import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { AuditLogRow, ClaimLinkRow, ClaimRow, DecisionRow, OutcomeRow } from '../core/rows.ts';

/**
 * Data portability (TODO §8): the full Ledger export. Lock-in by value,
 * not by hostage-taking — and a sales asset against the black-box
 * objection. One JSON document: claims (with links), decisions (with
 * Context Bundles), outcomes, and the audit trail. Import is
 * intentionally absent: history is append-only, and merging two histories
 * is a research problem, not a file format.
 */

export interface LedgerExport {
  version: 1;
  tenant: string;
  exportedAt: string;
  claims: ClaimRow[];
  claimLinks: ClaimLinkRow[];
  decisions: DecisionRow[];
  outcomes: OutcomeRow[];
  audit: AuditLogRow[];
}

export interface ExportOptions {
  batchSize?: number;
  now?: string;
  asOfClaimSeq?: number;
  asOfAuditSeq?: number;
  kind?: ExportKind;
}

export async function exportLedger(
  db: AsyncDb,
  tenant: string,
  now?: string,
  opts: ExportOptions = {},
): Promise<LedgerExport> {
  const at = now ?? opts.now ?? new Date().toISOString();
  return db.transaction(async () => {
    const EXPORT_BATCH = opts.batchSize ?? 500;
    const maxClaimSeq =
      opts.asOfClaimSeq ??
      Number(
        (
          (await db
            .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM claims WHERE tenant = ? AND observed_at <= ?')
            .get(tenant, at)) as {
            m: number;
          }
        ).m,
      );
    const maxAuditSeq =
      opts.asOfAuditSeq ??
      Number(
        (
          (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM audit_log WHERE tenant = ?').get(tenant)) as {
            m: number;
          }
        ).m,
      );
    const pageAll = async <R>(sql: string, params: unknown[]): Promise<R[]> => {
      const out: R[] = [];
      for (let offset = 0; ; offset += EXPORT_BATCH) {
        const rows = (await db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, EXPORT_BATCH, offset)) as R[];
        out.push(...rows);
        if (rows.length < EXPORT_BATCH) break;
      }
      return out;
    };
    const claims = await pageAll<ClaimRow>(
      'SELECT * FROM claims WHERE tenant = ? AND observed_at <= ? AND seq <= ? ORDER BY seq ASC, id ASC',
      [tenant, at, maxClaimSeq],
    );
    const claimIds = new Set(claims.map((r) => String(r.id)));
    const links = await pageAll<ClaimLinkRow>(
      `SELECT l.from_id, l.to_id, l.link FROM claim_links l
        WHERE EXISTS (SELECT 1 FROM claims c WHERE c.id = l.from_id AND c.tenant = ? AND c.observed_at <= ? AND c.seq <= ?)
        ORDER BY l.from_id ASC, l.to_id ASC, l.link ASC`,
      [tenant, at, maxClaimSeq],
    );
    const decisions = await pageAll<DecisionRow>(
      'SELECT * FROM decisions WHERE tenant = ? AND signed_at <= ? ORDER BY signed_at ASC, id ASC',
      [tenant, at],
    );
    const outcomes = await pageAll<OutcomeRow>(
      'SELECT * FROM outcomes WHERE tenant = ? AND created_at <= ? ORDER BY created_at ASC, id ASC',
      [tenant, at],
    );
    const audit = await pageAll<AuditLogRow>('SELECT * FROM audit_log WHERE tenant = ? AND seq <= ? ORDER BY seq ASC', [
      tenant,
      maxAuditSeq,
    ]);
    return {
      version: 1,
      tenant,
      exportedAt: at,
      claims,
      claimLinks: links.filter((l) => claimIds.has(String(l.to_id))),
      decisions,
      outcomes,
      audit,
    };
  });
}

