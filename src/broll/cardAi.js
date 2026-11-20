'use strict';
/**
 * The AI side of the card theme. The small LLM only fills a CARD FORM (JSON); code validates it (cardSpec.js)
 * and writes the final image prompt (cardPrompt.js). Every chosen B-roll always ends with a usable card.
 *
 *   cardsFor({ llm, items, context, avoid, batchSize, log }) -> Map(id -> { card, fellBack })
 */
const { parseJson, LlmError } = require('./llm');
const spec = require('./cardSpec');
const rich = require('./rich');
const planner = require('./planner');

const RETRYABLE = ['BADJSON', 'TRUNCATED', 'EMPTY'];

/* ---------------------------------------------------------------- few-shot examples (the tested look) */
const FEW_SHOT = [
  { quote: 'Motivation is a trap.', form: { id: 'b001', mode: 'scene', palette: 'black_yellow', subject: 'a lone person in a plain shirt reaching toward a glowing golden trophy that sits on the trigger plate of a huge metal mousetrap', action: 'their hand stops an inch above the trophy', setting: 'the cracked concrete floor of a narrow dim alley', composition: 'high_angle' } },
  { quote: "It feels like progress, but it isn't.", form: { id: 'b002', mode: 'scene', palette: 'blue_grey', subject: 'a young person in a school-style shirt pedalling a bicycle whose wheels spin on a rolling belt of road', action: 'pedalling hard while the scenery stays exactly the same', setting: 'an empty street with swirling outlined clouds behind', composition: 'medium' } },
  { quote: "It's resistance finding a clever way to distract you.", form: { id: 'b003', mode: 'scene', palette: 'muted_multicolor', subject: 'a student sitting at a low desk surrounded by three vivid ghostly figures in pink, yellow and purple leaning in to whisper', action: 'the student stares straight ahead with a blank face', setting: 'a cramped tatami room with bookshelves', composition: 'low_angle' } },
  { quote: "Instead of doing the work, you're fantasizing about the result.", form: { id: 'b004', mode: 'ui', layout: 'toggles', pill: 'your brain', rows: [{ label: 'doing the work', on: false, role: 'muted' }, { label: 'fantasizing about the result', on: true, role: 'secondary' }] } },
  { quote: 'The amateur daydreams about the reward. The professional concentrates on the work.', form: { id: 'b005', mode: 'ui', layout: 'columns', pill: 'two mindsets', left: { heading: 'amateur', text: 'daydreams about the reward', role: 'secondary' }, right: { heading: 'professional', text: 'focuses on the work', role: 'accent' } } },
  { quote: 'The professional knows success is a byproduct of the work.', form: { id: 'b006', mode: 'ui', layout: 'before_after', pill: 'the professional knows', before: { label: 'the work', text: 'the focus' }, after: { label: 'success', text: 'a byproduct' } } },
  { quote: '...allows the reward to come or not come.', form: { id: 'b007', mode: 'ui', layout: 'chips', pill: 'the reward', headline: 'let it come or not', items: [{ text: 'comes', check: true }, { text: 'does not come', check: true }] } },
  { quote: 'In its first month, skool made 3,104 dollars and YouTube ads made 2,119.', form: { id: 'b008', mode: 'ui', layout: 'bars', pill: 'skool · its first month', unit: '$', rows: [{ label: 'skool', value: 3104, role: 'accent' }, { label: 'youtube ads', value: 2119, role: 'secondary' }] } },
  { quote: 'A man that hardens his neck, that walks around stiff-necked and proud, will be destroyed.', form: { id: 'b009', mode: 'scene', palette: 'sepia', subject: 'a tall man in a dark suit with his chin raised high and a stiff neck', action: 'striding forward without looking down while thin cracks split the street ahead of him', setting: 'a dim old street with peeling walls', composition: 'low_angle' } },
  { quote: 'Hannibal pulls back his weak center and envelops the Roman army.', form: { id: 'b010', mode: 'scene', palette: 'green', subject: 'a hand pulling a longbow string far back so the bow bends in a deep curve', action: 'the arrow is aimed at a distant crowd of tiny dark figures', setting: 'an open field under swirling outlined clouds', composition: 'wide' } },
  { quote: 'Ceramics crumble, whereas metal can deform.', form: { id: 'b011', mode: 'material', pill: "bend, don't break", halves: [{ heading: 'ceramic', object: 'a white porcelain plate shattered into sharp pieces', role: 'secondary' }, { heading: 'metal', object: 'a thick brushed steel bar bent into a smooth arc without breaking, with a faint warm yellow glow along the bend', role: 'accent' }], caption: 'ceramic shatters · metal deforms' } },
  { quote: 'Then you upload it to YouTube.', form: { id: 'b012', mode: 'logo', brand: 'youtube', display_name: 'YouTube', kind: 'platform' } },
  { quote: 'Michelangelo painted the Sistine Chapel ceiling.', form: { id: 'b013', mode: 'symbol', pill: 'michelangelo', line_art: 'two hands reaching toward each other, fingers almost touching', icon_role: 'text', name: 'sistine chapel ceiling · 1512' } },
  { quote: 'Look at how he painted every figure on the ceiling.', form: { id: 'b014', mode: 'real_image', pill: 'michelangelo', search_hint: 'Sistine Chapel ceiling fresco' } }
];

