'use strict';
/**
 * Google Flow automation.
 *
 * Drives YOUR real, logged-in Chrome (started with --remote-debugging-port) through
 * Playwright's CDP connection. For each prompt it: types the prompt, clicks generate,
 * waits for NEW large <img> elements to appear, downloads them, and saves them.
 *
 * It never clicks a "download" button; it detects freshly rendered images and fetches
 * their bytes. That is far less sensitive to Flow's UI changes. All selectors live in
 * flow.config.json so a UI change is a config edit, not a code change.
 */
const crypto = require('crypto');
const fs = require('fs');
const { healRefs } = require('./cardPrompt');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const coded = (code, message) => Object.assign(new Error(message), { code });

function loadChromium() {
  for (const name of ['playwright-core', 'playwright']) {
    try { return require(name).chromium; } catch { /* try next */ }
  }
  throw new Error('Playwright is not installed. Run "npm install" in the project folder.');
}

async function connect(cfg) {
  const chromium = loadChromium();
  try {
    return await chromium.connectOverCDP(cfg.cdpUrl, { timeout: 10000 });
  } catch (e) {
    throw new Error(`Can't reach Chrome at ${cfg.cdpUrl}. Click "Launch Chrome" first. (${String(e.message).split('\n')[0]})`);
  }
}

async function getFlowPage(ctx, cfg) {
  const origin = new URL(cfg.flowUrl).origin;
  let page = ctx.pages().find(p => {
    try { return new URL(p.url()).origin === origin; } catch { return false; }
  });
  if (!page) {
    page = await ctx.newPage();
    await page.goto(cfg.flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.bringToFront();
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error('Flow is asking you to sign in. Sign into Google in the Chrome window once, then try again.');
  }
  return page;
}

// First visible (and optionally enabled) element matching any selector, in priority order.
async function findVisible(page, selectors, { timeout = 5000, enabled = false } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel);
        const n = Math.min(await loc.count(), 10);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if ((await el.isVisible()) && (!enabled || (await el.isEnabled()))) return el;
        }
      } catch { /* selector invalid or DOM changed mid-check; try the next */ }
    }
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

async function ensurePromptBox(page, cfg, ctl) {
  let box = await findVisible(page, cfg.selectors.promptBox, { timeout: 6000 });
  if (box) return box;
  const nb = await findVisible(page, cfg.selectors.newProjectButton || [], { timeout: 1500 });
  if (nb) {
    ctl.log('Opening a new Flow project…');
    await nb.click();
    box = await findVisible(page, cfg.selectors.promptBox, { timeout: 20000 });
    if (box) return box;
  }
  throw new Error(
    'Could not find the prompt box on the Flow page. Open a Flow project (the screen with the prompt bar) in the ' +
    'Chrome window, or use "Inspect Flow page" and update selectors.promptBox in flow.config.json.'
  );
}

function keyOf(src) {
  if (/^https?:/i.test(src)) return src.split(/[?#]/)[0];
  return crypto.createHash('sha1').update(src).digest('hex');
}

async function readImages(page, minSize) {
  return page.evaluate(min => Array.from(document.images)
    .filter(i => i.complete && i.naturalWidth >= min && i.naturalHeight >= min)
    .map(i => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight })), minSize);
}

function sniffExt(buf, type = '') {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (/svg/i.test(type)) return 'svg';
  if (/gif/i.test(type)) return 'gif';
  return 'png';
}

function parseDataUrl(u) {
  const comma = u.indexOf(',');
  const meta = u.slice(5, comma);
  const body = u.slice(comma + 1);
  const buf = /;base64/i.test(meta) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
  return { buf, type: meta.split(';')[0] };
}

// http(s): fetch through the browser context (shares login cookies, ignores CORS).
// blob:/data: URLs only exist inside the page, so those are read in-page.
async function fetchBytes(page, ctx, src) {
  if (/^data:/i.test(src)) return parseDataUrl(src);
  if (/^https?:/i.test(src)) {
    try {
      const r = await ctx.request.get(src, { timeout: 60000 });
      if (r.ok()) return { buf: await r.body(), type: r.headers()['content-type'] || '' };
    } catch { /* fall through to in-page fetch */ }
  }
  const dataUrl = await page.evaluate(async s => {
    const res = await fetch(s);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    return await new Promise((ok, no) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result);
      fr.onerror = () => no(fr.error);
      fr.readAsDataURL(blob);
    });
  }, src);
  return parseDataUrl(dataUrl);
}

async function matchedLimitText(page, patterns) {
  if (!patterns || !patterns.length) return [];
  try {
    return await page.evaluate(pats => {
      const t = (document.body.innerText || '').toLowerCase();
      return pats.filter(p => t.includes(p.toLowerCase()));
    }, patterns);
  } catch { return []; }
}

async function setPrompt(page, box, text) {
  await box.click({ timeout: 8000 });
  const tag = await box.evaluate(el => el.tagName.toLowerCase());
  if (tag === 'textarea' || tag === 'input') {
    await box.fill(text);
  } else {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(text);
  }
}

