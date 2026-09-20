import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  constants,
  lstatSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { findNearDuplicate } from '../ledger/similar.ts';
import type { SourceTier } from '../core/types.ts';

/**
 * Phase 1 ingestion (TODO §1.2): read-only collectors, deterministic (L0).
 *
 *   poll() → RawEvent[]   idempotent, checkpointed (cursors in `meta`)
 *   ingestEvents()        maps events → OBSERVATION claims, never FACT
 *
 * Durability shape (why the inbox exists): a collector used to advance its
 * cursor as soon as it had fetched events, so a crash between fetch and
 * downstream ingestion lost the event, and dedup was a separate
 * read→append→write keyed by content hash alone. Now every poll stages
 * fetched events into the durable `ingest_inbox` FIRST (idempotent insert on
 * the UNIQUE(tenant, collector, source_event_id, revision) key) and advances
 * the cursor only after that insert commits. Crash between fetch and cursor:
 * the event survives in the inbox (no loss); retry re-stages the same
 * identity and collapses onto the existing row (no dup). Consumers claim a
 * batch with `claimInbox`, process it, and close it with `settleInbox`.
 *
 * Identity vs content, kept apart on purpose: `fingerprint` is the ARTIFACT
 * content hash (the key into `data/artifacts/<sha256>`, so every
 * `rawArtifactRef` resolves); it says what the bytes were. Event identity —
 * which occurrence of which source, at which revision — is
 * (tenant, collector, source_event_id, revision). Two deliveries of the same
 * occurrence share an identity even if re-serialized; two revisions of one
 * file share an identity prefix but differ in revision.
 *
 * No collector may write FACT directly — promotion from OBSERVATION is a
 * separate governed step (curation). Raw payloads land content-addressed in
 * `data/artifacts/<sha256>` so every `rawArtifactRef` resolves.
 */

export interface RawEvent {
  /** Stable source name, e.g. `github:1jehuang/jcode:releases`. */
  source: string;
  /** Canonical URI of the underlying occurrence. */
  uri: string;
  /**
   * Content fingerprint — the ARTIFACT content hash (store key), not the
   * event identity. Two revisions have different fingerprints; two
   * deliveries of one revision share both fingerprint AND identity.
   */
  fingerprint: string;
  /**
   * Stable per-source occurrence id, e.g. the GitHub release id or the
   * watched filename. Defaults to `uri` when the source names nothing else.
   */
  eventId?: string;
  /**
   * Occurrence revision, e.g. tag+published_at or the content hash at fetch
   * time. Defaults to `fingerprint` (every byte-change is a new revision).
   */
  revision?: string;
  occurredAt: string;
  summary: string;
  payload: unknown;
}

export interface Collector {
  readonly name: string;
  /** Observation tier for this source. Ground tiers are refused at ingest. */
  readonly sourceTier: SourceTier;
  readonly extractor: string;
  readonly extractorVersion: string;
  /**
   * Sync collectors return events; network collectors return a promise.
   * `tenant` scopes the durable inbox staging (identity is per-tenant);
   * callers that predate the inbox omit it and stage under 'default'.
   */
  poll(db: AsyncDb, now: string, tenant?: string): RawEvent[] | Promise<RawEvent[]>;
}

const stagingReports = new AsyncLocalStorage<{
  db: AsyncDb;
  tenant: string;
  collector: string;
  report: { staged: number };
}>();

export async function pollWithStagingReport(
  db: AsyncDb,
  tenant: string,
  collector: Collector,
  now: string,
  report: { staged: number },
): Promise<RawEvent[]> {
  return stagingReports.run({ db, tenant, collector: collector.name, report }, () => collector.poll(db, now, tenant));
}

const GROUND_TIERS: readonly SourceTier[] = ['SYSTEM_OF_RECORD', 'MEASURED'];

const fingerprintOf = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function metaGet(db: AsyncDb, key: string): Promise<string | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  return r ? String(r.value) : null;
}

