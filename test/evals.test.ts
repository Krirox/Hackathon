import { T, eq, TEN, NOW, fresh, sor, rejects } from './helpers.ts';
import { addCase, getRun, listCases, proposeEvalFromCorrection, runSuite } from '../src/evals/runner.ts';
import { advanceStage, currentStage, rollbackStage } from '../src/evals/promotion.ts';
import { INJECTION_CORPUS, runInjectionSuite, runInjectionSuiteAsync } from '../src/evals/injection.ts';
import { denylistBackend } from '../src/substrate/screen.ts';

console.log('\n\x1b[1mEval spine — evals are the spec\x1b[0m');

T('cases are banked, listed, run, and recorded', async () => {
  const { db } = await fresh();
  await addCase(db, {
    tenant: TEN,
    capability: 'demo',
    suite: 'arith',
    input: { n: 2 },
    expect: { ok: true },
    kind: 'unit',
  });
  await addCase(db, {
    tenant: TEN,
    capability: 'demo',
    suite: 'arith',
    input: { n: 3 },
    expect: { ok: false },
    kind: 'unit',
  });
  eq((await listCases(db, TEN, 'arith')).length, 2);
  const run = await runSuite(db, TEN, 'arith', 'parity-target', ({ input }: any) => ({
    pass: (input as any).n % 2 === 0,
  }));
  eq(run.passed, 1);
  eq(run.failed, 1);
  const back = (await getRun(db, TEN, run.id))!;
  eq(back.target, 'parity-target');
  eq(back.results.length, 2);
});

T('an empty suite refuses to run — it would prove nothing', async () => {
  const { db } = await fresh();
  let code = '';
  try {
    await runSuite(db, TEN, 'nope', 't', () => ({ pass: true }));
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('EMPTY_SUITE'), true);
});

