import { unlinkSync } from 'node:fs';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { CognitiveRouter } from '../src/router/router.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { addCase, runSuite } from '../src/evals/runner.ts';

/**
 * Demo seed: builds var/demo.db with a lived-in tenant (claims, disputes,
 * decisions + outcomes, requests, 12 weeks of traces, cards, evals) so
 * `tsx src/cli.ts report --db var/demo.db` renders a console with real
 * numbers instead of an empty tenant.
 */
const TEN = 'acme';
const NOW = Date.now();
const day = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

try {
  unlinkSync('var/demo.db');
} catch {
  /* fresh */
}

const db = openDb('var/demo.db');
await migrate(db);
const ledger = createLedger(db);
const coord = createCoordinator(db);
const router = new CognitiveRouter(db);
const comp = new OrganizationalCompiler(db);
const at = (daysAgo: number): string => iso(NOW - daysAgo * day);

const sor = (uri: string) => ({
  sourceUri: uri,
  sourceTier: 'SYSTEM_OF_RECORD' as const,
  extractor: 'demo-seed',
  extractorVersion: '1.0.0',
  retrievedAt: at(0),
});

// --- claims: facts, a dispute, an expiring fact, a belief, a prediction ---
const price = await ledger.append({
  tenant: TEN,
  subject: 'pricing',
  kind: 'FACT',
  statement: 'Pro is $99',
  confidence: 1,
  observedAt: at(60),
  validFrom: at(60),
  owner: 'sync:stripe',
  scope: 'finance',
  authorType: 'system',
  now: at(60),
  provenance: sor('stripe://prices'),
});
const churnA = await ledger.append({
  tenant: TEN,
  subject: 'churn',
  kind: 'FACT',
  statement: 'churn 2%',
  confidence: 1,
  observedAt: at(10),
  validFrom: at(10),
  owner: 'sync:warehouse',
  scope: 'finance',
  authorType: 'system',
  now: at(10),
  provenance: sor('warehouse://churn'),
});
const churnB = await ledger.append({
  tenant: TEN,
  subject: 'churn',
  kind: 'FACT',
  statement: 'churn 9%',
  confidence: 1,
  observedAt: at(2),
  validFrom: at(2),
  owner: 'sync:survey',
  scope: 'finance',
  authorType: 'system',
  now: at(2),
  provenance: sor('survey://q3'),
});
await ledger.link(TEN, churnA.id, churnB.id, 'contradicts');
await ledger.append({
  tenant: TEN,
  subject: 'sla',
  kind: 'FACT',
  statement: 'support SLA 4h',
  confidence: 1,
  observedAt: at(40),
  validFrom: at(40),
  validUntil: iso(NOW + 3 * day),
  owner: 'sync:notion',
  scope: 'customer',
  authorType: 'system',
  now: at(40),
  provenance: sor('notion://sla'),
});
await ledger.append({
  tenant: TEN,
  subject: 'market',
  kind: 'BELIEF',
  statement: 'Globex may reprice in Q4',
  confidence: 0.5,
  observedAt: at(5),
  validFrom: at(5),
  owner: 'agent:mkt',
  scope: 'market',
  authorType: 'agent',
  now: at(5),
  provenance: { ...sor('web://globex'), sourceTier: 'SINGLE_SOURCE' },
});
await ledger.append({
  tenant: TEN,
  subject: 'growth',
  kind: 'PREDICTION',
  statement: 'signup lift +18% QoQ',
  confidence: 0.7,
  observedAt: at(20),
  validFrom: at(20),
  validUntil: iso(NOW + 70 * day),
  owner: 'agent:growth',
  scope: 'marketing',
  authorType: 'agent',
  now: at(20),
  provenance: { ...sor('model://forecast'), sourceTier: 'SINGLE_SOURCE' },
});

// --- requests: admitted human work, a notice, a decline (refusal is healthy) ---
const r1 = await coord.submit({
  tenant: TEN,
  messageClass: 'REQUEST',
  originScope: 'marketing',
  targetScope: 'engineering',
  goal: 'EU streaming flag',
  claimRefs: [price.id],
  deliverableSchema: 'code.v1',
  bid: { dollars: 8, humanMinutes: 25 },
  onBehalfOf: 'human:priya',
  now: at(1),
});
await coord.accept(TEN, r1.request.id);
await coord.charge(TEN, r1.request.id, { dollars: 3.4, humanMinutes: 12 });
await coord.submit({
  tenant: TEN,
  messageClass: 'NOTICE',
  originScope: 'engineering',
  targetScope: 'marketing',
  goal: 'deploy v2.14 done',
  claimRefs: [],
  deliverableSchema: 'note.v1',
  onBehalfOf: 'agent:eng',
  now: at(1),
});
const r3 = await coord.submit({
  tenant: TEN,
  messageClass: 'REQUEST',
  originScope: 'sales',
  targetScope: 'engineering',
  goal: 'free custom work',
  claimRefs: [price.id],
  deliverableSchema: 'code.v1',
  onBehalfOf: 'human:sam',
  now: at(0),
});
await coord.decline(TEN, r3.request.id, 'out of scope this quarter');
void r1;

