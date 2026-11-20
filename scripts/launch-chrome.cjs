'use strict';
// npm run chrome  →  opens Chrome with remote debugging, using the project's own profile.
const { loadConfig } = require('../src/broll/config');
const chrome = require('../src/broll/chrome');

(async () => {
  const cfg = loadConfig();
  if (await chrome.isUp(cfg.cdpUrl)) return console.log('Chrome is already running with remote debugging.');
  try {
    console.log('Launched:', chrome.launch(cfg));
    console.log('Sign into Google and open a Flow project in that window (first time only).');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
