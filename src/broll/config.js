'use strict';
const fs = require('fs');
const path = require('path');

// src/broll/ -> project root
const ROOT = path.resolve(__dirname, '..', '..');
// Same workspace folder as the editor (see src/server/jobs.js).
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || 'workspace');

// Re-read on every job so edits to flow.config.json apply without a restart.
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'flow.config.json'), 'utf8'));
  if (process.env.FLOW_URL) cfg.flowUrl = process.env.FLOW_URL;
  if (process.env.FLOW_CDP_URL) cfg.cdpUrl = process.env.FLOW_CDP_URL;
  if (process.env.SPEECHMATICS_URL) cfg.asr.baseUrl = process.env.SPEECHMATICS_URL;
  const groqUrl = process.env.GROQ_BASE_URL || process.env.GROQ_URL;
  if (groqUrl) cfg.llm.providers.groq.baseUrl = groqUrl;
  const geminiUrl = process.env.GEMINI_BASE_URL || process.env.GEMINI_URL;
  if (geminiUrl) cfg.llm.providers.gemini.baseUrl = geminiUrl;
  if (process.env.GEMINI_MODEL) cfg.llm.providers.gemini.default = process.env.GEMINI_MODEL;
  if (process.env.GROQ_MODEL) cfg.llm.providers.groq.default = process.env.GROQ_MODEL;
  cfg.root = ROOT;
  cfg.workspace = WORKSPACE;
  // Flow image jobs, usage counter and Chrome profile live next to the projects.
  cfg.outputDir = path.join(WORKSPACE, 'broll');
  cfg.profileDir = path.join(ROOT, '.chrome-profile');
  return cfg;
}

module.exports = { loadConfig, ROOT, WORKSPACE };
