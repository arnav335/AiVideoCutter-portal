'use strict';
/**
 * B-roll data for one editor project (the project id is the editor's project id):
 *   the edited transcript (kept words only) -> AI plans B-roll moments -> AI writes image prompts
 *   -> Flow generates images (jobs.js) -> you pick the best -> they become overlays in the exported video
 *      and/or separate gap-free clips (render.js).
 * Times in the plan are on the REVIEW timeline (the original recording), like the transcript and the cuts.
 * They are mapped onto the exported timeline (cut time removed) when exporting.
 *
 * Stored in <workspace>/<id>/broll/project.json, so deleting the editor project deletes its B-roll too.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const rounding = require('./rounding');
const keying = require('./keying');
const { HttpError } = require('./errors');
const secrets = require('./secrets');
const llmLib = require('./llm');
const planner = require('./planner');
const renderLib = require('./render');
const themes = require('./themes');
const cardAi = require('./cardAi');
const cardSpec = require('./cardSpec');
const cardPrompt = require('./cardPrompt');
const claudeWeb = require('./claudeWeb');
const { makeClaudeWeb } = claudeWeb;
const logosLib = require('./logos');
const jobs = require('./jobs');
const { mapSpan, totalKept, keptWithin, snapToKept } = require('./timeline');

const STEPS = ['plan', 'prompts', 'render', 'premiere'];
const premiereLib = require('./premiere');
const projects = new Map();
const timers = new Map();

/**
 * The editor plugs itself in here (see src/server/broll.js):
 *   dir(id)            folder for this project's B-roll files
 *   exists(id)         does the editor project exist?
 *   readCues(id)       -> { cues: [{index,start,end,text}] of the words that are NOT cut, duration }
 *   timeline(id)       -> { intervals, duration }  the kept stretches the export is made from
 *   defaultProvider(id) -> 'gemini' | 'groq'
 *   touch(id)          called when something that changes the exported video was edited
 */
let host = null;
const configure = h => { host = h; };
const need_host = () => { if (!host) throw new Error('B-roll is not configured.'); return host; };

const file = (p, name) => path.join(need_host().dir(p.id), name);
const urlOf = (p, name) => `/api/jobs/${p.id}/broll/files/${name}`;
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
const touch = id => { try { need_host().touch && need_host().touch(id); } catch { /* ignore */ } };

