import { T, eq, TEN, NOW, fresh, seedTrace, cardInput, withHarness, rejects } from './helpers.ts';
import { mineCandidates } from '../src/compiler/compiler.ts';
import { describeCard, describeCardReadOnly, listCards, runCardSuite } from '../src/compiler/registry.ts';
import { runCrossModelEvidence } from '../src/compiler/transfer.ts';
import { addCase } from '../src/evals/runner.ts';
import { JcodeAdapter, LocalEchoAdapter, type HarnessAdapter } from '../src/substrate/harness.ts';
console.log('\n\x1b[1mOrganizational Compiler — transfer before trust\x1b[0m');

T('git-imported packs always enter at QUARANTINE', async () => {
  const { comp } = await fresh();
  const c = await comp.compile({ ...cardInput([]), source: 'imported' });
  eq(c.state, 'QUARANTINE');
});

T('imported packs are third-party no matter what the importer claims', async () => {
  const { comp } = await fresh();
  const c = await comp.compile({ ...cardInput([]), source: 'imported', trustTier: 'internal' });
  eq(c.trustTier, 'third-party', 'foreign is foreign:');
  eq((await comp.get(TEN, c.id))!.trustTier, 'third-party', 'persisted, not just in memory:');
  const { comp: comp2 } = await fresh();
  const home = await comp2.compile(cardInput([]));
  eq(home.trustTier, 'internal');
});

T('quarantine entry is always allowed — scrutiny, not reward', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'q_ok', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['q_ok']));
  const r = await comp.attemptAdvance(TEN, c.id, 'QUARANTINE');
  eq(r.ok, true);
  eq((await comp.get(TEN, c.id))!.state, 'QUARANTINE');
});

T('the registry lists cards and says why each cannot be trusted yet', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'rg_ok', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['rg_ok']));
  eq((await listCards(comp, TEN)).length, 1);
  eq((await listCards(comp, TEN, { state: 'PROMOTED' })).length, 0);
  eq(
    (await listCards(comp, TEN, { state: 'CANDIDATE' })).map((x) => x.id),
    [c.id],
  );
  const desc = await describeCard(comp, TEN, c.id);
  eq(desc.transfers.length, 0);
  eq(desc.drift, null, 'drift is monitored only once promoted:');
  eq(desc.trustGaps.includes('no passing regression test'), true);
  eq(desc.trustGaps.includes('no eval suite reference (evals are the spec)'), true);
  await rejects(async () => await describeCard(comp, TEN, 'skl_nope'), 'MISSING_CARD');
});

T('a card runs its referenced eval suite; cards without one refuse', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'rs_ok', 'SUCCESS', 0.95);
  const bare = await comp.compile({ ...cardInput(['rs_ok']), evalRef: 'copy-regressions' });
  await addCase(db, {
    tenant: TEN,
    capability: 'compiler',
    suite: 'copy-regressions',
    input: { n: 1 },
    expect: { ok: true },
    kind: 'unit',
  });
  const run = await runCardSuite(db, comp, TEN, bare.id, 'card-target', () => ({ pass: true }), NOW);
  eq(run.failed, 0);
  const noref = await comp.compile(cardInput(['rs_ok']));
  let code = '';
  try {
    await runCardSuite(db, comp, TEN, noref.id, 't', () => ({ pass: true }), NOW);
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('NO_EVAL_REF'), true);
});

T('candidate mining surfaces repeated, compilable intents — and nothing else', async () => {
  const { db, comp } = await fresh();
  for (let i = 0; i < 4; i++) await seedTrace(comp, db, `m_ok${i}`, 'SUCCESS', 0.9);
  for (let i = 0; i < 2; i++) await seedTrace(comp, db, `m_few${i}`, 'SUCCESS', 0.9);
  await seedTrace(comp, db, 'm_low', 'SUCCESS', 0.2);
  await db.prepare("UPDATE traces SET intent = 'other-intent' WHERE id IN ('m_few0','m_few1')").run();
  const found = await mineCandidates(db, TEN, 3);
  eq(found.length, 1);
  eq(found[0]!.intent, 'draft-launch-copy');
  eq(found[0]!.repeats, 4);
  eq(found[0]!.successRate, 0.8, '4 compilable of 5 total (one the router doubted):');
});

