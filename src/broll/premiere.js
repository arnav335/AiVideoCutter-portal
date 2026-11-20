'use strict';
/**
 * "Premiere-ready" B-roll: files that sit in the right place the moment they are dropped at 0:00.
 *
 *  1. broll_track.mov: ONE video as long as the exported video, transparent everywhere except where a B-roll
 *     shows (ProRes 4444 with alpha). Put it on V2 at 0:00, above the exported video. Each picture is at its
 *     exact frames, with the position / size chosen on the preview.
 *  2. broll_sequence.xml: a Final Cut Pro 7 XML ("xmeml") that Premiere imports as a sequence. Every picture is its
 *     own clip on V2 at its exact time, with position / scale already applied, so it stays easy to trim or move.
 *
 * Pictures are laid on the EXPORTED timeline (after the cuts), same as the video export. Nothing is held over a gap:
 * a B-roll with no picture simply leaves empty space.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ff = require('./ffmpeg');

const even = n => Math.max(2, Math.floor(n / 2) * 2);
const rounding = require('./rounding');
const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Where a picture sits in a W×H frame, in pixels: { pw, ph, cx, cy } (width, height, centre).
// pos = { cx, cy, w } from dragging on the preview; otherwise the picture fills ("cover") or fits ("contain") the frame.
function placement({ imgW, imgH, W, H, pos, fit }) {
  if (pos && [pos.cx, pos.cy, pos.w].every(Number.isFinite)) {
    const pw = pos.w * W;
    return { pw, ph: pw * imgH / imgW, cx: pos.cx * W, cy: pos.cy * H };
  }
  const k = fit === 'contain' ? Math.min(W / imgW, H / imgH) : Math.max(W / imgW, H / imgH);
  return { pw: imgW * k, ph: imgH * k, cx: W / 2, cy: H / 2 };
}

async function makeTrack({ items, W, H, fps, totalSec, fit, outFile, progress }) {
  const args = ['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${totalSec.toFixed(3)},format=rgba`];
  for (const it of items) args.push('-i', it.imagePath);
  const f = ['[0:v]format=rgba[c0]'];
  items.forEach((it, k) => {
    const pl = it.place;
    const s = it.start.toFixed(3), e = it.end.toFixed(3), len = (it.end - it.start).toFixed(3);
    f.push(
      `[${k + 1}:v]scale=${even(Math.round(pl.pw))}:${even(Math.round(pl.ph))},setsar=1,format=rgba,${rounding.filterOf(it.round) ? rounding.filterOf(it.round) + ',format=rgba,' : ''}` +
      `loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,trim=duration=${len},setpts=PTS-STARTPTS+${s}/TB[p${k}]`
    );
    f.push(
      `[c${k}][p${k}]overlay=x=${(pl.cx).toFixed(2)}-w/2:y=${(pl.cy).toFixed(2)}-h/2:eof_action=pass:format=auto:enable='between(t,${s},${e})'[c${k + 1}]`
    );
  });
  f.push(`[c${items.length}]format=yuva444p10le[out]`);
  await ff.run([
    ...args, '-filter_complex', f.join(';'), '-map', '[out]', '-r', String(fps), '-an',
    ...ff.fileThreadArgs(), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0',
    outFile
  ]);
  progress && progress(items.length, items.length);
}

function makeXml({ items, W, H, fps, totalFrames, name }) {
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const clips = items.map((it, k) => {
    const a = Math.round(it.start * fps), b = Math.max(a + 1, Math.round(it.end * fps));
    const pl = it.place;
    // Premiere's Basic Motion: scale in %, centre as an offset from the middle of the frame (fraction of the frame).
    const scale = (pl.pw / it.imgW) * 100;
    const h = (pl.cx - W / 2) / W, v = (pl.cy - H / 2) / H;
    return `
        <clipitem id="clipitem-${k + 1}">
          <name>${esc(path.basename(it.imagePath))}</name>
          <duration>${b - a}</duration>
          ${rate}
          <start>${a}</start><end>${b}</end><in>0</in><out>${b - a}</out>
          <file id="file-${k + 1}">
            <name>${esc(path.basename(it.imagePath))}</name>
            <pathurl>${esc(pathToFileURL(it.imagePath).href)}</pathurl>
            ${rate}
            <duration>${Math.max(b - a, fps * 60)}</duration>
            <media><video><samplecharacteristics>${rate}<width>${it.imgW}</width><height>${it.imgH}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>
          </file>
          <filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
            <parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale.toFixed(3)}</value></parameter>
            <parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${h.toFixed(5)}</horiz><vert>${v.toFixed(5)}</vert></value></parameter>
          </effect></filter>
        </clipitem>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(name)} B-roll</name>
    <duration>${totalFrames}</duration>
    ${rate}
    <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
        <track>${clips}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;
}

// items: [{ id, start, end, imagePath, pos? }] in seconds on the exported timeline.
async function build({ items, size, fps = 30, totalSec, fit = 'cover', outDir, name = 'Project', log = () => {}, progress = () => {} }) {
  const W = even(size.width), H = even(size.height);
  fps = Math.round(fps) || 30;
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const warnings = [];
  for (const it of sorted) {
    const p = await ff.probe(it.imagePath);
    if (!p.width || !p.height) throw new Error(`Could not read the size of ${path.basename(it.imagePath)}.`);
    it.imgW = p.width; it.imgH = p.height;
    it.place = placement({ imgW: p.width, imgH: p.height, W, H, pos: it.pos, fit });
  }
  const totalFrames = Math.round(Math.max(totalSec, ...sorted.map(i => i.end)) * fps);
  fs.mkdirSync(outDir, { recursive: true });
  const trackFile = path.join(outDir, 'broll_track.mov');
  const xmlFile = path.join(outDir, 'broll_sequence.xml');

  log(`Building one transparent ${W}x${H} track, ${(totalFrames / fps).toFixed(2)} s at ${fps} fps, with ${sorted.length} picture(s)…`);
  await makeTrack({ items: sorted, W, H, fps, totalSec: totalFrames / fps, fit, outFile: trackFile, progress });
  fs.writeFileSync(xmlFile, makeXml({ items: sorted, W, H, fps, totalFrames, name }), 'utf8');
  const bytes = fs.statSync(trackFile).size;
  log(`Done: broll_track.mov (${(bytes / 1048576).toFixed(0)} MB) and broll_sequence.xml`);
  return { warnings, width: W, height: H, fps, durationSec: +(totalFrames / fps).toFixed(3), trackFile, xmlFile, trackBytes: bytes, count: sorted.length };
}

module.exports = { build, placement, makeXml };
