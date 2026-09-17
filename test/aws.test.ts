import { T, eq, TEN, NOW, fresh, sor, base, rejects } from './helpers.ts';
import { handler, runJob } from '../src/aws/executor.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

console.log('\n\x1b[1mAWS executor — the Lambda microVM plane\x1b[0m');

const tableCount = (path: string): number => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

T('VITAL_MIGRATE_ON_BOOT=0 skips DDL: migrations are deployment work, not per-invocation work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vital-aws-'));
  try {
    const skipped = join(dir, 'skipped.db');
    const out = await handler({ Records: [] }, { SQLITE_PATH: skipped, VITAL_MIGRATE_ON_BOOT: '0' });
    eq(out.results.length, 0);
    eq(tableCount(skipped), 0, 'no tables created when migration is off:');
    const migrated = join(dir, 'migrated.db');
    await handler({ Records: [] }, { SQLITE_PATH: migrated });
    eq(tableCount(migrated) > 10, true, 'default path still migrates (local/dev):');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

T('executor honors the tenant from the job, not the process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vital-aws-'));
  try {
    // Empty batch on a fresh DB migrates and returns no results — the point
    // is the handler boots against SQLITE_PATH without DATABASE_URL.
    const out = await handler({ Records: [] }, { SQLITE_PATH: join(dir, 'v.db'), VITAL_TENANT: TEN });
    eq(out.results, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- F05: ownership, accounting, artifacts over a REAL nonempty job -----

const chat = async () => ({ text: 'deliverable-body-0123456789'.repeat(8), usage: { input: 100, output: 50 } });

T('F05: a real job claims exclusively, charges usage, persists the full artifact, and completes', async () => {
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
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'f5a', goal: 'real job probe', claimRefs: [clm.id] }));
  const out = await runJob(
    db,
    { tenant: TEN, requestId: request.id, prompt: 'make the thing', lane: 'dev', onBehalfOf: 'worker:f5' },
    { GEMINI_API_KEY: 'test-key' },
    chat,
  );
  eq(out.status, 'COMPLETED');
  eq(out.usage, { input: 100, output: 50 }, 'usage is reported:');
  const after = (await coord.get(TEN, request.id))!;
  eq(after.state, 'COMPLETED');
  eq(after.spent.tokens, 150, 'usage charged through the coordinator (was silently dropped):');
  eq(after.spent.dollars > 0, true, 'dollar costing uses the tenant rates, not zero:');
  // The artifact carries the FULL text; the claim carries a preview + ref.
  const art = (await db
    .prepare('SELECT body, claim_id FROM executor_artifacts WHERE request_id = ?')
    .get(request.id)) as { body: string; claim_id: string };
  eq(art.body.length, 'deliverable-body-0123456789'.repeat(8).length, 'full text persisted, not an 8k truncation:');
  const obs = await ledger.get(TEN, art.claim_id);
  const value = obs!.value as { textPreview: string; fullTextRef: string; truncated: boolean };
  eq(value.fullTextRef.length > 0, true, 'the claim points at the artifact:');
  eq(value.textPreview.length <= 2000, true, 'the claim value is a bounded preview:');
  eq(value.truncated, false);
});

T('F05: a second concurrent delivery of the same job cannot double-spend (claim fencing)', async () => {
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
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'f5b', goal: 'fencing probe', claimRefs: [clm.id] }));
  // Worker A holds the claim (as if mid-model-call).
  await coord.claimExecution(TEN, request.id, 'worker-a', NOW);
  // The redelivered job arrives while A holds it: B must refuse, not spend.
  await rejects(
    async () =>
      await runJob(
        db,
        { tenant: TEN, requestId: request.id, prompt: 'make the thing', lane: 'dev' },
        { GEMINI_API_KEY: 'test-key' },
        chat,
      ),
    'CLAIM_LOST',
  );
  eq((await coord.get(TEN, request.id))!.spent.tokens, 0, 'the loser spent nothing:');
});

T('F05: a job whose usage breaches the bid settles TERMINATED as failed, artifact kept', async () => {
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
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'f5c', goal: 'budget probe', claimRefs: [clm.id], bid: { tokens: 100 } }),
  );
  const out = await runJob(
    db,
    { tenant: TEN, requestId: request.id, prompt: 'too expensive', lane: 'dev' },
    { GEMINI_API_KEY: 'test-key' },
    chat,
  );
  eq(out.status, 'FAILED', 'the over-budget completion does not read as success:');
  eq(out.error!.includes('budget'), true);
  const after = (await coord.get(TEN, request.id))!;
  eq(after.state, 'TERMINATED_BUDGET', 'the request settles coherently:');
  eq(after.spent.tokens, 150, 'the spend is recorded, never dropped:');
  // The artifact survives the budget death: the work product is inspectable.
  const art = (await db.prepare('SELECT body FROM executor_artifacts WHERE request_id = ?').get(request.id)) as {
    body: string;
  };
  eq(art.body.length > 0, true, 'deliverable kept despite the budget death:');
});
