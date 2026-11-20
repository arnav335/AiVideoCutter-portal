import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

// Unit tests for the B-roll feature: time mapping, the export filter graph (plus a real render),
// the planner, the gap-free clip layout and the guard that keeps the module local.
// The real-render test is skipped when ffmpeg is not installed.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-broll-"));
process.env.WORKSPACE_DIR = tmp;

const require = createRequire(import.meta.url);
const timeline = require("../src/broll/timeline.js");
const planner = require("../src/broll/planner.js");
const renderLib = require("../src/broll/render.js");
const { buildFilterGraph, cutMedia } = await import("../src/utils/cutMedia.js");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// ---------------------------------------------------------------- time mapping
test("B-roll times move onto the cut timeline; cut-out time disappears", () => {
  const kept = [{ start: 0, end: 2 }, { start: 3, end: 6 }];
  assert.deepEqual(timeline.mapSpan(kept, 0.5, 1.5), { start: 0.5, end: 1.5 });
  assert.deepEqual(timeline.mapSpan(kept, 1.5, 4), { start: 1.5, end: 3 });          // spans the cut
  const inside = timeline.mapSpan(kept, 2.2, 2.8);                                      // lies only in the cut
  assert.equal(inside.end - inside.start, 0);
  assert.equal(timeline.totalKept(kept), 5);
});

test("snapToKept pulls B-roll in to kept footage and drops cut-out ones", () => {
  const kept = [{ start: 0, end: 2 }, { start: 3, end: 6 }];
  assert.deepEqual(timeline.snapToKept(kept, 1, 4), { start: 1, end: 4 });
  assert.deepEqual(timeline.snapToKept(kept, 2.1, 5), { start: 3, end: 5 });
  assert.equal(timeline.snapToKept(kept, 2.1, 2.9), null);
  assert.equal(timeline.snapToKept(kept, 1.95, 3.05), null);                            // only slivers kept (< 0.15 s)
});

test("brollOverlays maps chosen pictures and drops the ones that are cut out", async () => {
  const { default: projects } = await import("../src/broll/projects.js");
  const { brollOverlays } = await import("../src/server/broll.js");
  const original = projects.chosen;
  projects.chosen = () => [
    { id: "a", start: 0.5, end: 1.5, imagePath: "/x/a.png" },
    { id: "b", start: 2.2, end: 2.8, imagePath: "/x/b.png" },   // inside the cut
    { id: "c", start: 1.5, end: 4, imagePath: "/x/c.png" }
  ];
  try {
    const out = brollOverlays("whatever", [{ start: 0, end: 2 }, { start: 3, end: 6 }]);
    assert.deepEqual(out.map(o => [o.id, o.file, o.start, o.end]), [["a", "/x/a.png", 0.5, 1.5], ["c", "/x/c.png", 1.5, 3]]);
  } finally { projects.chosen = original; }
});

