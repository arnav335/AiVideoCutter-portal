'use strict';
/**
 * Claude (claude.ai) as an AI provider, with NO API and NO key.
 * It drives the user's own, already signed-in Chrome through Playwright (connectOverCDP, the same Chrome that Flow uses):
 * open the claude.ai chat, paste the prompt, send it, wait for the answer and read it back.
 *
 *   makeClaudeWeb({ cfg, log }) -> { profile: 'rich', chat({ system, user }) -> JSON text }
 *   inspectClaude(cfg)          -> which selector of each group matches on the open claude.ai tab (for tuning flow.config.json)
 *   readChat() / writeChat(o) / resetChat()   the one shared chat, kept in claude-chat.json in the project root
 *
 * Every selector lives in flow.config.json ("claude"."selectors"), never in this file. The sign-in is never automated.
 */
const fs = require('fs');
const path = require('path');
const { LlmError, parseJson } = require('./llm');
const { ROOT } = require('./config');

const CHAT_URL = /^https:\/\/claude\.ai\/chat\/[0-9a-f-]{36}$/i;
const isChatUrl = u => CHAT_URL.test(String(u || '').trim());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const humanDelay = () => sleep(rand(300, 900));

/* ---------------------------------------------------------------- the shared chat (claude-chat.json) */
const stateFile = () => process.env.CLAUDE_CHAT_FILE || path.join(ROOT, 'claude-chat.json');
const EMPTY = () => ({ chatUrl: '', createdAt: null, messages: 0 });

function readChat(file = stateFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { chatUrl: isChatUrl(j.chatUrl) ? String(j.chatUrl).trim() : '', createdAt: j.createdAt || null, messages: Number(j.messages) || 0 };
  } catch { return EMPTY(); }
}

function writeChat(obj, file = stateFile()) {
  const url = obj && obj.chatUrl ? String(obj.chatUrl).trim() : '';
  if (url && !isChatUrl(url)) throw new Error('That is not a claude.ai chat link (it looks like https://claude.ai/chat/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
  const next = url ? { chatUrl: url, createdAt: (obj && obj.createdAt) || new Date().toISOString(), messages: Number(obj && obj.messages) || 0 } : EMPTY();
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

const resetChat = (file = stateFile()) => writeChat(EMPTY(), file);

/* ---------------------------------------------------------------- Playwright helpers */
function defaultConnect(cfg) {
  let chromium;
  for (const name of ['playwright-core', 'playwright']) { try { chromium = require(name).chromium; break; } catch { /* next */ } }
  if (!chromium) throw new LlmError('Playwright is not installed. Run "npm install" in the project folder.', 'NETWORK');
  return chromium.connectOverCDP(cfg.cdpUrl, { timeout: 10000 });
}

// First visible (and, if asked, enabled) element of any selector in the list.
async function findVisible(page, selectors, { timeout = 3000, enabled = false, poll = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const sel of selectors || []) {
      try {
        const loc = page.locator(sel);
        const n = Math.min(await loc.count(), 10);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if ((await el.isVisible()) && (!enabled || (await el.isEnabled()))) return el;
        }
      } catch { /* invalid selector or the DOM changed while checking: next one */ }
    }
    if (Date.now() >= deadline) return null;
    await sleep(poll);
  }
}

const isVisibleNow = (page, selectors) => findVisible(page, selectors, { timeout: 0 });

// The assistant messages on the page: the selector that finds the most of them wins.
async function assistantMessages(page, selectors) {
  let best = { count: 0, sel: null };
  for (const sel of selectors || []) {
    try { const n = await page.locator(sel).count(); if (n > best.count) best = { count: n, sel }; } catch { /* next */ }
  }
  return best;
}

// Text of the last assistant message; a code block inside it wins (the JSON is usually in one).
async function lastAnswer(page, selectors) {
  const { count, sel } = await assistantMessages(page, selectors);
  if (!count) return { count: 0, text: '' };
  const el = page.locator(sel).nth(count - 1);
  const text = await el.evaluate(node => {
    const code = node.querySelector('pre code') || node.querySelector('pre');
    return String((code && code.innerText) || node.innerText || '');
  }).catch(() => '');
  return { count, text: String(text || '').trim() };
}

const stripFence = t => String(t).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

// Starts like JSON but does not end like JSON: the answer was cut off.
function looksCutOff(text) {
  const t = stripFence(text).trim();
  if (t.startsWith('{')) return !t.endsWith('}');
  if (t.startsWith('[')) return !t.endsWith(']');
  return false;
}

