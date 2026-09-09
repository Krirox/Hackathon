import { T, eq, TEN, NOW, fresh, sor, base, rIn, rejects } from './helpers.ts';
import {
  assignHoldout,
  attributionCaveats,
  costOfDecision,
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
