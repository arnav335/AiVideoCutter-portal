'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const usage = require('./usage');
const { runFlow } = require('./flowGen');
const { runMock } = require('./mockGen');
const { logoToFrame } = require('./logos');
const keying = require('./keying');

const jobs = new Map();
let runningId = null;
const stops = new Set();

const pad = (n, w = 3) => String(n).padStart(w, '0');
const jobDir = (cfg, id) => path.join(cfg.outputDir, 'jobs', id);

function persist(job) {
  const cfg = loadConfig();
  const dir = jobDir(cfg, job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2));
}

// Restore jobs from disk so results (and "resume") survive a restart.
function loadAll() {
  const cfg = loadConfig();
  const root = path.join(cfg.outputDir, 'jobs');
  if (!fs.existsSync(root)) return;
  for (const id of fs.readdirSync(root)) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(root, id, 'job.json'), 'utf8'));
      if (job.status === 'running') job.status = 'stopped';
      for (const it of job.items) if (it.status === 'running') it.status = 'pending';
      jobs.set(job.id, job);
    } catch { /* skip unreadable job */ }
  }
}

function createJob(prompts, { mock = false, settings = null, refs = [], metas = [], projectId = null } = {}) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    mock: !!mock,
    settings: settings || { ratio: '16:9', model: 'Nano Banana 2.1', count: 2 },
    refs,
    projectId,
    error: null,
    items: prompts.map((prompt, index) => ({ index, prompt, ...(metas[index] || {}), status: 'pending', images: [], selected: null, error: null })),
    log: []
  };
  jobs.set(id, job);
  persist(job);
  return job;
}

function start(job) {
  if (runningId) throw new Error('A job is already running. Stop it or wait for it to finish.');
  const cfg = loadConfig();
  runningId = job.id;
  job.status = 'running';
  job.error = null;
  stops.delete(job.id);
  const imgDir = path.join(jobDir(cfg, job.id), 'images');
  const refDir = path.join(jobDir(cfg, job.id), 'refs');
  if (!job.settings) job.settings = { ratio: '16:9', model: 'Nano Banana 2.1', count: 2 }; // jobs saved before settings existed
  if (!job.refs) job.refs = [];

  const ctl = {
    isStopped: () => stops.has(job.id),
    save: () => persist(job),
    log: msg => {
      job.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    },
    settings: job.settings,
    refPaths: job.refs.map(r => path.join(refDir, r.file)),
    remaining: () => (job.mock ? Infinity : usage.remaining(cfg)),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    // The same logo used twice in one video is made once: later items copy the first one's picture.
    reuse: item => {
      if (item.dupOf == null) return false;
      const src = job.items[item.dupOf];
      if (!src || src.status !== 'done' || !src.images.length) return false;
      const f = src.selected || src.images[0].file;
      const entry = ctl.saveImage(item, fs.readFileSync(path.join(imgDir, f)), path.extname(f).slice(1) || 'png', { w: src.images[0].w, h: src.images[0].h }, { countUsage: false });
      item.selected = entry.file; item.status = 'done'; item.error = null;
      return true;
    },
    saveImage: (item, buf, ext, meta = {}, opts = {}) => {
      fs.mkdirSync(imgDir, { recursive: true });
      const file = `p${pad(item.index + 1)}_${item.images.length + 1}.${ext}`;
      fs.writeFileSync(path.join(imgDir, file), buf);
      const entry = { file, url: `/output/jobs/${job.id}/images/${file}`, w: meta.w || null, h: meta.h || null };
      item.images.push(entry);
      if (opts.countUsage !== false) usage.add(cfg, 1);
      return entry;
    }
  };

  (async () => {
    try {
      await settleFiles(job, ctl);
      await (job.mock ? runMock : runFlow)(job, cfg, ctl);
      if (stops.has(job.id)) {
        job.status = 'stopped';
      } else if (job.status !== 'limit') {
        const open = job.items.some(i => i.status !== 'done');
        job.status = !open ? 'done' : job.items.some(i => i.status === 'failed') ? 'partial' : 'stopped';
      }
      ctl.log(`Job finished: ${job.status}`);
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      ctl.log('ERROR: ' + e.message);
      for (const it of job.items) if (it.status === 'running') it.status = 'pending';
    } finally {
      runningId = null;
      await keyJobImages(job).catch(() => {});   // green cards get their transparent copy; a failure never fails the job
      persist(job);
    }
  })();
}

