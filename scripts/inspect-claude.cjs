'use strict';
// npm run inspect:claude  ->  shows which selector of each group matches on the open claude.ai tab.
const { loadConfig } = require('../src/broll/config');
const { inspectClaude } = require('../src/broll/claudeWeb');
inspectClaude(loadConfig()).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exit(1); });
