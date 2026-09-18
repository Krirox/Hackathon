import { decideShip, type ShipGrant, type ShipLoop } from '../vendor/qm/ship-gate.ts';
import type { ActionClass } from '../core/types.ts';

/**
 * Governance plane, part 1: the R/A/I matrix as data (idea §9.1).
 *
 * Autonomy is granted per action-class × scope — never globally per agent.
 * Ladders imply promotion; this matrix implies ceilings.
 *
 * Enforcement runs OVER the vendored ship-gate primitive (one enforcement
 * path, not a parallel one): the matrix decides the autonomy ceiling for the
 * action class, and a declared ship gate can only hold it lower, never raise
 * it. An undeclared ship action is denied outright — the same semantics as
 * the governor's quarantine, at decision time instead of review time.
 *
 * NOT YET HERE (explicitly): the Trust Ledger (3.3) that feeds `trust` from
 * `trust_scores`, honeytasks, and kill switches. `authorize()` takes trust as
 * an argument so the matrix is testable now and backed later; wiring the
 * jcode runner's permission policy through `authorize()` happens with it.
 */

export type AutonomyVerdict = 'autonomous' | 'approval' | 'human-command' | 'denied';

export interface TrustState {
  /** Consecutive clean instances of (scope, action class). */
  cleanInstances: number;
  /** Promotion to autonomous ACT_REVERSIBLE needs this many. */
  cleanThreshold?: number;
  /** Set when a freeze/demotion is in force — approval max, no autonomy. */
  frozen?: boolean;
  /** Explicit autonomous grant flag from trust_scores. */
  granted?: boolean;
  /** Maintained override rate. */
  overrideRate?: number;
  /** Total evaluated decisions. */
  total?: number;
}

export interface AuthorizeInput {
  scope: string;
  actionClass: string;
  trust?: TrustState;
  /** ANALYZE needs an eval pass to run autonomous. */
  evalPassed?: boolean;
  /** RECOMMEND needs routing precision above gate to run autonomous. */
  recommendPrecision?: number;
  /** Scopes pinned to Strict: ACT_REVERSIBLE never goes autonomous there. */
  pinnedScopes?: readonly string[];
  /** Optional ship-action check, enforced over the vendored primitive. */
  shipAction?: string;
  shipLoop?: ShipLoop;
  shipGrants?: ShipGrant[];
}

export interface AuthorizeResult {
  verdict: AutonomyVerdict;
  reasons: string[];
}

export const REVERSIBLE_CLEAN_THRESHOLD = 200;
export const RECOMMEND_PRECISION_GATE = 0.8;

export const DEFAULT_PINNED_SCOPES: readonly string[] = ['money', 'customer', 'production', 'finance'];

export function authorize(input: AuthorizeInput): AuthorizeResult {
  const reasons: string[] = [];
  const pinned = input.pinnedScopes ?? DEFAULT_PINNED_SCOPES;

  if (!['READ', 'ANALYZE', 'RECOMMEND', 'ACT_REVERSIBLE', 'ACT_IRREVERSIBLE'].includes(input.actionClass)) {
    return { verdict: 'denied', reasons: [`unknown action class "${input.actionClass}" — fail closed`] };
  }
  const cls = input.actionClass as ActionClass;

  // The matrix ceiling comes first; ship gates only hold lower.
  let verdict: AutonomyVerdict;
  switch (cls) {
    case 'READ':
      verdict = 'autonomous';
      reasons.push('READ is autonomous');
      break;
    case 'ANALYZE':
      if (input.evalPassed === true) {
        verdict = 'autonomous';
        reasons.push('ANALYZE with a passing eval is autonomous');
      } else {
        verdict = 'approval';
        reasons.push('ANALYZE without an eval pass needs approval');
      }
      break;
    case 'RECOMMEND':
      if ((input.recommendPrecision ?? 0) >= RECOMMEND_PRECISION_GATE) {
        verdict = 'autonomous';
        reasons.push(`RECOMMEND at precision ${input.recommendPrecision} ≥ ${RECOMMEND_PRECISION_GATE} is autonomous`);
      } else {
        verdict = 'approval';
        reasons.push(`RECOMMEND below precision gate ${RECOMMEND_PRECISION_GATE} needs approval`);
      }
      break;
    case 'ACT_REVERSIBLE': {
      const trust = input.trust;
      if (trust?.frozen === true) {
        verdict = 'approval';
        reasons.push('trust frozen — approval max until cleared');
      } else if (
        trust?.granted === true ||
        (trust?.cleanInstances ?? 0) >= (trust?.cleanThreshold ?? REVERSIBLE_CLEAN_THRESHOLD)
      ) {
        if (pinned.includes(input.scope)) {
          verdict = 'approval';
          reasons.push(`scope "${input.scope}" is pinned Strict — ACT_REVERSIBLE never goes autonomous there`);
        } else if ((trust?.overrideRate ?? 0) > 0.1 && (trust?.total ?? 0) >= 10) {
          verdict = 'approval';
          reasons.push(
            `override rate ${(trust?.overrideRate ?? 0).toFixed(2)} exceeds 0.10 threshold — approval required`,
          );
        } else {
          verdict = 'autonomous';
          reasons.push(`Trust Ledger grants it: ${trust?.cleanInstances} clean instances`);
        }
      } else {
        verdict = 'approval';
        reasons.push(
          `needs ${trust?.cleanThreshold ?? REVERSIBLE_CLEAN_THRESHOLD} clean instances, has ${trust?.cleanInstances ?? 0}`,
        );
      }
      break;
    }
    case 'ACT_IRREVERSIBLE':
      return {
        verdict: 'human-command',
        reasons: ['ACT_IRREVERSIBLE is human-command, always — legal review + named officer; not offered in year 1'],
      };
  }

  // Ship gate check: can hold lower, never raise.
  if (input.shipAction !== undefined) {
    if (!input.shipLoop) {
      return {
        verdict: 'denied',
        reasons: [...reasons, `ship action "${input.shipAction}" has no declared loop — denied`],
      };
    }
    const ship = decideShip(input.shipLoop, { shipAction: input.shipAction }, input.shipGrants ?? []);
    if (ship.outcome === 'undeclared') {
      return { verdict: 'denied', reasons: [...reasons, `ship action "${input.shipAction}" is undeclared — denied`] };
    }
    if (ship.outcome === 'hold') {
      if (verdict === 'autonomous') {
        verdict = 'approval';
        reasons.push(`ship gate holds "${input.shipAction}" — a human holds the gate`);
      } else {
        reasons.push(`ship gate holds "${input.shipAction}"`);
      }
    } else {
      reasons.push(`ship gate auto for "${input.shipAction}" via ${ship.via}`);
    }
  }

  return { verdict, reasons };
}
