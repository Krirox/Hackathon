import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDb, type AsyncDb } from '../src/core/db.ts';
import { createLedger, type Ledger } from '../src/ledger/ledger.ts';
import {
  claimInbox,
  cursorGet,
  ensureInboxTable,
  fileDiffCollector,
  ingestInboxBatch,
  readArtifact,
  type Collector,
} from '../src/ingest/collectors.ts';
import { runIngestionWorker, type IngestionWorkerOptions, type IngestionWorkerResult } from '../src/ingest/worker.ts';
import { T, eq, fresh, NOW, TEN, rejects } from './helpers.ts';

function directories() {
  const root = mkdtempSync(join(tmpdir(), 'vital-ingest-worker-'));
  const source = join(root, 'source');
  mkdirSync(source);
  return { root, source, artifactDir: join(root, 'artifacts') };
}

async function withWorker(
  fn: (world: {
    db: AsyncDb;
    ledger: Ledger;
    collector: Collector;
    source: string;
    options: IngestionWorkerOptions;
  }) => Promise<void>,
) {
  const dirs = directories();
  const { db, ledger } = await fresh();
  try {
    await fn({
      db,
      ledger,
      collector: fileDiffCollector('worker-files', dirs.source),
      source: dirs.source,
      options: { tenant: TEN, scope: 'engineering', artifactDir: dirs.artifactDir },
    });
  } finally {
    await db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

async function receipts(db: AsyncDb, tenant = TEN) {
  return db
    .prepare(
      'SELECT source_event_id, status, attempts, owner FROM ingest_inbox WHERE tenant = ? ORDER BY source_event_id',
    )
    .all(tenant);
}

T('F04a: nonempty default file poll writes verified artifact, OBSERVATION and DONE; rerun is idempotent', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'notes.md'), 'A real, nonempty observation.\n');
    let polls = 0;
    const watched: Collector = {
      ...collector,
      poll: (...args) => {
        polls += 1;
        return collector.poll(...args);
      },
    };
    const first = await runIngestionWorker(db, ledger, watched, options);
    eq([first.processed, first.failed, first.polled, first.stopped, first.errors], [1, 0, true, false, []]);
    eq(first.claimIds.length, 1);
    eq(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.owner), true);
    const claim = (await ledger.get(TEN, first.claimIds[0]!))!;
    eq(claim.kind, 'OBSERVATION');
    eq(claim.provenance.sourceTier, 'SINGLE_SOURCE');
    eq(claim.owner, first.owner);
    eq(claim.scope, options.scope);
    eq(claim.statement, 'notes.md appeared');
    eq(readArtifact(options.artifactDir, claim.provenance.rawArtifactRef!).payload, {
      bytes: 30,
      content: 'A real, nonempty observation.\n',
    });
    eq(await receipts(db), [{ source_event_id: 'notes.md', status: 'DONE', attempts: 1, owner: first.owner }]);
    eq(JSON.parse(JSON.stringify(first)), first, 'result is JSON-friendly');

    const second = await runIngestionWorker(db, ledger, watched, options);
    eq([second.processed, second.failed, second.claimIds, second.polled, second.errors], [0, 0, [], true, []]);
    eq(second.owner !== first.owner, true);
    eq(polls, 2, 'one poll per run');
    eq((await receipts(db)).length, 1);
    eq(readdirSync(options.artifactDir).length, 1);
    eq((await ledger.get(TEN, first.claimIds[0]!))!.id, claim.id, 'caller database remains usable');
  });
});

