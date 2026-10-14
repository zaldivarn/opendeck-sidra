'use strict';

// Stand-in for the Sidra app itself, for the "press to open" test: the plugin starts it from
// a desktop entry, it registers the mock MPRIS service on the session bus like Sidra does,
// and reports how it was started.
// argv: <cover.jpg> <report.json> plus whatever the desktop entry's Exec line added.

const fs = require('fs');
const { startMockSidra } = require('./mock-sidra');

const args = process.argv.slice(2);
const report = args[args.length - 1];
const cover = args[args.length - 2];

(async () => {
  await new Promise((r) => setTimeout(r, 400)); // Sidra takes a moment to load Apple Music
  const sidra = await startMockSidra({
    tracks: [{ id: '2001', title: 'Launched', artist: 'From A Key', album: 'Fresh', artUrl: `file://${cover}` }],
  });
  sidra.setStatus('Playing');
  fs.writeFileSync(
    report,
    JSON.stringify({ pid: process.pid, argv: args, cwd: process.cwd(), env: { APPIMAGE: process.env.APPIMAGE || null, PATH: process.env.PATH } }),
  );
  const quit = async () => {
    await sidra.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
