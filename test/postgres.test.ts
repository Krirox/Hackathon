import { openPostgres, toPostgresPlaceholders } from '../src/core/pg.ts';
import { migrate, nextSeq } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { T, eq, NOW, sor } from './helpers.ts';

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
    eq(version.value, '4');
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
