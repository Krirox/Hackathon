import { T, eq, TEN, NOW, fresh, rejects } from './helpers.ts';
import { applyMigrations, appliedMigrations, rollbackMigration, type Migration } from '../src/core/migrations.ts';
import { columnExists, dayOf, groupConcat, migrate, nextSeq, openDb, verifyIntegrity } from '../src/core/db.ts';
import { openFromEnv, PG_SCHEMA, toPostgresPlaceholders } from '../src/core/pg.ts';
import { SCHEMA } from '../src/core/db.ts';

console.log('\n\x1b[1mCore — migrations apply once and roll back tested\x1b[0m');

const scratch: Migration[] = [
  {
    name: '2026-09-09-scratch-flag',
    up: 'CREATE TABLE scratch_flags (id TEXT PRIMARY KEY, onoff INTEGER NOT NULL)',
    down: 'DROP TABLE scratch_flags',
  },
];

T('migrations apply once, list applied, and roll back with tested down SQL', async () => {
  const { db } = await fresh();
  eq((await appliedMigrations(db)).includes('2026-09-09-scratch-flag'), false);
  eq(await applyMigrations(db, scratch, NOW), ['2026-09-09-scratch-flag']);
  eq(await applyMigrations(db, scratch, NOW), [], 'second apply is a no-op:');
  await db.prepare('INSERT INTO scratch_flags (id, onoff) VALUES (?, ?)').run('f1', 1);
  await rollbackMigration(db, scratch, '2026-09-09-scratch-flag');
  eq((await appliedMigrations(db)).includes('2026-09-09-scratch-flag'), false);
  let gone = '';
  try {
    await db.prepare('SELECT * FROM scratch_flags').all();
  } catch (e) {
    gone = (e as Error).message;
  }
  eq(gone.length > 0, true, 'down SQL dropped the table:');
  await rejects(async () => await rollbackMigration(db, scratch, '2026-09-09-scratch-flag'), 'NOT_APPLIED');
  await rejects(async () => await rollbackMigration(db, scratch, 'nope'), 'UNKNOWN_MIGRATION');
  void TEN;
});

T('the PG schema is derived, not maintained — zero drift by construction', async () => {
  eq(PG_SCHEMA.includes('AUTOINCREMENT'), false, 'no sqlite-isms survive:');
  eq(PG_SCHEMA.includes('BIGSERIAL PRIMARY KEY'), true);
  const tables = (s: string) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)!.sort();
  eq(tables(PG_SCHEMA), tables(SCHEMA), 'same tables, translated:');
});

