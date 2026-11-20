'use strict';
/**
 * B-roll planning from the word-level SRT.
 *  1. Words are grouped into numbered, timestamped segments (what the LLM reads).
 *  2. The LLM must give EVERY segment (line) at least one B-roll; long lines may be split into several. Code verifies this and
 *     re-asks for any line that was missed, with a last-resort fallback, so no line is ever left without a B-roll.
 *  3. Any single B-roll can be re-planned on its own (regenerateOne).
 *  4. A second LLM call turns all B-roll descriptions into image prompts (common instructions applied to all).
 */
const { parseJson, LlmError } = require('./llm');
const { usesCards } = require('./themes');
const rich = require('./rich');

const WORD = /[\p{L}\p{N}]+/gu;
const normWord = t => (String(t).toLowerCase().match(WORD) || []).join('');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function buildSegments(cues, { maxWords = 22, gap = 0.9, minDur = 1.5 } = {}) {
  const segs = [];
  let start = 0;
  const close = last => {
    const ws = cues.slice(start, last + 1);
    segs.push({ id: segs.length + 1, first: start, last, start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map(w => w.text).join(' ') });
    start = last + 1;
  };
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const len = i - start + 1;
    const sentenceEnd = /[.!?…。？！][\"')\]]*$/.test(cues[i].text);
    const longEnough = cues[i].end - cues[start].start >= minDur; // a "line" must last long enough to show a picture
    if (!next || (longEnough && ((sentenceEnd && len >= 4) || len >= maxWords || next.start - cues[i].end > gap))) close(i);
  }
  // A tiny last line is merged into the one before it.
  if (segs.length > 1) {
    const l = segs[segs.length - 1], pv = segs[segs.length - 2];
    if (l.end - l.start < minDur) { pv.last = l.last; pv.end = l.end; pv.text += ' ' + l.text; segs.pop(); }
  }
  return segs;
}

