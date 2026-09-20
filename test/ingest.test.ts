import fs, { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, rejects } from './helpers.ts';
import {
  ArtifactStoreError,
  claimInbox,
  cursorGet,
  cursorSet,
  FilesystemArtifactStore,
  fileDiffCollector,
  gitHubReleasesCollector,
  ingestEvents,
  ingestInboxBatch,
  isNovel,
  serperSearchCollector,
  settleInbox,
  stageToInbox,
  type Collector,
} from '../src/ingest/collectors.ts';
import {
  deriveIntegrationState,
  getIntegrationHealth,
  ingestErrorCode,
  isCollectorDisabled,
  lastInboxReceipt,
  pollCollectorWithHealth,
  setCollectorDisabled,
  testFileDirectory,
  testGitHubRepo,
} from '../src/ingest/health.ts';
import { runIngestionWorker } from '../src/ingest/worker.ts';
import { createHmacSurface, statementHashOf, verifyClaimEnvelope } from '../src/talk/surface.ts';
import { parseGitHubRepo, parseActivationConfigInput } from '../src/console/activation.ts';

console.log('\n\x1b[1mIngestion — read-only collectors\x1b[0m');

T('a file collector reports new and changed files, then goes quiet (checkpointed)', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-ing-'));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# v1\n');
  const c = fileDiffCollector('changelog', dir);
  eq((await c.poll(db, NOW)).length, 1);
  eq((await c.poll(db, NOW)).length, 0, 'second poll: nothing changed:');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# v1\n# v2\n');
  const evs = await c.poll(db, NOW);
  eq(evs.length, 1);
  eq(evs[0]!.summary.includes('changed'), true);
});

T('ingest writes OBSERVATION, never FACT — and dedupes by fingerprint', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-ing2-'));
  writeFileSync(join(dir, 'notes.md'), 'hello\n');
  const c = fileDiffCollector('notes', dir);
  const evs = await c.poll(db, NOW);
  const ids = await ingestEvents(db, ledger, TEN, c, evs, {
    owner: 'sync:files',
    scope: 'product',
    now: NOW,
    artifactDir: join(dir, 'art'),
  });
  eq(ids.length, 1);
  eq((await ledger.get(TEN, ids[0]!))!.kind, 'OBSERVATION');
  eq((await ledger.get(TEN, ids[0]!))!.provenance.sourceTier, 'SINGLE_SOURCE');
  eq(
    (
      await ingestEvents(db, ledger, TEN, c, evs, {
        owner: 'sync:files',
        scope: 'product',
        now: NOW,
        artifactDir: join(dir, 'art'),
      })
    ).length,
    0,
    'same fingerprint: no duplicate claim:',
  );
});

T('a collector declaring a ground tier is refused at ingest', async () => {
  const { db, ledger } = await fresh();
  const c = fileDiffCollector('evil', tmpdir(), 'SYSTEM_OF_RECORD');
  await rejects(
    async () => await ingestEvents(db, ledger, TEN, c, [], { owner: 's', scope: 'x', now: NOW }),
    'INGEST_TIER',
  );
});

T('github releases advance the cursor and parse the fixture', async () => {
  const { db } = await fresh();
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 11,
          tag_name: 'v2.14.0',
          name: 'Streaming',
          html_url: 'https://gh/r11',
          published_at: NOW,
          body: 'ships EU streaming',
        },
        { id: 9, tag_name: 'v2.13.0', name: 'Fixes', html_url: 'https://gh/r9', published_at: NOW, body: 'bugfixes' },
      ],
    };
  };
  const c = gitHubReleasesCollector('acme', 'app', fetchFn);
  const first = await c.poll(db, NOW);
  eq(first.length, 2);
  eq(first[0]!.summary.includes('v2.13.0'), true, 'oldest first:');
  eq((await c.poll(db, NOW)).length, 0, 'cursor advanced:');
  eq(calls[0]!.includes('api.github.com/repos/acme/app/releases'), true);
});

console.log('\n\x1b[1mCuration — the part that decides survival\x1b[0m');

T('disputed pairs queue with both sides for resolution', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'churn',
    kind: 'FACT',
    statement: 'churn 2%',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const b = await ledger.append({
    tenant: TEN,
    subject: 'churn',
    kind: 'FACT',
    statement: 'churn 9%',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, a.id, b.id, 'contradicts');
  const pairs = await ledger.disputedPairs(TEN);
  eq(pairs.length, 1);
  eq([pairs[0]!.a.status, pairs[0]!.b.status], ['DISPUTED', 'DISPUTED']);
});

T('expiry prompts surface FACTs before the TTL lapses', async () => {
  const { ledger } = await fresh();
  const soon = new Date(Date.parse(NOW) + 3_600_000).toISOString();
  const later = new Date(Date.parse(NOW) + 90 * 86_400_000).toISOString();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'expiring',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: soon,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.append({
    tenant: TEN,
    subject: 'q',
    kind: 'FACT',
    statement: 'fresh',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: later,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  eq(
    (await ledger.dueVerifications(TEN, NOW, 86_400_000)).map((c) => c.id),
    [a.id],
  );
});

T('human correction supersedes, links, and counts', async () => {
  const { ledger } = await fresh();
  const old = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: '$99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const { claim: neu } = await ledger.correctClaim(TEN, old.id, '$79', 'human:priya', DAY_LATER);
  eq(neu.statement, '$79');
  eq((await ledger.get(TEN, old.id))!.status, 'SUPERSEDED');
  eq(await ledger.correctionCount(TEN), 1);
  await rejects(async () => await ledger.correctClaim(TEN, old.id, '', 'human:priya', DAY_LATER), 'EMPTY_CORRECTION');
});

T('a third party can reconstruct who asserted what, when, and signed it', async () => {
  const { ledger } = await fresh();
  const c = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: 'Pro is $99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:stripe',
    scope: 'finance',
    authorType: 'system',
    provenance: sor(),
  });
  const surface = createHmacSurface('tenant-secret');
  // The envelope names the FACT; it rides a publication-receipt claim.
  const env = surface.bindClaim({
    claimId: c.id,
    seq: c.seq,
    statementHash: statementHashOf(c.statement),
    scope: c.scope,
    tenant: TEN,
    boundAt: NOW,
  });
  const receipt = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'OBSERVATION',
    statement: 'published to talk surface',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'agent',
    buzzEventSig: JSON.stringify(env),
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  const back = await verifyClaimEnvelope(surface, ledger, TEN, receipt.id);
  eq(back.boundId, c.id);
  eq(back.binding.seq, c.seq);
  // Rebinding the same valid attestation to another claim fails.
  const other = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'OBSERVATION',
    statement: 'other receipt',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'agent',
    buzzEventSig: JSON.stringify({ ...env, binding: { ...env.binding, claimId: 'clm_nope' } }),
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  await rejects(async () => await verifyClaimEnvelope(surface, ledger, TEN, other.id), 'TAMPERED_ENVELOPE');
  await rejects(async () => await verifyClaimEnvelope(surface, ledger, TEN, c.id), 'UNBOUND_CLAIM');
});

