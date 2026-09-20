/**
 * Scratch (not shipped): build a persistent demo database for local UI testing.
 *
 * Everything here goes through the real domain APIs (auth, ledger, coordinator,
 * rooms, buzz) — no direct table writes except the trace rows the test fixtures
 * also write by hand, and no invented numbers: spend, escalations, and unread
 * counts are whatever the coordinator actually recorded.
 *
 *   tsx scratch/dev-seed.ts [--db var/dev-console.db] [--fresh]
 *
 * Then serve it:
 *   tsx src/cli.ts serve --db var/dev-console.db --port 3100 --tenant acme
 */
import { existsSync, rmSync } from 'node:fs';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator, DEFAULT_LIMITS } from '../src/coord/coordinator.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { createCustomRoom } from '../src/talk/rooms.ts';
import { createLocalReply } from '../src/console/buzz.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};

const DB = flag('--db', 'var/dev-console.db');
const TENANT = 'acme';
const OWNER_EMAIL = 'owner@acme.test';
const OWNER_PASSWORD = 'the-console-password';

// A fixed clock keeps the demo deterministic and gives the dashboard a real
// "today" to sum against. Requests carry their own created_at, so nothing is
// back-dated in a way the coordinator did not itself write.
const NOW = '2026-09-19T14:20:00.000Z';
const day = NOW.slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`;

if (args.includes('--fresh') && existsSync(DB)) rmSync(DB);

const db = openDb(DB);
await migrate(db);

// --------------------------------------------------------------- tenant ----
await installAuthSchema(db, NOW);
await signupTenant(
  db,
  { slug: TENANT, name: 'Acme Corp', email: OWNER_EMAIL, password: OWNER_PASSWORD, ownerName: 'Kulratan Thapar' },
  NOW,
);

const ledger = createLedger(db);

// The scheduler's production defaults (3 human escalations/day, $40/day) are
// deliberately tight, and a demo with a dozen proposals legitimately exceeds
// them — under the defaults the coordinator denies most of this world, which
// is correct behavior but leaves nothing to look at. The demo therefore states
// its own limits explicitly instead of misreporting the defaults as headroom.
const DEMO_LIMITS = {
  ...DEFAULT_LIMITS,
  maxConcurrentPerScope: 20,
  maxDailyDollars: 500,
  maxDailyTokens: 50_000_000,
  maxHumanEscalationsPerDay: 50,
  maxBid: {
    dollars: 100,
    tokens: 5_000_000,
    humanMinutes: 120,
    maxRounds: 10,
    maxHops: DEFAULT_LIMITS.maxBid!.maxHops!,
    maxDiskBytes: 8 * 1024 * 1024 * 1024,
  },
};
const coord = createCoordinator(db, DEMO_LIMITS);

const sor = (uri: string) => ({
  sourceUri: uri,
  sourceTier: 'SYSTEM_OF_RECORD' as const,
  extractor: 'linear-sync',
  extractorVersion: '1.0.0',
  retrievedAt: NOW,
});

/** Append one claim and hand back its real id. */
async function claim(
  scope: string,
  subject: string,
  statement: string,
  kind: 'FACT' | 'HYPOTHESIS' | 'PREDICTION',
  confidence: number,
  uri: string,
): Promise<string> {
  const rec = await ledger.append({
    tenant: TENANT,
    subject,
    kind,
    statement,
    confidence,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:linear',
    scope,
    authorType: 'system',
    provenance: sor(uri),
    validUntil: null,
  });
  return rec.id;
}

// -------------------------------------------------------------- claims ----
// Mixed kinds so the ledger and dashboard show every status tint with real
// evidence behind it, not a decorative rainbow.
const cShip = await claim(
  'infra',
  'release:v2.4',
  'v2.4 ships behind flag `v24`',
  'FACT',
  1,
  'https://linear.net/rel/1',
);
const cLatency = await claim('infra', 'api:p95', 'p95 latency is 240ms', 'FACT', 0.98, 'https://grafana.net/d/api-p95');
const cChurn = await claim(
  'business',
  'churn:q3',
  'Q3 churn holds under 2.1%',
  'FACT',
  0.94,
  'https://stripe.com/atlas',
);
const cBudget = await claim('finance', 'budget:q4', 'Q4 infra budget is $48k', 'FACT', 0.99, 'https://netsuite.com/gl');
const cClaimRate = await claim(
  'product',
  'onboarding:dropoff',
  'Onboarding drop-off is concentrated at step 3',
  'HYPOTHESIS',
  0.62,
  'https://amplitude.com/cohort',
);
const cPricing = await claim(
  'exec',
  'pricing:seat',
  'Seat-based pricing lifts net expansion',
  'HYPOTHESIS',
  0.55,
  'https://docs.google.com/pricing-model',
);
const cContract = await claim(
  'legal',
  'dpa:eu',
  'EU DPA revision clears counsel review',
  'FACT',
  1,
  'https://docusign.com/env/1',
);
const cSupport = await claim(
  'risk',
  'support:backlog',
  'Support backlog clears within 48h next quarter',
  'PREDICTION',
  0.71,
  'https://zendesk.com/reports/1',
);
const cDesign = await claim(
  'product',
  'design:tokens',
  'Design tokens ship in the same release as the console',
  'FACT',
  0.97,
  'https://figma.com/file/tokens',
);
const cResearch = await claim(
  'research',
  'market:apac',
  'APAC demand grows past EMEA in 2027',
  'PREDICTION',
  0.48,
  'https://internal/reports/apac',
);

// ------------------------------------------------------------ requests ----
let n = 0;
const rid = () => `rq_demo_${(n += 1).toString().padStart(2, '0')}`;

const proposal = (over: Record<string, unknown> = {}) => ({
  tenant: TENANT,
  messageClass: 'REQUEST' as const,
  originScope: 'product',
  targetScope: 'infra',
  goal: 'ship the console redesign',
  claimRefs: [cShip],
  deliverableSchema: 'feasibility.v1',
  onBehalfOf: 'human:owner',
  bid: { dollars: 6, humanMinutes: 12 },
  now: NOW,
  ...over,
});

type Submitted = Awaited<ReturnType<typeof coord.submit>>;
const submitted: Submitted[] = [];

/** Submit, and record the real state the coordinator assigned. */
async function propose(over: Record<string, unknown> = {}): Promise<Submitted> {
  const res = await coord.submit(proposal({ id: rid(), ...over }));
  submitted.push(res);
  return res;
}

// Settled work — this is what the spend KPIs sum, so the numbers are the
// coordinator's own, not a guess. Spend only ever flows through `charge`:
// `complete` takes a cost argument but records none, so charging first is what
// makes the dashboard's today-spend reflect this world.
const s1 = await propose({
  originScope: 'product',
  targetScope: 'infra',
  goal: 'ship console redesign',
  claimRefs: [cShip, cDesign],
});
await coord.accept(TENANT, s1.request.id);
await coord.charge(TENANT, s1.request.id, { dollars: 4.2, humanMinutes: 35, tokens: 41_000 });
await coord.complete(TENANT, s1.request.id, { claims: [cShip], cost: {} });

const s2 = await propose({
  originScope: 'business',
  targetScope: 'data',
  goal: 'reconcile Q3 churn against Atlas',
  claimRefs: [cChurn],
});
await coord.accept(TENANT, s2.request.id);
await coord.charge(TENANT, s2.request.id, { dollars: 2.8, humanMinutes: 20, tokens: 26_500 });
await coord.complete(TENANT, s2.request.id, { claims: [cChurn], cost: {} });

const s3 = await propose({
  originScope: 'finance',
  targetScope: 'infra',
  goal: 'model Q4 infra budget against usage',
  claimRefs: [cBudget, cLatency],
});
await coord.accept(TENANT, s3.request.id);
await coord.charge(TENANT, s3.request.id, { dollars: 3.1, humanMinutes: 25, tokens: 31_200 });
await coord.complete(TENANT, s3.request.id, { claims: [cBudget], cost: {} });

const s4 = await propose({
  originScope: 'legal',
  targetScope: 'exec',
  goal: 'route the EU DPA revision to counsel',
  claimRefs: [cContract],
});
await coord.accept(TENANT, s4.request.id);
await coord.charge(TENANT, s4.request.id, { dollars: 1.4, humanMinutes: 45, tokens: 12_400 });
await coord.complete(TENANT, s4.request.id, { claims: [cContract], cost: {} });

// In flight — one claimed for execution, so the activity feed shows live work.
const s5 = await propose({
  originScope: 'product',
  targetScope: 'research',
  goal: 'size APAC demand for 2027 planning',
  claimRefs: [cResearch],
});
await coord.accept(TENANT, s5.request.id);
await coord.claimExecution(TENANT, s5.request.id, 'worker:demo', NOW, 30 * 60_000);

// Still waiting on a human — the approvals queue is populated by the
// coordinator admitting these, not by a hand-written row.
await propose({
  originScope: 'product',
  targetScope: 'infra',
  goal: 'cut onboarding drop-off at step 3',
  claimRefs: [cClaimRate],
  bid: { dollars: 5, humanMinutes: 30 },
});
await propose({
  originScope: 'exec',
  targetScope: 'finance',
  goal: 'validate seat-based pricing before the board call',
  claimRefs: [cPricing],
  bid: { dollars: 8, humanMinutes: 45 },
});
await propose({
  originScope: 'risk',
  targetScope: 'product',
  goal: 'clear the support backlog before renewal season',
  claimRefs: [cSupport],
  bid: { dollars: 3, humanMinutes: 20 },
});
await propose({
  originScope: 'research',
  targetScope: 'business',
  goal: 'pressure-test the APAC forecast assumptions',
  claimRefs: [cResearch],
  bid: { dollars: 4, humanMinutes: 15 },
});

// A declined one, so the ledger shows a refusal with a real reason. The
// coordinator may already have refused it on its own terms — in that case the
// denial stands and we do not overwrite it with ours.
const s9 = await propose({
  originScope: 'data',
  targetScope: 'legal',
  goal: 'export raw customer rows for a one-off analysis',
  claimRefs: [cChurn],
  bid: { dollars: 2, humanMinutes: 10 },
});
if (s9.request.state === 'ADMITTED' || s9.request.state === 'IN_FLIGHT') {
  await coord.decline(TENANT, s9.request.id, 'raw PII export is out of policy — use the aggregated view');
} else {
  console.log(`  (coordinator refused the PII export on its own terms: ${s9.request.state})`);
}

// ------------------------------------------------------------- notices ----
// NOTICEs are the only thing the Digest renders, and they are deliberately not
// requests: `submit` completes them without touching budget, human minutes or
// review attention. Two of them share a topic inside the 24h grouping window on
// purpose, so the Digest shows a real group with `+1 more` rather than N
// single-notice cards.
const notice = (goal: string, originScope: string, targetScope: string, atTime: string, claimRefs: string[] = []) =>
  coord.submit({
    tenant: TENANT,
    id: rid(),
    messageClass: 'NOTICE',
    originScope,
    // Still a proposal, so origin and target must differ: the coordinator
    // rejects self-delegation. The target is merely who is being told.
    targetScope,
    goal,
    claimRefs,
    deliverableSchema: 'feasibility.v1',
    onBehalfOf: 'human:owner',
    bid: { dollars: 0, humanMinutes: 0 },
    now: atTime,
  });

await notice('nightly Atlas sync finished with no drift', 'data', 'business', at('02:05'));
await notice('v24 flag ramped to 25% of traffic', 'infra', 'product', at('09:40'));
await notice('support backlog is clearing ahead of schedule', 'risk', 'product', at('11:20'));
// Same normalized goal and origin scope, 2h40m apart — inside the 24h grouping
// window, so the Digest renders ONE group with "+1 more". The coordinator's
// idempotency key includes claimRefs, so citing evidence on the follow-up keeps
// it a distinct proposal rather than a replay of the 12:30 ping.
await notice('p95 latency is within budget', 'infra', 'product', at('12:30'));
await notice('p95 latency is within budget', 'infra', 'product', at('15:10'), [cLatency]);

// ---------------------------------------------------------------- traces ----
// Same shape the served-console fixture writes: the learning/compiler
// surfaces read these, so the demo needs at least a few.
const trace = async (id: string, requestId: string, scope: string, taskType: string, outcome: string, tokens: number) =>
  db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      TENANT,
      requestId,
      scope,
      taskType,
      `code:${scope}`,
      '[]',
      'MODEL',
      outcome,
      JSON.stringify({ tokens }),
      null,
      0.9,
      NOW,
    );

await trace('tr_demo_01', s1.request.id, 'infra', 'infra.implement', 'SUCCESS', 41_000);
await trace('tr_demo_02', s2.request.id, 'data', 'data.reconcile', 'SUCCESS', 26_500);
await trace('tr_demo_03', s3.request.id, 'infra', 'infra.model', 'SUCCESS', 31_200);
await trace('tr_demo_04', s4.request.id, 'exec', 'exec.route', 'SUCCESS', 12_400);
await trace('tr_demo_05', s5.request.id, 'research', 'research.size', 'PARTIAL', 8_900);

// ------------------------------------------------------------ chat rooms ----
// Real messages through the real store, so unread counts and recency are
// computed from rows the console would have fetched anyway.
const say = (scope: string, author: string, content: string, hhmm: string) =>
  createLocalReply(db, TENANT, scope, null, author, content, at(hhmm));

await say(
  'general',
  'human:owner',
  'Morning — the console redesign is on staging. Please flag anything that reads wrong.',
  '08:45',
);
await say('infra', 'agent:infra', 'v2.4 is behind the `v24` flag. Rollback is one flag flip, no deploy.', '09:10');
await say('infra', 'human:owner', 'Good. Hold the flag at 10% until p95 settles under 300ms.', '09:14');
await say('infra', 'agent:infra', 'p95 is 240ms. Evidence attached to release:v2.4.', '09:31');
await say('general', 'agent:finance', 'Q4 infra budget is $48k against $31.2k committed so far.', '10:02');
await say('general', 'human:owner', 'Keep the remaining spend reserved for the migration.', '10:07');
await say('legal', 'agent:legal', 'EU DPA revision cleared counsel review. No redlines outstanding.', '11:20');
await say(
  'risk',
  'agent:risk',
  'Support backlog is the renewal risk. 48h clearance is a prediction, not a fact yet.',
  '11:48',
);
await say(
  'product',
  'agent:product',
  'Onboarding drop-off at step 3 is still a hypothesis — the cohort query is not conclusive.',
  '12:05',
);
await say('general', 'agent:data', 'Churn reconciled against Atlas: 1.9%, under the 2.1% line.', '12:41');

// --------------------------------------------------------- custom rooms ----
await createCustomRoom(
  db,
  TENANT,
  {
    id: 'design',
    name: 'design',
    scope: 'design',
    agentName: 'design-agent',
    mission: 'Design system reviews for the console.',
  },
  'human:owner',
);
await say('design', 'agent:design', 'Token pass is done — one accent, one radius scale, no per-page colors.', '13:02');

// ---------------------------------------------------------------- report ----
const counts = {
  claims: (await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TENANT)) as { n: number },
  requests: (await db.prepare('SELECT COUNT(*) AS n FROM requests WHERE tenant = ?').get(TENANT)) as { n: number },
  escalations: (await db.prepare('SELECT COUNT(*) AS n FROM escalations WHERE tenant = ?').get(TENANT)) as {
    n: number;
  },
  messages: (await db.prepare('SELECT COUNT(*) AS n FROM buzz_messages WHERE tenant = ?').get(TENANT)) as { n: number },
  spend: (await db
    .prepare('SELECT COALESCE(SUM(spent_dollars),0) AS d FROM requests WHERE tenant = ?')
    .get(TENANT)) as { d: number },
};

console.log(`Seeded ${DB}`);
console.log(`  tenant      ${TENANT} (Acme Corp)`);
console.log(`  login       ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
console.log(`  claims      ${counts.claims.n}`);
console.log(`  requests    ${counts.requests.n}`);
console.log(`  escalations ${counts.escalations.n}`);
console.log(`  messages    ${counts.messages.n}`);
console.log(`  spend       $${Number(counts.spend.d).toFixed(2)}`);
console.log(
  `  limits      $${DEMO_LIMITS.maxDailyDollars}/day, ${DEMO_LIMITS.maxHumanEscalationsPerDay} escalations/day (demo, not production defaults)`,
);
console.log('');
console.log(`Serve it:  tsx src/cli.ts serve --db ${DB} --port 3100 --tenant ${TENANT}`);

await db.close();
