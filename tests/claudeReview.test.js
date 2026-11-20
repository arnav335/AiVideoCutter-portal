import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSegments, segmentText, applyDecisions } from "../src/shared/editModel.js";
import { reviewWithClaude, fmtStart, fmtPause } from "../src/functions/claudeReview.js";
import { CLAUDE_RETAKE_PROMPT } from "../src/prompts/retakePromptClaude.js";
import { cleanSettings } from "../src/server/settings.js";

const CFG = { maxCutRatio: 0.25, longWholeWords: 12, pauseFlagSec: 0.8, partMaxWords: 6000, contextSegments: 10, maxVerifyItems: 60 };

// ~12 words per sentence, 0.3 s per word, 0.5 s pause between sentences.
function makeWords(nSeg, perSeg = 12) {
  const words = [];
  let t = 0;
  for (let s = 1; s <= nSeg; s++) {
    for (let k = 0; k < perSeg; k++) {
      const last = k === perSeg - 1;
      words.push({ t: `w${s}x${k}${last ? "." : ","}`, s: t, e: t + 0.25 });
      t += 0.3;
    }
    t += 0.5;
  }
  return words;
}
const setup = (n = 150, per = 12, extra = {}) => {
  const words = makeWords(n, per);
  return { words, segments: buildSegments(words), ...extra };
};

// Fake llm: answers is a list of values (object -> JSON string, string -> as is, Error -> throw)
function fake(answers) {
  const calls = [];
  let reset = 0;
  return {
    calls,
    get resets() { return reset; },
    resetChat() { reset++; },
    async chat(msg) {
      calls.push(msg);
      const a = answers[calls.length - 1];
      if (a instanceof Error) throw a;
      return typeof a === "string" ? a : JSON.stringify(a);
    }
  };
}
const run = (env, llm, cfg = CFG) => reviewWithClaude({ words: env.words, segments: env.segments, llm, cfg });
const ans = (ids = [], partials = [], analysis = []) => ({ analysis, remove_segment_ids: ids, partial_removals: partials });

test("1. normal answer: 1 call, Groq shape, model label", async () => {
  const env = setup();
  const llm = fake([ans([3], [{ segment_id: 5, remove_text: "w5x0," }], ["3: x"])]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.resets, 1);
  assert.deepEqual(Object.keys(r).sort(), ["analysis", "model", "partials", "removeIds"]);
  assert.deepEqual(r.removeIds, [3]);
  assert.deepEqual(r.partials, [{ segment_id: 5, remove_text: "w5x0," }]);
  assert.deepEqual(r.analysis, ["3: x"]);
  assert.equal(r.model, "claude.ai chat");
  assert.equal(llm.calls[0].system, CLAUDE_RETAKE_PROMPT);
});

test("empty transcript sends nothing", async () => {
  const llm = fake([]);
  const r = await reviewWithClaude({ words: [], segments: [], llm, cfg: CFG });
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(r, { removeIds: [], partials: [], analysis: [], model: "claude.ai chat" });
});

