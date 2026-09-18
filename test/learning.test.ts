import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, TEN, NOW, fresh, base, sor } from './helpers.ts';
import { ApplicationWorker } from '../src/substrate/worker.ts';
import { CognitiveRouter } from '../src/router/router.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { setKill } from '../src/gov/trust.ts';
import { LocalEchoAdapter } from '../src/substrate/harness.ts';
import { migrate, openDb } from '../src/core/db.ts';

console.log('\n\x1b[1mF17 — Router, compiler and operating learning loop\x1b[0m');

T('balanced trace recording: LocalEchoAdapter records FAILURE trace on kill switch denial', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:baseline',
    kind: 'OBSERVATION',
    statement: 'baseline evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  const { request: req } = await coord.submit(base({ id: 'trace-fail-1', goal: 'kill me', claimRefs: [clm.id] }));
  await setKill(db, TEN, { scope: 'engineering', actionClass: '*' }, 'operator:test', NOW);

  const adapter = new LocalEchoAdapter(db, ledger, coord);
  const out = await adapter.run(TEN, req.id, {
    command: 'do something',
    claimRefs: [clm.id],
    onBehalfOf: 'agent:test',
    maxDollars: 1,
    maxTokens: 1000,
    taskType: 'engineering.implement',
    tier: 'MODEL',
    intent: 'code:feasibility.v1',
    skillCardId: null,
    routerConfidence: 0.85,
  });

  eq(out.status, 'DENIED');

  const tr = (await db.prepare('SELECT * FROM traces WHERE tenant = ? AND request_id = ?').get(TEN, req.id)) as Record<
    string,
    unknown
  >;
  eq(tr !== undefined, true, 'trace was recorded:');
  eq(tr.outcome, 'FAILURE', 'outcome is recorded as FAILURE:');
  eq(tr.task_type, 'engineering.implement');
  eq(tr.tier, 'MODEL');
  eq(tr.intent, 'code:feasibility.v1');
  eq(Number(tr.router_confidence), 0.85);
});

T('balanced trace recording: LocalEchoAdapter records FAILURE trace on budget termination', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:baseline',
    kind: 'OBSERVATION',
    statement: 'baseline evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  const { request: req } = await coord.submit(
    base({ id: 'trace-budget-1', goal: 'exceed tokens', claimRefs: [clm.id] }),
  );
  const adapter = new LocalEchoAdapter(db, ledger, coord);
  const out = await adapter.run(TEN, req.id, {
    command: 'very long command exceeding token ceiling',
    claimRefs: [clm.id],
    onBehalfOf: 'agent:test',
    maxDollars: 1,
    maxTokens: 5, // very small ceiling
    taskType: 'engineering.implement',
    tier: 'WORKFLOW',
    intent: 'code:feasibility.v1',
    skillCardId: 'card_demo_1',
    routerConfidence: 0.95,
  });

  eq(out.status, 'TERMINATED_BUDGET');

  const tr = (await db.prepare('SELECT * FROM traces WHERE tenant = ? AND request_id = ?').get(TEN, req.id)) as Record<
    string,
    unknown
  >;
  eq(tr !== undefined, true, 'trace recorded on budget breach:');
  eq(tr.outcome, 'FAILURE');
  eq(tr.tier, 'WORKFLOW');
  eq(tr.skill_card, 'card_demo_1');
  eq(Number(tr.router_confidence), 0.95);
});

