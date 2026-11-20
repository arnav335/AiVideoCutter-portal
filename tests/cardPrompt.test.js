import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The prompt builder: fixed templates, palette only, no ratio, no LLM.
const require = createRequire(import.meta.url);
const spec = require("../src/broll/cardSpec.js");
const P = require("../src/broll/cardPrompt.js");
const { FEW_SHOT } = require("../src/broll/cardAi.js");

const build = (card, o) => P.buildPrompt(card, o).prompt;
const CARD_MODES = ["ui", "material", "symbol"];
const PALETTE = Object.values(P.COLORS).map(h => h.toUpperCase());

// A form for every layout and mode (the few-shot ones plus the layouts they do not cover).
const EXTRA = [
  { quote: "It made $5,400 in October.", form: { id: "x1", mode: "ui", layout: "big_number", pill: "october", value_text: "$5,400", sub: "in one month", caption: "real money" } },
  { quote: "We are eighty percent of the way there.", form: { id: "x2", mode: "ui", layout: "milestone", pill: "the goal", headline: "80% there", percent: 80, marker_label: "today" } },
  { quote: "First write it, then film it, then post it.", form: { id: "x3", mode: "ui", layout: "list", pill: "the steps", rows: [{ text: "write it" }, { text: "film it", role: "secondary" }, { text: "post it" }] } },
  { quote: "Scale times human value times perception.", form: { id: "x4", mode: "ui", layout: "formula", pill: "the equation", parts: ["scale", "human value", "perception"], op: "x" } },
  { quote: "A steel beam.", form: { id: "x5", mode: "material", pill: "steel", object: "a brushed steel beam", texture_notes: "brushed steel" } },
  { quote: "Trophy.", form: { id: "x6", mode: "symbol", pill: "win", icon: "trophy", icon_role: "accent", name: "the prize" } },
  { quote: "YouTube changed how we learn.", form: { id: "x7", mode: "symbol", pill: "youtube", icon: "play_button", icon_role: "secondary", name: "youtube" } },
  { quote: "A wooden bow.", form: { id: "x8", mode: "material", pill: "cannae · 216 bc", object: "a large wooden longbow bent in a deep curve with the string pulled far back and one yellow arrow aimed right", texture_notes: "realistic wood grain", caption: "pull back to strike harder" } },
  { quote: "MrBeast has millions of views.", form: { id: "x9", mode: "person", name: "MrBeast", render: "animated", action: "standing calmly", setting: "a bright studio", composition: "medium", palette: "blue_grey" } },
  { quote: "Steve Jobs loved what he did.", form: { id: "x10", mode: "person", name: "Steve Jobs", render: "real", action: "sitting calmly, facing the camera", setting: "a plain bright studio", composition: "close_up" } }
];
const ALL = [...FEW_SHOT, ...EXTRA].map(e => ({ ...e, card: spec.validateCard(e.form, e.quote).card }));

test("the layouts and modes covered by the samples are every layout and mode", () => {
  const seen = new Set(ALL.flatMap(e => [e.card.layout, e.card.mode]));
  for (const l of Object.keys(spec.LAYOUTS)) assert.ok(seen.has(l), `layout ${l}`);
  for (const m of spec.MODES) assert.ok(seen.has(m), `mode ${m}`);
});

test("every prompt starts with its LOOK, contains FRAME, the pill and the caption exactly", () => {
  for (const { card } of ALL) {
    const prompt = build(card);
    if (card.mode === "real_image") { assert.equal(prompt, ""); continue; }
    if (!CARD_MODES.includes(card.mode)) { assert.ok(!prompt.includes(P.FRAME), `${card.id} is full frame: no FRAME`); continue; }
    assert.ok(prompt.startsWith(P.LOOK[card.mode] + " " + P.FRAME), `${card.id} starts with LOOK then FRAME`);
    assert.ok(prompt.includes(`the text "${card.pill}".`), `${card.id} pill`);
    if (card.caption) assert.ok(prompt.includes(`small grey (#8A8A8A) text "${card.caption}".`), `${card.id} caption`);
    else assert.ok(!prompt.includes("small grey (#8A8A8A) text"), `${card.id} has no caption sentence`);
  }
});

