import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter, HarnessOutcome } from '../substrate/harness.ts';
import { checkDraft, reuseDedupedOrThrow, WedgeError, type DraftCheck } from './ship.ts';
import {
  advanceFanOutWorkflow,
  churnLegIds,
  churnLegTemplates,
  createFanOutWorkflowRun,
  loadFanOutRun,
  requireCompleteFanOut,
  saveFanOutRun,
  stableFanOutRunId,
  type FanOutWorkflowRun,
} from './fanout-workflow.ts';

/**
 * Second workflow (TODO §8, earliest slice): churn-response.
 *
 * The point is not churn playbooks — it is proving multi-workflow Ledger
 * coherence: two loops (releases + churn) sharing one tenant, one reality,
 * with distinct Context Bundles that replay independently. Same primitives
 * as Ship-to-Result (grounded REQUESTs, no direct posts, decision +
 * bundle), different shape of work.
 */

export interface ChurnResponse {
  decisionId: string;
  productQueryId: string;
  outreachRequestId: string;
  offerRequestId: string;
}

async function validateChurnRiskClaims(
  ledger: Ledger,
  tenant: string,
  riskClaimIds: string[],
  now: string,
): Promise<void> {
  if (riskClaimIds.length === 0) {
    throw new WedgeError('UNGROUNDED_LOOP', 'a churn loop with no cited risk pattern is refused');
  }
  const UNUSABLE = ['STALE', 'DISPUTED', 'SUPERSEDED', 'RETIRED'] as const;
  const bad: string[] = [];
  for (const id of riskClaimIds) {
    const c = await ledger.get(tenant, id);
    if (!c) {
      bad.push(id);
      continue;
    }
    if ((UNUSABLE as readonly string[]).includes(c.status)) bad.push(id);
    else if (c.validUntil && c.validUntil <= now) bad.push(id);
  }
  if (bad.length > 0) {
    throw new WedgeError(
      'UNVERIFIABLE_CITATION',
      `churn risk cites ${bad.join(', ')} — stale, disputed, superseded, or unknown`,
    );
  }
}

async function ensureChurnDecision(db: AsyncDb, ledger: Ledger, run: FanOutWorkflowRun): Promise<FanOutWorkflowRun> {
  if (run.decisionId) return run;
  if (run.status !== 'COMPLETE') return run;
  const firstLeg = run.legs.length > 0 ? run.legs[0]! : null;
  let firstRequestId: string | null = null;
  if (firstLeg !== null) {
    firstRequestId = firstLeg.requestId;
  }
  const decision = await ledger.recordDecision({
    tenant: run.tenant,
    goal: `respond to churn risk in ${run.subject}`,
    action: JSON.stringify({ loop: 'churn-response', fanOutRunId: run.id, segment: run.subject }),
    actionClass: 'RECOMMEND',
    claimIds: run.claimIds,
    decidedBy: run.onBehalfOf,
    scope: 'customer',
    autonomy: 'approval',
    requestId: firstRequestId,
    now: run.now,
  });
  const updated = { ...run, decisionId: decision.id, updatedAt: new Date().toISOString() };
  await saveFanOutRun(db, updated);
  return updated;
}

/**
 * FLOW-013: durable churn fan-out with stable run + decision identity.
 */
export async function churnRespondWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  input: { segment: string; riskClaimIds: string[]; onBehalfOf: string; now: string; runId?: string },
): Promise<FanOutWorkflowRun> {
  await validateChurnRiskClaims(ledger, tenant, input.riskClaimIds, input.now);
  const runId = input.runId ?? stableFanOutRunId(tenant, 'churn', input.segment, input.riskClaimIds);
  let run = await loadFanOutRun(db, tenant, runId);
  if (!run) {
    run = createFanOutWorkflowRun({
      tenant,
      kind: 'churn',
      subject: input.segment,
      claimIds: input.riskClaimIds,
      onBehalfOf: input.onBehalfOf,
      now: input.now,
      legs: churnLegTemplates(input.segment),
      runId,
    });
    await saveFanOutRun(db, run);
  }
  run = await advanceFanOutWorkflow(db, coord, run, { readmitDeferred: true, retryBlocked: true });
  return ensureChurnDecision(db, ledger, run);
}