T('novelty-vs-ledger: history is not news', async () => {
  const { ledger } = await fresh();
  await ledger.append({
    tenant: TEN,
    subject: 'gh:releases',
    kind: 'FACT',
    statement: 'v2.14 shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  eq(await isNovel(ledger, TEN, 'gh:releases', 'v2.14 shipped'), false);
  eq(await isNovel(ledger, TEN, 'gh:releases', 'v2.15 shipped'), true);
});

T('F18: novelty ignores superseded history without hydrating the subject', async () => {
  const { ledger } = await fresh();
  const old = await ledger.append({
    tenant: TEN,
    subject: 'gh:releases',
    kind: 'FACT',
    statement: 'v2.14 shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  eq(await isNovel(ledger, TEN, 'gh:releases', 'v2.14 shipped'), false, 'live statement is not novel:');
  const neu = await ledger.append({
    tenant: TEN,
    subject: 'gh:releases',
    kind: 'FACT',
    statement: 'v2.14 shipped, corrected',
    confidence: 1,
    observedAt: DAY_LATER,
    validFrom: DAY_LATER,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, neu.id, old.id, 'supersedes');
  eq(await isNovel(ledger, TEN, 'gh:releases', 'v2.14 shipped'), true, 'superseded history is not prior art:');
  eq(await isNovel(ledger, TEN, 'gh:releases', 'v2.14 shipped, corrected'), false, 'the live row still matches:');
});

T('F19: the artifact store refuses oversized trees loudly instead of hashing them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-'));
  const store = new FilesystemArtifactStore(dir, 16);
  eq(store.put('small.txt', 'tiny'), 'small.txt', 'under-cap writes land:');
  eq(store.get('small.txt').toString(), 'tiny', 'and read back:');
  let code = '';
  try {
    store.put('big.txt', 'x'.repeat(17));
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('TOO_LARGE'), true, 'oversized writes refuse with a named error:');
  eq(code.includes('[artifact:'), true, 'namespaced like every other refusal:');
  writeFileSync(join(dir, ' smuggled.txt'.trim()), 'x'.repeat(64));
  let getCode = '';
  try {
    store.get('smuggled.txt');
  } catch (e) {
    getCode = (e as Error).message;
  }
  eq(getCode.includes('TOO_LARGE'), true, 'oversized reads refuse before hashing:');
  let unsafe = '';
  try {
    store.put('../escape.txt', 'x');
  } catch (e) {
    unsafe = (e as Error).message;
  }
  eq(unsafe.includes('UNSAFE_REF'), true, 'escaping refs refuse:');
  void ArtifactStoreError;
});

T('serper search maps results to raw events; the key travels in headers only', async () => {
  const { db, ledger } = await fresh();
  const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          {
            title: 'Magic links at Slack',
            link: 'https://slack.engineering/magic',
            snippet: 'short-lived tokens',
            date: '2026-01-01',
          },
          { title: 'SSO vendor blog', link: 'https://vendor.blog/sso', snippet: 'buy our sso' },
        ],
      }),
    };
  };
  const c = serperSearchCollector('magic link login competitors', { apiKey: 'k', fetchFn });
  const evs = await c.poll(db, NOW);
  eq(evs.length, 2);
  eq(evs[0]!.uri, 'https://slack.engineering/magic');
  eq(seen[0]!.url, 'https://google.serper.dev/search');
  eq(seen[0]!.init.headers['X-API-KEY'], 'k');
  eq(JSON.parse(seen[0]!.init.body).q, 'magic link login competitors');
  eq(JSON.parse(seen[0]!.init.body)['X-API-KEY'] ?? null, null, 'key in header, never in body:');
  const ids = await ingestEvents(db, ledger, TEN, c, evs, {
    owner: 'sync:serper',
    scope: 'market',
    now: NOW,
    artifactDir: join(tmpdir(), `vital-serp-${process.pid}`),
  });
  eq(ids.length, 2);
  let code = '';
  try {
    const nok = serperSearchCollector('x', {
      apiKey: 'k',
      fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });
    await nok.poll(db, NOW);
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('SERPER_FETCH'), true);
});

console.log('\n\x1b[1mIngestion — durable inbox (F03)\x1b[0m');

