import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The whole B-roll flow on a small project: an AI that answers from a fake local server writes the plan and the
// prompts, test mode makes the pictures (no Chrome, no Flow), and the real export puts them over the video.
// Then the real server is started to check that the routes and the export option are wired up.
// Skipped when ffmpeg is not installed.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
// The export and the server load the portal's own dependencies, so these tests need `npm install` first.
const missingDeps = ["dotenv/config", "@speechmatics/batch-client"].filter(name => { try { import.meta.resolve(name); return false; } catch { return true; } });
const skipReason = (!hasFfmpeg && "ffmpeg not found") || (missingDeps.length > 0 && `run npm install first (missing ${missingDeps.join(", ")})`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-broll-e2e-"));
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.GEMINI_API_KEY = "test-key";
delete process.env.GROQ_API_KEY;

// A tiny stand-in for the Gemini API. It answers the two kinds of request the B-roll module makes.
const requests = [];
let failSelection = false;
const fakeAi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    const system = body.systemInstruction.parts[0].text;
    const user = body.contents[0].parts[0].text;
    requests.push({ url: req.url, key: req.headers["x-goog-api-key"], system, user });

    let answer;
    if (failSelection && /deserve a picture/.test(system)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "selection is down" } }));
    }
    if (/deserve a picture/.test(system)) {
      // Second pass: skip greetings and sign-offs, group the two "engine" lines, give every other line its own picture.
      const lines = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      const wanted = lines.filter(l => !/Welcome|Thanks/.test(l.line));
      const engines = wanted.filter(l => /engines|fun to build/.test(l.line)).map(l => l.id);
      answer = { pictures: [
        ...wanted.filter(l => !engines.includes(l.id)).map(l => ({ ids: [l.id] })),
        { ids: engines, description: "Three rocket engines side by side" }
      ].sort((a, b) => a.ids[0].localeCompare(b.ids[0])) };
    } else if (/You write prompts for an AI image generation model/.test(system)) {
      const items = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      answer = { prompts: items.map(i => ({ id: i.id, prompt: `Illustration: ${i.description}` })) };
    } else if (/You fill in a CARD FORM/.test(system)) {
      // Card theme: the first row is a picture the editor must find themselves, every other row is a symbol card.
      const rows = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      answer = { cards: rows.map((r, i) => (i === 0
        ? { id: r.id, mode: "real_image", pill: "the rocket", search_hint: "Falcon 9 rocket launch" }
        : { id: r.id, mode: "symbol", pill: "rocket", icon: i % 2 ? "trophy" : "bell", icon_role: "accent", name: `card ${i}` })) };
    } else {
      const segs = [...user.matchAll(/^\[(\d+)\] \S+ (.+)$/gm)].map(m => ({ id: Number(m[1]), words: m[2].split(" ") }));
      answer = {
        broll: segs.map(s => ({
          start_segment: s.id, start_text: s.words.slice(0, 2).join(" "),
          end_segment: s.id, end_text: s.words.slice(-2).join(" "),
          description: `A picture for line ${s.id}: ${s.words.slice(0, 4).join(" ")}`
        }))
      };
    }
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(json);
  });
});
await new Promise(r => fakeAi.listen(0, "127.0.0.1", r));
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}/v1beta`;
test.after(() => fakeAi.close());

// 19 s of talking: a greeting, three real lines, a sign-off, and a stumble ("Um actually wait.") that is cut.
const SENTENCES = [
  { at: 0.3, text: "Welcome to the channel everyone." },
  { at: 3.5, text: "Today we are building a rocket." },
  { at: 7.0, text: "Um actually wait." },
  { at: 9.5, text: "It has three big engines." },
  { at: 12.5, text: "Rockets are really fun to build." },
  { at: 16.0, text: "Thanks so much for watching today." }
];
function makeWords() {
  const words = [];
  for (const s of SENTENCES) s.text.split(" ").forEach((t, i) => words.push({ t, s: +(s.at + i * 0.45).toFixed(2), e: +(s.at + i * 0.45 + 0.35).toFixed(2) }));
  return words;
}

async function waitFor(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Spread between the strongest and weakest colour channel in a patch of the picture (grey video ≈ 0, pictures ≫ 30).
function corner(file, t) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", "crop=iw/16:ih/16:iw/16:ih/16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
  return [...out.subarray(0, 3)];
}
const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
function colourfulness(file, t) {
  const rgb = corner(file, t);
  return Math.max(...rgb) - Math.min(...rgb);
}

test("plan → prompts → pictures → export puts the chosen pictures over the video", { skip: skipReason }, async () => {
  const jobs = await import("../src/server/jobs.js");
  const { setupBroll, brollOnTranscriptChanged } = await import("../src/server/broll.js");
  const { exportJob } = await import("../src/server/pipeline.js");
  const { default: brollApi } = await import("../src/broll/api.js");
  const { default: projects } = await import("../src/broll/projects.js");
  const { rangesToMask, computeKeepIntervals } = await import("../src/shared/editModel.js");

  await jobs.initStore();
  setupBroll();

  // A processed project: base video, transcript, and the stumble cut out.
  const job = await jobs.createJob({ name: "rocket" });
  const id = job.id;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:d=19:r=25",
    "-f", "lavfi", "-i", "sine=f=440:d=19", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", jobs.jobFile(id, "base.mp4")]);
  const words = makeWords();
  await jobs.writeJob(id, "words.json", { words, duration: 19 });
  const cutFrom = words.findIndex(w => w.t === "Um"), cutTo = words.findIndex(w => w.t === "wait.");
  await jobs.writeJob(id, "edits.json", { ranges: [[cutFrom, cutTo]], updatedAt: Date.now() });
  await jobs.updateJob(id, j => {
    j.source = { file: "source.mp4", originalName: "rocket.mp4", size: 1, duration: 19, hasVideo: true };
    j.base = { file: "base.mp4", duration: 19 };
    j.state = "review";
  });

  // This test follows the original "free style" flow (the card theme has its own test below).
  let P = await brollApi.forJob(id, "GET", "", {});
  assert.equal(P.options.theme, "card", "new projects start with the card theme");
  P = await brollApi.forJob(id, "POST", "options", { theme: "free" });
  assert.equal(P.options.theme, "free");

  // 1. Plan: only the words that stay are sent to the AI.
  assert.equal(P.llm.provider, "gemini");
  assert.equal(P.llm.hasKey, true);
  await brollApi.forJob(id, "POST", "plan", {});
  P = await waitFor(async () => {
    const x = await brollApi.forJob(id, "GET", "", {});
    if (x.steps.plan.status === "failed") throw new Error(x.steps.plan.error);
    return x.steps.plan.status === "done" && x;
  }, "the plan");
  assert.equal(requests[0].key, "test-key");
  assert.doesNotMatch(requests[0].user, /\bUm\b|actually|wait\./, "cut words must not be sent to the AI");
  assert.match(requests[0].system, /NO style or aesthetics of any kind/, "descriptions are asked for as bare information");

  // The second pass happens after every line has its description, and it sees them all.
  assert.match(requests[1].system, /deserve a picture/);
  for (const n of [1, 2, 3, 4, 5]) assert.match(requests[1].user, new RegExp(`A picture for line ${n}`));
  assert.doesNotMatch(requests[1].user, /\bUm\b|actually/);

  // 5 lines stay: the greeting and the sign-off are switched off (descriptions kept), the two "engine" lines share one picture.
  assert.deepEqual(P.brolls.map(b => [b.id, b.enabled, (b.lines || []).length]), [
    ["b001", false, 0], ["b002", true, 0], ["b003", true, 2], ["b005", false, 0]
  ]);
  assert.match(P.brolls[0].description, /A picture for line 1/);
  assert.match(P.brolls[3].description, /A picture for line 5/);
  const group = P.brolls[2];
  assert.equal(group.description, "Three rocket engines side by side");
  assert.match(group.quote, /engines.*fun to build/);
  assert.deepEqual(group.lines.map(l => l.description.replace(/:.*/, "")), ["A picture for line 3", "A picture for line 4"]);
  assert.ok(P.brolls.every(b => !b.cutOut));
  const keep = computeKeepIntervals(words, rangesToMask([[cutFrom, cutTo]], words.length), { duration: 19, pad: 0.05 });
  for (const b of P.brolls) {
    assert.ok(keep.some(iv => b.start >= iv.start - 1e-6 && b.end <= iv.end + 1e-6) || b.id === "b003", `${b.id} lies in kept footage`);
  }
  assert.ok(group.start >= 9.4 && group.end > 15.9, "the group runs from its first line to the end of its last");

  // 2. Prompts
  await brollApi.forJob(id, "POST", "prompts", { common: "flat vector style", suffix: "no text" });
  P = await waitFor(async () => {
    const x = await brollApi.forJob(id, "GET", "", {});
    if (x.steps.prompts.status === "failed") throw new Error(x.steps.prompts.error);
    return x.steps.prompts.status === "done" && x;
  }, "the prompts");
  const on = P.brolls.filter(b => b.enabled), off = P.brolls.filter(b => !b.enabled);
  assert.ok(on.every(b => b.prompt.startsWith("Illustration:") && b.prompt.endsWith("no text")));
  assert.ok(off.every(b => b.prompt === ""), "unticked lines get no prompt and no image credits");
  assert.match(requests.at(-1).user, /Three rocket engines side by side/);
  assert.match(requests.at(-1).system, /flat vector style/);

  // 3. Pictures in test mode (no Chrome, no Flow credits)
  P = await brollApi.forJob(id, "POST", "images", { mock: true, settings: { ratio: "16:9", model: "Nano Banana 2.1", count: 1 } });
  P = await waitFor(async () => {
    const x = await brollApi.forJob(id, "GET", "", {});
    return x.flowJob && x.flowJob.status === "done" && x;
  }, "the pictures");
  const flowJob = P.flowJob;
  assert.equal(flowJob.items.length, 2, "one picture for the single line and one for the whole group");
  assert.deepEqual(flowJob.items.map(i => i.brollId), ["b002", "b003"]);

  for (const index of [0, 1]) await brollApi.global("POST", `flow/${flowJob.id}/select`, { index, file: flowJob.items[index].images[0].file });
  const chosen = projects.chosen(id);
  assert.deepEqual(chosen.map(c => c.id), ["b002", "b003"]);

  // 4. Export with B-roll
  const pad = 0.05;
  await exportJob(id, { pad, broll: true, brollFit: "cover" });
  const done = jobs.getJob(id);
  assert.equal(done.export.status, "done", done.export.error);
  assert.deepEqual(done.export.broll, { enabled: true, count: 2, fit: "cover" });

  const final = jobs.jobFile(id, done.export.file);
  const mapSpan = (iv, t0, t1) => { const before = t => iv.reduce((a, x) => a + (t <= x.start ? 0 : Math.min(t, x.end) - x.start), 0); return { s: before(t0), e: before(t1) }; };
  const [greeting, single, grp, signoff] = P.brolls.map(b => mapSpan(keep, b.start, b.end));
  assert.ok(Math.abs(done.export.duration - keep.reduce((a, x) => a + x.end - x.start, 0)) < 0.01);

  const mid = sp => (sp.s + sp.e) / 2;
  assert.ok(colourfulness(final, mid(greeting)) < 10, "the skipped greeting stays plain video");
  assert.ok(colourfulness(final, mid(single)) > 40, "the single picture is on screen");
  assert.ok(colourfulness(final, mid(signoff)) < 10, "the skipped sign-off stays plain video");
  // One picture for the whole group: the same image at the start and at the end of it, different from the single one.
  const early = corner(final, grp.s + 0.3), late = corner(final, grp.e - 0.3), singleColour = corner(final, mid(single));
  assert.ok(colourfulness(final, grp.s + 0.3) > 40 && near(early, late), `group shows ONE picture (${early} vs ${late})`);
  assert.ok(!near(early, singleColour), "the group's picture differs from the single line's picture");

  // The same project exported without B-roll has none.
  await exportJob(id, { pad, broll: false });
  const plain = jobs.getJob(id);
  assert.equal(plain.export.broll.count, 0);
  assert.ok(colourfulness(jobs.jobFile(id, plain.export.file), mid(single)) < 10);

  // Changing a pick makes the finished export out of date.
  await brollApi.global("POST", `flow/${flowJob.id}/select`, { index: 1, file: flowJob.items[1].images[0].file });
  await waitFor(() => jobs.getJob(id).export.stale, "the export to be marked out of date");

  // Groups can be changed afterwards: ungroup gives every line its own description back, grouping joins neighbours again.
  const status = async fn => { try { return await fn(); } catch (e) { return e.status; } };
  P = await brollApi.forJob(id, "POST", "ungroup/b003", {});
  assert.equal(P.brolls.length, 5);
  const [lineC, lineD] = P.brolls.slice(2, 4);
  assert.equal(lineC.id, "b003");
  assert.match(lineC.description, /A picture for line 3/);
  assert.match(lineD.description, /A picture for line 4/);
  assert.ok([lineC, lineD].every(b => b.enabled && b.prompt === "" && !b.lines));
  assert.notEqual(lineD.id, "b003");
  assert.equal(projects.chosen(id).some(c => c.id === "b003"), false, "the group's picture no longer fits line 3 alone");
  assert.equal(await status(() => brollApi.forJob(id, "POST", "ungroup/b002", {})), 400, "a single line is not a group");
  assert.equal(await status(() => brollApi.forJob(id, "POST", "group", { ids: ["b002", lineD.id] })), 400, "lines must be neighbours");
  assert.equal(await status(() => brollApi.forJob(id, "POST", "group", { ids: ["b002"] })), 400);
  assert.equal(await status(() => brollApi.forJob(id, "POST", "group", { ids: ["b002", "nope"] })), 404);

  P = await brollApi.forJob(id, "POST", "group", { ids: [lineC.id, lineD.id] });
  assert.equal(P.brolls.length, 4);
  assert.deepEqual(P.brolls[2].lines.map(l => l.description.replace(/:.*/, "")), ["A picture for line 3", "A picture for line 4"]);
  // Saving the list keeps the groups, so they survive a reload.
  P = await brollApi.forJob(id, "POST", "save", { brolls: P.brolls });
  assert.equal(P.brolls[2].lines.length, 2);
  P = await brollApi.forJob(id, "POST", "group", { ids: ["b001", "b002"] });      // a skipped line joined to a ticked one
  assert.equal(P.brolls[0].enabled, true);
  assert.equal(P.brolls[0].id, "b002", "the group keeps the ticked member (and so its picture)");

  // New words mean a new plan: the old B-roll is dropped (and projects that never used B-roll are left alone).
  brollOnTranscriptChanged(id);
  P = await brollApi.forJob(id, "GET", "", {});
  assert.equal(P.brolls.length, 0);
  assert.equal(P.flowJob, null);
  const untouched = await jobs.createJob({ name: "never used B-roll" });
  brollOnTranscriptChanged(untouched.id);
  await assert.rejects(fs.access(path.join(jobs.jobDir(untouched.id), "broll")));
});

test("if the AI cannot decide which lines deserve a picture, every line stays on and you are told", { skip: skipReason }, async () => {
  const jobs = await import("../src/server/jobs.js");
  const { setupBroll } = await import("../src/server/broll.js");
  const { default: brollApi } = await import("../src/broll/api.js");
  await jobs.initStore();
  setupBroll();

  const job = await jobs.createJob({ name: "fallback" });
  const words = makeWords();
  await jobs.writeJob(job.id, "words.json", { words, duration: 19 });
  await jobs.writeJob(job.id, "edits.json", { ranges: [], updatedAt: Date.now() });

  failSelection = true;
  try {
    await brollApi.forJob(job.id, "POST", "plan", {});
    const P = await waitFor(async () => {
      const x = await brollApi.forJob(job.id, "GET", "", {});
      return x.steps.plan.status !== "running" && x;
    }, "the plan");
    assert.equal(P.steps.plan.status, "done", P.steps.plan.error);
    assert.match(P.steps.plan.warning, /could not decide which lines deserve a picture/);
    assert.ok(P.brolls.length >= 5 && P.brolls.every(b => b.enabled && b.description.startsWith("A picture for line")), "all lines kept, with descriptions");
  } finally { failSelection = false; }

  // Planning again clears the warning.
  await brollApi.forJob(job.id, "POST", "plan", {});
  const again = await waitFor(async () => {
    const x = await brollApi.forJob(job.id, "GET", "", {});
    return x.steps.plan.status !== "running" && x;
  }, "the second plan");
  assert.equal(again.steps.plan.warning, undefined);
  assert.ok(again.brolls.some(b => !b.enabled));
});

test("card theme: plan → card prompts → pictures; a real_image card gets no prompt and no image", { skip: skipReason }, async () => {
  const jobs = await import("../src/server/jobs.js");
  const { setupBroll } = await import("../src/server/broll.js");
  const { default: brollApi } = await import("../src/broll/api.js");
  await jobs.initStore();
  setupBroll();

  const job = await jobs.createJob({ name: "cards" });
  const words = makeWords();
  await jobs.writeJob(job.id, "words.json", { words, duration: 19 });
  await jobs.writeJob(job.id, "edits.json", { ranges: [], updatedAt: Date.now() });

  const first = await brollApi.forJob(job.id, "GET", "", {});
  assert.equal(first.options.theme, "card");
  assert.equal(first.options.prompts.suffix, "Flat graphic on solid #00FF00, no green spill.");
  assert.deepEqual(first.themes.map(t => t.id), ["card", "free"]);

  const before = requests.length;
  await brollApi.forJob(job.id, "POST", "plan", {});
  await waitFor(async () => (await brollApi.forJob(job.id, "GET", "", {})).steps.plan.status === "done", "the plan");
  assert.match(requests[before].system, /KEEP every number, name, date and comparison/, "the card theme asks the planner to keep the facts");
  assert.match(requests[before + 1].system, /CARD THEME/);

  await brollApi.forJob(job.id, "POST", "prompts", { common: "", suffix: "Flat graphic on solid #00FF00, no green spill." });
  const P = await waitFor(async () => {
    const x = await brollApi.forJob(job.id, "GET", "", {});
    if (x.steps.prompts.status === "failed") throw new Error(x.steps.prompts.error);
    return x.steps.prompts.status === "done" && x;
  }, "the card prompts");
  const on = P.brolls.filter(b => b.enabled);
  assert.ok(on.length >= 2, `expected at least 2 enabled B-rolls, got ${on.length}`);
  assert.equal(on[0].needsRealImage, true);
  assert.equal(on[0].searchHint, "Falcon 9 rocket launch");
  assert.equal(on[0].prompt, "");
  for (const b of on.slice(1)) {
    assert.ok(b.prompt.startsWith("Flat 2D UI graphic. On a solid pure green (#00FF00) background"), b.prompt.slice(0, 60));
    assert.ok(b.prompt.endsWith("Flat graphic on solid #00FF00, no green spill."));
    assert.doesNotMatch(b.prompt, /16:9|4:3|1:1/);
  }

  let images = await brollApi.forJob(job.id, "POST", "images", { mock: true, settings: { ratio: "16:9", model: "Nano Banana 2.1", count: 1 } });
  images = await waitFor(async () => {
    const x = await brollApi.forJob(job.id, "GET", "", {});
    return x.flowJob && x.flowJob.status === "done" && x;
  }, "the pictures");
  assert.deepEqual(images.flowJob.items.map(i => i.brollId), on.slice(1).map(b => b.id), "the real_image item is skipped by the images step");
});

test("the real server serves B-roll and refuses outsiders", { skip: skipReason }, async () => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const workspace = path.join(tmp, "server-workspace");
  const child = spawn(process.execPath, ["src/server/server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WORKSPACE_DIR: workspace }, stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  try {
    await waitFor(() => /running at/.test(log) || (child.exitCode !== null && Promise.reject(new Error(`Server exited:\n${log}`))), "the server");

    const get = (p, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, headers }, res => {
        let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
      });
      req.on("error", reject); req.end();
    });
    const post = async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };

    const options = await get("/api/broll/options");
    assert.equal(options.status, 200);
    assert.ok(JSON.parse(options.body).models.length > 0);
    assert.equal((await get("/broll.css")).status, 200);

    const created = await post("/api/jobs", { name: "smoke" });
    const jobId = created.json.id;
    const plan = await get(`/api/jobs/${jobId}/broll`);
    assert.equal(plan.status, 200);
    assert.deepEqual(JSON.parse(plan.body).brolls, []);
    assert.equal((await post(`/api/jobs/${jobId}/broll/plan`, {})).status, 409, "planning needs a transcript first");

    // Pictures: served with an image type; nothing outside the B-roll folder.
    const dir = path.join(workspace, "broll", "jobs", "abc", "images");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "p001_1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const pic = await get("/output/jobs/abc/images/p001_1.jpg");
    assert.equal(pic.status, 200);
    assert.match(pic.type, /image\/jpeg/);
    assert.equal((await get("/output/..%2F..%2Fjob.json")).status, 403);

    // Outsiders: wrong Host header (DNS rebinding) and cross-site requests.
    const evil = await get("/api/broll/status", { host: "evil.example" });
    assert.equal(evil.status, 403);
    assert.equal((await get(`/api/jobs/${jobId}/broll`, { host: "evil.example" })).status, 403);
    assert.equal((await get("/output/jobs/abc/images/p001_1.jpg", { host: "evil.example" })).status, 403);

    // The export route accepts the B-roll options and refuses a project that is not processed.
    const exp = await post(`/api/jobs/${jobId}/export`, { pad: 0.05, broll: true, brollFit: "contain" });
    assert.equal(exp.status, 202);
    await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).export.status === "error", "the export to fail cleanly");

    // Deleting a project also removes its B-roll pictures.
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`, { method: "DELETE" })).json()).ok, true);
  } finally {
    child.kill();
  }
});