export async function churnRespond(
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  input: { segment: string; riskClaimIds: string[]; onBehalfOf: string; now: string },
  db?: AsyncDb,
): Promise<ChurnResponse> {
  await validateChurnRiskClaims(ledger, tenant, input.riskClaimIds, input.now);
  if (db) {
    const run = await churnRespondWorkflow(db, coord, ledger, tenant, input);
    requireCompleteFanOut(run);
    if (!run.decisionId) throw new WedgeError('INCOMPLETE_FANOUT', 'churn workflow completed without a decision');
    const legs = churnLegIds(run);
    return { decisionId: run.decisionId, ...legs };
  }
  const leg = async (
    originScope: string,
    targetScope: string,
    messageClass: 'REQUEST' | 'QUERY',
    goal: string,
    deliverableSchema: string,
    humanMinutes: number,
  ): Promise<string> => {
    const r = await coord.submit({
      tenant,
      messageClass,
      originScope,
      targetScope,
      goal,
      claimRefs: input.riskClaimIds,
      deliverableSchema,
      bid: { humanMinutes },
      onBehalfOf: input.onBehalfOf,
      now: input.now,
    });
    return reuseDedupedOrThrow(r, originScope, targetScope);
  };
  const brief = `churn risk in ${input.segment}`;
  const productQueryId = await leg(
    'customer',
    'product',
    'QUERY',
    `does this match a known pain pattern? — ${brief}`,
    'pain-link.v1',
    0,
  );
  const outreachRequestId = await leg(
    'product',
    'customer',
    'REQUEST',
    `save play for ${input.segment} — ${brief}`,
    'save-play.v1',
    10,
  );
  const offerRequestId = await leg(
    'product',
    'marketing',
    'REQUEST',
    `retention offer copy for ${input.segment} — ${brief}`,
    'offer-copy.v1',
    10,
  );
  const decision = await ledger.recordDecision({
    tenant,
    goal: `respond to churn risk in ${input.segment}`,
    action: 'churn-response loop',
    actionClass: 'RECOMMEND',
    claimIds: input.riskClaimIds,
    decidedBy: input.onBehalfOf,
    scope: 'customer',
    autonomy: 'approval',
    now: input.now,
  });
  return { decisionId: decision.id, productQueryId, outreachRequestId, offerRequestId };
}

export interface CompletedChurnPlay {
  decisionId: string;
  productQueryId: string;
  outreachRequestId: string;
  offerRequestId: string;
  investigationOutcome: HarnessOutcome;
  savePlayDraft: string;
  savePlayCheck: DraftCheck;
  offerCopyDraft: string;
  offerCopyCheck: DraftCheck;
  executedAt: string;
  status: 'COMPLETED';
  fanOutRunId: string | null;
  recommendationDecisionId: string | null;
}

export interface ExecuteChurnPlayInput {
  segment: string;
  riskClaimIds: string[];
  onBehalfOf: string;
  approvedBy: string;
  now?: string;
  investigationCommand?: string;
  savePlayCommand?: string;
  offerCopyCommand?: string;
  savePlayDraftText?: string;
  offerCopyDraftText?: string;
  draftClaimIds?: string[];
}

/**
 * Execute the complete churn response play:
 * 1. Dispatch/dedupe the 3 legs (pain-link QUERY, save-play REQUEST, offer-copy REQUEST).
 * 2. Execute the product investigation query via harness adapter.
 * 3. Execute the save-play leg via harness adapter and check draft claims.
 * 4. Execute the offer-copy leg via harness adapter and check draft claims.
 * 5. Record human approval decision once deliverables are verified.
 * 6. Return CompletedChurnPlay with verified deliverables.
 */
