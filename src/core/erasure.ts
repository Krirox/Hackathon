import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AsyncDb } from './db.ts';
import { exportLedger, type LedgerExport } from '../ledger/export.ts';

/**
 * Per-tenant data erasure (FLOW-004 / GDPR Article 17): export-first deletion
 * against the one shared store.
 *
 * Export policy (two supported flows):
 *  - **API / in-memory** (`eraseTenant` without `exportTo`): `exportLedger` runs
 *    inside the erasure transaction and the portable record is returned by the
 *    same call. Deletion commits only after the in-memory export is complete.
 *  - **CLI durable file** (`exportTo` option): the JSON export is written and
 *    verified on disk **before** any destructive step commits. A write or
 *    verification failure rolls the whole transaction back — deletion is never
 *    reported when a requested export file was not durably preserved.
 *
 * The CLI's `--export-to` path is optional; when omitted the operator receives
 * the in-memory export only (no implied on-disk backup). When provided, durable
 * export is mandatory for that run.
 *
 * Completeness is enforced by TEST against introspection: every user-data table
 * the store knows about must be tenant-scoped (deleted by the loop below) or
 * in ORPHAN_TABLES with an explicit child-delete. Tenant-scoped `meta` keys,
 * raw artifacts (reference-aware), and operational residue (cursors, kill
 * switches, dedupe markers) are inventoried and cleared where verified.
 *
 * Retained by design (listed on the receipt, not promised deleted):
 *  - the `erased:<slug>` audit receipt row (retained indefinitely — it is
 *    the proof erasure happened; see "Export retention policy" below);
 *  - raw artifacts still referenced by another tenant's claims;
 *  - operator backups and external object stores outside this command's scope.
 *
 * Export retention policy:
 *  - API / in-memory exports are returned to the caller only; nothing is
 *    written to disk and no expiry applies because there is nothing to expire.
 *  - CLI `--export-to` files are operator-managed evidence with NO automatic
 *    expiry and NO automatic deletion — they are listed on the receipt as
 *    retained, and `verifyErasureReceipt` re-checks them on demand.
 *  - Exclusive artifact files are NOT deleted inside the erasure
 *    transaction; `collectErasureArtifacts` removes them post-commit after
 *    re-checking ownership, and is safe to rerun (idempotent, audited).
 *  - The `erased:<slug>` receipt row itself is never expired by this module.
 *
 * Slug reuse is blocked while an erasure receipt exists (`signupTenant` checks).
 */

/** Erasure marker action, written in the tenant's own trail before deletion. */
export const ERASURE_ACTION = 'erasure.tenant_requested';
/** Written after deletion under the synthetic receipt tenant. */
export const ERASURE_DONE_ACTION = 'erasure.tenant_erased';
/** Written by the post-commit collector for every collection run (idempotent). */
export const ERASURE_COLLECT_ACTION = 'erasure.artifacts_collected';
/** Synthetic tenant the receipt row lives under after erasure. */
export const erasedTenantOf = (slug: string): string => `erased:${slug}`;

/**
 * Tables that carry no `tenant` column. Each one is either deleted here as
 * an explicit child of a tenant-scoped parent, or holds no user data.
 */
const ORPHAN_TABLES = new Set(['schema_migrations', 'meta', 'claim_links', 'ledger_seq']);

export interface ErasureRetention {
  category: string;
  reason: string;
  items: string[];
}

export interface ErasureReceipt {
  /** Rows deleted per table. */
  deleted: Record<string, number>;
  /** Tenant-scoped meta keys removed. */
  metaKeysDeleted: string[];
  /** Content-addressed artifact refs removed from disk. */
  artifactsDeleted: string[];
  /** Data deliberately kept (shared artifacts, receipt row, out-of-scope stores). */
  retained: ErasureRetention[];
  /** Work outside verified scope (backups, external storage). */
  deferred: ErasureRetention[];
  /** Steps that failed without blocking verified deletion where applicable. */
  failed: ErasureRetention[];
  exportPolicy: 'in-memory' | 'durable-file';
  exportFile?: string;
  exportedAt: string;
}

