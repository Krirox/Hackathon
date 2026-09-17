import { T, eq, TEN, NOW, fresh, sor, base, rIn, rejects } from './helpers.ts';
import {
  assignHoldout,
  attributionCaveats,
  costOfDecision,
  costsOfDecisions,
  DEFAULT_RATES,
  getRates,
  setRates,
  getPrereg,
  misroutingCounts,
  preregister,
  tierMix,
} from '../src/attrib/attribution.ts';

console.log('\n\x1b[1mAttribution — costs roll up, results stay counterfactual\x1b[0m');

T('a launch rolls up to dollars and cost per good decision', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'r',
    kind: 'OBSERVATION',
    statement: 'v2.14 shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'c1', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 30 } }),
  );
  await coord.accept(TEN, request.id);
  await coord.charge(TEN, request.id, { dollars: 4, humanMinutes: 20 });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tr_c1',
      TEN,
      request.id,
      'engineering',
      'engineering.implement',
      'code:x',
      '[]',
      'MODEL',
      'SUCCESS',
      JSON.stringify({ tokens: 1000 }),
      null,
      0.9,
      NOW,
    );
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'launch v2.14',
    action: 'ship it',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:priya',
    scope: 'engineering',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'adoption',
    predicted: 0.2,
    actual: 0.31,
    basis: 'warehouse:adopt',
    holdoutRef: 'geo:emea',
    resolvedBy: 'human:priya',
    scope: 'engineering',
    owner: 'human:priya',
    now: NOW,
  });
  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.tokens, 1000);
  eq(cost.humanMinutes, 20);
  eq(cost.dollars, 4 + 1 + 20);
  eq(cost.goodDecisions, 1, 'actual beat prediction:');
  eq(cost.costPerGoodDecision, 25);
  eq(cost.outcomes[0]!.holdoutRef, 'geo:emea');
});

T('bulk roll-up matches per-decision costing and skips unknown ids', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'r',
    kind: 'OBSERVATION',
    statement: 'v2.14 shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const mk = async (id: string, dollars: number, tokens: number) => {
    // Distinct goals: identical proposals dedupe onto one thread (by design),
    // which would merge both traces under a single request.
    const { request } = await coord.submit(
      base({ id, goal: `launch work ${id}`, claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 30 } }),
    );
    await coord.accept(TEN, request.id);
    await coord.charge(TEN, request.id, { dollars, humanMinutes: 5 });
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `tr_${id}`,
        TEN,
        request.id,
        'engineering',
        'engineering.implement',
        'code:x',
        '[]',
        'MODEL',
        'SUCCESS',
        JSON.stringify({ tokens }),
        null,
        0.9,
        NOW,
      );
    const dec = await ledger.recordDecision({
      tenant: TEN,
      goal: `launch ${id}`,
      action: 'ship it',
      actionClass: 'ACT_REVERSIBLE',
      claimIds: [clm.id],
      decidedBy: 'human:priya',
      scope: 'engineering',
      autonomy: 'approval',
      requestId: request.id,
      now: NOW,
    });
    await ledger.recordOutcome({
      tenant: TEN,
      decisionId: dec.id,
      metric: 'adoption',
      predicted: 0.2,
      actual: 0.31,
      basis: 'warehouse:adopt',
      holdoutRef: null,
      resolvedBy: 'human:priya',
      scope: 'engineering',
      owner: 'human:priya',
      now: NOW,
    });
    return dec;
  };
  const rates = { dollarPerToken: 0.001, dollarPerHumanMinute: 1 };
  const d1 = await mk('bulk1', 4, 1000);
  const d2 = await mk('bulk2', 2, 500);
  const all = await costsOfDecisions(db, coord, ledger, TEN, [d1.id, d2.id, 'dec_nope'], rates);
  eq(all.size, 2, 'unknown ids are skipped, not exploded:');
  for (const d of [d1, d2]) {
    const one = await costOfDecision(db, coord, ledger, TEN, d.id, rates);
    eq(JSON.stringify(all.get(d.id)), JSON.stringify(one), `bulk matches single for ${d.id}:`);
  }
  eq(all.get(d1.id)!.tokens, 1000);
  eq(all.get(d2.id)!.requestDollars, 2);
});

T('no good outcome means unknown cost, not zero cost', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'r',
    kind: 'OBSERVATION',
    statement: 'x',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'g',
    action: 'a',
    actionClass: 'READ',
    claimIds: [clm.id],
    decidedBy: 'h',
    scope: 'x',
    autonomy: 'autonomous',
    now: NOW,
  });
  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.costPerGoodDecision, null);
  await rejects(
    async () =>
      await costOfDecision(db, coord, ledger, TEN, 'dec_nope', { dollarPerToken: 1, dollarPerHumanMinute: 1 }),
    'MISSING_DECISION',
  );
});

T('holdout lanes are deterministic and split near ratio', async () => {
  eq(assignHoldout('user-1'), assignHoldout('user-1'), 'same key, same lane:');
  let holdouts = 0;
  for (let i = 0; i < 1000; i++) if (assignHoldout(`user-${i}`) === 'holdout') holdouts++;
  eq(holdouts > 50 && holdouts < 150, true, `~10% lane (got ${holdouts}/1000):`);
  await rejects(async () => assignHoldout('x', 0), 'BAD_RATIO');
});