T('crash between fetch and cursor loses nothing: the inbox holds the event, retry dedupes', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-inbox-'));
  writeFileSync(join(dir, 'a.md'), 'v1\n');
  const c = fileDiffCollector('crashy', dir);
  const evs = await c.poll(db, NOW, TEN);
  eq(evs.length, 1);
  const count = async () =>
    ((await db.prepare('SELECT COUNT(*) AS n FROM ingest_inbox WHERE tenant = ?').get(TEN)) as { n: number }).n;
  eq(await count(), 1, 'poll stages to the inbox before moving the cursor:');
  // Simulate the crash: the cursor write never happened — rewind it. The
  // event must survive in the inbox (no loss).
  await db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run('ingest:cursor:crashy', `ingest:cursor:${TEN}:crashy`);
  const retry = await c.poll(db, NOW, TEN);
  eq(retry.length, 1, 'cursor rewound, so the occurrence is re-fetched:');
  eq(await count(), 1, 'same identity collapses onto the existing row (no dup):');
  // And the staged row is actually processable: claim → settle lifecycle.
  const claimed = await claimInbox(db, TEN, 'crashy', 10);
  eq(claimed.length, 1);
  eq(claimed[0]!.event.summary, evs[0]!.summary);
  await settleInbox(
    db,
    claimed.map((r) => r.id),
    'DONE',
  );
  eq(((await db.prepare('SELECT status AS s FROM ingest_inbox WHERE tenant = ?').get(TEN)) as { s: string }).s, 'DONE');
  eq((await claimInbox(db, TEN, 'crashy', 10)).length, 0, 'settled rows are never re-claimed:');
});

T('duplicate delivery collapses to one inbox receipt — per tenant', async () => {
  const { db } = await fresh();
  const ev = {
    source: 's',
    uri: 'https://example.com/e1',
    fingerprint: 'fp1',
    eventId: 'e1',
    revision: 'r1',
    occurredAt: NOW,
    summary: 's',
    payload: {},
  };
  eq(await stageToInbox(db, TEN, 'col', [ev], NOW), 1);
  eq(await stageToInbox(db, TEN, 'col', [ev], NOW), 0, 'same identity inserts nothing:');
  eq(await stageToInbox(db, TEN, 'col', [{ ...ev, revision: 'r2' }], NOW), 1, 'new revision is a new receipt:');
  eq(await stageToInbox(db, 'other-tenant', 'col', [ev], NOW), 1, 'identity is tenant-scoped:');
});

T('github pagination walks past the first page via Link continuation', async () => {
  const { db } = await fresh();
  const mk = (id: number) => ({
    id,
    tag_name: `v${id}.0`,
    name: `R${id}`,
    html_url: `https://gh/r${id}`,
    published_at: NOW,
    body: 'x',
  });
  const page1 = Array.from({ length: 20 }, (_, i) => mk(i + 1));
  const page2 = Array.from({ length: 5 }, (_, i) => mk(21 + i));
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const isPage2 = url.includes('page=2');
    return {
      ok: true,
      status: 200,
      json: async () => (isPage2 ? page2 : page1),
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'link' && !isPage2
            ? '<https://api.github.com/repos/acme/app/releases?per_page=100&page=2>; rel="next"'
            : null,
      },
    };
  };
  const c = gitHubReleasesCollector('acme', 'app', fetchFn);
  const evs = await c.poll(db, NOW, TEN);
  eq(evs.length, 25, 'walks all 25 releases, not just the first page:');
  eq(calls.length, 2, 'follows the explicit continuation:');
  eq((await c.poll(db, NOW, TEN)).length, 0, 'cursor advanced over every page:');
});

console.log('\n\x1b[1mIngestion — tenant cursors, revisions and receipts (F09)\x1b[0m');

T('F09: multi-tenant cursor isolation and legacy fallback', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-tenant-cursors-'));
  writeFileSync(join(dir, 'doc.txt'), 'content v1\n');

  const c = fileDiffCollector('shared-docs', dir);
  // Tenant A polls -> gets 1 event, advances cursor for tenant A
  const evsA = await c.poll(db, NOW, 'tenant-alpha');
  eq(evsA.length, 1);

  // Tenant B polls the same collector -> also gets 1 event, because tenant A's cursor is isolated!
  const evsB = await c.poll(db, NOW, 'tenant-beta');
  eq(evsB.length, 1);

  // Second poll for tenant A -> 0 events
  eq((await c.poll(db, NOW, 'tenant-alpha')).length, 0);
  // Second poll for tenant B -> 0 events
  eq((await c.poll(db, NOW, 'tenant-beta')).length, 0);

  // Fallback test: set legacy cursor key
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('ingest:cursor:legacy-col', JSON.stringify({ 'a.txt': 'h1' }));
  const val = await cursorGet(db, 'new-tenant', 'legacy-col');
  eq(val, JSON.stringify({ 'a.txt': 'h1' }));
  // Once tenant cursor is set, scoped cursor takes precedence
  await cursorSet(db, 'new-tenant', 'legacy-col', JSON.stringify({ 'a.txt': 'h2' }));
  eq(await cursorGet(db, 'new-tenant', 'legacy-col'), JSON.stringify({ 'a.txt': 'h2' }));
});

T('F09: gitHubReleasesCollector detects release edits as new revisions', async () => {
  const { db } = await fresh();
  let currentNotes = 'initial notes';
  const currentTag = 'v1.0.0';
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        id: 42,
        tag_name: currentTag,
        name: 'Release 42',
        html_url: 'https://gh/r42',
        published_at: NOW,
        body: currentNotes,
      },
    ],
  });

  const c = gitHubReleasesCollector('acme', 'edited-repo', fetchFn);
  const first = await c.poll(db, NOW, TEN);
  eq(first.length, 1);
  eq(first[0]!.eventId, '42');

  // Second poll without changes -> 0 events
  const second = await c.poll(db, NOW, TEN);
  eq(second.length, 0);

  // Edit the existing release body (e.g. changelog updated on github)
  currentNotes = 'updated notes with security patch details';
  const third = await c.poll(db, NOW, TEN);
  eq(third.length, 1, 'release edit detected as a new revision event:');
  eq(third[0]!.eventId, '42');
  eq((third[0]!.payload as { notes: string }).notes.includes('security patch'), true);

  // Verify inbox received both revisions for the same occurrence
  const rows = (await db
    .prepare('SELECT source_event_id, revision FROM ingest_inbox WHERE tenant = ? AND collector = ?')
    .all(TEN, c.name)) as { source_event_id: string; revision: string }[];
  eq(rows.length, 2);
  eq(rows[0]!.source_event_id, '42');
  eq(rows[1]!.source_event_id, '42');
  eq(rows[0]!.revision !== rows[1]!.revision, true, 'distinct revisions in inbox:');
});

