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

export interface ExecutorJob {
  tenant: string;
  requestId: string;
  prompt: string;
  claimRefs?: string[];
  onBehalfOf?: string;
  lane?: 'dev' | 'production';
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

async function runJob(
  db: AsyncDb,
  job: ExecutorJob,
  env: NodeJS.ProcessEnv,
): Promise<Omit<JobResult, 'messageId' | 'requestId'>> {
  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  const claimIds: string[] = [];

  const req = await coord.get(job.tenant, job.requestId);
  if (!req) throw new Error(`[executor] unknown request ${job.requestId}`);
  if (req.state !== 'ADMITTED' && req.state !== 'IN_FLIGHT') {
    throw new Error(`[executor] request ${job.requestId} is ${req.state}, not admitted`);
  }

  const profile = job.lane === 'dev' ? devProfile(env) : prodProfile(env);
  assertApproved(profile, job.lane ?? 'production', env);
  checkModelEgress(profile.baseUrl, env);
  const apiKey = readApiKey(env, profile);

  if (req.state === 'ADMITTED') await coord.accept(job.tenant, job.requestId);

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
  const out = await completeChat(profile, apiKey, messages, nodeFetch);

  const claim = await ledger.append({
    tenant: job.tenant,
    subject: `lambda:${req.targetScope}`,
    kind: 'OBSERVATION',
    statement: `executor run: ${(out.text.length / 1000).toFixed(1)}k chars, ${out.usage.input + out.usage.output} tokens`,
    value: { text: out.text.slice(0, 8000), usage: out.usage, model: profile.model, lane: job.lane },
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

  await coord.complete(job.tenant, job.requestId, {
    claims: claimIds,
    cost: { tokens: out.usage.input + out.usage.output },
  });
  return { status: 'COMPLETED', claimIds, usage: out.usage };
}

export async function handler(
  event: SqsEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ results: JobResult[] }> {
  const opened = openFromEnv(env);
  const db: AsyncDb = opened.db;
  if (opened.kind === 'postgres') await migratePostgres(db);
  else await migrate(db);

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
            if (current && (current.state === 'ADMITTED' || current.state === 'IN_FLIGHT')) {
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
