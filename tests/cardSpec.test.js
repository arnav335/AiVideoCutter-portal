import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Card forms: validation, number grounding, fallback and variety. No LLM involved.
const require = createRequire(import.meta.url);
const spec = require("../src/broll/cardSpec.js");
const { FEW_SHOT } = require("../src/broll/cardAi.js");

const ui = (layout, extra = {}) => ({ id: "b1", mode: "ui", layout, pill: "topic", ...extra });

test("every tested few-shot example is a valid form, unchanged", () => {
  for (const { quote, form } of FEW_SHOT) {
    const r = spec.validateCard(form, quote);
    assert.equal(r.ok, true, `${form.id}: ${r.errors.join("; ")}`);
    assert.equal(r.card.mode, form.mode);
    if (form.pill !== undefined) assert.equal(r.card.pill, form.pill, `${form.id} pill is kept as written`);
    else assert.equal(r.card.pill, undefined, `${form.id} is a full-frame picture: no pill`);
  }
});

test("validateCard rejects an unknown layout or mode and hands back the chips fallback", () => {
  const a = spec.validateCard(ui("pie_chart"), "Some words about pies and cakes.");
  assert.equal(a.ok, false);
  assert.match(a.errors[0], /layout must be one of/);
  assert.equal(a.card.layout, "chips");
  const b = spec.validateCard({ id: "b2", mode: "hologram", pill: "x" }, "Some words here.");
  assert.equal(b.ok, false);
  assert.equal(spec.validateCard(null, "x").ok, false);
});

test("validateCard shortens long text at a word boundary instead of rejecting", () => {
  const r = spec.validateCard({
    id: "b1", mode: "ui", layout: "columns", pill: "one two three four five six seven eight nine ten eleven twelve",
    left: { heading: "a very long heading indeed", text: "one two three four five six seven eight nine ten", role: "secondary" },
    right: { heading: "pro", text: "short", role: "accent" },
    caption: "this caption is far too long for the card and must be cut short at some point"
  }, "spoken words");
  assert.equal(r.ok, true);
  assert.ok(r.card.pill.split(" ").length <= 4 && r.card.pill.length <= 32, r.card.pill);
  assert.equal(r.card.left.heading, "a very long");
  assert.equal(r.card.left.text.split(" ").length, 8);
  assert.equal(r.card.caption.split(" ").length, 8);
});

test("text is cleaned: emojis, quotes and line breaks go; everything is lowercase except value_text and name", () => {
  const r = spec.validateCard(ui("big_number", { value_text: "$5,400", sub: 'In "October" 🚀\nnow' }), "It made $5,400 in October.");
  assert.equal(r.ok, true);
  assert.equal(r.card.value_text, "$5,400");
  assert.equal(r.card.sub, "in october now");
  const s = spec.validateCard({ id: "b", mode: "symbol", pill: "YouTube", icon: "play_button", name: "YouTube" }, "YouTube changed things.");
  assert.equal(s.card.name, "YouTube");
  assert.equal(s.card.pill, "youtube");
});

test("number words and digits both count as grounding", () => {
  assert.deepEqual(spec.numbersIn("three thousand one hundred four"), [3104]);
  assert.deepEqual(spec.numbersIn("eighty percent"), [80]);
  assert.deepEqual(spec.numbersIn("five thousand four hundred"), [5400]);
  assert.ok(spec.numbersIn("two and a half million").includes(2500000));
  assert.ok(spec.numbersIn("$5.4k in october").includes(5400));
  assert.ok(spec.numbersIn("3,104 dollars").includes(3104));
  assert.ok(spec.numbersIn("twenty-one days").includes(21));
  assert.equal(spec.isGrounded(3104, "made three thousand one hundred four dollars"), true);
  assert.equal(spec.isGrounded(3105, "made 3,104 dollars"), false);

  const r = spec.validateCard(ui("big_number", { value_text: "3104" }), "It made three thousand one hundred four dollars.");
  assert.equal(r.ok, true);
  const m = spec.validateCard(ui("milestone", { headline: "almost there", percent: 80, marker_label: "goal" }), "We are eighty percent of the way.");
  assert.equal(m.ok, true);
  assert.equal(m.card.percent, 80);
});

test("an ungrounded number is dropped: big_number, bars and milestone fall back to a chips card", () => {
  const quote = "The channel grew very fast last year.";
  for (const form of [
    ui("big_number", { value_text: "$5,400" }),
    ui("bars", { rows: [{ label: "a", value: 10 }, { label: "b", value: 4 }] }),
    ui("milestone", { headline: "growth", percent: 75, marker_label: "now" })
  ]) {
    const r = spec.validateCard(form, quote);
    assert.equal(r.ok, false, form.layout);
    assert.match(r.errors.join(" "), /not said in the line/);
    assert.equal(r.card.layout, "chips");
    assert.ok(r.card.items.length >= 2 && r.card.items.length <= 3);
    assert.equal(r.card.id, "b1");
  }
});

