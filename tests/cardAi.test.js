import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// cardsFor with a mock LLM: retries, missing ids, fallbacks and the variety pass.
const require = createRequire(import.meta.url);
const { cardsFor, cardSystem } = require("../src/broll/cardAi.js");
const { LlmError } = require("../src/broll/llm.js");

const items = n => Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, start: i * 10, quote: `Line number ${i + 1} about something.`, description: `d${i + 1}` }));
const chips = id => ({ id, mode: "ui", layout: "chips", pill: "p", items: [{ text: "a" }, { text: "b" }] });
const list = id => ({ id, mode: "ui", layout: "list", pill: "p", rows: [{ text: "a" }, { text: "b" }] });
const toggles = id => ({ id, mode: "ui", layout: "toggles", pill: "p", rows: [{ label: "a", on: true }, { label: "b", on: false }] });
const rowsOf = user => JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
const mock = handler => { const calls = []; return { calls, chat: async ({ system, user, temperature, reasoning }) => { calls.push({ system, user, temperature, reasoning, rows: rowsOf(user) }); return handler(calls.length, rowsOf(user)); } }; };
const silent = () => {};

test("the system prompt carries the contract, the decision table and all the examples", () => {
  const s = cardSystem();
  for (const must of ["CARD FORM", "decision table", "avoid_layouts", "previous_layouts", "Motivation is a trap.", "real_image", "big_number", "before_after", "SILENT CHECKLIST"]) assert.ok(s.includes(must), must);
  assert.ok(!/#[0-9A-Fa-f]{6}/.test(s), "the AI is never told hex colours");
});

test("the calls ask for a low temperature and low reasoning", async () => {
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => chips(r.id)) }));
  await cardsFor({ llm, items: items(1), log: silent });
  assert.equal(llm.calls[0].temperature, 0.2);
  assert.equal(llm.calls[0].reasoning, "low");
});

test("batches of 8: 20 items make 3 calls and every id gets a valid card", async () => {
  const kinds = [chips, list, toggles];
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map((r, i) => kinds[(i + n) % 3](r.id)) }));
  const got = await cardsFor({ llm, items: items(20), batchSize: 8, log: silent });
  assert.deepEqual(llm.calls.slice(0, 3).map(c => c.rows.length), [8, 8, 4]);
  assert.equal(got.size, 20);
  for (const it of items(20)) assert.ok(got.get(it.id).card.pill);
});

test("the first row of a later batch gets the last 2 layouts of the batch before", async () => {
  const kinds = [chips, list, toggles];
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map((r, i) => kinds[(i + n) % 3](r.id)) }));
  await cardsFor({ llm, items: items(10), batchSize: 8, log: silent });
  const second = llm.calls[1].rows[0];
  assert.equal(second.previous_layouts.length, 2);
  assert.ok(second.previous_layouts.every(l => ["chips", "list", "toggles"].includes(l)));
  assert.equal(llm.calls[0].rows[0].previous_layouts.length, 0);
});

test("invalid JSON triggers exactly one retry", async () => {
  let n = 0;
  const llm = mock((call, rows) => (++n === 1 ? "this is not json" : JSON.stringify({ cards: rows.map((r, i) => (i % 2 ? list : chips)(r.id)) })));
  const got = await cardsFor({ llm, items: items(2), log: silent });
  assert.equal(llm.calls.length, 2);
  assert.equal(got.size, 2);
  assert.ok([...got.values()].every(v => !v.fellBack));
});

test("a thrown BADJSON / TRUNCATED / EMPTY is retried once; other errors are not swallowed", async () => {
  let n = 0;
  const flaky = { calls: 0, chat: async ({ user }) => { flaky.calls++; if (++n === 1) throw new LlmError("cut off", "TRUNCATED"); return JSON.stringify({ cards: rowsOf(user).map(r => chips(r.id)) }); } };
  assert.equal((await cardsFor({ llm: flaky, items: items(1), log: silent })).size, 1);
  assert.equal(flaky.calls, 2);
  const down = { chat: async () => { throw new LlmError("bad key", "AUTH"); } };
  await assert.rejects(cardsFor({ llm: down, items: items(1), log: silent }), /bad key/);
});