T('operating learning loop sweep: checks drift and auto-demotes rotting PROMOTED cards', async () => {
  const { db, ledger, coord } = await fresh();
  const comp = new OrganizationalCompiler(db);

  // 1. Compile a card and advance it to PROMOTED
  const card = await comp.compile({
    tenant: TEN,
    intent: 'auto-triage',
    predicates: ['has_signal'],
    steps: ['triage'],
    tests: ['regression:triage.v1'],
    toolGrants: [],
    validatedAtTier: 'WORKFLOW',
    originScope: 'engineering',
    originModels: ['local-echo'],
    scopeRoles: ['engineering'],
    owner: 'human:alice',
    traceIds: [],
    evalRef: 'triage-evals',
    now: NOW,
  });

  await comp.recordTransfer(card, { kind: 'regression', variant: 'triage.v1', passed: true, score: 1, ranAt: NOW });
  await comp.recordTransfer(card, {
    kind: 'cross_model',
    variant: 'local-echo',
    passed: true,
    score: 0.98,
    ranAt: NOW,
  });
  await comp.recordTransfer(card, { kind: 'data_regime', variant: 'q1', passed: true, score: 0.95, ranAt: NOW });
  await comp.recordTransfer(card, {
    kind: 'cross_role',
    variant: 'engineering',
    passed: true,
    score: 0.97,
    ranAt: NOW,
  });

  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'SHADOW')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', { shadowRuns: 25, shadowSuccessRate: 0.96 })).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'PROMOTED', { pilotRuns: 55, pilotSuccessRate: 0.98 })).ok, true);

  const promotedCard = await comp.get(TEN, card.id);
  eq(promotedCard?.state, 'PROMOTED');

  // 2. Seed 12 failing live WORKFLOW traces with this skill_card
  for (let i = 0; i < 12; i++) {
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_rot_${i}`,
        TEN,
        `req_rot_${i}`,
        'engineering',
        'engineering.implement',
        'auto-triage',
        '[]',
        'WORKFLOW',
        'FAILURE',
        '{}',
        card.id,
        0.9,
        new Date(Date.parse(NOW) + i * 1000).toISOString(),
      );
  }

  // 3. Worker tick runs operating learning sweep
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.learning !== undefined, true, 'learning sweep executed:');
  eq(tickRes.learning?.driftChecks, 1, '1 promoted card checked:');
  eq(tickRes.learning?.cardsDemoted, 1, '1 rotting card auto-demoted:');

  const afterSweepCard = await comp.get(TEN, card.id);
  eq(afterSweepCard?.state, 'DEMOTED', 'card state was automatically demoted to DEMOTED:');

  const status = worker.status();
  eq(status.counters.driftChecks, 1);
  eq(status.counters.cardsDemoted, 1);
});

T('operating learning loop sweep: detects error budget breaches and auto-reverts tier to baseline', async () => {
  const { db, ledger, coord } = await fresh();
  const router = new CognitiveRouter(db);

  // Seed 50 traces with 10 failures on MODEL tier (20% failure rate > 10% budget)
  for (let i = 0; i < 50; i++) {
    const outcome = i < 10 ? 'FAILURE' : 'SUCCESS';
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_budget_${i}`,
        TEN,
        `req_b_${i}`,
        'engineering',
        'engineering.implement',
        'code:feasibility.v1',
        '[]',
        'MODEL',
        outcome,
        '{}',
        null,
        0.9,
        NOW,
      );
  }

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    router,
    dispatchRequests: false,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.learning?.tiersReverted.includes('MODEL'), true, 'MODEL tier auto-reverted:');

  const breaches = await router.budgetBreaches(TEN);
  eq(breaches.length > 0, true, 'breach recorded:');
  eq(breaches[0]?.tier, 'MODEL');
  eq(breaches[0]?.failureRate, 0.2);
});