// Finds the send button INSIDE the prompt bar (Flow's is an icon-only round arrow with no text).
// Walks up from the prompt box to the smallest ancestor holding the bar's buttons, drops
// close/add buttons, prefers an arrow/send-like label, else takes the right-most button on the bottom row.
// Scoping to the bar avoids hitting look-alikes elsewhere, e.g. the sidebar's "Create tool".
async function findPromptBarSubmit(page, box) {
  const boxHandle = await box.elementHandle();
  const handle = await page.evaluateHandle(el => {
    const visible = b => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = b => ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || b.textContent || '')).trim();
    const SKIP = /close|clear|cancel|remove|delete|attach|upload|\badd\b|^\+$/i;
    const GO = /arrow_forward|arrow_upward|send|generate|create|submit|\brun\b/i;
    const right = b => b.getBoundingClientRect().right;
    const cy = b => { const r = b.getBoundingClientRect(); return (r.top + r.bottom) / 2; };

    let node = el;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const all = [...node.querySelectorAll('button, [role="button"]')]
        .filter(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (all.length < 3) continue;
      const cands = all.filter(b => !SKIP.test(label(b)));
      if (!cands.length) continue;
      const goers = cands.filter(b => GO.test(label(b)));
      if (goers.length) return goers.sort((a, b) => right(b) - right(a))[0];
      const lowest = Math.max(...cands.map(cy));
      return cands.filter(b => cy(b) >= lowest - 14).sort((a, b) => right(b) - right(a))[0];
    }
    return null;
  }, boxHandle);
  await boxHandle.dispose();
  return handle.asElement();
}

const boxText = box => box.evaluate(el => ((el.value !== undefined ? el.value : el.innerText) || '').trim()).catch(() => '');

// Flow empties the prompt bar once a prompt is accepted, so "box is empty" == "it was submitted".
async function waitSubmitted(page, cfg, ctl, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(250);
    const b = await findVisible(page, cfg.selectors.promptBox, { timeout: 300 });
    if (!b) return true;                       // bar gone / page navigated: treat as accepted
    if (!(await boxText(b))) return true;
  }
  return false;
}

async function clickSendButton(page, box, cfg, ctl) {
  if (cfg.selectors.submitButton && cfg.selectors.submitButton.length) {
    const btn = await findVisible(page, cfg.selectors.submitButton, { timeout: 4000, enabled: true });
    if (btn) { await btn.click(); ctl.log('  clicked the configured send button'); return true; }
  }
  // The button can stay disabled for a moment after typing, so retry briefly.
  const deadline = Date.now() + 5000;
  let el = null;
  while (!el && Date.now() < deadline) {
    el = await findPromptBarSubmit(page, box);
    if (!el) await sleep(300);
  }
  if (!el) return false;
  const desc = await el.evaluate(b => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 30)).catch(() => '');
  try {
    // real mouse click at the button centre: more reliable than an element click on Flow's icon button
    const r = await el.boundingBox();
    if (r) await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    else await el.click();
  } catch { await el.click({ force: true }).catch(() => {}); }
  ctl.log(`  clicked send button${desc ? ` ("${desc}")` : ' (icon)'}`);
  return true;
}

// Sends the prompt and CONFIRMS Flow accepted it (the prompt bar empties). If the send button did nothing,
// falls back to Enter, then Ctrl+Enter, then re-types the prompt and tries again. Never needs a manual Enter.
async function submit(page, box, cfg, ctl, prompt) {
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      // re-type with real key events in case the framework never registered the fill()
      box = (await findVisible(page, cfg.selectors.promptBox, { timeout: 3000 })) || box;
      await box.click({ timeout: 4000 }).catch(() => {});
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(prompt, { delay: 5 });
      await sleep(500);
    }

    if (await clickSendButton(page, box, cfg, ctl)) {
      if (await waitSubmitted(page, cfg, ctl, 3000)) return;
      ctl.log('  send button did not submit; pressing Enter');
    } else {
      ctl.log('  no send button found; pressing Enter');
    }

    box = (await findVisible(page, cfg.selectors.promptBox, { timeout: 2000 })) || box;
    await box.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    if (await waitSubmitted(page, cfg, ctl, 3000)) return;

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    if (await waitSubmitted(page, cfg, ctl, 3000)) return;
    ctl.log(`  prompt still in the box (attempt ${round}/3)`);
  }
  throw new Error('Flow did not accept the prompt (the text stayed in the prompt bar after the send button, Enter and Ctrl+Enter). Use "Inspect Flow page" and set selectors.submitButton in flow.config.json.');
}


/* ------------------------------------------------------------------ *
 *  Settings (aspect ratio, model, outputs) and reference images
 * ------------------------------------------------------------------ */
const escRe = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Matches a label that may be preceded by a small icon/emoji, e.g. "🍌 Nano Banana Pro".
const labelRe = t => new RegExp(`^[^A-Za-z0-9]*${escRe(t)}\\s*$`);

// Smallest ancestor of the prompt box that holds the bar's buttons (same idea as the send-button finder).
const BAR_FINDER = `
  const visible = b => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const btns = n => [...n.querySelectorAll('button, [role="button"]')].filter(visible);
  const findBar = el => { let n = el; for (let d = 0; d < 8 && n; d++, n = n.parentElement) { if (btns(n).length >= 3) return n; } return null; };
`;

