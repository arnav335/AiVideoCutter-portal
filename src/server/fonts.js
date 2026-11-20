import fs from "node:fs/promises";
import path from "node:path";

import { WORKSPACE, readJsonFile } from "./jobs.js";
import { HttpError } from "./http.js";
import { readFontMeta } from "../utils/fontMeta.js";

// Added fonts are shared by every project: workspace/fonts/<id>/{font.json, 400.ttf, 700i.ttf, ...}
export const FONTS_DIR = path.join(WORKSPACE, "fonts");

const MAX_FONT_BYTES = 40 * 1024 * 1024;
const CATALOG_FILE = path.join(FONTS_DIR, "google-catalog.json");
const CATALOG_TTL = 7 * 24 * 3600 * 1000;

export const isValidFontId = id => /^[a-z0-9][a-z0-9-]{0,60}$/.test(id || "");

const slug = text => String(text)
  .toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const fontDir = id => path.join(FONTS_DIR, id);

// One writer at a time, so two quick uploads of the same family do not overwrite each other.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------- added fonts

export async function getFont(id) {
  if (!isValidFontId(id)) return null;
  return readJsonFile(path.join(fontDir(id), "font.json"), null).catch(() => null);
}

export async function listFonts() {
  let entries;
  try { entries = await fs.readdir(FONTS_DIR, { withFileTypes: true }); } catch { return []; }

  const fonts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidFontId(entry.name)) continue;
    const font = await getFont(entry.name);
    if (font?.files?.length) fonts.push(font);
  }
  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

// Save one font file. A family collects its faces (regular, bold, italic...) in one entry.
export async function addFontFile(buffer, { source = "upload", family, category } = {}) {
  if (buffer.length > MAX_FONT_BYTES) throw new HttpError(413, "That font file is too large.");

  let meta;
  try { meta = readFontMeta(buffer); } catch (error) { throw new HttpError(400, error.message); }

  const name = family || meta.family;
  const id = slug(name);
  if (!id) throw new HttpError(400, "Could not work out a name for this font.");

  return withLock(async () => {
    await fs.mkdir(fontDir(id), { recursive: true });

    const entry = (await getFont(id)) || { id, family: name, source, category: category || "", files: [] };
    const file = `${meta.weight}${meta.italic ? "i" : ""}.${meta.format}`;

    // A newer file for the same weight and slant replaces the old one.
    for (const old of entry.files.filter(f => f.weight === meta.weight && f.italic === meta.italic)) {
      if (old.file !== file) await fs.rm(path.join(fontDir(id), old.file), { force: true });
    }
    entry.files = entry.files.filter(f => !(f.weight === meta.weight && f.italic === meta.italic));

    await writeAtomic(path.join(fontDir(id), file), buffer);
    entry.files.push({
      file,
      weight: meta.weight,
      italic: meta.italic,
      assFamily: meta.legacyFamily,   // the name libass looks this face up by
      cell: meta.cell,                // font height / size, so the preview matches the burn-in
      format: meta.format
    });
    entry.files.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));

    await writeAtomic(path.join(fontDir(id), "font.json"), JSON.stringify(entry));
    return entry;
  });
}

export async function removeFont(id) {
  if (!isValidFontId(id)) throw new HttpError(404, "Font not found.");
  return withLock(() => fs.rm(fontDir(id), { recursive: true, force: true }));
}

// The path of one of a font's files. The file name must be one the font lists.
export async function fontFilePath(id, file) {
  const font = await getFont(id);
  if (!font || !font.files.some(f => f.file === file)) throw new HttpError(404, "Font not found.");
  return path.join(fontDir(id), file);
}

// ---------------------------------------------------------------- Google Fonts

// A user agent without WOFF2 support makes Google serve plain .ttf files.
const CSS_USER_AGENT = "curl/8.4.0";

async function fetchOk(url, { headers, what }) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new HttpError(502, `Could not reach ${what}. Check your internet connection.`);
  }
  if (!response.ok) throw new HttpError(502, `${what} answered with an error (${response.status}).`);
  return response;
}

// "400" / "700i" -> { w: 400, i: false } ...
const parseKey = key => ({ w: parseInt(key, 10), i: key.endsWith("i") });
const keyOf = v => `${v.w}${v.i ? "i" : ""}`;

// Catalog from Google's public metadata (no key needed).
export function normalizeMetadata(text) {
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ""));
  return (json.familyMetadataList || [])
    .filter(f => f?.family)
    .map(f => ({
      family: f.family,
      category: f.category || "",
      popularity: Number.isFinite(f.popularity) ? f.popularity : 99999,
      variants: Object.keys(f.fonts || {}).filter(k => /^\d{3,4}i?$/.test(k))
    }))
    .filter(f => f.variants.length > 0);
}

// Catalog from the official API (used when GOOGLE_FONTS_API_KEY is set); it lists direct .ttf links.
export function normalizeApi(json) {
  const toKey = v => v === "regular" ? "400" : v === "italic" ? "400i"
    : /^\d+$/.test(v) ? v : /^(\d+)italic$/.test(v) ? `${/^(\d+)/.exec(v)[1]}i` : null;

  return (json.items || []).filter(i => i?.family).map((item, index) => {
    const variants = [];
    const files = {};
    for (const v of item.variants || []) {
      const key = toKey(v);
      if (!key) continue;
      variants.push(key);
      if (item.files?.[v]) files[key] = String(item.files[v]).replace(/^http:/, "https:");
    }
    return { family: item.family, category: item.category || "", popularity: index, variants, files };
  }).filter(f => f.variants.length > 0);
}

