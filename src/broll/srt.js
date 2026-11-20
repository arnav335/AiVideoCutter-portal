'use strict';
const pad = (n, w) => String(n).padStart(w, '0');

function fmt(sec) {
  let ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function parseTime(t) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(t).trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

// words: [{start, end, text}] in seconds. One cue per word.
function build(words) {
  return words.map((w, i) => `${i + 1}\n${fmt(w.start)} --> ${fmt(Math.max(w.end, w.start + 0.001))}\n${w.text}\n`).join('\n');
}

function parse(text) {
  const cues = [];
  for (const block of String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTime(a), end = parseTime(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ index: cues.length + 1, start, end, text: lines.slice(ti + 1).join(' ').trim() });
  }
  return cues;
}

const toTranscript = cues => cues.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();

module.exports = { fmt, parseTime, build, parse, toTranscript };
