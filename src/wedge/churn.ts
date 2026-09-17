import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter, HarnessOutcome } from '../substrate/harness.ts';
import { checkDraft, reuseDedupedOrThrow, WedgeError, type DraftCheck } from './ship.ts';

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

export async function churnRespond(
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  input: { segment: string; riskClaimIds: string[]; onBehalfOf: string; now: string },
): Promise<ChurnResponse> {
  if (input.riskClaimIds.length === 0) {
    throw new WedgeError('UNGROUNDED_LOOP', 'a churn loop with no cited risk pattern is refused');
  }
  // Risk signals are BELIEFs by design (CANDIDATE, never VERIFIED on
  // arrival), so the bar here is LIVE, not verified: the claim must exist,
  // unretired, undisputed, unexpired. The loop investigates and recommends;
  // autonomy stays `approval`, so no action fires on a hunch.
  const UNUSABLE = ['STALE', 'DISPUTED', 'SUPERSEDED', 'RETIRED'] as const;
  const bad: string[] = [];
  for (const id of input.riskClaimIds) {
    const c = await ledger.get(tenant, id);
    if (!c) {
      bad.push(id);
      continue;
    }
    if ((UNUSABLE as readonly string[]).includes(c.status)) bad.push(id);
    else if (c.validUntil && c.validUntil <= input.now) bad.push(id);
  }
  if (bad.length > 0) {
    throw new WedgeError(
      'UNVERIFIABLE_CITATION',
      `churn risk cites ${bad.join(', ')} — stale, disputed, superseded, or unknown`,
    );
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
    // Same retry rule as ship fan-out: a dedupe hit reuses the existing leg.
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
  // No self-delegation: the customer scope acts on a REQUEST from product,
  // never on work it sends itself.
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
): Promise<CompletedChurnPlay> {
  const now = input.now ?? new Date().toISOString();

  // 1. Establish the churn response legs and preliminary recommendation decision
  const response = await churnRespond(coord, ledger, tenant, {
    segment: input.segment,
    riskClaimIds: input.riskClaimIds,
    onBehalfOf: input.onBehalfOf,
    now,
  });

  // 2. Execute investigation leg (QUERY) via adapter
  const investigationOutcome = await adapter.run(tenant, response.productQueryId, {
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

  // 4. Execute save play leg (REQUEST) via adapter
  const savePlayCommand = input.savePlayCommand ?? `prepare save play actions for ${input.segment}`;
  const savePlayOutcome = await adapter.run(tenant, response.outreachRequestId, {
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

  // 5. Execute retention offer leg (REQUEST) via adapter
  const offerCopyCommand = input.offerCopyCommand ?? `prepare retention offer copy for ${input.segment}`;
  const offerCopyOutcome = await adapter.run(tenant, response.offerRequestId, {
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

  // 5. Record human approval decision now that deliverables have been produced and verified
  const approvalDecision = await ledger.recordDecision({
    tenant,
    goal: `execute approved churn play for ${input.segment}`,
    action: `approved outreach and retention offer for ${input.segment}`,
    actionClass: 'ACT_REVERSIBLE',
    claimIds: input.riskClaimIds,
    decidedBy: input.onBehalfOf,
    approvedBy: input.approvedBy,
    scope: 'customer',
    autonomy: 'approval',
    requestId: response.outreachRequestId,
    now,
  });

  return {
    decisionId: approvalDecision.id,
    productQueryId: response.productQueryId,
    outreachRequestId: response.outreachRequestId,
    offerRequestId: response.offerRequestId,
    investigationOutcome,
    savePlayDraft,
    savePlayCheck,
    offerCopyDraft,
    offerCopyCheck,
    executedAt: now,
    status: 'COMPLETED',
  };
}