T('compiler refusal names the bad trace in a mixed batch', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'mix_ok', 'SUCCESS', 0.95);
  await seedTrace(comp, db, 'mix_bad', 'UNRESOLVED', 0.95);
  let msg = '';
  try {
    await comp.compile(cardInput(['mix_ok', 'mix_bad']));
  } catch (e) {
    msg = (e as Error).message;
  }
  eq(msg.includes('mix_bad'), true, 'refusal names the trace:');
  eq(msg.includes('UNRESOLVED_TRACE'), true);
});

T('compiler refuses to learn from traces the router doubted', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_low', 'SUCCESS', 0.2);
  await rejects(async () => await comp.compile(cardInput(['tr_low'])), 'LOW_CONFIDENCE_TRACE');
});

T('compiler refuses unresolved traces', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_unres', 'UNRESOLVED', 0.9);
  await rejects(async () => await comp.compile(cardInput(['tr_unres'])), 'UNRESOLVED_TRACE');
});

T('promotion is blocked without transfer evidence, and says why', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_ok', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['tr_ok']));
  const r = await comp.attemptAdvance(TEN, c.id, 'PROMOTED', { pilotRuns: 999, pilotSuccessRate: 1 });
  eq(r.ok, false);
  eq(r.reasons.length > 0, true, 'must give a reason:');
});

T('illegal state jumps are refused (one step at a time)', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_j', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['tr_j']));
  const r = await comp.attemptAdvance(TEN, c.id, 'PROMOTED');
  eq(r.ok, false);
  eq(
    r.reasons.some((x) => x.includes('illegal transition')),
    true,
  );
});

T('scope expansion needs a per-role cross_role test', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_s', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['tr_s']));
  const promoted = { ...c, state: 'PROMOTED' as const };
  await db.prepare("UPDATE skill_cards SET state='PROMOTED' WHERE id = ?").run(c.id);
  const r = await comp.expandScope(TEN, c.id, 'sales');
  eq(r.ok, false);
  eq(r.reasons[0]!.includes('cross_role'), true);
  await comp.recordTransfer(promoted, { kind: 'cross_role', variant: 'sales', passed: true, score: 0.97, ranAt: NOW });
  const ok = await comp.expandScope(TEN, c.id, 'sales');
  eq(ok.ok, true);
  eq(ok.card!.scopeRoles.includes('sales'), true);
});

T('concurrent scope expansions do not merge-lose a role', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_r', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['tr_r']));
  const promoted = { ...c, state: 'PROMOTED' as const };
  await db.prepare("UPDATE skill_cards SET state='PROMOTED' WHERE id = ?").run(c.id);
  for (const role of ['sales', 'support']) {
    await comp.recordTransfer(promoted, { kind: 'cross_role', variant: role, passed: true, score: 0.97, ranAt: NOW });
  }
  const settled = await Promise.allSettled([
    comp.expandScope(TEN, c.id, 'sales'),
    comp.expandScope(TEN, c.id, 'support'),
  ]);
  const wins = settled.filter((s) => s.status === 'fulfilled' && s.value.ok);
  const conflicts = settled.filter(
    (s) => s.status === 'rejected' && String((s as PromiseRejectedResult).reason).includes('STATE_CONFLICT'),
  );
  eq(wins.length, 1, 'exactly one expansion wins:');
  eq(conflicts.length, 1, 'the loser fails loud with STATE_CONFLICT, not a quiet ok:false:');
  const final = (await comp.get(TEN, c.id))!;
  eq(final.scopeRoles.includes('sales') !== final.scopeRoles.includes('support'), true, 'winner kept, no merge:');
});

