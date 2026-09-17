import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Storage is deliberately minimal and Postgres-swappable, mirroring QM's own
 * shape (sessions / memory / queue in one durable store).
 *
 * dev/test : node:sqlite  (zero-infra, single file, real transactions)
 * prod     : Postgres     (QM already runs on it; the Ledger is just tables)
 *
 * Only the statements in `migrations` and the handful of queries in this repo
 * need porting; nothing above this file knows which engine is underneath.
 */

export interface Row {
  [k: string]: unknown;
}

export interface AsyncStatement {
  all(...params: unknown[]): Promise<Row[]>;
  get(...params: unknown[]): Promise<Row | undefined>;
  run(...params: unknown[]): Promise<{ changes: number }>;
}

/**
 * The only database interface modules may program to (TODO V2.1).
 *
 * `node:postgres` has no synchronous client, so the old sync `Db`
 * (`node:sqlite`) could not survive contact with production. Every module
 * takes this instead: sqlite wraps its synchronous driver behind resolved
 * promises, Postgres implements it natively (`src/core/pg.ts`). One path.
 */
export interface AsyncDb {
  readonly engine: 'sqlite' | 'postgres';
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}

function wrapSqlite(raw: DatabaseSync): AsyncDb {
  const stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  // node:sqlite types want SQLInputValue; we normalize undefined→null and
  // boolean→0/1 first, so the cast is the only bridge needed.
  type SqlValue = string | number | bigint | Uint8Array | null;
  const clean = (v: unknown): SqlValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (v instanceof Uint8Array) return v;
    return String(v);
  };
  const args = (p: unknown[]): SqlValue[] => p.map(clean);
  // Async fn bodies cross await points where other tasks can interleave, so
  // a multi-statement transaction must hold a lock for its whole body —
  // otherwise two concurrent transactions interleave statements on one
  // connection. Single statements stay lock-free: the driver runs them
  // synchronously, which is atomic on one thread.
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = tail;
    tail = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    return release;
  };
  let depth = 0;
  return {
    engine: 'sqlite',
    prepare(sql: string): AsyncStatement {
      const s = prep(sql);
      return {
        all: async (...p) => s.all(...args(p)) as Row[],
        get: async (...p) => s.get(...args(p)) as Row | undefined,
        run: async (...p) => {
          const out = s.run(...args(p)) as { changes: number };
          return { changes: out.changes };
        },
      };
    },
    exec: async (sql) => {
      raw.exec(sql);
    },
    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      // Nested transactions become SAVEPOINTs so the ledger can wrap a
      // multi-statement atomic append without deadlocking itself.
      if (depth > 0) {
        raw.exec(`SAVEPOINT sp${depth}`);
        depth += 1;
        try {
          const out = await fn();
          depth -= 1;
          raw.exec(`RELEASE sp${depth}`);
          return out;
        } catch (err) {
          depth -= 1;
          raw.exec(`ROLLBACK TO sp${depth}`);
          throw err;
        }
      }
      const release = await acquire();
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = await fn();
        depth = 0;
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        depth = 0;
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        release();
      }
    },
    close: async () => {
      raw.close();
    },
  };
}

export function openDb(path = ':memory:'): AsyncDb {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  return wrapSqlite(new DatabaseSync(path));
}

/**
 * JSON field access behind the engine dialect — the Postgres parity pass
 * (TODO §0.5). SQLite speaks `json_extract(col,'$.key')`; Postgres speaks
 * `(col::jsonb ->> 'key')` (text) with an explicit cast for numerics.
 * Callers use these helpers instead of inline `json_extract` so the same
 * `AsyncDb` interface carries both dialects; a Postgres driver only needs to set
 * `engine: 'postgres'`.
 */
export function jsonNumber(engine: AsyncDb['engine'], col: string, key: string): string {
  return engine === 'postgres' ? `((${col}::jsonb ->> '${key}'))::float` : `json_extract(${col},'$.${key}')`;
}

export function jsonText(engine: AsyncDb['engine'], col: string, key: string): string {
  return engine === 'postgres' ? `(${col}::jsonb ->> '${key}')` : `json_extract(${col},'$.${key}')`;
}