T('F04a: persisted staged receipts recover after reopen BEFORE even a failing poll', async () => {
  const dirs = directories();
  const dbPath = join(dirs.root, 'worker.sqlite');
  let db = openDb(dbPath);
  let closed = false;
  try {
    await migrate(db);
    const collector = fileDiffCollector('persisted-files', dirs.source);
    writeFileSync(join(dirs.source, 'recovery.md'), 'persist this before the consumer starts');
    eq((await collector.poll(db, NOW, TEN)).length, 1);
    eq((await receipts(db))[0]!.status, 'PENDING');
    await db.close();
    closed = true;
    db = openDb(dbPath);
    closed = false;
    const ledger = createLedger(db);
    let statusAtPoll: unknown;
    let polls = 0;
    const result = await runIngestionWorker(
      db,
      ledger,
      {
        ...collector,
        async poll() {
          polls += 1;
          statusAtPoll = (await receipts(db))[0]!.status;
          throw new Error('sensitive-poll-payload token=do-not-return');
        },
      },
      { tenant: TEN, scope: 'engineering', artifactDir: dirs.artifactDir },
    );
    eq(statusAtPoll, 'DONE');
    eq(polls, 1);
    eq([result.processed, result.failed, result.polled, result.stopped], [1, 0, true, false]);
    eq(result.errors, ['[ingest-worker:POLL_FAILED]']);
    eq((await ledger.get(TEN, result.claimIds[0]!))!.kind, 'OBSERVATION');
    eq((await receipts(db))[0]!.status, 'DONE');
  } finally {
    if (!closed) await db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

T('F04a: cap exhausted by existing inbox prevents polling and leaves recoverable work', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    for (const file of ['a.md', 'b.md', 'c.md']) writeFileSync(join(source, file), file);
    await collector.poll(db, NOW, TEN);
    let polls = 0;
    const watched: Collector = {
      ...collector,
      poll: (...args) => {
        polls += 1;
        return collector.poll(...args);
      },
    };
    const first = await runIngestionWorker(db, ledger, watched, { ...options, maxReceipts: 2 });
    eq([first.processed, first.failed, first.polled, first.stopped, polls], [2, 0, false, false, 0]);
    eq((await receipts(db)).filter((r) => r.status === 'PENDING').length, 1);
    const second = await runIngestionWorker(db, ledger, watched, options);
    eq([second.processed, second.failed, second.polled, polls], [1, 0, true, 1]);
    eq(
      (await receipts(db)).every((r) => r.status === 'DONE' && r.attempts === 1),
      true,
    );
  });
});

T('F04a: a single total cap spans pre-poll and post-poll drains', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'a.md'), 'before');
    await collector.poll(db, NOW, TEN);
    writeFileSync(join(source, 'b.md'), 'after b');
    writeFileSync(join(source, 'c.md'), 'after c');
    const result = await runIngestionWorker(db, ledger, collector, { ...options, maxReceipts: 2 });
    eq([result.processed, result.failed, result.polled], [2, 0, true]);
    eq((await receipts(db)).filter((r) => r.status === 'DONE').length, 2);
    eq((await receipts(db)).filter((r) => r.status === 'PENDING').length, 1);
  });
});

T('F04a: default cap is 50 and the maximum accepted cap is 500', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    for (let i = 0; i < 51; i += 1) writeFileSync(join(source, `${i}.md`), `content ${i}`);
    const first = await runIngestionWorker(db, ledger, collector, options);
    eq([first.processed, first.failed, first.polled], [50, 0, true]);
    eq((await receipts(db)).filter((r) => r.status === 'PENDING').length, 1);
    const second = await runIngestionWorker(db, ledger, collector, { ...options, maxReceipts: 500 });
    eq([second.processed, second.failed, second.polled], [1, 0, true]);
  });
});

T('F04a: poison is attempted only three times and does not starve a valid receipt', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'a-poison.md'), 'private payload');
    await collector.poll(db, NOW, TEN);
    writeFileSync(join(source, 'b-valid.md'), 'valid payload');
    await collector.poll(db, new Date(Date.parse(NOW) + 1).toISOString(), TEN);
    const failingLedger: Ledger = {
      ...ledger,
      async append(input) {
        if (input.statement === 'a-poison.md appeared') throw new Error('private payload token=do-not-return');
        return ledger.append(input);
      },
    };
    const result = await runIngestionWorker(db, failingLedger, collector, options);
    eq([result.processed, result.failed, result.polled], [1, 3, true]);
    eq(result.errors, [
      '[ingest-worker:RECEIPT_FAILED] attempt=1',
      '[ingest-worker:RECEIPT_FAILED] attempt=2',
      '[ingest-worker:RECEIPT_FAILED] attempt=3',
    ]);
    eq(
      (await receipts(db)).map((r) => [r.source_event_id, r.status, r.attempts]),
      [
        ['a-poison.md', 'FAILED', 3],
        ['b-valid.md', 'DONE', 1],
      ],
    );
    eq((await ledger.get(TEN, result.claimIds[0]!))!.statement, 'b-valid.md appeared');
    const second = await runIngestionWorker(db, failingLedger, collector, options);
    eq([second.processed, second.failed, second.claimIds], [0, 0, []], 'exhausted poison is not retried');
  });
});