T('operating learning loop sweep: mines candidate procedural skills from repeated successes', async () => {
  const { db, ledger, coord } = await fresh();

  // Seed 4 repeated SUCCESS traces with confidence >= 0.5
  for (let i = 0; i < 4; i++) {
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_mine_${i}`,
        TEN,
        `req_mine_${i}`,
        'engineering',
        'engineering.implement',
        'recurring-pattern',
        '[]',
        'MODEL',
        'SUCCESS',
        '{}',
        null,
        0.85,
        NOW,
      );
  }

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq((tickRes.learning?.candidatesMined ?? 0) >= 1, true, 'mined candidate detected:');
  eq(worker.status().counters.candidatesMined >= 1, true);
});

T('request dispatch: PROMOTED card dispatches at WORKFLOW tier in control mode and records calibration', async () => {
  const { db, ledger, coord } = await fresh();
  const comp = new OrganizationalCompiler(db);
  const router = new CognitiveRouter(db);
  router.setControlRate(1); // control mode enabled

  // Compile and promote a card for intent 'code:feasibility.v1' in scope 'engineering' on model 'local-echo'
  const card = await comp.compile({
    tenant: TEN,
    intent: 'code:feasibility.v1',
    predicates: ['p1'],
    steps: ['step1'],
    tests: ['regression:test1'],
    toolGrants: [],
    validatedAtTier: 'WORKFLOW',
    originScope: 'engineering',
    originModels: ['local-echo'],
    scopeRoles: ['engineering'],
    owner: 'human:alice',
    traceIds: [],
    evalRef: 'eval-spec',
    now: NOW,
  });

  await comp.recordTransfer(card, { kind: 'regression', variant: 'test1', passed: true, score: 1, ranAt: NOW });
  await comp.recordTransfer(card, {
    kind: 'cross_model',
    variant: 'local-echo',
    passed: true,
    score: 0.99,
    ranAt: NOW,
  });
  await comp.recordTransfer(card, { kind: 'data_regime', variant: 'dr1', passed: true, score: 0.95, ranAt: NOW });
  await comp.recordTransfer(card, {
    kind: 'cross_role',
    variant: 'engineering',
    passed: true,
    score: 0.98,
    ranAt: NOW,
  });

  eq((await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'SHADOW')).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', { shadowRuns: 25, shadowSuccessRate: 0.98 })).ok, true);
  eq((await comp.attemptAdvance(TEN, card.id, 'PROMOTED', { pilotRuns: 60, pilotSuccessRate: 0.99 })).ok, true);

  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:grounding',
    kind: 'OBSERVATION',
    statement: 'grounding evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  const { request: req } = await coord.submit(
    base({
      id: 'req-workflow-1',
      deliverableSchema: 'feasibility.v1',
      targetScope: 'engineering',
      claimRefs: [clm.id],
    }),
  );

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    router,
    compiler: comp,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.requestsDispatched, 1);
  eq(tickRes.requestsCompleted, 1);

  // Check the recorded trace has tier = 'WORKFLOW' and skill_card bound
  const tr = (await db.prepare('SELECT * FROM traces WHERE tenant = ? AND request_id = ?').get(TEN, req.id)) as Record<
    string,
    unknown
  >;
  eq(tr.tier, 'WORKFLOW', 'dispatched at WORKFLOW tier:');
  eq(tr.skill_card, card.id, 'card id is bound in trace:');
  eq(tr.outcome, 'SUCCESS');

  // Check calibration sample recorded
  const cal = await router.calibration(TEN, 'engineering.implement');
  const workflowCal = cal.find((c) => c.tier === 'WORKFLOW');
  eq(workflowCal !== undefined, true, 'calibration sample recorded:');
  eq(workflowCal?.ok, 1);
  eq(workflowCal?.total, 1);
});

T('coupling guard: card validated for other scope is not executed as WORKFLOW', async () => {
  const { db, ledger, coord } = await fresh();
  const comp = new OrganizationalCompiler(db);
  const router = new CognitiveRouter(db);
  router.setControlRate(1);

  // Card only validated for 'marketing'
  const card = await comp.compile({
    tenant: TEN,
    intent: 'code:feasibility.v1',
    predicates: ['p1'],
    steps: ['step1'],
    tests: ['regression:test1'],
    toolGrants: [],
    validatedAtTier: 'WORKFLOW',
    originScope: 'marketing',
    originModels: ['local-echo'],
    scopeRoles: ['marketing'], // NOT engineering
    owner: 'human:bob',
    traceIds: [],
    evalRef: 'eval-spec',
    now: NOW,
  });

  await comp.recordTransfer(card, { kind: 'regression', variant: 'test1', passed: true, score: 1, ranAt: NOW });
  await comp.recordTransfer(card, {
    kind: 'cross_model',
    variant: 'local-echo',
    passed: true,
    score: 0.99,
    ranAt: NOW,
  });
  await comp.recordTransfer(card, { kind: 'data_regime', variant: 'dr1', passed: true, score: 0.95, ranAt: NOW });
  await comp.recordTransfer(card, { kind: 'cross_role', variant: 'marketing', passed: true, score: 0.98, ranAt: NOW });

  await comp.attemptAdvance(TEN, card.id, 'QUARANTINE');
  await comp.attemptAdvance(TEN, card.id, 'SHADOW');
  await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', { shadowRuns: 25, shadowSuccessRate: 0.98 });
  await comp.attemptAdvance(TEN, card.id, 'PROMOTED', { pilotRuns: 60, pilotSuccessRate: 0.99 });

  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:grounding',
    kind: 'OBSERVATION',
    statement: 'grounding evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  // Request is for 'engineering' scope
  const { request: req } = await coord.submit(
    base({ id: 'req-guard-1', deliverableSchema: 'feasibility.v1', targetScope: 'engineering', claimRefs: [clm.id] }),
  );

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    router,
    compiler: comp,
    relayOutbox: false,
  });

  await worker.tick(NOW);

  const tr = (await db.prepare('SELECT * FROM traces WHERE tenant = ? AND request_id = ?').get(TEN, req.id)) as Record<
    string,
    unknown
  >;
  eq(tr.tier, 'MODEL', 'coupling guard prevented WORKFLOW execution in unvalidated scope:');
  eq(tr.skill_card, null);
});

T('balanced trace recording: JcodeRunner records FAILURE trace on kill switch halt', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:jcode',
    kind: 'OBSERVATION',
    statement: 'baseline evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  const { request } = await coord.submit(base({ id: 'jcode-kill-1', claimRefs: [clm.id] }));
  await setKill(db, TEN, { scope: 'engineering', actionClass: '*' }, 'human:commander', NOW);

  const { JcodeRunner } = await import('../src/jcode/runner.ts');
  const runner = new JcodeRunner(db, ledger, coord);
  const out = await runner.run(
    TEN,
    request.id,
    {
      command: 'edit',
      claimRefs: [clm.id],
      onBehalfOf: 'agent:runner',
      maxDollars: 5,
      maxTokens: 10_000,
      taskType: 'engineering.implement',
      tier: 'MODEL',
      intent: 'code:feasibility.v1',
      routerConfidence: 0.9,
    },
    { socketPath: 'not-needed' },
  );

  eq(out.status, 'DENIED');

  const tr = (await db
    .prepare('SELECT * FROM traces WHERE tenant = ? AND request_id = ?')
    .get(TEN, request.id)) as Record<string, unknown>;
  eq(tr !== undefined, true, 'trace recorded for jcode denial:');
  eq(tr.outcome, 'FAILURE');
  eq(tr.task_type, 'engineering.implement');
  eq(tr.tier, 'MODEL');
});

T('fail-up guard: irreversible task in router fails up to HUMAN tier', async () => {
  const { db } = await fresh();
  const router = new CognitiveRouter(db);

  // 1. humanOnly task type
  const d1 = await router.route({
    tenant: TEN,
    taskType: 'pricing.change',
    scope: 'engineering',
    actionClass: 'ANALYZE',
    importance: 0.5,
    reversible: true,
  });
  eq(d1.tier, 'HUMAN', 'humanOnly task routes to HUMAN:');
  eq(d1.policyRule, 'humanOnly registry');

  // 2. Irreversible action class fails UP
  const d2 = await router.route({
    tenant: TEN,
    taskType: 'engineering.implement',
    scope: 'engineering',
    actionClass: 'ACT_IRREVERSIBLE',
    importance: 0.9,
    reversible: false,
  });
  eq(d2.tier, 'HUMAN', 'irreversible action fails up to HUMAN:');
  eq(d2.policyRule, 'fail-up: irreversible action');
});

T('candidate mining: mineCandidates returns intents with >= 3 successful runs', async () => {
  const { db } = await fresh();
  const { mineCandidates } = await import('../src/compiler/compiler.ts');
  for (let i = 0; i < 3; i++) {
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_mine_test_${i}`,
        TEN,
        `req_mine_${i}`,
        'engineering',
        'engineering.implement',
        'recurring.pattern.x',
        '[]',
        'MODEL',
        'SUCCESS',
        '{}',
        null,
        0.9,
        NOW,
      );
  }

  const mined = await mineCandidates(db, TEN, 3);
  eq(mined.length, 1);
  eq(mined[0]?.intent, 'recurring.pattern.x');
  eq(mined[0]?.repeats, 3);
});

