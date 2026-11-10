// Command-line mode: process one recording end to end with no review step.
// The AI's cuts are applied as-is and the trimmed video is written to output/.
//
//   npm run cli                     (uses the first file in input/)
//   npm run cli -- my-video.mp4     (a file from input/)
//
// For the review portal run `npm start` instead.

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

import { initStore, createJob, getJob, updateJob, jobFile } from "./server/jobs.js";
import { runPipeline, exportJob } from "./server/pipeline.js";
import { SUPPORTED_EXTENSIONS } from "./utils/ffmpeg.js";

const INPUT_DIR = path.resolve("input");
const OUTPUT_DIR = path.resolve("output");

async function pickInput(name) {
  if (name) return path.basename(name);

  const files = (await fs.readdir(INPUT_DIR))
    .filter(f => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()));

  if (files.length === 0) throw new Error(`Put a video in ${INPUT_DIR} first.`);
  return files[0];
}

async function main() {
  const fileName = await pickInput(process.argv[2]);
  const ext = path.extname(fileName).toLowerCase();

  await initStore();
  const job = await createJob({ name: path.parse(fileName).name });

  await fs.copyFile(path.join(INPUT_DIR, fileName), jobFile(job.id, `source${ext}`));
  await updateJob(job.id, j => {
    j.source = { file: `source${ext}`, originalName: fileName, size: 0, duration: null, hasVideo: null };
  });

  console.log(`Processing ${fileName}...`);

  let lastLine = "";
  const timer = setInterval(() => {
    const steps = getJob(job.id).steps;
    const running = Object.entries(steps).find(([, s]) => s.status === "running");
    const line = running ? `  ${running[0]}: ${running[1].message || "working"}` : "";
    if (line && line !== lastLine) console.log(line);
    lastLine = line;
  }, 500);

  await runPipeline(job.id);
  clearInterval(timer);

  const done = getJob(job.id);
  if (done.state !== "review") throw new Error(done.error?.message || "Processing failed.");
  for (const [name, step] of Object.entries(done.steps)) {
    console.log(`  ${name}: ${step.status}${step.message ? ` - ${step.message}` : ""}`);
  }

  console.log("Rendering the final video...");
  await exportJob(job.id);

  const result = getJob(job.id).export;
  if (result.status !== "done") throw new Error(result.error || "Export failed.");

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, `${path.parse(fileName).name}-trimmed${path.extname(result.file)}`);
  await fs.copyFile(jobFile(job.id, result.file), target);

  console.log(`Done: ${target}`);
  console.log(`Want to review the cuts first? Run "npm start" and open project "${done.name}".`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