// The icon pill at the bottom-right of the prompt bar: "<model> <ratio icon> x2". Click it to open the settings popover.
async function findSettingsButton(page, box, cfg) {
  if (cfg.selectors.settingsButton && cfg.selectors.settingsButton.length) {
    const b = await findVisible(page, cfg.selectors.settingsButton, { timeout: 2500 });
    if (b) return b;
  }
  const boxHandle = await box.elementHandle();
  const modelWords = (cfg.models || []).map(m => m.toLowerCase());
  const handle = await page.evaluateHandle(new Function('[el, modelWords]', `
    ${BAR_FINDER}
    const bar = findBar(el);
    if (!bar) return null;
    const label = b => (b.innerText || b.textContent || '').trim().toLowerCase();
    const right = b => b.getBoundingClientRect().right;
    let c = btns(bar).filter(b => /(^|\\s)x\\s?[1-4]\\b/.test(label(b)));
    if (!c.length) c = btns(bar).filter(b => modelWords.some(m => label(b).includes(m)) || /nano banana|imagen|veo/.test(label(b)));
    return c.sort((a, b) => right(b) - right(a))[0] || null;
  `), [boxHandle, modelWords]);
  await boxHandle.dispose();
  return handle.asElement();
}

// Finds the "+" button at the left of the prompt bar's bottom row.
async function findAddButton(page, box, cfg) {
  if (cfg.selectors.addButton && cfg.selectors.addButton.length) {
    const b = await findVisible(page, cfg.selectors.addButton, { timeout: 2500, enabled: true });
    if (b) return b;
  }
  const boxHandle = await box.elementHandle();
  const handle = await page.evaluateHandle(new Function('el', `
    ${BAR_FINDER}
    const bar = findBar(el);
    if (!bar) return null;
    const label = b => ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || b.textContent || '')).trim();
    const cy = b => { const r = b.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
    const left = b => b.getBoundingClientRect().left;
    const all = btns(bar).filter(b => !b.disabled);
    const plus = all.filter(b => /^(\\+|add|add_2|add_circle|attach|upload)/i.test(label(b)) || /\\badd\\b|attach|upload/i.test(label(b)));
    if (plus.length) return plus.sort((a, b) => cy(b) - cy(a) || left(a) - left(b))[0];
    const lowest = Math.max(...all.map(cy));
    return all.filter(b => cy(b) >= lowest - 14).sort((a, b) => left(a) - left(b))[0] || null;
  `), boxHandle);
  await boxHandle.dispose();
  return handle.asElement();
}

// Number of thumbnails currently sitting in the prompt bar (reference images). Measured as a
// difference from a baseline, so permanent icons in the bar never matter.
async function countAttachments(page, box) {
  const boxHandle = await box.elementHandle();
  try {
    return await page.evaluate(new Function('el', `
      ${BAR_FINDER}
      const bar = findBar(el);
      if (!bar) return 0;
      let n = 0;
      for (const i of bar.querySelectorAll('img, canvas, video')) if (visible(i)) n++;
      for (const d of bar.querySelectorAll('div, span, button')) {
        if (!visible(d)) continue;
        const bg = getComputedStyle(d).backgroundImage;
        if (bg && bg !== 'none' && /url\\(/.test(bg)) n++;
      }
      return n;
    `), boxHandle);
  } finally { await boxHandle.dispose(); }
}

// Finds the settings popover on screen: the nearest ancestor of the ratio buttons that also holds the
// model + "Thinking level" rows. Returns null if the popover is not open.
async function locatePopover(page, timeout = 4000) {
  const probe = await findVisible(page, ['text=/^\\s*9:16\\s*$/', 'button:has-text("9:16")'], { timeout });
  if (!probe) return null;
  const handle = await probe.evaluateHandle(el => {
    let n = el;
    for (let d = 0; d < 10 && n; d++, n = n.parentElement) {
      if (/thinking level|credits/i.test(n.innerText || '')) return n;
    }
    return el.parentElement ? el.parentElement.parentElement || el.parentElement : el;
  });
  return handle.asElement();
}

// Opens the popover if it is closed (never toggles an already-open one shut) and returns a FRESH handle to it.
// Flow re-renders / closes the popover when you change the model, so a handle must never be kept across steps.
async function openSettings(page, box, cfg) {
  let rootEl = await locatePopover(page, 700);
  if (rootEl) return { rootEl };
  const btn = await findSettingsButton(page, box, cfg);
  if (!btn) throw new Error('Could not find the settings pill (model / ratio / xN) in the prompt bar. Use "Inspect Flow page", then set selectors.settingsButton in flow.config.json.');
  await btn.click();
  rootEl = await locatePopover(page, 4000);
  if (!rootEl) throw new Error('Clicked the settings pill but the ratio options did not appear.');
  return { rootEl };
}