T('ledger epistemics run AS evals against a scratch ledger', async () => {
  const { db, ledger } = await fresh();
  const stale = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'old',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const live = await ledger.append({
    tenant: TEN,
    subject: 'q',
    kind: 'FACT',
    statement: 'new',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await addCase(db, {
    tenant: TEN,
    capability: 'ledger',
    suite: 'epistemics',
    kind: 'must-throw',
    input: { op: 'agent-append', kind: 'FACT' },
    expect: { throws: 'EPISTEMIC_GUARD' },
  });
  await addCase(db, {
    tenant: TEN,
    capability: 'ledger',
    suite: 'epistemics',
    kind: 'must-hold',
    input: { op: 'context', ids: [stale.id, live.id] },
    expect: { kept: [live.id] },
  });
  const run = await runSuite(db, TEN, 'epistemics', 'scratch-ledger', async ({ input, expect }: any) => {
    if (input.op === 'agent-append') {
      try {
        await ledger.append({
          tenant: TEN,
          subject: 'adv',
          kind: input.kind,
          statement: 'x',
          confidence: 0.9,
          observedAt: NOW,
          validFrom: NOW,
          owner: 'agent:x',
          scope: 'x',
          authorType: 'agent',
          provenance: sor(),
        });
      } catch (e) {
        return { pass: (e as Error).message.includes(expect.throws) };
      }
      return { pass: false, detail: 'append did not throw' };
    }
    const kept = (await ledger.contextFor(TEN, input.ids, NOW)).map((c) => c.id);
    return { pass: JSON.stringify(kept) === JSON.stringify(expect.kept) };
  });
  eq(run.failed, 0, 'epistemics hold as evals:');
});

T('a human correction becomes a regression eval that stays green', async () => {
  const { db, ledger } = await fresh();
  const old = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: '$99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const neu = await ledger.correctClaim(TEN, old.id, '$79', 'human:priya', NOW);
  const seq = (
    (await db
      .prepare("SELECT max(seq) AS m FROM audit_log WHERE tenant = ? AND action = 'CLAIM_CORRECTED'")
      .get(TEN)) as {
      m: number;
    }
  ).m;
  const kase = await proposeEvalFromCorrection(db, async (id) => await ledger.get(TEN, id), TEN, seq);
  eq(kase.suite, 'regressions');
  eq((await listCases(db, TEN, 'regressions')).length, 1);
  const run = await runSuite(db, TEN, 'regressions', 'supersede-link-target', async ({ expect }: any) => {
    const cur = await ledger.get(TEN, expect.supersedes);
    const nxt = await ledger.get(TEN, expect.supersededBy);
    return { pass: !!cur && !!nxt && cur.status === 'SUPERSEDED' && nxt.statement === expect.statement };
  });
  eq(run.failed, 0);
  void neu;
});

T('correction pipeline rejects non-correction audit rows', async () => {
  const { db, ledger } = await fresh();
  await rejects(
    async () => await proposeEvalFromCorrection(db, async (id) => await ledger.get(TEN, id), TEN, 99999),
    'NOT_A_CORRECTION',
  );
});

T('the injection suite screens both hooks, fails closed, and reports honestly', async () => {
  const report = runInjectionSuite(denylistBackend(), 0.5);
  eq(report.total, INJECTION_CORPUS.length);
  eq(report.falsePositives, [], 'benign traffic must pass:');
  eq(report.attackBlockRate >= 0.5, true, `reference floor blocks most attacks (got ${report.attackBlockRate}):`);
  eq(report.byCategory['tool-smuggle']!.blocked >= 1, true, 'tool output screened same as user input:');
  const dead = runInjectionSuite(
    {
      scoreText: () => {
        throw new Error('model down');
      },
    },
    0.5,
  );
  eq(dead.errors.length, INJECTION_CORPUS.length, 'a dead backend fails closed on every case:');
  eq(dead.blocked, INJECTION_CORPUS.length);
});

T('the injection suite catches a backend that waves attacks through', async () => {
  const lax = runInjectionSuite({ scoreText: () => ({ score: 0, flags: [] }) }, 0.5);
  eq(lax.attackBlockRate, 0);
  eq(lax.falsePositives, []);
});

T('the async runner matches the sync contract for model judges', async () => {
  const backend = denylistBackend();
  const sync = runInjectionSuite(backend, 0.5);
  const asyncReport = await runInjectionSuiteAsync(async (hook, text) => backend.scoreText(hook, text), 0.5);
  eq(asyncReport.attackBlockRate, sync.attackBlockRate, 'same corpus, same backend, same verdicts:');
  eq(asyncReport.falsePositives, []);
  const throwing = await runInjectionSuiteAsync(async () => {
    throw new Error('judge down');
  }, 0.5);
  eq(throwing.blocked, INJECTION_CORPUS.length, 'async failures fail closed too:');
});

T('promotion advances one gated stage at a time, with rollback', async () => {
  const { db } = await fresh();
  await addCase(db, {
    tenant: TEN,
    capability: 'm',
    suite: 'gate',
    input: { a: 1 },
    expect: { ok: true },
    kind: 'unit',
  });
  const pass = () => ({ pass: true });
  eq((await currentStage(db, TEN, 'model-x')).stage, 'offline');
  const s1 = await advanceStage(
    db,
    TEN,
    'model-x',
    { stage: 'offline', suite: 'gate', minPassRate: 1 },
    't',
    pass,
    NOW,
  );
  eq(s1.advanced, true);
  eq((await currentStage(db, TEN, 'model-x')).stage, 'shadow');
  const skip = await advanceStage(
    db,
    TEN,
    'model-x',
    { stage: 'canary', suite: 'gate', minPassRate: 1 },
    't',
    pass,
    NOW,
  );
  eq(skip.advanced, false, 'no skipping stages:');
  const fail = await advanceStage(
    db,
    TEN,
    'model-x',
    { stage: 'shadow', suite: 'gate', minPassRate: 1 },
    't',
    () => ({ pass: false }),
    NOW,
  );
  eq(fail.advanced, false, 'a failing gate holds:');
  eq((await rollbackStage(db, TEN, 'model-x', 'drill rollback', NOW)).stage, 'offline');
});

T('held-out suites stay out of the default path, visibly when used', async () => {
  const { db } = await fresh();
  await addCase(db, {
    tenant: TEN,
    capability: 'm',
    suite: 'heldout/final',
    input: { a: 1 },
    expect: { ok: true },
    kind: 'unit',
  });
  eq((await listCases(db, TEN)).length, 0, 'held out of listings by default:');
  eq((await listCases(db, TEN, undefined, { includeHeldOut: true })).length, 1);
  let code = '';
  try {
    await runSuite(db, TEN, 'heldout/final', 't', () => ({ pass: true }));
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('HELD_OUT_SUITE'), true);
  const run = await runSuite(db, TEN, 'heldout/final', 't', () => ({ pass: true }), { heldOut: true, now: NOW });
  eq(run.passed, 1);
  const audits = (await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'HELDOUT_RUN'").get()) as {
    n: number;
  };
  eq(audits.n, 1, 'held-out runs are audited:');
});