async function metaSet(db: AsyncDb, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export async function cursorGet(db: AsyncDb, tenant: string, name: string): Promise<string | null> {
  const scoped = await metaGet(db, `ingest:cursor:${tenant}:${name}`);
  if (scoped !== null) return scoped;
  return metaGet(db, `ingest:cursor:${name}`);
}

export async function cursorSet(db: AsyncDb, tenant: string, name: string, value: string): Promise<void> {
  await metaSet(db, `ingest:cursor:${tenant}:${name}`, value);
}

// ------------------------------------------------------- durable inbox ----

/**
 * Durable inbox row: one staged occurrence. `status` moves
 * PENDING → CLAIMED → DONE (or FAILED, which a later claim may retry).
 * The UNIQUE key is the event identity — duplicate deliveries collapse onto
 * one receipt instead of fanning out twice.
 */
export interface InboxReceipt {
  id: string;
  tenant: string;
  collector: string;
  sourceEventId: string;
  revision: string;
  status: string;
  attempts: number;
  createdAt: string;
  event: RawEvent;
}

/** Event identity, split out from the artifact content hash (see RawEvent). */
export function eventIdentityOf(e: RawEvent): { sourceEventId: string; revision: string } {
  return { sourceEventId: e.eventId ?? e.uri, revision: e.revision ?? e.fingerprint };
}

/** Self-creating inbox (idempotent): safe on DBs migrated before F03. */
export async function ensureInboxTable(db: AsyncDb): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ingest_inbox (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, collector TEXT NOT NULL,
      source_event_id TEXT NOT NULL, revision TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      owner TEXT, claimed_at TEXT,
      UNIQUE (tenant, collector, source_event_id, revision))`,
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS ix_inbox_claim ON ingest_inbox(tenant, collector, status, created_at)`);
  // F10: lease recovery columns on databases created before the owner/lease
  // work. Additive ALTERs are guarded by pragma probes (idempotent re-run).
  if (db.engine === 'sqlite') {
    const cols = new Set(
      ((await db.prepare('SELECT name FROM pragma_table_info(?)').all('ingest_inbox')) as { name: string }[]).map((r) =>
        String(r.name),
      ),
    );
    if (!cols.has('owner')) await db.exec(`ALTER TABLE ingest_inbox ADD COLUMN owner TEXT`);
    if (!cols.has('claimed_at')) await db.exec(`ALTER TABLE ingest_inbox ADD COLUMN claimed_at TEXT`);
  } else {
    await db.exec(`ALTER TABLE ingest_inbox ADD COLUMN IF NOT EXISTS owner TEXT`);
    await db.exec(`ALTER TABLE ingest_inbox ADD COLUMN IF NOT EXISTS claimed_at TEXT`);
  }
}

/**
 * Stage fetched events into the inbox FIRST, before any cursor moves.
 * Idempotent per identity (`ON CONFLICT DO NOTHING`): returns the count of
 * newly staged rows, so a retried fetch reports 0 without duplicating.
 */
export async function stageToInbox(
  db: AsyncDb,
  tenant: string,
  collector: string,
  events: RawEvent[],
  now: string,
): Promise<number> {
  await ensureInboxTable(db);
  let inserted = 0;
  for (const e of events) {
    const { sourceEventId, revision } = eventIdentityOf(e);
    const r = await db
      .prepare(
        `INSERT INTO ingest_inbox
           (id, tenant, collector, source_event_id, revision, payload_json, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?)
         ON CONFLICT(tenant, collector, source_event_id, revision) DO NOTHING`,
      )
      .run(crypto.randomUUID(), tenant, collector, sourceEventId, revision, JSON.stringify(e), now);
    inserted += r.changes;
    const local = stagingReports.getStore();
    if (local?.db === db && local.tenant === tenant && local.collector === collector) {
      local.report.staged += r.changes;
    }
  }
  return inserted;
}

/**
 * F10: atomically mark the oldest claimable batch CLAIMED for one named
 * owner. Claimable = PENDING, retry-due FAILED (attempts < maxAttempts), or
 * CLAIMED with an EXPIRED lease (a crashed consumer's work becomes runnable
 * again). The ownership CAS is per-row and conditional on the status the
 * SELECT observed — under Postgres READ COMMITTED a concurrent relay's
 * committed claim makes our UPDATE match zero rows for that row, so two
 * consumers can never both own it. The winner is recorded (owner,
 * claimed_at) and `settleInbox` refuses settlement from any other owner,
 * so an expired owner cannot settle a row that has been re-claimed.
 */
