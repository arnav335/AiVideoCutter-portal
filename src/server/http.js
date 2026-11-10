import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

export const mimeFor = file => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }

  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

// Serve a file with HTTP Range support so <video> can seek.
export async function sendFile(req, res, filePath, { downloadName } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new HttpError(404, "File not found.");
  }

  const headers = {
    "Content-Type": mimeFor(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Last-Modified": stat.mtime.toUTCString()
  };

  if (downloadName) {
    const safe = downloadName.replace(/[^\w.\- ]+/g, "_");
    headers["Content-Disposition"] = `attachment; filename="${safe}"`;
  }

  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }

    if (match[1] === "") {
      // suffix range: last N bytes
      start = Math.max(0, stat.size - Number(match[2]));
    } else {
      start = Number(match[1]);
      if (match[2] !== "") end = Math.min(end, Number(match[2]));
    }

    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }

    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }

  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);

  if (req.method === "HEAD") return res.end();

  fs.createReadStream(filePath, { start, end })
    .on("error", () => res.destroy())
    .pipe(res);
}

// Serve files below `root`, refusing anything that escapes it.
export async function sendStatic(req, res, root, relativePath) {
  const target = path.resolve(root, "." + path.posix.normalize("/" + relativePath));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(403, "Forbidden.");
  }
  return sendFile(req, res, target);
}