export interface StreamExportOptions {
  batchSize?: number;
  now?: string;
  asOfClaimSeq?: number;
  asOfAuditSeq?: number;
  kind?: ExportKind;
  /** Progress callback: start/batch/complete per section plus a final export event. */
  onProgress?: (event: ExportProgressEvent) => void;
}

/**
 * Progress event for large exports (FLOW-024). Totals are unknown until the
 * section completes (paged reads), so consumers should render `completed`
 * counts as they arrive and treat `phase: 'complete'` as the section total.
 */
export interface ExportProgressEvent {
  section: 'claims' | 'claimLinks' | 'decisions' | 'outcomes' | 'audit' | 'export';
  phase: 'start' | 'batch' | 'complete';
  /** Rows emitted so far in this section (final total when phase is complete). */
  completed: number;
  /** Attempts at this section including the current one (retry visibility). */
  attempts: number;
}

/**
 * Export retention/expiry policy (FLOW-004 / FLOW-024), surfaced on every
 * manifest: exports are operator-managed portable records with no automatic
 * expiry. Retention of the file, and of the erasure receipt that names it,
 * is the operator's job — `verifyErasureReceipt` re-checks on demand.
 */
export const EXPORT_RETENTION_POLICY =
  'operator-managed retained evidence: no automatic expiry, no automatic deletion; ' +
  'verify with verifyErasureReceipt (erasure files) or re-export (live ledger)';

export type ArchivalDeliveryStatus = 'verified' | 'missing' | 'mismatch' | 'unconfigured' | 'error';

export interface ArchivalDeliveryReport {
  status: ArchivalDeliveryStatus;
  bucket?: string;
  key?: string;
  expectedSha256?: string;
  detail: string;
}

export interface ArchivalProbe {
  /** Return the stored object's bytes, or null when the key does not exist. */
  read: (bucket: string, key: string) => Promise<Buffer | null>;
}

/**
 * Filesystem archival probe: treats a local directory as the archive shelf
 * (`<dir>/<key>`). Used by the CLI (`--archive-dir` / `VITAL_ARCHIVE_DIR`)
 * and by the backup/restore drill to prove a byte-compared read-back.
 */
export function filesystemArchivalProbe(dir: string): ArchivalProbe {
  return {
    read: async (_bucket, key) => {
      if (key.includes('..') || key.includes('/') || key.includes('\\')) return null;
      const full = join(dir, key);
      if (!existsSync(full)) return null;
      return readFileSync(full);
    },
  };
}

function sha256HexBytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Archival-delivery verification (FLOW-024): confirm an exported file
 * actually landed in the configured archive by reading the object back and
 * comparing sha256. When no bucket is configured the report is explicitly
 * `unconfigured` — never success. Bucket provisioning alone is not proof;
 * only a byte-compared read-back is `verified`.
 */
export async function verifyArchivalDelivery(
  localFile: string,
  opts: {
    bucket?: string;
    key?: string;
    probe?: ArchivalProbe;
    readLocal?: (path: string) => Buffer;
  } = {},
): Promise<ArchivalDeliveryReport> {
  const bucket = opts.bucket ?? process.env.VITAL_ARCHIVE_BUCKET ?? '';
  if (!bucket) {
    return {
      status: 'unconfigured',
      detail: 'no archival bucket configured (VITAL_ARCHIVE_BUCKET) — delivery is not claimed',
    };
  }
  const key = opts.key ?? process.env.VITAL_ARCHIVE_KEY ?? localFile.split(/[\\/]/).pop() ?? localFile;
  let expected: Buffer;
  try {
    expected = opts.readLocal ? opts.readLocal(localFile) : readFileSync(localFile);
  } catch (e) {
    return { status: 'error', bucket, key, detail: `cannot read local export "${localFile}": ${(e as Error).message}` };
  }
  if (!opts.probe) {
    return {
      status: 'error',
      bucket,
      key,
      detail: 'bucket is configured but no archive probe was supplied — cannot verify delivery without a read-back',
    };
  }
  let remote: Buffer | null;
  try {
    remote = await opts.probe.read(bucket, key);
  } catch (e) {
    return { status: 'error', bucket, key, detail: `archive read-back failed: ${(e as Error).message}` };
  }
  if (remote === null) {
    return { status: 'missing', bucket, key, detail: `object "${key}" not found in bucket "${bucket}"` };
  }
  const want = sha256HexBytes(expected);
  const got = sha256HexBytes(remote);
  if (want !== got) {
    return {
      status: 'mismatch',
      bucket,
      key,
      expectedSha256: want,
      detail: `archived bytes hash to ${got}, expected ${want} — object is missing, partial, or crossed`,
    };
  }
  return { status: 'verified', bucket, key, expectedSha256: want, detail: `object "${key}" exists and matches sha256 ${want}` };
}

