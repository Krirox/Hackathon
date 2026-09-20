import type { AsyncDb } from '../core/db.ts';
import type { Ledger, OutcomeRecord } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { preregister, getPrereg, type Preregistration } from '../attrib/attribution.ts';
import { mineCandidates } from '../compiler/compiler.ts';
import { loadFanOutRun, type FanOutLegRecord, type FanOutWorkflowRun } from '../wedge/fanout-workflow.ts';
import { getReleaseStage, type ReleaseStageRecord } from '../wedge/ship.ts';
import { resumeFanOutWorkflow } from '../wedge/ship.ts';

/**
 * FLOW-015: continuous release workspace — one connected journey from source
 * evidence through fan-out, approval, execution, measurement, and replay.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const overlayKey = (tenant: string, id: string): string => `wedge:workspace:${tenant}:${id}`;

export type WorkspaceLifecycle =
  | 'SOURCED'
  | 'FAN_OUT'
  | 'EXECUTING'
  | 'EXECUTION_COMPLETE'
  | 'MEASUREMENT_PENDING'
  | 'OUTCOME_VERIFIED'
  | 'CANCELLED'
  | 'BLOCKED';

export interface WorkflowWorkspaceOverlay {
  preregId?: string;
  outcomeIds?: string[];
  cancelledAt?: string;
  cancelReason?: string;
  baseline?: string;
  comparisonBasis?: string;
  measurementWindow?: { start: string; end: string };
  /** Feature workflow binding when kind is feature. */
  feature?: { feature: string; planFingerprint?: string; decisionId?: string; requestId?: string };
}

export interface WorkflowLegView {
  key: string;
  goal: string;
  status: string;
  requestId: string | null;
  requestState: string | null;
  decisionId: string | null;
  reason: string | null;
  url: string | null;
  /** True when nothing will advance this leg without human recovery. */
  stalled: boolean;
  /** Why it is stalled, in one sentence ready to render. */
  stallDetail: string | null;
}

/**
 * How long an accepted-but-unclaimed leg may wait before it is called stalled.
 *
 * Ten minutes is not a lease: it is the absence of one. A worker picks up
 * ACCEPTED work within seconds of a tick, and the execution lease itself is
 * 60s, so a leg nobody has claimed after ten minutes means no executor is
 * taking work — the state the console used to render as a perpetual "in
 * progress".
 */
export const UNCLAIMED_STALL_MS = 10 * 60_000;

/** The lease columns the stall check needs, read straight from `requests`. */
export interface LegLease {
  state: string;
  claimedAt: string | null;
  leaseMs: number | null;
  updatedAt: string;
}

/**
 * Explain a leg that has stopped moving, or `null` when it is progressing.
 *
 * Two distinct stalls, deliberately distinguished:
 * - `IN_FLIGHT` past `claimed_at + lease_ms` — an executor claimed the work and
 *   died. The coordinator's own sweep would reclaim it, but only a running
 *   worker performs that sweep, so a dead executor strands it.
 * - `ACCEPTED` for longer than `UNCLAIMED_STALL_MS` — no executor ever picked it
 *   up. Approving it looked successful and changed nothing.
 */
export function describeLegStall(
  requestState: string | null,
  lease: LegLease | null,
  nowMs: number,
  opts: { unclaimedMs?: number } = {},
): string | null {
  if (!requestState || !lease) return null;
  if (requestState === 'IN_FLIGHT') {
    const claimedAtMs = lease.claimedAt === null ? Number.NaN : Date.parse(lease.claimedAt);
    if (!Number.isFinite(claimedAtMs)) return null;
    const expiresAt = claimedAtMs + (lease.leaseMs ?? 60_000);
    if (expiresAt > nowMs) return null;
    const over = Math.max(0, Math.round((nowMs - expiresAt) / 1000));
    return `the executor claimed this request ${Math.round((nowMs - claimedAtMs) / 1000)}s ago and its ${Math.round((lease.leaseMs ?? 60_000) / 1000)}s lease expired ${over}s ago — the worker holding it is gone.`;
  }
  if (requestState === 'ACCEPTED') {
    const sinceMs = Date.parse(lease.updatedAt);
    if (!Number.isFinite(sinceMs)) return null;
    const waitedMs = nowMs - sinceMs;
    if (waitedMs < (opts.unclaimedMs ?? UNCLAIMED_STALL_MS)) return null;
    return `accepted ${Math.round(waitedMs / 60_000)}m ago and never claimed by an executor — no worker is picking up work.`;
  }
  return null;
}

export interface WorkflowTraceView {
  id: string;
  requestId: string;
  intent: string;
  outcome: string;
  tier: string;
  routerConfidence: number | null;
  compilable: boolean;
}

export interface WorkflowReplayView {
  decisionId: string;
  goal: string;
  frozenClaims: { id: string; status: string; statement: string }[];
  drift: { id: string; frozenStatus: string; currentStatus: string | null; drifted: boolean }[];
}

