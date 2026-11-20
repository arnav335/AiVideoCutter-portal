'use strict';
/**
 * The B-roll API, free of any HTTP framework: each function takes the parsed request and returns the JSON answer
 * (or throws HttpError). src/server/broll.js maps URLs onto these.
 */
const path = require('path');
const { loadConfig } = require('./config');
const usage = require('./usage');
const chrome = require('./chrome');
const jobs = require('./jobs');
const { inspectFlow } = require('./flowGen');
const settingsLib = require('./settings');
const { HttpError } = require('./errors');
const secrets = require('./secrets');
const projects = require('./projects');
const ffmpeg = require('./ffmpeg');
const claudeWeb = require('./claudeWeb');
const fs = require('fs');
const cardPrompt = require('./cardPrompt');
const keying = require('./keying');

/* ---------------- Flow image jobs ---------------- */
async function launchJob(body, { prompts, metas = [], projectId = null }) {
  const mock = !!body.mock;
  const cfg = loadConfig();
  if (jobs.runningJobId()) throw new HttpError(409, 'An image job is already running.');
  if (!mock && !(await chrome.isUp(cfg.cdpUrl))) {
    throw new HttpError(400, 'Chrome is not connected. Click "Launch Chrome" and sign into Flow first (or tick Test mode).');
  }
  let settings, decoded;
  try {
    settings = settingsLib.normalize(body.settings, cfg);
    decoded = settingsLib.decodeRefs(body.refs, cfg);
  } catch (e) {
    if (e instanceof settingsLib.SettingsError) throw new HttpError(400, e.message);
    throw e;
  }
  const job = jobs.createJob(prompts, { mock, settings, metas, projectId });
  job.refs = settingsLib.saveRefs(decoded, job.id, path.join(cfg.outputDir, 'jobs', job.id, 'refs'));
  try { jobs.start(job); } catch (e) { throw new HttpError(409, e.message); }
  return job;
}

/* ---------------- global: /api/broll/<sub> ---------------- */
async function global(method, sub, body) {
  const cfg = loadConfig();
  const parts = sub.split('/').filter(Boolean);
  const key = `${method} ${parts[0] || ''}`;

  if (key === 'GET status') {
    return {
      chromeUp: await chrome.isUp(cfg.cdpUrl),
      chromeFound: !!chrome.findChrome(),
      usage: { ...usage.get(cfg), limit: cfg.dailyLimit },
      runningJobId: jobs.runningJobId(),
      flowUrl: cfg.flowUrl
    };
  }

  if (key === 'GET options') {
    return {
      ratios: cfg.ratios, models: cfg.models, defaults: cfg.defaults,
      maxReferenceImages: cfg.maxReferenceImages,
      themes: require('./themes').THEMES, defaultTheme: ((cfg.themes && cfg.themes.default) || require('./themes').DEFAULT_THEME),
      asr: { models: cfg.asr.models, defaultModel: cfg.asr.defaultModel, defaultLanguage: cfg.asr.defaultLanguage },
      llm: { defaultProvider: cfg.llm.defaultProvider, providers: Object.fromEntries(Object.entries(cfg.llm.providers).map(([k, v]) => [k, { label: v.label, model: v.default, web: Boolean(v.web) }])) }
    };
  }

  // The one claude.ai chat that every B-roll step writes into (claude-chat.json).
  if (key === 'GET claude-chat') return claudeWeb.readChat();
  if (key === 'POST claude-chat') {
    try { return claudeWeb.writeChat({ chatUrl: String((body && body.chatUrl) || '').trim() }); } catch (e) { throw new HttpError(400, e.message); }
  }
  if (key === 'POST claude-chat-reset') return claudeWeb.resetChat();
  if (key === 'GET claude-inspect') {
    if (!(await chrome.isUp(cfg.cdpUrl))) throw new HttpError(400, 'Chrome is not connected. Click "Launch Chrome" first.');
    try { return await claudeWeb.inspectClaude(cfg); } catch (e) { throw new HttpError(400, e.message); }
  }

  if (key === 'GET claude-check') {
    try { return await claudeWeb.checkClaude(cfg); } catch (e) { throw new HttpError(400, e.message); }
  }

  if (key === 'GET system') return { ffmpeg: await ffmpeg.isAvailable(), keys: secrets.status() };

  if (key === 'POST secrets') {
    for (const name of secrets.names) if (typeof body[name] === 'string') secrets.set(name, body[name]);
    return { keys: secrets.status() };
  }

  if (key === 'GET chrome-profiles') return chrome.profileState(cfg);

  if (key === 'POST chrome-profile') {
    const all = chrome.listProfiles();
    const dir = String((body && body.dir) || '');
    if (!dir) { chrome.writeChoice(cfg, null); return chrome.profileState(cfg); }
    if (!all.some(p => p.dir === dir)) throw new HttpError(400, 'That Chrome profile was not found.');
    chrome.writeChoice(cfg, { dir });
    return chrome.profileState(cfg);
  }

  if (key === 'POST chrome') {
    if (await chrome.isUp(cfg.cdpUrl)) return { ok: true, already: true };
    try {
      const exe = chrome.launch(cfg, { refresh: Boolean(body && body.refresh), claude: Boolean(body && body.claude) });
      return { ok: true, exe, copy: chrome.launch.lastPrep };
    } catch (e) { throw new HttpError(400, e.message); }
  }

  if (key === 'GET inspect') {
    if (!(await chrome.isUp(cfg.cdpUrl))) throw new HttpError(400, 'Chrome is not connected. Click "Launch Chrome" first.');
    try { return await inspectFlow(cfg); } catch (e) { throw new HttpError(400, e.message); }
  }

  if (key === 'POST usage') {
    usage.set(cfg, Number(body.count) || 0);
    return { usage: { ...usage.get(cfg), limit: cfg.dailyLimit } };
  }

  // /api/broll/flow/:jobId/(stop|resume|select)
  if (parts[0] === 'flow' && method === 'POST' && parts.length === 3) {
    const [, jobId, action] = parts;
    const job = jobs.get(jobId);
    if (!job) throw new HttpError(404, 'Image job not found');
    let result;
    if (action === 'stop') { jobs.stop(jobId); result = { ok: true }; }
    else if (action === 'resume') {
      try { result = jobs.resume(jobId); } catch (e) { throw new HttpError(409, e.message); }
    } else if (action === 'select') {
      try { result = jobs.select(jobId, Number(body.index), body.file === null ? null : String(body.file)); }
      catch (e) { throw new HttpError(400, e.message); }
    } else throw new HttpError(404, 'Unknown endpoint');
    if (job.projectId && action === 'select') projects.touchExport(job.projectId);
    return result;
  }

  throw new HttpError(404, 'Unknown endpoint');
}

