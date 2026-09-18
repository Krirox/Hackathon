import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
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
/** Snapshot reads include this transaction's own writes. Nesting must inherit an
 * adequate snapshot or reject before invoking the callback; it cannot upgrade
 * an already active PostgreSQL READ COMMITTED transaction. */
export interface TransactionOptions {
  snapshot?: boolean;
}

export interface AsyncDb {
  readonly engine: 'sqlite' | 'postgres';
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T> | T, options?: TransactionOptions): Promise<T>;
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
  // connection. Single statements go through the same queue: the driver runs
  // them synchronously (atomic on one thread), but without the lock a
  // standalone nextSeq upsert could land mid-transaction and a concurrent
  // top-level transaction would be misread as nested. Statements stay
  // non-transactional — they just wait their turn.
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
  // Transaction depth rides the async chain (like pg.ts's tx storage), never
  // shared mutable state: two concurrent top-level transactions each see
  // "no store" and serialize on the mutex, while a genuinely-nested call on
  // the same chain sees its parent's depth and becomes a SAVEPOINT. A
  // closure `depth` variable cannot express this — the second concurrent
  // transaction would take the savepoint path inside the first one's BEGIN
  // and read its uncommitted writes.
  const txDepth = new AsyncLocalStorage<{ depth: number }>();
  const locked = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return {
    engine: 'sqlite',
    prepare(sql: string): AsyncStatement {
      const s = prep(sql);
      // Inside a transaction the caller already holds the lock: run direct.
      // Outside one, queue behind (and ahead of) running transactions.
      const runLocked = async <T>(fn: () => T): Promise<T> => {
        if (txDepth.getStore()) return fn();
        return locked(fn);
      };
      return {
        all: async (...p) => runLocked(() => s.all(...args(p)) as Row[]),
        get: async (...p) => runLocked(() => s.get(...args(p)) as Row | undefined),
        run: async (...p) =>
          runLocked(() => {
            const out = s.run(...args(p)) as { changes: number };
            return { changes: out.changes };
          }),
      };
    },
    exec: async (sql) => {
      if (txDepth.getStore()) {
        raw.exec(sql);
        return;
      }
      await locked(() => raw.exec(sql));
    },
    async transaction<T>(fn: () => Promise<T> | T, options?: TransactionOptions): Promise<T> {
      const parent = txDepth.getStore();
      // Nested transactions become SAVEPOINTs so the ledger can wrap a
      // multi-statement atomic append without deadlocking itself.
      if (parent && parent.depth > 0) {
        raw.exec(`SAVEPOINT sp${parent.depth}`);
        parent.depth += 1;
        try {
          const out = await fn();
          parent.depth -= 1;
          raw.exec(`RELEASE sp${parent.depth}`);
          return out;
        } catch (err) {
          parent.depth -= 1;
          raw.exec(`ROLLBACK TO sp${parent.depth}`);
          raw.exec(`RELEASE sp${parent.depth}`);
          throw err;
        }
      }
      const release = await acquire();
      try {
        // Deferred readers allow concurrent writers in WAL mode. Ordinary
        // write transactions retain their existing BEGIN IMMEDIATE semantics.
        raw.exec(options?.snapshot ? 'BEGIN' : 'BEGIN IMMEDIATE');
        const out = await txDepth.run({ depth: 1 }, fn);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
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

/**
 * Additive statements applied after the base schema on both engines. Since
 * the F07 consolidation these are NOT fire-and-forget text: `migrate()` runs
 * every statement inside ONE tracked transaction recorded as named rows in
 * `schema_migrations`, so a failure fails startup instead of being swallowed
 * as "already migrated". Idempotent re-application is explicit (IF NOT
 * EXISTS DDL, column-existence checks for ALTERs), never implicit try/catch.
 */
export const ADDITIVE_MIGRATIONS: string[] = [
  "ALTER TABLE skill_cards ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'internal'",
  `CREATE TABLE IF NOT EXISTS routing_calibration (
    tenant TEXT NOT NULL, task_type TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, task_type, tier, model))`,
  `CREATE TABLE IF NOT EXISTS subjects (
    id           TEXT PRIMARY KEY,
    tenant       TEXT NOT NULL,
    key          TEXT NOT NULL,
    display_name TEXT,
    kind         TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    UNIQUE (tenant, key))`,
  `CREATE INDEX IF NOT EXISTS ix_subjects_tenant ON subjects(tenant, kind)`,
  `CREATE INDEX IF NOT EXISTS ix_traces_request ON traces(tenant, request_id)`,
  `CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(tenant, action, at)`,
  // F01: per-request budget reservation (bid held at admission, released on
  // terminal states) so concurrent admits account outstanding bids, not just
  // spent. F02: exclusive execution ownership (owner/attempt/lease on the
  // request row). Additive columns only — base SCHEMA untouched.
  `ALTER TABLE requests ADD COLUMN reserved_json TEXT NOT NULL DEFAULT '{"dollars":0,"tokens":0}'`,
  `ALTER TABLE requests ADD COLUMN exec_owner TEXT`,
  `ALTER TABLE requests ADD COLUMN exec_attempt INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE requests ADD COLUMN claimed_at TEXT`,
  `ALTER TABLE requests ADD COLUMN lease_ms INTEGER NOT NULL DEFAULT 0`,
  // F03: durable ingest inbox — collectors stage fetched events here BEFORE
  // advancing cursors, so a crash between fetch and cursor leaves the event
  // in the inbox (no loss) and a retry dedupes on the UNIQUE key (no dup).
  // Portable DDL: TEXT primary key + IF NOT EXISTS, no engine-only syntax.
  `CREATE TABLE IF NOT EXISTS ingest_inbox (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL, collector TEXT NOT NULL,
    source_event_id TEXT NOT NULL, revision TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE (tenant, collector, source_event_id, revision))`,
  `CREATE INDEX IF NOT EXISTS ix_inbox_claim ON ingest_inbox(tenant, collector, status, created_at)`,
  // F15: generic durable outbox — producers enqueue inside their own
  // transaction where feasible; a relay sends to SQS only AFTER commit
  // (dispatch-after-commit), so a crash never sends what was not stored.
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_claim ON outbox(status, next_at)`,
  // F18: normalized alias lookup. The subjects.aliases_json LIKE scan is a
  // leading-wildcard search over JSON text; this table gives exact-match
  // resolution first (UNIQUE per tenant keeps one alias on one subject).
  // Portable DDL: TEXT + IF NOT EXISTS + UNIQUE, no engine-only syntax.
  `CREATE TABLE IF NOT EXISTS subject_aliases (
    tenant      TEXT NOT NULL,
    subject_id  TEXT NOT NULL,
    alias_norm  TEXT NOT NULL,
    UNIQUE (tenant, alias_norm))`,
  `CREATE INDEX IF NOT EXISTS ix_subject_aliases_lookup ON subject_aliases(tenant, alias_norm)`,
  // Native spent mirrors: REAL columns tracking spent_json dollars/tokens so
  // the admission SUM reads plain columns instead of casting JSON per row
  // per submit. ALTERs are portable; the backfill below is engine-specific.
  `ALTER TABLE requests ADD COLUMN spent_tokens REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE requests ADD COLUMN spent_dollars REAL NOT NULL DEFAULT 0`,
  // F18: immutable card revision, eval run reference, evaluator, and model identity
  // for transfer tests so evidence has full lineage.
  'ALTER TABLE skill_transfer_tests ADD COLUMN card_version INTEGER',
  'ALTER TABLE skill_transfer_tests ADD COLUMN eval_run_id TEXT',
  'ALTER TABLE skill_transfer_tests ADD COLUMN evaluator TEXT',
  'ALTER TABLE skill_transfer_tests ADD COLUMN model TEXT',
  // F19: maintain override counts on trust scores
  'ALTER TABLE trust_scores ADD COLUMN overrides INTEGER NOT NULL DEFAULT 0',
  // F23: database-level tenant constraint on skill_transfer_tests and card revision lineage
  "ALTER TABLE skill_transfer_tests ADD COLUMN tenant TEXT NOT NULL DEFAULT ''",
  'CREATE INDEX IF NOT EXISTS ix_transfer_tenant_card ON skill_transfer_tests(tenant, card_id, card_version, kind, passed)',
  `CREATE TABLE IF NOT EXISTS skill_card_revisions (
    tenant       TEXT NOT NULL,
    card_id      TEXT NOT NULL,
    version      INTEGER NOT NULL,
    state        TEXT NOT NULL,
    scope_json   TEXT NOT NULL,
    action       TEXT NOT NULL,
    actor        TEXT NOT NULL,
    detail       TEXT,
    recorded_at  TEXT NOT NULL,
    PRIMARY KEY (tenant, card_id, version)
  )`,
  'CREATE INDEX IF NOT EXISTS ix_card_revisions ON skill_card_revisions(tenant, card_id, version DESC)',
  // F24: durable watch contracts with budget, re-review dates, and spend tracking
  `CREATE TABLE IF NOT EXISTS watch_contracts (
    id                     TEXT PRIMARY KEY,
    tenant                 TEXT NOT NULL,
    name                   TEXT NOT NULL,
    state                  TEXT NOT NULL,
    entities_json          TEXT NOT NULL,
    predicates_json        TEXT NOT NULL,
    goal_refs_json         TEXT NOT NULL,
    revenue_cost_risk_json TEXT NOT NULL,
    thresholds_json        TEXT NOT NULL,
    max_dollars            REAL NOT NULL,
    max_tokens             INTEGER NOT NULL,
    spent_dollars          REAL NOT NULL DEFAULT 0,
    spent_tokens           INTEGER NOT NULL DEFAULT 0,
    compiled_at            TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    reviewed_at            TEXT,
    reviewed_by            TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS ix_watch_contracts_tenant ON watch_contracts(tenant, state)',
];

/** Version stamp, UPSERT form (not INSERT OR IGNORE) so it runs on Postgres unchanged. */
export async function stampVersion(db: AsyncDb, version: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', version);
}

/**
 * F07: does this table have the column already? The portable existence
 * probe for the ALTER TABLE entries above — re-running `migrate()` on an
 * up-to-date database must be a clean no-op, and "did the ALTER fail
 * because the column exists" must be a fact we READ, not an error we
 * swallow (SQLite's duplicate-column error message is not a contract).
 * Postgres: information_schema. SQLite: pragma_table_info (no
 * information_schema there — the first live run caught that).
 */
export async function columnExists(db: AsyncDb, table: string, column: string): Promise<boolean> {
  const rows =
    db.engine === 'postgres'
      ? ((await db
          .prepare(
            `SELECT column_name FROM information_schema.columns
             WHERE lower(table_name) = lower(?) AND lower(column_name) = lower(?)`,
          )
          .all(table, column)) as { column_name: string }[])
      : ((await db
          .prepare('SELECT name FROM pragma_table_info(?) WHERE lower(name) = lower(?)')
          .all(table, column)) as { name: string }[]);
  return rows.length > 0;
}

/**
 * F07: apply one additive migration with explicit idempotency. DDL guards
 * itself (CREATE ... IF NOT EXISTS); ALTER TABLE entries are probed with
 * `columnExists` first. Any OTHER failure rethrows — never swallowed.
 */
async function applyAdditiveStatement(db: AsyncDb, sql: string): Promise<void> {
  const alter = /ALTER TABLE\s+([\w"]+)\s+ADD COLUMN\s+([\w"]+)/i.exec(sql);
  if (alter) {
    if (await columnExists(db, alter[1]!, alter[2]!)) return;
  }
  await db.exec(sql);
}

const MIGRATION_JOURNAL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
)`;

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
  PRIMARY KEY (from_id, to_id, link),
  -- Enforced on BOTH engines: node:sqlite enables PRAGMA foreign_keys=ON by
  -- default on every connection (verified: fresh DatabaseSync reports
  -- foreign_keys=1, no PRAGMA management needed), and Postgres enforces the
  -- derived keys. The ledger guards the same invariant in code (link()
  -- throws MISSING_CLAIM before writing) so violations surface as ledger
  -- errors, never bare FK failures; verifyIntegrity() below REPORTS any
  -- orphans that slipped in around the ledger (pragma-off restores, copies).
  FOREIGN KEY (from_id) REFERENCES claims(id),
  FOREIGN KEY (to_id) REFERENCES claims(id)
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
  created_at  TEXT NOT NULL,
  -- Same posture as claim_links above: enforced on both engines, guarded in
  -- code (recordOutcome throws MISSING_DECISION), reported by
  -- verifyIntegrity().
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
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
  /** Native mirrors of spent_json dollars/tokens: the admission SUM reads
   *  these instead of casting JSON per row per submit. spent_json stays the
   *  source of truth (full shape); mirrors move only inside the single
   *  atomic UPDATE in spentAddAtomic, so they cannot drift. */
  spent_tokens     REAL NOT NULL DEFAULT 0,
  spent_dollars    REAL NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS ix_traces_request ON traces(tenant, request_id);

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
  tenant       TEXT NOT NULL,
  card_id      TEXT NOT NULL,
  card_version INTEGER,
  kind         TEXT NOT NULL,
  variant      TEXT NOT NULL,
  passed       INTEGER NOT NULL,
  score        REAL NOT NULL,
  ran_at       TEXT NOT NULL,
  eval_run_id  TEXT,
  evaluator    TEXT,
  model        TEXT
);
CREATE INDEX IF NOT EXISTS ix_transfer_tenant_card ON skill_transfer_tests(tenant, card_id, card_version, kind, passed);
CREATE INDEX IF NOT EXISTS ix_transfer_card ON skill_transfer_tests(card_id, kind, passed);

CREATE TABLE IF NOT EXISTS skill_card_revisions (
  tenant       TEXT NOT NULL,
  card_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,
  state        TEXT NOT NULL,
  scope_json   TEXT NOT NULL,
  action       TEXT NOT NULL,
  actor        TEXT NOT NULL,
  detail       TEXT,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (tenant, card_id, version)
);
CREATE INDEX IF NOT EXISTS ix_card_revisions ON skill_card_revisions(tenant, card_id, version DESC);

CREATE TABLE IF NOT EXISTS trust_scores (
  tenant        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  action_class  TEXT NOT NULL,
  clean         INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  overrides     INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(tenant, action, at);

CREATE TABLE IF NOT EXISTS ledger_seq (tenant TEXT PRIMARY KEY, "next" INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS routing_calibration (
  tenant TEXT NOT NULL, task_type TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, task_type, tier, model)
);

CREATE TABLE IF NOT EXISTS watch_contracts (
  id                     TEXT PRIMARY KEY,
  tenant                 TEXT NOT NULL,
  name                   TEXT NOT NULL,
  state                  TEXT NOT NULL,
  entities_json          TEXT NOT NULL,
  predicates_json        TEXT NOT NULL,
  goal_refs_json         TEXT NOT NULL,
  revenue_cost_risk_json TEXT NOT NULL,
  thresholds_json        TEXT NOT NULL,
  max_dollars            REAL NOT NULL,
  max_tokens             INTEGER NOT NULL,
  spent_dollars          REAL NOT NULL DEFAULT 0,
  spent_tokens           INTEGER NOT NULL DEFAULT 0,
  compiled_at            TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  reviewed_at            TEXT,
  reviewed_by            TEXT
);
CREATE INDEX IF NOT EXISTS ix_watch_contracts_tenant ON watch_contracts(tenant, state);
`;

/** The one schema, translated for Postgres (AUTOINCREMENT → BIGSERIAL). Zero drift by construction. */
export const PG_SCHEMA: string = SCHEMA.split('INTEGER PRIMARY KEY AUTOINCREMENT').join('BIGSERIAL PRIMARY KEY');

/**
 * The ONE migration authority (F07 consolidation).
 *
 * Order of operations, both engines:
 *   1. base schema (CREATE IF NOT EXISTS — self-idempotent)
 *   2. the additive list, applied as ONE named journal entry
 *      (`additive-list-v6`) in `schema_migrations`
 *   3. one-shot spent-mirror backfill (data migration, meta-flagged)
 *   4. version stamp
 *
 * What changed vs the old runner: a failure inside the additive list used
 * to be swallowed as "already migrated" while the version was stamped 6
 * anyway — a half-migrated database reported current. Now the additive
 * application runs in a transaction with the journal row, so an error
 * rolls back BOTH the DDL and the record and the failure propagates to
 * the caller (startup fails loudly on incomplete upgrades). Journal rows
 * are stamped FIRST for already-applied work, so a database created by the
 * older runner (schema present, journal empty) upgrades in place without
 * re-running anything.
 *
 * Idempotency is explicit, not catch-all: IF NOT EXISTS DDL, a
 * column-existence probe for each ALTER, and the meta-flagged backfill.
 * Concurrent boots may race the journal INSERT; the ON CONFLICT keeps the
 * first stamp and both write identical schema, so either outcome is sound.
 * Two boots can ALSO race inside Postgres itself: both pass the IF NOT
 * EXISTS existence check for the same table and collide in the catalog
 * (pg_type/pg_class unique indexes). That error means the object exists —
 * which is all idempotency needs — so schema DDL retries once on exactly
 * that class of failure (F07 concurrent-startup drill).
 */

/** True only for the duplicate-object catalog race (or its internal 23505). */
function isCatalogRace(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === '42P07' || code === '42710') return true; // duplicate_table / duplicate_object
  const msg = (error as Error).message ?? '';
  return msg.includes('pg_type_typname_nsp_index') || msg.includes('pg_class_relname_nsp_index');
}

/** Run IF NOT EXISTS DDL; one retry absorbs the concurrent-boot catalog race. */
async function execIdempotent(db: AsyncDb, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (error) {
    if (!isCatalogRace(error)) throw error;
    await db.exec(sql); // the object now exists; IF NOT EXISTS skips it
  }
}

export async function migrate(db: AsyncDb): Promise<void> {
  await execIdempotent(db, db.engine === 'postgres' ? PG_SCHEMA : SCHEMA);
  await execIdempotent(db, MIGRATION_JOURNAL);
  const additiveName = 'additive-list-v6';
  const stamped = (await db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(additiveName)) as
    { name: string } | undefined;
  if (stamped) {
    for (const sql of ADDITIVE_MIGRATIONS) {
      await applyAdditiveStatement(db, sql);
    }
    await runBackfill(db);
    await stampVersion(db, '6');
    return;
  }
  await db.transaction(async () => {
    // Stamp BEFORE the DDL: this transaction is the unit. If the DDL fails,
    // the stamp rolls back with it; if we crash mid-DDL, same. A journal
    // row WITHOUT its schema can only exist if someone deleted DDL rows
    // outside migrate() — not a state this runner can create.
    await db
      .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
      .run(additiveName, new Date().toISOString());
    for (const sql of ADDITIVE_MIGRATIONS) {
      await applyAdditiveStatement(db, sql);
    }
  });
  await runBackfill(db);
  await stampVersion(db, '6');
}

/**
 * Spent-mirror backfill: recomputed from spent_json, so re-running is a
 * no-op by construction (same source, same values). One-shot via a meta
 * flag — every boot re-scanning the table to rewrite identical values
 * would make migration cost history-sized. Engine-specific cast syntax —
 * this is the one place migrations branch on dialect. Concurrent boots
 * may both backfill; both write identical values.
 */
async function runBackfill(db: AsyncDb): Promise<void> {
  const backfilled = (await db.prepare('SELECT value FROM meta WHERE key = ?').get('spent_mirrors_backfilled')) as
    { value: string } | undefined;
  if (backfilled) return;
  if (db.engine === 'postgres') {
    await db.exec(
      `UPDATE requests SET spent_tokens = COALESCE((spent_json::jsonb ->> 'tokens')::float,0),
        spent_dollars = COALESCE((spent_json::jsonb ->> 'dollars')::float,0)`,
    );
  } else {
    await db.exec(
      `UPDATE requests SET spent_tokens = COALESCE(json_extract(spent_json,'$.tokens'),0),
        spent_dollars = COALESCE(json_extract(spent_json,'$.dollars'),0)`,
    );
  }
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('spent_mirrors_backfilled', '6');
}

/**
 * Tenant-scoped monotonic sequence for the append-only ledger.
 *
 * One atomic UPSERT, never SELECT-then-UPDATE. Under Postgres the pool hands
 * each transaction its own client at READ COMMITTED, so a read-then-write
 * lets two concurrent appends observe the same `next` and mint the same seq
 * (the sqlite driver's BEGIN IMMEDIATE hid this; it was never verified
 * through the production engine). `ON CONFLICT ... DO UPDATE ... RETURNING`
 * is evaluated under the row lock, so every caller gets a distinct value on
 * both engines.
 *
 * `"next"` is quoted because NEXT is a reserved word in Postgres. It is not
 * reserved in SQLite, and a double-quoted identifier is portable to both.
 *
 * Seq semantics (read before streaming on this): allocation is NOT
 * commit-visibility order. `nextSeq` runs BEFORE the claim INSERT transaction
 * (see ledger append), so a crashed or rolled-back append leaves a gap, and
 * two concurrent appends can commit in the opposite order of their seqs.
 * Consumers must therefore never treat "seq > watermark" as "visible":
 * stream from a commit watermark (e.g. the outbox pattern — rows marked
 * delivered inside the same transaction that made them visible), never from
 * the raw seq counter.
 */
export async function nextSeq(db: AsyncDb, tenant: string): Promise<number> {
  const row = (await db
    .prepare(
      `INSERT INTO ledger_seq (tenant, "next") VALUES (?, 1)
       ON CONFLICT(tenant) DO UPDATE SET "next" = ledger_seq."next" + 1
       RETURNING "next"`,
    )
    .get(tenant)) as { next: number } | undefined;
  if (!row) throw new Error('[db:SEQ] ledger_seq upsert returned no row');
  return Number(row.next);
}

/**
 * Read-only integrity checker for the foreign keys above.
 *
 * Reports orphans without deleting or failing anything: dangling claim_links
 * (an endpoint claim id with no claims row) and outcomes citing an unknown
 * decision. The ledger already refuses to CREATE these (MISSING_CLAIM /
 * MISSING_DECISION) and both engines enforce the keys, so a non-empty report
 * means rows were written around the ledger (pragma-off restore, a copy) —
 * investigate, never auto-delete. Links carry no tenant column, so the link
 * leg is scoped to links touching this tenant's claims plus fully-dangling
 * links (both endpoints gone, unattributable to any tenant).
 */
export interface IntegrityReport {
  ok: boolean;
  orphanOutcomes: { id: string; decisionId: string }[];
  danglingLinks: { fromId: string; toId: string; link: string; missing: 'from' | 'to' | 'both' }[];
}

export async function verifyIntegrity(db: AsyncDb, tenant: string): Promise<IntegrityReport> {
  const orphanOutcomes = (await db
    .prepare(
      `SELECT o.id AS id, o.decision_id AS decisionId FROM outcomes o
       LEFT JOIN decisions d ON d.id = o.decision_id
       WHERE o.tenant = ? AND d.id IS NULL`,
    )
    .all(tenant)) as { id: string; decisionId: string }[];
  const dangling = (await db
    .prepare(
      `SELECT l.from_id AS fromId, l.to_id AS toId, l.link AS link,
              cf.id AS hasFrom, ct.id AS hasTo
       FROM claim_links l
       LEFT JOIN claims cf ON cf.id = l.from_id
       LEFT JOIN claims ct ON ct.id = l.to_id
       WHERE (cf.id IS NULL OR ct.id IS NULL)
         AND (cf.tenant = ? OR ct.tenant = ? OR (cf.id IS NULL AND ct.id IS NULL))`,
    )
    .all(tenant, tenant)) as {
    fromId: string;
    toId: string;
    link: string;
    hasFrom: string | null;
    hasTo: string | null;
  }[];
  const danglingLinks = dangling.map((l) => {
    let missing: 'from' | 'to' | 'both' = 'to';
    if (l.hasFrom == null) missing = l.hasTo == null ? 'both' : 'from';
    return { fromId: String(l.fromId), toId: String(l.toId), link: String(l.link), missing };
  });
  const cleanOutcomes = orphanOutcomes.map((o) => ({ id: String(o.id), decisionId: String(o.decisionId) }));
  return { ok: cleanOutcomes.length === 0 && danglingLinks.length === 0, orphanOutcomes: cleanOutcomes, danglingLinks };
}