export interface WorkflowWorkspaceView {
  id: string;
  kind: FanOutWorkflowRun['kind'] | 'feature';
  subject: string;
  summary: string | null;
  owner: string;
  lifecycle: WorkspaceLifecycle;
  blocker: string | null;
  nextAction: string | null;
  updatedAt: string;
  createdAt: string;
  sourceClaimIds: string[];
  sourceReceipts: { id: string; statement: string; status: string; url: string }[];
  legs: WorkflowLegView[];
  fanoutStatus: string | null;
  releaseStage: ReleaseStageRecord | null;
  prereg: Preregistration | null;
  outcomes: OutcomeRecord[];
  measurementState: 'unsupported' | 'pending' | 'verified' | 'unknown';
  cancelled: boolean;
  cancelReason: string | null;
  traces: WorkflowTraceView[];
  compilerCandidates: { intent: string; repeats: number; successRate: number }[];
  replay: WorkflowReplayView[];
  canRetry: boolean;
  canCancel: boolean;
  canPreregister: boolean;
  canCaptureOutcome: boolean;
  /** Legs that nothing will advance without human recovery, if any. */
  stalledLegs: { key: string; requestId: string | null; detail: string | null }[];
}

export interface WorkflowListItem {
  id: string;
  kind: FanOutWorkflowRun['kind'] | 'feature';
  subject: string;
  summary: string | null;
  lifecycle: WorkspaceLifecycle;
  owner: string;
  updatedAt: string;
  url: string;
}

export async function loadWorkspaceOverlay(
  db: AsyncDb,
  tenant: string,
  id: string,
): Promise<WorkflowWorkspaceOverlay | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(overlayKey(tenant, id))) as
    { value: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(String(r.value)) as WorkflowWorkspaceOverlay;
  } catch {
    return null;
  }
}

export async function saveWorkspaceOverlay(
  db: AsyncDb,
  tenant: string,
  id: string,
  overlay: WorkflowWorkspaceOverlay,
): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(overlayKey(tenant, id), JSON.stringify(overlay));
}