export async function claimInbox(
  db: AsyncDb,
  tenant: string,
  collector: string,
  batch: number,
  opts: { owner?: string; now?: string; leaseMs?: number; maxAttempts?: number } = {},
): Promise<InboxReceipt[]> {
  if (!Number.isInteger(batch) || batch < 0 || batch > 500) throw new RangeError('[inbox:BAD_BATCH] expected 0–500');
  if (opts.maxAttempts !== undefined && (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1))
    throw new RangeError('[inbox:BAD_ATTEMPTS] expected a positive integer');
  await ensureInboxTable(db);
  const owner = opts.owner ?? 'inbox-worker';
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const leaseMs = opts.leaseMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 10;
  const now = new Date(nowMs).toISOString();
  const leaseCutoff = new Date(nowMs - leaseMs).toISOString();
  return db.transaction(async () => {
    // Exhausted crashed attempts remain inspectable, but cannot be reclaimed forever.
    await db
      .prepare(
        `UPDATE ingest_inbox SET status = 'FAILED'
      WHERE tenant = ? AND collector = ? AND status = 'CLAIMED'
        AND attempts >= ? AND claimed_at <= ?`,
      )
      .run(tenant, collector, maxAttempts, leaseCutoff);
    const rows = (await db
      .prepare(
        `SELECT * FROM ingest_inbox WHERE tenant = ? AND collector = ?
           AND attempts < ?
           AND (status = 'PENDING' OR status = 'FAILED'
                OR (status = 'CLAIMED' AND claimed_at IS NOT NULL AND claimed_at <= ?))
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(tenant, collector, maxAttempts, leaseCutoff, batch)) as Record<string, unknown>[];
    const out: InboxReceipt[] = [];
    for (const r of rows) {
      // Ownership CAS: only the PENDING/FAILED/lease-expired state the SELECT
      // observed converts. A concurrent relay that already claimed this row
      // (status now CLAIMED with a fresh claimed_at) matches zero rows here.
      const claimed = await db
        .prepare(
          `UPDATE ingest_inbox SET status = 'CLAIMED', attempts = attempts + 1,
             owner = ?, claimed_at = ?
           WHERE id = ? AND attempts < ?
             AND (status = 'PENDING' OR status = 'FAILED'
                  OR (status = 'CLAIMED' AND claimed_at IS NOT NULL AND claimed_at <= ?))`,
        )
        .run(owner, now, String(r['id']), maxAttempts, leaseCutoff);
      if (claimed.changes === 0) continue; // someone else won this row
      out.push({
        id: String(r['id']),
        tenant: String(r['tenant']),
        collector: String(r['collector']),
        sourceEventId: String(r['source_event_id']),
        revision: String(r['revision']),
        status: 'CLAIMED',
        attempts: Number(r['attempts']) + 1,
        createdAt: String(r['created_at']),
        event: JSON.parse(String(r['payload_json'])) as RawEvent,
      });
    }
    return out;
  });
}

/**
 * Close claimed rows: DONE is terminal, FAILED stays retryable by claim
 * policy (attempts-capped). F10: settlement is owner-checked — a consumer
 * whose lease expired and whose row was re-claimed by another worker CANNOT
 * settle it (the stale worker's late write would corrupt the new owner's
 * processing). Pass the owner received from `claimInbox`; the default
 * matches the default claim owner.
 */
export async function settleInbox(
  db: AsyncDb,
  ids: string[],
  outcome: 'DONE' | 'FAILED',
  opts: { owner?: string } = {},
): Promise<void> {
  await ensureInboxTable(db);
  await settleInboxRows(db, ids, outcome, opts.owner ?? 'inbox-worker');
}

// Schema initialization belongs before transactions acquire receipt locks.
async function settleInboxRows(db: AsyncDb, ids: string[], outcome: 'DONE' | 'FAILED', owner: string): Promise<void> {
  for (const id of ids) {
    const out = await db
      .prepare(`UPDATE ingest_inbox SET status = ? WHERE id = ? AND owner = ? AND status = 'CLAIMED'`)
      .run(outcome, id, owner);
    if (out.changes === 0) {
      const row = (await db.prepare('SELECT status, owner FROM ingest_inbox WHERE id = ?').get(id)) as
        { status: string; owner: string | null } | undefined;
      if (!row) continue; // row vanished: nothing to settle
      if (row.status === 'CLAIMED' && row.owner !== owner) {
        throw new Error(
          `[inbox:NOT_OWNER] row ${id} is claimed by ${row.owner ?? 'someone else'}: settlement refused`,
        );
      }
      // Already DONE/FAILED by a legitimate earlier settlement: idempotent no-op.
    }
  }
}

/**
 * Drains and settles a batch of staged inbox events into the Ledger.
 * Claims a batch of PENDING/retryable rows, converts each into an OBSERVATION
 * claim with an artifact ref and identity receipt, and settles the receipts
 * to 'DONE' (or 'FAILED' on error).
 */
export async function ingestInboxBatch(
  db: AsyncDb,
  ledger: Ledger,
  tenant: string,
  collector: Collector,
  opts: {
    batch?: number;
    owner?: string;
    scope?: string;
    now?: string;
    artifactDir?: string;
    leaseMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<{ receipts: InboxReceipt[]; claimIds: string[] }> {
  const receipts = await claimInbox(db, tenant, collector.name, opts.batch ?? 50, {
    owner: opts.owner,
    now: opts.now,
    leaseMs: opts.leaseMs,
    maxAttempts: opts.maxAttempts,
  });
  if (receipts.length === 0) {
    return { receipts: [], claimIds: [] };
  }
  let claimIds: string[];
  try {
    claimIds = await db.transaction(async () => {
      // The conditional write locks each receipt through persistence and settlement.
      // A reclaimed owner cannot append evidence for the replacement attempt.
      for (const receipt of receipts) {
        const fence = await db
          .prepare(
            `UPDATE ingest_inbox SET owner = owner
          WHERE id = ? AND tenant = ? AND collector = ? AND status = 'CLAIMED'
            AND owner = ? AND attempts = ?`,
          )
          .run(receipt.id, tenant, collector.name, opts.owner ?? 'inbox-worker', receipt.attempts);
        if (fence.changes !== 1) throw new Error('[inbox:NOT_OWNER] ingestion attempt was replaced');
      }
      const ids = await ingestEvents(
        db,
        ledger,
        tenant,
        collector,
        receipts.map((r) => r.event),
        {
          owner: opts.owner ?? 'inbox-worker',
          scope: opts.scope ?? 'engineering',
          now: opts.now ?? new Date().toISOString(),
          artifactDir: opts.artifactDir,
        },
      );
      await settleInboxRows(
        db,
        receipts.map((r) => r.id),
        'DONE',
        opts.owner ?? 'inbox-worker',
      );
      return ids;
    });
  } catch (err) {
    try {
      await settleInboxRows(
        db,
        receipts.map((r) => r.id),
        'FAILED',
        opts.owner ?? 'inbox-worker',
      );
    } catch {
      /* preserve primary err */
    }
    throw err;
  }
  return { receipts, claimIds };
}

/**
 * Content-addressed raw-artifact store.
 * Keyed by the SHA-256 content hash of the serialized envelope
 * (`{ uri, occurredAt, payload }`), NOT by event identity or collector fingerprint.
 * One revision, one blob; re-deliveries of identical bytes land on the same
 * path and are a no-op.
 * Bounded by maxBytes (default 25 MB) and safe against path traversal.
 * `dir` defaults to `data/artifacts`.
 */
export function storeArtifact(
  db: AsyncDb,
  event: RawEvent,
  dir = join('data', 'artifacts'),
  maxBytes: number = 25_000_000,
): string {
  const serialized = JSON.stringify({
    uri: event.uri,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    throw new ArtifactStoreError(
      'TOO_LARGE',
      `artifact for "${event.uri}" is ${bytes} bytes, over the ${maxBytes}-byte cap: refusing instead of storing an unbounded tree`,
    );
  }
  const ref = createHash('sha256').update(serialized, 'utf8').digest('hex');
  if (ref.startsWith('/') || ref.includes('..') || ref.includes('\\')) {
    throw new ArtifactStoreError('UNSAFE_REF', `artifact ref escapes the store: "${ref}"`);
  }
  mkdirSync(dir, { recursive: true });
  const full = join(dir, ref);
  try {
    statSync(full);
  } catch {
    writeFileSync(full, serialized, 'utf8');
  }
  void db;
  return ref;
}

/**
 * Read-back integrity verification for stored artifacts.
 * Accepts either (ref, dir?, maxBytes?) or (dir, ref, maxBytes?).
 * Reads the bytes, verifies the SHA-256 hash matches `ref`, and returns the verified Buffer.
 * Throws ArtifactStoreError:
 *   - UNSAFE_REF if ref contains traversal characters
 *   - NOT_FOUND if file does not exist
 *   - TOO_LARGE if file exceeds maxBytes
 *   - CORRUPT if file contents do not match ref
 */
export function verifyArtifact(dirOrRef: string, refOrDir?: string, maxBytes: number = 25_000_000): Buffer {
  let dir = join('data', 'artifacts');
  let ref: string;

  if (refOrDir === undefined) {
    ref = dirOrRef;
  } else if (/^[0-9a-f]{64}$/i.test(refOrDir)) {
    dir = dirOrRef;
    ref = refOrDir;
  } else if (/^[0-9a-f]{64}$/i.test(dirOrRef)) {
    ref = dirOrRef;
    dir = refOrDir;
  } else {
    dir = dirOrRef;
    ref = refOrDir;
  }

  if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
    throw new ArtifactStoreError('UNSAFE_REF', `artifact ref escapes the store: "${ref}"`);
  }

  const full = join(dir, ref);
  let size: number;
  try {
    size = statSync(full).size;
  } catch {
    throw new ArtifactStoreError('NOT_FOUND', `artifact "${ref}" not found in "${dir}"`);
  }

  if (size > maxBytes) {
    throw new ArtifactStoreError(
      'TOO_LARGE',
      `artifact "${ref}" is ${size} bytes, over the ${maxBytes}-byte cap: refusing instead of hashing an unbounded tree`,
    );
  }

  const bytes = readFileSync(full);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== ref) {
    throw new ArtifactStoreError(
      'CORRUPT',
      `artifact "${ref}" failed content-address verification (actual sha256: "${actualHash}"): refusing tampered blob`,
    );
  }

  return bytes;
}

/**
 * Read and decode a stored artifact envelope after verifying its integrity.
 */
export function readArtifact(
  dirOrRef: string,
  refOrDir?: string,
  maxBytes: number = 25_000_000,
): { uri: string; occurredAt: string; payload: unknown } {
  const bytes = verifyArtifact(dirOrRef, refOrDir, maxBytes);
  return JSON.parse(bytes.toString('utf8')) as { uri: string; occurredAt: string; payload: unknown };
}

/**
 * Bounded artifact store seam (F19, scoped): artifacts stay
 * filesystem-backed — an S3 store is out of scope and deliberately not
 * built here. This interface is the seam a future S3 implementation plugs
 * into; the filesystem implementation below is the only backend. The
 * maxBytes guard refuses loudly instead of hashing unbounded trees.
 */
export interface ArtifactStore {
  /** Persist bytes under `ref`; refuses with [artifact:TOO_LARGE] past maxBytes. */
  put(ref: string, body: string | Buffer): string;
  /** Read bytes back; refuses past maxBytes before hashing/returning. */
  get(ref: string): Buffer;
}

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[artifact:${code}] ${message}`);
  }
}

export class FilesystemArtifactStore implements ArtifactStore {
  constructor(
    private readonly dir: string = join('data', 'artifacts'),
    private readonly maxBytes: number = 25_000_000,
  ) {}

  put(ref: string, body: string | Buffer): string {
    const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
    // Bound the write before touching disk: an unbounded artifact tree is
    // how a cache becomes a foothold.
    if (bytes > this.maxBytes) {
      throw new ArtifactStoreError(
        'TOO_LARGE',
        `artifact "${ref}" is ${bytes} bytes, over the ${this.maxBytes}-byte cap: refusing instead of storing an unbounded tree`,
      );
    }
    if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
      throw new ArtifactStoreError('UNSAFE_REF', `artifact ref escapes the store: "${ref}"`);
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, ref), body);
    return ref;
  }

  get(ref: string): Buffer {
    if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
      throw new ArtifactStoreError('UNSAFE_REF', `artifact ref escapes the store: "${ref}"`);
    }
    const full = join(this.dir, ref);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      throw new ArtifactStoreError('NOT_FOUND', `artifact "${ref}" not found in "${this.dir}"`);
    }
    if (size > this.maxBytes) {
      throw new ArtifactStoreError(
        'TOO_LARGE',
        `artifact "${ref}" is ${size} bytes, over the ${this.maxBytes}-byte cap: refusing instead of hashing an unbounded tree`,
      );
    }
    return readFileSync(full);
  }
}

