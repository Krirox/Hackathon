import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, rejects, fresh, TEN, NOW } from './helpers.ts';
import {
  eraseTenant,
  ERASURE_ACTION,
  ERASURE_DONE_ACTION,
  erasedTenantOf,
  type ErasureReceipt,
} from '../src/core/erasure.ts';
import { storeArtifact, type RawEvent } from '../src/ingest/collectors.ts';
import { setKill } from '../src/gov/trust.ts';
import { installAuthSchema, signupTenant, inviteUser, login, sessionUser } from '../src/core/auth.ts';
import type { AsyncDb } from '../src/core/db.ts';

console.log('\n\x1b[1mErasure — GDPR Article 17, one tenant at a time, export before delete\x1b[0m');

const SIGNUP = {
  slug: 'acme',
  name: 'Acme Inc',
  email: 'owner@acme.test',
  password: 'correct horse battery staple',
  ownerName: 'Ada Owner',
};

/** A fresh world with auth tables, one signed-up tenant, and a seed of data across the store. */
async function world() {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await signupTenant(ctx.db, SIGNUP, NOW);
  const rows = await seedTenantData(ctx.db, TEN);
  return { ...ctx, rows };
}

/** Seed data in every category: business rows, auth rows, live sessions. */
async function seedTenantData(db: AsyncDb, tenant: string) {
  const at = NOW;
  // Business rows: claim + link + decision + outcome + request + trace.
  await db
    .prepare(
      `INSERT INTO claims (id, tenant, subject, kind, statement, confidence, source_uri, source_tier, extractor,
        extractor_ver, retrieved_at, observed_at, valid_from, status, owner, scope, created_at, seq)
       VALUES ('clm_e1', ?, 'release:v1', 'FACT', 'ships', 1, 'https://x.test/1', 'SYSTEM_OF_RECORD', 'e', '1', ?, ?, ?, 'CURRENT', 'sync:gh', 'eng', ?, 1)`,
    )
    .run(tenant, at, at, at, at);
  // Another tenant's data that MUST survive.
  await db
    .prepare(
      `INSERT INTO claims (id, tenant, subject, kind, statement, confidence, source_uri, source_tier, extractor,
        extractor_ver, retrieved_at, observed_at, valid_from, status, owner, scope, created_at, seq)
       VALUES ('clm_z1', 'zenith', 'release:z', 'FACT', 'ships', 1, 'https://x.test/2', 'SYSTEM_OF_RECORD', 'e', '1', ?, ?, ?, 'CURRENT', 'sync:gh', 'eng', ?, 1)`,
    )
    .run(at, at, at, at);
  await db.prepare(`INSERT INTO claim_links (from_id, to_id, link) VALUES ('clm_e1', 'clm_z1', 'relates')`).run();
  await db
    .prepare(
      `INSERT INTO decisions (id, tenant, goal, action, action_class, context_bundle, decided_by, scope, autonomy, signed_at)
       VALUES ('dec_e1', ?, 'g', 'analyze', 'ANALYZE', '{}', 'agent:x', 'eng', 'AUTO', ?)`,
    )
    .run(tenant, at);
  await db
    .prepare(
      `INSERT INTO outcomes (id, tenant, decision_id, metric, basis, created_at) VALUES ('out_e1', ?, 'dec_e1', 'm', 'test', ?)`,
    )
    .run(tenant, at);
  await db
    .prepare(
      `INSERT INTO traces (id, tenant, scope, task_type, intent, steps, tier, outcome, cost_json, router_confidence, created_at)
       VALUES ('trc_e1', ?, 'eng', 'launch.copy.draft', 'copy', '[]', 'L2_MODEL', 'ok', '{}', 0.9, ?)`,
    )
    .run(tenant, at);
  // Audit rows: 2 pre-existing, distinct tenants covered below.
  await db
    .prepare(`INSERT INTO audit_log (tenant, actor, action, target, at) VALUES (?, 'a', 'auth.login', 'login', ?)`)
    .run(tenant, at);
  await db
    .prepare(
      `INSERT INTO audit_log (tenant, actor, action, target, at) VALUES ('zenith', 'a', 'auth.login', 'login', ?)`,
    )
    .run(at);
  // Auth: an invited second user WITH a live session that must die on erasure.
  const member = await inviteUser(
    db,
    tenant,
    { email: 'm@acme.test', name: 'M', role: 'member', password: 'a-member-password' },
    { userId: 'seed', role: 'owner' },
    at,
  );
  const { token } = await login(
    db,
    { tenant, email: 'm@acme.test', password: 'a-member-password', ip: '10.0.0.9' },
    at,
  );
  void member;
  return { liveToken: token };
}

// ------------------------------------------------------------ completeness ----