export async function listWorkflowRuns(db: AsyncDb, tenant: string): Promise<FanOutWorkflowRun[]> {
  const rows = (await db.prepare('SELECT value FROM meta WHERE key LIKE ?').all(`wedge:fanout:${tenant}:%`)) as {
    value: string;
  }[];
  const out: FanOutWorkflowRun[] = [];
  for (const row of rows) {
    try {
      const run = JSON.parse(String(row.value)) as FanOutWorkflowRun;
      if (run.tenant === tenant && Array.isArray(run.legs)) out.push(run);
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Feature workspaces without fan-out legs still appear in the release workspace index. */
export async function listFeatureWorkspaceIds(db: AsyncDb, tenant: string): Promise<string[]> {
  const rows = (await db.prepare('SELECT key FROM meta WHERE key LIKE ?').all(`wedge:workspace:${tenant}:%`)) as {
    key: string;
  }[];
  const fanoutIds = new Set((await listWorkflowRuns(db, tenant)).map((r) => r.id));
  return rows.map((r) => r.key.slice(`wedge:workspace:${tenant}:`.length)).filter((id) => !fanoutIds.has(id));
}

function legTerminalSuccess(status: string): boolean {
  return status === 'ADMITTED' || status === 'DEDUPED' || status === 'COMPLETED';
}

function legExecuting(status: string): boolean {
  return status === 'EXECUTING' || status === 'ACCEPTED' || status === 'IN_FLIGHT';
}

function deriveLifecycle(
  run: FanOutWorkflowRun | null,
  overlay: WorkflowWorkspaceOverlay | null,
  releaseStage: ReleaseStageRecord | null,
  outcomes: OutcomeRecord[],
): WorkspaceLifecycle {
  if (overlay?.cancelledAt) return 'CANCELLED';
  if (!run) return overlay?.feature ? 'SOURCED' : 'SOURCED';
  if (outcomes.length > 0 || releaseStage?.stage === 'MEASURED') return 'OUTCOME_VERIFIED';
  const allSuccess = run.legs.every((l) => legTerminalSuccess(l.status));
  const anyExecuting = run.legs.some((l) => legExecuting(l.status));
  const anyBlocked = run.legs.some((l) => ['DENIED', 'DECLINED', 'FAILED'].includes(l.status));
  if (run.status === 'BLOCKED' || (anyBlocked && !allSuccess)) return 'BLOCKED';
  if (allSuccess && (releaseStage?.stage === 'EXECUTED' || anyExecuting)) return 'MEASUREMENT_PENDING';
  if (allSuccess) {
    return releaseStage?.stage === 'EXECUTED' ? 'MEASUREMENT_PENDING' : 'EXECUTION_COMPLETE';
  }
  if (anyExecuting) return 'EXECUTING';
  if (run.status === 'IN_PROGRESS' || run.status === 'PARTIAL') return 'FAN_OUT';
  return 'FAN_OUT';
}

function deriveBlockerAndNext(
  lifecycle: WorkspaceLifecycle,
  run: FanOutWorkflowRun | null,
  overlay: WorkflowWorkspaceOverlay | null,
  legs: WorkflowLegView[],
  prereg: Preregistration | null,
): { blocker: string | null; nextAction: string | null } {
  if (lifecycle === 'CANCELLED') {
    return { blocker: overlay?.cancelReason ?? 'Workflow cancelled', nextAction: null };
  }
  const refused = legs.find((l) => ['DENIED', 'DECLINED', 'FAILED'].includes(l.status));
  if (lifecycle === 'BLOCKED' && refused) {
    return {
      blocker: refused.reason ?? `${refused.key} leg ${refused.status}`,
      nextAction: 'Retry eligible legs or raise policy limits before retrying blocked legs',
    };
  }
  // A stall outranks a pending review: work that looks approved but can never
  // run is the failure this view exists to make visible, and "approve the next
  // deliverable" would otherwise be the only thing the operator was told.
  const stalled = legs.filter((l) => l.stalled);
  if (stalled.length > 0) {
    return {
      blocker: `${stalled.map((l) => l.key).join(', ')} stalled — ${stalled[0]!.stallDetail ?? 'no executor is advancing it'}`,
      nextAction: 'Reclaim the stalled legs, then resume fan-out',
    };
  }
  const pendingReview = legs.find((l) => l.requestState === 'ADMITTED');
  if (pendingReview) {
    return {
      blocker: null,
      nextAction: `Review and approve ${pendingReview.key} deliverable`,
    };
  }
  if (lifecycle === 'EXECUTION_COMPLETE' || lifecycle === 'MEASUREMENT_PENDING') {
    if (!prereg) return { blocker: null, nextAction: 'Pre-register pilot metrics before measuring outcomes' };
    if (lifecycle === 'MEASUREMENT_PENDING') {
      return { blocker: null, nextAction: 'Capture measured outcome with basis and comparison' };
    }
  }
  if (lifecycle === 'OUTCOME_VERIFIED') {
    return { blocker: null, nextAction: 'Review replay and eligible procedure traces' };
  }
  if (run?.status === 'PARTIAL') {
    return { blocker: null, nextAction: 'Resume fan-out for deferred or pending legs' };
  }
  if (run?.status === 'IN_PROGRESS') {
    return { blocker: null, nextAction: 'Monitor fan-out leg admission and execution' };
  }
  return { blocker: null, nextAction: null };
}

/**
 * Execution-lease facts for the legs of one workflow, in a single query.
 *
 * Read per workflow rather than per leg, and answered with an empty map on
 * failure: a workflow page must still render when the lease columns are
 * unreadable, and it must not claim a stall it could not verify.
 */
async function loadLegLeases(db: AsyncDb, tenant: string, requestIds: string[]): Promise<Map<string, LegLease>> {
  const out = new Map<string, LegLease>();
  if (requestIds.length === 0) return out;
  const placeholders = requestIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(
      `SELECT id, state, claimed_at, lease_ms, updated_at FROM requests
        WHERE tenant = ? AND id IN (${placeholders})`,
    )
    .all(tenant, ...requestIds)) as {
    id: string;
    state: string;
    claimed_at: string | null;
    lease_ms: number | null;
    updated_at: string;
  }[];
  for (const r of rows) {
    out.set(String(r.id), {
      state: String(r.state),
      claimedAt: r.claimed_at === null ? null : String(r.claimed_at),
      leaseMs: r.lease_ms === null ? null : Number(r.lease_ms),
      updatedAt: String(r.updated_at),
    });
  }
  return out;
}

async function hydrateLeg(
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  leg: FanOutLegRecord,
  leases: Map<string, LegLease>,
  nowMs: number,
): Promise<WorkflowLegView> {
  let requestState: string | null = null;
  let decisionId: string | null = null;
  if (leg.requestId) {
    const req = await coord.get(tenant, leg.requestId);
    requestState = req?.state ?? null;
    const dec = await ledger.getDecisionByRequest(tenant, leg.requestId);
    decisionId = dec?.id ?? null;
  }
  // The coordinator's own view is authoritative for state; the lease row is
  // authoritative for time. A leg whose coordinator read failed is not called
  // stalled — an unreadable request is a different problem, reported elsewhere.
  const lease = leg.requestId ? (leases.get(leg.requestId) ?? null) : null;
  const verifiedLease = lease && lease.state === requestState ? lease : null;
  const stallDetail = describeLegStall(requestState, verifiedLease, nowMs);
  return {
    key: leg.key,
    goal: leg.goal,
    status: leg.status,
    requestId: leg.requestId,
    requestState,
    decisionId,
    reason: leg.reason,
    url: leg.requestId ? `/console/requests/${encodeURIComponent(leg.requestId)}` : null,
    stalled: stallDetail !== null,
    stallDetail,
  };
}

async function loadOutcomesForDecisions(db: AsyncDb, tenant: string, decisionIds: string[]): Promise<OutcomeRecord[]> {
  if (decisionIds.length === 0) return [];
  const placeholders = decisionIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(
      `SELECT id, tenant, decision_id, metric, predicted, actual, basis, holdout_ref, resolved_at
       FROM outcomes WHERE tenant = ? AND decision_id IN (${placeholders})`,
    )
    .all(tenant, ...decisionIds)) as {
    id: string;
    tenant: string;
    decision_id: string;
    metric: string;
    predicted: number | null;
    actual: number;
    basis: string;
    holdout_ref: string | null;
    resolved_at: string;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    tenant: String(r.tenant),
    decisionId: String(r.decision_id),
    metric: String(r.metric),
    predicted: r.predicted === null ? null : Number(r.predicted),
    actual: Number(r.actual),
    basis: String(r.basis),
    holdoutRef: r.holdout_ref === null ? null : String(r.holdout_ref),
    resolvedAt: String(r.resolved_at),
  }));
}