function persist(p) {
  if (!projects.has(p.id) || !need_host().exists(p.id)) return;
  p.updatedAt = new Date().toISOString();
  const dir = need_host().dir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `project.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, path.join(dir, 'project.json'));
}

function persistSoon(p) {
  if (timers.has(p.id)) return;
  timers.set(p.id, setTimeout(() => { timers.delete(p.id); persist(p); }, 600));
}

// Theme of a project that has none stored: new projects get the config default (card), old ones stay on `free`.
const themeDefaults = () => { const t = (loadConfig().themes) || {}; return { fresh: themes.normalizeTheme(t.default, themes.DEFAULT_THEME), legacy: themes.normalizeTheme(t.legacy, themes.LEGACY_THEME) }; };

function defaultOptions(id) {
  return {
    provider: need_host().defaultProvider(id),
    theme: themeDefaults().fresh,
    prompts: { common: '', suffix: '' },
    render: { outputDir: '' }
  };
}

function blank(id) {
  const options = defaultOptions(id);
  if (themes.usesCards(options.theme)) options.prompts.suffix = cardPrompt.DEFAULT_SUFFIX;   // the user can edit it
  return {
    id, createdAt: new Date().toISOString(), updatedAt: null,
    steps: Object.fromEntries(STEPS.map(s => [s, { status: 'idle' }])),
    options, brolls: [], flowJobId: null, log: []
  };
}

// Loads (or creates) the B-roll project of an editor project.
function ensure(id) {
  if (projects.has(id)) return projects.get(id);
  if (!need_host().exists(id)) throw new HttpError(404, 'Project not found');
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(need_host().dir(id), 'project.json'), 'utf8')); } catch { p = null; }
  const fromDisk = Boolean(p);
  if (!p) p = blank(id);
  const d = defaultOptions(id);
  const storedTheme = p.options && p.options.theme;
  p.options = { ...d, ...(p.options || {}) };
  // A project saved before themes existed keeps the behaviour it always had.
  p.options.theme = themes.isTheme(storedTheme) ? storedTheme : (fromDisk ? themeDefaults().legacy : d.theme);
  p.options.prompts = { ...d.prompts, ...(p.options.prompts || {}) };
  p.options.render = { outputDir: String((p.options.render && p.options.render.outputDir) || '') };
  p.log = p.log || []; p.brolls = p.brolls || [];
  for (const b of p.brolls) delete b.meaning;
  for (const s of STEPS) {
    p.steps[s] = p.steps[s] || { status: 'idle' };
    if (p.steps[s].status === 'running') { p.steps[s].status = 'failed'; p.steps[s].error = 'Interrupted (the app was restarted). Run it again.'; }
  }
  projects.set(id, p);
  return p;
}

/* ---------- cuts ---------- */
// A B-roll with less than this much footage left is "cut out": the export drops it anyway.
const MIN_KEPT = 0.1;

// The kept stretches of the video (review timeline), or null if they can't be read yet.
async function keepIntervals(id) {
  try { return (await need_host().timeline(id)).intervals; } catch { return null; }
}

// Ids of B-rolls that lie entirely inside cut-out parts: no prompt, image or clip is made for these.
const cutOutIds = (p, keep) =>
  new Set(keep ? p.brolls.filter(b => !snapToKept(keep, b.start, b.end)).map(b => b.id) : []);

// Pulls every B-roll in to the kept footage and drops the ones with nothing kept.
function snapPlan(items, keep) {
  if (!keep || !keep.length) return items;
  const out = [];
  for (const b of items) {
    const s = snapToKept(keep, b.start, b.end);
    if (s && s.end - s.start >= MIN_KEPT) out.push({ ...b, start: s.start, end: s.end });
  }
  return out;
}

// `keep` adds what the CURRENT cuts mean for each B-roll. It is not stored: it changes whenever the cuts do.
//   cutOut    : nothing of it stays in the video
//   needsTrim : it starts or ends inside a cut part (the trim button fixes this)
//   keptSec / cutSec : seconds of it that stay / are cut
function view(p, keep = null) {
  const out = { ...p, urls: {} };
  if (keep) {
    out.brolls = p.brolls.map(b => {
      const kept = keptWithin(keep, b.start, b.end);
      const eff = snapToKept(keep, b.start, b.end);
      return {
        ...b, keptSec: kept, cutSec: Math.max(0, (b.end - b.start) - kept), cutOut: !eff,
        needsTrim: Boolean(eff) && (eff.start - b.start > 0.05 || b.end - eff.end > 0.05)
      };
    });
  }
  out.flowJob = p.flowJobId ? jobs.get(p.flowJobId) : null;
  out.llm = llmInfo(p);
  out.themes = themes.THEMES;
  { const u = loadConfig().ultraKey || {}; out.ultraKey = { enabled: u.enabled !== false, modes: u.modes || ['ui', 'material', 'symbol'] }; }
  out.rounding = { default: rounding.DEFAULT_ROUND, max: rounding.MAX_ROUND, cardModes: rounding.CARD_MODES };
  return out;
}

function llmInfo(p) {
  const cfg = loadConfig();
  const provider = cfg.llm.providers[p.options.provider] ? p.options.provider : cfg.llm.defaultProvider;
  const pc = cfg.llm.providers[provider];
  // A web provider (Claude in claude.ai) has no API key: it uses the signed-in Chrome.
  if (pc.web) return { provider, label: pc.label, model: pc.default, hasKey: true, keyName: null, web: true, profile: 'rich' };
  return { provider, label: pc.label, model: pc.default, hasKey: !!secrets.get(provider), keyName: secrets.envVarOf(provider) };
}

/* ---------- step runner ---------- */
const log = (p, msg) => {
  p.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (p.log.length > 300) p.log.splice(0, p.log.length - 300);
  persistSoon(p);
};

const anyRunning = p => Object.values(p.steps).some(s => s.status === 'running');

function startStep(p, step, task) {
  if (anyRunning(p)) throw new HttpError(409, 'Another B-roll step is still running. Wait for it to finish.');
  p.steps[step] = { status: 'running', error: null, startedAt: new Date().toISOString() };
  persist(p);
  (async () => {
    try {
      await task();
      p.steps[step].status = 'done';
      log(p, `${step}: done`);
    } catch (e) {
      p.steps[step].status = 'failed';
      p.steps[step].error = e.message || String(e);
      log(p, `ERROR (${step}): ${p.steps[step].error}`);
      if (!(e instanceof HttpError) && !e.code) console.error(e);
    } finally {
      persist(p);
      touch(p.id);
    }
  })();
}

function resetFrom(p, step) {
  const i = STEPS.indexOf(step);
  for (const s of STEPS.slice(i)) p.steps[s] = { status: 'idle' };
}

/* ---------- LLM ---------- */
// Batch sizes: Claude reads whole parts of the video at once (claude.* in flow.config.json); Groq / Gemini keep the planning.* ones.
const isClaude = p => Boolean(loadConfig().llm.providers[p.options.provider] && loadConfig().llm.providers[p.options.provider].web);
function planning(p) {
  const cfg = loadConfig();
  const base = cfg.planning || {};
  return isClaude(p) ? { ...base, ...pick(cfg.claude || {}, ['chunkWords', 'selectBatchSize', 'cardBatchSize', 'promptBatchSize']) } : base;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] != null).map(k => [k, o[k]]));
function llmFor(p) {
  const cfg = loadConfig();
  const provider = cfg.llm.providers[p.options.provider] ? p.options.provider : cfg.llm.defaultProvider;
  const pc = cfg.llm.providers[provider];
  if (pc.web) return makeClaudeWeb({ cfg, log: m => log(p, m) });
  const key = secrets.get(provider);
  if (!key) throw new HttpError(400, `Add your ${pc.label} API key first (API keys button, top right, or ${secrets.envVarOf(provider)} in the .env file), or pick the other AI.`);
  return llmLib.make({ provider, model: pc.default, apiKey: key, baseUrl: pc.baseUrl, log: m => log(p, m) });
}

/* ---------- 1. B-roll plan ---------- */
async function startPlan(id) {
  const p = ensure(id);
  const cfg = loadConfig();
  const { cues, duration } = await need_host().readCues(id);
  if (!cues.length) throw new HttpError(400, 'No words are left to plan B-roll for. Restore some words in the transcript first.');
  const llm = llmFor(p);
  const keep = await keepIntervals(id);
  const claude = isClaude(p);
  // Claude: a new claude.ai chat for every video, so the history of older videos never piles up or leaks into this one.
  if (claude && cfg.claude && cfg.claude.newChatPerVideo !== false) { try { claudeWeb.resetChat(); } catch { /* ignore */ } }
  const combine = claude && themes.usesCards(p.options.theme) && Boolean(cfg.claude && cfg.claude.combineChooseCards);

  startStep(p, 'plan', async () => {
    log(p, `Planning on the edited transcript (${cues.length} words that stay in the video).`);
    const planned = await planner.planAll({
      llm, cues, audioDuration: duration, maxChunkWords: planning(p).chunkWords, theme: p.options.theme, log: m => log(p, m)
    });
    // The planner lays B-rolls back to back; trim them so none starts, ends or sits in a cut-out part.
    let plan = snapPlan(planned, keep);
    if (!plan.length) throw new Error('No B-roll could be planned on the parts that stay in the video.');
    if (plan.length !== planned.length) log(p, `${planned.length - plan.length} B-roll(s) were left out because they only covered cut-out parts.`);

    // Every line now has a description. Second pass: which lines deserve a picture, and which share one.
    // If it fails the descriptions are kept and every line stays on, so nothing is lost.
    try {
      log(p, `All ${plan.length} line(s) have a description.`);
      if (combine) throw Object.assign(new Error('combined'), { combined: true });   // choosing and designing happen together in the prompts step
      const chosen = await planner.chooseBroll({ llm, items: plan, batchSize: planning(p).selectBatchSize || 120, theme: p.options.theme, log: m => log(p, m) });
      plan = chosen.items;
      const lines = plan.filter(b => b.enabled).reduce((n, b) => n + planner.linesOf(b).length, 0);
      log(p, `The AI picked ${chosen.picked} picture(s) for ${lines} line(s)` +
        `${chosen.groups ? ` (${chosen.groups} shared by neighbouring lines)` : ''}. The other lines are unticked; tick any you want.`);
    } catch (e) {
      if (e.combined) { log(p, 'Claude will choose the pictures and design the cards together in the next step (claude.combineChooseCards).'); p.brolls = plan; p.flowJobId = null; resetFrom(p, 'prompts'); return; }
      p.steps.plan.warning = `The AI could not decide which lines deserve a picture (${e.message}). Every line is left on; untick the ones you don't want.`;
      log(p, `WARNING: ${p.steps.plan.warning}`);
    }
    p.brolls = plan;
    p.flowJobId = null;
    resetFrom(p, 'prompts');
    log(p, `${plan.length} B-roll moments planned.`);
  });
  return p;
}

