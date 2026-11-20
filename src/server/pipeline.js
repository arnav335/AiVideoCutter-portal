import fs from "node:fs/promises";
import path from "node:path";

import {
  STEP_NAMES, jobFile, readJsonFile, updateJob, writeJob, getJob
} from "./jobs.js";

import { convertToWav } from "../utils/convertToWav.js";
import { probeMedia } from "../utils/ffmpeg.js";
import { cutMedia } from "../utils/cutMedia.js";
import { prepareCaptions } from "./captionRender.js";
import { brollOnTranscriptChanged, brollOverlays, brollAutoRun } from "./broll.js";
import { sanitizeCaptions } from "../shared/captions.js";
import { transcribeAudio, wordsToSentenceSrt, wordsToWordSrt } from "../functions/transcribe.js";
import { reviewWithGroq } from "../functions/groqReview.js";
import { reviewWithClaude } from "../functions/claudeReview.js";
import {
  buildSegments, computeKeepIntervals, computePauseIntervals, applyDecisions,
  maskToRanges, rangesToMask, remapWords, totalDuration
} from "../shared/editModel.js";

const busy = new Set();
export const isBusy = id => busy.has(id);

// ---------- cancel / skip ----------
// Steps that can be abandoned while they run (network / AI work). The others (audio, transcription, silence
// removal) are single uninterruptible jobs, so "stop" there takes effect as soon as that step finishes.
const SKIPPABLE = new Set(["ai", "srt", "broll"]);
const controls = new Map();   // id -> { cancelled, skipped, skippable, skipNow }

function makeControl() {
  const ctl = { cancelled: false, skipped: false, skippable: false, skipNow: null };
  ctl.skipPromise = () => new Promise(resolve => { ctl.skipNow = resolve; });
  return ctl;
}

// "Skip this step": abandon the running step (ai / srt / broll) and carry on with the next one.
export function skipStep(id) {
  const ctl = controls.get(id);
  if (!ctl?.skippable || !ctl.skipNow) return false;
  ctl.skipped = true;
  ctl.skipNow();
  return true;
}

// "Stop": abandon the running step if it can be, and skip every step after it.
export function cancelPipeline(id) {
  const ctl = controls.get(id);
  if (!ctl) return { stopping: false };
  ctl.cancelled = true;
  if (ctl.skippable) skipStep(id);
  return { stopping: true, immediate: ctl.skippable };
}

// The words that stay in the video, with times on the cut timeline. Subtitles and transcript both come from this,
// so they always match the cuts that are saved right now.
async function keptWords(id) {
  const job = getJob(id);
  const data = await readJsonFile(jobFile(id, "words.json"), null);
  if (!job?.base || !data) throw new Error("This project has not been transcribed yet.");
  const edits = await readJsonFile(jobFile(id, "edits.json"), { ranges: [] });
  const mask = rangesToMask(edits.ranges, data.words.length);
  const intervals = computeKeepIntervals(data.words, mask, { duration: data.duration, pad: job.export?.pad ?? 0.05 });
  const kept = remapWords(data.words.filter((_, i) => !mask[i]), intervals);
  if (!kept.length) throw new Error("Every word is cut, so there is nothing left to write.");
  return kept;
}

// The subtitles of the video as it will be exported: cut words are left out, times are on the cut timeline.
export async function buildSrt(id, kind = "sentence") {
  const kept = await keptWords(id);
  return kind === "word" ? wordsToWordSrt(kept) : wordsToSentenceSrt(kept);
}