/**
 * Map raw events to OBSERVATION claims. Idempotent per (tenant, collector,
 * fingerprint); ground tiers refused; every claim carries its artifact ref.
 * The dedup key carries tenant AND collector identity: two tenants watching
 * one repo must not suppress each other, and the legacy global key is
 * honored on read so pre-fix receipts are not re-ingested.
 */
export async function ingestEvents(
  db: AsyncDb,
  ledger: Ledger,
  tenant: string,
  collector: Collector,
  events: RawEvent[],
  opts: { owner: string; scope: string; now: string; artifactDir?: string },
): Promise<string[]> {
  if ((GROUND_TIERS as readonly string[]).includes(collector.sourceTier)) {
    throw new Error(
      `[ingest:INGEST_TIER] collector "${collector.name}" declares ground tier ${collector.sourceTier}: collectors write OBSERVATION, promotion is governed`,
    );
  }
  const ids: string[] = [];
  for (const e of events) {
    const { sourceEventId, revision } = eventIdentityOf(e);
    // Identity-scoped receipt first (why: the old global `ingest:seen:<hash>`
    // let one tenant's fetch hide another's); the legacy key is read-only
    // back-compat so upgrades never double-ingest.
    const identityKey = `ingest:seen:${tenant}:${collector.name}:${sourceEventId}:${revision}`;
    const fingerprintKey = `ingest:seen:${tenant}:${collector.name}:${e.fingerprint}`;
    if (await metaGet(db, identityKey)) continue;
    const fingerprintReceipt = await metaGet(db, fingerprintKey);
    if (fingerprintReceipt) {
      await metaSet(db, identityKey, fingerprintReceipt);
      continue;
    }
    const legacyFingerprint = serperLegacyFingerprint(collector, e);
    if (
      (await metaGet(db, `ingest:seen:${e.fingerprint}`)) ||
      (legacyFingerprint && (await metaGet(db, `ingest:seen:${legacyFingerprint}`)))
    ) {
      await metaSet(db, fingerprintKey, 'migrated');
      await metaSet(db, identityKey, 'migrated');
      continue;
    }
    if (legacyFingerprint) {
      const legacyReceipt = await metaGet(db, `ingest:seen:${tenant}:${collector.name}:${legacyFingerprint}`);
      const prior =
        legacyReceipt && legacyReceipt !== 'migrated'
          ? ((await db
              .prepare("SELECT value_json FROM claims WHERE tenant = ? AND id = ? AND kind = 'OBSERVATION'")
              .get(tenant, legacyReceipt)) as { value_json: string | null } | undefined)
          : undefined;
      let sameContent: boolean;
      try {
        const value = JSON.parse(prior?.value_json ?? 'null') as { title?: string; snippet?: string } | null;
        const payload = e.payload as { title: string; snippet?: string };
        sameContent = value?.title === payload.title && (value?.snippet ?? '') === (payload.snippet ?? '');
      } catch {
        sameContent = false;
      }
      if (legacyReceipt && (legacyReceipt === 'migrated' || sameContent)) {
        await metaSet(db, fingerprintKey, legacyReceipt);
        await metaSet(db, identityKey, legacyReceipt);
        continue;
      }
    }
    const ref = storeArtifact(db, e, opts.artifactDir);
    const claimId = await db.transaction(async () => {
      const c = await ledger.append({
        tenant,
        subject: e.source,
        kind: 'OBSERVATION',
        statement: e.summary,
        value: e.payload === undefined ? undefined : (e.payload as Record<string, unknown>),
        confidence: 1,
        owner: opts.owner,
        scope: opts.scope,
        authorType: 'system',
        observedAt: e.occurredAt,
        validFrom: e.occurredAt,
        now: opts.now,
        provenance: {
          sourceUri: e.uri,
          sourceTier: collector.sourceTier,
          extractor: collector.extractor,
          extractorVersion: collector.extractorVersion,
          retrievedAt: opts.now,
          rawArtifactRef: ref,
        },
      });
      await metaSet(db, fingerprintKey, c.id);
      await metaSet(db, identityKey, c.id);
      return c.id;
    });
    // ADR 0006 sidecar: a near-duplicate of an existing claim is ingested
    // (append-only — nothing is suppressed) but the PRIOR claim it resembles
    // is demoted to provisional with a similar_to link, forcing human review
    // of which statement actually represents the event. The similarity score
    // is a search candidate, never a truth assertion.
    try {
      const dup = await findNearDuplicate(db, tenant, e.summary, { excludeIds: [claimId] });
      if (dup.hit) {
        await ledger.link(tenant, claimId, dup.hit.claimId, 'similar_to', { demoteSimilar: true });
        await db
          .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
          .run(
            tenant,
            'ingest',
            'SIMILAR_DEMOTE',
            dup.hit.claimId,
            `near-duplicate of new claim ${claimId} (score ${dup.hit.score.toFixed(2)}): provisional pending review`,
            opts.now,
          );
      }
    } catch (err) {
      // Similarity is advisory: a detector failure must never fail ingestion.
      // The claim stands as appended; review happens without the hint. But the
      // skip is recorded — a sidecar that fails silently is a sidecar nobody
      // knows is missing ("terminate loudly, never continue silently").
      try {
        await db
          .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
          .run(tenant, 'ingest', 'SIMILAR_SKIP', claimId, `detector error: ${String(err).slice(0, 200)}`, opts.now);
      } catch {
        // audit itself unavailable — nothing left to degrade into
      }
    }
    ids.push(claimId);
  }
  return ids;
}

