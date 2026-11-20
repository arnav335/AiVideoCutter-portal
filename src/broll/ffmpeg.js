'use strict';
/**
 * ffmpeg helpers. Uses FFMPEG_PATH, then the bundled ffmpeg-static package (if npm installed it), then "ffmpeg" on PATH.
 * Only ffmpeg is needed: media info is read from its banner output, so no ffprobe.
 */
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');


/* ---- Keeping the computer responsive while ffmpeg works ----
 * ffmpeg normally grabs every CPU core at full priority, which freezes the browser / editor / this app.
 * So every heavy ffmpeg run here (1) runs at below-normal priority, (2) is capped to leave a couple of cores free
 * and (3) waits for the previous heavy run instead of competing with it.
 *   FFMPEG_THREADS=N        threads to use (default: cores - 2, at least 1; 0 = let ffmpeg use everything)
 *   FFMPEG_PRIORITY=normal  skip the priority drop (default: below-normal)
 */
function threads() {
  const env = process.env.FFMPEG_THREADS;
  if (env !== undefined && env !== '' && Number.isInteger(Number(env)) && Number(env) >= 0) return Number(env);
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  return cores <= 2 ? 1 : cores - 2;
}
// Global options (graph / filter threads) and per-file options (decoder before -i, encoder before the output).
const filterThreadArgs = () => (threads() ? ['-filter_threads', String(threads()), '-filter_complex_threads', String(threads())] : []);
const fileThreadArgs = () => (threads() ? ['-threads', String(threads())] : []);

// Lowers the priority of a running ffmpeg. On Linux a thread's priority is separate, so every existing thread is
// lowered too (threads started later inherit it); a second pass catches those created during start-up.
function lowerPriority(child) {
  if (!child || !child.pid || /^normal$/i.test(process.env.FFMPEG_PRIORITY || '')) return;
  const level = os.constants.priority.PRIORITY_BELOW_NORMAL;
  const apply = () => {
    try { os.setPriority(child.pid, level); } catch { return; }
    if (process.platform === 'linux') {
      try {
        for (const tid of fs.readdirSync(`/proc/${child.pid}/task`)) { try { os.setPriority(Number(tid), level); } catch { /* gone */ } }
      } catch { /* no /proc */ }
    }
  };
  apply();
  const again = setTimeout(apply, 400);
  child.once('close', () => clearTimeout(again));
}

// Heavy ffmpeg runs go through one queue: two encodes at once just make both (and the computer) slower.
let queueTail = Promise.resolve();
function heavy(task) {
  const result = queueTail.then(() => task());
  queueTail = result.then(() => {}, () => {});
  return result;
}

function bin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { const p = require('ffmpeg-static'); if (p) return p; } catch { /* not installed */ }
  return 'ffmpeg';
}

function exec(args, { low = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin(), args, { windowsHide: true }); } catch (e) { return reject(notFound(e)); }
    if (low) lowerPriority(child);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 400000) stderr = stderr.slice(-200000); });
    child.on('error', e => reject(notFound(e)));
    child.on('close', code => resolve({ code, stderr }));
  });
}

const notFound = e => new Error(
  e && e.code === 'ENOENT'
    ? 'ffmpeg was not found. Run "npm install" (it bundles ffmpeg), install ffmpeg yourself, or set FFMPEG_PATH to the ffmpeg executable.'
    : `Could not start ffmpeg: ${e.message}`
);

// Runs ffmpeg and fails with the useful tail of its output.
async function run(args) {
  const { code, stderr } = await heavy(() => exec(['-hide_banner', '-loglevel', 'error', '-y', ...filterThreadArgs(), ...args], { low: true }));
  if (code !== 0) throw new Error('ffmpeg failed: ' + (stderr.trim().split('\n').slice(-4).join(' | ') || `exit code ${code}`));
}

// For callers that want execFile's behaviour (rejects with error.stderr on a non-zero exit): queued + low priority.
function execHeavy(args, { maxBuffer = 20 * 1024 * 1024 } = {}) {
  return heavy(async () => {
    const { code, stderr } = await exec(['-hide_banner', ...filterThreadArgs(), ...args], { low: true });
    if (code !== 0) { const e = new Error(`ffmpeg exited with code ${code}`); e.stderr = stderr.slice(-maxBuffer); e.code = code; throw e; }
    return { stdout: '', stderr };
  });
}

async function isAvailable() {
  try {
    const { code, stderr } = await exec(['-version']);
    return { ok: code === 0, version: (/ffmpeg version (\S+)/.exec(stderr) || [])[1] || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function probe(file) {
  const { stderr } = await exec(['-hide_banner', '-i', file]);
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const lines = stderr.split('\n');
  const video = lines.find(l => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  const audio = lines.find(l => /Stream #.*Audio:/.test(l));
  if (!video && !audio) throw new Error('This file is not a readable audio or video file.');
  const dims = video ? /,\s*(\d{2,5})x(\d{2,5})[,\s\[]/.exec(video) : null;
  let width = dims ? Number(dims[1]) : null, height = dims ? Number(dims[2]) : null;
  // Phone videos store the picture sideways plus a rotation flag; ffmpeg turns it upright when it re-encodes.
  const rot = /rotat(?:e|ion)\s*(?:of|:)?\s*(-?\d+(?:\.\d+)?)/i.exec(stderr);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasVideo: !!video, hasAudio: !!audio, width, height,
    fps: video && /(\d+(?:\.\d+)?)\s*fps/.exec(video) ? Number(/(\d+(?:\.\d+)?)\s*fps/.exec(video)[1]) : null
  };
}

// 16 kHz mono 16-bit PCM WAV: the format used for every later step.
const toWav = (src, dest) => run(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dest]);

module.exports = { run, exec, execHeavy, heavy, lowerPriority, threads, filterThreadArgs, fileThreadArgs, probe, toWav, isAvailable, bin };
