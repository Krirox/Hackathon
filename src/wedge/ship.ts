import type { AsyncDb } from '../core/db.ts';
import type { Ledger, OutcomeRecord } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter, HarnessOutcome } from '../substrate/harness.ts';
import { actReversible, type ActReceipt } from '../gov/act.ts';
import {
  advanceFanOutWorkflow,
  createFanOutWorkflowRun,
  loadFanOutRun,
  requireCompleteFanOut,
  saveFanOutRun,
  shipLegIds,
  shipLegTemplates,
  stableFanOutRunId,
  type FanOutWorkflowRun,
} from './fanout-workflow.ts';
import { persistDeliverableVersion } from './deliverable-artifact.ts';

/**
 * Wedge: Ship-to-Result, phases 2.1–2.3 plus the closed execution loop.
 *
 * What lives here is the coordination and outcome half of the loop:
 * 1. Turn release OBSERVATIONs into an evidence-backed change summary.
 * 2. Ground customer segmentation alongside internal affected scopes.
 * 3. Fan work out to five teams as typed REQUESTs through the scheduler.
 * 4. Execute release deliverables via harness adapters.
 * 5. Check human-facing drafts against the Ledger and denylist before publishing.
 * 6. Record human approval DECISIONs with frozen Context Bundles.
 * 7. Execute reversible publication actions with concrete receipts.
 * 8. Measure real business OUTCOMEs against comparison bases.
 * 9. Durable stage progression and multi-department deliverable join.
 */