// Makes the transparent (Ultra Key) copy of every picture of the items marked `key`, and records its url on the image.
// A picture whose key fails simply has no keyedUrl, so everything keeps using its original.
async function keyJobImages(idOrJob) {
  const job = typeof idOrJob === 'string' ? get(idOrJob) : idOrJob;
  if (!job) throw new Error('Job not found');
  const cfg = loadConfig();
  const dir = path.join(jobDir(cfg, job.id), 'images');
  let changed = false;
  for (const item of job.items) {
    if (item.key !== true) continue;
    for (const im of item.images || []) {
      const before = im.keyedUrl;
      try {
        const out = await keying.ensureKeyed(path.join(dir, im.file), cfg);
        im.keyedUrl = `/output/jobs/${job.id}/keyed/${path.basename(out)}`;
      } catch { delete im.keyedUrl; }
      if (im.keyedUrl !== before) changed = true;
    }
  }
  if (changed) persist(job);
  return job;
}
// Items that come from the user's own logo file need no generation: place the file on the frame, pick it, mark the item done.
async function settleFiles(job, ctl) {
  for (const item of job.items) {
    if (item.source !== 'file' || item.status === 'done') continue;
    try {
      const { buf, ext, w, h } = await logoToFrame(item.file, (job.settings && job.settings.ratio) || '16:9');
      item.images = []; item.selected = null; item.error = null;
      const entry = ctl.saveImage(item, buf, ext, { w, h }, { countUsage: false });
      item.selected = entry.file; item.status = 'done';
      ctl.log(`Prompt ${item.index + 1}/${job.items.length}: used your own logo file (${path.basename(item.file)}), nothing generated.`);
    } catch (e) {
      item.status = 'failed'; item.error = `Could not use the logo file: ${e.message}`;
      ctl.log(`  ${item.error}`);
    }
    ctl.save();
  }
}

function resume(id) {
  const job = get(id);
  if (!job) throw new Error('Job not found');
  for (const it of job.items) if (it.status === 'failed') { it.status = 'pending'; it.error = null; delete it.needsAttention; delete it.attention; }
  start(job);
  return job;
}

function stop(id) {
  if (!jobs.has(id)) throw new Error('Job not found');
  if (runningId === id) stops.add(id);
}

const get = id => jobs.get(id) || null;
const list = () => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const runningJobId = () => runningId;

function select(id, index, file) {
  const job = get(id);
  const item = job && job.items[index];
  if (!item) throw new Error('Prompt not found');
  if (file !== null && !item.images.some(i => i.file === file)) throw new Error('Image not found');
  item.selected = file;
  persist(job);
  return job;
}

// Copies the picked image for each prompt to selected/001.png, 002.png, ... plus a manifest.
function exportSelected(id) {
  const job = get(id);
  if (!job) throw new Error('Job not found');
  const cfg = loadConfig();
  const picked = job.items.filter(i => i.selected);
  if (!picked.length) throw new Error('Select at least one image first.');
  const dir = path.join(jobDir(cfg, id), 'selected');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = picked.map(i => {
    const name = `${pad(i.index + 1)}${path.extname(i.selected)}`;
    fs.copyFileSync(path.join(jobDir(cfg, id), 'images', i.selected), path.join(dir, name));
    return { index: i.index + 1, prompt: i.prompt, file: name, url: `/output/jobs/${id}/selected/${name}` };
  });
  fs.writeFileSync(path.join(dir, 'selected.json'), JSON.stringify(manifest, null, 2));
  return { dir: path.resolve(dir), manifest };
}

loadAll();

// Deletes the image jobs (and their pictures) that belong to one project.
function removeByProject(projectId) {
  for (const j of [...jobs.values()]) {
    if (j.projectId !== projectId || runningId === j.id) continue;
    jobs.delete(j.id);
    fs.rmSync(jobDir(loadConfig(), j.id), { recursive: true, force: true });
  }
}

// Changes one job and saves it (used when a picture is redone after the job was made).
function update(id, fn) { const job = get(id); if (!job) throw new Error('Job not found'); fn(job); persist(job); return job; }

module.exports = { keyJobImages, update, removeByProject, createJob, start, resume, stop, get, list, select, exportSelected, runningJobId };
