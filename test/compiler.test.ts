import { T, eq, TEN, NOW, fresh, seedTrace, cardInput, withHarness, rejects } from './helpers.ts';
import { mineCandidates, type TransferTest } from '../src/compiler/compiler.ts';
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

T('F23: foreign source traces are unknown and compilation leaves no card or audit', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tenant_home', 'SUCCESS', 0.95);
  await seedTrace(comp, db, 'tenant_foreign', 'SUCCESS', 0.95);
  await db.prepare('UPDATE traces SET tenant = ? WHERE id = ?').run('other-tenant', 'tenant_foreign');
  const cardsBefore = await db.prepare('SELECT * FROM skill_cards').all();
  const auditsBefore = await db.prepare('SELECT * FROM audit_log').all();

  for (const outcome of ['SUCCESS', 'UNRESOLVED']) {
    await db.prepare('UPDATE traces SET outcome = ? WHERE id = ?').run(outcome, 'tenant_foreign');
    await rejects(() => comp.compile(cardInput(['tenant_home', 'tenant_foreign'])), 'UNKNOWN_TRACE');
    eq(await db.prepare('SELECT * FROM skill_cards').all(), cardsBefore, 'no card from a mixed-tenant batch:');
    eq(await db.prepare('SELECT * FROM audit_log').all(), auditsBefore, 'no audit from a refused compile:');
  }

  const card = await comp.compile(cardInput(['tenant_home']));
  eq(card.tenant, TEN);
  eq(card.provenance.traceIds, ['tenant_home']);
  eq(await comp.get(TEN, card.id), card);
  eq(
    (await db.prepare("SELECT * FROM audit_log WHERE action = 'CARD_COMPILED' AND target = ?").all(card.id)).length,
    1,
  );
});

T('F23: transfer reads require the owning tenant, including registry reads', async () => {
  const { db, comp } = await fresh();
  const card = await comp.compile(cardInput([]));
  const test: TransferTest = { kind: 'regression', variant: 'suite', passed: true, score: 0.97, ranAt: NOW };
  await comp.recordTransfer(card, test);
  eq(await comp.transferResults(TEN, card.id), [test]);
  eq(await comp.transferResults('other-tenant', card.id), []);
  eq(await comp.transferResults(TEN, 'skl_missing'), []);
  eq((await describeCard(comp, TEN, card.id)).transfers, [test]);
  eq((await describeCardReadOnly(db, comp, TEN, card.id)).transfers, [test]);
  await rejects(() => describeCard(comp, 'other-tenant', card.id), 'MISSING_CARD');
  await rejects(() => describeCardReadOnly(db, comp, 'other-tenant', card.id), 'MISSING_CARD');
});

T('F23: forged tenant cards cannot record transfer evidence', async () => {
  const { db, comp } = await fresh();
  const card = await comp.compile({ ...cardInput([]), tenant: 'other-tenant' });
  const test: TransferTest = { kind: 'cross_model', variant: 'model', passed: true, score: 1, ranAt: NOW };
  await comp.recordTransfer(card, test);
  const transfersBefore = await db.prepare('SELECT * FROM skill_transfer_tests').all();
  const auditsBefore = await db.prepare('SELECT * FROM audit_log').all();

  await rejects(() => comp.recordTransfer({ ...card, tenant: TEN }, { ...test, passed: false }), 'UNKNOWN_CARD');
  await rejects(() => comp.recordTransfer({ ...card, id: 'skl_missing' }, test), 'UNKNOWN_CARD');
  eq(await db.prepare('SELECT * FROM skill_transfer_tests').all(), transfersBefore, 'no foreign or orphan evidence:');
  eq(await db.prepare('SELECT * FROM audit_log').all(), auditsBefore);
  eq(await comp.get(card.tenant, card.id), card);
  eq(await comp.transferResults(card.tenant, card.id), [test]);
  eq(await comp.transferResults(TEN, card.id), []);
});

