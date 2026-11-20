import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  initStore, createJob, getJob, listJobs, updateJob, deleteJob, subscribe,
  isValidId, jobFile, readJsonFile, writeJob, WORKSPACE, STEP_NAMES
} from "./jobs.js";
import { cleanSettings } from "./settings.js";
import { runPipeline, exportJob, isBusy, cancelPipeline, skipStep, buildSrt, buildTranscript, refreshTextFiles } from "./pipeline.js";
import {
  HttpError, sendJson, readJsonBody, readRawBody, sendFile, sendStatic
} from "./http.js";
import {
  listFonts, addFontFile, removeFont, fontFilePath, searchGoogleFonts, installGoogleFont
} from "./fonts.js";
import {
  setupBroll, handleBrollGlobal, handleBrollJob, handleOutput, brollOnProjectDeleted
} from "./broll.js";
import { SYSTEM_FONTS, sanitizeCaptions } from "../shared/captions.js";
import { buildSegments } from "../shared/editModel.js";
import { SUPPORTED_EXTENSIONS } from "../utils/ffmpeg.js";
import { buildEnhanceMp3, applyEnhancedAudio, revertEnhancedAudio, ADOBE_ENHANCE_URL } from "./enhance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const SHARED_DIR = path.resolve(__dirname, "../shared");
const INPUT_DIR = path.resolve("input");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

function requireJob(id) {
  if (!isValidId(id)) throw new HttpError(404, "Project not found.");
  const job = getJob(id);
  if (!job) throw new HttpError(404, "Project not found.");
  return job;
}

async function listInputFiles() {
  try {
    const entries = await fsp.readdir(INPUT_DIR, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fsp.stat(path.join(INPUT_DIR, entry.name));
      files.push({ name: entry.name, size: stat.size });
    }
    return files;
  } catch {
    return [];
  }
}

