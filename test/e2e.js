'use strict';

// End-to-end test: runs the bundled plugin exactly as OpenDeck would, against
//  - a mock Sidra MPRIS service on a private session bus (run under dbus-run-session),
//  - a mock OpenDeck WebSocket host,
//  - a mock Chrome DevTools endpoint whose "page" runs the injected script against a fake MusicKit,
//  - a local HTTP server standing in for Apple's artwork CDN.
// Usage: dbus-run-session -- node test/e2e.js <art-dir> [out-dir]

const assert = require('assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { startMockSidra } = require('./mock-sidra');

const ART = path.resolve(process.argv[2] || 'test/art');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : null;
const PLUGIN = path.resolve(__dirname, '../com.zaldivarn.sidra.sdPlugin');
const NS = 'com.zaldivarn.sidra';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.stack || err}`);
    throw err;
  }
}

(async () => {
  // ---------------------------------------------------------------- fake artwork CDN
  const cdnHits = [];
  const cdn = http.createServer((req, res) => {
    cdnHits.push(req.url);
    // Serve only the downsized rendition the plugin should ask for.
    if (req.url === '/image/thumb/Music/aa/bb/288x288bb.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(fs.readFileSync(path.join(ART, 'album3.jpg')));
    }
    res.writeHead(404).end();
  });
  const cdnPort = await listen(cdn);

  // ---------------------------------------------------------------- fake DevTools + MusicKit
  const apiCalls = [];
  const library = new Set(['1001']); // catalogue ids already in the library
  let useMusicKitApi = true;
  let nowPlaying = null; // set to mirror the mock Sidra track
  function makeMusicKit() {
    const mk = {
      developerToken: 'DEV',
      musicUserToken: 'USER',
      storefrontId: 'gb',
      get nowPlayingItem() {
        return nowPlaying;
      },
    };
    if (useMusicKitApi) {
      mk.api = {
        music: async (p, params, opts) => {
          const method = (opts && opts.fetchOptions && opts.fetchOptions.method) || 'GET';
          apiCalls.push({ via: 'musickit', method, path: p, params });
          return fakeApi(method, p, params);
        },
      };
    }
    return mk;
  }
  function fakeApi(method, p, params) {
    if (method === 'POST' && p === '/v1/me/library') {
      const id = params['ids[songs]'];
      library.add(String(id));
      return { response: { status: 202 }, data: null };
    }
    const m = /^\/v1\/catalog\/(\w+)\/songs\/(\d+)$/.exec(p);
    if (m) {
      const inLib = library.has(m[2]);
      return { response: { status: 200 }, data: { data: [{ id: m[2], relationships: { library: { data: inLib ? [{ id: `i.${m[2]}` }] : [] } } }] } };
    }
    return { response: { status: 404 }, data: null };
  }
  async function fakeFetch(url, init = {}) {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    apiCalls.push({ via: 'fetch', method: init.method || 'GET', path: u.pathname, params, auth: init.headers });
    const r = fakeApi(init.method || 'GET', u.pathname, params);
    return { status: r.response.status, ok: r.response.status < 300, json: async () => r.data };
  }

  const cdp = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify([
          { type: 'service_worker', url: 'https://music.apple.com/sw.js', webSocketDebuggerUrl: 'ws://nope' },
          { type: 'page', url: 'https://music.apple.com/gb/new', title: 'Apple Music', webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/ABC` },
        ]),
      );
    }
    res.writeHead(404).end();
  });
  const cdpPort = await listen(cdp);
  const evaluated = [];
  new WebSocketServer({ server: cdp }).on('connection', (ws) => {
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      evaluated.push(msg);
      assert.equal(msg.method, 'Runtime.evaluate');
      const MusicKit = { getInstance: makeMusicKit };
      const sandbox = { MusicKit, fetch: fakeFetch, URLSearchParams, console };
      sandbox.window = sandbox;
      try {
        const value = await vm.runInNewContext(msg.params.expression, sandbox);
        ws.send(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value } } }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, result: { result: {}, exceptionDetails: { text: String(err) } } }));
      }
    });
  });

  // ---------------------------------------------------------------- mock Sidra
  const tracks = [
    { id: '1001', title: 'Sunrise', artist: 'The Testers', album: 'Mock Album', artUrl: `file://${ART}/album1.jpg` },
    {
      id: '1002',
      title: 'A Rather Long Song Title That Needs To Scroll',
      artist: 'Somebody & The Overflowing Band',
      album: 'Second',
      artUrl: `file://${ART}/album2-actually-png.jpg`,
    },
    { id: '1003', title: 'Over HTTP', artist: 'CDN', album: 'Third', artUrl: `http://127.0.0.1:${cdnPort}/image/thumb/Music/aa/bb/512x512bb.jpg` },
  ];
  const syncNowPlaying = (i) => {
    const t = tracks[i];
    nowPlaying = { id: t.id, type: 'songs', attributes: { name: t.title, playParams: { id: t.id, kind: 'song' } } };
  };
  syncNowPlaying(0);
  let sidra = await startMockSidra({ tracks: tracks.map((t) => ({ ...t })) });

  // ---------------------------------------------------------------- mock OpenDeck
  const odServer = http.createServer();
  const odPort = await listen(odServer);
  const wss = new WebSocketServer({ server: odServer });
  const keys = {}; // context -> { images, titles, states, alerts, oks }
  let pluginSocket = null;
  const globalSettingsRequests = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.event === 'registerPlugin') {
        pluginSocket = ws;
        return;
      }
      if (msg.event === 'getGlobalSettings') {
        globalSettingsRequests.push(msg);
        ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { cdpPort } } }));
        return;
      }
      if (msg.event === 'logMessage') return;
      const k = (keys[msg.context] ||= { images: [], titles: [], states: [], alerts: 0, oks: 0, pi: [] });
      if (msg.event === 'setImage') k.images.push(msg.payload.image);
      else if (msg.event === 'setTitle') k.titles.push(msg.payload.title);
      else if (msg.event === 'setState') k.states.push(msg.payload.state);
      else if (msg.event === 'showAlert') k.alerts++;
      else if (msg.event === 'showOk') k.oks++;
      else if (msg.event === 'sendToPropertyInspector') k.pi.push(msg.payload);
    });
  });

  const desk = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sidra-desk-'));
  const xdgHome = path.join(desk, 'xdg home'); // a space, to exercise Exec quoting
  const xdgSys = path.join(desk, 'sys');
  fs.mkdirSync(path.join(xdgHome, 'applications'), { recursive: true });
  fs.mkdirSync(path.join(xdgSys, 'applications'), { recursive: true });
  const launchReport = path.join(xdgHome, 'launched.json');
  const desktopEntry = path.join(xdgHome, 'applications', 'sidra.desktop');
  fs.writeFileSync(
    desktopEntry,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Sidra',
      `Exec="${process.execPath}" "${path.join(__dirname, 'fake-sidra-app.js')}" --remote-debugging-port=9222 "${path.join(ART, 'album1.jpg')}" "${launchReport}" %U`,
      'StartupWMClass=Sidra',
      '',
      '[Desktop Action PlayPause]',
      'Exec=dbus-send --print-reply --dest=org.mpris.MediaPlayer2.sidra /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.PlayPause',
      '',
    ].join('\n'),
  );
  // Stand-ins for the sound server tools the visualizer uses: pactl lists a Sidra stream (and
  // another app's), parec streams a pulsing 440 Hz + 1.5 kHz signal in real time and logs how it
  // was started. (A perfectly steady tone would give identical frames, which the plugin skips.)
  const fakeBin = path.join(desk, 'bin');
  const parecLog = path.join(desk, 'parec.log');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'pactl'),
    `#!${process.execPath}\n` +
      `const json = process.argv.includes('json');\n` +
      `const list = [{ index: 3, corked: false, properties: { 'application.name': 'Firefox' } }, { index: 7, corked: false, properties: { 'application.name': 'Sidra', 'application.process.binary': 'sidra' } }];\n` +
      `process.stdout.write(json ? JSON.stringify(list) : '');\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'parec'),
    `#!${process.execPath}\n` +
      `require('fs').appendFileSync(${JSON.stringify(parecLog)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n');\n` +
      `const rate = 22050; let n = 0;\n` +
      `setInterval(() => { const b = Buffer.alloc(441 * 2); for (let i = 0; i < 441; i++, n++) { const t = n / rate; const beat = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * 2.3 * t)); b.writeInt16LE(Math.round(9000 * beat * Math.sin(2 * Math.PI * 440 * t) + 3000 * Math.abs(Math.sin(Math.PI * 3.7 * t)) * Math.sin(2 * Math.PI * 1500 * t)), i * 2); } process.stdout.write(b); }, 20);\n` +
      `process.on('SIGTERM', () => process.exit(0));\n`,
    { mode: 0o755 },
  );
  const parecRuns = () => (fs.existsSync(parecLog) ? fs.readFileSync(parecLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const pluginEnv = {
    ...process.env,
    XDG_DATA_HOME: xdgHome,
    XDG_DATA_DIRS: xdgSys,
    APPIMAGE: '/home/user/Applications/OpenDeck.AppImage',
    APPDIR: '/tmp/.mount_OpenDeXYZ',
    PATH: `${fakeBin}:/tmp/.mount_OpenDeXYZ/usr/bin:${process.env.PATH}`,
  };

  const logFile = OUT ? fs.createWriteStream(path.join(OUT, 'plugin.log')) : null;
  let pluginLog = '';
  const child = spawn(process.execPath, ['bin/plugin.js', '-port', String(odPort), '-pluginUUID', NS, '-registerEvent', 'registerPlugin', '-info', '{}'], {
    cwd: PLUGIN,
    env: pluginEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    pluginLog += d;
    logFile && logFile.write(d);
  });
  child.stderr.on('data', (d) => {
    logFile && logFile.write(d);
    process.stderr.write(`[plugin stderr] ${d}`);
  });

  const send = (obj) => pluginSocket.send(JSON.stringify(obj));
  const ctx = (name) => `dev1.Default.Keypad.${name}.0`;
  const C = {
    art: ctx(0),
    play: ctx(1),
    pause: ctx(2),
    next: ctx(3),
    previous: ctx(4),
    shuffle: ctx(5),
    library: ctx(6),
    song: ctx(7),
  };
  const ACTION = {
    art: `${NS}.playpauseart`,
    play: `${NS}.play`,
    pause: `${NS}.pause`,
    next: `${NS}.next`,
    previous: `${NS}.previous`,
    shuffle: `${NS}.shuffle`,
    library: `${NS}.library`,
    song: `${NS}.nowplaying`,
  };
  const appear = (name, settings = {}) =>
    send({ event: 'willAppear', action: ACTION[name], context: C[name], device: 'dev1', payload: { settings, state: 0, controller: 'Keypad' } });
  const keyEvent = (event, name) => send({ event, action: ACTION[name], context: C[name], device: 'dev1', payload: { settings: {} } });
  // Like real hardware: a press is a keyDown followed shortly by a keyUp.
  const press = (name) => {
    keyEvent('keyDown', name);
    setTimeout(() => keyEvent('keyUp', name), 40);
  };
  const hold = async (name, ms) => {
    keyEvent('keyDown', name);
    await sleep(ms);
    keyEvent('keyUp', name);
  };
  const k = (name) => keys[C[name]] || { images: [], titles: [], states: [], alerts: 0, oks: 0, pi: [] };
  const last = (arr) => arr[arr.length - 1];
  const svgText = (uri) => (uri && uri.startsWith('data:image/svg+xml;base64,') ? Buffer.from(uri.split(',')[1], 'base64').toString() : '');
  const saved = [];
  let pngAuto = null;
  const save = (label, name) => {
    if (!OUT) return;
    const img = last(k(name).images);
    const title = last(k(name).titles) || '';
    saved.push({ label, image: img, title, state: last(k(name).states) });
  };

  console.log('Sidra Companion Plugin — end-to-end');

  await step('manifest: "Sidra Companion Plugin" by zaldivarn', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
    assert.equal(manifest.Name, 'Sidra Companion Plugin');
    assert.equal(manifest.Author, 'zaldivarn');
  });

  await step('plugin registers with OpenDeck and asks for global settings', async () => {
    await waitFor(() => pluginSocket, 'registerPlugin');
    await waitFor(() => globalSettingsRequests.length, 'getGlobalSettings');
  });

  await step('keys render on appear (Sidra paused on track 1)', async () => {
    for (const name of Object.keys(C)) appear(name);
    await waitFor(() => /^data:image\/jpeg;base64,/.test(last(k('art').images) || ''), 'album art on the Play/Pause key');
    await waitFor(() => last(k('song').titles) === 'Sunrise\nThe Testers', 'song text');
    await waitFor(() => /^data:image\/jpeg;base64,/.test(last(k('song').images) || ''), 'song background');
    assert.ok(!k('art').images.some((i) => svgText(i).includes('Sidra closed')), 'no "Sidra closed" placeholder while still connecting');
    assert.ok(!k('song').titles.includes('Sidra\nclosed'), 'no "Sidra closed" flash while still connecting');
    assert.equal(last(k('shuffle').states), 0);
    save('Play/Pause art · paused', 'art');
    save('Song Display · short', 'song');
  });

  await step('library check marks a song that is already in the library', async () => {
    await waitFor(() => k('library').states.includes(1), 'library state 1 for track 1001', 5000);
    assert.ok(apiCalls.some((c) => c.path === '/v1/catalog/gb/songs/1001' && c.params.relate === 'library'));
    save('Add to Library · in library', 'library');
  });

  await step('Play/Pause (album art) toggles playback and redraws as plain album art', async () => {
    const before = k('art').images.length;
    press('art');
    await waitFor(() => sidra.calls.includes('PlayPause'), 'PlayPause call');
    await waitFor(() => k('art').images.length > before, 'art re-render');
    assert.equal(sidra.status, 'Playing');
    assert.notEqual(last(k('art').images), k('art').images[before - 1]);
    save('Play/Pause art · playing', 'art');
  });

  await step('Play, Pause and Previous send their MPRIS methods', async () => {
    press('pause');
    await waitFor(() => sidra.calls.includes('Pause'), 'Pause');
    press('play');
    await waitFor(() => sidra.calls.includes('Play'), 'Play');
    press('previous');
    await waitFor(() => sidra.calls.includes('Previous'), 'Previous');
    press('next'); // back to track 1 (previous wrapped to track 3)
    await waitFor(() => sidra.calls.filter((c) => c === 'Next').length === 1, 'Next');
    await waitFor(() => last(k('song').titles) === 'Sunrise\nThe Testers', 'back on track 1');
  });

  await step('Toggle Shuffle flips the MPRIS Shuffle property and the key state', async () => {
    press('shuffle');
    await waitFor(() => sidra.calls.includes('SetShuffle:true'), 'SetShuffle true');
    await waitFor(() => last(k('shuffle').states) === 1, 'shuffle state 1');
    save('Toggle Shuffle · on', 'shuffle');
    press('shuffle');
    await waitFor(() => sidra.calls.includes('SetShuffle:false'), 'SetShuffle false');
    await waitFor(() => last(k('shuffle').states) === 0, 'shuffle state 0');
    save('Toggle Shuffle · off', 'shuffle');
  });

  await step('Next Song moves to track 2: PNG cover (named .jpg) decodes, long text scrolls', async () => {
    syncNowPlaying(1);
    const imgs = k('art').images.length;
    press('next');
    await waitFor(() => sidra.index === 1, 'track 2');
    await waitFor(() => k('art').images.length > imgs, 'art for track 2');
    await waitFor(() => (last(k('song').titles) || '').startsWith('A Rather Lo'), 'song title for track 2');
    const firstFrame = last(k('song').titles);
    assert.equal(firstFrame.split('\n')[0].length, 12, 'scrolling window is 12 chars wide');
    await sleep(3500);
    const frames = new Set(k('song').titles.slice(-6));
    assert.ok(frames.size >= 3, `marquee should advance (saw ${frames.size} distinct frames)`);
    pngAuto = last(k('art').images);
    save('Play/Pause art · PNG cover', 'art');
    save('Song Display · scrolling', 'song');
  });

  await step('library check reports track 2 as not in library', async () => {
    await waitFor(() => last(k('library').states) === 0, 'library state back to 0');
    await sleep(1500); // let the post-track-change check run
    assert.equal(last(k('library').states), 0);
    save('Add to Library · not in library', 'library');
  });

  await step('Add to Library POSTs the catalogue id through MusicKit and flips to In Library', async () => {
    const oks = k('library').oks;
    press('library');
    await waitFor(() => k('library').oks > oks, 'showOk');
    assert.ok(apiCalls.some((c) => c.method === 'POST' && c.path === '/v1/me/library' && c.params['ids[songs]'] === '1002'));
    assert.equal(last(k('library').states), 1);
  });

  await step('Add to Library falls back to a direct amp-api request without mk.api', async () => {
    useMusicKitApi = false;
    library.delete('1002');
    const before = apiCalls.length;
    press('library');
    await waitFor(() => apiCalls.slice(before).some((c) => c.via === 'fetch' && c.method === 'POST'), 'fetch POST');
    const post = apiCalls.slice(before).find((c) => c.via === 'fetch' && c.method === 'POST');
    assert.equal(post.params['ids[songs]'], '1002');
    assert.equal(post.auth.Authorization, 'Bearer DEV');
    assert.equal(post.auth['Music-User-Token'], 'USER');
    useMusicKitApi = true;
  });

  await step('track 3 cover comes over http, asking the CDN for a 288px rendition', async () => {
    syncNowPlaying(2);
    const imgs = k('art').images.length;
    press('next');
    await waitFor(() => sidra.index === 2, 'track 3');
    await waitFor(() => k('art').images.length > imgs, 'art for track 3');
    assert.ok(cdnHits.includes('/image/thumb/Music/aa/bb/288x288bb.jpg'), `CDN hits: ${cdnHits}`);
    save('Play/Pause art · http cover', 'art');
  });

  await step('https→file:// cover swap for the same track does not redraw the key', async () => {
    await sleep(300);
    const imgs = k('art').images.length;
    sidra.swapArt(`file://${ART}/album3.jpg`);
    await sleep(600);
    assert.equal(k('art').images.length, imgs);
  });

  await step('settings changes re-render (corner pause icon, song only, no scroll, plain background)', async () => {
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { indicator: 'badge', dimWhenPaused: true } } });
    send({ event: 'didReceiveSettings', action: ACTION.song, context: C.song, payload: { settings: { fields: 'title', scroll: false, background: 'plain' } } });
    syncNowPlaying(1);
    const artBefore = k('art').images.length;
    press('previous');
    await waitFor(() => sidra.index === 1, 'track 2 again');
    await waitFor(() => k('art').images.length > artBefore, 'art re-render with new settings');
    await sleep(500); // let any superseded render settle
    assert.equal(sidra.status, 'Playing');
    assert.equal(last(k('art').images), pngAuto, 'while playing the key is plain album art whatever the paused-icon setting');
    await waitFor(() => last(k('song').titles) === 'A Rather\nLong Song\nTitle That…', `wrapped title, got ${JSON.stringify(last(k('song').titles))}`);
    await waitFor(() => /^data:image\/svg\+xml/.test(last(k('song').images)), 'plain background');
    save('Song Display · wrapped, plain', 'song');
    const beforePause = k('art').images.length;
    press('pause');
    await waitFor(() => k('art').images.length > beforePause, 'art re-render on pause');
    assert.notEqual(last(k('art').images), pngAuto, 'paused rendering differs');
    save('Play/Pause art · paused, corner icon', 'art');
    press('play');
    await waitFor(() => sidra.status === 'Playing', 'playing again');
  });

  await step('Song Display press raises the Sidra window', async () => {
    press('song');
    await waitFor(() => sidra.calls.includes('Raise'), 'Raise');
  });

  await step('property inspector status for Add to Library reports both connections', async () => {
    send({ event: 'propertyInspectorDidAppear', action: ACTION.library, context: C.library });
    const st = await waitFor(() => last(k('library').pi), 'PI status');
    assert.equal(st.sidra, 'connected');
    assert.equal(st.cdp.ok, true);
    assert.match(st.cdp.message, /music\.apple\.com\/gb\/new/);
    send({ event: 'propertyInspectorDidDisappear', action: ACTION.library, context: C.library });
  });

  await step('Sidra quitting: placeholders, "Sidra closed", and presses show an alert', async () => {
    await sidra.stop();
    await waitFor(() => last(k('song').titles) === 'Sidra\nclosed', 'closed text');
    await waitFor(() => /^data:image\/svg\+xml/.test(last(k('art').images)), 'placeholder art');
    const alerts = k('play').alerts;
    press('play');
    await waitFor(() => k('play').alerts > alerts, 'alert on play');
    save('Play/Pause art · Sidra closed', 'art');
    save('Song Display · Sidra closed', 'song');
  });

  await step('album-art key settings show which launcher will open Sidra', async () => {
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { indicator: 'auto' } } });
    send({ event: 'propertyInspectorDidAppear', action: ACTION.art, context: C.art });
    const st = await waitFor(() => last(k('art').pi), 'PI status for art key');
    assert.equal(st.sidra, 'not running');
    assert.ok(st.launch.ok, JSON.stringify(st.launch));
    assert.ok(st.launch.message.includes('xdg home/applications/sidra.desktop'), st.launch.message);
    send({ event: 'propertyInspectorDidDisappear', action: ACTION.art, context: C.art });
  });

  await step('pressing the album-art key on the "Sidra closed" screen opens Sidra from its desktop entry', async () => {
    const imgs = k('art').images.length;
    const songTitles = k('song').titles.length;
    press('art');
    await waitFor(() => k('art').images.slice(imgs).some((i) => svgText(i).includes('Opening')), '"Opening…" on the key');
    await waitFor(() => k('song').titles.slice(songTitles).includes('Opening\nSidra…'), '"Opening Sidra…" on Song Display');
    const report = await waitFor(() => fs.existsSync(launchReport) && JSON.parse(fs.readFileSync(launchReport, 'utf8')), 'Sidra started', 6000);
    assert.deepEqual(report.argv, ['--remote-debugging-port=9222', path.join(ART, 'album1.jpg'), launchReport], 'Exec args kept, %U dropped');
    assert.equal(report.env.APPIMAGE, null, "OpenDeck's APPIMAGE must not leak into Sidra");
    assert.ok(!report.env.PATH.includes('.mount_OpenDe'), 'AppImage mount stripped from PATH');
    await waitFor(() => last(k('song').titles) === 'Launched', 'plugin attached to the launched Sidra');
    await waitFor(() => /^data:image\/jpeg/.test(last(k('art').images)), 'album art for the launched Sidra');
    assert.match(pluginLog, /Opening Sidra via desktop entry/);
    save('Play/Pause art · after opening Sidra', 'art');
    process.kill(report.pid, 'SIGTERM');
    await waitFor(() => svgText(last(k('art').images)).includes('Sidra closed'), 'closed again');
  });

  await step('with "Opens Sidra" turned off, pressing the closed key only alerts', async () => {
    fs.rmSync(launchReport, { force: true });
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { launchWhenClosed: false } } });
    const alerts = k('art').alerts;
    press('art');
    await waitFor(() => k('art').alerts > alerts, 'alert');
    await sleep(1200);
    assert.ok(!fs.existsSync(launchReport), 'nothing was started');
  });

  await step('a launch command that fails alerts and goes back to "Sidra closed"', async () => {
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { launchWhenClosed: true, launchCommand: 'exit 3' } } });
    const alerts = k('art').alerts;
    press('art');
    await waitFor(() => k('art').alerts > alerts, 'alert');
    await waitFor(() => svgText(last(k('art').images)).includes('Sidra closed'), 'closed caption restored');
    assert.match(pluginLog, /exited straight away \(exit code 3\) when started via custom command: exit 3/);
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: {} } });
  });

  await step('Sidra coming back is picked up without restarting the plugin', async () => {
    syncNowPlaying(0);
    sidra = await startMockSidra({ tracks: tracks.map((t) => ({ ...t })) });
    await waitFor(() => last(k('song').titles) === 'Sunrise', 'reattached (song-only mode)');
    await waitFor(() => /^data:image\/jpeg/.test(last(k('art').images)), 'art back');
    press('art');
    await waitFor(() => sidra.calls.includes('PlayPause'), 'PlayPause after restart');
  });

  const count = (name) => sidra.calls.filter((c) => c === name).length;

  await step('album-art key: a tap plays/pauses on release, holding skips to the next song', async () => {
    const pp = count('PlayPause'), nx = count('Next');
    keyEvent('keyDown', 'art');
    await sleep(250);
    assert.equal(count('PlayPause'), pp, 'nothing happens until the key is released or held long enough');
    keyEvent('keyUp', 'art');
    await waitFor(() => count('PlayPause') === pp + 1, 'tap → PlayPause');
    assert.equal(count('Next'), nx);

    const before = sidra.index;
    await hold('art', 900);
    await waitFor(() => count('Next') === nx + 1, 'hold → Next');
    await sleep(300);
    assert.equal(count('Next'), nx + 1, 'one skip per hold');
    assert.equal(count('PlayPause'), pp + 1, 'releasing after a skip does not also play/pause');
    assert.equal(sidra.index, (before + 1) % tracks.length);
  });

  await step('hold time setting: a 0.6 s hold skips at "short" but not at "long"', async () => {
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { holdTime: 'long' } } });
    const pp = count('PlayPause'), nx = count('Next');
    await hold('art', 600);
    await waitFor(() => count('PlayPause') === pp + 1, 'released before 0.8 s → PlayPause');
    assert.equal(count('Next'), nx);
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { holdTime: 'short' } } });
    await hold('art', 600);
    await waitFor(() => count('Next') === nx + 1, 'held past 0.35 s → Next');
  });

  await step('v1.3 "hold to skip" switched off carries over: the key toggles on press, holding never skips', async () => {
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: { holdToSkip: false } } });
    const pp = count('PlayPause'), nx = count('Next');
    keyEvent('keyDown', 'art');
    await waitFor(() => count('PlayPause') === pp + 1, 'PlayPause straight away on keyDown');
    await sleep(900);
    keyEvent('keyUp', 'art');
    await sleep(200);
    assert.equal(count('Next'), nx);
    assert.equal(count('PlayPause'), pp + 1);
    send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings: {} } });
  });

  const artSettings = (settings) => send({ event: 'didReceiveSettings', action: ACTION.art, context: C.art, payload: { settings } });
  const doubleTap = async (name, gap = 120) => {
    press(name);
    await sleep(gap);
    press(name);
  };

  await step('double-tap → Previous song (hold still Next): no play/pause, one Previous', async () => {
    artSettings({ doubleTapAction: 'previous' });
    const pp = count('PlayPause'), pv = count('Previous'), nx = count('Next');
    await doubleTap('art');
    await waitFor(() => count('Previous') === pv + 1, 'Previous on double-tap');
    await sleep(600);
    assert.equal(count('Previous'), pv + 1);
    assert.equal(count('PlayPause'), pp, 'a double-tap is not also a play/pause');
    assert.equal(count('Next'), nx);
    await hold('art', 800);
    await waitFor(() => count('Next') === nx + 1, 'hold still skips forward');
  });

  await step('with double-tap on, a single tap plays/pauses only after the double-tap wait', async () => {
    artSettings({ doubleTapAction: 'previous', doubleTapTime: 'relaxed' }); // 0.5 s
    const pp = count('PlayPause'), pv = count('Previous');
    press('art');
    await sleep(300);
    assert.equal(count('PlayPause'), pp, 'still waiting for a possible second tap');
    await waitFor(() => count('PlayPause') === pp + 1, 'PlayPause once the wait ends', 1500);
    assert.equal(count('Previous'), pv);
  });

  await step('hold → Replay song seeks back to 0:00 and flashes OK', async () => {
    artSettings({ holdAction: 'replay' });
    const oks = k('art').oks, idx = sidra.index;
    await hold('art', 800);
    await waitFor(() => sidra.calls.includes('Seek:-86400000000'), 'Seek back past the start');
    await waitFor(() => k('art').oks > oks, 'OK flash');
    assert.equal(sidra.index, idx, 'same song');
  });

  await step('double-tap → Replay with hold off: holding is just a (late) tap', async () => {
    artSettings({ holdAction: 'none', doubleTapAction: 'replay', doubleTapTime: 'fast' });
    const seeks = sidra.calls.filter((c) => c.startsWith('Seek:')).length, pp = count('PlayPause'), nx = count('Next');
    await doubleTap('art', 100);
    await waitFor(() => sidra.calls.filter((c) => c.startsWith('Seek:')).length === seeks + 1, 'Seek on double-tap');
    await hold('art', 900);
    await waitFor(() => count('PlayPause') === pp + 1, 'long press without hold action → PlayPause', 1500);
    assert.equal(count('Next'), nx);
  });

  await step('hold → Previous, double-tap → Next: both gestures at once', async () => {
    artSettings({ holdAction: 'previous', doubleTapAction: 'next' });
    const pv = count('Previous'), nx = count('Next'), pp = count('PlayPause');
    await hold('art', 800);
    await waitFor(() => count('Previous') === pv + 1, 'hold → Previous');
    await doubleTap('art');
    await waitFor(() => count('Next') === nx + 1, 'double-tap → Next');
    await sleep(500);
    assert.equal(count('PlayPause'), pp);
  });

  await step('both gestures off: play/pause on press, as in v1.2', async () => {
    artSettings({ holdAction: 'none', doubleTapAction: 'none' });
    const pp = count('PlayPause');
    keyEvent('keyDown', 'art');
    await waitFor(() => count('PlayPause') === pp + 1, 'PlayPause on keyDown');
    keyEvent('keyUp', 'art');
    artSettings({});
  });

  await step('a hold cut short by the key disappearing (profile switch) does not skip', async () => {
    const nx = count('Next');
    keyEvent('keyDown', 'art');
    await sleep(100);
    send({ event: 'willDisappear', action: ACTION.art, context: C.art, device: 'dev1', payload: { settings: {} } });
    await sleep(800);
    assert.equal(count('Next'), nx);
    appear('art');
    await waitFor(() => /^data:image\/jpeg/.test(last(k('art').images)), 'art key back');
  });

  // ---------------------------------------------------------------- song text + visualizer
  // Still frames are JPEG, visualizer frames PNG.
  const jpegPixel = (uri, x, y) => {
    const bytes = Buffer.from(uri.split(',')[1], 'base64');
    const img = uri.startsWith('data:image/png') ? require('../src/png').decodePng(bytes) : require('jpeg-js').decode(bytes, { formatAsRGBA: true });
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const titleParams = (alignment) =>
    send({
      event: 'titleParametersDidChange',
      action: ACTION.art,
      context: C.art,
      device: 'dev1',
      payload: { settings: {}, titleParameters: { titleAlignment: alignment, showTitle: true, fontSize: 9 } },
    });

  await step('album-art key: song text is off by default and leaves the key title alone', async () => {
    artSettings({});
    await sleep(300);
    const before = k('art').titles.length;
    syncNowPlaying(0);
    sidra.setTrack(0);
    sidra.setStatus('Playing');
    await waitFor(() => /^data:image\/jpeg/.test(last(k('art').images)), 'art for Sunrise');
    await sleep(300);
    assert.equal(k('art').titles.length, before, 'no setTitle while song text is off');
  });

  await step('album-art key: "Artist + song" text, cover darkened behind it at the title position', async () => {
    titleParams('bottom');
    const plain = last(k('art').images);
    artSettings({ textFields: 'artist-title' });
    await waitFor(() => last(k('art').titles) === 'The Testers\nSunrise', `art title, got ${JSON.stringify(last(k('art').titles))}`);
    await waitFor(() => last(k('art').images) !== plain, 'shaded render');
    const shaded = last(k('art').images);
    const lum = (uri, y) => jpegPixel(uri, 72, y).reduce((a, b) => a + b, 0);
    assert.ok(lum(shaded, 130) < lum(plain, 130) * 0.7, 'bottom darkened');
    assert.ok(Math.abs(lum(shaded, 12) - lum(plain, 12)) < 30, 'top untouched');
    titleParams('top');
    await waitFor(() => last(k('art').images) !== shaded, 'shade moves to the top');
    const top = last(k('art').images);
    assert.ok(lum(top, 12) < lum(plain, 12) * 0.7, 'top darkened');
    save('Play/Pause art · song text', 'art');
    titleParams('bottom');
  });

  await step('album-art key: switching song text off clears the title it set', async () => {
    artSettings({ textFields: 'none' });
    await waitFor(() => last(k('art').titles) === '', 'title cleared');
  });

  await step("visualizer: captures only Sidra's stream and animates the key while playing", async () => {
    const imgs = k('art').images.length;
    artSettings({ viz: true, vizFps: 'medium' });
    const run = await waitFor(() => parecRuns()[0], 'parec started', 5000);
    assert.ok(run.args.includes('--monitor-stream=7'), `parec args ${run.args.join(' ')}`);
    assert.ok(run.args.includes('--rate=22050') && run.args.includes('--channels=1'));
    await waitFor(() => k('art').images.length > imgs + 5, 'frames arriving', 4000);
    const n0 = k('art').images.length;
    await sleep(1000);
    const perSecond = k('art').images.length - n0;
    assert.ok(perSecond >= 8 && perSecond <= 14, `~12 frames a second (got ${perSecond})`);
    // 440 Hz lands in bar 6 of 16; it should be lit, and a high bar should be at rest.
    const frame = last(k('art').images);
    const barX = (i) => Math.round(9 + i * ((144 - 18 - 2.2 * 15) / 16 + 2.2) + 2.9);
    const bright = (p) => p.reduce((a, b) => a + b, 0) / 3;
    assert.ok(bright(jpegPixel(frame, barX(6), 100)) > 150, 'bar 6 is up');
    assert.ok(bright(jpegPixel(frame, barX(14), 100)) < bright(jpegPixel(frame, barX(6), 100)) - 60, 'bar 14 stays low');
    save('Play/Pause art · visualizer (album colour)', 'art');
  });

  await step('visualizer: custom colour', async () => {
    artSettings({ viz: true, vizColorMode: 'custom', vizColor: '#ff2020' });
    await sleep(500);
    const frame = last(k('art').images);
    const barX = Math.round(9 + 6 * ((144 - 18 - 2.2 * 15) / 16 + 2.2) + 2.9);
    const [r, g, b] = jpegPixel(frame, barX, 110);
    assert.ok(r > 200 && g < 110 && b < 110, `bar colour ${[r, g, b]}`);
    artSettings({ viz: true, vizColorMode: 'custom', vizColor: '#ff2020', vizStyle: 'center', textFields: 'title' });
    await waitFor(() => last(k('art').titles) === 'Sunrise', 'text with the visualizer');
    await sleep(400);
    save('Play/Pause art · centre bars + song text', 'art');
  });

  await step('visualizer: pausing stops capture and frames, and shows the paused key', async () => {
    const pid = last(parecRuns()).pid;
    sidra.setStatus('Paused');
    await waitFor(() => !alive(pid), 'parec stopped', 3000);
    await sleep(300);
    const n = k('art').images.length;
    await sleep(800);
    assert.equal(k('art').images.length, n, 'no frames while paused');
    const paused = last(k('art').images);
    assert.ok(jpegPixel(paused, 65, 72).reduce((a, b) => a + b) / 3 > 200, 'pause icon showing');
  });

  await step('visualizer: "Everything playing" records the default output instead', async () => {
    const runs = parecRuns().length;
    artSettings({ viz: true, vizSource: 'all' });
    sidra.setStatus('Playing');
    const run = await waitFor(() => parecRuns()[runs], 'parec restarted', 5000);
    assert.deepEqual(run.args.slice(0, 2), ['-d', '@DEFAULT_MONITOR@']);
    await waitFor(() => k('art').images.length > 3, 'frames');
  });

  await step('visualizer: turning it off stops capture; the key goes back to the plain cover', async () => {
    const pid = last(parecRuns()).pid;
    artSettings({});
    await waitFor(() => !alive(pid), 'parec stopped', 3000);
    await sleep(400);
    const n = k('art').images.length;
    await sleep(600);
    assert.equal(k('art').images.length, n, 'no more frames');
  });

  await step('Add to Library without a DevTools port shows an alert with a setup hint', async () => {
    send({ event: 'didReceiveGlobalSettings', payload: { settings: { cdpPort: 1 } } });
    const alerts = k('library').alerts;
    press('library');
    await waitFor(() => k('library').alerts > alerts, 'alert');
    send({ event: 'propertyInspectorDidAppear', action: ACTION.library, context: C.library });
    const st = await waitFor(() => {
      const s = last(k('library').pi);
      return s && s.cdpPort === 1 && s;
    }, 'PI status with port 1');
    assert.equal(st.cdp.ok, false);
    assert.match(st.cdp.message, /--remote-debugging-port=1/);
  });

  await step('plugin exits when OpenDeck closes the socket', async () => {
    const exited = new Promise((r) => child.once('exit', r));
    pluginSocket.close();
    const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
    assert.equal(code, 0);
  });

  if (OUT) fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(saved, null, 2));
  console.log(`\n${passed} checks passed`);
  await sidra.stop().catch(() => {});
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
