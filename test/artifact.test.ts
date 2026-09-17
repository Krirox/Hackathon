import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, fresh, rejects, TEN, NOW } from './helpers.ts';
import {
  ArtifactStoreError,
  FilesystemArtifactStore,
  fileDiffCollector,
  ingestEvents,
  readArtifact,
  storeArtifact,
  verifyArtifact,
  type RawEvent,
} from '../src/ingest/collectors.ts';

console.log('\n\x1b[1mArtifact storage — content addressing, bounded size, and read-back integrity\x1b[0m');

T('storeArtifact hashes the serialized envelope on disk: ref matches actual sha256', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-hash-'));
  const ev: RawEvent = {
    source: 'github:vital/test:commits',
    uri: 'https://example.com/commit/12345',
    fingerprint: 'collector-fingerprint-not-envelope-hash',
    occurredAt: NOW,
    summary: 'initial commit',
    payload: { author: 'alice', lines: 42 },
  };

  const ref = storeArtifact(db, ev, dir);
  // Ref must be a 64-char sha256 hex string
  eq(/^[0-9a-f]{64}$/.test(ref), true, 'ref is sha256 hex:');
  // It must NOT simply be the collector's fingerprint
  eq(ref !== ev.fingerprint, true, 'ref is computed from disk envelope, not collector fingerprint:');

  // Verify that the actual bytes on disk have the exact sha256 of ref
  const diskBytes = readFileSync(join(dir, ref));
  const expectedHash = createHash('sha256').update(diskBytes).digest('hex');
  eq(ref, expectedHash, 'ref matches sha256 of bytes on disk:');
});

T('round-trip recovery: readArtifact recovers exact uri, occurredAt, and payload', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-rt-'));
  const ev: RawEvent = {
    source: 'file:docs/spec.md',
    uri: 'file:///docs/spec.md',
    fingerprint: 'fp-spec-1',
    occurredAt: '2026-09-17T12:00:00.000Z',
    summary: 'updated spec with Section 4',
    payload: { bytes: 1400, content: '# Architecture Spec\nSection 4: Provenance' },
  };

  const ref = storeArtifact(db, ev, dir);
  const recovered = readArtifact(dir, ref);
  eq(recovered.uri, ev.uri);
  eq(recovered.occurredAt, ev.occurredAt);
  eq((recovered.payload as { content: string }).content, '# Architecture Spec\nSection 4: Provenance');
});

T('storeArtifact is idempotent: same event produces same ref without duplication', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-idem-'));
  const ev: RawEvent = {
    source: 'test:source',
    uri: 'https://example.com/ev1',
    fingerprint: 'fp-1',
    occurredAt: NOW,
    summary: 'same event twice',
    payload: { status: 'ok' },
  };

  const ref1 = storeArtifact(db, ev, dir);
  const ref2 = storeArtifact(db, ev, dir);
  eq(ref1, ref2, 'identical event returns identical ref:');
});

T('storeArtifact bounds size before write: refuses oversized payload with TOO_LARGE', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-size-'));
  const ev: RawEvent = {
    source: 'test:huge',
    uri: 'https://example.com/big',
    fingerprint: 'fp-huge',
    occurredAt: NOW,
    summary: 'huge payload',
    payload: { data: 'a'.repeat(200) },
  };

  let caught: Error | null = null;
  try {
    storeArtifact(db, ev, dir, 100);
  } catch (e) {
    caught = e as Error;
  }
  eq(caught !== null, true, 'threw error on oversized write:');
  eq(caught instanceof ArtifactStoreError, true, 'instance of ArtifactStoreError:');
  eq((caught as ArtifactStoreError).code, 'TOO_LARGE');
  eq(caught!.message.includes('[artifact:TOO_LARGE]'), true);
});

T('verifyArtifact detects tampered blobs and throws CORRUPT', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-tamper-'));
  const ev: RawEvent = {
    source: 'test:auth',
    uri: 'https://example.com/audit',
    fingerprint: 'fp-audit',
    occurredAt: NOW,
    summary: 'audit receipt',
    payload: { approved: true },
  };

  const ref = storeArtifact(db, ev, dir);
  // Sanity check: untampered blob verifies cleanly
  const verified = verifyArtifact(dir, ref);
  eq(verified.length > 0, true);

  // Tamper with the bytes on disk under the same filename
  writeFileSync(join(dir, ref), JSON.stringify({ approved: false, malicious: true }), 'utf8');

  let tamperError: Error | null = null;
  try {
    verifyArtifact(dir, ref);
  } catch (e) {
    tamperError = e as Error;
  }
  eq(tamperError !== null, true, 'tampered blob detected:');
  eq((tamperError as ArtifactStoreError).code, 'CORRUPT');
  eq(tamperError!.message.includes('[artifact:CORRUPT]'), true);
});