/* ---------------------------------------------------------------- system prompt */
function cardSystem() {
  const layouts = Object.entries(spec.LAYOUTS).map(([k, v]) => `  - ${k}: ${v}`).join('\n');
  const shots = FEW_SHOT.map((e, i) => `${i + 1}. Line: ${JSON.stringify(e.quote)}\n   ${JSON.stringify(e.form)}`).join('\n');
  return `# ROLE
1. You fill in a CARD FORM for each B-roll of a talking video. You never write image prompts and you never describe colours, style or layout wording: code does that from your form.
2. A card is a dark rounded UI card shown over a green screen. You only choose what goes on it.

# OUTPUT CONTRACT
3. Reply with JSON only, no prose, no markdown: {"cards":[ {form}, {form}, ... ]}. One form per input row, same "id", same order.
4. Every form has: "id", "mode", "pill" (max 4 words, the topic label), optional "pill_dot" and optional "caption" (max 8 words). Roles (colours) are only these names: accent (yellow, the main highlight), secondary (coral red, the other side or a warning), muted (grey), text (white).
5. Fields per mode:
  - mode "ui" needs "layout" and its fields:
${layouts}
  - mode "scene" (a full-frame drawn illustration with no card): palette (one of ${spec.PALETTES.join(', ')}), subject (one person or one object, max 35 words), action (max 25), setting (ground or backdrop only, max 30), composition (one of ${spec.COMPOSITIONS.join(', ')}), optional extra. No text inside a scene and no art-style words: code adds the style.
  - mode "logo" (a full-frame brand logo): brand (lowercase slug like youtube), display_name (max 3 words), kind (${spec.LOGO_KINDS.join(', ')}).
  - mode "material": object (one object) OR halves [two {heading, object, role}, left and right], optional texture_notes.
  - mode "symbol": icon (one of ${spec.ICONS.join(', ')}) OR line_art (a simple subject, max 8 words), plus name (text under it) and icon_role.
  - mode "real_image": search_hint (short search phrase) and pill. Use it ONLY when a famous artwork, a real person, a real place or a real product must look authentic.

# CHOOSING THE MODE (decision table)
6. The line is about...                                   -> mode
  - a number, amount, comparison, list, steps, formula, before/after -> ui with a data layout
  - an abstract idea or a warning (trap, distraction, myth, "feels like X but isn't", cause and effect) -> scene or material showing ONE simple idea object or moment, or a symbol card if one icon says it. Never a text-only card
  - a choice, X vs Y, or a "comes or not" outcome -> ui with toggles, columns or chips
  - a feeling, behaviour or personal moment -> scene (one person, one pose)
  - a story, historical event or example -> scene or material showing the IDEA behind the event as one simple object or moment, never a reconstruction (no battles, no maps). Name and date go in the pill
  - physical things or materials (steel, ceramic, wood, stone) -> material
  - a named brand, platform, company or creator brand (YouTube, Instagram...) -> logo
  - a famous artwork, famous real person, real place, real product -> symbol with line_art if a simple line drawing works, otherwise real_image
7. Metaphors for ui layouts: a choice or one thing instead of another -> toggles; X vs Y -> columns; X turns into Y -> before_after; an optional or uncertain outcome -> chips with check marks. Traps, dangers, distractions, myths and "feels like X but isn't" are NOT ui cards.
8. One card shows ONE idea with at most three elements. A viewer who knows nothing about the topic must get it in one second. No crowds of tiny objects, no maps, at most one small caption.
9. Over a whole video aim for about 40 to 50 percent ui, 35 to 45 percent scene and material together, the rest symbol and real_image.

# HARD RULES
10. Numbers and names come from the line. If the speaker gives no number, do NOT invent one: pick a layout that needs no number. For bars, big_number and milestone every number must be said in the line.
11. All text is lowercase, short and copied or condensed from the spoken line (except value_text and name). Use the word limits above.
12. Avoid apostrophes in text when a plain wording exists (image models drop them). No emojis, no quotation marks.
13. Nothing on a card is ever green.
14. Variety: do not use the same layout (or the material mode) as the previous card. Each row gives "previous_layouts": stay away from them. If a row gives "avoid_layouts", never use those. Do not use more than 2 cards of the same layout in any 10.
15. If a row gives "fix", your earlier form for that id was rejected for that reason: correct it.

# EXAMPLES (spoken line -> form)
${shots}

# SILENT CHECKLIST (do before answering)
- numbers grounded in the line? text within the word limits? layout different from the previous card? mode matches the table? one form per id, in order?`;
}

