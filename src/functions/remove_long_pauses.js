
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Convert an SRT timestamp into seconds.
function timestampToSeconds(timestamp) {
  const [hours, minutes, seconds] = timestamp
    .replace(",", ".")
    .split(":")
    .map(Number);

  return hours * 3600 + minutes * 60 + seconds;
}

// Read word timings from the SRT file.
function parseSrt(srtContent) {
  const timestamps = [];

  const regex =
    /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/g;

  let match;

  while ((match = regex.exec(srtContent)) !== null) {
    timestamps.push({
      start: timestampToSeconds(match[1]),
      end: timestampToSeconds(match[2])
    });
  }

  return timestamps;
}

// Combine word intervals separated by short pauses.
function mergeIntervals(words, maxPause) {
  if (words.length === 0) {
    throw new Error("No word timestamps found in the SRT file.");
  }

  const intervals = [];

  let current = { ...words[0] };

  for (let i = 1; i < words.length; i++) {
    const next = words[i];
    const gap = next.start - current.end;

    if (gap <= maxPause) {
      current.end = Math.max(current.end, next.end);
    } else {
      intervals.push(current);
      current = { ...next };
    }
  }

  intervals.push(current);

  return intervals;
}

// Prevent padded segments from overlapping.
function mergeOverlappingSegments(segments) {
  if (segments.length === 0) return [];

  const merged = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const current = merged[merged.length - 1];
    const next = segments[i];

    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }

  return merged;
}

// Get information about the input media file.
async function getMediaInfo(inputPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type:format=duration",
    "-of", "json",
    inputPath
  ]);

  return JSON.parse(stdout);
}

// Main function.
export async function removeLongPauses({
  inputFileName,
  maxPause = 0.8,
  padding = 0.08
} = {}) {
  const inputDir = path.resolve("input");
  const outputDir = path.resolve("output");

  await fs.mkdir(outputDir, { recursive: true });

  const srtPath = path.join(
    outputDir,
    "wordByWordTranscription.srt"
  );

  // Find the original input file.
  const supportedExtensions = [".mp4", ".mp3", ".wav"];

  let inputPath;

  if (inputFileName) {
    inputPath = path.join(
      inputDir,
      path.basename(inputFileName)
    );
  } else {
    const files = await fs.readdir(inputDir, {
      withFileTypes: true
    });

    const mediaFiles = files.filter(file =>
      file.isFile() &&
      supportedExtensions.includes(
        path.extname(file.name).toLowerCase()
      )
    );

    if (mediaFiles.length !== 1) {
      throw new Error(
        `Expected exactly one media file in input/. Found ${mediaFiles.length}. ` +
        "Pass inputFileName if you want to select a specific file."
      );
    }

    inputPath = path.join(inputDir, mediaFiles[0].name);
  }

  const extension = path.extname(inputPath).toLowerCase();

  if (!supportedExtensions.includes(extension)) {
    throw new Error("Unsupported input format.");
  }

  await fs.access(inputPath);
  await fs.access(srtPath);

  if (
    !Number.isFinite(maxPause) ||
    !Number.isFinite(padding) ||
    maxPause < 0 ||
    padding < 0
  ) {
    throw new Error(
      "maxPause and padding must be non-negative finite numbers."
    );
  }

  const outputPath = path.join(
    outputDir,
    `long_pauses_trimmed${extension}`
  );

  // Read and parse SRT.
  const srtContent = await fs.readFile(srtPath, "utf8");
  const words = parseSrt(srtContent);

  if (words.length === 0) {
    throw new Error("No word timestamps found in the SRT file.");
  }

  // Get media duration and stream information.
  const mediaInfo = await getMediaInfo(inputPath);

  const duration = Number(mediaInfo.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine input media duration.");
  }

  const hasVideo = mediaInfo.streams.some(
    stream => stream.codec_type === "video"
  );

  const hasAudio = mediaInfo.streams.some(
    stream => stream.codec_type === "audio"
  );

  if (!hasAudio) {
    throw new Error("Input file does not contain an audio stream.");
  }

  // Remove invalid timestamps and clamp to media duration.
  const validWords = words
    .map(word => ({
      start: Math.max(0, word.start),
      end: Math.min(duration, word.end)
    }))
    .filter(word =>
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.end > word.start
    )
    .sort((a, b) => a.start - b.start);

  if (validWords.length === 0) {
    throw new Error("No valid word timestamps found.");
  }

  // Group words separated by pauses shorter than maxPause.
  const mergedIntervals = mergeIntervals(validWords, maxPause);

  // Add padding around each retained section.
  const paddedSegments = mergedIntervals.map(interval => ({
    start: Math.max(0, interval.start - padding),
    end: Math.min(duration, interval.end + padding)
  }));

  // Prevent overlapping segments from duplicating content.
  const segments = mergeOverlappingSegments(paddedSegments);

  if (segments.length === 0) {
    throw new Error("No valid speech segments were generated.");
  }

  console.log(`Found ${segments.length} speech segments.`);
  console.log("Building FFmpeg filter graph...");

  // Build FFmpeg filter graph.
  const filters = [];

  segments.forEach((segment, index) => {
    const start = segment.start.toFixed(3);
    const end = segment.end.toFixed(3);

    if (hasVideo) {
      filters.push(
        `[0:v:0]trim=start=${start}:end=${end},` +
        `setpts=PTS-STARTPTS[v${index}]`
      );
    }

    filters.push(
      `[0:a:0]atrim=start=${start}:end=${end},` +
      `asetpts=PTS-STARTPTS[a${index}]`
    );
  });

  // IMPORTANT: concat expects each segment's streams together:
  // [v0][a0][v1][a1], NOT [v0][v1][a0][a1].
  if (hasVideo) {
    const concatInputs = segments
      .map((_, index) => `[v${index}][a${index}]`)
      .join("");

    filters.push(
      `${concatInputs}concat=n=${segments.length}:v=1:a=1[vout][aout]`
    );
  } else {
    const audioInputs = segments
      .map((_, index) => `[a${index}]`)
      .join("");

    filters.push(
      `${audioInputs}concat=n=${segments.length}:v=0:a=1[aout]`
    );
  }

  const filterGraph = filters.join(";");

  // Configure FFmpeg.
  const args = [
    "-y",
    "-i", inputPath,
    "-filter_complex", filterGraph
  ];

  if (hasVideo) {
    args.push(
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k"
    );

    if (extension === ".mp4") {
      args.push("-movflags", "+faststart");
    }
  } else {
    args.push("-map", "[aout]");

    if (extension === ".mp3") {
      args.push(
        "-c:a", "libmp3lame",
        "-q:a", "2"
      );
    } else if (extension === ".wav") {
      args.push("-c:a", "pcm_s16le");
    } else {
      args.push("-c:a", "aac");
    }
  }

  args.push(outputPath);

  console.log("Removing long pauses...");

  try {
    await execFileAsync("ffmpeg", args, {
      maxBuffer: 20 * 1024 * 1024
    });

    console.log("Long pauses removed successfully.");

    return outputPath;

  } catch (error) {
    throw new Error(
      `FFmpeg pause removal failed:\n${error.stderr || error.message}`
    );
  }
}
