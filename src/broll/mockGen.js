'use strict';
// Test mode: makes placeholder PNGs (in the chosen aspect ratio) so the whole pipeline, including
// the video render, can be tried without Flow or Chrome. Each image shows "prompt-option" in big digits.
const zlib = require('zlib');
const { RATIO_SIZE } = require('./settings');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111', '-': '000000111000000'
};

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

function placeholderPng(W, H, index, variant) {
  const hue = (index * 67 + variant * 40) % 360;
  const c1 = hsl(hue, 0.6, 0.35), c2 = hsl((hue + 50) % 360, 0.65, 0.2);
  const text = `${index + 1}-${variant}`;
  const scale = Math.max(2, Math.floor(H / 5 / 5));
  const tw = text.length * 4 * scale - scale, th = 5 * scale;
  const x0 = Math.floor((W - tw) / 2), y0 = Math.floor((H - th) / 2);
  const raw = Buffer.alloc((1 + W * 3) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2;
      let r = c1[0] + (c2[0] - c1[0]) * t, g = c1[1] + (c2[1] - c1[1]) * t, b = c1[2] + (c2[2] - c1[2]) * t;
      if (y >= y0 && y < y0 + th && x >= x0 && x < x0 + tw) {
        const cx = Math.floor((x - x0) / scale), cy = Math.floor((y - y0) / scale);
        const col = cx % 4;
        const glyph = FONT[text[Math.floor(cx / 4)]];
        if (col < 3 && glyph && glyph[cy * 3 + col] === '1') { r = g = b = 255; }
      }
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

async function runMock(job, cfg, ctl) {
  const st = ctl.settings;
  const [W, H] = RATIO_SIZE[st.ratio] || [1280, 720];
  for (const item of job.items) {
    if (item.status === 'done') continue;
    if (ctl.isStopped()) break;
    if (ctl.reuse && ctl.reuse(item)) { ctl.log(`[test mode] Prompt ${item.index + 1}: same logo as an earlier picture, reused.`); ctl.save(); continue; }
    item.status = 'running'; item.error = null; item.images = []; item.selected = null;
    ctl.save();
    ctl.log(`[test mode] Prompt ${item.index + 1}/${job.items.length}`);
    for (let v = 1; v <= st.count; v++) {
      await sleep(300);
      ctl.saveImage(item, placeholderPng(W, H, item.index, v), 'png', { w: W, h: H }, { countUsage: false });
    }
    item.status = 'done';
    ctl.save();
  }
}

module.exports = { runMock };