/** GROUP_CONCAT (SQLite) vs string_agg (Postgres). Separator is always ','. */
export function groupConcat(engine: AsyncDb['engine'], expr: string): string {
  return engine === 'postgres' ? `string_agg(DISTINCT ${expr}, ',')` : `GROUP_CONCAT(DISTINCT ${expr})`;
}

/** Day truncation over ISO-instant TEXT columns: date() vs timestamptz cast. */
export function dayOf(engine: AsyncDb['engine'], col: string): string {
  return engine === 'postgres' ? `(${col}::timestamptz)::date` : `date(${col})`;
}

// ------------------------------------------------------------- migrations ----

/** Additive, idempotent statements applied after the base schema on both engines. */
export const ADDITIVE_MIGRATIONS: string[] = [
  "ALTER TABLE skill_cards ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'internal'",
  `CREATE TABLE IF NOT EXISTS routing_calibration (
    tenant TEXT NOT NULL, task_type TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, task_type, tier, model))`,
];

/** Version stamp, UPSERT form (not INSERT OR IGNORE) so it runs on Postgres unchanged. */
export async function stampVersion(db: AsyncDb, version: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', version);
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  statement     TEXT NOT NULL,
  value_json    TEXT,
  unit          TEXT,
  confidence    REAL NOT NULL,
  source_uri    TEXT NOT NULL,
  source_tier   TEXT NOT NULL,
  extractor     TEXT NOT NULL,
  extractor_ver TEXT NOT NULL,
  retrieved_at  TEXT NOT NULL,
  raw_ref       TEXT,
  corrob_json   TEXT,
  observed_at   TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  valid_until   TEXT,
  verified_at   TEXT,
  status        TEXT NOT NULL,
  owner         TEXT NOT NULL,
  scope         TEXT NOT NULL,
  provisional   INTEGER NOT NULL DEFAULT 0,
  buzz_sig      TEXT,
  created_at    TEXT NOT NULL,
  seq           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_claims_subject ON claims(tenant, subject, status);
CREATE INDEX IF NOT EXISTS ix_claims_kind    ON claims(tenant, kind, status);
CREATE INDEX IF NOT EXISTS ix_claims_expiry  ON claims(tenant, status, valid_until);
CREATE INDEX IF NOT EXISTS ix_claims_scope   ON claims(tenant, scope);

CREATE TABLE IF NOT EXISTS claim_links (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  link    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, link)
);
CREATE INDEX IF NOT EXISTS ix_links_to ON claim_links(to_id, link);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  goal         TEXT NOT NULL,
  action       TEXT NOT NULL,
  action_class TEXT NOT NULL,
  context_bundle TEXT NOT NULL,
  decided_by   TEXT NOT NULL,
  approved_by  TEXT,
  scope        TEXT NOT NULL,
  autonomy     TEXT NOT NULL,
  request_id   TEXT,
  signed_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  tenant      TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  metric      TEXT NOT NULL,
  predicted   REAL,
  actual      REAL,
  basis       TEXT NOT NULL,
  holdout_ref TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outcomes_decision ON outcomes(tenant, decision_id);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT PRIMARY KEY,
  tenant           TEXT NOT NULL,
  message_class    TEXT NOT NULL,
  origin_scope     TEXT NOT NULL,
  target_scope     TEXT NOT NULL,
  goal             TEXT NOT NULL,
  claim_refs       TEXT NOT NULL,
  deliverable      TEXT NOT NULL,
  bid_json         TEXT NOT NULL,
  on_behalf_of     TEXT NOT NULL,
  hop_chain        TEXT NOT NULL,
  chain_claims     TEXT NOT NULL,
  idem_key         TEXT NOT NULL,
  stop_condition   TEXT NOT NULL,
  state            TEXT NOT NULL,
  spent_json       TEXT NOT NULL,
  refusal_reason   TEXT,
  parent_request   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_req_idem ON requests(tenant, idem_key);
CREATE INDEX IF NOT EXISTS ix_req_state ON requests(tenant, state, target_scope);