/* ---------- cards (theme "card") ---------- */
const CARD_KEYS = ['card', 'mode', 'needsRealImage', 'searchHint', 'refs', 'source', 'file', 'logoSlug', 'render'];
function clearCard(b) {
  for (const k of CARD_KEYS) delete b[k];
  b.prompt = '';
}

// Stores a validated card on a B-roll and writes its prompt with the templates. A real_image card has no prompt.
function applyCard(b, card, { common = '', suffix = '' } = {}) {
  b.card = card; b.mode = card.mode;
  for (const k of ['refs', 'source', 'file', 'logoSlug', 'render']) delete b[k];
  if (card.mode === 'real_image') { b.needsRealImage = true; b.searchHint = card.search_hint; b.prompt = ''; return; }
  delete b.needsRealImage; delete b.searchHint;
  // Scenes and animated people carry their three style references; a logo with the user's own file is not generated at all.
  const built = cardPrompt.buildPrompt(card, { common, suffix });
  b.prompt = built.prompt;
  b.source = built.source;
  if (built.refs.length) b.refs = built.refs;
  if (built.source === 'file') b.file = built.file;
  if (card.mode === 'logo') b.logoSlug = card.brand;
  if (card.mode === 'person') b.render = card.render;
}

const durationOf = p => p.brolls.reduce((m, b) => Math.max(m, b.end || 0), 0);
const cardContext = (p, exceptIds, cut = new Set()) => p.brolls
  .filter(b => b.enabled && b.card && !cut.has(b.id) && !exceptIds.has(b.id))
  .map(b => ({ id: b.id, start: b.start, card: b.card }));

// Re-plans ONE B-roll (new moment/timing inside its free window + new picture). Runs inline.
const regenerating = new Set();
async function regenerateBroll(id, brollId) {
  const p = ensure(id);
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  if (regenerating.has(p.id)) throw new HttpError(409, 'Another B-roll is being regenerated. Wait a moment.');
  const b = p.brolls.find(x => x.id === brollId);
  if (!b) throw new HttpError(404, 'B-roll not found. Reload the page.');
  const llm = llmFor(p);
  const { cues, duration } = await need_host().readCues(id);
  regenerating.add(p.id);
  try {
    log(p, `Regenerating B-roll ${b.id}…`);
    const r = await planner.regenerateOne({ llm, cues, brolls: p.brolls, id: b.id, audioDuration: duration, theme: p.options.theme, log: m => log(p, m) });
    const keep = await keepIntervals(id);
    const snapped = keep && snapToKept(keep, r.start, r.end);
    if (Array.isArray(b.lines) && b.lines.length > 1) {
      // A group keeps its lines and timing; only the picture idea changes.
      Object.assign(b, { description: r.description, prompt: '' });
    } else {
      Object.assign(b, {
        start: snapped ? snapped.start : r.start, end: snapped ? snapped.end : r.end,
        quote: r.quote, anchor: r.anchor, description: r.description, prompt: ''
      });
    }
    clearCard(b);                 // the description changed: its card, mode and prompt no longer fit
    p.brolls.sort((x, y) => x.start - y.start);
    p.flowJobId = null;           // the old images no longer match this plan
    resetFrom(p, 'prompts');
    persist(p);
    touch(id);
    log(p, `B-roll ${b.id} regenerated.`);
    return p;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e.message || 'Could not regenerate this B-roll.');
  } finally { regenerating.delete(p.id); }
}