export async function streamExportLedger(
  db: AsyncDb,
  tenant: string,
  sink: (chunk: string) => Promise<void> | void,
  opts: StreamExportOptions = {},
): Promise<{
  manifest: ExportManifest;
  counts: { claims: number; claimLinks: number; decisions: number; outcomes: number; audit: number };
}> {
  const at = opts.now ?? new Date().toISOString();
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 500, 2000));
  const kind = opts.kind ?? 'snapshot';

  return db.transaction(async () => {
    const emit = opts.onProgress;
    const attempts = new Map<string, number>();
    const progress = (section: ExportProgressEvent['section'], phase: ExportProgressEvent['phase'], completed: number): void => {
      if (!emit) return;
      attempts.set(section, (attempts.get(section) ?? 0) + (phase === 'start' ? 1 : 0));
      emit({ section, phase, completed, attempts: attempts.get(section) ?? 1 });
    };
    const maxClaimSeq =
      opts.asOfClaimSeq ??
      Number(
        (
          (await db
            .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM claims WHERE tenant = ? AND observed_at <= ?')
            .get(tenant, at)) as {
            m: number;
          }
        ).m,
      );
    const maxAuditSeq =
      opts.asOfAuditSeq ??
      Number(
        (
          (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM audit_log WHERE tenant = ?').get(tenant)) as {
            m: number;
          }
        ).m,
      );

    await sink(`{"version":1,"tenant":${JSON.stringify(tenant)},"exportedAt":${JSON.stringify(at)},"claims":[`);

    const artifactByRef = new Map<string, string[]>();
    const claimIds = new Set<string>();
    let claimCount = 0;
    let firstClaim = true;
    progress('claims', 'start', 0);
    for (let offset = 0; ; offset += batchSize) {
      const rows = (await db
        .prepare(
          'SELECT * FROM claims WHERE tenant = ? AND observed_at <= ? AND seq <= ? ORDER BY seq ASC, id ASC LIMIT ? OFFSET ?',
        )
        .all(tenant, at, maxClaimSeq, batchSize, offset)) as ClaimRow[];
      for (const r of rows) {
        claimCount++;
        claimIds.add(String(r.id));
        if (r.raw_ref) {
          const ref = String(r.raw_ref);
          const ids = artifactByRef.get(ref) ?? [];
          ids.push(String(r.id));
          artifactByRef.set(ref, ids);
        }
        await sink((firstClaim ? '' : ',') + JSON.stringify(r));
        firstClaim = false;
      }
      progress('claims', 'batch', claimCount);
      if (rows.length < batchSize) break;
    }
    progress('claims', 'complete', claimCount);

    await sink('],"claimLinks":[');
    let linkCount = 0;
    let firstLink = true;
    progress('claimLinks', 'start', 0);
    for (let offset = 0; ; offset += batchSize) {
      const rows = (await db
        .prepare(
          `SELECT l.from_id, l.to_id, l.link FROM claim_links l
           WHERE EXISTS (SELECT 1 FROM claims c WHERE c.id = l.from_id AND c.tenant = ? AND c.observed_at <= ? AND c.seq <= ?)
           ORDER BY l.from_id ASC, l.to_id ASC, l.link ASC
           LIMIT ? OFFSET ?`,
        )
        .all(tenant, at, maxClaimSeq, batchSize, offset)) as ClaimLinkRow[];
      for (const r of rows) {
        if (!claimIds.has(String(r.to_id))) continue;
        linkCount++;
        await sink((firstLink ? '' : ',') + JSON.stringify(r));
        firstLink = false;
      }
      progress('claimLinks', 'batch', linkCount);
      if (rows.length < batchSize) break;
    }
    progress('claimLinks', 'complete', linkCount);

    await sink('],"decisions":[');
    let decisionCount = 0;
    let firstDecision = true;
    progress('decisions', 'start', 0);
    for (let offset = 0; ; offset += batchSize) {
      const rows = (await db
        .prepare(
          'SELECT * FROM decisions WHERE tenant = ? AND signed_at <= ? ORDER BY signed_at ASC, id ASC LIMIT ? OFFSET ?',
        )
        .all(tenant, at, batchSize, offset)) as DecisionRow[];
      for (const r of rows) {
        decisionCount++;
        await sink((firstDecision ? '' : ',') + JSON.stringify(r));
        firstDecision = false;
      }
      progress('decisions', 'batch', decisionCount);
      if (rows.length < batchSize) break;
    }
    progress('decisions', 'complete', decisionCount);

    await sink('],"outcomes":[');
    let outcomeCount = 0;
    let firstOutcome = true;
    progress('outcomes', 'start', 0);
    for (let offset = 0; ; offset += batchSize) {
      const rows = (await db
        .prepare(
          'SELECT * FROM outcomes WHERE tenant = ? AND created_at <= ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
        )
        .all(tenant, at, batchSize, offset)) as OutcomeRow[];
      for (const r of rows) {
        outcomeCount++;
        await sink((firstOutcome ? '' : ',') + JSON.stringify(r));
        firstOutcome = false;
      }
      progress('outcomes', 'batch', outcomeCount);
      if (rows.length < batchSize) break;
    }
    progress('outcomes', 'complete', outcomeCount);

    await sink('],"audit":[');
    let auditCount = 0;
    let firstAudit = true;
    progress('audit', 'start', 0);
    for (let offset = 0; ; offset += batchSize) {
      const rows = (await db
        .prepare('SELECT * FROM audit_log WHERE tenant = ? AND seq <= ? ORDER BY seq ASC LIMIT ? OFFSET ?')
        .all(tenant, maxAuditSeq, batchSize, offset)) as AuditLogRow[];
      for (const r of rows) {
        auditCount++;
        await sink((firstAudit ? '' : ',') + JSON.stringify(r));
        firstAudit = false;
      }
      progress('audit', 'batch', auditCount);
      if (rows.length < batchSize) break;
    }
    progress('audit', 'complete', auditCount);

    await sink(']}');

    const artifacts: ArtifactOwnership[] = [...artifactByRef.entries()].map(([ref, ids]) => ({
      ref,
      claimIds: ids,
      shared: ids.length > 1,
    }));

    const counts = {
      claims: claimCount,
      claimLinks: linkCount,
      decisions: decisionCount,
      outcomes: outcomeCount,
      audit: auditCount,
    };

    const manifest: ExportManifest = {
      version: 1,
      tenant,
      exportedAt: at,
      kind,
      contents: EXPORT_CONTENTS[kind],
      omissions: [...EXPORT_OMISSIONS],
      counts,
      artifacts,
      note: EXPORT_NOTES[kind],
      retention: EXPORT_RETENTION_POLICY,
    };

    progress('export', 'complete', claimCount + linkCount + decisionCount + outcomeCount + auditCount);
    return { manifest, counts };
  });
}

