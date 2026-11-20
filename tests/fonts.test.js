import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { makeFont } from "./helpers/makeFont.js";
import { readFontMeta } from "../src/utils/fontMeta.js";

// The font store lives in WORKSPACE_DIR, which jobs.js reads when it loads.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "avc-fonts-"));
process.env.WORKSPACE_DIR = tmp;
const fonts = await import("../src/server/fonts.js");

test("font files are read for family, weight, slant and line height", () => {
  const meta = readFontMeta(makeFont({ family: "Demo Bold", typoFamily: "Demo", subfamily: "Bold", weight: 700, bold: true, ascent: 1000, descent: 250 }));
  assert.equal(meta.family, "Demo");
  assert.equal(meta.legacyFamily, "Demo Bold");
  assert.equal(meta.weight, 700);
  assert.equal(meta.italic, false);
  assert.equal(meta.ribbiBold, true);
  assert.equal(meta.cell, 1.25);
  assert.equal(meta.format, "ttf");

  assert.equal(readFontMeta(makeFont({ family: "Demo", weight: 400, italic: true })).italic, true);
});

test("bad font files are refused with a clear message", () => {
  assert.throws(() => readFontMeta(Buffer.from("not a font at all, really")), /does not look like/);
  assert.throws(() => readFontMeta(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(20)])), /WOFF/);
  assert.throws(() => readFontMeta(Buffer.concat([Buffer.from("ttcf"), Buffer.alloc(20)])), /collections/);
  assert.throws(() => readFontMeta(Buffer.alloc(4)), /too small/);
});

test("faces of one family are collected, replaced and listed", async () => {
  await fonts.addFontFile(makeFont({ family: "Demo", weight: 400 }));
  await fonts.addFontFile(makeFont({ family: "Demo", weight: 700, bold: true, subfamily: "Bold" }));
  const entry = await fonts.addFontFile(makeFont({ family: "Demo", weight: 400, ascent: 1100 }));  // replaces 400

  assert.equal(entry.id, "demo");
  assert.deepEqual(entry.files.map(f => f.file), ["400.ttf", "700.ttf"]);
  assert.equal(entry.files[0].cell, 1.4);

  const list = await fonts.listFonts();
  assert.deepEqual(list.map(f => f.id), ["demo"]);
  assert.match(await fonts.fontFilePath("demo", "700.ttf"), /700\.ttf$/);
  await assert.rejects(fonts.fontFilePath("demo", "../../etc/passwd"), /not found/i);
  await assert.rejects(fonts.fontFilePath("../x", "400.ttf"), /not found/i);

  await fonts.removeFont("demo");
  assert.deepEqual(await fonts.listFonts(), []);
});

test("Google Fonts helpers pick faces and build the CSS address", () => {
  const picks = fonts.chooseVariants(["300", "400", "500", "700", "900", "400i", "700i"]);
  assert.deepEqual(picks.map(v => `${v.w}${v.i ? "i" : ""}`), ["400", "700", "400i", "700i"]);
  assert.deepEqual(fonts.chooseVariants(["700"]).map(v => v.w), [700]);

  assert.equal(
    fonts.googleCssUrl("Open Sans", fonts.chooseVariants(["400", "700", "400i"])),
    "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,700;1,400");
  assert.equal(
    fonts.googleCssUrl("Anton", fonts.chooseVariants(["400"])),
    "https://fonts.googleapis.com/css2?family=Anton:wght@400");

  const css = `@font-face { font-family: 'X'; font-style: italic; font-weight: 700; src: url(https://fonts.gstatic.com/s/x/a.ttf) format('truetype'); }`;
  assert.deepEqual(fonts.parseGoogleCss(css), [{ italic: true, weight: 700, url: "https://fonts.gstatic.com/s/x/a.ttf", format: "truetype" }]);
});

test("Google catalogs are read from both the public list and the API", () => {
  const meta = ")]}'\n" + JSON.stringify({ familyMetadataList: [
    { family: "Roboto", category: "Sans Serif", popularity: 2, fonts: { "400": {}, "700": {}, "400i": {} } },
    { family: "Broken" }
  ] });
  assert.deepEqual(fonts.normalizeMetadata(meta), [
    { family: "Roboto", category: "Sans Serif", popularity: 2, variants: ["400", "700", "400i"] }
  ]);

  const api = fonts.normalizeApi({ items: [{ family: "Lobster", category: "display", variants: ["regular", "italic", "700italic"],
    files: { regular: "http://x/a.ttf", italic: "http://x/b.ttf", "700italic": "http://x/c.ttf" } }] });
  assert.deepEqual(api[0].variants, ["400", "400i", "700i"]);
  assert.equal(api[0].files["700i"], "https://x/c.ttf");
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