async function loadTracesForRequests(db: AsyncDb, tenant: string, requestIds: string[]): Promise<WorkflowTraceView[]> {
  if (requestIds.length === 0) return [];
  const placeholders = requestIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(
      `SELECT id, request_id, intent, outcome, tier, router_confidence
       FROM traces WHERE tenant = ? AND request_id IN (${placeholders})`,
    )
    .all(tenant, ...requestIds)) as {
    id: string;
    request_id: string;
    intent: string;
    outcome: string;
    tier: string;
    router_confidence: number | null;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    requestId: String(r.request_id),
    intent: String(r.intent),
    outcome: String(r.outcome),
    tier: String(r.tier),
    routerConfidence: r.router_confidence === null ? null : Number(r.router_confidence),
    compilable: r.outcome === 'SUCCESS' && (r.router_confidence === null || Number(r.router_confidence) >= 0.5),
  }));
}

export async function buildWorkspaceView(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  _comp: OrganizationalCompiler,
  tenant: string,
  id: string,
): Promise<WorkflowWorkspaceView | null> {
  const run = await loadFanOutRun(db, tenant, id);
  const overlay = await loadWorkspaceOverlay(db, tenant, id);
  if (!run && !overlay?.feature) return null;

  const releaseId = run?.subject ?? overlay?.feature?.feature ?? id;
  const releaseStage = await getReleaseStage(db, tenant, releaseId);
  const nowMs = Date.now();
  const legRequestIds = (run?.legs ?? []).map((l) => l.requestId).filter((r): r is string => Boolean(r));
  const leases = await loadLegLeases(db, tenant, legRequestIds);
  const legs = run ? await Promise.all(run.legs.map((l) => hydrateLeg(coord, ledger, tenant, l, leases, nowMs))) : [];
  const decisionIds = [
    ...(run?.decisionId ? [run.decisionId] : []),
    ...legs.map((l) => l.decisionId).filter((d): d is string => Boolean(d)),
    ...(overlay?.feature?.decisionId ? [overlay.feature.decisionId] : []),
  ];
  const uniqueDecisionIds = [...new Set(decisionIds)];
  const stalledLegs = legs.filter((l) => l.stalled);
  const outcomes = await loadOutcomesForDecisions(db, tenant, uniqueDecisionIds);
  const prereg = overlay?.preregId ? await getPrereg(db, tenant, overlay.preregId) : null;
  const lifecycle = deriveLifecycle(run, overlay, releaseStage, outcomes);
  const { blocker, nextAction } = deriveBlockerAndNext(lifecycle, run, overlay, legs, prereg);

  const sourceClaimIds = run?.claimIds ?? [];
  const sourceReceipts = [];
  for (const cid of sourceClaimIds) {
    const c = await ledger.get(tenant, cid);
    sourceReceipts.push({
      id: cid,
      statement: c?.statement ?? 'evidence unavailable',
      status: c?.status ?? 'unknown',
      url: `/console/claims/${encodeURIComponent(cid)}`,
    });
  }

  const requestIds = legs.map((l) => l.requestId).filter((r): r is string => Boolean(r));
  const traces = await loadTracesForRequests(db, tenant, requestIds);
  const candidates = await mineCandidates(db, tenant, 1);
  const traceIntents = new Set(traces.filter((t) => t.compilable).map((t) => t.intent));
  const compilerCandidates = candidates.filter((c) => traceIntents.has(c.intent));

  const replay: WorkflowReplayView[] = [];
  for (const did of uniqueDecisionIds) {
    try {
      const { record, drift } = await ledger.replayDecision(tenant, did);
      replay.push({
        decisionId: did,
        goal: record.goal,
        frozenClaims: record.bundle.claims.map((e) => ({
          id: e.id,
          status: e.status,
          statement: e.statement,
        })),
        drift: drift.map((d) => ({
          id: d.id,
          frozenStatus: d.frozenStatus,
          currentStatus: d.currentStatus,
          drifted: d.drifted,
        })),
      });
    } catch {
      /* decision may not replay */
    }
  }

  let measurementState: WorkflowWorkspaceView['measurementState'] = 'unsupported';
  if (lifecycle === 'OUTCOME_VERIFIED') measurementState = 'verified';
  else if (lifecycle === 'MEASUREMENT_PENDING') measurementState = 'pending';
  else if (lifecycle === 'EXECUTION_COMPLETE') measurementState = prereg ? 'pending' : 'unknown';

  return {
    id,
    kind: run?.kind ?? 'feature',
    subject: run?.subject ?? overlay?.feature?.feature ?? id,
    summary: run?.summary ?? null,
    owner: run?.onBehalfOf ?? 'unknown',
    lifecycle,
    blocker,
    nextAction,
    updatedAt: run?.updatedAt ?? overlay?.cancelledAt ?? new Date().toISOString(),
    createdAt: run?.createdAt ?? new Date().toISOString(),
    sourceClaimIds,
    sourceReceipts,
    legs,
    fanoutStatus: run?.status ?? null,
    releaseStage,
    prereg,
    outcomes,
    measurementState,
    cancelled: Boolean(overlay?.cancelledAt),
    cancelReason: overlay?.cancelReason ?? null,
    traces,
    compilerCandidates,
    replay,
    // A stalled leg joins PARTIAL/BLOCKED as a retryable condition: without
    // this, a run stuck IN_PROGRESS showed no retry affordance at all, which is
    // how an approved release sat unexecuted with the page still saying "in
    // progress".
    canRetry: Boolean(
      run && !overlay?.cancelledAt && (run.status === 'PARTIAL' || run.status === 'BLOCKED' || stalledLegs.length > 0),
    ),
    stalledLegs: stalledLegs.map((l) => ({ key: l.key, requestId: l.requestId, detail: l.stallDetail })),
    canCancel: Boolean(!overlay?.cancelledAt && lifecycle !== 'OUTCOME_VERIFIED'),
    canPreregister: Boolean(
      !overlay?.cancelledAt &&
      !prereg &&
      (lifecycle === 'EXECUTION_COMPLETE' || lifecycle === 'MEASUREMENT_PENDING' || lifecycle === 'FAN_OUT'),
    ),
    canCaptureOutcome: Boolean(!overlay?.cancelledAt && prereg && outcomes.length === 0),
  };
}