export async function executeChurnPlay(
  coord: Coordinator,
  ledger: Ledger,
  adapter: HarnessAdapter,
  tenant: string,
  input: ExecuteChurnPlayInput,
  opts?: { db?: AsyncDb },
): Promise<CompletedChurnPlay> {
  const now = input.now ?? new Date().toISOString();

  let fanOutRunId: string | null = null;
  let recommendationDecisionId: string | null = null;
  let productQueryId: string;
  let outreachRequestId: string;
  let offerRequestId: string;
  if (opts !== undefined && opts.db !== undefined) {
    const run = await churnRespondWorkflow(opts.db, coord, ledger, tenant, {
      segment: input.segment,
      riskClaimIds: input.riskClaimIds,
      onBehalfOf: input.onBehalfOf,
      now,
    });
    requireCompleteFanOut(run);
    if (!run.decisionId) throw new WedgeError('INCOMPLETE_FANOUT', 'churn workflow completed without a decision');
    const legs = churnLegIds(run);
    fanOutRunId = run.id;
    recommendationDecisionId = run.decisionId;
    productQueryId = legs.productQueryId;
    outreachRequestId = legs.outreachRequestId;
    offerRequestId = legs.offerRequestId;
  } else {
    const response = await churnRespond(coord, ledger, tenant, {
      segment: input.segment,
      riskClaimIds: input.riskClaimIds,
      onBehalfOf: input.onBehalfOf,
      now,
    });
    productQueryId = response.productQueryId;
    outreachRequestId = response.outreachRequestId;
    offerRequestId = response.offerRequestId;
  }

  const investigationOutcome = await adapter.run(tenant, productQueryId, {
    command: input.investigationCommand ?? `investigate pain links for ${input.segment}`,
    claimRefs: input.riskClaimIds,
    onBehalfOf: input.onBehalfOf,
    maxDollars: 10,
    maxTokens: 10000,
  });

  // 3. Human curation: promote candidate claims to VERIFIED by human approver before drafting
  const draftClaimIds = input.draftClaimIds ?? input.riskClaimIds;
  for (const id of draftClaimIds) {
    const c = await ledger.get(tenant, id);
    if (c && c.status === 'CANDIDATE') {
      await ledger.verifyClaim(tenant, id, input.approvedBy, now);
    }
  }

  const savePlayCommand = input.savePlayCommand ?? `prepare save play actions for ${input.segment}`;
  const savePlayOutcome = await adapter.run(tenant, outreachRequestId, {
    command: savePlayCommand,
    claimRefs: input.riskClaimIds,
    onBehalfOf: input.onBehalfOf,
    maxDollars: 10,
    maxTokens: 10000,
  });
  const savePlayDraft = input.savePlayDraftText ?? savePlayOutcome.transcript;
  const savePlayCheck = await checkDraft(ledger, tenant, { text: savePlayDraft, claimIds: draftClaimIds }, now);
  if (!savePlayCheck.ok) {
    const reasons = [...savePlayCheck.unverified, ...savePlayCheck.deniedPhrases].join(', ');
    throw new WedgeError('DRAFT_BLOCKED', `save play draft failed claims checker: ${reasons}`);
  }

  const offerCopyCommand = input.offerCopyCommand ?? `prepare retention offer copy for ${input.segment}`;
  const offerCopyOutcome = await adapter.run(tenant, offerRequestId, {
    command: offerCopyCommand,
    claimRefs: input.riskClaimIds,
    onBehalfOf: input.onBehalfOf,
    maxDollars: 10,
    maxTokens: 10000,
  });
  const offerCopyDraft = input.offerCopyDraftText ?? offerCopyOutcome.transcript;
  const offerCopyCheck = await checkDraft(ledger, tenant, { text: offerCopyDraft, claimIds: draftClaimIds }, now);
  if (!offerCopyCheck.ok) {
    const reasons = [...offerCopyCheck.unverified, ...offerCopyCheck.deniedPhrases].join(', ');
    throw new WedgeError('DRAFT_BLOCKED', `offer copy draft failed claims checker: ${reasons}`);
  }

  let approvalAction = `approved outreach and retention offer for ${input.segment}`;
  if (fanOutRunId !== null) {
    approvalAction = JSON.stringify({
      play: 'churn-play-approval',
      fanOutRunId,
      recommendationDecisionId,
      segment: input.segment,
    });
  }
  const approvalDecision = await ledger.recordDecision({
    tenant,
    goal: `execute approved churn play for ${input.segment}`,
    action: approvalAction,
    actionClass: 'ACT_REVERSIBLE',
    claimIds: input.riskClaimIds,
    decidedBy: input.onBehalfOf,
    approvedBy: input.approvedBy,
    scope: 'customer',
    autonomy: 'approval',
    requestId: outreachRequestId,
    now,
  });

  return {
    decisionId: approvalDecision.id,
    productQueryId,
    outreachRequestId,
    offerRequestId,
    investigationOutcome,
    savePlayDraft,
    savePlayCheck,
    offerCopyDraft,
    offerCopyCheck,
    executedAt: now,
    status: 'COMPLETED',
    fanOutRunId,
    recommendationDecisionId,
  };
}
