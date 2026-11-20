'use strict';
/**
 * The CARD FORM: what the small LLM is allowed to fill in, and the code that checks it.
 * Pure functions, no LLM, no I/O.
 *
 *   validateCard(form, quote)  -> { ok, card, errors }   (card is ALWAYS usable: on failure it is the fallback chips card)
 *   fallbackCard(id, quote)    -> a chips card made from the line's own words
 *   varietyCheck(cards)        -> [{ index, id, reason, avoid }]  cards that repeat a layout / mode too much
 *   numbersIn(text) / isGrounded(n, quote)   number grounding (digits and English number words)
 */

const MODES = ['ui', 'material', 'symbol', 'scene', 'logo', 'person', 'real_image'];
const FULL_FRAME = ['scene', 'logo', 'person'];                 // no card, no green screen: never keyed or cropped
const PALETTES = ['pink', 'blue_grey', 'green', 'sepia', 'black_yellow', 'muted_multicolor'];
const COMPOSITIONS = ['close_up', 'medium', 'wide', 'from_behind', 'high_angle', 'low_angle', 'tilted', 'over_shoulder'];
const LOGO_KINDS = ['platform', 'creator', 'company', 'product', 'app', 'channel'];
const RENDERS = ['animated', 'real'];
const ROLES = ['accent', 'secondary', 'muted', 'text'];
const ICONS = ['play_button', 'chat_bubble', 'heart', 'bell', 'magnifier', 'lock', 'coin', 'trophy', 'book', 'lightbulb', 'globe', 'generic'];
// Claude (rich) may also use these, in the symbol mode and as hero_icon. ICONS itself stays as it was: the Groq prompt is built from it.
const RICH_ICONS = [...ICONS, 'arrow_up', 'arrow_down', 'clock', 'shield', 'check', 'warning'];
// Optional icon on a ui card (Claude only): every icon except "generic". Too crowded for chips, toggles and columns.
const HERO_ICONS = RICH_ICONS.filter(i => i !== 'generic');
const HERO_LAYOUTS = ['big_number', 'bars', 'milestone', 'list', 'formula', 'before_after'];
const OPS = ['x', '+', '=', '-', '÷'];
const UNITS = ['$', '€', '£', '%'];

// Layout -> short description of its fields (also used to build the LLM schema text).
const LAYOUTS = {
  big_number: 'value_text, sub?',
  bars: 'rows[2-4]{label,value,role}, unit?',
  milestone: 'headline, percent, marker_label',
  chips: 'headline?, items[2-6]{text,check?,role?}',
  list: 'rows[2-4]{text,role?}',
  toggles: 'rows[2-3]{label,on,role?}',
  columns: 'left{heading,text,role}, right{heading,text,role}',
  formula: 'parts[2-4], op',
  before_after: 'before{label,text}, after{label,text}'
};

// Every limit in one place (section 9.3 of the spec). `label` is 4 words (not 3) so the tested few-shot examples survive.
const LIMITS = {
  pill: { words: 4, chars: 32 },
  label: { words: 4 },
  heading: { words: 3 },
  text: { words: 8 },
  caption: { words: 8 },
  subject: { words: 20 },
  action: { words: 15 },
  setting: { words: 15 },
  object: { words: 25 },
  prop: { words: 8 },
  texture: { words: 8 },
  lineArt: { words: 8 },
  name: { words: 8 },
  hint: { words: 8 },
  valueText: { chars: 14 },
  chips: { min: 2, max: 6 },
  rows: { min: 2, max: 4 },
  toggleRows: { min: 2, max: 3 },
  parts: { min: 2, max: 4 },
  // Full-frame modes (scene, logo, person): the same for every AI.
  sceneSubject: { words: 35 }, sceneAction: { words: 25 }, sceneSetting: { words: 30 }, sceneExtra: { words: 30 }, altIdea: { words: 25 },
  look: { words: 25 }, personName: { words: 4 }, personAction: { words: 20 }, personSetting: { words: 20 }, displayName: { words: 3 }, reason: { words: 14 },
  psych: { words: 12 }   // Claude only: the viewer feeling and the cue; never drawn, only shown to the editor
};

