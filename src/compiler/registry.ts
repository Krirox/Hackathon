import type { AsyncDb } from '../core/db.ts';
import type { EvalRunRow } from '../core/rows.ts';
import { runSuite, type EvalTarget, type SuiteRun } from '../evals/runner.ts';
import type { OrganizationalCompiler, SkillCard, SkillCardRevision, SkillState, TransferTest } from './compiler.ts';

/**
 * Procedure registry, read side (TODO §5): card, state, scope, tests
 * passed, live success rate, and — the column that matters — why it
 * can't be trusted yet.
 *
 * Presentation never evaluates: `describeCardReadOnly` reports the drift
 * signal without demoting or writing, so dashboard GETs (report.ts) stay
 * side-effect free. The evaluating `describeCard` path stays for explicit
 * evaluation entry points — scheduled evaluation should call it (or
 * comp.checkDrift directly), never the read-only variant. A registry read
 * that hides decay would be the failure mode this system exists to
 * prevent, so the read-only path still SHOWS the drift signal (the
 * `drifting` trust gap) — it just never acts on it.
 */

export interface CardDescription {
  card: SkillCard;
  transfers: TransferTest[];
  drift: { drifting: boolean; demoted: boolean; ewma: number; samples: number } | null;
  revisions?: SkillCardRevision[];
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

function trustGapsFor(
  card: SkillCard,
  transfers: TransferTest[],
  drift: { drifting: boolean; demoted: boolean } | null,
): string[] {
  const passed = (kind: TransferTest['kind'], variant?: string): boolean =>
    transfers.some((t) => t.kind === kind && t.passed && (variant === undefined || t.variant === variant));
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
  return trustGaps;
}

/**
 * Read-only drift signal: the same EWMA the evaluating monitor uses, but
 * computed from a SELECT with no persist and no audit write. `demoted` is
 * always false here by construction — a GET reports decay, it never acts.
 * Mirrors OrganizationalCompiler.checkDrift defaults (window 40, alpha 0.2,
 * threshold 0.9, minimum 10 samples) so the signal matches evaluation.
 */
async function peekDrift(
  db: AsyncDb,
  tenant: string,
  card: SkillCard,
): Promise<{ drifting: boolean; demoted: boolean; ewma: number; samples: number } | null> {
  if (card.state !== 'PROMOTED') return null;
  const window = 40;
  const alpha = 0.2;
  const threshold = 0.9;
  const rows = (await db
    .prepare(
      `SELECT outcome FROM traces WHERE tenant = ? AND intent = ? AND tier = 'WORKFLOW'
         AND skill_card = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(tenant, card.intent, card.id, window)) as { outcome: string }[];
  if (rows.length < 10) return { drifting: false, demoted: false, ewma: 1, samples: rows.length };
  let ewma = 1;
  for (const r of [...rows].reverse()) {
    let s = ewma;
    if (r.outcome === 'SUCCESS') s = 1;
    else if (r.outcome === 'FAILURE') s = 0;
    ewma = alpha * s + (1 - alpha) * ewma;
  }
  return { drifting: ewma < threshold, demoted: false, ewma, samples: rows.length };
}

/**
 * Presentation path: no evaluation, no writes. Dashboard GETs must call
 * this, never `describeCard`.
 */
export async function describeCardReadOnly(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  id: string,
): Promise<CardDescription> {
  const card = await comp.get(tenant, id);
  if (!card) throw new Error(`[registry:MISSING_CARD] unknown card ${id}`);
  const transfers = await comp.transferResults(tenant, card.id);
  const revisions = await comp.cardRevisions(tenant, card.id);
  const drift = await peekDrift(db, tenant, card);
  return { card, transfers, drift, revisions, trustGaps: trustGapsFor(card, transfers, drift) };
}

/**
 * Evaluation path: describing a PROMOTED card runs the drift monitor,
 * which auto-demotes per its own contract when live success breaches
 * baseline. Reserved for explicit evaluation entry points (scheduled
 * evaluation should call this or comp.checkDrift directly) — never for
 * presentation reads.
 */
export async function describeCard(comp: OrganizationalCompiler, tenant: string, id: string): Promise<CardDescription> {
  const card = await comp.get(tenant, id);
  if (!card) throw new Error(`[registry:MISSING_CARD] unknown card ${id}`);
  const transfers = await comp.transferResults(tenant, card.id);
  const revisions = await comp.cardRevisions(tenant, card.id);
  const drift = card.state === 'PROMOTED' ? await comp.checkDrift(tenant, card.id) : null;
  return { card, transfers, drift, revisions, trustGaps: trustGapsFor(card, transfers, drift) };
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
  const run = await runSuite(db, tenant, card.evalRef, targetName, target, { now });
  const passed = run.failed === 0 && run.passed > 0;
  const score = run.passed + run.failed > 0 ? run.passed / (run.passed + run.failed) : 0;
  await comp.recordTransfer(card, {
    kind: 'regression',
    variant: card.evalRef,
    passed,
    score,
    ranAt: run.ranAt,
    cardVersion: card.version,
    evalRunId: run.id,
    evaluator: targetName,
  });
  return run;
}

export interface CardEvaluationEvidence {
  card: SkillCard;
  transfers: TransferTest[];
  trustGaps: string[];
  evalRef: string | null;
  runs: { id: string; suite: string; passed: number; failed: number; ranAt: string }[];
  latest: { id: string; suite: string; passed: number; failed: number; ranAt: string } | null;
  evidenceOnly: string;
}

export async function cardEvaluationEvidence(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  cardId: string,
): Promise<CardEvaluationEvidence> {
  const described = await describeCardReadOnly(db, comp, tenant, cardId);
  const runs =
    described.card.evalRef == null
      ? []
      : (
          (await db
            .prepare(
              'SELECT id, suite, passed, failed, ran_at FROM eval_runs WHERE tenant = ? AND suite = ? ORDER BY ran_at DESC LIMIT 5',
            )
            .all(tenant, described.card.evalRef)) as EvalRunRow[]
        ).map((row) => ({
          id: String(row.id),
          suite: String(row.suite),
          passed: Number(row.passed),
          failed: Number(row.failed),
          ranAt: String(row.ran_at),
        }));
  return {
    card: described.card,
    transfers: described.transfers,
    trustGaps: described.trustGaps,
    evalRef: described.card.evalRef,
    runs,
    latest: runs.length > 0 ? (runs[0] as CardEvaluationEvidence['latest']) : null,
    evidenceOnly: 'evidence only — linking a gap to its eval runs never promotes the card',
  };
}
