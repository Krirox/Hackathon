import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { DEFAULT_LIMITS, type Coordinator, type AdmissionResult, type SchedulerLimits } from '../coord/coordinator.ts';
import type { RequestState } from '../core/types.ts';
import { WedgeError } from './ship.ts';

/**
 * FLOW-013: fan-out as a durable partial workflow.
 *
 * A parent run identity is minted before any child REQUEST is submitted.
 * Each leg is persisted after admission so a crash or a later-leg refusal
 * leaves honest partial progress — not a thrown-away earlier success.
 * Retries skip completed/deduped legs and terminal refusals; they never
 * silently raise scheduler safety limits to force admission.
 */

export type FanOutLegStatus =
  'PENDING' | 'ADMITTED' | 'DEFERRED' | 'DENIED' | 'DECLINED' | 'EXECUTING' | 'FAILED' | 'COMPLETED' | 'DEDUPED';

export type FanOutWorkflowStatus = 'IN_PROGRESS' | 'PARTIAL' | 'COMPLETE' | 'BLOCKED';

export interface FanOutLegRecord {
  key: string;
  originScope: string;
  targetScope: string;
  messageClass: 'REQUEST' | 'QUERY';
  goal: string;
  deliverableSchema: string;
  humanMinutes: number;
  requestId: string | null;
  status: FanOutLegStatus;
  reason: string | null;
  /** When the coordinator deduped onto an existing thread. */
  dedupedTo: string | null;
  updatedAt: string;
}

