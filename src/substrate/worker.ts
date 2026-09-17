import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { claimOutbox, settleOutbox, type OutboxRow } from './scheduler.ts';
import { JcodeAdapter, LocalEchoAdapter, type HarnessAdapter } from './harness.ts';
import { runJob, type ExecutorJob } from '../aws/executor.ts';

export interface ApplicationWorkerOptions {
  tenant: string;
  workerId?: string;
  pollIntervalMs?: number;
  sweepIntervalMs?: number;
  outboxBatchSize?: number;
  dispatchRequests?: boolean;
  relayOutbox?: boolean;
  jcodeSocketPath?: string;
  adapter?: HarnessAdapter;
  signal?: AbortSignal;
  outboxHandler?: (row: OutboxRow) => Promise<void>;
  requestExecutor?: (
    req: CoordinationRequest,
  ) => Promise<{ claims?: string[]; cost?: Partial<CoordinationRequest['spent']> }>;
  sqsSender?: (job: ExecutorJob) => Promise<void>;
}

export interface WorkerStatus {
  running: boolean;
  workerId: string;
  tenant: string;
  uptimeSeconds: number;
  lastSweepAt: string | null;
  lastError: string | null;
  counters: {
    sweeps: number;
    readmitted: number;
    reclaimed: number;
    expired: number;
    outboxSettled: number;
    outboxFailed: number;
    requestsDispatched: number;
    requestsCompleted: number;
    requestsFailed: number;
  };
}

export interface WorkerTickResult {
  swept: {
    readmitted: number;
    reclaimed: number;
    expired: number;
  };
  outboxProcessed: number;
  outboxFailed: number;
  requestsDispatched: number;
  requestsCompleted: number;
  requestsFailed: number;
}

export interface ApplicationWorkerResult {
  workerId: string;
  tenant: string;
  stopped: boolean;
  ticks: number;
  counters: WorkerStatus['counters'];
  errors: string[];
}

export class ApplicationWorker {
  readonly workerId: string;
  readonly tenant: string;
  private readonly pollIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly outboxBatchSize: number;
  private readonly dispatchRequests: boolean;
  private readonly relayOutbox: boolean;
  private readonly adapter: HarnessAdapter;
  private readonly signal?: AbortSignal;
  private readonly outboxHandler?: (row: OutboxRow) => Promise<void>;
  private readonly requestExecutor?: (
    req: CoordinationRequest,
  ) => Promise<{ claims?: string[]; cost?: Partial<CoordinationRequest['spent']> }>;
  private readonly sqsSender?: (job: ExecutorJob) => Promise<void>;

  private stopped = false;
  private startedAt: number | null = null;
  private lastSweepMs = 0;
  private lastSweepAt: string | null = null;
  private lastError: string | null = null;
  private tickCount = 0;
  private errors: string[] = [];

