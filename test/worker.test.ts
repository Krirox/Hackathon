import { T, eq, TEN, NOW, fresh, base, sor, rejects } from './helpers.ts';
import { ApplicationWorker, runApplicationWorker } from '../src/substrate/worker.ts';
import { enqueueOutbox } from '../src/substrate/scheduler.ts';
import { enqueueExecutorJob } from '../src/aws/executor.ts';
import { setKill, clearKill } from '../src/gov/trust.ts';
import type { BuzzSurface } from '../src/talk/buzz-surface.ts';
import type { HarnessAdapter } from '../src/substrate/harness.ts';
import {
  loadDeliverableByRequest,
  listDeliverableVersions,
} from '../src/wedge/deliverable-artifact.ts';

console.log('\n\x1b[1mApplication Worker — background sweeps, outbox relay, and request dispatch\x1b[0m');

T('worker validates options: tenant must be nonempty without NUL', async () => {
  const { db, ledger, coord } = await fresh();

  await rejects(
    // @ts-expect-error testing invalid options
    async () => new ApplicationWorker(db, ledger, coord, null),
    'INVALID_OPTIONS',
  );

  await rejects(async () => new ApplicationWorker(db, ledger, coord, { tenant: '' }), 'INVALID_OPTIONS');

  await rejects(async () => new ApplicationWorker(db, ledger, coord, { tenant: 'bad\0tenant' }), 'INVALID_OPTIONS');
});

T('recovery sweeps: readmits deferred, reclaims stale leases, and expires timed-out requests', async () => {
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

  // 1. Stale in-flight lease
  const { request: r1 } = await coord.submit(base({ id: 'req-stale', goal: 'stale task', claimRefs: [clm.id] }));
  const claimedAt = '2026-09-01T00:00:00.000Z';
  await coord.claimExecution(TEN, r1.id, 'old-worker', claimedAt, 1000); // 1-second lease

  // 2. Timed-out unadmitted request with expired deadline
  const { request: r2 } = await coord.submit(
    base({
      id: 'req-expired',
      goal: 'expired task',
      claimRefs: [clm.id],
      bid: {
        dollars: 1,
        tokens: 1000,
        maxRounds: 1,
        humanMinutes: 0,
        maxDiskBytes: 0,
        deadline: '2026-09-01T00:00:00.000Z',
      },
    }),
  );

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.swept.reclaimed, 1);
  eq(tickRes.swept.expired, 1);

  const checkR1 = await coord.get(TEN, r1.id);
  eq(checkR1?.state, 'ADMITTED'); // Lease reclaimed back to ADMITTED
  eq(checkR1?.execOwner, null);

  const checkR2 = await coord.get(TEN, r2.id);
  eq(checkR2?.state, 'EXPIRED');

  const status = worker.status();
  eq(status.counters.reclaimed, 1);
  eq(status.counters.expired, 1);
  eq(status.counters.sweeps, 1);
});

T('outbox relay: claims rows, dispatches to handler, and settles DONE', async () => {
  const { db, ledger, coord } = await fresh();

  const outboxId = await enqueueOutbox(db, TEN, 'custom-notification', { title: 'hello' }, { now: NOW });

  const handled: string[] = [];
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    outboxHandler: async (row) => {
      handled.push(row.id);
    },
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.outboxProcessed, 1);
  eq(tickRes.outboxFailed, 0);
  eq(handled.includes(outboxId), true);

  const row = (await db.prepare('SELECT status FROM outbox WHERE id = ?').get(outboxId)) as { status: string };
  eq(row.status, 'DONE');
});

T('outbox relay: handles failures with retry backoff and settles FAILED', async () => {
  const { db, ledger, coord } = await fresh();

  const outboxId = await enqueueOutbox(db, TEN, 'failing-task', { foo: 'bar' }, { now: NOW });

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    outboxHandler: async () => {
      throw new Error('network down');
    },
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.outboxProcessed, 0);
  eq(tickRes.outboxFailed, 1);

  const row = (await db.prepare('SELECT status, attempts, next_at FROM outbox WHERE id = ?').get(outboxId)) as {
    status: string;
    attempts: number;
    next_at: string;
  };
  eq(row.status, 'FAILED');
  eq(row.attempts, 1);
  eq(Date.parse(row.next_at) > Date.parse(NOW), true); // Backoff scheduled in future
});

