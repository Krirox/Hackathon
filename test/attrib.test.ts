import { T, eq, TEN, NOW, fresh, sor, base, rIn, rejects } from './helpers.ts';
import {
  assignHoldout,
  attributionCaveats,
  costOfDecision,
  costsOfDecisions,
  DEFAULT_RATES,
  evaluateTenantCaveats,
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
  await router.label(TEN, lastId, 'HUMAN', 'human:priya');
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

T('F21: descendant child request costs roll up into parent decision', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'perf',
    kind: 'OBSERVATION',
    statement: 'optimizing core pipeline',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  // 1. Root request
  const { request: parent } = await coord.submit(
    base({ id: 'p1', goal: 'parent pipeline', claimRefs: [clm.id], bid: { dollars: 20, humanMinutes: 30 } }),
  );
  await coord.accept(TEN, parent.id);
  await coord.charge(TEN, parent.id, { dollars: 5, humanMinutes: 2 });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tr_p1',
      TEN,
      parent.id,
      'eng',
      'eng.task',
      'code',
      '[]',
      'MODEL',
      'SUCCESS',
      JSON.stringify({ tokens: 500 }),
      0.9,
      NOW,
    );

  // 2. Child request (decomposed from parent)
  const [childResult] = await coord.decompose(TEN, parent.id, [
    {
      goal: 'child subtask 1',
      deliverableSchema: 'sub.1',
      targetScope: 'eng-sub1',
      bid: { dollars: 5, humanMinutes: 10 },
    },
  ]);
  const child = childResult!.request;
  await coord.accept(TEN, child.id);
  await coord.charge(TEN, child.id, { dollars: 3, humanMinutes: 1 });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tr_c1',
      TEN,
      child.id,
      'eng-sub1',
      'eng.sub',
      'code',
      '[]',
      'MODEL',
      'SUCCESS',
      JSON.stringify({ tokens: 300 }),
      0.9,
      NOW,
    );

  // 3. Grandchild request (decomposed from child)
  const [grandchildResult] = await coord.decompose(TEN, child.id, [
    {
      goal: 'grandchild subtask 2',
      deliverableSchema: 'sub.2',
      targetScope: 'eng-sub2',
      bid: { dollars: 2, humanMinutes: 5 },
    },
  ]);
  const grandchild = grandchildResult!.request;
  await coord.accept(TEN, grandchild.id);
  await coord.charge(TEN, grandchild.id, { dollars: 2, humanMinutes: 1 });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tr_gc1',
      TEN,
      grandchild.id,
      'eng-sub2',
      'eng.sub',
      'code',
      '[]',
      'MODEL',
      'SUCCESS',
      JSON.stringify({ tokens: 200 }),
      0.9,
      NOW,
    );

  // Decision references the root request
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'pipeline optimization',
    action: 'deploy',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: parent.id,
    now: NOW,
  });

  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'throughput',
    predicted: 100,
    actual: 150,
    basis: 'metrics:load',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });

  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  // Total dollars: 5 (parent) + 3 (child) + 2 (grandchild) = 10 request dollars
  eq(cost.requestDollars, 10);
  // Total human minutes: 2 + 1 + 1 = 4 minutes ($4)
  eq(cost.humanMinutes, 4);
  // Total tokens: 500 + 300 + 200 = 1000 tokens ($1)
  eq(cost.tokens, 1000);
  // Total dollars: 10 + 4 + 1 = 15
  eq(cost.dollars, 15);
  eq(cost.goodDecisions, 1);
  eq(cost.costPerGoodDecision, 15);
});

T('F21: malformed or missing cost flags unknownCost and sets costPerGoodDecision to null', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test',
    kind: 'OBSERVATION',
    statement: 'testing unknown cost',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'bad_cost_req', goal: 'bad cost', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  // Corrupt spent_json directly in the database
  await db
    .prepare('UPDATE requests SET spent_json = ? WHERE tenant = ? AND id = ?')
    .run('{"dollars": "corrupted_non_numeric"}', TEN, request.id);

  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'bad cost test',
    action: 'deploy',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'throughput',
    predicted: 100,
    actual: 120,
    basis: 'metrics:load',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });

  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.goodDecisions, 1);
  eq(cost.unknownCost, true);
  eq(cost.costPerGoodDecision, null, 'unknown cost cannot be divided as free');
});

T('F21: preregistration throws POST_HOC_PREREG if outcomes already exist for the decision', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test',
    kind: 'OBSERVATION',
    statement: 'testing post-hoc prereg',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'posthoc_req', goal: 'posthoc test', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'posthoc test',
    action: 'deploy',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  // Outcome recorded before preregistration
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'revenue',
    predicted: 1000,
    actual: 1500,
    basis: 'stripe',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });

  await rejects(
    async () =>
      await preregister(db, TEN, {
        decisionId: dec.id,
        metrics: [{ name: 'revenue', threshold: 1000, direction: 'higher' }],
        agreedBy: 'human:eng',
        now: NOW,
      }),
    'POST_HOC_PREREG',
  );
});