export async function* exportLedgerStream(
  db: AsyncDb,
  tenant: string,
  opts: StreamExportOptions = {},
): AsyncGenerator<
  string,
  {
    manifest: ExportManifest;
    counts: { claims: number; claimLinks: number; decisions: number; outcomes: number; audit: number };
  }
> {
  let resultMeta:
    | {
        manifest: ExportManifest;
        counts: { claims: number; claimLinks: number; decisions: number; outcomes: number; audit: number };
      }
    | undefined;
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let error: unknown = null;

  void streamExportLedger(
    db,
    tenant,
    (chunk) => {
      queue.push(chunk);
      if (notify) {
        notify();
        notify = null;
      }
    },
    opts,
  ).then(
    (res) => {
      resultMeta = res;
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    },
    (err) => {
      error = err;
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    },
  );

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done) {
      if (error) throw error;
      return resultMeta!;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}

export type ExportKind = 'snapshot' | 'evidence-package' | 'backup-reference';

export interface ArtifactOwnership {
  ref: string;
  claimIds: string[];
  shared: boolean;
}

export interface ExportManifest {
  version: 1;
  tenant: string;
  exportedAt: string;
  kind: ExportKind;
  contents: string[];
  omissions: string[];
  counts: { claims: number; claimLinks: number; decisions: number; outcomes: number; audit: number };
  artifacts: ArtifactOwnership[];
  note: string;
  /** Retention/expiry policy for the exported file (FLOW-024). */
  retention: string;
}