// ---------------------------------------------------------------- filter graph
test("the filter graph lays B-roll over the joined video, under the captions", () => {
  const intervals = [{ start: 0, end: 2 }, { start: 3, end: 6 }];
  const size = { width: 641, height: 361 };
  const overlays = [{ file: "a.png", start: 0.5, end: 1.5 }, { file: "b.png", start: 3, end: 4 }];

  const plain = buildFilterGraph({ intervals, hasVideo: true, overlays: [], size });
  assert.match(plain, /concat=n=2:v=1:a=1\[vout\]\[aout\]/);                         // unchanged without B-roll
  assert.doesNotMatch(plain, /overlay/);

  const g = buildFilterGraph({ intervals, hasVideo: true, overlays, size });
  assert.match(g, /concat=n=2:v=1:a=1\[vcat\]\[aout\]/);
  assert.match(g, /\[1:v\]scale=640:360:force_original_aspect_ratio=increase,crop=640:360/);   // odd sizes become even
  assert.match(g, /\[2:v\]scale=640:360/);
  assert.match(g, /\[vcat\]\[ov0\]overlay=eof_action=pass:enable='between\(t,0\.500,1\.500\)'\[vb0\]/);
  assert.match(g, /\[vb0\]\[ov1\]overlay=eof_action=pass:enable='between\(t,3\.000,4\.000\)'\[vout\]/);
  assert.match(g, /loop=loop=-1:size=1/);                                              // decoded once, then repeated

  const contain = buildFilterGraph({ intervals, hasVideo: true, overlays, overlayFit: "contain", size });
  assert.match(contain, /force_original_aspect_ratio=decrease:force_divisible_by=2/);
  assert.doesNotMatch(contain, /pad=/, "fit inside paints nothing around the picture");
  assert.match(contain, /overlay=x=\(main_w-overlay_w\)\/2:y=\(main_h-overlay_h\)\/2:/);

  const withCaptions = buildFilterGraph({ intervals, hasVideo: true, overlays, size, subtitles: { file: "c.ass", fontsDir: null } });
  assert.match(withCaptions, /\[vb0\]\[ov1\]overlay=[^\n]*\[vbroll\];\n\[vbroll\]subtitles=c\.ass\[vout\]/);

  assert.doesNotMatch(buildFilterGraph({ intervals, hasVideo: false, overlays, size }), /overlay/);   // audio only
  assert.throws(() => buildFilterGraph({ intervals, hasVideo: true, overlays }), /video size/);
});

// Average colour of a small patch at (x, y) (fractions of the frame) of the video at time t.
function patch(file, t, x, y) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `crop=iw/16:ih/16:iw*${x}:ih*${y},scale=1:1,format=rgb24`, "-f", "rawvideo", "-"]);
  return [...out.subarray(0, 3)];
}
const near = (rgb, want, tol = 28) => rgb.every((v, i) => Math.abs(v - want[i]) <= tol);

test("B-roll pictures appear exactly where the cut timeline says, filling or fitting the frame",
  { skip: !hasFfmpeg && "ffmpeg not found" }, async () => {
    const base = path.join(tmp, "base.mp4");
    const red = path.join(tmp, "red.png");
    const lime = path.join(tmp, "lime.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:d=6:r=25",
      "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", base]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=800x800", "-frames:v", "1", red]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=lime:s=320x180", "-frames:v", "1", lime]);

    const intervals = [{ start: 0, end: 2 }, { start: 3, end: 6 }];           // output is 5 s long
    const overlays = [{ file: red, start: 0, end: 1.5 }, { file: lime, start: 3, end: 5 }];  // starts at 0 and ends with the video
    const size = { width: 640, height: 360 };
    const GREY = [48, 48, 48], RED = [255, 0, 0], LIME = [0, 255, 0];

    const cover = path.join(tmp, "cover.mp4");
    await cutMedia({ inputPath: base, outputPath: cover, intervals, hasVideo: true, overlays, overlayFit: "cover", size });
    const probe = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cover]).toString());
    assert.ok(Math.abs(probe - 5) < 0.15, `duration ${probe}`);

    assert.ok(near(patch(cover, 0.05, 0.5, 0.5), RED), "first frame already shows the picture");
    assert.ok(near(patch(cover, 1.0, 0.02, 0.5), RED), "cover: the picture reaches the left edge");
    assert.ok(near(patch(cover, 1.8, 0.5, 0.5), GREY), "plain video between pictures");
    assert.ok(near(patch(cover, 2.9, 0.5, 0.5), GREY), "plain video just before the second picture");
    assert.ok(near(patch(cover, 3.3, 0.5, 0.5), LIME), "second picture");
    assert.ok(near(patch(cover, 4.8, 0.5, 0.5), LIME), "second picture runs to the end of the video");

    const contain = path.join(tmp, "contain.mp4");
    await cutMedia({ inputPath: base, outputPath: contain, intervals, hasVideo: true, overlays: [overlays[0]], overlayFit: "contain", size });
    assert.ok(near(patch(contain, 1.0, 0.5, 0.5), RED), "contain: picture in the middle");
    assert.ok(near(patch(contain, 1.0, 0.02, 0.5), GREY), "contain: the sides are transparent, the video shows through (no black bars)");
  });