let catalogMemo = null;

async function loadCatalog() {
  if (catalogMemo && Date.now() - catalogMemo.at < 3600_000) return catalogMemo.list;

  const cached = await readJsonFile(CATALOG_FILE, null).catch(() => null);
  if (cached?.list?.length && Date.now() - cached.at < CATALOG_TTL) {
    catalogMemo = cached;
    return cached.list;
  }

  try {
    const key = process.env.GOOGLE_FONTS_API_KEY;
    let list;
    if (key) {
      const response = await fetchOk(
        `https://www.googleapis.com/webfonts/v1/webfonts?key=${encodeURIComponent(key)}&sort=popularity`,
        { what: "the Google Fonts API" });
      list = normalizeApi(await response.json());
    } else {
      const response = await fetchOk("https://fonts.google.com/metadata/fonts", { what: "Google Fonts" });
      list = normalizeMetadata(await response.text());
    }
    if (list.length === 0) throw new HttpError(502, "Google Fonts returned an empty list.");

    catalogMemo = { at: Date.now(), list };
    await fs.mkdir(FONTS_DIR, { recursive: true });
    await writeAtomic(CATALOG_FILE, JSON.stringify(catalogMemo));
    return list;
  } catch (error) {
    if (cached?.list?.length) return cached.list; // an old list beats none
    throw error;
  }
}

export async function searchGoogleFonts(query, { limit = 30 } = {}) {
  const catalog = await loadCatalog();
  const installed = new Set((await listFonts()).map(f => f.family.toLowerCase()));
  const q = String(query || "").trim().toLowerCase();

  const scored = [];
  for (const font of catalog) {
    const name = font.family.toLowerCase();
    let rank;
    if (!q) rank = 2;
    else if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else continue;
    scored.push({ font, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.font.popularity - b.font.popularity);

  return scored.slice(0, limit).map(({ font }) => ({
    family: font.family,
    category: font.category,
    styles: font.variants.length,
    installed: installed.has(font.family.toLowerCase())
  }));
}

// Regular, bold, italic and bold italic: the faces the bold / italic switches can use.
export function chooseVariants(variants) {
  const all = variants.map(parseKey);
  const nearest = (italic, want, minWeight = 0) => {
    const pool = all.filter(v => v.i === italic && v.w >= minWeight);
    pool.sort((a, b) => Math.abs(a.w - want) - Math.abs(b.w - want) || b.w - a.w);
    return pool[0] || null;
  };

  const picks = [nearest(false, 400), nearest(false, 700, 600), nearest(true, 400), nearest(true, 700, 600)]
    .filter(Boolean);
  const seen = new Set();
  return picks.filter(v => !seen.has(keyOf(v)) && seen.add(keyOf(v)));
}

export function googleCssUrl(family, picks) {
  const sorted = [...picks].sort((a, b) => Number(a.i) - Number(b.i) || a.w - b.w);
  const hasItalic = sorted.some(v => v.i);
  const tuples = sorted.map(v => (hasItalic ? `${v.i ? 1 : 0},${v.w}` : String(v.w))).join(";");
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${name}:${hasItalic ? "ital,wght" : "wght"}@${tuples}`;
}

export function parseGoogleCss(css) {
  return (css.match(/@font-face\s*\{[^}]*\}/g) || []).map(block => ({
    italic: /font-style:\s*italic/i.test(block),
    weight: Number(/font-weight:\s*(\d+)/i.exec(block)?.[1]) || 400,
    url: /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(block)?.[1] || null,
    format: (/format\(\s*['"]?([\w-]+)/i.exec(block)?.[1] || "").toLowerCase()
  })).filter(f => f.url);
}

async function download(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" || hostname !== "fonts.gstatic.com") {
    throw new HttpError(502, "Google Fonts pointed to an unexpected address, so nothing was downloaded.");
  }
  const response = await fetchOk(url, { what: "Google Fonts" });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FONT_BYTES) throw new HttpError(502, "That font file is too large.");
  return buffer;
}

export async function installGoogleFont(family) {
  const catalog = await loadCatalog();
  const item = catalog.find(f => f.family.toLowerCase() === String(family || "").toLowerCase());
  if (!item) throw new HttpError(404, `"${family}" is not in the Google Fonts list.`);

  const picks = chooseVariants(item.variants);
  let sources;

  if (item.files) {
    sources = picks.map(v => ({ ...v, url: item.files[keyOf(v)] })).filter(s => s.url);
  } else {
    const response = await fetchOk(googleCssUrl(item.family, picks), {
      headers: { "User-Agent": CSS_USER_AGENT },
      what: "Google Fonts"
    });
    const parsed = parseGoogleCss(await response.text());
    if (parsed.some(f => f.format === "woff2" || /\.woff2?($|\?)/.test(f.url))) {
      throw new HttpError(502,
        "Google sent web-font files that ffmpeg cannot use. Add a free GOOGLE_FONTS_API_KEY to .env and try again, " +
        "or download the font from fonts.google.com and use \"Upload font\".");
    }
    sources = parsed.map(f => ({ w: f.weight, i: f.italic, url: f.url }));
  }

  if (sources.length === 0) throw new HttpError(502, "Google Fonts did not return any files for this font.");

  let entry = null;
  for (const source of sources) {
    entry = await addFontFile(await download(source.url), {
      source: "google", family: item.family, category: item.category
    });
  }
  return entry;
}