T('drift detection auto-demotes a decaying procedure', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_d', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['tr_d']));
  await db.prepare("UPDATE skill_cards SET state='PROMOTED' WHERE id = ?").run(c.id);
  for (let i = 0; i < 20; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `bad${i}`,
        TEN,
        'marketing',
        'x',
        'draft-launch-copy',
        '[]',
        'WORKFLOW',
        'FAILURE',
        '{}',
        c.id,
        0.9,
        `2026-09-0${(i % 9) + 1}T00:00:00Z`,
      );
  }
  const d = await comp.checkDrift(TEN, c.id);
  eq(d.drifting, true);
  eq(d.demoted, true);
  eq((await comp.get(TEN, c.id))!.state, 'DEMOTED');
});

T('F06: the read-only description reports drift without acting; evaluation still demotes', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'ro_ok', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['ro_ok']));
  await db.prepare("UPDATE skill_cards SET state='PROMOTED' WHERE id = ?").run(c.id);
  for (let i = 0; i < 20; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `robad${i}`,
        TEN,
        'marketing',
        'x',
        'draft-launch-copy',
        '[]',
        'WORKFLOW',
        'FAILURE',
        '{}',
        c.id,
        0.9,
        `2026-09-0${(i % 9) + 1}T00:00:00Z`,
      );
  }
  const auditsBefore = Number(
    ((await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN)) as { n: number }).n,
  );
  const peeked = await describeCardReadOnly(db, comp, TEN, c.id);
  eq(peeked.drift?.drifting, true, 'decay is visible on the read-only path:');
  eq(peeked.drift?.demoted, false, 'but the read never demotes:');
  eq(
    peeked.trustGaps.includes('drifting: live success below validated baseline'),
    true,
    'the gap line still names it:',
  );
  eq((await comp.get(TEN, c.id))!.state, 'PROMOTED', 'state untouched:');
  eq(
    Number(((await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN)) as { n: number }).n),
    auditsBefore,
    'no audit rows from a read:',
  );
  const evaluated = await describeCard(comp, TEN, c.id);
  eq(evaluated.drift?.demoted, true, 'the evaluating path still demotes:');
  eq((await comp.get(TEN, c.id))!.state, 'DEMOTED');
});

T('concurrent advances: the stale writer throws STATE_CONFLICT', async () => {
  // Both callers read CANDIDATE and both pass the gate; the row itself moves
  // exactly once. The loser must throw, never mint a second version over the
  // winner's state with a stale base.
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'cc_ok', 'SUCCESS', 0.95);
  const c = await comp.compile(cardInput(['cc_ok']));
  const [a, b] = await Promise.allSettled([
    comp.attemptAdvance(TEN, c.id, 'QUARANTINE'),
    comp.attemptAdvance(TEN, c.id, 'QUARANTINE'),
  ]);
  const wins = [a, b].filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
    ok: boolean;
  }>[];
  const losses = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  eq(wins.length, 1, 'one advancer wins:');
  eq(wins[0]!.value.ok, true);
  eq(losses.length, 1, 'the other loses:');
  eq(String(losses[0]!.reason?.message ?? losses[0]!.reason).includes('STATE_CONFLICT'), true, 'to a conflict:');
  eq((await comp.get(TEN, c.id))!.state, 'QUARANTINE');
  eq((await comp.get(TEN, c.id))!.version, 2, 'a single version bump — no double advance:');
});

