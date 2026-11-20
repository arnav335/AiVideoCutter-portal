import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Block H "Viewer psychology" (PSYCHOLOGY_BLOCK_SPEC.md): prompt assembly, the optional "psych" key and the optional "hero_icon".
const require = createRequire(import.meta.url);
const spec = require("../src/broll/cardSpec.js");
const P = require("../src/broll/cardPrompt.js");
const rich = require("../src/broll/rich.js");
const { cardSystem } = require("../src/broll/cardAi.js");

const bigNumber = (o = {}) => ({ id: "b030", mode: "ui", layout: "big_number", pill: "one month", value_text: "$5,400", ...o });
const QUOTE = "I made five thousand four hundred dollars in one month.";
const at = (text, needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `${needle} is missing`); return i; };

/* ------------------------------------------------------------ prompt assembly */
test("T3, T4 and T6 carry Block H after the palettes and before the examples; the order is A B C D E H F G", () => {
  for (const [name, sys] of [["T3", rich.cardSystemRich()], ["T4", rich.ideaSystemRich()], ["T6", rich.pickDesignSystemRich()]]) {
    assert.ok(sys.includes("<viewer_psychology>") && sys.includes("</viewer_psychology>"), `${name} has Block H`);
    const order = ["<role>", "<modes>", "<forms>", "<rules>", "<palettes>", "<viewer_psychology>", "<examples>", "<output_rules>"].map(t => at(sys, t));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${name} block order`);
  }
});

test("T1, T5 and T7 do not get Block H; T2 and T6 get the viewer_attention snippet", () => {
  for (const sys of [rich.planSystemRich(), rich.regenSystemRich(), rich.promptSystemRich()]) assert.ok(!sys.includes("<viewer_psychology>") && !sys.includes("<viewer_attention>"));
  const t2 = rich.selectSystemRich();
  assert.ok(t2.includes("<viewer_attention>") && at(t2, "</what_earns_a_picture>") < at(t2, "<viewer_attention>") && at(t2, "</viewer_attention>") < at(t2, "<grouping>"));
  assert.ok(!t2.includes("<viewer_psychology>"));
  assert.ok(rich.pickDesignSystemRich().includes("<viewer_attention>"));
});

test("Block H keeps the rules of the spec: no hex values, no emoji characters, the five questions and the honesty clause", () => {
  const h = rich.read("H");
  assert.ok(!/#[0-9A-Fa-f]{6}/.test(h) && !/\p{Extended_Pictographic}/u.test(h));
  for (const must of ["FEELING.", "FOCAL POINT.", "NO-WORDS TEST.", "EYE PATH.", "ONE EMPHASIS.", "SYMBOL BEFORE TEXT", "EVERYTHING MUST STAY HONEST", "DECISION SHORTCUT"]) assert.ok(h.includes(must), must);
  assert.ok(h.split(/\s+/).length > 900, "the block is complete");
});

test("Block F2 examples, rule 10 and the psych key are in the blocks", () => {
  const sys = rich.cardSystemRich();
  for (const id of ["b030", "b031", "b032", "b033", "b034", "b035", "b036"]) assert.ok(sys.includes(`"id":"${id}"`), id);
  assert.ok(at(sys, '"id":"b036"') < at(sys, "</examples>"));
  assert.ok(sys.includes("one clear feeling, one focal point and one emphasis") && sys.includes('"psych" (max 12 words'));
  assert.ok(rich.cardSystemRich().includes("No emojis"), "rule 2 is unchanged");
  assert.ok(rich.read("t3-task").includes("opening hook and in the closing lesson"));
});

test("every F2 example is a valid form for its own line (and keeps its psych)", () => {
  const f = rich.read("F");
  const lines = f.split("\n");
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\{"id":"b03\d"/.test(lines[i])) continue;
    const form = JSON.parse(lines[i]);
    const quote = lines[i - 1].replace(/^"|"( \(.*\))?$/g, "").replace(/"$/, "");
    const v = spec.validateCard(form, quote, { profile: "rich" });
    assert.ok(v.ok, `${form.id}: ${v.errors.join("; ")}`);
    assert.ok(v.card.psych, `${form.id} keeps psych`);
    checked++;
  }
  assert.ok(checked >= 8, `checked ${checked} examples`);
});

test("Groq / Gemini prompts do not change: no Block H, no psych, no hero_icon, the old icon list", () => {
  const groq = cardSystem();
  assert.ok(!/viewer_psychology|psych\b|hero_icon|arrow_up|arrow_down|\bshield\b/.test(groq));
  assert.ok(groq.includes(spec.ICONS.join(", ")) && spec.ICONS.length === 12);
});

/* ------------------------------------------------------------ psych */
test("psych: kept and trimmed to 12 words for Claude, stored on the card, never used in the image prompt", () => {
  const psych = "fear of missing out: closing door, one figure left behind, and then some extra words here";
  const v = spec.validateCard(bigNumber({ psych }), QUOTE, { profile: "rich" });
  assert.ok(v.ok);
  assert.equal(v.card.psych.split(" ").length, 12);
  assert.ok(psych.startsWith(v.card.psych));
  const prompt = P.buildPrompt(v.card).prompt;
  assert.ok(!prompt.includes("fear of missing") && !prompt.includes(v.card.psych));
  const sc = spec.validateCard({ id: "s", mode: "scene", subject: "a door", palette: "pink", psych: "curiosity gap: closed door" }, "x", { profile: "rich" });
  assert.equal(sc.card.psych, "curiosity gap: closed door");
  assert.ok(!P.buildPrompt(sc.card).prompt.includes("curiosity gap"));
});

test("psych is Claude only: the compact profile ignores it, a missing psych adds no key", () => {
  assert.equal(spec.validateCard(bigNumber({ psych: "wants proof" }), QUOTE).card.psych, undefined);
  assert.equal(spec.validateCard(bigNumber(), QUOTE, { profile: "rich" }).card.psych, undefined);
  assert.equal(spec.validateCard(bigNumber({ psych: "  " }), QUOTE, { profile: "rich" }).card.psych, undefined);
});

/* ------------------------------------------------------------ hero_icon */
test("hero_icon: a valid icon is kept on a ui card and adds one sentence to the image prompt; an unknown icon is dropped", () => {
  const ok = spec.validateCard(bigNumber({ hero_icon: "coin" }), QUOTE, { profile: "rich" });
  assert.ok(ok.ok && ok.card.hero_icon === "coin");
  const prompt = P.buildPrompt(ok.card).prompt;
  assert.ok(prompt.includes("A single bold flat") && prompt.includes("coin icon") && prompt.includes("sits above the main element"));
  assert.ok(prompt.includes("$5,400"), "the number stays the hero");

  const bad = spec.validateCard(bigNumber({ hero_icon: "dragon" }), QUOTE, { profile: "rich" });
  assert.ok(bad.ok && bad.card.hero_icon === undefined, "the card still works");
  assert.ok(!P.buildPrompt(bad.card).prompt.includes("icon (a generic shape"));
  assert.equal(spec.validateCard(bigNumber({ hero_icon: "Arrow-Up" }), QUOTE, { profile: "rich" }).card.hero_icon, "arrow_up");
  assert.equal(spec.validateCard(bigNumber({ hero_icon: "generic" }), QUOTE, { profile: "rich" }).card.hero_icon, undefined);
});

test("hero_icon is refused on chips, toggles and columns, and for the compact profile", () => {
  const chips = spec.validateCard({ id: "c", mode: "ui", layout: "chips", pill: "p", items: [{ text: "a" }, { text: "b" }], hero_icon: "coin" }, "", { profile: "rich" });
  const toggles = spec.validateCard({ id: "t", mode: "ui", layout: "toggles", pill: "p", rows: [{ label: "a", on: true }, { label: "b", on: false }], hero_icon: "coin" }, "", { profile: "rich" });
  const columns = spec.validateCard({ id: "k", mode: "ui", layout: "columns", pill: "p", left: { heading: "a", text: "b" }, right: { heading: "c", text: "d" }, hero_icon: "coin" }, "", { profile: "rich" });
  for (const r of [chips, toggles, columns]) assert.ok(r.ok && r.card.hero_icon === undefined, r.card.layout);
  assert.equal(spec.validateCard(bigNumber({ hero_icon: "coin" }), QUOTE).card.hero_icon, undefined);
  const list = spec.validateCard({ id: "l", mode: "ui", layout: "list", pill: "p", rows: [{ text: "a" }, { text: "b" }], hero_icon: "trophy" }, "", { profile: "rich" });
  assert.equal(list.card.hero_icon, "trophy");
});

test("symbol mode: Claude can use the new icons (warning, clock...), the compact profile falls back to generic", () => {
  const f = { id: "y", mode: "symbol", pill: "p", icon: "warning", name: "careful" };
  assert.equal(spec.validateCard(f, "", { profile: "rich" }).card.icon, "warning");
  assert.equal(spec.validateCard(f, "").card.icon, "generic");
  assert.equal(spec.validateCard({ ...f, icon: "coin" }, "").card.icon, "coin");
  for (const icon of spec.RICH_ICONS) assert.ok(P.ICON_TEXT[icon], `${icon} has a prompt description`);
});