// Runs fn(rootEl) against a freshly located popover, then releases the handle.
async function withSettings(page, box, cfg, fn) {
  const { rootEl } = await openSettings(page, box, cfg);
  try { return await fn(rootEl); } finally { await rootEl.dispose().catch(() => {}); }
}

async function clickInRoot(rootEl, text, what) {
  const target = await rootEl.evaluateHandle((root, pattern) => {
    const re = new RegExp(pattern);
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nodes = [...root.querySelectorAll('*')].filter(e => vis(e) && re.test((e.innerText || '').trim()));
    // deepest matching element = the label itself, not a big container
    const leaf = nodes.filter(e => !nodes.some(o => o !== e && e.contains(o)));
    return leaf[0] || null;
  }, labelRe(text).source);
  const el = target.asElement();
  if (!el) throw new Error(`Could not find "${text}" in Flow's settings popover (${what}). Use "Inspect Flow page" to see what Flow shows now.`);
  await el.click();
}

async function popoverOpen(page) {
  return !!(await findVisible(page, ['text=/^\\s*9:16\\s*$/'], { timeout: 600 }));
}

// Best effort: leaves the popover closed if at all possible, but NEVER throws. A popover that stays open must not
// kill the run (the prompt box is usually still reachable), so the worst case is a logged warning.
async function closeSettings(page, box, cfg) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});   // closes an open model menu first, then the popover
    await sleep(300);
    if (!(await popoverOpen(page))) return true;
  }
  const btn = await findSettingsButton(page, box, cfg).catch(() => null);
  if (btn) await btn.click({ timeout: 2000 }).catch(() => {});
  await sleep(300);
  if (!(await popoverOpen(page))) return true;
  // last resort: click an empty corner of the page to dismiss it
  await page.mouse.click(5, 5).catch(() => {});
  await sleep(300);
  return !(await popoverOpen(page));
}

async function readPillText(page, box, cfg) {
  const btn = await findSettingsButton(page, box, cfg);
  return btn ? (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
}

/* ---- Model dropdown ----
 * Flow's model list is a menu that opens from a button inside the settings popover. It is often rendered in a
 * portal OUTSIDE the popover, rows may carry a description line or icon-font text ("check"), and picking a row can
 * close the popover. So: find the trigger inside the popover, look for the wanted row on the whole page, click it,
 * then re-open the popover and verify instead of assuming anything.
 */
const modelRe = name => `(?:^|[^A-Za-z0-9.])${escRe(name)}(?![A-Za-z0-9]|\\.\\d)`;   // "Nano Banana 2.1" ≠ "Nano Banana 2.15"
const modelIn = (text, models) => models.find(m => new RegExp(modelRe(m), 'i').test(String(text || '').replace(/\s+/g, ' '))) || '';

// The dropdown button inside the popover and the model it currently shows.
async function findModelTrigger(page, rootEl, cfg, models) {
  const configured = await findVisible(page, cfg.selectors.modelDropdown || [], { timeout: 500 });
  if (configured) return { el: configured, current: modelIn(await configured.innerText().catch(() => ''), models) };
  const h = await rootEl.evaluateHandle((root, pats) => {
    const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const hits = t => pats.filter(([, src]) => new RegExp(src, 'i').test(t)).length;
    // a trigger shows exactly one model name; containers that list several are not it
    const cands = [...root.querySelectorAll('button, [role="combobox"], [aria-haspopup], [role="button"]')]
      .filter(e => vis(e) && hits(norm(e.innerText)) === 1)
      .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
    if (cands.length) return cands[0];
    // fallback: the deepest element whose text is a model name (clicks bubble up to the real button)
    return [...root.querySelectorAll('*')].find(e => vis(e) && e.children.length === 0 && hits(norm(e.textContent)) === 1) || null;
  }, models.map(m => [m, modelRe(m)]));
  const el = h.asElement();
  if (!el) { await h.dispose().catch(() => {}); return { el: null, current: '' }; }
  return { el, current: modelIn(await el.innerText().catch(() => '') || await el.textContent().catch(() => ''), models) };
}

// The row for `model` in the opened menu. Searches the whole page (menus live in portals), ignores the trigger itself.
async function findModelOption(page, trigger, model, timeout = 3500) {
  const deadline = Date.now() + timeout;
  const re = new RegExp(modelRe(model), 'i');
  for (;;) {
    for (const role of ['option', 'menuitemradio', 'menuitem', 'radio']) {
      try {
        const loc = page.getByRole(role, { name: re });
        const n = Math.min(await loc.count(), 6);
        for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) return loc.nth(i);
      } catch { /* role not present */ }
    }
    const h = await page.evaluateHandle(([trig, nameEsc]) => {
      const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      // text STARTS with the model name (optionally after an emoji / icon word); a description may follow
      const start = new RegExp('^(?:[a-z_]{2,24}\\s+)?[^A-Za-z0-9]*' + nameEsc + '(?![A-Za-z0-9]|\\.\\d)', 'i');
      const nodes = [...document.querySelectorAll('body *')]
        .filter(e => vis(e) && !trig.contains(e) && !e.contains(trig) && start.test(norm(e.innerText)));
      const leaves = nodes.filter(e => !nodes.some(o => o !== e && e.contains(o)));
      return leaves.find(e => e.closest('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="listbox"],[role="menu"]')) || leaves[0] || null;
    }, [trigger, escRe(model)]);
    const el = h.asElement();
    if (el) return el;
    await h.dispose().catch(() => {});
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

// What the page offers as model rows right now (for the log when something goes wrong).
async function describeMenu(page) {
  return page.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    let rows = [...document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')].filter(vis).map(e => norm(e.innerText));
    if (!rows.length) rows = [...document.querySelectorAll('body *')].filter(e => vis(e) && e.children.length === 0 && /nano|banana|imagen|veo|gemini/i.test(e.textContent || '')).map(e => norm(e.textContent));
    return [...new Set(rows.filter(Boolean))].slice(0, 12);
  }).catch(() => []);
}

async function clickRow(el) {
  try { await el.click({ timeout: 4000 }); return; } catch { /* covered / animating: try harder */ }
  try { await el.click({ timeout: 2000, force: true }); return; } catch { /* last resort */ }
  await el.evaluate(e => e.click());
}

// Makes Flow use st.model. Returns true when the popover afterwards shows it, false (with a log) if it could not.
async function selectModel(page, box, cfg, ctl, st) {
  const models = [...new Set([...(cfg.models || []), st.model])];
  let why = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { el: trigger, current, menu } = await withSettings(page, box, cfg, async rootEl => {
      const t = await findModelTrigger(page, rootEl, cfg, models);
      if (!t.el || t.current === st.model || attempt === 4) return { ...t, menu: [] };   // attempt 4 only verifies
      try {
        await t.el.click({ timeout: 5000 });
        await sleep(450);
        const option = await findModelOption(page, t.el, st.model);
        if (option) {
          await clickRow(option);
          await sleep(700);
          return { ...t, menu: null };
        }
        return { ...t, menu: await describeMenu(page) };
      } catch (e) { why = e.message.split('\n')[0]; return { ...t, menu: [] }; }
    }).catch(e => { why = e.message.split('\n')[0]; return { el: null, current: '', menu: [] }; });

    if (current === st.model) return true;
    if (attempt === 4) break;
    if (!trigger) { why = why || 'no model dropdown found in the settings popover'; await sleep(500); continue; }
    if (menu === null) continue;   // a row was clicked: the next pass re-opens the popover and verifies it took
    if (menu.length) {
      // the menu opened but does not list this model: more retries cannot help
      why = `row "${st.model}" not in the menu; Flow lists: ${menu.join(' | ')}`;
      await page.keyboard.press('Escape').catch(() => {}); await sleep(350);
      break;
    }
    if (!why) why = 'the model menu did not open';
    await page.keyboard.press('Escape').catch(() => {}); await sleep(350);   // then re-open the popover from scratch
    ctl.log(`  model menu: attempt ${attempt} failed (${why}); retrying…`);
  }
  ctl.log(`  could not select model "${st.model}"${why ? `: ${why}` : ''}`);
  return false;
}

