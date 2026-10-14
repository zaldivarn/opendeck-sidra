'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const text = require('../src/text');
const { sizedArtworkUrl } = require('../src/art');
const { decodePng, isPng } = require('../src/png');
const raster = require('../src/raster');
const { parseMetadata, resolveBusAddress } = require('../src/mpris');
const { Variant } = require('dbus-next');

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
};

console.log('unit');

t('wrap keeps words together and ellipsises the last line', () => {
  assert.deepEqual(text.wrap('A Rather Long Song Title That Needs To Scroll', 10, 3), ['A Rather', 'Long Song', 'Title Tha…']);
  assert.deepEqual(text.wrap('Short', 10, 3), ['Short']);
  assert.deepEqual(text.wrap('Supercalifragilistic', 8, 3), ['Supercal', 'ifragili', 'stic']);
});

t('truncate respects code points (emoji, accents)', () => {
  assert.equal(text.truncate('Beyoncé 🐝 Halo', 9), 'Beyoncé…');
  assert.equal(text.truncate('Halo', 9), 'Halo');
});

t('marquee holds at the start, then scrolls one character per tick and loops', () => {
  const s = 'ABCDEFGHIJKLMNOP';
  assert.equal(text.marquee(s, 6, 0), 'ABCDEF');
  assert.equal(text.marquee(s, 6, 5), 'ABCDEF');
  assert.equal(text.marquee(s, 6, 6), 'BCDEFG');
  const period = s.length + 5 + 5; // text + gap + pause
  assert.equal(text.marquee(s, 6, period), 'ABCDEF');
  assert.equal(text.marquee('Fits', 6, 99), 'Fits');
});

t('Apple artwork URLs are rewritten to a 288px rendition', () => {
  assert.equal(
    sizedArtworkUrl('https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/cc/uuid/196589.jpg/512x512bb.jpg'),
    'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/cc/uuid/196589.jpg/288x288bb.jpg',
  );
  assert.equal(sizedArtworkUrl('https://example.com/a/600x600bb-60.webp'), 'https://example.com/a/288x288bb.jpg');
  assert.equal(sizedArtworkUrl('https://example.com/cover.jpg'), 'https://example.com/cover.jpg');
});

t('PNG decoder handles a real RGB PNG', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'art', 'album2-actually-png.jpg'));
  assert.ok(isPng(buf));
  const img = decodePng(buf);
  assert.equal(img.width, 300);
  assert.equal(img.data.length, 300 * 300 * 4);
});

t('resizeSquare centre-crops and box-filters to 144px', () => {
  const src = raster.createImage(300, 200, [200, 100, 50]);
  const out = raster.resizeSquare(src, 144);
  assert.equal(out.width, 144);
  assert.deepEqual([...out.data.subarray(0, 4)], [200, 100, 50, 255]);
});

t('MPRIS metadata parsing matches Sidra\'s shape', () => {
  const md = parseMetadata({
    'mpris:trackid': new Variant('o', '/org/sidra/track/1440833098'),
    'xesam:title': new Variant('s', 'Song'),
    'xesam:artist': new Variant('as', ['Artist']),
    'xesam:album': new Variant('s', 'Album'),
    'mpris:artUrl': new Variant('s', 'file:///home/user/.cache/sidra/artwork/x-512x512.jpg'),
    'mpris:length': new Variant('x', 215000000n),
  });
  assert.equal(md.trackId, '1440833098');
  assert.equal(md.artist, 'Artist');
  assert.equal(md.lengthUs, 215000000);
});

t('abstract D-Bus addresses become NUL-prefixed socket paths', () => {
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:abstract=/tmp/dbus-XYZ,guid=abc';
  assert.equal(resolveBusAddress(), 'unix:socket=\u0000/tmp/dbus-XYZ');
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
  assert.equal(resolveBusAddress(), 'unix:path=/run/user/1000/bus');
  if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
});

