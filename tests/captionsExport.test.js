import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Real render: burn captions into a small test video and check they appear.
// Skipped when ffmpeg (with libass) is not installed.
const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
const canBurn = ffmpeg.status === 0 && /\bsubtitles\b/.test(ffmpeg.stdout);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-burn-"));
process.env.WORKSPACE_DIR = tmp;

const { buildFilterGraph } = await import("../src/utils/cutMedia.js");

test("the filter graph burns captions in after the cuts are joined", () => {
  const intervals = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
  const plain = buildFilterGraph({ intervals, hasVideo: true });
  assert.match(plain, /concat=n=2:v=1:a=1\[vout\]\[aout\]/);
  assert.doesNotMatch(plain, /subtitles/);

  const burned = buildFilterGraph({ intervals, hasVideo: true, subtitles: { file: "captions.ass", fontsDir: "capfonts" } });
  assert.match(burned, /concat=n=2:v=1:a=1\[vcat\]\[aout\];\n\[vcat\]subtitles=captions\.ass:fontsdir=capfonts\[vout\]/);

  const noFolder = buildFilterGraph({ intervals, hasVideo: true, subtitles: { file: "captions.ass", fontsDir: null } });
  assert.match(noFolder, /\[vcat\]subtitles=captions\.ass\[vout\]/);

  assert.doesNotMatch(buildFilterGraph({ intervals, hasVideo: false, subtitles: { file: "x.ass" } }), /subtitles/);
});

test("captions are burned into the exported video", { skip: !canBurn && "ffmpeg with libass not found" }, async () => {
  const { createJob, jobFile } = await import("../src/server/jobs.js");
  const { prepareCaptions } = await import("../src/server/captionRender.js");
  const { cutMedia } = await import("../src/utils/cutMedia.js");
  const { computeKeepIntervals } = await import("../src/shared/editModel.js");
  const { sanitizeCaptions } = await import("../src/shared/captions.js");

  const job = await createJob({ name: "burn" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x202020:s=640x360:d=4:r=25",
    "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    jobFile(job.id, "base.mp4")]);

  const words = [
    { t: "Hello", s: 0.2, e: 0.6 }, { t: "uh", s: 0.7, e: 1.0 }, { t: "there", s: 1.1, e: 1.6 },
    { t: "friends.", s: 1.7, e: 2.4 }
  ];
  const mask = new Uint8Array([0, 1, 0, 0]);
  const intervals = computeKeepIntervals(words, mask, { duration: 4, pad: 0.05 });
  const config = sanitizeCaptions({ enabled: true, style: { size: 80, y: 0.5 } });

  const prepared = await prepareCaptions(job.id, { config, words, mask, intervals, videoFile: "base.mp4" });
  assert.equal(prepared.count, 1);

  const ass = await fs.readFile(jobFile(job.id, "captions.ass"), "utf8");
  assert.match(ass, /Hello there friends\./);
  assert.doesNotMatch(ass, /\buh\b/);          // the cut word is not captioned

  const plainFile = jobFile(job.id, "plain.mp4");
  const burnedFile = jobFile(job.id, "burned.mp4");
  await cutMedia({ inputPath: jobFile(job.id, "base.mp4"), outputPath: plainFile, intervals, hasVideo: true });
  await cutMedia({ inputPath: jobFile(job.id, "base.mp4"), outputPath: burnedFile, intervals, hasVideo: true, subtitles: prepared.subtitles });

  // Compare the middle frame: the captioned one must differ from the plain one.
  const frame = file => execFileSync("ffmpeg", ["-v", "error", "-ss", "0.8", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 10_000_000 });
  const a = frame(plainFile), b = frame(burnedFile);
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  assert.ok(differing > 500, `only ${differing} pixels changed`);
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
