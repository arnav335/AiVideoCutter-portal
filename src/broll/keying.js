'use strict';
/**
 * "Ultra Key": removes the flat green (#00FF00) around the dark UI cards and keeps the card, with alpha.
 * The original picture is never touched; the keyed copy is a separate PNG in <job>/keyed/.
 * Every consumer (preview, video export, Premiere) simply uses the keyed file instead of the original.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');

const DEFAULTS = { enabled: true, color: '0x00FF00', similarity: 0.30, blend: 0.10, despill: true, modes: ['ui', 'material', 'symbol'] };
const settings = cfg => ({ ...DEFAULTS, ...((cfg && cfg.ultraKey) || {}) });

// Only the green card pictures are keyed; full-frame pictures (scene, logo, person) and real images never are.
function isKeyable(mode, cfg) {
  const u = settings(cfg);
  return Boolean(u.enabled && mode && u.modes.includes(mode));
}

// .../jobs/<id>/images/p003_1.jpg  ->  .../jobs/<id>/keyed/p003_1.png
function keyedFile(imagePath) {
  const ext = path.extname(imagePath);
  return path.join(path.dirname(path.dirname(imagePath)), 'keyed', path.basename(imagePath, ext) + '.png');
}

function filterOf(cfg) {
  const u = settings(cfg);
  const color = String(u.color).replace(/^#/, '0x');
  let f = `format=rgba,colorkey=${color}:${Number(u.similarity)}:${Number(u.blend)}`;
  if (u.despill) f += ',despill=type=green:mix=0.5:expand=0.0';
  return f;
}

// True when the keyed copy exists and is not older than the original.
function isFresh(imagePath) {
  try {
    return fs.statSync(keyedFile(imagePath)).mtimeMs >= fs.statSync(imagePath).mtimeMs;
  } catch { return false; }
}

// Creates the keyed PNG when it is missing or older than the original. Throws when ffmpeg fails.
async function ensureKeyed(imagePath, cfg) {
  const out = keyedFile(imagePath);
  if (isFresh(imagePath)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp.png';
  try {
    await ff.run(['-i', imagePath, '-vf', filterOf(cfg), '-frames:v', '1', tmp]);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return out;
}

module.exports = { isKeyable, keyedFile, ensureKeyed, isFresh, filterOf };