// --- 12 weeks of traces, tier mix drifting toward REFLEX/WORKFLOW ---
const tiers: string[] = [
  'MODEL',
  'MODEL',
  'MODEL',
  'WORKFLOW',
  'MODEL',
  'WORKFLOW',
  'REFLEX',
  'WORKFLOW',
  'REFLEX',
  'REFLEX',
  'WORKFLOW',
  'REFLEX',
];
for (const [w, tier] of tiers.entries()) {
  for (let i = 0; i < 4; i++) {
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `tr_w${w}_${i}`,
        TEN,
        null,
        'marketing',
        'launch.copy.draft',
        'draft-launch-copy',
        '[]',
        tier,
        i === 3 && tier === 'MODEL' ? 'FAILURE' : 'SUCCESS',
        JSON.stringify({ tokens: 800 }),
        null,
        0.9,
        at(84 - w * 7),
      );
  }
}

// --- decisions + outcomes: one beat, one miss ---
const d1 = await ledger.recordDecision({
  tenant: TEN,
  goal: 'launch v2.14',
  action: 'ship EU streaming',
  actionClass: 'ACT_REVERSIBLE',
  claimIds: [price.id],
  decidedBy: 'human:priya',
  approvedBy: 'human:ceo',
  scope: 'engineering',
  autonomy: 'approval',
  now: at(6),
});
await ledger.recordOutcome({
  tenant: TEN,
  decisionId: d1.id,
  metric: 'adoption',
  predicted: 0.2,
  actual: 0.31,
  basis: 'warehouse:adopt',
  holdoutRef: 'geo:emea',
  resolvedBy: 'human:priya',
  scope: 'engineering',
  owner: 'human:priya',
  now: at(1),
});
const d2 = await ledger.recordDecision({
  tenant: TEN,
  goal: 'price test',
  action: 'raise Pro to $109',
  actionClass: 'ACT_REVERSIBLE',
  claimIds: [price.id],
  decidedBy: 'human:priya',
  approvedBy: 'human:ceo',
  scope: 'finance',
  autonomy: 'approval',
  now: at(30),
});
await ledger.recordOutcome({
  tenant: TEN,
  decisionId: d2.id,
  metric: 'conversion',
  predicted: 0.5,
  actual: 0.42,
  basis: 'warehouse:conv',
  resolvedBy: 'human:priya',
  scope: 'finance',
  owner: 'human:priya',
  now: at(25),
});

