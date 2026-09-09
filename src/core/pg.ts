import { Pool, type PoolClient } from 'pg';
import { migrate, type AsyncDb, type AsyncStatement, type Row } from './db.ts';
import { openDb } from './db.ts';

export type { AsyncDb, AsyncStatement, Row } from './db.ts';
export { PG_SCHEMA } from './db.ts';

/**
 * Postgres driver (TODO V2.1): the native async implementation of `AsyncDb`
 * (per-transaction client checkout, savepoints for nesting). The schema is
 * derived mechanically from the one SCHEMA (zero drift), `?` placeholders
 * rewrite outside string literals. Porting every module from sync `Db` to
 * `AsyncDb` is done — what remains here is the deployment path: driver,
 * migrations, wiring, and the CI/live verification.
 */

/** Rewrite `?` placeholders to `$n`, skipping single-quoted literals ('' escapes). */
export function toPostgresPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      if (inStr && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === '?' && !inStr) {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

const cleanParam = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  return v;
};

export function openPostgres(url: string): AsyncDb {
  const pool = new Pool({ connectionString: url });
  let holder: { client: PoolClient; depth: number } | null = null;

  const prep = (exec: (sql: string, params: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>) => {
    const run = (sql: string, params: unknown[]) => exec(toPostgresPlaceholders(sql), params.map(cleanParam));
    return (sql: string): AsyncStatement => ({
      all: async (...p) => (await run(sql, p)).rows,
      get: async (...p) => (await run(sql, p)).rows[0],
      run: async (...p) => ({ changes: (await run(sql, p)).rowCount ?? 0 }),
    });
  };

  const direct = prep((sql, params) => pool.query(sql, params as unknown[]));
  const scoped = (client: PoolClient) => prep((sql, params) => client.query(sql, params as unknown[]));

  return {
    engine: 'postgres',
    prepare: (sql) => (holder ? scoped(holder.client)(sql) : direct(sql)),
    exec: async (sql: string) => {
      if (holder) await holder.client.query(sql);
      else await pool.query(sql);
    },
    transaction: async <T>(fn: () => Promise<T> | T): Promise<T> => {
      if (holder) {
        const depth = holder.depth++;
        await holder.client.query(`SAVEPOINT vital_sp${depth}`);
        try {
          const out = await fn();
          await holder.client.query(`RELEASE SAVEPOINT vital_sp${depth}`);
          holder.depth--;
          return out;
        } catch (err) {
          await holder.client.query(`ROLLBACK TO SAVEPOINT vital_sp${depth}`);
          holder.depth--;
          throw err;
        }
      }
      const client = await pool.connect();
      holder = { client, depth: 1 };
      await client.query('BEGIN');
      try {
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        holder = null;
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

/** Apply the derived schema + additive migrations + version stamp. Unified `migrate` covers both engines — this stays as the explicit PG entry point. */
export async function migratePostgres(db: AsyncDb): Promise<void> {
  await migrate(db);
}

/** Runtime wiring: postgres:// URL → PG, anything else → sqlite. One `AsyncDb` either way. */
export function openFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { kind: 'postgres'; db: AsyncDb; url: string } | { kind: 'sqlite'; db: AsyncDb; path: string } {
  const url = env.DATABASE_URL ?? '';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { kind: 'postgres', db: openPostgres(url), url };
  }
  const path = env.SQLITE_PATH ?? ':memory:';
  return { kind: 'sqlite', db: openDb(path), path };
}
