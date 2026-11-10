import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSegments, rangesToMask, maskToRanges, computeKeepIntervals,
  computePauseIntervals, remapWords, nextPlayable, applyDecisions
} from "../src/shared/editModel.js";

const W = (t, s, e) => ({ t, s, e });

test("buildSegments splits on sentence punctuation", () => {
  const words = [W("Hi", 0, 0.2), W("there.", 0.2, 0.5), W("Next", 1, 1.2), W("one!", 1.2, 1.5), W("tail", 2, 2.2)];
  const segs = buildSegments(words);
  assert.deepEqual(segs.map(s => [s.id, s.w0, s.w1]), [[1, 0, 2], [2, 2, 4], [3, 4, 5]]);
  assert.equal(segs[1].start, 1);
  assert.equal(segs[1].end, 1.5);
});

test("mask <-> ranges round trip", () => {
  const mask = rangesToMask([[1, 2], [5, 5]], 8);
  assert.deepEqual([...mask], [0, 1, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(maskToRanges(mask), [[1, 2], [5, 5]]);
});

test("keep intervals never include a cut word and pad is split with the gap", () => {
  const words = [W("a", 1, 1.2), W("b", 1.3, 1.5), W("c", 1.6, 1.8), W("d", 2.5, 2.8)];
  const mask = rangesToMask([[1, 1]], 4); // cut "b"
  const iv = computeKeepIntervals(words, mask, { duration: 5, pad: 0.05 });
  assert.equal(iv.length, 2);
  assert.equal(iv[0].start, 0);                       // first word kept -> from the start
  assert.ok(Math.abs(iv[0].end - 1.25) < 1e-9);       // gap 0.1 -> pad 0.05
  assert.ok(Math.abs(iv[1].start - 1.55) < 1e-9);
  assert.equal(iv[1].end, 5);                         // last word kept -> to the end
  for (const v of iv) {
    assert.ok(!(v.start < 1.5 && v.end > 1.3), "interval overlaps the cut word");
  }
});

test("pad is capped by half of a tiny gap", () => {
  const words = [W("a", 0, 1), W("b", 1, 2), W("c", 2, 3)];
  const iv = computeKeepIntervals(words, rangesToMask([[1, 1]], 3), { duration: 3, pad: 0.1 });
  assert.deepEqual(iv, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
});

test("cutting the first and last words trims the edges", () => {
  const words = [W("a", 1, 1.5), W("b", 2, 2.5), W("c", 3, 3.5)];
  const iv = computeKeepIntervals(words, rangesToMask([[0, 0], [2, 2]], 3), { duration: 10, pad: 0.05 });
  assert.equal(iv.length, 1);
  assert.ok(Math.abs(iv[0].start - 1.95) < 1e-9);
  assert.ok(Math.abs(iv[0].end - 2.55) < 1e-9);
});

test("everything cut -> no intervals", () => {
  const words = [W("a", 0, 1)];
  assert.deepEqual(computeKeepIntervals(words, rangesToMask([[0, 0]], 1), { duration: 1 }), []);
});

test("pause intervals merge short gaps and drop long ones", () => {
  const words = [W("a", 1, 1.4), W("b", 1.5, 1.9), W("c", 4, 4.4)];
  const iv = computePauseIntervals(words, { maxPause: 0.6, padding: 0.1, duration: 10 });
  assert.equal(iv.length, 2);
  assert.ok(Math.abs(iv[0].start - 0.9) < 1e-9 && Math.abs(iv[0].end - 2.0) < 1e-9);
  assert.ok(Math.abs(iv[1].start - 3.9) < 1e-9);
});

test("remapWords shifts words onto the trimmed timeline", () => {
  const words = [W("a", 1, 1.4), W("b", 1.5, 1.9), W("c", 4, 4.4)];
  const iv = computePauseIntervals(words, { maxPause: 0.6, padding: 0.1, duration: 10 });
  const out = remapWords(words, iv);
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[0].s - 0.1) < 1e-9);
  assert.ok(Math.abs(out[2].s - (1.1 + 0.1)) < 1e-9);   // first interval is 1.1s long
});

test("nextPlayable skips cuts and ends after the last interval", () => {
  const iv = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
  assert.equal(nextPlayable(iv, 0), 1);
  assert.equal(nextPlayable(iv, 1.5), 1.5);
  assert.equal(nextPlayable(iv, 2.2), 3);
  assert.equal(nextPlayable(iv, 4), null);
  assert.equal(nextPlayable([], 1), null);
});

test("applyDecisions: whole segments, partial snippets, punctuation tolerant", () => {
  const words = [
    W("Hi", 0, 1), W("everyone.", 1, 2),
    W("Today,", 3, 4), W("Today", 4, 5), W("we", 5, 6), W("talk.", 6, 7),
    W("Um.", 8, 9)
  ];
  const segs = buildSegments(words);
  const r = applyDecisions(words, segs, {
    removeIds: [3],
    partials: [{ segment_id: 2, remove_text: "today" }, { segment_id: 1, remove_text: "nothing here" }]
  });
  assert.deepEqual([...r.mask], [0, 0, 1, 0, 0, 0, 1]);
  assert.equal(r.whole, 1);
  assert.equal(r.partial, 1);
  assert.equal(r.warnings.length, 1);
});

test("applyDecisions: repeated snippet cuts the first copy, then the next", () => {
  const words = [W("no", 0, 1), W("no", 1, 2), W("yes.", 2, 3)];
  const segs = buildSegments(words);
  const r = applyDecisions(words, segs, {
    removeIds: [],
    partials: [{ segment_id: 1, remove_text: "no" }, { segment_id: 1, remove_text: "no" }]
  });
  assert.deepEqual([...r.mask], [1, 1, 0]);
});