T('F23: an existing id is a creation collision, never an overwrite', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'c_ok', 'SUCCESS', 0.95);
  await seedTrace(comp, db, 'c_foreign', 'SUCCESS', 0.95);
  await db.prepare('UPDATE traces SET tenant = ? WHERE id = ?').run('other-tenant', 'c_foreign');
  const original = await comp.compile({ ...cardInput(['c_ok']), id: 'skl_dup' });
  const cardsBefore = await db.prepare('SELECT * FROM skill_cards').all();
  const auditsBefore = await db.prepare('SELECT * FROM audit_log').all();

  // Same tenant, different content: must not touch the original row.
  await rejects(
    () =>
      comp.compile({
        ...cardInput(['c_ok']),
        id: 'skl_dup',
        source: 'imported',
        originScope: 'engineering',
        intent: 'other-intent',
        steps: ['hijack'],
        tests: ['regression:hijack.v1'],
        evalRef: 'suite_hijack',
        owner: 'human:mallory',
      }),
    'CARD_EXISTS',
  );
  eq(await db.prepare('SELECT * FROM skill_cards').all(), cardsBefore, 'same-tenant card row untouched:');
  eq(await db.prepare('SELECT * FROM audit_log').all(), auditsBefore, 'no audit from same-tenant refusal:');
  // Foreign tenant reusing the id: same refusal, no cross-tenant write.
  await rejects(
    () =>
      comp.compile({
        ...cardInput(['c_foreign']),
        id: 'skl_dup',
        tenant: 'other-tenant',
        source: 'imported',
        originScope: 'engineering',
        intent: 'other-intent',
        steps: ['hijack'],
        tests: ['regression:hijack.v1'],
        evalRef: 'suite_hijack',
        owner: 'human:mallory',
      }),
    'CARD_EXISTS',
  );
  eq(await db.prepare('SELECT * FROM skill_cards').all(), cardsBefore, 'original card row untouched:');
  eq(await db.prepare('SELECT * FROM audit_log').all(), auditsBefore, 'no audit rows from refusals:');
  eq(await comp.get(TEN, 'skl_dup'), original);
  eq(await comp.get('other-tenant', 'skl_dup'), null);

  // A fresh explicit id still compiles normally.
  const freshCard = await comp.compile({ ...cardInput(['c_ok']), id: 'skl_new' });
  eq(freshCard.id, 'skl_new');
  eq(freshCard.provenance.traceIds, ['c_ok']);
  eq(await comp.get(TEN, 'skl_new'), freshCard);
  eq(
    (await db.prepare("SELECT * FROM audit_log WHERE action = 'CARD_COMPILED' AND target = ?").all(freshCard.id))
      .length,
    1,
  );
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
    const evModel = (await comp.transferResults(TEN, card.id)).filter((t) => t.kind === 'cross_model');
    const evSmoke = (await comp.transferResults(TEN, card.id)).filter((t) => t.kind === 'harness_smoke');
    eq(evModel.length, 1, 'jcode banks authentic cross_model transfer:');
    eq(evModel[0]!.variant, 'jcode');
    eq(evModel[0]!.passed, true);
    eq(evSmoke.length, 1, 'local-echo is reclassified as harness_smoke, not cross_model:');
    eq(evSmoke[0]!.variant, 'local-echo');
    eq(evSmoke[0]!.passed, true);
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

  const transferRows = await comp.transferResults(TEN, card.id);
  const crashTest = transferRows.find((t) => t.variant === 'crashing-model');
  eq(crashTest?.passed, false);
  eq(crashTest?.score, 0);
});