const buildMessage = (system, user) => `<instructions>\n${system}\n</instructions>\n\n<input>\n${user}\n</input>\n\n` +
  'Follow the instructions above. Reply with ONLY the JSON that the instructions describe: no explanation, no markdown fence, no text before or after it.';

/* ---------------------------------------------------------------- one message in a queue */
let tail = Promise.resolve();      // only ONE message is in flight at a time, across every project and retry

function makeClaudeWeb({ cfg, log = () => {}, connect = defaultConnect, file, delay = humanDelay, pollMs = 700 } = {}) {
  const cc = cfg.claude || {};
  const sel = cc.selectors || {};
  const settleMs = cc.settleMs != null ? cc.settleMs : 2500;
  const replyTimeoutMs = cc.replyTimeoutMs || 300000;
  const stuckMs = cc.stuckMs != null ? cc.stuckMs : 25000;
  const startWaitMs = cc.startWaitMs != null ? cc.startWaitMs : 20000;
  const maxContinues = cc.maxContinues != null ? cc.maxContinues : 4;
  const limitPatterns = (cc.limitTextPatterns || []).map(s => String(s).toLowerCase());
  const chatPattern = new RegExp(cc.chatUrlPattern || '^https://claude\\.ai/chat/[0-9a-f-]{36}', 'i');
  const newChatUrl = cc.newChatUrl || 'https://claude.ai/new';
  const stateOf = () => readChat(file);

  async function bodyText(page) { return String(await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')).toLowerCase(); }
  const limitHits = async page => { const t = await bodyText(page); return limitPatterns.filter(p => t.includes(p)); };

  async function openChat(page) {
    const st = stateOf();
    let target = st.chatUrl || newChatUrl;
    const here = () => String(page.url() || '').split(/[?#]/)[0];
    if (here() !== target) { await page.goto(target, { waitUntil: 'domcontentloaded' }); await delay(); }

    const loggedOut = async () => /\/login|\/logout/.test(page.url()) || Boolean(await findVisible(page, sel.loginMarker, { timeout: 1500 }));
    if (await loggedOut()) throw new LlmError('Claude is asking you to sign in. Sign in to claude.ai in the Chrome window once, then try again.', 'AUTH');

    // A saved chat that no longer exists (deleted, or another account): forget it and start a new one.
    if (st.chatUrl) {
      const gone = here() !== st.chatUrl || /(chat|conversation) not found|couldn'?t find (this|that) (chat|conversation)/i.test(await bodyText(page));
      if (gone) {
        log('  The saved Claude chat could not be opened; starting a new chat.');
        resetChat(file);
        target = newChatUrl;
        await page.goto(target, { waitUntil: 'domcontentloaded' }); await delay();
        if (await loggedOut()) throw new LlmError('Claude is asking you to sign in. Sign in to claude.ai in the Chrome window once, then try again.', 'AUTH');
      }
    }
  }

  async function putText(page, text) {
    const box = await findVisible(page, sel.input, { timeout: 20000 });
    if (!box) throw new LlmError('Could not find the message box on claude.ai. Run "npm run inspect:claude" and check the "input" selectors in flow.config.json.', 'EMPTY');
    await page.bringToFront().catch(() => {});
    await box.click(); await delay();
    const kind = await box.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    const length = () => box.evaluate(el => String(el.value != null && el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').trim().length).catch(() => 0);
    if (kind === 'textarea') await box.fill(text);
    else {
      await box.evaluate(el => { el.focus(); document.execCommand('selectAll', false); document.execCommand('delete', false); }).catch(() => {});
      await page.keyboard.insertText(text);
      if (!(await length())) {            // second way: execCommand on the focused editor
        await box.evaluate((el, t) => { el.focus(); document.execCommand('insertText', false, t); }, text).catch(() => {});
      }
    }
    await delay();
    if (!(await length())) throw new LlmError('The prompt could not be pasted into the claude.ai message box.', 'EMPTY');
    return box;
  }

  async function sendAndConfirm(page, box, before) {
    const sent = async () => {
      if ((await assistantMessages(page, sel.assistantMessage)).count > before) return true;
      if (await isVisibleNow(page, sel.stop)) return true;
      const left = await box.evaluate(el => String(el.value != null && el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').trim().length).catch(() => 0);
      return left === 0;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const btn = await findVisible(page, sel.send, { timeout: 4000, enabled: true });
      if (btn) await btn.click(); else await page.keyboard.press('Enter');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { if (await sent()) return; await sleep(pollMs); }
    }
    throw new LlmError('Claude did not accept the message.', 'EMPTY');
  }

  // After pressing Send: make sure Claude really started (Stop button, a new answer, or the last answer's text changed).
  // If nothing happens for startWaitMs the message was probably not sent (long text turned into an attachment, send button disabled): press Send again.
  async function confirmStarted(page, box, before, beforeText, baseHits) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const deadline = Date.now() + startWaitMs;
      while (Date.now() < deadline) {
        if (await isVisibleNow(page, sel.stop)) return true;
        const a = await lastAnswer(page, sel.assistantMessage);
        if (a.count > before || (a.text && a.text !== beforeText)) return true;
        const hits = (await limitHits(page)).filter(h => !baseHits.includes(h));
        if (hits.length) throw new LlmError("Claude's message limit was reached. Try again later (free plan) or switch to Groq.", 'HTTP_429');
        await sleep(pollMs);
      }
      if (attempt === 2) break;
      log('  Claude has not started answering; pressing Send again…');
      await page.bringToFront().catch(() => {});
      const btn = await findVisible(page, sel.send, { timeout: 3000, enabled: true });
      if (btn) await btn.click().catch(() => {}); else await page.keyboard.press('Enter').catch(() => {});
    }
    log('  Claude did not start answering. Look at the claude.ai window: is the message in the box or attached, and is Send available?');
    return false;
  }

  // Waits until Claude has finished: no Stop button, a new answer, and its text unchanged for settleMs.
  // Never hangs silently: a progress line every ~15 s, and if the Stop button / "streaming" flag looks stuck while the text has
  // stopped changing for stuckMs, the answer is taken as finished (a wrong answer is then repaired by the caller).
  async function waitAnswer(page, before, baseHits, beforeText = '') {
    const started = Date.now();
    let last = '', changed = Date.now(), beat = Date.now();
    for (;;) {
      await sleep(pollMs);
      const streaming = Boolean(await isVisibleNow(page, sel.stop));
      const ans = await lastAnswer(page, sel.assistantMessage);
      const fresh = ans.count > before || (Boolean(ans.text) && ans.text !== beforeText);
      if (!fresh || !ans.text) {
        const hits = (await limitHits(page)).filter(h => !baseHits.includes(h));
        if (hits.length) throw new LlmError("Claude's message limit was reached. Try again later (free plan) or switch to Groq.", 'HTTP_429');
      }
      if (ans.text !== last) { last = ans.text; changed = Date.now(); }
      const quiet = Date.now() - changed;
      if (!streaming && fresh && ans.text && quiet >= settleMs) return ans;
      if (streaming && fresh && ans.text && quiet >= stuckMs) { log('  The Stop button is still showing but the answer stopped growing; taking it as finished.'); return ans; }
      if (Date.now() - beat >= 15000) {
        beat = Date.now();
        log(`  Claude is still writing… ${ans.text.length} characters so far${streaming ? '' : fresh ? ' (waiting for the answer to settle)'  : ' (no new answer detected yet: answers on page ' + ans.count + ', before ' + before + ')'}.`);
      }
      if (Date.now() - started > replyTimeoutMs) throw new LlmError(`Claude took too long to answer (${Math.round(replyTimeoutMs / 60000)} min). Check the claude.ai window, then press the button again.`, 'NETWORK');
    }
  }

  // Claude's own raw text via the Copy button of the LAST answer (the page text can differ from what Claude wrote: markdown is rendered).
  async function copyFromClipboard(page, ctx) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://claude.ai' }).catch(() => {});
    let btn = null;
    for (const s of sel.copyButton || []) {
      try {
        const loc = page.locator(s);
        for (let i = (await loc.count()) - 1; i >= 0 && !btn; i--) if (await loc.nth(i).isVisible().catch(() => false)) btn = loc.nth(i);
      } catch { /* next selector */ }
      if (btn) break;
    }
    if (!btn) return '';
    await btn.click().catch(() => {});
    await sleep(300);
    return String(await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')).trim();
  }

  const parses = t => { try { parseJson(t, { save: false }); return true; } catch { return false; } };

  async function exchange(browser, { system, user }) {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new LlmError('Chrome has no open window to control. Press "Launch Chrome" first.', 'NETWORK');
    let page = ctx.pages().find(p => /claude\.ai/.test(p.url()));
    if (!page) page = await ctx.newPage();                  // never the Flow tab, and the user's tabs are never closed

    log('Asking Claude…');
    await openChat(page);
    const baseHits = await limitHits(page);
    const box = await putText(page, buildMessage(system, user));
    const snap = await lastAnswer(page, sel.assistantMessage);
    const before = snap.count, beforeText = snap.text;
    await sendAndConfirm(page, box, before);
    await confirmStarted(page, box, before, beforeText, baseHits);
    log('Claude is answering…');

    let ans = await waitAnswer(page, before, baseHits, beforeText);
    let text = stripFence(ans.text);

    // Cut-off answers: press Continue (or ask for the rest) and join the pieces.
    for (let n = 0; n < maxContinues && (looksCutOff(text) || (await isVisibleNow(page, sel.continueButton))); n++) {
      log(`  The answer was cut off; asking Claude to continue (${n + 1}/${maxContinues})…`);
      const snapC = await lastAnswer(page, sel.assistantMessage);
      const count = snapC.count;
      const btn = await findVisible(page, sel.continueButton, { timeout: 1000, enabled: true });
      if (btn) await btn.click();
      else {
        const b2 = await putText(page, 'Continue exactly where you stopped, output only the rest of the JSON.');
        await sendAndConfirm(page, b2, count);
      }
      await delay();
      const more = await waitAnswer(page, btn ? Math.max(0, count - 1) : count, baseHits, btn ? '' : snapC.text);
      const piece = stripFence(more.text);
      text = more.count > count || !btn ? `${text}${piece}` : (piece.startsWith(text.slice(0, 40)) ? piece : `${text}${piece}`);
    }
    if (looksCutOff(text)) throw new LlmError('The answer was cut off (too long).', 'TRUNCATED');

    if (!text) text = stripFence(await copyFromClipboard(page, ctx));
    if (!text) throw new LlmError('Claude returned an empty answer.', 'EMPTY');

    // The answer does not parse: (1) Claude's raw text through the Copy button, (2) ask Claude to resend it inside a JSON code block.
    if (!parses(text)) {
      const dom = text;
      const raw = stripFence(await copyFromClipboard(page, ctx));
      if (raw && parses(raw)) { log("  Read Claude's raw text with the Copy button."); text = raw; }
      else {
        log('  The answer was not valid JSON; asking Claude to send it again as a JSON code block…');
        const snapR = await lastAnswer(page, sel.assistantMessage);
        const count = snapR.count;
        const b2 = await putText(page, 'Your last reply was not valid JSON. Send the same answer again as ONE valid JSON document inside a single ```json code block, with no text outside the block. Escape every double quote inside a text value as \\" and keep each value on one line.');
        await sendAndConfirm(page, b2, count);
        await confirmStarted(page, b2, count, snapR.text, baseHits);
        await delay();
        const again = await waitAnswer(page, count, baseHits, snapR.text);
        let fixed = stripFence(again.text);
        let raw2 = '';
        if (!parses(fixed)) { raw2 = stripFence(await copyFromClipboard(page, ctx)); if (raw2 && parses(raw2)) fixed = raw2; }
        if (parses(fixed)) text = fixed;
        else {
          try {
            const dir = path.join(cfg.workspace || path.resolve('workspace'), 'broll'); fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'last-claude-debug.json'), JSON.stringify({ pageText: dom, copyButton: raw, resentPageText: again.text, resentCopyButton: raw2 }, null, 2));
          } catch { /* debug file is best effort */ }
          text = dom;
        }
      }
    }

    // Remember the chat (first answer of a new chat) and count the message.
    let st = stateOf();
    if (!st.chatUrl) {
      for (let i = 0; i < 10 && !chatPattern.test(page.url()); i++) await sleep(Math.min(pollMs, 500));
      const url = String(page.url() || '').split(/[?#]/)[0];
      if (isChatUrl(url)) st = writeChat({ chatUrl: url, createdAt: new Date().toISOString(), messages: 0 }, file);
    }
    if (st.chatUrl) {
      st = writeChat({ ...st, messages: st.messages + 1 }, file);
      if (cc.newChatEvery > 0 && st.messages >= cc.newChatEvery) { resetChat(file); log('  Claude chat reset (newChatEvery reached); the next message opens a new chat.'); }
    }
    log(`Got ${text.length} characters.`);
    return text;
  }

  async function run(args) {
    let browser;
    try { browser = await connect(cfg); } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError('Chrome is not connected. Press "Launch Chrome" on the B-roll page first, then try again.', 'NETWORK');
    }
    try {
      try { return await exchange(browser, args); } catch (e) {
        // The user closed the claude.ai tab in the middle of a run: open one again and retry once.
        if (!(e instanceof LlmError) && /closed|Target page|has been closed|detached/i.test(String(e.message))) { log('  The claude.ai tab was closed; opening it again…'); return await exchange(browser, args); }
        throw e;
      }
    } finally {
      await Promise.resolve(browser.close()).catch(() => {});   // only disconnects; the user's Chrome stays open
    }
  }

  return {
    profile: 'rich',
    chat({ system, user }) {
      const job = tail.then(() => run({ system, user }));
      tail = job.catch(() => {});
      return job;
    }
  };
}

/* ---------------------------------------------------------------- selector tuning */
async function inspectClaude(cfg, { connect = defaultConnect } = {}) {
  const sel = (cfg.claude && cfg.claude.selectors) || {};
  let browser;
  try { browser = await connect(cfg); } catch { throw new LlmError('Chrome is not connected. Press "Launch Chrome" first.', 'NETWORK'); }
  try {
    const ctx = browser.contexts()[0];
    const page = ctx && ctx.pages().find(p => /claude\.ai/.test(p.url()));
    if (!page) throw new LlmError('Open claude.ai in the Chrome window first, then run this again.', 'NETWORK');
    const groups = {};
    for (const [name, list] of Object.entries(sel)) {
      const matches = [];
      for (const s of list) {
        let count = 0, visible = 0, html = '';
        try {
          const loc = page.locator(s); count = await loc.count();
          for (let i = 0; i < Math.min(count, 10); i++) if (await loc.nth(i).isVisible()) visible++;
          if (count && ['input', 'send', 'stop', 'assistantMessage'].includes(name)) {
            html = String(await loc.nth(name === 'assistantMessage' ? count - 1 : 0).evaluate(el => el.outerHTML).catch(() => '')).slice(0, 400);
          }
        } catch { /* invalid selector */ }
        matches.push({ selector: s, count, visible, ...(html ? { html } : {}) });
      }
      groups[name] = { firstMatch: (matches.find(m => m.visible) || matches.find(m => m.count) || {}).selector || null, matches };
    }
    return { url: page.url(), title: await page.title().catch(() => ''), chat: readChat(), groups };
  } finally { await Promise.resolve(browser.close()).catch(() => {}); }
}

/* ---------------------------------------------------------------- "Test Claude" (is claude.ai open and signed in?) */
async function checkClaude(cfg, { connect = defaultConnect } = {}) {
  const sel = (cfg.claude && cfg.claude.selectors) || {};
  const newChatUrl = (cfg.claude && cfg.claude.newChatUrl) || 'https://claude.ai/new';
  let browser;
  try { browser = await connect(cfg); } catch { return { ready: false, chrome: false, message: 'Chrome is not connected. Pick a profile and press Launch Chrome first.' }; }
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) return { ready: false, chrome: true, message: 'Chrome has no open window to control. Press Launch Chrome.' };
    let page = ctx.pages().find(p => /claude\.ai/.test(p.url()));
    if (!page) page = await ctx.newPage();
    if (!/claude\.ai/.test(page.url())) await page.goto(newChatUrl, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const out = !!(/\/login|\/logout/.test(page.url()) || await findVisible(page, sel.loginMarker, { timeout: 1500 }));
    if (out) return { ready: false, chrome: true, signedIn: false, message: 'claude.ai is asking you to sign in. Sign in in the Chrome window once, then press Test Claude again.' };
    const box = await findVisible(page, sel.input, { timeout: 8000 });
    if (!box) return { ready: false, chrome: true, signedIn: true, message: 'claude.ai is open but the message box was not found. Run "npm run inspect:claude" to check the selectors.' };
    return { ready: true, chrome: true, signedIn: true, message: 'Claude is ready: claude.ai is open and signed in.' };
  } finally { await Promise.resolve(browser.close()).catch(() => {}); }
}

module.exports = { makeClaudeWeb, inspectClaude, checkClaude, readChat, writeChat, resetChat, isChatUrl, CHAT_URL, buildMessage, looksCutOff, stripFence };
