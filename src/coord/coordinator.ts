import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AsyncDb } from '../core/db.ts';
import { dayOf as sqlDayOf, jsonNumber, jsonText } from '../core/db.ts';
import {
  MESSAGE_CLASSES,
  TERMINAL_REQUEST_STATES,
  type CoordinationRequest,
  type CostBid,
  type MessageClass,
  type RequestState,
} from '../core/types.ts';

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

function rowToRequest(r: Record<string, unknown>): CoordinationRequest {
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
  expireStale(tenant: string, now: string): Promise<string[]>;
  /** Refusal-rate health metric: 0% refusal across all agents means sycophancy. */
  refusalStats(tenant: string): Promise<{ total: number; refused: number; rate: number }>;
  openEscalations(tenant: string, day: string): Promise<number>;
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
      Record<string, unknown> | undefined;
    return row ? rowToRequest(row) : null;
  };

  const dayOf = (iso: string) => iso.slice(0, 10);

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
        .get(p.tenant, idem)) as Record<string, unknown> | undefined;
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
      const today = dayOf(now);
      const inflight = (
        (await db
          .prepare(
            `SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND target_scope = ?
           AND state IN ('ADMITTED','IN_FLIGHT')`,
          )
          .get(p.tenant, p.targetScope)) as { n: number }
      ).n;

      const spentToday = (await db
        .prepare(
          `SELECT COALESCE(SUM(${jsonNumber(db.engine, 'spent_json', 'dollars')}),0) AS d,
                COALESCE(SUM(${jsonNumber(db.engine, 'spent_json', 'tokens')}),0) AS t
           FROM requests WHERE tenant = ? AND ${sqlDayOf(db.engine, 'created_at')} = ?`,
        )
        .get(p.tenant, today)) as { d: number; t: number };

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
      if (spentToday.d + bid.dollars > limits.maxDailyDollars || spentToday.t + bid.tokens > limits.maxDailyTokens) {
        req.state = 'DENIED';
        await persist(req);
        await audit(
          'scheduler',
          'ADMIT_DENIED_BUDGET',
          req.id,
          p.tenant,
          `day $${spentToday.d} + $${bid.dollars} > $${limits.maxDailyDollars}`,
        );
        return { admitted: false, state: 'DENIED', reason: 'daily org budget exhausted', request: req };
      }
      // The escalation cap BLOCKS: a request that needs human minutes is
      // denied when today's attention budget is spent. Approval that arrives
      // after the cap is theater, not oversight.
      if (bid.humanMinutes > 0 && (await openEscalations(p.tenant, today)) >= limits.maxHumanEscalationsPerDay) {
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
      if (TERMINAL_REQUEST_STATES.includes(r.state) && !['DECLINED', 'COMPLETED', 'FAILED'].includes(to)) {
        throw new CoordinationError('TERMINAL', `request ${id} already ${r.state}`);
      }
      const next: CoordinationRequest = { ...r, ...fields, state: to, updatedAt: new Date().toISOString() };
      await persist(next);
      await audit(next.targetScope + ':agent', `REQUEST_${to}`, id, tenant, next.refusalReason ?? undefined);
      return next;
    });
  }

  async function charge(
    tenant: string,
    id: string,
    cost: Partial<CoordinationRequest['spent']>,
  ): Promise<CoordinationRequest> {
    const r = await load(tenant, id);
    if (!r) throw new CoordinationError('NOT_FOUND', `request ${id}`);
    const spent = {
      dollars: r.spent.dollars + (cost.dollars ?? 0),
      tokens: r.spent.tokens + (cost.tokens ?? 0),
      humanMinutes: r.spent.humanMinutes + (cost.humanMinutes ?? 0),
      rounds: r.spent.rounds + 1,
      // Disk is a peak, not an accumulation: the caller reports the scope's
      // current bytesOnDisk and we keep the high-water mark.
      diskBytes: Math.max(r.spent.diskBytes, cost.diskBytes ?? 0),
    };
    // Budget death: terminate loudly, log a partial result. Never continue silently.
    const breached: string[] = [];
    if (spent.dollars > r.bid.dollars) breached.push(`$${spent.dollars.toFixed(3)}/${r.bid.dollars}`);
    if (spent.tokens > r.bid.tokens) breached.push(`${spent.tokens}/${r.bid.tokens} tokens`);
    if (spent.rounds > r.bid.maxRounds) breached.push(`${spent.rounds}/${r.bid.maxRounds} rounds`);
    if (r.bid.maxDiskBytes > 0 && spent.diskBytes > r.bid.maxDiskBytes) {
      breached.push(
        `${(spent.diskBytes / 1024 / 1024).toFixed(1)}/${(r.bid.maxDiskBytes / 1024 / 1024).toFixed(0)} MiB disk`,
      );
    }
    if (breached.length) {
      return transition(tenant, id, 'TERMINATED_BUDGET', {
        spent,
        refusalReason: `budget exhausted (${breached.join(', ')})`,
      });
    }
    return transition(tenant, id, r.state === 'ADMITTED' ? 'IN_FLIGHT' : r.state, { spent });
  }

  async function decompose(
    tenant: string,
    parentId: string,
    steps: DecomposeStep[],
    now?: string,
  ): Promise<AdmissionResult[]> {
    const parent = await load(tenant, parentId);
    if (!parent) throw new CoordinationError('NOT_FOUND', `request ${parentId}`);
    if (parent.state !== 'ADMITTED' && parent.state !== 'IN_FLIGHT') {
      throw new CoordinationError('BAD_PARENT', `request ${parentId} is ${parent.state} — only live work decomposes`);
    }
    if (steps.length === 0)
      throw new CoordinationError('EMPTY_DECOMPOSE', 'decomposing into zero steps splits nothing');
    const at = now ?? new Date().toISOString();
    // Already-committed (non-terminal) children hold part of the budget.
    const committed = (await db
      .prepare(
        `SELECT COALESCE(SUM(${jsonNumber(db.engine, 'bid_json', 'dollars')}),0) AS d FROM requests
          WHERE tenant = ? AND parent_request = ? AND state NOT IN (${TERMINAL_REQUEST_STATES.map(() => '?').join(',')})`,
      )
      .get(parent.tenant, parent.id, ...TERMINAL_REQUEST_STATES)) as { d: number };
    const remaining = parent.bid.dollars - parent.spent.dollars - Number(committed.d);
    const total = steps.reduce((s, st) => s + (st.bid?.dollars ?? 0), 0);
    if (total > remaining) {
      throw new CoordinationError(
        'BUDGET_SPLIT',
        `children bid $${total} against $${remaining.toFixed(3)} unspent on ${parentId} — decomposition never prints money`,
      );
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
  }

  async function openEscalations(tenant: string, day: string): Promise<number> {
    return (
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM requests
           WHERE tenant = ? AND ${sqlDayOf(db.engine, 'updated_at')} = ? AND ${jsonNumber(db.engine, 'bid_json', 'humanMinutes')} > 0
             AND state IN ('ADMITTED','IN_FLIGHT','DEFERRED')`,
        )
        .get(tenant, day)) as { n: number }
    ).n;
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

  async function expireStale(tenant: string, now: string): Promise<string[]> {
    const rows = (await db
      .prepare(
        `SELECT id FROM requests WHERE tenant = ? AND state IN ('ADMITTED','IN_FLIGHT','DEFERRED')
         AND ${jsonText(db.engine, 'bid_json', 'deadline')} <= ?`,
      )
      .all(tenant, now)) as { id: string }[];
    for (const r of rows) await transition(tenant, String(r.id), 'EXPIRED', { refusalReason: 'deadline passed' });
    return rows.map((r) => String(r.id));
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
      ).map((r) => rowToRequest(r as Record<string, unknown>));
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
    decompose,
    expireStale,
    refusalStats,
    openEscalations,
  };
}