T('pre-registration banks metrics before the pilot, visibly', async () => {
  const { db } = await fresh();
  const pre = await preregister(db, TEN, {
    metrics: [{ name: 'adoption', threshold: 0.2 }],
    agreedBy: 'human:priya',
    now: NOW,
  });
  eq((await getPrereg(db, TEN, pre.id))!.metrics, [{ name: 'adoption', threshold: 0.2 }]);
  eq(await getPrereg(db, TEN, 'prereg_nope'), null);
  await rejects(
    async () => await preregister(db, TEN, { metrics: [], agreedBy: 'human:priya', now: NOW }),
    'EMPTY_PREREG',
  );
});

T('tier mix and misrouting counts come from the same tables as the work', async () => {
  const { db, router } = await fresh();
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run('tm1', TEN, null, 'x', 't', 'i', '[]', 'REFLEX', 'SUCCESS', '{}', null, 0.9, NOW);
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run('tm2', TEN, null, 'x', 't', 'i', '[]', 'MODEL', 'SUCCESS', '{}', null, 0.9, NOW);
  eq(Object.entries(await tierMix(db, TEN)).sort(), [
    ['MODEL', 1],
    ['REFLEX', 1],
  ]);
  await router.route(rIn());
  const lastId = ((await db.prepare('SELECT max(id) AS m FROM routing_decisions').get()) as { m: number }).m;
  await router.label(lastId, 'HUMAN');
  const miss = (await misroutingCounts(db, TEN)).find((m) => m.tier === 'MODEL')!;
  eq(miss.samples, 1);
  eq(miss.misses, 1, 'proposed MODEL, correct HUMAN:');
});

T('deception caveats block claims the evidence cannot support', async () => {
  eq(
    attributionCaveats({ daysObserved: 60, hasHoldout: true, hasBaseline: true, hasPrereg: true }),
    [],
    'full evidence: no caveats:',
  );
  const thin = attributionCaveats({ daysObserved: 3, hasHoldout: false, hasBaseline: false, hasPrereg: false });
  eq(thin.length, 4);
});

T('rates resolve per tenant with versioned overrides, never code constants', async () => {
  const { db } = await fresh();
  eq(await getRates(db, TEN), DEFAULT_RATES, 'defaults match the old constants:');
  const next = await setRates(db, TEN, { dollarPerToken: 0.005, dollarPerHumanMinute: 2 }, 'human:priya', NOW);
  eq(next, { dollarPerToken: 0.005, dollarPerHumanMinute: 2 });
  eq(await getRates(db, TEN), next, 'stored rates win:');
  eq(await getRates(db, 'other'), DEFAULT_RATES, 'tenants price independently:');
  await rejects(
    async () => setRates(db, TEN, { dollarPerToken: NaN, dollarPerHumanMinute: 1 }, 'human:priya', NOW),
    'BAD_RATES',
  );
  await rejects(async () => setRates(db, TEN, { dollarPerToken: 1, dollarPerHumanMinute: 1 }, '', NOW), 'NO_OWNER');
  eq(await getRates(db, TEN), next, 'rejected writes change nothing:');
});

T('F21: lower-is-better metric evaluates actual <= predicted as passing', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'service:api',
    kind: 'OBSERVATION',
    statement: 'optimizing api latency',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'f21_lat', goal: 'latency tuning', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  await coord.accept(TEN, request.id);
  await coord.charge(TEN, request.id, { dollars: 5, humanMinutes: 5 });
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'optimize latency',
    action: 'deploy cache',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  // Latency predicted 200ms, actual 150ms -> lower is better! This should pass.
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'p99_latency_ms',
    predicted: 200,
    actual: 150,
    basis: 'metrics:datadog',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });
  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.goodDecisions, 1, 'lower actual latency than predicted counts as a good decision:');
  eq(cost.costPerGoodDecision, 10, 'decision cost is allocated to the single decision:');
});

T('F21: multiple outcomes require all to pass for a good decision', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'service:checkout',
    kind: 'OBSERVATION',
    statement: 'checkout v2 roll out',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'f21_multi', goal: 'checkout v2', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  await coord.accept(TEN, request.id);
  await coord.charge(TEN, request.id, { dollars: 8, humanMinutes: 2 });
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'checkout rollout',
    action: 'rollout',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  // Outcome 1 passes (conversion beat prediction)
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'conversion_rate',
    predicted: 0.05,
    actual: 0.06,
    basis: 'analytics:mixpanel',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });
  // Outcome 2 fails (error rate worse than predicted: 0.02 actual vs 0.01 predicted)
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'error_rate',
    predicted: 0.01,
    actual: 0.02,
    basis: 'analytics:sentry',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });
  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.goodDecisions, 0, 'mixed outcome is not declared a good decision:');
  eq(cost.costPerGoodDecision, null, 'failed/mixed decision has null cost per good decision:');
});