// The rich profile (Claude) allows a little more text and more rows (section 3.8 of CLAUDE_PROMPTS_SPEC.md).
const RICH_LIMITS = {
  ...LIMITS,
  pill: { words: 5, chars: 40 }, label: { words: 4 }, heading: { words: 4 }, text: { words: 10 }, caption: { words: 10 }, lineArt: { words: 10 },
  chips: { min: 2, max: 8 }, rows: { min: 2, max: 5 }
};
const limitsFor = profile => (profile === 'rich' ? RICH_LIMITS : LIMITS);

/* ---------------------------------------------------------------- text cleaning */
const EMOJI = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const hasWordChar = t => /[\p{L}\p{N}]/u.test(t);

function cleanText(s, { lower = true } = {}) {
  let t = String(s == null ? '' : s).replace(EMOJI, '').replace(/[“”„‟«»"`]/g, '').replace(/[‘’]/g, "'")
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (lower) t = t.toLowerCase();
  return t;
}

// Cuts at a word boundary. Symbols such as "·" do not count as words.
function limitText(s, maxWords, maxChars) {
  const toks = String(s).split(' ').filter(Boolean);
  const out = [];
  let words = 0;
  for (const t of toks) {
    if (hasWordChar(t)) { if (maxWords && words >= maxWords) break; words++; }
    out.push(t);
  }
  let r = out.join(' ');
  if (maxChars && r.length > maxChars) {
    const cut = r.slice(0, maxChars + 1);
    const sp = cut.lastIndexOf(' ');
    r = (sp > 0 ? cut.slice(0, sp) : r.slice(0, maxChars));
  }
  return r.replace(/[\s,;:·\-–—]+$/u, '').trim();
}

function text(v, lim, { lower = true } = {}) {
  return limitText(cleanText(v, { lower }), lim && lim.words, lim && lim.chars);
}

const role = (v, dflt = 'accent') => {
  const r = String(v == null ? '' : v).toLowerCase().trim();
  return ROLES.includes(r) ? r : dflt;
};
const bool = v => v === true || /^(true|on|yes|1)$/i.test(String(v));

/* ---------------------------------------------------------------- numbers: digits and English number words */
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

const isNumWord = w => w in SMALL || w in TENS || w === 'hundred' || w in SCALE;

// English number words -> every number the text says ("three thousand one hundred four" -> 3104, "two and a half million" -> 2500000).
function wordNumbers(str) {
  const toks = String(str).toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = [];
  let i = 0;
  while (i < toks.length) {
    const startsNumber = isNumWord(toks[i]) || (toks[i] === 'a' && (toks[i + 1] === 'hundred' || toks[i + 1] in SCALE));
    if (!startsNumber) { i++; continue; }
    let total = 0, cur = 0, any = false;
    while (i < toks.length) {
      const w = toks[i];
      if (w in SMALL || w in TENS) { cur += SMALL[w] != null ? SMALL[w] : TENS[w]; any = true; i++; }
      else if (w === 'a' && (toks[i + 1] === 'hundred' || toks[i + 1] in SCALE)) { cur = 1; any = true; i++; }
      else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; i++; }
      else if (w in SCALE) { total += (cur || 1) * SCALE[w]; cur = 0; any = true; i++; }
      else if (w === 'and' && toks[i + 1] === 'a' && toks[i + 2] === 'half') { cur += 0.5; i += 3; }
      else if (w === 'and' && isNumWord(toks[i + 1] || '')) { i++; }
      else break;
    }
    if (any) found.push(total + cur);
  }
  return found;
}

// Digits ("3,104", "$5.4k", "2 million", "80%") -> numbers; a multiplier word gives the scaled value as well.
function digitNumbers(str) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mm|m|million|bn|b|billion)?\b/gi;
  let m;
  while ((m = re.exec(String(str)))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    out.push(n);
    if (m[2]) out.push(n * MULT[m[2].toLowerCase()]);
  }
  return out;
}

const numbersIn = str => [...digitNumbers(str), ...wordNumbers(str)];
const sameNumber = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
const isGrounded = (n, quote) => Number.isFinite(n) && numbersIn(quote).some(x => sameNumber(x, n));

// "$5,400" -> 5400, "80%" -> 80, "twelve" -> 12; null if the text holds no number.
function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const found = numbersIn(String(v == null ? '' : v));
  return found.length ? found[0] : null;
}

