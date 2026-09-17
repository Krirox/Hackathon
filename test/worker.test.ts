import { T, eq, TEN, NOW, fresh, base, sor, rejects } from './helpers.ts';
import { ApplicationWorker, runApplicationWorker } from '../src/substrate/worker.ts';
import { enqueueOutbox } from '../src/substrate/scheduler.ts';
import { enqueueExecutorJob } from '../src/aws/executor.ts';

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