export interface FanOutWorkflowRun {
  id: string;
  tenant: string;
  kind: 'ship' | 'churn';
  claimIds: string[];
  onBehalfOf: string;
  now: string;
  /** Ship release label or churn segment — scopes stable run identity. */
  subject: string;
  summary: string | null;
  legs: FanOutLegRecord[];
  status: FanOutWorkflowStatus;
  /** Churn: one recommendation decision per run, not per retry. */
  decisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

const runKeyOf = (tenant: string, id: string): string => `wedge:fanout:${tenant}:${id}`;

const TERMINAL_SUCCESS: readonly FanOutLegStatus[] = ['ADMITTED', 'DEDUPED', 'COMPLETED'];
const TERMINAL_FAILURE: readonly FanOutLegStatus[] = ['DENIED', 'DECLINED', 'FAILED'];
const RETRYABLE: readonly FanOutLegStatus[] = ['PENDING', 'DEFERRED'];

export function stableFanOutRunId(tenant: string, kind: string, subject: string, claimIds: string[]): string {
  const norm = [tenant, kind, subject, ...[...claimIds].sort()].join('::');
  const h = createHash('sha256').update(norm).digest('hex').slice(0, 24);
  return `wfr_${h}`;
}

export function legStatusFromRequest(state: RequestState): FanOutLegStatus {
  switch (state) {
    case 'ADMITTED':
      return 'ADMITTED';
    case 'DEFERRED':
      return 'DEFERRED';
    case 'DENIED':
      return 'DENIED';
    case 'DECLINED':
      return 'DECLINED';
    case 'ACCEPTED':
    case 'IN_FLIGHT':
      return 'EXECUTING';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
    case 'TERMINATED_BUDGET':
    case 'EXPIRED':
      return 'FAILED';
    case 'REDIRECTED':
      return 'DECLINED';
    default:
      return 'PENDING';
  }
}

export function legStatusFromAdmission(r: AdmissionResult): FanOutLegStatus {
  if (r.dedupedTo) {
    const mapped = legStatusFromRequest(r.state);
    if (mapped === 'COMPLETED' || mapped === 'ADMITTED' || mapped === 'EXECUTING' || mapped === 'DEFERRED') {
      return 'DEDUPED';
    }
    if (TERMINAL_FAILURE.includes(mapped)) return mapped;
    return 'DEDUPED';
  }
  if (r.admitted) return 'ADMITTED';
  return legStatusFromRequest(r.state);
}

export function isLegTerminalSuccess(status: FanOutLegStatus): boolean {
  return (TERMINAL_SUCCESS as readonly string[]).includes(status);
}

export function isLegRetryEligible(status: FanOutLegStatus): boolean {
  return (RETRYABLE as readonly string[]).includes(status);
}

export function isLegRefusal(status: FanOutLegStatus): boolean {
  return (TERMINAL_FAILURE as readonly string[]).includes(status);
}

export interface FanOutLegProgress {
  key: string;
  status: FanOutLegStatus;
  requestId: string | null;
  reason: string | null;
  dedupedTo: string | null;
}

export interface FanOutProgress {
  runId: string;
  status: FanOutWorkflowStatus;
  createdIds: Record<string, string>;
  legs: FanOutLegProgress[];
}

export function partialFanOutProgress(run: FanOutWorkflowRun): FanOutProgress {
  const createdIds: Record<string, string> = {};
  for (const leg of run.legs) {
    if (leg.requestId) {
      createdIds[leg.key] = leg.requestId;
    }
  }
  return {
    runId: run.id,
    status: run.status,
    createdIds,
    legs: run.legs.map((leg) => ({
      key: leg.key,
      status: leg.status,
      requestId: leg.requestId,
      reason: leg.reason,
      dedupedTo: leg.dedupedTo,
    })),
  };
}

export interface FanOutAttentionNeed {
  key: string;
  targetScope: string;
  humanMinutes: number;
  status: FanOutLegStatus;
  reason: string | null;
}

export interface FanOutAttentionReconciliation {
  runId: string;
  cap: number;
  used: number;
  remaining: number;
  needsAttention: FanOutAttentionNeed[];
  blockedByPolicy: string[];
  policyRaised: boolean;
}

export async function reconcileFanOutAttention(
  coord: Coordinator,
  run: FanOutWorkflowRun,
  limits: SchedulerLimits = DEFAULT_LIMITS,
): Promise<FanOutAttentionReconciliation> {
  const used = await coord.dailyEscalations(run.tenant, run.now.slice(0, 10));
  const cap = limits.maxHumanEscalationsPerDay;
  const needsAttention: FanOutAttentionNeed[] = [];
  const blockedByPolicy: string[] = [];
  for (const leg of run.legs) {
    if (leg.humanMinutes <= 0) {
      continue;
    }
    if (isLegTerminalSuccess(leg.status)) {
      continue;
    }
    needsAttention.push({
      key: leg.key,
      targetScope: leg.targetScope,
      humanMinutes: leg.humanMinutes,
      status: leg.status,
      reason: leg.reason,
    });
    if (leg.reason !== null && leg.reason.includes('escalation cap')) {
      blockedByPolicy.push(leg.key);
    }
  }
  let remaining = cap - used;
  if (remaining < 0) {
    remaining = 0;
  }
  return {
    runId: run.id,
    cap,
    used,
    remaining,
    needsAttention,
    blockedByPolicy,
    policyRaised: false,
  };
}

export function computeWorkflowStatus(legs: FanOutLegRecord[]): FanOutWorkflowStatus {
  if (legs.length === 0) return 'IN_PROGRESS';
  const allSuccess = legs.every((l) => isLegTerminalSuccess(l.status));
  if (allSuccess) return 'COMPLETE';
  const anySuccess = legs.some((l) => isLegTerminalSuccess(l.status));
  const anyFailure = legs.some((l) => (TERMINAL_FAILURE as readonly string[]).includes(l.status));
  const anyRetryable = legs.some((l) => isLegRetryEligible(l.status));
  if (anySuccess && (anyFailure || anyRetryable)) return 'PARTIAL';
  if (anyFailure && !anySuccess) return 'BLOCKED';
  if (anyRetryable) return 'IN_PROGRESS';
  if (anySuccess && anyFailure) return 'PARTIAL';
  return 'BLOCKED';
}

export async function saveFanOutRun(db: AsyncDb, run: FanOutWorkflowRun): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(runKeyOf(run.tenant, run.id), JSON.stringify(run));
}

