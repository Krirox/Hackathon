import { openDb, migrate, type AsyncDb } from './db.ts';
import { openPostgres } from './pg.ts';

/**
 * FLOW-005: one resolution path for operator commands — flags beat env,
 * secrets never echo, tenant existence is checked before sensitive work,
 * and `status` inspects without migrating.
 */

export type DbEngine = 'sqlite' | 'postgres';

export type DbSource = '--db' | 'DATABASE_URL' | 'SQLITE_PATH' | 'default';

export class CliTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[cli-target:${code}] ${message}`);
  }
}

export interface ResolvedDbTarget {
  engine: DbEngine;
  /** Raw sqlite path or postgres URL — internal use only. */
  connection: string;
  /** Safe for logs and JSON output. */
  display: string;
  source: DbSource;
}

export interface ResolveDbOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  /** Used when no flag or env URL/path is set. */
  defaultPath?: string;
  /** Reject implicit :memory: — commands that inspect production must name a store. */
  requirePersistent?: boolean;
}

export interface ResolveTenantOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  required?: boolean;
  /** Only for commands that intentionally default a dev tenant (e.g. serve). */
  defaultTenant?: string;
}

export interface SchemaStatus {
  ready: boolean;
  schemaVersion: string | null;
  migrationCount: number | null;
}

const PERSISTENT_DEFAULT = 'var/vital.db';

function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/** Redact credentials from postgres URLs; sqlite paths pass through unchanged. */
export function sanitizeDbDisplay(connection: string, engine: DbEngine): string {
  if (engine !== 'postgres') return connection;
  try {
    const u = new URL(connection);
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username.length > 0 ? '***' : '';
    return u.toString();
  } catch {
    return 'postgres://***';
  }
}

export function resolveDbTarget(opts: ResolveDbOptions = {}): ResolvedDbTarget {
  const env = opts.env ?? process.env;
  const flag = opts.flag?.trim();
  if (flag) {
    const engine = isPostgresUrl(flag) ? 'postgres' : 'sqlite';
    return {
      engine,
      connection: flag,
      display: sanitizeDbDisplay(flag, engine),
      source: '--db',
    };
  }
  const envUrl = (env.DATABASE_URL ?? '').trim();
  if (envUrl) {
    const engine = isPostgresUrl(envUrl) ? 'postgres' : 'sqlite';
    return {
      engine,
      connection: envUrl,
      display: sanitizeDbDisplay(envUrl, engine),
      source: 'DATABASE_URL',
    };
  }
  const sqlitePath = (env.SQLITE_PATH ?? '').trim();
  if (sqlitePath) {
    return {
      engine: 'sqlite',
      connection: sqlitePath,
      display: sqlitePath,
      source: 'SQLITE_PATH',
    };
  }
  const path = opts.defaultPath ?? PERSISTENT_DEFAULT;
  if (opts.requirePersistent && path === ':memory:') {
    throw new CliTargetError(
      'PERSISTENT_DB_REQUIRED',
      'this command requires an explicit database — pass --db <path|postgres-url> or set DATABASE_URL / SQLITE_PATH (not :memory:)',
    );
  }
  const engine = isPostgresUrl(path) ? 'postgres' : 'sqlite';
  return {
    engine,
    connection: path,
    display: sanitizeDbDisplay(path, engine),
    source: 'default',
  };
}

export function openDbTarget(target: ResolvedDbTarget): AsyncDb {
  return target.engine === 'postgres' ? openPostgres(target.connection) : openDb(target.connection);
}

export async function migrateDbTarget(db: AsyncDb): Promise<void> {
  await migrate(db);
}

export function resolveTenant(opts: ResolveTenantOptions = {}): string | undefined {
  const fromFlag = opts.flag?.trim();
  if (fromFlag) return fromFlag.toLowerCase();
  const fromEnv = (opts.env ?? process.env).VITAL_TENANT?.trim();
  if (fromEnv) return fromEnv.toLowerCase();
  if (opts.required && !opts.defaultTenant) {
    throw new CliTargetError('TENANT_REQUIRED', 'this command requires --tenant <slug> or VITAL_TENANT');
  }
  return opts.defaultTenant?.toLowerCase();
}

export async function assertTenantExists(db: AsyncDb, tenant: string, opts?: { strict?: boolean }): Promise<void> {
  if (!(await tableExists(db, 'tenants'))) {
    if (opts?.strict)
      throw new CliTargetError('TENANT_NOT_FOUND', `tenant "${tenant}" does not exist in the selected database`);
    return;
  }
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM tenants').get()) as { n: number | string };
  if (Number(count.n) === 0 && !opts?.strict) return; // ledger-only databases without auth provisioning
  const row = await db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(tenant);
  if (!row) throw new CliTargetError('TENANT_NOT_FOUND', `tenant "${tenant}" does not exist in the selected database`);
}

/** Read schema state without migrating — status must not mutate the store. */
export async function readSchemaStatus(db: AsyncDb): Promise<SchemaStatus> {
  const hasMeta = await tableExists(db, 'meta');
  if (!hasMeta) return { ready: false, schemaVersion: null, migrationCount: null };
  const version = (await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()) as
    { value: string } | undefined;
  let migrationCount: number | null = null;
  if (await tableExists(db, 'schema_migrations')) {
    const row = (await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()) as { n: number | string };
    migrationCount = Number(row.n);
  }
  return {
    ready: version?.value != null,
    schemaVersion: version?.value != null ? String(version.value) : null,
    migrationCount,
  };
}

async function tableExists(db: AsyncDb, name: string): Promise<boolean> {
  if (db.engine === 'postgres') {
    const row = (await db
      .prepare(
        "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?",
      )
      .get(name)) as { n: number };
    return Number(row.n) > 0;
  }
  const row = (await db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)) as { n: number };
  return Number(row.n) > 0;
}

export function formatTargetHeader(target: ResolvedDbTarget, tenant?: string): Record<string, string> {
  const out: Record<string, string> = {
    engine: target.engine,
    db: target.display,
    db_source: target.source,
  };
  if (tenant) out.tenant = tenant;
  return out;
}

/** Boot-check smoke: migrate, write/read meta, no-op on already-migrated stores. */
export async function verifyInstance(db: AsyncDb): Promise<{ schemaVersion: string; probe: string }> {
  await migrate(db);
  const key = `verify:${Date.now()}`;
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, 'ok');
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string };
  if (row?.value !== 'ok') throw new CliTargetError('VERIFY_PROBE_FAILED', 'meta round-trip failed');
  await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  const status = await readSchemaStatus(db);
  if (!status.schemaVersion)
    throw new CliTargetError('VERIFY_NO_VERSION', 'schema migrated but schema_version is missing');
  return { schemaVersion: status.schemaVersion, probe: 'meta_round_trip' };
}