T('cross-model evidence runs the same intent on every harness and banks it', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await seedTrace(comp, db, 'xm_ok', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['xm_ok']));
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'x',
    kind: 'OBSERVATION',
    statement: 'ground',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'engineering',
    authorType: 'system',
    provenance: {
      sourceUri: 'u',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'e',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });
  await withHarness(async (h) => {
    const runs = await runCrossModelEvidence(
      coord,
      comp,
      TEN,
      card.id,
      [new LocalEchoAdapter(db, ledger, coord), new JcodeAdapter(db, ledger, coord, { socketPath: h.path })],
      {
        originScope: 'marketing',
        targetScope: 'engineering',
        command: 'draft it',
        claimIds: [clm.id],
        onBehalfOf: 'human:priya',
        maxDollars: 2,
        maxTokens: 20_000,
        now: NOW,
      },
    );
    eq(runs.map((r) => r.adapter).sort(), ['jcode', 'local-echo']);
    eq(
      runs.every((r) => r.status === 'COMPLETED' && r.recorded),
      true,
    );
    const ev = (await comp.transferResults(card.id)).filter((t) => t.kind === 'cross_model');
    eq(ev.length, 2);
    eq(
      ev.every((t) => t.passed),
      true,
      'both harnesses proved the transfer:',
    );
  });
  let code = '';
  try {
    await runCrossModelEvidence(coord, comp, TEN, 'skl_nope', [new LocalEchoAdapter(db, ledger, coord)], {
      originScope: 'm',
      targetScope: 'e',
      command: 'x',
      claimIds: [],
      onBehalfOf: 'h',
      maxDollars: 1,
      maxTokens: 1,
      now: NOW,
    });
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('MISSING_CARD'), true);
});

T('F18: subsequent failure in a variant invalidates historical pass in attemptAdvance', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_f18', 'SUCCESS', 0.95);
  const card = await comp.compile({ ...cardInput(['tr_f18']), evalRef: 'suite_f18' });

  // Record an initial passing regression test at T0
  await comp.recordTransfer(card, {
    kind: 'regression',
    variant: 'suite_v1',
    passed: true,
    score: 1.0,
    ranAt: '2026-09-17T10:00:00.000Z',
  });

  // Advance to QUARANTINE
  const q = await comp.attemptAdvance(TEN, card.id, 'QUARANTINE');
  eq(q.ok, true);

  // Advance to SHADOW should succeed because regression passed
  const s = await comp.attemptAdvance(TEN, card.id, 'SHADOW');
  eq(s.ok, true);

  // Now record a subsequent FAILING regression test for the same variant at T1
  await comp.recordTransfer(card, {
    kind: 'regression',
    variant: 'suite_v1',
    passed: false,
    score: 0.2,
    ranAt: '2026-09-17T11:00:00.000Z',
  });

  // Now attempt to advance to BOUNDED_PILOT:
  // Even though there is a historical pass at 10:00, the latest run at 11:00 failed!
  const pilot = await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', { shadowRuns: 30, shadowSuccessRate: 0.95 });
  eq(pilot.ok, false);
  eq(
    pilot.reasons.some((r) => r.includes('regression tests not passing')),
    true,
  );
});

T('F18: adapter exceptions bank negative transfer results instead of aborting', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await seedTrace(comp, db, 'tr_f18_ex', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['tr_f18_ex']));

  const clm = await ledger.append({
    tenant: TEN,
    subject: 'x',
    kind: 'OBSERVATION',
    statement: 'ground',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'engineering',
    authorType: 'system',
    provenance: {
      sourceUri: 'u',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'e',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });

  // Create a failing adapter that throws an error
  const crashingAdapter: HarnessAdapter = {
    name: 'crashing-model',
    async run() {
      throw new Error('connection refused: model unavailable');
    },
  };

  const runs = await runCrossModelEvidence(
    coord,
    comp,
    TEN,
    card.id,
    [crashingAdapter, new LocalEchoAdapter(db, ledger, coord)],
    {
      originScope: 'marketing',
      targetScope: 'engineering',
      command: 'draft it',
      claimIds: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 2,
      maxTokens: 20_000,
      now: NOW,
    },
  );

  // Both adapters finished: crashing-model banked a FAILED result, local-echo succeeded
  eq(runs.length, 2);
  const crashRun = runs.find((r) => r.adapter === 'crashing-model');
  eq(crashRun?.status, 'FAILED');

  const transferRows = await comp.transferResults(card.id);
  const crashTest = transferRows.find((t) => t.variant === 'crashing-model');
  eq(crashTest?.passed, false);
  eq(crashTest?.score, 0);
});
