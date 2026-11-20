'use strict';
/**
 * Generation settings (aspect ratio, model, outputs per prompt, reference images).
 * Validation lives here so the HTTP layer, jobs and automation all agree.
 */
const fs = require('fs');
const path = require('path');

const RATIO_SIZE = { '16:9': [1280, 720], '4:3': [1024, 768], '1:1': [1024, 1024], '3:4': [768, 1024], '9:16': [720, 1280] };
const MAX_REF_BYTES = 10 * 1024 * 1024;

class SettingsError extends Error {}

function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Returns { ratio, model, count } with defaults filled and values checked against the config.
function normalize(input, cfg) {
  const d = cfg.defaults || {};
  const s = input || {};
  const ratio = String(s.ratio || d.ratio || '16:9');
  const model = String(s.model || d.model || cfg.models[0]);
  const count = Number(s.count === undefined ? d.count || 2 : s.count);
  if (!cfg.ratios.includes(ratio)) throw new SettingsError(`Unknown aspect ratio "${ratio}".`);
  if (!cfg.models.includes(model)) throw new SettingsError(`Unknown model "${model}".`);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new SettingsError('Outputs per prompt must be 1 to 4.');
  return { ratio, model, count };
}

// Decodes data-URL reference images from the request and validates them. Nothing is written yet.
function decodeRefs(refs, cfg) {
  const list = Array.isArray(refs) ? refs : [];
  const max = cfg.maxReferenceImages || 3;
  if (list.length > max) throw new SettingsError(`You can add at most ${max} reference images.`);
  return list.map((r, i) => {
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(String((r && r.data) || ''));
    if (!m) throw new SettingsError(`Reference image ${i + 1} could not be read.`);
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_REF_BYTES) throw new SettingsError(`Reference image ${i + 1} is larger than 10 MB.`);
    const ext = sniffImage(buf);
    if (!ext) throw new SettingsError(`Reference image ${i + 1} must be a PNG, JPG or WebP file.`);
    return { buf, ext, name: String((r && r.name) || `reference ${i + 1}`).slice(0, 120) };
  });
}

// Writes decoded refs into the job folder. File names are unique per job so Flow's asset search finds them.
function saveRefs(decoded, jobId, dir) {
  if (!decoded.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  return decoded.map((r, i) => {
    const file = `flowref-${jobId}-${i + 1}.${r.ext}`;
    fs.writeFileSync(path.join(dir, file), r.buf);
    return { file, name: r.name, url: `/output/jobs/${jobId}/refs/${file}` };
  });
}

module.exports = { normalize, decodeRefs, saveRefs, SettingsError, RATIO_SIZE };
