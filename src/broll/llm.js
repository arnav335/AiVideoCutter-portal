'use strict';
/** Gemini (default) or Groq behind one tiny interface: chat({system, user}) → JSON text. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

class LlmError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function errMessage(text) {
  try { const j = JSON.parse(text); return (j.error && (j.error.message || j.error)) || j.message || text; } catch { return text; }
}

async function postJson(url, headers, body, { retries = 4, log = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    } catch (e) {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw new LlmError(`Could not reach the AI service (${e.cause && e.cause.code ? e.cause.code : e.message}).`, 'NETWORK');
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Math.min(60000, (Number(res.headers.get('retry-after')) || 0) * 1000 || 3000 * 2 ** attempt);
      log(`  AI service busy (${res.status}); retrying in ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    const msg = String(errMessage(text)).slice(0, 400);
    if (res.status === 401 || res.status === 403) throw new LlmError(`The AI service rejected the API key (${res.status}): ${msg}`, 'AUTH');
    if (res.status === 404) throw new LlmError(`Model not found: ${msg}`, 'MODEL');
    throw new LlmError(`AI service error ${res.status}: ${msg}`, `HTTP_${res.status}`);
  }
}

// Gemini (Google AI Studio) and Groq (OpenAI-compatible chat API) behind the same chat() call.
function make({ provider = 'gemini', model, apiKey, baseUrl, log }) {
  if (provider === 'gemini') return makeGemini({ model, apiKey, baseUrl, log });
  if (provider === 'groq') return makeGroq({ model, apiKey, baseUrl, log });
  throw new LlmError(`Unknown AI provider "${provider}".`, 'PROVIDER');
}

function makeGemini({ model, apiKey, baseUrl, log }) {
  if (!apiKey) throw new LlmError('Add your Gemini API key first (API keys button, top right, or GEMINI_API_KEY in the .env file).', 'AUTH');
  const base = baseUrl.replace(/\/$/, '');
  return {
    async chat({ system, user, temperature }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: temperature != null ? temperature : 0.3, maxOutputTokens: 16384, responseMimeType: 'application/json' }
      };
      const data = await postJson(`${base}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, body, { log });
      const cand = (data.candidates || [])[0];
      const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || '').join('');
      if (cand && cand.finishReason === 'MAX_TOKENS') throw new LlmError('The answer was cut off (too long).', 'TRUNCATED');
      if (!text || !text.trim()) {
        const why = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || 'no content';
        throw new LlmError(`Gemini returned an empty answer (${why}).`, 'EMPTY');
      }
      return text;
    }
  };
}

function makeGroq({ model, apiKey, baseUrl, log }) {
  if (!apiKey) throw new LlmError('Add your Groq API key first (API keys button, top right, or GROQ_API_KEY in the .env file).', 'AUTH');
  const base = baseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${apiKey}` };

  return {
    // temperature and reasoning ('low' | 'medium' | 'high') are optional per call; the defaults are what every other step uses.
    async chat({ system, user, temperature, reasoning }) {
      const body = {
        model, temperature: temperature != null ? temperature : 0.3, reasoning_effort: reasoning || 'medium', max_completion_tokens: 16384,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }
      };
      let data;
      try {
        data = await postJson(`${base}/chat/completions`, headers, body, { log });
      } catch (e) {
        // A model/API version that rejects an optional field: drop the optional fields and ask again.
        if (e.code === 'HTTP_400' && /response_format|json|reasoning|max_completion_tokens|max_tokens/i.test(e.message)) {
          delete body.response_format; delete body.reasoning_effort; delete body.max_completion_tokens;
          data = await postJson(`${base}/chat/completions`, headers, body, { log });
        } else throw e;
      }
      const choice = (data.choices || [])[0];
      const text = choice && choice.message && choice.message.content;
      if (choice && choice.finish_reason === 'length') throw new LlmError('The answer was cut off (too long).', 'TRUNCATED');
      if (!text || !text.trim()) throw new LlmError('Groq returned an empty answer.', 'EMPTY');
      return text;
    }
  };
}

/* ---- tolerant JSON reading (Claude on claude.ai sometimes adds chatter, labels, comments, trailing commas or unescaped quotes) ---- */
const tryParse = t => { try { return { ok: true, value: JSON.parse(t) }; } catch { return { ok: false }; } };

// Every top-level balanced {...} / [...] block in the text (string-aware), longest first.
function balancedBlocks(t) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const open = t[i];
    if (open !== '{' && open !== '[') continue;
    const stack = []; let inStr = false, esc = false, j = i;
    for (; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) break; }
    }
    if (!stack.length && j < t.length) { out.push(t.slice(i, j + 1)); i = j; }
  }
  return out.sort((x, y) => y.length - x.length);
}

// Repairs the usual slips: comments, trailing commas, raw newlines and unescaped quotes inside strings, smart quotes as delimiters.
function repairJson(t) {
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/\u00A0/g, ' ');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') continue;
      if (c === '\t') { out += '\\t'; continue; }
      if (c === '"') {
        const rest = t.slice(i + 1).match(/^\s*(.)?/)[1];
        if (rest === undefined || ',:}]'.includes(rest)) { inStr = false; out += c; } else out += '\\"';   // a quote inside the text
        continue;
      }
      out += c; continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function saveBadAnswer(text) {
  try {
    const fs = require('fs'), path = require('path');
    const dir = path.join(path.resolve(process.env.WORKSPACE_DIR || 'workspace'), 'broll');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'last-bad-answer.txt');
    fs.writeFileSync(file, String(text));
    return file;
  } catch { return null; }
}

// Tolerates ```json fences, chatter around the JSON and small syntax slips.
function parseJson(text, { save = true } = {}) {
  const raw = String(text);
  const t = raw.replace(/^\uFEFF/, '').trim();
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1].trim());
  const unfenced = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const sources = [unfenced, ...fenced, t];
  const candidates = [];
  for (const src of sources) { candidates.push(src); candidates.push(...balancedBlocks(src)); }
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue; seen.add(c);
    let r = tryParse(c); if (r.ok && r.value && typeof r.value === 'object') return r.value;
    r = tryParse(repairJson(c)); if (r.ok && r.value && typeof r.value === 'object') return r.value;
  }
  // Old behaviour: first bracket to last bracket.
  const a = Math.min(...['{', '['].map(c => { const i = unfenced.indexOf(c); return i < 0 ? Infinity : i; }));
  const b = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'));
  if (Number.isFinite(a) && b > a) { const r = tryParse(repairJson(unfenced.slice(a, b + 1))); if (r.ok) return r.value; }
  const file = save ? saveBadAnswer(raw) : null;
  const start = raw.replace(/\s+/g, ' ').trim().slice(0, 140);
  const err = new LlmError(`The AI answer was not valid JSON. It starts with: "${start}"${file ? ` (the full answer was saved to ${file})` : ''}`, 'BADJSON');
  err.raw = raw;
  throw err;
}

// Live model list (Groq).
async function listModels({ apiKey, baseUrl }) {
  if (!apiKey) throw new LlmError('Add the API key first.', 'AUTH');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) })
    .catch(e => { throw new LlmError(`Could not reach the AI service (${e.message}).`, 'NETWORK'); });
  if (!res.ok) throw new LlmError(`Could not list models (${res.status}): ${String(errMessage(await res.text())).slice(0, 200)}`, 'HTTP');
  const data = await res.json();
  return (data.data || []).map(m => m.id).filter(n => !/whisper|guard|tts|playai|embed|orpheus/i.test(n)).sort();
}

module.exports = { make, parseJson, listModels, LlmError };
