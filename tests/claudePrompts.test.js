import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Scene / logo / person modes, the reference ring, the logo registry, the rich prompts and the Claude provider.
const require = createRequire(import.meta.url);
const spec = require("../src/broll/cardSpec.js");
const P = require("../src/broll/cardPrompt.js");
const rich = require("../src/broll/rich.js");
const { cardsFor, newIdea, pickAndDesign } = require("../src/broll/cardAi.js");
const { LlmError } = require("../src/broll/llm.js");
const cw = require("../src/broll/claudeWeb.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "silent-"));
const scene = (o = {}) => ({ id: "s", mode: "scene", palette: "sepia", subject: "a tall man", action: "striding forward", setting: "a dim street", composition: "low_angle", ...o });

/* ------------------------------------------------------------ validation */
test("scene: bad palette and composition get defaults, no subject falls back, style words are stripped", () => {
  const ok = spec.validateCard(scene({ palette: "neon", composition: "weird", subject: "a flat anime 3d render of a man in cel style" }), "x");
  assert.equal(ok.ok, true);
  assert.equal(ok.card.palette, "blue_grey");
  assert.equal(ok.card.composition, "medium");
  assert.ok(!/\b(anime|cel|flat|3d|render|style)\b/i.test(ok.card.subject), ok.card.subject);
  const bad = spec.validateCard({ id: "s", mode: "scene", palette: "pink" }, "Motivation is a trap.");
  assert.equal(bad.ok, false);
  assert.equal(bad.card.mode, "ui", "fallback chips card");
  assert.equal(ok.card.pill, undefined, "no pill on a full-frame picture");
});

test("logo: the slug is sanitised and an empty slug falls back", () => {
  assert.equal(spec.validateCard({ id: "l", mode: "logo", brand: "Google Docs", display_name: "Google Docs", kind: "product" }, "x").card.brand, "google-docs");
  assert.equal(spec.validateCard({ id: "l", mode: "logo", brand: "MrBeast!!", kind: "nope" }, "x").card.kind, "company");
  assert.equal(spec.validateCard({ id: "l", mode: "logo", brand: "***" }, "x").ok, false);
});

test("person: render defaults to animated, blocked words are dropped, neutral action as fallback", () => {
  const p = spec.validateCard({ id: "p", mode: "person", name: "MrBeast", render: "???", action: "nude and bloody arrest", setting: "a dead scandal" }, "x").card;
  assert.equal(p.render, "animated");
  assert.equal(p.palette, "blue_grey");
  assert.equal(p.action, "standing and looking toward the camera");
  assert.ok(!p.setting);
  const real = spec.validateCard({ id: "p", mode: "person", name: "Steve Jobs", render: "real", action: "sitting calmly", palette: "pink", look: "round glasses" }, "x").card;
  assert.equal(real.palette, undefined);
  assert.equal(real.look, undefined, "look is only for animated");
});

test("rich limits are accepted, compact limits are still enforced for Groq", () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ text: `item ${i}` }));
  const form = { id: "c", mode: "ui", layout: "chips", pill: "one two three four five", items: rows(8) };
  assert.equal(spec.validateCard(form, "x", { profile: "rich" }).card.items.length, 8);
  assert.equal(spec.validateCard(form, "x").card.items.length, 6);
  assert.equal(spec.validateCard(form, "x", { profile: "rich" }).card.pill, "one two three four five");
  assert.equal(spec.validateCard(form, "x").card.pill, "one two three four");
});

test("the old animated mode is read as a scene", () => {
  assert.equal(spec.validateCard({ id: "a", mode: "animated", subject: "a person", action: "walks" }, "x").card.mode, "scene");
});

/* ------------------------------------------------------------ prompts and references */
test("scene prompt: Tatami style, full frame, no FRAME, no green, no pill; three references in ring order", () => {
  const dir = tmp();
  const { card } = spec.validateCard(scene(), "x");
  const r = P.buildPrompt(card, { styleDir: dir, common: "ignored", suffix: P.DEFAULT_SUFFIX });
  assert.ok(r.prompt.startsWith(P.TATAMI_STYLE));
  assert.ok(r.prompt.includes("no card") && !r.prompt.includes(P.FRAME) && !r.prompt.includes("#00FF00") && !/pill label/.test(r.prompt));
  assert.ok(!r.prompt.includes("ignored") && !r.prompt.includes(P.DEFAULT_SUFFIX), "common and suffix are for cards only");
  assert.deepEqual(r.refs.map(f => path.basename(f)), ["tatami-sepia.jpg", "tatami-pink.jpg", "tatami-green.jpg"]);
  assert.equal(new Set(r.refs).size, 3);
  assert.deepEqual(P.refsFor("pink", tmp()).map(f => path.basename(f)), ["tatami-pink.jpg", "tatami-green.jpg", "tatami-black_yellow.jpg"]);
  assert.deepEqual(P.refsFor("muted_multicolor", tmp()).map(f => path.basename(f)), ["tatami-muted_multicolor.jpg", "tatami-blue_grey.jpg", "tatami-sepia.jpg"]);
  assert.ok(r.prompt.includes("a dominant dark sepia-brown palette"));
});