T('F04a: failed attempts consume the cap and suppress new polling', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'poison.md'), 'private');
    await collector.poll(db, NOW, TEN);
    const result = await runIngestionWorker(
      db,
      {
        ...ledger,
        append: async () => {
          throw new Error('private');
        },
      },
      collector,
      { ...options, maxReceipts: 2 },
    );
    eq([result.processed, result.failed, result.polled, result.stopped], [0, 2, false, false]);
    eq((await receipts(db))[0]!.attempts, 2);
    eq(result.errors.length, 2);
  });
});

T('F04a: pre-aborted signal leaves existing work untouched and never polls', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'pending.md'), 'pending');
    await collector.poll(db, NOW, TEN);
    const result = await runIngestionWorker(db, ledger, collector, { ...options, signal: AbortSignal.abort() });
    eq([result.processed, result.failed, result.polled, result.stopped, result.errors], [0, 0, false, true, []]);
    eq((await receipts(db))[0]!.status, 'PENDING');
    eq((await receipts(db))[0]!.attempts, 0);
  });
});

T('F04a: abort during a receipt completes it but starts no next receipt or poll', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'a.md'), 'first');
    writeFileSync(join(source, 'b.md'), 'second');
    await collector.poll(db, NOW, TEN);
    const controller = new AbortController();
    const result = await runIngestionWorker(
      db,
      {
        ...ledger,
        async append(input) {
          const claim = await ledger.append(input);
          controller.abort();
          return claim;
        },
      },
      collector,
      { ...options, signal: controller.signal },
    );
    eq([result.processed, result.failed, result.polled, result.stopped], [1, 0, false, true]);
    eq((await receipts(db)).filter((r) => r.status === 'DONE').length, 1);
    eq((await receipts(db)).filter((r) => r.status === 'PENDING' && r.attempts === 0).length, 1);
  });
});

T('F04a: abort during poll preserves staged work without starting ingestion', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'pending.md'), 'pending');
    const controller = new AbortController();
    const result = await runIngestionWorker(
      db,
      ledger,
      {
        ...collector,
        async poll(...args) {
          const events = await collector.poll(...args);
          controller.abort();
          return events;
        },
      },
      { ...options, signal: controller.signal },
    );
    eq([result.processed, result.failed, result.polled, result.stopped], [0, 0, true, true]);
    eq((await receipts(db))[0]!.status, 'PENDING');
    eq((await runIngestionWorker(db, ledger, collector, options)).processed, 1);
  });
});

T('F04a: tenants have isolated inbox claims, cursors and deduplication', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'shared.md'), 'shared content');
    await collector.poll(db, NOW, 'other');
    const acme = await runIngestionWorker(db, ledger, collector, options);
    eq(acme.processed, 1);
    eq((await receipts(db, 'other'))[0]!.status, 'PENDING');
    eq((await receipts(db, 'other'))[0]!.attempts, 0);
    const other = await runIngestionWorker(db, ledger, collector, { ...options, tenant: 'other' });
    eq(other.processed, 1);
    eq(acme.claimIds[0] !== other.claimIds[0], true);
    eq((await ledger.get(TEN, acme.claimIds[0]!))!.tenant, TEN);
    eq((await ledger.get('other', other.claimIds[0]!))!.tenant, 'other');
    eq(!!(await ledger.get('other', acme.claimIds[0]!)), false);
    eq(!!(await ledger.get(TEN, other.claimIds[0]!)), false);
    eq((await receipts(db))[0]!.owner, acme.owner);
    eq((await receipts(db, 'other'))[0]!.owner, other.owner);
  });
});

T('F04a: invalid options reject before database, collector or artifact effects', async () => {
  await withWorker(async ({ db, ledger, collector, options }) => {
    let effects = 0;
    const unexpected = (): never => {
      effects += 1;
      throw new Error('unexpected effect');
    };
    const untouched: AsyncDb = {
      ...db,
      prepare: unexpected,
      exec: unexpected,
      transaction: unexpected,
      close: unexpected,
    };
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      ...[0, -1, 501, 1.5, NaN, Infinity, '2', null].map((maxReceipts) => ({ ...options, maxReceipts })),
      ...['tenant', 'scope', 'artifactDir'].flatMap((key) =>
        ['', '   ', null, 42, 'bad\0value'].map((value) => ({ ...options, [key]: value })),
      ),
      { ...options, signal: { aborted: false } },
    ];
    for (const input of invalid) {
      await rejects(
        () =>
          runIngestionWorker(untouched, ledger, { ...collector, poll: unexpected }, input as IngestionWorkerOptions),
        'INVALID_OPTIONS',
      );
    }
    eq(effects, 0);
  });
});