export async function listWorkflows(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  tenant: string,
): Promise<WorkflowListItem[]> {
  const runs = await listWorkflowRuns(db, tenant);
  const featureIds = await listFeatureWorkspaceIds(db, tenant);
  const ids = [...runs.map((r) => r.id), ...featureIds];
  const items: WorkflowListItem[] = [];
  for (const id of ids) {
    const view = await buildWorkspaceView(db, ledger, coord, comp, tenant, id);
    if (!view) continue;
    items.push({
      id: view.id,
      kind: view.kind,
      subject: view.subject,
      summary: view.summary,
      lifecycle: view.lifecycle,
      owner: view.owner,
      updatedAt: view.updatedAt,
      url: `/console/workflows/${encodeURIComponent(view.id)}`,
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function preregisterWorkflowMetrics(
  db: AsyncDb,
  tenant: string,
  workflowId: string,
  input: {
    metrics: { name: string; threshold: number; direction?: 'higher' | 'lower' }[];
    baseline: string;
    comparisonBasis: string;
    measurementWindow: { start: string; end: string };
    agreedBy: string;
    decisionId?: string;
    now?: string;
  },
): Promise<Preregistration> {
  const overlay = (await loadWorkspaceOverlay(db, tenant, workflowId)) ?? {};
  if (overlay.cancelledAt) throw new Error('cannot pre-register metrics on a cancelled workflow');
  if (overlay.preregId) {
    const existing = await getPrereg(db, tenant, overlay.preregId);
    if (existing) return existing;
  }
  if (!input.baseline.trim()) throw new Error('baseline is required');
  if (!input.comparisonBasis.trim()) throw new Error('comparison basis is required');
  const rec = await preregister(db, tenant, {
    decisionId: input.decisionId,
    metrics: input.metrics,
    agreedBy: input.agreedBy,
    now: input.now,
  });
  await saveWorkspaceOverlay(db, tenant, workflowId, {
    ...overlay,
    preregId: rec.id,
    baseline: input.baseline,
    comparisonBasis: input.comparisonBasis,
    measurementWindow: input.measurementWindow,
  });
  return rec;
}

export async function captureWorkflowOutcome(
  db: AsyncDb,
  ledger: Ledger,
  tenant: string,
  workflowId: string,
  input: {
    decisionId: string;
    metric: string;
    actual: number;
    basis: string;
    predicted?: number;
    holdoutRef?: string;
    resolvedBy: string;
    owner: string;
    scope: string;
    now?: string;
  },
): Promise<OutcomeRecord> {
  const overlay = (await loadWorkspaceOverlay(db, tenant, workflowId)) ?? {};
  if (overlay.cancelledAt) throw new Error('cannot capture outcome on a cancelled workflow');
  if (!overlay.preregId) throw new Error('pre-register metrics before capturing outcomes');
  const outcome = await ledger.recordOutcome({
    tenant,
    decisionId: input.decisionId,
    metric: input.metric,
    actual: input.actual,
    basis: input.basis,
    predicted: input.predicted,
    holdoutRef: input.holdoutRef,
    resolvedBy: input.resolvedBy,
    owner: input.owner,
    scope: input.scope,
    now: input.now,
  });
  await saveWorkspaceOverlay(db, tenant, workflowId, {
    ...overlay,
    outcomeIds: [...(overlay.outcomeIds ?? []), outcome.id],
  });
  return outcome;
}

export async function cancelWorkflow(
  db: AsyncDb,
  tenant: string,
  workflowId: string,
  reason: string,
  at: string,
): Promise<void> {
  const overlay = (await loadWorkspaceOverlay(db, tenant, workflowId)) ?? {};
  await saveWorkspaceOverlay(db, tenant, workflowId, {
    ...overlay,
    cancelledAt: at,
    cancelReason: reason,
  });
}

/**
 * The request ids of this workflow's stalled legs, newest evidence first.
 *
 * Exported because the reclaim is a coordinator write: callers pass these ids
 * to `reclaimStale` so the operator's retry releases the legs they are looking
 * at, not every expired lease in the tenant.
 */
export async function stalledLegRequestIds(
  db: AsyncDb,
  tenant: string,
  workflowId: string,
  opts: { now?: string } = {},
): Promise<string[]> {
  const run = await loadFanOutRun(db, tenant, workflowId);
  if (!run) return [];
  const ids = run.legs.map((l) => l.requestId).filter((r): r is string => Boolean(r));
  const leases = await loadLegLeases(db, tenant, ids);
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const out: string[] = [];
  for (const leg of run.legs) {
    if (!leg.requestId) continue;
    const lease = leases.get(leg.requestId) ?? null;
    const stall = leg.status === 'EXECUTING' ? describeLegStall(lease?.state ?? null, lease, nowMs) : null;
    if (stall) out.push(leg.requestId);
  }
  return out;
}

/**
 * Resume a workflow, reclaiming any expired execution lease first.
 *
 * Without the reclaim, "retry" was a no-op on exactly the case that needed it:
 * a leg whose executor died stays IN_FLIGHT, so the sync in `resumeFanOutWorkflow`
 * reports the same EXECUTING leg back and the operator is told the retry ran
 * while nothing moved. The reclaim is the coordinator's own recovery path
 * (audited per row, CAS on state + claimed_at), scoped to this workflow's legs.
 */
export async function retryWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  tenant: string,
  workflowId: string,
  opts: { retryBlocked?: boolean; now?: string } = {},
): Promise<{ run: FanOutWorkflowRun; reclaimed: string[] }> {
  const overlay = await loadWorkspaceOverlay(db, tenant, workflowId);
  if (overlay?.cancelledAt) throw new Error('cannot retry a cancelled workflow');
  const nowIso = opts.now ?? new Date().toISOString();
  const stalled = await stalledLegRequestIds(db, tenant, workflowId, { now: nowIso });
  const reclaimed =
    stalled.length > 0 ? await coord.reclaimStale(tenant, Date.parse(nowIso), stalled.length, stalled) : [];
  const run = await resumeFanOutWorkflow(db, coord, tenant, workflowId, opts);
  return { run, reclaimed };
}

export async function createFeatureWorkspace(
  db: AsyncDb,
  tenant: string,
  input: {
    id: string;
    feature: string;
    claimIds: string[];
    onBehalfOf: string;
    planFingerprint?: string;
    decisionId?: string;
    requestId?: string;
  },
): Promise<string> {
  await saveWorkspaceOverlay(db, tenant, input.id, {
    feature: {
      feature: input.feature,
      planFingerprint: input.planFingerprint,
      decisionId: input.decisionId,
      requestId: input.requestId,
    },
  });
  return input.id;
}

/** Tint class per lifecycle state — the label always travels with the color. */
const LIFECYCLE_TONE: Record<WorkspaceLifecycle, string> = {
  SOURCED: 'v-badge',
  FAN_OUT: 'v-badge-info',
  EXECUTING: 'v-badge-info',
  EXECUTION_COMPLETE: 'v-badge-warn',
  MEASUREMENT_PENDING: 'v-badge-warn',
  OUTCOME_VERIFIED: 'v-badge-good',
  CANCELLED: 'v-badge',
  BLOCKED: 'v-badge-risk',
};

function lifecycleBadge(lifecycle: WorkspaceLifecycle): string {
  return `<span class="v-badge ${LIFECYCLE_TONE[lifecycle]}"><span class="dot"></span>${esc(lifecycle)}</span>`;
}

export function renderWorkflowListPage(
  items: WorkflowListItem[],
  opts: { home: string; csrf: string; actor: string },
): string {
  const rows =
    items.length === 0
      ? '<div class="v-empty"><h3>No release workflows yet</h3><p>Configure an evidence source, then start your first release workflow — its fan-out legs appear here.</p><p><a class="v-btn v-btn-secondary v-btn-sm" href="/setup">Configure a source</a></p></div>'
      : `<table><thead><tr><th>Release</th><th>Kind</th><th>State</th><th>Owner</th><th>Updated</th></tr></thead><tbody>${items
          .map(
            (w) =>
              `<tr><td><a href="${esc(w.url)}">${esc(w.subject)}</a><div class="sub">${esc(w.summary ?? '')}</div></td>
<td>${esc(w.kind)}</td>
<td>${lifecycleBadge(w.lifecycle)}</td>
<td>${esc(w.owner)}</td><td>${esc(w.updatedAt)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return pageShell(
    'Release workflows',
    `<p class="sub"><a href="${esc(opts.home)}">← Dashboard</a></p>
<h1>Release workflows</h1>
<p class="sub">Follow one release from source evidence to measured outcome.</p>
${rows}`,
  );
}

export function renderWorkflowDetailPage(
  view: WorkflowWorkspaceView,
  opts: { home: string; csrf: string; actor: string },
): string {
  const sources = view.sourceReceipts
    .map((s) => `<li><a href="${esc(s.url)}">${esc(s.id)}</a> · ${esc(s.status)} — ${esc(s.statement)}</li>`)
    .join('');
  const legs = view.legs
    .map(
      (l) =>
        `<tr><td>${esc(l.key)}</td><td>${esc(l.status)}${l.stalled ? ' <span class="v-badge v-badge-risk"><span class="dot"></span>stalled</span>' : ''}</td><td>${l.url ? `<a href="${esc(l.url)}">${esc(l.requestId ?? '')}</a>` : '—'}</td>
<td>${esc(l.requestState ?? '—')}</td><td>${l.decisionId ? `<a href="/console/decisions/${esc(encodeURIComponent(l.decisionId))}">${esc(l.decisionId)}</a>` : '—'}</td>
<td>${esc(l.reason ?? '')}</td></tr>`,
    )
    .join('');
  const stallHtml =
    view.stalledLegs.length === 0
      ? ''
      : `<div class="card" id="stalled-legs"><h2>Stalled legs</h2>
<p class="sub">These legs were approved and will not advance on their own — the executor that held them is gone, or none ever claimed them. Reclaiming releases the claim back to ADMITTED so an executor can pick the work up again.</p>
<ul>${view.stalledLegs.map((l) => `<li><strong>${esc(l.key)}</strong> — ${esc(l.detail ?? 'not advancing')}</li>`).join('')}</ul></div>`;
  const outcomes = view.outcomes.length
    ? view.outcomes
        .map(
          (o) =>
            `<li><strong>${esc(o.metric)}</strong>: actual ${o.actual}${o.predicted !== null ? ` (predicted ${o.predicted})` : ''} · basis ${esc(o.basis)}</li>`,
        )
        .join('')
    : '<li class="sub">No measured outcome yet</li>';
  const prereg = view.prereg
    ? `<p>Pre-registered ${esc(view.prereg.id)} by ${esc(view.prereg.agreedBy)} at ${esc(view.prereg.agreedAt)}</p>
<ul>${view.prereg.metrics.map((m) => `<li>${esc(m.name)} threshold ${m.threshold} (${m.direction ?? 'higher'})</li>`).join('')}</ul>`
    : '<p class="sub">Metrics not pre-registered yet.</p>';
  const replay = view.replay
    .map(
      (r) =>
        `<article><h3><a href="/console/decisions/${esc(encodeURIComponent(r.decisionId))}">${esc(r.decisionId)}</a></h3>
<p>${esc(r.goal)}</p>
<h4>Frozen evidence</h4><ul>${r.frozenClaims.map((c) => `<li>${esc(c.id)} · ${esc(c.status)} — ${esc(c.statement)}</li>`).join('')}</ul>
<h4>Drift since approval</h4><ul>${r.drift.map((d) => `<li>${esc(d.id)}: ${esc(d.frozenStatus)} → ${esc(d.currentStatus ?? 'missing')}${d.drifted ? ' <strong>drifted</strong>' : ''}</li>`).join('')}</ul></article>`,
    )
    .join('');
  const traces = view.traces.length
    ? `<ul>${view.traces
        .map(
          (t) =>
            `<li>${esc(t.id)} · ${esc(t.intent)} · ${esc(t.outcome)} · ${esc(t.tier)}${t.compilable ? ' · <em>eligible trace</em>' : ''}</li>`,
        )
        .join('')}</ul>`
    : '<p class="sub">No execution traces yet.</p>';
  const candidates = view.compilerCandidates.length
    ? `<ul>${view.compilerCandidates.map((c) => `<li>${esc(c.intent)} · ${c.repeats} successes · ${(c.successRate * 100).toFixed(0)}% rate — quarantine/transfer gates still apply</li>`).join('')}</ul>`
    : '<p class="sub">No compiler candidates from this workflow yet.</p>';

  const forms: string[] = [];
  if (view.canPreregister) {
    forms.push(`<section><h2>Pre-register metrics</h2>
<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/preregister">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>Metric name <input name="metric" required value="ship_to_launch_hours"></label>
<label>Threshold <input name="threshold" type="number" step="0.1" required value="24"></label>
<label>Baseline <input name="baseline" required placeholder="pre-pilot average hours"></label>
<label>Comparison basis <input name="comparisonBasis" required placeholder="holdout lane / segment split"></label>
<label>Window start <input name="windowStart" required value="${esc(new Date().toISOString().slice(0, 10))}"></label>
<label>Window end <input name="windowEnd" required value="${esc(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))}"></label>
<button type="submit">Pre-register</button></form></section>`);
  }
  if (view.canCaptureOutcome && view.replay[0]) {
    forms.push(`<section><h2>Capture outcome</h2>
<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/outcome">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="decisionId" value="${esc(view.replay[0]!.decisionId)}">
<label>Metric <input name="metric" required value="${esc(view.prereg?.metrics[0]?.name ?? 'ship_to_launch_hours')}"></label>
<label>Actual <input name="actual" type="number" step="0.1" required></label>
<label>Basis <input name="basis" required placeholder="measurement source URI or method"></label>
<label>Predicted <input name="predicted" type="number" step="0.1"></label>
<button type="submit">Record measured outcome</button></form>
<p class="sub">Execution complete ≠ business outcome verified. Outcomes require a pre-registered metric and explicit basis.</p></section>`);
  }
  if (view.canRetry) {
    const label = view.stalledLegs.length > 0 ? 'Reclaim stalled legs and resume' : 'Retry eligible legs';
    forms.push(`<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/retry" style="display:inline">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}"><button type="submit">${label}</button></form>`);
  }
  if (view.canCancel) {
    forms.push(`<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/cancel" style="display:inline;margin-left:8px">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input name="reason" required placeholder="cancellation reason" style="width:200px">
<button type="submit" class="v-btn v-btn-danger v-btn-sm">Cancel workflow</button></form>`);
  }

  let measurementNote = 'Measurement unsupported at this stage';
  if (view.measurementState === 'verified') {
    measurementNote = 'Business outcome verified';
  } else if (view.measurementState === 'pending') {
    measurementNote = 'Execution complete — measurement pending';
  } else if (view.measurementState === 'unknown') {
    measurementNote = 'Outcome state unknown — pre-register before measuring';
  }

  return pageShell(
    `Workflow ${view.subject}`,
    `<p class="sub"><a href="${esc(opts.home)}">← Dashboard</a> · <a href="/console/workflows">All workflows</a></p>
<h1>${esc(view.subject)}</h1>
<p>${lifecycleBadge(view.lifecycle)}
<span class="v-sub">· ${esc(measurementNote)} · owner ${esc(view.owner)} · updated ${esc(view.updatedAt)}</span></p>
${view.summary ? `<p>${esc(view.summary)}</p>` : ''}
${view.blocker ? `<p class="err">Blocker: ${esc(view.blocker)}</p>` : ''}
${view.nextAction ? `<p><strong>Next:</strong> ${esc(view.nextAction)}</p>` : ''}
${view.cancelled ? `<p class="err">Cancelled: ${esc(view.cancelReason ?? 'no reason recorded')}</p>` : ''}
${stallHtml}
<div class="card"><h2>Source evidence</h2><ul>${sources || '<li class="sub">No source claims linked</li>'}</ul></div>
<div class="card"><h2>Fan-out legs</h2>
<p class="sub">Fan-out status: ${esc(view.fanoutStatus ?? 'n/a')}${view.releaseStage ? ` · release stage ${esc(view.releaseStage.stage)}` : ''}</p>
<table><thead><tr><th>Leg</th><th>Status</th><th>Request</th><th>Request state</th><th>Decision</th><th>Reason</th></tr></thead><tbody>${legs || '<tr><td colspan="6" class="sub">No legs</td></tr>'}</tbody></table></div>
<div class="card"><h2>Pre-registration</h2>${prereg}</div>
<div class="card"><h2>Outcomes</h2><ul>${outcomes}</ul></div>
<div class="card"><h2>Replay (frozen vs current)</h2>${replay || '<p class="sub">No decisions to replay yet.</p>'}</div>
<div class="card"><h2>Procedure traces</h2>${traces}${candidates}</div>
${forms.join('\n')}`,
  );
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Vital</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* Layout only — color, radius and shadow come from the token system. */
body{margin:0 auto;padding:26px 20px 48px;max-width:1020px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid var(--v-line);padding:10px 14px;text-align:left}
th{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--v-muted)}
label{display:block;margin:8px 0;font-size:12.5px;font-weight:600;color:var(--v-muted)}
</style></head><body><a class="skip-link" href="#main">Skip to main content</a><main id="main">${body}</main></body></html>`;
}