export async function loadFanOutRun(db: AsyncDb, tenant: string, id: string): Promise<FanOutWorkflowRun | null> {
  try {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(runKeyOf(tenant, id))) as
      { value: string } | undefined;
    if (!r) return null;
    const run = JSON.parse(String(r.value)) as FanOutWorkflowRun;
    if (!Array.isArray(run.legs)) return null;
    return run;
  } catch {
    return null;
  }
}

async function syncLegFromCoordinator(
  coord: Coordinator,
  tenant: string,
  leg: FanOutLegRecord,
): Promise<FanOutLegRecord> {
  if (!leg.requestId) return leg;
  const req = await coord.get(tenant, leg.requestId);
  if (!req) return leg;
  const status = legStatusFromRequest(req.state);
  return { ...leg, status, reason: req.refusalReason ?? leg.reason, updatedAt: new Date().toISOString() };
}

function applyAdmission(leg: FanOutLegRecord, r: AdmissionResult, at: string): FanOutLegRecord {
  const status = legStatusFromAdmission(r);
  const requestId = r.dedupedTo ?? r.request.id;
  return {
    ...leg,
    requestId,
    status,
    reason: r.reason,
    dedupedTo: r.dedupedTo ?? null,
    updatedAt: at,
  };
}

export interface AdvanceFanOutOpts {
  /** When true, DEFERRED legs are readmitted before submission. */
  readmitDeferred?: boolean;
  /**
   * When false and the run is BLOCKED, PENDING legs are not submitted — the
   * operator must raise policy limits or pass `retryBlocked: true` on resume.
   */
  retryBlocked?: boolean;
}

/**
 * Submit the next eligible legs. Persists after every leg. Does not throw on
 * partial admission — the returned run carries honest per-leg status instead.
 */
export async function advanceFanOutWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  run: FanOutWorkflowRun,
  opts: AdvanceFanOutOpts = {},
): Promise<FanOutWorkflowRun> {
  const at = new Date().toISOString();
  if (opts.readmitDeferred) await coord.readmitDeferred(run.tenant);

  let current = run;
  const blocked = computeWorkflowStatus(current.legs) === 'BLOCKED';
  for (let i = 0; i < current.legs.length; i++) {
    let leg = current.legs[i]!;
    // Terminal refusals are retained until policy or evidence changes.
    if (leg.status === 'DENIED' || leg.status === 'DECLINED') continue;
    if (blocked && !opts.retryBlocked && leg.status === 'PENDING') continue;
    // Successful legs are re-submitted for idempotent dedupe on retry (same as
    // the legacy fan-out path) — a dedupe hit becomes DEDUPED, not a refusal.
    if ((leg.status === 'ADMITTED' || leg.status === 'DEDUPED') && leg.requestId) {
      const synced = await syncLegFromCoordinator(coord, run.tenant, leg);
      if (
        synced.status === 'COMPLETED' ||
        synced.status === 'EXECUTING' ||
        synced.status === 'FAILED' ||
        synced.status === 'DENIED' ||
        synced.status === 'DECLINED'
      ) {
        current = {
          ...current,
          legs: current.legs.map((l, idx) => (idx === i ? synced : l)),
          updatedAt: at,
        };
        await saveFanOutRun(db, current);
        continue;
      }
      const r = await coord.submit({
        tenant: run.tenant,
        messageClass: leg.messageClass,
        originScope: leg.originScope,
        targetScope: leg.targetScope,
        goal: leg.goal,
        claimRefs: run.claimIds,
        deliverableSchema: leg.deliverableSchema,
        bid: { humanMinutes: leg.humanMinutes },
        onBehalfOf: run.onBehalfOf,
        now: run.now,
      });
      leg = applyAdmission(synced, r, at);
      current = {
        ...current,
        legs: current.legs.map((l, idx) => (idx === i ? leg : l)),
        updatedAt: at,
      };
      await saveFanOutRun(db, current);
      continue;
    }
    if (!isLegRetryEligible(leg.status)) {
      if (leg.requestId) {
        leg = await syncLegFromCoordinator(coord, run.tenant, leg);
        if (leg.status !== current.legs[i]!.status) {
          current = {
            ...current,
            legs: current.legs.map((l, idx) => (idx === i ? leg : l)),
            updatedAt: at,
          };
          await saveFanOutRun(db, current);
        }
      }
      continue;
    }

    const r = await coord.submit({
      tenant: run.tenant,
      messageClass: leg.messageClass,
      originScope: leg.originScope,
      targetScope: leg.targetScope,
      goal: leg.goal,
      claimRefs: run.claimIds,
      deliverableSchema: leg.deliverableSchema,
      bid: { humanMinutes: leg.humanMinutes },
      onBehalfOf: run.onBehalfOf,
      now: run.now,
    });
    leg = applyAdmission(leg, r, at);
    current = {
      ...current,
      legs: current.legs.map((l, idx) => (idx === i ? leg : l)),
      status: computeWorkflowStatus(current.legs.map((l, idx) => (idx === i ? leg : l))),
      updatedAt: at,
    };
    await saveFanOutRun(db, current);

    // A terminal refusal stops forward progress — earlier legs stay visible.
    if ((TERMINAL_FAILURE as readonly string[]).includes(leg.status) && !r.dedupedTo) {
      current = { ...current, status: computeWorkflowStatus(current.legs) };
      await saveFanOutRun(db, current);
      break;
    }
  }

  current = { ...current, status: computeWorkflowStatus(current.legs), updatedAt: at };
  await saveFanOutRun(db, current);
  return current;
}

