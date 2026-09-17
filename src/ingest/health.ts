import { existsSync, opendirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import {
  cursorGet,
  ensureInboxTable,
  type Collector,
  type FilePollLimits,
  type RawEvent,
} from './collectors.ts';

/**
 * FLOW-016: one observable contract for ingestion health — checkpoint, receipts,
 * freshness, actionable errors, and explicit separation of claim-populating
 * sync from downstream workflow starts.
 */

export type IntegrationState =
  | 'unconfigured'
  | 'disabled'
  | 'empty'
  | 'delayed'
  | 'rate_limited'
  | 'syncing'
  | 'failed'
  | 'ready'
  | 'rejected';

export interface InboxStats {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  total: number;
}

export interface ReceiptPreview {
  id: string;
  summary: string;
  status: string;
  createdAt: string;
  claimId: string | null;
}

export interface PollHealthRecord {
  at: string;
  ok: boolean;
  eventsFetched: number;
  staged: number;
  errorCode: string | null;
}

export interface IntegrationHealth {
  collector: string;
  state: IntegrationState;
  stateDetail: string;
  configured: boolean;
  disabled: boolean;
  lastPoll: PollHealthRecord | null;
  lastSuccessAt: string | null;
  checkpoint: string | null;
  freshnessSeconds: number | null;
  inbox: InboxStats;
  lastReceipt: ReceiptPreview | null;
  lastError: { code: string; detail: string } | null;
  permissionNote: string;
  /** Sync populates OBSERVATION claims; workflows are started separately. */
  actionsNote: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  code: string;
  detail: string;
  preview?: { count: number; samples: Array<{ name: string; summary: string }> };
}

export const INGEST_ACTIONS_NOTE =
  'Sync stages source events and, when settled by the worker, writes OBSERVATION claims to the ledger. It never mints FACT. Starting a release workflow is a separate action that consumes existing evidence.';

const FILE_PERMISSION_NOTE =
  'Vital reads the configured directory with the console process identity. The path must exist, be readable, and stay outside the artifact and database stores.';

const SERPER_PERMISSION_NOTE =
  'Serper credentials travel in the X-API-KEY header only — never stored in the ledger, logs, or request bodies. Set SERPER_API_KEY in the environment.';

const GITHUB_PERMISSION_NOTE =
  'GitHub release polling uses the public API. Private repositories require a token configured at the deployment boundary (not written to claims).';

/** Default staleness before a configured source is considered delayed (24h). */
export const DEFAULT_DELAY_MS = 86_400_000;

function healthKey(tenant: string, collector: string, field: string): string {
  return `ingest:health:${tenant}:${collector}:${field}`;
}

function disabledKey(tenant: string, collector: string): string {
  return `ingest:disabled:${tenant}:${collector}`;
}

async function metaGet(db: AsyncDb, key: string): Promise<string | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  return r ? String(r.value) : null;
}

async function metaSet(db: AsyncDb, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Parse a poll/ingest error into a stable code safe for operators. */
export function ingestErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const bracket = msg.match(/\[(?:ingest|ingest-worker):([A-Z0-9_]+)\]/);
  if (bracket) return bracket[1]!;
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg)) return 'RATE_LIMITED';
  if (/SERPER_KEY|API key missing/i.test(msg)) return 'UNCONFIGURED';
  if (/GITHUB_FETCH|SERPER_FETCH/i.test(msg)) return 'PROVIDER_ERROR';
  if (/BYTE_LIMIT|ENTRY_LIMIT|SYMLINK/i.test(msg)) return 'SOURCE_REJECTED';
  if (/INGEST_TIER/i.test(msg)) return 'TIER_REJECTED';
  return 'POLL_FAILED';
}