function chunkSegments(segs, maxWords) {
  const chunks = [];
  let cur = [], words = 0;
  for (const s of segs) {
    const n = s.text.split(/\s+/).length;
    if (cur.length && words + n > maxWords) { chunks.push(cur); cur = []; words = 0; }
    cur.push(s); words += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const stamp = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const formatSegments = segs => segs.map(s => `[${s.id}] ${stamp(s.start)}-${stamp(s.end)} ${s.text}`).join('\n');

// Safety rails only (not user options): the AI decides placement and length; these just stop absurd values.
const HARD_MIN = 1.0, HARD_MAX = 20;

/* ---------------- prompt engineering: the B-roll director ---------------- */

const DIRECTOR_RULES = `# ROLE
You are a senior YouTube video editor. You read a timed transcript of a talking video and, for every line, write down what a cutaway picture (B-roll) for that line would show. A later step decides which of the lines really get a picture and which neighbouring lines share one, so you describe EVERY line.

# INPUT
The transcript comes from a word-level SRT file, grouped into numbered segments:
  [id] start-end spoken text
- "id" is the segment number. "start" and "end" are m:ss.s timestamps in the video. The timing is accurate: trust it.
- Segments are consecutive pieces of one continuous speech. Read them in order, as a viewer would hear them.

# WHAT YOU DECIDE
EVERY numbered segment (line) of the transcript MUST get an entry. You never skip a line, not even a greeting, a transition, a sign-off, filler, a call to action or an opinion. If a line has nothing obvious to show, describe the simplest fitting stand-in: the place or object the line is about, or a person speaking. You decide:
1. WHAT each B-roll shows.
2. Whether a long line is split into 2 or 3 consecutive B-rolls (only when it has distinct sub-ideas, or lasts more than about 8 seconds).
3. Where each split inside a line starts and ends.

# HOW TO DECIDE
1. Go through the segments one by one, in order, from the first to the last. Do not jump ahead and do not leave any out.
2. Every segment gets at least one B-roll. Never merge two segments into one B-roll: each segment has its own B-roll(s).
3. The first B-roll of a segment starts when the segment starts. Extra B-rolls inside the same segment start at the words where the next sub-idea begins. The last B-roll of a segment ends at the end of that segment's last sentence or clause.
4. Never let one image run across two segments. Avoid flicker: no B-roll shorter than about 1.5 s.
5. B-rolls never overlap, and together they cover the WHOLE transcript from the first segment to the last, with no line missing.
6. DESCRIBE what the picture shows as plain INFORMATION taken from the spoken words: the subject, the objects, the place or the action the line is about, in ONE short sentence (about 5 to 15 words). Say only what the speaker says or directly implies, and add nothing of your own. NO style or aesthetics of any kind: no mood, lighting, colours, atmosphere, composition, camera, art style, and no "beautiful", "dramatic" or "cinematic" words; no text, captions or logos. Describe a picture, not an idea ("a crowded night market", not "the concept of street food"). Another step writes the final image prompt and adds the style.`;

// Theme "card": the next step fills a card form from these descriptions, so they must keep the facts.
const CARD_DIRECTOR_ADD = `
7. KEEP every number, name, date and comparison from the speech exactly as spoken (for example "3,104 dollars versus 2,119", "Cannae, 216 BC", "amateur versus professional"): the next step builds a data card from them and cannot invent them. Still no style words.`;
const directorRules = theme => (usesCards(theme) ? DIRECTOR_RULES + CARD_DIRECTOR_ADD : DIRECTOR_RULES);

function planSystem(theme) {
  return `${directorRules(theme)}

# OUTPUT CONTRACT
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"broll":[{"start_segment":12,"start_text":"...","end_segment":12,"end_text":"...","description":"..."}]}
- "start_segment": id of the segment where the B-roll starts.
- "start_text": 2 to 8 words copied EXACTLY (same spelling, same order) from that segment: the words at which the image appears.
- "end_segment": id of the segment where it ends (same as start_segment, or a later one).
- "end_text": 1 to 6 words copied EXACTLY from the end segment: the LAST words spoken while the image is still on screen.
- "description": see rule 6 (plain information only, no style).
- Entries are in time order and never overlap. Every segment id you were given must appear as "start_segment" in at least one entry. An empty list is never a valid answer.

# EXAMPLE
Input:
[3] 0:08.2-0:13.9 Engineers used more than eighteen thousand iron parts and two and a half million rivets to build it.
[4] 0:14.0-0:17.6 But honestly, the best part is seeing it sparkle at night.
Output:
{"broll":[{"start_segment":3,"start_text":"eighteen thousand iron parts","end_segment":3,"end_text":"million rivets","description":"Iron beams joined with thousands of rivets."},{"start_segment":4,"start_text":"sparkle at night","end_segment":4,"end_text":"at night","description":"The Eiffel Tower lit up at night."}]}

# FINAL CHECK (do silently before answering)
- COVERAGE: go through the segment ids you were given one by one; each one has at least one entry. Add the ones you missed.
- Every start_text and end_text appears verbatim in its segment.
- Entries are in time order, nothing overlaps, ids are within the range you were given.
- Every description is one short, plain sentence of information with no style words.`;
}

function planUser({ segs, part, parts }) {
  return `${parts > 1 ? `This is part ${part} of ${parts} of the transcript. Only use segment ids that appear below.\n` : ''}TRANSCRIPT:
${formatSegments(segs)}

Return the JSON now.`;
}

function regenSystem(theme) {
  return `${directorRules(theme)}

# THIS TASK
The editor is unhappy with ONE existing B-roll and wants it planned again. You get the transcript around it, the free time window it may occupy (the rest of the timeline is taken by other B-rolls), and the current version.
- Decide again, from the speech, the best moment, start, end and picture for this one B-roll.
- Give a clearly DIFFERENT idea from the current description (a different subject, or a different way to show the same information), while still supporting what is being said. Keep it plain information, no style words.
- The new B-roll must start and end inside the allowed window. Lines outside the window are shown for context only.

# OUTPUT CONTRACT
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"start_segment":12,"start_text":"...","end_segment":12,"end_text":"...","description":"..."}
- "start_text": 2 to 8 words copied EXACTLY from the start segment, where the image appears.
- "end_text": 1 to 6 words copied EXACTLY from the end segment, the last words spoken while the image is on screen.
- "end_segment" is the same as "start_segment" or a later id.
- "description": see rule 6.`;
}

// Finds a phrase inside a segment's words; returns the start of its first word and end of its last word, or null.
// Tolerates a slightly misquoted phrase by matching any run of 2+ of its words (or the single word).
function locate(anchor, seg, cues) {
  const toks = String(anchor || '').split(/\s+/).map(normWord).filter(Boolean);
  if (!toks.length) return null;
  const words = cues.slice(seg.first, seg.last + 1);
  const wt = words.map(w => normWord(w.text));
  const cl = i => Math.min(words.length - 1, Math.max(0, i));
  for (let len = toks.length; len >= Math.min(2, toks.length); len--) {
    for (let off = 0; off + len <= toks.length; off++) {
      const sub = toks.slice(off, off + len);
      for (let i = 0; i + len <= wt.length; i++) {
        if (sub.every((t, k) => wt[i + k] === t)) {
          return { start: words[cl(i - off)].start, end: words[cl(i - off + toks.length - 1)].end };
        }
      }
    }
  }
  return null;
}

// Turns one AI entry into exact times (looked up in the SRT words). Returns null if unusable.
function resolveEntry(r, { segById, cues, lo, hi, audioDuration }) {
  const sid = Math.round(Number(r.start_segment != null ? r.start_segment : r.segment));
  if (!Number.isFinite(sid) || sid < lo || sid > hi || !String(r.description || '').trim()) return null;
  const seg = segById.get(sid);
  const eid = Math.round(Number(r.end_segment));
  const endSeg = Number.isFinite(eid) && eid >= sid && eid <= hi ? segById.get(eid) : seg;
  const locS = locate(r.start_text != null ? r.start_text : r.anchor_text, seg, cues);
  const locE = locate(r.end_text, endSeg, cues);
  const start = locS ? locS.start : seg.start;
  let end = locE && locE.end > start ? locE.end : endSeg.end;
  if (end <= start) end = start + HARD_MIN;
  end = clamp(end, start + HARD_MIN, start + HARD_MAX);
  if (audioDuration) end = Math.min(end, audioDuration);
  return { sid, endId: endSeg.id, start, end, anchor: String(r.start_text != null ? r.start_text : r.anchor_text || '').slice(0, 120), description: String(r.description).trim() };
}

// Turns AI entries into plan items. The FIRST B-roll of every line starts exactly when that line starts, so each line gets its own picture.
function entriesToItems(arr, { segs, segById, cues, audioDuration }) {
  const lo = segs[0].id, hi = segs[segs.length - 1].id;
  const items = [];
  for (const r of arr) {
    const e = r && resolveEntry(r, { segById, cues, lo, hi, audioDuration });
    if (!e || e.end - e.start < 0.2) continue;
    items.push({ sid: e.sid, endId: e.endId, start: e.start, end: e.end, anchor: e.anchor, description: e.description });
  }
  items.sort((a, b) => a.start - b.start);
  const seen = new Set();
  for (const it of items) {
    if (!seen.has(it.sid)) { seen.add(it.sid); it.start = segById.get(it.sid).start; }
    // One picture never runs over into the next line.
    const own = segById.get(it.sid);
    if (it.end > own.end + 0.05) it.end = Math.max(own.end, it.start + 0.2);
    it.quote = own.text.slice(0, 300);
  }
  return items;
}

async function askPlan({ llm, segs, part, parts, extra, theme }) {
  const system = rich.isRich(llm) ? rich.planSystemRich() : planSystem(theme);   // Claude gets the rich prompt, same JSON contract
  const text = await llm.chat({ system, user: planUser({ segs, part, parts }) + (extra ? `\n\n${extra}` : '') });
  const data = parseJson(text);
  return Array.isArray(data) ? data : data.broll || data.brolls || data.items || [];
}

async function askWithRetry(args) {
  try { return await askPlan(args); } catch (e) {
    if (e instanceof LlmError && (e.code === 'BADJSON' || e.code === 'TRUNCATED' || e.code === 'EMPTY')) return askPlan(args);
    throw e;
  }
}

// Plans one part of the transcript and GUARANTEES that every line in it has at least one B-roll.
async function planChunk({ llm, segs, part, parts, segById, cues, audioDuration, theme, log = () => {} }) {
  const ctx = { segById, cues, audioDuration };
  let items = entriesToItems(await askWithRetry({ llm, segs, part, parts, theme }), { segs, ...ctx });
  const missingOf = () => { const have = new Set(items.map(i => i.sid)); return segs.filter(s => !have.has(s.id)); };

  // The AI missed some lines: ask again for just those lines (up to 3 times).
  for (let round = 1; round <= 3; round++) {
    const missing = missingOf();
    if (!missing.length) break;
    log(`  ${missing.length} line(s) had no B-roll (${missing.slice(0, 8).map(m => m.id).join(', ')}${missing.length > 8 ? '…' : ''}); asking again for them (try ${round})…`);
    const extra = `IMPORTANT: your earlier answer left these segments without B-roll: ${missing.map(m => m.id).join(', ')}. Give every one of them at least one B-roll now. Only use these segment ids.`;
    try {
      const more = entriesToItems(await askWithRetry({ llm, segs: missing, part: 1, parts: 1, extra, theme }), { segs: missing, ...ctx });
      items = items.concat(more.filter(m => missing.some(s => s.id === m.sid)));
    } catch (e) { if (!(e instanceof LlmError)) throw e; }
  }

  // Last resort: a line the AI still skipped gets a B-roll built from the line's own words, so nothing is ever missing.
  for (const m of missingOf()) {
    log(`  Line ${m.id} still had no B-roll; added one from its own words.`);
    items.push({ sid: m.id, endId: m.id, start: m.start, end: Math.max(m.end, m.start + HARD_MIN), anchor: m.text.split(/\s+/).slice(0, 6).join(' '),
      description: `What this line talks about: "${m.text.slice(0, 160)}"` });
  }
  items.sort((a, b) => a.start - b.start);
  return items.map(it => ({
    start: it.start, end: it.end, anchor: it.anchor, description: it.description,
    quote: it.quote || segById.get(it.sid).text.slice(0, 300), sid: it.sid
  }));
}

// Sort and lay the B-rolls back to back: each one runs until the next begins, the first starts at 0:00 and the last runs to the end.
function finalizePlan(items, { minGap = 0.4, total = 0 } = {}) {
  items.sort((a, b) => a.start - b.start);
  const kept = [];
  for (const it of items) {
    const prev = kept[kept.length - 1];
    if (prev && it.start - prev.start < minGap) continue; // two starting at the same instant: keep the first
    kept.push({ ...it });
  }
  kept.forEach((it, i) => {
    const next = kept[i + 1];
    it.end = next ? next.start : Math.max(it.end, total || 0);
  });
  if (kept.length) kept[0].start = 0;
  return kept.map((it, i) => { const { sid, ...rest } = it; return { id: `b${String(i + 1).padStart(3, '0')}`, ...rest, prompt: '', enabled: true }; });
}

async function planAll({ llm, cues, audioDuration, maxChunkWords, theme, log }) {
  const segs = buildSegments(cues);
  if (!segs.length) throw new Error('The transcript is empty.');
  const segById = new Map(segs.map(s => [s.id, s]));
  const chunks = chunkSegments(segs, maxChunkWords);
  log(`Transcript split into ${segs.length} segments (${chunks.length} part${chunks.length === 1 ? '' : 's'}).`);
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    log(`Asking the AI to plan B-roll, part ${i + 1}/${chunks.length}…`);
    const args = { llm, segs: chunks[i], part: i + 1, parts: chunks.length, segById, cues, audioDuration, theme, log };
    const found = await planChunk(args);
    log(`  ${chunks[i].length} line(s) -> ${found.length} B-roll(s)`);
    all.push(...found);
  }
  const plan = finalizePlan(all, { total: audioDuration || segs[segs.length - 1].end });
  if (!plan.length) throw new Error('No B-roll could be planned. Try again, or add B-rolls by hand.');
  log(`Coverage check: all ${segs.length} lines have a B-roll.`);
  return plan;
}

/* ---------------- regenerate ONE B-roll ---------------- */

// Re-plans a single B-roll inside the free window between its enabled neighbours.
// Returns { start, end, quote, anchor, description }.
async function regenerateOne({ llm, cues, brolls, id, audioDuration, theme, log }) {
  const segs = buildSegments(cues);
  if (!segs.length) throw new Error('The transcript is empty.');
  const segById = new Map(segs.map(s => [s.id, s]));
  const idx = brolls.findIndex(b => b.id === id);
  if (idx < 0) throw new Error('B-roll not found.');
  const cur = brolls[idx];
  const prev = brolls.slice(0, idx).reverse().find(b => b.enabled);
  const next = brolls.slice(idx + 1).find(b => b.enabled);
  const total = audioDuration || segs[segs.length - 1].end;
  // Free window = gap between neighbours, capped to ±40 s around the item so the request stays small.
  let lo = Math.max(prev ? prev.end : 0, cur.start - 40), hi = Math.min(next ? next.start : total, cur.end + 40);
  lo = Math.min(lo, cur.start); hi = Math.max(hi, cur.end);

  const view = segs.filter(s => s.end >= lo - 8 && s.start <= hi + 8);
  const inWin = view.filter(s => s.end > lo && s.start < hi);
  if (!inWin.length) throw new Error('There is no speech around this B-roll to plan from.');
  const wLo = inWin[0].id, wHi = inWin[inWin.length - 1].id;
  const user = `ALLOWED WINDOW: ${stamp(lo)} to ${stamp(hi)} (segments ${wLo} to ${wHi}). The new B-roll must start and end inside it.

CURRENT B-ROLL TO REPLACE: ${stamp(cur.start)}-${stamp(cur.end)}
Current description: ${JSON.stringify(cur.description || '')}

TRANSCRIPT (lines outside the window are context only):
${formatSegments(view)}

Return the JSON now.`;

  const ask = async () => {
    const data = parseJson(await llm.chat({ system: rich.isRich(llm) ? rich.regenSystemRich() : regenSystem(theme), user }));
    const r = Array.isArray(data) ? data[0] : (data.broll || data.brolls || data.items || [data])[0];
    const e = r && resolveEntry(r, { segById, cues, lo: wLo, hi: wHi, audioDuration });
    if (!e) throw new LlmError('The AI answer had no usable B-roll.', 'BADJSON');
    return e;
  };
  let e;
  try { e = await ask(); } catch (err) {
    if (err instanceof LlmError && ['BADJSON', 'TRUNCATED', 'EMPTY'].includes(err.code)) { log('  The AI answer was unusable; trying once more…'); e = await ask(); } else throw err;
  }
  // If the AI placed it outside the free window, keep the old timing and take only the new picture.
  const inside = e.start >= lo - 0.05 && e.end <= hi + 0.05 && e.end - e.start >= HARD_MIN;
  const start = inside ? e.start : cur.start, end = inside ? e.end : cur.end;
  const sIds = segs.filter(s => s.end > start && s.start < end).map(s => s.id);
  const quote = segs.filter(s => sIds.includes(s.id)).map(s => s.text).join(' ').slice(0, 300);
  if (!inside) log('  The AI picked a time outside the free window; kept the original timing.');
  return { start, end, quote, anchor: inside ? e.anchor : cur.anchor, description: e.description };
}

/* ---------------- which lines deserve a picture, and which share one ---------------- */
/**
 * Second AI pass, run AFTER every line has its own description. It reads all lines (words + description) and decides
 *   - which lines deserve a picture at all (the others are kept in the list but switched off, so you can tick them later)
 *   - which neighbouring lines share ONE picture (a group: one row, one description, one image)
 * Groups are plain B-roll items with a `lines` list, so prompts, images, the preview and the export need no special care.
 */
const SELECT_RULES = `# ROLE
You are a senior YouTube video editor. A talking video has been split into numbered lines, and every line already has a plain description of a possible cutaway picture (B-roll). You now decide where pictures are really worth showing.

# INPUT
A JSON list of lines in time order: { "id", "time", "line" (the spoken words), "picture" (the description already written) }.

# WHAT YOU DECIDE
1. WHICH lines deserve a picture. A picture earns its place when it SHOWS something the viewer gains from seeing: a concrete thing, place, person, object, number or result, a process, an example, a comparison, a demonstration. A picture is wasted on greetings, introductions, sign-offs, calls to action (like, subscribe), transitions ("so", "anyway"), filler, jokes with nothing to show, plain opinions, abstract statements, and lines whose picture would only repeat the previous one. Lines you leave out simply stay as plain video.
2. WHICH NEIGHBOURING lines share ONE picture. Group two or more lines that sit right next to each other and talk about the same subject, so a single picture stays on screen for all of them. Only group lines that are directly next to each other, in order, and keep groups short (usually 2 to 4 lines, under about 25 seconds in total). Give each group ONE description: a single short, plain sentence of information about what the shared picture shows, covering all its lines. No style or aesthetics (no mood, lighting, colours, camera, "beautiful" or "cinematic").

Use judgement: usually something like a third to a half of the lines get a picture. Spread them through the whole video, and do not leave a long stretch without any picture unless its lines truly have nothing to show.

# OUTPUT CONTRACT
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"pictures":[{"ids":["b003"]},{"ids":["b005","b006"],"description":"..."}]}
- Every entry is one picture. "ids" lists the line ids it covers, in time order, directly next to each other. One id = a line with its own picture (keep its description; give no "description"). Two or more ids = a group sharing one picture (give "description").
- Lines that do not appear in any entry get no picture. Each id appears at most once. Use only ids you were given.
- Entries are in time order.`;

// Theme "card": every picture is a data / idea card, so the picker looks for lines that have something to put on a card.
const CARD_SELECT_ADD = `# CARD THEME (this video uses cards; these rules replace the "third to a half" guidance above)
A line earns a card when it contains a number, a comparison, a list, steps, a formula, a clear before/after, a named thing, a strong claim, a warning, or a vivid behaviour. Skip greetings, sign-offs, calls to action, filler, questions with nothing to show, and REPEATED TAKES: if two neighbouring lines are near-identical retakes of the same sentence, only the LAST one gets a picture. Aim for about one card per 8 to 12 seconds of speech, and never leave a stretch longer than about 25 seconds without a card unless it truly has nothing to show.

`;
const selectSystem = theme => (usesCards(theme) ? SELECT_RULES.replace('# OUTPUT CONTRACT', `${CARD_SELECT_ADD}# OUTPUT CONTRACT`) : SELECT_RULES);

function selectUser(batch, { part, parts }) {
  const rows = batch.map(b => ({ id: b.id, time: `${stamp(b.start)}-${stamp(b.end)}`, line: b.quote, picture: b.description }));
  return `${parts > 1 ? `This is part ${part} of ${parts} of the video. Only use ids that appear below.\n` : ''}LINES:\n${JSON.stringify(rows, null, 1)}\n\nReturn the JSON now.`;
}

function readPictures(data) {
  const arr = Array.isArray(data) ? data : data.pictures || data.selected || data.groups || data.broll || [];
  return (Array.isArray(arr) ? arr : []).map(e => {
    if (typeof e === 'string' || typeof e === 'number') return { ids: [String(e)] };
    if (Array.isArray(e)) return { ids: e.map(String) };
    const ids = e && (Array.isArray(e.ids) ? e.ids : e.id != null ? [e.id] : []);
    return { ids: (ids || []).map(String), description: e && e.description };
  });
}

// Turns the AI's entries into decisions: { at: [items next to each other], description }.
// Unknown ids and repeats are ignored; ids that are not directly next to each other are split into separate runs.
function decide(entries, batch) {
  const index = new Map(batch.map((b, i) => [String(b.id), i]));
  const taken = new Set();
  const out = [];
  for (const e of entries) {
    const idx = [...new Set(e.ids)].filter(id => index.has(id) && !taken.has(id)).map(id => index.get(id)).sort((a, b) => a - b);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      out.push({ at: run.map(i => batch[i]), description: run.length > 1 ? String(e.description || '').trim() : '' });
      run.forEach(i => taken.add(String(batch[i].id)));
      run = [];
    };
    for (const i of idx) { if (run.length && i !== run[run.length - 1] + 1) flush(); run.push(i); }
    flush();
  }
  return out.sort((a, b) => index.get(String(a.at[0].id)) - index.get(String(b.at[0].id)));
}