// ---- Opening Sidra ----
const launcher = require('../src/launcher');
const os = require('os');

t('desktop Exec lines become argv, dropping %U and honouring quotes and escapes', () => {
  assert.deepEqual(
    launcher.parseExec('env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/sidra_sidra.desktop /snap/bin/sidra %U'),
    ['env', 'BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/sidra_sidra.desktop', '/snap/bin/sidra'],
  );
  assert.deepEqual(launcher.parseExec('/opt/Sidra/sidra --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 %U'), [
    '/opt/Sidra/sidra',
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
  ]);
  // As written in the file: "a \\"q\\" b"  (string escape first, then quote escape)
  assert.deepEqual(launcher.parseExec('"/home/user/My Apps/Sidra.AppImage" --x "a \\\\"q\\\\" b" 100%% %i', { icon: 'sidra' }), [
    '/home/user/My Apps/Sidra.AppImage',
    '--x',
    'a "q" b',
    '100%',
    '--icon',
    'sidra',
  ]);
});

function fakeXdg() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidra-xdg-'));
  const dir = (p) => {
    const d = path.join(root, p, 'applications');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const home = dir('home'), sys = dir('sys');
  const write = (d, name, body) => fs.writeFileSync(path.join(d, name), `[Desktop Entry]\nType=Application\n${body}\n`);
  const env = { HOME: root, PATH: '/usr/bin:/bin', XDG_DATA_HOME: path.join(root, 'home'), XDG_DATA_DIRS: path.join(root, 'sys') };
  return { root, home, sys, write, env };
}

t("the user's ~/.local/share copy of sidra.desktop wins over the system one", () => {
  const x = fakeXdg();
  x.write(x.sys, 'sidra.desktop', 'Name=Sidra\nExec=/opt/Sidra/sidra %U');
  x.write(x.home, 'sidra.desktop', 'Name=Sidra\nExec=/opt/Sidra/sidra --remote-debugging-port=9222 %U\n[Desktop Action PlayPause]\nExec=dbus-send x');
  const how = launcher.resolve({ env: x.env });
  assert.equal(how.kind, 'desktop');
  assert.equal(how.file, path.join(x.home, 'sidra.desktop'));
  assert.deepEqual(how.argv, ['/opt/Sidra/sidra', '--remote-debugging-port=9222']);
});

t('Hidden=true in the user dir hides the system entry; snap and AppImage entries are found', () => {
  const x = fakeXdg();
  x.write(x.sys, 'sidra.desktop', 'Name=Sidra\nExec=/opt/Sidra/sidra %U');
  x.write(x.home, 'sidra.desktop', 'Hidden=true');
  x.write(x.sys, 'sidra_sidra.desktop', 'Name=Sidra\nExec=env BAMF=1 /snap/bin/sidra %U');
  assert.deepEqual(launcher.resolve({ env: x.env }).argv, ['env', 'BAMF=1', '/snap/bin/sidra']);
  const y = fakeXdg();
  y.write(y.home, 'appimagekit_0a1b-Sidra.desktop', 'Name=Sidra\nStartupWMClass=Sidra\nExec="/home/user/Applications/Sidra-linux-x86_64.AppImage" %U');
  y.write(y.home, 'other.desktop', 'Name=Other\nExec=/usr/bin/other');
  assert.deepEqual(launcher.resolve({ env: y.env }).argv, ['/home/user/Applications/Sidra-linux-x86_64.AppImage']);
});

t('entries whose TryExec is missing are skipped; nothing found means null', () => {
  const x = fakeXdg();
  x.write(x.sys, 'sidra.desktop', 'Name=Sidra\nTryExec=/definitely/not/here/sidra\nExec=/definitely/not/here/sidra %U');
  assert.equal(launcher.resolve({ env: x.env }), null);
});