// Theme "card": asks the AI for a different card for ONE B-roll (it must not use the layout the B-roll has now).
async function newCardIdea(id, brollId, body = {}) {
  const p = ensure(id);
  if (!themes.usesCards(p.options.theme)) throw new HttpError(400, 'New card ideas only exist in the UI Card theme.');
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  if (regenerating.has(p.id)) throw new HttpError(409, 'Another B-roll is being regenerated. Wait a moment.');
  const b = p.brolls.find(x => x.id === String(brollId));
  if (!b) throw new HttpError(404, 'B-roll not found. Reload the page.');
  const llm = llmFor(p);
  regenerating.add(p.id);
  try {
    log(p, `Asking for a new card idea for ${b.id}…`);
    const got = await cardAi.newIdea({
      llm, item: b, current: b.card || null, wish: clean(body && body.wish, 500),
      context: cardContext(p, new Set([b.id])), all: p.brolls, duration: durationOf(p), log: m => log(p, m)
    });
    applyCard(b, got.card, { common: p.options.prompts.common, suffix: p.options.prompts.suffix });
    p.flowJobId = null;                       // the old images no longer match the prompts
    p.steps.render = { status: 'idle' };
    persist(p); touch(id);
    log(p, `New card for ${b.id}: ${b.card.mode}${b.card.layout ? '/' + b.card.layout : ''}.`);
    return p;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e.message || 'Could not make a new card idea.');
  } finally { regenerating.delete(p.id); }
}

/* ---------- logos and people ---------- */
const itemOf = (p, brollId) => {
  const job = p.flowJobId ? jobs.get(p.flowJobId) : null;
  return { job, item: job ? job.items.find(i => i.brollId === brollId) : null };
};
const needIdle = (p, job) => {
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  if (job && jobs.runningJobId() === job.id) throw new HttpError(409, 'The images are being generated. Stop the job first.');
};
const cardOf = (p, brollId, mode) => {
  const b = p.brolls.find(x => x.id === String(brollId));
  if (!b) throw new HttpError(404, 'B-roll not found. Reload the page.');
  if (!b.card || b.card.mode !== mode) throw new HttpError(400, `This B-roll is not a ${mode} picture.`);
  return b;
};

// "Save as logo": the picked image becomes assets/logos/<brand>.png, so every later video uses it with no generation.
function saveAsLogo(id, brollId) {
  const p = ensure(id);
  const b = cardOf(p, brollId, 'logo');
  const { job, item } = itemOf(p, b.id);
  if (!item || !item.selected) throw new HttpError(400, 'Pick an image for this logo first.');
  const dest = logosLib.saveLogo(path.join(loadConfig().outputDir, 'jobs', job.id, 'images', item.selected), b.card.brand);
  b.source = 'file'; b.file = dest;
  log(p, `Saved the ${b.card.display_name} logo to ${path.relative(loadConfig().root, dest)}. Every later video uses it.`);
  persist(p); touch(id);
  return p;
}

// A real-person picture that Flow refused or got wrong: draw them in the animated style instead.
function personToAnimated(id, brollId) {
  const p = ensure(id);
  const b = cardOf(p, brollId, 'person');
  const { job, item } = itemOf(p, b.id);
  needIdle(p, job);
  const v = cardSpec.validateCard({ ...b.card, render: 'animated', palette: 'blue_grey' }, b.quote || b.description || '', { profile: 'rich' });
  applyCard(b, v.card, { common: p.options.prompts.common, suffix: p.options.prompts.suffix });
  if (item) jobs.update(job.id, j => {
    const it = j.items[item.index];
    Object.assign(it, { prompt: b.prompt, refs: b.refs || [], person: 'animated', status: 'pending', error: null, images: [], selected: null });
    delete it.needsAttention; delete it.attention;
  });
  p.steps.render = { status: 'idle' };
  log(p, `${b.id}: ${b.card.name} will be drawn animated. Press Resume to generate it.`);
  persist(p); touch(id);
  return p;
}

// ...or use their authentic photo: the picture becomes a "needs your own image" item searched by the person's name.
function personToPhoto(id, brollId) {
  const p = ensure(id);
  const b = cardOf(p, brollId, 'person');
  const { job, item } = itemOf(p, b.id);
  needIdle(p, job);
  applyCard(b, { id: b.id, mode: 'real_image', pill: String(b.card.name).toLowerCase().slice(0, 40), search_hint: b.card.name }, {});
  if (item) jobs.update(job.id, j => {
    const it = j.items[item.index];
    Object.assign(it, { status: 'done', skipped: true, images: [], selected: null, error: null });
    delete it.needsAttention; delete it.attention;
  });
  p.steps.render = { status: 'idle' };
  log(p, `${b.id}: ${b.card.search_hint} now needs your own photo.`);
  persist(p); touch(id);
  return p;
}

// ---- placement ("transform") of the pictures on the frame ----
// p.globalPos = { cx, cy, w } is the PARENT setting every B-roll follows. A B-roll's own `pos` is a CHILD override: it may hold
// any of cx / cy / w, and whatever it leaves out is inherited from the parent. No result = the picture fills / fits the frame.
const r4 = v => Math.round(v * 10000) / 10000;
const POS_RANGE = { cx: [-0.5, 1.5], cy: [-0.5, 1.5], w: [0.1, 2.5] };
function cleanPos(raw, { full = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['cx', 'cy', 'w']) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    const v = Number(raw[k]);
    if (Number.isFinite(v)) out[k] = r4(Math.min(POS_RANGE[k][1], Math.max(POS_RANGE[k][0], v)));
  }
  if (full && !['cx', 'cy', 'w'].every(k => k in out)) return null;
  return Object.keys(out).length ? out : null;
}
// What a B-roll really uses: its own values on top of the parent's. null unless all three values are known.
function resolvePos(p, b) {
  const merged = { ...(cleanPos(p && p.globalPos) || {}), ...(cleanPos(b && b.pos) || {}) };
  return ['cx', 'cy', 'w'].every(k => k in merged) ? { cx: merged.cx, cy: merged.cy, w: merged.w } : null;
}

