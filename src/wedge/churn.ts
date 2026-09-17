import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { WedgeError } from './ship.ts';

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
    if (!r.admitted) throw new WedgeError('FANOUT_REFUSED', `${originScope}→${targetScope} ${r.state}: ${r.reason}`);
    return r.request.id;
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
