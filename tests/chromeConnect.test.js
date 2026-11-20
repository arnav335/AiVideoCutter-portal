import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("listProfiles returns every Chrome profile, Default first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-"));
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: {
    "Profile 2": { name: "Nimbu", user_name: "n@x.com" }, Default: { name: "Arthur", gaia_name: "Arthur A", user_name: "a@x.com" }, "Profile 10": { name: "Ten" } } } }));
  for (const d of ["Default", "Profile 2", "Profile 10"]) fs.mkdirSync(path.join(root, d));
  process.env.CHROME_USER_DATA_DIR = root;
  const chrome = require("../src/broll/chrome.js");
  assert.deepEqual(chrome.listProfiles().map(p => p.name), ["Arthur", "Nimbu", "Ten"]);
  delete process.env.CHROME_USER_DATA_DIR;
});

const fakeBrowser = ({ url, loginVisible = false, inputVisible = true }) => ({
  contexts: () => [{ pages: () => [], newPage: async () => ({
    url: () => url, goto: async () => {},
    locator: sel => ({ count: async () => 1, nth: () => ({ isVisible: async () => (/login/.test(sel) ? loginVisible : inputVisible), isEnabled: async () => true }) })
  }) }],
  close: async () => {}
});
const cfg = { claude: { newChatUrl: "https://claude.ai/new", selectors: { loginMarker: ["login"], input: ["input"] } } };

test("checkClaude: Chrome not connected, signed out, and ready", async () => {
  const { checkClaude } = require("../src/broll/claudeWeb.js");
  let r = await checkClaude(cfg, { connect: async () => { throw new Error("x"); } });
  assert.equal(r.ready, false); assert.equal(r.chrome, false);
  r = await checkClaude(cfg, { connect: async () => fakeBrowser({ url: "https://claude.ai/login", loginVisible: true }) });
  assert.equal(r.ready, false); assert.equal(r.signedIn, false);
  r = await checkClaude(cfg, { connect: async () => fakeBrowser({ url: "https://claude.ai/new" }) });
  assert.equal(r.ready, true);
});

test("parseJson copes with chatter, labels, comments, trailing commas and quotes inside text", () => {
  const { parseJson } = require("../src/broll/llm.js");
  assert.deepEqual(parseJson('Here:\n```json\n{"a":[1,2,],}\n```\nDone {ok}'), { a: [1, 2] });
  assert.deepEqual(parseJson('json\nCopy\n[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJson('{"d":"a "big" idea","e":2} // x'), { d: 'a "big" idea', e: 2 });
  assert.throws(() => parseJson("I cannot do that."), e => e.code === "BADJSON" && /starts with/.test(e.message));
});
