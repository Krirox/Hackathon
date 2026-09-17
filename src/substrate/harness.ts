import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { JcodeRunner } from '../jcode/runner.ts';
import type { JcodeClientOptions } from '../jcode/client.ts';

/**
 * Substrate, part 6 (TODO §0.5): harness adapters. Engineering is not
 * single-vendor: jcode runs as a sibling process, and every other harness
 * speaks this interface. Cross-model transfer tests (compiler §5) run the
 * same intent through every adapted harness — which is only possible if
 * more than one exists. `LocalEchoAdapter` is the deterministic offline
 * second harness: no model, no network, same ledger/coordinator path.
 */

export class HarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[harness:${code}] ${message}`);
  }
}

export interface HarnessTask {
  command: string;
  workingDir?: string;
  claimRefs: string[];
  onBehalfOf: string;
  maxDollars: number;
  maxTokens: number;
}

export interface HarnessOutcome {
  adapter: string;
  requestId: string;
  status: 'COMPLETED' | 'FAILED' | 'TERMINATED_BUDGET' | 'DENIED';
  transcript: string;
  tools: string[];
  usage: { input: number; output: number };
  permissions: { tool: string; decision: string }[];
}

export interface HarnessAdapter {
  readonly name: string;
  run(tenant: string, requestId: string, task: HarnessTask): Promise<HarnessOutcome>;
}

export class JcodeAdapter implements HarnessAdapter {
  readonly name = 'jcode';

  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    private readonly clientOpts: JcodeClientOptions = {},
  ) {}

  async run(tenant: string, requestId: string, task: HarnessTask): Promise<HarnessOutcome> {
    const runner = new JcodeRunner(this.db, this.ledger, this.coord);
    const out = await runner.run(tenant, requestId, task, this.clientOpts);
    return {
      adapter: this.name,
      requestId,
      status: out.status,
      transcript: out.transcript,
      tools: out.toolCalls.map((t) => t.name),
      usage: out.usage,
      permissions: out.permissions.map((p) => ({ tool: p.toolName, decision: p.decision })),
    };
  }
}

/**
 * Deterministic offline harness. Executes no model: it grounds the task,
 * records the work as a ledger OBSERVATION, completes the request, and
 * leaves a compilable TRACE — the same write path a real harness takes,
 * minus the reasoning. Used for transfer tests, CI without a harness, and
 * calibration baselines. It still refuses unadmitted and ungrounded work.
 */
export class LocalEchoAdapter implements HarnessAdapter {
  readonly name = 'local-echo';
  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
  ) {}

  async run(tenant: string, requestId: string, task: HarnessTask): Promise<HarnessOutcome> {
    const req = await this.coord.get(tenant, requestId);
    if (!req) throw new HarnessError('UNKNOWN_REQUEST', `unknown request ${requestId}`);
    // F03: same executable set as every worker — ACCEPTED (human-approved)
    // is claimable.
    if (req.state !== 'ADMITTED' && req.state !== 'ACCEPTED' && req.state !== 'IN_FLIGHT') {
      throw new HarnessError('NOT_ADMITTED', `request ${requestId} is ${req.state}, not executable`);
    }
    if (task.claimRefs.length === 0) {
      throw new HarnessError('UNGROUNDED_TASK', 'a harness task must cite the claims it is grounded in');
    }
    if (task.command.length > task.maxTokens) {
      await this.coord.fail(tenant, requestId, 'token ceiling reached');
      return {
        adapter: this.name,
        requestId,
        status: 'TERMINATED_BUDGET',
        transcript: '',
        tools: [],
        usage: { input: 0, output: 0 },
        permissions: [],
      };
    }
    const now = new Date().toISOString();
    const transcript = `echo(${req.targetScope}): ${task.command}`;
    const claim = await this.ledger.append({
      tenant,
      subject: `harness:${req.targetScope}`,
      kind: 'OBSERVATION',
      statement: `local-echo run: 0 tool calls, ${transcript.length} chars`,
      confidence: 1,
      owner: task.onBehalfOf,
      scope: req.targetScope,
      authorType: 'agent',
      observedAt: now,
      validFrom: now,
      provenance: {
        sourceUri: `harness:${this.name}:${requestId}`,
        sourceTier: 'MEASURED',
        extractor: 'local-echo',
        extractorVersion: '1.0.0',
        retrievedAt: now,
      },
    });
    await this.coord.accept(tenant, requestId);
    await this.coord.complete(tenant, requestId, { claims: [claim.id], cost: { tokens: transcript.length } });
    await this.db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_${crypto.randomUUID()}`,
        tenant,
        requestId,
        req.targetScope,
        'engineering.implement',
        `code:${req.deliverableSchema}`,
        JSON.stringify({ adapter: this.name, summary: transcript.slice(0, 500) }),
        'MODEL',
        'SUCCESS',
        JSON.stringify({ tokens: transcript.length }),
        null,
        0.9,
        now,
      );
    return {
      adapter: this.name,
      requestId,
      status: 'COMPLETED',
      transcript,
      tools: [],
      usage: { input: transcript.length, output: 0 },
      permissions: [],
    };
  }
}

/**
 * Model selection below the tier decision (TODO §4): once the router says
 * MODEL, this picks which harness runs it. Engineering implementation
 * prefers jcode; everything else prefers the cheapest adapter available.
 * No silent fallback to an unlisted harness — unknown work fails closed.
 */
export function selectAdapter(taskType: string, available: HarnessAdapter[]): HarnessAdapter {
  if (available.length === 0)
    throw new HarnessError('NO_HARNESS', 'no harness adapted — refusing rather than guessing');
  if (taskType.startsWith('engineering.')) {
    const jcode = available.find((a) => a.name === 'jcode');
    if (jcode) return jcode;
  }
  return available[0]!;
}