export interface ErasureResult {
  export: LedgerExport;
  receipt: ErasureReceipt;
  /** @deprecated use receipt.deleted */
  deleted: Record<string, number>;
  erasedAt: string;
}

export interface EraseTenantOptions {
  /** When set, write and verify the export JSON here before deletion commits. */
  exportTo?: string;
  /** Raw artifact directory (default `data/artifacts`). */
  artifactDir?: string;
}

/**
 * Erase one tenant completely. Export and deletion run in ONE transaction:
 * both happen or neither does.
 */
export async function eraseTenant(
  db: AsyncDb,
  tenant: string,
  actor: string,
  now?: string,
  opts: EraseTenantOptions = {},
): Promise<ErasureResult> {
  const at = now ?? new Date().toISOString();
  const artifactDir = resolve(opts.artifactDir ?? process.env.ARTIFACT_DIR ?? join('data', 'artifacts'));

  return db.transaction(async (): Promise<ErasureResult> => {
    const tables = await tenantScopedTables(db);
    if (db.engine === 'postgres') {
      const locked = [
        ...new Set([
          ...tables,
          'tenants',
          'meta',
          'claim_links',
          'skill_transfer_tests',
          'ledger_seq',
          'login_attempts',
          'password_resets',
          'auth_sessions',
        ]),
      ].sort();
      await db.exec("SET LOCAL lock_timeout = '5s'");
      await db.exec(`LOCK TABLE ${locked.map(quoteIdentifier).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const exists = (await db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(tenant)) as
      { slug: string } | undefined;
    if (!exists) throw new Error(`[erasure:UNKNOWN_TENANT] no tenant "${tenant}"`);

    const artifactRefs = await tenantArtifactRefs(db, tenant);
    const sharedArtifacts = await sharedArtifactRefs(db, tenant, artifactRefs);
    const metaKeys = await tenantMetaKeys(db, tenant);

    const deferred: ErasureRetention[] = [
      {
        category: 'backups',
        reason: 'operator-managed backups and external replicas are outside this command',
        items: [],
      },
      {
        category: 'external-storage',
        reason: 'configured object stores (e.g. S3) are not purged by tenant erasure',
        items: [],
      },
    ];

    const retained: ErasureRetention[] = [
      {
        category: 'erasure-receipt',
        reason: 'audit evidence that erasure occurred',
        items: [erasedTenantOf(tenant)],
      },
    ];
    if (sharedArtifacts.length > 0) {
      retained.push({
        category: 'shared-artifacts',
        reason: 'content-addressed blob still referenced by another tenant',
        items: sharedArtifacts,
      });
    }

    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenant, actor, ERASURE_ACTION, `tenant:${tenant}`, 'per-tenant erasure with prior export', at);

    const exported = await exportLedger(db, tenant, at);

    let exportFile: string | undefined;
    const exportPolicy = opts.exportTo ? 'durable-file' : 'in-memory';
    if (opts.exportTo) {
      exportFile = writeErasureExport(opts.exportTo, tenant, at, exported);
      retained.push({
        category: 'ledger-export',
        reason:
          'operator-managed retained evidence; no automatic expiry; not a full backup and contains no artifact bytes',
        items: [exportFile],
      });
    }

    const deleted: Record<string, number> = {};
    const del = async (sql: string, ...args: unknown[]): Promise<number> =>
      (await db.prepare(sql).run(...args)).changes;

    deleted['password_resets'] = await del(
      'DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE tenant = ?)',
      tenant,
    );
    deleted['auth_sessions'] = await del(
      'DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE tenant = ?)',
      tenant,
    );
    deleted['login_attempts'] = await del('DELETE FROM login_attempts WHERE key LIKE ?', `${tenant}|%`);
    deleted['users'] = await del('DELETE FROM users WHERE tenant = ?', tenant);

    deleted['claim_links'] = await del(
      `DELETE FROM claim_links WHERE from_id IN (SELECT id FROM claims WHERE tenant = ?)
        OR to_id IN (SELECT id FROM claims WHERE tenant = ?)`,
      tenant,
      tenant,
    );
    deleted['skill_transfer_tests'] = await del('DELETE FROM skill_transfer_tests WHERE tenant = ?', tenant);
    deleted['ledger_seq'] = await del('DELETE FROM ledger_seq WHERE tenant = ?', tenant);
    deleted['outcomes'] = await del('DELETE FROM outcomes WHERE tenant = ?', tenant);

    for (const t of tables) {
      if (t in deleted) continue;
      deleted[t] = await del(`DELETE FROM ${quoteIdentifier(t)} WHERE tenant = ?`, tenant);
    }

    const metaKeysDeleted: string[] = [];
    for (const key of metaKeys) {
      await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      metaKeysDeleted.push(key);
    }
    deleted['meta'] = metaKeysDeleted.length;

    deleted['tenants'] = await del('DELETE FROM tenants WHERE slug = ?', tenant);

    const pendingArtifacts = artifactRefs.filter((ref) => !sharedArtifacts.includes(ref));
    const artifactsDeleted: string[] = [];
    const failed: ErasureRetention[] = [];
    const plannedArtifacts = pendingArtifacts.filter((ref) => {
      try {
        verifyArtifactRef(ref, artifactDir);
        return true;
      } catch (e) {
        failed.push({
          category: 'artifacts',
          reason: e instanceof Error ? e.message : String(e),
          items: [ref],
        });
        return false;
      }
    });
    if (plannedArtifacts.length > 0) {
      deferred.push({
        category: 'artifacts',
        reason: `exclusive refs verified but files are not deleted inside the transaction: a post-commit ownership-aware collector must remove ${plannedArtifacts.length} file(s) under ${artifactDir}`,
        items: plannedArtifacts,
      });
    }
    deferred.push({
      category: 'unindexed-artifacts',
      reason:
        'only claims.raw_ref is inventoried; transcript, deliverable, orphaned and other configured artifact stores require separate inventory and cleanup',
      items: [],
    });

    const receipt: ErasureReceipt = {
      deleted,
      metaKeysDeleted,
      artifactsDeleted,
      retained,
      deferred,
      failed,
      exportPolicy,
      exportFile,
      exportedAt: exported.exportedAt,
    };

    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(erasedTenantOf(tenant), actor, ERASURE_DONE_ACTION, `tenant:${tenant}`, JSON.stringify(receipt), at);

    return { export: exported, receipt, deleted, erasedAt: at };
  });
}

export interface ErasureCollectorResult {
  /** Refs whose files were deleted by this run. */
  deleted: string[];
  /** Refs still referenced by surviving claims — never deleted. */
  retainedShared: string[];
  /** Refs with no file on disk — already collected or never written. */
  missing: string[];
  /** Refs that could not be collected (unsafe path, I/O error). */
  failed: { ref: string; reason: string }[];
}

export interface CollectErasureArtifactsOptions {
  /** Raw artifact directory (default `data/artifacts`). */
  artifactDir?: string;
  /** Audit actor (default `erasure:collector`). */
  actor?: string;
  now?: string;
}

/**
 * Post-commit exclusive-artifact collector (FLOW-004).
 *
 * Runs AFTER the erasure transaction commits — never inside it — so a
 * rollback can never restore claim rows that point at already-deleted
 * blobs. For every candidate ref it re-checks ownership against the live
 * store: any surviving `claims.raw_ref` row (any tenant) means the blob is
 * shared and the file is left untouched. Missing files are reported, not
 * errors, so reruns are idempotent. Each run appends one audited row under
 * the `erased:<slug>` receipt tenant.
 */
export async function collectErasureArtifacts(
  db: AsyncDb,
  tenant: string,
  refs: string[],
  opts: CollectErasureArtifactsOptions = {},
): Promise<ErasureCollectorResult> {
  const artifactDir = resolve(opts.artifactDir ?? process.env.ARTIFACT_DIR ?? join('data', 'artifacts'));
  const actor = opts.actor ?? 'erasure:collector';
  const at = opts.now ?? new Date().toISOString();
  const result: ErasureCollectorResult = { deleted: [], retainedShared: [], missing: [], failed: [] };
  for (const ref of [...new Set(refs)].sort()) {
    let full: string;
    try {
      full = verifyArtifactRef(ref, artifactDir);
    } catch (e) {
      result.failed.push({ ref, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const row = (await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE raw_ref = ?').get(ref)) as { n: number };
    if (Number(row.n) > 0) {
      result.retainedShared.push(ref);
      continue;
    }
    if (!existsSync(full)) {
      result.missing.push(ref);
      continue;
    }
    try {
      unlinkSync(full);
      result.deleted.push(ref);
    } catch (e) {
      result.failed.push({ ref, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(erasedTenantOf(tenant), actor, ERASURE_COLLECT_ACTION, `tenant:${tenant}`, JSON.stringify(result), at);
  return result;
}

export type ExportFileStatus = 'verified' | 'missing' | 'unreadable' | 'mismatch';

export interface ErasureReceiptVerification {
  found: boolean;
  slug: string;
  receipt?: ErasureReceipt;
  erasedAt?: string;
  exportFile?: { path: string; status: ExportFileStatus; detail: string };
}

/**
 * Operator/browser receipt verification (FLOW-004): read the surviving
 * `erased:<slug>` receipt and, when the receipt names a durable export
 * file, check the file still parses and matches the receipt's tenant and
 * export timestamp. Post-hoc verification is structural — the live rows are
 * gone, so byte-equality against the in-transaction document is only
 * possible at erase time (`verifyErasureExportFile`).
 */
export async function verifyErasureReceipt(
  db: AsyncDb,
  slug: string,
  opts: { checkExportFile?: boolean } = {},
): Promise<ErasureReceiptVerification> {
  const row = (await db
    .prepare('SELECT detail, at FROM audit_log WHERE tenant = ? AND action = ? ORDER BY seq DESC LIMIT 1')
    .get(erasedTenantOf(slug), ERASURE_DONE_ACTION)) as { detail: string; at: string } | undefined;
  if (!row) return { found: false, slug };
  const receipt = JSON.parse(String(row.detail)) as ErasureReceipt;
  const out: ErasureReceiptVerification = { found: true, slug, receipt, erasedAt: row.at };
  if (opts.checkExportFile !== false && receipt.exportFile) {
    out.exportFile = checkErasureExportFile(receipt.exportFile, slug, receipt.exportedAt);
  }
  return out;
}

function checkErasureExportFile(
  path: string,
  slug: string,
  exportedAt: string,
): { path: string; status: ExportFileStatus; detail: string } {
  if (!existsSync(path))
    return { path, status: 'missing', detail: 'export file no longer on disk (operator-managed retention)' };
  let parsed: { tenant?: unknown; exportedAt?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { tenant?: unknown; exportedAt?: unknown };
  } catch (e) {
    return { path, status: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
  if (parsed.tenant !== slug || parsed.exportedAt !== exportedAt) {
    return {
      path,
      status: 'mismatch',
      detail: `file names tenant=${String(parsed.tenant)} exportedAt=${String(parsed.exportedAt)}; receipt expects tenant=${slug} exportedAt=${exportedAt}`,
    };
  }
  return { path, status: 'verified', detail: 'file parses and matches receipt tenant + export timestamp' };
}

/** sha256 of a file, used by archival delivery verification. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True when an erasure receipt blocks slug reuse for a new organization. */
export async function isErasedSlugReserved(db: AsyncDb, slug: string): Promise<boolean> {
  const row = (await db
    .prepare('SELECT 1 AS n FROM audit_log WHERE tenant = ? AND action = ? LIMIT 1')
    .get(erasedTenantOf(slug), ERASURE_DONE_ACTION)) as { n: number } | undefined;
  return row !== undefined;
}

/** Write and verify a durable export file; throws on failure (rolls back caller's transaction). */
export function writeErasureExport(dir: string, tenant: string, erasedAt: string, exported: LedgerExport): string {
  mkdirSync(dir, { recursive: true });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(tenant) || !Number.isFinite(Date.parse(erasedAt))) {
    throw new Error('[erasure:EXPORT_TARGET] invalid tenant or export timestamp');
  }
  const file = resolve(
    dir,
    `${tenant}-ledger-export-${new Date(erasedAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
  );
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(exported, null, 2), 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  verifyErasureExportFile(file, exported);
  if (process.platform !== 'win32') {
    let directory = dirname(file);
    for (;;) {
      const handle = openSync(directory, 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return file;
}

/** Round-trip check: parsed export matches the in-transaction document. */
export function verifyErasureExportFile(file: string, expected: LedgerExport): void {
  let parsed: LedgerExport;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as LedgerExport;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[erasure:EXPORT_VERIFY] could not read export file "${file}": ${msg}`, { cause: e });
  }
  if (!isDeepStrictEqual(parsed, JSON.parse(JSON.stringify(expected)))) {
    throw new Error(`[erasure:EXPORT_VERIFY] export file "${file}" does not match the complete export`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isTenantMetaKey(key: string, tenant: string): boolean {
  if (
    [
      `rates:${tenant}`,
      `operatorkeys:${tenant}`,
      ...['config', 'signupAt', 'firstReviewAt', 'sample'].map((kind) => `activation:${kind}:${tenant}`),
    ].includes(key)
  )
    return true;
  const prefixes = [
    `ingest:cursor:${tenant}:`,
    `ingest:seen:${tenant}:`,
    `ingest:health:${tenant}:`,
    `ingest:disabled:${tenant}:`,
    `kill:${tenant}:`,
    `promo:${tenant}:`,
    `admitlock:${tenant}:`,
    `wedge:summary:${tenant}:`,
    `wedge:stage:${tenant}:`,
    `research:run:${tenant}:`,
    `ratelimit:${tenant}:`,
  ];
  return prefixes.some((p) => key.startsWith(p));
}

async function tenantMetaKeys(db: AsyncDb, tenant: string): Promise<string[]> {
  const rows = (await db.prepare('SELECT key FROM meta').all()) as { key: string }[];
  return rows
    .map((r) => String(r.key))
    .filter((key) => isTenantMetaKey(key, tenant))
    .sort();
}

async function tenantArtifactRefs(db: AsyncDb, tenant: string): Promise<string[]> {
  const rows = (await db
    .prepare('SELECT DISTINCT raw_ref AS ref FROM claims WHERE tenant = ? AND raw_ref IS NOT NULL')
    .all(tenant)) as { ref: string }[];
  return rows.map((r) => String(r.ref)).sort();
}

async function sharedArtifactRefs(db: AsyncDb, tenant: string, refs: string[]): Promise<string[]> {
  const shared: string[] = [];
  for (const ref of refs) {
    const row = (await db
      .prepare('SELECT COUNT(*) AS n FROM claims WHERE raw_ref = ? AND tenant != ?')
      .get(ref, tenant)) as { n: number };
    if (Number(row.n) > 0) shared.push(ref);
  }
  return shared;
}

function verifyArtifactRef(ref: string, artifactDir: string): string {
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`[erasure:UNSAFE_ARTIFACT] refusing ref "${ref}"`);
  const full = resolve(artifactDir, ref);
  // Platform-correct separator: the old hardcoded '\\' failed on POSIX,
  // misclassifying every exclusive artifact as an escape attempt.
  if (full !== artifactDir && !full.startsWith(artifactDir + (artifactDir.endsWith(sep) ? '' : sep))) {
    throw new Error(`[erasure:UNSAFE_ARTIFACT] ref "${ref}" escapes "${artifactDir}"`);
  }
  return full;
}

async function tenantScopedTables(db: AsyncDb): Promise<string[]> {
  const names: string[] = [];
  if (db.engine === 'postgres') {
    const rows = (await db
      .prepare(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
      .all()) as { name: string }[];
    for (const r of rows) names.push(String(r.name));
  } else {
    const rows = (await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all()) as { name: string }[];
    for (const r of rows) names.push(String(r.name));
  }
  const out: string[] = [];
  for (const name of names) {
    if (ORPHAN_TABLES.has(name)) continue;
    const cols = await columnsOf(db, name);
    if (cols.includes('tenant')) out.push(name);
  }
  return out.sort();
}

async function columnsOf(db: AsyncDb, table: string): Promise<string[]> {
  if (db.engine === 'postgres') {
    const rows = (await db
      .prepare(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`)
      .all(table)) as { column_name: string }[];
    return rows.map((r) => String(r.column_name));
  }
  const rows = (await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()) as { name: string }[];
  return rows.map((r) => String(r.name));
}