CREATE TABLE IF NOT EXISTS skill_cards (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  intent        TEXT NOT NULL,
  predicates    TEXT NOT NULL,
  steps         TEXT NOT NULL,
  tests         TEXT NOT NULL,
  tool_grants   TEXT NOT NULL,
  validated_tier TEXT NOT NULL,
  scope_json    TEXT NOT NULL,
  state         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  provenance    TEXT NOT NULL,
  eval_ref      TEXT,
  owner         TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_skill_state ON skill_cards(tenant, state, intent);

CREATE TABLE IF NOT EXISTS traces (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  request_id TEXT,
  scope      TEXT NOT NULL,
  task_type  TEXT NOT NULL,
  intent     TEXT NOT NULL,
  steps      TEXT NOT NULL,
  tier       TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  cost_json  TEXT NOT NULL,
  skill_card TEXT,
  router_confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_traces_intent ON traces(tenant, intent, created_at);
CREATE INDEX IF NOT EXISTS ix_traces_type   ON traces(tenant, task_type, outcome);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant          TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  scope           TEXT NOT NULL,
  action_class    TEXT NOT NULL,
  proposed        TEXT NOT NULL,
  executed        TEXT NOT NULL,
  policy_baseline TEXT NOT NULL,
  shadow          INTEGER NOT NULL,
  guards          TEXT NOT NULL,
  skill_card      TEXT,
  confidence      REAL,
  importance      REAL NOT NULL,
  labeled         INTEGER NOT NULL DEFAULT 0,
  correct_tier    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_routing_tenant ON routing_decisions(tenant, labeled, proposed);
CREATE INDEX IF NOT EXISTS ix_routing_type   ON routing_decisions(tenant, task_type, executed);

CREATE TABLE IF NOT EXISTS skill_transfer_tests (
  card_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  variant TEXT NOT NULL,
  passed  INTEGER NOT NULL,
  score   REAL NOT NULL,
  ran_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_transfer_card ON skill_transfer_tests(card_id, kind, passed);

CREATE TABLE IF NOT EXISTS trust_scores (
  tenant        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  action_class  TEXT NOT NULL,
  clean         INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  override_rate REAL NOT NULL DEFAULT 0,
  honey_misses  INTEGER NOT NULL DEFAULT 0,
  granted       INTEGER NOT NULL DEFAULT 0,
  frozen        INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant, scope, action_class)
);

CREATE TABLE IF NOT EXISTS honeytasks (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  is_bad     INTEGER NOT NULL,
  injected   INTEGER NOT NULL,
  detected   INTEGER,
  acted_on   INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS escalations (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  request_id TEXT,
  human      TEXT NOT NULL,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_cases (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  capability TEXT NOT NULL,
  suite      TEXT NOT NULL,
  input_json TEXT NOT NULL,
  expect_json TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_eval_suite ON eval_cases(tenant, capability, suite);

CREATE TABLE IF NOT EXISTS eval_runs (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  suite      TEXT NOT NULL,
  target     TEXT NOT NULL,
  passed     INTEGER NOT NULL,
  failed     INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  ran_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  detail     TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_seq (tenant TEXT PRIMARY KEY, next INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS routing_calibration (
  tenant TEXT NOT NULL, task_type TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, task_type, tier, model)
);
`;

/** The one schema, translated for Postgres (AUTOINCREMENT → BIGSERIAL). Zero drift by construction. */
export const PG_SCHEMA: string = SCHEMA.split('INTEGER PRIMARY KEY AUTOINCREMENT').join('BIGSERIAL PRIMARY KEY');

export async function migrate(db: AsyncDb): Promise<void> {
  await db.exec(db.engine === 'postgres' ? PG_SCHEMA : SCHEMA);
  // Minimal migration runner: additive statements only, idempotent via
  // try/catch (SQLite and Postgres both error on duplicate ADD COLUMN).
  for (const sql of ADDITIVE_MIGRATIONS) {
    try {
      await db.exec(sql);
    } catch {
      /* already migrated */
    }
  }
  await stampVersion(db, '4');
}

/** Tenant-scoped monotonic sequence for the append-only ledger. */
export async function nextSeq(db: AsyncDb, tenant: string): Promise<number> {
  return db.transaction(async () => {
    const row = (await db.prepare('SELECT next FROM ledger_seq WHERE tenant = ?').get(tenant)) as
      { next: number } | undefined;
    const n = (row?.next ?? 0) + 1;
    if (row) await db.prepare('UPDATE ledger_seq SET next = ? WHERE tenant = ?').run(n, tenant);
    else await db.prepare('INSERT INTO ledger_seq (tenant, next) VALUES (?, ?)').run(tenant, n);
    return n;
  });
}