export function shipLegTemplates(
  release: string,
  summary: string,
): Omit<FanOutLegRecord, 'requestId' | 'status' | 'reason' | 'dedupedTo' | 'updatedAt'>[] {
  const brief = `${release}: ${summary}`;
  const at = new Date().toISOString();
  const base = (
    key: string,
    originScope: string,
    targetScope: string,
    messageClass: 'REQUEST' | 'QUERY',
    goal: string,
    deliverableSchema: string,
    humanMinutes: number,
  ) => ({
    key,
    originScope,
    targetScope,
    messageClass,
    goal,
    deliverableSchema,
    humanMinutes,
    updatedAt: at,
  });
  return [
    base(
      'marketing',
      'product',
      'marketing',
      'REQUEST',
      `launch narrative + blog + in-app copy — ${brief}`,
      'launch-pack.v1',
      15,
    ),
    base(
      'customer',
      'product',
      'customer',
      'REQUEST',
      `support macro + FAQ + churn-risk segment — ${brief}`,
      'support-pack.v1',
      15,
    ),
    base('sales', 'product', 'sales', 'REQUEST', `battlecard + objection handling — ${brief}`, 'battlecard.v1', 10),
    base(
      'product',
      'engineering',
      'product',
      'QUERY',
      `does this close a known pain pattern? — ${brief}`,
      'pain-link.v1',
      0,
    ),
    base(
      'finance',
      'product',
      'finance',
      'REQUEST',
      `budget headroom for paid launch — ${brief}`,
      'budget-check.v1',
      10,
    ),
  ];
}

