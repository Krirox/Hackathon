import type { AsyncDb } from '../core/db.ts';
import { runSuite, type EvalTarget, type SuiteRun } from '../evals/runner.ts';
import type { OrganizationalCompiler, SkillCard, SkillState, TransferTest } from './compiler.ts';

/**
 * Procedure registry, read side (TODO §5): card, state, scope, tests
 * passed, live success rate, and — the column that matters — why it
 * can't be trusted yet. One honest exception to read-only: describing a
 * PROMOTED card runs the drift monitor, which auto-demotes per its own
 * contract when live success breaches baseline. A registry read that
 * hides decay would be the failure mode this system exists to prevent.
 */

export interface CardDescription {
  card: SkillCard;
  transfers: TransferTest[];
  drift: { drifting: boolean; demoted: boolean; ewma: number; samples: number } | null;
  /** Empty means: nothing blocks the next step that evidence can show. */
  trustGaps: string[];
}

export function listCards(
  comp: OrganizationalCompiler,
  tenant: string,
  opts: { state?: SkillState; intent?: string } = {},
): Promise<SkillCard[]> {
  return comp.list(tenant, opts);
}

export async function describeCard(comp: OrganizationalCompiler, tenant: string, id: string): Promise<CardDescription> {
  const card = await comp.get(tenant, id);
  if (!card) throw new Error(`[registry:MISSING_CARD] unknown card ${id}`);
  const transfers = await comp.transferResults(card.id);
  const passed = (kind: TransferTest['kind'], variant?: string): boolean =>
    transfers.some((t) => t.kind === kind && t.passed && (variant === undefined || t.variant === variant));
  const drift = card.state === 'PROMOTED' ? await comp.checkDrift(tenant, card.id) : null;

  const trustGaps: string[] = [];
  if (!passed('regression')) trustGaps.push('no passing regression test');
  if (!card.evalRef) trustGaps.push('no eval suite reference (evals are the spec)');
  if (!passed('cross_model')) trustGaps.push('no passing cross-model transfer test');
  if (card.state === 'PROMOTED' && !passed('data_regime')) trustGaps.push('no passing data-regime test');
  if (card.trustTier === 'third-party' && !passed('cross_model')) {
    trustGaps.push('third-party pack: transfer unproven on our harness');
  }
  for (const role of card.scopeRoles) {
    if (role !== card.originScope && !passed('cross_role', role)) {
      trustGaps.push(`no passing cross_role test for "${role}"`);
    }
  }
  if (drift?.drifting === true) trustGaps.push('drifting: live success below validated baseline');
  if (drift?.demoted === true) trustGaps.push('auto-demoted — see drift ticket');

  return { card, transfers, drift, trustGaps };
}

/**
 * Regression suite for a Skill Card (TODO §3.1: mandatory for SHADOW).
 * Runs the card's referenced eval suite and returns the evidence run.
 * A card with no eval reference has no suite — that is itself a gap,
 * and this refuses rather than inventing one.
 */
export async function runCardSuite(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  cardId: string,
  targetName: string,
  target: EvalTarget,
  now?: string,
): Promise<SuiteRun> {
  const card = await comp.get(tenant, cardId);
  if (!card) throw new Error(`[registry:MISSING_CARD] unknown card ${cardId}`);
  if (!card.evalRef)
    throw new Error(`[registry:NO_EVAL_REF] card ${cardId} has no eval suite reference (evals are the spec)`);
  return runSuite(db, tenant, card.evalRef, targetName, target, { now });
}
