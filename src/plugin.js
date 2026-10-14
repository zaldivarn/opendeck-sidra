'use strict';

// Sidra Companion Plugin (OpenDeck): transport controls, shuffle, now-playing text, album-art play/pause
// and Add to Library for the Sidra Apple Music client on Linux.

const { OpenDeck } = require('./opendeck');
const { SidraPlayer, SidraNotRunning } = require('./mpris');
const { ArtCache } = require('./art');
const { LibraryClient, LibraryError } = require('./library');
const launcher = require('./launcher');
const icons = require('./icons');
const text = require('./text');

const NS = 'com.zaldivarn.sidra';
const A = {
  play: `${NS}.play`,
  pause: `${NS}.pause`,
  next: `${NS}.next`,
  previous: `${NS}.previous`,
  library: `${NS}.library`,
  nowPlaying: `${NS}.nowplaying`,
  shuffle: `${NS}.shuffle`,
  artPlayPause: `${NS}.playpauseart`,
};

const DEFAULTS = {
  [A.artPlayPause]: { indicator: 'auto', dimWhenPaused: true, launchWhenClosed: true, launchCommand: '', holdTime: 'normal', doubleTapAction: 'none', doubleTapTime: 'normal' },
  [A.nowPlaying]: { fields: 'title-artist', background: 'art', scroll: true, lineChars: 12, speed: 'normal', press: 'raise' },
};

const SPEED_MS = { slow: 700, normal: 450, fast: 280 };
const HOLD_MS = { short: 350, normal: 500, long: 800 };
const DOUBLE_TAP_MS = { fast: 250, normal: 350, relaxed: 500 };

const od = new OpenDeck();
const log = (m) => od.log(m);
const player = new SidraPlayer({ log });
const art = new ArtCache(log);

let globalSettings = { cdpPort: 9222 };
const library = new LibraryClient({ getPort: () => Number(globalSettings.cdpPort) || 9222 });
// What we know about the current track's library membership: { key, inLibrary }.
let libraryState = { key: null, inLibrary: null };
let libraryCheckTimer = null;
const loggedOnce = new Set();
// Set while we have started Sidra and are waiting for it to appear on the bus.
let launching = null; // { ctx, timer }
const LAUNCH_TIMEOUT_MS = 60000; // Sidra only registers MPRIS once Apple Music has loaded

/** context -> { action, settings, seq, ticker, tick, lines } */
const instances = new Map();

function settingsFor(inst) {
  return { ...(DEFAULTS[inst.action] || {}), ...(inst.settings || {}) };
}

function eachOf(action, fn) {
  for (const [ctx, inst] of instances) if (inst.action === action) fn(ctx, inst);
}

function logOnce(key, message) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log(message);
}

// ---------------------------------------------------------------- rendering

const svg = (s) => icons.svgDataUri(s);

async function renderArtPlayPause(ctx, inst) {
  const s = player.state;
  const md = s.metadata;
  const playing = s.status === 'Playing';
  const seq = ++inst.seq;
  if (!s.running) return od.setImage(ctx, svg(icons.placeholderKey({ caption: closedCaption() })));
  if (!md.title && !md.artUrl) return od.setImage(ctx, svg(icons.placeholderKey()));
  const st = settingsFor(inst);
  const uri = await art.playPauseKey(md.artUrl, playing, st);
  if (seq !== inst.seq) return; // a newer render started while the cover was loading
  inst.renderedArtFor = uri ? md.key : null;
  // No cover to show: same rule as the cover itself, a pause icon only while paused.
  od.setImage(ctx, uri || svg(icons.placeholderKey({ paused: !playing && st.indicator !== 'none' })));
}

function closedCaption() {
  if (launching) return 'Opening…';
  return player.ready ? 'Sidra closed' : '';
}

function songLines(inst) {
  const s = player.state;
  const md = s.metadata;
  const st = settingsFor(inst);
  if (!s.running) {
    if (launching) return ['Opening', 'Sidra…'];
    return player.ready ? ['Sidra', 'closed'] : [];
  }
  if (!md.title) return ['Nothing', 'playing'];
  switch (st.fields) {
    case 'title':
      return st.scroll ? [md.title] : text.wrap(md.title, clampChars(st.lineChars), 3);
    case 'title-artist-album':
      return [md.title, md.artist, md.album].filter(Boolean);
    case 'artist-title':
      return [md.artist, md.title].filter(Boolean);
    default:
      return [md.title, md.artist].filter(Boolean);
  }
}

