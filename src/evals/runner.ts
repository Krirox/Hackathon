import { z } from 'zod';
import type { AsyncDb } from '../core/db.ts';

/**
 * Eval spine, part 1 (TODO §3.1): the store + the suite runner.
 *
 * "Evals are the spec" means capabilities earn features by failing evals
 * first. This file is the machinery: cases in `eval_cases`, runs in
 * `eval_runs`, targets as plain functions. Golden sets per capability and
 * the injection suite are separate items; the pattern they follow is proven
 * in `test/evals.test.ts`, where ledger epistemics run AS evals.
 */

export class EvalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[evals:${code}] ${message}`);
  }
}

const newCaseSchema = z
  .object({
    tenant: z.string().min(1),
    capability: z.string().min(1),
    suite: z.string().min(1),
    input: z.unknown(),
    expect: z.unknown(),
    kind: z.string().min(1),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

export type NewCaseInput = z.input<typeof newCaseSchema>;

export interface EvalCase {
  id: string;
  tenant: string;
  capability: string;
  suite: string;
  input: unknown;
  expect: unknown;
  kind: string;
  createdAt: string;
}

export interface CaseResult {
  caseId: string;
  pass: boolean;
  detail?: unknown;
}

export type EvalTarget = (
  input: unknown,
) => { pass: boolean; detail?: unknown } | Promise<{ pass: boolean; detail?: unknown }>;

export interface SuiteRun {
  id: string;
  tenant: string;
  suite: string;
  target: string;
  passed: number;
  failed: number;
  results: CaseResult[];
  ranAt: string;
}

function rowToCase(r: Record<string, unknown>): EvalCase {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    capability: String(r.capability),
    suite: String(r.suite),
    input: JSON.parse(String(r.input_json)),
    expect: JSON.parse(String(r.expect_json)),
    kind: String(r.kind),
    createdAt: String(r.created_at),
  };
}

export async function addCase(db: AsyncDb, input: NewCaseInput): Promise<EvalCase> {
  const c = newCaseSchema.parse(input);
  const now = c.now ?? new Date().toISOString();
  const id = c.id ?? `evc_${crypto.randomUUID()}`;
  await db
    .prepare(
      'INSERT INTO eval_cases (id, tenant, capability, suite, input_json, expect_json, kind, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(id, c.tenant, c.capability, c.suite, JSON.stringify(c.input), JSON.stringify(c.expect), c.kind, now);
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(c.tenant, 'evals', 'CASE_ADDED', id, `${c.capability}/${c.suite}`, now);
  return rowToCase((await db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(id)) as Record<string, unknown>);
}

export async function listCases(
  db: AsyncDb,
  tenant: string,
  suite?: string,
  opts: { includeHeldOut?: boolean } = {},
): Promise<EvalCase[]> {
  const all = await listCasesRaw(db, tenant, suite);
  if (opts.includeHeldOut === true) return all;
  // Contamination guard: held-out sets never enter prompts or training
  // traces through the default path. Explicit opt-in only.
  return all.filter((c) => !c.suite.startsWith('heldout/'));
}

async function listCasesRaw(db: AsyncDb, tenant: string, suite?: string): Promise<EvalCase[]> {
  const sql =
    suite !== undefined
      ? 'SELECT * FROM eval_cases WHERE tenant = ? AND suite = ? ORDER BY created_at'
      : 'SELECT * FROM eval_cases WHERE tenant = ? ORDER BY created_at';
  const args = suite !== undefined ? [tenant, suite] : [tenant];
  return (await db.prepare(sql).all(...args)).map((r) => rowToCase(r as Record<string, unknown>));
}

export async function runSuite(
  db: AsyncDb,
  tenant: string,
  suite: string,
  targetName: string,
  target: EvalTarget,
  opts: { now?: string; heldOut?: boolean } = {},
): Promise<SuiteRun> {
  const at = opts.now ?? new Date().toISOString();
  if (suite.startsWith('heldout/') && opts.heldOut !== true) {
    throw new EvalError('HELD_OUT_SUITE', `suite "${suite}" is held out — pass { heldOut: true } to run it, visibly`);
  }
  const cases = await listCases(db, tenant, suite, { includeHeldOut: opts.heldOut === true });
  if (cases.length === 0)
    throw new EvalError('EMPTY_SUITE', `suite "${suite}" has no cases — a suite that cannot fail proves nothing`);
  if (suite.startsWith('heldout/')) {
    await db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, 'evals', 'HELDOUT_RUN', suite, targetName, at);
  }
  const results: CaseResult[] = [];
  for (const c of cases) {
    let r: { pass: boolean; detail?: unknown };
    try {
      const out = await target({ input: c.input, expect: c.expect, kind: c.kind, caseId: c.id });
      r = { pass: !!out.pass, detail: out.detail };
    } catch (e) {
      r = { pass: false, detail: (e as Error).message };
    }
    results.push({ caseId: c.id, pass: r.pass, detail: r.detail });
  }
  const passed = results.filter((r) => r.pass).length;
  const id = `evr_${crypto.randomUUID()}`;
  await db
    .prepare(
      'INSERT INTO eval_runs (id, tenant, suite, target, passed, failed, detail_json, ran_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(id, tenant, suite, targetName, passed, results.length - passed, JSON.stringify(results), at);
  return { id, tenant, suite, target: targetName, passed, failed: results.length - passed, results, ranAt: at };
}

export async function getRun(db: AsyncDb, tenant: string, id: string): Promise<SuiteRun | null> {
  const r = (await db.prepare('SELECT * FROM eval_runs WHERE id = ? AND tenant = ?').get(id, tenant)) as
    Record<string, unknown> | undefined;
  if (!r) return null;
  const results = JSON.parse(String(r.detail_json)) as CaseResult[];
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    suite: String(r.suite),
    target: String(r.target),
    passed: Number(r.passed),
    failed: Number(r.failed),
    results,
    ranAt: String(r.ran_at),
  };
}

/**
 * Learning made real (TODO §3.1): a human correction becomes a regression
 * eval case. Reads the CLAIM_CORRECTED audit row (`oldId->newId` detail),
 * resolves both claims through `getClaim`, and banks a case asserting the
 * supersede link — so the exact mistake that taught us once is checked
 * forever.
 */
export async function proposeEvalFromCorrection(
  db: AsyncDb,
  getClaim: (
    id: string,
  ) => { subject: string; statement: string } | null | Promise<{ subject: string; statement: string } | null>,
  tenant: string,
  auditSeq: number,
  suite = 'regressions',
  now?: string,
): Promise<EvalCase> {
  const row = (await db.prepare('SELECT * FROM audit_log WHERE seq = ? AND tenant = ?').get(auditSeq, tenant)) as
    Record<string, unknown> | undefined;
  if (!row || String(row.action) !== 'CLAIM_CORRECTED') {
    throw new EvalError('NOT_A_CORRECTION', `audit seq ${auditSeq} is not a CLAIM_CORRECTED row`);
  }
  // correctClaim audits target as `oldId->newId` (detail carries the old statement).
  const link = String(row.target ?? '');
  const [oldId, newId] = link.split('->');
  if (!oldId || !newId) throw new EvalError('MALFORMED_CORRECTION', `cannot parse correction link "${link}"`);
  const old = await getClaim(oldId);
  const neu = await getClaim(newId);
  if (!old || !neu) throw new EvalError('CORRECTION_GONE', 'corrected claims no longer resolve');
  return addCase(db, {
    tenant,
    capability: 'ledger',
    suite,
    kind: 'correction-regression',
    input: { subject: old.subject, wrongStatement: old.statement },
    expect: { statement: neu.statement, supersededBy: newId, supersedes: oldId },
    now,
  });
}
