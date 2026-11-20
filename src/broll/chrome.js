'use strict';
// Starts a real Chrome with remote debugging on, using a dedicated profile folder.
// By default it uses a dedicated profile folder (sign in once). Better: pick one of your existing Chrome profiles
// (see "using one of the person's existing Chrome profiles" below) and it opens already signed in.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function isUp(cdpUrl) {
  try {
    const r = await fetch(cdpUrl.replace(/\/$/, '') + '/json/version', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}


/* ---------- using one of the person's existing Chrome profiles ----------
   Chrome (136+) ignores --remote-debugging-port on its normal profile folder, so we cannot attach to the live
   profile. Instead the chosen profile (Arthur, Nimbu, ...) is copied once into our own folder, together with its
   saved login, and Chrome is opened on that copy. The real profile is only read, never changed. */

function chromeUserDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// The profiles shown in Chrome's own "Who's using Chrome?" window.
function listProfiles() {
  const root = chromeUserDataDir();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {}; } catch { /* no Chrome here */ }
  const out = Object.entries(cache).map(([dir, info]) => ({
    dir,
    name: info.name || info.gaia_name || dir,
    fullName: info.gaia_name || '',
    email: info.user_name || ''
  }));
  out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })));
  return out.filter(p => fs.existsSync(path.join(root, p.dir)));
}

const choiceFile = cfg => cfg.profileDir + '.json';
function readChoice(cfg) {
  try { return JSON.parse(fs.readFileSync(choiceFile(cfg), 'utf8')); } catch { return null; }
}
function writeChoice(cfg, choice) {
  fs.mkdirSync(path.dirname(choiceFile(cfg)), { recursive: true });
  if (!choice) { fs.rmSync(choiceFile(cfg), { force: true }); return; }
  fs.writeFileSync(choiceFile(cfg), JSON.stringify(choice, null, 2));
}

// The profile to use: the one picked in the app, else CHROME_PROFILE (a folder name like "Profile 1" or the display name).
function chosenProfile(cfg) {
  const all = listProfiles();
  const wanted = (readChoice(cfg) || {}).dir || process.env.CHROME_PROFILE;
  if (!wanted) return null;
  return all.find(p => p.dir === wanted) || all.find(p => p.name.toLowerCase() === String(wanted).toLowerCase()) || null;
}

const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Media Cache', 'CacheStorage', 'ScriptCache', 'Crashpad', 'Safe Browsing', 'OptimizationHints', 'optimization_guide_model_store']);
const SKIP_FILES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name), to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) copyTree(from, to, stats);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      try { fs.copyFileSync(from, to); stats.files++; } catch { stats.skipped++; } // a file Chrome has locked
    }
  }
}

// Copies the chosen profile into cfg.profileDir (once; `force` copies it again to refresh the login).
function prepareProfile(cfg, profile, force = false) {
  const marker = path.join(cfg.profileDir, '.copied-from.json');
  let done = null;
  try { done = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* not copied yet */ }
  if (!force && done && done.dir === profile.dir && fs.existsSync(path.join(cfg.profileDir, profile.dir))) return { copied: false, ...done };

  const root = chromeUserDataDir();
  const stats = { files: 0, skipped: 0 };
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  fs.rmSync(path.join(cfg.profileDir, profile.dir), { recursive: true, force: true });
  try { fs.copyFileSync(path.join(root, 'Local State'), path.join(cfg.profileDir, 'Local State')); } catch { stats.skipped++; }
  copyTree(path.join(root, profile.dir), path.join(cfg.profileDir, profile.dir), stats);
  const info = { dir: profile.dir, name: profile.name, at: new Date().toISOString(), ...stats };
  fs.writeFileSync(marker, JSON.stringify(info));
  return { copied: true, ...info };
}

function profileState(cfg) {
  const chosen = chosenProfile(cfg);
  let copied = null;
  try { copied = JSON.parse(fs.readFileSync(path.join(cfg.profileDir, '.copied-from.json'), 'utf8')); } catch { /* none */ }
  return {
    profiles: listProfiles(),
    selected: chosen ? chosen.dir : null,
    copied: !!(chosen && copied && copied.dir === chosen.dir),
    copiedAt: copied && chosen && copied.dir === chosen.dir ? copied.at : null,
    skipped: copied && chosen && copied.dir === chosen.dir ? copied.skipped : 0
  };
}

function launch(cfg, opts = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('Chrome not found. Set the CHROME_PATH environment variable to your chrome executable.');
  const port = new URL(cfg.cdpUrl).port || '9222';
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  const profile = chosenProfile(cfg);
  const prep = profile ? prepareProfile(cfg, profile, Boolean(opts.refresh)) : null;
  const extra = process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : [];
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${cfg.profileDir}`,
    ...(profile ? [`--profile-directory=${profile.dir}`] : []),
    '--no-first-run',
    '--no-default-browser-check',
    ...extra,
    cfg.flowUrl,
    ...(opts.claude ? [(cfg.claude && cfg.claude.newChatUrl) || 'https://claude.ai/new'] : [])
  ];
  launch.lastPrep = prep;
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return exe;
}
launch.lastPrep = null;

module.exports = { findChrome, isUp, launch, listProfiles, profileState, writeChoice, readChoice, chosenProfile, prepareProfile, chromeUserDataDir };