function clampChars(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(40, Math.max(4, v)) : 12;
}

function drawSongTitle(ctx, inst) {
  const st = settingsFor(inst);
  const width = clampChars(st.lineChars);
  const lines = inst.lines || [];
  const out = lines.map((l) => (st.scroll ? text.marquee(l, width, inst.tick || 0) : text.truncate(l, width)));
  od.setTitle(ctx, out.join('\n'));
}

function startOrStopTicker(ctx, inst) {
  const st = settingsFor(inst);
  const width = clampChars(st.lineChars);
  const needs = st.scroll && (inst.lines || []).some((l) => text.overflows(l, width));
  const interval = SPEED_MS[st.speed] || SPEED_MS.normal;
  if (inst.ticker && (!needs || inst.tickerInterval !== interval)) {
    clearInterval(inst.ticker);
    inst.ticker = null;
  }
  if (needs && !inst.ticker) {
    inst.tickerInterval = interval;
    inst.ticker = setInterval(() => {
      inst.tick = (inst.tick || 0) + 1;
      drawSongTitle(ctx, inst);
    }, interval);
  }
}

async function renderNowPlaying(ctx, inst, { resetScroll = true, background = true } = {}) {
  const s = player.state;
  const md = s.metadata;
  const st = settingsFor(inst);
  inst.lines = songLines(inst);
  if (resetScroll) inst.tick = 0;
  drawSongTitle(ctx, inst);
  startOrStopTicker(ctx, inst);
  if (!background) return;
  const seq = ++inst.seq;
  let image = null;
  if (s.running && md.artUrl && st.background === 'art') {
    image = await art.songBackground(md.artUrl, 0.4);
    if (seq !== inst.seq) return;
  }
  inst.renderedBgFor = image ? md.key : null;
  od.setImage(ctx, image || svg(icons.plainBackground()));
}

function renderShuffle(ctx) {
  od.setState(ctx, player.state.running && player.state.shuffle ? 1 : 0);
}

function renderLibrary(ctx) {
  const md = player.state.metadata;
  const known = player.state.running && libraryState.key === md.key && libraryState.inLibrary === true;
  od.setState(ctx, known ? 1 : 0);
}

function render(ctx, inst) {
  switch (inst.action) {
    case A.artPlayPause:
      return renderArtPlayPause(ctx, inst);
    case A.nowPlaying:
      return renderNowPlaying(ctx, inst);
    case A.shuffle:
      return renderShuffle(ctx);
    case A.library:
      return renderLibrary(ctx);
    default:
      return undefined; // static keys use their manifest image
  }
}

// ---------------------------------------------------------------- library state

function scheduleLibraryCheck() {
  clearTimeout(libraryCheckTimer);
  let any = false;
  eachOf(A.library, () => (any = true));
  const md = player.state.metadata;
  if (!any || !player.state.running || !md.title) return;
  const key = md.key;
  libraryCheckTimer = setTimeout(async () => {
    try {
      const r = await library.check();
      if (player.state.metadata.key !== key) return;
      if (r && r.ok && typeof r.inLibrary === 'boolean') {
        libraryState = { key, inLibrary: r.inLibrary };
        eachOf(A.library, (ctx) => renderLibrary(ctx));
      }
    } catch (err) {
      const code = err instanceof LibraryError ? err.code : 'OTHER';
      logOnce(`check-${code}`, `Library status check unavailable: ${err.message}`);
    }
  }, 1200);
}

// ---------------------------------------------------------------- key presses

async function attempt(ctx, label, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    od.showAlert(ctx);
    if (err instanceof SidraNotRunning) logOnce('not-running', `${label}: ${err.message}`);
    else log(`${label} failed: ${err.message}`);
    return false;
  }
}