T('F09: atomic claim + receipt persistence with dual identity/fingerprint receipt', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-atomic-receipts-'));
  writeFileSync(join(dir, 'test.txt'), 'atomic payload\n');
  const c = fileDiffCollector('atomic-col', dir);
  const evs = await c.poll(db, NOW, TEN);
  eq(evs.length, 1);

  const claimIds = await ingestEvents(db, ledger, TEN, c, evs, {
    owner: 'worker:ingest',
    scope: 'infra',
    now: NOW,
  });
  eq(claimIds.length, 1);

  // Both fingerprint receipt and identity receipt exist
  const fpKey = `ingest:seen:${TEN}:${c.name}:${evs[0]!.fingerprint}`;
  const idKey = `ingest:seen:${TEN}:${c.name}:${evs[0]!.eventId}:${evs[0]!.revision}`;
  const fpVal = ((await db.prepare('SELECT value FROM meta WHERE key = ?').get(fpKey)) as { value: string }).value;
  const idVal = ((await db.prepare('SELECT value FROM meta WHERE key = ?').get(idKey)) as { value: string }).value;
  eq(fpVal, claimIds[0]!);
  eq(idVal, claimIds[0]!);

  // Re-ingest with same events is deduped
  const second = await ingestEvents(db, ledger, TEN, c, evs, {
    owner: 'worker:ingest',
    scope: 'infra',
    now: NOW,
  });
  eq(second.length, 0);
});

T('F09: ingestInboxBatch claims, persists claims and settles inbox rows to DONE', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-inbox-batch-'));
  writeFileSync(join(dir, 'file1.txt'), 'content 1\n');
  writeFileSync(join(dir, 'file2.txt'), 'content 2\n');
  const c = fileDiffCollector('batch-col', dir);
  await c.poll(db, NOW, TEN);

  // Drain and settle via ingestInboxBatch
  const res = await ingestInboxBatch(db, ledger, TEN, c, {
    owner: 'worker:batch',
    scope: 'product',
    now: NOW,
  });
  eq(res.receipts.length, 2);
  eq(res.claimIds.length, 2);

  // Check inbox rows status
  const statuses = (
    (await db.prepare('SELECT status FROM ingest_inbox WHERE tenant = ? AND collector = ?').all(TEN, c.name)) as {
      status: string;
    }[]
  ).map((r) => r.status);
  eq(statuses, ['DONE', 'DONE']);

  // Ledger has both claims
  for (const cid of res.claimIds) {
    const claim = await ledger.get(TEN, cid);
    eq(claim?.kind, 'OBSERVATION');
  }

  // Second run finds nothing pending
  const second = await ingestInboxBatch(db, ledger, TEN, c);
  eq(second.receipts.length, 0);
  eq(second.claimIds.length, 0);
});

console.log('\n\x1b[1mIngestion — standardized health (FLOW-016)\x1b[0m');

T('FLOW-016: serper collector stages to inbox and advances checkpoint like file/github', async () => {
  const { db } = await fresh();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      organic: [{ title: 'A', link: 'https://a.test', snippet: 'one' }],
    }),
  });
  const c = serperSearchCollector('probe', { apiKey: 'k', fetchFn });
  const evs = await c.poll(db, NOW, TEN);
  eq(evs.length, 1);
  const inbox = (await db.prepare('SELECT COUNT(*) AS n FROM ingest_inbox WHERE tenant = ?').get(TEN)) as { n: number };
  eq(inbox.n, 1, 'staged before return:');
  eq((await cursorGet(db, TEN, c.name)) !== null, true, 'checkpoint advanced:');
  eq((await c.poll(db, NOW, TEN)).length, 1, 're-fetch same result:');
  const inbox2 = (await db.prepare('SELECT COUNT(*) AS n FROM ingest_inbox WHERE tenant = ?').get(TEN)) as {
    n: number;
  };
  eq(inbox2.n, 1, 'duplicate delivery collapses:');
});

T('FLOW-016: serper runs through the same worker as file collectors', async () => {
  const { db, ledger } = await fresh();
  const art = join(tmpdir(), `vital-flow016-${process.pid}`);
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      organic: [{ title: 'Worker path', link: 'https://worker.test', snippet: 'via worker' }],
    }),
  });
  const c = serperSearchCollector('worker probe', { apiKey: 'k', fetchFn });
  const result = await runIngestionWorker(db, ledger, c, {
    tenant: TEN,
    scope: 'market',
    artifactDir: art,
    maxReceipts: 5,
  });
  eq([result.processed, result.failed, result.polled], [1, 0, true]);
  eq((await ledger.get(TEN, result.claimIds[0]!))!.kind, 'OBSERVATION');
});

T('FLOW-016: empty serper result is an explicit empty receipt, not a silent success masquerade', async () => {
  const { db } = await fresh();
  const c = serperSearchCollector('empty', {
    apiKey: 'k',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ organic: [] }) }),
  });
  const evs = await c.poll(db, NOW, TEN);
  eq(evs.length, 0);
  const health = await getIntegrationHealth(db, TEN, c.name, { configured: true, now: NOW });
  eq(health.inbox.total, 0);
  const derived = deriveIntegrationState({
    configured: true,
    disabled: false,
    stats: health.inbox,
    lastPoll: { at: NOW, ok: true, eventsFetched: 0, staged: 0, errorCode: null },
    lastSuccessAt: NOW,
    nowMs: Date.parse(NOW),
    delayMs: 86_400_000,
  });
  eq(derived.state, 'empty');
});

