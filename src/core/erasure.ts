import type { AsyncDb } from './db.ts';
import { exportLedger, type LedgerExport } from '../ledger/export.ts';

/**
 * Per-tenant data erasure (TODO V2.1.1): GDPR Article 17 "right to erasure"
 * against the one shared store. Export is not optional — `exportLedger` runs
 * INSIDE the erasure transaction and the export document is returned by the
 * same call, so no code path can delete a tenant's history without producing
 * the portable record first (lock-in by value, not hostage-taking; see
 * `export.ts`).
 *
 * Completeness is enforced by TEST against introspection, not by a hand-list
 * rotting in a comment (see test/erasure.test.ts): every user-data table the
 * store knows about must be either tenant-scoped (deleted by the loop below)
 * or in ORPHAN_TABLES with an explicit child-delete here. A future
 * `CREATE TABLE` with a `tenant` column that skips erasure fails the suite.
 *
 * The receipt that survives: the tenant's own audit_log is erased with the
 * tenant (that is the point), so the final receipt row is written under a
 * synthetic `erased:<slug>` tenant an operator can always query to answer
 * "was this tenant erased, when, by whom".
 */

/** Erasure marker action, written in the tenant's own trail before deletion. */
export const ERASURE_ACTION = 'erasure.tenant_requested';
/** Written after deletion under the synthetic receipt tenant. */
export const ERASURE_DONE_ACTION = 'erasure.tenant_erased';
/** Synthetic tenant the receipt row lives under after erasure. */
export const erasedTenantOf = (slug: string): string => `erased:${slug}`;

/**
 * Tables that carry no `tenant` column. Each one is either deleted here as
 * an explicit child of a tenant-scoped parent, or holds no user data:
 *  - claim_links            child of claims (deleted via both endpoint ids)
 *  - skill_transfer_tests   child of skill_cards (deleted via card ids)
 *  - ledger_seq             per-tenant sequence bookkeeping (explicit delete)
 *  - schema_migrations/meta infrastructure, never user data
 */
const ORPHAN_TABLES = new Set(['schema_migrations', 'meta', 'claim_links', 'skill_transfer_tests', 'ledger_seq']);

export interface ErasureResult {
  /** The full portable record taken before deletion. */
  export: LedgerExport;
  /** Rows deleted per table, for the operator's receipt. */
  deleted: Record<string, number>;
  /** Timestamp of the erasure (also stamped on the export and the receipt). */
  erasedAt: string;
}

/**
 * Erase one tenant completely. Export and deletion run in ONE transaction:
 * both happen or neither does. Order inside the transaction matters —
 * children before parents (claim_links needs claims' ids to find itself;
 * password_resets and auth_sessions need users' ids), auth tables before
 * business tables, the tenants row last, the receipt after everything.
 */
export async function eraseTenant(db: AsyncDb, tenant: string, actor: string, now?: string): Promise<ErasureResult> {
  const at = now ?? new Date().toISOString();

  // The tenant must exist; erasing a typo must not "succeed".
  const exists = (await db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(tenant)) as
    { slug: string } | undefined;
  if (!exists) throw new Error(`[erasure:UNKNOWN_TENANT] no tenant "${tenant}"`);

  return db.transaction(async (): Promise<ErasureResult> => {
    // 1. The tenant's own audit trail records WHO ordered this — written
    //    BEFORE the export so the portable record itself carries the proof
    //    that erasure was ordered.
    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenant, actor, ERASURE_ACTION, `tenant:${tenant}`, 'per-tenant erasure with prior export', at);

    // 2. Export second — inside the transaction, so export and delete are
    //    atomic and the export includes the erasure marker.
    const exported = await exportLedger(db, tenant, at);

    const deleted: Record<string, number> = {};
    const del = async (sql: string, ...args: unknown[]): Promise<number> =>
      (await db.prepare(sql).run(...args)).changes;

    // 3. Auth tables. Sessions die here — deletion IS revocation; no orphaned
    //    login survives. Children first (resets/sessions reference users).
    deleted['password_resets'] = await del(
      'DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE tenant = ?)',
      tenant,
    );
    deleted['auth_sessions'] = await del(
      'DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE tenant = ?)',
      tenant,
    );
    // Lockout counters are keyed "tenant|ip|email" — a prefix match.
    deleted['login_attempts'] = await del('DELETE FROM login_attempts WHERE key LIKE ?', `${tenant}|%`);
    deleted['users'] = await del('DELETE FROM users WHERE tenant = ?', tenant);

    // 4. Orphan-keyed children of business tables, while the parent ids are
    //    still queryable.
    deleted['claim_links'] = await del(
      `DELETE FROM claim_links WHERE from_id IN (SELECT id FROM claims WHERE tenant = ?)
        OR to_id IN (SELECT id FROM claims WHERE tenant = ?)`,
      tenant,
      tenant,
    );
    deleted['skill_transfer_tests'] = await del(
      'DELETE FROM skill_transfer_tests WHERE card_id IN (SELECT id FROM skill_cards WHERE tenant = ?)',
      tenant,
    );
    deleted['ledger_seq'] = await del('DELETE FROM ledger_seq WHERE tenant = ?', tenant);

    // 5. Every tenant-scoped table — the loop is the source of truth (the
    //    test asserts it covers all of them). audit_log lands here too; the
    //    receipt in step 7 is deliberately written after this deletes it.
    //    Tables already handled in step 3 (users, auth_sessions) are empty by
    //    now — keep their REAL counts instead of overwriting with 0.
    for (const t of await tenantScopedTables(db)) {
      if (t in deleted) continue;
      deleted[t] = await del(`DELETE FROM ${t} WHERE tenant = ?`, tenant);
    }

    // 6. The tenant row itself, last of the tenant's data.
    deleted['tenants'] = await del('DELETE FROM tenants WHERE slug = ?', tenant);

    // 7. The surviving receipt, under a synthetic tenant the operator can
    //    query after the real one is gone.
    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        erasedTenantOf(tenant),
        actor,
        ERASURE_DONE_ACTION,
        `tenant:${tenant}`,
        JSON.stringify({ deleted: deleted, exportedAt: exported.exportedAt }),
        at,
      );

    return { export: exported, deleted: deleted, erasedAt: at };
  });
}

/**
 * Tables with a `tenant` column — the erasure loop's source of truth.
 * Introspection is dialect-branched like the rest of the store (information_schema
 * on Postgres, sqlite_master + PRAGMA on SQLite), so erasure carries to the
 * live-Postgres path with the same completeness guarantee.
 */
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
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as { name: string }[];
  return rows.map((r) => String(r.name));
}