export function collectArtifactOwnership(claims: { id: string; raw_ref: string | null }[]): ArtifactOwnership[] {
  const byRef = new Map<string, string[]>();
  for (const claim of claims) {
    if (claim.raw_ref == null || claim.raw_ref === '') continue;
    const ref = String(claim.raw_ref);
    const ids = byRef.get(ref) ?? [];
    ids.push(String(claim.id));
    byRef.set(ref, ids);
  }
  return [...byRef.entries()].map(([ref, claimIds]) => ({ ref, claimIds, shared: claimIds.length > 1 }));
}

const EXPORT_CONTENTS: Record<ExportKind, string[]> = {
  snapshot: ['claims', 'claimLinks', 'decisions', 'outcomes', 'audit', 'artifact-ownership-refs'],
  'evidence-package': ['claims', 'claimLinks', 'decisions', 'outcomes', 'audit', 'artifact-ownership-refs'],
  'backup-reference': ['manifest-only'],
};

const EXPORT_OMISSIONS = [
  'sessions, users, and credentials are never exported',
  'raw artifact bytes are not embedded — only content-addressed refs with ownership metadata',
  'external object stores and backups are out of scope',
  'other tenants are never included',
];

const EXPORT_NOTES: Record<ExportKind, string> = {
  snapshot:
    'point-in-time dashboard view of this tenant ledger; portable record, not a backup and not restorable by import',
  'evidence-package':
    'full portable ledger record for audit investigation; history stays append-only and import is unsupported',
  'backup-reference':
    'describes what a backup covers versus what this export covers; backup and restore are tested separately per docs/deployment.md',
};

