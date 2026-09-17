// End-to-end boot check (TODO §§0.4, V2.1, FLOW-005).
// Runs `verify` (migrate + meta round-trip), then read-only `status`.
// No DATABASE_URL: sqlite smoke on a temp file. With DATABASE_URL: postgres
// service path CI executes on every push.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const node = process.execPath;
const run = (args, env = {}) => {
  execFileSync(node, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
};

if (process.env.DATABASE_URL) {
  console.log('verify-instance: postgres path');
  run(['verify', '--db', process.env.DATABASE_URL]);
  run(['status', '--db', process.env.DATABASE_URL]);
} else {
  console.log('verify-instance: sqlite path');
  const dir = mkdtempSync(join(tmpdir(), 'vital-verify-'));
  const dbPath = join(dir, 'verify.sqlite');
  try {
    run(['verify', '--db', dbPath]);
    run(['status', '--db', dbPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log('verify-instance: OK');