export function churnLegTemplates(
  segment: string,
): Omit<FanOutLegRecord, 'requestId' | 'status' | 'reason' | 'dedupedTo' | 'updatedAt'>[] {
  const brief = `churn risk in ${segment}`;
  const at = new Date().toISOString();
  const base = (
    key: string,
    originScope: string,
    targetScope: string,
    messageClass: 'REQUEST' | 'QUERY',
    goal: string,
    deliverableSchema: string,
    humanMinutes: number,
  ) => ({
    key,
    originScope,
    targetScope,
    messageClass,
    goal,
    deliverableSchema,
    humanMinutes,
    updatedAt: at,
  });
  return [
    base(
      'productQuery',
      'customer',
      'product',
      'QUERY',
      `does this match a known pain pattern? — ${brief}`,
      'pain-link.v1',
      0,
    ),
    base('outreach', 'product', 'customer', 'REQUEST', `save play for ${segment} — ${brief}`, 'save-play.v1', 10),
    base(
      'offer',
      'product',
      'marketing',
      'REQUEST',
      `retention offer copy for ${segment} — ${brief}`,
      'offer-copy.v1',
      10,
    ),
  ];
}

function blankLeg(
  t: Omit<FanOutLegRecord, 'requestId' | 'status' | 'reason' | 'dedupedTo' | 'updatedAt'>,
  at: string,
): FanOutLegRecord {
  return {
    ...t,
    requestId: null,
    status: 'PENDING',
    reason: null,
    dedupedTo: null,
    updatedAt: at,
  };
}

export function createFanOutWorkflowRun(input: {
  tenant: string;
  kind: 'ship' | 'churn';
  subject: string;
  claimIds: string[];
  onBehalfOf: string;
  now: string;
  summary?: string | null;
  legs: Omit<FanOutLegRecord, 'requestId' | 'status' | 'reason' | 'dedupedTo' | 'updatedAt'>[];
  runId?: string;
}): FanOutWorkflowRun {
  const at = input.now;
  const id = input.runId ?? stableFanOutRunId(input.tenant, input.kind, input.subject, input.claimIds);
  return {
    id,
    tenant: input.tenant,
    kind: input.kind,
    claimIds: input.claimIds,
    onBehalfOf: input.onBehalfOf,
    now: input.now,
    subject: input.subject,
    summary: input.summary ?? null,
    legs: input.legs.map((l) => blankLeg(l, at)),
    status: 'IN_PROGRESS',
    decisionId: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Map a completed ship workflow to the legacy FanOutResult shape. */
export function shipLegIds(
  run: FanOutWorkflowRun,
): Record<'marketing' | 'customer' | 'sales' | 'product' | 'finance', string> {
  const out: Record<string, string> = {};
  for (const leg of run.legs) {
    if (!leg.requestId) {
      throw new WedgeError('INCOMPLETE_FANOUT', `leg ${leg.key} has no request id`);
    }
    out[leg.key] = leg.requestId;
  }
  return out as Record<'marketing' | 'customer' | 'sales' | 'product' | 'finance', string>;
}

export function churnLegIds(run: FanOutWorkflowRun): {
  productQueryId: string;
  outreachRequestId: string;
  offerRequestId: string;
} {
  const pick = (key: string): string => {
    const leg = run.legs.find((l) => l.key === key);
    if (!leg?.requestId) throw new WedgeError('INCOMPLETE_FANOUT', `leg ${key} has no request id`);
    return leg.requestId;
  };
  return {
    productQueryId: pick('productQuery'),
    outreachRequestId: pick('outreach'),
    offerRequestId: pick('offer'),
  };
}

export function requireCompleteFanOut(run: FanOutWorkflowRun): void {
  if (run.status === 'COMPLETE') return;
  const progress = partialFanOutProgress(run);
  const refused = run.legs.filter((l) => isLegRefusal(l.status));
  const first = refused[0];
  if (first) {
    throw new WedgeError(
      'FANOUT_REFUSED',
      `${first.originScope}→${first.targetScope} ${first.status}: ${first.reason ?? 'refused'}`,
      { runId: run.id, status: run.status, progress },
    );
  }
  throw new WedgeError('INCOMPLETE_FANOUT', `fan-out ${run.id} is ${run.status} — not all legs admitted`, {
    runId: run.id,
    status: run.status,
    progress,
  });
}