T('outbox relay: dispatches executor-job to sqsSender when configured', async () => {
  const { db, ledger, coord } = await fresh();

  const outboxId = await enqueueExecutorJob(
    db,
    TEN,
    {
      tenant: TEN,
      requestId: 'req-sqs-1',
      prompt: 'test prompt',
    },
    { now: NOW },
  );

  const sqsSent: string[] = [];
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    sqsSender: async (job) => {
      sqsSent.push(job.requestId);
    },
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.outboxProcessed, 1);
  eq(sqsSent.includes('req-sqs-1'), true);

  const row = (await db.prepare('SELECT status FROM outbox WHERE id = ?').get(outboxId)) as { status: string };
  eq(row.status, 'DONE');
});

T('runnable request dispatch: claims ADMITTED/ACCEPTED requests, executes, and completes', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:seed',
    kind: 'OBSERVATION',
    statement: 'seed evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:seed',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  // Request 1: ADMITTED
  const { request: r1 } = await coord.submit(base({ id: 'disp-1', goal: 'task 1', claimRefs: [clm.id] }));
  eq(r1.state, 'ADMITTED');

  // Request 2: ACCEPTED (approved by human)
  const { request: r2 } = await coord.submit(base({ id: 'disp-2', goal: 'task 2', claimRefs: [clm.id] }));
  await coord.accept(TEN, r2.id);
  const checkR2 = await coord.get(TEN, r2.id);
  eq(checkR2?.state, 'ACCEPTED');

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.requestsDispatched, 2);
  eq(tickRes.requestsCompleted, 2);
  eq(tickRes.requestsFailed, 0);

  const finishedR1 = await coord.get(TEN, r1.id);
  eq(finishedR1?.state, 'COMPLETED');

  const finishedR2 = await coord.get(TEN, r2.id);
  eq(finishedR2?.state, 'COMPLETED');
});

T('request dispatch: handles custom requestExecutor and error isolation', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:custom',
    kind: 'OBSERVATION',
    statement: 'evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:seed',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });

  const { request: r1 } = await coord.submit(base({ id: 'custom-1', goal: 'failing task', claimRefs: [clm.id] }));

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
    requestExecutor: async () => {
      throw new Error('unrecoverable failure');
    },
  });

  const tickRes = await worker.tick(NOW);
  eq(tickRes.requestsDispatched, 1);
  eq(tickRes.requestsCompleted, 0);
  eq(tickRes.requestsFailed, 1);

  const finishedR1 = await coord.get(TEN, r1.id);
  eq(finishedR1?.state, 'FAILED');
  eq(finishedR1?.refusalReason?.includes('unrecoverable failure'), true);
});

T('an engaged stop refuses the custom requestExecutor path before it claims', async () => {
  // Two execution paths exist in the worker, and only the adapter one used to be
  // guarded — the adapter checks the kill switch inside itself (harness.ts),
  // while a custom `requestExecutor` never touches an adapter. A stop engaged by
  // an operator therefore stopped one path and not the other.
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:custom-kill',
    kind: 'OBSERVATION',
    statement: 'evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:seed',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'custom-kill-1', goal: 'must not run', claimRefs: [clm.id] }),
  );
  await setKill(db, TEN, { scope: 'engineering', actionClass: '*' }, 'operator:killprobe', NOW);

  let calls = 0;
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
    requestExecutor: async () => {
      calls += 1;
      return { claims: [], cost: {} };
    },
  });
  const tickRes = await worker.tick(NOW);
  eq(calls, 0, 'the custom executor is never invoked under a stop:');
  eq(tickRes.requestsFailed >= 1, true, 'the refusal is counted as a failure:');
  const after = await coord.get(TEN, request.id);
  eq(after?.state, 'FAILED');
  eq(after?.refusalReason?.includes('kill switch'), true, 'and the reason is recorded:');

  // Disengage, and a fresh request on the same scope runs: the guard refuses on
  // the stop alone, not on the executor being custom.
  await clearKill(db, TEN, { scope: 'engineering', actionClass: '*' }, 'operator:killprobe', NOW);
  const { request: r2 } = await coord.submit(base({ id: 'custom-kill-2', goal: 'runs now', claimRefs: [clm.id] }));
  const worker2 = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
    requestExecutor: async () => {
      calls += 1;
      return { claims: [], cost: {} };
    },
  });
  await worker2.tick(NOW);
  eq(calls, 1, 'the executor runs once the stop is cleared:');
  eq((await coord.get(TEN, r2.id))?.state, 'COMPLETED');
});