export class WedgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[wedge:${code}] ${message}`);
  }
}

export interface ChangeItem {
  text: string;
  /** Every bullet cites its evidence — an uncited sentence is a bug. */
  claimIds: string[];
}

export interface CustomerSegment {
  id: string;
  name: string;
  tier: string;
  impact: string;
  rationale: string;
  region?: string;
}

export interface ChangeSummary {
  release: string;
  whatChanged: ChangeItem[];
  affected: string[];
  whyItMatters: string;
  sources: { claimId: string; uri: string; tier: string }[];
  confidence: number;
  summaryFingerprint: string;
  customerSegments: CustomerSegment[];
}

/**
 * Evidence-backed change summary (2.1). Deterministic assembly, not prose
 * generation: each bullet is built FROM cited claims, and any bullet whose
 * citations do not resolve to live claims is refused rather than softened.
 */
export async function summarizeRelease(
  ledger: Ledger,
  tenant: string,
  release: string,
  items: { text: string; claimIds: string[]; affected: string[] }[],
  now: string,
  customerSegments?: CustomerSegment[],
): Promise<ChangeSummary> {
  if (items.length === 0) throw new WedgeError('EMPTY_RELEASE', 'a release with no cited changes is not a summary');
  const whatChanged: ChangeItem[] = [];
  const affected = new Set<string>();
  const sources: ChangeSummary['sources'] = [];
  let confSum = 0;
  let confN = 0;
  for (const it of items) {
    if (it.claimIds.length === 0) {
      throw new WedgeError('UNCITED_SENTENCE', `change item cites nothing: "${it.text}"`);
    }
    const live = await ledger.contextFor(tenant, it.claimIds, now);
    const liveIds = new Set(live.map((c) => c.id));
    const missing = it.claimIds.filter((id) => !liveIds.has(id));
    if (missing.length > 0) {
      throw new WedgeError(
        'UNVERIFIABLE_CITATION',
        `"${it.text}" cites ${missing.join(', ')} — stale, disputed, provisional, or unknown`,
      );
    }
    whatChanged.push({ text: it.text, claimIds: it.claimIds });
    for (const c of live) {
      sources.push({ claimId: c.id, uri: c.provenance.sourceUri, tier: c.provenance.sourceTier });
      confSum += c.confidence;
      confN += 1;
      affected.add(c.scope);
    }
    for (const a of it.affected) affected.add(a);
  }
  const fp = `release:${release}:${whatChanged.map((w) => w.text).join('|')}`;
  const resolvedSegments: CustomerSegment[] =
    customerSegments && customerSegments.length > 0
      ? customerSegments
      : [...affected].map((scope) => ({
          id: `seg:${scope}`,
          name: `${scope.toUpperCase()} Segment`,
          tier: 'STANDARD',
          impact: `Directly affected by changes in ${scope}`,
          rationale: `Grounded in affected release scope: ${scope}`,
        }));

  return {
    release,
    whatChanged,
    affected: [...affected],
    whyItMatters: `${whatChanged.length} verified change(s) across ${affected.size} scope(s)`,
    sources,
    confidence: confN === 0 ? 0 : confSum / confN,
    summaryFingerprint: fp,
    customerSegments: resolvedSegments,
  };
}

/** Novelty check vs the Ledger: don't re-summarise a re-deploy. Scoped by tenant with legacy fallback. */
export async function isKnownRelease(db: AsyncDb, fingerprint: string, tenant?: string): Promise<boolean> {
  const key = tenant ? `wedge:summary:${tenant}:${fingerprint}` : `wedge:summary:${fingerprint}`;
  let r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  if (!r && tenant) {
    // Legacy fallback for records stored before tenant-scoping
    r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`wedge:summary:${fingerprint}`)) as
      { value: string } | undefined;
  }
  return !!r;
}

export async function markReleaseKnown(
  db: AsyncDb,
  fingerprint: string,
  summaryId: string,
  tenant?: string,
): Promise<void> {
  const key = tenant ? `wedge:summary:${tenant}:${fingerprint}` : `wedge:summary:${fingerprint}`;
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, summaryId);
}

export type ReleaseStage =
  'SUMMARIZED' | 'DISPATCHED' | 'DELIVERED' | 'VERIFIED' | 'APPROVED' | 'EXECUTED' | 'MEASURED';

export interface ReleaseStageRecord {
  tenant: string;
  releaseId: string;
  stage: ReleaseStage;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export async function recordReleaseStage(
  db: AsyncDb,
  tenant: string,
  releaseId: string,
  stage: ReleaseStage,
  now: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const key = `wedge:stage:${tenant}:${releaseId}`;
  const record: ReleaseStageRecord = { tenant, releaseId, stage, updatedAt: now, metadata };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(record));
}

export async function getReleaseStage(
  db: AsyncDb,
  tenant: string,
  releaseId: string,
): Promise<ReleaseStageRecord | null> {
  const key = `wedge:stage:${tenant}:${releaseId}`;
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.value) as ReleaseStageRecord;
  } catch {
    return null;
  }
}

export interface FanOutResult {
  marketing: string;
  customer: string;
  sales: string;
  product: string;
  finance: string;
}

/**
 * Dedupe-hit legs are COMPLETED-with-result, never refusal (why this helper
 * exists: the coordinator answers an identical re-submission with
 * `admitted:false + dedupedTo`, and the old fan-out threw FANOUT_REFUSED on
 * exactly that path — so a retried release died on work that already
 * existed). A dedupe hit reuses the existing leg's id; only genuine denials
 * (budget, capacity, escalation cap — no `dedupedTo`) still refuse.
 */
export function reuseDedupedOrThrow(
  r: { admitted: boolean; state: string; reason: string; request: { id: string }; dedupedTo?: string },
  originScope: string,
  targetScope: string,
): string {
  if (r.admitted) return r.request.id;
  if (r.dedupedTo) return r.dedupedTo;
  throw new WedgeError('FANOUT_REFUSED', `${originScope}→${targetScope} ${r.state}: ${r.reason}`);
}

/**
 * FLOW-013: durable partial fan-out — parent run id exists before any leg
 * is submitted; each leg is checkpointed; partial progress survives refusal.
 */
export async function fanOutWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  tenant: string,
  input: {
    release: string;
    claimIds: string[];
    onBehalfOf: string;
    now: string;
    summary: string;
    runId?: string;
    resume?: boolean;
  },
): Promise<FanOutWorkflowRun> {
  const runId = input.runId ?? stableFanOutRunId(tenant, 'ship', input.release, input.claimIds);
  let run = await loadFanOutRun(db, tenant, runId);
  if (!run) {
    run = createFanOutWorkflowRun({
      tenant,
      kind: 'ship',
      subject: input.release,
      claimIds: input.claimIds,
      onBehalfOf: input.onBehalfOf,
      now: input.now,
      summary: input.summary,
      legs: shipLegTemplates(input.release, input.summary),
      runId,
    });
    await saveFanOutRun(db, run);
  }
  return advanceFanOutWorkflow(db, coord, run, { readmitDeferred: true, retryBlocked: true });
}

export async function resumeFanOutWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  tenant: string,
  runId: string,
  opts: { retryBlocked?: boolean } = {},
): Promise<FanOutWorkflowRun> {
  const run = await loadFanOutRun(db, tenant, runId);
  if (!run) throw new WedgeError('UNKNOWN_FANOUT_RUN', `no fan-out workflow ${runId}`);
  return advanceFanOutWorkflow(db, coord, run, {
    readmitDeferred: true,
    retryBlocked: opts.retryBlocked ?? false,
  });
}

export async function getFanOutWorkflow(
  db: AsyncDb,
  tenant: string,
  runId: string,
): Promise<FanOutWorkflowRun | null> {
  return loadFanOutRun(db, tenant, runId);
}

/**
 * Fan-out (2.2): one release → five typed coordination objects, ALL through
 * the scheduler. No direct channel posts exist as a code path.
 *
 * When `db` is provided, runs the durable FLOW-013 workflow and throws only
 * if a leg is terminally refused (legacy all-or-nothing callers). Without
 * `db`, submits inline and throws on the first refusal — tests only.
 */
export async function fanOut(
  coord: Coordinator,
  tenant: string,
  input: {
    release: string;
    claimIds: string[];
    onBehalfOf: string;
    now: string;
    summary: string;
  },
  db?: AsyncDb,
): Promise<FanOutResult> {
  if (db) {
    const run = await fanOutWorkflow(db, coord, tenant, input);
    requireCompleteFanOut(run);
    return shipLegIds(run);
  }
  const req = async (
    originScope: string,
    targetScope: string,
    messageClass: 'REQUEST' | 'QUERY',
    goal: string,
    deliverableSchema: string,
    humanMinutes: number,
  ) => {
    const r = await coord.submit({
      tenant,
      messageClass,
      originScope,
      targetScope,
      goal,
      claimRefs: input.claimIds,
      deliverableSchema,
      bid: { humanMinutes },
      onBehalfOf: input.onBehalfOf,
      now: input.now,
    });
    return reuseDedupedOrThrow(r, originScope, targetScope);
  };
  const brief = `${input.release}: ${input.summary}`;
  return {
    marketing: await req(
      'product',
      'marketing',
      'REQUEST',
      `launch narrative + blog + in-app copy — ${brief}`,
      'launch-pack.v1',
      15,
    ),
    customer: await req(
      'product',
      'customer',
      'REQUEST',
      `support macro + FAQ + churn-risk segment — ${brief}`,
      'support-pack.v1',
      15,
    ),
    sales: await req('product', 'sales', 'REQUEST', `battlecard + objection handling — ${brief}`, 'battlecard.v1', 10),
    product: await req(
      'engineering',
      'product',
      'QUERY',
      `does this close a known pain pattern? — ${brief}`,
      'pain-link.v1',
      0,
    ),
    finance: await req(
      'product',
      'finance',
      'REQUEST',
      `budget headroom for paid launch — ${brief}`,
      'budget-check.v1',
      10,
    ),
  };
}

/** Regulated-claim denylist: these phrases force human review, always. */
const DENYLIST = [
  /\bguarantee[sd]?\b/i,
  /\b\d+%\s*(returns|profit|uptime|effective|cure)\b/i,
  /\b(fda|sec|hipaa|gdpr)\s*(approved|compliant|certified)\b/i,
  /\brisk-?free\b/i,
  /\bno\s+side\s+effects\b/i,
  /\bbest\s+in\s+(the\s+world|class)\b/i,
];

export interface DraftCheck {
  ok: boolean;
  /** Cited claims that are not VERIFIED/live — each one blocks. */
  unverified: string[];
  /** Denylist hits — each one forces a human. */
  deniedPhrases: string[];
}

/** Claims checker (2.3): drafts ship evidence or they do not ship. */
export async function checkDraft(
  ledger: Ledger,
  tenant: string,
  draft: { text: string; claimIds: string[] },
  now: string,
): Promise<DraftCheck> {
  const live = new Set((await ledger.contextFor(tenant, draft.claimIds, now)).map((c) => c.id));
  const unverified = draft.claimIds.filter((id) => !live.has(id));
  const deniedPhrases = DENYLIST.filter((re) => re.test(draft.text)).map((re) => String(re));
  return { ok: unverified.length === 0 && deniedPhrases.length === 0, unverified, deniedPhrases };
}

export interface ProduceReleaseAssetInput {
  releaseId: string;
  scope: string;
  goal: string;
  deliverableSchema: string;
  claimIds: string[];
  onBehalfOf: string;
  approvedBy: string;
  command: string;
  now?: string;
  requestId?: string;
  draftText?: string;
  maxDollars?: number;
  maxTokens?: number;
  measurement?: {
    metric: string;
    predicted?: number;
    actual: number;
    basis: string;
    holdoutRef?: string;
    resolvedBy?: string;
  };
  executeAction?: () => Promise<ActReceipt> | ActReceipt;
}

export interface ProducedReleaseAsset {
  releaseId: string;
  requestId: string;
  decisionId: string;
  draftCheck: DraftCheck;
  outcome: HarnessOutcome;
  actionClaimId: string;
  actionReceipt?: ActReceipt;
  measuredOutcome: OutcomeRecord;
  stage: 'MEASURED';
}

/**
 * Closed-loop single asset production:
 * 1. Dispatch/ensure admitted coordination request.
 * 2. Execute deliverable production via harness adapter.
 * 3. Run claims checker against draft and fail closed on unverified or denied claims.
 * 4. Record human approval decision with frozen Context Bundle.
 * 5. Publish reversible action via actReversible with concrete execution receipt.
 * 6. Record verified business outcome against comparison basis.
 * 7. Advance durable stage to MEASURED.
 */
export async function produceReleaseAsset(
  coord: Coordinator,
  ledger: Ledger,
  adapter: HarnessAdapter,
  tenant: string,
  input: ProduceReleaseAssetInput,
  db?: AsyncDb,
): Promise<ProducedReleaseAsset> {
  const now = input.now ?? new Date().toISOString();
  if (input.claimIds.length === 0) {
    throw new WedgeError('UNGROUNDED_ASSET', 'release asset request cites no claims');
  }

  // 1. Dispatch request
  let requestId = input.requestId;
  if (!requestId) {
    const res = await coord.submit({
      tenant,
      messageClass: 'REQUEST',
      originScope: 'product',
      targetScope: input.scope,
      goal: input.goal,
      claimRefs: input.claimIds,
      deliverableSchema: input.deliverableSchema,
      bid: { humanMinutes: 15 },
      onBehalfOf: input.onBehalfOf,
      now,
    });
    requestId = reuseDedupedOrThrow(res, 'product', input.scope);
  }

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'DISPATCHED', now, { requestId, scope: input.scope });
  }

  // 2. Harness execution
  const outcome = await adapter.run(tenant, requestId, {
    command: input.command,
    claimRefs: input.claimIds,
    onBehalfOf: input.onBehalfOf,
    maxDollars: input.maxDollars ?? 10,
    maxTokens: input.maxTokens ?? 10000,
  });

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'DELIVERED', now, {
      requestId,
      status: outcome.status,
    });
  }

  // 3. Draft check + versioned artifact persistence (FLOW-014)
  const draftText = input.draftText ?? (outcome.transcript.length > 0 ? outcome.transcript : input.command);
  const verdict = await checkDraft(ledger, tenant, { text: draftText, claimIds: input.claimIds }, now);
  let deliverableVersionId: string | null = null;
  let deliverableFingerprint: string | null = null;
  if (db) {
    const stored = await persistDeliverableVersion(db, ledger, {
      tenant,
      requestId,
      deliverableSchema: input.deliverableSchema,
      content: draftText,
      claimIds: input.claimIds,
      createdBy: input.onBehalfOf,
      now,
    });
    deliverableVersionId = stored.id;
    deliverableFingerprint = stored.fingerprint;
  }
  if (!verdict.ok) {
    const reasons = [...verdict.unverified, ...verdict.deniedPhrases].join(', ');
    throw new WedgeError('DRAFT_BLOCKED', `draft failed the claims checker: ${reasons}`);
  }

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'VERIFIED', now, {
      requestId,
      deliverableVersionId,
      deliverableFingerprint,
    });
  }

  // 4. Human approval decision — includes reviewed asset fingerprint when persisted
  const decision = await ledger.recordDecision({
    tenant,
    goal: input.goal,
    action: JSON.stringify({
      approvalStage: 'final-deliverable',
      releaseId: input.releaseId,
      scope: input.scope,
      deliverableVersionId,
      fingerprint: deliverableFingerprint,
      artifactAction: `publish release asset for ${input.releaseId} [scope:${input.scope}]`,
    }),
    actionClass: 'ACT_REVERSIBLE',
    claimIds: input.claimIds,
    decidedBy: input.onBehalfOf,
    approvedBy: input.approvedBy,
    scope: input.scope,
    autonomy: 'approval',
    requestId,
    now,
  });

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'APPROVED', now, {
      requestId,
      decisionId: decision.id,
    });
  }

  // 5. Action publication receipt via actReversible
  const defaultExecute = () => ({
    executed: true,
    receiptId: `rcpt_${crypto.randomUUID()}`,
    output: { releaseId: input.releaseId, scope: input.scope, published: true },
  });
  const actResult = await actReversible(ledger, 'autonomous', [`human approved in decision:${decision.id}`], {
    tenant,
    scope: input.scope,
    kind: 'flag',
    detail: `publish release asset for ${input.releaseId} [scope:${input.scope}]`,
    by: input.approvedBy,
    claimIds: input.claimIds,
    now,
    execute: input.executeAction ?? defaultExecute,
  });

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'EXECUTED', now, {
      requestId,
      decisionId: decision.id,
      actionClaimId: actResult.claimId,
    });
  }

  // 6. Measured business outcome
  const measurement = input.measurement ?? {
    metric: 'release_readiness_hours',
    predicted: 24,
    actual: 4,
    basis: 'pre-release smoke checklist benchmark',
  };

  const measuredOutcome = await ledger.recordOutcome({
    tenant,
    decisionId: decision.id,
    metric: measurement.metric,
    predicted: measurement.predicted,
    actual: measurement.actual,
    basis: measurement.basis,
    holdoutRef: measurement.holdoutRef,
    resolvedBy: measurement.resolvedBy ?? input.approvedBy,
    owner: input.onBehalfOf,
    scope: input.scope,
    now,
  });

  // 7. Update stage to MEASURED
  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'MEASURED', now, {
      requestId,
      decisionId: decision.id,
      actionClaimId: actResult.claimId,
      outcomeId: measuredOutcome.id,
    });
  }

  return {
    releaseId: input.releaseId,
    requestId,
    decisionId: decision.id,
    draftCheck: verdict,
    outcome,
    actionClaimId: actResult.claimId,
    actionReceipt: actResult.receipt,
    measuredOutcome,
    stage: 'MEASURED',
  };
}

export interface JoinReleaseDeliverablesInput {
  releaseId: string;
  summary: ChangeSummary;
  legs: FanOutResult;
  onBehalfOf: string;
  approvedBy: string;
  now?: string;
  deliverables?: Partial<
    Record<
      'marketing' | 'customer' | 'sales' | 'product' | 'finance',
      {
        command?: string;
        draftText?: string;
        measurement?: { metric: string; predicted?: number; actual: number; basis: string; holdoutRef?: string };
        executeAction?: () => Promise<ActReceipt> | ActReceipt;
      }
    >
  >;
}

export interface LaunchPack {
  release: string;
  summary: ChangeSummary;
  legs: FanOutResult;
  deliverables: Record<'marketing' | 'customer' | 'sales' | 'product' | 'finance', ProducedReleaseAsset>;
  assembledAt: string;
  allVerified: boolean;
}

const DEPT_CONFIGS: Record<
  'marketing' | 'customer' | 'sales' | 'product' | 'finance',
  { deliverableSchema: string; defaultCommand: string }
> = {
  marketing: {
    deliverableSchema: 'launch-pack.v1',
    defaultCommand: 'generate launch narrative and customer-facing blog copy',
  },
  customer: {
    deliverableSchema: 'support-pack.v1',
    defaultCommand: 'generate customer support macros and churn mitigation playbook',
  },
  sales: {
    deliverableSchema: 'battlecard.v1',
    defaultCommand: 'generate sales battlecard and objection responses',
  },
  product: {
    deliverableSchema: 'pain-link.v1',
    defaultCommand: 'link release features to verified customer pain patterns',
  },
  finance: {
    deliverableSchema: 'budget-check.v1',
    defaultCommand: 'evaluate launch spend headroom and unit economics',
  },
};

export async function joinReleaseDeliverables(
  coord: Coordinator,
  ledger: Ledger,
  adapter: HarnessAdapter,
  tenant: string,
  input: JoinReleaseDeliverablesInput,
  db?: AsyncDb,
): Promise<LaunchPack> {
  const now = input.now ?? new Date().toISOString();
  const claimIds = input.summary.whatChanged.flatMap((w) => w.claimIds);
  const departments: ('marketing' | 'customer' | 'sales' | 'product' | 'finance')[] = [
    'marketing',
    'customer',
    'sales',
    'product',
    'finance',
  ];

  const deliverables = {} as Record<'marketing' | 'customer' | 'sales' | 'product' | 'finance', ProducedReleaseAsset>;

  for (const dept of departments) {
    const cfg = DEPT_CONFIGS[dept];
    const custom = input.deliverables?.[dept];
    const asset = await produceReleaseAsset(
      coord,
      ledger,
      adapter,
      tenant,
      {
        releaseId: input.releaseId,
        scope: dept,
        goal: `${dept} deliverable for ${input.releaseId}`,
        deliverableSchema: cfg.deliverableSchema,
        claimIds,
        onBehalfOf: input.onBehalfOf,
        approvedBy: input.approvedBy,
        command: custom?.command ?? cfg.defaultCommand,
        requestId: input.legs[dept],
        draftText: custom?.draftText,
        measurement: custom?.measurement,
        executeAction: custom?.executeAction,
        now,
      },
      db,
    );
    deliverables[dept] = asset;
  }

  const allVerified = Object.values(deliverables).every((d) => d.draftCheck.ok);

  if (db) {
    await recordReleaseStage(db, tenant, input.releaseId, 'DELIVERED', now, {
      allVerified,
      deliverables: Object.keys(deliverables),
    });
  }

  return {
    release: input.releaseId,
    summary: input.summary,
    legs: input.legs,
    deliverables,
    assembledAt: now,
    allVerified,
  };
}