// Corner roundness (% of the picture's shorter side), same two levels as the position: p.globalRound is the PARENT every
// B-roll follows, a B-roll's own `round` overrides it. Green-screen cards (ui / material / symbol) are never rounded.
function resolveRound(p, b) {
  if (!rounding.isRoundable(b && b.mode)) return 0;
  const own = b && b.round !== undefined && b.round !== null && Number.isFinite(Number(b.round)) ? b.round : null;
  const glob = p && p.globalRound !== undefined && p.globalRound !== null && Number.isFinite(Number(p.globalRound)) ? p.globalRound : null;
  return rounding.cleanRound(own !== null ? own : glob);
}

async function saveBrolls(id, arr, globalPos, globalRound) {
  const p = ensure(id);
  if (!Array.isArray(arr)) throw new HttpError(400, 'Send a list of B-rolls.');
  if (arr.length > 500) throw new HttpError(400, 'Too many B-rolls (max 500).');
  const { duration } = await need_host().readCues(id);
  const dur = duration || Infinity;
  const seen = new Set();
  const before = new Map(p.brolls.map(x => [x.id, x]));
  const out = arr.map((b, i) => {
    let bid = /^[\w-]{1,20}$/.test(String(b.id || '')) ? String(b.id) : '';
    if (!bid || seen.has(bid)) { let n = i + 1; do { bid = `b${String(n++).padStart(3, '0')}x`; } while (seen.has(bid)); }
    seen.add(bid);
    const start = Number(b.start), end = Number(b.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new HttpError(400, `B-roll ${i + 1}: the end time must be after the start time.`);
    if (start >= dur) throw new HttpError(400, `B-roll ${i + 1} starts after the end of the recording (${dur.toFixed(1)} s).`);
    const item = {
      id: bid, start, end: Math.min(end, dur), quote: clean(b.quote, 400), anchor: clean(b.anchor, 120),
      description: clean(b.description, 1500), prompt: clean(b.prompt, 2000), enabled: b.enabled !== false
    };
    // This B-roll's own placement (an override of the parent one; any of cx / cy / w). Absent = it follows the parent.
    const pos = cleanPos(b.pos);
    if (pos) item.pos = pos;
    // This B-roll's own corner roundness (absent = it follows the parent one).
    if (b.round !== undefined && b.round !== null && Number.isFinite(Number(b.round))) item.round = rounding.cleanRound(b.round);
    // Theme "card": the card form, its mode and the real-image flag live on the server; the editor does not send them back.
    const old = before.get(bid);
    if (old && old.card) {
      item.card = old.card; item.mode = old.mode;
      for (const k of ['refs', 'source', 'file', 'logoSlug', 'render']) if (old[k] !== undefined) item[k] = old[k];
      if (old.needsRealImage && !item.prompt.trim()) { item.needsRealImage = true; item.searchHint = old.searchHint || ''; }
    }
    // A group remembers its lines so it can be split again.
    const lines = Array.isArray(b.lines) ? b.lines.slice(0, 100).map(l => ({
      start: Number(l && l.start), end: Number(l && l.end), quote: clean(l && l.quote, 400), description: clean(l && l.description, 1500)
    })).filter(l => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start) : [];
    if (lines.length > 1) item.lines = lines;
    return item;
  }).sort((a, b) => a.start - b.start);
  p.brolls = out;
  // The parents (what every B-roll follows). Without this the "All B-rolls" position was never kept on the server.
  const gp = cleanPos(globalPos, { full: true });
  if (gp) p.globalPos = gp; else delete p.globalPos;
  if (globalRound !== undefined && globalRound !== null && Number.isFinite(Number(globalRound))) p.globalRound = rounding.cleanRound(globalRound);
  else delete p.globalRound;
  persist(p);
  touch(id);
  return p;
}

// Pulls every B-roll in to the footage that is still kept and removes the ones that lie only in cut-out parts.
// Descriptions, prompts and chosen images of the others are untouched.
async function tidyBrolls(id) {
  const p = ensure(id);
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  const keep = await keepIntervals(id);
  if (!keep) throw new HttpError(409, 'This project has not been transcribed yet.');
  const before = p.brolls.length;
  p.brolls = snapPlan(p.brolls, keep);
  log(p, `Trimmed B-rolls to the kept parts (${before - p.brolls.length} removed because they were only in cut-out parts).`);
  persist(p);
  touch(id);
  return p;
}

// Makes neighbouring B-rolls share ONE picture. `ids` must be next to each other in the list (on or off, any mix).
// The group keeps the id, description and prompt of its first ticked member (else the first), so that picture stays valid.
async function groupBrolls(id, ids) {
  const p = ensure(id);
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  const want = Array.isArray(ids) ? ids.map(String) : [];
  if (want.length < 2 || new Set(want).size !== want.length) throw new HttpError(400, 'Pick at least two different lines to group.');
  const at = want.map(x => p.brolls.findIndex(b => b.id === x));
  if (at.some(i => i < 0)) throw new HttpError(404, 'B-roll not found. Reload the page.');
  at.sort((a, b) => a - b);
  if (at.some((i, k) => k && i !== at[k - 1] + 1)) throw new HttpError(400, 'Only lines that are directly next to each other can share a picture.');

  const members = at.map(i => p.brolls[i]);
  const primary = members.find(m => m.enabled) || members[0];
  const merged = planner.mergeGroup(members, { primary });
  merged.enabled = members.some(m => m.enabled);
  p.brolls.splice(at[0], members.length, merged);
  p.steps.render = { status: 'idle' };
  log(p, `Grouped ${members.length} B-rolls into ${merged.id}.`);
  persist(p); touch(id);
  return p;
}

// Splits a group back into one B-roll per line, each with the description it had before.
function ungroupBroll(id, brollId) {
  const p = ensure(id);
  if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
  const i = p.brolls.findIndex(b => b.id === String(brollId));
  if (i < 0) throw new HttpError(404, 'B-roll not found. Reload the page.');
  const group = p.brolls[i];
  if (!Array.isArray(group.lines) || group.lines.length < 2) throw new HttpError(400, 'This B-roll is not a group.');

  const used = new Set(p.brolls.map(b => b.id));
  let n = 0;
  const nextId = () => { let x; do { x = `s${Date.now().toString(36)}${(n++).toString(36)}`; } while (used.has(x)); used.add(x); return x; };
  const parts = planner.splitGroup(group, nextId);
  p.brolls.splice(i, 1, ...parts);

  // The old picture was chosen for the whole group; it no longer fits the first line alone.
  const job = p.flowJobId ? jobs.get(p.flowJobId) : null;
  const item = job && job.items.find(x => x.brollId === group.id);
  if (item && item.selected) { try { jobs.select(job.id, item.index, null); } catch { /* ignore */ } }

  p.steps.render = { status: 'idle' };
  log(p, `Ungrouped ${group.id} into ${parts.length} B-rolls.`);
  persist(p); touch(id);
  return p;
}

function saveOptions(id, body = {}) {
  const p = ensure(id);
  const o = p.options;
  if (body.theme !== undefined && body.theme !== o.theme) {
    if (!themes.isTheme(body.theme)) throw new HttpError(400, 'Unknown theme.');
    if (anyRunning(p)) throw new HttpError(409, 'A B-roll step is still running. Wait for it to finish.');
    const had = p.brolls.some(b => b.prompt || b.card);
    o.theme = body.theme;
    // The default suffix belongs to the card theme: add it when switching to it, remove it (if untouched) when leaving.
    const sfx = String(o.prompts.suffix || '').trim();
    if (themes.usesCards(o.theme) && !sfx) o.prompts.suffix = cardPrompt.DEFAULT_SUFFIX;
    else if (!themes.usesCards(o.theme) && sfx === cardPrompt.DEFAULT_SUFFIX) o.prompts.suffix = '';
    if (had) {                                  // prompts written for the other theme do not fit: clear them, keep the plan
      p.brolls.forEach(clearCard);
      p.flowJobId = null;
      resetFrom(p, 'prompts');
      log(p, `Theme changed to "${o.theme}": prompts and cards were cleared (the plan is kept).`);
    }
  }
  if (body.prompts) {
    o.prompts.common = clean(body.prompts.common, 4000);
    o.prompts.suffix = clean(body.prompts.suffix, 500);
  }
  if (body.render) o.render = { outputDir: clean(body.render.outputDir, 500).trim() };
  if (body.provider !== undefined) {
    if (!loadConfig().llm.providers[body.provider]) throw new HttpError(400, 'Unknown AI.');
    o.provider = body.provider;
  }
  if (body.ultraKey !== undefined && (body.ultraKey !== false) !== (o.ultraKey !== false)) {
    o.ultraKey = Boolean(body.ultraKey);        // changes the exported pictures: the old clips/export no longer match
    p.steps.render = { status: 'idle' };
    persist(p); touch(id);
    return p;
  }
  persist(p);
  return p;
}

/* ---------- 2. image prompts ---------- */
function startPrompts(id, body = {}, keep = null) {
  const p = ensure(id);
  const cfg = loadConfig();
  if (!p.brolls.length) throw new HttpError(400, 'Plan the B-roll first.');
  const common = clean(body.common != null ? body.common : p.options.prompts.common, 4000);
  const suffix = clean(body.suffix != null ? body.suffix : p.options.prompts.suffix, 500);
  const onlyMissing = !!body.onlyMissing;
  const cut = cutOutIds(p, keep);
  const cards = themes.usesCards(p.options.theme);
  // "Only the empty ones" never touches a prompt the user has (or edited), and leaves "needs your own image" items alone.
  const targets = p.brolls.filter(b => b.enabled && !cut.has(b.id) && (!onlyMissing || (!b.prompt.trim() && !(cards && (b.needsRealImage || b.source === 'file')))));
  if (!targets.length) throw new HttpError(400, onlyMissing ? 'Every B-roll already has a prompt.' : 'No enabled B-roll on the kept parts to write prompts for.');
  const llm = llmFor(p);
  p.options.prompts = { ...p.options.prompts, common, suffix };

  if (cards) {
    // Theme "card": the AI only fills a form; validation, variety and the final prompt are code.
    const pl = planning(p);
    const combine = isClaude(p) && Boolean(cfg.claude && cfg.claude.combineChooseCards) && !onlyMissing && p.brolls.every(b => !b.card);
    startStep(p, 'prompts', async () => {
      let work = targets;
      const forms = new Map();
      if (combine) {
        // T6: Claude chooses the pictures AND designs every card in one answer; the usual grouping code then merges the neighbours.
        const r = await cardAi.pickAndDesign({ llm, items: work, duration: durationOf(p), log: m => log(p, m) });
        if (!r.decisions.length) throw new Error('The AI did not pick any line for a B-roll.');
        const starts = new Map(r.decisions.map(d => [String(d.at[0].id), d]));
        const merged = new Set(r.decisions.flatMap(d => d.at.slice(1).map(m => String(m.id))));
        const out = [];
        for (const b of p.brolls) {
          const bid = String(b.id);
          if (merged.has(bid)) continue;
          const d = starts.get(bid);
          if (!d) { out.push(targets.includes(b) ? { ...b, enabled: false } : b); continue; }
          const item = d.at.length > 1 ? planner.mergeGroup(d.at, { description: d.description }) : { ...b, enabled: true };
          if (r.cards.has(bid)) forms.set(bid, r.cards.get(bid));
          out.push(item);
        }
        p.brolls = out;
        work = p.brolls.filter(b => b.enabled && !cut.has(b.id));
        log(p, `The AI picked ${r.decisions.length} picture(s) and designed ${forms.size} card(s) in one answer.`);
      }
      const need = work.filter(b => !forms.has(String(b.id)));
      const got = need.length ? await cardAi.cardsFor({
        llm, items: need, context: cardContext(p, new Set(work.map(b => b.id)), cut), all: p.brolls, duration: durationOf(p),
        batchSize: pl.cardBatchSize || 8, log: m => log(p, m)
      }) : new Map();
      let real = 0, fell = 0, logos = 0;
      for (const b of work) {
        const r = forms.has(String(b.id)) ? { card: forms.get(String(b.id)), fellBack: false } : got.get(String(b.id));
        applyCard(b, r.card, { common, suffix });
        if (r.card.mode === 'real_image') real++;
        if (b.source === 'file') logos++;
        if (r.fellBack) fell++;
      }
      p.flowJobId = null;
      p.steps.render = { status: 'idle' };
      log(p, `${work.length - real - logos} prompt(s) written` + (logos ? `, ${logos} logo(s) use your own file` : '') + (real ? `, ${real} B-roll(s) need your own image` : '') + (fell ? `, ${fell} used a simple fallback card` : '') + '.');
    });
    return p;
  }

  startStep(p, 'prompts', async () => {
    const got = await planner.promptsFor({ llm, items: targets, common, batchSize: planning(p).promptBatchSize || cfg.planning.promptBatchSize, log: m => log(p, m) });
    for (const b of targets) if (got.has(b.id)) b.prompt = planner.applySuffix(got.get(b.id), suffix);
    p.flowJobId = null;
    p.steps.render = { status: 'idle' };
    log(p, `${got.size} prompt(s) written.`);
  });
  return p;
}

/* ---------- 3. images (Flow job) ---------- */
function imageItems(p, keep = null) {
  const cut = cutOutIds(p, keep);   // never spend image credits on parts that are cut out
  const items = p.brolls.filter(b => b.enabled && !cut.has(b.id) && (b.prompt.trim() || b.source === 'file'));
  if (!items.length) throw new HttpError(400, 'No enabled B-roll on the kept parts has an image prompt yet. Write the prompts first.');
  return items;
}
function attachJob(p, jobId) { p.flowJobId = jobId; p.steps.render = { status: 'idle' }; persist(p); touch(p.id); }

// The original picture file of a job item (the Clips step and the "no key" case always use this one).
const originalPath = (cfg, job, item) => path.join(cfg.outputDir, 'jobs', job.id, 'images', item.selected);

// The picked images, ready for compositing: [{ id, start, end, imagePath, mode, keyed }] on the review timeline.
// A green card picture whose Ultra Key copy exists (and the switch is on) comes with the keyed PNG and keyed:true.
function chosen(id) {
  const p = ensure(id);
  const job = p.flowJobId ? jobs.get(p.flowJobId) : null;
  if (!job) return [];
  const cfg = loadConfig();
  const keyOn = p.options.ultraKey !== false;
  const byId = new Map(p.brolls.map(b => [b.id, b]));
  return job.items
    .filter(i => i.selected && byId.has(i.brollId) && byId.get(i.brollId).enabled)
    .map(i => {
      const b = byId.get(i.brollId);
      let imagePath = originalPath(cfg, job, i), keyed = false;
      if (keyOn && i.key === true && keying.isKeyable(b.mode, cfg) && fs.existsSync(imagePath) && keying.isFresh(imagePath)) {
        imagePath = keying.keyedFile(imagePath); keyed = true;
      }
      return { id: b.id, start: b.start, end: b.end, pos: resolvePos(p, b), round: resolveRound(p, b), prompt: i.prompt, description: b.description,
        mode: b.mode, keyed, imagePath };
    })
    .filter(c => fs.existsSync(c.imagePath))
    .sort((a, b) => a.start - b.start);
}

// Backfill of the transparent copies: marks the green card pictures of the job and keys them (old jobs, changed settings).
async function keyImages(id) {
  const p = ensure(id);
  const job = p.flowJobId ? jobs.get(p.flowJobId) : null;
  if (!job) return p;
  const cfg = loadConfig();
  const byId = new Map(p.brolls.map(b => [b.id, b]));
  for (const it of job.items) { const b = byId.get(it.brollId); if (b && keying.isKeyable(b.mode, cfg)) it.key = true; }
  await jobs.keyJobImages(job);
  persist(p); touch(id);
  return p;
}
/* ---------- 4b. Premiere-ready files (one transparent track + an importable sequence) ---------- */
async function startPremiere(id, body = {}) {
  const p = ensure(id);
  const items = chosen(id);
  if (!items.length) throw new HttpError(400, p.flowJobId ? 'Select at least one image first.' : 'Generate images first.');
  const extraDir = checkOutputDir(body.outputDir);
  const fit = body.fit === 'contain' ? 'contain' : 'cover';
  const { intervals, duration } = await need_host().timeline(id);
  const info = await need_host().videoInfo(id);
  if (!info.width || !info.height) throw new HttpError(400, 'Could not read the video size.');
  const total = duration || totalKept(intervals);

  startStep(p, 'premiere', async () => {
    const warnings = [];
    const mapped = [];
    for (const it of items) {
      const m = mapSpan(intervals, it.start, it.end);
      if (m.end - m.start < 0.1) { warnings.push(`${it.id} falls entirely inside cut-out parts and was left out.`); continue; }
      mapped.push({ ...it, start: m.start, end: m.end });
    }
    if (!mapped.length) throw new Error('Every chosen B-roll falls inside cut-out parts, so there is nothing to build.');
    p.steps.premiere.progress = { done: 0, total: mapped.length };
    const outDir = file(p, 'premiere');
    const r = await premiereLib.build({
      items: mapped, size: info, fps: info.fps || 30, totalSec: total, fit, outDir, name: need_host().name ? need_host().name(id) : 'Project',
      log: m => log(p, m), progress: (done, count) => { p.steps.premiere.progress = { done, total: count }; }
    });
    let outputDir = outDir;
    if (extraDir) {
      for (const f of ['broll_track.mov', 'broll_sequence.xml']) fs.copyFileSync(path.join(outDir, f), path.join(extraDir, f));
      outputDir = extraDir;
      log(p, `Copied to ${extraDir}`);
    }
    p.steps.premiere.result = {
      warnings: [...warnings, ...r.warnings], outputDir, projectDir: outDir, width: r.width, height: r.height, fps: r.fps,
      durationSec: r.durationSec, count: r.count, trackBytes: r.trackBytes,
      track: `${urlOf(p, 'premiere')}/broll_track.mov`, xml: `${urlOf(p, 'premiere')}/broll_sequence.xml`
    };
  });
  return p;
}

/* ---------- 4. separate clips ---------- */
function checkOutputDir(raw) {
  const dir = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  if (!dir) return null;
  if (!path.isAbsolute(dir)) throw new HttpError(400, 'The output folder must be a full path, for example C:\\Videos\\broll or /Users/me/broll.');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true });
  } catch (e) { throw new HttpError(400, `Cannot write to the output folder "${dir}": ${e.message}`); }
  return path.resolve(dir);
}