T('FLOW-016: invalid serper credentials classify as unconfigured', async () => {
  const { db } = await fresh();
  const c = serperSearchCollector('no-key', {
    apiKey: '',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  let code = '';
  try {
    await pollCollectorWithHealth(db, TEN, c, NOW);
  } catch (e) {
    code = ingestErrorCode(e);
  }
  eq(code, 'UNCONFIGURED');
});

T('FLOW-016: provider rate limit surfaces rate_limited state', async () => {
  const { db } = await fresh();
  const c = serperSearchCollector('rate', {
    apiKey: 'k',
    fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  try {
    await pollCollectorWithHealth(db, TEN, c, NOW);
  } catch {
    /* expected */
  }
  const health = await getIntegrationHealth(db, TEN, c.name, { configured: true, now: NOW });
  eq(health.state, 'rate_limited');
});

T('FLOW-016: current poll failure remains visible after successful receipts', async () => {
  const input = {
    configured: true,
    disabled: false,
    stats: { pending: 0, claimed: 0, done: 2, failed: 0, total: 2 },
    lastPoll: { at: DAY_LATER, ok: false, eventsFetched: 0, staged: 0, errorCode: 'PROVIDER_ERROR' },
    lastSuccessAt: NOW,
    nowMs: Date.parse(DAY_LATER),
    delayMs: 86_400_000,
  };
  const failed = deriveIntegrationState(input);
  eq(failed.state, 'failed');
  eq(failed.detail.includes('upstream provider'), true);
  eq(failed.detail.includes('2 source items already ingested'), true);
  eq(deriveIntegrationState({ ...input, stats: { ...input.stats, pending: 1, total: 3 } }).state, 'failed');
  eq(deriveIntegrationState({ ...input, configured: false }).state, 'unconfigured');
  eq(deriveIntegrationState({ ...input, disabled: true }).state, 'disabled');
  for (const [errorCode, state] of [
    ['RATE_LIMITED', 'rate_limited'],
    ['UNCONFIGURED', 'unconfigured'],
    ['SOURCE_REJECTED', 'rejected'],
    ['TIER_REJECTED', 'rejected'],
    [null, 'failed'],
  ] as const) {
    eq(deriveIntegrationState({ ...input, lastPoll: { ...input.lastPoll, errorCode } }).state, state);
  }
  const recovered = { ...input, lastPoll: { ...input.lastPoll, ok: true, errorCode: null } };
  const mixed = deriveIntegrationState({
    ...recovered,
    stats: { ...input.stats, failed: 1, total: 3 },
  });
  eq(mixed.state, 'failed');
  eq(mixed.detail.includes('1 receipt failed'), true);
  eq(mixed.detail.includes('2 source items already ingested'), true);
  eq(deriveIntegrationState(recovered).state, 'ready');
});

T('FLOW-016: disabled collector refuses before staging', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-flow016-dis-'));
  writeFileSync(join(dir, 'a.md'), 'x');
  const c = fileDiffCollector('disabled', dir);
  await setCollectorDisabled(db, TEN, c.name, true);
  eq(await isCollectorDisabled(db, TEN, c.name), true);
  await rejects(() => pollCollectorWithHealth(db, TEN, c, NOW), 'DISABLED');
  const health = await getIntegrationHealth(db, TEN, c.name, { configured: true, now: NOW });
  eq(health.state, 'disabled');
});

T('FLOW-016: connection test previews readable files without staging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-flow016-test-'));
  writeFileSync(join(dir, 'notes.md'), 'hello');
  const test = testFileDirectory(dir);
  eq(test.ok, true);
  eq(test.preview?.count, 1);
  eq(test.preview?.samples[0]!.name, 'notes.md');
});

T('FLOW-016: duplicate delivery through worker remains idempotent', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-flow016-dup-'));
  const art = join(tmpdir(), `vital-flow016-art-${process.pid}`);
  writeFileSync(join(dir, 'once.md'), 'once');
  const c = fileDiffCollector('dup', dir);
  const first = await runIngestionWorker(db, ledger, c, { tenant: TEN, scope: 'x', artifactDir: art });
  const second = await runIngestionWorker(db, ledger, c, { tenant: TEN, scope: 'x', artifactDir: art });
  eq(first.processed, 1);
  eq([second.processed, second.claimIds.length], [0, 0]);
  eq(((await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number }).n, 1);
});

T('FLOW-016: ground-tier collector refusal is explicit rejected evidence', async () => {
  const { db, ledger } = await fresh();
  const c = fileDiffCollector('evil-tier', tmpdir(), 'SYSTEM_OF_RECORD');
  await rejects(
    async () =>
      await ingestEvents(db, ledger, TEN, c, [], {
        owner: 's',
        scope: 'x',
        now: NOW,
      }),
    'INGEST_TIER',
  );
  eq(ingestErrorCode(new Error('[ingest:INGEST_TIER] bad')), 'TIER_REJECTED');
});