T('F18: runCardSuite automatically banks linked regression gate evidence with evalRunId and cardVersion', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_ev_link', 'SUCCESS', 0.95);
  const card = await comp.compile({ ...cardInput(['tr_ev_link']), evalRef: 'suite_linked' });

  await addCase(db, {
    tenant: TEN,
    capability: 'compiler',
    suite: 'suite_linked',
    input: { x: 1 },
    expect: { y: 2 },
    kind: 'unit',
  });

  const suiteRun = await runCardSuite(db, comp, TEN, card.id, 'evaluator_v1', () => ({ pass: true }), NOW);
  eq(suiteRun.passed, 1);
  eq(suiteRun.failed, 0);

  const transfers = await comp.transferResults(TEN, card.id);
  const regTest = transfers.find((t) => t.kind === 'regression');
  eq(Boolean(regTest), true, 'regression test was automatically banked');
  eq(regTest?.variant, 'suite_linked');
  eq(regTest?.passed, true);
  eq(regTest?.evalRunId, suiteRun.id, 'linked to eval run id');
  eq(regTest?.cardVersion, card.version, 'bound to card version');
  eq(regTest?.evaluator, 'evaluator_v1', 'recorded evaluator identity');

  // Now advance to QUARANTINE then SHADOW — should succeed without manual recordTransfer!
  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);
  const shadowAdv = await comp.attemptAdvance(TEN, card.id, 'SHADOW');
  eq(shadowAdv.ok, true, 'promotes to SHADOW using linked eval suite evidence');
});

T('F18: harness_smoke evidence from LocalEchoAdapter does not satisfy cross_model gate', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await seedTrace(comp, db, 'tr_smoke_gate', 'SUCCESS', 0.95);
  const card = await comp.compile({ ...cardInput(['tr_smoke_gate']), evalRef: 'smoke_suite' });

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

  // Run cross-model evidence with ONLY LocalEchoAdapter (test baseline)
  const runs = await runCrossModelEvidence(coord, comp, TEN, card.id, [new LocalEchoAdapter(db, ledger, coord)], {
    originScope: 'marketing',
    targetScope: 'engineering',
    command: 'smoke test',
    claimIds: [clm.id],
    onBehalfOf: 'human:priya',
    maxDollars: 1,
    maxTokens: 10_000,
    now: NOW,
  });

  eq(runs.length, 1);
  eq(runs[0]!.kind, 'harness_smoke');
  eq(runs[0]!.status, 'COMPLETED');

  // Also record passing regression test so that doesn't block
  await comp.recordTransfer(card, { kind: 'regression', variant: 'smoke_suite', passed: true, score: 1, ranAt: NOW });

  // Advance to QUARANTINE and SHADOW
  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'SHADOW')).ok, true);

  // Attempt to advance to BOUNDED_PILOT: harness_smoke alone MUST NOT satisfy cross_model!
  const pilotAdv = await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', {
    shadowRuns: 30,
    shadowSuccessRate: 0.95,
  });
  eq(pilotAdv.ok, false);
  eq(
    pilotAdv.reasons.some((r) => r.includes('cross-model transfer test required')),
    true,
  );
});

T('F18: independent quality assertion fails transfer test even if harness transport COMPLETED', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await seedTrace(comp, db, 'tr_qa', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['tr_qa']));

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

  // Mock adapter representing a model whose transport succeeds
  const mockModelAdapter: HarnessAdapter = {
    name: 'real-model-1',
    category: 'model',
    isTestBaseline: false,
    model: 'model-xyz',
    async run(_tenant, reqId) {
      return {
        adapter: 'real-model-1',
        requestId: reqId,
        status: 'COMPLETED',
        transcript: 'Generated hallucinated or garbage output',
        tools: [],
        usage: { input: 100, output: 50 },
        permissions: [],
      };
    },
  };

  // Run with quality assertion that fails because output was inadequate
  const runs = await runCrossModelEvidence(coord, comp, TEN, card.id, [mockModelAdapter], {
    originScope: 'marketing',
    targetScope: 'engineering',
    command: 'test command',
    claimIds: [clm.id],
    onBehalfOf: 'human:priya',
    maxDollars: 1,
    maxTokens: 10_000,
    now: NOW,
    assertQuality: async (outcome) => {
      const pass = outcome.transcript.includes('CORRECT_ANSWER');
      return { pass, score: pass ? 1.0 : 0.2, reason: 'output did not match expected structure' };
    },
  });

  eq(runs.length, 1);
  eq(runs[0]!.status, 'COMPLETED');
  eq(runs[0]!.passed, false, 'marked failed due to quality assertion');
  eq(runs[0]!.score, 0.2);

  const transfer = (await comp.transferResults(TEN, card.id)).find((t) => t.variant === 'real-model-1');
  eq(transfer?.passed, false, 'persisted as failed test');
  eq(transfer?.score, 0.2);
  eq(transfer?.evaluator, 'quality-assertion');
  eq(transfer?.model, 'model-xyz');
});

