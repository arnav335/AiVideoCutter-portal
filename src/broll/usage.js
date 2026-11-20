'use strict';
// Daily image counter (Flow's free tier is capped per day). Resets on local midnight.
const fs = require('fs');
const path = require('path');

const file = cfg => path.join(cfg.outputDir, 'usage.json');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function get(cfg) {
  try {
    const u = JSON.parse(fs.readFileSync(file(cfg), 'utf8'));
    if (u.date === today()) return { date: u.date, count: u.count };
  } catch { /* no file yet */ }
  return { date: today(), count: 0 };
}

function set(cfg, count) {
  fs.mkdirSync(cfg.outputDir, { recursive: true });
  fs.writeFileSync(file(cfg), JSON.stringify({ date: today(), count: Math.max(0, count | 0) }));
}

function add(cfg, n) {
  set(cfg, get(cfg).count + n);
}

function remaining(cfg) {
  return cfg.dailyLimit - get(cfg).count;
}

module.exports = { get, set, add, remaining };
