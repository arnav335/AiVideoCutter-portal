import fs from "node:fs/promises";
import path from "node:path";
import { filterScriptOption, runFfmpeg } from "./ffmpeg.js";

// Keep only the given [start, end] intervals (seconds) of a media file and
// join them back to back.
//
// The filter graph is written to a file because a video with hundreds of
// cuts produces a command line too long for Windows (and sometimes Linux).
export async function cutMedia({
  inputPath,
  outputPath,
  intervals,
  hasVideo,
  onProgress,
  fadeSeconds = 0.008
}) {
  if (!intervals || intervals.length === 0) {
    throw new Error("There is nothing to export: every word is cut.");
  }

  const extension = path.extname(outputPath).toLowerCase();
  const totalSeconds = intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);

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
    filters.push(`${inputs}concat=n=${intervals.length}:v=1:a=1[vout][aout]`);
  } else {
    const inputs = intervals.map((_, i) => `[a${i}]`).join("");
    filters.push(`${inputs}concat=n=${intervals.length}:v=0:a=1[aout]`);
  }

  const scriptPath = `${outputPath}.filter.txt`;
  await fs.writeFile(scriptPath, filters.join(";\n"), "utf8");

  const args = ["-y", "-i", inputPath, await filterScriptOption(), scriptPath];

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
      onProgress: seconds => onProgress?.(Math.min(1, seconds / totalSeconds))
    });
  } finally {
    await fs.rm(scriptPath, { force: true });
  }

  return { outputPath, duration: totalSeconds };
}
