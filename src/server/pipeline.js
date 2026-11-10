import fs from "node:fs/promises";
import path from "node:path";

import {
  STEP_NAMES, jobFile, readJsonFile, updateJob, writeJob, getJob
} from "./jobs.js";

import { convertToWav } from "../utils/convertToWav.js";
import { probeMedia } from "../utils/ffmpeg.js";
import { cutMedia } from "../utils/cutMedia.js";
import { transcribeAudio } from "../functions/transcribe.js";
import { reviewWithGroq } from "../functions/groqReview.js";
import {
  buildSegments, computeKeepIntervals, computePauseIntervals, applyDecisions,
  maskToRanges, rangesToMask, remapWords, totalDuration
} from "../shared/editModel.js";

const busy = new Set();
export const isBusy = id => busy.has(id);

const PLAYABLE_AS_IS = [".mp4", ".m4v", ".mp3", ".wav", ".m4a"];

function setStep(id, name, patch, opts) {
  return updateJob(id, job => { Object.assign(job.steps[name], patch); }, opts);
}

// Run the processing steps from `from` onward.
export async function runPipeline(id, { from = "audio" } = {}) {
  if (busy.has(id)) throw new Error("This project is already being processed.");
  busy.add(id);

  const startIndex = STEP_NAMES.indexOf(from);
  let current = from;

  try {
    // New words mean old cut positions are meaningless.
    if (startIndex <= STEP_NAMES.indexOf("trim")) {
      await fs.rm(jobFile(id, "edits.json"), { force: true });
      await fs.rm(jobFile(id, "ai.json"), { force: true });
    }

    await updateJob(id, job => {
      job.state = "running";
      job.error = null;
      STEP_NAMES.forEach((name, i) => {
        if (i >= startIndex) job.steps[name] = { status: "pending", message: "", progress: null };
      });
    });

    for (const name of STEP_NAMES.slice(startIndex)) {
      current = name;
      await setStep(id, name, { status: "running", message: "", progress: null, startedAt: Date.now() });
      const result = await STEPS[name](id);
      await setStep(id, name, {
        status: result?.skipped ? "skipped" : "done",
        message: result?.message || "",
        progress: null,
        endedAt: Date.now()
      });
    }

    await updateJob(id, job => { job.state = "review"; });
  } catch (error) {
    console.error(`[${id}] ${current} failed:`, error.message);
    await updateJob(id, job => {
      job.state = "error";
      job.error = { step: current, message: error.message };
      job.steps[current] = { ...job.steps[current], status: "error", message: error.message, progress: null };
    });
  } finally {
    busy.delete(id);
  }
}

