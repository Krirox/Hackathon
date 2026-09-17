import type { AsyncDb } from './db.ts';

/**
 * Migration journal (TODO Ops): named migrations with up/down SQL,
 * recorded in `schema_migrations`, applied once, rolled back explicitly.
 * Down migrations are TESTED here (not trusted): the suite applies and
 * rolls back a scratch migration on every run.
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

const JOURNAL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
)`;

export async function appliedMigrations(db: AsyncDb): Promise<string[]> {
  await db.exec(JOURNAL);
  return ((await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()) as { name: string }[]).map((r) =>
    String(r.name),
  );
}

/** Apply every pending migration in order. Already-applied names are skipped. */
export async function applyMigrations(db: AsyncDb, migrations: Migration[], now?: string): Promise<string[]> {
  const at = now ?? new Date().toISOString();
  await db.exec(JOURNAL);
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
  if (!row) throw new MigrationError('NOT_APPLIED', `migration "${name}" is not applied — nothing to roll back`);
  await db.transaction(async () => {
    await db.exec(m.down);
    await db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(name);
  });
}
