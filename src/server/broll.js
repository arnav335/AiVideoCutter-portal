import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import brollApi from "../broll/api.js";
import projects from "../broll/projects.js";
import brollConfig from "../broll/config.js";
import secrets from "../broll/secrets.js";
import chromeLib from "../broll/chrome.js";
import brollFfmpeg from "../broll/ffmpeg.js";
import brollTimeline from "../broll/timeline.js";
import { HttpError, sendFile, readJsonBody, sendJson } from "./http.js";
import { getJob, jobDir, jobFile, readJsonFile, updateJob, isValidId } from "./jobs.js";
import { rangesToMask, computeKeepIntervals } from "../shared/editModel.js";

const { loadConfig } = brollConfig;

// The cuts decide which words stay and where the export is cut.
async function readState(id) {
  const data = await readJsonFile(jobFile(id, "words.json"), null);
  if (!data) throw new HttpError(409, "This project has not been transcribed yet.");
  const edits = await readJsonFile(jobFile(id, "edits.json"), { ranges: [] });
  const mask = rangesToMask(edits.ranges, data.words.length);
  return { words: data.words, duration: data.duration, mask };
}

// The rest of the portal reads its API keys straight from process.env. The B-roll module can also keep
// keys in secrets.json (the "API keys" window), so both are copied into process.env: a key typed in
// that window then works for the retake review and transcription too, with no restart.
function syncKeysToEnv() {
  for (const name of secrets.names) {
    const envName = secrets.envVarOf(name);
    const key = secrets.get(name);
    if (key && process.env[envName] !== key) process.env[envName] = key;
  }
}

// Groq is the default for every AI task (retake review, B-roll planning, prompts). Gemini is only used when it is
// picked in the B-roll tab, or when there is no Groq key at all.
function defaultProvider() {
  if (secrets.get("groq")) return "groq";
  if (secrets.get("gemini")) return "gemini";
  return loadConfig().llm.defaultProvider;
}

export function setupBroll() {
  syncKeysToEnv();

  projects.configure({
    dir: id => path.join(jobDir(id), "broll"),
    exists: id => isValidId(id) && Boolean(getJob(id)),
    defaultProvider,

    // The words that stay in the video, on the review timeline, in the shape the planner reads.
    async readCues(id) {
      const { words, duration, mask } = await readState(id);
      const cues = [];
      words.forEach((w, i) => {
        if (!mask[i]) cues.push({ index: cues.length + 1, start: w.s, end: w.e, text: w.t });
      });
      return { cues, duration };
    },

    // The stretches the export keeps (same as the export itself uses).
    async timeline(id) {
      const { words, duration, mask } = await readState(id);
      const pad = getJob(id)?.export?.pad ?? 0.05;
      const intervals = computeKeepIntervals(words, mask, { duration, pad });
      return { intervals, duration: intervals.reduce((s, iv) => s + (iv.end - iv.start), 0) };
    },

    // Size and frame rate of the video the pictures are laid on.
    async videoInfo(id) {
      const job = getJob(id);
      const file = job?.base ? jobFile(id, job.base.file) : null;
      if (!file) return {};
      const i = await brollFfmpeg.probe(file);
      return { width: i.width, height: i.height, fps: i.fps };
    },
    name: id => getJob(id)?.name || "Project",

    // B-roll changes make an existing export out of date.
    touch(id) {
      const job = getJob(id);
      if (job?.export?.status === "done" && !job.export.stale) {
        updateJob(id, j => { j.export.stale = true; }).catch(() => {});
      }
    }
  });
}

// Pipeline step "B-roll": plan -> prompts -> (pictures, only if Chrome is already connected to Flow).
// Returns { message } like any pipeline step; throws on a hard failure (the pipeline shows it on that step).
export async function brollAutoRun(id, { isSkipped = () => false, onStatus = () => {} } = {}) {
  const useClaude = getJob(id)?.settings?.brollAi === "claude";
  if (useClaude) {
    // Claude needs no key: it uses claude.ai in the signed-in Chrome. Without Chrome the step is skipped, never failed.
    const up = await chromeLib.isUp(loadConfig().cdpUrl).catch(() => false);
    if (!up) return { skipped: true, message: "Launch Chrome (B-roll tab), sign in to claude.ai once, then press Plan B-roll." };
    await wrap(() => brollApi.forJob(id, "POST", "options", { provider: "claude" }));
  } else if (!secrets.get("groq") && !secrets.get("gemini")) {
    return { skipped: true, message: "No GROQ_API_KEY or GEMINI_API_KEY, so B-roll was not planned." };
  }
  const waitFor = async step => {
    for (;;) {
      if (isSkipped()) return null;
      const s = projects.ensure(id).steps[step];
      if (s.status !== "running") return s;
      await new Promise(r => setTimeout(r, 800));
    }
  };
  const run = async (step, label) => {
    onStatus(label);
    await wrap(() => brollApi.forJob(id, "POST", step, {}));
    const s = await waitFor(step);
    if (s && s.status === "failed") throw new Error(`B-roll ${step} failed: ${s.error}`);
    return s;
  };

  await run("plan", "Planning where B-roll goes…");
  if (isSkipped()) return { skipped: true, message: "Skipped by you." };
  await run("prompts", "Writing the picture prompts…");
  if (isSkipped()) return { skipped: true, message: "Skipped by you." };

  const count = projects.ensure(id).brolls.filter(b => b.enabled).length;
  const cfg = loadConfig();
  const chromeUp = await chromeLib.isUp(cfg.cdpUrl).catch(() => false);
  if (!chromeUp) {
    return { message: `${count} B-roll moments planned with prompts. To make the pictures: B-roll tab → Launch Chrome → Generate.` };
  }
  onStatus("Generating pictures in Flow…");
  try {
    await wrap(() => brollApi.forJob(id, "POST", "images", {}));
    return { message: `${count} B-roll moments planned; pictures are being generated in Flow (see the B-roll tab).` };
  } catch (e) {
    return { message: `${count} B-roll moments planned. Pictures not started: ${e.message}` };
  }
}