T('placeholders rewrite per position, skipping string literals', async () => {
  eq(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  eq(
    toPostgresPlaceholders("SELECT 'what?' FROM t WHERE a = ?"),
    "SELECT 'what?' FROM t WHERE a = $1",
    'literal ? untouched:',
  );
  eq(
    toPostgresPlaceholders("SELECT 'it''s ?' FROM t WHERE a = ?"),
    "SELECT 'it''s ?' FROM t WHERE a = $1",
    'escaped quotes handled:',
  );
  eq(toPostgresPlaceholders('SELECT 1'), 'SELECT 1');
});

T('day truncation and grouping emit the PG dialect', async () => {
  eq(dayOf('postgres', 'created_at'), '(created_at::timestamptz)::date');
  eq(dayOf('sqlite', 'created_at'), 'date(created_at)');
  eq(groupConcat('postgres', 'scope'), "string_agg(DISTINCT scope, ',')");
});

T('runtime wiring picks postgres by URL without connecting', async () => {
  const pg = openFromEnv({ DATABASE_URL: 'postgres://u:p@host:5432/db' } as NodeJS.ProcessEnv);
  eq(pg.kind, 'postgres');
  void pg.db.close();
  const lite = openFromEnv({} as NodeJS.ProcessEnv);
  eq(lite.kind, 'sqlite');
  lite.db.close();
});

// ---- F07: migrate() is the one authoritative journal -------------------

T('F07: migrate() stamps its additive list as one named journal entry', async () => {
  const { db } = await fresh();
  await migrate(db);
  const names = await appliedMigrations(db);
  eq(names.includes('additive-list-v6'), true, 'additive list is journaled:');
  // Re-migrate is a clean no-op: journal intact, no duplicates possible
  // (name is the primary key).
  await migrate(db);
  const names2 = await appliedMigrations(db);
  eq(names2.filter((n) => n === 'additive-list-v6').length, 1, 're-run does not double-stamp:');
});

T('F07: a legacy database (schema without journal) upgrades in place', async () => {
  // Simulate the pre-consolidation world WITHOUT running migrate(): raw
  // openDb, SCHEMA applied, additive columns added the old way. migrate()
  // must stamp the journal and version WITHOUT re-running the ALTERs (the
  // probe answers "exists" and skips — the old runner would have thrown
  // duplicate-column and swallowed it; a naive one would throw for real).
  const db = openDb(':memory:');
  await db.exec(SCHEMA);
  await db.exec("ALTER TABLE requests ADD COLUMN reserved_json TEXT NOT NULL DEFAULT '{}'");
  const stamped = async () =>
    (await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()) as { value: string } | undefined;
  eq(await stamped(), undefined, 'raw schema carries no version stamp yet:');
  eq(await columnExists(db, 'requests', 'reserved_json'), true, 'legacy db already has the additive column:');
  eq(await columnExists(db, 'requests', 'no_such_column'), false, 'the probe answers no when absent:');
  await migrate(db);
  eq(
    (await appliedMigrations(db)).includes('additive-list-v6'),
    true,
    'legacy db journaled without re-running ALTERs:',
  );
  eq((await stamped())?.value, '6', 'version stamped after upgrade:');
  // The ledger works on the upgraded db: seq allocation exercises a real table.
  eq(await nextSeq(db, 'legacy-tenant'), 1);
  await db.close();
});

T('F07: a failed additive statement rolls back the journal stamp', async () => {
  // Corrupt the additive list contract: drop a table the list's CREATE
  // INDEX depends on, inside a database that has NOT run migrate(). The
  // transaction must roll back the journal row — startup fails loudly
  // instead of reporting current.
  const { db } = await fresh();
  await db.exec(SCHEMA);
  await db.exec('CREATE TABLE meta_tmp AS SELECT key, value FROM meta');
  // Point the journal at a broken DDL by applying a scratch migration whose
  // up fails halfway through its own statements.
  const broken: Migration[] = [
    {
      name: '2026-09-17-broken',
      up: 'CREATE TABLE broken_t (id TEXT PRIMARY KEY); INSERT INTO missing_table SELECT 1;',
      down: 'DROP TABLE broken_t',
    },
  ];
  let threw = '';
  try {
    await applyMigrations(db, broken, NOW);
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw.includes('missing_table'), true, 'failure propagated, not swallowed:');
  eq(
    (await appliedMigrations(db)).includes('2026-09-17-broken'),
    false,
    'journal has no row for the failed migration:',
  );
  const leftover = (
    (await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'broken_t'").get()) as { n: number }
  ).n;
  eq(leftover, 0, 'DDL rolled back with the journal row:');
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

T('sqlite: concurrent top-level transactions never share depth (isolation, not savepoints)', async () => {
  const db = openDb(':memory:');
  try {
    await db.exec('CREATE TABLE f12_iso (id TEXT PRIMARY KEY)');
    let seenByA: string[] = [];
    const txA = db.transaction(async () => {
      await db.prepare('INSERT INTO f12_iso (id) VALUES (?)').run('a');
      await sleep(50);
      // B writes + rolls back while A is still open. If B were misread as a
      // nested SAVEPOINT (the old shared-depth bug), its uncommitted 'b'
      // would be visible here inside A's transaction.
      seenByA = ((await db.prepare('SELECT id FROM f12_iso ORDER BY id').all()) as { id: string }[]).map((r) => r.id);
    });
    const txB = (async () => {
      await sleep(10); // land while A holds the transaction
      await db.transaction(async () => {
        await db.prepare('INSERT INTO f12_iso (id) VALUES (?)').run('b');
        await sleep(20);
        throw new Error('F12_ROLLBACK_B');
      });
    })().catch((e) => {
      eq((e as Error).message.includes('F12_ROLLBACK_B'), true, 'B must roll back, not deadlock:');
    });
    await Promise.all([txA, txB]);
    eq(seenByA, ['a'], 'A must never see B uncommitted writes:');
    const final = ((await db.prepare('SELECT id FROM f12_iso ORDER BY id').all()) as { id: string }[]).map((r) => r.id);
    eq(final, ['a'], 'B rolled back, A committed:');
  } finally {
    await db.close();
  }
});

T('sqlite: concurrent transactions interleave without corrupting each other', async () => {
  const db = openDb(':memory:');
  try {
    await db.exec('CREATE TABLE f12_pair (owner TEXT NOT NULL, n INTEGER NOT NULL)');
    const writer = async (owner: string): Promise<void> => {
      await db.transaction(async () => {
        for (let i = 0; i < 5; i++) {
          await db.prepare('INSERT INTO f12_pair (owner, n) VALUES (?, ?)').run(owner, i);
          await sleep(5);
        }
      });
    };
    await Promise.all([writer('a'), writer('b')]);
    for (const owner of ['a', 'b']) {
      const rows = (await db.prepare('SELECT n FROM f12_pair WHERE owner = ? ORDER BY n').all(owner)) as {
        n: number;
      }[];
      eq(
        rows.map((r) => r.n),
        [0, 1, 2, 3, 4],
        `${owner} committed all five rows:`,
      );
    }
  } finally {
    await db.close();
  }
});

T('sqlite: genuinely-nested transactions still use savepoints', async () => {
  const db = openDb(':memory:');
  try {
    await db.exec('CREATE TABLE f12_nest (id TEXT PRIMARY KEY)');
    await db.transaction(async () => {
      await db.prepare('INSERT INTO f12_nest (id) VALUES (?)').run('outer');
      try {
        await db.transaction(async () => {
          await db.prepare('INSERT INTO f12_nest (id) VALUES (?)').run('inner-bad');
          throw new Error('F12_INNER_ROLLBACK');
        });
      } catch (e) {
        eq((e as Error).message.includes('F12_INNER_ROLLBACK'), true);
      }
      await db.transaction(async () => {
        await db.prepare('INSERT INTO f12_nest (id) VALUES (?)').run('inner-good');
      });
    });
    const rows = ((await db.prepare('SELECT id FROM f12_nest ORDER BY id').all()) as { id: string }[]).map((r) => r.id);
    eq(rows, ['inner-good', 'outer'], 'inner rollback undoes only its savepoint:');
  } finally {
    await db.close();
  }
});

T('sqlite: concurrent ledger appends keep ledger_seq 1..N under real concurrency', async () => {
  const { db, ledger } = await fresh();
  try {
    const N = 20;
    const claims = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ledger.append({
          tenant: TEN,
          subject: 'f12-conc',
          kind: 'OBSERVATION',
          statement: `w${i}`,
          confidence: 1,
          owner: 'human:priya',
          scope: 'engineering',
          authorType: 'system',
          observedAt: NOW,
          validFrom: NOW,
          now: NOW,
          provenance: {
            sourceUri: 'https://linear.net/bug/1',
            sourceTier: 'SINGLE_SOURCE',
            extractor: 't',
            extractorVersion: '1',
            retrievedAt: NOW,
          },
        }),
      ),
    );
    eq(
      claims.map((c) => c.seq).sort((a, b) => a - b),
      Array.from({ length: N }, (_, i) => i + 1),
      'concurrent appends mint a dense 1..N seq range:',
    );
  } finally {
    await db.close();
  }
});

T('schema declares the tenant-safe foreign keys (fresh DBs + Postgres)', async () => {
  eq(SCHEMA.includes('FOREIGN KEY (decision_id) REFERENCES decisions(id)'), true, 'outcomes key declared:');
  eq(SCHEMA.includes('FOREIGN KEY (from_id) REFERENCES claims(id)'), true, 'link from key declared:');
  eq(SCHEMA.includes('FOREIGN KEY (to_id) REFERENCES claims(id)'), true, 'link to key declared:');
});

T('verifyIntegrity passes clean DBs and reports seeded orphans', async () => {
  const { db, ledger } = await fresh();
  try {
    const clean = await verifyIntegrity(db, TEN);
    eq(clean.ok, true, 'fresh DB is clean:');
    eq(clean.orphanOutcomes, [], 'no orphan outcomes:');
    eq(clean.danglingLinks, [], 'no dangling links:');
    // Two real claims so links can be half-valid: one endpoint present.
    const a = await ledger.append({
      tenant: TEN,
      subject: 'f20-a',
      kind: 'OBSERVATION',
      statement: 'a',
      confidence: 1,
      owner: 'human:priya',
      scope: 'engineering',
      authorType: 'system',
      observedAt: NOW,
      validFrom: NOW,
      now: NOW,
      provenance: {
        sourceUri: 'https://linear.net/bug/1',
        sourceTier: 'SINGLE_SOURCE',
        extractor: 't',
        extractorVersion: '1',
        retrievedAt: NOW,
      },
    });
    // The keys are ENFORCED, not just declared (node:sqlite enables
    // foreign_keys per connection by default): an orphan write around the
    // ledger is refused at the driver, not silently stored.
    await rejects(
      async () =>
        await db
          .prepare(
            'INSERT INTO outcomes (id, tenant, decision_id, metric, predicted, actual, basis, holdout_ref, resolved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .run('out_orphan', TEN, 'dec_missing', 'm', null, 1, 'b', null, null, NOW),
      'FOREIGN KEY',
      'orphan outcome refused:',
    );
    // Orphans can still arrive around the ledger (pragma-off restore, bulk
    // copy): seed with enforcement paused, exactly that path, then re-arm.
    await db.exec('PRAGMA foreign_keys = OFF');
    try {
      await db
        .prepare(
          'INSERT INTO outcomes (id, tenant, decision_id, metric, predicted, actual, basis, holdout_ref, resolved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run('out_orphan', TEN, 'dec_missing', 'm', null, 1, 'b', null, null, NOW);
      await db
        .prepare(
          'INSERT INTO outcomes (id, tenant, decision_id, metric, predicted, actual, basis, holdout_ref, resolved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run('out_other', 'zz-other', 'dec_missing', 'm', null, 1, 'b', null, null, NOW);
      await db
        .prepare('INSERT INTO claim_links (from_id, to_id, link) VALUES (?,?,?)')
        .run('clm_missing', a.id, 'relates');
      await db
        .prepare('INSERT INTO claim_links (from_id, to_id, link) VALUES (?,?,?)')
        .run('clm_gone1', 'clm_gone2', 'relates');
    } finally {
      await db.exec('PRAGMA foreign_keys = ON');
    }
    const report = await verifyIntegrity(db, TEN);
    eq(report.ok, false, 'orphans fail the check:');
    eq(report.orphanOutcomes, [{ id: 'out_orphan', decisionId: 'dec_missing' }], 'own-tenant orphan reported:');
    eq(
      report.danglingLinks.some((l) => l.fromId === 'clm_missing' && l.toId === a.id && l.missing === 'from'),
      true,
      'half-dangling link reported:',
    );
    eq(
      report.danglingLinks.some((l) => l.fromId === 'clm_gone1' && l.missing === 'both'),
      true,
      'fully-dangling link reported:',
    );
  } finally {
    await db.close();
  }
});
