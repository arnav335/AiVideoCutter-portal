'use strict';
/**
 * API keys. Where they are read from (first one found wins):
 *   1. real environment variables
 *   2. the .env file in the project folder   <- the easy place to put them
 *   3. secrets.json (written by the "API keys" window in the portal)
 * The .env file is re-read every time, so you don't need to restart after editing it.
 * Keys are never sent back to the browser, only whether one exists and its last 4 characters.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const FILE = path.join(ROOT, 'secrets.json');
const DOTENV = path.join(ROOT, '.env');
// Each key can be given under more than one environment variable name (first one found wins).
const ENV = {
  speechmatics: ['SPEECHMATICS_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY']
};

function readJson() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// Minimal .env parser: KEY=value, optional quotes, # comments.
function readDotenv() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(DOTENV, 'utf8'); } catch { return out; }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1].startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v.trim();
  }
  return out;
}

function lookup(name) {
  const names = ENV[name] || [];
  for (const envName of names) {
    const real = (process.env[envName] || '').trim();
    if (real) return { key: real, source: 'env', envName };
  }
  const dotenv = readDotenv();
  for (const envName of names) {
    const dot = (dotenv[envName] || '').trim();
    if (dot) return { key: dot, source: 'dotenv', envName };
  }
  const saved = (readJson()[name] || '').trim();
  if (saved) return { key: saved, source: 'saved', envName: names[0] };
  return { key: '', source: null, envName: names[0] };
}

const get = name => (ENV[name] ? lookup(name).key : '');
const envVarOf = name => (ENV[name] ? ENV[name][0] : '');

function set(name, value) {
  if (!ENV[name]) throw new Error('Unknown key name');
  const all = readJson();
  const v = String(value || '').trim();
  if (v) all[name] = v; else delete all[name];
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function status() {
  const out = {};
  for (const name of Object.keys(ENV)) {
    const { key, source, envName } = lookup(name);
    out[name] = { set: !!key, source, hint: key ? '…' + key.slice(-4) : '', envVar: envName };
  }
  return out;
}

module.exports = { get, set, status, envVarOf, names: Object.keys(ENV) };
