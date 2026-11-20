// Reads what the captions need from a .ttf / .otf file: its family name (the name
// libass looks fonts up by), weight, italic flag and vertical metrics.
// Only the 'name', 'OS/2', 'head' and 'hhea' tables are read.

const NAME_FAMILY = 1;
const NAME_SUBFAMILY = 2;
const NAME_FULL = 4;
const NAME_TYPO_FAMILY = 16;

function decode(buffer, platform) {
  if (platform === 3 || platform === 0) {
    // UTF-16 big endian
    let out = "";
    for (let i = 0; i + 1 < buffer.length; i += 2) out += String.fromCharCode(buffer.readUInt16BE(i));
    return out;
  }
  return buffer.toString("latin1");
}

function readTables(buf) {
  if (buf.length < 12) throw new Error("This file is too small to be a font.");

  const tag = buf.toString("latin1", 0, 4);
  if (tag === "ttcf") throw new Error("Font collections (.ttc) are not supported. Use a single .ttf or .otf file.");
  if (tag === "wOFF" || tag === "wOF2") throw new Error("WOFF fonts are not supported. Use a .ttf or .otf file.");

  const isOtf = tag === "OTTO";
  if (!isOtf && buf.readUInt32BE(0) !== 0x00010000 && tag !== "true") {
    throw new Error("This does not look like a TrueType or OpenType font.");
  }

  const count = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > buf.length) break;
    tables[buf.toString("latin1", at, at + 4)] = { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
  }
  return { tables, isOtf };
}

function readNames(buf, table) {
  const names = new Map(); // nameID -> [{ platform, lang, text }]
  const base = table.offset;
  const count = buf.readUInt16BE(base + 2);
  const storage = base + buf.readUInt16BE(base + 4);

  for (let i = 0; i < count; i++) {
    const at = base + 6 + i * 12;
    if (at + 12 > buf.length) break;
    const platform = buf.readUInt16BE(at);
    const lang = buf.readUInt16BE(at + 4);
    const id = buf.readUInt16BE(at + 6);
    const length = buf.readUInt16BE(at + 8);
    const offset = buf.readUInt16BE(at + 10);
    if (storage + offset + length > buf.length) continue;

    const text = decode(buf.subarray(storage + offset, storage + offset + length), platform).trim();
    if (!text) continue;
    if (!names.has(id)) names.set(id, []);
    names.get(id).push({ platform, lang, text });
  }
  return names;
}

// English Windows names first, then any Windows name, then Mac / Unicode ones.
function pickName(names, id) {
  const list = names.get(id);
  if (!list) return "";
  const rank = n => (n.platform === 3 && n.lang === 0x409 ? 0 : n.platform === 3 ? 1 : n.platform === 1 ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b))[0].text;
}

export function readFontMeta(buf) {
  const { tables, isOtf } = readTables(buf);
  if (!tables.name) throw new Error("This font has no name table.");

  const names = readNames(buf, tables.name);
  const legacyFamily = pickName(names, NAME_FAMILY);
  const family = pickName(names, NAME_TYPO_FAMILY) || legacyFamily;
  if (!family) throw new Error("This font has no family name.");

  let weight = 400;
  let italic = false;
  let ribbiBold = false;
  let ribbiItalic = false;
  let winAscent = 0;
  let winDescent = 0;
  let unitsPerEm = 1000;

  const head = tables.head;
  if (head && head.offset + 46 <= buf.length) {
    unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
    const macStyle = buf.readUInt16BE(head.offset + 44);
    ribbiBold = Boolean(macStyle & 1);
    ribbiItalic = Boolean(macStyle & 2);
    italic = ribbiItalic;
  }

  const os2 = tables["OS/2"];
  if (os2 && os2.offset + 78 <= buf.length) {
    weight = buf.readUInt16BE(os2.offset + 4) || 400;
    const selection = buf.readUInt16BE(os2.offset + 62);
    if (selection & 1) { italic = true; ribbiItalic = true; }
    if (selection & 32) ribbiBold = true;
    winAscent = buf.readUInt16BE(os2.offset + 74);
    winDescent = buf.readUInt16BE(os2.offset + 76);
  }

  // libass sizes text by the OS/2 "win" cell height (ascent + descent).
  let cellUnits = winAscent + winDescent;
  const hhea = tables.hhea;
  if (!cellUnits && hhea && hhea.offset + 8 <= buf.length) {
    cellUnits = buf.readInt16BE(hhea.offset + 4) - buf.readInt16BE(hhea.offset + 6);
  }
  const cell = cellUnits > 0 ? cellUnits / unitsPerEm : 1.15;

  return {
    family,
    legacyFamily: legacyFamily || family,
    subfamily: pickName(names, NAME_SUBFAMILY),
    fullName: pickName(names, NAME_FULL),
    weight: Math.min(1000, Math.max(1, weight)),
    italic,
    ribbiBold,
    ribbiItalic,
    cell: Math.round(cell * 10000) / 10000,
    format: isOtf ? "otf" : "ttf"
  };
}