test("prompts use only palette colours and never name an aspect ratio", () => {
  for (const { card } of ALL.filter(e => CARD_MODES.includes(e.card.mode))) {
    const prompt = build(card, { common: "", suffix: P.DEFAULT_SUFFIX });
    for (const hex of prompt.match(/#[0-9a-fA-F]{6}\b/g) || []) assert.ok(PALETTE.includes(hex.toUpperCase()), `${card.id}: ${hex} is not in the palette`);
    for (const ratio of ["16:9", "4:3", "1:1", "3:4", "9:16"]) assert.ok(!prompt.includes(ratio), `${card.id} mentions ${ratio}`);
    assert.ok(!/\bgreen\b(?!\s*\()/i.test(prompt.replace(P.FRAME, "")) || /no green/.test(prompt), `${card.id}: nothing inside the card is green`);
  }
});

test("each template says what the spec says", () => {
  const by = id => build(ALL.find(e => e.card.id === id).card);
  assert.match(by("x1"), /Centered, a huge bold yellow \(#FFCE2B\) number "\$5,400" and below it small grey text "in one month"\./);
  assert.match(by("b008"), /Row 1: the label "skool" in white on the left, a rounded horizontal bar in yellow \(#FFCE2B\) whose length is 100% of the full bar width, and the text "\$3,104" on the right\./);
  assert.match(by("b008"), /Row 2: .* whose length is 68% of the full bar width/);
  assert.match(by("x2"), /thin white vertical marker at 80%/);
  assert.match(by("b007"), /Centered white bold text "let it come or not"\. Below it, 2 rounded chips side by side.*yellow \(#FFCE2B\) checkmark icon and the text "comes" in white/);
  assert.match(by("x3"), /3 stacked rows, each with a small yellow \(#FFCE2B\) dot on the left and white bold text: "write it", "film it", "post it"\./);
  assert.match(by("b004"), /Label "doing the work", toggle switched OFF in dark grey\. Label "fantasizing about the result", toggle switched ON in coral red \(#FF5F57\)\./);
  assert.match(by("b005"), /Left column: the heading "amateur" in coral red \(#FF5F57\) and under it in white "daydreams about the reward"\./);
  assert.match(by("x4"), /"scale" x "human value" x "perception", each word inside its own rounded chip/);
  assert.match(by("b006"), /Left: heading "the work" in grey and text "the focus" in white\. Right: heading "success" in yellow/);
  assert.match(by("x8"), /with a realistic wood grain texture, satin finish/);
  assert.match(by("b011"), /split into two equal halves by a thin vertical grey line\. Left half: a white porcelain plate/);
  assert.match(by("x7"), /a large flat coral red \(#FF5F57\) rounded rectangle with a white play triangle \(a generic shape, not a real logo\)\. Below it, white bold text "youtube"\./);
  assert.match(by("b013"), /simple white thick rounded line art of two hands reaching toward each other/);
});

test("common instructions and the suffix go at the end, in that order; the suffix is skipped when empty", () => {
  const card = ALL.find(e => e.card.id === "x7").card;
  const p = build(card, { common: "  Keep it minimal.  ", suffix: P.DEFAULT_SUFFIX });
  assert.ok(p.endsWith(`Keep it minimal. ${P.DEFAULT_SUFFIX}`));
  assert.ok(p.indexOf('white bold text "youtube".') < p.indexOf("Keep it minimal."));
  assert.equal(build(card).endsWith('white bold text "youtube".'), true);
});

test("a real_image card has no prompt", () => {
  assert.equal(build({ id: "r", mode: "real_image", pill: "x", search_hint: "y" }), "");
  assert.equal(build(null), "");
});

test('healRefs re-points stale saved reference paths at the current style folder', () => {
  const { healRefs, STYLE_DIR } = require('../src/broll/cardPrompt');
  const fs = require('fs'), path = require('path');
  const have = fs.readdirSync(STYLE_DIR).find(f => /^tatami-.*\.jpg$/.test(f));
  if (!have) return;
  const out = healRefs([`/some/old/place/${have}`, '/some/old/place/tatami-nope.jpg'], 'pink');
  assert.deepEqual(out, [path.join(STYLE_DIR, have)]);
});