t('a custom command runs through sh and wins over detection', () => {
  const x = fakeXdg();
  x.write(x.sys, 'sidra.desktop', 'Name=Sidra\nExec=/opt/Sidra/sidra %U');
  const how = launcher.resolve({ command: '  ~/Apps/Sidra.AppImage --x  ', env: x.env });
  assert.deepEqual(how.argv, ['/bin/sh', '-c', '~/Apps/Sidra.AppImage --x']);
});

t("OpenDeck's AppImage packaging is scrubbed from the environment Sidra gets", () => {
  const env = launcher.cleanEnv({
    HOME: '/home/user',
    APPIMAGE: '/home/user/OpenDeck.AppImage',
    APPDIR: '/tmp/.mount_odXYZ',
    PATH: '/tmp/.mount_odXYZ/usr/bin:/usr/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_odXYZ/usr/lib',
    XDG_ACTIVATION_TOKEN: 'stale',
    WAYLAND_DISPLAY: 'wayland-0',
  });
  assert.deepEqual(env, { HOME: '/home/user', PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' });
});

// ---- Visualizer: analysis and drawing ----
const audio = require('../src/audio');

function tone(hz, n = audio.FFT_SIZE, amp = 0.5) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / audio.RATE);
  return out;
}
const peakBand = (levels) => Array.from(levels).indexOf(Math.max(...levels));

t('analyser: a low tone lifts a low bar, a high tone a high bar; silence settles to zero', () => {
  const edges = audio.bandEdges();
  assert.equal(edges.length, audio.BANDS + 1);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1], 'band edges strictly increase');
  const lowA = new audio.Analyser();
  for (let i = 0; i < 10; i++) lowA.update(tone(110));
  const highA = new audio.Analyser();
  for (let i = 0; i < 10; i++) highA.update(tone(4000));
  assert.ok(peakBand(lowA.levels) <= 4, `110 Hz peaks in band ${peakBand(lowA.levels)}`);
  assert.ok(peakBand(highA.levels) >= 12, `4 kHz peaks in band ${peakBand(highA.levels)}`);
  assert.ok(Math.max(...lowA.levels) > 0.8);
  for (let i = 0; i < 30; i++) lowA.update(new Float64Array(audio.FFT_SIZE));
  assert.ok(Math.max(...lowA.levels) < 0.05, 'silence falls back to rest');
});

t('analyser adapts: a quiet song still fills the bars after a moment', () => {
  const a = new audio.Analyser();
  for (let i = 0; i < 200; i++) a.update(tone(440, audio.FFT_SIZE, 0.01)); // -46 dBFS
  assert.ok(Math.max(...a.levels) > 0.7, `quiet tone level ${Math.max(...a.levels).toFixed(2)}`);
});

t("Sidra's stream is recognised by app name or binary, from pactl JSON or text", () => {
  assert.ok(audio.looksLikeSidra({ 'application.name': 'Sidra' }));
  assert.ok(audio.looksLikeSidra({ 'application.name': 'Chromium', 'application.process.binary': 'sidra' }));
  assert.ok(!audio.looksLikeSidra({ 'application.name': 'Firefox', 'application.process.binary': 'firefox' }));
  const text = [
    'Sink Input #12',
    '\tDriver: protocol-native.c',
    '\tCorked: no',
    '\tProperties:',
    '\t\tapplication.name = "Firefox"',
    'Sink Input #57',
    '\tCorked: yes',
    '\tProperties:',
    '\t\tapplication.name = "Sidra"',
    '\t\tapplication.process.binary = "sidra"',
  ].join('\n');
  const parsed = audio.parsePactlText(text);
  assert.deepEqual(parsed.map((s) => [s.index, s.corked, s.properties['application.name']]), [[12, false, 'Firefox'], [57, true, 'Sidra']]);
});