test("logo prompt has #121212 and no pill; a file in assets/logos is used with no prompt", () => {
  const dir = tmp();
  const { card } = spec.validateCard({ id: "l", mode: "logo", brand: "youtube", display_name: "YouTube", kind: "platform" }, "x");
  const gen = P.buildPrompt(card, { logosDir: dir });
  assert.ok(gen.prompt.includes("#121212") && !/pill/i.test(gen.prompt));
  assert.equal(gen.source, "generated");
  fs.writeFileSync(path.join(dir, "youtube.png"), "x");
  const file = P.buildPrompt(card, { logosDir: dir });
  assert.equal(file.source, "file");
  assert.equal(file.prompt, "");
  assert.equal(file.file, path.join(dir, "youtube.png"));
});

test("person: real is photorealistic without references, animated has the style and three references", () => {
  const real = P.buildPrompt(spec.validateCard({ id: "p", mode: "person", name: "Steve Jobs", render: "real", action: "sitting calmly", composition: "close_up" }, "x").card);
  assert.match(real.prompt, /^Photorealistic natural photograph of Steve Jobs/);
  assert.ok(!real.prompt.includes("Hand-drawn") && real.refs.length === 0);
  const anim = P.buildPrompt(spec.validateCard({ id: "p", mode: "person", name: "Hannibal", render: "animated", palette: "green", look: "a short dark beard" }, "x").card);
  assert.ok(anim.prompt.includes(P.TATAMI_STYLE) && anim.prompt.includes("with a short dark beard"));
  assert.equal(anim.refs.length, 3);
});

/* ------------------------------------------------------------ variety */
test("variety: same scene palette twice and four scenes in a row are flagged; logos and real persons are exempt", () => {
  const sc = (palette, id) => ({ id, mode: "scene", palette });
  const logo = { id: "lg", mode: "logo", brand: "x" };
  const real = { id: "rp", mode: "person", render: "real" };
  assert.deepEqual(spec.varietyCheck([sc("pink", "a"), sc("pink", "b")]).map(v => v.id), ["b"]);
  assert.equal(spec.varietyCheck([sc("pink", "a"), logo, real, sc("sepia", "b")]).length, 0);
  const four = spec.varietyCheck([sc("pink", "a"), sc("sepia", "b"), sc("green", "c"), sc("blue_grey", "d")]);
  assert.deepEqual(four.map(v => v.id), ["d"]);
  assert.match(four[0].reason, /more than 3 scene/);
  const animated = { id: "an", mode: "person", render: "animated", palette: "pink" };
  assert.equal(spec.varietyCheck([sc("pink", "a"), animated]).length, 1, "an animated person counts as a scene");
});

/* ------------------------------------------------------------ rich prompts */
const okLlm = (profile, handler) => { const calls = []; return { profile, calls, chat: async a => { calls.push(a); return handler(a, calls.length); } }; };