T('verifyArtifact throws NOT_FOUND for non-existent artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-nf-'));
  const fakeRef = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  let nfError: Error | null = null;
  try {
    verifyArtifact(dir, fakeRef);
  } catch (e) {
    nfError = e as Error;
  }
  eq(nfError !== null, true, 'non-existent artifact caught:');
  eq((nfError as ArtifactStoreError).code, 'NOT_FOUND');
  eq(nfError!.message.includes('[artifact:NOT_FOUND]'), true);
});

T('verifyArtifact refuses path traversal in ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-trav-'));
  const badRefs = ['../secret', 'foo/bar', '..\\win', '/etc/passwd'];

  for (const bad of badRefs) {
    let err: Error | null = null;
    try {
      verifyArtifact(dir, bad);
    } catch (e) {
      err = e as Error;
    }
    eq(err !== null, true, `traversal "${bad}" refused:`);
    eq((err as ArtifactStoreError).code, 'UNSAFE_REF');
    eq(err!.message.includes('[artifact:UNSAFE_REF]'), true);
  }
});

T('verifyArtifact enforces maxBytes on read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-art-readcap-'));
  const content = 'hello world bounded read';
  const ref = createHash('sha256').update(content).digest('hex');
  writeFileSync(join(dir, ref), content);

  let err: Error | null = null;
  try {
    verifyArtifact(dir, ref, 5); // cap at 5 bytes, file is 24 bytes
  } catch (e) {
    err = e as Error;
  }
  eq(err !== null, true, 'read past cap refused:');
  eq((err as ArtifactStoreError).code, 'TOO_LARGE');
  eq(err!.message.includes('[artifact:TOO_LARGE]'), true);
});

T('ingestEvents stores artifact whose rawArtifactRef verifies via verifyArtifact', async () => {
  const { db, ledger } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-ing-art-'));
  writeFileSync(join(dir, 'notes.md'), 'important documentation\n');
  const c = fileDiffCollector('notes', dir);
  const evs = await c.poll(db, NOW);
  eq(evs.length, 1);

  const artDir = join(dir, 'artifacts');
  const ids = await ingestEvents(db, ledger, TEN, c, evs, {
    owner: 'agent:archiver',
    scope: 'docs',
    now: NOW,
    artifactDir: artDir,
  });
  eq(ids.length, 1);

  const claim = await ledger.get(TEN, ids[0]!);
  eq(claim !== null, true);
  const ref = claim!.provenance.rawArtifactRef!;
  eq(typeof ref, 'string');
  eq(/^[0-9a-f]{64}$/.test(ref), true, 'claim rawArtifactRef is valid sha256:');

  // Verify the artifact directly using the claim ref
  const verifiedBytes = verifyArtifact(artDir, ref);
  const parsed = JSON.parse(verifiedBytes.toString('utf8')) as { uri: string; payload: { content?: string } };
  eq(parsed.uri, `file://${join(dir, 'notes.md')}`);
  eq(parsed.payload.content, 'important documentation\n', 'raw file content preserved in artifact payload:');
});

T('FilesystemArtifactStore: put, get, size cap, safe path, not-found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-fs-store-'));
  const store = new FilesystemArtifactStore(dir, 32);

  eq(store.put('item.txt', 'hello filesystem store'), 'item.txt');
  eq(store.get('item.txt').toString('utf8'), 'hello filesystem store');

  // Bounded write
  await rejects(async () => {
    store.put('big.txt', 'x'.repeat(33));
  }, 'TOO_LARGE');

  // Unsafe ref
  await rejects(async () => {
    store.put('../escape.txt', 'data');
  }, 'UNSAFE_REF');

  // Not found
  await rejects(async () => {
    store.get('missing.txt');
  }, 'NOT_FOUND');
});
