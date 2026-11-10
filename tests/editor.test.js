import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL("tests/helpers/shared-loader.mjs"));
const { createEditor } = await import("../public/js/editor.js");

const W = (t, s, e) => ({ t, s, e });
const words = [W("a", 0, 1), W("b", 1.2, 2), W("c", 2.2, 3), W("d", 3.2, 4)];

test("cut, undo and redo", () => {
  const ed = createEditor({ words, duration: 5, aiRanges: [[1, 1]], ranges: [[1, 1]] });
  assert.equal(ed.isCut(1), true);
  assert.equal(ed.isAi(1), true);

  assert.equal(ed.set(2, 3, 1), true);
  assert.deepEqual(ed.ranges(), [[1, 3]]);
  assert.equal(ed.set(2, 3, 1), false);          // no change -> no undo entry

  ed.undo();
  assert.deepEqual(ed.ranges(), [[1, 1]]);
  ed.redo();
  assert.deepEqual(ed.ranges(), [[1, 3]]);
});

test("cut runs know who made them", () => {
  const ed = createEditor({ words, duration: 5, aiRanges: [[1, 1]], ranges: [[1, 1]] });
  ed.set(3, 3, 1);
  const runs = ed.cutRuns();
  assert.deepEqual(runs.map(r => r.source), ["ai", "you"]);
  ed.set(2, 2, 1);
  assert.deepEqual(ed.cutRuns().map(r => r.source), ["mixed"]);
});

test("change events report the affected words", () => {
  const ed = createEditor({ words, duration: 5 });
  const seen = [];
  ed.onChange(e => seen.push(e));
  ed.set(2, 1, 1);                               // reversed range is fine
  ed.undo();
  assert.deepEqual(seen, [{ from: 1, to: 2 }, { from: 1, to: 2 }]);
});

test("stats and keep intervals follow the mask", () => {
  const ed = createEditor({ words, duration: 5 });
  assert.equal(ed.stats().cuts, 0);
  ed.set(1, 2, 1);
  const s = ed.stats();
  assert.equal(s.cuts, 1);
  assert.equal(s.cutWords, 2);
  assert.ok(s.removedSeconds > 1.5 && s.removedSeconds < 2.5);
});

test("resetToAi drops manual cuts and restores AI cuts", () => {
  const ed = createEditor({ words, duration: 5, aiRanges: [[1, 1]], ranges: [] });
  ed.set(3, 3, 1);
  ed.resetToAi();
  assert.deepEqual(ed.ranges(), [[1, 1]]);
  ed.undo();
  assert.deepEqual(ed.ranges(), [[3, 3]]);
});