test("bars: fill percent is computed in code, the largest value is 100", () => {
  const r = spec.validateCard(ui("bars", { unit: "$", rows: [{ label: "skool", value: "3,104", role: "accent" }, { label: "ads", value: 2119, role: "weird" }] }),
    "Skool made 3,104 dollars and ads made 2,119.");
  assert.equal(r.ok, true);
  assert.deepEqual(r.card.rows.map(x => x.fill), [100, 68]);
  assert.equal(r.card.rows[1].role, "accent", "an unknown role becomes accent");
  assert.equal(spec.validateCard(ui("bars", { rows: [{ label: "a", value: -1 }, { label: "b", value: 2 }] }), "minus 1 and 2").ok, false);
});

test("row counts are enforced and unknown fields are dropped", () => {
  assert.equal(spec.validateCard(ui("bars", { rows: [{ label: "a", value: 1 }] }), "1").ok, false);
  assert.equal(spec.validateCard(ui("chips", { items: [{ text: "only one" }] }), "x").ok, false);
  assert.equal(spec.validateCard(ui("toggles", { rows: [{ label: "a", on: true }] }), "x").ok, false);
  const r = spec.validateCard(ui("list", { rows: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }, { text: "five" }], colour: "green", glow: true }), "x");
  assert.equal(r.ok, true);
  assert.equal(r.card.rows.length, 4, "extra rows are cut");
  assert.equal(r.card.colour, undefined);
  assert.equal(r.card.glow, undefined);
});

test("symbol, material and real_image forms", () => {
  assert.equal(spec.validateCard({ id: "b", mode: "symbol", pill: "x", icon: "no_such_icon", name: "n" }, "x").card.icon, "generic");
  assert.equal(spec.validateCard({ id: "b", mode: "symbol", pill: "x" }, "x").ok, false, "needs an icon or line_art");
  assert.equal(spec.validateCard({ id: "b", mode: "material", pill: "x" }, "x").ok, false);
  assert.equal(spec.validateCard({ id: "b", mode: "scene", palette: "pink" }, "x").ok, false, "a scene needs a subject");
  assert.equal(spec.validateCard({ id: "b", mode: "scene", subject: "a person" }, "x").ok, true);
  const real = spec.validateCard({ id: "b", mode: "real_image", pill: "michelangelo", search_hint: "Sistine Chapel ceiling fresco", caption: "ignored" }, "x");
  assert.equal(real.ok, true);
  assert.equal(real.card.search_hint, "Sistine Chapel ceiling fresco");
  assert.equal(real.card.caption, undefined);
});

test("a missing pill is derived from the line", () => {
  const r = spec.validateCard({ id: "b", mode: "symbol", icon: "bell", name: "alerts" }, "The notifications keep distracting you.");
  assert.equal(r.ok, true);
  assert.ok(r.card.pill.length > 0);
});

test("fallbackCard always has 2 to 3 chips and a pill, whatever the line", () => {
  for (const q of ["Motivation is a trap, honestly.", "Um.", "", "And so it goes on and on"]) {
    const c = spec.fallbackCard("b9", q);
    assert.equal(c.layout, "chips");
    assert.ok(c.items.length >= 2 && c.items.length <= 3, q);
    assert.ok(c.pill.length > 0);
    assert.equal(spec.validateCard(c, q).ok, true, "the fallback itself passes validation");
  }
});

const card = (mode, layout) => ({ id: `${mode}-${layout}-${Math.random()}`, mode, layout });
test("varietyCheck flags the same layout twice in a row", () => {
  const v = spec.varietyCheck([card("ui", "bars"), card("ui", "bars"), card("ui", "list")]);
  assert.deepEqual(v.map(x => x.index), [1]);
  assert.deepEqual(v[0].avoid, ["bars"]);
  assert.equal(spec.varietyCheck([card("material"), card("material")]).length, 1, "same material mode twice");
  assert.equal(spec.varietyCheck([card("ui", "bars"), card("material"), card("ui", "bars")]).length, 0);
});

test("varietyCheck flags more than 2 of a layout in 10, and more than 3 of a mode in a row", () => {
  const seq = [card("ui", "bars"), card("symbol"), card("ui", "bars"), card("material"), card("ui", "bars")];
  const v = spec.varietyCheck(seq);
  assert.deepEqual(v.map(x => x.index), [4], "the third bars card inside 10");
  assert.match(v[0].reason, /more than 2 bars/);

  const run = spec.varietyCheck([card("ui", "bars"), card("ui", "list"), card("ui", "chips"), card("ui", "toggles")]);
  assert.deepEqual(run.map(x => x.index), [3]);
  assert.match(run[0].reason, /more than 3 ui cards in a row/);

  // far apart is fine
  const far = [card("ui", "bars")];
  for (let i = 0; i < 9; i++) far.push(card(i % 2 ? "symbol" : "material"));
  far.push(card("ui", "bars"), card("symbol"), card("ui", "bars"));
  assert.equal(spec.varietyCheck(far).filter(x => /more than 2/.test(x.reason)).length, 0);
});

test("real_image cards are ignored by the variety check", () => {
  const v = spec.varietyCheck([card("ui", "bars"), { id: "r", mode: "real_image" }, card("ui", "bars")]);
  assert.deepEqual(v.map(x => x.index), [2], "they have no picture, so the two bars cards are still neighbours");
});