// --- a promoted card with transfer evidence + a quarantined import ---
for (let i = 0; i < 5; i++) {
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      `tr_c${i}`,
      TEN,
      null,
      'marketing',
      'launch.copy.draft',
      'draft-launch-copy',
      '[]',
      'MODEL',
      'SUCCESS',
      '{}',
      null,
      0.95,
      at(50),
    );
}
const card = await comp.compile({
  tenant: TEN,
  intent: 'draft-launch-copy',
  predicates: ['has_release_notes'],
  steps: ['read notes', 'draft'],
  tests: ['regression:copy.v1'],
  toolGrants: ['docs.read'],
  validatedAtTier: 'WORKFLOW',
  originScope: 'marketing',
  originModels: ['claude'],
  scopeRoles: ['marketing'],
  owner: 'human:priya',
  traceIds: ['tr_c0', 'tr_c1', 'tr_c2'],
  evalRef: 'copy-regressions',
  now: at(40),
});
await comp.recordTransfer(card, { kind: 'regression', variant: 'copy.v1', passed: true, score: 1, ranAt: at(39) });
await comp.recordTransfer(card, {
  kind: 'cross_model',
  variant: 'local-echo',
  passed: true,
  score: 0.97,
  ranAt: at(38),
});
await comp.recordTransfer(card, { kind: 'data_regime', variant: 'q3', passed: true, score: 0.93, ranAt: at(37) });
await comp.recordTransfer(card, { kind: 'cross_role', variant: 'marketing', passed: true, score: 0.96, ranAt: at(37) });
console.log(
  'transfer/promotion:',
  (await comp.attemptAdvance(TEN, card.id, 'QUARANTINE')).ok ? 'quarantined' : 'blocked',
);
console.log('shadow:', (await comp.attemptAdvance(TEN, card.id, 'SHADOW')).ok ? 'shadow' : 'blocked');
console.log(
  'pilot:',
  (await comp.attemptAdvance(TEN, card.id, 'BOUNDED_PILOT', { shadowRuns: 24, shadowSuccessRate: 0.96 })).ok
    ? 'pilot'
    : 'blocked',
);
console.log(
  'promoted:',
  (await comp.attemptAdvance(TEN, card.id, 'PROMOTED', { pilotRuns: 60, pilotSuccessRate: 0.97 })).ok
    ? 'PROMOTED'
    : 'blocked',
);
// A second card that rots live: 12 failing WORKFLOW traces → drift auto-demotes.
const card2 = await comp.compile({
  tenant: TEN,
  intent: 'draft-churn-mail',
  predicates: ['has_segment'],
  steps: ['draft'],
  tests: ['regression:mail.v1'],
  toolGrants: [],
  validatedAtTier: 'WORKFLOW',
  originScope: 'marketing',
  originModels: ['claude'],
  scopeRoles: ['marketing'],
  owner: 'human:priya',
  traceIds: ['tr_c0'],
  evalRef: 'mail-regressions',
  now: at(40),
});
await comp.recordTransfer(card2, { kind: 'regression', variant: 'mail.v1', passed: true, score: 1, ranAt: at(39) });
await comp.recordTransfer(card2, {
  kind: 'cross_model',
  variant: 'local-echo',
  passed: true,
  score: 0.95,
  ranAt: at(38),
});
await comp.recordTransfer(card2, { kind: 'data_regime', variant: 'q3', passed: true, score: 0.92, ranAt: at(37) });
for (const [stage, ev] of [
  ['QUARANTINE', {}],
  ['SHADOW', {}],
  ['BOUNDED_PILOT', { shadowRuns: 20, shadowSuccessRate: 0.9 }],
] as const) {
  console.log(stage, (await comp.attemptAdvance(TEN, card2.id, stage, ev)).ok ? 'ok' : 'blocked');
}
console.log(
  'promoted:',
  (await comp.attemptAdvance(TEN, card2.id, 'PROMOTED', { pilotRuns: 55, pilotSuccessRate: 0.96 })).ok
    ? 'PROMOTED'
    : 'blocked',
);
for (let i = 0; i < 12; i++) {
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      `tr_rot${i}`,
      TEN,
      null,
      'marketing',
      'churn.mail',
      'draft-churn-mail',
      '[]',
      'WORKFLOW',
      'FAILURE',
      '{}',
      card2.id,
      0.9,
      at(10 - i),
    );
}
console.log('drift check:', JSON.stringify(await comp.checkDrift(TEN, card2.id)));
const imp = await comp.compile({
  tenant: TEN,
  intent: 'draft-launch-copy',
  predicates: ['x'],
  steps: ['s'],
  tests: ['t'],
  toolGrants: [],
  validatedAtTier: 'WORKFLOW',
  originScope: 'sales',
  originModels: ['x'],
  scopeRoles: ['sales'],
  owner: 'h',
  traceIds: [],
  source: 'imported',
  now: at(5),
});
console.log('imported:', imp.id, imp.state, imp.trustTier);

// --- router traffic + an eval suite with a run ---
await router.route({
  tenant: TEN,
  taskType: 'release.detect',
  scope: 'engineering',
  actionClass: 'READ',
  importance: 0.1,
  reversible: true,
  now: at(1),
});
await router.route({
  tenant: TEN,
  taskType: 'launch.copy.draft',
  scope: 'marketing',
  actionClass: 'ANALYZE',
  importance: 0.4,
  reversible: true,
  now: at(1),
});
await addCase(db, {
  tenant: TEN,
  capability: 'ledger',
  suite: 'epistemics',
  kind: 'must-hold',
  input: { op: 'context' },
  expect: { ok: true },
  now: at(2),
});
const run = await runSuite(db, TEN, 'epistemics', 'demo-target', () => ({ pass: true }), { now: at(1) });
console.log('eval run:', run.passed, 'passed');

// --- watch contract + honeytask + kill drill traces in audit ---
await db
  .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
  .run(TEN, 'ledger', 'CONTRADICTION_OPEN', `${churnA.id}<>${churnB.id}`, 'resolution ticket required', at(2));

console.log('seeded var/demo.db');
await db.close();