t('bars: bottom style rises from the bottom edge, centre style is mirrored about the middle', () => {
  const lum = (img, x, y) => img.data[(y * 144 + x) * 4];
  const levels = new Array(16).fill(0);
  levels[7] = 1; // one full-height bar
  const bottom = raster.drawBars(raster.createImage(144, 144, [0, 0, 0]), levels, { style: 'bottom', color: [255, 255, 255] });
  const bx = Math.round(9 + 7 * ((144 - 18 - 2.2 * 15) / 16 + 2.2) + 2.9); // middle of bar 7
  assert.ok(lum(bottom, bx, 130) > 200 && lum(bottom, bx, 60) > 200, 'tall bar from the bottom');
  assert.ok(lum(bottom, bx, 30) < 40, 'stops below the top');
  assert.ok(lum(bottom, 20, 100) < 40, 'quiet bars stay short');
  const centre = raster.drawBars(raster.createImage(144, 144, [0, 0, 0]), levels, { style: 'center', color: [255, 255, 255] });
  assert.ok(lum(centre, bx, 72) > 200 && lum(centre, bx, 40) > 200 && lum(centre, bx, 104) > 200, 'mirrored about the middle');
  assert.ok(lum(centre, bx, 135) < 40, 'leaves the bottom edge clear');
});

t('album colour: a contrasting colour from the cover, else a light tint of its main colour', () => {
  // Purple sky with a yellow sun: the sun's colour wins, so bars stand out from the sky.
  const sunset = raster.createImage(144, 144, [110, 40, 150]);
  for (let y = 30; y < 70; y++) for (let x = 50; x < 95; x++) sunset.data.set([250, 210, 70], (y * 144 + x) * 4);
  const [r1, g1, b1] = raster.accentColour(sunset);
  assert.ok(r1 > 200 && g1 > 160 && b1 < 120, `sunset → ${[r1, g1, b1]}`);
  // One colour only: a light tint of it, which reads over the cover itself.
  const [r2, g2, b2] = raster.accentColour(raster.createImage(144, 144, [170, 20, 40]));
  assert.ok(r2 > 220 && r2 > g2 && r2 > b2 && g2 > 150, `red cover → ${[r2, g2, b2]}`);
  // Greyscale: soft white.
  assert.deepEqual(raster.accentColour(raster.createImage(144, 144, [128, 128, 128])), [235, 235, 240]);
  assert.deepEqual(raster.parseHex('#3AD1FF'), [58, 209, 255]);
  assert.deepEqual(raster.parseHex('nope', [1, 2, 3]), [1, 2, 3]);
});

