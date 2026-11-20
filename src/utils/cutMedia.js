import fs from "node:fs/promises";
import path from "node:path";
import { filterScriptOption, runFfmpeg } from "./ffmpeg.js";
import rounding from "../broll/rounding.js";

const OVERLAY_FPS = 30;
const even = n => Math.max(2, Math.floor(n / 2) * 2);

// B-roll pictures laid over the joined video. `overlays` are [{ file, start, end }] in seconds on the
// OUTPUT timeline (after the cuts); picture k is ffmpeg input k + 1 (input 0 is the video itself).
// Each picture is scaled once and repeated with the loop filter instead of being decoded again for
// every frame, which roughly halves the CPU time of a B-roll export.
//   overlayFit "cover"   fills the frame and crops the edges
//   overlayFit "contain" fits the whole picture inside; the sides stay clear so the video shows through (no black bars)
export function overlayChain({ overlays, overlayFit, size, from, to }) {
  if (!size?.width || !size?.height) throw new Error("The video size is needed to place B-roll pictures.");
  const W = even(size.width);
  const H = even(size.height);
  const fit = overlayFit === "contain"
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

  const filters = [];
  let current = from;
  overlays.forEach((o, k) => {
    const start = o.start.toFixed(3);
    const end = o.end.toFixed(3);
    const length = (o.end - o.start).toFixed(3);
    const out = k === overlays.length - 1 ? to : `vb${k}`;
    // A picture the user placed by hand: keep its shape, scale it to its width and put its centre where they put it.
    const pos = o.pos && [o.pos.cx, o.pos.cy, o.pos.w].every(Number.isFinite) ? o.pos : null;
    const shape = pos ? `scale=${even(Math.round(pos.w * W))}:-2` : fit;
    const centred = "x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:"; // "fit inside": centred, nothing painted around it
    const at = pos ? `x=${(pos.cx * W).toFixed(2)}-w/2:y=${(pos.cy * H).toFixed(2)}-h/2:` : (overlayFit === "contain" ? centred : "");
    // Rounded corners (pictures that are not green-screen cards): the corners turn transparent so the video shows through.
    const round = rounding.filterOf(o.round);
    filters.push(
      `[${k + 1}:v]${shape},setsar=1,${round ? round + "," : ""}format=${round || o.alpha ? "yuva420p" : "yuv420p"},` +
      `loop=loop=-1:size=1:start=0,setpts=N/${OVERLAY_FPS}/TB,trim=duration=${length},setpts=PTS-STARTPTS+${start}/TB[ov${k}]`
    );
    filters.push(`[${current}][ov${k}]overlay=${at}${round || o.alpha ? "format=auto:" : ""}eof_action=pass:enable='between(t,${start},${end})'[${out}]`);
    current = out;
  });
  return filters;
}

// The ffmpeg filter graph that keeps only the given intervals and joins them back to back.
// With `overlays` the joined video gets the B-roll pictures put over it (see overlayChain).
// With `subtitles` ({ file, fontsDir }) it also gets the caption file burned in, on top of the B-roll.
// Both names are relative: ffmpeg runs in the folder that holds them, which avoids the
// quoting trouble of Windows drive letters inside a filter graph.
export function buildFilterGraph({
  intervals, hasVideo, fadeSeconds = 0.008, subtitles = null,
  overlays = [], overlayFit = "cover", size = null
}) {
  const filters = [];

  intervals.forEach((iv, index) => {
    const start = iv.start.toFixed(3);
    const end = iv.end.toFixed(3);
    const length = iv.end - iv.start;

    if (hasVideo) {
      filters.push(
        `[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`
      );
    }

    // Tiny fades at every cut point remove clicks.
    let audio = `[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`;
    if (fadeSeconds > 0 && length > fadeSeconds * 4) {
      audio +=
        `,afade=t=in:st=0:d=${fadeSeconds}` +
        `,afade=t=out:st=${(length - fadeSeconds).toFixed(3)}:d=${fadeSeconds}`;
    }
    filters.push(`${audio}[a${index}]`);
  });

  if (hasVideo) {
    const inputs = intervals.map((_, i) => `[v${i}][a${i}]`).join("");
    const pictures = overlays.length > 0;
    if (subtitles || pictures) {
      filters.push(`${inputs}concat=n=${intervals.length}:v=1:a=1[vcat][aout]`);
      let current = "vcat";
      if (pictures) {
        const to = subtitles ? "vbroll" : "vout";
        filters.push(...overlayChain({ overlays, overlayFit, size, from: current, to }));
        current = to;
      }
      if (subtitles) {
        const options = [`subtitles=${subtitles.file}`];
        if (subtitles.fontsDir) options.push(`fontsdir=${subtitles.fontsDir}`);
        filters.push(`[${current}]${options.join(":")}[vout]`);
      }
    } else {
      filters.push(`${inputs}concat=n=${intervals.length}:v=1:a=1[vout][aout]`);
    }
  } else {
    const inputs = intervals.map((_, i) => `[a${i}]`).join("");
    filters.push(`${inputs}concat=n=${intervals.length}:v=0:a=1[aout]`);
  }

  return filters.join(";\n");
}

// Keep only the given [start, end] intervals (seconds) of a media file and
// join them back to back.
//
// The filter graph is written to a file because a video with hundreds of
// cuts produces a command line too long for Windows (and sometimes Linux).
//
// subtitles: { file, fontsDir, cwd } burns a caption (.ass) file into the video.
// `file` and `fontsDir` are relative to `cwd`.
// overlays: [{ file, start, end }] B-roll pictures (absolute paths, seconds on the output timeline),
// size: { width, height } of the video, overlayFit: "cover" | "contain".
export async function cutMedia({
  inputPath,
  outputPath,
  intervals,
  hasVideo,
  onProgress,
  fadeSeconds = 0.008,
  subtitles = null,
  overlays = [],
  overlayFit = "cover",
  size = null
}) {
  if (!intervals || intervals.length === 0) {
    throw new Error("There is nothing to export: every word is cut.");
  }

  const extension = path.extname(outputPath).toLowerCase();
  const totalSeconds = intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  const burn = hasVideo && subtitles ? subtitles : null;
  const pictures = hasVideo ? overlays || [] : [];

  const scriptPath = `${outputPath}.filter.txt`;
  await fs.writeFile(scriptPath, buildFilterGraph({
    intervals, hasVideo, fadeSeconds, subtitles: burn, overlays: pictures, overlayFit, size
  }), "utf8");

  const args = ["-y", "-i", inputPath];
  for (const picture of pictures) args.push("-i", picture.file);
  args.push(await filterScriptOption(), scriptPath);

  if (hasVideo) {
    args.push(
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k"
    );
    if (extension === ".mp4") args.push("-movflags", "+faststart");
  } else {
    args.push("-map", "[aout]");
    if (extension === ".mp3") args.push("-c:a", "libmp3lame", "-q:a", "2");
    else if (extension === ".wav") args.push("-c:a", "pcm_s16le");
    else args.push("-c:a", "aac", "-b:a", "192k");
  }

  args.push(outputPath);

  try {
    await runFfmpeg(args, {
      cwd: burn?.cwd,
      onProgress: seconds => onProgress?.(Math.min(1, seconds / totalSeconds))
    });
  } finally {
    await fs.rm(scriptPath, { force: true });
  }

  return { outputPath, duration: totalSeconds };
}
