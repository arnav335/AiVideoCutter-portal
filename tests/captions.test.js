import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STYLE, PRESETS, sanitizeStyle, sanitizeCaptions, makeTimeMap, buildCaptions, captionIndexAt,
  buildAss, assColor, playRes, pickFontFile, cleanFontName
} from "../src/shared/captions.js";

const W = (t, s, e) => ({ t, s, e });
const mask = (n, cut = []) => { const m = new Uint8Array(n); cut.forEach(i => { m[i] = 1; }); return m; };

test("sanitizeStyle fills gaps, clamps and refuses hostile values", () => {
  const s = sanitizeStyle({ size: 9999, color: "red", bold: "yes", fontFamily: "Ar,ial{}\\", fontId: "../x", maxLines: 0 });
  assert.equal(s.size, 200);
  assert.equal(s.color, DEFAULT_STYLE.color);
  assert.equal(s.bold, DEFAULT_STYLE.bold);
  assert.equal(s.fontFamily, "Ar ial");
  assert.equal(s.fontId, null);
  assert.equal(s.maxLines, 1);
  assert.deepEqual(sanitizeStyle(null), DEFAULT_STYLE);
  assert.equal(sanitizeCaptions({}).enabled, true);
  assert.equal(sanitizeCaptions({ enabled: false }).enabled, false);
});

test("presets are valid styles and never move the captions", () => {
  assert.equal(PRESETS.length, 4);
  for (const p of PRESETS) {
    const clean = sanitizeStyle(p.style);
    for (const [key, value] of Object.entries(p.style)) assert.equal(clean[key], value, `${p.id}.${key}`);
    assert.equal("x" in p.style || "y" in p.style || "maxChars" in p.style || "maxLines" in p.style, false);
  }
});

test("time map moves source time onto the final timeline", () => {
  const map = makeTimeMap([{ start: 1, end: 3 }, { start: 5, end: 6 }]);
  assert.equal(map.total, 3);
  assert.equal(map.toFinal(0.5), null);
  assert.equal(map.toFinal(1), 0);
  assert.equal(map.toFinal(2.5), 1.5);
  assert.equal(map.toFinal(4), null);
  assert.equal(map.toFinal(5.5), 2.5);
  const w = map.wordTimes(5.2, 5.4);
  assert.ok(Math.abs(w.start - 2.2) < 1e-9 && Math.abs(w.end - 2.4) < 1e-9);
});

test("captions skip cut words and follow the cut timeline", () => {
  const words = [W("Hello", 0, 0.4), W("um", 0.5, 0.8), W("there.", 0.9, 1.3), W("Next", 3, 3.4), W("one", 3.5, 3.9)];
  const intervals = [{ start: 0, end: 0.45 }, { start: 0.85, end: 1.35 }, { start: 2.95, end: 3.95 }];
  const caps = buildCaptions(words, mask(5, [1]), intervals, DEFAULT_STYLE);

  assert.equal(caps.length, 2);                       // a sentence end starts a new caption
  assert.equal(caps[0].text, "Hello there.");
  assert.equal(caps[1].text, "Next one");
  assert.ok(Math.abs(caps[0].start - 0) < 1e-9);
  assert.ok(Math.abs(caps[1].start - 1.0) < 1e-9);   // 0.45 + 0.5 kept before it, plus 0.05 into its stretch
  assert.equal(captionIndexAt(caps, 0.1), 0);
  assert.equal(captionIndexAt(caps, 100), -1);
});

test("captions wrap by characters and lines, and ALL CAPS applies", () => {
  const words = "one two three four five six seven eight nine ten".split(" ").map((t, i) => W(t, i * 0.3, i * 0.3 + 0.25));
  const intervals = [{ start: 0, end: 3 }];
  const style = { ...DEFAULT_STYLE, maxChars: 12, maxLines: 2, allCaps: true };
  const caps = buildCaptions(words, mask(10), intervals, style);

  assert.ok(caps.length > 1);
  for (const c of caps) {
    assert.ok(c.lines.length <= 2);
    for (const line of c.lines) assert.ok(line.length <= 12, line);
    assert.equal(c.text, c.text.toUpperCase());
  }
});

test("a long silence starts a new caption and short ones stay joined", () => {
  const words = [W("a", 0, 0.2), W("b", 0.3, 0.5), W("c", 2, 2.2)];
  const caps = buildCaptions(words, mask(3), [{ start: 0, end: 3 }], DEFAULT_STYLE);
  assert.deepEqual(caps.map(c => c.text), ["a b", "c"]);
});

test("ASS output has the right size, colours, position and a box layer when asked", () => {
  assert.deepEqual(playRes(1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(playRes(1080, 1920), { w: 1080, h: 1920 });
  assert.deepEqual(playRes(3840, 2160), { w: 1920, h: 1080 });
  assert.equal(assColor("#FF8000", 100), "&H000080FF");
  assert.equal(assColor("#FF8000", 0), "&HFF0080FF");

  const captions = [{ start: 1, end: 2.5, lines: ["Hello {x}", "a\\b"] }];
  const plain = buildAss({ captions, style: DEFAULT_STYLE, width: 1920, height: 1080 });
  assert.match(plain, /PlayResX: 1920/);
  assert.match(plain, /Style: Cap,Arial,58,/);
  assert.match(plain, /Dialogue: 1,0:00:01.00,0:00:02.50,Cap,,0,0,0,,\{\\an5\\pos\(960.0,864.0\)\}Hello \(x\)\\Na\/b/);
  assert.doesNotMatch(plain, /CapBox,,/);

  const boxed = buildAss({ captions, style: { ...DEFAULT_STYLE, bgEnabled: true }, width: 1080, height: 1920, fontFamily: "My Font" });
  assert.match(boxed, /Dialogue: 0,.*,CapBox,/);
  assert.match(boxed, /Style: Cap,My Font,/);
  assert.match(boxed, /PlayResY: 1920/);
});

test("font names cannot break the ASS file", () => {
  assert.equal(cleanFontName("A,B{C}\nD", "x"), "A B C D");
  assert.equal(cleanFontName("", "fallback"), "fallback");
});

test("pickFontFile chooses the nearest weight and the right slant", () => {
  const entry = { files: [
    { file: "400.ttf", weight: 400, italic: false },
    { file: "700.ttf", weight: 700, italic: false },
    { file: "400i.ttf", weight: 400, italic: true }
  ] };
  assert.equal(pickFontFile(entry, { bold: false, italic: false }).file, "400.ttf");
  assert.equal(pickFontFile(entry, { bold: true, italic: false }).file, "700.ttf");
  assert.equal(pickFontFile(entry, { bold: true, italic: true }).file, "400i.ttf");
  assert.equal(pickFontFile({ files: [{ file: "300.ttf", weight: 300, italic: false }] }, { italic: true }).file, "300.ttf");
  assert.equal(pickFontFile(null), null);
});
