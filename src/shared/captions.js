// Caption logic shared by the Node server (burn-in) and the browser (live preview),
// so what you see on the player is what gets rendered.
//
// Sizes are in "caption units": the SHORTER side of the video is always 1080 units,
// whatever its real resolution, so a style looks the same on 720p, 1080p and 4K,
// and on landscape and vertical video.

export const CAPTION_UNIT = 1080;

// Common system fonts offered next to the ones you add. libass falls back to a
// similar font if one is not installed on the machine that renders the export.
export const SYSTEM_FONTS = [
  "Arial", "Arial Black", "Impact", "Verdana", "Tahoma", "Trebuchet MS",
  "Georgia", "Times New Roman", "Courier New", "Segoe UI", "Comic Sans MS", "Helvetica"
];

export const DEFAULT_STYLE = {
  fontFamily: "Arial",
  fontId: null,          // id of an added font (Google / uploaded), or null for a system font
  bold: true,
  italic: false,
  allCaps: false,
  size: 58,              // caption units
  spacing: 0,            // extra letter spacing, caption units
  color: "#FFFFFF",
  textOpacity: 100,      // %
  outlineWidth: 4,
  outlineColor: "#000000",
  shadowSize: 2,
  shadowColor: "#000000",
  shadowOpacity: 60,     // %
  bgEnabled: false,
  bgColor: "#000000",
  bgOpacity: 60,         // %
  bgPadding: 12,
  x: 0.5,                // centre of the caption block, as a fraction of the frame
  y: 0.8,
  maxChars: 28,          // characters per line
  maxLines: 2            // lines per caption
};

// Presets change the look but not the position or the line-wrapping limits.
export const PRESETS = [
  {
    id: "classic", label: "Classic",
    style: {
      fontFamily: "Arial", fontId: null, bold: true, italic: false, allCaps: false,
      size: 58, spacing: 0, color: "#FFFFFF", textOpacity: 100,
      outlineWidth: 4, outlineColor: "#000000",
      shadowSize: 2, shadowColor: "#000000", shadowOpacity: 60,
      bgEnabled: false, bgColor: "#000000", bgOpacity: 60, bgPadding: 12
    }
  },
  {
    id: "pop", label: "Bold pop",
    style: {
      fontFamily: "Impact", fontId: null, bold: false, italic: false, allCaps: true,
      size: 84, spacing: 1, color: "#FFE600", textOpacity: 100,
      outlineWidth: 9, outlineColor: "#000000",
      shadowSize: 5, shadowColor: "#000000", shadowOpacity: 80,
      bgEnabled: false, bgColor: "#000000", bgOpacity: 60, bgPadding: 12
    }
  },
  {
    id: "boxed", label: "Boxed",
    style: {
      fontFamily: "Arial", fontId: null, bold: true, italic: false, allCaps: false,
      size: 54, spacing: 0, color: "#FFFFFF", textOpacity: 100,
      outlineWidth: 0, outlineColor: "#000000",
      shadowSize: 0, shadowColor: "#000000", shadowOpacity: 60,
      bgEnabled: true, bgColor: "#000000", bgOpacity: 70, bgPadding: 14
    }
  },
  {
    id: "cinema", label: "Cinematic",
    style: {
      fontFamily: "Georgia", fontId: null, bold: false, italic: false, allCaps: false,
      size: 56, spacing: 2, color: "#F5F0E6", textOpacity: 100,
      outlineWidth: 0, outlineColor: "#000000",
      shadowSize: 6, shadowColor: "#000000", shadowOpacity: 75,
      bgEnabled: false, bgColor: "#000000", bgOpacity: 60, bgPadding: 12
    }
  }
];

// ---------------------------------------------------------------- settings

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
const num = (v, lo, hi, fallback) => isNum(v) ? clamp(Number(v), lo, hi) : fallback;
const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
const hex = (v, fallback) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;