// ---------------------------------------------------------------- planner
const cuesOf = text => {
  let t = 0;
  return text.split(/\s+/).map((w, i) => { const c = { index: i + 1, start: t, end: t + 0.4, text: w }; t += 0.5; return c; });
};

test("the planner splits a transcript into lines and lays B-roll back to back", () => {
  const cues = cuesOf("Hello there my friends. This is a second sentence here. And a third one follows now.");
  const segs = planner.buildSegments(cues);
  assert.ok(segs.length >= 2);
  assert.equal(segs[0].first, 0);
  assert.equal(segs[segs.length - 1].last, cues.length - 1);

  const items = [
    { start: 3, end: 5, anchor: "b", description: "second", quote: "q" },
    { start: 0.2, end: 2, anchor: "a", description: "first", quote: "q" }
  ];
  const plan = planner.finalizePlan(items, { total: 9 });
  assert.deepEqual(plan.map(p => [p.id, p.start, p.end]), [["b001", 0, 3], ["b002", 3, 9]]);
  assert.ok(plan.every(p => p.enabled && p.prompt === ""));
});

test("the planner finds quoted words even when slightly misquoted", () => {
  const cues = cuesOf("one two three four five six");
  const seg = { first: 0, last: 5 };
  assert.deepEqual(planner.locate("three four", seg, cues), { start: cues[2].start, end: cues[3].end });
  assert.ok(planner.locate("three FOUR!", seg, cues));
  assert.equal(planner.locate("nonsense words", seg, cues), null);
  assert.equal(planner.applySuffix("A cat", "no text"), "A cat. no text");
});

// ---------------------------------------------------------------- separate clips
test("clips cover the whole timeline with no gaps, frame exact", () => {
  const { clips, totalFrames } = renderLib.layout([
    { id: "b2", start: 3.0, end: 5, imagePath: "2.png" },
    { id: "b1", start: 0.4, end: 3, imagePath: "1.png" }
  ], 8);
  assert.equal(totalFrames, 240);
  assert.deepEqual(clips.map(c => [c.id, c.fa, c.fb]), [["b1", 0, 90], ["b2", 90, 240]]);
});

// ---------------------------------------------------------------- keeping B-roll local
test("B-roll refuses requests that do not come from localhost", async () => {
  const { handleBrollGlobal, handleOutput } = await import("../src/server/broll.js");
  const url = new URL("http://localhost/api/broll/status");
  const req = headers => ({ method: "GET", headers });
  const refused = /localhost/;

  await assert.rejects(handleBrollGlobal(req({ host: "evil.example:3000" }), {}, url, ["broll", "status"]), refused);
  await assert.rejects(handleBrollGlobal(req({ host: "localhost:3000", origin: "https://evil.example" }), {}, url, ["broll", "status"]), refused);
  await assert.rejects(handleBrollGlobal(req({ host: "localhost:3000", "sec-fetch-site": "cross-site" }), {}, url, ["broll", "status"]), refused);
  await assert.rejects(handleOutput(req({ host: "192.168.1.5:3000" }), {}, new URL("http://x/output/jobs/a.png")), refused);

  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
    let sent;
    const res = { writeHead() {}, end: body => { sent = JSON.parse(body); } };
    await handleBrollGlobal(req({ host, origin: `http://${host}` }), res, url, ["broll", "status"]);
    assert.ok("chromeUp" in sent, host);
  }
});

test("pictures cannot be fetched from outside the B-roll folder", async () => {
  const { handleOutput } = await import("../src/server/broll.js");
  const local = { host: "localhost:3000" };
  await assert.rejects(handleOutput({ method: "GET", headers: local }, {}, new URL("http://x/output/..%2F..%2Fsecret.txt")), /Forbidden|not found/i);
  await assert.rejects(handleOutput({ method: "GET", headers: local }, {}, new URL("http://x/output/jobs/none/images/p001_1.png")), /not found/i);
});

