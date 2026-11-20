import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".mkv", ".webm"];
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a"];
export const SUPPORTED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

export async function probeMedia(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration",
    "-of", "json",
    filePath
  ], { maxBuffer: 5 * 1024 * 1024 });

  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const duration = Number(info.format?.duration);

  // Size of the picture as it is shown (a phone video stored sideways is turned the right way up).
  const video = streams.find(s => s.codec_type === "video");
  let width = Number(video?.width) || 0;
  let height = Number(video?.height) || 0;
  const rotation = Math.abs(Number(
    video?.side_data_list?.find(d => Number.isFinite(Number(d?.rotation)))?.rotation ?? video?.tags?.rotate ?? 0
  ));
  if (Math.round(rotation) % 180 === 90) [width, height] = [height, width];

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: streams.some(s => s.codec_type === "video"),
    hasAudio: streams.some(s => s.codec_type === "audio"),
    width,
    height
  };
}

let subtitlesFilter;

// Burning captions in needs an ffmpeg built with libass (it provides the "subtitles" filter).
export async function hasSubtitlesFilter() {
  if (subtitlesFilter === undefined) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-filters"], { maxBuffer: 5 * 1024 * 1024 });
      subtitlesFilter = /^\s*\S+\s+subtitles\s/m.test(stdout);
    } catch {
      subtitlesFilter = false;
    }
  }
  return subtitlesFilter;
}

let ffmpegMajor;

// ffmpeg >= 7 reads a long filter graph with "-/filter_complex file";
// older versions use "-filter_complex_script file".
export async function filterScriptOption() {
  if (ffmpegMajor === undefined) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", ["-version"]);
      const match = stdout.match(/version\s+[nN]?(\d+)\./);
      ffmpegMajor = match ? Number(match[1]) : 99; // unknown (git build) -> assume new
    } catch {
      ffmpegMajor = 99;
    }
  }
  return ffmpegMajor >= 7 ? "-/filter_complex" : "-filter_complex_script";
}

// Run ffmpeg, reporting progress as seconds of OUTPUT produced.
export function runFfmpeg(args, { onProgress, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args],
      { stdio: ["ignore", "pipe", "pipe"], signal, cwd }
    );

    let stderrTail = "";
    let buffer = "";

    child.stderr.on("data", chunk => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();

      for (const line of lines) {
        const [key, value] = line.split("=");
        if ((key === "out_time_us" || key === "out_time_ms") && onProgress) {
          const micro = Number(value);
          if (Number.isFinite(micro) && micro >= 0) onProgress(micro / 1e6);
        }
      }
    });

    child.on("error", error => {
      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg was not found. Install ffmpeg and make sure it is on your PATH."));
      } else if (error.name === "AbortError") {
        reject(new Error("Cancelled."));
      } else {
        reject(error);
      }
    });

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit ${code}):\n${stderrTail}`));
    });
  });
}
