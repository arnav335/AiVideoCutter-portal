'use strict';
// Maps times on the review timeline (the original recording) onto the exported timeline (after the cuts).
// `intervals` are the kept [{start, end}] stretches, sorted, exactly as used for the export.

// Seconds of kept footage before time t.
function keptBefore(intervals, t) {
  let acc = 0;
  for (const iv of intervals) {
    if (t <= iv.start) break;
    acc += Math.min(t, iv.end) - iv.start;
  }
  return acc;
}

const totalKept = intervals => intervals.reduce((s, iv) => s + (iv.end - iv.start), 0);

// B-roll { start, end } (review timeline) -> output timeline. Cut-out time simply disappears.
function mapSpan(intervals, start, end) {
  return { start: keptBefore(intervals, start), end: keptBefore(intervals, end) };
}

// Seconds of [start, end] that lie inside kept footage (the rest is cut out).
function keptWithin(intervals, start, end) {
  let sum = 0;
  for (const iv of intervals) {
    if (iv.end <= start) continue;
    if (iv.start >= end) break;
    sum += Math.min(end, iv.end) - Math.max(start, iv.start);
  }
  return sum;
}

// Pulls a B-roll's ends in to the kept footage: it begins at the first kept moment and ends at the last.
// Slivers shorter than `minPiece` (just the padding around a neighbouring word) don't count as kept footage.
// Returns null when no real piece of [start, end] is kept.
function snapToKept(intervals, start, end, minPiece = 0.15) {
  let s = null, e = null;
  for (const iv of intervals) {
    if (iv.end <= start) continue;
    if (iv.start >= end) break;
    const a = Math.max(start, iv.start), b = Math.min(end, iv.end);
    if (b - a < minPiece) continue;
    if (s === null) s = a;
    e = b;
  }
  return s === null ? null : { start: s, end: e };
}

module.exports = { keptBefore, totalKept, mapSpan, keptWithin, snapToKept };
