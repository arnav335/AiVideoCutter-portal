import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Scenes, logos and people inside a project: references, the logo registry, the images step. Fake Groq, mock image job.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-claude-"));
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.GROQ_API_KEY = "test-key";
delete process.env.GEMINI_API_KEY;

const require = createRequire(import.meta.url);
let answer = () => [];
const fakeAi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    const user = body.messages[1].content;
    const rows = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cards: answer(rows) }) }, finish_reason: "stop" }] }));
  });
});
await new Promise(r => fakeAi.listen(0, "127.0.0.1", r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}/openai/v1`;
test.after(() => fakeAi.close());

const { default: projects } = await import("../src/broll/projects.js");
const { default: api } = await import("../src/broll/api.js");
const P = require("../src/broll/cardPrompt.js");

projects.configure({
  dir: id => path.join(tmp, "projects", id, "broll"),
  exists: id => /^p\d+$/.test(id),
  defaultProvider: () => "groq",
  readCues: async () => ({ cues: [], duration: 200 }),
  timeline: async () => ({ intervals: [{ start: 0, end: 200 }], duration: 200 }),
  touch: () => {}
});

const waitStep = async (p, step) => {
  for (let i = 0; i < 300 && p.steps[step].status === "running"; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(p.steps[step].status, "done", p.steps[step].error);
};
const item = (id, start, quote) => ({ id, start, end: start + 8, quote, anchor: "", description: `about ${quote}`, prompt: "", enabled: true });
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const forms = {
  s1: { id: "s1", mode: "scene", palette: "pink", subject: "a person on a floor", action: "daydreaming", composition: "high_angle" },
  l1: { id: "l1", mode: "logo", brand: "zzz-test-brand", display_name: "Zzz Brand", kind: "company" },
  l2: { id: "l2", mode: "logo", brand: "zzz-test-brand", display_name: "Zzz Brand", kind: "company" },
  p1: { id: "p1", mode: "person", name: "Steve Jobs", render: "real", action: "sitting calmly", composition: "close_up" },
  p2: { id: "p2", mode: "person", name: "Hannibal", render: "animated", palette: "green", action: "watching an army" }
};

test("scenes and animated people carry three references; logos and real persons carry none", async () => {
  const p = projects.ensure("p1");
  p.brolls = ["s1", "l1", "l2", "p1", "p2"].map((id, i) => item(id, i * 10, `line ${id}`));
  answer = rows => rows.map(r => forms[r.id]);
  projects.startPrompts("p1", {});
  await waitStep(p, "prompts");
  const by = Object.fromEntries(p.brolls.map(b => [b.id, b]));
  assert.deepEqual(by.s1.refs.map(f => path.basename(f)), ["tatami-pink.jpg", "tatami-muted_multicolor.jpg", "tatami-sepia.jpg"], "the three bundled style images, the palette's own first");
  assert.equal(by.p2.refs.length, 3);
  assert.equal(by.p1.refs, undefined);
  assert.equal(by.l1.refs, undefined);
  assert.equal(by.l1.source, "generated");
  assert.equal(by.l1.logoSlug, "zzz-test-brand");
  assert.ok(by.s1.prompt.startsWith(P.TATAMI_STYLE) && !by.s1.prompt.includes("00FF00"));
});

test("the images step stops before it starts when the style references are missing", async () => {
  const p = projects.ensure("p1");
  const missing = p.brolls.some(b => (b.refs || []).some(f => !fsSync.existsSync(f)));
  if (!missing) return;   // the six reference images are present in this checkout
  await assert.rejects(api.forJob("p1", "POST", "images", {}), e => /Style reference images are missing in assets\/style\/tatami/.test(e.message));
});

test("a user logo file is used with no generation; a generated logo used twice is made once", { skip: !hasFfmpeg }, async () => {
  const logo = path.join(P.LOGO_DIR, "zzz-file-brand.png");
  try {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", logo], { stdio: "ignore" });
    const p = projects.ensure("p1");
    p.brolls = ["l1", "l2", "f1"].map((id, i) => item(id, i * 10, `line ${id}`));
    answer = rows => rows.map(r => (r.id === "f1" ? { id: "f1", mode: "logo", brand: "zzz-file-brand", display_name: "Zzz File", kind: "company" } : forms[r.id]));
    projects.startPrompts("p1", {});
    await waitStep(p, "prompts");
    const f1 = p.brolls.find(b => b.id === "f1");
    assert.equal(f1.source, "file");
    assert.equal(f1.prompt, "");
    assert.deepEqual(projects.imageItems(p).map(b => b.id), ["l1", "l2", "f1"], "the file item is part of the images step");

    const view = await api.forJob("p1", "POST", "images", { mock: true, settings: { ratio: "16:9", model: "Nano Banana 2.1", count: 1 } });
    const jobs = require("../src/broll/jobs.js");
    for (let i = 0; i < 200 && jobs.runningJobId(); i++) await new Promise(r => setTimeout(r, 50));
    const job = jobs.get(view.flowJobId);
    const [a, b, c] = job.items;
    assert.equal(c.status, "done");
    assert.ok(c.selected, "the logo file is picked automatically");
    assert.equal(b.dupOf, 0, "the second use of the same logo copies the first");
    assert.equal(b.status, "done");
    assert.ok(b.selected && b.images.length === 1);
    assert.equal(a.images.length, 1);
  } finally { fsSync.rmSync(logo, { force: true }); }
});

test("a failed real-person picture offers animated or a real photo", async () => {
  const p = projects.ensure("p1");
  p.brolls = [item("p1", 0, "Steve Jobs said it.")];
  answer = rows => rows.map(r => forms[r.id]);
  projects.startPrompts("p1", {});
  await waitStep(p, "prompts");
  assert.equal(p.brolls[0].card.render, "real");
  const anim = projects.personToAnimated("p1", "p1");
  const b = anim.brolls[0];
  assert.equal(b.card.render, "animated");
  assert.equal(b.card.palette, "blue_grey");
  assert.equal(b.refs.length, 3);
  const photo = projects.personToPhoto("p1", "p1").brolls[0];
  assert.equal(photo.needsRealImage, true);
  assert.equal(photo.searchHint, "Steve Jobs");
});