/* ---------------------------------------------------------------- fallback card */
const STOP = new Set(('a an the and or but so if then than that this these those there here is are was were be been being am do does did done have has had having ' +
  'i me my mine we us our you your he him his she her it its they them their what which who whom whose when where why how not no nor of to in on at by for with ' +
  'about as into from up down out over under again very just also too can could will would shall should may might must like really actually basically honestly literally simply definitely kind sort ' +
  'thing things stuff get got gets going gone one more most some any all each every other such only own same than s t don didn doesn isn aren wasn weren').split(/\s+/));

const wordsOf = s => String(s).toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}']*/gu) || [];

// The always-valid card: chips with the 2 to 3 most meaningful words of the line.
function fallbackCard(id, quote) {
  const all = wordsOf(quote);
  const meaningful = [];
  all.forEach((w, i) => { if (!STOP.has(w) && w.length > 2 && !meaningful.some(m => m.w === w)) meaningful.push({ w, i }); });
  const top = meaningful.slice().sort((a, b) => b.w.length - a.w.length || a.i - b.i).slice(0, 3).sort((a, b) => a.i - b.i).map(m => m.w);
  const items = top.slice();
  for (const w of all) { if (items.length >= 2) break; if (!items.includes(w) && w.length > 1) items.push(w); }
  while (items.length < 2) items.push(items.length ? 'the point' : 'the idea');
  const pill = text(top[0] || items[0] || 'idea', LIMITS.pill) || 'idea';
  return { id: String(id || ''), mode: 'ui', layout: 'chips', pill, pill_dot: 'accent', items: items.map(t => ({ text: text(t, { words: 3 }) })) };
}

/* ---------------------------------------------------------------- validation */
function rowsOf(v, min, max, errors, what) {
  const arr = Array.isArray(v) ? v.filter(x => x && typeof x === 'object' || typeof x === 'string') : [];
  if (arr.length < min) { errors.push(`${what} must have ${min} to ${max} items`); return null; }
  return arr.slice(0, max);
}

/* ---------------------------------------------------------------- full-frame helpers */
const enumOf = (v, list, dflt) => {
  const x = String(v == null ? '' : v).toLowerCase().trim().replace(/[\s-]+/g, '_');
  return list.includes(x) ? x : dflt;
};

// The art style belongs to the code, so style words are stripped from what the AI writes for a scene.
const STYLE_WORDS = /\b(anime|cel|flat|3d|render(?:ed|ing|s)?|styles?|styled)\b/gi;
const sceneText = (v, lim) => text(String(v == null ? '' : v).replace(STYLE_WORDS, ' '), lim, { lower: false });

