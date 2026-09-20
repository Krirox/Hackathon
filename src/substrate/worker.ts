import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { claimOutbox, settleOutbox, type OutboxRow } from './scheduler.ts';
import { JcodeAdapter, LocalEchoAdapter, type HarnessAdapter } from './harness.ts';
import { requiresHumanApproval, validateExecutionAgainstSpec, type ExecutionSpec } from '../coord/execution-spec.ts';
import { enqueueExecutorJob, runJob, type ExecutorJob } from '../aws/executor.ts';
import { CognitiveRouter } from '../router/router.ts';
import { OrganizationalCompiler, mineCandidates } from '../compiler/compiler.ts';
import type { RoutingClass } from '../core/types.ts';
import { watchRun, type BuzzSurface } from '../talk/buzz.ts';
import { evaluateDispatch } from '../talk/enforce.ts';
import { checkKill } from '../gov/trust.ts';
import { runCrossModelEvidence } from '../compiler/transfer.ts';
import { BUZZ_STATUS_KIND } from '../talk/buzz-surface.ts';
import { loadDeliverableByRequest, persistDeliverableVersion } from '../wedge/deliverable-artifact.ts';

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
  /**
   * Where MODEL-tier work runs.
   *
   * `local` (default) executes it here through the harness adapter. `cloud`
   * writes a durable `executor-job` row instead, which the outbox relay delivers
   * — to SQS when a sender is configured, otherwise to the same Lambda container
   * handler in-process (`runJob`).
   *
   * This exists because the executor lane had a consumer and no producer:
   * `enqueueExecutorJob` was called from nothing but tests, so the Lambda path,
   * its Terraform, and the deployment doc described a lane that no product flow
   * could ever feed. The seam is opt-in because switching where approved work
   * executes is a deployment decision, not a refactor.
   */
  executorLane?: 'local' | 'cloud';
  router?: CognitiveRouter;
  compiler?: OrganizationalCompiler;
  enableLearningLoop?: boolean;
  /**
   * Harnesses a `transfer-test` job runs the card through.
   *
   * Separate from `adapter` because transfer evidence is about *breadth*: the
   * point is running the same procedure on a second harness whose model differs.
   * Defaults to the worker's own adapter, which is honest but narrow — with only
   * a test-baseline harness attached the run records `harness_smoke`, not
   * `cross_model`, and the cross-model promotion gate stays open. The worker
   * says so in its errors rather than letting the row imply otherwise.
   */
  transferAdapters?: HarnessAdapter[];
  /**
   * Optional Buzz surface for live progress and terminal summaries.
   * `channelFor` maps a requestId to channel/threadRoot (return null to
   * skip Buzz for that request). Relay failures are non-fatal: they are
   * counted in WorkerStatus.counters.buzzRelayFailures and logged as
   * worker errors but never stall or abort dispatch.
   */
  buzz?: {
    surface: BuzzSurface;
    channelFor(requestId: string, request?: CoordinationRequest): { channel: string; threadRoot?: string } | null;
  };
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
    /** MODEL-tier requests handed to the cloud executor lane instead of run here. */
    requestsQueuedForCloud: number;
    requestsCompleted: number;
    requestsFailed: number;
    driftChecks: number;
    cardsDemoted: number;
    tiersReverted: number;
    candidatesMined: number;
    /** Buzz relay failures (fire-and-forget; non-fatal to dispatch). */
    buzzRelayFailures: number;
  };
}

export interface WorkerTickResult {
  swept: {
    readmitted: number;
    reclaimed: number;
    expired: number;
  };
  learning?: {
    driftChecks: number;
    cardsDemoted: number;
    tiersReverted: RoutingClass[];
    candidatesMined: number;
  };
  outboxProcessed: number;
  outboxFailed: number;
  requestsDispatched: number;
  requestsQueuedForCloud: number;
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
  private readonly executorLane: 'local' | 'cloud';
  readonly router: CognitiveRouter;
  readonly compiler: OrganizationalCompiler;
  private readonly enableLearningLoop: boolean;
  private readonly buzz?: ApplicationWorkerOptions['buzz'];
  private readonly transferAdapters: HarnessAdapter[];

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
    requestsQueuedForCloud: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
    driftChecks: 0,
    cardsDemoted: 0,
    tiersReverted: 0,
    candidatesMined: 0,
    buzzRelayFailures: 0,
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
    this.executorLane = options.executorLane ?? 'local';
    this.router = options.router ?? new CognitiveRouter(this.db);
    this.compiler = options.compiler ?? new OrganizationalCompiler(this.db);
    this.enableLearningLoop = options.enableLearningLoop ?? true;
    this.buzz = options.buzz;

