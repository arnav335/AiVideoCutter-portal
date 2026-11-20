// Builds a tiny but valid-looking sfnt file (name, head, OS/2, hhea tables only) so the font
// reader can be tested without shipping a real font. It has no glyphs: it cannot be rendered.

function nameTable(entries) {
  const records = [];
  const strings = [];
  let offset = 0;
  for (const { id, text } of entries) {
    const data = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) data.writeUInt16BE(text.charCodeAt(i), i * 2);
    records.push({ id, length: data.length, offset });
    strings.push(data);
    offset += data.length;
  }
  const header = Buffer.alloc(6 + records.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  records.forEach((r, i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(3, at);          // Windows
    header.writeUInt16BE(1, at + 2);      // Unicode BMP
    header.writeUInt16BE(0x409, at + 4);  // English (US)
    header.writeUInt16BE(r.id, at + 6);
    header.writeUInt16BE(r.length, at + 8);
    header.writeUInt16BE(r.offset, at + 10);
  });
  return Buffer.concat([header, ...strings]);
}

export function makeFont({ family, typoFamily, subfamily = "Regular", weight = 400, italic = false, bold = false, ascent = 900, descent = 300, unitsPerEm = 1000 } = {}) {
  const names = [{ id: 1, text: family }, { id: 2, text: subfamily }, { id: 4, text: `${family} ${subfamily}` }];
  if (typoFamily) names.push({ id: 16, text: typoFamily });

  const head = Buffer.alloc(54);
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeUInt16BE((bold ? 1 : 0) | (italic ? 2 : 0), 44);

  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE((italic ? 1 : 0) | (bold ? 32 : 0), 62);
  os2.writeUInt16BE(ascent, 74);
  os2.writeUInt16BE(descent, 76);

  const hhea = Buffer.alloc(36);
  hhea.writeInt16BE(ascent, 4);
  hhea.writeInt16BE(-descent, 6);

  const tables = [["OS/2", os2], ["head", head], ["hhea", hhea], ["name", nameTable(names)]];
  const dirSize = 12 + tables.length * 16;
  const out = [Buffer.alloc(dirSize)];
  out[0].writeUInt32BE(0x00010000, 0);
  out[0].writeUInt16BE(tables.length, 4);

  let offset = dirSize;
  tables.forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    out[0].write(tag, at, "latin1");
    out[0].writeUInt32BE(offset, at + 8);
    out[0].writeUInt32BE(data.length, at + 12);
    const pad = (4 - (data.length % 4)) % 4;
    out.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
  });
  return Buffer.concat(out);
}
