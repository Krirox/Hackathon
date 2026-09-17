import { T, eq, TEN, NOW, fresh, rIn } from './helpers.ts';
console.log('\n\x1b[1mCognitive Router — shadow-first\x1b[0m');

T('controlRate starts at 0 — router proposes, policy executes', async () => {
  const { router } = await fresh();
  eq(router.controlRate, 0);
  const d = await router.route(rIn());
  eq(d.shadow, true);
  eq(d.tier, 'MODEL', 'policy floor:');
});

T('irreversible actions always fail UP to a human', async () => {
  const { router } = await fresh();
  const d = await router.route(rIn({ taskType: 'pricing.change', actionClass: 'ACT_IRREVERSIBLE', reversible: false }));
  eq(d.tier, 'HUMAN');
});

T('reflex registry handles deterministic work at zero cost', async () => {
  const { router } = await fresh();
  const d = await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  eq(d.tier, 'REFLEX');
});

T('coupling guard: a card validated for another scope cannot run here', async () => {
  const { router } = await fresh();
  const d = await router.route(
    rIn({
      taskType: 'launch.copy.draft',
      skillCard: {
        id: 'skl_x',
        state: 'PROMOTED',
        validatedAtTier: 'WORKFLOW',
        scopeRoles: ['sales'],
        scopeModels: ['m'],
      },
    }),
  );
  eq(d.policyBaseline, 'MODEL');
});

T('coupling guard: a card cannot run on a model it was not validated on', async () => {
  const { router } = await fresh(undefined, { controlRate: 1, rng: () => 0 });
  await router.registerTaskType('memo.draft');
  const card = {
    id: 'skl_m2',
    state: 'PROMOTED',
    validatedAtTier: 'WORKFLOW' as const,
    scopeRoles: ['marketing'],
    scopeModels: ['claude'],
  };
  const on = await router.route(rIn({ taskType: 'memo.draft', importance: 0.1, model: 'claude', skillCard: card }));
  eq(on.tier, 'WORKFLOW', 'the validated model runs the card:');
  const off = await router.route(
    rIn({ taskType: 'memo.draft', importance: 0.1, model: 'novita/deepseek-v4', skillCard: card }),
  );
  eq(off.tier, 'MODEL', 'an unvalidated model degrades to MODEL:');
  eq(
    off.guards.some((g) => g.includes('skill_model_mismatch')),
    true,
  );
  const wrongTier = await router.route(
    rIn({
      taskType: 'memo.draft',
      importance: 0.1,
      model: 'claude',
      skillCard: { ...card, validatedAtTier: 'MODEL' as const },
    }),
  );
  eq(wrongTier.tier, 'MODEL', 'a card validated below WORKFLOW never runs as WORKFLOW:');
});

T('precision gate stays closed until enough labeled samples', async () => {
  const { router } = await fresh();
  const p = await router.precision(TEN);
  eq(p.samples, 0);
  eq(p.readyForControl, false);
});

T('label() feeds precision; budgetBreaches fires past budget', async () => {
  const { db, router } = await fresh();
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    await router.route(rIn());
    ids.push(((await db.prepare('SELECT max(id) AS m FROM routing_decisions').get()) as { m: number }).m);
  }
  await router.label(ids[0]!, 'MODEL');
  await router.label(ids[1]!, 'MODEL');
  await router.label(ids[2]!, 'HUMAN');
  const p = await router.precision(TEN);
  eq(p.samples, 3);
  eq(p.readyForControl, false, '3 samples never clear a 2000-sample gate:');
  for (let i = 0; i < 60; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `bb${i}`,
        TEN,
        null,
        'marketing',
        't',
        'i',
        '[]',
        'MODEL',
        i % 5 === 0 ? 'FAILURE' : 'SUCCESS',
        '{}',
        null,
        0.9,
        NOW,
      );
  }
  eq(
    (await router.budgetBreaches(TEN)).some((x) => x.tier === 'MODEL'),
    true,
    '20% failure blows the 10% MODEL budget:',
  );
});

T('undeclared task types are refused, not guessed', async () => {
  const { router } = await fresh();
  let code = '';
  try {
    await router.route(rIn({ taskType: 'mind.meld' }));
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('UNKNOWN_TASK_TYPE'), true);
  await router.registerTaskType('mind.meld');
  eq((await router.route(rIn({ taskType: 'mind.meld' }))).tier, 'MODEL');
});

T('the coupling guard holds under router control, not just in shadow', async () => {
  const { router } = await fresh(undefined, { controlRate: 1, rng: () => 0 });
  const d = await router.route(
    rIn({
      taskType: 'launch.copy.draft',
      skillCard: {
        id: 'skl_x',
        state: 'PROMOTED',
        validatedAtTier: 'WORKFLOW',
        scopeRoles: ['sales'],
        scopeModels: ['m'],
      },
    }),
  );
  eq(d.shadow, false, 'router is in control:');
  eq(d.tier, 'MODEL', 'wrong-scope card degrades to MODEL even in control:');
  eq(
    d.guards.some((g) => g.includes('skill_scope_mismatch')),
    true,
  );
});