export function ingestErrorDetail(code: string): string {
  switch (code) {
    case 'UNCONFIGURED':
      return 'credentials or source path are missing — configure before syncing';
    case 'RATE_LIMITED':
      return 'provider rate limit — wait and retry; checkpoint is preserved';
    case 'PROVIDER_ERROR':
      return 'upstream provider rejected the request — verify credentials and reachability';
    case 'SOURCE_REJECTED':
      return 'source exceeded configured size or shape limits — fix the directory contents';
    case 'TIER_REJECTED':
      return 'collector attempted a ground tier — collectors write OBSERVATION only';
    case 'POLL_FAILED':
      return 'poll failed — inspect connection test output and retry';
    default:
      return 'ingestion error — retry after fixing the reported condition';
  }
}

export async function isCollectorDisabled(db: AsyncDb, tenant: string, collector: string): Promise<boolean> {
  return (await metaGet(db, disabledKey(tenant, collector))) === '1';
}

export async function setCollectorDisabled(
  db: AsyncDb,
  tenant: string,
  collector: string,
  disabled: boolean,
): Promise<void> {
  if (disabled) await metaSet(db, disabledKey(tenant, collector), '1');
  else await db.prepare('DELETE FROM meta WHERE key = ?').run(disabledKey(tenant, collector));
}

export async function recordPollHealth(
  db: AsyncDb,
  tenant: string,
  collector: string,
  record: PollHealthRecord,
): Promise<void> {
  await metaSet(db, healthKey(tenant, collector, 'lastPoll'), JSON.stringify(record));
  if (record.ok) await metaSet(db, healthKey(tenant, collector, 'lastSuccess'), record.at);
  else if (record.errorCode) {
    await metaSet(
      db,
      healthKey(tenant, collector, 'lastError'),
      JSON.stringify({ code: record.errorCode, detail: ingestErrorDetail(record.errorCode), at: record.at }),
    );
  }
}

