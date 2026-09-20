import type { Ledger } from '../ledger/ledger.ts';
import type { AsyncDb } from '../core/db.ts';
import { checkKill } from './trust.ts';
import type { AutonomyVerdict } from './raci.ts';

/**
 * Governance plane, part 4 (TODO §7): the ACT_REVERSIBLE execution path.
 *
 * Feature flags, internal tickets, and schedules execute through here and
 * only here: the caller passes the matrix verdict, and execution happens
 * if and only if the verdict is `autonomous`. `approval` means a human
 * takes it from here (throws NEEDS_APPROVAL, never self-approves);
 * `human-command` and `denied` refuse outright. Every execution is a
 * Ledger ACTION with its authorization basis cited.
 */

export class ActError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[act:${code}] ${message}`);
  }
}

export type ReversibleKind = 'flag' | 'ticket' | 'schedule';

export interface CompensationAction {
  kind: string;
  detail: string;
  compensate: () => Promise<void> | void;
}

export interface ActReceipt<T = unknown> {
  executed: boolean;
  receiptId: string;
  output?: T;
  compensation?: CompensationAction;
}

export interface ActInput<T = unknown> {
  tenant: string;
  scope: string;
  kind: ReversibleKind;
  detail: string;
  by: string;
  claimIds: string[];
  now?: string;
  /** Optional concrete execution handler to perform the real external reversible action. */
  execute?: () => Promise<ActReceipt<T>> | ActReceipt<T>;
}

export async function actReversible<T = unknown>(
  ledger: Ledger,
  verdict: AutonomyVerdict,
  reasons: string[],
  input: ActInput<T>,
): Promise<{ claimId: string; kind: ReversibleKind; receipt?: ActReceipt<T> }> {
  if (verdict === 'denied') throw new ActError('DENIED_ACTION', `refused: ${reasons.join('; ')}`);
  if (verdict === 'human-command') {
    throw new ActError('HUMAN_COMMAND', 'this action class is human-command: no autonomous execution path exists');
  }
  if (verdict === 'approval') {
    throw new ActError('NEEDS_APPROVAL', `a human approves first: ${reasons.join('; ')}`);
  }
  if (input.claimIds.length === 0) throw new ActError('UNGROUNDED_ACTION', 'execution without cited basis is refused');

  let receipt: ActReceipt<T> | undefined;
  if (input.execute) {
    try {
      receipt = await input.execute();
      if (!receipt || receipt.executed !== true) {
        throw new ActError('EXECUTION_FAILED', 'action execution handler reported non-success');
      }
    } catch (err) {
      if (err instanceof ActError) throw err;
      throw new ActError('EXECUTION_FAILED', `action execution threw: ${(err as Error).message}`);
    }
  }

  const now = input.now ?? new Date().toISOString();
  const statement = receipt
    ? `${input.kind}: ${input.detail} [receipt:${receipt.receiptId}] [${reasons.join('; ')}]`
    : `${input.kind}: ${input.detail} [${reasons.join('; ')}]`;

  const claim = await ledger.append({
    tenant: input.tenant,
    subject: `act:${input.scope}`,
    kind: 'ACTION',
    statement,
    confidence: 1,
    owner: input.by,
    scope: input.scope,
    authorType: 'agent',
    observedAt: now,
    validFrom: now,
    now,
    provenance: {
      sourceUri: `gov:act:${input.kind}`,
      sourceTier: 'MEASURED',
      extractor: 'act-reversible',
      extractorVersion: '1.1.0',
      retrievedAt: now,
    },
  });
  return { claimId: claim.id, kind: input.kind, receipt };
}

/** Execute a recorded compensation action for a reversible operation and record its compensation claim. */
export async function compensateReversible(
  ledger: Ledger,
  tenant: string,
  actionClaimId: string,
  compensation: CompensationAction,
  by: string,
  now?: string,
): Promise<{ claimId: string; compensated: boolean }> {
  const ts = now ?? new Date().toISOString();
  const prior = await ledger.get(tenant, actionClaimId);
  if (!prior) {
    throw new ActError('UNKNOWN_ACTION', `action claim "${actionClaimId}" not found for compensation`);
  }
  try {
    await compensation.compensate();
  } catch (err) {
    if (err instanceof ActError) throw err;
    throw new ActError('COMPENSATION_FAILED', `compensation execution threw: ${(err as Error).message}`);
  }

  const compClaim = await ledger.append({
    tenant,
    subject: prior.subject,
    kind: 'ACTION',
    statement: `COMPENSATION for [claim:${actionClaimId}]: ${compensation.kind}: ${compensation.detail}`,
    confidence: 1,
    owner: by,
    scope: prior.scope,
    authorType: 'agent',
    observedAt: ts,
    validFrom: ts,
    now: ts,
    provenance: {
      sourceUri: `gov:compensation:${compensation.kind}`,
      sourceTier: 'MEASURED',
      extractor: 'act-reversible-compensation',
      extractorVersion: '1.0.0',
      retrievedAt: ts,
    },
  });

  return { claimId: compClaim.id, compensated: true };
}

export async function assertNoHalt(db: AsyncDb, tenant: string, scope: string, actionClass: string): Promise<void> {
  if (await checkKill(db, tenant, scope, actionClass)) {
    throw new ActError('HALTED_WHEN_STOPPED', `stop active for ${scope}/${actionClass}: recover via recoverStop first`);
  }
}

export type ActFailure = 'rate-limit' | 'timeout-unknown' | 'dependency-outage' | 'denied' | 'needs-approval';

export function actRetryGuidance(failure: ActFailure, actionClass: string): { retryable: boolean; strategy: string } {
  if (failure === 'denied' || failure === 'needs-approval') {
    return { retryable: false, strategy: 'explicit human decision only: refusals are never retried automatically' };
  }
  if (actionClass === 'ACT_IRREVERSIBLE') {
    return { retryable: false, strategy: 'explicit human resubmission only: irreversible effects are never replayed' };
  }
  if (failure === 'timeout-unknown') {
    return { retryable: true, strategy: 'reconcile-then-retry under the same idempotency key' };
  }
  return { retryable: true, strategy: 'bounded retry with backoff under the same idempotency key' };
}