function cardUser(rows) {
  return `ROWS:\n${JSON.stringify(rows, null, 1)}\n\nReturn the JSON now, one form per row.`;
}

/* ---------------------------------------------------------------- calls */
function readCards(text, log) {
  const data = parseJson(text);
  if (data && typeof data.notes === 'string' && data.notes.trim() && log) log(`  Claude: ${data.notes.trim().slice(0, 300)}`);
  const arr = Array.isArray(data) ? data : data.cards || data.forms || data.items || (data && data.id ? [data] : []);
  const byId = new Map();
  for (const f of Array.isArray(arr) ? arr : []) if (f && typeof f === 'object' && f.id != null && !byId.has(String(f.id))) byId.set(String(f.id), f);
  return byId;
}

async function askOnce({ llm, rows, system, build, log }) {
  const text = await llm.chat({ system: system || cardSystem(), user: build ? build(rows) : cardUser(rows), temperature: 0.2, reasoning: 'low' });
  return readCards(text, log);
}

// One retry on unusable output (BADJSON / TRUNCATED / EMPTY); a second failure becomes "no answer" so the fallbacks take over.
// Claude (rich): a TRUNCATED answer is halved and asked again, so a long video never fails because one answer was too long.
async function ask({ llm, rows, log, system, build }) {
  const isRich = rich.isRich(llm);
  const attempt = async (rs, depth) => {
    for (let a = 0; a < 2; a++) {
      try { return await askOnce({ llm, rows: rs, system, build, log }); } catch (e) {
        if (!(e instanceof LlmError) || !RETRYABLE.includes(e.code)) throw e;
        if (isRich && e.code === 'TRUNCATED' && rs.length > 1 && depth < 6) {
          log(`  The answer for ${rs.length} card(s) was cut off; splitting it in half…`);
          const h = Math.ceil(rs.length / 2);
          const first = await attempt(rs.slice(0, h), depth + 1);
          for (const [k, v] of await attempt(rs.slice(h), depth + 1)) first.set(k, v);
          return first;
        }
        if (a === 0) log(`  The AI answer for ${rs.length} card(s) was unusable (${e.code}); trying once more…`);
      }
    }
    log('  The AI answer was still unusable; those cards fall back to a simple card.');
    return new Map();
  };
  return attempt(rows, 0);
}

