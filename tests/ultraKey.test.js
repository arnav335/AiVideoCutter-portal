import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Ultra Key: removing the green around the dark UI cards (keying.js, chosen(), Clips, export filter).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-key-"));
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
const require = createRequire(import.meta.url);
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const keying = require("../src/broll/keying.js");
const { loadConfig } = require("../src/broll/config.js");
const cfg = loadConfig();
const { default: projects } = await import("../src/broll/projects.js");
const jobs = require("../src/broll/jobs.js");
const renderLib = require("../src/broll/render.js");
const { overlayChain } = await import("../src/utils/cutMedia.js");

projects.configure({
  dir: id => path.join(tmp, "projects", id, "broll"),
  exists: id => /^p\d+$/.test(id),
  defaultProvider: () => "groq",
  readCues: async () => ({ cues: [], duration: 100 }),
  timeline: async () => ({ intervals: [{ start: 0, end: 100 }], duration: 100 }),
  touch: () => {}
});

const pixel = (file, x, y) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "ignore"] });
const makeCard = (file) => {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x00FF00:s=200x120", "-vf", "drawbox=x=40:y=20:w=120:h=80:color=0x121212:t=fill", "-frames:v", "1", file]);
};

test("isKeyable: only the green card modes, and only when enabled", () => {
  for (const m of ["ui", "material", "symbol"]) assert.equal(keying.isKeyable(m, cfg), true, m);
  for (const m of ["scene", "logo", "person", "real_image", undefined]) assert.equal(keying.isKeyable(m, cfg), false, String(m));
  assert.equal(keying.isKeyable("ui", { ultraKey: { ...cfg.ultraKey, enabled: false } }), false);
});

test("keyedFile puts the png in the sibling keyed folder", () => {
  assert.equal(keying.keyedFile(path.join("a", "jobs", "j1", "images", "p003_1.jpg")), path.join("a", "jobs", "j1", "keyed", "p003_1.png"));
});

test("ensureKeyed: green becomes transparent, the card stays, and it is cached", { skip: !hasFfmpeg }, async () => {
  const src = path.join(tmp, "k1", "images", "p001_1.png");
  makeCard(src);
  const out = await keying.ensureKeyed(src, cfg);
  assert.equal(out, path.join(tmp, "k1", "keyed", "p001_1.png"));
  const corner = pixel(out, 2, 2), centre = pixel(out, 100, 60);
  assert.equal(corner[3], 0);
  assert.equal(centre[3], 255);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(centre[i] - 0x12) < 12, `channel ${i} = ${centre[i]}`);
  const m1 = fsSync.statSync(out).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  await keying.ensureKeyed(src, cfg);
  assert.equal(fsSync.statSync(out).mtimeMs, m1);
});

// A project whose job has one picked picture per B-roll.
async function setup(id, specs, options = {}) {
  const job = jobs.createJob(specs.map(s => `prompt ${s.id}`), { mock: true, metas: specs.map(s => ({ brollId: s.id, ...(s.key ? { key: true } : {}) })) });
  specs.forEach((s, i) => {
    const file = `p${String(i + 1).padStart(3, "0")}_1.png`;
    const full = path.join(cfg.outputDir, "jobs", job.id, "images", file);
    makeCard(full);
    jobs.update(job.id, j => { j.items[i].images = [{ file, url: `/output/jobs/${job.id}/images/${file}` }]; j.items[i].selected = file; j.items[i].status = "done"; });
    s.full = full;
  });
  const dir = path.join(tmp, "projects", id, "broll");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({
    id, steps: {}, flowJobId: job.id, log: [], options: { theme: "card", ...options },
    brolls: specs.map((s, i) => ({ id: s.id, start: i * 10, end: i * 10 + 5, enabled: true, prompt: "x", description: "d", mode: s.mode }))
  }));
  return { job, specs };
}

test("chosen(): keyed picture only for green cards with key:true, switch on and the file present", { skip: !hasFfmpeg }, async () => {
  const { job, specs } = await setup("p1", [
    { id: "b1", mode: "ui", key: true }, { id: "b2", mode: "scene", key: false }, { id: "b3", mode: "ui", key: true }, { id: "b4", mode: "ui", key: false }
  ]);
  await jobs.keyJobImages(job.id);
  // b1 and b3 got keyed copies; b3's is then removed to test the "file must exist" rule.
  fsSync.rmSync(keying.keyedFile(specs[2].full));
  const got = Object.fromEntries(projects.chosen("p1").map(c => [c.id, c]));
  assert.equal(got.b1.keyed, true);
  assert.equal(got.b1.imagePath, keying.keyedFile(specs[0].full));
  assert.equal(got.b2.keyed, false); assert.equal(got.b2.imagePath, specs[1].full);   // scene is never keyed
  assert.equal(got.b3.keyed, false); assert.equal(got.b3.imagePath, specs[2].full);   // keyed file missing
  assert.equal(got.b4.keyed, false); assert.equal(got.b4.imagePath, specs[3].full);   // not marked key
  assert.ok(jobs.get(job.id).items[0].images[0].keyedUrl.endsWith("/keyed/p001_1.png"));
  assert.equal(jobs.get(job.id).items[1].images[0].keyedUrl, undefined);

  projects.saveOptions("p1", { ultraKey: false });                                    // switch off: originals everywhere
  assert.equal(projects.chosen("p1").find(c => c.id === "b1").keyed, false);
  assert.equal(projects.chosen("p1").find(c => c.id === "b1").imagePath, specs[0].full);
  projects.saveOptions("p1", { ultraKey: true });
  assert.equal(projects.chosen("p1").find(c => c.id === "b1").keyed, true);
});

test("overlayChain: alpha overlays use yuva420p and format=auto, others are unchanged", () => {
  const base = { overlayFit: "cover", size: { width: 1280, height: 720 }, from: "vcat", to: "vout" };
  const withAlpha = overlayChain({ ...base, overlays: [{ file: "a.png", start: 1, end: 3, alpha: true }] }).join("\n");
  assert.match(withAlpha, /format=yuva420p/);
  assert.match(withAlpha, /format=auto:eof_action=pass/);
  const plain = overlayChain({ ...base, overlays: [{ file: "a.png", start: 1, end: 3 }] }).join("\n");
  assert.match(plain, /format=yuv420p/);
  assert.doesNotMatch(plain, /yuva420p|format=auto/);
});

test("Clips use the original picture and warn about the green", { skip: !hasFfmpeg }, async () => {
  const { job, specs } = await setup("p2", [{ id: "b1", mode: "ui", key: true }]);
  await jobs.keyJobImages(job.id);
  assert.equal(projects.chosen("p2")[0].keyed, true);
  const orig = renderLib.render;
  let seen = null;
  renderLib.render = async ({ items }) => { seen = items; return { warnings: [] }; };
  try {
    const p = await projects.startRender("p2", {});
    for (let i = 0; i < 200 && p.steps.render.status === "running"; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(p.steps.render.status, "done", p.steps.render.error);
    assert.equal(seen[0].imagePath, specs[0].full);
    assert.ok(p.steps.render.result.warnings.some(w => w.startsWith("Green card pictures stay on green")));
  } finally { renderLib.render = orig; }
});