// Commas and braces would break the ASS file, so they never reach it.
export function cleanFontName(value, fallback) {
  const s = typeof value === "string"
    ? value.replace(/[\u0000-\u001f,{}\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
  return s || fallback;
}

// Make any input (including a partial or hostile one) into a complete, valid style.
export function sanitizeStyle(input, base = DEFAULT_STYLE) {
  const s = input && typeof input === "object" ? input : {};
  const fontId = s.fontId === null ? null
    : typeof s.fontId === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(s.fontId) ? s.fontId
    : base.fontId;

  return {
    fontFamily: cleanFontName(s.fontFamily, base.fontFamily),
    fontId,
    bold: bool(s.bold, base.bold),
    italic: bool(s.italic, base.italic),
    allCaps: bool(s.allCaps, base.allCaps),
    size: num(s.size, 20, 200, base.size),
    spacing: num(s.spacing, -5, 30, base.spacing),
    color: hex(s.color, base.color),
    textOpacity: num(s.textOpacity, 0, 100, base.textOpacity),
    outlineWidth: num(s.outlineWidth, 0, 20, base.outlineWidth),
    outlineColor: hex(s.outlineColor, base.outlineColor),
    shadowSize: num(s.shadowSize, 0, 20, base.shadowSize),
    shadowColor: hex(s.shadowColor, base.shadowColor),
    shadowOpacity: num(s.shadowOpacity, 0, 100, base.shadowOpacity),
    bgEnabled: bool(s.bgEnabled, base.bgEnabled),
    bgColor: hex(s.bgColor, base.bgColor),
    bgOpacity: num(s.bgOpacity, 0, 100, base.bgOpacity),
    bgPadding: num(s.bgPadding, 0, 40, base.bgPadding),
    x: num(s.x, 0, 1, base.x),
    y: num(s.y, 0, 1, base.y),
    maxChars: Math.round(num(s.maxChars, 8, 60, base.maxChars)),
    maxLines: Math.round(num(s.maxLines, 1, 4, base.maxLines))
  };
}

export function sanitizeCaptions(input) {
  const c = input && typeof input === "object" ? input : {};
  return { enabled: bool(c.enabled, true), style: sanitizeStyle(c.style) };
}

// ---------------------------------------------------------------- fonts

// Choose which file of an added font to use for the bold / italic switches.
export function pickFontFile(entry, { bold = false, italic = false } = {}) {
  const files = entry?.files || [];
  if (files.length === 0) return null;

  const upright = files.filter(f => Boolean(f.italic) === Boolean(italic));
  const pool = upright.length ? upright : files;
  const want = bold ? 700 : 400;

  let best = null;
  let bestScore = Infinity;
  for (const f of pool) {
    // Closest weight wins; when bold is wanted, a heavier face beats an equally near lighter one.
    const score = Math.abs(f.weight - want) * 2 + (bold && f.weight < want ? 1 : 0) + (!bold && f.weight > want ? 1 : 0);
    if (score < bestScore) { best = f; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------- timing

// Maps a time on the cut-free source timeline onto the final (exported) timeline.
export function makeTimeMap(intervals) {
  const offsets = [];
  let total = 0;
  for (const iv of intervals) { offsets.push(total); total += iv.end - iv.start; }

  // Last interval that starts at or before t, or -1.
  function find(t) {
    let lo = 0, hi = intervals.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  return {
    total,
    // Final time for source time t, or null when t falls inside a cut.
    toFinal(t) {
      const k = find(t);
      if (k < 0 || t >= intervals[k].end) return null;
      return offsets[k] + (t - intervals[k].start);
    },
    // Final start/end of a word, or null when it is not inside any kept interval.
    wordTimes(s, e) {
      const k = find(s);
      if (k < 0) return null;
      const iv = intervals[k];
      const len = iv.end - iv.start;
      const a = clamp(s - iv.start, 0, len);
      const b = clamp(e - iv.start, a, len);
      return { start: offsets[k] + a, end: offsets[k] + b };
    }
  };
}

// ---------------------------------------------------------------- building captions

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const MAX_GAP = 0.8;      // a longer silence always starts a new caption
const MAX_SPAN = 7;       // seconds on screen, at most
const MIN_SHOW = 0.4;     // a caption stays up at least this long
const BRIDGE = 0.3;       // gaps shorter than this are bridged so captions don't flicker

const len = s => Array.from(s).length;

function greedy(tokens, width) {
  const lines = [];
  let cur = "";
  for (const token of tokens) {
    if (!cur) cur = token;
    else if (len(cur) + 1 + len(token) <= width) cur += " " + token;
    else { lines.push(cur); cur = token; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Same number of lines as the greedy wrap, but with even line lengths.
function balanced(tokens, maxChars) {
  const base = greedy(tokens, maxChars);
  const k = base.length;
  if (k <= 1) return base;
  const total = tokens.reduce((sum, t) => sum + len(t), 0) + tokens.length - 1;
  for (let w = Math.ceil(total / k); w < maxChars; w++) {
    const lines = greedy(tokens, w);
    if (lines.length <= k) return lines;
  }
  return base;
}

// Build the captions for the final video.
//   words      [{ t, s, e }] on the source timeline
//   mask       Uint8Array, 1 = word is cut (left out of the captions)
//   intervals  [{ start, end }] the kept stretches (computeKeepIntervals)
// Returns [{ start, end, lines, text, first, last }] with times on the FINAL timeline.
export function buildCaptions(words, mask, intervals, style) {
  const { maxChars, maxLines, allCaps } = style;
  const map = makeTimeMap(intervals);
  const captions = [];

  let cur = null;
  let prevEnd = -Infinity;
  let prevToken = "";

  const flush = () => {
    if (!cur) return;
    const lines = balanced(cur.tokens, maxChars);
    captions.push({
      start: cur.start,
      end: cur.end,
      lines,
      text: lines.join("\n"),
      first: cur.first,
      last: cur.last
    });
    cur = null;
  };

  for (let i = 0; i < words.length; i++) {
    if (mask[i]) continue;
    const raw = String(words[i].t ?? "").trim();
    if (!raw) continue;

    const times = map.wordTimes(words[i].s, words[i].e);
    if (!times) continue;

    const token = allCaps ? raw.toUpperCase() : raw;

    if (cur) {
      const startsNew =
        times.start - prevEnd > MAX_GAP ||
        SENTENCE_END.test(prevToken) ||
        times.end - cur.start > MAX_SPAN ||
        greedy([...cur.tokens, token], maxChars).length > maxLines;
      if (startsNew) flush();
    }

    if (!cur) cur = { tokens: [], first: i, start: times.start, end: times.end };
    cur.tokens.push(token);
    cur.last = i;
    cur.end = Math.max(cur.end, times.end);
    prevEnd = times.end;
    prevToken = raw;
  }
  flush();

  // Timing polish: minimum on-screen time, and no flicker between neighbours.
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    const next = captions[i + 1];
    c.end = Math.max(c.end, c.start + MIN_SHOW);
    if (next) {
      if (next.start - c.end < BRIDGE) c.end = next.start;
      if (c.end > next.start) c.end = next.start;
    }
  }

  return captions;
}

// The caption on screen at final time t (or -1).
export function captionIndexAt(captions, t) {
  let lo = 0, hi = captions.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (captions[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && t < captions[found].end ? found : -1;
}

// ---------------------------------------------------------------- ASS (burn-in)

// Script size: the shorter side is always CAPTION_UNIT, so libass scales every
// number in the style to the real video for us.
export function playRes(width, height) {
  const k = CAPTION_UNIT / Math.min(width, height);
  return { w: Math.round(width * k), h: Math.round(height * k) };
}

const h2 = n => Math.round(n).toString(16).toUpperCase().padStart(2, "0");

// ASS colours are &HAABBGGRR with AA = transparency.
export function assColor(color, opacityPercent = 100) {
  const r = color.slice(1, 3), g = color.slice(3, 5), b = color.slice(5, 7);
  return `&H${h2(255 * (1 - clamp(opacityPercent, 0, 100) / 100))}${b}${g}${r}`.toUpperCase();
}

function assTime(seconds) {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const assText = line => line.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/[\r\n]+/g, " ");

// fontFamily: the family name libass should look up (the added font's own name, or a system font).
export function buildAss({ captions, style, width, height, fontFamily }) {
  const { w, h } = playRes(width, height);
  const flag = on => (on ? -1 : 0);
  const family = cleanFontName(fontFamily, style.fontFamily);

  const styleLine = (name, { size, primary, outline, back, borderStyle, outlineWidth, shadow }) =>
    `Style: ${name},${family},${size},${primary},${primary},${outline},${back},` +
    `${flag(style.bold)},${flag(style.italic)},0,0,100,100,${style.spacing},0,` +
    `${borderStyle},${outlineWidth},${shadow},5,0,0,0,1`;

  const text = styleLine("Cap", {
    size: style.size,
    primary: assColor(style.color, style.textOpacity),
    outline: assColor(style.outlineColor, 100),
    back: assColor(style.shadowColor, style.shadowOpacity),
    borderStyle: 1,
    outlineWidth: style.outlineWidth,
    shadow: style.shadowSize
  });

  // The box is a second, transparent copy of the text drawn underneath: libass draws
  // the "outline" of a BorderStyle 3 line as a filled rectangle behind it.
  const box = styleLine("CapBox", {
    size: style.size,
    primary: "&HFF000000",
    outline: assColor(style.bgColor, style.bgOpacity),
    back: "&HFF000000",
    borderStyle: 3,
    outlineWidth: style.bgPadding,
    shadow: 0
  });

  const px = (style.x * w).toFixed(1);
  const py = (style.y * h).toFixed(1);

  const events = [];
  for (const c of captions) {
    const body = `{\\an5\\pos(${px},${py})}${c.lines.map(assText).join("\\N")}`;
    const start = assTime(c.start);
    const end = assTime(c.end);
    if (style.bgEnabled) events.push(`Dialogue: 0,${start},${end},CapBox,,0,0,0,,${body}`);
    events.push(`Dialogue: 1,${start},${end},Cap,,0,0,0,,${body}`);
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    text,
    box,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    ""
  ].join("\n");
}
