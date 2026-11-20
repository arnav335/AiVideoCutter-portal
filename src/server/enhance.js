import fs from "node:fs/promises";
import path from "node:path";

import { jobFile, updateJob, getJob } from "./jobs.js";
import { HttpError } from "./http.js";
import { probeMedia, runFfmpeg } from "../utils/ffmpeg.js";

export const ADOBE_ENHANCE_URL = "https://podcast.adobe.com/en/enhance";

const rmQuiet = file => fs.rm(file, { force: true }).catch(() => {});

// MP3 of the project's audio (the same trimmed timeline the editor plays), ready to drop into Adobe Podcast.
export async function buildEnhanceMp3(id) {
  const job = getJob(id);
  if (!job?.base) throw new HttpError(409, "This project has not finished processing.");
  const out = jobFile(id, "audio-for-adobe.mp3");
  await runFfmpeg(["-y", "-i", jobFile(id, job.base.file), "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2", out]);
  return out;
}

// Swap the audio of the project for the enhanced file. The picture and the timing stay exactly as they were, so
// the transcript, the cuts, captions and B-roll all still line up. The first base file is kept so it can be restored.
export async function applyEnhancedAudio(id, uploadedPath, originalName) {
  const job = getJob(id);
  if (!job?.base) throw new HttpError(409, "This project has not finished processing.");

  const original = job.enhanced?.original || { file: job.base.file, duration: job.base.duration };
  const info = await probeMedia(uploadedPath).catch(() => null);
  if (!info?.hasAudio) throw new HttpError(400, "That file has no audio. Drop the file you downloaded from Adobe Podcast.");

  const target = original.duration || job.base.duration;
  if (target && info.duration && Math.abs(info.duration - target) > 2) {
    throw new HttpError(400,
      `That audio is ${info.duration.toFixed(1)}s long but this project is ${target.toFixed(1)}s. ` +
      `Make sure you enhanced the MP3 downloaded from this project.`);
  }

  const ext = path.extname(original.file).toLowerCase();
  const next = `base.enhanced-${Date.now()}${ext}`;
  const args = ["-y"];

  if (job.source.hasVideo) {
    args.push("-i", jobFile(id, original.file), "-i", uploadedPath,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
  } else {
    const codec = ext === ".wav" ? ["-c:a", "pcm_s16le"] : ext === ".mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:a", "aac", "-b:a", "192k"];
    args.push("-i", uploadedPath, "-map", "0:a:0", "-vn", ...codec);
  }
  // Keep the length identical to the project: pad a hair short, cut a hair long.
  args.push("-af", "apad", "-t", String(original.duration || info.duration), jobFile(id, next));

  try {
    await runFfmpeg(args);
  } catch (error) {
    await rmQuiet(jobFile(id, next));
    throw new HttpError(500, `Could not replace the audio: ${error.message.split("\n")[0]}`);
  }

  const previous = job.enhanced?.file;
  await updateJob(id, j => {
    const dur = ((j.enhanced?.original || original).duration);
    j.enhanced = { file: next, originalName, at: Date.now(), original };
    j.base = { file: next, duration: dur };
    if (j.export?.status === "done") j.export.stale = true;
  });
  if (previous) await rmQuiet(jobFile(id, previous));
}

export async function revertEnhancedAudio(id) {
  const job = getJob(id);
  if (!job?.enhanced) throw new HttpError(409, "This project is already using its original audio.");
  const { file, original } = job.enhanced;
  await updateJob(id, j => {
    j.base = { file: original.file, duration: original.duration };
    delete j.enhanced;
    if (j.export?.status === "done") j.export.stale = true;
  });
  await rmQuiet(jobFile(id, file));
}
