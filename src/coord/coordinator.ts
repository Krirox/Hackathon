import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AsyncDb } from '../core/db.ts';
import { dayOf as sqlDayOf, jsonNumber, jsonText } from '../core/db.ts';
import type { RequestRow } from '../core/rows.ts';
import {
  LATE_COMPLETION_SETTLEMENT,
  MESSAGE_CLASSES,
  TERMINAL_REQUEST_STATES,
  type CoordinationRequest,
  type CostBid,
  type MessageClass,
  type RequestState,
} from '../core/types.ts';

/**
 * F03: the states from which paid work may execute. One set, every executor
 * gates on it — `accept` moves a human-approved request to ACCEPTED so the
 * claim path can pick it up; approval may not strand work in a state no
 * executor reads. ADMITTED (scheduler-approved) is the pre-approval leg.
 */
export const EXECUTABLE_STATES: readonly RequestState[] = ['ADMITTED', 'ACCEPTED', 'IN_FLIGHT'];

/**
 * FLOW-002: the only legal live-state moves. The absent edge is deliberate —
 * a stale approval must not pull running (or approved) work back to ACCEPTED,
 * erasing the human's decision marker or a worker's claim. Every transition
 * outside this map (and the terminal recovery paths above) is refused.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  PROPOSED: ['QUEUED', 'ADMITTED', 'DENIED', 'DEFERRED'],
  QUEUED: ['ADMITTED', 'DENIED', 'DEFERRED', 'EXPIRED'],
  ADMITTED: ['ACCEPTED', 'IN_FLIGHT', 'DECLINED', 'EXPIRED', 'COMPLETED', 'FAILED'],
  ACCEPTED: ['IN_FLIGHT', 'COMPLETED', 'FAILED', 'TERMINATED_BUDGET', 'EXPIRED'],
  IN_FLIGHT: ['COMPLETED', 'FAILED', 'TERMINATED_BUDGET', 'EXPIRED'],
  DEFERRED: ['ADMITTED', 'DENIED', 'EXPIRED'],
  REDIRECTED: [],
  DENIED: [],
  DECLINED: [],
  EXPIRED: [],
  COMPLETED: [],
  FAILED: [],
  TERMINATED_BUDGET: [],
};

/**
 * Coordination layer.
 *
 * THE RULE: a message may never be the thing that carries work.
 * Channels are the *presentation* of coordination. This file is coordination.
 *
 *   QUERY    read-only, token-budgeted, refusable, never interrupts a human
 *   REQUEST  real work: full bid (owner/deadline/cost/stop condition), refusable
 *   NOTICE   informational: no budget, NEVER pings a human, goes to the digest
 *
 * Loop prevention is structural, not policy:
 *   hop limit · cycle detection via chain claim refs · idempotency dedupe ·
 *   right to refuse · budget death · no self-delegation.
 */

/** Latency distribution over recorded human approval decisions (TODO 2.3). */
export interface ApprovalLatencyStats {
  n: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
  /** Which humans are the slow step: sorted slowest-first, median per human. */
  byHuman: { human: string; n: number; medianSeconds: number }[];
  /** Where the slow work queues up: the request's target scope. */
  byScope: { scope: string; n: number; medianSeconds: number }[];
}

export class CoordinationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`[coord:${code}] ${message}`);
  }
}

const bidSchema = z.object({
  dollars: z.number().min(0),
  tokens: z.number().int().min(0),
  humanMinutes: z.number().min(0),
  deadline: z.string().min(1),
  maxRounds: z.number().int().min(1),
  maxHops: z.number().int().min(1).max(3),
  maxDiskBytes: z.number().min(0),
});

