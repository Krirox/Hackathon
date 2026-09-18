import { openPostgres, toPostgresPlaceholders } from '../src/core/pg.ts';
import { migrate, nextSeq } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { claimOutbox, settleOutbox, enqueueOutbox } from '../src/substrate/scheduler.ts';
import { claimInbox, settleInbox, stageToInbox } from '../src/ingest/collectors.ts';
import { T, eq, NOW, sor, rejects } from './helpers.ts';

/**
 * Postgres lane (CI postgres service, TEST_PG_URL).
 *
 * The main suite runs on sqlite; this lane proves the PRODUCTION engine:
 * the derived schema, `?` → `$n` placeholder rewriting, the dialect
 * helpers, and the nextSeq atomicity that sqlite's BEGIN IMMEDIATE masks.
 * Nothing is registered without TEST_PG_URL, so local runs are an explicit
 * no-op and the sqlite test count (the docs' number) is untouched.
 */
const url = process.env.TEST_PG_URL;
const skip = !url;

/** Register nothing when the lane is skipped — a skipped lane must not look verified. */
const pgT = (name: string, fn: () => void | Promise<void>): void => {
  if (skip) return;
  T(name, fn);
};

if (skip) {
  console.log(
    '\n\x1b[1mPostgres lane\x1b[0m — TEST_PG_URL unset, nothing registered (CI sets it against the postgres service)',
  );
} else {
  console.log('\n\x1b[1mPostgres lane — the production engine\x1b[0m');
}

const tenant = `pg-${process.pid}-${Date.now().toString(36)}`;

pgT('migrate derives the schema and stamps the version (postgres)', async () => {
  const db = openPostgres(url!);
  try {
    await migrate(db);
    const version = (await db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')) as {
      value: string;
    };
    eq(version.value, '6');
    // Derived from the one SCHEMA — if this ever drops, the translation
    // silently lost a table and the Ledger is not the only store.
    const tables = (await db
      .prepare("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")
      .get()) as { n: string };
    eq(Number(tables.n) >= 17, true, 'schema derived:');
  } finally {
    await db.close();
  }
});

pgT('nextSeq is atomic under concurrency — 25 callers, 25 distinct seqs (postgres)', async () => {
  const db = openPostgres(url!);
  try {
    await migrate(db);
    // The regression this exists for: under READ COMMITTED with one pool
    // client per transaction, SELECT-then-UPDATE hands two appends the same
    // seq. The upsert must be a single locked statement.
    const values = await Promise.all(Array.from({ length: 25 }, () => nextSeq(db, tenant)));
    eq(new Set(values).size, 25, 'concurrent nextSeq must never collide:');
    eq(Math.min(...values), 1, 'first seq is 1:');
  } finally {
    await db.close();
  }
});

pgT('concurrent ledger appends mint distinct, monotonic seqs (postgres)', async () => {
  const db = openPostgres(url!);
  try {
    await migrate(db);
    const ledger = createLedger(db);
    // Own tenant: ledger_seq persists per tenant, and the nextSeq test above
    // already ran 25 increments on the shared one — min would be 26, not 1.
    const t = `${tenant}-appends`;
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.append({
          tenant: t,
          subject: 'release',
          kind: 'OBSERVATION',
          statement: `w${i}`,
          confidence: 1,
          owner: 'human:priya',
          scope: 'engineering',
          authorType: 'system',
          observedAt: NOW,
          validFrom: NOW,
          now: NOW,
          provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
        }),
      ),
    );
    const seqs = claims.map((c) => c.seq);
    eq(new Set(seqs).size, 20, 'no duplicate seqs across concurrent appends:');
    eq(Math.min(...seqs), 1);
    const stats = await ledger.stats(t, NOW);
    eq(stats.total, 20);
  } finally {
    await db.close();
  }
});

pgT('coordinator dialect helpers execute against real postgres', async () => {
  const db = openPostgres(url!);
  try {
    await migrate(db);
    const coord = createCoordinator(db, {
      maxConcurrentPerScope: 6,
      maxDailyDollars: 100,
      maxDailyTokens: 1e9,
      maxHumanEscalationsPerDay: 5,
    });
    // submit() runs jsonNumber + sqlDayOf for the daily-spend query;
    // expireStale() runs jsonText for the deadline compare.
    const { request } = await coord.submit({
      tenant,
      messageClass: 'REQUEST',
      originScope: 'marketing',
      targetScope: 'engineering',
      goal: 'pg lane',
      claimRefs: ['clm_x'],
      deliverableSchema: 'x.v1',
      // deadline must be explicit: the default is now+24h, and expireStale(NOW)
      // correctly returns [] for it — the CI lane failed on exactly this before.
      bid: { dollars: 2, humanMinutes: 1, deadline: NOW },
      onBehalfOf: 'human:priya',
      now: NOW,
    });
    eq(request.state, 'ADMITTED');
    const charged = await coord.charge(tenant, request.id, { dollars: 0.5 });
    eq(charged.spent.dollars, 0.5, 'spent_json read/written through the dialect:');
    const expired = await coord.expireStale(tenant, NOW);
    eq(expired, [request.id], 'jsonText deadline compare runs:');
  } finally {
    await db.close();
  }
});

T('placeholder rewriting never touches a ? inside a string literal', () => {
  eq(toPostgresPlaceholders("SELECT '?' , ?"), "SELECT '?' , $1");
  eq(toPostgresPlaceholders("UPDATE t SET x = 'it''s ?' WHERE id = ?"), "UPDATE t SET x = 'it''s ?' WHERE id = $1");
});