export async function exportLedgerWithManifest(
  db: AsyncDb,
  tenant: string,
  kind: ExportKind,
  now?: string,
): Promise<{ export: LedgerExport; manifest: ExportManifest }> {
  const data = await exportLedger(db, tenant, now);
  const manifest: ExportManifest = {
    version: 1,
    tenant,
    exportedAt: data.exportedAt,
    kind,
    contents: EXPORT_CONTENTS[kind],
    omissions: [...EXPORT_OMISSIONS],
    counts: {
      claims: data.claims.length,
      claimLinks: data.claimLinks.length,
      decisions: data.decisions.length,
      outcomes: data.outcomes.length,
      audit: data.audit.length,
    },
    artifacts: collectArtifactOwnership(data.claims),
    note: EXPORT_NOTES[kind],
    retention: EXPORT_RETENTION_POLICY,
  };
  return { export: data, manifest };
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  requestId?: string;
  decisionId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  rows: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function queryAudit(db: AsyncDb, tenant: string, query: AuditQuery = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 500);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  const where = ['tenant = ?'];
  const args: unknown[] = [tenant];
  if (query.actor !== undefined) {
    where.push('actor = ?');
    args.push(query.actor);
  }
  if (query.action !== undefined) {
    where.push('action = ?');
    args.push(query.action);
  }
  if (query.from !== undefined) {
    where.push('at >= ?');
    args.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('at <= ?');
    args.push(query.to);
  }
  if (query.requestId !== undefined) {
    where.push("(target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    args.push(`%${escapeLike(query.requestId)}%`, `%${escapeLike(query.requestId)}%`);
  }
  if (query.decisionId !== undefined) {
    where.push("(target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    args.push(`%${escapeLike(query.decisionId)}%`, `%${escapeLike(query.decisionId)}%`);
  }
  const filter = where.join(' AND ');
  const totalRow = (await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${filter}`).get(...args)) as {
    n: number;
  };
  const rows = (await db
    .prepare(`SELECT * FROM audit_log WHERE ${filter} ORDER BY seq LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)) as AuditLogRow[];
  return { rows, total: Number(totalRow.n), limit, offset };
}

export interface AuditLinks {
  evidence: string[];
  authorization: string | null;
  receipt: string | null;
  outcome: string | null;
}

export function auditLinks(row: { target: string; detail: string | null; actor: string }): AuditLinks {
  const haystack = `${row.target} ${row.detail ?? ''}`;
  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const match of haystack.matchAll(/(claim|decision|request|clm|dec|req)[:_][A-Za-z0-9_-]+/g)) {
    const id = match[0];
    if (!seen.has(id)) {
      seen.add(id);
      evidence.push(id);
    }
  }
  const receipt = haystack.match(/receipt[:_][A-Za-z0-9_-]+/);
  const outcome = haystack.match(/outcome[:_][A-Za-z0-9_-]+/);
  return {
    evidence,
    authorization: row.actor && row.actor.length > 0 ? row.actor : null,
    receipt: receipt ? receipt[0] : null,
    outcome: outcome ? outcome[0] : null,
  };
}

export type ExportSectionStatus = 'pending' | 'completed' | 'failed';

export interface ExportSectionState {
  section: string;
  status: ExportSectionStatus;
  detail?: string;
  attempts: number;
}

export type ExportTrackerState = 'in-progress' | 'partial-failure' | 'completed' | 'failed' | 'expired';

export interface ExportTracker {
  update: (section: string, status: 'completed' | 'failed', detail?: string) => void;
  retry: (section: string) => void;
  expire: () => void;
  summary: () => { state: ExportTrackerState; sections: ExportSectionState[] };
}

export function createExportTracker(sections: string[]): ExportTracker {
  const states = new Map<string, ExportSectionState>(
    sections.map((section) => [section, { section, status: 'pending', attempts: 0 }]),
  );
  let expired = false;
  const get = (section: string): ExportSectionState => {
    const state = states.get(section);
    if (!state) throw new Error(`[export:UNKNOWN_SECTION] no export section "${section}"`);
    return state;
  };
  const derive = (): ExportTrackerState => {
    if (expired) return 'expired';
    const all = [...states.values()];
    if (all.every((entry) => entry.status === 'completed')) return 'completed';
    const failed = all.filter((entry) => entry.status === 'failed');
    if (failed.length === 0) return 'in-progress';
    if (failed.length === all.length) return 'failed';
    return 'partial-failure';
  };
  return {
    update: (section, status, detail) => {
      const state = get(section);
      state.status = status;
      state.attempts += 1;
      if (detail !== undefined) state.detail = detail;
      else delete state.detail;
    },
    retry: (section) => {
      const state = get(section);
      state.status = 'pending';
      state.attempts += 1;
      delete state.detail;
    },
    expire: () => {
      expired = true;
    },
    summary: () => ({ state: derive(), sections: [...states.values()] }),
  };
}
