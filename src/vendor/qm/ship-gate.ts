/**
 * PROVENANCE — vendored, not written.
 *   source:        https://github.com/yc-software/qm
 *   commit:        60ba79195dc84aa85a23f238749656e11c88696c (2026-09-08)
 *   upstream path: src/loops/ship-gate.ts (74 lines)
 *   license:       MIT — see LICENSE-THIRD-PARTY.md
 *
 * WHAT WAS CHANGED AND WHY
 *   One import rewritten, zero semantics changed. Upstream imports
 *   `contentPart` from `triggers/trigger-store.ts`, which pulls
 *   `directory/person.ts` and a Postgres-backed `durable-map.ts` — substrate
 *   we explicitly do not absorb. `contentPart` is just `canonicalJson`
 *   (verified in upstream source), so this file imports the verbatim-vendored
 *   `../qm/objects.ts` instead. `hashId` comes from the verbatim-vendored
 *   `./crypto.ts`. The QM loop types (`Loop`, `ShipGrant`, …) are restated
 *   here with ONLY the fields this file reads, copied field-for-field from
 *   upstream `src/types.ts` (same commit).
 *
 *   Our R/A/I matrix (`src/gov/raci.ts`) enforces OVER this primitive —
 *   one enforcement path, not a parallel one.
 */

import { canonicalJson as contentPart } from './objects.ts';
import { hashId } from './crypto.ts';

export type ShipGate = 'hold' | 'auto';

export interface ShipActionPolicy {
  action: string;
  gate: ShipGate;
}

/** Verbatim upstream `ApprovalGrantModes` (src/types.ts, same commit). */
export interface ApprovalGrantModes {
  session: boolean;
  always: boolean;
}
/** Narrowed upstream `ShipGrant`: only the fields this file reads. */
export interface ShipGrant {
  id: string;
  loopId: string;
  shipAction: string;
  label?: string;
  actorId: string;
  policyVersion: number;
  createdAt: number;
  revokedAt?: number;
}

/** Narrowed upstream loop surface: id, policyVersion, shipActions. */
export interface ShipLoop {
  id: string;
  policyVersion?: number;
  shipActions: ShipActionPolicy[];
}

export interface LoopOutputShip {
  shipAction: string;
  label?: string;
}

export type ShipDecision =
  { outcome: 'auto'; via: 'policy' | 'grant'; grantId?: string } | { outcome: 'hold' } | { outcome: 'undeclared' };

export interface ShipCandidate {
  shipAction: string;
  label?: string;
}

function declaredGate(loop: ShipLoop, shipAction: string): ShipGate | undefined {
  return loop.shipActions.find((policy) => policy.action === shipAction)?.gate;
}

function grantCovers(grant: ShipGrant, loop: ShipLoop, candidate: ShipCandidate): boolean {
  if (
    grant.loopId !== loop.id ||
    grant.policyVersion !== (loop.policyVersion ?? 1) ||
    grant.revokedAt !== undefined ||
    grant.shipAction !== candidate.shipAction
  )
    return false;
  return grant.label === undefined || grant.label === candidate.label;
}

export function decideShip(loop: ShipLoop, candidate: ShipCandidate, grants: ShipGrant[] = []): ShipDecision {
  const gate = declaredGate(loop, candidate.shipAction);
  if (gate === undefined) return { outcome: 'undeclared' };
  if (gate === 'auto') return { outcome: 'auto', via: 'policy' };
  const grant = grants.find((g) => grantCovers(g, loop, candidate));
  if (grant) return { outcome: 'auto', via: 'grant', grantId: grant.id };
  return { outcome: 'hold' };
}

export function graduationAllowed(modes?: ApprovalGrantModes): boolean {
  return modes?.always !== false;
}

export function buildShipGrant(input: {
  loopId: string;
  shipAction: string;
  actorId: string;
  policyVersion: number;
  label?: string;
  modes?: ApprovalGrantModes;
}): ShipGrant {
  if (!graduationAllowed(input.modes)) throw new Error('standing ship grants are disabled for this org');
  return {
    id: hashId([
      contentPart(input.loopId),
      contentPart(input.policyVersion),
      contentPart(input.shipAction),
      contentPart(input.label),
    ]),
    loopId: input.loopId,
    shipAction: input.shipAction,
    actorId: input.actorId,
    policyVersion: input.policyVersion,
    createdAt: Date.now(),
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}

export function outputCandidate(output: LoopOutputShip): ShipCandidate {
  return { shipAction: output.shipAction, ...(output.label !== undefined ? { label: output.label } : {}) };
}

export function undeclaredShipActions(loop: ShipLoop, outputs: Array<Pick<LoopOutputShip, 'shipAction'>>): string[] {
  const declared = new Set(loop.shipActions.map((policy) => policy.action));
  return [...new Set(outputs.map((o) => o.shipAction).filter((action) => !declared.has(action)))];
}
