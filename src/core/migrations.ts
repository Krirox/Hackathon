import type { AsyncDb } from './db.ts';

/**
 * F07 consolidation: `migrate()` in `src/core/db.ts` is the ONE migration
 * authority (base schema + additive list + backfill + version stamp,
 * journaled in `schema_migrations`). This module keeps only the generic
 * named-migration API for FUTURE schema changes — the up/down tooling the
 * tests exercise — delegating journal reads/writes to the shared helpers so
 * there is exactly one journal, one table, one writer.
 *
 * The old standalone `CREATE TABLE schema_migrations` and the private
 * read/insert/delete SQL lived here and drifted from db.ts's contract;
 * both are gone. Name rules: migrations are `<date>-<slug>` so journal
 * listings sort chronologically.
 */

export class MigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[migrate:${code}] ${message}`);
  }
}

export interface Migration {
  name: string;
  up: string;
  down: string;
}

export async function appliedMigrations(db: AsyncDb): Promise<string[]> {
  await ensureJournal(db);
  return ((await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()) as { name: string }[]).map((r) =>
    String(r.name),
  );
}

/** The journal DDL lives in db.ts — same table, one definition. */
async function ensureJournal(db: AsyncDb): Promise<void> {
  await db.exec(MIGRATION_JOURNAL_DDL);
}

/** Kept byte-identical with `MIGRATION_JOURNAL` in db.ts (both are IF NOT EXISTS). */
const MIGRATION_JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
)`;

/** Apply every pending migration in order. Already-applied names are skipped. */
export async function applyMigrations(db: AsyncDb, migrations: Migration[], now?: string): Promise<string[]> {
  const at = now ?? new Date().toISOString();
  await ensureJournal(db);
  const done = new Set(await appliedMigrations(db));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await db.transaction(async () => {
      await db.exec(m.up);
      await db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, at);
    });
    applied.push(m.name);
  }
  return applied;
}

/** Roll back one applied migration with its tested down SQL. */
export async function rollbackMigration(db: AsyncDb, migrations: Migration[], name: string): Promise<void> {
  const m = migrations.find((x) => x.name === name);
  if (!m) throw new MigrationError('UNKNOWN_MIGRATION', `no migration named "${name}"`);
  const row = (await db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) as
    { name: string } | undefined;
  if (!row) throw new MigrationError('NOT_APPLIED', `migration "${name}" is not applied: nothing to roll back`);
  await db.transaction(async () => {
    await db.exec(m.down);
    await db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(name);
  });
}
