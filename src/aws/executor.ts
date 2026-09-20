import { createLedger } from '../ledger/ledger.ts';
import { createCoordinator } from '../coord/coordinator.ts';
import { migratePostgres, openFromEnv } from '../core/pg.ts';
import { migrate } from '../core/db.ts';
import type { AsyncDb } from '../core/db.ts';
import {
  assertApproved,
  completeChat,
  devProfile,
  prodProfile,
  readApiKey,
  type ChatMessage,
} from '../substrate/models.ts';
import { decideEgress } from '../substrate/egress.ts';
import { checkKill } from '../gov/trust.ts';
import { getRates } from '../attrib/attribution.ts';

/**
 * AWS Lambda container handler for fast coding-agent work (TODO AWS deploy).
 *
 * This is the Firecracker-microVM half of the execution plane: Lambda runs
 * every invocation in its own microVM, which is exactly the blast-radius
 * shape Vital wants — one REQUEST in, one deliverable + Ledger claims out,
 * no durable state, no ambient credentials (scope work only, Secrets Manager
 * supplies keys at the boundary, never the Ledger).
 *
 * Long jcode runs (swarms, overnight, graph memory) do NOT belong here —
 * Lambda caps at 15 min. They run as the Fargate jcode sidecar next to
 * vital-core (deploy/aws/main.tf), coordinated over the same REQUEST path
 * (src/jcode/runner.ts). This handler is REFLEX/WORKFLOW + short MODEL only.
 *
 * Epistemics: the handler appends OBSERVATION/ACTION only (I1). It never
 * mints FACT/MEASUREMENT/OUTCOME — outcomes still go through recordOutcome
 * with a basis, on core.
 */

import { enqueueOutbox } from '../substrate/scheduler.ts';

/**
 * Enqueue an ExecutorJob into the durable outbox for subsequent relay to SQS or worker dispatch.
 */
export async function enqueueExecutorJob(
  db: AsyncDb,
  tenant: string,
  job: ExecutorJob,
  opts: { id?: string; now?: string; nextAt?: string } = {},
): Promise<string> {
  return enqueueOutbox(db, tenant, 'executor-job', job, opts);
}

export interface ExecutorJob {
  tenant: string;
  requestId: string;
  prompt: string;
  claimRefs?: string[];
  onBehalfOf?: string;
  lane?: 'dev' | 'production';
  /**
   * Idempotency key the producer attached at enqueue time. A redelivered SQS
   * message for an already-COMPLETED request is acked (duplicate success)
   * ONLY when this matches the stored request's key — a redelivery that
   * names a completed id but carries a different key is a different job
   * wearing a familiar id, and must fail loudly instead of acking.
   */
  idempotencyKey?: string;
}

interface SqsRecord {
  body: string;
  messageId: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface JobResult {
  messageId: string;
  requestId: string;
  status: 'COMPLETED' | 'FAILED';
  claimIds: string[];
  usage: { input: number; output: number };
  error?: string;
}

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const nodeFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
};

function parseJob(body: string): ExecutorJob {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw new Error('[executor:BAD_JOB] SQS body is not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('[executor:BAD_JOB] job must be an object');
  const j = raw as Record<string, unknown>;
  if (typeof j['tenant'] !== 'string' || j['tenant'].length === 0)
    throw new Error('[executor:BAD_JOB] job.tenant is required');
  if (typeof j['requestId'] !== 'string' || j['requestId'].length === 0)
    throw new Error('[executor:BAD_JOB] job.requestId is required');
  if (typeof j['prompt'] !== 'string' || j['prompt'].length === 0)
    throw new Error('[executor:BAD_JOB] job.prompt is required');
  const lane = j['lane'];
  if (lane !== undefined && lane !== 'dev' && lane !== 'production')
    throw new Error('[executor:BAD_JOB] job.lane must be dev|production');
  return {
    tenant: j['tenant'] as string,
    requestId: j['requestId'] as string,
    prompt: j['prompt'] as string,
    claimRefs: Array.isArray(j['claimRefs']) ? (j['claimRefs'] as string[]) : [],
    onBehalfOf: typeof j['onBehalfOf'] === 'string' ? (j['onBehalfOf'] as string) : 'lambda-executor',
    lane: (lane as 'dev' | 'production' | undefined) ?? 'production',
    idempotencyKey: typeof j['idempotencyKey'] === 'string' ? (j['idempotencyKey'] as string) : undefined,
  };
}

/** Fail-closed egress check for the model endpoint before any token is spent. */
function checkModelEgress(baseUrl: string, env: NodeJS.ProcessEnv): void {
  const allowRaw = env['ALLOWED_EGRESS_HOSTS'] ?? '';
  const allowedHosts = allowRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowedHosts.length === 0) return; // open egress (dev); prod sets the allowlist in Terraform
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`[executor:EGRESS] unparseable model baseUrl "${baseUrl}" — refusing`);
  }
  const verdict = decideEgress(host, { allowedHosts, deniedHosts: [] });
  if (verdict.verdict !== 'allow') throw new Error(`[executor:EGRESS] ${verdict.reason}`);
}

