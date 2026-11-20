import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The card theme inside a B-roll project: defaults, legacy projects, theme switching, the prompts step, "new card idea",
// grouping and saving. A fake OpenAI-style server stands in for Groq; no Chrome, no ffmpeg.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-cards-"));
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.GROQ_API_KEY = "test-key";
delete process.env.GEMINI_API_KEY;

const require = createRequire(import.meta.url);
const requests = [];
let answer = rows => rows.map(r => ({ id: r.id, mode: "ui", layout: "chips", pill: "p", items: [{ text: "a" }, { text: "b" }] }));
const fakeAi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    const system = body.messages[0].content, user = body.messages[1].content;
    const rows = /CARD FORM/.test(system) ? JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1)) : [];
    requests.push({ system, user, rows, body });
    const content = JSON.stringify({ cards: answer(rows) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  });
});
await new Promise(r => fakeAi.listen(0, "127.0.0.1", r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}/openai/v1`;
test.after(() => fakeAi.close());

const { default: projects } = await import("../src/broll/projects.js");
const planner = require("../src/broll/planner.js");
const { FRAME, LOOK, DEFAULT_SUFFIX } = require("../src/broll/cardPrompt.js");

const root = path.join(tmp, "projects");
const dirOf = id => path.join(root, id, "broll");
projects.configure({
  dir: dirOf,
  exists: id => /^p\d+$/.test(id),
  defaultProvider: () => "groq",
  readCues: async () => ({ cues: [], duration: 200 }),
  timeline: async () => ({ intervals: [{ start: 0, end: 200 }], duration: 200 }),
  touch: () => {}
});

const waitDone = async (p, step) => {
  for (let i = 0; i < 200 && p.steps[step].status === "running"; i++) await new Promise(r => setTimeout(r, 25));
  assert.notEqual(p.steps[step].status, "running", "timed out");
  assert.equal(p.steps[step].status, "done", p.steps[step].error);
};
const seed = (id, brolls) => { const p = projects.ensure(id); p.brolls = brolls; return p; };
const item = (id, start, quote, extra = {}) => ({ id, start, end: start + 8, quote, anchor: "", description: `about ${quote}`, prompt: "", enabled: true, ...extra });
const saveProjectJson = async (id, project) => { await fs.mkdir(dirOf(id), { recursive: true }); await fs.writeFile(path.join(dirOf(id), "project.json"), JSON.stringify(project)); };

test("a new project defaults to the card theme (with the default suffix); a saved one without a theme loads as free", async () => {
  const fresh = projects.ensure("p1");
  assert.equal(fresh.options.theme, "card");
  assert.equal(fresh.options.prompts.suffix, DEFAULT_SUFFIX);
  assert.deepEqual(projects.view(fresh).themes.map(t => t.id), ["card", "free"]);

  await saveProjectJson("p2", { id: "p2", options: { provider: "groq", prompts: { common: "flat", suffix: "" }, render: { outputDir: "" } }, steps: {}, brolls: [], log: [] });
  const legacy = projects.ensure("p2");
  assert.equal(legacy.options.theme, "free");
  assert.equal(legacy.options.prompts.suffix, "", "the old suffix is untouched");
  assert.equal(legacy.options.prompts.common, "flat");

  await saveProjectJson("p3", { id: "p3", options: { theme: "nonsense", prompts: {} }, steps: {}, brolls: [], log: [] });
  assert.equal(projects.ensure("p3").options.theme, "free", "an unknown stored theme becomes free");
});

test("saveOptions validates the theme; changing it clears prompts and cards but keeps the plan", async () => {
  const p = seed("p4", [item("b001", 0, "Motivation is a trap.", { prompt: "old prompt", card: { mode: "ui" }, mode: "ui" }), item("b002", 10, "Second line.")]);
  p.flowJobId = "job1";
  assert.throws(() => projects.saveOptions("p4", { theme: "neon" }), /Unknown theme/);
  projects.saveOptions("p4", { theme: "free" });
  assert.equal(p.options.theme, "free");
  assert.equal(p.options.prompts.suffix, "", "the card default suffix is removed when leaving the theme");
  assert.deepEqual(p.brolls.map(b => [b.id, b.prompt, b.card, b.mode]), [["b001", "", undefined, undefined], ["b002", "", undefined, undefined]]);
  assert.equal(p.brolls[0].description, "about Motivation is a trap.", "the plan is kept");
  assert.equal(p.flowJobId, null);
  assert.equal(p.steps.prompts.status, "idle");

  projects.saveOptions("p4", { theme: "card" });
  assert.equal(p.options.prompts.suffix, DEFAULT_SUFFIX);
  projects.saveOptions("p4", { theme: "card", prompts: { common: "x", suffix: "mine" } });
  assert.equal(p.options.prompts.suffix, "mine");
  projects.saveOptions("p4", { theme: "free" });
  assert.equal(p.options.prompts.suffix, "mine", "an edited suffix is never touched");
});

test("theme free writes prompts exactly as before (no card call)", async () => {
  const p = seed("p5", [item("b001", 0, "Hello there.")]);
  projects.saveOptions("p5", { theme: "free" });
  const before = requests.length;
  projects.startPrompts("p5", { common: "flat vector", suffix: "no text" });
  await waitDone(p, "prompts");
  const sent = requests.slice(before);
  assert.ok(sent.length >= 1);
  assert.match(sent[0].system, /You write prompts for an AI image generation model/);
  assert.ok(sent.every(r => !/CARD FORM/.test(r.system)));
  assert.equal(p.brolls[0].card, undefined);
});

test("theme card: the AI fills forms, code writes the prompts; real_image items get no prompt", async () => {
  const p = seed("p6", [
    item("b001", 0, "Motivation is a trap."),
    item("b002", 10, "In its first month, skool made 3,104 dollars and ads made 2,119."),
    item("b003", 20, "Look at how he painted every figure."),
    item("b004", 30, "Off line.", { enabled: false })
  ]);
  answer = rows => rows.map(r => ({
    b001: { id: "b001", mode: "material", pill: "warning", pill_dot: "secondary", object: "a metal mousetrap with a trophy as bait", caption: "motivation is a trap" },
    b002: { id: "b002", mode: "ui", layout: "bars", pill: "skool", unit: "$", rows: [{ label: "skool", value: 3104, role: "accent" }, { label: "ads", value: 2119, role: "secondary" }] },
    b003: { id: "b003", mode: "real_image", pill: "michelangelo", search_hint: "Sistine Chapel ceiling fresco" }
  })[r.id]);
  projects.startPrompts("p6", { common: "Keep it minimal.", suffix: DEFAULT_SUFFIX });
  await waitDone(p, "prompts");

  const [a, b, c, d] = p.brolls;
  assert.ok(a.prompt.startsWith(`${LOOK.material} ${FRAME}`));
  assert.ok(a.prompt.includes("Keep it minimal.") && a.prompt.endsWith(DEFAULT_SUFFIX));
  assert.equal(a.mode, "material");
  assert.equal(b.card.layout, "bars");
  assert.ok(b.prompt.includes('the text "$3,104"') && b.prompt.includes("68%"));
  assert.equal(c.needsRealImage, true);
  assert.equal(c.searchHint, "Sistine Chapel ceiling fresco");
  assert.equal(c.prompt, "");
  assert.equal(d.prompt, "", "an unticked line gets nothing");
  assert.deepEqual(projects.imageItems(p).map(x => x.id), ["b001", "b002"], "the images step skips the real_image item");
  assert.equal(p.flowJobId, null);
});

test("\"Only the empty ones\" keeps edited prompts and skips needs-your-own-image items; \"all\" rewrites everything", async () => {
  const p = seed("p7", [
    item("b001", 0, "Motivation is a trap.", { prompt: "my own hand-written prompt", card: { id: "b001", mode: "symbol", pill: "x", icon: "bell", icon_role: "accent", name: "n" }, mode: "symbol" }),
    item("b002", 10, "Look at the painting.", { needsRealImage: true, searchHint: "Mona Lisa", card: { id: "b002", mode: "real_image", pill: "x", search_hint: "Mona Lisa" }, mode: "real_image" }),
    item("b003", 20, "Brand new line about steel.")
  ]);
  answer = rows => rows.map(r => ({ id: r.id, mode: "symbol", pill: "steel", icon: "lock", icon_role: "text", name: "steel" }));
  const before = requests.length;
  projects.startPrompts("p7", { onlyMissing: true });
  await waitDone(p, "prompts");
  const asked = requests.slice(before).flatMap(r => r.rows.map(x => x.id));
  assert.deepEqual([...new Set(asked)], ["b003"], "only the empty one was asked for");
  assert.equal(p.brolls[0].prompt, "my own hand-written prompt");
  assert.equal(p.brolls[1].prompt, "");
  assert.equal(p.brolls[1].needsRealImage, true);
  assert.ok(p.brolls[2].prompt.startsWith(LOOK.symbol));

  // the existing cards around it count as context for variety (b001 is a symbol card)
  assert.deepEqual(requests.slice(before)[0].rows[0].previous_layouts, ["symbol"]);

  projects.startPrompts("p7", {});
  await waitDone(p, "prompts");
  assert.ok(p.brolls[0].prompt.startsWith(LOOK.symbol), "\"write for all\" replaces the edit");
  assert.equal(p.brolls[1].needsRealImage, undefined, "and the real_image item was asked again");
});

test("a B-roll added by hand (description only) gets a card too", async () => {
  const p = seed("p8", [item("n1", 0, "", { description: "A stack of 500 dollars" })]);
  answer = rows => rows.map(r => ({ id: r.id, mode: "ui", layout: "big_number", pill: "cash", value_text: "$500" }));
  projects.startPrompts("p8", { suffix: "" });
  await waitDone(p, "prompts");
  assert.equal(p.brolls[0].card.layout, "big_number");
  assert.ok(p.brolls[0].prompt.includes('"$500"'));
});

test("New card idea asks again for one item and avoids its current layout", async () => {
  const p = seed("p9", [
    item("b001", 0, "It feels like progress."),
    item("b002", 10, "Amateur versus professional.", { card: { id: "b002", mode: "ui", layout: "columns", pill: "x", left: { heading: "a", text: "b", role: "secondary" }, right: { heading: "c", text: "d", role: "accent" } }, mode: "ui", prompt: "old" })
  ]);
  p.flowJobId = "job-x";
  answer = rows => rows.map(r => ({ id: r.id, mode: "ui", layout: "toggles", pill: "mindset", rows: [{ label: "amateur", on: true }, { label: "pro", on: false }] }));
  const before = requests.length;
  await projects.newCardIdea("p9", "b002");
  const sent = requests.slice(before);
  assert.deepEqual(sent[0].rows.map(r => r.id), ["b002"]);
  assert.deepEqual(sent[0].rows[0].avoid_layouts, ["columns"]);
  assert.equal(p.brolls[1].card.layout, "toggles");
  assert.ok(p.brolls[1].prompt.startsWith(LOOK.ui) && p.brolls[1].prompt !== "old");
  assert.equal(p.flowJobId, null);
  await assert.rejects(projects.newCardIdea("p9", "nope"), /not found/);
  projects.saveOptions("p9", { theme: "free" });
  await assert.rejects(projects.newCardIdea("p9", "b002"), /only exist in the UI Card theme/);
});

test("grouping clears the card, mode and prompt of the merged item; ungrouping gives parts without cards", async () => {
  const card = { id: "x", mode: "symbol", pill: "x", icon: "bell", icon_role: "accent", name: "n" };
  const p = seed("p10", [
    item("b001", 0, "First.", { prompt: "P1", card, mode: "symbol" }),
    item("b002", 8, "Second.", { prompt: "P2", card, mode: "symbol", needsRealImage: false })
  ]);
  await projects.groupBrolls("p10", ["b001", "b002"]);
  const g = p.brolls[0];
  assert.equal(g.lines.length, 2);
  assert.deepEqual([g.prompt, g.card, g.mode, g.needsRealImage, g.searchHint], ["", undefined, undefined, undefined, undefined]);
  projects.ungroupBroll("p10", g.id);
  assert.ok(p.brolls.every(b => b.prompt === "" && b.card === undefined && b.mode === undefined));

  // the planner function itself
  const m = planner.mergeGroup([item("a", 0, "A.", { card, mode: "symbol", prompt: "p" }), item("b", 8, "B.")], { description: "new" });
  assert.equal(m.card, undefined); assert.equal(m.prompt, "");
  // theme free: a group that keeps the primary's description keeps its prompt (unchanged behaviour)
  const keep = planner.mergeGroup([item("a", 0, "A.", { prompt: "p" }), item("b", 8, "B.")]);
  assert.equal(keep.prompt, "p");
});

test("saving the list from the editor keeps each item's card, mode and real-image flag", async () => {
  const card = { id: "b001", mode: "real_image", pill: "x", search_hint: "Mona Lisa" };
  const p = seed("p11", [item("b001", 0, "Look.", { card, mode: "real_image", needsRealImage: true, searchHint: "Mona Lisa" }), item("b002", 10, "Two.", { card: { ...card, id: "b002" }, mode: "real_image", needsRealImage: true, searchHint: "Mona Lisa" })]);
  const fromEditor = p.brolls.map(({ card: _c, mode: _m, needsRealImage: _n, searchHint: _s, ...rest }) => rest);   // the editor never sends these back
  fromEditor[1].prompt = "I typed my own prompt";
  await projects.saveBrolls("p11", fromEditor);
  assert.equal(p.brolls[0].needsRealImage, true);
  assert.equal(p.brolls[0].card.search_hint, "Mona Lisa");
  assert.equal(p.brolls[0].mode, "real_image");
  assert.equal(p.brolls[1].needsRealImage, undefined, "typing a prompt means the item has its own picture prompt now");
  assert.equal(p.brolls[1].prompt, "I typed my own prompt");
});

test("the plan step gets the card rules only in the card theme; free is byte-for-byte the old text", () => {
  assert.equal(planner.planSystem("free"), planner.planSystem());
  assert.equal(planner.selectSystem("free"), planner.selectSystem());
  assert.match(planner.planSystem("card"), /KEEP every number, name, date and comparison/);
  assert.match(planner.selectSystem("card"), /REPEATED TAKES/);
  assert.match(planner.selectSystem("card"), /8 to 12 seconds/);
  assert.match(planner.selectSystem("card"), /25 seconds/);
  assert.doesNotMatch(planner.planSystem("free"), /KEEP every number/);
  assert.doesNotMatch(planner.selectSystem("free"), /CARD THEME/);
});