export async function inboxStats(db: AsyncDb, tenant: string, collector: string | null): Promise<InboxStats> {
  await ensureInboxTable(db);
  if (!collector) return { pending: 0, claimed: 0, done: 0, failed: 0, total: 0 };
  const rows = (await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM ingest_inbox
       WHERE tenant = ? AND collector = ? GROUP BY status`,
    )
    .all(tenant, collector)) as { status: string; n: number }[];
  const out: InboxStats = { pending: 0, claimed: 0, done: 0, failed: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    out.total += n;
    if (row.status === 'PENDING') out.pending += n;
    else if (row.status === 'CLAIMED') out.claimed += n;
    else if (row.status === 'DONE') out.done += n;
    else if (row.status === 'FAILED') out.failed += n;
  }
  return out;
}

export async function lastInboxReceipt(
  db: AsyncDb,
  tenant: string,
  collector: string,
  scope: string | null,
): Promise<ReceiptPreview | null> {
  const row = (await db
    .prepare(
      `SELECT id, status, created_at, payload_json FROM ingest_inbox
       WHERE tenant = ? AND collector = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tenant, collector)) as { id: string; status: string; created_at: string; payload_json: string } | undefined;
  if (!row) return null;
  let summary = 'source event';
  try {
    const payload = JSON.parse(row.payload_json) as { summary?: string };
    if (payload.summary) summary = payload.summary;
  } catch {
    /* keep default */
  }
  const claim =
    scope
      ? ((await db
          .prepare(
            `SELECT id FROM claims WHERE tenant = ? AND scope = ? AND kind = 'OBSERVATION'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(tenant, scope)) as { id: string } | undefined)
      : undefined;
  return {
    id: String(row.id),
    summary,
    status: String(row.status),
    createdAt: String(row.created_at),
    claimId: claim ? String(claim.id) : null,
  };
}

export function deriveIntegrationState(input: {
  configured: boolean;
  disabled: boolean;
  stats: InboxStats;
  lastPoll: PollHealthRecord | null;
  lastSuccessAt: string | null;
  nowMs: number;
  delayMs: number;
}): { state: IntegrationState; detail: string } {
  if (!input.configured) {
    return { state: 'unconfigured', detail: 'choose a source on the setup page before syncing' };
  }
  if (input.disabled) {
    return { state: 'disabled', detail: 'integration is disabled — re-enable before polling' };
  }
  if (input.lastPoll && !input.lastPoll.ok && input.lastPoll.errorCode === 'RATE_LIMITED') {
    return {
      state: 'rate_limited',
      detail: 'provider rate limit — checkpoint preserved; retry after the window resets',
    };
  }
  if (input.stats.pending > 0 || input.stats.claimed > 0) {
    return {
      state: 'syncing',
      detail: `${input.stats.pending} pending · ${input.stats.claimed} in progress — worker is settling receipts`,
    };
  }
  if (input.stats.failed > 0 && input.stats.done === 0) {
    return {
      state: 'failed',
      detail: `${input.stats.failed} receipt${input.stats.failed === 1 ? '' : 's'} failed — fix the source and retry sync`,
    };
  }
  if (input.lastPoll && !input.lastPoll.ok && input.stats.total === 0) {
    const code = input.lastPoll.errorCode ?? 'POLL_FAILED';
    return { state: 'failed', detail: ingestErrorDetail(code) };
  }
  if (input.stats.done > 0) {
    if (
      input.lastSuccessAt &&
      input.stats.pending === 0 &&
      input.stats.claimed === 0 &&
      input.nowMs - Date.parse(input.lastSuccessAt) > input.delayMs &&
      input.stats.failed === 0
    ) {
      return {
        state: 'delayed',
        detail: `last successful sync was ${Math.round((input.nowMs - Date.parse(input.lastSuccessAt)) / 3600)}h ago — source may need a refresh`,
      };
    }
    return {
      state: 'ready',
      detail: `${input.stats.done} source item${input.stats.done === 1 ? '' : 's'} ingested into the ledger`,
    };
  }
  if (input.stats.total > 0 && input.stats.done === 0 && input.stats.failed > 0) {
    return { state: 'rejected', detail: 'events were received but could not become ledger evidence' };
  }
  if (input.lastPoll?.ok && input.lastPoll.eventsFetched === 0) {
    return {
      state: 'empty',
      detail: 'source is reachable but returned no new events — add or change source content, then sync',
    };
  }
  if (input.stats.total === 0) {
    return {
      state: 'empty',
      detail: 'source is configured but no events have arrived yet — add content or run sync',
    };
  }
  return { state: 'rejected', detail: 'events were received but none could be ingested as evidence' };
}

export async function getIntegrationHealth(
  db: AsyncDb,
  tenant: string,
  collector: string,
  opts: {
    configured: boolean;
    scope?: string | null;
    now?: string;
    delayMs?: number;
    permissionNote?: string;
  },
): Promise<IntegrationHealth> {
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const disabled = await isCollectorDisabled(db, tenant, collector);
  const stats = await inboxStats(db, tenant, collector);
  const lastPollRaw = await metaGet(db, healthKey(tenant, collector, 'lastPoll'));
  const lastPoll = lastPollRaw ? (JSON.parse(lastPollRaw) as PollHealthRecord) : null;
  const lastSuccessAt = await metaGet(db, healthKey(tenant, collector, 'lastSuccess'));
  const lastErrorRaw = await metaGet(db, healthKey(tenant, collector, 'lastError'));
  const lastError = lastErrorRaw ? (JSON.parse(lastErrorRaw) as { code: string; detail: string }) : null;
  const checkpoint = await cursorGet(db, tenant, collector);
  const freshnessSeconds =
    lastSuccessAt && Number.isFinite(Date.parse(lastSuccessAt))
      ? Math.max(0, Math.round((nowMs - Date.parse(lastSuccessAt)) / 1000))
      : null;
  const derived = deriveIntegrationState({
    configured: opts.configured,
    disabled,
    stats,
    lastPoll,
    lastSuccessAt,
    nowMs,
    delayMs: opts.delayMs ?? DEFAULT_DELAY_MS,
  });
  return {
    collector,
    state: derived.state,
    stateDetail: derived.detail,
    configured: opts.configured,
    disabled,
    lastPoll,
    lastSuccessAt,
    checkpoint,
    freshnessSeconds,
    inbox: stats,
    lastReceipt: await lastInboxReceipt(db, tenant, collector, opts.scope ?? null),
    lastError,
    permissionNote: opts.permissionNote ?? FILE_PERMISSION_NOTE,
    actionsNote: INGEST_ACTIONS_NOTE,
  };
}

/** Bounded directory listing for connection test / preview — no staging, no cursor. */
export function testFileDirectory(
  sourcePath: string,
  limits: FilePollLimits = { maxEntries: 20, maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 },
): ConnectionTestResult {
  const dir = resolve(sourcePath);
  if (!existsSync(dir)) {
    return { ok: false, code: 'NOT_FOUND', detail: `directory does not exist: ${dir}` };
  }
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return { ok: false, code: 'NOT_DIRECTORY', detail: 'path is not a directory' };
  } catch {
    return { ok: false, code: 'NOT_READABLE', detail: 'directory is not readable with the console process identity' };
  }
  const samples: Array<{ name: string; summary: string }> = [];
  let entries = 0;
  const directory = opendirSync(dir);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++entries > limits.maxEntries) {
        return {
          ok: false,
          code: 'ENTRY_LIMIT',
          detail: `directory exceeds the ${limits.maxEntries}-entry preview cap`,
        };
      }
      if (!entry.isFile()) continue;
      const size = statSync(join(dir, entry.name)).size;
      if (size > limits.maxFileBytes) {
        return {
          ok: false,
          code: 'BYTE_LIMIT',
          detail: `file "${entry.name}" exceeds the ${limits.maxFileBytes}-byte cap`,
        };
      }
      samples.push({ name: entry.name, summary: `${entry.name} (${size} bytes)` });
    }
  } finally {
    directory.closeSync();
  }
  if (samples.length === 0) {
    return {
      ok: true,
      code: 'EMPTY',
      detail: 'directory is readable but contains no files yet',
      preview: { count: 0, samples: [] },
    };
  }
  return {
    ok: true,
    code: 'REACHABLE',
    detail: `${samples.length} file${samples.length === 1 ? '' : 's'} readable — sync to stage events`,
    preview: { count: samples.length, samples: samples.slice(0, 5) },
  };
}

export function permissionNoteForCollector(collector: Collector): string {
  if (collector.extractor === 'serper-search') return SERPER_PERMISSION_NOTE;
  if (collector.extractor === 'github-releases') return GITHUB_PERMISSION_NOTE;
  return FILE_PERMISSION_NOTE;
}

/** Poll once and record health — used by worker and explicit connection tests. */
export async function pollCollectorWithHealth(
  db: AsyncDb,
  tenant: string,
  collector: Collector,
  now: string,
): Promise<{ events: RawEvent[]; staged: number; ok: boolean; errorCode: string | null }> {
  if (await isCollectorDisabled(db, tenant, collector.name)) {
    const code = 'DISABLED';
    await recordPollHealth(db, tenant, collector.name, {
      at: now,
      ok: false,
      eventsFetched: 0,
      staged: 0,
      errorCode: code,
    });
    throw new Error('[ingest:DISABLED] collector is disabled');
  }
  try {
    const events = await collector.poll(db, now, tenant);
    const staged = events.length;
    await recordPollHealth(db, tenant, collector.name, {
      at: now,
      ok: true,
      eventsFetched: events.length,
      staged,
      errorCode: null,
    });
    return { events, staged, ok: true, errorCode: null };
  } catch (err) {
    const code = ingestErrorCode(err);
    await recordPollHealth(db, tenant, collector.name, {
      at: now,
      ok: false,
      eventsFetched: 0,
      staged: 0,
      errorCode: code,
    });
    throw err;
  }
}
