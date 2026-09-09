import { EventEmitter } from 'node:events';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { JcodeClient, type JcodeClientOptions } from './client.ts';
import type { PermissionDecision, ServerFrame } from './protocol.ts';
import { isShellTool, screenShellCommand } from '../gov/shell.ts';

/**
 * The jcode connection.
 *
 * Flow: a coding need becomes a REQUEST -> coordinator admits it (budget,
 * hop limit, grounding) -> we open a jcode session, send the command +
 * instructions -> every PermissionRequest is decided by OUR R/A/I policy,
 * not by a human at a terminal -> tool activity is recorded -> on turn_done
 * the deliverable and cost are written back and the request completes.
 *
 * Why the permission hook matters: jcode's own gate asks a *person*. In an
 * autonomous organisation that becomes either an interruption storm or a
 * rubber stamp. Routing it through the R/A/I matrix means the same action
 * class that would need approval from a human is denied outright for an
 * agent, and the denial is a logged Ledger event rather than a shrug.
 */

export interface CodingTask {
  /** The instruction sent to the harness as the user message. */
  command: string;
  workingDir?: string;
  /** Claim IDs the work is grounded in. Required: no ungrounded coding. */
  claimRefs: string[];
  onBehalfOf: string;
  /** Ceiling; enforced against jcode's own token_usage events. */
  maxDollars: number;
  maxTokens: number;
}

export type PermissionPolicy = (ctx: { toolName: string; description: string; task: CodingTask }) => {
  decision: PermissionDecision;
  reason: string;
  actionClass: string;
};

export interface RunResult {
  requestId: string;
  sessionId: string;
  status: 'COMPLETED' | 'FAILED' | 'TERMINATED_BUDGET' | 'DENIED';
  transcript: string;
  toolCalls: { name: string; callId: string; error?: string | null }[];
  permissions: { toolName: string; decision: PermissionDecision; reason: string; actionClass: string }[];
  usage: { input: number; output: number };
  claimIds: string[];
  refusalReason?: string;
}

/** Default policy: read-only tools run, writes need approval, unknowns deny. */
export const defaultPermissionPolicy =
  (allow: Set<string>, needsApproval: Set<string>): PermissionPolicy =>
  ({ toolName, description, task }) => {
    // Shell text runs through the vendored hard-deny list first: an agent
    // asking bash to `rm -rf` is denied for the matched rule, not the tool name.
    if (isShellTool(toolName)) {
      const screen = screenShellCommand(description || task.command);
      if (screen.decision === 'deny') {
        return { decision: 'deny', reason: screen.reason, actionClass: screen.actionClass };
      }
    }
    if (allow.has(toolName)) return { decision: 'allow', reason: 'allowlisted read-only tool', actionClass: 'READ' };
    if (needsApproval.has(toolName)) {
      // An agent has no one to approve it, so "needs approval" == deny for
      // irreversible classes. Fail up, never sideways.
      return {
        decision: 'deny',
        reason: `tool "${toolName}" requires human approval; agents may not self-approve`,
        actionClass: 'ACT_IRREVERSIBLE',
      };
    }
    return { decision: 'deny', reason: `unrecognised tool "${toolName}" is denied by default`, actionClass: 'UNKNOWN' };
  };