const CLIPS_KEY_WARNING = 'Green card pictures stay on green in the separate clips. Use the video export or the Premiere track for transparency.';

async function startRender(id, body = {}) {
  const p = ensure(id);
  // Clips are opaque .mp4 files and cannot hold transparency: they always use the ORIGINAL (green) picture.
  const keyedCount = chosen(id).filter(c => c.keyed).length;
  const cfgNow = loadConfig(), jobNow = p.flowJobId ? jobs.get(p.flowJobId) : null;
  const items = chosen(id).map(c => {
    if (!c.keyed || !jobNow) return c;
    const it = jobNow.items.find(x => x.brollId === c.id && x.selected);
    return { ...c, keyed: false, imagePath: it ? originalPath(cfgNow, jobNow, it) : c.imagePath };
  });
  if (!items.length) throw new HttpError(400, p.flowJobId ? 'Select at least one image first.' : 'Generate images first.');
  const extraDir = checkOutputDir(body.outputDir);
  p.options.render = { outputDir: String(body.outputDir || '').trim() };
  const { intervals, duration } = await need_host().timeline(id);
  const total = duration || totalKept(intervals);

  startStep(p, 'render', async () => {
    const warnings = [];
    // Clips are laid on the EXPORTED timeline (the video after the cuts).
    const mapped = [];
    for (const it of items) {
      const m = mapSpan(intervals, it.start, it.end);
      if (m.end - m.start < 0.1) { warnings.push(`${it.id} falls entirely inside cut-out parts and was left out.`); continue; }
      mapped.push({ ...it, start: m.start, end: m.end });
    }
    if (!mapped.length) throw new Error('Every chosen B-roll falls inside cut-out parts, so there is nothing to render.');
    const cut = cutOutIds(p, intervals);
    const skipped = p.brolls.filter(b => b.enabled && !cut.has(b.id) && !items.some(i => i.id === b.id)).map(b => b.id);
    p.steps.render.progress = { done: 0, total: mapped.length };
    const result = await renderLib.render({
      items: mapped, durationSec: total,
      outDir: file(p, 'render'), urlBase: urlOf(p, 'render'), extraDir,
      log: m => log(p, m), progress: (done, count) => { p.steps.render.progress = { done, total: count }; }
    });
    result.warnings.unshift(...warnings);
    if (keyedCount) result.warnings.push(CLIPS_KEY_WARNING);
    if (skipped.length) result.warnings.push(`${skipped.length} enabled B-roll(s) have no chosen image (${skipped.join(', ')}). Their time is covered by the previous clip so nothing is missing.`);
    p.steps.render.result = result;
  });
  return p;
}