test("a missing id is asked for again, for just that id", async () => {
  const llm = mock((n, rows) => (n === 1
    ? JSON.stringify({ cards: [chips("b1"), list("b3")] })              // b2 is missing
    : JSON.stringify({ cards: rows.map(r => toggles(r.id)) })));
  const got = await cardsFor({ llm, items: items(3), log: silent });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[1].rows.map(r => r.id), ["b2"]);
  assert.match(llm.calls[1].rows[0].fix, /no card was returned/);
  assert.equal(got.get("b2").fellBack, false);
  assert.equal(got.get("b2").card.layout, "toggles");
});

test("an invalid form is re-asked once with the error text, then falls back", async () => {
  const bad = id => ({ id, mode: "ui", layout: "bars", pill: "p", rows: [{ label: "a", value: 99 }, { label: "b", value: 5 }] });   // 99 and 5 are not in the line
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => bad(r.id)) }));
  const got = await cardsFor({ llm, items: items(2), log: silent });
  assert.equal(llm.calls.length, 2, "one batch call and one fix call");
  assert.match(llm.calls[1].rows[0].fix, /not said in the line/);
  assert.ok([...got.values()].every(v => v.fellBack && v.card.layout === "chips"));
});

test("whatever the AI does, every id ends with a usable card", async () => {
  for (const handler of [() => "garbage", () => "{}", () => JSON.stringify({ cards: [] }), () => JSON.stringify({ cards: [null, 5, "x", { id: "zzz" }] })]) {
    const llm = mock(handler);
    const got = await cardsFor({ llm, items: items(3), log: silent });
    assert.equal(got.size, 3);
    for (const v of got.values()) { assert.equal(v.fellBack, true); assert.ok(v.card.items.length >= 2); }
    assert.ok(llm.calls.length <= 6, "bounded number of calls");
  }
});

test("grounding uses the description when a B-roll has no spoken line", async () => {
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => ({ id: r.id, mode: "ui", layout: "big_number", pill: "p", value_text: "$500" })) }));
  const got = await cardsFor({ llm, items: [{ id: "n1", start: 0, quote: "", description: "A stack of 500 dollars" }], log: silent });
  assert.equal(got.get("n1").card.layout, "big_number");
});

test("the variety pass asks once more for repeated layouts, then accepts what it gets", async () => {
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => (n === 1 ? list(r.id) : chips(r.id))) }));
  const got = await cardsFor({ llm, items: items(4), log: silent });
  const variety = llm.calls[1];
  assert.ok(variety.rows.every(r => r.avoid_layouts.includes("list") && /too repetitive/.test(r.fix)));
  assert.deepEqual(variety.rows.map(r => r.id), ["b2", "b3", "b4"].slice(0, variety.rows.length));
  assert.equal(llm.calls.length, 2, "never loops");
  assert.equal(got.get("b1").card.layout, "list");
  assert.equal(got.get("b2").card.layout, "chips");

  // an AI that ignores the request is accepted, not asked again
  const stubborn = mock((n, rows) => JSON.stringify({ cards: rows.map(r => list(r.id)) }));
  const again = await cardsFor({ llm: stubborn, items: items(3), log: silent });
  assert.equal(stubborn.calls.length, 2);
  assert.ok([...again.values()].every(v => v.card.layout === "list"));
});

test("avoid_layouts is passed for a single item (new card idea) and context cards count for variety", async () => {
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => toggles(r.id)) }));
  const context = [{ id: "c1", start: 5, card: { id: "c1", mode: "ui", layout: "chips", pill: "p" } }, { id: "c2", start: 100, card: { id: "c2", mode: "ui", layout: "list", pill: "p" } }];
  const got = await cardsFor({ llm, items: [{ id: "b1", start: 10, quote: "x y z", description: "d" }], context, avoid: { b1: ["bars"] }, batchSize: 1, log: silent });
  assert.deepEqual(llm.calls[0].rows[0].avoid_layouts, ["bars"]);
  assert.deepEqual(llm.calls[0].rows[0].previous_layouts, ["chips"], "only the card before it in time");
  assert.equal(got.get("b1").card.layout, "toggles");
});

test("a real_image answer is kept as a real_image card", async () => {
  const llm = mock((n, rows) => JSON.stringify({ cards: rows.map(r => ({ id: r.id, mode: "real_image", pill: "michelangelo", search_hint: "Sistine Chapel ceiling" })) }));
  const got = await cardsFor({ llm, items: items(1), log: silent });
  assert.equal(got.get("b1").card.mode, "real_image");
});
