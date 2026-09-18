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

async function hydrateLeg(
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  leg: FanOutLegRecord,
): Promise<WorkflowLegView> {
  let requestState: string | null = null;
  let decisionId: string | null = null;
  if (leg.requestId) {
    const req = await coord.get(tenant, leg.requestId);
    requestState = req?.state ?? null;
    const dec = await ledger.getDecisionByRequest(tenant, leg.requestId);
    decisionId = dec?.id ?? null;
  }
  return {
    key: leg.key,
    goal: leg.goal,
    status: leg.status,
    requestId: leg.requestId,
    requestState,
    decisionId,
    reason: leg.reason,
    url: leg.requestId ? `/console/requests/${encodeURIComponent(leg.requestId)}` : null,
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
  const legs = run ? await Promise.all(run.legs.map((l) => hydrateLeg(coord, ledger, tenant, l))) : [];
  const decisionIds = [
    ...(run?.decisionId ? [run.decisionId] : []),
    ...legs.map((l) => l.decisionId).filter((d): d is string => Boolean(d)),
    ...(overlay?.feature?.decisionId ? [overlay.feature.decisionId] : []),
  ];
  const uniqueDecisionIds = [...new Set(decisionIds)];
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
    canRetry: Boolean(run && !overlay?.cancelledAt && (run.status === 'PARTIAL' || run.status === 'BLOCKED')),
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

export async function retryWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  tenant: string,
  workflowId: string,
  opts: { retryBlocked?: boolean } = {},
): Promise<FanOutWorkflowRun> {
  const overlay = await loadWorkspaceOverlay(db, tenant, workflowId);
  if (overlay?.cancelledAt) throw new Error('cannot retry a cancelled workflow');
  return resumeFanOutWorkflow(db, coord, tenant, workflowId, opts);
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

const LIFECYCLE_COLOR: Record<WorkspaceLifecycle, string> = {
  SOURCED: '#6B7280',
  FAN_OUT: '#4338CA',
  EXECUTING: '#4338CA',
  EXECUTION_COMPLETE: '#B45309',
  MEASUREMENT_PENDING: '#B45309',
  OUTCOME_VERIFIED: '#0F7A3D',
  CANCELLED: '#6B7280',
  BLOCKED: '#B91C1C',
};

export function renderWorkflowListPage(
  items: WorkflowListItem[],
  opts: { home: string; csrf: string; actor: string },
): string {
  const rows =
    items.length === 0
      ? '<p class="sub">No release workflows yet. <a href="/setup">Configure a source</a> and start your first release workflow.</p>'
      : `<table><thead><tr><th>Release</th><th>Kind</th><th>State</th><th>Owner</th><th>Updated</th></tr></thead><tbody>${items
          .map(
            (w) =>
              `<tr><td><a href="${esc(w.url)}">${esc(w.subject)}</a><div class="sub">${esc(w.summary ?? '')}</div></td>
<td>${esc(w.kind)}</td>
<td><span style="color:${LIFECYCLE_COLOR[w.lifecycle]}">${esc(w.lifecycle)}</span></td>
<td>${esc(w.owner)}</td><td>${esc(w.updatedAt)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return pageShell(
    'Release workflows',
    `<p class="sub"><a href="${esc(opts.home)}">← Dashboard</a></p>
<h1>Release workflows</h1>
<p class="sub">Signed in as ${esc(opts.actor)}. Follow one release from source evidence to measured outcome.</p>
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
        `<tr><td>${esc(l.key)}</td><td>${esc(l.status)}</td><td>${l.url ? `<a href="${esc(l.url)}">${esc(l.requestId ?? '')}</a>` : '—'}</td>
<td>${esc(l.requestState ?? '—')}</td><td>${l.decisionId ? `<a href="/console/decisions/${esc(encodeURIComponent(l.decisionId))}">${esc(l.decisionId)}</a>` : '—'}</td>
<td>${esc(l.reason ?? '')}</td></tr>`,
    )
    .join('');
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
    forms.push(`<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/retry" style="display:inline">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}"><button type="submit">Retry eligible legs</button></form>`);
  }
  if (view.canCancel) {
    forms.push(`<form method="post" action="/console/workflows/${esc(encodeURIComponent(view.id))}/cancel" style="display:inline;margin-left:8px">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input name="reason" required placeholder="cancellation reason" style="width:200px">
<button type="submit" style="background:#B91C1C">Cancel workflow</button></form>`);
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
<p><span style="color:${LIFECYCLE_COLOR[view.lifecycle]};font-weight:700">${esc(view.lifecycle)}</span>
· ${esc(measurementNote)} · owner ${esc(view.owner)} · updated ${esc(view.updatedAt)}</p>
${view.summary ? `<p>${esc(view.summary)}</p>` : ''}
${view.blocker ? `<p class="err">Blocker: ${esc(view.blocker)}</p>` : ''}
${view.nextAction ? `<p><strong>Next:</strong> ${esc(view.nextAction)}</p>` : ''}
${view.cancelled ? `<p class="err">Cancelled: ${esc(view.cancelReason ?? 'no reason recorded')}</p>` : ''}
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
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#0A0F14;margin:0;padding:24px;max-width:960px}
.sub{color:#6B7280;font-size:12px}.err{color:#B91C1C}.card{border:1px solid #E4E4E1;border-radius:10px;padding:16px;background:#fff;margin:16px 0}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #E4E4E1;padding:8px;text-align:left;font-size:14px}
input,button{padding:8px;border:1px solid #E4E4E1;border-radius:6px}button{background:#0F5C57;color:#fff;font-weight:600;cursor:pointer;border:0}
label{display:block;margin:8px 0}</style></head><body>${body}</body></html>`;
}