// Plain-text transcript of what is left after the cuts: one sentence per line.
export async function buildTranscript(id) {
  const kept = await keptWords(id);
  const lines = [];
  let cur = [];
  for (const w of kept) {
    cur.push(w.t);
    if (/[.!?…]["'”’)\]]*$/.test(w.t)) { lines.push(cur.join(" ")); cur = []; }
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines.join("\n") + "\n";
}

// Rewrites the saved subtitles.srt and transcript.txt from the current cuts, so no old copy is ever left behind.
export async function refreshTextFiles(id) {
  const srtFile = jobFile(id, "subtitles.srt");
  const txtFile = jobFile(id, "transcript.txt");
  try {
    await fs.writeFile(srtFile, await buildSrt(id, "sentence"), "utf8");
    await fs.writeFile(txtFile, await buildTranscript(id), "utf8");
  } catch {
    // Nothing left (everything cut) or not transcribed yet: remove the old copies instead of leaving outdated ones.
    await fs.rm(srtFile, { force: true }).catch(() => {});
    await fs.rm(txtFile, { force: true }).catch(() => {});
  }
  await fs.rm(jobFile(id, "subtitles-words.srt"), { force: true }).catch(() => {});
}

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
      // The B-roll plan was made for the old words and cuts.
      try { brollOnTranscriptChanged(id); } catch (error) { console.error(`[${id}] could not reset B-roll:`, error.message); }
    }

    await updateJob(id, job => {
      job.state = "running";
      job.error = null;
      STEP_NAMES.forEach((name, i) => {
        if (i >= startIndex) job.steps[name] = { status: "pending", message: "", progress: null };
      });
    });

    const ctl = makeControl();
    controls.set(id, ctl);
    let stoppedAt = null;

    for (const name of STEP_NAMES.slice(startIndex)) {
      current = name;
      if (ctl.cancelled) {
        await setStep(id, name, { status: "skipped", message: "Stopped by you.", progress: null });
        stoppedAt = stoppedAt || name;
        continue;
      }
      ctl.skipped = false;
      ctl.skippable = SKIPPABLE.has(name);
      await setStep(id, name, { status: "running", message: "", progress: null, startedAt: Date.now() });

      const work = STEPS[name](id, ctl);
      let result;
      if (ctl.skippable) {
        work.catch(() => {});   // abandoned work must not crash the server when it fails later
        result = await Promise.race([work, ctl.skipPromise().then(() => ({ skipped: true, message: "Skipped by you." }))]);
      } else {
        result = await work;
      }
      ctl.skippable = false; ctl.skipNow = null;

      await setStep(id, name, {
        status: result?.skipped ? "skipped" : "done",
        message: result?.message || "",
        progress: null,
        endedAt: Date.now()
      });
    }

    // A skipped / stopped AI step must still leave a valid (empty) set of cuts behind.
    const words = await readJsonFile(jobFile(id, "words.json"), null);
    if (words && !(await readJsonFile(jobFile(id, "edits.json"), null))) {
      await writeJob(id, "edits.json", { ranges: [], updatedAt: Date.now() });
    }

    if (ctl.cancelled && !getJob(id).base) {
      // Stopped before there was anything to edit: show the retry button on the step it stopped at.
      await updateJob(id, job => {
        job.state = "error";
        job.error = { step: stoppedAt || current, message: "Stopped by you. Press Try again to continue from here." };
      });
    } else {
      await updateJob(id, job => { job.state = "review"; });
    }
  } catch (error) {
    console.error(`[${id}] ${current} failed:`, error.message);
    await updateJob(id, job => {
      job.state = "error";
      job.error = { step: current, message: error.message };
      job.steps[current] = { ...job.steps[current], status: "error", message: error.message, progress: null };
    });
  } finally {
    controls.delete(id);
    busy.delete(id);
  }
}

export const STEPS = {
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
    const model = getJob(id).settings.asrModel === "melia-1" ? "melia-1" : "enhanced";
    const cached = await readJsonFile(cache, null);
    const cachedModel = (await readJsonFile(jobFile(id, "words.raw.model.json"), null))?.model || "enhanced";
    if (cached?.length && cachedModel === model) return { message: `${cached.length} words (reused earlier transcript)` };

    const words = await transcribeAudio({
      inputPath: jobFile(id, "raw.wav"),
      language: getJob(id).settings.language,
      model,
      onStatus: message => setStep(id, "transcribe", { message }, { persist: false })
    });

    await writeJob(id, "raw-words-tmp.json", words);
    await fs.rename(jobFile(id, "raw-words-tmp.json"), cache);
    await writeJob(id, "words.raw.model.json", { model });
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
  async ai(id, ctl) {
    const job = getJob(id);
    const { words } = await readJsonFile(jobFile(id, "words.json"));
    const segments = buildSegments(words);
    const hasEdits = await readJsonFile(jobFile(id, "edits.json"), null);

    const skip = async message => {
      if (!hasEdits) await writeJob(id, "edits.json", { ranges: [], updatedAt: Date.now() });
      await writeJob(id, "ai.json", { skipped: true, message, analysis: [], warnings: [], ranges: [] });
      return { skipped: true, message };
    };

    const useClaude = job.settings.cutAi === "claude";
    if (!job.settings.useAi) return skip("AI review is turned off for this project.");
    if (!useClaude && !process.env.GROQ_API_KEY) return skip("GROQ_API_KEY is not set, so nothing was marked automatically.");

    const review = useClaude ? reviewWithClaude : reviewWithGroq;
    const decisions = await review({
      words,
      segments,
      onProgress: message => setStep(id, "ai", { message }, { persist: false })
    });

    if (ctl?.skipped) return { skipped: true, message: "Skipped by you." };   // finished after the skip: drop the result

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
  },

  // 5. Subtitle file (.srt) for the video as it will be exported. The download link always rebuilds it from the
  // current cuts, so later edits in the editor are included.
  async srt(id, ctl) {
    if (getJob(id).settings.doSrt === false) return { skipped: true, message: "SRT file is turned off." };
    if (!(await readJsonFile(jobFile(id, "edits.json"), null))) await writeJob(id, "edits.json", { ranges: [], updatedAt: Date.now() });
    const text = await buildSrt(id, "sentence");
    if (ctl?.skipped) return { skipped: true, message: "Skipped by you." };
    await refreshTextFiles(id);
    return { message: `${text.split(/\n\n/).length} subtitle lines (download below)` };
  },

  // 6. B-roll: plan the pictures, write the image prompts and, if Chrome is already connected to Flow, generate them.
  async broll(id, ctl) {
    const job = getJob(id);
    if (job.settings.doBroll === false) return { skipped: true, message: "B-roll is turned off." };
    if (!job.source?.hasVideo) return { skipped: true, message: "B-roll is only added to videos, not audio files." };
    if (!(await readJsonFile(jobFile(id, "edits.json"), null))) await writeJob(id, "edits.json", { ranges: [], updatedAt: Date.now() });
    try {
      return await brollAutoRun(id, { isSkipped: () => ctl?.skipped, onStatus: message => setStep(id, "broll", { message }, { persist: false }) });
    } catch (error) {
      // B-roll is an extra: a failure here must not hide the finished transcript and cuts.
      return { skipped: true, message: `B-roll could not be planned: ${error.message}` };
    }
  }
};