/* ---------------- one project: /api/jobs/:id/broll/<sub> ---------------- */
async function forJob(id, method, sub, body) {
  const parts = sub.split('/').filter(Boolean);
  const key = `${method} ${parts[0] || ''}`;

  // What the current cuts mean for each B-roll is added to every answer (see projects.view).
  const keep = await projects.keepIntervals(id);
  const V = p => projects.view(p, keep);

  if (key === 'GET ') return V(projects.ensure(id));
  if (key === 'POST plan') return V(await projects.startPlan(id));
  if (key === 'POST regenerate') return V(await projects.regenerateBroll(id, parts[1]));
  if (key === 'POST card-idea') return V(await projects.newCardIdea(id, parts[1], body));
  if (key === 'POST save-logo') return V(projects.saveAsLogo(id, parts[1]));
  if (key === 'POST person-animated') return V(projects.personToAnimated(id, parts[1]));
  if (key === 'POST person-photo') return V(projects.personToPhoto(id, parts[1]));
  if (key === 'POST prompts') return V(projects.startPrompts(id, body, keep));
  if (key === 'POST tidy') return V(await projects.tidyBrolls(id));
  if (key === 'POST group') return V(await projects.groupBrolls(id, body.ids));
  if (key === 'POST ungroup') return V(projects.ungroupBroll(id, parts[1]));
  if (key === 'POST save') return V(await projects.saveBrolls(id, body.brolls, body.globalPos, body.globalRound));
  // Backfill: the transparent copies of a job made before Ultra Key existed (or after the settings changed).
  if (key === 'POST key') return V(await projects.keyImages(id));
  if (key === 'POST options') return V(projects.saveOptions(id, body));
  if (key === 'POST render') return V(await projects.startRender(id, body));
  if (key === 'POST premiere') return V(await projects.startPremiere(id, body));
  if (key === 'POST open-folder') return projects.openRenderFolder(id, body.which);

  if (key === 'POST images') {
    const p = projects.ensure(id);
    const items = projects.imageItems(p, keep);
    // Scenes and animated people need their Tatami style images. Never trust the paths saved with the prompts (they can be
    // stale: written before the images existed, or on another path): rebuild them from the card's palette and the CURRENT folder.
    for (const b of items) {
      if (!(b.refs && b.refs.length)) continue;
      const fresh = cardPrompt.refsFor(b.card && b.card.palette);
      b.refs = fresh.every(f => fs.existsSync(f)) ? fresh : cardPrompt.healRefs(b.refs, b.card && b.card.palette);
    }
    if (!body.mock) {
      const bad = items.flatMap(b => b.refs || []).find(f => !fs.existsSync(f));
      if (bad) {
        let found = [];
        try { found = fs.readdirSync(cardPrompt.STYLE_DIR); } catch { /* folder missing */ }
        throw new HttpError(400, `Style reference images are missing in assets/style/tatami/. Put at least one tatami-<palette>.jpg file there (see the README in that folder). Looked in: ${cardPrompt.STYLE_DIR} (found: ${found.length ? found.join(', ') : 'nothing'}); needed: ${path.basename(bad)}.`);
      }
    }
    // The same logo used twice in one video is made once: later items copy the first one.
    const cfg = loadConfig();
    const firstLogo = new Map();
    const metas = items.map((b, i) => {
      const m = { brollId: b.id };
      if (b.refs && b.refs.length) m.refs = b.refs;
      if (b.source === 'file') { m.source = 'file'; m.file = b.file; }
      else if (b.logoSlug) { if (firstLogo.has(b.logoSlug)) m.dupOf = firstLogo.get(b.logoSlug); else firstLogo.set(b.logoSlug, i); m.logoSlug = b.logoSlug; }
      if (b.card && b.card.mode === 'person') m.person = b.card.render;
      // Green card pictures get a transparent (Ultra Key) copy. Always made, so the switch can be turned on later.
      if (keying.isKeyable(b.mode, cfg)) m.key = true;
      return m;
    });
    const job = await launchJob(body, { prompts: items.map(b => b.prompt), metas, projectId: p.id });
    projects.attachJob(p, job.id);
    return V(p);
  }

  throw new HttpError(404, 'Unknown endpoint');
}

module.exports = { global, forJob, loadConfig };