// Opens the folder of the last clip render (path comes from our own stored result, never from the request).
function openRenderFolder(id, which) {
  const p = ensure(id);
  const r = which === 'premiere' ? (p.steps.premiere && p.steps.premiere.result) : (p.steps.render && p.steps.render.result);
  const dir = r && r.outputDir;
  if (!dir || !fs.existsSync(dir)) throw new HttpError(400, 'Make the clips first.');
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
  try {
    const c = require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  } catch (e) { throw new HttpError(500, `Could not open the folder: ${e.message}`); }
  return { ok: true, dir };
}

/* ---------- lifecycle ---------- */
// The transcript or the cuts base changed (re-transcribed / re-trimmed): the old plan no longer fits.
function reset(id) {
  if (!need_host().exists(id)) return;
  const p = ensure(id);
  p.brolls = []; p.flowJobId = null;
  for (const s of STEPS) p.steps[s] = { status: 'idle' };
  jobs.removeByProject(id);
  fs.rmSync(path.join(need_host().dir(id), 'render'), { recursive: true, force: true });
  persist(p);
}

// The editor project was deleted: forget it and delete its image jobs (the folder goes with the project).
function remove(id) {
  clearTimeout(timers.get(id)); timers.delete(id);
  projects.delete(id);
  jobs.removeByProject(id);
}

// Something that changes the exported video was edited elsewhere (e.g. a picked image).
const touchExport = id => touch(id);

const hasChosen = id => { try { return chosen(id).length; } catch { return 0; } };

module.exports = {
  resolvePos, cleanPos,
  configure, ensure, view, keepIntervals, tidyBrolls, startPlan, regenerateBroll, newCardIdea, saveAsLogo, personToAnimated, personToPhoto, saveBrolls, groupBrolls, ungroupBroll, saveOptions, startPrompts,
  imageItems, attachJob, chosen, keyImages, originalPath, startRender, startPremiere, openRenderFolder, reset, remove, hasChosen, touchExport, anyRunning, llmInfo
};