test("rich blocks are assembled from the spec text", () => {
  const sys = rich.cardSystemRich();
  for (const must of ["<role>", "<modes>", "<forms>", "<rules>", "<creativity>", "<palettes>", "<examples>", "<output_rules>", "CARDS."]) assert.ok(sys.includes(must), must);
  assert.ok(!/#[0-9A-Fa-f]{6}/.test(sys.replace(/#121212/g, "")), "no hex colours in the prompt");
  assert.ok(rich.planSystemRich().includes("Logo of NAME") && rich.planSystemRich().includes("<how_this_tool_works>") && !rich.planSystemRich().includes("(Block A-short)"));
  assert.ok(rich.selectSystemRich().includes('"notes"') && rich.regenSystemRich().includes("RE-DESCRIBE"));
  assert.ok(rich.ideaSystemRich().includes("NEW IDEA") && rich.pickDesignSystemRich().includes("PICK AND DESIGN") && rich.pickDesignSystemRich().includes("<pacing>"));
  assert.ok(rich.promptSystemRich().includes("Nano Banana"));
});

test("cardsFor: a rich llm gets the rich prompt and the brief; a plain llm keeps the compact prompt", async () => {
  const items = [{ id: "b1", start: 0, end: 5, quote: "Motivation is a trap.", description: "d" }, { id: "b2", start: 6, end: 10, quote: "Then you upload it to YouTube.", description: "d" }];
  const answer = ({ user }) => JSON.stringify({ notes: "ok", cards: [scene({ id: "b1" }), { id: "b2", mode: "logo", brand: "youtube", display_name: "YouTube", kind: "platform" }] });
  const claude = okLlm("rich", answer);
  const got = await cardsFor({ llm: claude, items, duration: 125, log: () => {} });
  assert.ok(claude.calls[0].system.includes("<creativity>"));
  assert.ok(claude.calls[0].user.includes("Duration: 2:05") && claude.calls[0].user.includes('"before"'));
  assert.equal(got.get("b1").card.mode, "scene");
  assert.equal(got.get("b2").card.brand, "youtube");

  const groq = okLlm(undefined, ({ user }) => JSON.stringify({ cards: JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1)).map(r => ({ id: r.id, mode: "ui", layout: "chips", pill: "p", items: [{ text: "a" }, { text: "b" }] })) }));
  await cardsFor({ llm: groq, items: items.slice(0, 1), log: () => {} });
  assert.ok(groq.calls[0].system.includes("CARD FORM") && !groq.calls[0].system.includes("<creativity>"));
});

test("cardsFor with Claude halves a TRUNCATED answer and asks again", async () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, start: i * 10, end: i * 10 + 5, quote: `Line ${i + 1}.`, description: "d" }));
  const kinds = ["blue_grey", "sepia", "pink", "green"];
  const llm = okLlm("rich", ({ user }, n) => {
    const ids = [...user.matchAll(/"id": "(b\d)"/g)].map(m => m[1]);
    if (ids.length > 2) throw new LlmError("cut off", "TRUNCATED");
    return JSON.stringify({ cards: ids.map(id => ({ id, mode: "scene", palette: kinds[Number(id[1]) - 1], subject: `thing ${id}`, composition: "wide" })) });
  });
  const got = await cardsFor({ llm, items, batchSize: 10, log: () => {} });
  assert.equal(got.size, 4);
  assert.ok([...got.values()].every(v => !v.fellBack));
  assert.ok(llm.calls.length >= 3);
});

test("newIdea (Claude) sends the current card, what to avoid and the editor's wish", async () => {
  const llm = okLlm("rich", () => JSON.stringify({ notes: "different", card: { id: "b1", mode: "ui", layout: "toggles", pill: "x", rows: [{ label: "a", on: true }, { label: "b", on: false }] } }));
  const item = { id: "b1", start: 0, end: 5, quote: "You can do the work or fantasize.", description: "d" };
  const r = await newIdea({ llm, item, current: scene({ id: "b1" }), wish: "use toggles", all: [item], log: () => {} });
  assert.equal(r.card.layout, "toggles");
  assert.ok(llm.calls[0].system.includes("NEW IDEA"));
  assert.ok(llm.calls[0].user.includes("use toggles") && llm.calls[0].user.includes("palettes: [sepia]") && llm.calls[0].user.includes("modes: [scene]"));
});

test("pickAndDesign groups neighbours and validates each card", async () => {
  const items = [1, 2, 3].map(i => ({ id: `b${i}`, start: i * 5, end: i * 5 + 4, quote: `Line ${i}.`, description: `d${i}` }));
  const llm = okLlm("rich", () => JSON.stringify({ notes: "n", pictures: [{ ids: ["b1", "b2"], description: "shared", card: scene({ id: "b1" }) }, { ids: ["b3"], card: { id: "b3", mode: "logo", brand: "skool", display_name: "Skool", kind: "platform" } }] }));
  const r = await pickAndDesign({ llm, items, duration: 30, log: () => {} });
  assert.deepEqual(r.decisions.map(d => d.at.map(x => x.id)), [["b1", "b2"], ["b3"]]);
  assert.equal(r.cards.get("b1").mode, "scene");
  assert.equal(r.cards.get("b3").brand, "skool");
});