const rowOf = (it, extra) => ({ id: it.id, line: String(it.quote || it.description || '').slice(0, 400), description: String(it.description || '').slice(0, 300), ...extra });
const spokenOf = it => String(it.quote || it.description || '');

// Rich: a picture row with its time and the spoken lines around it ("before" and "after" are context only).
function pictureOf(it, all, extra) {
  const i = all.findIndex(x => String(x.id) === String(it.id));
  const near = k => (all[k] && all[k].quote ? String(all[k].quote).slice(0, 200) : '');
  return {
    id: it.id, time: `${rich.mmss(it.start)}-${rich.mmss(it.end != null ? it.end : it.start)}`,
    line: String(it.quote || it.description || '').slice(0, 400), description: String(it.description || '').slice(0, 300),
    before: i > 0 ? near(i - 1) : '', after: i >= 0 ? near(i + 1) : '', ...extra
  };
}

/**
 * items:     the B-rolls to write cards for, in time order: { id, start, end?, quote, description }
 * context:   the other B-rolls around them (already have cards): [{ id, start, card }]. Only used for variety.
 * avoid:     Map or object  id -> [layouts the AI must not use for that item]
 * all:       every B-roll of the video in time order (rich profile: gives each picture its "before" and "after" line)
 * duration:  length of the video in seconds (rich profile: the video brief)
 * Returns Map(id -> { card, fellBack }). Every id of `items` is in it; every card is valid.
 */
