// Pure helpers shared by the Node server and the browser UI.
// Words are { t: text, s: start seconds, e: end seconds } in timeline order.
// A "mask" is a Uint8Array with one entry per word: 1 = cut, 0 = keep.
// A "range" is [firstWordIndex, lastWordIndex] (inclusive).

const SENTENCE_END = /[.!?]["')\]]*$/;

export function buildSegments(words, { maxWords = 80 } = {}) {
  const segments = [];
  let w0 = 0;

  const push = (w1) => {
    if (w1 <= w0) return;
    segments.push({
      id: segments.length + 1,
      w0,
      w1, // exclusive
      start: words[w0].s,
      end: words[w1 - 1].e
    });
    w0 = w1;
  };

  for (let i = 0; i < words.length; i++) {
    const endsSentence = SENTENCE_END.test(words[i].t);
    if (endsSentence || i + 1 - w0 >= maxWords) push(i + 1);
  }
  push(words.length);

  return segments;
}

export function segmentText(words, seg) {
  return words.slice(seg.w0, seg.w1).map(w => w.t).join(" ");
}

// ---------- masks & ranges ----------

export function rangesToMask(ranges, length) {
  const mask = new Uint8Array(length);
  for (const [a, b] of ranges || []) {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(length - 1, Math.max(a, b));
    for (let i = lo; i <= hi; i++) mask[i] = 1;
  }
  return mask;
}

export function maskToRanges(mask) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i] === 1;
    if (on && start === -1) start = i;
    if (!on && start !== -1) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  return ranges;
}

// ---------- cutting ----------

// Turn "which words are cut" into the time intervals that are KEPT.
// Cut points are placed in the gap next to a removed word, never inside it:
// each side gets up to `pad` seconds but at most half of the available gap.
export function computeKeepIntervals(words, mask, { duration, pad = 0.05 } = {}) {
  const n = words.length;
  const end = Number.isFinite(duration) ? duration : words[n - 1]?.e ?? 0;
  const intervals = [];

  let i = 0;
  while (i < n) {
    if (mask[i]) { i++; continue; }

    let j = i;
    while (j + 1 < n && !mask[j + 1]) j++;

    // start boundary
    let start;
    if (i === 0) {
      start = 0;
    } else {
      const gap = Math.max(0, words[i].s - words[i - 1].e);
      start = words[i].s - Math.min(pad, gap / 2);
    }

    // end boundary
    let stop;
    if (j === n - 1) {
      stop = end;
    } else {
      const gap = Math.max(0, words[j + 1].s - words[j].e);
      stop = words[j].e + Math.min(pad, gap / 2);
    }

    start = Math.max(0, start);
    stop = Math.min(end, stop);
    if (stop > start) intervals.push({ start, end: stop });

    i = j + 1;
  }

  return intervals;
}

// Pause removal: keep every stretch of speech, drop silences longer than maxPause.
export function computePauseIntervals(words, { maxPause = 0.6, padding = 0.08, duration } = {}) {
  const valid = words
    .map(w => ({
      start: Math.max(0, w.s),
      end: Number.isFinite(duration) ? Math.min(duration, w.e) : w.e
    }))
    .filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  if (valid.length === 0) return [];

  const merged = [];
  let current = { ...valid[0] };

  for (let i = 1; i < valid.length; i++) {
    const next = valid[i];
    if (next.start - current.end <= maxPause) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  const padded = merged.map(m => ({
    start: Math.max(0, m.start - padding),
    end: Number.isFinite(duration) ? Math.min(duration, m.end + padding) : m.end + padding
  }));

  const out = [{ ...padded[0] }];
  for (let i = 1; i < padded.length; i++) {
    const last = out[out.length - 1];
    if (padded[i].start <= last.end) last.end = Math.max(last.end, padded[i].end);
    else out.push({ ...padded[i] });
  }
  return out;
}

// Move word timings from the original timeline onto the pause-trimmed timeline.
export function remapWords(words, intervals) {
  const out = [];
  let offset = 0;
  let k = 0;

  for (const w of words) {
    while (k < intervals.length && w.s >= intervals[k].end) {
      offset += intervals[k].end - intervals[k].start;
      k++;
    }
    if (k >= intervals.length) break;

    const iv = intervals[k];
    if (w.s < iv.start) continue; // fell into a removed gap; should not happen

    const s = offset + (w.s - iv.start);
    const e = offset + (Math.min(w.e, iv.end) - iv.start);
    out.push({ t: w.t, s: round3(s), e: round3(Math.max(e, s)) });
  }
  return out;
}

export function totalDuration(intervals) {
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

// For preview playback: where should the player be at time t?
// Returns t if t is inside a kept interval, the next kept start if t is in a
// cut, or null once playback has passed the last kept interval.
export function nextPlayable(intervals, t) {
  if (intervals.length === 0) return null;
  let lo = 0, hi = intervals.length - 1, found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].start <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  if (found === -1) return intervals[0].start;
  if (t < intervals[found].end) return t;
  if (found + 1 < intervals.length) return intervals[found + 1].start;
  return null;
}

// ---------- matching the AI's partial cuts onto words ----------

export function normToken(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokenize(text) {
  return String(text).split(/\s+/).map(normToken).filter(Boolean);
}

// decisions: { removeIds: number[], partials: [{ segment_id, remove_text }] }
export function applyDecisions(words, segments, decisions) {
  const mask = new Uint8Array(words.length);
  const warnings = [];
  const byId = new Map(segments.map(s => [s.id, s]));
  const norm = words.map(w => normToken(w.t));
  let whole = 0;
  let partial = 0;

  const wholeIds = new Set();
  for (const id of decisions.removeIds || []) {
    const seg = byId.get(id);
    if (!seg) continue;
    wholeIds.add(id);
    mask.fill(1, seg.w0, seg.w1);
    whole++;
  }

  for (const item of decisions.partials || []) {
    const seg = byId.get(item.segment_id);
    if (!seg) {
      warnings.push(`Partial cut for unknown segment ${item.segment_id} was ignored.`);
      continue;
    }
    if (wholeIds.has(seg.id)) continue;

    const tokens = tokenize(item.remove_text);
    if (tokens.length === 0) continue;

    // First occurrence that is not already fully cut.
    let hit = -1;
    let fallback = -1;
    for (let i = seg.w0; i + tokens.length <= seg.w1; i++) {
      let ok = true;
      for (let k = 0; k < tokens.length; k++) {
        if (norm[i + k] !== tokens[k]) { ok = false; break; }
      }
      if (!ok) continue;
      if (fallback === -1) fallback = i;
      let already = true;
      for (let k = 0; k < tokens.length; k++) if (!mask[i + k]) { already = false; break; }
      if (!already) { hit = i; break; }
    }
    if (hit === -1) hit = fallback;

    if (hit === -1) {
      warnings.push(`Segment ${seg.id}: could not find "${item.remove_text}" in the transcript, so nothing was cut there.`);
      continue;
    }

    mask.fill(1, hit, hit + tokens.length);
    partial++;
  }

  return { mask, warnings, whole, partial };
}

// ---------- formatting ----------

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function fmtSrt(seconds) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (v, l = 2) => String(v).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function fmtClock(seconds, decimals = 1) {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sec = s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");
  return `${m}:${sec}`;
}