const proposalSchema = z
  .object({
    tenant: z.string().min(1),
    messageClass: z.enum(MESSAGE_CLASSES),
    originScope: z.string().min(1),
    targetScope: z.string().min(1),
    goal: z.string().min(1),
    claimRefs: z.array(z.string()),
    deliverableSchema: z.string().min(1),
    bid: bidSchema.partial().optional(),
    onBehalfOf: z.string().min(1),
    stopCondition: z.string().min(1).optional(),
    parentRequestId: z.string().nullable().optional(),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

export type ProposalInput = z.input<typeof proposalSchema>;

/** Defaults are conservative on purpose: an agent asking for 3 hops and $50 is a bug, not a feature. */
const DEFAULT_BID: Omit<CostBid, 'deadline'> = {
  dollars: 0.25,
  tokens: 20_000,
  humanMinutes: 0,
  maxRounds: 3,
  maxHops: 3,
  // 2 GiB: enough for a real clone + build, small enough that a runaway loop
  // cannot fill a tenant's volume. Tighten per scope; agents may never raise it.
  maxDiskBytes: 2 * 1024 * 1024 * 1024,
};

/**
 * An agent may never raise its own quota. A limit the subject can edit is a
 * suggestion, and the whole point of a bid is that it is not self-issued.
 */
export function clampBid(bid: Partial<CostBid>, ceiling: Partial<CostBid> = {}): CostBid {
  const cap = (v: number | undefined, c: number | undefined, fallback: number) => {
    const asked = v ?? fallback;
    return c === undefined ? asked : Math.min(asked, c);
  };
  return {
    dollars: cap(bid.dollars, ceiling.dollars, DEFAULT_BID.dollars),
    tokens: cap(bid.tokens, ceiling.tokens, DEFAULT_BID.tokens),
    humanMinutes: cap(bid.humanMinutes, ceiling.humanMinutes, DEFAULT_BID.humanMinutes),
    maxRounds: cap(bid.maxRounds, ceiling.maxRounds, DEFAULT_BID.maxRounds),
    maxHops: cap(bid.maxHops, ceiling.maxHops, DEFAULT_BID.maxHops),
    maxDiskBytes: cap(bid.maxDiskBytes, ceiling.maxDiskBytes, DEFAULT_BID.maxDiskBytes),
    deadline: bid.deadline ?? '',
  };
}

export const HARD_MAX_HOPS = 3;

export interface AdmissionResult {
  admitted: boolean;
  state: RequestState;
  reason: string;
  request: CoordinationRequest;
  /** Set when this proposal deduped onto an in-flight request. */
  dedupedTo?: string;
}

export interface SchedulerLimits {
  /** Per-scope concurrent admitted work. Stops one loud team starving others. */
  maxConcurrentPerScope: number;
  /** Org-wide inference $/day ceiling. */
  maxDailyDollars: number;
  maxDailyTokens: number;
  /** The anti-notification-overload control: hard cap, enforced structurally. */
  maxHumanEscalationsPerDay: number;
  /**
   * Bid ceiling per request, applied by the scheduler — never by the
   * proposer. An agent may never raise its own quota; anything asked
   * above the ceiling is clamped down to it (the stored bid is the
   * clamped one). DEFAULT_LIMITS sets one — a single request may never
   * out-bid the whole org's daily allowance — and `maxBid: {}` is the
   * explicit opt-out for a caller that really means no ceiling.
   */
  maxBid?: Partial<CostBid>;
}

export const DEFAULT_LIMITS: SchedulerLimits = {
  maxConcurrentPerScope: 6,
  maxDailyDollars: 40,
  maxDailyTokens: 2_000_000,
  maxHumanEscalationsPerDay: 3,
  // A per-request ceiling that exists by default, because "an agent may never
  // raise its own quota" is only true if there is a quota to raise. The bound
  // is the org's own daily allowance: no single request may bid more than the
  // whole company may spend in a day. An operator may set tighter numbers;
  // `maxBid: {}` opts out entirely.
  maxBid: {
    dollars: 40,
    tokens: 2_000_000,
    humanMinutes: 60,
    maxRounds: 10,
    maxHops: HARD_MAX_HOPS,
    maxDiskBytes: 8 * 1024 * 1024 * 1024,
  },
};

function rowToRequest(r: RequestRow): CoordinationRequest {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    messageClass: String(r.message_class) as MessageClass,
    originScope: String(r.origin_scope),
    targetScope: String(r.target_scope),
    goal: String(r.goal),
    claimRefs: JSON.parse(String(r.claim_refs)) as string[],
    deliverableSchema: String(r.deliverable),
    bid: JSON.parse(String(r.bid_json)) as CostBid,
    onBehalfOf: String(r.on_behalf_of),
    hopChain: JSON.parse(String(r.hop_chain)) as string[],
    chainClaimIds: JSON.parse(String(r.chain_claims)) as string[],
    idempotencyKey: String(r.idem_key),
    stopCondition: String(r.stop_condition),
    state: String(r.state) as RequestState,
    // Rows written before diskBytes existed parse without it; default, don't throw.
    spent: {
      diskBytes: 0,
      ...(JSON.parse(String(r.spent_json)) as {
        dollars: number;
        tokens: number;
        humanMinutes: number;
        rounds: number;
        diskBytes?: number;
      }),
    },
    refusalReason: r.refusal_reason == null ? null : String(r.refusal_reason),
    parentRequestId: r.parent_request == null ? null : String(r.parent_request),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    execOwner: r.exec_owner == null ? null : String(r.exec_owner),
    execAttempt: Number(r.exec_attempt ?? 0),
  };
}

export function idempotencyKeyOf(p: {
  originScope: string;
  targetScope: string;
  goal: string;
  deliverableSchema: string;
  claimRefs: string[];
}): string {
  const norm = [
    p.originScope,
    p.targetScope,
    p.goal.trim().toLowerCase(),
    p.deliverableSchema,
    [...p.claimRefs].sort().join('|'),
  ].join('::');
  const h = createHash('sha256').update(norm).digest('hex').slice(0, 24);
  return h;
}

export interface DecomposeStep {
  goal: string;
  deliverableSchema: string;
  targetScope?: string;
  messageClass?: MessageClass;
  bid?: { dollars?: number; tokens?: number; humanMinutes?: number; maxRounds?: number };
  id?: string;
}

export interface Coordinator {
  submit(input: ProposalInput): Promise<AdmissionResult>;
  get(tenant: string, id: string): Promise<CoordinationRequest | null>;
  /**
   * Split an admitted REQUEST into budgeted child steps, each parented on
   * it and grounded in its claims. The children's dollars must fit inside
   * the parent's unspent budget — decomposition never prints money. Hop
   * and cycle rules apply to every leg through the normal submit path.
   */
  decompose(tenant: string, parentId: string, steps: DecomposeStep[], now?: string): Promise<AdmissionResult[]>;
  list(tenant: string, opts?: { scope?: string; state?: RequestState }): Promise<CoordinationRequest[]>;
  accept(tenant: string, id: string): Promise<CoordinationRequest>;
  complete(
    tenant: string,
    id: string,
    outcome: { claims: string[]; cost: Partial<CoordinationRequest['spent']> },
  ): Promise<CoordinationRequest>;
  decline(tenant: string, id: string, reason: string): Promise<CoordinationRequest>;
  redirect(tenant: string, id: string, toScope: string): Promise<AdmissionResult>;
  fail(tenant: string, id: string, reason: string): Promise<CoordinationRequest>;
  charge(tenant: string, id: string, cost: Partial<CoordinationRequest['spent']>): Promise<CoordinationRequest>;
  /**
   * Exclusive execution ownership: atomically claim an ADMITTED request for
   * a worker (compare-and-swap on state). Only the winner runs the paid
   * work; losers get CLAIM_LOST and must not touch the harness.
   */
  claimExecution(
    tenant: string,
    id: string,
    owner: string,
    now: string,
    leaseMs?: number,
  ): Promise<CoordinationRequest>;
  /**
   * F12: renew an active execution lease while work continues.
   * Atomic CAS on (id, tenant, state='IN_FLIGHT', exec_owner=owner);
   * throws LEASE_EXPIRED if the lease was lost or reclaimed.
   */
  renewExecutionLease(
    tenant: string,
    id: string,
    owner: string,
    now: string,
    leaseMs?: number,
  ): Promise<CoordinationRequest>;
  /**
   * Release IN_FLIGHT claims whose lease expired back to ADMITTED so a dead
   * worker's work becomes runnable again. Bounded per call, audited per row.
   */
  reclaimStale(tenant: string, nowMs: number, limit?: number): Promise<string[]>;
  /**
   * F03: move DEFERRED requests back to ADMITTED once their target scope
   * has concurrency headroom. The missing readmission loop — submit parks
   * work in DEFERRED at the cap, and without a sweep it never leaves.
   * Re-checks the live cap per row; bounded per call.
   */
  readmitDeferred(tenant: string, limit?: number): Promise<string[]>;
  /**
   * Continuous usage flow for long-lived executions (jcode turns, Lambda
   * workers): accumulate tokens/dollars WITHOUT consuming a round. charge()
   * counts coordination rounds, so per-event charging through it would
   * self-terminate any run longer than maxRounds tool calls — this path
   * enforces only the token/dollar ceilings and may TERMINATE_BUDGET the
   * request mid-run. Callers must honor a TERMINATED_BUDGET return by
   * stopping work, the same as the in-memory ceiling trip.
   */
  reportUsage(
    tenant: string,
    id: string,
    usage: { tokens?: number; dollars?: number; humanMinutes?: number },
  ): Promise<CoordinationRequest>;
  expireStale(tenant: string, now: string): Promise<string[]>;
  /** Refusal-rate health metric: 0% refusal across all agents means sycophancy. */
  refusalStats(tenant: string): Promise<{ total: number; refused: number; rate: number }>;
  /** Cumulative human interruption events recorded in the immutable escalations log today. */
  dailyEscalations(tenant: string, day: string): Promise<number>;
  /** Concurrent open requests requiring human attention. */
  openEscalations(tenant: string, day?: string): Promise<number>;
  /** Approval latency (TODO 2.3): submission → human decision, one audit row per decision. */
  recordApprovalLatency(
    tenant: string,
    requestId: string,
    action: 'approve' | 'decline',
    human: string,
    decidedAt: string,
  ): Promise<{ seconds: number }>;
  /** Latency distribution over recorded approvals — the curation-cost kill-metric's clock. */
  approvalLatencyStats(tenant: string): Promise<ApprovalLatencyStats>;
  /**
   * FLOW-003: pending work that still cites a claim id (directly or in its chain).
   * Terminal and completed requests are excluded — only work that may need re-review.
   */
  listPendingAffectedByClaim(tenant: string, claimId: string): Promise<CoordinationRequest[]>;
  /**
   * FLOW-003: replace superseded evidence refs with their current replacements.
   * Only ADMITTED/DEFERRED/ACCEPTED requests may refresh — executing or finished
   * work keeps its frozen references.
   */
  refreshEvidence(
    tenant: string,
    requestId: string,
    resolve: (claimId: string) => Promise<string | null>,
    now?: string,
  ): Promise<CoordinationRequest>;
}

export function createCoordinator(db: AsyncDb, limits: SchedulerLimits = DEFAULT_LIMITS): Coordinator {
  const audit = async (actor: string, action: string, target: string, tenant: string, detail?: string) =>
    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, actor, action, target, detail ?? null, new Date().toISOString());

  const persist = async (r: CoordinationRequest) =>
    await db
      .prepare(
        `INSERT INTO requests (
         id, tenant, message_class, origin_scope, target_scope, goal, claim_refs, deliverable,
         bid_json, on_behalf_of, hop_chain, chain_claims, idem_key, stop_condition, state,
         spent_json, refusal_reason, parent_request, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, updated_at = excluded.updated_at,
         refusal_reason = excluded.refusal_reason, spent_json = excluded.spent_json,
         chain_claims = excluded.chain_claims, hop_chain = excluded.hop_chain`,
      )
      .run(
        r.id,
        r.tenant,
        r.messageClass,
        r.originScope,
        r.targetScope,
        r.goal,
        JSON.stringify(r.claimRefs),
        r.deliverableSchema,
        JSON.stringify(r.bid),
        r.onBehalfOf,
        JSON.stringify(r.hopChain),
        JSON.stringify(r.chainClaimIds),
        r.idempotencyKey,
        r.stopCondition,
        r.state,
        JSON.stringify(r.spent),
        r.refusalReason ?? null,
        r.parentRequestId ?? null,
        r.createdAt,
        r.updatedAt,
      );

  const load = async (tenant: string, id: string): Promise<CoordinationRequest | null> => {
    const row = (await db.prepare('SELECT * FROM requests WHERE id = ? AND tenant = ?').get(id, tenant)) as
      RequestRow | undefined;
    return row ? rowToRequest(row) : null;
  };

  const dayOf = (iso: string) => iso.slice(0, 10);

  /**
   * Atomic spent increment: ONE UPDATE computing new values from the row's
   * own values, never read-modify-write. Concurrent charges/reportUsage each
   * apply their delta under the row lock, so no increment is ever lost. Disk
   * stays a high-water mark (max), rounds only move when asked. The native
   * spent_tokens/spent_dollars mirrors move in the SAME statement — one
   * writer, no drift window.
   */
  async function spentAddAtomic(
    tenant: string,
    id: string,
    delta: { dollars: number; tokens: number; humanMinutes: number; rounds: number; diskBytes: number },
    now: string,
  ): Promise<number> {
    const sql =
      db.engine === 'postgres'
        ? `UPDATE requests SET spent_json = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
             COALESCE(spent_json::jsonb,'{}'::jsonb),
             '{dollars}', to_jsonb(COALESCE(((spent_json::jsonb ->> 'dollars'))::float,0) + ?)),
             '{tokens}', to_jsonb(COALESCE(((spent_json::jsonb ->> 'tokens'))::float,0) + ?)),
             '{humanMinutes}', to_jsonb(COALESCE(((spent_json::jsonb ->> 'humanMinutes'))::float,0) + ?)),
             '{rounds}', to_jsonb(COALESCE(((spent_json::jsonb ->> 'rounds'))::float,0) + ?)),
             '{diskBytes}', to_jsonb(GREATEST(COALESCE(((spent_json::jsonb ->> 'diskBytes'))::float,0), ?)))::text,
           spent_tokens = spent_tokens + ?, spent_dollars = spent_dollars + ?,
           updated_at = ? WHERE id = ? AND tenant = ?`
        : `UPDATE requests SET spent_json = json_set(COALESCE(spent_json,'{}'),
             '$.dollars', COALESCE(json_extract(spent_json,'$.dollars'),0) + ?,
             '$.tokens', COALESCE(json_extract(spent_json,'$.tokens'),0) + ?,
             '$.humanMinutes', COALESCE(json_extract(spent_json,'$.humanMinutes'),0) + ?,
             '$.rounds', COALESCE(json_extract(spent_json,'$.rounds'),0) + ?,
             '$.diskBytes', max(COALESCE(json_extract(spent_json,'$.diskBytes'),0), ?)),
           spent_tokens = spent_tokens + ?, spent_dollars = spent_dollars + ?,
           updated_at = ? WHERE id = ? AND tenant = ?`;
    const out = await db
      .prepare(sql)
      .run(
        delta.dollars,
        delta.tokens,
        delta.humanMinutes,
        delta.rounds,
        delta.diskBytes,
        delta.tokens,
        delta.dollars,
        now,
        id,
        tenant,
      );
    return out.changes;
  }

  /**
   * Terminal settlement that never touches spent_json: the atomic increment
   * already recorded the cost, so this only moves state, names the breach,
   * and releases the budget reservation + execution claim.
   */
  async function settleTerminal(
    tenant: string,
    id: string,
    to: RequestState,
    refusalReason: string,
    now: string,
  ): Promise<CoordinationRequest> {
    await db
      .prepare(
        `UPDATE requests SET state = ?, refusal_reason = ?, updated_at = ?,
           reserved_json = '{"dollars":0,"tokens":0}', exec_owner = NULL, claimed_at = NULL
           WHERE id = ? AND tenant = ?`,
      )
      .run(to, refusalReason, now, id, tenant);
    const r = await load(tenant, id);
    if (!r) throw new CoordinationError('NOT_FOUND', `request ${id}`);
    await audit(r.targetScope + ':agent', `REQUEST_${to}`, id, tenant, refusalReason);
    return r;
  }

  async function maybeInflight(tenant: string, id: string, now: string): Promise<void> {
    // Cheap CAS: only live pre-execution states move; a concurrent
    // claim/charge that already moved it makes this a no-op instead of an
    // overwrite. F03: ACCEPTED is included — charging an approved request
    // must not undo the human's decision marker.
    await db
      .prepare(
        `UPDATE requests SET state = 'IN_FLIGHT', updated_at = ?
          WHERE id = ? AND tenant = ? AND state IN ('ADMITTED','ACCEPTED')`,
      )
      .run(now, id, tenant);
  }

  async function submit(input: ProposalInput): Promise<AdmissionResult> {
    const p = proposalSchema.parse(input);
    const now = p.now ?? new Date().toISOString();

    // ---- structural rules that apply to ALL classes -------------------------
    if (p.originScope === p.targetScope) {
      throw new CoordinationError(
        'SELF_DELEGATION',
        `scope ${p.originScope} may not send work to itself; that is how loops start`,
      );
    }
    if (p.messageClass === 'REQUEST' && p.claimRefs.length === 0) {
      throw new CoordinationError(
        'UNGROUNDED_WORK',
        `${p.messageClass} requires at least one claim reference. Work must cite its basis.`,
      );
    }

    const hopChain = [p.originScope];

    // Inherit the parent's hop chain: this is the anti-circular-conversation rule.
    let chain = hopChain;
    let chainClaims: string[] = [...p.claimRefs];
    if (p.parentRequestId) {
      const parent = await load(p.tenant, p.parentRequestId);
      if (parent) {
        chain = [...parent.hopChain, p.originScope];
        chainClaims = [...new Set([...parent.chainClaimIds, ...p.claimRefs])];
        if (chain.includes(p.targetScope)) {
          throw new CoordinationError(
            'CYCLE_DETECTED',
            `${p.targetScope} already appears in this request's hop chain [${chain.join(' → ')}]`,
            { chain },
          );
        }
        // chain holds the ORIGIN scopes traversed so far; the target is the
        // next hop, so the real path length is chain.length + 1.
        if (chain.length > HARD_MAX_HOPS) {
          throw new CoordinationError(
            'HOP_LIMIT',
            `hop limit ${HARD_MAX_HOPS} exceeded [${[...chain, p.targetScope].join(' → ')}]; escalate to a human in the ORIGIN channel`,
            { chain },
          );
        }
        // A request may not re-enter a scope already in its own chain.
        if (chain.includes(p.targetScope)) {
          throw new CoordinationError(
            'CYCLE_DETECTED',
            `${p.targetScope} already appears in this request's hop chain [${chain.join(' → ')}]`,
            { chain },
          );
        }
      }
    }

    // The scheduler clamps the bid against its ceiling: an agent may bid
    // low, never high. limits.maxBid absent means no clamping.
    const bid: CostBid = clampBid(
      {
        ...DEFAULT_BID,
        ...p.bid,
        deadline: p.bid?.deadline ?? new Date(Date.parse(now) + 1000 * 60 * 60 * 24).toISOString(),
      },
      limits.maxBid,
    );
    if (bid.maxHops > HARD_MAX_HOPS) bid.maxHops = HARD_MAX_HOPS;

    const idem = idempotencyKeyOf({ ...p, claimRefs: p.claimRefs });

    return db.transaction(async (): Promise<AdmissionResult> => {
      // ---- idempotency: "already exists, here's the thread" -----------------
      // In-flight: dedupe onto the live thread. Terminal: replay the finished
      // thread instead of crashing on the UNIQUE(tenant, idem_key) constraint
      // — a re-emitted identical NOTICE (cron) or re-clicked REQUEST must
      // return the record, never throw. Callers who need distinct occurrences
      // of the same content put the occurrence (a date, a run id) in the goal.
      const dup = (await db
        .prepare('SELECT * FROM requests WHERE tenant = ? AND idem_key = ? ORDER BY created_at DESC LIMIT 1')
        .get(p.tenant, idem)) as RequestRow | undefined;
      if (dup) {
        const existing = rowToRequest(dup);
        const terminal = TERMINAL_REQUEST_STATES.includes(existing.state);
        await audit(
          `${p.originScope}:agent`,
          terminal ? 'REQUEST_REPLAYED' : 'REQUEST_DEDUPED',
          existing.id,
          p.tenant,
          existing.goal,
        );
        return {
          admitted: false,
          state: existing.state,
          reason: terminal
            ? `identical request already ${existing.state} — replayed ${existing.id}`
            : `deduped onto in-flight request ${existing.id}`,
          request: existing,
          dedupedTo: existing.id,
        };
      }

      const req: CoordinationRequest = {
        id: p.id ?? `req_${crypto.randomUUID()}`,
        tenant: p.tenant,
        messageClass: p.messageClass,
        originScope: p.originScope,
        targetScope: p.targetScope,
        goal: p.goal,
        claimRefs: p.claimRefs,
        deliverableSchema: p.deliverableSchema,
        bid,
        onBehalfOf: p.onBehalfOf,
        hopChain: chain,
        chainClaimIds: chainClaims,
        idempotencyKey: idem,
        stopCondition: p.stopCondition ?? `budget exhausted, deadline ${bid.deadline}, or ${bid.maxRounds} rounds`,
        state: 'PROPOSED',
        spent: { dollars: 0, tokens: 0, humanMinutes: 0, rounds: 0, diskBytes: 0 },
        parentRequestId: p.parentRequestId ?? null,
        createdAt: now,
        updatedAt: now,
      };

      // ---- NOTICE: no budget, no human interrupt, digest only ---------------
      if (p.messageClass === 'NOTICE') {
        req.state = 'COMPLETED';
        await persist(req);
        await audit(`${p.originScope}:agent`, 'NOTICE_TO_DIGEST', req.id, p.tenant, req.goal);
        return {
          admitted: true,
          state: 'COMPLETED',
          reason: 'notice routed to digest; no human interrupt',
          request: req,
        };
      }

      // ---- scheduler admission --------------------------------------------
      // Serialized per tenant-day on a meta lock row: the counts below must
      // observe every concurrent submit's reservation, or two admits racing
      // past the same check print money. The UPDATE takes the row lock on
      // Postgres; on sqlite the surrounding transaction is already exclusive.
      const today = dayOf(now);
      const lockKey = `admitlock:${p.tenant}:${today}`;
      await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(lockKey, '1');
      await db.prepare('UPDATE meta SET value = value WHERE key = ?').run(lockKey);
      const inflight = (
        (await db
          .prepare(
            `SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND target_scope = ?
           AND state IN ('ADMITTED','IN_FLIGHT')`,
          )
          .get(p.tenant, p.targetScope)) as { n: number }
      ).n;

      // Live exposure is the outstanding reservation (the bid held at admit),
      // terminal exposure is what was actually spent: summing both for live
      // rows would double-count every admitted request against the ceiling.
      // The terminal SUM reads the native mirrors, not JSON casts — this
      // query runs per submit, so per-row function calls here are per-submit
      // cost on the whole day's history.
      const spentTerminal = (await db
        .prepare(
          `SELECT COALESCE(SUM(spent_dollars),0) AS d, COALESCE(SUM(spent_tokens),0) AS t
             FROM requests WHERE tenant = ? AND ${sqlDayOf(db.engine, 'created_at')} = ?
               AND state IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
        )
        .get(p.tenant, today, ...TERMINAL_REQUEST_STATES)) as { d: number; t: number };
      const liveReserved = (await db
        .prepare(
          `SELECT COALESCE(SUM(${jsonNumber(db.engine, 'reserved_json', 'dollars')}),0) AS d,
                 COALESCE(SUM(${jsonNumber(db.engine, 'reserved_json', 'tokens')}),0) AS t
            FROM requests WHERE tenant = ? AND ${sqlDayOf(db.engine, 'created_at')} = ?
              AND state NOT IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
        )
        .get(p.tenant, today, ...TERMINAL_REQUEST_STATES)) as { d: number; t: number };

      if (p.messageClass === 'QUERY' && bid.dollars > 1) {
        req.state = 'DENIED';
        await persist(req);
        await audit('scheduler', 'QUERY_DENIED_OVER_BUDGET', req.id, p.tenant, `asked ${bid.dollars}`);
        return {
          admitted: false,
          state: 'DENIED',
          reason: 'QUERY is token-only; a paid QUERY must be a REQUEST',
          request: req,
        };
      }
      if (inflight >= limits.maxConcurrentPerScope) {
        req.state = 'DEFERRED';
        await persist(req);
        await audit('scheduler', 'ADMIT_DEFERRED', req.id, p.tenant, `${p.targetScope} at capacity ${inflight}`);
        return {
          admitted: false,
          state: 'DEFERRED',
          reason: `target ${p.targetScope} at concurrency cap`,
          request: req,
        };
      }
      if (
        spentTerminal.d + liveReserved.d + bid.dollars > limits.maxDailyDollars ||
        spentTerminal.t + liveReserved.t + bid.tokens > limits.maxDailyTokens
      ) {
        req.state = 'DENIED';
        await persist(req);
        await audit(
          'scheduler',
          'ADMIT_DENIED_BUDGET',
          req.id,
          p.tenant,
          `day $${spentTerminal.d + liveReserved.d} + $${bid.dollars} > $${limits.maxDailyDollars}`,
        );
        return { admitted: false, state: 'DENIED', reason: 'daily org budget exhausted', request: req };
      }
      // Delegated parent bounds check (F20): child work must not exceed
      // the parent's unspent budget across dollars, tokens, or attention.
      if (p.parentRequestId) {
        const parent = await load(p.tenant, p.parentRequestId);
        if (parent) {
          if (parent.state !== 'ADMITTED' && parent.state !== 'IN_FLIGHT') {
            req.state = 'DENIED';
            await persist(req);
            await audit('scheduler', 'ADMIT_DENIED_PARENT', req.id, p.tenant, `parent ${parent.id} is ${parent.state}`);
            return {
              admitted: false,
              state: 'DENIED',
              reason: `parent ${parent.id} is ${parent.state} — child work denied`,
              request: req,
            };
          }
          const terminalChildSpend = (await db
            .prepare(
              `SELECT
                 COALESCE(SUM(spent_dollars), 0) AS dollars,
                 COALESCE(SUM(spent_tokens), 0) AS tokens,
                 COALESCE(SUM(${jsonNumber(db.engine, 'spent_json', 'humanMinutes')}), 0) AS humanMinutes
               FROM requests
               WHERE tenant = ? AND parent_request = ?
                 AND state IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
            )
            .get(parent.tenant, parent.id, ...TERMINAL_REQUEST_STATES)) as {
            dollars: number;
            tokens: number;
            humanMinutes: number;
          };

          const liveChildBids = (await db
            .prepare(
              `SELECT
                 COALESCE(SUM(CASE WHEN ${jsonNumber(db.engine, 'reserved_json', 'dollars')} > 0 THEN ${jsonNumber(db.engine, 'reserved_json', 'dollars')} ELSE ${jsonNumber(db.engine, 'bid_json', 'dollars')} END), 0) AS dollars,
                 COALESCE(SUM(CASE WHEN ${jsonNumber(db.engine, 'reserved_json', 'tokens')} > 0 THEN ${jsonNumber(db.engine, 'reserved_json', 'tokens')} ELSE ${jsonNumber(db.engine, 'bid_json', 'tokens')} END), 0) AS tokens,
                 COALESCE(SUM(${jsonNumber(db.engine, 'bid_json', 'humanMinutes')}), 0) AS humanMinutes
               FROM requests
               WHERE tenant = ? AND parent_request = ? AND id != ?
                 AND state NOT IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
            )
            .get(parent.tenant, parent.id, req.id, ...TERMINAL_REQUEST_STATES)) as {
            dollars: number;
            tokens: number;
            humanMinutes: number;
          };

          const remainingDollars =
            parent.bid.dollars -
            parent.spent.dollars -
            (Number(terminalChildSpend.dollars) + Number(liveChildBids.dollars));

          if (bid.dollars > remainingDollars) {
            req.state = 'DENIED';
            await persist(req);
            await audit(
              'scheduler',
              'ADMIT_DENIED_PARENT_BUDGET',
              req.id,
              p.tenant,
              `child bid $${bid.dollars} exceeds parent ${parent.id} remaining $${remainingDollars.toFixed(3)}`,
            );
            return {
              admitted: false,
              state: 'DENIED',
              reason: `child bid exceeds parent ${parent.id} unspent budget`,
              request: req,
            };
          }
        }
      }

      // The escalation cap BLOCKS: a request that needs human minutes is
      // denied when today's cumulative attention budget is spent. Approval that arrives
      // after the cap is theater, not oversight.
      if (bid.humanMinutes > 0 && (await dailyEscalations(p.tenant, today)) >= limits.maxHumanEscalationsPerDay) {
        req.state = 'DENIED';
        await persist(req);
        await audit(
          'scheduler',
          'ADMIT_DENIED_ESCALATIONS',
          req.id,
          p.tenant,
          `${p.targetScope} cap ${limits.maxHumanEscalationsPerDay}/day reached`,
        );
        return {
          admitted: false,
          state: 'DENIED',
          reason: `human escalation cap (${limits.maxHumanEscalationsPerDay}/day) reached — no further human interrupts today`,
          request: req,
        };
      }

      req.state = 'ADMITTED';
      await persist(req);
      // Hold the bid as the request's reservation: later admits account it
      // until a terminal state releases it. Same transaction as the counts
      // above, so the hold is never visible without the check — and the
      // reservation never exists without the row.
      await db
        .prepare('UPDATE requests SET reserved_json = ? WHERE id = ? AND tenant = ?')
        .run(JSON.stringify({ dollars: bid.dollars, tokens: bid.tokens }), req.id, p.tenant);
      if (bid.humanMinutes > 0) {
        // Named-human audit trail: who was interrupted, for what, when.
        await db
          .prepare(
            'INSERT INTO escalations (id, tenant, scope, request_id, human, day, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
          )
          .run(`esc_${req.id}`, p.tenant, p.targetScope, req.id, p.onBehalfOf, today, now);
      }
      await audit(`${p.originScope}:agent`, 'REQUEST_ADMITTED', req.id, p.tenant, `→ ${p.targetScope}: ${req.goal}`);
      return { admitted: true, state: 'ADMITTED', reason: 'admitted within budget and capacity', request: req };
    });
  }

  async function transition(
    tenant: string,
    id: string,
    to: RequestState,
    fields: Partial<CoordinationRequest> = {},
  ): Promise<CoordinationRequest> {
    return db.transaction(async () => {
      const r = await load(tenant, id);
      if (!r) throw new CoordinationError('NOT_FOUND', `request ${id}`);
      if (TERMINAL_REQUEST_STATES.includes(r.state)) {
        // F03: terminal states are history, not a scratch pad. Three legal
        // rewrites, exactly:
        //   1. late COMPLETION over a refusal/expiry (the map): refusal
        //      stands, row settles FAILED with the worker's objection
        //      preserved behind `REFUSAL|`;
        //   2. redelivery recovery FAILED→COMPLETED — but NOT when this
        //      FAILED row is itself a preserved refusal (`REFUSAL|`): a
        //      refusal is never resurrected;
        //   3. same-state re-settlement: idempotent crash recovery, no
        //      second history.
        // Everything else refuses (TERMINAL).
        const refusalPreserved = (r.refusalReason ?? '').startsWith('REFUSAL|');
        const late = LATE_COMPLETION_SETTLEMENT.get(r.state);
        if (to === 'COMPLETED' && r.state === 'FAILED') {
          // Redelivery recovery: a genuinely failed run completed on retry.
          // A preserved refusal is never resurrected.
          if (refusalPreserved) {
            throw new CoordinationError('TERMINAL', `request ${id} was refused — refusal is not recoverable`);
          }
          await db
            .prepare('UPDATE requests SET state = ?, refusal_reason = ?, updated_at = ? WHERE id = ? AND tenant = ?')
            .run('COMPLETED', r.refusalReason ?? null, new Date().toISOString(), id, tenant);
          const recovered = (await load(tenant, id))!;
          await audit(
            'scheduler',
            'REQUEST_FAILED_TO_COMPLETED',
            id,
            tenant,
            'redelivery recovery: the retried work completed',
          );
          return recovered;
        } else if (to === 'COMPLETED' && late) {
          // Late completion over a refusal/expiry/budget-death: the settled
          // outcome stands, the row settles FAILED with the worker's
          // objection preserved behind `REFUSAL|`.
          await db
            .prepare('UPDATE requests SET state = ?, refusal_reason = ?, updated_at = ? WHERE id = ? AND tenant = ?')
            .run(
              late,
              `REFUSAL|${fields.refusalReason ?? `worker completion contradicts settled ${r.state}`}`,
              new Date().toISOString(),
              id,
              tenant,
            );
          const settled = (await load(tenant, id))!;
          await audit('scheduler', `REQUEST_${r.state}_TO_${late}`, id, tenant, settled.refusalReason ?? undefined);
          return settled;
        }
        if (to !== r.state) {
          throw new CoordinationError('TERMINAL', `request ${id} already ${r.state}`);
        }
        // Same-state re-settlement: no-op recovery, return the settled row.
        return (await load(tenant, id))!;
      }
      if (!ALLOWED_TRANSITIONS[r.state].includes(to)) {
        throw new CoordinationError(
          'INVALID_TRANSITION',
          `${r.state} → ${to} is not an allowed transition for request ${id}`,
          { from: r.state, to },
        );
      }
      const next: CoordinationRequest = { ...r, ...fields, state: to, updatedAt: new Date().toISOString() };
      await persist(next);
      if ((TERMINAL_REQUEST_STATES as readonly string[]).includes(to)) {
        // Reconcile the hold: a finished request's bid must stop counting
        // against the daily ceiling, and its execution claim must not pin
        // the row IN_FLIGHT forever. persist() never touches these columns,
        // so this is additive, same transaction.
        await db
          .prepare(
            `UPDATE requests SET reserved_json = '{"dollars":0,"tokens":0}', exec_owner = NULL, claimed_at = NULL
              WHERE id = ? AND tenant = ?`,
          )
          .run(id, tenant);
      }
      await audit(next.targetScope + ':agent', `REQUEST_${to}`, id, tenant, next.refusalReason ?? undefined);
      return (await load(tenant, id)) ?? next;
    });
  }

  async function charge(
    tenant: string,
    id: string,
    cost: Partial<CoordinationRequest['spent']>,
  ): Promise<CoordinationRequest> {
    const now = new Date().toISOString();
    const changed = await spentAddAtomic(
      tenant,
      id,
      {
        dollars: cost.dollars ?? 0,
        tokens: cost.tokens ?? 0,
        humanMinutes: cost.humanMinutes ?? 0,
        rounds: 1,
        diskBytes: cost.diskBytes ?? 0,
      },
      now,
    );
    if (changed === 0) throw new CoordinationError('NOT_FOUND', `request ${id}`);
    const r = (await load(tenant, id))!;
    const spent = r.spent;
    // Budget death: terminate loudly, log a partial result. Never continue silently.
    const breached: string[] = [];
    if (spent.dollars > r.bid.dollars) breached.push(`$${spent.dollars.toFixed(3)}/${r.bid.dollars}`);
    if (spent.tokens > r.bid.tokens) breached.push(`${spent.tokens}/${r.bid.tokens} tokens`);
    if (spent.rounds > r.bid.maxRounds) breached.push(`${spent.rounds}/${r.bid.maxRounds} rounds`);
    if (r.bid.humanMinutes > 0 && spent.humanMinutes > r.bid.humanMinutes) {
      breached.push(`${spent.humanMinutes}/${r.bid.humanMinutes} human minutes`);
    }
    if (r.bid.maxDiskBytes > 0 && spent.diskBytes > r.bid.maxDiskBytes) {
      breached.push(
        `${(spent.diskBytes / 1024 / 1024).toFixed(1)}/${(r.bid.maxDiskBytes / 1024 / 1024).toFixed(0)} MiB disk`,
      );
    }
    if (breached.length) {
      return settleTerminal(tenant, id, 'TERMINATED_BUDGET', `budget exhausted (${breached.join(', ')})`, now);
    }
    await maybeInflight(tenant, id, now);
    return (await load(tenant, id))!;
  }

  async function reportUsage(
    tenant: string,
    id: string,
    usage: { tokens?: number; dollars?: number; humanMinutes?: number },
  ): Promise<CoordinationRequest> {
    const now = new Date().toISOString();
    const changed = await spentAddAtomic(
      tenant,
      id,
      {
        dollars: usage.dollars ?? 0,
        tokens: usage.tokens ?? 0,
        humanMinutes: usage.humanMinutes ?? 0,
        rounds: 0,
        diskBytes: 0,
      },
      now,
    );
    if (changed === 0) throw new CoordinationError('NOT_FOUND', `request ${id}`);
    const r = (await load(tenant, id))!;
    const spent = r.spent;
    // Rounds deliberately untouched (see interface note): a token flow is
    // continuous activity, not coordination rounds.
    const breached: string[] = [];
    if (spent.dollars > r.bid.dollars) breached.push(`$${spent.dollars.toFixed(3)}/${r.bid.dollars}`);
    if (spent.tokens > r.bid.tokens) breached.push(`${spent.tokens}/${r.bid.tokens} tokens`);
    if (r.bid.humanMinutes > 0 && spent.humanMinutes > r.bid.humanMinutes) {
      breached.push(`${spent.humanMinutes}/${r.bid.humanMinutes} human minutes`);
    }
    if (breached.length) {
      return settleTerminal(tenant, id, 'TERMINATED_BUDGET', `budget exhausted mid-run (${breached.join(', ')})`, now);
    }
    await maybeInflight(tenant, id, now);
    return (await load(tenant, id))!;
  }

  /**
   * Exclusive execution claim (F02): a single UPDATE that moves ADMITTED to
   * IN_FLIGHT only when the row is still ADMITTED. The winner records owner,
   * attempt, and lease; every loser sees zero changed rows and gets
   * CLAIM_LOST without ever touching the harness.
   */
  async function claimExecution(
    tenant: string,
    id: string,
    owner: string,
    now: string,
    leaseMs = 60_000,
  ): Promise<CoordinationRequest> {
    // F03: the CAS covers the full executable set — a human-approved
    // (ACCEPTED) request is claimable, not just scheduler-admitted work.
    const out = await db
      .prepare(
        `UPDATE requests SET state = 'IN_FLIGHT', exec_owner = ?, exec_attempt = exec_attempt + 1,
           claimed_at = ?, lease_ms = ?, updated_at = ?
           WHERE id = ? AND tenant = ? AND state IN ('ADMITTED','ACCEPTED')`,
      )
      .run(owner, now, leaseMs, now, id, tenant);
    if (out.changes === 0) {
      const r = await load(tenant, id);
      if (!r) throw new CoordinationError('NOT_FOUND', `request ${id}`);
      throw new CoordinationError('CLAIM_LOST', `request ${id} is ${r.state} — another worker holds the claim`, {
        state: r.state,
      });
    }
    const claimed = (await load(tenant, id))!;
    await audit(owner, 'EXECUTION_CLAIMED', id, tenant, `lease ${leaseMs}ms`);
    return claimed;
  }

  async function renewExecutionLease(
    tenant: string,
    id: string,
    owner: string,
    now: string,
    leaseMs = 60_000,
  ): Promise<CoordinationRequest> {
    const out = await db
      .prepare(
        `UPDATE requests SET claimed_at = ?, lease_ms = ?, updated_at = ?
           WHERE id = ? AND tenant = ? AND state = 'IN_FLIGHT' AND exec_owner = ?`,
      )
      .run(now, leaseMs, now, id, tenant, owner);
    if (out.changes === 0) {
      const r = await load(tenant, id);
      if (!r) throw new CoordinationError('NOT_FOUND', `request ${id}`);
      throw new CoordinationError(
        'LEASE_EXPIRED',
        `request ${id} is no longer owned by ${owner} (current state: ${r.state}, owner: ${r.execOwner}) — cannot renew lease`,
      );
    }
    return (await load(tenant, id))!;
  }

  /**
   * Lease expiry (F02): IN_FLIGHT rows whose claimed_at + lease_ms passed are
   * released back to ADMITTED. Selection happens in JS (portable date math),
   * release is a CAS on (state, claimed_at) so a freshly re-claimed lease is
   * never stolen. Bounded per call, one audit row per release.
   */
  async function reclaimStale(tenant: string, nowMs: number, limit = 100): Promise<string[]> {
    const rows = (await db
      .prepare(
        `SELECT id, claimed_at, lease_ms FROM requests
          WHERE tenant = ? AND state = 'IN_FLIGHT' AND claimed_at IS NOT NULL LIMIT ?`,
      )
      .all(tenant, limit)) as { id: string; claimed_at: string; lease_ms: number }[];
    const released: string[] = [];
    for (const row of rows) {
      const at = Date.parse(String(row.claimed_at));
      if (!Number.isFinite(at) || at + Number(row.lease_ms) > nowMs) continue;
      const now = new Date(nowMs).toISOString();
      const out = await db
        .prepare(
          `UPDATE requests SET state = 'ADMITTED', exec_owner = NULL, claimed_at = NULL, updated_at = ?
            WHERE id = ? AND tenant = ? AND state = 'IN_FLIGHT' AND claimed_at = ?`,
        )
        .run(now, String(row.id), tenant, String(row.claimed_at));
      if (out.changes === 0) continue;
      await audit('scheduler', 'EXECUTION_RECLAIMED', String(row.id), tenant, 'lease expired — back to ADMITTED');
      released.push(String(row.id));
    }
    return released;
  }

  async function decompose(
    tenant: string,
    parentId: string,
    steps: DecomposeStep[],
    now?: string,
  ): Promise<AdmissionResult[]> {
    return db.transaction(async () => {
      const parent = await load(tenant, parentId);
      if (!parent) throw new CoordinationError('NOT_FOUND', `request ${parentId}`);
      if (parent.state !== 'ADMITTED' && parent.state !== 'IN_FLIGHT') {
        throw new CoordinationError('BAD_PARENT', `request ${parentId} is ${parent.state} — only live work decomposes`);
      }
      if (steps.length === 0)
        throw new CoordinationError('EMPTY_DECOMPOSE', 'decomposing into zero steps splits nothing');
      const at = now ?? new Date().toISOString();

      // Account for full completed-child spend and nonterminal child reservations (F20)
      const terminalChildSpend = (await db
        .prepare(
          `SELECT
             COALESCE(SUM(spent_dollars), 0) AS dollars,
             COALESCE(SUM(spent_tokens), 0) AS tokens,
             COALESCE(SUM(${jsonNumber(db.engine, 'spent_json', 'humanMinutes')}), 0) AS humanMinutes
           FROM requests
           WHERE tenant = ? AND parent_request = ?
             AND state IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
        )
        .get(parent.tenant, parent.id, ...TERMINAL_REQUEST_STATES)) as {
        dollars: number;
        tokens: number;
        humanMinutes: number;
      };

      const liveChildBids = (await db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN ${jsonNumber(db.engine, 'reserved_json', 'dollars')} > 0 THEN ${jsonNumber(db.engine, 'reserved_json', 'dollars')} ELSE ${jsonNumber(db.engine, 'bid_json', 'dollars')} END), 0) AS dollars,
             COALESCE(SUM(CASE WHEN ${jsonNumber(db.engine, 'reserved_json', 'tokens')} > 0 THEN ${jsonNumber(db.engine, 'reserved_json', 'tokens')} ELSE ${jsonNumber(db.engine, 'bid_json', 'tokens')} END), 0) AS tokens,
             COALESCE(SUM(${jsonNumber(db.engine, 'bid_json', 'humanMinutes')}), 0) AS humanMinutes
           FROM requests
           WHERE tenant = ? AND parent_request = ?
             AND state NOT IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
        )
        .get(parent.tenant, parent.id, ...TERMINAL_REQUEST_STATES)) as {
        dollars: number;
        tokens: number;
        humanMinutes: number;
      };

      const totalChildDollars = Number(terminalChildSpend.dollars) + Number(liveChildBids.dollars);
      const totalChildTokens = Number(terminalChildSpend.tokens) + Number(liveChildBids.tokens);
      const totalChildHumanMinutes = Number(terminalChildSpend.humanMinutes) + Number(liveChildBids.humanMinutes);

      const remainingDollars = parent.bid.dollars - parent.spent.dollars - totalChildDollars;
      const remainingTokens = parent.bid.tokens - parent.spent.tokens - totalChildTokens;
      const remainingHumanMinutes = parent.bid.humanMinutes - parent.spent.humanMinutes - totalChildHumanMinutes;

      // Omitted child bids are fully resolved against DEFAULT_BID and clamped (F20)
      const stepDollars = steps.map((st) =>
        st.bid?.dollars !== undefined
          ? Math.min(st.bid.dollars, limits.maxBid?.dollars ?? st.bid.dollars)
          : DEFAULT_BID.dollars,
      );
      const totalStepDollars = stepDollars.reduce((acc, d) => acc + d, 0);

      if (totalStepDollars > remainingDollars) {
        throw new CoordinationError(
          'BUDGET_SPLIT',
          `children bid $${totalStepDollars.toFixed(3)} against $${remainingDollars.toFixed(3)} unspent on ${parentId} — decomposition never prints money`,
        );
      }

      const stepTokensExplicit = steps.some((st) => st.bid?.tokens !== undefined);
      if (stepTokensExplicit) {
        const stepTokens = steps.map((st) => st.bid?.tokens ?? DEFAULT_BID.tokens);
        const totalStepTokens = stepTokens.reduce((acc, t) => acc + t, 0);
        if (totalStepTokens > remainingTokens) {
          throw new CoordinationError(
            'BUDGET_SPLIT',
            `children bid ${totalStepTokens} tokens against ${remainingTokens} unspent tokens on ${parentId} — decomposition never prints tokens`,
          );
        }
      }

      const stepHumanMinutesExplicit = steps.some((st) => (st.bid?.humanMinutes ?? 0) > 0);
      if (stepHumanMinutesExplicit && parent.bid.humanMinutes > 0) {
        const stepHumanMinutes = steps.map((st) => st.bid?.humanMinutes ?? 0);
        const totalStepHumanMinutes = stepHumanMinutes.reduce((acc, h) => acc + h, 0);
        if (totalStepHumanMinutes > remainingHumanMinutes) {
          throw new CoordinationError(
            'BUDGET_SPLIT',
            `children bid ${totalStepHumanMinutes} human minutes against ${remainingHumanMinutes} unspent human minutes on ${parentId} — attention budget exhausted`,
          );
        }
      }

      const out: AdmissionResult[] = [];
      for (const st of steps) {
        out.push(
          await submit({
            tenant,
            messageClass: st.messageClass ?? 'REQUEST',
            originScope: parent.originScope,
            targetScope: st.targetScope ?? parent.targetScope,
            goal: st.goal,
            claimRefs: parent.chainClaimIds.length > 0 ? parent.chainClaimIds : parent.claimRefs,
            deliverableSchema: st.deliverableSchema,
            bid: st.bid,
            onBehalfOf: parent.onBehalfOf,
            parentRequestId: parent.id,
            id: st.id,
            now: at,
          }),
        );
      }
      return out;
    });
  }

  async function dailyEscalations(tenant: string, day: string): Promise<number> {
    return (
      (await db.prepare('SELECT COUNT(*) AS n FROM escalations WHERE tenant = ? AND day = ?').get(tenant, day)) as {
        n: number;
      }
    ).n;
  }

  async function openEscalations(tenant: string, day?: string): Promise<number> {
    const dayClause = day ? `AND ${sqlDayOf(db.engine, 'updated_at')} = ?` : '';
    const params = day ? [tenant, day] : [tenant];
    return (
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM requests
           WHERE tenant = ? ${dayClause} AND ${jsonNumber(db.engine, 'bid_json', 'humanMinutes')} > 0
             AND state IN ('ADMITTED','IN_FLIGHT','DEFERRED')`,
        )
        .get(...params)) as { n: number }
    ).n;
  }

  async function recordApprovalLatency(
    tenant: string,
    requestId: string,
    action: 'approve' | 'decline',
    human: string,
    decidedAt: string,
  ): Promise<{ seconds: number }> {
    const r = await load(tenant, requestId);
    if (!r) throw new CoordinationError('UNKNOWN_REQUEST', `unknown request ${requestId}`, { requestId });
    const ms = Date.parse(decidedAt) - Date.parse(r.createdAt);
    if (Number.isNaN(ms)) {
      throw new CoordinationError('BAD_TIMESTAMP', `decidedAt ${decidedAt} does not parse`, { decidedAt });
    }
    // Clamp negatives: clocks drift, tests freeze time; a −40ms round-trip is
    // still a 0-second approval, not a thrown-away measurement.
    const seconds = Math.max(0, ms / 1000);
    await audit('console:' + human, 'APPROVAL_LATENCY', requestId, tenant, JSON.stringify({ action, seconds, human }));
    return { seconds };
  }

  async function approvalLatencyStats(tenant: string): Promise<ApprovalLatencyStats> {
    // detail carries {action, seconds, human}; joining requests gives the
    // target scope — who is the slow step, and where the work queues up.
    const rows = (
      (await db
        .prepare(
          `SELECT a.target AS request_id, a.detail, r.target_scope
           FROM audit_log a
           LEFT JOIN requests r ON r.tenant = a.tenant AND r.id = a.target
           WHERE a.tenant = ? AND a.action = 'APPROVAL_LATENCY'
           ORDER BY a.at`,
        )
        .all(tenant)) as { request_id: string; detail: string | null; target_scope: string | null }[]
    ).map((r) => {
      try {
        const d = JSON.parse(String(r.detail ?? '{}')) as { seconds?: number; human?: string };
        return { seconds: d.seconds, human: d.human, scope: r.target_scope };
      } catch {
        return { seconds: undefined, human: undefined, scope: r.target_scope };
      }
    });
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    };
    const seconds = rows.map((r) => r.seconds).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
    const overall = median(seconds);
    const groupBy = (keyOf: (r: { seconds?: number; human?: string; scope: string | null }) => string | undefined) => {
      const m = new Map<string, number[]>();
      for (const r of rows) {
        const k = keyOf(r);
        if (typeof k !== 'string' || k === '' || typeof r.seconds !== 'number') continue;
        const list = m.get(k) ?? [];
        list.push(r.seconds);
        m.set(k, list);
      }
      return [...m.entries()]
        .map(([k, xs]) => ({ key: k, n: xs.length, medianSeconds: median(xs)! }))
        .sort((a, b) => b.medianSeconds - a.medianSeconds);
    };
    const p90 =
      seconds.length === 0
        ? null
        : (() => {
            // Percentiles rank over sorted values — `seconds` arrives in
            // audit-`at` order, which is insertion order, not rank order.
            const s = [...seconds].sort((a, b) => a - b);
            return Math.min(s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]!, s[s.length - 1]!);
          })();
    return {
      n: seconds.length,
      medianSeconds: overall,
      p90Seconds: p90,
      maxSeconds: seconds.length === 0 ? null : Math.max(...seconds),
      byHuman: groupBy((r) => r.human).map(({ key, n, medianSeconds }) => ({ human: key, n, medianSeconds })),
      byScope: groupBy((r) => r.scope ?? undefined).map(({ key, n, medianSeconds }) => ({
        scope: key,
        n,
        medianSeconds,
      })),
    };
  }

  async function refusalStats(tenant: string) {
    const total = (
      (await db
        .prepare("SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND message_class = 'REQUEST'")
        .get(tenant)) as {
        n: number;
      }
    ).n;
    const refused = (
      (await db
        .prepare(
          "SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND state IN ('DECLINED','TERMINATED_BUDGET','EXPIRED')",
        )
        .get(tenant)) as { n: number }
    ).n;
    return { total, refused, rate: total === 0 ? 0 : refused / total };
  }

  /**
   * F03: readmit DEFERRED work. Submit parks a request in DEFERRED when its
   * target scope is at the concurrency cap; without this sweep deferred work
   * waits forever — the audit's "deferred work can remain indefinitely
   * queued". Re-admission re-checks the live cap (a deferred request must
   * not leapfrog freshly admitted work) and uses the same CAS shape as
   * reclaimStale: DEFERRED→ADMITTED only while the row is still DEFERRED.
   * Not atomic across concurrent sweeps, but the CAS loser simply re-checks
   * on the next sweep; no work is lost or duplicated. Bounded like
   * expireStale so a huge backlog terminates.
   */
  async function readmitDeferred(tenant: string, limit = 100): Promise<string[]> {
    const rows = (await db
      .prepare("SELECT id, target_scope FROM requests WHERE tenant = ? AND state = 'DEFERRED' LIMIT ?")
      .all(tenant, limit)) as { id: string; target_scope: string }[];
    const readmitted: string[] = [];
    for (const row of rows) {
      const inflight = (
        (await db
          .prepare(
            "SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND target_scope = ? AND state IN ('ADMITTED','IN_FLIGHT')",
          )
          .get(tenant, String(row.target_scope))) as { n: number }
      ).n;
      if (inflight >= limits.maxConcurrentPerScope) continue;
      const out = await db
        .prepare(
          "UPDATE requests SET state = 'ADMITTED', updated_at = ? WHERE id = ? AND tenant = ? AND state = 'DEFERRED'",
        )
        .run(new Date().toISOString(), String(row.id), tenant);
      if (out.changes === 0) continue;
      await audit(
        'scheduler',
        'REQUEST_READMITTED',
        String(row.id),
        tenant,
        'deferred work re-checked against the live cap',
      );
      readmitted.push(String(row.id));
    }
    return readmitted;
  }

  async function expireStale(tenant: string, now: string): Promise<string[]> {
    // Chunked: the candidate set is unbounded (a tenant that never sweeps),
    // and each expiry is its own transition + audit row. Cap rounds so a
    // pathological backlog terminates instead of sweeping forever.
    const BATCH = 500;
    const MAX_ROUNDS = 1000;
    const expired: string[] = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = (await db
        .prepare(
          `SELECT id FROM requests WHERE tenant = ? AND state IN ('ADMITTED','IN_FLIGHT','DEFERRED')
           AND ${jsonText(db.engine, 'bid_json', 'deadline')} <= ? LIMIT ${BATCH}`,
        )
        .all(tenant, now)) as { id: string }[];
      if (rows.length === 0) break;
      for (const r of rows) await transition(tenant, String(r.id), 'EXPIRED', { refusalReason: 'deadline passed' });
      expired.push(...rows.map((r) => String(r.id)));
      if (rows.length < BATCH) break;
    }
    return expired;
  }

  const PENDING_EVIDENCE_STATES: readonly RequestState[] = ['ADMITTED', 'DEFERRED', 'ACCEPTED'];

  async function listPendingAffectedByClaim(tenant: string, claimId: string): Promise<CoordinationRequest[]> {
    const rows = (await db
      .prepare(
        `SELECT * FROM requests WHERE tenant = ? AND state IN (${PENDING_EVIDENCE_STATES.map(() => '?').join(',')})`,
      )
      .all(tenant, ...PENDING_EVIDENCE_STATES)) as RequestRow[];
    return rows
      .filter((r) => {
        const refs = JSON.parse(String(r.claim_refs)) as string[];
        const chain = JSON.parse(String(r.chain_claims)) as string[];
        return refs.includes(claimId) || chain.includes(claimId);
      })
      .map((r) => rowToRequest(r));
  }

  async function refreshEvidence(
    tenant: string,
    requestId: string,
    resolve: (claimId: string) => Promise<string | null>,
    now?: string,
  ): Promise<CoordinationRequest> {
    const r = await load(tenant, requestId);
    if (!r) throw new CoordinationError('NOT_FOUND', `request ${requestId}`);
    if (!PENDING_EVIDENCE_STATES.includes(r.state)) {
      throw new CoordinationError(
        'NOT_REFRESHABLE',
        `request ${requestId} is ${r.state} — only pending review/work may refresh evidence`,
        { state: r.state },
      );
    }
    const at = now ?? new Date().toISOString();
    const remap = async (ids: string[]) => {
      const out: string[] = [];
      for (const cid of ids) {
        const cur = await resolve(cid);
        out.push(cur ?? cid);
      }
      return [...new Set(out)];
    };
    const claimRefs = await remap(r.claimRefs);
    const chainClaimIds = await remap(r.chainClaimIds);
    const changed =
      claimRefs.length !== r.claimRefs.length ||
      chainClaimIds.length !== r.chainClaimIds.length ||
      claimRefs.some((id, i) => id !== r.claimRefs[i]) ||
      chainClaimIds.some((id, i) => id !== r.chainClaimIds[i]);
    if (!changed) return r;
    await db
      .prepare('UPDATE requests SET claim_refs = ?, chain_claims = ?, updated_at = ? WHERE id = ? AND tenant = ?')
      .run(JSON.stringify(claimRefs), JSON.stringify(chainClaimIds), at, requestId, tenant);
    await audit(
      'console',
      'EVIDENCE_REFRESHED',
      requestId,
      tenant,
      JSON.stringify({ from: r.claimRefs, to: claimRefs }),
    );
    const next = (await load(tenant, requestId))!;
    return next;
  }

  return {
    submit,
    get: load,
    async list(tenant, opts = {}) {
      const where = ['tenant = ?'];
      const args: unknown[] = [tenant];
      if (opts.scope) {
        where.push('(origin_scope = ? OR target_scope = ?)');
        args.push(opts.scope, opts.scope);
      }
      if (opts.state) {
        where.push('state = ?');
        args.push(opts.state);
      }
      return (
        await db.prepare(`SELECT * FROM requests WHERE ${where.join(' AND ')} ORDER BY created_at`).all(...args)
      ).map((r) => rowToRequest(r as RequestRow));
    },
    accept: (t, id) => transition(t, id, 'ACCEPTED'),
    complete: async (t, id, o) => {
      const r = await load(t, id);
      return transition(t, id, 'COMPLETED', { chainClaimIds: [...r!.chainClaimIds, ...o.claims] });
    },
    decline: (t, id, reason) => transition(t, id, 'DECLINED', { refusalReason: reason }),
    fail: (t, id, reason) => transition(t, id, 'FAILED', { refusalReason: reason }),
    redirect: async (t, id, toScope) => {
      const r = (await load(t, id))!;
      await transition(t, id, 'REDIRECTED', { refusalReason: `redirected → ${toScope}` });
      return submit({
        tenant: t,
        messageClass: r.messageClass,
        originScope: r.originScope,
        targetScope: toScope,
        goal: r.goal,
        claimRefs: r.claimRefs,
        deliverableSchema: r.deliverableSchema,
        bid: r.bid,
        onBehalfOf: r.onBehalfOf,
        stopCondition: r.stopCondition,
        parentRequestId: r.id,
      });
    },
    charge,
    reportUsage,
    claimExecution,
    renewExecutionLease,
    reclaimStale,
    readmitDeferred,
    decompose,
    expireStale,
    refusalStats,
    dailyEscalations,
    openEscalations,
    recordApprovalLatency,
    approvalLatencyStats,
    listPendingAffectedByClaim,
    refreshEvidence,
  };
}
