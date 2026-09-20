import type { AsyncDb } from '../core/db.ts';
import { runSuite, type EvalTarget, type SuiteRun } from './runner.ts';

/**
 * Promotion pipeline (TODO §3.1): offline eval gate → shadow → canary(1%)
 * → promote, with rollback. Each stage names its suite and pass-rate bar;
 * advancing records the run id, so a promotion is always traceable to the
 * evidence that allowed it. Rollback moves one step back with a reason —
 * demotion is a feature, here as everywhere.
 */

export class PromotionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[promotion:${code}] ${message}`);
  }
}

export type PromoStage = 'offline' | 'shadow' | 'canary' | 'promoted';

export const STAGE_ORDER: readonly PromoStage[] = ['offline', 'shadow', 'canary', 'promoted'];

export interface StageGate {
  /** The stage this gate guards the EXIT of: pass the offline gate to enter shadow. */
  stage: Exclude<PromoStage, 'promoted'>;
  suite: string;
  minPassRate: number;
}

export interface StageRecord {
  target: string;
  stage: PromoStage;
  runId: string | null;
  at: string;
}

async function readStage(db: AsyncDb, tenant: string, target: string): Promise<StageRecord> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`promo:${tenant}:${target}`)) as
    { value: string } | undefined;
  if (!r) return { target, stage: 'offline', runId: null, at: '' };
  return JSON.parse(String(r.value)) as StageRecord;
}

async function writeStage(db: AsyncDb, tenant: string, rec: StageRecord): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`promo:${tenant}:${rec.target}`, JSON.stringify(rec));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'promotion', `STAGE_${rec.stage.toUpperCase()}`, rec.target, rec.runId ?? 'no run (rollback)', rec.at);
}

export async function currentStage(db: AsyncDb, tenant: string, target: string): Promise<StageRecord> {
  return readStage(db, tenant, target);
}

/** Run the gate suite; advance one stage on a pass. Returns the evidence run. */
export async function advanceStage(
  db: AsyncDb,
  tenant: string,
  target: string,
  gate: StageGate,
  targetName: string,
  fn: EvalTarget,
  now?: string,
): Promise<{ advanced: boolean; run: SuiteRun; reasons: string[] }> {
  const at = now ?? new Date().toISOString();
  const cur = await readStage(db, tenant, target);
  if (cur.stage === 'promoted') {
    const rerun = await runSuite(db, tenant, gate.suite, targetName, fn, { now: at });
    return { advanced: false, run: rerun, reasons: ['already promoted: nothing to advance'] };
  }
  if (gate.stage !== cur.stage) {
    const wrong = await runSuite(db, tenant, gate.suite, targetName, fn, { now: at });
    return {
      advanced: false,
      run: wrong,
      reasons: [`at stage ${cur.stage}, gate is for ${gate.stage}: advance one step at a time`],
    };
  }
  const run = await runSuite(db, tenant, gate.suite, targetName, fn, { now: at });
  const total = run.passed + run.failed;
  const rate = total === 0 ? 0 : run.passed / total;
  if (rate < gate.minPassRate) {
    return {
      advanced: false,
      run,
      reasons: [`pass rate ${rate.toFixed(2)} < ${gate.minPassRate}: leaving ${gate.stage} refused`],
    };
  }
  const advanceTo: PromoStage = STAGE_ORDER[STAGE_ORDER.indexOf(cur.stage) + 1]!;
  // Expected-state CAS: the stage moves only if it still holds the value
  // this call validated the gate against. A concurrent advancer wins, this
  // call sees zero changed rows and throws instead of overwriting — two
  // gates can never both "advance" the same stage. The ensure-INSERT covers
  // the first-ever advance (no row yet); it is idempotent, so racers share it.
  const key = `promo:${tenant}:${target}`;
  const next: StageRecord = { target, stage: advanceTo, runId: run.id, at };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
    .run(key, JSON.stringify(cur));
  const out = await db
    .prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
    .run(JSON.stringify(next), key, JSON.stringify(cur));
  if (out.changes === 0) {
    throw new PromotionError(
      'STATE_CONFLICT',
      `stage for ${target} moved under this advance (was ${cur.stage}): re-read and gate again`,
    );
  }
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'promotion', `STAGE_${advanceTo.toUpperCase()}`, target, run.id, at);
  return { advanced: true, run, reasons: [] };
}

/** Roll back one stage with a reason. Always allowed — that is the point. */
export async function rollbackStage(
  db: AsyncDb,
  tenant: string,
  target: string,
  reason: string,
  now?: string,
): Promise<StageRecord> {
  const at = now ?? new Date().toISOString();
  const cur = await readStage(db, tenant, target);
  const idx = STAGE_ORDER.indexOf(cur.stage);
  const back: PromoStage = STAGE_ORDER[Math.max(0, idx - 1)]!;
  const rec: StageRecord = { target, stage: back, runId: null, at };
  await writeStage(db, tenant, rec);
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'promotion', 'STAGE_ROLLBACK', target, reason, at);
  return rec;
}