/* ------------------------------------------------------------ the Claude provider (fake Chrome page) */
function fakeChrome({ answers, loggedOut = false, limit = false, dropFirstSend = false, chatId = "123e4567-e89b-12d3-a456-426614174000", stopFor = 0 }) {
  const state = { url: "about:blank", box: "", msgs: [], sends: 0, stopLeft: 0, gotos: [], active: 0, maxActive: 0, continueBtn: false };
  const el = (visible, extra = {}) => ({ isVisible: async () => visible(), isEnabled: async () => true, click: async () => extra.click && extra.click(), evaluate: async fn => extra.eval ? extra.eval(fn) : "", fill: async t => { state.box = t; } });
  const locators = {
    "[contenteditable='true']": () => [el(() => !loggedOut, { eval: fn => (String(fn).includes("tagName.toLowerCase") ? "div" : String(state.box).length) })],
    "button[aria-label='Send message']": () => [el(() => true, { click: () => { state.sends++; state.stopLeft = stopFor; if (!limit && !(dropFirstSend && state.sends === 1)) state.msgs.push(answers.shift()); state.box = ""; state.url = `https://claude.ai/chat/${chatId}`; } })],
    "button[aria-label='Stop response']": () => [el(() => state.stopLeft-- > 0)],
    "div.font-claude-response": () => state.msgs.map(m => el(() => true, { eval: () => m })),
    "input[type='email']": () => [el(() => loggedOut)]
  };
  const page = {
    url: () => state.url,
    goto: async u => { state.gotos.push(u); state.url = u; },
    bringToFront: async () => {},
    locator: sel => { const make = locators[sel] || (() => []); return { count: async () => make().length, nth: i => make()[i] }; },
    keyboard: { insertText: async t => { state.box = t; }, press: async () => {} },
    evaluate: async () => (limit && state.sends > 0 ? "You've reached your usage limit" : "page"),
    title: async () => "Claude"
  };
  const ctx = { pages: () => [page], newPage: async () => page, grantPermissions: async () => {} };
  let connected = 0;
  const connect = async () => { connected++; return { contexts: () => [ctx], close: async () => {} }; };
  return { state, connect, connectedCount: () => connected };
}

const cfgOf = (over = {}) => ({ cdpUrl: "x", claude: {
  settleMs: 5, startWaitMs: 60, replyTimeoutMs: 3000, maxContinues: 2, newChatEvery: 0, limitTextPatterns: ["usage limit"],
  selectors: { input: ["[contenteditable='true']"], send: ["button[aria-label='Send message']"], stop: ["button[aria-label='Stop response']"], assistantMessage: ["div.font-claude-response"], copyButton: [], continueButton: [], loginMarker: ["input[type='email']"] }, ...over } });

const withFile = fn => async () => { const dir = tmp(); const file = path.join(dir, "claude-chat.json"); await fn(file); };

test("claude: sends one combined message, returns the answer and remembers the chat; the next call opens the same chat", withFile(async file => {
  const fc = fakeChrome({ answers: ['{"a":1}', '{"b":2}'] });
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect: fc.connect, file, delay: async () => {}, pollMs: 1 });
  assert.equal(llm.profile, "rich");
  assert.equal(await llm.chat({ system: "SYS", user: "USR" }), '{"a":1}');
  assert.ok(fc.state.box === "" && fc.state.sends === 1);
  assert.equal(cw.readChat(file).chatUrl, "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000");
  assert.equal(cw.readChat(file).messages, 1);
  fc.state.url = "https://claude.ai/recents";
  assert.equal(await llm.chat({ system: "S", user: "U" }), '{"b":2}');
  assert.equal(fc.state.gotos[1], "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000");
  assert.equal(cw.readChat(file).messages, 2);
}));

test("claude: waits while the Stop button is visible", withFile(async file => {
  const fc = fakeChrome({ answers: ['{"ok":true}'], stopFor: 6 });
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect: fc.connect, file, delay: async () => {}, pollMs: 1 });
  assert.equal(await llm.chat({ system: "s", user: "u" }), '{"ok":true}');
}));

