'use strict';
/**
 * Logo files. A file named <brand>.png|jpg|jpeg|webp|svg in assets/logos/ is the user's own logo: it is used as it is, with no image
 * generation. It is placed centred on a flat dark (#121212) full frame of the job's aspect ratio.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const { RATIO_SIZE } = require('./settings');
const { LOGO_DIR, LOGO_EXTS } = require('./cardPrompt');

// Scales the logo to fit the frame and centres it on #121212. Returns { buf, ext: 'png', w, h }.
async function logoToFrame(file, ratio) {
  const [W, H] = RATIO_SIZE[ratio] || [1280, 720];
  const ext = path.extname(file).slice(1).toLowerCase();
  const bg = '#121212';

  try {                                                    // sharp (optional) handles every format, including svg
    const sharp = require('sharp');
    const buf = await sharp(file, { density: 300 }).resize(W, H, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toBuffer();
    return { buf, ext: 'png', w: W, h: H };
  } catch (e) { if (e && e.code !== 'MODULE_NOT_FOUND') { /* sharp failed on this file: try ffmpeg */ } }

  const out = path.join(os.tmpdir(), `logo-${process.pid}-${Date.now()}.png`);
  try {
    await ffmpeg.run(['-i', file, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x121212`, '-frames:v', '1', out]);
    return { buf: fs.readFileSync(out), ext: 'png', w: W, h: H };
  } catch (e) {
    if (ext === 'svg') throw new Error('SVG logos need the "sharp" package (run "npm install sharp"), or save the logo as a PNG instead.');
    throw e;
  } finally { fs.rmSync(out, { force: true }); }
}

// "Save as logo": copies a picked image to assets/logos/<brand>.<ext> so every later video uses it. Returns the new path.
function saveLogo(srcFile, brand, dir = LOGO_DIR) {
  const ext = path.extname(srcFile).slice(1).toLowerCase().replace('jpeg', 'jpg');
  const use = LOGO_EXTS.includes(ext) && ext !== 'svg' ? ext : 'png';
  fs.mkdirSync(dir, { recursive: true });
  for (const e of LOGO_EXTS) fs.rmSync(path.join(dir, `${brand}.${e}`), { force: true });   // one file per brand
  const dest = path.join(dir, `${brand}.${use}`);
  fs.copyFileSync(srcFile, dest);
  return dest;
}

module.exports = { logoToFrame, saveLogo };