// ---------------------------------------------------------------- which lines get a picture, groups
const line = (id, start, end, description = `pic ${id}`) => ({ id, start, end, quote: `words of ${id}`, anchor: "", description, prompt: "", enabled: true });
const sixLines = () => [line("b1", 0, 2), line("b2", 2, 4), line("b3", 4, 6), line("b4", 6, 8), line("b5", 8, 10), line("b6", 10, 12)];
const fakeLlm = answer => ({ calls: [], async chat(args) { this.calls.push(args); return JSON.stringify(typeof answer === "function" ? answer(args) : answer); } });

test("the AI's picks switch the other lines off but keep their descriptions", async () => {
  const llm = fakeLlm({ pictures: [{ ids: ["b2"] }, { ids: ["b5"] }] });
  const { items, picked, groups } = await planner.chooseBroll({ llm, items: sixLines() });
  assert.equal(picked, 2);
  assert.equal(groups, 0);
  assert.deepEqual(items.map(b => [b.id, b.enabled]), [["b1", false], ["b2", true], ["b3", false], ["b4", false], ["b5", true], ["b6", false]]);
  assert.equal(items[0].description, "pic b1");                       // kept, so it can be ticked later
  assert.match(llm.calls[0].system, /deserve a picture/);
  assert.match(llm.calls[0].user, /"picture": "pic b1"/);               // the AI sees every line and its description
});

test("the AI's groups become ONE item that covers all their lines", async () => {
  const llm = fakeLlm({ pictures: [{ ids: ["b2", "b3", "b4"], description: "A rocket engine firing" }, { ids: ["b6"] }] });
  const { items, groups } = await planner.chooseBroll({ llm, items: sixLines() });
  assert.equal(groups, 1);
  assert.deepEqual(items.map(b => b.id), ["b1", "b2", "b5", "b6"]);   // b3 and b4 merged into b2
  const g = items[1];
  assert.equal(g.enabled, true);
  assert.equal(g.start, 2);
  assert.equal(g.end, 8);
  assert.equal(g.description, "A rocket engine firing");
  assert.equal(g.prompt, "");
  assert.deepEqual(g.lines.map(l => [l.start, l.end, l.description]), [[2, 4, "pic b2"], [4, 6, "pic b3"], [6, 8, "pic b4"]]);
  assert.equal(g.quote, "words of b2 words of b3 words of b4");
  assert.equal(items[0].enabled, false);
  assert.equal(items[2].enabled, false);
});

test("groups that are not made of neighbouring lines are split, repeats and unknown ids are ignored", async () => {
  const llm = fakeLlm({ pictures: [{ ids: ["b1", "b3"], description: "x" }, { ids: ["b3", "nope"] }, { ids: "b5" }, { ids: ["b4", "b5"], description: "pair" }, "b6"] });
  const { items } = await planner.chooseBroll({ llm, items: sixLines() });
  assert.deepEqual(items.map(b => [b.id, b.enabled, (b.lines || []).length]), [
    ["b1", true, 0], ["b2", false, 0], ["b3", true, 0], ["b4", true, 2], ["b6", true, 0]
  ]);
  assert.equal(items[3].description, "pair");                            // the malformed entry is ignored, b4+b5 are grouped
});

test("a group without a usable description falls back to its first line's description", async () => {
  const { items } = await planner.chooseBroll({ llm: fakeLlm({ pictures: [{ ids: ["b1", "b2"] }] }), items: sixLines() });
  assert.equal(items[0].description, "pic b1");
});

test("a long plan is decided in parts and groups never cross a part", async () => {
  const items = Array.from({ length: 5 }, (_, i) => line(`c${i + 1}`, i * 2, i * 2 + 2));
  const llm = fakeLlm(({ user }) => ({ pictures: [{ ids: [...user.matchAll(/"id": "(c\d)"/g)].map(m => m[1]), description: "all of the part" }] }));
  const out = await planner.chooseBroll({ llm, items, batchSize: 3 });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(out.items.map(b => [b.id, b.lines.length]), [["c1", 3], ["c4", 2]]);
});