async function cardsFor({ llm, items, context = [], avoid = {}, batchSize = 8, all = [], duration = 0, log = () => {} }) {
  const isRich = rich.isRich(llm);
  const profile = isRich ? 'rich' : 'compact';
  const system = isRich ? rich.cardSystemRich() : null;
  const avoidOf = id => (avoid instanceof Map ? avoid.get(id) : avoid[id]) || [];
  const result = new Map();                       // id -> { card, fellBack }
  const byId = new Map(items.map(it => [String(it.id), it]));
  const neighbours = all.length ? all : items;
  const parts = Math.max(1, Math.ceil(items.length / batchSize));

  // The cards in time order (context + what has been decided so far): used for "previous_layouts" and the variety pass.
  const sequence = () => {
    const seqAll = [...context.filter(c => c.card).map(c => ({ id: String(c.id), start: c.start, card: c.card })),
      ...items.filter(it => result.has(String(it.id))).map(it => ({ id: String(it.id), start: it.start, card: result.get(String(it.id)).card }))];
    return seqAll.sort((a, b) => a.start - b.start);
  };
  const keyOf = card => spec.layoutKey(card) || card.mode;
  const prevLayouts = it => {
    const seq = sequence().filter(x => x.start < it.start && x.card.mode !== 'real_image');   // a real_image card shows no picture
    return seq.slice(-2).map(x => keyOf(x.card));
  };
  const earlierLines = it => sequence().filter(x => x.start < it.start && x.card.mode !== 'real_image').map(x => rich.cardLine({ ...x.card, id: x.id }));

  // Rich: rows are picture objects; the user message is built from them (and from the cards decided so far).
  const richRow = (it, extra) => pictureOf(it, neighbours, extra);
  const buildFor = (first, part) => rows => rich.cardUserRich({ duration, part, parts, earlier: earlierLines(first), pictures: rows });
  const askFor = (rows, first, part) => (isRich
    ? ask({ llm, rows, log, system, build: buildFor(first, part) })
    : ask({ llm, rows, log }));

  // Validates the answers; returns the items still without a valid card with the reason.
  const settle = (answers, wanted) => {
    const bad = [];
    for (const it of wanted) {
      const form = answers.get(String(it.id));
      if (!form) { bad.push({ it, why: 'no card was returned for this id' }); continue; }
      const v = spec.validateCard({ ...form, id: it.id }, spokenOf(it), { profile });
      if (v.ok) result.set(String(it.id), { card: v.card, fellBack: false });
      else bad.push({ it, why: v.errors.join('; ') || 'invalid card' });
    }
    return bad;
  };

  for (let off = 0; off < items.length; off += batchSize) {
    const batch = items.slice(off, off + batchSize);
    const part = Math.floor(off / batchSize) + 1;
    log(`Filling card forms for ${batch.length} B-roll(s)${items.length > batchSize ? ` (${part}/${parts})` : ''}…`);
    // Only the first row needs the layouts that came before the batch; the others follow the rows above them.
    const rows = batch.map((it, i) => (isRich
      ? richRow(it, avoidOf(it.id).length ? { avoid: avoidOf(it.id) } : {})
      : rowOf(it, {
        ...(i === 0 ? { previous_layouts: prevLayouts(it) } : {}),
        ...(avoidOf(it.id).length ? { avoid_layouts: avoidOf(it.id) } : {})
      })));
    let bad = settle(await askFor(rows, batch[0], part), batch);

    if (bad.length) {
      log(`  ${bad.length} card(s) were missing or invalid; asking again for those…`);
      const retryRows = bad.map(b => (isRich
        ? richRow(b.it, { fix: b.why, ...(avoidOf(b.it.id).length ? { avoid: avoidOf(b.it.id) } : {}) })
        : rowOf(b.it, { previous_layouts: prevLayouts(b.it), fix: b.why, ...(avoidOf(b.it.id).length ? { avoid_layouts: avoidOf(b.it.id) } : {}) })));
      bad = settle(await askFor(retryRows, bad[0].it, part), bad.map(b => b.it));
    }
    for (const b of bad) {
      log(`  Card ${b.it.id} could not be made (${b.why}); used a simple fallback card.`);
      result.set(String(b.it.id), { card: spec.fallbackCard(b.it.id, spokenOf(b.it)), fellBack: true });
    }
  }

  // Variety pass: ask ONCE more for the cards that repeat too much. If they still do, accept them.
  const seq = sequence();
  const violations = spec.varietyCheck(seq.map(x => ({ ...x.card, id: x.id }))).filter(v => byId.has(String(v.id)) && !result.get(String(v.id)).fellBack);   // a card the AI already failed to make is not asked for again
  if (violations.length) {
    log(`Variety check: ${violations.length} card(s) repeat a layout or palette; asking for different ideas…`);
    const rows = violations.map(v => {
      const it = byId.get(String(v.id));
      const avoidList = [...new Set([...v.avoid, ...avoidOf(it.id)])];
      const fix = `too repetitive (${v.reason}); use a different layout, palette or mode`;
      if (isRich) return richRow(it, { fix, avoid: avoidList });
      const before = seq.filter(x => x.start < it.start && x.card.mode !== 'real_image').slice(-2).map(x => keyOf(x.card));
      return rowOf(it, { previous_layouts: before, avoid_layouts: avoidList, fix });
    });
    const answers = await askFor(rows, byId.get(String(violations[0].id)), 1);
    for (const v of violations) {
      const it = byId.get(String(v.id)), form = answers.get(String(v.id));
      if (!form) continue;
      const r = spec.validateCard({ ...form, id: it.id }, spokenOf(it), { profile });
      if (r.ok) result.set(String(it.id), { card: r.card, fellBack: false });   // an invalid answer keeps the earlier card
    }
  }
  return result;
}

/**
 * T4 NEW IDEA (Claude): one new card for ONE picture that must differ from the current one.
 * With Groq / Gemini the usual cardsFor call is used, avoiding the current layout, exactly as before.
 * Returns { card, fellBack }.
 */
