/**
 * Substrate, part 1 (TODO §0.5): the scheduler we stopped inheriting.
 *
 * Crons, watches, and inbound webhooks with rate budgets. Deliberately
 * small (no Slack coupling): a registry with per-job daily caps plus a
 * webhook intake with per-source rate limits and shared-secret auth. Time
 * is injected so tests never sleep.
 *
 * Durability note (F15): cron registries, counters, and webhook deliveries
 * below are still in-memory scheduling state — full scheduler persistence is
 * out of scope. What IS durable is the generic `outbox` beside it: producers
 * enqueue inside their own transaction where feasible (`enqueueOutbox`), a
 * relay claims batches (`claimOutbox`), sends to SQS only AFTER the commit
 * (dispatch-after-commit — a crash never sends what was not stored; the SQS
 * send itself is deploy wiring, see the deploy note), and closes rows with
 * `settleOutbox`. Scheduler occurrences that must survive a restart go
 * through `recordSchedulerOccurrence`, i.e. the outbox, not the in-memory
 * registry.
 */

import type { AsyncDb } from '../core/db.ts';

export class SchedulerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[scheduler:${code}] ${message}`);
  }
}

export interface CronJob {
  name: string;
  scope: string;
  intervalMs: number;
  maxFiresPerDay: number;
  handler: () => void | Promise<void>;
}

export interface WebhookDelivery {
  source: string;
  receivedAt: number;
  payload: unknown;
}

interface CronState extends CronJob {
  lastFire: number | null;
  firesByDay: Record<string, number>;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ------------------------------------------------------------- outbox ----

/**
 * Durable outbox row. `status` moves PENDING → CLAIMED → DONE; FAILED is
 * retryable (a later claim picks it up once `next_at` arrives) so a poisoned
 * batch never wedges the queue behind one bad row.
 */
export interface OutboxRow {
  id: string;
  tenant: string;
  kind: string;
  payload: unknown;
  status: string;
  attempts: number;
  nextAt: string;
}

/** Self-creating outbox (idempotent): safe on DBs migrated before F15. F10 adds owner/lease columns, probed idempotently. */
export async function ensureOutboxTable(db: AsyncDb): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL,
      owner TEXT, claimed_at TEXT)`,
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS ix_outbox_claim ON outbox(status, next_at)`);
  if (db.engine === 'sqlite') {
    const cols = new Set(
      ((await db.prepare('SELECT name FROM pragma_table_info(?)').all('outbox')) as { name: string }[]).map((r) =>
        String(r.name),
      ),
    );
    if (!cols.has('owner')) await db.exec(`ALTER TABLE outbox ADD COLUMN owner TEXT`);
    if (!cols.has('claimed_at')) await db.exec(`ALTER TABLE outbox ADD COLUMN claimed_at TEXT`);
  } else {
    await db.exec(`ALTER TABLE outbox ADD COLUMN IF NOT EXISTS owner TEXT`);
    await db.exec(`ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at TEXT`);
  }
}

/**
 * Enqueue inside the producing transaction where feasible
 * (`db.transaction(() => { ...write...; enqueueOutbox(...); })`): the row
 * commits atomically with the work that produced it. The SQS send happens
 * strictly AFTER commit (dispatch-after-commit, deploy wiring relays
 * CLAIMED rows to the queue) — never inside the transaction, so a rollback
 * cannot leave a sent-but-unstored message.
 */
export async function enqueueOutbox(
  db: AsyncDb,
  tenant: string,
  kind: string,
  payload: unknown,
  opts: { id?: string; now?: string; nextAt?: string } = {},
): Promise<string> {
  await ensureOutboxTable(db);
  const id = opts.id ?? crypto.randomUUID();
  const at = opts.now ?? new Date().toISOString();
  await db
    .prepare(`INSERT INTO outbox (id, tenant, kind, payload_json, status, attempts, next_at) VALUES (?,?,?,?,?,0,?)`)
    .run(id, tenant, kind, JSON.stringify(payload), 'PENDING', opts.nextAt ?? at);
  return id;
}

/**
 * F10: atomically mark the oldest due batch CLAIMED for one named owner
 * (PENDING, retry-due FAILED, or CLAIMED with an EXPIRED lease — a crashed
 * relay's work becomes runnable again). The ownership CAS is per-row and
 * conditional on the state the SELECT observed: under Postgres READ
 * COMMITTED a concurrent relay's committed claim makes our UPDATE match
 * zero rows for that row, so two relays can never both own it. The winner
 * is recorded and `settleOutbox` refuses settlement from any other owner,
 * so an expired owner cannot settle a row that has been re-claimed.
 */
export async function claimOutbox(
  db: AsyncDb,
  batch: number,
  now?: string,
  opts: { owner?: string; leaseMs?: number; maxAttempts?: number } = {},
): Promise<OutboxRow[]> {
  await ensureOutboxTable(db);
  const owner = opts.owner ?? 'outbox-relay';
  const nowMs = Date.parse(now ?? new Date().toISOString());
  const at = new Date(nowMs).toISOString();
  const leaseMs = opts.leaseMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 10;
  const leaseCutoff = new Date(nowMs - leaseMs).toISOString();
  return db.transaction(async () => {
    // Slice in JS so sqlite and postgres share the SQL (no LIMIT placeholder).
    const rows = (await db
      .prepare(
        `SELECT * FROM outbox WHERE next_at <= ?
           AND (status = 'PENDING'
                OR (status = 'FAILED' AND attempts < ?)
                OR (status = 'CLAIMED' AND claimed_at IS NOT NULL AND claimed_at <= ?))
         ORDER BY next_at`,
      )
      .all(at, maxAttempts, leaseCutoff)) as Record<string, unknown>[];
    const out: OutboxRow[] = [];
    for (const r of rows.slice(0, Math.max(0, batch))) {
      // Ownership CAS: see claimInbox — the loser matches zero rows and
      // skips, never double-owns.
      const claimed = await db
        .prepare(
          `UPDATE outbox SET status = 'CLAIMED', attempts = attempts + 1, owner = ?, claimed_at = ?
           WHERE id = ?
             AND (status = 'PENDING'
                  OR (status = 'FAILED' AND attempts < ?)
                  OR (status = 'CLAIMED' AND claimed_at IS NOT NULL AND claimed_at <= ?))`,
        )
        .run(owner, at, String(r['id']), maxAttempts, leaseCutoff);
      if (claimed.changes === 0) continue; // someone else won this row
      out.push({
        id: String(r['id']),
        tenant: String(r['tenant']),
        kind: String(r['kind']),
        payload: JSON.parse(String(r['payload_json'])) as unknown,
        status: 'CLAIMED',
        attempts: Number(r['attempts']) + 1,
        nextAt: String(r['next_at']),
      });
    }
    return out;
  });
}

/**
 * Close claimed rows. DONE is terminal; FAILED stays retryable — pass
 * `retryAt` to delay the next claim (backoff), or nothing to retry ASAP.
 * F10: settlement is owner-checked — a relay whose lease expired and whose
 * row was re-claimed by another relay CANNOT settle it. Pass the owner
 * received from `claimOutbox`; the default matches the default claim owner.
 */
export async function settleOutbox(
  db: AsyncDb,
  ids: string[],
  outcome: 'DONE' | 'FAILED',
  opts: { retryAt?: string; owner?: string } = {},
): Promise<void> {
  await ensureOutboxTable(db);
  const owner = opts.owner ?? 'outbox-relay';
  for (const id of ids) {
    let out: { changes: number };
    if (outcome === 'DONE') {
      out = await db
        .prepare(`UPDATE outbox SET status = 'DONE' WHERE id = ? AND owner = ? AND status = 'CLAIMED'`)
        .run(id, owner);
    } else if (opts.retryAt) {
      out = await db
        .prepare(`UPDATE outbox SET status = 'FAILED', next_at = ? WHERE id = ? AND owner = ? AND status = 'CLAIMED'`)
        .run(opts.retryAt, id, owner);
    } else {
      out = await db
        .prepare(`UPDATE outbox SET status = 'FAILED' WHERE id = ? AND owner = ? AND status = 'CLAIMED'`)
        .run(id, owner);
    }
    if (out.changes === 0) {
      const row = (await db.prepare('SELECT status, owner FROM outbox WHERE id = ?').get(id)) as
        { status: string; owner: string | null } | undefined;
      if (!row) continue; // row vanished: nothing to settle
      if (row.status === 'CLAIMED' && row.owner !== owner) {
        throw new Error(
          `[outbox:NOT_OWNER] row ${id} is claimed by ${row.owner ?? 'someone else'} — settlement refused`,
        );
      }
      // Already DONE/FAILED by a legitimate earlier settlement: idempotent no-op.
    }
  }
}

/**
 * A scheduler occurrence that must survive a restart (cron fired, webhook
 * accepted) is an outbox row of kind 'scheduler-occurrence' — the in-memory
 * registry stays the scheduling state, the outbox is the durable record.
 */
export async function recordSchedulerOccurrence(
  db: AsyncDb,
  tenant: string,
  jobName: string,
  firedAt: string,
  detail: unknown = {},
): Promise<string> {
  return enqueueOutbox(db, tenant, 'scheduler-occurrence', { job: jobName, firedAt, detail }, { now: firedAt });
}

export class Scheduler {
  private crons = new Map<string, CronState>();
  private deliveries: WebhookDelivery[] = [];
  private hits: { source: string; minute: number }[] = [];
  /**
   * Bound on the in-memory delivery list (why a cap at all: full
   * persistence of the scheduler is out of scope, and an unbounded list
   * is a slow memory leak on a long-lived core — the cap drops oldest
   * first and counts them, so loss is visible, never silent).
   */
  private droppedDeliveries = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly webhookSecret: string | null = null,
    private readonly maxWebhooksPerSourcePerMinute = 60,
    private readonly maxDeliveries = 500,
  ) {}

  register(job: CronJob): void {
    if (this.crons.has(job.name)) throw new SchedulerError('DUP_CRON', `cron "${job.name}" already registered`);
    if (job.intervalMs <= 0) throw new SchedulerError('BAD_INTERVAL', 'interval must be positive');
    this.crons.set(job.name, { ...job, lastFire: null, firesByDay: {} });
  }

  unregister(name: string): void {
    this.crons.delete(name);
  }

  /** Fire every due job whose daily cap is unspent. Returns fired names. */
  async tick(): Promise<string[]> {
    const t = this.now();
    const day = dayOf(t);
    const fired: string[] = [];
    for (const job of this.crons.values()) {
      const spent = job.firesByDay[day] ?? 0;
      if (spent >= job.maxFiresPerDay) continue;
      if (job.lastFire !== null && t - job.lastFire < job.intervalMs) continue;
      job.lastFire = t;
      job.firesByDay[day] = spent + 1;
      await job.handler();
      fired.push(job.name);
    }
    return fired;
  }

  /** Inbound webhook: authenticate, rate-limit, record. Delivery effects belong to the handler layer. */
  webhook(source: string, token: string | null, payload: unknown): { accepted: boolean; reason: string } {
    if (this.webhookSecret !== null && token !== this.webhookSecret) {
      return { accepted: false, reason: 'bad webhook secret' };
    }
    const t = this.now();
    const minute = Math.floor(t / 60_000);
    this.hits = this.hits.filter((h) => h.minute === minute);
    const hits = this.hits.filter((h) => h.source === source).length;
    if (hits >= this.maxWebhooksPerSourcePerMinute) {
      return { accepted: false, reason: `rate budget exceeded for ${source}` };
    }
    this.hits.push({ source, minute });
    this.deliveries.push({ source, receivedAt: t, payload });
    // Cap + drop-oldest with an audit note (the counter): deliveries are
    // scheduling state, and durable consumers must read the outbox, not this list.
    while (this.deliveries.length > this.maxDeliveries) {
      this.deliveries.shift();
      this.droppedDeliveries += 1;
    }
    return { accepted: true, reason: 'recorded' };
  }

  /** Capped deliveries dropped so far — the audit note for the cap above. */
  droppedCount(): number {
    return this.droppedDeliveries;
  }

  deliveriesFrom(source: string): WebhookDelivery[] {
    return this.deliveries.filter((d) => d.source === source);
  }
}