T('F18: attemptAdvance derives shadow and pilot statistics from persisted traces when omitted', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_derive', 'SUCCESS', 0.95);
  const card = await comp.compile({ ...cardInput(['tr_derive']), evalRef: 'derive_suite' });

  await comp.recordTransfer(card, { kind: 'regression', variant: 'derive_suite', passed: true, score: 1, ranAt: NOW });
  await comp.recordTransfer(card, { kind: 'cross_model', variant: 'real_model', passed: true, score: 1, ranAt: NOW });
  await comp.recordTransfer(card, { kind: 'data_regime', variant: 'regime_1', passed: true, score: 1, ranAt: NOW });

  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'SHADOW')).ok, true);

  // Without any traces seeded, attemptAdvance without explicit evidence fails with 0 runs
  const failPilot = await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT');
  eq(failPilot.ok, false);
  eq(
    failPilot.reasons.some((r) => r.includes('need ≥20 shadow runs, got 0')),
    true,
  );

  // Seed 25 traces (24 SUCCESS, 1 FAILURE -> 96% success rate)
  for (let i = 0; i < 25; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `tr_shadow_${i}`,
        TEN,
        'marketing',
        'x',
        card.intent,
        '[]',
        'MODEL',
        i === 0 ? 'FAILURE' : 'SUCCESS',
        '{}',
        card.id,
        0.95,
        NOW,
      );
  }

  // Now advance to BOUNDED_PILOT without passing explicit evidence -> derives from traces!
  const pilotAdv = await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT');
  eq(pilotAdv.ok, true, 'shadow statistics successfully derived from persisted traces');

  // For PROMOTED, requires 50 WORKFLOW tier runs
  const failPromote = await comp.attemptAdvance(TEN, card.id, 'PROMOTED');
  eq(failPromote.ok, false);
  eq(
    failPromote.reasons.some((r) => r.includes('need ≥50 pilot runs, got 0')),
    true,
  );

  // Seed 55 WORKFLOW traces for pilot (54 SUCCESS, 1 FAILURE -> 98% success rate)
  for (let i = 0; i < 55; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `tr_pilot_${i}`,
        TEN,
        'marketing',
        'x',
        card.intent,
        '[]',
        'WORKFLOW',
        i === 0 ? 'FAILURE' : 'SUCCESS',
        '{}',
        card.id,
        0.95,
        NOW,
      );
  }

  // Advance to PROMOTED without passing explicit evidence -> derives from WORKFLOW traces!
  const promoteAdv = await comp.attemptAdvance(TEN, card.id, 'PROMOTED');
  eq(promoteAdv.ok, true, 'pilot statistics successfully derived from persisted traces');
});

