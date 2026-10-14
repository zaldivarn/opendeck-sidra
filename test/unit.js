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
    const img = raster.decodeJpeg(Buffer.from(uri.split(',')[1], 'base64'));
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

  const legacy = await cache.playPauseKey(url, false, { indicator: 'center', dimWhenPaused: true });
  t("retired 'center' setting renders like the default", () => {
    assert.equal(legacy, pausedAuto);
  });

  console.log(`${n} unit checks passed\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