test("2. wrong remove_text: repair call, corrected used; still wrong is dropped", async () => {
  const env = setup();
  const llm = fake([
    ans([], [{ segment_id: 5, remove_text: "w5x0 wrong" }, { segment_id: 6, remove_text: "nope nope" }]),
    { partial_removals: [{ segment_id: 5, remove_text: "w5x0," }, { segment_id: 6, remove_text: "still bad" }] }
  ]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /<not_found>[\s\S]*\[segment 5\] you wrote: "w5x0 wrong"/);
  assert.match(llm.calls[1].user, new RegExp(`the line is: ${JSON.stringify(segmentText(env.words, env.segments[4])).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(r.partials, [{ segment_id: 5, remove_text: "w5x0," }]);
  const { mask } = applyDecisions(env.words, env.segments, r);
  assert.equal(mask.reduce((a, b) => a + b, 0), 1);
});

test("2b. repair call that fails drops the partials, no throw", async () => {
  const env = setup();
  const llm = fake([ans([], [{ segment_id: 5, remove_text: "zzz" }]), new Error("boom")]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(r.partials, []);
});

test("3. over 25 percent: verify call, undo_ids and undo_partials applied", async () => {
  const env = setup(150, 12);
  const ids = Array.from({ length: 60 }, (_, i) => i + 1); // 40 % of segments
  const llm = fake([
    ans(ids, [{ segment_id: 100, remove_text: "w100x0," }]),
    { undo_ids: [1, 2], undo_partials: [{ segment_id: 100, remove_text: "w100x0," }], notes: ["kept the only version"] }
  ]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /Cuts are currently 40 percent of all words \(limit 25\)\. Be strict\./);
  assert.ok(!r.removeIds.includes(1) && !r.removeIds.includes(2) && r.removeIds.length === 58);
  assert.deepEqual(r.partials, []);
  assert.ok(r.analysis.includes("kept the only version"));
});

test("4. one long whole-line cut, small ratio: verify with only that line", async () => {
  // segment 7 has 14 words, the others 10
  const w = []; let t = 0;
  for (let s = 1; s <= 60; s++) {
    const n = s === 7 ? 14 : 10;
    for (let k = 0; k < n; k++) { w.push({ t: `a${s}x${k}${k === n - 1 ? "." : ""}`, s: t, e: t + 0.2 }); t += 0.3; }
    t += 0.4;
  }
  const e2 = { words: w, segments: buildSegments(w) };
  const llm = fake([ans([7]), { undo_ids: [], undo_partials: [], notes: [] }]);
  const r = await run(e2, llm);
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /\[7\] CUT WHOLE LINE \(14 words\)/);
  assert.equal((llm.calls[1].user.match(/CUT /g) || []).length, 1);
  assert.doesNotMatch(llm.calls[1].user, /percent of all words/);
  assert.deepEqual(r.removeIds, [7]);
});

test("5. unmatched AND over budget: 3 calls", async () => {
  const env = setup(150, 12);
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const llm = fake([
    ans(ids, [{ segment_id: 100, remove_text: "bad text" }]),
    { partial_removals: [{ segment_id: 100, remove_text: "w100x0," }] },
    { undo_ids: [5], undo_partials: [], notes: [] }
  ]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 3);
  assert.ok(!r.removeIds.includes(5));
  assert.deepEqual(r.partials, [{ segment_id: 100, remove_text: "w100x0," }]);
});

test("6. invalid JSON then valid: one extra call; invalid twice throws", async () => {
  const env = setup();
  const llm = fake(["I think you should cut 3", ans([3])]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].user, llm.calls[1].user);
  assert.deepEqual(r.removeIds, [3]);
  await assert.rejects(run(env, fake(["nope", "still nope"])));
});

test("6b. errors from the chat (Chrome / sign-in) propagate untouched", async () => {
  const env = setup();
  const err = Object.assign(new Error("Launch Chrome..."), { code: "NETWORK" });
  await assert.rejects(run(env, fake([err])), e => e === err);
});

test("7. verify answer invalid: original decisions kept, note added, no throw", async () => {
  const env = setup(150, 12);
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const llm = fake([ans(ids), "garbage"]);
  const r = await run(env, llm);
  assert.equal(llm.calls.length, 2);
  assert.equal(r.removeIds.length, 60);
  assert.ok(r.analysis.includes("Verification could not be done."));
});

test("8. more than partMaxWords: several parts in order, outside ids ignored", async () => {
  const env = setup(30, 10); // 300 words
  const cfg = { ...CFG, partMaxWords: 100, contextSegments: 2 };
  const llm = fake([ans([2, 25]), ans([15, 3]), ans([22, 9])]);
  const r = await run(env, llm, cfg);
  assert.equal(llm.calls.length, 3);
  assert.match(llm.calls[0].user, /\(Part 1 of 3\.\)/);
  assert.match(llm.calls[1].user, /\(Part 2 of 3\.\)/);
  assert.match(llm.calls[1].user, /You decide cuts only for ids 11-20\./);
  assert.match(llm.calls[1].user, /Earlier parts of this video are above in this chat\./);
  assert.ok(llm.calls[1].user.includes("\n9 | ") && llm.calls[1].user.includes("\n22 | ")); // context lines
  assert.deepEqual(r.removeIds, [2, 15, 22]);
});

test("9. input format", async () => {
  const env = setup(20, 10);
  const llm = fake([ans()]);
  await run(env, llm);
  const lines = llm.calls[0].user.split("\n");
  assert.equal(lines[0], "<transcript>");
  assert.equal(lines[1], "Format: id | start | pause before | text");
  assert.match(lines[2], /^1 \| 0:00\.0 \| - \| /);
  assert.equal(lines[2], `1 | ${fmtStart(env.segments[0].start)} | - | ${segmentText(env.words, env.segments[0])}`);
  assert.match(lines[3], /^2 \| 0:\d\d\.\d \| \+0\.5s \| w2x0, /);
  assert.ok(lines.includes("Lines in this message: 1-20. (Part 1 of 1.)"));
  assert.equal(lines.at(-1), "Reply with only the JSON.");
  assert.equal(fmtStart(83.44), "1:23.4");
  assert.equal(fmtPause(2.1), "+2.1s");
  assert.equal(fmtPause(0), "+0.0s");
  for (const seg of env.segments) assert.ok(llm.calls[0].user.includes(segmentText(env.words, seg)));
});

test("10. prompt content", () => {
  assert.ok(CLAUDE_RETAKE_PROMPT.includes("25 percent"));
  assert.ok(CLAUDE_RETAKE_PROMPT.includes("partial_removals"));
});

test("11. pipeline: cutAi groq without key skips; cutAi claude does not skip and never calls Groq", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cut-"));
  process.env.WORKSPACE_DIR = dir;
  process.env.CLAUDE_CHAT_FILE = path.join(dir, "claude-chat.json");
  process.env.FLOW_CDP_URL = "http://127.0.0.1:1";
  delete process.env.GROQ_API_KEY;
  const realFetch = globalThis.fetch;
  const hits = [];
  globalThis.fetch = (url, ...rest) => { hits.push(String(url)); return String(url).includes("groq") ? Promise.reject(new Error("no")) : realFetch(url, ...rest); };
  try {
    const jobs = await import("../src/server/jobs.js");
    const { STEPS } = await import("../src/server/pipeline.js");
    await jobs.initStore();
    const mk = async cutAi => {
      const job = await jobs.createJob({ name: "t", settings: { cutAi } });
      const words = makeWords(5, 10);
      await jobs.writeJob(job.id, "words.json", { words, duration: 30 });
      return job.id;
    };
    const g = await mk("groq");
    const rg = await STEPS.ai(g, {});
    assert.equal(rg.skipped, true);
    assert.match(rg.message, /GROQ_API_KEY is not set/);

    const c = await mk("claude");
    let outcome;
    try { outcome = await STEPS.ai(c, {}); } catch (e) { outcome = e; }
    assert.ok(!(outcome && outcome.skipped), "claude path must not skip");
    assert.ok(outcome instanceof Error, "Chrome is not running: the error propagates");
    assert.ok(!hits.some(u => u.includes("groq")), "Groq must not be called");

    const old = await jobs.createJob({ name: "old", settings: {} });
    assert.equal(jobs.getJob(old.id).settings.cutAi, "groq");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("12. cleanSettings accepts only groq / claude", () => {
  assert.equal(cleanSettings({ cutAi: "claude" }).cutAi, "claude");
  assert.equal(cleanSettings({ cutAi: "groq" }).cutAi, "groq");
  assert.equal("cutAi" in cleanSettings({ cutAi: "auto" }), false);
  assert.equal("cutAi" in cleanSettings({ cutAi: 5 }), false);
  assert.equal("cutAi" in cleanSettings({}), false);
});