async function onPress(ctx, inst) {
  const st = settingsFor(inst);
  switch (inst.action) {
    case A.play:
      return attempt(ctx, 'Play', () => player.play());
    case A.pause:
      return attempt(ctx, 'Pause', () => player.pause());
    case A.next:
      return attempt(ctx, 'Next', () => player.next());
    case A.previous:
      return attempt(ctx, 'Previous', () => player.previous());
    case A.artPlayPause:
      // Only on the "Sidra closed" screen: open Sidra instead of failing.
      if (!player.state.running && player.ready && st.launchWhenClosed) return openSidra(ctx, st);
      return attempt(ctx, 'Play/Pause', () => player.playPause());
    case A.shuffle:
      return attempt(ctx, 'Shuffle', async () => {
        const on = await player.toggleShuffle();
        // Reflect it straight away; Sidra's PropertiesChanged will confirm.
        player.state.shuffle = on;
        eachOf(A.shuffle, (c) => renderShuffle(c));
      });
    case A.nowPlaying:
      if (st.press === 'playpause') return attempt(ctx, 'Play/Pause', () => player.playPause());
      if (st.press === 'raise') return attempt(ctx, 'Show Sidra', () => player.raise());
      return undefined;
    case A.library:
      return addToLibrary(ctx);
    default:
      return undefined;
  }
}

async function addToLibrary(ctx) {
  if (!player.state.running) {
    od.showAlert(ctx);
    return;
  }
  const key = player.state.metadata.key;
  try {
    const r = await library.add();
    if (r.ok) {
      libraryState = { key, inLibrary: true };
      od.showOk(ctx);
      eachOf(A.library, (c) => renderLibrary(c));
      log(r.already ? `"${r.title}" is already in your library` : `Added "${r.title}" to your library`);
    } else {
      od.showAlert(ctx);
      log(`Add to Library: ${r.error || 'failed'}`);
    }
  } catch (err) {
    od.showAlert(ctx);
    log(`Add to Library: ${err.message}`);
  }
}

// ---------------------------------------------------------------- opening Sidra

function renderClosedKeys() {
  if (player.state.running) return;
  eachOf(A.artPlayPause, (c, i) => renderArtPlayPause(c, i));
  eachOf(A.nowPlaying, (c, i) => renderNowPlaying(c, i));
}

function endLaunch(failure) {
  if (!launching) return;
  const { ctx, timer } = launching;
  clearTimeout(timer);
  launching = null;
  if (failure) {
    log(failure);
    od.showAlert(ctx);
  }
  renderClosedKeys();
}

async function openSidra(ctx, st) {
  if (launching) return; // already on its way
  launching = { ctx, timer: null };
  renderClosedKeys();
  try {
    const how = await launcher.launch({
      command: st.launchCommand,
      onEarlyExit: (code, signal, started) =>
        endLaunch(`Sidra exited straight away (${signal || `exit code ${code}`}) when started via ${started.description}`),
    });
    log(`Opening Sidra via ${how.description}`);
    if (launching) {
      launching.timer = setTimeout(
        () => endLaunch(`Started Sidra, but it hadn't connected after ${LAUNCH_TIMEOUT_MS / 1000} s`),
        LAUNCH_TIMEOUT_MS,
      );
    }
  } catch (err) {
    endLaunch(`Couldn't open Sidra: ${err.message}`);
  }
}

// ---------------------------------------------------------------- property inspector

async function statusFor(action, ctx) {
  const s = player.state;
  const status = {
    type: 'status',
    sidra: s.running ? 'connected' : 'not running',
    track: s.running && s.metadata.title ? `${s.metadata.title}${s.metadata.artist ? ` — ${s.metadata.artist}` : ''}` : '',
    playback: s.running ? s.status : '',
    cdpPort: Number(globalSettings.cdpPort) || 9222,
    cdp: null,
  };
  if (action === A.artPlayPause) {
    const inst = instances.get(ctx);
    const how = launcher.resolve({ command: inst ? settingsFor(inst).launchCommand : '' });
    status.launch = how ? { ok: true, message: `Opens with ${how.description}` } : { ok: false, message: "Sidra's launcher wasn't found — set a command below." };
  }
  if (action === A.library) {
    try {
      const page = await library.probe();
      status.cdp = { ok: true, message: `Connected to ${page.url.replace(/^https:\/\//, '').split('?')[0]}` };
    } catch (err) {
      status.cdp = { ok: false, message: err.message };
    }
  }
  return status;
}