T('an outbox row nobody can deliver is never settled as delivered', async () => {
  // The relay handled `executor-job` and let every other kind fall through to
  // settleOutbox(..., 'DONE'). `automation-self-halt` is one of those kinds, so
  // the governance system's own alarm was marked "delivered" without a delivery —
  // the freeze happened, the operator was never told, and the DB agreed with the
  // lie. A row that cannot be delivered must stay FAILED and retrying.
  const { db, ledger, coord } = await fresh();
  await enqueueOutbox(
    db,
    TEN,
    'automation-self-halt',
    { scope: 'engineering', actionClass: '*', reason: 'honeytask miss — automatic freeze' },
    { now: NOW },
  );
  await enqueueOutbox(db, TEN, 'kind-nobody-handles', { anything: true }, { now: NOW });
  // The second governance alarm, and the one row in this outbox that is not a
  // delivery at all.
  await enqueueOutbox(
    db,
    TEN,
    'canary-sla-miss',
    { scope: 'engineering', canaryId: 'canary-1', reason: 'agent failed to flag anomaly' },
    { now: NOW },
  );
  await enqueueOutbox(db, TEN, 'scheduler-occurrence', { job: 'watch', firedAt: NOW }, { now: NOW });

  const statusOf = async (): Promise<Map<string, { status: string; attempts: number }>> => {
    const rows = (await db.prepare('SELECT kind, status, attempts FROM outbox').all()) as {
      kind: string;
      status: string;
      attempts: number;
    }[];
    return new Map(rows.map((r) => [r.kind, { status: r.status, attempts: r.attempts }]));
  };

  // No Buzz surface bound: nothing can deliver either row.
  const unbound = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
  });
  await unbound.tick(NOW);
  const afterUnbound = await statusOf();
  eq(
    afterUnbound.get('automation-self-halt')?.status,
    'FAILED',
    'an undeliverable self-halt is not recorded as delivered:',
  );
  eq(
    afterUnbound.get('kind-nobody-handles')?.status,
    'FAILED',
    'an unknown kind is not recorded as delivered:',
  );
  eq(
    (afterUnbound.get('automation-self-halt')?.attempts ?? 0) > 0,
    true,
    'and the attempt is counted, so it retries instead of disappearing:',
  );

  // With a surface bound, the halt is published as a status event — the alarm
  // rings, and only then does the row read DONE.
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const surface = {
    name: 'test',
    relayUrl: 'wss://relay.test',
    authMode: 'none' as const,
    pubkey: 'pk-test',
    publish: async (evt: { kind: number; tags: string[][]; content: string }) => {
      published.push(evt);
      return { id: 'evt' } as never;
    },
    post: async () => {
      throw new Error('unused in this test');
    },
    query: async () => [],
    health: async () => ({ ok: true }) as never,
  } as unknown as BuzzSurface;
  const bound = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    dispatchRequests: false,
    buzz: { surface, channelFor: () => null },
  });
  // Past the retry backoff the first failure scheduled: a FAILED row is due
  // again, which is the other half of "it retries rather than disappearing".
  const later = new Date(Date.parse(NOW) + 120_000).toISOString();
  await bound.tick(later);
  const afterBound = await statusOf();
  eq(
    published.length,
    2,
    `both governance notices are published (${published.map((p) => p.content).join(' | ')}):`,
  );
  eq(
    published.some((p) => p.content.includes('Honeytask canary missed')),
    true,
    'the canary SLA miss is delivered, not swallowed:',
  );
  const halt = published.find((p) => p.content.includes('Automation frozen'))!;
  eq(
    halt.content.includes('engineering'),
    true,
    `the notice names the frozen scope (${halt.content}):`,
  );
  eq(
    halt.tags.some(([k, v]) => k === 'vital-scope' && v === 'engineering'),
    true,
    'and carries the scope as a filterable tag:',
  );
  eq(afterBound.get('automation-self-halt')?.status, 'DONE', 'delivered rows settle DONE:');
  eq(
    afterBound.get('canary-sla-miss')?.status,
    'DONE',
    'the delivered canary notice settles DONE:',
  );
  // `recordSchedulerOccurrence` documents this row as the durable record that a
  // cron fired — the record itself is the whole point, so acknowledging it is
  // correct rather than a silent swallow.
  eq(
    afterBound.get('scheduler-occurrence')?.status,
    'DONE',
    'a scheduler occurrence is acknowledged as a record, not delivered:',
  );
  eq(
    afterBound.get('kind-nobody-handles')?.status,
    'FAILED',
    'an unknown kind stays FAILED even with a surface bound:',
  );
});