  private counters: WorkerStatus['counters'] = {
    sweeps: 0,
    readmitted: 0,
    reclaimed: 0,
    expired: 0,
    outboxSettled: 0,
    outboxFailed: 0,
    requestsDispatched: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
  };

  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    options: ApplicationWorkerOptions,
  ) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('[worker:INVALID_OPTIONS] options are required');
    }
    if (typeof options.tenant !== 'string' || options.tenant.trim().length === 0 || options.tenant.includes('\0')) {
      throw new TypeError('[worker:INVALID_OPTIONS] tenant must be a nonempty string without NUL');
    }
    this.tenant = options.tenant.trim();
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
    this.outboxBatchSize = options.outboxBatchSize ?? 10;
    this.dispatchRequests = options.dispatchRequests ?? true;
    this.relayOutbox = options.relayOutbox ?? true;
    this.signal = options.signal;
    this.outboxHandler = options.outboxHandler;
    this.requestExecutor = options.requestExecutor;
    this.sqsSender = options.sqsSender;

    if (options.adapter) {
      this.adapter = options.adapter;
    } else if (options.jcodeSocketPath) {
      this.adapter = new JcodeAdapter(this.db, this.ledger, this.coord, { socketPath: options.jcodeSocketPath });
    } else {
      this.adapter = new LocalEchoAdapter(this.db, this.ledger, this.coord);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  status(): WorkerStatus {
    const uptime = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    return {
      running: !this.stopped && !(this.signal?.aborted ?? false),
      workerId: this.workerId,
      tenant: this.tenant,
      uptimeSeconds: uptime,
      lastSweepAt: this.lastSweepAt,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }

  /**
   * Run a single discrete tick of the worker: sweeps, outbox relay, and request dispatch.
   */
  async tick(now?: string): Promise<WorkerTickResult> {
    const nowMs = Date.parse(now ?? new Date().toISOString());
    const nowIso = new Date(nowMs).toISOString();

    const result: WorkerTickResult = {
      swept: { readmitted: 0, reclaimed: 0, expired: 0 },
      outboxProcessed: 0,
      outboxFailed: 0,
      requestsDispatched: 0,
      requestsCompleted: 0,
      requestsFailed: 0,
    };

    // 1. Recovery sweeps (interval-gated or first tick)
    if (this.lastSweepMs === 0 || nowMs - this.lastSweepMs >= this.sweepIntervalMs) {
      try {
        const readmitted = await this.coord.readmitDeferred(this.tenant, 25);
        const reclaimed = await this.coord.reclaimStale(this.tenant, nowMs, 25);
        const expired = await this.coord.expireStale(this.tenant, nowIso);

        this.lastSweepMs = nowMs;
        this.lastSweepAt = nowIso;
        this.counters.sweeps += 1;
        this.counters.readmitted += readmitted.length;
        this.counters.reclaimed += reclaimed.length;
        this.counters.expired += expired.length;

        result.swept.readmitted = readmitted.length;
        result.swept.reclaimed = reclaimed.length;
        result.swept.expired = expired.length;
      } catch (err) {
        const msg = `[worker:SWEEP_FAILED] ${String(err)}`;
        this.lastError = msg;
        this.errors.push(msg);
      }
    }

    // 2. Outbox relay
    if (this.relayOutbox && !this.stopped && !this.signal?.aborted) {
      try {
        const rows = await claimOutbox(this.db, this.outboxBatchSize, nowIso, {
          owner: this.workerId,
          leaseMs: 60_000,
        });
        for (const row of rows) {
          if (this.stopped || this.signal?.aborted) break;
          try {
            if (this.outboxHandler) {
              await this.outboxHandler(row);
            } else if (row.kind === 'executor-job' && this.sqsSender) {
              await this.sqsSender(row.payload as ExecutorJob);
            } else if (row.kind === 'executor-job') {
              await runJob(this.db, row.payload as ExecutorJob, process.env);
            }
            await settleOutbox(this.db, [row.id], 'DONE', { owner: this.workerId });
            this.counters.outboxSettled += 1;
            result.outboxProcessed += 1;
          } catch (err) {
            const retryDelayMs = Math.min(300_000, 1000 * Math.pow(2, row.attempts));
            const retryAt = new Date(nowMs + retryDelayMs).toISOString();
            try {
              await settleOutbox(this.db, [row.id], 'FAILED', { owner: this.workerId, retryAt });
            } catch {
              /* ignore settlement error */
            }
            this.counters.outboxFailed += 1;
            result.outboxFailed += 1;
            const msg = `[worker:OUTBOX_FAILED] row=${row.id} ${String(err)}`;
            this.lastError = msg;
            this.errors.push(msg);
          }
        }
      } catch (err) {
        const msg = `[worker:OUTBOX_CLAIM_FAILED] ${String(err)}`;
        this.lastError = msg;
        this.errors.push(msg);
      }
    }

    // 3. Request dispatch
    if (this.dispatchRequests && !this.stopped && !this.signal?.aborted) {
      try {
        const rows = (await this.db
          .prepare(
            `SELECT id, target_scope, goal, claim_refs, on_behalf_of, bid_json, state
             FROM requests
             WHERE tenant = ? AND state IN ('ADMITTED', 'ACCEPTED')
             ORDER BY created_at ASC LIMIT 5`,
          )
          .all(this.tenant)) as Record<string, unknown>[];

        for (const r of rows) {
          if (this.stopped || this.signal?.aborted) break;
          const reqId = String(r['id']);
          const targetScope = String(r['target_scope']);
          const goal = String(r['goal']);
          const onBehalfOf = String(r['on_behalf_of'] || 'agent:worker');
          const claimRefs = JSON.parse(String(r['claim_refs'] || '[]')) as string[];
          const bid = JSON.parse(String(r['bid_json'] || '{}')) as { dollars?: number; tokens?: number };

          let groundedClaimRefs = [...claimRefs];
          if (groundedClaimRefs.length === 0) {
            const clm = await this.ledger.append({
              tenant: this.tenant,
              subject: `task:${reqId}`,
              kind: 'OBSERVATION',
              statement: goal,
              confidence: 1.0,
              observedAt: nowIso,
              validFrom: nowIso,
              owner: onBehalfOf,
              scope: targetScope,
              authorType: 'system',
              provenance: {
                sourceUri: `vital://worker/${this.tenant}/${reqId}`,
                sourceTier: 'SYSTEM_OF_RECORD',
                extractor: 'vital-worker',
                extractorVersion: '1.0.0',
                retrievedAt: nowIso,
              },
            });
            groundedClaimRefs = [clm.id];
          }

          result.requestsDispatched += 1;
          this.counters.requestsDispatched += 1;

          try {
            if (this.requestExecutor) {
              const claimed = await this.coord.claimExecution(this.tenant, reqId, this.workerId, nowIso);
              const execRes = await this.requestExecutor(claimed);
              await this.coord.complete(this.tenant, reqId, {
                claims: execRes.claims ?? [],
                cost: execRes.cost ?? {},
              });
              this.counters.requestsCompleted += 1;
              result.requestsCompleted += 1;
            } else {
              const outcome = await this.adapter.run(this.tenant, reqId, {
                command: goal,
                claimRefs: groundedClaimRefs,
                onBehalfOf,
                maxDollars: bid.dollars ?? 1,
                maxTokens: bid.tokens ?? 10_000,
              });
              if (outcome.status === 'COMPLETED') {
                this.counters.requestsCompleted += 1;
                result.requestsCompleted += 1;
              } else {
                this.counters.requestsFailed += 1;
                result.requestsFailed += 1;
              }
            }
          } catch (err) {
            this.counters.requestsFailed += 1;
            result.requestsFailed += 1;
            const msg = `[worker:REQUEST_EXECUTION_FAILED] req=${reqId} ${String(err)}`;
            this.lastError = msg;
            this.errors.push(msg);
            try {
              await this.coord.fail(this.tenant, reqId, msg);
            } catch {
              /* ignore settlement error if already finalized */
            }
          }
        }
      } catch (err) {
        const msg = `[worker:REQUEST_DISPATCH_FAILED] ${String(err)}`;
        this.lastError = msg;
        this.errors.push(msg);
      }
    }

    this.tickCount += 1;
    return result;
  }

  /**
   * Run the worker loop continuously until stopped or aborted.
   */
  async run(): Promise<ApplicationWorkerResult> {
    this.startedAt = Date.now();
    this.stopped = false;

    while (!this.stopped && !(this.signal?.aborted ?? false)) {
      await this.tick();
      if (this.stopped || (this.signal?.aborted ?? false)) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollIntervalMs);
        if (this.signal) {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          this.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    return {
      workerId: this.workerId,
      tenant: this.tenant,
      stopped: this.stopped || (this.signal?.aborted ?? false),
      ticks: this.tickCount,
      counters: { ...this.counters },
      errors: [...this.errors],
    };
  }
}

/**
 * Run application worker entrypoint.
 */
export async function runApplicationWorker(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  options: ApplicationWorkerOptions,
): Promise<ApplicationWorkerResult> {
  const worker = new ApplicationWorker(db, ledger, coord, options);
  return worker.run();
}
