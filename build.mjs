// Build the OpenDeck plugin folder and the installable .streamDeckPlugin archive.
//   npm run build        -> com.zaldivarn.sidra.sdPlugin/ and dist/com.zaldivarn.sidra.streamDeckPlugin
//   npm run install-local -> also copies the folder into ~/.config/opendeck/plugins/

import { build } from 'esbuild';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const icons = require('./src/icons.js');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const UUID = 'com.zaldivarn.sidra';
const OUT = `${UUID}.sdPlugin`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/bin`, { recursive: true });
fs.mkdirSync(`${OUT}/imgs`, { recursive: true });

// 1. Bundle the plugin into one file that only needs system Node (>= 20).
await build({
  entryPoints: ['src/plugin.js'],
  outfile: `${OUT}/bin/plugin.js`,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false, // pageScript is serialised with toString() and injected into Sidra
  external: ['usocket', 'x11'], // optional add-ons in dbus-next; we connect with plain sockets and never use X11 discovery
  legalComments: 'eof',
  banner: { js: `// Sidra Companion Plugin v${pkg.version} by zaldivarn — built ${new Date().toISOString().slice(0, 10)}. Source: src/` },
  logLevel: 'warning',
});

// 2. Icons.
const write = (name, svg) => fs.writeFileSync(`${OUT}/imgs/${name}.svg`, svg);
// Plugin + category icon: Sidra's own logo (Blue Oak licensed; see assets/NOTICE.md).
fs.copyFileSync('assets/sidra-logo.svg', `${OUT}/imgs/plugin.svg`);
fs.copyFileSync('assets/sidra-logo.svg', `${OUT}/imgs/category.svg`);
fs.copyFileSync('assets/NOTICE.md', `${OUT}/NOTICE.md`);
write('key-play', icons.keys.play());
write('key-pause', icons.keys.pause());
write('key-next', icons.keys.next());
write('key-previous', icons.keys.previous());
write('key-shuffle-off', icons.keys.shuffleOff());
write('key-shuffle-on', icons.keys.shuffleOn());
write('key-library-add', icons.keys.libraryAdd());
write('key-library-done', icons.keys.libraryDone());
write('key-song', icons.keys.songDisplay());
write('key-art', icons.keys.artPlayPause());
write('list-play', icons.listIcon('play'));
write('list-pause', icons.listIcon('pause'));
write('list-next', icons.listIcon('next'));
write('list-previous', icons.listIcon('previous'));
write('list-shuffle', icons.listIcon('shuffle'));
write('list-library', icons.listIcon('libraryAdd'));
write('list-song', icons.listIcon('songLines'));
write('list-art', icons.listIcon('note'));

// 3. Property inspector.
fs.cpSync('plugin-static/pi', `${OUT}/pi`, { recursive: true });

// 4. Manifest.
const action = (id, name, tooltip, list, states, extra = {}) => ({
  UUID: `${UUID}.${id}`,
  Name: name,
  Tooltip: tooltip,
  Icon: `imgs/${list}`,
  States: states,
  Controllers: ['Keypad'],
  ...extra,
});
const img = (image, extra = {}) => ({ Image: `imgs/${image}`, ShowTitle: true, ...extra });

const manifest = {
  $schema: 'https://schemas.elgato.com/streamdeck/plugins/manifest.json',
  Name: 'Sidra Companion Plugin',
  Author: 'zaldivarn',
  Description: 'Control Sidra, the Apple Music client for Linux: transport, shuffle, add to library, now playing and album-art play/pause.',
  Version: pkg.version,
  SDKVersion: 2,
  Icon: 'imgs/plugin',
  Category: 'Sidra',
  CategoryIcon: 'imgs/category',
  CodePath: 'bin/plugin.js',
  CodePathLin: 'bin/plugin.js',
  PropertyInspectorPath: 'pi/index.html',
  OS: [{ Platform: 'linux', MinimumVersion: '0' }],
  Software: { MinimumVersion: '6.4' },
  Nodejs: { Version: '20' },
  Actions: [
    action('playpauseart', 'Play/Pause (Album Art)', 'Play or pause, showing the current album cover', 'list-art', [img('key-art', { Title: '', FontSize: 9, TitleAlignment: 'bottom' })], {
      SupportedInMultiActions: false,
    }),
    action('play', 'Play', 'Start playback in Sidra', 'list-play', [img('key-play')]),
    action('pause', 'Pause', 'Pause playback in Sidra', 'list-pause', [img('key-pause')]),
    action('next', 'Next Song', 'Skip to the next song', 'list-next', [img('key-next')]),
    action('previous', 'Previous Song', 'Go back to the previous song', 'list-previous', [img('key-previous')]),
    action(
      'shuffle',
      'Toggle Shuffle',
      'Turn shuffle on or off',
      'list-shuffle',
      [img('key-shuffle-off', { Name: 'Shuffle off' }), img('key-shuffle-on', { Name: 'Shuffle on' })],
      { DisableAutomaticStates: true },
    ),
    action(
      'library',
      'Add to Library',
      'Add the current song to your Apple Music library',
      'list-library',
      [img('key-library-add', { Name: 'Not in library' }), img('key-library-done', { Name: 'In library' })],
      { DisableAutomaticStates: true },
    ),
    action(
      'nowplaying',
      'Song Display',
      'Shows the current song and artist',
      'list-song',
      [img('key-song', { FontSize: 10, TitleAlignment: 'middle', TitleColor: '#FFFFFF' })],
      { SupportedInMultiActions: false },
    ),
  ],
};
fs.writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Package: a zip whose single top-level folder is com.zaldivarn.sidra.sdPlugin/.
fs.mkdirSync('dist', { recursive: true });
const archive = `dist/${UUID}.streamDeckPlugin`;
fs.rmSync(archive, { force: true });
writeZip(archive, OUT);
console.log(`built ${OUT}/ and ${archive}`);

if (process.argv.includes('--install')) {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const flatpak = path.join(os.homedir(), '.var/app/me.amankhanna.opendeck/config/opendeck/plugins');
  const target = fs.existsSync(path.dirname(flatpak)) ? flatpak : path.join(base, 'opendeck', 'plugins');
  fs.mkdirSync(target, { recursive: true });
  fs.rmSync(path.join(target, OUT), { recursive: true, force: true });
  fs.cpSync(OUT, path.join(target, OUT), { recursive: true });
  console.log(`installed to ${path.join(target, OUT)} — restart OpenDeck (or reload the plugin) to pick it up`);
}

// Minimal stored-deflate zip writer, so building needs no `zip` binary.
function writeZip(file, dir) {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r);
      else entries.push(r);
    }
  };
  walk('');
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const rel of entries) {
    const name = Buffer.from(`${path.basename(dir)}/${rel}`);
    const data = fs.readFileSync(path.join(dir, rel));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4); // made by Unix, so permissions survive
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...chunks, cenBuf, end]));
}

