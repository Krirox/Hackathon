// Tenant scope — the structural half of multi-tenancy.
//
// Today every tenant query writes `WHERE tenant = ?` by hand: 584 of 586 call
// sites do, which is a good convention and not a guarantee. One omission in a
// 586-site codebase is a cross-customer data incident, and the failure is
// silent — a query without the predicate returns *someone's* rows, not an error.
//
// This module gives that convention a name, a runtime assertion, and a place to
// fail fast:
//
//   const t = forTenant(db, tenant);
//   await t.all('SELECT id FROM requests WHERE tenant = ? AND state = ?', 'OPEN');
//
// `t.all` refuses SQL that does not reference the tenant column, so the mistake
// is a thrown error in development and tests rather than a leak in production.
// It is deliberately not an ORM: statements stay visible, only the guard is new.
//
// Defence in depth, not a substitute for RLS: Postgres row-level security (a
// separate change, since it needs a session GUC) would catch the sites that
// bypass this facade entirely.

import type { AsyncDb, AsyncStatement, Row } from './db.ts';

/**
 * Tables whose rows belong to exactly one tenant. A statement touching one of
 * these without a `tenant` predicate is a cross-tenant read/write by
 * definition — there is no legitimate variant.
 *
 * Deliberately excluded, with reasons, so the list stays trustworthy:
 *   meta, schema_migrations        — global key/value and migration bookkeeping
 *   tenants                        — the tenant registry itself
 *   users, auth_sessions, ...      — identity is addressed by token/email/id at
 *                                    the boundary, then checked against the
 *                                    session's tenant; requiring the column
 *                                    here would flag the legitimate lookups
 *   login_attempts                 — keyed by client fingerprint, not tenant
 */
export const TENANT_TABLES: readonly string[] = [
  'requests',
  'decisions',
  'outcomes',
  'traces',
  'audit_log',
  'ledger_seq',
  'claims',
  'watch_contracts',
  'skill_cards',
  'skill_card_revisions',
  'skill_transfer_tests',
  'routing_decisions',
  'routing_calibration',
  'issues',
  'issue_comments',
  'meetings',
  'meeting_participants',
  'meeting_questions',
  'meeting_notes',
  'meeting_recordings',
  'meeting_transcript_segments',
  'meeting_chunks',
  'meeting_embeddings',
  'escalations',
  'ingest_inbox',
  'outbox',
  'executor_artifacts',
  'honeytasks',
  'eval_runs',
  'eval_cases',
  'github_project_sync',
  'trust_scores',
  'subjects',
  'subject_aliases',
];

const TENANT_TABLE_SET = new Set(TENANT_TABLES);

/** Tables this module recognises regardless of scope (for callers that ask). */
export function isTenantTable(name: string): boolean {
  return TENANT_TABLE_SET.has(name);
}

/** `TABLE`/`INTO TABLE`/`FROM TABLE`/`UPDATE TABLE`/`JOIN TABLE` — first tenant table named. */
export function tenantTableInSql(sql: string): string | null {
  const lower = sql.toLowerCase();
  for (const table of TENANT_TABLES) {
    const t = table.toLowerCase();
    if (
      lower.includes(`from ${t}`) ||
      lower.includes(`into ${t}`) ||
      lower.includes(`update ${t}`) ||
      lower.includes(`join ${t}`) ||
      lower.includes(`table ${t} `) ||
      lower.includes(`table ${t}(`)
    ) {
      return table;
    }
  }
  return null;
}

/** True when the SQL constrains rows by the tenant column. */
export function sqlIsTenantScoped(sql: string): boolean {
  // `tenant` as a whole word: rejects `tenant_id`-style columns by accident on
  // purpose — the column in this schema is literally `tenant`.
  return /\btenant\b/i.test(sql);
}

export class TenantScopeError extends Error {
  constructor(sql: string, table: string) {
    super(
      `[tenant:UNSCOPED] statement touches "${table}" without a tenant predicate: ` +
        `${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}: use forTenant(db, tenant) and filter on tenant`,
    );
    this.name = 'TenantScopeError';
  }
}

/**
 * Throw when `sql` reads or writes a tenant table without a tenant predicate.
 * `allowGlobal` exists for the rare deliberate cross-tenant aggregate (an admin
 * count across tenants) and must be written at the call site, so it shows up in
 * review rather than hiding in a helper.
 */
export function assertTenantScoped(sql: string, opts: { allowGlobal?: boolean } = {}): void {
  if (opts.allowGlobal) return;
  const table = tenantTableInSql(sql);
  if (!table) return;
  if (sqlIsTenantScoped(sql)) return;
  throw new TenantScopeError(sql, table);
}

export interface TenantScope {
  readonly tenant: string;
  /** Prepare a tenant-checked statement. */
  statement(sql: string, opts?: { allowGlobal?: boolean }): AsyncStatement;
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

/**
 * Bind a database to one tenant. Every statement it hands out is checked, so the
 * predicate cannot be forgotten rather than merely being remembered.
 */
export function forTenant(db: AsyncDb, tenant: string): TenantScope {
  if (!tenant || tenant.trim().length === 0) {
    throw new Error('[tenant:EMPTY] forTenant requires a non-empty tenant');
  }
  const statement = (sql: string, opts?: { allowGlobal?: boolean }): AsyncStatement => {
    assertTenantScoped(sql, opts ?? {});
    return db.prepare(sql);
  };
  return {
    tenant,
    statement,
    get: async <T = Row>(sql: string, ...params: unknown[]) =>
      (await statement(sql).get(...params)) as T | undefined,
    all: async <T = Row>(sql: string, ...params: unknown[]) =>
      (await statement(sql).all(...params)) as T[],
    run: async (sql: string, ...params: unknown[]) => statement(sql).run(...params),
  };
}