for (const boundary of [
  { name: 'file bytes', limits: { maxEntries: 2, maxFileBytes: 5, maxTotalBytes: 20 }, code: 'BYTE_LIMIT' },
  { name: 'total bytes', limits: { maxEntries: 2, maxFileBytes: 6, maxTotalBytes: 6 }, code: 'BYTE_LIMIT' },
  { name: 'entries', limits: { maxEntries: 1, maxFileBytes: 6, maxTotalBytes: 20 }, code: 'ENTRY_LIMIT' },
]) {
  T(`F04a: bounded file poll refuses excess ${boundary.name} without staging or moving cursor`, async () => {
    await withWorker(async ({ db, source }) => {
      const collector = fileDiffCollector('bounded-files', source, 'SINGLE_SOURCE', boundary.limits);
      await ensureInboxTable(db);
      writeFileSync(join(source, 'a.md'), 'a');
      // Three UTF-8 characters occupy six bytes: limits apply to bytes, not JS length.
      writeFileSync(join(source, 'b.md'), 'ééé');
      await rejects(() => collector.poll(db, NOW, TEN), boundary.code);
      eq(await receipts(db), [], 'no partial staging on initial refusal');
      eq(await cursorGet(db, TEN, collector.name), null);

      rmSync(join(source, 'b.md'));
      eq((await collector.poll(db, NOW, TEN)).length, 1, 'acceptable input succeeds');
      const beforeRows = await receipts(db);
      const beforeCursor = await cursorGet(db, TEN, collector.name);
      eq(beforeCursor !== null, true);
      writeFileSync(join(source, 'a.md'), 'b');
      writeFileSync(join(source, 'b.md'), 'ééé');
      await rejects(() => collector.poll(db, NOW, TEN), boundary.code);
      eq(await receipts(db), beforeRows, 'no new receipt or revision on refusal');
      eq(await cursorGet(db, TEN, collector.name), beforeCursor, 'existing checkpoint survives');
      rmSync(join(source, 'b.md'));
      eq((await collector.poll(db, NOW, TEN)).length, 1, 'refused revision remains discoverable');
      eq((await receipts(db)).length, 2);
    });
  });
}

T('F04a: bounded file poll accepts exact entry, file-byte and total-byte limits', async () => {
  await withWorker(async ({ db, source }) => {
    writeFileSync(join(source, 'a.md'), 'éé');
    writeFileSync(join(source, 'b.md'), 'four');
    const collector = fileDiffCollector('exact-bounds', source, 'SINGLE_SOURCE', {
      maxEntries: 2,
      maxFileBytes: 4,
      maxTotalBytes: 8,
    });
    eq((await collector.poll(db, NOW, TEN)).length, 2);
    eq(
      (await receipts(db)).map((r) => r.status),
      ['PENDING', 'PENDING'],
    );
    eq((await cursorGet(db, TEN, collector.name)) !== null, true);
    eq((await collector.poll(db, NOW, TEN)).length, 0);
  });
});

T('F04a: expired crashed CLAIMED at maxAttempts becomes FAILED and is never reclaimed', async () => {
  await withWorker(async ({ db, collector, source }) => {
    writeFileSync(join(source, 'crashed.md'), 'crashed');
    await collector.poll(db, NOW, TEN);
    const opts = { owner: 'crashed', now: NOW, leaseMs: 60_000, maxAttempts: 3 };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimInbox(db, TEN, collector.name, 1, {
        ...opts,
        now: new Date(Date.parse(NOW) + (attempt - 1) * 60_000).toISOString(),
      });
      eq(claimed.length, 1);
      eq(claimed[0]!.attempts, attempt);
    }
    eq((await receipts(db))[0]!.status, 'CLAIMED');
    eq(
      await claimInbox(db, TEN, collector.name, 1, {
        ...opts,
        owner: 'replacement',
        now: new Date(Date.parse(NOW) + 180_000).toISOString(),
      }),
      [],
    );
    eq(await receipts(db), [{ source_event_id: 'crashed.md', status: 'FAILED', attempts: 3, owner: 'crashed' }]);
    eq(
      await claimInbox(db, TEN, collector.name, 1, {
        ...opts,
        owner: 'later',
        now: new Date(Date.parse(NOW) + 240_000).toISOString(),
      }),
      [],
    );
    eq((await receipts(db))[0]!.attempts, 3);
  });
});

