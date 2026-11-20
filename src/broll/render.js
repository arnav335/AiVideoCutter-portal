'use strict';
/**
 * Turns the chosen B-roll images into separate video clips, one file per image. Nothing is stitched together.
 *
 *  - Each clip is exactly the image: same pixel size (an odd side loses 1 px, because H.264 needs even sizes),
 *    no black bars, no transparency, fixed 30 fps, no audio.
 *  - No time is missing: clip N runs from its own start up to the START of clip N+1. A silent stretch between two
 *    B-rolls is therefore held on the previous image. The first clip begins at 0:00 and the last one runs to
 *    the end of the audio. Put the files on a timeline back to back, in number order, and every image sits
 *    exactly where its line is spoken; the total length equals the audio length.
 *  - Lengths are whole frames, so the clips add up to the exact total frame count.
 *  - timeline.csv / timeline.json list the exact start/end of every clip.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const srt = require('./srt');

const FPS = 30;
const tag = t => `${String(Math.floor(t / 60)).padStart(2, '0')}m${(t % 60).toFixed(3).padStart(6, '0')}s`;
const csvCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const CLIP_RE = /^broll_\d{3}_.*\.mp4$/;

// Frame-exact, gap-free layout. items need { start, imagePath } (seconds); returns clips with frame numbers.
function layout(items, durationSec) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const lastEnd = Math.max(0, ...sorted.map(i => i.end || 0));
  const totalFrames = Math.round(Math.max(durationSec || 0, lastEnd) * FPS);
  const warnings = [];
  const starts = [];
  for (const it of sorted) {
    const fa = Math.round(it.start * FPS);
    if (starts.length && fa <= starts[starts.length - 1].fa) { warnings.push(`${it.id} starts in the same frame as the previous B-roll and was left out.`); continue; }
    if (fa >= totalFrames) { warnings.push(`${it.id} starts after the end of the audio and was left out.`); continue; }
    starts.push({ ...it, fa });
  }
  const clips = starts.map((c, n) => ({ ...c, fa: n === 0 ? 0 : c.fa, fb: n + 1 < starts.length ? starts[n + 1].fa : totalFrames }));
  return { clips, totalFrames, warnings };
}

async function render({ items, durationSec, outDir, urlBase, extraDir = null, log = () => {}, progress = () => {} }) {
  const { clips, totalFrames, warnings } = layout(items, durationSec);
  if (!clips.length) throw new Error('Nothing to render.');

  // Only our own files are removed from a previous run, never the whole folder.
  const clipDir = path.join(outDir, 'clips');
  fs.mkdirSync(clipDir, { recursive: true });
  for (const f of fs.readdirSync(clipDir)) if (CLIP_RE.test(f)) fs.rmSync(path.join(clipDir, f), { force: true });

  // Each clip keeps its own image's size.
  const sizes = new Set();
  for (const c of clips) {
    const p = await ff.probe(c.imagePath);
    if (!p.width || !p.height) throw new Error(`Could not read the size of ${path.basename(c.imagePath)}.`);
    c.w = p.width - (p.width % 2); c.h = p.height - (p.height % 2);
    if (c.w !== p.width || c.h !== p.height) c.trimmed = `${p.width}x${p.height}`;
    sizes.add(`${c.w}x${c.h}`);
  }
  const trimmed = clips.filter(c => c.trimmed);
  if (trimmed.length) warnings.push(`H.264 needs even sizes, so ${trimmed.length} image(s) lost 1 px on an odd side (for example ${trimmed[0].trimmed} became ${trimmed[0].w}x${trimmed[0].h}).`);
  if (sizes.size > 1) warnings.push(`The chosen images have different sizes (${[...sizes].join(', ')}). Each clip keeps its own size; your editor will scale them.`);
  log(`${clips.length} clip(s), ${FPS} fps, ${sizes.size === 1 ? [...sizes][0] : 'image size'} each, covering the whole audio (${(totalFrames / FPS).toFixed(3)} s) with no gaps.`);

  progress(0, clips.length);
  for (const [n, c] of clips.entries()) {
    const st = c.fa / FPS, en = c.fb / FPS;
    c.clipFile = `broll_${String(n + 1).padStart(3, '0')}_${tag(st)}-${tag(en)}.mp4`;
    log(`Clip ${n + 1}/${clips.length}: ${c.id}  ${srt.fmt(st)} → ${srt.fmt(en)}  (${(en - st).toFixed(3)} s)`);
    await ff.run([
      '-loop', '1', '-framerate', String(FPS), '-i', c.imagePath,
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p',
      '-frames:v', String(c.fb - c.fa), '-r', String(FPS), '-an',
      ...ff.fileThreadArgs(), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      path.join(clipDir, c.clipFile)
    ]);
    progress(n + 1, clips.length);
  }

  // Timeline files.
  const timeline = clips.map((c, n) => ({
    n: n + 1, id: c.id, start: +(c.fa / FPS).toFixed(3), end: +(c.fb / FPS).toFixed(3), duration: +((c.fb - c.fa) / FPS).toFixed(3),
    startSrt: srt.fmt(c.fa / FPS), endSrt: srt.fmt(c.fb / FPS), startFrame: c.fa, endFrame: c.fb, width: c.w, height: c.h,
    clip: `clips/${c.clipFile}`, file: c.clipFile, image: path.basename(c.imagePath), prompt: c.prompt, description: c.description
  }));
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify({ fps: FPS, durationSec: +(totalFrames / FPS).toFixed(3), totalFrames, clips: timeline }, null, 2));
  const head = ['n', 'id', 'start_sec', 'end_sec', 'duration_sec', 'start_srt', 'end_srt', 'clip', 'image', 'description', 'prompt'];
  fs.writeFileSync(path.join(outDir, 'timeline.csv'), [head.join(',')].concat(timeline.map(t =>
    [t.n, t.id, t.start, t.end, t.duration, t.startSrt, t.endSrt, t.file, t.image, t.description, t.prompt].map(csvCell).join(','))).join('\n'));

  // Copy the clips into the folder the person chose (flat: just the clips + the timeline files).
  let outputDir = clipDir;
  if (extraDir) {
    fs.mkdirSync(extraDir, { recursive: true });
    for (const f of fs.readdirSync(extraDir)) if (CLIP_RE.test(f)) fs.rmSync(path.join(extraDir, f), { force: true });
    for (const c of clips) fs.copyFileSync(path.join(clipDir, c.clipFile), path.join(extraDir, c.clipFile));
    for (const f of ['timeline.csv', 'timeline.json']) fs.copyFileSync(path.join(outDir, f), path.join(extraDir, f));
    outputDir = extraDir;
    log(`Clips copied to ${extraDir}`);
  }

  const url = f => `${urlBase}/${f.split(path.sep).join('/')}`;
  return {
    fps: FPS, durationSec: +(totalFrames / FPS).toFixed(3), warnings, outputDir, projectDir: clipDir,
    timeline: { json: url('timeline.json'), csv: url('timeline.csv') },
    clips: timeline.map(t => ({ ...t, url: url(t.clip) }))
  };
}

module.exports = { render, layout, FPS };