// Brand slug: lowercase, spaces to "-", other characters dropped, [a-z0-9-]{1,40}.
function slugify(v) {
  return String(v == null ? '' : v).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Words that are never allowed in a picture of a real person (section 3.9).
const BLOCKED_PERSON = /\b(?:nude|naked|blood(?:y)?|kill(?:s|ed|ing|er)?|dead|arrest(?:s|ed|ing)?|scandal(?:s|ous)?)\b/gi;
// Blocked words are dropped; what is left must still say something (no dangling "and", "with", "a"...).
const CONNECTORS = /^(?:(?:and|or|with|but|while|the|a|an|in|on|at|of|to)\b[\s,;:.]*)+|(?:[\s,;:.]*\b(?:and|or|with|but|while|the|a|an|in|on|at|of|to))+[\s,;:.]*$/gi;
function safePerson(v, lim) {
  const raw = String(v == null ? '' : v);
  if (!BLOCKED_PERSON.test(raw)) { BLOCKED_PERSON.lastIndex = 0; return text(raw, lim, { lower: false }); }
  BLOCKED_PERSON.lastIndex = 0;
  const left = text(raw.replace(BLOCKED_PERSON, ' ').replace(/\s+/g, ' ').trim().replace(CONNECTORS, '').trim(), lim, { lower: false });
  return (left.match(/[\p{L}\p{N}]+/gu) || []).length >= 2 ? left : '';
}

const LAYOUT_CHECK = {
  big_number(f, ctx) {
    const value_text = text(f.value_text, ctx.L.valueText, { lower: false });
    if (!value_text) { ctx.errors.push('big_number needs value_text'); return null; }
    const n = parseNumber(value_text);
    if (n == null) { ctx.errors.push('value_text must contain the number said in the line'); return null; }
    if (!isGrounded(n, ctx.quote)) { ctx.errors.push(`the number ${value_text} is not said in the line`); ctx.ungrounded = true; return null; }
    const card = { layout: 'big_number', value_text };
    const sub = text(f.sub, ctx.L.text); if (sub) card.sub = sub;
    return card;
  },
  bars(f, ctx) {
    const rows = rowsOf(f.rows, 2, ctx.L.rows.max, ctx.errors, 'bars rows'); if (!rows) return null;
    const out = [];
    for (const r of rows) {
      const label = text(r && r.label, ctx.L.label);
      const value = parseNumber(r && r.value);
      if (!label || value == null || value < 0) { ctx.errors.push('every bars row needs a label and a number value of 0 or more'); return null; }
      if (!isGrounded(value, ctx.quote)) { ctx.errors.push(`the number ${value} is not said in the line`); ctx.ungrounded = true; return null; }
      out.push({ label, value, role: role(r.role) });
    }
    const max = Math.max(...out.map(r => r.value));
    if (!(max > 0)) { ctx.errors.push('at least one bars value must be above 0'); return null; }
    out.forEach(r => { r.fill = r.value > 0 ? Math.max(1, Math.round((r.value / max) * 100)) : 0; });
    const card = { layout: 'bars', rows: out };
    const unit = String(f.unit == null ? '' : f.unit).trim(); if (UNITS.includes(unit)) card.unit = unit;
    return card;
  },
  milestone(f, ctx) {
    const headline = text(f.headline, ctx.L.text);
    const percent = parseNumber(f.percent);
    if (!headline || percent == null || percent < 0 || percent > 100) { ctx.errors.push('milestone needs headline, percent (0 to 100) and marker_label'); return null; }
    if (!isGrounded(percent, ctx.quote)) { ctx.errors.push(`the number ${percent} is not said in the line`); ctx.ungrounded = true; return null; }
    const marker_label = text(f.marker_label, ctx.L.heading);
    if (!marker_label) { ctx.errors.push('milestone needs marker_label'); return null; }
    return { layout: 'milestone', headline, percent, marker_label };
  },
  chips(f, ctx) {
    const items = rowsOf(f.items, ctx.L.chips.min, ctx.L.chips.max, ctx.errors, 'chips items'); if (!items) return null;
    const out = [];
    for (const it of items) {
      const t = text(typeof it === 'string' ? it : it && it.text, { words: 4 });
      if (!t) continue;
      const chip = { text: t };
      if (it && typeof it === 'object') {
        if (it.check !== undefined) chip.check = bool(it.check);
        if (it.role !== undefined) chip.role = role(it.role);
      }
      out.push(chip);
    }
    if (out.length < 2) { ctx.errors.push(`chips items must have 2 to ${ctx.L.chips.max} items with text`); return null; }
    const card = { layout: 'chips', items: out };
    const headline = text(f.headline, ctx.L.text); if (headline) card.headline = headline;
    return card;
  },
  list(f, ctx) {
    const rows = rowsOf(f.rows, 2, ctx.L.rows.max, ctx.errors, 'list rows'); if (!rows) return null;
    const out = rows.map(r => { const t = text(typeof r === 'string' ? r : r && r.text, ctx.L.text); return t ? { text: t, role: role(r && r.role) } : null; }).filter(Boolean);
    if (out.length < 2) { ctx.errors.push(`list rows must have 2 to ${ctx.L.rows.max} items with text`); return null; }
    return { layout: 'list', rows: out };
  },
  toggles(f, ctx) {
    const rows = rowsOf(f.rows, 2, 3, ctx.errors, 'toggles rows'); if (!rows) return null;
    const out = rows.map(r => {
      const label = text(r && r.label, ctx.L.label); if (!label) return null;
      const on = bool(r.on);
      return { label, on, role: r.role === undefined ? (on ? 'accent' : 'muted') : role(r.role) };
    }).filter(Boolean);
    if (out.length < 2) { ctx.errors.push('toggles rows must have 2 to 3 items with a label'); return null; }
    return { layout: 'toggles', rows: out };
  },
  columns(f, ctx) {
    const side = (s, dflt) => {
      const heading = text(s && s.heading, ctx.L.heading), t = text(s && s.text, ctx.L.text);
      return heading && t ? { heading, text: t, role: role(s.role, dflt) } : null;
    };
    const left = side(f.left, 'secondary'), right = side(f.right, 'accent');
    if (!left || !right) { ctx.errors.push('columns needs left and right, each with heading and text'); return null; }
    return { layout: 'columns', left, right };
  },
  formula(f, ctx) {
    const parts = (Array.isArray(f.parts) ? f.parts : []).map(p => text(p, ctx.L.heading)).filter(Boolean).slice(0, ctx.L.parts.max);
    if (parts.length < ctx.L.parts.min) { ctx.errors.push('formula parts must have 2 to 4 words'); return null; }
    let op = String(f.op == null ? 'x' : f.op).trim().toLowerCase();
    if (op === '*' || op === '×') op = 'x'; if (op === '/') op = '÷'; if (op === '−' || op === '–') op = '-';
    return { layout: 'formula', parts, op: OPS.includes(op) ? op : 'x' };
  },
  before_after(f, ctx) {
    const side = s => { const label = text(s && s.label, ctx.L.heading), t = text(s && s.text, ctx.L.text); return label && t ? { label, text: t } : null; };
    const before = side(f.before), after = side(f.after);
    if (!before || !after) { ctx.errors.push('before_after needs before and after, each with label and text'); return null; }
    return { layout: 'before_after', before, after };
  }
};

const MODE_CHECK = {
  ui(f, ctx) {
    const layout = String(f.layout || '').toLowerCase().trim();
    if (!LAYOUTS[layout]) { ctx.errors.push(`layout must be one of ${Object.keys(LAYOUTS).join(', ')}`); return null; }
    return LAYOUT_CHECK[layout](f, ctx);
  },
  scene(f, ctx) {
    const subject = sceneText(f.subject, LIMITS.sceneSubject);
    if (!subject) { ctx.errors.push('scene needs a subject'); return null; }
    const card = { palette: enumOf(f.palette, PALETTES, 'blue_grey'), subject };
    const action = sceneText(f.action, LIMITS.sceneAction); if (action) card.action = action;
    const setting = sceneText(f.setting, LIMITS.sceneSetting); if (setting) card.setting = setting;
    card.composition = enumOf(f.composition, COMPOSITIONS, 'medium');
    const extra = sceneText(f.extra, LIMITS.sceneExtra); if (extra) card.extra = extra;
    const alt = sceneText(f.alt_idea, LIMITS.altIdea); if (alt) card.alt_idea = alt;
    return card;
  },
  logo(f, ctx) {
    const brand = slugify(f.brand || f.display_name);
    if (!brand) { ctx.errors.push('logo needs a brand'); return null; }
    const card = { brand, display_name: text(f.display_name || f.brand, LIMITS.displayName, { lower: false }) || brand, kind: enumOf(f.kind, LOGO_KINDS, 'company') };
    const look = text(f.look, LIMITS.look, { lower: false }); if (look) card.look = look;
    return card;
  },
  person(f, ctx) {
    const name = text(f.name, LIMITS.personName, { lower: false });
    if (!name) { ctx.errors.push('person needs a name'); return null; }
    const render = enumOf(f.render, RENDERS, 'animated');
    const action = safePerson(f.action, LIMITS.personAction) || 'standing and looking toward the camera';
    const setting = safePerson(f.setting, LIMITS.personSetting);
    const card = { name, render, action, composition: enumOf(f.composition, COMPOSITIONS, 'medium') };
    if (setting) card.setting = setting;
    if (render === 'animated') {
      card.palette = enumOf(f.palette, PALETTES, 'blue_grey');
      const look = text(f.look, LIMITS.look, { lower: false }); if (look) card.look = look;
    }
    return card;
  },
  material(f, ctx) {
    const card = {};
    const notes = text(f.texture_notes, ctx.L.texture); if (notes) card.texture_notes = notes;
    const halves = Array.isArray(f.halves) ? f.halves : null;
    if (halves && halves.length >= 2) {
      const out = halves.slice(0, 2).map((h, i) => {
        const heading = text(h && h.heading, ctx.L.heading), object = text(h && h.object, ctx.L.object);
        return heading && object ? { heading, object, role: role(h.role, i === 0 ? 'secondary' : 'accent') } : null;
      });
      if (out.some(h => !h)) { ctx.errors.push('material halves need heading and object on both sides'); return null; }
      card.halves = out;
      return card;
    }
    const object = text(f.object, ctx.L.object);
    if (!object) { ctx.errors.push('material needs object, or halves (2 items)'); return null; }
    card.object = object;
    return card;
  },
  symbol(f, ctx) {
    const icon = String(f.icon || '').toLowerCase().trim();
    const lineArt = text(f.line_art, ctx.L.lineArt);
    if (!lineArt && !icon) { ctx.errors.push('symbol needs icon (from the list) or line_art'); return null; }
    const card = { icon_role: role(f.icon_role), name: text(f.name, ctx.L.name, { lower: false }) || ctx.pill };
    if (lineArt) card.line_art = lineArt; else card.icon = (ctx.rich ? RICH_ICONS : ICONS).includes(icon) ? icon : 'generic';
    return card;
  },
  real_image(f, ctx) {
    const search_hint = text(f.search_hint, ctx.L.hint, { lower: false });
    if (!search_hint) { ctx.errors.push('real_image needs search_hint'); return null; }
    return { search_hint };
  }
};

// Meaningful words of the line for a missing pill.
const derivePill = quote => text(wordsOf(quote).filter(w => !STOP.has(w) && w.length > 2).slice(0, 2).join(' ') || 'idea', LIMITS.pill);

/**
 * Checks and cleans one card form. Never throws.
 * Returns { ok, card, errors }. When ok is false, `card` is the fallback chips card, so a caller that gives up still has something usable.
 */
function validateCard(form, quote = '', { profile } = {}) {
  const errors = [];
  const id = form && typeof form === 'object' ? String(form.id == null ? '' : form.id) : '';
  const fail = () => ({ ok: false, errors, card: fallbackCard(id, quote) });
  if (!form || typeof form !== 'object' || Array.isArray(form)) { errors.push('the card must be a JSON object'); return fail(); }

  let mode = String(form.mode || '').toLowerCase().trim();
  if (mode === 'animated') mode = 'scene';          // the old animated mode is now the scene mode
  if (!mode && form.layout) mode = 'ui';
  if (!MODES.includes(mode)) { errors.push(`mode must be one of ${MODES.join(', ')}`); return fail(); }

  const L = limitsFor(profile);
  const pill = text(form.pill, L.pill) || derivePill(quote);
  const ctx = { errors, quote: String(quote || ''), pill, L, rich: profile === 'rich' };
  const body = MODE_CHECK[mode](form, ctx);
  if (!body) return fail();

  // Full-frame pictures have no card, so no pill and no caption (and no text of any kind inside the picture).
  const card = FULL_FRAME.includes(mode) ? { id, mode, ...body } : { id, mode, pill, pill_dot: role(form.pill_dot), ...body };
  if (!FULL_FRAME.includes(mode)) {
    const caption = text(form.caption, L.caption);
    if (caption && mode !== 'real_image') card.caption = caption;
    if (mode === 'real_image') delete card.pill_dot;
  }
  const reason = text(form.reason, LIMITS.reason, { lower: false }); if (reason) card.reason = reason;
  if (profile === 'rich') {
    const psych = text(form.psych, LIMITS.psych, { lower: false }); if (psych) card.psych = psych;
    // hero_icon: only on the ui layouts that have room for it; an unknown value is dropped and the card still works.
    if (mode === 'ui' && HERO_LAYOUTS.includes(card.layout)) {
      const hero = String(form.hero_icon == null ? '' : form.hero_icon).toLowerCase().trim().replace(/[\s-]+/g, '_');
      if (HERO_ICONS.includes(hero)) card.hero_icon = hero;
    }
  }
  return { ok: true, card, errors: [] };
}

/* ---------------------------------------------------------------- variety */
// What "the same" means for variety: a ui layout, or the mode for material. Scenes are compared by palette (see varietyCheck).
const layoutKey = c => (c.mode === 'ui' ? c.layout : c.mode === 'material' ? c.mode : null);

// A scene, or a person drawn animated: both are Tatami-style full-frame drawings with a palette.
const isSceneLike = c => Boolean(c) && (c.mode === 'scene' || (c.mode === 'person' && c.render === 'animated'));
// Logos and real-person photos are exempt from the scene rules (they neither count nor interrupt a run).
const isExempt = c => Boolean(c) && (c.mode === 'logo' || (c.mode === 'person' && c.render !== 'animated'));

/**
 * Walks the cards in time order and flags the ones that repeat too much:
 *   same layout (or same material mode) as the card before; more than 2 of one layout in any 10; more than 3 of one mode in a row;
 *   a scene with the same palette as the previous scene; more than 3 scenes in a row (an animated person counts as a scene).
 * Cards without a picture (real_image) are skipped. Returns [{ index, id, reason, avoid: [layouts / palettes to stay away from] }].
 */
function varietyCheck(cards) {
  const seq = cards.map((c, index) => ({ c, index })).filter(x => x.c && x.c.mode !== 'real_image');
  const flagged = new Map();
  const flag = (x, reason, avoid) => {
    const f = flagged.get(x.index) || { index: x.index, id: x.c.id, reasons: [], avoid: new Set() };
    f.reasons.push(reason); avoid.filter(Boolean).forEach(a => f.avoid.add(a));
    flagged.set(x.index, f);
  };

  seq.forEach((x, i) => {
    const key = layoutKey(x.c), prev = seq[i - 1];
    if (prev && key && key === layoutKey(prev.c)) flag(x, `same ${x.c.mode === 'ui' ? 'layout' : 'mode'} (${key}) as the card before`, [key]);
  });

  const layouts = seq.map(x => (x.c.mode === 'ui' ? x.c.layout : null));
  for (let i = 0; i < seq.length; i++) {
    if (!layouts[i]) continue;
    const lo = Math.max(0, i - 9);
    const inWindow = []; for (let j = lo; j <= i; j++) if (layouts[j] === layouts[i]) inWindow.push(j);
    if (inWindow.length > 2) flag(seq[i], `more than 2 ${layouts[i]} cards in 10`, [layouts[i]]);
  }

  // Runs of one mode (ui, material, symbol); scenes have their own rule below.
  let run = 0;
  seq.forEach((x, i) => {
    if (isSceneLike(x.c) || isExempt(x.c)) { run = 0; return; }
    run = i && x.c.mode === seq[i - 1].c.mode ? run + 1 : 1;
    if (run > 3) flag(x, `more than 3 ${x.c.mode} cards in a row`, [layoutKey(x.c)]);
  });

  // Scenes: never the same palette twice in a row, never more than 3 in a row.
  let prevScene = null, sceneRun = 0;
  seq.forEach(x => {
    if (isExempt(x.c)) return;
    if (!isSceneLike(x.c)) { prevScene = null; sceneRun = 0; return; }
    if (prevScene && x.c.palette && x.c.palette === prevScene.c.palette) flag(x, `same scene palette (${x.c.palette}) as the scene before`, [`palette:${x.c.palette}`]);
    sceneRun += 1;
    if (sceneRun > 3) flag(x, 'more than 3 scene pictures in a row', ['scene']);
    prevScene = x;
  });

  return [...flagged.values()].sort((a, b) => a.index - b.index)
    .map(f => ({ index: f.index, id: f.id, reason: f.reasons.join('; '), avoid: [...f.avoid] }));
}

module.exports = {
  MODES, FULL_FRAME, PALETTES, COMPOSITIONS, LOGO_KINDS, RENDERS, ROLES, ICONS, RICH_ICONS, HERO_ICONS, HERO_LAYOUTS, OPS, UNITS, LAYOUTS, LIMITS, RICH_LIMITS, limitsFor,
  slugify, isSceneLike, isExempt,
  cleanText, limitText, wordNumbers, digitNumbers, numbersIn, isGrounded, parseNumber,
  fallbackCard, validateCard, varietyCheck, layoutKey
};