T('FLOW-016: receipt links exact tenant collector identity, never latest scope observation', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-exact-receipt-'));
  try {
    const c = fileDiffCollector('exact-receipt', dir);
    const event = {
      source: c.name,
      uri: 'https://receipt.test/a',
      eventId: 'a',
      revision: 'r1',
      fingerprint: 'receipt-a',
      occurredAt: NOW,
      summary: 'first',
      payload: {},
    };
    await stageToInbox(db, TEN, c.name, [event], NOW);
    const batch = await ingestInboxBatch(db, ledger, TEN, c, { scope: 'x', now: NOW, artifactDir: dir });
    await ingestEvents(db, ledger, TEN, { ...c, name: 'unrelated' }, [{ ...event, fingerprint: 'other' }], {
      owner: 'sync',
      scope: 'x',
      now: DAY_LATER,
      artifactDir: dir,
    });
    eq((await lastInboxReceipt(db, TEN, c.name, 'x'))?.claimId, batch.claimIds[0]);
    eq((await lastInboxReceipt(db, TEN, c.name, null))?.claimId, batch.claimIds[0]);
    eq((await lastInboxReceipt(db, TEN, c.name, 'wrong-scope'))?.claimId, null);
    const key = `ingest:seen:${TEN}:${c.name}:a:r1`;
    const foreign = await ingestEvents(db, ledger, 'other-tenant', c, [event], {
      owner: 'sync',
      scope: 'x',
      now: NOW,
      artifactDir: dir,
    });
    for (const value of ['migrated', 'missing-claim', foreign[0]!]) {
      await db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
      eq((await lastInboxReceipt(db, TEN, c.name, 'x'))?.claimId, null);
    }
    await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    eq((await lastInboxReceipt(db, TEN, c.name, 'x'))?.claimId, null);
    eq(await lastInboxReceipt(db, TEN, 'unknown-collector', 'x'), null);
    await stageToInbox(db, TEN, c.name, [{ ...event, eventId: 'pending' }], DAY_LATER);
    const pending = await lastInboxReceipt(db, TEN, c.name, 'x');
    eq([pending?.status, pending?.claimId], ['PENDING', null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: fingerprint deduplication persists an exact identity alias for receipt lookup', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-receipt-alias-'));
  try {
    const c = fileDiffCollector('alias', dir);
    const event = {
      source: c.name,
      uri: 'https://receipt.test/alias',
      eventId: 'first',
      revision: 'v1',
      fingerprint: 'same-content',
      occurredAt: NOW,
      summary: 'same',
      payload: {},
    };
    const ids = await ingestEvents(db, ledger, TEN, c, [event], {
      owner: 'sync',
      scope: 'x',
      now: NOW,
      artifactDir: dir,
    });
    await stageToInbox(db, TEN, c.name, [{ ...event, eventId: 'second' }], DAY_LATER);
    const batch = await ingestInboxBatch(db, ledger, TEN, c, { scope: 'x', now: DAY_LATER, artifactDir: dir });
    eq(batch.claimIds.length, 0);
    eq((await lastInboxReceipt(db, TEN, c.name, 'x'))?.claimId, ids[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: recovered polls clear active errors and freshness uses hours not milliseconds', async () => {
  const { db } = await fresh();
  let failing = true;
  const c = serperSearchCollector('recovery', {
    apiKey: 'k',
    fetchFn: async () => ({
      ok: !failing,
      status: failing ? 429 : 200,
      json: async () => ({ organic: [] }),
    }),
  });
  await rejects(() => pollCollectorWithHealth(db, TEN, c, NOW), 'SERPER_FETCH');
  eq((await getIntegrationHealth(db, TEN, c.name, { configured: true, now: NOW })).lastError?.code, 'RATE_LIMITED');
  failing = false;
  await pollCollectorWithHealth(db, TEN, c, DAY_LATER);
  const later = new Date(Date.parse(DAY_LATER) + 25 * 3_600_000).toISOString();
  const health = await getIntegrationHealth(db, TEN, c.name, { configured: true, now: later });
  eq([health.lastError, health.lastSuccessAt, health.freshnessSeconds], [null, DAY_LATER, 90_000]);
  const derived = deriveIntegrationState({
    configured: true,
    disabled: false,
    stats: { pending: 0, claimed: 0, done: 1, failed: 0, total: 1 },
    lastPoll: health.lastPoll,
    lastSuccessAt: DAY_LATER,
    nowMs: Date.parse(later),
    delayMs: 86_400_000,
  });
  eq(derived.state, 'delayed');
  eq(derived.detail.includes('25h ago'), true);
});

T('FLOW-016: changed Serper snippet creates revised observation while duplicates stage zero', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-serper-revisions-'));
  let snippet = 'first';
  const c = serperSearchCollector('revision', {
    apiKey: 'k',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ organic: [{ title: 'Stable title', link: 'https://revision.test', snippet }] }),
    }),
  });
  try {
    const first = await runIngestionWorker(db, ledger, c, { tenant: TEN, scope: 'market', artifactDir: dir });
    const duplicate = await pollCollectorWithHealth(db, TEN, c, DAY_LATER);
    eq([duplicate.events.length, duplicate.staged], [1, 0]);
    snippet = 'second';
    const second = await runIngestionWorker(db, ledger, c, { tenant: TEN, scope: 'market', artifactDir: dir });
    eq([first.claimIds.length, second.claimIds.length], [1, 1]);
    eq(first.claimIds[0] !== second.claimIds[0], true);
    eq((await ledger.get(TEN, second.claimIds[0]!))?.statement, 'Stable title — second');
    eq((await pollCollectorWithHealth(db, TEN, c, DAY_LATER)).staged, 0);
    eq((await getIntegrationHealth(db, TEN, c.name, { configured: true })).inbox.total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: Serper legacy fingerprints preserve blanket dedupe and allow scoped content revisions', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-serper-legacy-'));
  const title = 'Legacy title';
  const uri = 'https://legacy.test';
  const fingerprint = createHash('sha256').update(`${uri}:${title}`).digest('hex');
  const c = serperSearchCollector('legacy', {
    apiKey: 'k',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ organic: [{ title, link: uri, snippet: 'old' }] }),
    }),
  });
  try {
    const [event] = await c.poll(db, NOW, TEN);
    const opts = { owner: 'sync', scope: 'market', now: NOW, artifactDir: dir };
    const old = await ingestEvents(db, ledger, TEN, c, [{ ...event!, fingerprint }], opts);
    await db
      .prepare('DELETE FROM meta WHERE key = ?')
      .run(`ingest:seen:${TEN}:${c.name}:${event!.eventId}:${event!.revision}`);
    eq((await ingestEvents(db, ledger, TEN, c, [event!], opts)).length, 0);
    const changed = {
      ...event!,
      fingerprint: 'new-content',
      revision: 'new-revision',
      payload: { title, snippet: 'new' },
    };
    eq((await ingestEvents(db, ledger, TEN, c, [changed], opts)).length, 1);
    eq(old.length, 1);
    await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`ingest:seen:${fingerprint}`, old[0]!);
    eq((await ingestEvents(db, ledger, 'other-tenant', c, [changed], opts)).length, 0);
    await db.prepare('DELETE FROM meta WHERE key = ?').run(`ingest:seen:${fingerprint}`);
    await db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(`ingest:seen:migrated-tenant:${c.name}:${fingerprint}`, 'migrated');
    eq((await ingestEvents(db, ledger, 'migrated-tenant', c, [changed], opts)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: staging reports are invocation-local across overlapping polls and partial failure', async () => {
  const { db } = await fresh();
  const event = {
    source: 'local-report',
    uri: 'https://staging.test',
    fingerprint: 'local-fp',
    occurredAt: NOW,
    summary: 'local',
    payload: {},
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let staged!: () => void;
  const started = new Promise<void>((resolve) => {
    staged = resolve;
  });
  let calls = 0;
  const c: Collector = {
    name: 'local-report',
    sourceTier: 'SINGLE_SOURCE',
    extractor: 'test',
    extractorVersion: '1',
    async poll(db, now, tenant = 'default') {
      const first = ++calls === 1;
      await stageToInbox(db, tenant, 'local-report', [event], now);
      if (first) {
        staged();
        await gate;
      }
      return [event];
    },
  };
  const first = pollCollectorWithHealth(db, TEN, c, NOW);
  await started;
  const second = await pollCollectorWithHealth(db, TEN, c, NOW);
  release();
  eq([(await first).staged, second.staged], [1, 0]);
  const broken: Collector = {
    ...c,
    async poll(db, now, tenant = 'default') {
      await stageToInbox(db, tenant, c.name, [{ ...event, revision: 'partial' }], now);
      throw new Error('partial fetch');
    },
  };
  await rejects(() => pollCollectorWithHealth(db, TEN, broken, DAY_LATER), 'partial fetch');
  const health = await getIntegrationHealth(db, TEN, c.name, { configured: true });
  eq([health.lastPoll?.ok, health.lastPoll?.staged, health.inbox.total], [false, 1, 2]);
});

T('FLOW-016: connection preview shares entry file-byte and total-byte bounds without effects', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-preview-bounds-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'éé');
    writeFileSync(join(dir, 'b.txt'), 'four');
    const limits = { maxEntries: 2, maxFileBytes: 4, maxTotalBytes: 8 };
    eq(testFileDirectory(dir, limits).preview?.count, 2);
    for (const [cap, code] of [
      [{ ...limits, maxEntries: 1 }, 'ENTRY_LIMIT'],
      [{ ...limits, maxFileBytes: 3 }, 'BYTE_LIMIT'],
      [{ ...limits, maxTotalBytes: 7 }, 'BYTE_LIMIT'],
      [{ ...limits, maxEntries: 0 }, 'BAD_LIMIT'],
    ] as const) {
      eq(testFileDirectory(dir, cap).code, code);
      const c = fileDiffCollector('preview-bounds', dir, 'SINGLE_SOURCE', cap);
      await rejects(() => c.poll(db, NOW, TEN), code);
      eq(await cursorGet(db, TEN, c.name), null);
    }
    eq((await getIntegrationHealth(db, TEN, 'preview-bounds', { configured: true })).inbox.total, 0);
    eq(testFileDirectory(join(dir, 'missing')).code, 'NOT_FOUND');
    eq(testFileDirectory(join(dir, 'a.txt')).code, 'NOT_DIRECTORY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: connection preview rejects root and entry symlinks like bounded polling', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-preview-links-'));
  const target = mkdtempSync(join(tmpdir(), 'vital-preview-target-'));
  try {
    const link = join(dir, 'linked');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const limits = { maxEntries: 5, maxFileBytes: 20, maxTotalBytes: 40 };
    for (const path of [dir, link]) {
      eq(testFileDirectory(path, limits).code, 'SYMLINK');
      const c = fileDiffCollector('links', path, 'SINGLE_SOURCE', limits);
      await rejects(() => c.poll(db, NOW, TEN), 'SYMLINK');
      eq(await cursorGet(db, TEN, c.name), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

T('FLOW-016: directory open and file read failures return sanitized structured connection errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-preview-read-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'read me');
    for (const method of ['opendirSync', 'openSync', 'readSync'] as const) {
      const stub = mock.method(fs, method, () => {
        throw Object.assign(new Error('private source details'), { code: 'EACCES' });
      });
      syncBuiltinESMExports();
      try {
        const result = testFileDirectory(dir);
        eq([result.ok, result.code], [false, 'NOT_READABLE']);
        eq(JSON.stringify(result).includes('private source details'), false);
      } finally {
        stub.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('FLOW-016: parseGitHubRepo parses owner/repo and handles prefixes/suffixes', async () => {
  eq(parseGitHubRepo('facebook/react'), ['facebook', 'react']);
  eq(parseGitHubRepo('github:facebook/react:releases'), ['facebook', 'react']);
  eq(parseGitHubRepo('  vercel/next.js  '), ['vercel', 'next.js']);
  eq(parseGitHubRepo('not-a-repo'), null);
  eq(parseGitHubRepo('/path/to/changelog'), null);
});

T('FLOW-016: testGitHubRepo tests API connectivity with status code mapping', async () => {
  // 200 OK with release preview
  const mockOkFetch = async () =>
    new Response(
      JSON.stringify([
        { tag_name: 'v1.0.0', name: 'Release 1.0', published_at: '2026-01-01T00:00:00Z' },
        { tag_name: 'v0.9.0', name: 'Beta 0.9', published_at: '2025-12-01T00:00:00Z' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const okResult = await testGitHubRepo('testowner', 'testrepo', 'fake-token', mockOkFetch as unknown as typeof fetch);
  eq(okResult.ok, true);
  eq(okResult.code, 'REACHABLE');
  eq(okResult.preview?.count, 2);
  eq(okResult.preview?.samples[0]?.name, 'v1.0.0');

  // 404 NOT_FOUND
  const mock404Fetch = async () => new Response('Not Found', { status: 404 });
  const notFound = await testGitHubRepo('testowner', 'missing', undefined, mock404Fetch as unknown as typeof fetch);
  eq(notFound.ok, false);
  eq(notFound.code, 'NOT_FOUND');

  // 403 RATE_OR_AUTH
  const mock403Fetch = async () => new Response('Forbidden', { status: 403 });
  const rateLimit = await testGitHubRepo('testowner', 'testrepo', undefined, mock403Fetch as unknown as typeof fetch);
  eq(rateLimit.ok, false);
  eq(rateLimit.code, 'RATE_OR_AUTH');

  // Network error
  const mockFailFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const unreachable = await testGitHubRepo(
    'testowner',
    'testrepo',
    undefined,
    mockFailFetch as unknown as typeof fetch,
  );
  eq(unreachable.ok, false);
  eq(unreachable.code, 'NETWORK_ERROR');
});

T('FLOW-016: parseActivationConfigInput preserves GitHub repo and sets sourceKind to github', async () => {
  const users = [
    {
      id: 'usr-1',
      tenant: 'corp',
      email: 'lead@corp.test',
      name: 'Team Lead',
      displayName: 'Team Lead',
      role: 'owner' as const,
      team: 'unassigned' as const,
      mustChangePassword: false,
      disabled: false,
      createdAt: NOW,
      lastLoginAt: null,
    },
  ];

  const config = parseActivationConfigInput(
    {
      scope: 'backend',
      sourcePath: 'facebook/react',
      artifactDir: 'data/artifacts',
      accountableOwnerId: 'usr-1',
      approverRole: 'owner',
      humanMinutesBudget: '60',
    },
    users,
    NOW,
    'corp',
  );

  eq(config.sourceKind, 'github');
  eq(config.sourcePath, 'facebook/react');
  eq(config.scope, 'backend');
});

// ------------------------------------------------------- ADR 0006 sidecar (ingest path)
T('ADR 0006: ingest appends near-duplicate but demotes the PRIOR claim to provisional', async () => {
  const { db, ledger } = await fresh();
  const { stageToInbox } = await import('../src/ingest/collectors.ts');

  const probe = {
    name: 'dup-probe',
    sourceTier: 'SINGLE_SOURCE' as const,
    extractor: 'test',
    extractorVersion: '1.0.0',
    poll: () => [],
  };

  // Event 1: the original signal.
  await stageToInbox(
    db,
    TEN,
    probe.name,
    [
      {
        source: 'test:dup:1',
        uri: 'https://example.test/pricing/1',
        fingerprint: 'fp-original-1',
        eventId: 'e1',
        revision: 'r1',
        occurredAt: NOW,
        summary: 'Competitor slashed enterprise pricing by twenty percent on Q3 renewals for large accounts',
        payload: { note: 'original' },
      },
    ],
    NOW,
  );
  const first = await ingestInboxBatch(db, ledger, TEN, probe, { owner: 'human:ana', scope: 'research', now: NOW });
  eq(first.claimIds.length, 1, 'first event ingested:');

  // Event 2: same fact, reworded — different identity (not exact dedupe) but a
  // near-duplicate by shingle similarity.
  await stageToInbox(
    db,
    TEN,
    probe.name,
    [
      {
        source: 'test:dup:2',
        uri: 'https://example.test/pricing/2',
        fingerprint: 'fp-paraphrase-2',
        eventId: 'e2',
        revision: 'r2',
        occurredAt: NOW,
        summary: 'Competitor cut enterprise pricing by twenty percent on Q3 renewals for big accounts',
        payload: { note: 'paraphrase' },
      },
    ],
    NOW,
  );
  const second = await ingestInboxBatch(db, ledger, TEN, probe, { owner: 'human:ana', scope: 'research', now: NOW });
  eq(second.claimIds.length, 1, 'near-duplicate is still appended (append-only, never suppressed):');

  const priorId = first.claimIds[0]!;
  const dupId = second.claimIds[0]!;

  // The PRIOR claim — the one that already represents the event — is demoted.
  const prior = await ledger.get(TEN, priorId);
  eq(prior?.provisional, true, 'prior claim demoted to provisional:');

  // The link points dup → prior as a search hint, not a truth assertion.
  const link = await db
    .prepare("SELECT 1 AS x FROM claim_links WHERE from_id = ? AND to_id = ? AND link = 'similar_to'")
    .get(dupId, priorId);
  eq(Boolean(link), true, 'similar_to link recorded dup → prior:');

  // Audited, so the demotion is never a silent mutation of company reality.
  const audit = await db
    .prepare("SELECT detail FROM audit_log WHERE tenant = ? AND action = 'SIMILAR_DEMOTE' AND target = ?")
    .get(TEN, priorId);
  eq(typeof (audit as { detail?: string } | undefined)?.detail, 'string', 'demotion audited:');

  // I6: the demoted claim can no longer reach high-tier reasoning context.
  const ctx = await ledger.contextFor(TEN, [priorId], NOW);
  eq(ctx.length, 0, 'demoted claim excluded from reasoning context:');

  // Unrelated follow-up signal: no demotion, no link.
  await stageToInbox(
    db,
    TEN,
    probe.name,
    [
      {
        source: 'test:dup:3',
        uri: 'https://example.test/other/3',
        fingerprint: 'fp-other-3',
        eventId: 'e3',
        revision: 'r3',
        occurredAt: NOW,
        summary: 'The design team shipped the new onboarding flow documentation today',
        payload: { note: 'unrelated' },
      },
    ],
    NOW,
  );
  const third = await ingestInboxBatch(db, ledger, TEN, probe, { owner: 'human:ana', scope: 'research', now: NOW });
  eq(third.claimIds.length, 1);
  // One demotion event, two audit rows by design: ledger.link() audits the
  // status change, the sidecar audits the detection (with the score). Assert
  // on distinct demoted claims so novel signals can't hide a second demotion.
  const demotes = await db
    .prepare("SELECT COUNT(DISTINCT target) AS n FROM audit_log WHERE tenant = ? AND action = 'SIMILAR_DEMOTE'")
    .get(TEN);
  eq((demotes as { n: number }).n, 1, 'exactly one demotion — novel signals untouched:');
});