// The lines a B-roll item covers: a group lists its own, a single item is its own line.
const linesOf = b => (Array.isArray(b.lines) && b.lines.length > 1 ? b.lines : [{ start: b.start, end: b.end, quote: b.quote || '', description: b.description || '' }]);

// Merges items that sit next to each other into ONE B-roll (one description, one picture) that covers all their lines.
//   primary     which member's id / description / prompt the group keeps (default: the first). Its image stays valid.
//   description replaces the group's description (the prompt is then cleared, it no longer matches).
function mergeGroup(members, { primary = members[0], description } = {}) {
  const lines = members.flatMap(linesOf).map(l => ({ start: l.start, end: l.end, quote: String(l.quote || '').slice(0, 400), description: String(l.description || '') }));
  const quotes = lines.map(l => l.quote);
  const text = String(description != null && String(description).trim() ? description : primary.description || '').trim();
  // A card made for one line no longer fits a merged group: its card, mode and prompt are cleared (the description changed).
  const hadCard = members.some(m => m.card || m.mode || m.needsRealImage);
  const merged = {
    ...members[0],
    id: primary.id,
    start: members[0].start,
    end: members[members.length - 1].end,
    quote: quotes.filter((q, i) => q && q !== quotes[i - 1]).join(' ').slice(0, 400),
    description: text,
    prompt: text === String(primary.description || '').trim() ? primary.prompt || '' : '',
    enabled: true,
    lines
  };
  if (hadCard) { merged.prompt = ''; }
  for (const k of ['card', 'mode', 'needsRealImage', 'searchHint', 'refs', 'source', 'file', 'logoSlug', 'render']) delete merged[k];
  return merged;
}