T('a completed run leaves a reviewable draft deliverable', async () => {
  // The last hop of the flagship loop used to be manual: a background run
  // produced a claim, a trace and a snapshot, and the human was then asked to
  // hand-draft the artifact before they could approve it. `ship.ts` drafts inline
  // for the synchronous path; the worker never did.
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:draft',
    kind: 'OBSERVATION',
    statement: 'the claim holds under load',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:seed',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'draft-1', goal: 'produce the artifact', claimRefs: [clm.id] }),
  );
  await coord.accept(TEN, request.id);

  const body = `${clm.id}: the claim holds under load. Next step: run the pilot.`;
  let runs = 0;
  const adapter = {
    name: 'test-real-adapter',
    async run() {
      runs += 1;
      return {
        adapter: 'test-real-adapter',
        requestId: request.id,
        status: 'COMPLETED' as const,
        transcript: body,
        tools: [],
        usage: { input: 10, output: 20 },
        permissions: [],
        isTestBaseline: false,
      };
    },
  } as unknown as HarnessAdapter;

  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
    adapter,
  });
  const tickRes = await worker.tick(NOW);
  eq(runs, 1, 'the adapter ran:');
  eq(tickRes.requestsCompleted, 1);

  const draft = await loadDeliverableByRequest(db, TEN, request.id);
  eq(Boolean(draft), true, 'the completed run left a deliverable to review:');
  const versions = await listDeliverableVersions(db, TEN, draft!.id);
  eq(versions.length, 1, 'exactly one draft version:');
  eq(versions[0]!.requestId, request.id, 'linked back to the request:');
  eq(versions[0]!.preview.includes('the claim holds under load'), true, 'and carries the run output:');
  eq(versions[0]!.createdBy.length > 0, true, 'attributed to the actor the run was made for:');

  // At-least-once delivery: a redelivered run must not stack versions.
  await db.prepare('UPDATE requests SET state = ? WHERE tenant = ? AND id = ?').run('ACCEPTED', TEN, request.id);
  const redelivered = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    relayOutbox: false,
    adapter,
  });
  await redelivered.tick(NOW);
  eq(runs, 2, 'the redelivered run executed:');
  eq(
    (await listDeliverableVersions(db, TEN, draft!.id)).length,
    1,
    'and did not stack a second draft version:',
  );
});

T('runApplicationWorker respects AbortSignal and shuts down gracefully', async () => {
  const { db, ledger, coord } = await fresh();
  const controller = new AbortController();

  const workerPromise = runApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    pollIntervalMs: 20,
    signal: controller.signal,
  });

  // Let it run at least 1 tick
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();

  const result = await workerPromise;
  eq(result.stopped, true);
  eq(result.ticks >= 1, true);
  eq(result.tenant, TEN);
});

T('the cloud lane produces the executor job the Lambda infrastructure consumes', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:cloud-lane',
    kind: 'OBSERVATION',
    statement: 'work to be queued for the cloud executor',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  await coord.submit(base({ id: 'req-cloud', goal: 'draft the release note', claimRefs: [clm.id] }));

  const sent: { requestId: string }[] = [];
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    executorLane: 'cloud',
    relayOutbox: false,
    sqsSender: async (job) => {
      sent.push({ requestId: job.requestId });
    },
  });

  // Tick 1: the lane writes the durable job and does NOT execute anything here.
  const first = await worker.tick(NOW);
  eq(first.requestsQueuedForCloud, 1, 'the request was queued for the cloud lane:');
  eq(sent.length, 0, 'nothing was sent by the dispatch tick itself:');
  const queued = (await db
    .prepare("SELECT payload_json FROM outbox WHERE tenant = ? AND kind = 'executor-job'")
    .all(TEN)) as { payload_json: string }[];
  eq(queued.length, 1, 'the job is durable, so a crash cannot lose it:');
  eq(JSON.parse(queued[0]!.payload_json).requestId, 'req-cloud');
  const claimed = (await db.prepare('SELECT state FROM requests WHERE id = ?').get('req-cloud')) as { state: string };
  eq(claimed.state, 'ADMITTED', 'and the local worker never claims work it handed over:');

  // Tick 2: the relay delivers it to the configured sender.
  const relayWorker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    executorLane: 'cloud',
    dispatchRequests: false,
    sqsSender: async (job) => {
      sent.push({ requestId: job.requestId });
    },
  });
  const second = await relayWorker.tick(NOW);
  eq(second.outboxProcessed, 1, 'the relay delivered the queued job:');
  eq(sent.length, 1);
  eq(sent[0]!.requestId, 'req-cloud');
  await db.close();
});

T('the local lane still runs MODEL-tier work itself', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:local-lane',
    kind: 'OBSERVATION',
    statement: 'work for the local lane',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  await coord.submit(base({ id: 'req-local', goal: 'draft it here', claimRefs: [clm.id] }));
  const worker = new ApplicationWorker(db, ledger, coord, { tenant: TEN, relayOutbox: false });
  const result = await worker.tick(NOW);
  eq(result.requestsQueuedForCloud, 0, 'the default lane queues nothing:');
  const jobs = (await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'executor-job'").get()) as { n: number };
  eq(Number(jobs.n), 0);
  await db.close();
});