T('F04a: unexpired lease is protected and expired below-cap receipt recovers to DONE', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'recover.md'), 'recover');
    await collector.poll(db, NOW, TEN);
    const opts = {
      batch: 1,
      owner: 'replacement',
      now: NOW,
      leaseMs: 60_000,
      maxAttempts: 3,
      artifactDir: options.artifactDir,
    };
    const original = await claimInbox(db, TEN, collector.name, 1, { ...opts, owner: 'crashed' });
    eq(original[0]!.attempts, 1);
    eq((await ingestInboxBatch(db, ledger, TEN, collector, opts)).receipts, []);
    const recovered = await ingestInboxBatch(db, ledger, TEN, collector, {
      ...opts,
      now: new Date(Date.parse(NOW) + 60_000).toISOString(),
    });
    eq(recovered.receipts[0]!.id, original[0]!.id);
    eq(recovered.claimIds.length, 1);
    eq(await receipts(db), [{ source_event_id: 'recover.md', status: 'DONE', attempts: 2, owner: 'replacement' }]);
    eq((await ledger.get(TEN, recovered.claimIds[0]!))!.kind, 'OBSERVATION');
  });
});

T('F04a: settlement error rolls back append and DONE atomically; retry creates exactly one claim', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'atomic.md'), 'atomic');
    await collector.poll(db, NOW, TEN);
    let injected = 0;
    const wrapped: AsyncDb = {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!/^UPDATE ingest_inbox SET status\s*=\s*\? WHERE/i.test(sql.trim().replace(/\s+/g, ' '))) return statement;
        return {
          ...statement,
          async run(...params) {
            const result = await statement.run(...params);
            if (params[0] === 'DONE' && injected === 0) {
              injected += 1;
              eq(
                (await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN)).length,
                1,
                'append reached settlement',
              );
              eq((await receipts(db))[0]!.status, 'DONE', 'DONE written inside transaction');
              throw new Error('injected settlement failure');
            }
            return result;
          },
        };
      },
    };
    const opts = { batch: 1, owner: 'atomic-worker', now: NOW, maxAttempts: 3, artifactDir: options.artifactDir };
    await rejects(() => ingestInboxBatch(wrapped, ledger, TEN, collector, opts), 'injected settlement failure');
    eq(injected, 1, 'settlement SQL interception ran');
    eq(await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN), [], 'append rolled back');
    eq(await db.prepare("SELECT key FROM meta WHERE key LIKE 'ingest:seen:%'").all(), [], 'dedup markers rolled back');
    eq(await receipts(db), [{ source_event_id: 'atomic.md', status: 'FAILED', attempts: 1, owner: 'atomic-worker' }]);
    const retry = await ingestInboxBatch(wrapped, ledger, TEN, collector, opts);
    eq(retry.claimIds.length, 1);
    eq(await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN), [{ id: retry.claimIds[0] }]);
    eq((await receipts(db))[0]!.status, 'DONE');
    eq((await receipts(db))[0]!.attempts, 2);
    eq((await ingestInboxBatch(wrapped, ledger, TEN, collector, opts)).claimIds, []);
    eq((await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN)).length, 1);
  });
});

T('F04a: stale-owner fence refuses before any ledger append', async () => {
  await withWorker(async ({ db, ledger, collector, source, options }) => {
    writeFileSync(join(source, 'fenced.md'), 'fenced');
    await collector.poll(db, NOW, TEN);
    let fences = 0;
    let appends = 0;
    const wrapped: AsyncDb = {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!/^UPDATE ingest_inbox SET owner\s*=\s*owner\b/i.test(sql.trim().replace(/\s+/g, ' '))) return statement;
        return {
          ...statement,
          async run(...params) {
            fences += 1;
            // Model replacement immediately before the persistence fence. This
            // injected write shares SQLite's transaction and may itself roll back.
            const replaced = await db
              .prepare('UPDATE ingest_inbox SET owner = ? WHERE id = ?')
              .run('replacement-owner', params[0]);
            eq(replaced.changes, 1);
            return statement.run(...params);
          },
        };
      },
    };
    await rejects(
      () =>
        ingestInboxBatch(
          wrapped,
          {
            ...ledger,
            async append(input) {
              appends += 1;
              return ledger.append(input);
            },
          },
          TEN,
          collector,
          { batch: 1, owner: 'stale-owner', now: NOW, artifactDir: options.artifactDir },
        ),
      'NOT_OWNER',
    );
    eq(fences, 1, 'fence SQL interception ran');
    eq(appends, 0);
    eq(await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN), []);
    eq(existsSync(options.artifactDir), false, 'fence precedes artifact persistence too');
  });
});