T('erasure removes EVERY tenant-scoped table, verified against store introspection', async () => {
  const { db } = await world();
  // Introspect independently of the implementation's own list: every table
  // with a tenant column must end empty (orphans handled explicitly).
  const tables = (await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()) as { name: string }[];
  const orphans = new Set(['schema_migrations', 'meta', 'claim_links', 'skill_transfer_tests', 'ledger_seq']);
  await eraseTenant(db, TEN, 'op', NOW);
  for (const { name } of tables) {
    if (orphans.has(name)) continue;
    const cols = (await db.prepare(`PRAGMA table_info(${name})`).all()) as { name: string }[];
    if (!cols.some((c) => c.name === 'tenant')) continue;
    const left = (await db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE tenant = ?`).get(TEN)) as { n: number };
    eq(Number(left.n), 0, `table ${name} kept rows of the erased tenant:`);
  }
  // Orphan children are gone too.
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM claim_links').get()) as { n: number }).n,
    0,
    'claim_links of erased claims are gone:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM ledger_seq WHERE tenant = ?').get(TEN)) as { n: number }).n,
    0,
    'sequence bookkeeping is gone:',
  );
});

T('erasure is export-first: the returned document predates deletion and round-trips the content', async () => {
  const { db } = await world();
  const r = await eraseTenant(db, TEN, 'op', NOW);
  eq(r.export.version, 1);
  eq(r.export.tenant, TEN);
  eq(r.export.exportedAt, NOW);
  eq(r.export.claims.length, 1, 'the claim was exported:');
  eq((r.export.claims[0] as { id: string }).id, 'clm_e1');
  eq(r.export.decisions.length, 1);
  eq(r.export.outcomes.length, 1);
  eq(
    r.export.audit.some((a) => String((a as { action: string }).action) === ERASURE_ACTION),
    true,
    'the pre-delete audit marker rode along:',
  );
  // And the store really is empty behind the export.
  eq(((await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number }).n, 0);
});

// ---------------------------------------------------------------- isolation ----

T('erasure is tenant-scoped: another tenant loses nothing, not even shared child rows', async () => {
  const { db } = await world();
  await eraseTenant(db, TEN, 'op', NOW);
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get('zenith')) as { n: number }).n,
    1,
    'the other tenant keeps its claim:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get('zenith')) as { n: number }).n,
    1,
    'the other tenant keeps its audit trail:',
  );
});

T('erasure kills live sessions: no orphaned login survives the deleted user', async () => {
  const { db, rows } = await world();
  // The member's session is live before erasure.
  await sessionUser(db, rows.liveToken, NOW);
  await eraseTenant(db, TEN, 'op', NOW);
  await rejects(() => sessionUser(db, rows.liveToken, NOW), 'NO_SESSION', 'the live session died with its user:');
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?').get(TEN)) as { n: number }).n,
    0,
    'users are gone (PII):',
  );
  eq(((await db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()) as { n: number }).n, 0, 'sessions are gone:');
});

// ------------------------------------------------------------------ receipt ----

T('erasure leaves a surviving receipt: the deleted tenant is answerable for having been erased', async () => {
  const { db } = await world();
  const r = await eraseTenant(db, TEN, 'op', NOW);
  const receipt = (await db
    .prepare('SELECT * FROM audit_log WHERE tenant = ? AND action = ?')
    .get(erasedTenantOf(TEN), ERASURE_DONE_ACTION)) as
    { actor: string; target: string; detail: string; at: string } | undefined;
  eq(receipt !== undefined, true, 'the receipt row exists:');
  eq(receipt!.actor, 'op', 'it names the operator:');
  eq(receipt!.target, `tenant:${TEN}`);
  eq(receipt!.at, r.erasedAt);
  const detail = JSON.parse(receipt!.detail) as ErasureReceipt;
  eq(detail.exportedAt, NOW);
  eq((detail.deleted['claims'] ?? 0) >= 1, true, 'it carries row counts:');
  eq(detail.retained.some((r) => r.category === 'erasure-receipt'), true, 'it lists retained categories:');
  eq(detail.deferred.some((r) => r.category === 'backups'), true, 'it lists deferred categories:');
  eq(r.receipt.exportedAt, NOW, 'the API receipt matches the audit row:');
  // The tenant's own audit rows (including the pre-delete marker) are gone;
  // only the receipt's tenant remains.
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN)) as { n: number }).n,
    0,
    'the erased tenant leaves no trail of its own:',
  );
});

// ------------------------------------------------------------------- guards ----

T('erasure refuses unknown tenants and will not silently double-run', async () => {
  const { db } = await world();
  await rejects(() => eraseTenant(db, 'nope', 'op', NOW), 'UNKNOWN_TENANT');
  await eraseTenant(db, TEN, 'op', NOW);
  // Second run: the tenants row is gone, so the guard fires.
  await rejects(() => eraseTenant(db, TEN, 'op', NOW), 'UNKNOWN_TENANT', 'erasing a deleted tenant is refused:');
});

T('erasure is atomic: a failure inside the transaction restores the tenant and its data', async () => {
  const { db } = await world();
  // Sabotage: drop a table step 1 queries (the export reads claims), so the
  // transaction must fail and roll back in full. The drop itself happened
  // outside the transaction and stays dropped — atomicity is asserted on the
  // tables that still exist.
  await db.exec('DROP TABLE claim_links; DROP TABLE claims');
  await rejects(() => eraseTenant(db, TEN, 'op', NOW), 'no such table', 'the sabotaged erasure fails:');
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?').get(TEN)) as { n: number }).n,
    2,
    'the users came back with the rollback:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN)) as { n: number }).n,
    5,
    'the tenant\u2019s audit rows came back with the rollback (seeded marker + member auth rows):',
  );
  eq(
    (
      (await db
        .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ? AND action = ?')
        .get(TEN, ERASURE_ACTION)) as { n: number }
    ).n,
    0,
    'no erasure marker survived a failed erasure:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE slug = ?').get(TEN)) as { n: number }).n,
    1,
    'the tenant row itself came back:',
  );
});

// ----------------------------------------------------------- FLOW-004 gaps ----

T('FLOW-004: durable export failure rolls back before deletion is reported', async () => {
  const { db } = await world();
  const exportDir = mkdtempSync(join(tmpdir(), 'vital-erasure-'));
  const blocker = join(exportDir, 'blocked');
  writeFileSync(blocker, 'not a directory');
  await rejects(
    () => eraseTenant(db, TEN, 'op', NOW, { exportTo: blocker }),
    'EEXIST',
    'unwritable export location aborts erasure:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number }).n,
    1,
    'claims survived the failed export:',
  );
  eq(
    ((await db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE slug = ?').get(TEN)) as { n: number }).n,
    1,
    'tenant survived the failed export:',
  );
});

T('FLOW-004: durable export is written and verified before deletion commits', async () => {
  const { db } = await world();
  const exportDir = mkdtempSync(join(tmpdir(), 'vital-erasure-'));
  const r = await eraseTenant(db, TEN, 'op', NOW, { exportTo: exportDir });
  eq(r.receipt.exportPolicy, 'durable-file');
  eq(r.receipt.exportFile !== undefined, true, 'export file path is recorded:');
  eq(((await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number }).n, 0);
});

T('FLOW-004: tenant-scoped meta keys (cursor, kill switch) are inventoried and removed', async () => {
  const { db } = await world();
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run(`ingest:cursor:${TEN}:github`, 'sha-old');
  await setKill(db, TEN, { scope: 'eng', actionClass: 'READ' }, 'op', NOW);
  await eraseTenant(db, TEN, 'op', NOW);
  eq(
    ((await db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE ?").get(`ingest:cursor:${TEN}:%`)) as {
      n: number;
    }).n,
    0,
    'ingest cursors are gone:',
  );
  eq(
    ((await db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE ?").get(`kill:${TEN}:%`)) as { n: number }).n,
    0,
    'kill switches are gone:',
  );
});

T('FLOW-004: unshared raw artifacts are deleted; shared artifacts are retained', async () => {
  const { db } = await world();
  const artifactDir = mkdtempSync(join(tmpdir(), 'vital-artifacts-'));
  const event: RawEvent = {
    source: 'github',
    uri: 'https://x.test/blob',
    summary: 'payload',
    fingerprint: 'fp-shared-artifact',
    occurredAt: NOW,
    payload: { v: 1 },
  };
  const ref = storeArtifact(db, event, artifactDir);
  await db.prepare('UPDATE claims SET raw_ref = ? WHERE id = ?').run(ref, 'clm_e1');
  await db.prepare('UPDATE claims SET raw_ref = ? WHERE id = ?').run(ref, 'clm_z1');
  const r = await eraseTenant(db, TEN, 'op', NOW, { artifactDir });
  eq(
    r.receipt.retained.some((x) => x.category === 'shared-artifacts' && x.items.includes(ref)),
    true,
    'shared artifact listed as retained:',
  );
  eq(r.receipt.artifactsDeleted.includes(ref), false, 'shared artifact was not deleted:');
  try {
    const { statSync } = await import('node:fs');
    statSync(join(artifactDir, ref));
  } catch {
    throw new Error('shared artifact file should still exist on disk');
  }
});

T('FLOW-004: erased slug cannot be reused for a new organization', async () => {
  const { db } = await world();
  await eraseTenant(db, TEN, 'op', NOW);
  await rejects(() => signupTenant(db, SIGNUP, NOW), 'SLUG_RESERVED', 'erased slug reuse is refused:');
});

T('FLOW-004: exclusive artifact refs are deleted with the tenant', async () => {
  const { db } = await world();
  const artifactDir = mkdtempSync(join(tmpdir(), 'vital-artifacts-'));
  mkdirSync(artifactDir, { recursive: true });
  const event: RawEvent = {
    source: 'github',
    uri: 'https://x.test/only-acme',
    summary: 'exclusive',
    fingerprint: 'fp-exclusive-artifact',
    occurredAt: NOW,
    payload: { only: TEN },
  };
  const ref = storeArtifact(db, event, artifactDir);
  await db.prepare('UPDATE claims SET raw_ref = ? WHERE id = ?').run(ref, 'clm_e1');
  const r = await eraseTenant(db, TEN, 'op', NOW, { artifactDir });
  eq(r.receipt.artifactsDeleted.includes(ref), true, 'exclusive artifact deleted:');
  eq(existsSync(join(artifactDir, ref)), false, 'artifact file is gone:');
});
