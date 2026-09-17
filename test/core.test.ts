import { T, eq, TEN, NOW, fresh, rejects } from './helpers.ts';
import { applyMigrations, appliedMigrations, rollbackMigration, type Migration } from '../src/core/migrations.ts';
import { dayOf, groupConcat } from '../src/core/db.ts';
import { openFromEnv, PG_SCHEMA, toPostgresPlaceholders } from '../src/core/pg.ts';
import { SCHEMA } from '../src/core/db.ts';

console.log('\n\x1b[1mCore — migrations apply once and roll back tested\x1b[0m');

const scratch: Migration[] = [
  {
    name: '2026-09-09-scratch-flag',
    up: 'CREATE TABLE scratch_flags (id TEXT PRIMARY KEY, onoff INTEGER NOT NULL)',
    down: 'DROP TABLE scratch_flags',
  },
];

T('migrations apply once, list applied, and roll back with tested down SQL', async () => {
  const { db } = await fresh();
  eq((await appliedMigrations(db)).includes('2026-09-09-scratch-flag'), false);
  eq(await applyMigrations(db, scratch, NOW), ['2026-09-09-scratch-flag']);
  eq(await applyMigrations(db, scratch, NOW), [], 'second apply is a no-op:');
  await db.prepare('INSERT INTO scratch_flags (id, onoff) VALUES (?, ?)').run('f1', 1);
  await rollbackMigration(db, scratch, '2026-09-09-scratch-flag');
  eq((await appliedMigrations(db)).includes('2026-09-09-scratch-flag'), false);
  let gone = '';
  try {
    await db.prepare('SELECT * FROM scratch_flags').all();
  } catch (e) {
    gone = (e as Error).message;
  }
  eq(gone.length > 0, true, 'down SQL dropped the table:');
  await rejects(async () => await rollbackMigration(db, scratch, '2026-09-09-scratch-flag'), 'NOT_APPLIED');
  await rejects(async () => await rollbackMigration(db, scratch, 'nope'), 'UNKNOWN_MIGRATION');
  void TEN;
});

T('the PG schema is derived, not maintained — zero drift by construction', async () => {
  eq(PG_SCHEMA.includes('AUTOINCREMENT'), false, 'no sqlite-isms survive:');
  eq(PG_SCHEMA.includes('BIGSERIAL PRIMARY KEY'), true);
  const tables = (s: string) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)!.sort();
  eq(tables(PG_SCHEMA), tables(SCHEMA), 'same tables, translated:');
});

T('placeholders rewrite per position, skipping string literals', async () => {
  eq(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  eq(
    toPostgresPlaceholders("SELECT 'what?' FROM t WHERE a = ?"),
    "SELECT 'what?' FROM t WHERE a = $1",
    'literal ? untouched:',
  );
  eq(
    toPostgresPlaceholders("SELECT 'it''s ?' FROM t WHERE a = ?"),
    "SELECT 'it''s ?' FROM t WHERE a = $1",
    'escaped quotes handled:',
  );
  eq(toPostgresPlaceholders('SELECT 1'), 'SELECT 1');
});

T('day truncation and grouping emit the PG dialect', async () => {
  eq(dayOf('postgres', 'created_at'), '(created_at::timestamptz)::date');
  eq(dayOf('sqlite', 'created_at'), 'date(created_at)');
  eq(groupConcat('postgres', 'scope'), "string_agg(DISTINCT scope, ',')");
});

T('runtime wiring picks postgres by URL without connecting', async () => {
  const pg = openFromEnv({ DATABASE_URL: 'postgres://u:p@host:5432/db' } as NodeJS.ProcessEnv);
  eq(pg.kind, 'postgres');
  void pg.db.close();
  const lite = openFromEnv({} as NodeJS.ProcessEnv);
  eq(lite.kind, 'sqlite');
  lite.db.close();
});