T('calibration memory records per task×tier×model outcomes', async () => {
  const { router } = await fresh();
  for (let i = 0; i < 8; i++)
    await router.recordCalibrationSample(TEN, 'launch.copy.draft', 'MODEL', 'claude', i < 6, NOW);
  for (let i = 0; i < 4; i++)
    await router.recordCalibrationSample(TEN, 'launch.copy.draft', 'REFLEX', 'rules', true, NOW);
  const cal = await router.calibration(TEN, 'launch.copy.draft');
  const model = cal.find((c) => c.tier === 'MODEL')!;
  eq(model.total, 8);
  eq(model.rate, 0.75);
  eq(cal.find((c) => c.tier === 'REFLEX')!.rate, 1);
  eq((await router.calibration(TEN, 'unknown.task')).length, 0);
});

T('the labeling queue proposes with evidence but never auto-labels', async () => {
  const { db, router } = await fresh();
  await router.route(rIn());
  await router.route(rIn());
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run('lq1', TEN, null, 'marketing', 'launch.copy.draft', 'i', '[]', 'MODEL', 'SUCCESS', '{}', null, 0.9, NOW);
  const q = await router.labelingQueue(TEN);
  eq(q.length, 2);
  eq(q[0]!.evidence, { traces: 1, successRate: 1 });
  eq((await router.precision(TEN)).samples, 0, 'evidence proposes; only label() disposes:');
  await router.label(q[0]!.id, 'MODEL');
  eq((await router.precision(TEN)).samples, 1);
});

T('reflex coverage measures how much traffic policy handles alone', async () => {
  const { router } = await fresh();
  await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  await router.route(rIn());
  const cov = await router.reflexCoverage(TEN);
  eq(cov.total, 3);
  eq(cov.reflex, 2, 'two deterministic, one model-floor:');
});

T('cost-per-signal: the expensive tier sees a minority of arrivals, gate at <1%', async () => {
  const { router } = await fresh(undefined, { controlRate: 1, rng: () => 0.5 });
  router.registerTaskType('memo.draft'); // not reflex/modelFloor-listed → WORKFLOW-proposable via a validated card
  const card = {
    id: 'skl_cps',
    state: 'PROMOTED' as const,
    validatedAtTier: 'WORKFLOW' as const,
    scopeRoles: ['marketing'],
    scopeModels: ['m'],
  };
  // 50 reflex arrivals, 49 workflow arrivals, and exactly 1 model-priced one.
  for (let i = 0; i < 50; i++) await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  for (let i = 0; i < 49; i++) await router.route(rIn({ taskType: 'memo.draft', skillCard: card, model: 'm' }));
  await router.route(rIn({ taskType: 'memo.draft', model: 'm' }));

  const cps = await router.costPerSignal(TEN);
  eq(cps.arrivals, 100);
  eq(cps.byTier['MODEL'], 1, 'exactly one model-priced arrival:');
  eq(cps.byTier['WORKFLOW'], 49);
  eq(cps.byTier['REFLEX'], 50);
  eq(cps.modelShare, 0.01);
  eq(cps.withinGate, false, '1.00% is not <1% — the gate is strict:');
  eq(cps.gate, 0.01);
});

T('cost-per-signal passes comfortably when the inbox is sorted', async () => {
  const { router } = await fresh();
  for (let i = 0; i < 200; i++) await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  const cps = await router.costPerSignal(TEN);
  eq(cps.arrivals, 200);
  eq(cps.byTier['MODEL'] ?? 0, 0, 'reflex handled everything:');
  eq(cps.modelShare, 0);
  eq(cps.withinGate, true);
});

T('a tier past its error budget reverts to the fixed policy, even in control', async () => {
  const { db, router } = await fresh(undefined, { controlRate: 1, rng: () => 0 });
  await router.registerTaskType('memo.draft');
  const card = {
    id: 'skl_m',
    state: 'PROMOTED',
    validatedAtTier: 'WORKFLOW' as const,
    scopeRoles: ['marketing'],
    scopeModels: ['m'],
  };
  const before = await router.route(rIn({ taskType: 'memo.draft', importance: 0.1, skillCard: card }));
  eq(before.shadow, false);
  eq(before.tier, 'WORKFLOW', 'healthy tier runs the card in control:');
  for (let i = 0; i < 60; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `rv${i}`,
        TEN,
        null,
        'marketing',
        't',
        'i',
        '[]',
        'WORKFLOW',
        i % 6 === 0 ? 'FAILURE' : 'SUCCESS',
        '{}',
        null,
        0.9,
        NOW,
      );
  }
  eq(await router.revertBreachedTiers(TEN), ['WORKFLOW'], '16% failure blows the 5% WORKFLOW budget:');
  const after = await router.route(rIn({ taskType: 'memo.draft', importance: 0.1, skillCard: card }));
  eq(after.tier, 'MODEL', 'reverted to the fixed baseline:');
  eq(
    after.guards.some((g) => g.includes('budget_revert_WORKFLOW')),
    true,
  );
  await router.clearTierOverride('WORKFLOW');
  eq(
    (await router.route(rIn({ taskType: 'memo.draft', importance: 0.1, skillCard: card }))).tier,
    'WORKFLOW',
    'manual recovery after recalibration:',
  );
});