    if (options.adapter) {
      this.adapter = options.adapter;
    } else if (options.jcodeSocketPath) {
      this.adapter = new JcodeAdapter(this.db, this.ledger, this.coord, { socketPath: options.jcodeSocketPath });
    } else {
      this.adapter = new LocalEchoAdapter(this.db, this.ledger, this.coord);
    }
    this.transferAdapters = options.transferAdapters ?? [this.adapter];
  }

  /**
   * Run one queued cross-model transfer test and bank its evidence.
   *
   * This is the other half of the learning loop: `compile()` can now mint a
   * CANDIDATE card from the console, but a card only leaves quarantine with
   * transfer evidence, and the harnesses that produce it live on a worker. So the
   * console queues the run and this executes it — the same governed adapter path
   * an ordinary request takes, including kill switches, because it goes through
   * `adapter.run` rather than around it.
   *
   * Throws only for a malformed job. A harness failure is not an error here:
   * `runCrossModelEvidence` banks negative transfer results, and a failed test is
   * exactly the evidence the gate exists to record.
   */
  private async runTransferTest(row: OutboxRow, nowIso: string): Promise<void> {
    const payload = (row.payload ?? {}) as {
      cardId?: string;
      originScope?: string;
      targetScope?: string;
      command?: string;
      claimIds?: string[];
      maxDollars?: number;
      maxTokens?: number;
      onBehalfOf?: string;
    };
    const cardId = payload.cardId?.trim();
    if (!cardId) throw new Error('[worker:TRANSFER_TEST] job carries no cardId');
    const targetScope = payload.targetScope?.trim() || payload.originScope?.trim();
    if (!targetScope) throw new Error('[worker:TRANSFER_TEST] job carries no target scope');
    const originScope = payload.originScope?.trim() || targetScope;
    // Refused rather than run: a self-delegation fails inside the coordinator, and
    // that failure would be banked as a FAILED transfer — evidence the card would
    // carry for a configuration mistake. A malformed job belongs in the outbox's
    // failure state, not in the card's trust record.
    if (originScope === targetScope) {
      throw new Error(
        `[worker:TRANSFER_TEST] card=${cardId} origin and target scope are both ${targetScope}; a transfer must leave the card's own scope`,
      );
    }

    const runs = await runCrossModelEvidence(
      this.coord,
      this.compiler,
      this.tenant,
      cardId,
      this.transferAdapters,
      {
        originScope,
        targetScope,
        command: payload.command?.trim() || cardId,
        claimIds: payload.claimIds ?? [],
        onBehalfOf: payload.onBehalfOf?.trim() || `worker:${this.workerId}`,
        maxDollars: payload.maxDollars ?? 2,
        maxTokens: payload.maxTokens ?? 20_000,
        now: nowIso,
      },
    );

    // Baseline harnesses record `harness_smoke`, which does not satisfy the
    // cross-model gate. Say so here: a transfer test that ran but cannot promote
    // is a fact the operator needs, not a silent success.
    if (!runs.some((r) => r.kind === 'cross_model')) {
      const msg = `[worker:TRANSFER_SMOKE_ONLY] card=${cardId}: every attached harness is a test baseline, so the run recorded harness_smoke and the cross-model gate is still open`;
      this.lastError = msg;
      this.errors.push(msg);
    }
  }

  /**
   * Turn a completed run into a reviewable draft deliverable.
   *
   * Without this the last hop of the flagship loop was manual: an asynchronous run
   * produced a claim, a trace and a snapshot, and the human was then asked to
   * hand-draft the artifact before they could approve it. `ship.ts` drafts inline
   * for the synchronous path; the worker never did, so anything executed in the
   * background had no artifact to review and the ship loop could not close.
   *
   * Idempotent: an existing deliverable for the request is left untouched, so a
   * redelivered run cannot stack versions. Non-fatal: the execution itself
   * succeeded, so a drafting failure is reported through `errors` (visible in
   * worker status) instead of failing the request that already did its work.
   */
  private async draftDeliverable(input: {
    requestId: string;
    deliverableSchema: string;
    content: string;
    claimIds: string[];
    createdBy: string;
    now: string;
    isTestBaseline?: boolean;
  }): Promise<void> {
    try {
      // An echo/test-baseline adapter is not a deliverable: drafting its 
      // transcript would fill the review queue with the harness's own words.
      if (input.isTestBaseline) return;
      if (!input.content.trim()) {
        throw new Error('run completed with an empty transcript: nothing to draft');
      }
      const existing = await loadDeliverableByRequest(this.db, this.tenant, input.requestId);
      if (existing) return;
      await persistDeliverableVersion(this.db, this.ledger, {
        tenant: this.tenant,
        requestId: input.requestId,
        deliverableSchema: input.deliverableSchema,
        content: input.content,
        claimIds: input.claimIds,
        createdBy: input.createdBy,
        now: input.now,
      });
    } catch (err) {
      const msg = `[worker:DRAFT_FAILED] req=${input.requestId} ${String(err).slice(0, 200)}`;
      this.lastError = msg;
      this.errors.push(msg);
    }
  }

  /**
   * Deliver a governance notice (`automation-self-halt`, `canary-sla-miss`).
   *
   * These are the governance system's own alarm bells. The halt one is a freeze:
   * an operator who is not told about it cannot clear it, and the halt stands
   * until someone does. The canary one is a degraded scope where an agent failed
   * to notice a planted anomaly — the exact signal a supervisor must see. With no
   * Buzz surface bound this throws, which leaves the outbox row FAILED and
   * retrying rather than claiming a delivery that never happened. The durable
   * audit row and the console panels are the in-product record either way, so the
   * failure mode of this method is "loud", not "lost".
   */
  private async deliverNotice(row: OutboxRow): Promise<void> {
    const payload = (row.payload ?? {}) as { scope?: string; actionClass?: string; reason?: string };
    const scope = payload.scope ?? '*';
    const summary =
      row.kind === 'canary-sla-miss'
        ? `Honeytask canary missed: scope ${scope}: ${payload.reason ?? 'canary SLA miss'}`
        : `Automation frozen: scope ${scope}/${payload.actionClass ?? '*'}: ${payload.reason ?? 'self-halt'}`;
    if (!this.buzz) {
      throw new Error(`[worker:OUTBOX_UNDELIVERABLE] no Buzz surface bound: ${summary}`);
    }
    // Published as a status event rather than chat text, matching the status
    // beacon the health sweeps emit: a halt is a state, and a state belongs in a
    // kind that a client can filter for instead of in the conversation stream.
    await this.buzz.surface.publish({
      kind: BUZZ_STATUS_KIND,
      tags: [
        ['d', `${row.kind}:${scope}`],
        ['vital-notice', row.kind],
        ['vital-scope', scope],
        ['vital-action-class', payload.actionClass ?? '*'],
      ],
      content: summary,
    });
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

    // FLOW-023: durable heartbeat so readiness (and operators) can tell a
    // live worker from a silent one. Best-effort by design: a heartbeat
    // write must never fail the tick it reports on.
    try {
      const { recordWorkerHeartbeat } = await import('../gov/trust.ts');
      await recordWorkerHeartbeat(this.db, this.tenant, {
        workerId: this.workerId,
        now: nowIso,
        // Which executor is attached matters as much as being alive: the echo
        // harness completes requests without doing work, and the console can only
        // say so if the heartbeat carries it.
        adapter: this.adapter.name,
        baseline: this.adapter.isTestBaseline === true,
      });
    } catch {
      /* heartbeat is observability, not work */
    }

    const result: WorkerTickResult = {
      swept: { readmitted: 0, reclaimed: 0, expired: 0 },
      outboxProcessed: 0,
      outboxFailed: 0,
      requestsDispatched: 0,
      requestsQueuedForCloud: 0,
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

        // F17: Operating learning loop: drift checks, budget reversions, and candidate mining
        if (this.enableLearningLoop) {
          const promotedCards = (await this.db
            .prepare("SELECT id FROM skill_cards WHERE tenant = ? AND state = 'PROMOTED'")
            .all(this.tenant)) as { id: string }[];
          let demotedCount = 0;
          for (const card of promotedCards) {
            const driftRes = await this.compiler.checkDrift(this.tenant, card.id);
            if (driftRes.demoted) demotedCount += 1;
          }

          const revertedTiers = await this.router.revertBreachedTiers(this.tenant);
          const candidates = await mineCandidates(this.db, this.tenant);

          this.counters.driftChecks += promotedCards.length;
          this.counters.cardsDemoted += demotedCount;
          this.counters.tiersReverted += revertedTiers.length;
          this.counters.candidatesMined += candidates.length;

          result.learning = {
            driftChecks: promotedCards.length,
            cardsDemoted: demotedCount,
            tiersReverted: revertedTiers,
            candidatesMined: candidates.length,
          };
        }
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
            } else if (row.kind === 'automation-self-halt' || row.kind === 'canary-sla-miss') {
              await this.deliverNotice(row);
            } else if (row.kind === 'transfer-test') {
              // Enqueued by the console (`/console/learning/cards/:id/transfer-test`).
              // Handled here because the harnesses are attached to this process.
              await this.runTransferTest(row, nowIso);
            } else if (row.kind === 'scheduler-occurrence') {
              // Not a delivery: `recordSchedulerOccurrence` documents this row as
              // *the durable record* that a cron fired ("the in-memory registry
              // stays the scheduling state, the outbox is the durable record"). A
              // record has nothing to deliver, so acknowledging it here is the
              // whole job — named explicitly so the next reader does not have to
              // decide whether DONE was an oversight.
            } else {
              // Fail closed on a kind no handler owns. Settling it DONE reported a
              // delivery that never happened, which is how every
              // `automation-self-halt` row was swallowed: the governance system's
              // own alarm was marked "delivered" by falling through this branch,
              // with the DB as the only witness that it was not. A row nobody can
              // deliver must stay FAILED and retrying so it is visible.
              throw new Error(
                `outbox: no handler for kind "${row.kind}": refusing to settle it as delivered`,
              );
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
          const state = String(r['state']);
          const targetScope = String(r['target_scope']);
          const goal = String(r['goal']);
          const onBehalfOf = String(r['on_behalf_of'] || 'agent:worker');
          const claimRefs = JSON.parse(String(r['claim_refs'] || '[]')) as string[];
          const bid = JSON.parse(String(r['bid_json'] || '{}')) as {
            dollars?: number;
            tokens?: number;
            humanMinutes?: number;
          };

          const request = await this.coord.get(this.tenant, reqId);
          if (!request) continue;
          if (state === 'ADMITTED' && requiresHumanApproval(request)) continue;

          // Room-config enforcement: the autonomy tier and budget ceilings an
          // operator set in the wizard bind here, in the dispatch path — not
          // just in display code. A refusal is recorded as a worker error so
          // the operator can see why work is not moving.
          const roomDecision = await evaluateDispatch(this.db, this.tenant, request);
          if (!roomDecision.allowed) {
            const msg = `[worker:ROOM_GATE] req=${reqId} scope=${targetScope} code=${roomDecision.code} ${roomDecision.reason}`;
            if (!this.errors.includes(msg)) {
              this.errors.push(msg);
              this.lastError = msg;
            }
            continue;
          }

          let command = goal;
          let groundedClaimRefs = [...claimRefs];
          let approvedSpec: ExecutionSpec | undefined;
          const approvalDecision = await this.ledger.getDecisionByRequest(this.tenant, reqId);
          if (state === 'ACCEPTED' && approvalDecision) {
            const bound = await validateExecutionAgainstSpec(
              this.ledger,
              this.coord,
              this.tenant,
              reqId,
              { command: goal, claimRefs: groundedClaimRefs, decisionId: approvalDecision.id },
              nowIso,
            );
            approvedSpec = bound.spec;
            command = bound.spec.command;
            groundedClaimRefs = bound.spec.evidence.map((e) => e.id);
          } else if (state === 'ACCEPTED' && requiresHumanApproval(request)) {
            continue;
          }
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

          // F17: Query compiler for executable card and cognitive router for dispatch tier
          const taskType = 'engineering.implement';
          const intent = `code:${request.deliverableSchema}`;
          const candidateCard = await this.compiler.executableFor(this.tenant, intent, targetScope, this.adapter.name);
          const routeDecision = await this.router.route({
            tenant: this.tenant,
            taskType,
            scope: targetScope,
            actionClass: 'ACT_REVERSIBLE',
            importance: 0.3,
            reversible: true,
            skillCard: candidateCard
              ? {
                  id: candidateCard.id,
                  state: candidateCard.state,
                  validatedAtTier: candidateCard.validatedAtTier,
                  scopeRoles: candidateCard.scopeRoles,
                  scopeModels: candidateCard.originModels,
                }
              : null,
            model: this.adapter.name,
            now: nowIso,
          });

          // Conservative fail-up: if router decided HUMAN, and request lacks approval, do not execute autonomously
          if (routeDecision.tier === 'HUMAN' && state === 'ADMITTED') {
            continue;
          }

          // Cloud execution lane: Lambda's handler is documented as REFLEX/
          // WORKFLOW + short MODEL work, and a MODEL-tier request is exactly what
          // it is for. The row is written before anything is claimed, so a crash
          // between the decision and the delivery loses nothing, and only the
          // cloud executor claims the request — never both.
          if (this.executorLane === 'cloud' && routeDecision.tier === 'MODEL') {
            try {
              await enqueueExecutorJob(
                this.db,
                this.tenant,
                {
                  tenant: this.tenant,
                  requestId: reqId,
                  prompt: command,
                  claimRefs: groundedClaimRefs,
                  onBehalfOf,
                },
                { now: nowIso },
              );
              result.requestsDispatched += 1;
              result.requestsQueuedForCloud += 1;
              this.counters.requestsDispatched += 1;
              this.counters.requestsQueuedForCloud += 1;
            } catch (err) {
              // A lane that cannot queue is a lane that silently does nothing; a
              // failure to write the row is reported like any other worker error.
              const msg = `[worker:CLOUD_ENQUEUE_FAILED] req=${reqId} ${(err as Error).message}`;
              this.lastError = msg;
              this.errors.push(msg);
              result.requestsFailed += 1;
              this.counters.requestsFailed += 1;
            }
            continue;
          }

          result.requestsDispatched += 1;
          this.counters.requestsDispatched += 1;

          try {
            if (this.requestExecutor) {
              // A custom executor never passes through a harness adapter, and the
              // adapter is where the kill check normally happens (harness.ts).
              // Guarding before the claim keeps one safety property across both
              // execution paths: an engaged stop refuses the work before it is
              // claimed, and therefore before it can spend.
              if (
                (await checkKill(this.db, this.tenant, targetScope, '*')) ||
                (await checkKill(this.db, this.tenant, '*', '*'))
              ) {
                await this.coord.fail(
                  this.tenant,
                  reqId,
                  `kill switch engaged for scope "${targetScope}"`,
                );
                result.requestsFailed += 1;
                this.counters.requestsFailed += 1;
                continue;
              }
              const claimed = await this.coord.claimExecution(this.tenant, reqId, this.workerId, nowIso);
              let execSuccess = false;
              try {
                const execRes = await this.requestExecutor(claimed);
                await this.coord.complete(this.tenant, reqId, {
                  claims: execRes.claims ?? [],
                  cost: execRes.cost ?? {},
                });
                execSuccess = true;
                this.counters.requestsCompleted += 1;
                result.requestsCompleted += 1;
              } finally {
                await this.router.recordCalibrationSample(
                  this.tenant,
                  taskType,
                  routeDecision.tier,
                  this.adapter.name,
                  execSuccess,
                  nowIso,
                );
                // Ensure balanced trace exists for custom executor
                const existingTr = (await this.db
                  .prepare('SELECT id FROM traces WHERE tenant = ? AND request_id = ?')
                  .get(this.tenant, reqId)) as { id: string } | undefined;
                if (!existingTr) {
                  await this.db
                    .prepare(
                      `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    )
                    .run(
                      `tr_${randomUUID()}`,
                      this.tenant,
                      reqId,
                      targetScope,
                      taskType,
                      intent,
                      JSON.stringify({ executor: 'requestExecutor' }),
                      routeDecision.tier,
                      execSuccess ? 'SUCCESS' : 'FAILURE',
                      '{}',
                      routeDecision.tier === 'WORKFLOW' ? (candidateCard?.id ?? null) : null,
                      routeDecision.shadow ? 0.5 : 0.9,
                      nowIso,
                    );
                }
              }
            } else {
              const boundSkillCardId = routeDecision.tier === 'WORKFLOW' ? (candidateCard?.id ?? null) : null;
              // Team microVM: one isolated workspace per scope, many jcode
              // sessions multiplex inside. COMPLETED runs snapshot the workspace
              // against the real artifact ref; FAILED/DENIED runs and adapter
              // throws destroy it — a tainted workspace must never become the
              // resume state for the next provision. Budget-exhausted runs leave
              // the workspace untouched. Test-baseline adapters skip the VM
              // lifecycle entirely.
              const needsVm = !this.adapter.isTestBaseline;
              let vm: { workingDir: string } | null = null;
              if (needsVm) {
                const { provisionTeamVm } = await import('./vm.ts');
                vm = await provisionTeamVm(this.db, this.tenant, targetScope, nowIso);
              }
              let outcome;
              try {
                outcome = await this.adapter.run(this.tenant, reqId, {
                  command,
                  claimRefs: groundedClaimRefs,
                  onBehalfOf,
                  maxDollars: bid.dollars ?? 1,
                  maxTokens: bid.tokens ?? 10_000,
                  ...(vm ? { workingDir: vm.workingDir } : {}),
                  ...(approvedSpec && approvalDecision
                    ? { approvedDecisionId: approvalDecision.id, specFingerprint: approvedSpec.fingerprint }
                    : {}),
                  taskType,
                  tier: routeDecision.tier,
                  intent,
                  skillCardId: boundSkillCardId,
                  routerConfidence: routeDecision.shadow ? 0.5 : 0.9,
                });
              } catch (err) {
                if (needsVm && vm) {
                  const { destroyTeamVm } = await import('./vm.ts');
                  await destroyTeamVm(
                    this.db,
                    this.tenant,
                    targetScope,
                    `adapter throw: ${String(err).slice(0, 160)}`,
                    nowIso,
                  );
                }
                throw err;
              }
              if (needsVm && vm) {
                if (outcome.status === 'COMPLETED') {
                  const { snapshotTeamVm } = await import('./vm.ts');
                  await snapshotTeamVm(this.db, this.tenant, targetScope, reqId, outcome.artifactRef ?? null, nowIso);
                } else if (outcome.status === 'FAILED' || outcome.status === 'DENIED') {
                  const { destroyTeamVm } = await import('./vm.ts');
                  await destroyTeamVm(
                    this.db,
                    this.tenant,
                    targetScope,
                    `${outcome.status}: ${(outcome.refusalReason ?? 'no reason given').slice(0, 160)}`,
                    nowIso,
                  );
                }
              }

              // F25: Post terminal Buzz summary. Skip test-baseline adapters
              // (no operator-visible thread noise from CI runs). Relay
              // failures are counted but never fatal to dispatch.
              if (this.buzz && !outcome.isTestBaseline) {
                const buzzCoords = this.buzz.channelFor(reqId, request);
                if (buzzCoords) {
                  const handle = watchRun(
                    () => {
                      /* progress subscription: runner already ran */
                    },
                    this.buzz.surface,
                    { channel: buzzCoords.channel, threadRoot: buzzCoords.threadRoot, requestId: reqId },
                  );
                  try {
                    await handle.terminal(outcome.status, {
                      step: outcome.tools.length,
                      tokens: outcome.usage.input + outcome.usage.output,
                    });
                  } catch {
                    /* terminal resolves null on relay failure, never throws */
                  }
                  await handle.close(3000);
                  if (handle.failures > 0) {
                    this.counters.buzzRelayFailures += handle.failures;
                    const msg = `[worker:BUZZ_RELAY_FAILED] req=${reqId} failures=${handle.failures} last=${handle.lastError ?? '?'}`;
                    this.lastError = msg;
                    this.errors.push(msg);
                  }
                }
              }

              await this.router.recordCalibrationSample(
                this.tenant,
                taskType,
                routeDecision.tier,
                this.adapter.name,
                outcome.status === 'COMPLETED',
                nowIso,
              );

              if (outcome.status === 'COMPLETED') {
                this.counters.requestsCompleted += 1;
                result.requestsCompleted += 1;
                // EXECUTION → REVIEW: leave a draft a human can act on.
                await this.draftDeliverable({
                  requestId: reqId,
                  deliverableSchema: request.deliverableSchema,
                  content: outcome.transcript,
                  claimIds: groundedClaimRefs,
                  createdBy: onBehalfOf,
                  now: nowIso,
                  isTestBaseline: outcome.isTestBaseline,
                });
              } else {
                this.counters.requestsFailed += 1;
                result.requestsFailed += 1;
              }
            }
          } catch (err) {
            await this.router.recordCalibrationSample(
              this.tenant,
              taskType,
              routeDecision.tier,
              this.adapter.name,
              false,
              nowIso,
            );
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
