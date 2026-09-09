// End-to-end boot check (TODO §§0.4, V2.1). No DATABASE_URL: sqlite smoke.
// With DATABASE_URL=postgres://…: derived schema migrates, a claim row
// round-trips through raw SQL, dialect probes return rows. CI runs the PG
// path against the postgres service on every push.
import { execFileSync } from 'node:child_process';

const node = process.execPath;
const run = (args, env = {}) =>
  execFileSync(node, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

if (process.env.DATABASE_URL) {
  console.log('verify-instance: postgres path');
  run(['status', '--db', process.env.DATABASE_URL]);
} else {
  console.log('verify-instance: sqlite path');
  run(['status', '--db', ':memory:']);
}
console.log('verify-instance: OK');