// Runs one settings step with a hard time limit. A step that fails or hangs is logged and skipped; it never stops the run.
async function softStep(ctl, label, ms, fn) {
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms); })
    ]);
    return true;
  } catch (e) {
    ctl.log(`  ${label}: skipped (${String(e.message).split('\n')[0]})`);
    return false;
  } finally { clearTimeout(timer); }
}

// Sets model, aspect ratio and number of outputs in Flow's popover ONCE per run. Never throws and never blocks:
// every step has its own time limit, a failed step is skipped (Flow keeps whatever is currently selected), and the
// popover is always dismissed afterwards so the prompt bar is free for generating.
// Every step re-opens/re-finds the popover: choosing a model can close or re-render it.
async function applySettings(page, box, cfg, ctl, st) {
  if (cfg.skipSettings) { ctl.log('Skipping Flow settings (skipSettings is on); using whatever Flow currently has selected.'); return; }
  const stepMs = cfg.settingsStepTimeoutMs || 15000;
  ctl.log(`Setting Flow to ${st.model} · ${st.ratio} · x${st.count} (once for this run)…`);
  page.setDefaultTimeout(8000);   // keep every click / lookup in here short instead of Playwright's 30s default
  try {
    await softStep(ctl, 'Image tab', stepMs, () => withSettings(page, box, cfg, r => clickInRoot(r, 'Image', 'Image tab')));
    await sleep(250);

    // Model first: switching model can reset ratio / outputs. A failed model switch just carries on with Flow's model.
    if (!ctl.modelGaveUp) {
      const ok = await softStep(ctl, 'model', stepMs * 3, async () => {
        if (!(await selectModel(page, box, cfg, ctl, st))) throw new Error(`could not select "${st.model}"`);
      });
      if (!ok) {
        ctl.modelGaveUp = true;
        ctl.log('  WARNING: continuing with the model Flow currently has selected. Set the model by hand in Chrome if it is wrong.');
      }
    }
    await closeSettings(page, box, cfg);

    await softStep(ctl, 'aspect ratio', stepMs, () => withSettings(page, box, cfg, r => clickInRoot(r, st.ratio, 'aspect ratio')));
    await sleep(250);
    await softStep(ctl, 'outputs per prompt', stepMs, () => withSettings(page, box, cfg, r => clickInRoot(r, `x${st.count}`, 'outputs per prompt')));
    await sleep(250);
  } finally {
    const closed = await closeSettings(page, box, cfg).catch(() => false);   // never leave a popover / menu open on screen
    if (!closed) ctl.log('  WARNING: the settings popover may still be open; carrying on anyway.');
    page.setDefaultTimeout(30000);
  }

  const pill = await readPillText(page, box, cfg).catch(() => '');
  const okModel = pill.toLowerCase().includes(st.model.toLowerCase());
  const okCount = new RegExp(`x\\s?${st.count}\\b`, 'i').test(pill);
  if (pill && (!okModel || !okCount)) {
    ctl.log(`  WARNING: Flow's prompt bar shows "${pill}" (wanted ${st.model} x${st.count}). Generating with that.`);
  } else {
    ctl.log(`  Flow shows: ${pill || '(pill unreadable)'}`);
  }
}