test("if the AI picks nothing the plan step is told, so it can keep every line on", async () => {
  await assert.rejects(planner.chooseBroll({ llm: fakeLlm({ pictures: [] }), items: sixLines() }), /did not pick/);
  await assert.rejects(planner.chooseBroll({ llm: fakeLlm({ pictures: [{ ids: ["zzz"] }] }), items: sixLines() }), /did not pick/);
});

test("a group can be split back into its lines with their own descriptions", () => {
  const lines = [{ start: 0, end: 2, quote: "a", description: "da" }, { start: 2, end: 5, quote: "b", description: "db" }];
  const group = { id: "g", start: 0, end: 5, quote: "a b", anchor: "A", description: "shared", prompt: "p", enabled: true, lines };
  let n = 0;
  const parts = planner.splitGroup(group, () => `n${++n}`);
  assert.deepEqual(parts.map(b => [b.id, b.start, b.end, b.description, b.prompt, b.enabled, b.lines]), [
    ["g", 0, 2, "da", "", true, undefined], ["n1", 2, 5, "db", "", true, undefined]
  ]);
  assert.deepEqual(planner.splitGroup({ id: "x", start: 0, end: 1 }, () => "y").map(b => b.id), ["x"]);   // not a group: unchanged
});

test("merging keeps the primary's id and prompt, and groups of groups stay flat", () => {
  const a = { ...line("a", 0, 2), enabled: false, prompt: "pa" };
  const b = { ...line("b", 2, 4), prompt: "pb" };
  const c = line("c", 4, 6);
  const ab = planner.mergeGroup([a, b], { primary: b });
  assert.equal(ab.id, "b");
  assert.equal(ab.description, "pic b");
  assert.equal(ab.prompt, "pb");                                         // same description, so the picture still fits
  const abc = planner.mergeGroup([ab, c]);
  assert.equal(abc.lines.length, 3);
  assert.deepEqual([abc.start, abc.end], [0, 6]);
});

test("the planning rules ask for bare information and a second pass picks the pictures", () => {
  const rules = fsSync.readFileSync(new URL("../src/broll/planner.js", import.meta.url), "utf8");
  assert.match(rules, /plain INFORMATION taken from the spoken words/);
  assert.match(rules, /NO style or aesthetics of any kind/);
  assert.doesNotMatch(rules, /grey-brown metal under soft daylight/);   // the old styled example is gone
});

test("placement: a B-roll follows the parent position, and its own override wins per property", () => {
  const { resolvePos, cleanPos } = require("../src/broll/projects");
  const p = { globalPos: { cx: 0.5, cy: 0.4, w: 0.8 } };
  assert.deepEqual(resolvePos(p, {}), { cx: 0.5, cy: 0.4, w: 0.8 });                       // follows the parent
  assert.deepEqual(resolvePos(p, { pos: { w: 0.3 } }), { cx: 0.5, cy: 0.4, w: 0.3 });      // only the size is its own
  assert.deepEqual(resolvePos(p, { pos: { cx: 0.2, cy: 0.9 } }), { cx: 0.2, cy: 0.9, w: 0.8 });
  assert.equal(resolvePos({}, {}), null);                                                  // nothing set: fill / fit
  assert.equal(resolvePos({}, { pos: { w: 0.3 } }), null);                                 // partial with no parent is incomplete
  assert.deepEqual(resolvePos({}, { pos: { cx: 0.5, cy: 0.5, w: 1 } }), { cx: 0.5, cy: 0.5, w: 1 }); // old full pos still works
  assert.deepEqual(cleanPos({ cx: 9, cy: "x", w: 0 }), { cx: 1.5, w: 0.1 });               // clamped, junk dropped
  assert.equal(cleanPos({ cx: 0.5 }, { full: true }), null);
});
