import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, rejects } from './helpers.ts';
import {
  fileDiffCollector,
  gitHubReleasesCollector,
  ingestEvents,
  isNovel,
  serperSearchCollector,
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
