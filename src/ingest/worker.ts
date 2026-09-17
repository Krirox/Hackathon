import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { ingestInboxBatch, type Collector } from './collectors.ts';

export interface IngestionWorkerOptions {
  tenant: string;
  scope: string;
  artifactDir: string;
  /** Total receipt attempts across both drains, including failures; integer 1–500, default 50. */
  maxReceipts?: number;
  signal?: AbortSignal;
}

export interface IngestionWorkerResult {
  owner: string;
  /** Successfully settled receipts, including deduplicated receipts that create no claim. */
  processed: number;
  /** Failed batch-of-one attempts; conservatively includes failures before a receipt is claimed. */
  failed: number;
  claimIds: string[];
  /** True if poll was attempted, whether or not it succeeded. */
  polled: boolean;
  /** True if cancellation was observed; reaching the receipt cap alone is not a stop. */
  stopped: boolean;
  /** Nonempty means non-success. Fixed error codes and attempt numbers only, never exception text. */
  errors: string[];
}

/**
 * One finite run for one tenant/collector. Drain durable work before polling
 * once, then drain again within the SAME attempt budget. Collectors own inbox
 * staging; returned poll payloads are never ingested directly. Even a failed
 * poll may have staged work, so the second drain still runs if budget permits.
 *
 * Cancellation is cooperative between receipts (and before poll), not a
 * rollback of in-flight work. Each receipt gets a fresh lease timestamp.
 * Invalid options reject before effects; operational failures are returned as
 * sanitized errors. The caller owns the database and all logging/lifecycle.
 */
export async function runIngestionWorker(
  db: AsyncDb,
  ledger: Ledger,
  collector: Collector,
  options: IngestionWorkerOptions,
): Promise<IngestionWorkerResult> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[ingest-worker:INVALID_OPTIONS] options are required');
  }
  for (const key of ['tenant', 'scope', 'artifactDir'] as const) {
    const value = options[key];
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
      throw new TypeError(`[ingest-worker:INVALID_OPTIONS] ${key} must be a nonempty string without NUL`);
    }
  }
  const maxReceipts = options.maxReceipts === undefined ? 50 : options.maxReceipts;
  if (!Number.isInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 500) {
    throw new RangeError('[ingest-worker:INVALID_OPTIONS] maxReceipts must be an integer from 1 to 500');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError('[ingest-worker:INVALID_OPTIONS] signal must be an AbortSignal');
  }
  const { tenant, scope, artifactDir, signal } = options;
  const result: IngestionWorkerResult = {
    owner: randomUUID(),
    processed: 0,
    failed: 0,
    claimIds: [],
    polled: false,
    stopped: false,
    errors: [],
  };
  const canContinue = (): boolean => {
    if (signal?.aborted) result.stopped = true;
    return !result.stopped && result.processed + result.failed < maxReceipts;
  };
  const drain = async (): Promise<void> => {
    while (canContinue()) {
      try {
        const batch = await ingestInboxBatch(db, ledger, tenant, collector, {
          batch: 1,
          owner: result.owner,
          scope,
          artifactDir,
          maxAttempts: 3,
          leaseMs: 60_000,
          now: new Date().toISOString(),
        });
        if (batch.receipts.length === 0) break;
        result.processed += batch.receipts.length;
        result.claimIds.push(...batch.claimIds);
      } catch {
        // Never copy exception messages: even validation and filesystem errors
        // can contain source URIs, filenames, or raw event values.
        result.failed += 1;
        result.errors.push(`[ingest-worker:RECEIPT_FAILED] attempt=${result.processed + result.failed}`);
      }
    }
  };

  await drain();
  if (canContinue()) {
    result.polled = true;
    try {
      await collector.poll(db, new Date().toISOString(), tenant);
    } catch {
      result.errors.push('[ingest-worker:POLL_FAILED]');
    }
    await drain();
  }
  if (signal?.aborted) result.stopped = true;
  return result;
}