async function attachSource(id, originalName, writeTo) {
  const ext = path.extname(originalName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new HttpError(400, `Unsupported file type "${ext || "none"}". Use ${SUPPORTED_EXTENSIONS.join(", ")}.`);
  }
  const file = `source${ext}`;
  await writeTo(jobFile(id, file));
  const { size } = await fsp.stat(jobFile(id, file));
  await updateJob(id, job => {
    job.source = { file, originalName, size, duration: null, hasVideo: null };
    if (job.name === "Untitled project") job.name = path.parse(originalName).name;
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const method = req.method;

  if (parts[0] === "config" && method === "GET") {
    return sendJson(res, 200, {
      speechmatics: Boolean(process.env.SPEECHMATICS_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      googleFontsKey: Boolean(process.env.GOOGLE_FONTS_API_KEY),
      extensions: SUPPORTED_EXTENSIONS,
      adobeEnhanceUrl: ADOBE_ENHANCE_URL
    });
  }

  if (parts[0] === "inputs" && method === "GET") {
    return sendJson(res, 200, await listInputFiles());
  }

  // ---- fonts (shared by every project)
  if (parts[0] === "fonts") {
    // GET /api/fonts -> added fonts + the system fonts we offer
    if (parts.length === 1 && method === "GET") {
      return sendJson(res, 200, { fonts: await listFonts(), system: SYSTEM_FONTS });
    }
    // POST /api/fonts?filename=x.ttf  (raw font file as the body)
    if (parts.length === 1 && method === "POST") {
      const buffer = await readRawBody(req, 40 * 1024 * 1024);
      return sendJson(res, 201, await addFontFile(buffer, { source: "upload" }));
    }
    // GET /api/fonts/<id>/file/<file> -> the font itself, for the browser preview
    if (parts.length === 4 && parts[2] === "file" && (method === "GET" || method === "HEAD")) {
      return sendFile(req, res, await fontFilePath(parts[1], parts[3]));
    }
    // DELETE /api/fonts/<id>
    if (parts.length === 2 && method === "DELETE") {
      await removeFont(parts[1]);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  if (parts[0] === "google-fonts") {
    // GET /api/google-fonts?q=roboto -> search; POST {family} -> download and add
    if (method === "GET") {
      return sendJson(res, 200, await searchGoogleFonts(url.searchParams.get("q") || ""));
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 201, await installGoogleFont(body.family));
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- B-roll: Chrome / Flow, usage counter, API keys
  if (parts[0] === "broll") return handleBrollGlobal(req, res, url, parts);

  if (parts[0] !== "jobs") throw new HttpError(404, "Not found.");

  // /api/jobs
  if (parts.length === 1) {
    if (method === "GET") return sendJson(res, 200, listJobs());

    if (method === "POST") {
      const body = await readJsonBody(req);
      const job = await createJob({ name: body.name, settings: cleanSettings(body.settings) });

      if (body.fromInput) {
        const name = path.basename(String(body.fromInput));
        const from = path.join(INPUT_DIR, name);
        await fsp.access(from).catch(() => { throw new HttpError(400, `"${name}" is not in the input folder.`); });
        await attachSource(job.id, name, dest => fsp.copyFile(from, dest));
      }
      return sendJson(res, 201, getJob(job.id));
    }
    throw new HttpError(405, "Method not allowed.");
  }

  const job = requireJob(parts[1]);
  const id = job.id;
  const action = parts[2];

  if (!action) {
    if (method === "GET") return sendJson(res, 200, job);
    if (method === "DELETE") {
      if (isBusy(id)) throw new HttpError(409, "Wait for processing to finish first.");
      brollOnProjectDeleted(id);
      await deleteJob(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      await updateJob(id, j => {
        if (typeof body.name === "string" && body.name.trim()) j.name = body.name.trim().slice(0, 120);
        if (body.settings) Object.assign(j.settings, cleanSettings(body.settings));
      });
      return sendJson(res, 200, getJob(id));
    }
    throw new HttpError(405, "Method not allowed.");
  }

  if (action === "events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    return subscribe(id, res);
  }

  if (action === "source" && method === "PUT") {
    if (isBusy(id)) throw new HttpError(409, "This project is busy.");
    const name = path.basename(url.searchParams.get("filename") || "upload.mp4");
    await attachSource(id, name, dest => pipeline(req, fs.createWriteStream(dest)));
    return sendJson(res, 200, getJob(id));
  }

  if (action === "run" && method === "POST") {
    const body = await readJsonBody(req);
    const from = STEP_NAMES.includes(body.from) ? body.from : "audio";

    if (!job.source) throw new HttpError(400, "Add a video first.");
    if (isBusy(id)) throw new HttpError(409, "This project is already being processed.");

    if (body.settings) {
      await updateJob(id, j => Object.assign(j.settings, cleanSettings(body.settings)));
    }
    if (body.reTranscribe) await fsp.rm(jobFile(id, "words.raw.json"), { force: true });
    if (from === "ai" && !job.base) throw new HttpError(400, "Process the video first.");

    runPipeline(id, { from });
    return sendJson(res, 202, getJob(id));
  }

  if (action === "cancel" && method === "POST") {
    if (!isBusy(id)) throw new HttpError(409, "Nothing is running for this project.");
    return sendJson(res, 200, { ok: true, ...cancelPipeline(id) });
  }

  if (action === "skip" && method === "POST") {
    if (!isBusy(id)) throw new HttpError(409, "Nothing is running for this project.");
    return sendJson(res, 200, { ok: true, skipped: skipStep(id) });
  }

  // GET /api/jobs/:id/srt?kind=sentence|word  -> subtitles for the video as it will be exported (cuts applied)
  if (action === "srt" && (method === "GET" || method === "HEAD")) {
    const kind = url.searchParams.get("kind") === "word" ? "word" : "sentence";
    const text = await buildSrt(id, kind);
    const base = job.name.replace(/[^\w\- ]+/g, "").trim() || "video";
    const tmp = jobFile(id, `download-${kind}.srt`);
    await fsp.writeFile(tmp, text, "utf8");
    return sendFile(req, res, tmp, { downloadName: `${base}-${kind === "word" ? "words" : "subtitles"}.srt` });
  }

  // GET /api/jobs/:id/transcript  -> plain text of what is left after the cuts
  if (action === "transcript" && (method === "GET" || method === "HEAD")) {
    const text = await buildTranscript(id);
    const base = job.name.replace(/[^\w\- ]+/g, "").trim() || "video";
    const tmp = jobFile(id, "download-transcript.txt");
    await fsp.writeFile(tmp, text, "utf8");
    return sendFile(req, res, tmp, { downloadName: `${base}-transcript.txt` });
  }

  if (action === "review" && method === "GET") {
    const data = await readJsonFile(jobFile(id, "words.json"), null);
    if (!data) throw new HttpError(409, "This project has not been transcribed yet.");

    const edits = await readJsonFile(jobFile(id, "edits.json"), { ranges: [] });
    const ai = await readJsonFile(jobFile(id, "ai.json"), null);
    const captions = sanitizeCaptions(await readJsonFile(jobFile(id, "captions.json"), null));

    return sendJson(res, 200, {
      job,
      words: data.words,
      duration: data.duration,
      segments: buildSegments(data.words),
      edits,
      ai,
      captions
    });
  }

  if (action === "captions" && method === "PUT") {
    const body = await readJsonBody(req);
    await writeJob(id, "captions.json", sanitizeCaptions(body));
    if (job.export?.status === "done" && !job.export.stale) {
      await updateJob(id, j => { j.export.stale = true; });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (action === "edits" && method === "PUT") {
    const body = await readJsonBody(req);
    const data = await readJsonFile(jobFile(id, "words.json"), null);
    if (!data) throw new HttpError(409, "This project has not been transcribed yet.");

    const n = data.words.length;
    const ranges = Array.isArray(body.ranges) ? body.ranges : null;
    const valid = ranges && ranges.every(r =>
      Array.isArray(r) && r.length === 2 &&
      Number.isInteger(r[0]) && Number.isInteger(r[1]) &&
      r[0] >= 0 && r[1] < n && r[0] <= r[1]);
    if (!valid) throw new HttpError(400, "ranges must be [[firstWord, lastWord], ...].");

    await writeJob(id, "edits.json", { ranges, updatedAt: Date.now() });
    await refreshTextFiles(id);   // the saved .srt and transcript follow every edit
    if (job.export?.status === "done" && !job.export.stale) {
      await updateJob(id, j => { j.export.stale = true; });
    }
    return sendJson(res, 200, { ok: true });
  }

  // ---- Adobe Podcast "Enhance Speech": MP3 out, enhanced audio back in
  if (action === "enhance") {
    if (parts[3] === "mp3" && (method === "GET" || method === "HEAD")) {
      if (isBusy(id)) throw new HttpError(409, "This project is busy.");
      const file = await buildEnhanceMp3(id);
      const base = job.name.replace(/[^\w\- ]+/g, "").trim() || "video";
      return sendFile(req, res, file, { downloadName: `${base}-for-adobe.mp3` });
    }
    if (parts[3] === "upload" && method === "PUT") {
      if (isBusy(id)) throw new HttpError(409, "This project is busy.");
      const name = path.basename(url.searchParams.get("filename") || "enhanced.mp3");
      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        throw new HttpError(400, `Unsupported file type "${ext || "none"}". Use ${SUPPORTED_EXTENSIONS.join(", ")}.`);
      }
      const tmp = jobFile(id, `enhance-upload${ext}`);
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        await applyEnhancedAudio(id, tmp, name);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
      return sendJson(res, 200, getJob(id));
    }
    if (!parts[3] && method === "DELETE") {
      if (isBusy(id)) throw new HttpError(409, "This project is busy.");
      await revertEnhancedAudio(id);
      return sendJson(res, 200, getJob(id));
    }
    throw new HttpError(405, "Method not allowed.");
  }

  if (action === "broll") return handleBrollJob(req, res, url, parts);

  if (action === "export" && method === "POST") {
    const body = await readJsonBody(req);
    if (isBusy(id)) throw new HttpError(409, "This project is busy.");
    const pad = Number.isFinite(body.pad) ? Math.min(0.3, Math.max(0, body.pad)) : 0.05;
    const broll = body.broll === true;
    const brollFit = body.brollFit === "contain" ? "contain" : "cover";
    exportJob(id, { pad, broll, brollFit });
    return sendJson(res, 202, getJob(id));
  }

  if (action === "media" && (method === "GET" || method === "HEAD")) {
    const which = parts[3];
    if (which === "base" && job.base) {
      return sendFile(req, res, jobFile(id, job.base.file));
    }
    if (which === "source" && job.source) {
      return sendFile(req, res, jobFile(id, job.source.file));
    }
    if (which === "final" && job.export?.file) {
      const ext = path.extname(job.export.file);
      const downloadName = url.searchParams.has("download")
        ? `${job.name.replace(/[^\w\- ]+/g, "").trim() || "video"}-trimmed${ext}`
        : undefined;
      return sendFile(req, res, jobFile(id, job.export.file), { downloadName });
    }
    throw new HttpError(404, "File not found.");
  }

  throw new HttpError(404, "Not found.");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");

    if (url.pathname.startsWith("/output/")) return await handleOutput(req, res, url);

    if (url.pathname.startsWith("/shared/")) {
      return await sendStatic(req, res, SHARED_DIR, url.pathname.slice("/shared/".length));
    }

    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return await sendStatic(req, res, PUBLIC_DIR, rel);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: error.message });
  }
});

await initStore();
setupBroll();

server.listen(PORT, HOST, () => {
  console.log(`The Silent Shears running at http://${HOST}:${PORT}`);
  console.log(`Projects are stored in ${WORKSPACE}`);
  if (!process.env.SPEECHMATICS_API_KEY) console.log("  ! SPEECHMATICS_API_KEY is not set (needed for transcription)");
  if (!process.env.GROQ_API_KEY) console.log("  ! GROQ_API_KEY is not set (AI cut suggestions will be skipped)");
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.GROQ_API_KEY) {
    console.log("  ! Neither GEMINI_API_KEY nor GROQ_API_KEY is set (needed to plan B-roll)");
  }
});