test("claude: errors are coded (AUTH, HTTP_429, TRUNCATED, NETWORK)", withFile(async file => {
  const mk = (over, extra) => cw.makeClaudeWeb({ cfg: cfgOf(over), connect: extra.connect, file, delay: async () => {}, pollMs: 1 });
  const out = fakeChrome({ answers: [], loggedOut: true });
  await assert.rejects(mk({}, out).chat({ system: "s", user: "u" }), e => e.code === "AUTH");
  const lim = fakeChrome({ answers: [], limit: true });
  await assert.rejects(mk({}, lim).chat({ system: "s", user: "u" }), e => e.code === "HTTP_429");
  const cut = fakeChrome({ answers: ['{"a":[1,2', '{"a":[1,2', '{"a":[1,2'] });
  await assert.rejects(mk({}, cut).chat({ system: "s", user: "u" }), e => e.code === "TRUNCATED");
  await assert.rejects(mk({}, { connect: async () => { throw new Error("no chrome"); } }).chat({ system: "s", user: "u" }), e => e.code === "NETWORK" && /Launch Chrome/.test(e.message));
}));

test("claude: two calls at once are serialized", withFile(async file => {
  const fc = fakeChrome({ answers: ['{"n":1}', '{"n":2}'] });
  let active = 0, max = 0;
  const connect = async () => { active++; max = Math.max(max, active); const b = await fc.connect(); return { ...b, close: async () => { active--; } }; };
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect, file, delay: async () => {}, pollMs: 1 });
  const [a, b] = await Promise.all([llm.chat({ system: "s", user: "1" }), llm.chat({ system: "s", user: "2" })]);
  assert.deepEqual([a, b], ['{"n":1}', '{"n":2}']);
  assert.equal(max, 1);
}));

test("claude chat file: reset clears it, a bad link is refused", () => {
  const file = path.join(tmp(), "c.json");
  cw.writeChat({ chatUrl: "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000" }, file);
  assert.ok(cw.readChat(file).chatUrl);
  cw.resetChat(file);
  assert.equal(cw.readChat(file).chatUrl, "");
  assert.throws(() => cw.writeChat({ chatUrl: "https://example.com/x" }, file));
});

test("claude: an answer that is not JSON is re-requested once as a JSON code block", withFile(async file => {
  const fc = fakeChrome({ answers: ["Sure! Here is my plan in words, no JSON.", '{"broll":[{"start_segment":1}]}'] });
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect: fc.connect, file, delay: async () => {}, pollMs: 1 });
  assert.equal(await llm.chat({ system: "s", user: "u" }), '{"broll":[{"start_segment":1}]}');
  assert.equal(fc.state.sends, 2, "one follow-up message in the same chat");
}));

test("claude: if the first Send did nothing, Send is pressed again and the answer is still found", withFile(async file => {
  const fc = fakeChrome({ answers: ['{"ok":1}'], dropFirstSend: true });
  const logs = [];
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect: fc.connect, file, log: m => logs.push(m), delay: async () => {}, pollMs: 1 });
  assert.equal(await llm.chat({ system: "s", user: "u" }), '{"ok":1}');
  assert.ok(fc.state.sends >= 2);
  assert.ok(logs.some(l => /pressing Send again/.test(l)));
}));

test("claude: an old answer left on the page is not mistaken for the new one", withFile(async file => {
  const fc = fakeChrome({ answers: ['{"n":1}', '{"n":2}'] });
  const llm = cw.makeClaudeWeb({ cfg: cfgOf(), connect: fc.connect, file, delay: async () => {}, pollMs: 1 });
  assert.equal(await llm.chat({ system: "s", user: "1" }), '{"n":1}');
  assert.equal(await llm.chat({ system: "s", user: "2" }), '{"n":2}');
}));

test("refsFor with only some of the six files: the palette's own first, then the next ones that exist", () => {
  const dir = tmp();
  for (const n of ["pink", "sepia", "muted_multicolor"]) fs.writeFileSync(path.join(dir, `tatami-${n}.jpg`), "x");
  const names = pal => P.refsFor(pal, dir).map(f => path.basename(f));
  assert.deepEqual(names("pink"), ["tatami-pink.jpg", "tatami-muted_multicolor.jpg", "tatami-sepia.jpg"]);
  assert.deepEqual(names("sepia"), ["tatami-sepia.jpg", "tatami-pink.jpg", "tatami-muted_multicolor.jpg"]);
  assert.equal(names("green")[0], "tatami-muted_multicolor.jpg", "no green file: starts from the next one that exists in the ring");
  assert.equal(names("green").length, 3);
  assert.ok(P.refsFor("pink", dir).every(f => fs.existsSync(f)));
});