T('F15: simulated traces never satisfy mining thresholds — exclusion is by construction', async () => {
  const { db } = await fresh();
  const { mineCandidates } = await import('../src/compiler/compiler.ts');
  // Six simulated SUCCESS traces — far past the threshold if they were counted.
  for (let i = 0; i < 6; i++) {
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_sim_mine_${i}`,
        TEN,
        `req_sim_${i}`,
        'product',
        'release.summarize',
        'simulated:ship-to-result',
        '[]',
        'WORKFLOW',
        'SUCCESS',
        JSON.stringify({ simulated: true }),
        null,
        0.95,
        NOW,
      );
  }
  // Three real traces below the default threshold (minRepeats=3 would admit
  // them if simulated rows leaked in — they must stand alone).
  for (let i = 0; i < 2; i++) {
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_real_mine_${i}`,
        TEN,
        `req_real_${i}`,
        'engineering',
        'engineering.implement',
        'real.pattern.y',
        '[]',
        'MODEL',
        'SUCCESS',
        '{}',
        null,
        0.9,
        NOW,
      );
  }
  const mined = await mineCandidates(db, TEN, 3);
  eq(
    mined.some((m) => m.intent.startsWith('simulated:')),
    false,
    'no simulated intent is ever mined:',
  );
  eq(mined.some((m) => m.intent === 'real.pattern.y'), false, 'real traces below threshold still wait:');
  // A simulated run plus two real successes cannot pool into a candidate: the
  // simulated rows do not count toward ANY intent's threshold.
  const withOneMoreReal = await mineCandidates(db, TEN, 3);
  eq(withOneMoreReal.length, 0);
});

T('CLI learn command runs drift, budget breach, and mining sweeps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-learn-cli-'));
  const dbPath = join(dir, 'test.db');
  try {
    const initDb = openDb(dbPath);
    await migrate(initDb);
    await initDb.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tenant:acme', 'active');
    await initDb.close();

    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'learn', '--db', dbPath, '--tenant', 'acme'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    eq(res.status, 0, `cli learn exited cleanly: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    eq(parsed.ok, true);
    eq(parsed.vital, '0.0.1');
    eq(parsed.drift.checked, 0);
    eq(parsed.candidates.mined, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
