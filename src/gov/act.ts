import type { Ledger } from '../ledger/ledger.ts';
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

export interface ActInput {
  tenant: string;
  scope: string;
  kind: ReversibleKind;
  detail: string;
  by: string;
  claimIds: string[];
  now?: string;
}

export async function actReversible(
  ledger: Ledger,
  verdict: AutonomyVerdict,
  reasons: string[],
  input: ActInput,
): Promise<{ claimId: string; kind: ReversibleKind }> {
  if (verdict === 'denied') throw new ActError('DENIED_ACTION', `refused: ${reasons.join('; ')}`);
  if (verdict === 'human-command') {
    throw new ActError('HUMAN_COMMAND', 'this action class is human-command — no autonomous execution path exists');
  }
  if (verdict === 'approval') {
    throw new ActError('NEEDS_APPROVAL', `a human approves first: ${reasons.join('; ')}`);
  }
  if (input.claimIds.length === 0) throw new ActError('UNGROUNDED_ACTION', 'execution without cited basis is refused');
  const now = input.now ?? new Date().toISOString();
  const claim = await ledger.append({
    tenant: input.tenant,
    subject: `act:${input.scope}`,
    kind: 'ACTION',
    statement: `${input.kind}: ${input.detail} [${reasons.join('; ')}]`,
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
      extractorVersion: '1.0.0',
      retrievedAt: now,
    },
  });
  return { claimId: claim.id, kind: input.kind };
}
