'use strict';
/**
 * Speechmatics batch transcription (v2 REST API): upload → poll → fetch json-v2 → word list.
 * Models: "enhanced" (highest accuracy for one language), "melia-1" (multilingual, language "multi"), "standard".
 */
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(url, apiKey, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) } });
  } catch (e) {
    throw new Error(`Could not reach Speechmatics (${e.cause && e.cause.code ? e.cause.code : e.message}). Check your internet connection.`);
  }
  if (res.ok) return res;
  let detail = '';
  try { const j = await res.json(); detail = j.detail || j.error || j.message || JSON.stringify(j); } catch { /* not json */ }
  if (res.status === 401 || res.status === 403) throw new Error(`Speechmatics rejected the API key (${res.status}). ${detail}`.trim());
  if (res.status === 402) throw new Error(`Speechmatics says the account has no credit or quota left. ${detail}`.trim());
  throw new Error(`Speechmatics error ${res.status}: ${detail || res.statusText}`);
}

async function fileBlob(file) {
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(file, { type: 'audio/wav' });
  return new Blob([await fs.promises.readFile(file)], { type: 'audio/wav' });
}

async function transcribe({ apiKey, baseUrl, file, model, language, pollMs = 3000, log = () => {}, timeoutMs = 3 * 3600 * 1000 }) {
  const base = baseUrl.replace(/\/$/, '');
  const lang = model === 'melia-1' ? 'multi' : (language || 'en');
  const config = { type: 'transcription', transcription_config: { language: lang, model } };

  const fd = new FormData();
  fd.append('config', JSON.stringify(config));
  fd.append('data_file', await fileBlob(file), path.basename(file));
  log(`Uploading audio to Speechmatics (model ${model}, language ${lang})…`);
  const created = await (await call(`${base}/jobs/`, apiKey, { method: 'POST', body: fd })).json();
  const id = created.id;
  if (!id) throw new Error('Speechmatics did not return a job id.');
  log(`Speechmatics job ${id} created. Waiting for the transcript…`);

  const started = Date.now();
  for (;;) {
    await sleep(pollMs);
    const { job } = await (await call(`${base}/jobs/${id}`, apiKey)).json();
    if (job.status === 'done') break;
    if (job.status === 'rejected' || job.status === 'deleted' || job.status === 'expired') {
      const why = (job.errors || []).map(e => e.message).join('; ');
      throw new Error(`Speechmatics ${job.status} the job${why ? `: ${why}` : '.'}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error('Speechmatics took too long to finish.');
  }
  log('Transcript ready. Downloading word timings…');
  return (await call(`${base}/jobs/${id}/transcript?format=json-v2`, apiKey)).json();
}

// json-v2 → [{start, end, text}] with punctuation glued onto the neighbouring word.
function jsonToWords(json) {
  const out = [];
  let prefix = '';
  for (const r of json.results || []) {
    const alt = (r.alternatives || [])[0];
    if (!alt) continue;
    if (r.type === 'word') {
      out.push({ start: Number(r.start_time), end: Number(r.end_time), text: prefix + alt.content });
      prefix = '';
    } else if (r.type === 'punctuation') {
      if (r.attaches_to === 'next' || !out.length) prefix += alt.content;
      else out[out.length - 1].text += alt.content;
    }
  }
  return out.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end));
}

module.exports = { transcribe, jsonToWords };