// ---- Play/Pause (Album Art) key rendering, checked at the pixel level ----
(async () => {
  const os = require('os');
  const { ArtCache } = require('../src/art');
  const grey = raster.createImage(300, 300, [128, 128, 128]);
  const coverPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sidra-art-')), 'cover.jpg');
  fs.writeFileSync(coverPath, Buffer.from(raster.encodeJpeg(grey, 95).split(',')[1], 'base64'));
  const url = `file://${coverPath}`;
  const cache = new ArtCache();
  const px = (uri, x, y) => {
    const img = decodePng(Buffer.from(uri.split(',')[1], 'base64'));
    const i = (y * img.width + x) * 4;
    return Math.round((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
  };
  const near = (v, want, tol = 6) => Math.abs(v - want) <= tol;
  // Pause glyph geometry from raster.drawPauseGlyph: centred icon has bars at x≈62–69 and 75–82,
  // corner icon (centre 118,118) has its left bar at x≈112–116.
  const CENTRE_BAR = [65, 72], CENTRE_GAP = [72, 72], CORNER_BAR = [114, 118], CORNER_GAP = [118, 118];

  for (const indicator of ['auto', 'badge', 'none']) {
    const playing = await cache.playPauseKey(url, true, { indicator, dimWhenPaused: true });
    t(`playing (${indicator}): just the cover, no icon anywhere`, () => {
      for (const [x, y] of [CENTRE_BAR, CENTRE_GAP, CORNER_BAR, CORNER_GAP, [10, 10]]) {
        assert.ok(near(px(playing, x, y), 128), `pixel ${x},${y} = ${px(playing, x, y)}`);
      }
    });
  }

  const pausedAuto = await cache.playPauseKey(url, false, { indicator: 'auto', dimWhenPaused: true });
  t('paused (default): dimmed cover with a large centred pause icon, not a play triangle', () => {
    assert.ok(px(pausedAuto, ...CENTRE_BAR) > 220, 'white pause bar in the centre');
    // The old play triangle covered the centre point; the pause icon leaves a gap there.
    assert.ok(px(pausedAuto, ...CENTRE_GAP) < 50, 'dark gap between the bars');
    assert.ok(near(px(pausedAuto, ...CORNER_GAP), 58), 'rest of the cover dimmed to 45%');
  });

  const pausedBadge = await cache.playPauseKey(url, false, { indicator: 'badge', dimWhenPaused: true });
  t('paused (corner): small pause icon in the corner, centre left clear', () => {
    assert.ok(px(pausedBadge, ...CORNER_BAR) > 180, 'white pause bar in the corner');
    assert.ok(px(pausedBadge, ...CORNER_GAP) < 50, 'dark gap between the corner bars');
    assert.ok(near(px(pausedBadge, ...CENTRE_GAP), 58), 'centre is just dimmed cover');
  });

  const pausedNone = await cache.playPauseKey(url, false, { indicator: 'none', dimWhenPaused: false });
  t('paused (no icon, no dim): identical to the playing key', () => {
    assert.ok(near(px(pausedNone, ...CENTRE_BAR), 128));
    assert.ok(near(px(pausedNone, ...CORNER_BAR), 128));
  });

  // Memory-saving paths: reusable PNG scratch buffers and the reused visualizer frame.
  t('PNG encoding round-trips exactly, with scratch buffers shared across sizes', () => {
    for (const size of [72, 144, 72, 96, 72]) {
      const img = raster.createImage(size, size, [0, 0, 0]);
      for (let i = 0; i < img.data.length; i += 4) img.data.set([(i * 7) & 255, (i * 13) & 255, (i * 3) & 255], i);
      const back = decodePng(Buffer.from(raster.encodePng(img).split(',')[1], 'base64'));
      assert.equal(back.width, size);
      for (let i = 0; i < img.data.length; i += 4) {
        if (back.data[i] !== img.data[i] || back.data[i + 1] !== img.data[i + 1] || back.data[i + 2] !== img.data[i + 2]) {
          assert.fail(`pixel ${i / 4} differs at size ${size}`);
        }
      }
    }
  });

  const quiet = new Array(16).fill(0), loud = new Array(16).fill(1);
  const loudFrame = cache.vizFrame(url, loud, { size: 72, color: [255, 0, 0] });
  const quietFrame = cache.vizFrame(url, quiet, { size: 72, color: [255, 0, 0] });
  t('visualizer frames are drawn at the requested key size, and the reused buffer starts clean each frame', () => {
    const a = decodePng(Buffer.from(loudFrame.split(',')[1], 'base64'));
    const b = decodePng(Buffer.from(quietFrame.split(',')[1], 'base64'));
    assert.equal(a.width, 72);
    const at = (img, x, y) => img.data.subarray((y * 72 + x) * 4, (y * 72 + x) * 4 + 3);
    assert.ok(at(a, 30, 30)[0] > 200 && at(a, 30, 30)[1] < 80, 'loud frame: tall red bar');
    assert.deepEqual([...at(b, 30, 30)], [128, 128, 128], 'quiet frame after a loud one: no leftover bar');
  });

  const legacy = await cache.playPauseKey(url, false, { indicator: 'center', dimWhenPaused: true });
  t("retired 'center' setting renders like the default", () => {
    assert.equal(legacy, pausedAuto);
  });

  console.log(`${n} unit checks passed\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