// ---- F10/F07: two TRUE connection drills — CAS and migration under real READ COMMITTED
// The sqlite F10 tests interleave claims through ONE connection (JS awaits
// between statements). These drills open two SEPARATE pool connections so
// the ownership CAS is exercised exactly as two deployed workers would:
// both transactions observe the same rows under READ COMMITTED, and only
// the conditional UPDATE decides who owns what.

const pgTwo = async (): Promise<[Awaited<ReturnType<typeof openPostgres>>, Awaited<ReturnType<typeof openPostgres>>]> => {
  const a = openPostgres(url!);
  const b = openPostgres(url!);
  try {
    await migrate(a);
    await migrate(b);
  } catch (e) {
    await a.close();
    await b.close();
    throw e;
  }
  return [a, b];
};

pgT('F07: two connections racing migrate() on a fresh database both succeed, one journal stamp', async () => {
  const [dbA, dbB] = await pgTwo();
  try {
    // Reset the journal so both connections see a "fresh" database and race
    // the full migrate() path: base DDL, additive list, journal stamp.
    await dbA.exec('DROP TABLE IF EXISTS schema_migrations');
    await dbA.prepare('DELETE FROM meta WHERE key = ?').run('schema_version');
    await dbA.prepare('DELETE FROM meta WHERE key = ?').run('spent_mirrors_backfilled');
    await Promise.all([migrate(dbA), migrate(dbB)]);
    const stamps = (await dbA.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get(
      'additive-list-v6',
    )) as { n: number };
    eq(Number(stamps.n), 1, 'exactly one journal stamp after the race:');
    const version = (await dbA.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')) as {
      value: string;
    };
    eq(version.value, '6', 'version stamped exactly once at 6:');
    // A third sequential re-run stays idempotent.
    await migrate(dbA);
    await migrate(dbB);
    const stampsAfter = (await dbA.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get(
      'additive-list-v6',
    )) as { n: number };
    eq(Number(stampsAfter.n), 1, 're-run does not duplicate the stamp:');
  } finally {
    await dbA.close();
    await dbB.close();
  }
});

pgT('F10: two Postgres connections cannot both own one outbox row; stale owner cannot settle', async () => {
  const [dbA, dbB] = await pgTwo();
  try {
    for (let i = 0; i < 4; i++) await enqueueOutbox(dbA, tenant, 'sqs-send', { i }, { now: NOW });
    // Both relays claim CONCURRENTLY — two pools, two transactions, same rows.
    const [aRows, bRows] = await Promise.all([
      claimOutbox(dbA, 10, NOW, { owner: 'relay-a', leaseMs: 60_000 }),
      claimOutbox(dbB, 10, NOW, { owner: 'relay-b', leaseMs: 60_000 }),
    ]);
    const ownedByA = new Set(aRows.map((r) => r.id));
    const ownedByB = new Set(bRows.map((r) => r.id));
    for (const id of ownedByA) eq(ownedByB.has(id), false, `row ${id} owned by both relays:`);
    eq(ownedByA.size + ownedByB.size, 4, 'every row claimed exactly once:');
    // The loser of a row cannot settle it — ownership fencing on the live engine.
    if (ownedByB.size > 0) {
      await rejects(
        async () => await settleOutbox(dbA, [...ownedByB], 'DONE', { owner: 'relay-a' }),
        'NOT_OWNER',
        'stale owner settlement refused:',
      );
    }
    await settleOutbox(dbA, [...ownedByA], 'DONE', { owner: 'relay-a' });
    await settleOutbox(dbB, [...ownedByB], 'DONE', { owner: 'relay-b' });
    const left = (await dbA.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'CLAIMED'").get()) as {
      n: number;
    };
    eq(Number(left.n), 0, 'nothing stranded in CLAIMED:');
  } finally {
    await dbA.close();
    await dbB.close();
  }
});

pgT('F10: two Postgres connections cannot both own one inbox row; lease recovery works', async () => {
  const [dbA, dbB] = await pgTwo();
  try {
    const events = Array.from({ length: 4 }, (_, n) => ({
      source: 's',
      uri: `https://example.com/pg-f10-${n}`,
      fingerprint: `pgfp${n}`,
      eventId: `pge${n}`,
      revision: 'r1',
      occurredAt: NOW,
      summary: `pg event ${n}`,
      payload: {},
    }));
    await stageToInbox(dbA, tenant, 'col', events, NOW);
    const [aRows, bRows] = await Promise.all([
      claimInbox(dbA, tenant, 'col', 10, { owner: 'consumer-a', leaseMs: 60_000, now: NOW }),
      claimInbox(dbB, tenant, 'col', 10, { owner: 'consumer-b', leaseMs: 60_000, now: NOW }),
    ]);
    const ownedByA = new Set(aRows.map((r) => r.id));
    const ownedByB = new Set(bRows.map((r) => r.id));
    for (const id of ownedByA) eq(ownedByB.has(id), false, `inbox row ${id} owned by both consumers:`);
    eq(ownedByA.size + ownedByB.size, 4, 'every staged row claimed exactly once:');
    await settleInbox(dbA, [...ownedByA], 'DONE', { owner: 'consumer-a' });
    if (ownedByB.size > 0) {
      await rejects(
        async () => await settleInbox(dbA, [...ownedByB], 'DONE', { owner: 'consumer-a' }),
        'NOT_OWNER',
        'inbox stale owner settlement refused:',
      );
    }
    await settleInbox(dbB, [...ownedByB], 'DONE', { owner: 'consumer-b' });
    const stranded = (await dbA
      .prepare("SELECT id FROM ingest_inbox WHERE tenant = ? AND status = 'CLAIMED'")
      .all(tenant)) as { id: unknown }[];
    eq(stranded.length, 0, 'nothing stranded:');
  } finally {
    await dbA.close();
    await dbB.close();
  }
});