// Splits a group back into its lines, each with the description it had before it was grouped.
// The first line keeps the group's id; `nextId()` makes ids for the others.
function splitGroup(item, nextId) {
  if (!Array.isArray(item.lines) || item.lines.length < 2) return [item];
  return item.lines.map((l, i) => ({
    id: i === 0 ? item.id : nextId(), start: l.start, end: l.end, quote: l.quote, anchor: i === 0 ? item.anchor || '' : '',
    description: l.description, prompt: '', enabled: item.enabled
  }));
}

async function askSelect({ llm, batch, part, parts, theme }) {
  const once = async () => readPictures(parseJson(await llm.chat({ system: rich.isRich(llm) ? rich.selectSystemRich() : selectSystem(theme), user: selectUser(batch, { part, parts }) })));
  try { return await once(); } catch (e) {
    if (e instanceof LlmError && (e.code === 'BADJSON' || e.code === 'TRUNCATED' || e.code === 'EMPTY')) return once();
    throw e;
  }
}

// items: the plan, every line described. Returns { items, picked, groups }: the same plan with the undeserving lines switched
// off (their descriptions stay) and the AI's groups merged into single items. Throws if the AI picked nothing.
async function chooseBroll({ llm, items, batchSize = 120, theme, log = () => {} }) {
  const decisions = [];
  const parts = Math.ceil(items.length / batchSize);
  for (let off = 0, part = 1; off < items.length; off += batchSize, part++) {
    log(`Deciding which lines deserve a B-roll and which share one picture${parts > 1 ? ` (part ${part}/${parts})` : ''}…`);
    const batch = items.slice(off, off + batchSize);
    decisions.push(...decide(await askSelect({ llm, batch, part, parts, theme }), batch));
  }
  const starts = new Map(decisions.map(d => [String(d.at[0].id), d]));
  const merged = new Set(decisions.flatMap(d => d.at.slice(1).map(m => String(m.id))));
  const out = [];
  let picked = 0, groups = 0;
  for (const b of items) {
    const id = String(b.id);
    if (merged.has(id)) continue;
    const d = starts.get(id);
    if (!d) { out.push({ ...b, enabled: false }); continue; }
    picked++;
    if (d.at.length > 1) { groups++; out.push(mergeGroup(d.at, { description: d.description })); }
    else out.push({ ...b, enabled: true });
  }
  if (!picked) throw new Error('The AI did not pick any line for a B-roll.');
  return { items: out, picked, groups };
}

