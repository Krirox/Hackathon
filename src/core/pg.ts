import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  const normalized = url.replace(/^postgres:\/\//, 'postgresql://');
  const parsed = new URL(normalized);
  const sslMode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const connectionString = parsed.toString().replace(/^postgresql:\/\//, 'postgres://');
  // node-pg v8+ maps sslmode=require in the URL to verify-full semantics, which
  // rejects RDS's Amazon CA unless we ship the bundle. Strip the query param and
  // pass ssl explicitly for encrypted-but-unverified pilot RDS (see deploy/aws).
  const useSsl = sslMode !== null && sslMode !== 'disable';
  const pool = new Pool({
    connectionString,
    ...(useSsl ? { ssl: { rejectUnauthorized: sslMode === 'verify-full' || sslMode === 'verify-ca' } } : {}),
  });

  // Transaction context rides the async chain, never shared mutable state:
  // concurrent transactions each hold their own pool client (READ COMMITTED
  // + the atomic nextSeq upsert carry the correctness), while nested calls
  // on the same chain become savepoints on their parent's client. A closure
  // `holder` cannot express this — concurrent transactions would interleave
  // statements on one client and COMMIT would release it mid-flight
  // (`savepoint "vital_sp1" does not exist`, caught by the PG CI lane).
  const tx = new AsyncLocalStorage<{ client: PoolClient }>();
  let spCounter = 0; // synchronous increment: unique savepoint names even for concurrent nested calls

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
    prepare: (sql) => {
      const ctx = tx.getStore();
      return ctx ? scoped(ctx.client)(sql) : direct(sql);
    },
    exec: async (sql: string) => {
      const ctx = tx.getStore();
      if (ctx) await ctx.client.query(sql);
      else await pool.query(sql);
    },
    transaction: async <T>(fn: () => Promise<T> | T): Promise<T> => {
      const parent = tx.getStore();
      if (parent) {
        const name = `vital_sp${spCounter++}`;
        await parent.client.query(`SAVEPOINT ${name}`);
        try {
          const out = await fn();
          await parent.client.query(`RELEASE SAVEPOINT ${name}`);
          return out;
        } catch (err) {
          await parent.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw err;
        }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await tx.run({ client }, fn);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // the connection is toast either way; release it below
        }
        throw err;
      } finally {
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