// ---------- export ----------

const pickPrev = ex => {
  const { prev, status, progress, error, lastError, ...rest } = ex;
  return { ...rest, status: "done", progress: 1 };
};

async function renameWithRetry(from, to, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to); }
    catch (e) {
      if (i >= tries || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
}

// Deletes every final-*.ext (and temp files) except the one to keep.
async function removeOldRenders(id, keep) {
  const dir = path.dirname(jobFile(id, "x"));
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/^final(-\d+)?(\.tmp)?\.[a-z0-9]+$/i.test(name) || name === keep) continue;
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

export async function exportJob(id, { pad = 0.05, broll = false, brollFit = "cover" } = {}) {
  if (busy.has(id)) throw new Error("This project is busy.");
  busy.add(id);
  let previousFile = null;

  try {
    const job = getJob(id);
    if (!job?.base) throw new Error("This project has not finished processing.");

    const { words, duration } = await readJsonFile(jobFile(id, "words.json"));
    const edits = await readJsonFile(jobFile(id, "edits.json"), { ranges: [] });
    const mask = rangesToMask(edits.ranges, words.length);
    const intervals = computeKeepIntervals(words, mask, { duration, pad });

    if (intervals.length === 0) throw new Error("Every word is cut, so there is nothing to export.");

    const ext = path.extname(job.base.file);
    // Every render gets its own file name. Overwriting final.mp4 failed on re-render because the browser
    // (or the Download) still had the previous file open, which blocks the rename on Windows.
    const stamp = Date.now();
    const finalFile = `final-${stamp}${ext}`;
    const tmpFile = `final-${stamp}.tmp${ext}`;
    previousFile = job.export?.file || null;

    await updateJob(id, j => {
      // Keep the last good render visible while the new one is made.
      j.export = { ...(j.export?.file ? { prev: pickPrev(j.export) } : {}), status: "running", progress: 0, stale: false, pad };
    });

    // Captions are built from the words that are kept, on the same cut list the video uses.
    const captionConfig = sanitizeCaptions(await readJsonFile(jobFile(id, "captions.json"), null));
    let captions = { enabled: false, count: 0 };
    let subtitles = null;

    if (captionConfig.enabled && job.source.hasVideo) {
      const prepared = await prepareCaptions(id, {
        config: captionConfig, words, mask, intervals, videoFile: job.base.file
      });
      if (prepared.subtitles) {
        subtitles = prepared.subtitles;
        captions = { enabled: true, count: prepared.count, font: prepared.font };
      }
    }

    // B-roll: the chosen pictures, moved onto the cut timeline with the same intervals the video is cut by.
    let overlays = [];
    let size = null;
    if (broll && job.source.hasVideo) {
      overlays = brollOverlays(id, intervals);
      if (overlays.length) {
        const info = await probeMedia(jobFile(id, job.base.file));
        if (!info.width || !info.height) throw new Error("Could not read the video size to place the B-roll pictures.");
        size = { width: info.width, height: info.height };
      }
    }

    const result = await cutMedia({
      inputPath: jobFile(id, job.base.file),
      outputPath: jobFile(id, tmpFile),
      intervals,
      hasVideo: job.source.hasVideo,
      subtitles,
      overlays,
      overlayFit: brollFit,
      size,
      onProgress: p => updateJob(id, j => { j.export.progress = p; }, { persist: false })
    });

    await renameWithRetry(jobFile(id, tmpFile), jobFile(id, finalFile));
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
        captions,
        broll: { enabled: broll && Boolean(job.source.hasVideo), count: overlays.length, fit: brollFit },
        finishedAt: Date.now()
      };
    });

    // Old renders are removed afterwards; if one is still open somewhere it is simply left for next time.
    await removeOldRenders(id, finalFile);
  } catch (error) {
    console.error(`[${id}] export failed:`, error.message);
    await updateJob(id, j => {
      const prev = j.export?.prev;
      // A failed render never throws away the last good video: it stays playable and a new render can be started.
      j.export = prev
        ? { ...prev, status: "done", stale: true, lastError: error.message }
        : { status: "error", progress: 0, error: error.message, stale: j.export?.stale };
    });
    await removeOldRenders(id, previousFile).catch(() => {});
  } finally {
    busy.delete(id);
  }
}