/* ---- Reference images: upload ONCE, then re-use the asset from Flow's library ----
 * Flow empties the prompt bar after every submit, so each prompt needs the references attached again.
 * Uploading again every time would pile up duplicate assets (flowref-… listed many times in the picker).
 * Instead: the first time a reference is needed it is uploaded (only if the library doesn't already hold it),
 * and every later prompt just opens "+", searches the library for the same file name, picks that asset and
 * clicks "Add to prompt". Names are unique per job (flowref-<jobId>-<n>), so the search finds exactly one.
 */
const baseName = filePath => require('path').basename(filePath).replace(/\.[^.]+$/, '');

// The asset picker = nearest ancestor of its search box that also holds the "Add to prompt" / "Upload media" buttons.
async function findPicker(page, cfg, timeout = 6000) {
  const search = await findVisible(page, cfg.selectors.assetSearch || ["input[placeholder*='Search' i]"], { timeout });
  if (!search) return null;
  const h = await search.evaluateHandle(el => {
    let n = el;
    for (let d = 0; d < 10 && n; d++, n = n.parentElement) {
      if (/add to prompt|upload media/i.test(n.innerText || '')) return n;
    }
    return el.parentElement;
  });
  return { search, root: h.asElement() };
}

// Types the file name into the picker's search box and clicks the matching row. true if a row was clicked.
async function pickFromLibrary(page, picker, name, waitMs) {
  await picker.search.fill('').catch(() => {});
  await picker.search.fill(name).catch(() => {});
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(700);
    const row = await picker.root.evaluateHandle((root, wanted) => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...root.querySelectorAll('*')].filter(e => vis(e) && !e.matches('input, textarea') && (e.innerText || '').trim().toLowerCase().startsWith(wanted.toLowerCase()));
      return nodes.filter(e => !nodes.some(o => o !== e && e.contains(o)))[0] || null;   // deepest = the name label
    }, name).catch(() => null);
    const el = row && row.asElement();
    if (el) { await el.click().catch(() => {}); await sleep(600); return true; }
  }
  return false;
}

// Attaches one reference image to the prompt bar. Uploads it only if Flow's library doesn't have it yet.
async function attachReference(page, box, cfg, ctl, filePath, state) {
  const name = baseName(filePath);
  const before = await countAttachments(page, box);

  const plus = await findAddButton(page, box, cfg);
  if (!plus) throw new Error('Could not find the "+" button in the prompt bar to add a reference image. Set selectors.addButton in flow.config.json.');
  await plus.click();

  const picker = await findPicker(page, cfg);
  if (!picker) throw new Error('The asset picker opened but its search box was not found. Set selectors.assetSearch in flow.config.json.');

  // 1) Already in Flow's library (uploaded earlier in this run or in an earlier run of the job)? Use it.
  //    If we uploaded it ourselves a moment ago, give the library longer to list it, never upload twice.
  const known = state.uploaded.has(name);
  let picked = await pickFromLibrary(page, picker, name, known ? 20000 : 4000);

  // 2) Otherwise upload it, once.
  if (!picked) {
    if (known) throw new Error(`Reference ${name} was uploaded but never showed up in Flow's asset list. Use "Inspect Flow page" and check the asset picker.`);
    await picker.search.fill('').catch(() => {});
    const upload = await findVisible(page, cfg.selectors.uploadButton, { timeout: 6000 });
    if (!upload) throw new Error('The asset picker opened but there is no "Upload media" button. Set selectors.uploadButton in flow.config.json.');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), upload.click()]);
    await chooser.setFiles(filePath);
    state.uploaded.add(name);
    ctl.log(`  uploaded ${name} (once; later prompts re-use it from the library)`);
  } else {
    ctl.log(`  re-using ${name} from Flow's library (no upload)`);
  }

  // Flow may attach it straight away, or leave the picker open waiting for "Add to prompt".
  const deadline = Date.now() + 40000;
  let clicked = false, tried = picked;
  while (Date.now() < deadline) {
    await sleep(1000);
    if ((await countAttachments(page, box)) > before) { if (await findPicker(page, cfg, 300)) await page.keyboard.press('Escape').catch(() => {}); return; }
    if (clicked) continue;
    const add = await findVisible(page, cfg.selectors.addToPromptButton, { timeout: 500, enabled: true });
    if (!add) continue;
    if (!tried) {   // freshly uploaded: select its row first so "Add to prompt" targets this file
      const p2 = (await findPicker(page, cfg, 1500)) || picker;
      tried = await pickFromLibrary(page, p2, name, 8000);
    }
    const add2 = await findVisible(page, cfg.selectors.addToPromptButton, { timeout: 1500, enabled: true });
    if (add2) { await add2.click(); clicked = true; ctl.log('  clicked "Add to prompt"'); }
  }
  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`Could not attach ${name} as a reference (it did not show up in the prompt bar). Use "Inspect Flow page" and check the "+" / asset picker / Add to prompt buttons.`);
}

