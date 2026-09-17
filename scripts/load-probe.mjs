// Load probe (audit Phase 1 validation): seeds synthetic history directly
// into the tables (SQL, not ledger writes — this measures READ shape, not
// write invariants) and times the interactive paths: dashboard build,
// approval, admission. Run: `node scripts/load-probe.mjs [--claims N
// --decisions N]`. Not part of `npm test` (minutes, not milliseconds).
// Numbers are local-sqlite evidence, not production claims.
import { openDb, migrate } from '../src/core/db.ts';
import { openPostgres, migratePostgres } from '../src/core/pg.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { buildReport } from '../src/console/report.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1] ?? fallback);
};
const N_CLAIMS = flag('--claims', 10_000);
const N_DECISIONS = flag('--decisions', 200);
const PG_URL = process.env.LOAD_PG_URL ?? '';
// Dedicated tenant + pre-clean: repeated runs (especially against a shared
// Postgres) must neither collide on PKs nor touch real tenants.
const TEN = 'probe';
const NOW = '2026-09-17T12:00:00.000Z';

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const db = PG_URL ? openPostgres(PG_URL) : openDb(':memory:');
if (PG_URL) await migratePostgres(db);
else await migrate(db);
// Outcomes first: outcomes.decision_id is a real FK (both engines enforce).
for (const t of ['outcomes', 'traces', 'claims', 'decisions', 'requests']) {
  await db.prepare(`DELETE FROM ${t} WHERE tenant = ?`).run(TEN);
}
const tSeed0 = Date.now();
await db.transaction(async () => {
  for (let i = 0; i < N_CLAIMS; i++) {
    await db
      .prepare(
        `INSERT INTO claims (id,tenant,subject,kind,statement,value_json,unit,confidence,source_uri,source_tier,
         extractor,extractor_ver,retrieved_at,raw_ref,corrob_json,observed_at,valid_from,valid_until,
         verified_at,status,owner,scope,provisional,buzz_sig,created_at,seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `clm_${i}`,
        TEN,
        `repo:svc${i % 50}`,
        'OBSERVATION',
        `signal ${i}`,
        null,
        null,
        0.8,
        `https://x/${i}`,
        'SINGLE_SOURCE',
        'probe',
        '1',
        NOW,
        null,
        null,
        NOW,
        NOW,
        null,
        null,
        'CANDIDATE',
        'human:priya',
        'engineering',
        0,
        null,
        NOW,
        i + 1,
      );
  }
});
await db.transaction(async () => {
  for (let i = 0; i < N_DECISIONS; i++) {
    const rid = `req_${i}`;
    await db
      .prepare(
        `INSERT INTO requests (id,tenant,message_class,origin_scope,target_scope,goal,claim_refs,deliverable,
         bid_json,on_behalf_of,hop_chain,chain_claims,idem_key,stop_condition,state,spent_json,refusal_reason,
         parent_request,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rid,
        TEN,
        'REQUEST',
        'marketing',
        'engineering',
        `goal ${i}`,
        '[]',
        'x.v1',
        JSON.stringify({
          dollars: 10,
          tokens: 20000,
          humanMinutes: 30,
          deadline: NOW,
          maxRounds: 3,
          maxHops: 3,
          maxDiskBytes: 0,
        }),
        'human:priya',
        '[]',
        '[]',
        `idem_${i}`,
        'done',
        'COMPLETED',
        JSON.stringify({ dollars: 1, tokens: 1500, humanMinutes: 5, rounds: 1, diskBytes: 0 }),
        null,
        null,
        NOW,
        NOW,
      );
    await db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_${i}`,
        TEN,
        rid,
        'engineering',
        'engineering.implement',
        'x',
        '[]',
        'MODEL',
        'SUCCESS',
        JSON.stringify({ tokens: 1500 }),
        null,
        0.9,
        NOW,
      );
    const did = `dec_${i}`;
    await db
      .prepare(
        `INSERT INTO decisions (id,tenant,goal,action,action_class,context_bundle,decided_by,approved_by,scope,autonomy,request_id,signed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        did,
        TEN,
        `goal ${i}`,
        'ship',
        'ACT_REVERSIBLE',
        '{}',
        'human:priya',
        'human:priya',
        'engineering',
        'approval',
        rid,
        NOW,
      );
    await db
      .prepare(
        `INSERT INTO outcomes (id,tenant,decision_id,metric,predicted,actual,basis,holdout_ref,resolved_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(`out_${i}`, TEN, did, 'adoption', 0.2, 0.31, 'warehouse:adopt', null, NOW, NOW);
  }
});
const seedMs = Date.now() - tSeed0;

const ledger = createLedger(db);
const coord = createCoordinator(db);
const comp = new OrganizationalCompiler(db);

await buildReport(db, ledger, coord, comp, TEN, NOW); // warm
const builds = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  await buildReport(db, ledger, coord, comp, TEN, NOW);
  builds.push(Date.now() - t0);
}
const submits = [];
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  await coord.submit({
    tenant: TEN,
    messageClass: 'QUERY',
    originScope: 'marketing',
    targetScope: 'engineering',
    goal: `probe ${i} ${Date.now()}`,
    claimRefs: ['clm_1'],
    deliverableSchema: 'x.v1',
    onBehalfOf: 'human:priya',
    now: NOW,
  });
  submits.push(Date.now() - t0);
}
const tA0 = Date.now();
await coord.approvalLatencyStats(TEN);
const latencyMs = Date.now() - tA0;

console.log(
  JSON.stringify(
    {
      engine: PG_URL ? 'postgres' : 'sqlite',
      claims: N_CLAIMS,
      decisions: N_DECISIONS,
      seedMs,
      reportMs: { p50: pct(builds, 0.5), p95: pct(builds, 0.95), max: Math.max(...builds) },
      submitMs: { p50: pct(submits, 0.5), p95: pct(submits, 0.95), max: Math.max(...submits) },
      approvalLatencyStatsMs: latencyMs,
    },
    null,
    2,
  ),
);
await db.close();
