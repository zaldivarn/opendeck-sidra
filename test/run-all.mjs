// npm test: unit checks, then the end-to-end run on a private D-Bus session bus.
import { spawnSync } from 'child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, ['test/unit.js']);
run(process.execPath, ['test/pi.js']);
run('node', ['build.mjs']);
run('dbus-run-session', ['--', process.execPath, 'test/e2e.js', 'test/art', ...process.argv.slice(2)]);