function serperLegacyFingerprint(collector: Collector, event: RawEvent): string | null {
  if (collector.extractor !== 'serper-search' || !event.payload || typeof event.payload !== 'object') return null;
  const title = (event.payload as { title?: unknown }).title;
  return typeof title === 'string' ? fingerprintOf(`${event.uri}:${title}`) : null;
}

export interface FilePollLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** Read bounded, flat operator-controlled directories; symlinks are not inputs. */
export function boundedFiles(dir: string, limits: FilePollLimits): { name: string; body: string; bytes: number }[] {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError('[ingest:BAD_LIMIT] positive integers required');
  }
  const root = lstatSync(dir);
  if (root.isSymbolicLink()) throw new Error('[ingest:SYMLINK] source symlinks are not supported');
  if (!root.isDirectory()) throw new Error('[ingest:NOT_DIRECTORY] path is not a directory');
  const directory = opendirSync(dir);
  const files: { name: string; body: string; bytes: number }[] = [];
  let entries = 0;
  let total = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++entries > limits.maxEntries) throw new Error('[ingest:ENTRY_LIMIT] directory exceeds entry cap');
      if (entry.isSymbolicLink()) throw new Error('[ingest:SYMLINK] source symlinks are not supported');
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const before = lstatSync(path);
      if (before.isSymbolicLink()) throw new Error('[ingest:SYMLINK] source symlinks are not supported');
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        const after = lstatSync(path);
        if (
          after.isSymbolicLink() ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          after.dev !== stat.dev ||
          after.ino !== stat.ino
        )
          throw new Error('[ingest:SYMLINK] source changed during open');
        if (!stat.isFile() || stat.size > limits.maxFileBytes || total + stat.size > limits.maxTotalBytes)
          throw new Error('[ingest:BYTE_LIMIT] source exceeds byte cap');
        const cap = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
        const buffer = Buffer.alloc(cap + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = readSync(fd, buffer, size, buffer.length - size, null);
          if (read === 0) break;
          size += read;
        }
        if (size > cap) throw new Error('[ingest:BYTE_LIMIT] source grew beyond byte cap');
        total += size;
        files.push({ name: entry.name, body: buffer.subarray(0, size).toString('utf8'), bytes: size });
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    directory.closeSync();
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Watches files for new/changed content. Checkpoint: path → hash in `meta`. */
export function fileDiffCollector(
  name: string,
  dir: string,
  sourceTier: SourceTier = 'SINGLE_SOURCE',
  limits?: FilePollLimits,
): Collector {
  return {
    name,
    sourceTier,
    extractor: 'file-diff',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string, tenant = 'default'): Promise<RawEvent[]> {
      let prev: Record<string, string>;
      try {
        prev = JSON.parse((await cursorGet(db, tenant, name)) ?? '{}') as Record<string, string>;
      } catch {
        prev = {};
      }
      const next: Record<string, string> = {};
      const out: RawEvent[] = [];
      const files = limits
        ? boundedFiles(dir, limits)
        : readdirSync(dir)
            .filter((f) => statSync(join(dir, f)).isFile())
            .map((f) => ({ name: f, body: readFileSync(join(dir, f), 'utf8') }));
      for (const { name: f, body } of files) {
        const p = join(dir, f);
        const fp = fingerprintOf(body);
        next[p] = fp;
        if (prev[p] !== fp) {
          out.push({
            source: `${name}:${f}`,
            uri: `file://${p}`,
            fingerprint: fp,
            // Identity, distinct from the content hash: the occurrence is
            // "this path", the revision is "these bytes". A re-fetch of
            // unchanged bytes is the same revision (dedupes); an edit is a
            // new revision of the same occurrence (new inbox row).
            eventId: f,
            revision: fp,
            occurredAt: now,
            summary: `${f} ${prev[p] === undefined ? 'appeared' : 'changed'}`,
            payload: { bytes: body.length, content: body },
          });
        }
      }
      // Inbox BEFORE cursor (why: a crash here must leave the event staged
      // for retry, never silently dropped; the retry dedupes on identity).
      await stageToInbox(db, tenant, name, out, now);
      await cursorSet(db, tenant, name, JSON.stringify(next));
      return out;
    },
  };
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  body: string | null;
}

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Present on real fetch Responses; absent on old test stubs (treated as "no next page"). */
  headers?: { get(name: string): string | null } | Record<string, string | undefined> | Headers;
}>;