// Makes sure the job's reference images are in the prompt bar (adds the missing ones, in order).
async function ensureReferences(page, box, cfg, ctl, state, refPaths) {
  if (!refPaths.length) return;
  const have = (await countAttachments(page, box)) - state.baseline;
  if (have >= refPaths.length) return;
  // Flow clears the bar after each submit: attach again from the library, no new upload.
  for (let i = Math.max(0, have); i < refPaths.length; i++) {
    ctl.log(`  attaching reference image ${i + 1}/${refPaths.length}`);
    await attachReference(page, box, cfg, ctl, refPaths[i], state);
    await sleep(500);
  }
}

async function generateOne(page, ctx, cfg, ctl, prompt, seen, pre) {
  const box = await ensurePromptBox(page, cfg, ctl);
  if (pre) await pre(box);

  const baseline = new Set(seen);
  for (const im of await readImages(page, cfg.minImageSize)) baseline.add(keyOf(im.src));
  const baselineLimit = await matchedLimitText(page, cfg.limitTextPatterns);

  await setPrompt(page, box, prompt);
  await submit(page, box, cfg, ctl, prompt);

  const found = new Map();
  const started = Date.now();
  let lastChange = Date.now();

  for (;;) {
    if (ctl.isStopped()) throw coded('STOP', 'Stopped');
    await sleep(1500);

    let imgs = [];
    try { imgs = await readImages(page, cfg.minImageSize); } catch { /* page mid-navigation */ }
    for (const im of imgs) {
      const k = keyOf(im.src);
      if (!baseline.has(k) && !found.has(k)) { found.set(k, im); lastChange = Date.now(); }
    }

    const n = found.size;
    const quiet = Date.now() - lastChange;
    if (n > 0) {
      const target = cfg.expectedPerPrompt > 0 && n >= cfg.expectedPerPrompt;
      if (quiet >= (target ? 1500 : cfg.settleMs)) break;
    } else {
      const hits = (await matchedLimitText(page, cfg.limitTextPatterns)).filter(h => !baselineLimit.includes(h));
      if (hits.length) throw coded('LIMIT', `Flow shows a limit message ("${hits[0]}"). Stopping; resume tomorrow.`);
    }
    if (Date.now() - started > cfg.generationTimeoutMs) {
      if (n > 0) break;
      throw new Error(`No new images appeared within ${Math.round(cfg.generationTimeoutMs / 1000)}s. Check the Chrome window for an error from Flow.`);
    }
  }

  const out = [];
  for (const [k, im] of found) {
    const { buf, type } = await fetchBytes(page, ctx, im.src);
    seen.add(k);
    // Flow can echo the reference thumbnails back as big <img>s: never save those as results.
    if (ctl.refHashes && ctl.refHashes.has(crypto.createHash('sha1').update(buf).digest('hex'))) continue;
    out.push({ buf, ext: sniffExt(buf, type), w: im.w, h: im.h });
  }
  return out;
}