/* ---------------- image prompts ---------------- */

function promptSystem(common) {
  return `You write prompts for an AI image generation model. Each prompt will generate one still image used as YouTube B-roll.

For every B-roll you receive: id, description (what the image should show) and line (the words being spoken at that moment).

Write ONE prompt per B-roll: a single vivid, self-contained paragraph of 1-3 sentences describing the subject, setting, composition, lighting, colors and mood. Be concrete and visual. Do not mention the aspect ratio. Do not ask for text, captions, logos or watermarks in the image unless the description explicitly needs readable text.
${common && common.trim() ? `
COMMON INSTRUCTIONS (apply to EVERY prompt, exactly, so all images look like one consistent set):
${common.trim()}
` : ''}
Reply with JSON only, exactly this shape, one entry for every id you were given:
{"prompts":[{"id":"b001","prompt":"..."}]}`;
}

async function promptBatch({ llm, items, common, log }) {
  const isRich = rich.isRich(llm);
  const user = `${isRich && common && common.trim() ? `COMMON INSTRUCTIONS:\n${common.trim()}\n\n` : ''}B-ROLLS:\n${JSON.stringify(items.map(i => ({ id: i.id, description: i.description, line: i.quote })), null, 1)}\n\nReturn the JSON now.`;
  const data = parseJson(await llm.chat({ system: isRich ? rich.promptSystemRich() : promptSystem(common), user }));
  const arr = Array.isArray(data) ? data : data.prompts || data.items || [];
  const map = new Map();
  for (const r of arr) if (r && r.id && String(r.prompt || '').trim()) map.set(String(r.id), String(r.prompt).trim());
  return map;
}