T('F18: attemptAdvance validates referenced evalRunId against suite and pass status', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_eval_ref', 'SUCCESS', 0.95);
  const card = await comp.compile({ ...cardInput(['tr_eval_ref']), evalRef: 'eval_suite_target' });

  // Record passing regression test
  await comp.recordTransfer(card, {
    kind: 'regression',
    variant: 'eval_suite_target',
    passed: true,
    score: 1,
    ranAt: NOW,
  });
  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);

  // 1. Missing eval run ID fails
  const missingAdv = await comp.attemptAdvance(TEN, card.id, 'SHADOW', { evalRunId: 'evr_nonexistent' });
  eq(missingAdv.ok, false);
  eq(
    missingAdv.reasons.some((r) => r.includes('referenced eval run evr_nonexistent not found')),
    true,
  );

  // 2. Eval run for wrong suite fails
  await db
    .prepare(
      'INSERT INTO eval_runs (id, tenant, suite, target, passed, failed, detail_json, ran_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run('evr_wrong_suite', TEN, 'other_suite', 't', 1, 0, '[]', NOW);
  const wrongSuiteAdv = await comp.attemptAdvance(TEN, card.id, 'SHADOW', { evalRunId: 'evr_wrong_suite' });
  eq(wrongSuiteAdv.ok, false);
  eq(
    wrongSuiteAdv.reasons.some((r) => r.includes('is for suite other_suite, expected eval_suite_target')),
    true,
  );

  // 3. Eval run with failures fails
  await db
    .prepare(
      'INSERT INTO eval_runs (id, tenant, suite, target, passed, failed, detail_json, ran_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run('evr_failed', TEN, 'eval_suite_target', 't', 1, 2, '[]', NOW);
  const failedRunAdv = await comp.attemptAdvance(TEN, card.id, 'SHADOW', { evalRunId: 'evr_failed' });
  eq(failedRunAdv.ok, false);
  eq(
    failedRunAdv.reasons.some((r) => r.includes('eval run evr_failed failed')),
    true,
  );

  // 4. Valid passing eval run succeeds
  await db
    .prepare(
      'INSERT INTO eval_runs (id, tenant, suite, target, passed, failed, detail_json, ran_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run('evr_passed', TEN, 'eval_suite_target', 't', 3, 0, '[]', NOW);
  const validAdv = await comp.attemptAdvance(TEN, card.id, 'SHADOW', { evalRunId: 'evr_passed' });
  eq(validAdv.ok, true);
});

T('F23: skill_transfer_tests records tenant and isolates results by tenant', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_iso', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['tr_iso']));

  await comp.recordTransfer(card, {
    kind: 'regression',
    variant: 'v1',
    passed: true,
    score: 1,
    ranAt: NOW,
  });

  // Verify the row in skill_transfer_tests holds tenant = TEN directly
  const row = (await db
    .prepare('SELECT tenant, card_id, kind, passed FROM skill_transfer_tests WHERE card_id = ?')
    .get(card.id)) as { tenant: string; card_id: string; kind: string; passed: number };
  eq(row.tenant, TEN);
  eq(row.card_id, card.id);

  // Tenant-scoped queries return evidence; another tenant gets nothing
  const ownResults = await comp.transferResults(TEN, card.id);
  eq(ownResults.length, 1);
  const foreignResults = await comp.transferResults('other-tenant', card.id);
  eq(foreignResults.length, 0);

  // Spoofed tenant card cannot record transfer against a foreign card
  const spoofedCard = { ...card, tenant: 'attacker' };
  await rejects(
    async () =>
      comp.recordTransfer(spoofedCard, {
        kind: 'regression',
        variant: 'v1',
        passed: true,
        score: 1,
        ranAt: NOW,
      }),
    'UNKNOWN_CARD',
  );
});

T('F23: cardRevisions records durable revision lineage on compile, advance, and scope expansion', async () => {
  const { db, comp } = await fresh();
  await seedTrace(comp, db, 'tr_rev', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['tr_rev']));

  // Rev 1: COMPILED
  let revs = await comp.cardRevisions(TEN, card.id);
  eq(revs.length, 1);
  eq(revs[0]!.version, 1);
  eq(revs[0]!.action, 'CARD_COMPILED');
  eq(revs[0]!.state, 'CANDIDATE');

  // Rev 2: advance to QUARANTINE
  await comp.attemptAdvance(TEN, card.id, 'QUARANTINE');
  revs = await comp.cardRevisions(TEN, card.id);
  eq(revs.length, 2);
  eq(revs[1]!.version, 2);
  eq(revs[1]!.state, 'QUARANTINE');
  eq(revs[1]!.action, 'CARD_QUARANTINE');

  // Verify describeCard returns the revisions
  const desc = await describeCard(comp, TEN, card.id);
  eq(desc.revisions?.length, 2);
  eq(desc.revisions?.[0]?.version, 1);
  eq(desc.revisions?.[1]?.version, 2);
});
