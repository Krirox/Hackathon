import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { FilesystemArtifactStore } from '../ingest/collectors.ts';
import { S3ArtifactStore, type S3FetchFn } from '../ledger/s3store.ts';

// SnapshotStore: Postgres/meta (metadata) + content-addressed bytes (dedupe).
// 10 snapshots sharing one Docker digest store the digest row once + N refs —
// never N copies of the image. Backend: filesystem now, S3-compatible via
// VITAL_SNAPSHOT_DIR or the ledger s3store seam later; interface is async-ready.
export interface SnapshotBlobRef { hash: string; ref: string; bytes: number; deduped: boolean; }
export interface SnapshotStore {
  put(kind: string, body: string | Buffer): Promise<SnapshotBlobRef>;
  get(hash: string): Promise<Buffer | null>;
}
function defaultDir(): string {
  return process.env.VITAL_SNAPSHOT_DIR ?? 'data/snapshots';
}
export function contentHash(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
export class FsSnapshotStore implements SnapshotStore {
  private fs = new FilesystemArtifactStore(defaultDir());
  constructor(private db?: AsyncDb, private tenant?: string) {}
  // hash→ref index written on every put; this is what makes get(hash) work
  // without knowing the kind the blob was stored under.
  private async indexRef(hash: string, ref: string): Promise<void> {
    if (!this.db || !this.tenant) return;
    await this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`blobidx:${this.tenant}:${hash}`, ref).catch(() => {});
  }
  async put(kind: string, body: string | Buffer): Promise<SnapshotBlobRef> {
    const hash = contentHash(body);
    const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
    // Dedupe: same hash → same ref, record linkage only.
    if (this.db && this.tenant) {
      const hit = (await this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`blob:${this.tenant}:${kind}:${hash}`)) as { value: string } | undefined;
      if (hit) {
        const ref = String(hit.value);
        await this.indexRef(hash, ref);
        return { hash, ref, bytes, deduped: true };
      }
    }
    const ref = `${kind}-${hash.slice(0, 16)}`;
    try { this.fs.put(ref, body); } catch (e) {
      if ((e as Error).message.includes('TOO_LARGE')) throw new Error(`[snapshot:TOO_LARGE] ${kind} blob ${bytes}B over store cap`);
      throw e;
    }
    if (this.db && this.tenant) {
      await this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(`blob:${this.tenant}:${kind}:${hash}`, ref).catch(() => {});
    }
    await this.indexRef(hash, ref);
    return { hash, ref, bytes, deduped: false };
  }
  async get(hash: string): Promise<Buffer | null> {
    // The index lives in the tenant db; without one there is no hash→ref
    // mapping, so retrieval must go through getByRef with a known ref.
    if (!this.db || !this.tenant) return null;
    const row = (await this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`blobidx:${this.tenant}:${hash}`)) as { value: string } | undefined;
    if (!row) return null;
    return this.fs.get(String(row.value));
  }
  async getByRef(ref: string): Promise<Buffer> { return this.fs.get(ref); }
}
// S3 backend: same content-addressed contract, shared durable shelf across
// machines. Keys are the sha256 hex digest (S3 shelf requires 64-hex refs).
// No AWS SDK — SigV4 lives in ledger/s3store.ts, transport injected for tests.
export class S3SnapshotStore implements SnapshotStore {
  private s3: S3ArtifactStore;
  constructor(opts: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; endpoint?: string; fetchFn: S3FetchFn; maxBytes?: number }) {
    this.s3 = new S3ArtifactStore({
      bucket: opts.bucket, region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}) },
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      fetchFn: opts.fetchFn, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
  }
  async put(kind: string, body: string | Buffer): Promise<SnapshotBlobRef> {
    const hash = contentHash(body);
    const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
    // Idempotent by construction: same hash → same key; S3 PUT is a rewrite of
    // identical bytes, so no pre-check GET is needed (saves a round trip).
    await this.s3.put(hash, body);
    return { hash, ref: `${kind}-${hash.slice(0, 16)}:${hash}`, bytes, deduped: false };
  }
  async get(hash: string): Promise<Buffer | null> {
    try { return await this.s3.get(hash); } catch { return null; }
  }
}
const nodeS3Fetch: S3FetchFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as unknown as string });
  return { ok: res.ok, status: res.status, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
};
// Factory: S3 when VITAL_SNAPSHOT_BUCKET is set, filesystem otherwise.
// Same interface either way — callers never branch on backend.
export function snapshotStoreFromEnv(db?: AsyncDb, tenant?: string): SnapshotStore {
  const bucket = process.env.VITAL_SNAPSHOT_BUCKET;
  if (bucket) {
    return new S3SnapshotStore({
      bucket, region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
      ...(process.env.VITAL_S3_ENDPOINT ? { endpoint: process.env.VITAL_S3_ENDPOINT } : {}),
      fetchFn: nodeS3Fetch,
    });
  }
  return new FsSnapshotStore(db, tenant);
}
// Persist the durable layers of a snapshot; returns blob refs for the manifest.
// Docker images stored as digest refs (never image bytes); dep caches + workspace
// stored content-addressed so identical layers dedupe across snapshots.
export async function persistSnapshotLayers(
  store: SnapshotStore, o: { workspace: string; dependencies: string; dockerDigests: string[] },
): Promise<{ workspaceHash: string; depHash: string; dockerRefs: string[] }> {
  const w = await store.put('workspace', o.workspace);
  const d = await store.put('deps', o.dependencies);
  const dockerRefs: string[] = [];
  for (const digest of o.dockerDigests) {
    const r = await store.put('docker', digest); // digest string only: immutable ref, no image copy
    dockerRefs.push(r.hash);
  }
  return { workspaceHash: w.hash, depHash: d.hash, dockerRefs };
}