export class JcodeRunner extends EventEmitter {
  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    private readonly policy: PermissionPolicy = defaultPermissionPolicy(
      new Set(['read_file', 'list_dir', 'search', 'grep', 'glob', 'think']),
      new Set(['write_file', 'edit_file', 'bash', 'delete_file', 'apply_patch']),
    ),
  ) {
    super();
  }

  /**
   * The only entry point. Takes an already-admitted REQUEST so budget and hop
   * rules cannot be bypassed by calling jcode directly.
   */
  async run(
    tenant: string,
    requestId: string,
    task: CodingTask,
    clientOpts: JcodeClientOptions = {},
  ): Promise<RunResult> {
    const req = await this.coord.get(tenant, requestId);
    if (!req) throw new Error(`[jcode] unknown request ${requestId}`);
    if (req.state !== 'ADMITTED' && req.state !== 'IN_FLIGHT') {
      throw new Error(`[jcode] request ${requestId} is ${req.state}, not admitted`);
    }
    if (task.claimRefs.length === 0) {
      throw new Error('[jcode] a coding task must cite the claims it is grounded in');
    }

    const client = new JcodeClient(clientOpts);
    const transcript: string[] = [];
    const toolCalls: RunResult['toolCalls'] = [];
    const permissions: RunResult['permissions'] = [];
    const usage = { input: 0, output: 0 };
    const claimIds: string[] = [];
    let budgetBroken = false;
    // Permission round-trips are answered asynchronously. The run must not
    // finish (and destroy the socket) while one is still in flight, or the
    // response write is dropped and the harness never sees our decision.
    const inflight = new Set<Promise<unknown>>();
    const track = (p: Promise<unknown>): Promise<unknown> => {
      inflight.add(p);
      return p.then(
        () => {
          inflight.delete(p);
        },
        () => {
          inflight.delete(p);
        },
      );
    };

    const onPermission = async (frame: ServerFrame) => {
      const toolName = String(frame.tool_name ?? '');
      const description = String(frame.description ?? '');
      const verdict = this.policy({ toolName, description, task });
      permissions.push({
        toolName,
        decision: verdict.decision,
        reason: verdict.reason,
        actionClass: verdict.actionClass,
      });
      // Every permission decision is a Ledger event: an agent that quietly
      // blocked itself is as invisible as one that quietly acted.
      const c = await this.ledger.append({
        tenant,
        subject: `jcode:${req.targetScope}`,
        kind: 'ACTION',
        statement: `permission ${verdict.decision.toUpperCase()} for ${toolName}: ${verdict.reason}`,
        confidence: 1,
        owner: task.onBehalfOf,
        scope: req.targetScope,
        authorType: 'agent',
        observedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        provenance: {
          sourceUri: `jcode:session:${String(frame.session_id ?? '')}`,
          sourceTier: 'MEASURED',
          extractor: 'jcode-harness-api',
          extractorVersion: 'v1',
          retrievedAt: new Date().toISOString(),
        },
      });
      claimIds.push(c.id);
      await this.audit(tenant, 'jcode', `PERMISSION_${verdict.decision.toUpperCase()}`, requestId, toolName);
      await client.respondPermission(String(frame.session_id ?? ''), String(frame.request_id ?? ''), verdict.decision);
    };

    const onText = (f: ServerFrame) => {
      if (typeof f.text === 'string') transcript.push(f.text);
    };
    const onToolDone = (f: ServerFrame) => {
      // Tool calls are activity, not rounds: a round is one agent turn.
      // Charging a round here would make any run of >maxRounds tool calls
      // self-terminate, which is exactly the bug this line used to be.
      toolCalls.push({
        name: String(f.name ?? ''),
        callId: String(f.call_id ?? ''),
        error: (f.error as string) ?? null,
      });
    };
    const onUsage = (f: ServerFrame) => {
      usage.input += Number(f.input ?? 0);
      usage.output += Number(f.output ?? 0);
      const tokens = usage.input + usage.output;
      if (tokens > task.maxTokens) budgetBroken = true;
      this.emit('usage', tokens);
    };

    client.on('frame:permission_request', (f) => {
      void track(onPermission(f));
    });
    client.on('frame:text_delta', onText);
    client.on('frame:tool_done', onToolDone);
    client.on('frame:token_usage', onUsage);

    let status: RunResult['status'] = 'COMPLETED';
    let refusalReason: string | undefined;

    try {
      await client.connect();
      const sessionId = await client.createSession(task.workingDir);
      await client.attach(sessionId);
      await this.coord.accept(tenant, requestId);

      await client.send(sessionId, task.command);
      const turn = await this.waitForTurn(client, sessionId, task.maxDollars, () => budgetBroken);
      // Drain outstanding permission round-trips (bounded) before writing
      // back: a turn_done that arrives in the same chunk as a
      // permission_request must not close the socket under the response.
      if (inflight.size > 0) {
        await Promise.race([Promise.allSettled([...inflight]), new Promise((res) => setTimeout(res, 5_000))]);
      }
      if (turn === 'budget') {
        status = 'TERMINATED_BUDGET';
        refusalReason = 'token ceiling reached';
      } else if (turn === 'timeout') {
        status = 'FAILED';
        refusalReason = 'harness turn did not complete';
      }

      // Deliverable + provenance claim, then close the request.
      const summary = transcript.join('').slice(0, 4000);
      const out = await this.ledger.append({
        tenant,
        subject: `jcode:${req.targetScope}`,
        kind: 'OBSERVATION',
        statement: `harness run: ${toolCalls.length} tool calls, ${usage.input + usage.output} tokens`,
        value: { toolCalls, usage, permissions },
        confidence: 1,
        owner: task.onBehalfOf,
        scope: req.targetScope,
        authorType: 'agent',
        observedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        provenance: {
          sourceUri: `jcode:session:${sessionId}`,
          sourceTier: 'MEASURED',
          extractor: 'jcode-harness-api',
          extractorVersion: 'v1',
          retrievedAt: new Date().toISOString(),
        },
      });
      claimIds.push(out.id);

      if (status === 'COMPLETED') {
        await this.coord.complete(tenant, requestId, {
          claims: claimIds,
          cost: { tokens: usage.input + usage.output },
        });
        await this.recordTrace(tenant, req, sessionId, summary, usage);
      } else {
        await this.coord.fail(tenant, requestId, refusalReason ?? 'unknown failure');
      }
      return {
        requestId,
        sessionId,
        status,
        transcript: transcript.join(''),
        toolCalls,
        permissions,
        usage,
        claimIds,
        refusalReason,
      };
    } catch (e) {
      status = 'FAILED';
      refusalReason = (e as Error).message;
      try {
        await this.coord.fail(tenant, requestId, refusalReason);
      } catch {
        /* already terminal */
      }
      return {
        requestId,
        sessionId: '',
        status,
        transcript: transcript.join(''),
        toolCalls,
        permissions,
        usage,
        claimIds,
        refusalReason,
      };
    } finally {
      client.close();
    }
  }

  private waitForTurn(
    client: JcodeClient,
    sessionId: string,
    _maxDollars: number,
    budgetHit: () => boolean,
  ): Promise<'done' | 'budget' | 'timeout'> {
    return new Promise((resolve) => {
      // Await the cancel round-trip so the harness actually observes it
      // before the run closes the socket under the write. If the harness is
      // gone, the budget breach stands regardless — resolve anyway.
      const finishBudget = () => {
        clearInterval(poll);
        client.removeListener('frame:turn_done', done);
        let settled = false;
        const fin = (): void => {
          if (!settled) {
            settled = true;
            resolve('budget');
          }
        };
        client.cancel(sessionId).then(fin, fin);
        setTimeout(fin, 2000).unref?.();
      };
      const poll = setInterval(() => {
        if (budgetHit()) finishBudget();
      }, 50);
      function done(f: ServerFrame) {
        if (String(f.session_id ?? '') !== sessionId) return;
        // The ceiling may already be breached by a token_usage frame that
        // arrived in the same chunk as this turn_done: the poll never gets a
        // chance, so check synchronously instead of declaring success.
        if (budgetHit()) {
          finishBudget();
          return;
        }
        clearInterval(poll);
        client.removeListener('frame:turn_done', done);
        resolve('done');
      }
      client.on('frame:turn_done', done);
      setTimeout(() => {
        clearInterval(poll);
        client.removeListener('frame:turn_done', done);
        resolve('timeout');
      }, 60_000).unref?.();
    });
  }

  /** A completed run becomes a TRACE eligible for compilation. */
  private async recordTrace(
    tenant: string,
    req: CoordinationRequest,
    sessionId: string,
    summary: string,
    usage: { input: number; output: number },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_${crypto.randomUUID()}`,
        tenant,
        req.id,
        req.targetScope,
        'engineering.implement',
        `code:${req.deliverableSchema}`,
        JSON.stringify({ sessionId, summary: summary.slice(0, 500) }),
        'MODEL',
        'SUCCESS',
        JSON.stringify({ tokens: usage.input + usage.output }),
        null,
        0.9,
        new Date().toISOString(),
      );
  }

  private async audit(tenant: string, actor: string, action: string, target: string, detail?: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, actor, action, target, detail ?? null, new Date().toISOString());
  }
}