/**
 * Read the RFC 5988 `Link` header's `rel="next"` URL, across the header
 * shapes a fetch injection may carry (Headers instance, getter object, or
 * plain record). Null means "no explicit continuation".
 */
export function nextPageLinkOf(
  headers: { get(name: string): string | null } | Record<string, string | undefined> | Headers | undefined,
): string | null {
  if (!headers) return null;
  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    raw = (headers as { get(name: string): string | null }).get('link');
  } else {
    const rec = headers as Record<string, string | undefined>;
    raw = rec['link'] ?? rec['Link'];
  }
  if (!raw) return null;
  for (const part of raw.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*[^,]*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** GitHub releases + tags. `fetchFn` is injected so tests never hit network. */
export function gitHubReleasesCollector(
  owner: string,
  repo: string,
  fetchFn: FetchFn,
  sourceTier: SourceTier = 'PRIMARY',
): Collector {
  const name = `github:${owner}/${repo}:releases`;
  return {
    name,
    sourceTier,
    extractor: 'github-releases',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string, tenant = 'default'): Promise<RawEvent[]> {
      // Explicit continuation, never a fixed first page (why the old code
      // lost history: `?per_page=20` read page 1 and stopped, so release 21+
      // never entered the inbox). Follow `rel="next"` when the API offers
      // it; otherwise walk `?page=` while full pages keep arriving.
      const PER_PAGE = 100;
      const base = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}`;
      const releases: GitHubRelease[] = [];
      let url: string | null = `${base}&page=1`;
      let fetches = 0;
      while (url !== null && fetches < 25) {
        fetches += 1;
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`[ingest:GITHUB_FETCH] ${owner}/${repo} → ${res.status}`);
        const batch = (await res.json()) as GitHubRelease[];
        if (batch.length === 0) break;
        releases.push(...batch);
        const viaLink = nextPageLinkOf(res.headers);
        if (viaLink) {
          url = viaLink;
        } else if (batch.length >= PER_PAGE) {
          url = `${base}&page=${fetches + 1}`;
        } else {
          url = null;
        }
      }
      let cursor: { highId: number; revisions: Record<string, string> } = { highId: 0, revisions: {} };
      const rawCursor = await cursorGet(db, tenant, name);
      if (rawCursor) {
        if (rawCursor.startsWith('{')) {
          try {
            const parsed = JSON.parse(rawCursor) as { highId?: number; revisions?: Record<string, string> };
            cursor = {
              highId: typeof parsed.highId === 'number' ? parsed.highId : 0,
              revisions: parsed.revisions ?? {},
            };
          } catch {
            cursor = { highId: 0, revisions: {} };
          }
        } else {
          const legacyNum = Number(rawCursor);
          cursor = { highId: Number.isFinite(legacyNum) ? legacyNum : 0, revisions: {} };
        }
      }
      let high = cursor.highId;
      const nextRevisions: Record<string, string> = { ...cursor.revisions };
      const out: RawEvent[] = [];
      for (const r of [...releases].reverse()) {
        const rev = `${r.tag_name}:${r.published_at ?? ''}:${fingerprintOf(r.body ?? '').slice(0, 12)}`;
        const hadRev = cursor.revisions[String(r.id)];
        const isNew = r.id > cursor.highId;
        const isModified = hadRev !== undefined && hadRev !== rev;

        if (isNew || isModified) {
          high = Math.max(high, r.id);
          const summary = `${owner}/${repo} ${r.tag_name}: ${r.name ?? 'untitled'}`;
          out.push({
            source: name,
            uri: r.html_url,
            fingerprint: fingerprintOf(`${r.id}:${rev}`),
            // Identity vs content: the occurrence is the release id, the
            // revision is its tag/published/body content. Re-tagging or
            // updating notes of a release is a new revision of the same
            // occurrence (new inbox row), while re-fetching it is the same
            // identity (dedupes).
            eventId: String(r.id),
            revision: rev,
            occurredAt: r.published_at ?? now,
            summary,
            payload: { tag: r.tag_name, name: r.name, notes: (r.body ?? '').slice(0, 2000) },
          });
        }
        nextRevisions[String(r.id)] = rev;
      }
      // Prune nextRevisions if exceptionally large (keep up to 1000)
      const revisionKeys = Object.keys(nextRevisions);
      if (revisionKeys.length > 1000) {
        for (const k of revisionKeys.slice(0, revisionKeys.length - 1000)) {
          delete nextRevisions[k];
        }
      }
      // Inbox BEFORE cursor — same crash ordering as the file collector.
      await stageToInbox(db, tenant, name, out, now);
      await cursorSet(db, tenant, name, JSON.stringify({ highId: high, revisions: nextRevisions }));
      return out;
    },
  };
}

/**
 * L1 novelty-vs-Ledger: a signal is novel only if no live claim already
 * says the same thing about the same subject. Retired, stale, and
 * superseded rows do not count — history is not news. Answered by a SQL
 * EXISTS probe (ledger.hasLiveClaim), never by hydrating the subject's
 * full history into memory first.
 */
export async function isNovel(ledger: Ledger, tenant: string, subject: string, statement: string): Promise<boolean> {
  return !(await ledger.hasLiveClaim(tenant, subject, statement));
}

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
}

type SerperFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Serper.dev web search (TODO §6.2 L0). The API key is read at the runtime
 * boundary and travels in the request header only — it is never stored,
 * never logged, never written to the Ledger. `fetchFn` injected: tests
 * stub the network, production passes global fetch.
 */
export function serperSearchCollector(
  query: string,
  opts: { apiKey: string; fetchFn: SerperFetch; num?: number; sourceTier?: SourceTier },
): Collector {
  const name = `serper:${fingerprintOf(query).slice(0, 12)}`;
  return {
    name,
    sourceTier: opts.sourceTier ?? 'SINGLE_SOURCE',
    extractor: 'serper-search',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string, tenant = 'default'): Promise<RawEvent[]> {
      if (!opts.apiKey)
        throw new Error('[ingest:SERPER_KEY] Serper API key missing: set SERPER_API_KEY, never hardcode it');
      const res = await opts.fetchFn('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: opts.num ?? 10 }),
      });
      if (!res.ok) throw new Error(`[ingest:SERPER_FETCH] "${query}" → ${res.status}`);
      const body = (await res.json()) as { organic?: SerperResult[] };
      const out = (body.organic ?? []).map((r) => ({
        source: name,
        uri: r.link,
        fingerprint: fingerprintOf(JSON.stringify([r.link, r.title, r.snippet ?? ''])),
        eventId: r.link,
        revision: fingerprintOf(`${r.title}:${r.snippet ?? ''}`),
        occurredAt: r.date ?? now,
        summary: `${r.title}: ${(r.snippet ?? '').slice(0, 300)}`,
        payload: { title: r.title, snippet: r.snippet ?? '', date: r.date ?? null, query },
      }));
      await stageToInbox(db, tenant, name, out, now);
      await cursorSet(db, tenant, name, now);
      return out;
    },
  };
}

export interface StripeInvoice {
  id: string;
  customer?: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  status: string;
  created: number;
  subscription?: string | null;
}

export type StripeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Stripe invoice and billing collector for finance-agent.
 * Key travels in Authorization header only (never written to ledger or artifacts).
 * Ingests live invoice status, subscription revenue, and billing discrepancies.
 */
export function stripeInvoicesCollector(
  opts: {
    apiKey: string;
    fetchFn?: StripeFetch;
    limit?: number;
    sourceTier?: SourceTier;
  },
): Collector {
  const name = 'stripe:invoices';
  return {
    name,
    sourceTier: opts.sourceTier ?? 'PRIMARY',
    extractor: 'stripe-invoices',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string, tenant = 'default'): Promise<RawEvent[]> {
      if (!opts.apiKey) {
        throw new Error('[ingest:STRIPE_KEY] Stripe API key missing: set STRIPE_SECRET_KEY, never hardcode it');
      }
      const fetchFn = opts.fetchFn ?? ((url: string, init: { method: string; headers: Record<string, string> }) => fetch(url, init));
      const limit = opts.limit ?? 100;
      const url = `https://api.stripe.com/v1/invoices?limit=${limit}`;
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`[ingest:STRIPE_FETCH] Stripe API returned status ${res.status}`);
      const body = (await res.json()) as { data?: StripeInvoice[] };
      const invoices = body.data ?? [];

      const out: RawEvent[] = [];
      for (const inv of invoices) {
        const rev = `${inv.status}:${inv.amount_due}:${inv.amount_paid}`;
        const occurredAt = inv.created ? new Date(inv.created * 1000).toISOString() : now;
        const cur = (inv.currency ?? 'usd').toUpperCase();
        const due = (inv.amount_due / 100).toFixed(2);
        const summary = `Stripe invoice ${inv.id}: ${cur} ${due} (${inv.status})`;

        out.push({
          source: name,
          uri: `https://dashboard.stripe.com/invoices/${inv.id}`,
          fingerprint: fingerprintOf(`${inv.id}:${rev}`),
          eventId: inv.id,
          revision: rev,
          occurredAt,
          summary,
          payload: {
            id: inv.id,
            customer: inv.customer ?? null,
            amountDueCents: inv.amount_due,
            amountPaidCents: inv.amount_paid,
            currency: inv.currency,
            status: inv.status,
            subscription: inv.subscription ?? null,
          },
        });
      }

      await stageToInbox(db, tenant, name, out, now);
      await cursorSet(db, tenant, name, now);
      return out;
    },
  };
}