async function sendStatus(ctx, action) {
  od.sendToPropertyInspector(ctx, action, await statusFor(action, ctx));
}

// ---------------------------------------------------------------- wiring

od.on('willAppear', (msg) => {
  const inst = { action: msg.action, settings: (msg.payload && msg.payload.settings) || {}, seq: 0, tick: 0 };
  const old = instances.get(msg.context);
  if (old && old.ticker) clearInterval(old.ticker);
  if (old) cancelGesture(old);
  instances.set(msg.context, inst);
  od.resetContext(msg.context);
  render(msg.context, inst);
  if (msg.action === A.library) scheduleLibraryCheck();
});

od.on('willDisappear', (msg) => {
  const inst = instances.get(msg.context);
  if (inst && inst.ticker) clearInterval(inst.ticker);
  if (inst) cancelGesture(inst); // e.g. profile switched mid-press: no keyUp will follow
  instances.delete(msg.context);
  od.resetContext(msg.context);
});

od.on('didReceiveSettings', (msg) => {
  const inst = instances.get(msg.context);
  if (!inst) return;
  inst.settings = (msg.payload && msg.payload.settings) || {};
  render(msg.context, inst);
  if (visibleInspector && visibleInspector.context === msg.context) sendStatus(msg.context, msg.action);
});

od.on('keyDown', (msg) => {
  const inst = instances.get(msg.context) || { action: msg.action, settings: (msg.payload && msg.payload.settings) || {} };
  if (inst.gesture && inst.gesture.phase === 'waitSecond') secondDown(msg.context, inst);
  else if (usesGestures(msg.context, inst)) firstDown(msg.context, inst);
  else onPress(msg.context, inst);
});

od.on('keyUp', (msg) => {
  const inst = instances.get(msg.context);
  if (inst && inst.gesture) gestureKeyUp(msg.context, inst);
});

// ---------------------------------------------------------------- album-art key gestures
// Tap = play/pause. Optionally, holding and/or double-tapping run Next, Previous or Replay.
//   hold on:        a tap counts on release (before the hold time); holding past it runs
//                   the hold action and the release does nothing.
//   double-tap on:  a tap waits briefly for a second press; a second press runs the
//                   double-tap action, otherwise the tap plays/pauses when the wait ends.
// On the "Sidra closed" screen none of this applies: a press opens Sidra straight away.

const GESTURE_ACTIONS = {
  next: { label: 'Next', run: () => player.next() },
  previous: { label: 'Previous', run: () => player.previous() },
  replay: { label: 'Replay', run: () => player.restartTrack(), confirm: true }, // the key doesn't change, so flash OK
};

function gestureSettings(inst) {
  const st = settingsFor(inst);
  // v1.3 stored a hold on/off switch; carry that over until the new setting is saved.
  const hold = st.holdAction !== undefined ? st.holdAction : st.holdToSkip === false ? 'none' : 'next';
  return {
    hold: GESTURE_ACTIONS[hold] ? hold : 'none',
    holdMs: HOLD_MS[st.holdTime] || HOLD_MS.normal,
    doubleTap: GESTURE_ACTIONS[st.doubleTapAction] ? st.doubleTapAction : 'none',
    doubleTapMs: DOUBLE_TAP_MS[st.doubleTapTime] || DOUBLE_TAP_MS.normal,
  };
}

function usesGestures(ctx, inst) {
  // Only keys we track get their keyUp matched up.
  if (inst.action !== A.artPlayPause || instances.get(ctx) !== inst) return false;
  if (!player.state.running) return false;
  const g = gestureSettings(inst);
  return g.hold !== 'none' || g.doubleTap !== 'none';
}

function runGesture(ctx, name) {
  const action = GESTURE_ACTIONS[name];
  return attempt(ctx, action.label, async () => {
    await action.run();
    if (action.confirm) od.showOk(ctx);
  });
}

function singleTap(ctx, inst) {
  if (player.state.running) onPress(ctx, inst); // don't open Sidra if it quit mid-gesture
}

function firstDown(ctx, inst) {
  cancelGesture(inst);
  const g = gestureSettings(inst);
  const gesture = { phase: 'down1', g, timer: null };
  if (g.hold !== 'none') {
    gesture.timer = setTimeout(() => {
      gesture.phase = 'held';
      gesture.timer = null;
      runGesture(ctx, g.hold);
    }, g.holdMs);
  }
  inst.gesture = gesture;
}

