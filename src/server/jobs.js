import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || "workspace");

const jobs = new Map();       // id -> job (in-memory copy, written to job.json)
const listeners = new Map();  // id -> Set<http.ServerResponse>
const lastBroadcast = new Map();

export const STEP_NAMES = ["audio", "transcribe", "trim", "ai"];

export const DEFAULT_SETTINGS = {
  trimPauses: true,
  maxPause: 0.6,
  padding: 0.08,
  language: "en",
  useAi: true
};

export const isValidId = id => /^[a-f0-9]{12}$/.test(id || "");
export const jobDir = id => path.join(WORKSPACE, id);
export const jobFile = (id, name) => path.join(jobDir(id), name);

function emptySteps() {
  const steps = {};
  for (const name of STEP_NAMES) steps[name] = { status: "pending", message: "", progress: null };
  return steps;
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export async function readJsonFile(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export const writeJob = (id, name, data) => writeJsonAtomic(jobFile(id, name), data);

export async function initStore() {
  await fs.mkdir(WORKSPACE, { recursive: true });
  const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const job = await readJsonFile(jobFile(entry.name, "job.json"), null).catch(() => null);
    if (!job) continue;

    // A restart kills any pipeline that was running.
    if (job.state === "running") {
      job.state = "error";
      job.error = { step: null, message: "The server restarted while this project was processing. Retry to continue." };
      for (const step of Object.values(job.steps)) {
        if (step.status === "running") { step.status = "error"; step.message = "Interrupted."; }
      }
    }
    if (job.export?.status === "running") {
      job.export = { ...job.export, status: "error", error: "The server restarted during export." };
    }
    jobs.set(job.id, job);
  }
}

export async function createJob({ name, settings }) {
  const id = crypto.randomBytes(6).toString("hex");
  await fs.mkdir(jobDir(id), { recursive: true });

  const now = new Date().toISOString();
  const job = {
    id,
    name: (name || "Untitled project").slice(0, 120),
    createdAt: now,
    updatedAt: now,
    state: "created",
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    source: null,
    base: null,
    steps: emptySteps(),
    error: null,
    stats: null,
    export: { status: "idle", progress: 0, stale: false }
  };

  jobs.set(id, job);
  await writeJob(id, "job.json", job);
  return job;
}

export const getJob = id => jobs.get(id) || null;

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Change a job, save it and tell every open browser tab.
// Frequent progress updates pass { persist: false } and are throttled.
export async function updateJob(id, mutate, { persist = true } = {}) {
  const job = jobs.get(id);
  if (!job) throw new Error("Project not found.");

  mutate(job);
  job.updatedAt = new Date().toISOString();

  if (persist) await writeJob(id, "job.json", job);
  broadcast(id, { persist });
  return job;
}

function broadcast(id, { persist }) {
  const set = listeners.get(id);
  if (!set || set.size === 0) return;

  const now = Date.now();
  if (!persist && now - (lastBroadcast.get(id) || 0) < 200) return;
  lastBroadcast.set(id, now);

  const payload = `data: ${JSON.stringify(jobs.get(id))}\n\n`;
  for (const res of set) res.write(payload);
}

export function subscribe(id, res) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(res);

  res.write(`data: ${JSON.stringify(jobs.get(id))}\n\n`);

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(keepAlive);
    listeners.get(id)?.delete(res);
  });
}

export async function deleteJob(id) {
  jobs.delete(id);
  listeners.delete(id);
  await fs.rm(jobDir(id), { recursive: true, force: true });
}