function runFilesCli(dirs: ReturnType<typeof directories>, overrides: Record<string, string> = {}) {
  const flags = {
    '--tenant': TEN,
    '--scope': 'engineering',
    '--source': dirs.source,
    '--artifacts': dirs.artifactDir,
    '--db': join(dirs.root, 'cli.sqlite'),
    ...overrides,
  };
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'ingest-files', ...Object.entries(flags).flat()],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: '', ARTIFACT_DIR: '', NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    },
  );
  if (child.error) throw child.error;
  eq(child.signal, null, 'CLI exits without being killed');
  return child;
}

T('F04a: finite tsx ingest-files CLI persists artifacts and claims and reruns without duplicates', async () => {
  const dirs = directories();
  try {
    writeFileSync(join(dirs.source, 'cli.md'), 'CLI evidence');
    const first = runFilesCli(dirs);
    eq(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout) as IngestionWorkerResult;
    eq([result.processed, result.failed, result.polled, result.stopped, result.errors], [1, 0, true, false, []]);
    eq(result.claimIds.length, 1);
    const second = runFilesCli(dirs);
    eq(second.status, 0, second.stderr);
    const rerun = JSON.parse(second.stdout) as IngestionWorkerResult;
    eq([rerun.processed, rerun.failed, rerun.claimIds, rerun.polled, rerun.errors], [0, 0, [], true, []]);
    eq(rerun.owner !== result.owner, true);
    const db = openDb(join(dirs.root, 'cli.sqlite'));
    try {
      eq(await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN), [{ id: result.claimIds[0] }]);
      eq(await receipts(db), [{ source_event_id: 'cli.md', status: 'DONE', attempts: 1, owner: result.owner }]);
      const claim = (await createLedger(db).get(TEN, result.claimIds[0]!))!;
      eq(claim.kind, 'OBSERVATION');
      eq(readArtifact(dirs.artifactDir, claim.provenance.rawArtifactRef!).payload, {
        bytes: 12,
        content: 'CLI evidence',
      });
      eq(readdirSync(dirs.artifactDir).length, 1);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

T('F04a: CLI invalid configuration exits nonzero before opening a database', async () => {
  const dirs = directories();
  try {
    for (const [overrides, message] of [
      [{ '--max-receipts': '501' }, '--max-receipts must be'],
      [{ '--tenant': '' }, 'usage: vital ingest-files'],
      [{ '--artifacts': join(dirs.source, 'nested-artifacts') }, 'must be outside the source directory'],
    ] as const) {
      const result = runFilesCli(dirs, overrides);
      eq(result.status, 1);
      eq(result.stderr.includes(message), true, result.stderr);
      eq(result.stdout.trim(), '');
      eq(existsSync(join(dirs.root, 'cli.sqlite')), false);
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

T('F04a: CLI overlimit poll exits nonzero with sanitized result and no staged work or cursor', async () => {
  const dirs = directories();
  try {
    writeFileSync(join(dirs.source, 'a-valid.md'), 'valid');
    writeFileSync(join(dirs.source, 'private-oversize.md'), Buffer.alloc(1_000_001, 'x'));
    const child = runFilesCli(dirs);
    eq(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout) as IngestionWorkerResult;
    eq([result.processed, result.failed, result.claimIds, result.polled, result.stopped], [0, 0, [], true, false]);
    eq(result.errors, ['[ingest-worker:POLL_FAILED]']);
    eq(child.stdout.includes('private-oversize'), false);
    const db = openDb(join(dirs.root, 'cli.sqlite'));
    try {
      eq(await receipts(db), []);
      eq(await db.prepare('SELECT id FROM claims WHERE tenant = ?').all(TEN), []);
      eq(await db.prepare("SELECT key FROM meta WHERE key LIKE 'ingest:cursor:%'").all(), []);
      eq(readdirSync(dirs.artifactDir), []);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