async function runFlow(job, cfg, ctl) {
  const browser = await connect(cfg);
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('Chrome has no open window to control. Click "Launch Chrome".');
    const page = await getFlowPage(ctx, cfg);
    await ensurePromptBox(page, cfg, ctl);

    const st = ctl.settings;
    const refPaths = ctl.refPaths || [];
    for (const it of job.items) if (it.refs && it.refs.length) it.refs = healRefs(it.refs);   // stale paths from an older run
    // Every reference image of the job (project-wide and the per-picture style references): Flow can echo them back as big images.
    const allRefs = new Set([...refPaths, ...job.items.flatMap(i => i.refs || [])]);
    ctl.refHashes = new Set([...allRefs].filter(f => fs.existsSync(f)).map(f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')));
    const runCfg = { ...cfg, expectedPerPrompt: st.count };

    // Apply model / ratio / outputs once, up front, then reference images.
    const box0 = await ensurePromptBox(page, cfg, ctl);
    await applySettings(page, box0, cfg, ctl, st).catch(e => ctl.log(`  settings step failed (${e.message}); generating with Flow's current settings.`));
    const refState = { baseline: await countAttachments(page, box0), uploaded: new Set() };   // uploaded = reference names we put into Flow this run
    if (refState.baseline > 0 && refPaths.length) ctl.log(`  note: the prompt bar already holds ${refState.baseline} thumbnail-like element(s); counting references relative to that.`);

    const seen = new Set();
    for (const im of await readImages(page, cfg.minImageSize)) seen.add(keyOf(im.src));
    ctl.log(`Connected to Flow. Ignoring ${seen.size} image(s) already on the page.`);

    // Before every prompt: top up reference images only. Model / ratio / outputs were set once above and are NOT
    // touched again (re-opening the settings popover for every prompt is what used to make the run hang).
    // A picture may carry its own references (item.refs: the three Tatami style images of a scene). They are mandatory:
    // if one cannot be attached, that prompt is NOT sent without it.
    let current = null;
    const pre = async box => {
      const own = current && Array.isArray(current.refs) && current.refs.length ? current.refs : null;
      try { await ensureReferences(page, box, cfg, ctl, refState, own || refPaths); } catch (e) {
        if (own) throw coded('REF', e.message);
        throw e;
      }
    };

    // Items with the same reference list run together (fewest changes of references).
    const refKey = it => (it.refs || []).join('|');
    const rank = new Map();
    job.items.forEach(it => { if (!rank.has(refKey(it))) rank.set(refKey(it), rank.size); });
    const order = [...job.items].sort((a, b) => rank.get(refKey(a)) - rank.get(refKey(b)) || a.index - b.index);

    for (const item of order) {
      if (item.status === 'done') continue;
      if (ctl.isStopped()) break;
      current = item;
      delete item.needsAttention; delete item.attention;
      if (ctl.reuse && ctl.reuse(item)) { ctl.log(`Prompt ${item.index + 1}/${job.items.length}: same logo as an earlier picture, reused (nothing generated).`); ctl.save(); continue; }
      const missing = (item.refs || []).filter(f => !fs.existsSync(f));
      if (missing.length) {
        item.status = 'failed'; item.attention = 'refs';
        item.error = item.needsAttention = 'Style reference images are missing in assets/style/tatami/';
        ctl.log(`  ${item.error}`); ctl.save(); continue;
      }
      if (ctl.remaining() <= 0) {
        job.status = 'limit';
        ctl.log(`Daily limit of ${cfg.dailyLimit} images reached. Remaining prompts are saved; resume tomorrow.`);
        break;
      }

      item.status = 'running'; item.error = null; item.images = []; item.selected = null;
      ctl.save();
      ctl.log(`Prompt ${item.index + 1}/${job.items.length}: ${item.prompt.slice(0, 70)}${item.prompt.length > 70 ? '…' : ''}`);

      try {
        const shots = await generateOne(page, ctx, runCfg, ctl, item.prompt, seen, pre);
        for (const s of shots) ctl.saveImage(item, s.buf, s.ext, { w: s.w, h: s.h });
        item.status = 'done';
        ctl.log(`  saved ${shots.length} image(s)`);
      } catch (e) {
        if (e.code === 'STOP') { item.status = 'pending'; ctl.log('Stopped.'); break; }
        if (e.code === 'LIMIT') { item.status = 'pending'; job.status = 'limit'; ctl.log(e.message); break; }
        item.status = 'failed'; item.error = e.message;
        if (e.code === 'REF') { item.attention = 'refs'; item.needsAttention = 'Style reference could not be attached, press Retry'; item.error = item.needsAttention; }
        else if (item.person === 'real') { item.attention = 'person'; item.needsAttention = 'Flow gave no image for this real person. Try an animated drawing, or use a real photo.'; }
        ctl.log(`  failed: ${e.message}`);
      }

      try { for (const im of await readImages(page, cfg.minImageSize)) seen.add(keyOf(im.src)); } catch { /* ignore */ }
      ctl.save();
      await sleep(cfg.betweenPromptsMs + Math.random() * 2000);
    }
  } finally {
    await browser.close().catch(() => {}); // disconnects only; your Chrome stays open
  }
}

// Lists what the live Flow page offers so selectors in flow.config.json can be tuned.
async function inspectFlow(cfg) {
  const browser = await connect(cfg);
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('Chrome has no open window.');
    const page = await getFlowPage(ctx, cfg);
    const info = await page.evaluate(() => {
      const vis = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const inputs = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable=''], [contenteditable='true'], [role='textbox']")]
        .filter(vis).map(e => ({
          tag: e.tagName.toLowerCase(),
          placeholder: e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '',
          role: e.getAttribute('role') || ''
        }));
      const buttons = [...document.querySelectorAll("button, [role='button']")].filter(vis).slice(0, 60).map(b => ({
        text: (b.innerText || '').trim().slice(0, 40),
        aria: b.getAttribute('aria-label') || '',
        disabled: !!b.disabled
      }));
      const images = [...document.images].filter(i => i.naturalWidth > 0)
        .map(i => `${i.naturalWidth}x${i.naturalHeight}`);
      return { inputs, buttons, images };
    });
    return { url: page.url(), title: await page.title(), ...info };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runFlow, inspectFlow, _test: { applySettings, ensurePromptBox, getFlowPage, connect, readPillText } };
