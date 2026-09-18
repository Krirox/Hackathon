import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { T, eq, rejects, throws } from './helpers.ts';
import { migrate, openDb } from '../src/core/db.ts';
import {
  assertTenantExists,
  readSchemaStatus,
  resolveDbTarget,
  resolveTenant,
  sanitizeDbDisplay,
  verifyInstance,
} from '../src/core/cli-target.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = '2026-09-18T00:00:00.000Z';

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: '', SQLITE_PATH: '', VITAL_TENANT: '', ...env },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}

console.log('\n\x1b[1mCLI target — FLOW-005 database resolution\x1b[0m');

T('FLOW-005: --db beats DATABASE_URL and secrets are redacted', () => {
  const flag = resolveDbTarget({
    flag: 'postgres://alice:secret@db.example.com:5432/vital',
    env: { DATABASE_URL: 'postgres://bob:other@ignored/db' } as NodeJS.ProcessEnv,
  });
  eq(flag.source, '--db');
  eq(flag.engine, 'postgres');
  eq(flag.display.includes('secret'), false);
  eq(flag.display.includes('***'), true);
  eq(sanitizeDbDisplay('var/vital.db', 'sqlite'), 'var/vital.db');
});

T('FLOW-005: DATABASE_URL selects postgres when --db is absent', () => {
  const target = resolveDbTarget({
    env: { DATABASE_URL: 'postgresql://u:p@localhost:5432/vital' } as NodeJS.ProcessEnv,
  });
  eq(target.source, 'DATABASE_URL');
  eq(target.engine, 'postgres');
});

T('FLOW-005: SQLITE_PATH is used when flag and DATABASE_URL are absent', () => {
  const target = resolveDbTarget({ env: { SQLITE_PATH: 'var/custom.db' } as NodeJS.ProcessEnv });
  eq(target.source, 'SQLITE_PATH');
  eq(target.connection, 'var/custom.db');
});

T('FLOW-005: status requires a persistent default, not silent :memory:', () => {
  throws(() => resolveDbTarget({ requirePersistent: true, defaultPath: ':memory:' }), 'PERSISTENT_DB_REQUIRED');
});

T('FLOW-005: resolveTenant requires explicit tenant when configured', () => {
  throws(() => resolveTenant({ required: true }), 'TENANT_REQUIRED');
  eq(resolveTenant({ flag: 'Acme', env: { VITAL_TENANT: 'other' } as NodeJS.ProcessEnv }), 'acme');
  eq(resolveTenant({ env: { VITAL_TENANT: 'prod' } as NodeJS.ProcessEnv }), 'prod');
});

T('FLOW-005: readSchemaStatus is read-only on an empty sqlite file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-cli-target-'));
  const path = join(dir, 'empty.sqlite');
  const db = openDb(path);
  try {
    const before = await readSchemaStatus(db);
    eq(before.ready, false);
    eq(before.schemaVersion, null);
    const after = await readSchemaStatus(db);
    eq(after.ready, false);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-005: verify migrates and round-trips without status mutating schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-cli-target-'));
  const path = join(dir, 'probe.sqlite');
  const db = openDb(path);
  try {
    const verified = await verifyInstance(db);
    eq(verified.probe, 'meta_round_trip');
    eq(verified.schemaVersion, '6');
    const inspect = openDb(path);
    const statusBefore = await readSchemaStatus(inspect);
    const statusAfter = await readSchemaStatus(inspect);
    eq(statusBefore.ready, true);
    eq(statusBefore.schemaVersion, statusAfter.schemaVersion);
    await inspect.close();
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-005: assertTenantExists is strict for auth commands', async () => {
  const { db } = await (async () => {
    const d = openDb(':memory:');
    await migrate(d);
    await installAuthSchema(d);
    return { db: d };
  })();
  try {
    await rejects(() => assertTenantExists(db, 'missing', { strict: true }), 'TENANT_NOT_FOUND');
    await signupTenant(
      db,
      { slug: 'acme', name: 'Acme', email: 'o@acme.test', password: 'long-enough-pass', ownerName: 'Owner' },
      NOW,
    );
    await assertTenantExists(db, 'acme', { strict: true });
  } finally {
    await db.close();
  }
});

T('FLOW-005: status on uninitialized db exits nonzero without migrating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-cli-status-'));
  const path = join(dir, 'raw.sqlite');
  try {
    const child = runCli(['status', '--db', path]);
    eq(child.status, 1);
    eq(child.stdout.includes('ready'), true);
    eq(child.stdout.includes('schema_version'), true);
    const db = openDb(path);
    try {
      const s = await readSchemaStatus(db);
      eq(s.ready, false);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-005: report and status share sqlite targeting and report rejects postgres', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-cli-report-'));
  const path = join(dir, 'shared.sqlite');
  try {
    const db = openDb(path);
    await migrate(db);
    await db.close();

    const status = runCli(['status', '--db', path]);
    eq(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { engine: string; db: string; db_source: string };
    eq(statusJson.engine, 'sqlite');
    eq(statusJson.db_source, '--db');
    eq(statusJson.db.includes('shared.sqlite'), true);

    const pg = runCli(['report', '--db', 'postgres://u:p@localhost/db', '--tenant', 'acme']);
    eq(pg.status, 1);
    eq(pg.stderr.includes('ENGINE_UNSUPPORTED'), true);

    const missingTenant = runCli(['report', '--db', path]);
    eq(missingTenant.status, 1);
    eq(missingTenant.stderr.includes('TENANT_REQUIRED'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-005: signup and passwd honor the same --db path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-cli-auth-'));
  const path = join(dir, 'auth.sqlite');
  try {
    const signup = runCli([
      'signup',
      '--db',
      path,
      '--tenant',
      'pilot',
      '--email',
      'owner@pilot.test',
      '--password',
      'long-enough-pass',
    ]);
    eq(signup.status, 0, signup.stderr);
    const passwd = runCli([
      'passwd',
      '--db',
      path,
      '--tenant',
      'pilot',
      '--email',
      'owner@pilot.test',
      '--password',
      'another-long-pass',
    ]);
    eq(passwd.status, 0, passwd.stderr);
    const missing = runCli([
      'passwd',
      '--db',
      path,
      '--tenant',
      'ghost',
      '--email',
      'owner@pilot.test',
      '--password',
      'another-long-pass',
    ]);
    eq(missing.status, 1);
    eq(missing.stderr.includes('TENANT_NOT_FOUND'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