/** Exported for tests: the per-record path without the SQS/DB-open envelope. */
export async function runJob(
  db: AsyncDb,
  job: ExecutorJob,
  env: NodeJS.ProcessEnv,
  chat: (
    profile: Parameters<typeof completeChat>[0],
    apiKey: string,
    messages: ChatMessage[],
  ) => Promise<{ text: string; usage: { input: number; output: number } }> = (profile, apiKey, messages) =>
    completeChat(profile, apiKey, messages, nodeFetch),
): Promise<Omit<JobResult, 'messageId' | 'requestId'>> {
  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  const claimIds: string[] = [];

  const req = await coord.get(job.tenant, job.requestId);
  if (!req) throw new Error(`[executor] unknown request ${job.requestId}`);
  if (req.state === 'COMPLETED') {
    // Redelivered success (SQS at-least-once): ack the duplicate instead of
    // failing it to the DLQ — no new model call, no new claims. The
    // idempotency-key check is the whole safety: without it, any redelivery
    // naming a finished id would read as success.
    if (job.idempotencyKey !== undefined && job.idempotencyKey !== req.idempotencyKey) {
      throw new Error(
        `[executor] request ${job.requestId} already COMPLETED under a different idempotency key — refusing to ack`,
      );
    }
    return { status: 'COMPLETED', claimIds: [...req.chainClaimIds], usage: { input: 0, output: 0 } };
  }
  // FAILED is retryable, not terminal-for-the-worker: a redelivered job for
  // a failed request re-runs the model and completes (FAILED→COMPLETED is a
  // legal coordinator transition). Anything else non-live still throws.
  if (req.state !== 'ADMITTED' && req.state !== 'IN_FLIGHT' && req.state !== 'ACCEPTED' && req.state !== 'FAILED') {
    throw new Error(`[executor] request ${job.requestId} is ${req.state}, not admitted`);
  }

  // Emergency stop, checked BEFORE the claim and before any spend. This executor
  // runs serverless and never passes through a harness adapter, so the
  // adapter-level check that guards a local run cannot guard this one — without
  // this, an operator's stop halts the worker and leaves Lambda spending money
  // on the same scope. Checked here rather than deeper so the refusal also
  // precedes `assertApproved` and the model call.
  if ((await checkKill(db, job.tenant, req.targetScope, '*')) || (await checkKill(db, job.tenant, '*', '*'))) {
    const reason = `kill switch engaged for scope "${req.targetScope}"`;
    // Terminal refusal, not a retry: a stop is an operator decision, and an
    // SQS redelivery would spend exactly the money the stop was protecting. A
    // request already in a state that cannot fail still ends the job — the
    // reason travels in `error` either way.
    try {
      await coord.fail(job.tenant, job.requestId, reason);
    } catch {
      // Already terminal, or not failable from here: the refusal stands.
    }
    return { status: 'FAILED', claimIds: [], usage: { input: 0, output: 0 }, error: reason };
  }

  // F05: exclusive leased ownership BEFORE any spend. The atomic
  // ADMITTED/ACCEPTED→IN_FLIGHT CAS means two concurrent deliveries of the
  // same job cannot both run paid work; the loser gets CLAIM_LOST and the
  // SQS redelivery discipline handles it. FAILED rows (retry path) are
  // already IN_FLIGHT-cas-ineligible, so the retry claims by re-failing the
  // row first: the coordinator's FAILED→COMPLETED recovery below settles it.
  if (req.state === 'ADMITTED' || req.state === 'ACCEPTED') {
    try {
      await coord.claimExecution(
        job.tenant,
        job.requestId,
        job.onBehalfOf ?? 'lambda-executor',
        new Date().toISOString(),
      );
    } catch {
      throw new Error(
        `[executor:CLAIM_LOST] request ${job.requestId} is being executed by another worker — refusing to double-spend`,
      );
    }
  }

  const profile = job.lane === 'dev' ? devProfile(env) : prodProfile(env);
  assertApproved(profile, job.lane ?? 'production', env);
  checkModelEgress(profile.baseUrl, env);
  const apiKey = readApiKey(env, profile);

  // F05: even on the IN_FLIGHT retry path, another worker may hold the
  // claim. If the row is claimed by someone else, refuse before any spend.
  const current = await coord.get(job.tenant, job.requestId);
  const holder = current?.execOwner ?? null;
  if (holder && holder !== (job.onBehalfOf ?? 'lambda-executor')) {
    throw new Error(
      `[executor:CLAIM_LOST] request ${job.requestId} is claimed by ${holder} — refusing to double-spend`,
    );
  }

  const grounded = [...(job.claimRefs ?? []), ...(req.claimRefs ?? [])];
  const context = grounded.length > 0 ? await ledger.contextFor(job.tenant, grounded, new Date().toISOString()) : [];
  const contextText =
    context.length > 0
      ? context.map((c) => `- [${c.kind}] ${c.subject}: ${c.statement}`).join('\n')
      : '(no grounded context — generic task)';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      text: 'You are a short-horizon coding assistant. Answer with the deliverable only. Never assert unverified facts; flag uncertainty explicitly.',
    },
    { role: 'user', text: `Grounded context:\n${contextText}\n\nTask:\n${job.prompt}` },
  ];
  const out = await chat(profile, apiKey, messages);

  // F05: the FULL deliverable is persisted as an artifact row (bounded at
  // 1 MiB — Lambda deliverables are short-horizon outputs, and the bound
  // makes the storage guarantee honest); the claim's value carries only a
  // preview plus the artifact reference. The old code truncated at 8,000
  // chars with no recovery path — the produced artifact was unreachable.
  const artifactId = `art_${crypto.randomUUID()}`;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS executor_artifacts (
         id TEXT PRIMARY KEY, tenant TEXT NOT NULL, request_id TEXT NOT NULL,
         claim_id TEXT, model TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
    )
    .run();
  if (out.text.length > 1_000_000) {
    throw new Error(
      '[executor:ARTIFACT_TOO_LARGE] deliverable exceeds the 1MiB artifact bound — refusing to store a silent truncation',
    );
  }
  await db
    .prepare(
      `INSERT INTO executor_artifacts (id, tenant, request_id, claim_id, model, body, created_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(artifactId, job.tenant, job.requestId, null, profile.model, out.text, new Date().toISOString());

  const claim = await ledger.append({
    tenant: job.tenant,
    subject: `lambda:${req.targetScope}`,
    kind: 'OBSERVATION',
    statement: `executor run: ${(out.text.length / 1000).toFixed(1)}k chars, ${out.usage.input + out.usage.output} tokens`,
    value: {
      textPreview: out.text.slice(0, 2000),
      fullTextRef: artifactId,
      truncated: false,
      usage: out.usage,
      model: profile.model,
      lane: job.lane,
    },
    confidence: 0.7,
    owner: job.onBehalfOf ?? 'lambda-executor',
    scope: req.targetScope,
    authorType: 'agent',
    observedAt: new Date().toISOString(),
    validFrom: new Date().toISOString(),
    provenance: {
      sourceUri: `lambda:executor:${job.requestId}`,
      sourceTier: 'MEASURED',
      extractor: 'vital-aws-executor',
      extractorVersion: 'v1',
      retrievedAt: new Date().toISOString(),
    },
  });
  claimIds.push(claim.id);
  await db.prepare('UPDATE executor_artifacts SET claim_id = ? WHERE id = ?').run(claim.id, artifactId);

  // F05: authoritative cost accounting. Usage flows through reportUsage —
  // the coordinator's atomic spend increment, which enforces the request's
  // own ceilings and can TERMINATE_BUDGET mid-flight — so the spent mirrors
  // and daily roll-ups see exactly what this job consumed. complete() then
  // records the result; it no longer carries (ignored) cost. Dollar costing
  // uses the tenant's versioned rates (meta), unknown rates degrade to the
  // token count, never to a fabricated zero.
  const rates = await getRates(db, job.tenant);
  const charged = await coord.reportUsage(job.tenant, job.requestId, {
    tokens: out.usage.input + out.usage.output,
    dollars: (out.usage.input + out.usage.output) * rates.dollarPerToken,
  });
  if (charged.state === 'TERMINATED_BUDGET') {
    // The usage itself breached the bid: reportUsage already settled the
    // request. Do NOT complete — surface the failure so the operator sees
    // why the deliverable never formally landed. The artifact and the
    // observation claim survive on the ledger for inspection.
    return { status: 'FAILED', claimIds, usage: out.usage, error: 'budget exhausted mid-run (reportUsage ceiling)' };
  }
  await coord.complete(job.tenant, job.requestId, {
    claims: claimIds,
    cost: {},
  });
  return { status: 'COMPLETED', claimIds, usage: out.usage };
}

export async function handler(
  event: SqsEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ results: JobResult[] }> {
  const opened = openFromEnv(env);
  const db: AsyncDb = opened.db;
  // Migrations are deployment work, not per-invocation work: every Lambda
  // boot running DDL adds latency and contention, and the try/catch
  // additive runner can stamp success over a real failure. The ECS core
  // service migrates at boot; the executor skips when told to.
  // VITAL_MIGRATE_ON_BOOT=0 requires the core to have booted (and migrated)
  // at least once first — deploy ordering, enforced by documentation, not code.
  if (env['VITAL_MIGRATE_ON_BOOT'] !== '0') {
    if (opened.kind === 'postgres') await migratePostgres(db);
    else await migrate(db);
  }

  const results: JobResult[] = [];
  try {
    for (const record of event.Records ?? []) {
      let job: ExecutorJob | null = null;
      try {
        job = parseJob(record.body);
        const out = await runJob(db, job, env);
        results.push({ messageId: record.messageId, requestId: job.requestId, ...out });
      } catch (err) {
        const message = (err as Error).message;
        // Best effort: terminal-fail the admitted request so it never hangs.
        try {
          if (job) {
            const coord = createCoordinator(db);
            const current = await coord.get(job.tenant, job.requestId);
            // F03: ACCEPTED joins the failure path too — an approved request
            // that errors must settle, not strand (fail() itself rejects on
            // settled rows, so the wider live set is safe to probe).
            if (
              current &&
              (current.state === 'ADMITTED' || current.state === 'ACCEPTED' || current.state === 'IN_FLIGHT')
            ) {
              await coord.fail(job.tenant, job.requestId, message.slice(0, 500));
            }
          }
        } catch {
          /* failing to fail is reported, not thrown — DLQ still sees the error below */
        }
        results.push({
          messageId: record.messageId,
          requestId: job?.requestId ?? 'unknown',
          status: 'FAILED',
          claimIds: [],
          usage: { input: 0, output: 0 },
          error: message,
        });
      }
    }
  } finally {
    await db.close();
  }
  const failed = results.filter((r) => r.status === 'FAILED');
  if (failed.length > 0) {
    // Throw so SQS + DLQ see the batch as failed; per-record detail stays in the response.
    throw Object.assign(new Error(`[executor] ${failed.length}/${results.length} jobs failed`), { results });
  }
  return { results };
}