// Hooks the rest of the portal calls.
export const brollOnProjectDeleted = id => projects.remove(id);

// New words make the old plan meaningless. Projects that never used B-roll are left untouched.
export function brollOnTranscriptChanged(id) {
  if (!fs.existsSync(path.join(jobDir(id), "broll", "project.json"))) return;
  projects.reset(id);
}

// The chosen pictures as ffmpeg overlays on the EXPORTED timeline.
// `intervals` must be the exact kept stretches the export is built from.
// Pictures that lie entirely in cut-out parts vanish (less than 0.1 s left).
export function brollOverlays(id, intervals) {
  const out = [];
  for (const pick of projects.chosen(id)) {
    const { start, end } = brollTimeline.mapSpan(intervals, pick.start, pick.end);
    if (end - start < 0.1) continue;
    out.push({ id: pick.id, file: pick.imagePath, start, end, pos: pick.pos || null, round: pick.round || 0, alpha: Boolean(pick.keyed) });
  }
  return out;
}

// B-roll can drive the person's logged-in Chrome, so only the local machine may talk to it. Checking the
// Host header also stops a web page from reaching it through DNS rebinding.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const hostnameOf = value => {
  try { return new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname.toLowerCase(); } catch { return ""; }
};

function assertLocal(req) {
  const host = hostnameOf(String(req.headers.host || ""));
  const origin = req.headers.origin;
  const bad = !LOCAL_HOSTS.has(host)
    || (origin && origin !== "null" && !LOCAL_HOSTS.has(hostnameOf(origin)))
    || req.headers["sec-fetch-site"] === "cross-site";
  if (bad) throw new HttpError(403, "B-roll only works when the portal is opened as localhost or 127.0.0.1, because it can control your Chrome.");
}

// Turns B-roll errors into the portal's own HttpError.
async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.status) throw new HttpError(error.status, error.message);
    throw error;
  }
}

const BODY_LIMIT = 60 * 1024 * 1024; // reference images arrive as data URLs

// /api/broll/...   (Chrome, usage, keys, image jobs)
export async function handleBrollGlobal(req, res, url, parts) {
  assertLocal(req);
  const body = req.method === "POST" ? await readJsonBody(req, BODY_LIMIT) : {};
  const sub = parts.slice(1).join("/");
  const result = await wrap(() => brollApi.global(req.method, sub, body));
  if (sub === "secrets") syncKeysToEnv();
  return sendJson(res, 200, result);
}

// /api/jobs/:id/broll/...   (plan, prompts, images, clips of one project)
export async function handleBrollJob(req, res, url, parts) {
  assertLocal(req);
  const id = parts[1];
  const sub = parts.slice(3);

  // Rendered clips and timeline files.
  if (sub[0] === "files" && (req.method === "GET" || req.method === "HEAD")) {
    const rel = path.normalize(sub.slice(1).join("/"));
    const base = path.join(jobDir(id), "broll");
    const full = path.join(base, rel);
    if (!full.startsWith(base + path.sep)) throw new HttpError(403, "Forbidden.");
    await fsp.access(full).catch(() => { throw new HttpError(404, "File not found."); });
    return sendFile(req, res, full);
  }

  const body = req.method === "POST" ? await readJsonBody(req, BODY_LIMIT) : {};
  return sendJson(res, 200, await wrap(() => brollApi.forJob(id, req.method, sub.join("/"), body)));
}

// /output/...  (pictures generated by Flow)
export async function handleOutput(req, res, url) {
  assertLocal(req);
  const base = loadConfig().outputDir;
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice("/output/".length)); } catch { throw new HttpError(400, "Bad path."); }
  const full = path.join(base, path.normalize(rel));
  if (rel.includes("\0") || !full.startsWith(base + path.sep)) throw new HttpError(403, "Forbidden.");
  await fsp.access(full).catch(() => { throw new HttpError(404, "File not found."); });
  return sendFile(req, res, full);
}