const STEPS = {
  // 1. Probe the upload and extract audio for the transcription service.
  async audio(id) {
    const job = getJob(id);
    const sourcePath = jobFile(id, job.source.file);

    const info = await probeMedia(sourcePath);
    if (!info.hasAudio) throw new Error("This file has no audio track.");

    await convertToWav(sourcePath, jobFile(id, "raw.wav"));

    await updateJob(id, j => {
      j.source.duration = info.duration;
      j.source.hasVideo = info.hasVideo;
    });
    return { message: info.hasVideo ? "Video with audio" : "Audio only" };
  },

  // 2. Word-level transcript. The result is cached so re-running later steps is free.
  async transcribe(id) {
    const cache = jobFile(id, "words.raw.json");
    const cached = await readJsonFile(cache, null);
    if (cached?.length) return { message: `${cached.length} words (reused earlier transcript)` };

    const words = await transcribeAudio({
      inputPath: jobFile(id, "raw.wav"),
      language: getJob(id).settings.language,
      onStatus: message => setStep(id, "transcribe", { message }, { persist: false })
    });

    await writeJob(id, "raw-words-tmp.json", words);
    await fs.rename(jobFile(id, "raw-words-tmp.json"), cache);
    return { message: `${words.length} words` };
  },

  // 3. Remove long silences and move the transcript onto the shortened timeline.
  async trim(id) {
    const job = getJob(id);
    const { settings, source } = job;
    const raw = await readJsonFile(jobFile(id, "words.raw.json"));
    const sourcePath = jobFile(id, source.file);
    const sourceExt = path.extname(source.file).toLowerCase();

    const wantTrim = settings.trimPauses && settings.maxPause > 0;
    const needsEncode = !PLAYABLE_AS_IS.includes(sourceExt);

    let words = raw;
    let baseFile = source.file;
    let baseDuration = source.duration;
    let removedSeconds = 0;

    if (wantTrim || needsEncode) {
      const intervals = wantTrim
        ? computePauseIntervals(raw, {
            maxPause: settings.maxPause,
            padding: settings.padding,
            duration: source.duration
          })
        : [{ start: 0, end: source.duration }];

      if (intervals.length === 0) throw new Error("No speech was found in this recording.");

      const outExt = source.hasVideo ? ".mp4" : (sourceExt === ".mp3" || sourceExt === ".wav" ? sourceExt : ".m4a");
      baseFile = `base${outExt}`;

      const result = await cutMedia({
        inputPath: sourcePath,
        outputPath: jobFile(id, baseFile),
        intervals,
        hasVideo: source.hasVideo,
        onProgress: p => setStep(id, "trim", { progress: p }, { persist: false })
      });

      baseDuration = (await probeMedia(jobFile(id, baseFile))).duration || result.duration;
      if (wantTrim) {
        words = remapWords(raw, intervals);
        removedSeconds = Math.max(0, source.duration - totalDuration(intervals));
      }
    }

    await writeJob(id, "words.json", { words, duration: baseDuration });
    await updateJob(id, j => {
      j.base = { file: baseFile, duration: baseDuration };
      j.stats = { words: words.length, segments: buildSegments(words).length };
    });

    return {
      message: wantTrim
        ? `Removed ${removedSeconds.toFixed(1)}s of silence`
        : "Silence removal is off"
    };
  },

  // 4. Ask the AI which parts are retakes and mark them as cuts.
  async ai(id) {
    const job = getJob(id);
    const { words } = await readJsonFile(jobFile(id, "words.json"));
    const segments = buildSegments(words);
    const hasEdits = await readJsonFile(jobFile(id, "edits.json"), null);

    const skip = async message => {
      if (!hasEdits) await writeJob(id, "edits.json", { ranges: [], updatedAt: Date.now() });
      await writeJob(id, "ai.json", { skipped: true, message, analysis: [], warnings: [], ranges: [] });
      return { skipped: true, message };
    };

    if (!job.settings.useAi) return skip("AI review is turned off for this project.");
    if (!process.env.GROQ_API_KEY) return skip("GROQ_API_KEY is not set, so nothing was marked automatically.");

    const decisions = await reviewWithGroq({
      words,
      segments,
      onProgress: message => setStep(id, "ai", { message }, { persist: false })
    });

    const { mask, warnings, whole, partial } = applyDecisions(words, segments, decisions);
    const ranges = maskToRanges(mask);

    await writeJob(id, "ai.json", {
      model: decisions.model,
      createdAt: Date.now(),
      analysis: decisions.analysis,
      removeIds: decisions.removeIds,
      partials: decisions.partials,
      warnings,
      ranges
    });
    await writeJob(id, "edits.json", { ranges, updatedAt: Date.now() });

    await updateJob(id, j => {
      j.stats = { ...j.stats, aiCuts: ranges.length };
      j.export = { ...j.export, stale: j.export.status === "done" };
    });

    return { message: `${ranges.length} cut${ranges.length === 1 ? "" : "s"} marked (${whole} whole, ${partial} partial)` };
  }
};

// ---------- export ----------

export async function exportJob(id, { pad = 0.05 } = {}) {
  if (busy.has(id)) throw new Error("This project is busy.");
  busy.add(id);

  try {
    const job = getJob(id);
    if (!job?.base) throw new Error("This project has not finished processing.");

    const { words, duration } = await readJsonFile(jobFile(id, "words.json"));
    const edits = await readJsonFile(jobFile(id, "edits.json"), { ranges: [] });
    const mask = rangesToMask(edits.ranges, words.length);
    const intervals = computeKeepIntervals(words, mask, { duration, pad });

    if (intervals.length === 0) throw new Error("Every word is cut, so there is nothing to export.");

    const ext = path.extname(job.base.file);
    const finalFile = `final${ext}`;
    const tmpFile = `final.tmp${ext}`;

    await updateJob(id, j => {
      j.export = { status: "running", progress: 0, stale: false, pad };
    });

    const result = await cutMedia({
      inputPath: jobFile(id, job.base.file),
      outputPath: jobFile(id, tmpFile),
      intervals,
      hasVideo: job.source.hasVideo,
      onProgress: p => updateJob(id, j => { j.export.progress = p; }, { persist: false })
    });

    await fs.rename(jobFile(id, tmpFile), jobFile(id, finalFile));
    const bytes = (await fs.stat(jobFile(id, finalFile))).size;

    await updateJob(id, j => {
      j.export = {
        status: "done",
        progress: 1,
        stale: false,
        pad,
        file: finalFile,
        duration: result.duration,
        bytes,
        cuts: maskToRanges(mask).length,
        finishedAt: Date.now()
      };
    });
  } catch (error) {
    console.error(`[${id}] export failed:`, error.message);
    await updateJob(id, j => {
      j.export = { status: "error", progress: 0, error: error.message, stale: j.export?.stale };
    });
  } finally {
    busy.delete(id);
  }
}

