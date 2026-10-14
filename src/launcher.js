'use strict';

// Starting Sidra from a key press. The preferred route is Sidra's own desktop entry, found
// the way the desktop does it (user entries in ~/.local/share/applications win), so any
// flags the user added there — such as the DevTools port for Add to Library — still apply.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Desktop file IDs Sidra ships as: deb/rpm/AUR/Nix, and the snap.
const KNOWN_IDS = ['sidra.desktop', 'sidra_sidra.desktop'];

function unique(list) {
  return [...new Set(list)];
}

function applicationDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  // Snap and Flatpak exports are normally already in XDG_DATA_DIRS; listed again in case the
  // environment OpenDeck was started from lacks them.
  const extras = ['/var/lib/snapd/desktop', path.join(home, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share'];
  return unique([dataHome, ...dataDirs, ...extras].map((d) => path.join(d, 'applications')));
}

/** Parse the [Desktop Entry] group of a .desktop file into a plain object. */
function parseDesktopFile(text) {
  const out = {};
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // localised variants
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Undo the escapes allowed in desktop-entry string values (\s \n \t \r \\). */
function unescapeValue(v) {
  return v.replace(/\\([sntr\\])/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
}

/**
 * Split an Exec value into argv following the Desktop Entry spec: double-quoted arguments,
 * backslash escapes inside quotes, and field codes removed or expanded.
 */
function parseExec(exec, { name = '', icon = '', file = '' } = {}) {
  const s = unescapeValue(exec);
  const args = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) cur += s[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started || cur) args.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
    }
  }
  if (started || cur) args.push(cur);

  const argv = [];
  for (const a of args) {
    if (a === '%i') {
      if (icon) argv.push('--icon', icon);
      continue;
    }
    if (/^%[fFuUdDnNvm]$/.test(a)) continue; // nothing to open: drop file/URL placeholders
    argv.push(a.replace(/%(.)/g, (_, c) => (c === '%' ? '%' : c === 'c' ? name : c === 'k' ? file : '')));
  }
  return argv;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(cmd, env = process.env) {
  if (!cmd) return null;
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null;
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(dir, cmd);
    if (isExecutable(p)) return p;
  }
  return null;
}

function readEntry(file) {
  try {
    return parseDesktopFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function usable(entry, env) {
  if (!entry || !entry.Exec) return false;
  if (/^true$/i.test(entry.Hidden || '')) return false;
  if (entry.Type && entry.Type !== 'Application') return false;
  if (entry.TryExec && !which(parseExec(entry.TryExec)[0] || entry.TryExec, env)) return false;
  return true;
}

function looksLikeSidra(entry) {
  if (!entry || !entry.Exec) return false;
  const exec = entry.Exec.toLowerCase();
  if ((entry.StartupWMClass || '').toLowerCase() === 'sidra' && exec.includes('sidra')) return true;
  return (entry.Name || '').trim().toLowerCase() === 'sidra' && exec.includes('sidra');
}

/**
 * Find Sidra's desktop entry. Earlier directories mask later ones per desktop file ID, and a
 * Hidden=true entry in an earlier directory hides the ID entirely, as on the desktop.
 */
function findDesktopEntry(env = process.env) {
  const dirs = applicationDirs(env);
  const seen = new Set();
  const generic = [];
  const byId = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const id of names) {
      if (seen.has(id)) continue;
      seen.add(id);
      const file = path.join(dir, id);
      const entry = readEntry(file);
      if (!usable(entry, env)) continue;
      const found = { id, file, entry };
      if (KNOWN_IDS.includes(id)) byId.set(id, found);
      else if (looksLikeSidra(entry)) generic.push(found);
    }
  }
  for (const id of KNOWN_IDS) if (byId.has(id)) return byId.get(id);
  return generic[0] || null;
}

/** AppImages and plain binaries in the usual places, for installs without a desktop entry. */
function findBinary(env = process.env) {
  for (const cmd of ['sidra', '/snap/bin/sidra', '/opt/Sidra/sidra']) {
    const p = which(cmd, env);
    if (p) return p;
  }
  const home = env.HOME || os.homedir();
  for (const dir of ['Applications', 'AppImages', '.local/bin'].map((d) => path.join(home, d))) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.filter((n) => /^sidra.*\.appimage$/i.test(n)).sort().pop();
    if (hit && isExecutable(path.join(dir, hit))) return path.join(dir, hit);
  }
  return null;
}

/**
 * Environment for Sidra: OpenDeck's, minus anything that describes OpenDeck's own packaging.
 * In particular APPIMAGE would make Sidra's updater think it is an AppImage at that path.
 */
function cleanEnv(env = process.env) {
  const out = { ...env };
  const appDir = env.APPDIR;
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'DESKTOP_STARTUP_ID', 'XDG_ACTIVATION_TOKEN']) {
    delete out[k];
  }
  if (appDir) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || !v.includes(appDir)) continue;
      const kept = v.split(':').filter((p) => p && !p.startsWith(appDir));
      if (kept.length) out[k] = kept.join(':');
      else delete out[k];
    }
  }
  return out;
}

/** Work out how Sidra would be started, without starting it. */
function resolve({ command = '', env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  if (command && command.trim()) {
    return { kind: 'command', argv: ['/bin/sh', '-c', command.trim()], cwd: home, description: `custom command: ${command.trim()}` };
  }
  const found = findDesktopEntry(env);
  if (found) {
    const argv = parseExec(found.entry.Exec, { name: found.entry.Name || 'Sidra', icon: found.entry.Icon || '', file: found.file });
    if (argv.length) {
      return {
        kind: 'desktop',
        argv,
        cwd: found.entry.Path && fs.existsSync(found.entry.Path) ? found.entry.Path : home,
        file: found.file,
        description: `desktop entry ${found.file.replace(home, '~')}`,
      };
    }
  }
  const bin = findBinary(env);
  if (bin) return { kind: 'binary', argv: [bin], cwd: home, description: bin.replace(home, '~') };
  return null;
}

class LaunchError extends Error {}

/**
 * Start Sidra detached from the plugin, so it outlives it. Resolves once the process has
 * spawned; `onEarlyExit(code)` fires if it exits non-zero within `watchMs`.
 */
function launch({ command = '', env = process.env, onEarlyExit = () => {}, watchMs = 5000 } = {}) {
  const how = resolve({ command, env });
  if (!how) {
    return Promise.reject(
      new LaunchError("Couldn't find Sidra: no sidra.desktop entry and no sidra command on PATH. Set a launch command in the key's settings."),
    );
  }
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(how.argv[0], how.argv.slice(1), { cwd: how.cwd, env: cleanEnv(env), detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(new LaunchError(`${how.description}: ${err.message}`));
      return;
    }
    const started = Date.now();
    child.once('error', (err) => reject(new LaunchError(`${how.description}: ${err.code === 'ENOENT' ? `${how.argv[0]} not found` : err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolvePromise({ ...how, pid: child.pid });
    });
    child.once('exit', (code, signal) => {
      if (Date.now() - started <= watchMs && (code || signal)) onEarlyExit(code, signal, how);
    });
  });
}

module.exports = { launch, resolve, parseExec, parseDesktopFile, findDesktopEntry, findBinary, cleanEnv, applicationDirs, LaunchError };