T('F21: preregistration is immutable and throws PREREG_IMMUTABLE on tampering', async () => {
  const { db } = await fresh();
  const p1 = await preregister(db, TEN, {
    metrics: [{ name: 'speed', threshold: 50, direction: 'higher' }],
    agreedBy: 'human:eng',
    now: NOW,
  });
  // Calling with exact same metrics returns existing
  const pSame = await preregister(db, TEN, {
    metrics: [{ name: 'speed', threshold: 50, direction: 'higher' }],
    agreedBy: 'human:eng',
    now: NOW,
  });
  eq(pSame.id, p1.id);

  // Directly tampering meta with same id but different content causes PREREG_IMMUTABLE
  await db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run(JSON.stringify({ ...p1, metrics: [{ name: 'speed', threshold: 999 }] }), `prereg:${p1.id}`);

  await rejects(
    async () =>
      await preregister(db, TEN, {
        metrics: [{ name: 'speed', threshold: 50, direction: 'higher' }],
        agreedBy: 'human:eng',
        now: NOW,
      }),
    'PREREG_IMMUTABLE',
  );
});

T('F21: preregistered thresholds and directions govern outcome evaluation in costsOfDecisions', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test',
    kind: 'OBSERVATION',
    statement: 'testing prereg evaluation',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'prereg_eval_req', goal: 'prereg eval', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  await coord.accept(TEN, request.id);
  await coord.charge(TEN, request.id, { dollars: 10, humanMinutes: 0 });

  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'custom metric decision',
    action: 'deploy',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });

  // Pre-register: custom_score must be >= 80 (direction: 'higher')
  await preregister(db, TEN, {
    decisionId: dec.id,
    metrics: [{ name: 'custom_score', threshold: 80, direction: 'higher' }],
    agreedBy: 'human:eng',
    now: NOW,
  });

  // Outcome meets preregistered threshold (85 >= 80)
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'custom_score',
    predicted: 50, // lower heuristic prediction, but prereg requires 80
    actual: 85,
    basis: 'internal_test',
    holdoutRef: null,
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });

  const cost = await costOfDecision(db, coord, ledger, TEN, dec.id, { dollarPerToken: 0.001, dollarPerHumanMinute: 1 });
  eq(cost.goodDecisions, 1, 'passes according to preregistered threshold:');
  eq(cost.costPerGoodDecision, 10);
});

T('F21: evaluateTenantCaveats computes caveats from real database state', async () => {
  const { db, ledger, coord } = await fresh();
  // Initially, fresh tenant has all 4 caveats
  const initial = await evaluateTenantCaveats(db, TEN, NOW);
  eq(initial.metrics.hasPrereg, false);
  eq(initial.metrics.hasHoldout, false);
  eq(initial.metrics.hasBaseline, false);
  eq(initial.metrics.daysObserved, 0);
  eq(initial.caveats.length, 4);

  // Now create preregistration, holdout outcome, and a 30-day-old decision
  await preregister(db, TEN, {
    metrics: [{ name: 'kpi', threshold: 10 }],
    agreedBy: 'human:eng',
    now: NOW,
  });

  const pastDate = new Date(Date.parse(NOW) - 30 * 24 * 60 * 60 * 1000).toISOString();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test',
    kind: 'OBSERVATION',
    statement: '30 day old observation',
    confidence: 1,
    observedAt: pastDate,
    validFrom: pastDate,
    owner: 's',
    scope: 'eng',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'caveat_req', goal: 'caveat test', claimRefs: [clm.id], bid: { dollars: 10, humanMinutes: 10 } }),
  );
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'caveat test',
    action: 'deploy',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [clm.id],
    decidedBy: 'human:eng',
    scope: 'eng',
    autonomy: 'approval',
    requestId: request.id,
    now: pastDate,
  });

  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'kpi',
    predicted: 10,
    actual: 15,
    basis: 'baseline_study',
    holdoutRef: 'geo:us',
    resolvedBy: 'human:eng',
    scope: 'eng',
    owner: 'human:eng',
    now: NOW,
  });

  const evaluated = await evaluateTenantCaveats(db, TEN, NOW);
  eq(evaluated.metrics.hasPrereg, true);
  eq(evaluated.metrics.hasHoldout, true);
  eq(evaluated.metrics.hasBaseline, true);
  eq(evaluated.metrics.daysObserved >= 30, true);
  eq(evaluated.caveats.length, 0, 'all conditions met — no caveats remaining:');
});