function gestureKeyUp(ctx, inst) {
  const gesture = inst.gesture;
  if (gesture.phase === 'down1') {
    clearTimeout(gesture.timer);
    if (gesture.g.doubleTap !== 'none') {
      gesture.phase = 'waitSecond';
      gesture.timer = setTimeout(() => {
        inst.gesture = null;
        singleTap(ctx, inst);
      }, gesture.g.doubleTapMs);
      return;
    }
    inst.gesture = null;
    singleTap(ctx, inst);
  } else if (gesture.phase === 'held' || gesture.phase === 'down2') {
    inst.gesture = null;
  }
}

function secondDown(ctx, inst) {
  const gesture = inst.gesture;
  clearTimeout(gesture.timer);
  gesture.phase = 'down2';
  gesture.timer = null;
  runGesture(ctx, gesture.g.doubleTap);
}

function cancelGesture(inst) {
  if (inst.gesture) clearTimeout(inst.gesture.timer);
  inst.gesture = null;
}

od.on('didReceiveGlobalSettings', (msg) => {
  const s = (msg.payload && msg.payload.settings) || {};
  globalSettings = { ...globalSettings, ...s };
  loggedOnce.clear();
});

// Keep the visible inspector's status line fresh (OpenDeck keeps hidden inspectors loaded,
// so the refresh loop lives here and only follows the one on screen).
let visibleInspector = null;
let inspectorTimer = null;
od.on('propertyInspectorDidAppear', (msg) => {
  visibleInspector = { context: msg.context, action: msg.action };
  sendStatus(msg.context, msg.action);
  clearInterval(inspectorTimer);
  inspectorTimer = setInterval(() => {
    if (visibleInspector) sendStatus(visibleInspector.context, visibleInspector.action);
  }, 4000);
});
od.on('propertyInspectorDidDisappear', (msg) => {
  if (visibleInspector && visibleInspector.context === msg.context) {
    visibleInspector = null;
    clearInterval(inspectorTimer);
  }
});

od.on('sendToPlugin', async (msg) => {
  const p = msg.payload || {};
  if (p.type === 'setCdpPort') {
    const port = Math.round(Number(p.cdpPort));
    if (port > 0 && port < 65536) {
      globalSettings = { ...globalSettings, cdpPort: port };
      od.setGlobalSettings(globalSettings);
      loggedOnce.clear();
    }
    await sendStatus(msg.context, msg.action);
    scheduleLibraryCheck();
  } else if (p.type === 'refresh') {
    await sendStatus(msg.context, msg.action);
  }
});

player.on('change', (state, changed) => {
  if (state.running && launching) endLaunch();
  for (const [ctx, inst] of instances) {
    switch (inst.action) {
      case A.artPlayPause:
        // Sidra swaps the https cover URL for a cached file:// copy shortly after a track
        // starts; skip that second render when the cover already made it onto the key.
        if (changed.track || changed.status || changed.running || (changed.art && inst.renderedArtFor !== state.metadata.key)) {
          renderArtPlayPause(ctx, inst);
        }
        break;
      case A.nowPlaying:
        if (changed.track || changed.running) renderNowPlaying(ctx, inst);
        else if (changed.art && inst.renderedBgFor !== state.metadata.key) renderNowPlaying(ctx, inst, { resetScroll: false });
        break;
      case A.shuffle:
        if (changed.shuffle || changed.running) renderShuffle(ctx);
        break;
      case A.library:
        if (changed.track || changed.running) renderLibrary(ctx);
        break;
      default:
        break;
    }
  }
  if (changed.track || changed.running) scheduleLibraryCheck();
});

od.on('connected', () => {
  log(`connected to OpenDeck on port ${od.port}`);
  od.getGlobalSettings();
});

od.on('disconnected', () => {
  // OpenDeck has gone away (quit, or the plugin is being reloaded): exit cleanly.
  process.exit(0);
});

od.on('socketError', (err) => {
  console.error(`OpenDeck socket error: ${err.message}`);
});

process.on('unhandledRejection', (err) => log(`unhandled: ${err && err.stack ? err.stack : err}`));

od.connect();
player.start();
