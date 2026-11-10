
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { SUPPORTED_EXTENSIONS } from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

export async function convertToWav(inputPath, outputPath) {
  const extension = path.extname(inputPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file type: ${extension}`);
  }

  outputPath ??= path.join(
    path.dirname(inputPath),
    `${path.parse(inputPath).name}.wav`
  );

  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-c:a", "pcm_s16le",
    outputPath
  ];

  try {
    await execFileAsync("ffmpeg", args, {
      maxBuffer: 10 * 1024 * 1024
    });

    return outputPath;
  } catch (error) {
    throw new Error(
      `FFmpeg conversion failed: ${error.stderr || error.message}`
    );
  }
}


export async function processInputDirectory() {
  const inputDir = path.resolve("input");
  const outputDir = path.resolve("output");

  await fs.mkdir(outputDir, { recursive: true });

  const files = await fs.readdir(inputDir, { withFileTypes: true });

  const file = files.find(file => file.isFile());

  if (!file) {
    throw new Error("No file found in input directory");
  }

  const inputPath = path.join(inputDir, file.name);
  const extension = path.extname(file.name).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file type: ${extension}`);
  }

  const wavPath = path.join(outputDir, "raw.wav");

  if (extension === ".wav") {
    await fs.copyFile(inputPath, wavPath);
  } else {
    await convertToWav(inputPath, wavPath);
  }

  const outputPath = path.join(outputDir, "output.srt");

  console.log(`Processed: ${file.name}`);

  return [file.name, outputPath];
}