async function newIdea({ llm, item, current = null, wish = '', context = [], all = [], duration = 0, log = () => {} }) {
  if (!rich.isRich(llm)) {
    const key = current ? (spec.layoutKey(current) || current.mode) : null;
    const got = await cardsFor({ llm, items: [item], context, avoid: { [item.id]: key ? [key] : [] }, batchSize: 1, all, duration, log });
    return got.get(String(item.id));
  }
  const avoid = { modes: current ? [current.mode] : [], layouts: current && current.layout ? [current.layout] : [], palettes: current && current.palette ? [current.palette] : [] };
  const picture = pictureOf(item, all.length ? all : [item], {});
  const system = rich.ideaSystemRich();
  let fix = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = rich.ideaUserRich({ picture, current, avoid, wish: fix ? `${wish || ''} (your last answer was rejected: ${fix})`.trim() : wish });
    let data;
    try { data = parseJson(await llm.chat({ system, user, temperature: 0.7, reasoning: 'low' })); } catch (e) {
      if (e instanceof LlmError && RETRYABLE.includes(e.code) && attempt === 0) { log('  The AI answer was unusable; trying once more…'); continue; }
      throw e;
    }
    if (data && typeof data.notes === 'string' && data.notes.trim()) log(`  Claude: ${data.notes.trim().slice(0, 300)}`);
    const form = data && (data.card || data.form || (data.id ? data : null));
    const v = form ? spec.validateCard({ ...form, id: item.id }, spokenOf(item), { profile: 'rich' }) : { ok: false, errors: ['no card was returned'] };
    if (v.ok) return { card: v.card, fellBack: false };
    fix = v.errors.join('; ');
  }
  throw new Error(`The AI could not make a usable new card (${fix}). Try again.`);
}

/**
 * T6 PICK AND DESIGN (Claude, optional): choose which lines get a picture, group neighbours and design every card in ONE answer.
 * Returns { decisions: [{ at: [items], description }], cards: Map(firstId -> card) } (cards are validated).
 */
async function pickAndDesign({ llm, items, duration = 0, log = () => {} }) {
  const rows = items.map(b => ({ id: b.id, time: `${rich.mmss(b.start)}-${rich.mmss(b.end)}`, line: b.quote, picture: b.description,
    before: '', after: '' }));
  rows.forEach((r, i) => { r.before = i ? String(items[i - 1].quote || '').slice(0, 200) : ''; r.after = i < items.length - 1 ? String(items[i + 1].quote || '').slice(0, 200) : ''; });
  const system = rich.pickDesignSystemRich();
  const user = rich.pickDesignUserRich({ duration, rows });
  let data;
  for (let attempt = 0; ; attempt++) {
    try { data = parseJson(await llm.chat({ system, user, temperature: 0.4, reasoning: 'low' })); break; } catch (e) {
      if (e instanceof LlmError && RETRYABLE.includes(e.code) && attempt === 0) { log('  The AI answer was unusable; trying once more…'); continue; }
      throw e;
    }
  }
  if (data && typeof data.notes === 'string' && data.notes.trim()) log(`  Claude: ${data.notes.trim().slice(0, 300)}`);
  const entries = (Array.isArray(data) ? data : data.pictures || []).map(e => ({
    ids: (e && (Array.isArray(e.ids) ? e.ids : e && e.id != null ? [e.id] : []) || []).map(String), description: e && e.description, card: e && e.card
  }));
  const decisions = planner.decide(entries.map(e => ({ ids: e.ids, description: e.description })), items);
  const cards = new Map();
  for (const d of decisions) {
    const first = String(d.at[0].id);
    const e = entries.find(x => x.ids.includes(first) && x.card);
    if (!e) continue;
    const quote = d.at.map(spokenOf).join(' ');
    const v = spec.validateCard({ ...e.card, id: first }, quote, { profile: 'rich' });
    if (v.ok) cards.set(first, v.card);
  }
  return { decisions, cards };
}

module.exports = { FEW_SHOT, cardSystem, cardUser, cardsFor, askOnce, newIdea, pickAndDesign };
