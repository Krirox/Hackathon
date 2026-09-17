import { mkdtempSync, writeFileSync } from 'node:fs';
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
} from '../src/ingest/collectors.ts';
import { createHmacSurface, statementHashOf, verifyClaimEnvelope } from '../src/talk/surface.ts';

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
  const neu = await ledger.correctClaim(TEN, old.id, '$79', 'human:priya', DAY_LATER);
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
