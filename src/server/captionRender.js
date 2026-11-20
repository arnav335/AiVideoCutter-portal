import fs from "node:fs/promises";
import path from "node:path";

import { jobDir, jobFile } from "./jobs.js";
import { getFont, FONTS_DIR } from "./fonts.js";
import { probeMedia, hasSubtitlesFilter } from "../utils/ffmpeg.js";
import { buildCaptions, buildAss, pickFontFile } from "../shared/captions.js";

const ASS_FILE = "captions.ass";
const FONTS_FOLDER = "capfonts";

// Builds the caption file for an export and returns what cutMedia needs to burn it in,
// or { skipped: "why" } when there is nothing to burn.
//   words / mask / intervals: exactly what the cut uses, so captions line up with the final video.
export async function prepareCaptions(id, { config, words, mask, intervals, videoFile }) {
  const style = config.style;

  const captions = buildCaptions(words, mask, intervals, style);
  if (captions.length === 0) return { skipped: "There were no words left to caption." };

  if (!(await hasSubtitlesFilter())) {
    throw new Error(
      "Your ffmpeg has no subtitle support (libass), so captions cannot be burned in. " +
      "Install a full ffmpeg build (on Windows: the \"full\" build from gyan.dev), or turn captions off."
    );
  }

  const info = await probeMedia(jobFile(id, videoFile));
  if (!info.width || !info.height) throw new Error("Could not read the video size to place the captions.");

  // An added font is copied into its own small folder so libass finds exactly that file.
  const fontsFolder = path.join(jobDir(id), FONTS_FOLDER);
  await fs.rm(fontsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

  let family = style.fontFamily;
  let usesFolder = false;

  if (style.fontId) {
    const entry = await getFont(style.fontId);
    const file = pickFontFile(entry, style);
    if (file) {
      await fs.mkdir(fontsFolder, { recursive: true });
      await fs.copyFile(path.join(FONTS_DIR, entry.id, file.file), path.join(fontsFolder, file.file));
      family = file.assFamily || entry.family;
      usesFolder = true;
    }
    // A font that was removed since falls back to the system font name saved with the style.
  }

  const ass = buildAss({ captions, style, width: info.width, height: info.height, fontFamily: family });
  await fs.writeFile(jobFile(id, ASS_FILE), ass, "utf8");

  return {
    count: captions.length,
    font: family,
    subtitles: { file: ASS_FILE, fontsDir: usesFolder ? FONTS_FOLDER : null, cwd: jobDir(id) }
  };
}