// One call for everything; if the answer is cut off / malformed, split the batch and retry the halves.
async function promptsFor({ llm, items, common, batchSize, log }) {
  const result = new Map();
  async function run(batch, depth = 0) {
    try {
      const got = await promptBatch({ llm, items: batch, common, log });
      for (const [k, v] of got) result.set(k, v);
    } catch (e) {
      if (e instanceof LlmError && (e.code === 'BADJSON' || e.code === 'TRUNCATED') && batch.length > 1 && depth < 5) {
        log(`  Answer for ${batch.length} items was unusable; splitting…`);
        const h = Math.ceil(batch.length / 2);
        await run(batch.slice(0, h), depth + 1);
        await run(batch.slice(h), depth + 1);
      } else throw e;
    }
  }
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    log(`Writing image prompts for ${batch.length} B-roll(s)${items.length > batchSize ? ` (batch ${Math.floor(i / batchSize) + 1})` : ' in one request'}…`);
    await run(batch);
  }
  const missing = items.filter(i => !result.has(i.id));
  if (missing.length) {
    log(`  ${missing.length} prompt(s) missing from the answer; asking again for those…`);
    await run(missing);
  }
  return result;
}

function applySuffix(prompt, suffix) {
  const s = (suffix || '').trim();
  if (!s) return prompt;
  return `${/[.!?]$/.test(prompt) ? prompt : prompt + '.'} ${s}`;
}

module.exports = {
  buildSegments, chunkSegments, planAll, regenerateOne, promptsFor, applySuffix, finalizePlan, locate,
  chooseBroll, mergeGroup, splitGroup, linesOf, decide, planSystem, selectSystem, regenSystem
};
