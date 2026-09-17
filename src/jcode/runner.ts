import { EventEmitter } from 'node:events';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { JcodeClient, type JcodeClientOptions } from './client.ts';
import type { PermissionDecision, ServerFrame } from './protocol.ts';
import { isShellTool, screenShellCommand } from '../gov/shell.ts';
import { getRates } from '../attrib/attribution.ts';
import { FilesystemArtifactStore } from '../ingest/collectors.ts';
import { checkKill, guardedAuthorize } from '../gov/trust.ts';
import { verifyScopeToken } from '../substrate/identity.ts';
import { verifySandbox, type Manifest } from '../substrate/sandbox.ts';
import type { ScreenResult } from '../substrate/screen.ts';

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
  /** Bound on one agent turn. Real coding turns take minutes; the 60s
   *  default only fits the scripted harness — raise for live siblings. */
  turnTimeoutMs?: number;
  /** Optional scope token credential for scoped authorization. */
  scopeToken?: string;
  /** Optional secret used to verify scopeToken (defaults to process.env.VITAL_CORE_SECRET). */
  coreSecret?: string;
  /** Optional sandbox manifest to verify workingDir contents against before running. */
  sandboxManifest?: Manifest;
}

export interface PermissionRequest {
  toolName: string;
  description: string;
  task: CodingTask;
  tenant?: string;
  scope?: string;
}

export interface PermissionVerdict {
  decision: PermissionDecision;
  reason: string;
  actionClass: string;
}

export type PermissionPolicy = (ctx: PermissionRequest) => PermissionVerdict | Promise<PermissionVerdict>;

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

/**
 * Live progress from a running turn — the feed a Buzz thread (or any other
 * watcher) renders while the work happens, instead of waiting for turn_done.
 * Emitted on every tool completion and every token batch; subscribers decide
 * their own sampling (post every Nth step, throttle by time, etc.).
 */
export interface ProgressUpdate {
  requestId: string;
  sessionId: string;
  /** Monotonic step within this run: tool completions and token batches. */
  step: number;
  /** Tool that just completed, when this update is a tool step. */
  toolName?: string;
  /** Cumulative tokens this run has consumed so far. */
  tokens: number;
  usage: { input: number; output: number };
}

export interface GovernedPolicyOptions {
  allow?: Set<string>;
  reversibleTools?: Set<string>;
  irreversibleTools?: Set<string>;
  pinnedScopes?: readonly string[];
}

/**
 * Governed policy: composes shell screening, trust scores, RACI matrix,
 * and live emergency kill switches into the executor permission boundary.
 */
export const createGovernedPermissionPolicy =
  (db: AsyncDb, opts: GovernedPolicyOptions = {}): PermissionPolicy =>
  async ({ toolName, description, task, tenant, scope }) => {
    // 1. Shell screening
    if (isShellTool(toolName)) {
      const screen = screenShellCommand(description || task.command);
      if (screen.decision === 'deny') {
        return { decision: 'deny', reason: screen.reason, actionClass: screen.actionClass };
      }
    }

    const allow = opts.allow ?? new Set(['read_file', 'list_dir', 'search', 'grep', 'glob', 'think']);
    const reversible = opts.reversibleTools ?? new Set(['write_file', 'edit_file', 'delete_file', 'apply_patch']);
    const irreversible = opts.irreversibleTools ?? new Set(['bash']);

    let actionClass: string;
    if (allow.has(toolName)) {
      actionClass = 'READ';
    } else if (reversible.has(toolName)) {
      actionClass = 'ACT_REVERSIBLE';
    } else if (irreversible.has(toolName)) {
      actionClass = 'ACT_IRREVERSIBLE';
    } else {
      actionClass = 'UNKNOWN';
    }

    // 2. Kill switch check
    if (tenant && scope) {
      if (
        (await checkKill(db, tenant, scope, actionClass)) ||
        (await checkKill(db, tenant, '*', '*')) ||
        (await checkKill(db, tenant, scope, '*'))
      ) {
        return {
          decision: 'deny',
          reason: `kill switch engaged for ${scope}/${actionClass} — execution halted`,
          actionClass,
        };
      }
    }

    // 3. RACI Matrix authorization
    if (actionClass === 'READ') {
      return { decision: 'allow', reason: 'allowlisted read-only tool', actionClass: 'READ' };
    }

    if (actionClass === 'ACT_REVERSIBLE') {
      if (tenant && scope) {
        const auth = await guardedAuthorize(db, {
          tenant,
          scope,
          actionClass: 'ACT_REVERSIBLE',
          pinnedScopes: opts.pinnedScopes,
        });
        if (auth.verdict === 'autonomous') {
          return {
            decision: 'allow',
            reason: `governed autonomous execution: ${auth.reasons.join('; ')}`,
            actionClass: 'ACT_REVERSIBLE',
          };
        }
        return {
          decision: 'deny',
          reason: `tool "${toolName}" requires human approval: ${auth.reasons.join('; ')}`,
          actionClass: 'ACT_REVERSIBLE',
        };
      }
      return {
        decision: 'deny',
        reason: `tool "${toolName}" requires human approval; agents may not self-approve`,
        actionClass: 'ACT_REVERSIBLE',
      };
    }

    if (actionClass === 'ACT_IRREVERSIBLE') {
      return {
        decision: 'deny',
        reason: `tool "${toolName}" requires human command; agents may not self-approve`,
        actionClass: 'ACT_IRREVERSIBLE',
      };
    }

    return {
      decision: 'deny',
      reason: `unrecognised tool "${toolName}" is denied by default`,
      actionClass: 'UNKNOWN',
    };
  };

/** Default static policy: read-only tools run, writes need approval, unknowns deny. */
export const defaultPermissionPolicy =
  (allow: Set<string>, needsApproval: Set<string>): ((ctx: PermissionRequest) => PermissionVerdict) =>
  ({ toolName, description, task }): PermissionVerdict => {
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

export interface JcodeRunnerOptions {
  contentScreen?: {
    check: (hook: 'user_input' | 'tool_response', text: string) => ScreenResult;
  };
}

export class JcodeRunner extends EventEmitter {
  private readonly artifactStore: FilesystemArtifactStore;
  private readonly contentScreen?: {
    check: (hook: 'user_input' | 'tool_response', text: string) => ScreenResult;
  };
  private readonly policy: PermissionPolicy;

  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    policy?: PermissionPolicy,
    artifactStore?: FilesystemArtifactStore,
    opts: JcodeRunnerOptions = {},
  ) {
    super();
    this.policy = policy ?? createGovernedPermissionPolicy(db);
    this.artifactStore = artifactStore ?? new FilesystemArtifactStore();
    this.contentScreen = opts.contentScreen;
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
    // F03: the same executable set every worker uses — a human-approved
    // (ACCEPTED) request is claimable, so approval cannot strand work in a
    // state no executor reads.
    if (req.state !== 'ADMITTED' && req.state !== 'ACCEPTED' && req.state !== 'IN_FLIGHT') {
      throw new Error(`[jcode] request ${requestId} is ${req.state}, not executable`);
    }
    if (task.claimRefs.length === 0) {
      throw new Error('[jcode] a coding task must cite the claims it is grounded in');
    }

    // Pre-flight kill switch check: halt before claiming execution or touching harness
    if ((await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'))) {
      const reason = `[jcode:HALTED] kill switch engaged for scope "${req.targetScope}"`;
      await this.audit(tenant, 'jcode', 'KILL_SWITCH_HALTED', requestId, reason);
      try {
        await this.coord.fail(tenant, requestId, reason);
      } catch {
        /* already terminal */
      }
      return {
        requestId,
        sessionId: '',
        status: 'DENIED',
        transcript: '',
        toolCalls: [],
        permissions: [],
        usage: { input: 0, output: 0 },
        claimIds: [],
        refusalReason: reason,
      };
    }

    // Scoped control: verify scope token credential when provided
    if (task.scopeToken) {
      const secret = task.coreSecret ?? process.env.VITAL_CORE_SECRET;
      if (!secret) {
        throw new Error('[jcode:IDENTITY] scope token supplied but no VITAL_CORE_SECRET available for verification');
      }
      const grant = verifyScopeToken(secret, task.scopeToken, new Date().toISOString());
      if (grant.scope !== req.targetScope) {
        throw new Error(
          `[jcode:IDENTITY] scope token scope "${grant.scope}" does not match target scope "${req.targetScope}"`,
        );
      }
    }

    // Scoped control: verify sandbox manifest before execution if requested
    if (task.sandboxManifest) {
      const dir = task.workingDir ?? process.cwd();
      const v = verifySandbox(dir, task.sandboxManifest);
      if (!v.ok) {
        const faults: string[] = [];
        if (v.tampered.length > 0) faults.push(`tampered: ${v.tampered.join(', ')}`);
        if (v.missing.length > 0) faults.push(`missing: ${v.missing.join(', ')}`);
        throw new Error(`[jcode:SANDBOX] sandbox verification failed (${faults.join('; ')})`);
      }
    }

    // Exclusive ownership BEFORE the harness: exactly one worker may run the
    // paid work. A lost claim throws CLAIM_LOST here — before connect() and
    // before createSession() — so the loser never touches the harness and
    // never fails the winner's request in the catch below.
    try {
      await this.coord.claimExecution(tenant, requestId, task.onBehalfOf, new Date().toISOString());
    } catch (e) {
      throw new Error(`[jcode:CLAIM_LOST] ${(e as Error).message}`, { cause: e });
    }

    const rates = await getRates(this.db, tenant);
    const contextClaims = await this.ledger.contextFor(tenant, task.claimRefs, new Date().toISOString());
    let prompt = task.command;
    if (contextClaims.length > 0) {
      const contextLines = contextClaims.map((c) => `- [${c.kind}] (${c.subject}): ${c.statement}`).join('\n');
      prompt = `[Grounded Context]\n${contextLines}\n\n[Instruction]\n${task.command}`;
    }

    // Content screening on input prompt
    if (this.contentScreen) {
      const screen = this.contentScreen.check('user_input', prompt);
      if (screen.verdict === 'deny') {
        const reason = `[jcode:DENIED] content screen denied input: ${screen.flags.join(', ') || 'unsafe content'}`;
        await this.audit(tenant, 'jcode', 'CONTENT_SCREEN_DENIED', requestId, reason);
        try {
          await this.coord.fail(tenant, requestId, reason);
        } catch {
          /* already terminal */
        }
        return {
          requestId,
          sessionId: '',
          status: 'DENIED',
          transcript: '',
          toolCalls: [],
          permissions: [],
          usage: { input: 0, output: 0 },
          claimIds: [],
          refusalReason: reason,
        };
      }
    }

    const client = new JcodeClient(clientOpts);
    const transcript: string[] = [];
    const toolCalls: RunResult['toolCalls'] = [];
    const permissions: RunResult['permissions'] = [];
    const usage = { input: 0, output: 0 };
    const claimIds: string[] = [];
    let budgetBroken = false;
    // Transcript is model-controlled text: cap it so a runaway stream cannot
    // exhaust task memory. Oldest chunks drop first; the claim discloses the
    // cut (a silent slice would misrepresent the evidence).
    let transcriptChars = 0;
    let transcriptTruncated = false;
    const MAX_TRANSCRIPT_CHARS = 64_000;
    /** Tool calls persisted per claim: the value lists the first N with the
     *  true total beside it — same disclosure rule as the transcript. */
    const MAX_CLAIM_TOOL_CALLS = 200;
    // Progress sink (live watch): every tool completion and token batch flows
    // spend into the coordinator mid-run (reportUsage touches tokens/dollars
    // only — never rounds, so unlike charge() it cannot self-terminate the
    // run) and emits a ProgressUpdate for watchers (Buzz thread publisher).
    let sessionId = '';
    let step = 0;
    const progress = (toolName?: string): void => {
      step += 1;
      this.emit('progress', {
        requestId,
        sessionId,
        step,
        toolName,
        tokens: usage.input + usage.output,
        usage: { ...usage },
      } satisfies ProgressUpdate);
    };
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

    let turnError: string | null = null;

    const onPermission = async (frame: ServerFrame) => {
      const toolName = String(frame.tool_name ?? '');
      const description = String(frame.description ?? '');
      const sid = String(frame.session_id ?? '');
      const rid = String(frame.request_id ?? '');

      // Check live kill switch before deciding
      const killed =
        (await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'));
      if (killed) {
        const reason = `kill switch engaged for scope "${req.targetScope}" — mid-turn execution halted`;
        permissions.push({
          toolName,
          decision: 'deny',
          reason,
          actionClass: 'UNKNOWN',
        });
        await this.audit(tenant, 'jcode', 'PERMISSION_DENIED_KILL', requestId, toolName);
        await client.respondPermission(sid, rid, 'deny');
        void client.cancel(sessionId).catch(() => {});
        turnError = reason;
        return;
      }

      const verdict = await this.policy({
        toolName,
        description,
        task,
        tenant,
        scope: req.targetScope,
      });
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
          sourceUri: `jcode:session:${sid}`,
          sourceTier: 'MEASURED',
          extractor: 'jcode-harness-api',
          extractorVersion: 'v1',
          retrievedAt: new Date().toISOString(),
        },
      });
      claimIds.push(c.id);
      await this.audit(tenant, 'jcode', `PERMISSION_${verdict.decision.toUpperCase()}`, requestId, toolName);
      await client.respondPermission(sid, rid, verdict.decision);
    };

    const onText = (f: ServerFrame) => {
      if (typeof f.text !== 'string' || f.text.length === 0) return;
      if (this.contentScreen) {
        const screen = this.contentScreen.check('tool_response', f.text);
        if (screen.verdict === 'deny') {
          budgetBroken = true;
          if (turnError === null) {
            turnError = `content screen denied output: ${screen.flags.join(', ') || 'unsafe content'}`;
          }
          void client.cancel(sessionId).catch(() => {});
        }
      }
      transcript.push(f.text);
      transcriptChars += f.text.length;
      while (transcriptChars > MAX_TRANSCRIPT_CHARS && transcript.length > 1) {
        transcriptChars -= (transcript.shift() ?? '').length;
        transcriptTruncated = true;
      }
    };
    const onToolDone = (f: ServerFrame) => {
      // Tool calls are activity, not rounds: a round is one agent turn.
      // Charging a round here would make any run of >maxRounds tool calls
      // self-terminate, which is exactly the bug this line used to be.
      const name = String(f.name ?? '');
      toolCalls.push({
        name,
        callId: String(f.call_id ?? ''),
        error: (f.error as string) ?? null,
      });
      progress(name);
    };
    const onUsage = (f: ServerFrame) => {
      const deltaTokens = Number(f.input ?? 0) + Number(f.output ?? 0);
      const deltaDollars = deltaTokens * (rates.dollarPerToken ?? 0);
      usage.input += Number(f.input ?? 0);
      usage.output += Number(f.output ?? 0);
      const tokens = usage.input + usage.output;
      const dollars = tokens * (rates.dollarPerToken ?? 0);
      if (tokens > task.maxTokens || dollars > task.maxDollars) budgetBroken = true;
      this.emit('usage', tokens);
      // Persist the flow mid-run so a crash loses minutes, not the whole
      // turn — and so a coordinator-side breach stops the run even if the
      // in-memory ceiling hasn't tripped yet.
      if (deltaTokens > 0) {
        void track(
          this.coord
            .reportUsage(tenant, requestId, { tokens: deltaTokens, dollars: deltaDollars })
            .then((r) => {
              if (r.state === 'TERMINATED_BUDGET') budgetBroken = true;
              progress();
            })
            .catch((e) => {
              // Custom event name: safe without listeners (only 'error' throws).
              this.emit('progressError', { requestId, error: (e as Error).message });
            }),
        );
      } else {
        progress();
      }
    };

    client.on('frame:permission_request', (f) => {
      void track(onPermission(f));
    });
    client.on('frame:text_delta', onText);
    client.on('frame:tool_done', onToolDone);
    client.on('frame:token_usage', onUsage);

    let status: RunResult['status'] = 'COMPLETED';
    let refusalReason: string | undefined;
    // Bare `error` events (no reply_to) are the real bridge's failure
    // channel: legacy errors for a normal message arrive as events, never as
    // correlated replies. Correlated errors already reject their own request
    // (client.onData), so only unattributed ones fail the turn here.
    const onRunError = (f: ServerFrame): void => {
      if (typeof f.reply_to === 'number') return;
      if (turnError === null) turnError = String(f.message ?? f.code ?? 'harness error');
    };

    // Execution lease heartbeat: actively renew our claim so long-running turns
    // don't get reclaimed as stale.
    const leaseHeartbeat = setInterval(() => {
      void (async () => {
        const killed =
          (await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'));
        if (killed && turnError === null) {
          turnError = `kill switch engaged for scope "${req.targetScope}" — mid-turn execution halted`;
          void client.cancel(sessionId).catch(() => {});
        }
        await this.coord.renewExecutionLease(tenant, requestId, task.onBehalfOf, new Date().toISOString());
      })().catch((e) => {
        if (turnError === null) {
          turnError = `execution lease lost: ${(e as Error).message}`;
        }
      });
    }, 25_000);
    leaseHeartbeat.unref?.();

    try {
      await client.connect();
      sessionId = await client.createSession(task.workingDir);
      await client.attach(sessionId);
      await this.coord.accept(tenant, requestId);

      client.on('frame:error', onRunError);
      // A daemon-side disconnect is a turn failure, not a 60s wait: the
      // poll in waitForTurn sees turnError within 50ms and fails fast.
      // (Set after 'done' already resolved, this assignment is harmless.)
      client.once('close', () => {
        if (turnError === null) turnError = 'harness disconnected';
      });
      await client.send(sessionId, prompt);
      const turn = await this.waitForTurn(
        client,
        sessionId,
        task.maxDollars,
        () => budgetBroken,
        () => turnError,
        task.turnTimeoutMs ?? 60_000,
      );
      client.removeListener('frame:error', onRunError);
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
      } else if (turn === 'error') {
        const err = turnError as string | null;
        status = err?.includes('kill switch') || err?.includes('content screen') ? 'DENIED' : 'FAILED';
        refusalReason = err ?? 'harness reported an error';
      }

      // Deliverable artifact persistence: store raw transcript via FilesystemArtifactStore
      // so rawArtifactRef and fullTextRef point to durable content.
      const rawTranscript = transcript.join('');
      let artifactRef: string | undefined;
      try {
        const safeTenant = tenant.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeReq = requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const artifactName = `jcode-${safeTenant}-${safeReq}-${Date.now()}.txt`;
        artifactRef = this.artifactStore.put(artifactName, rawTranscript);
      } catch (e) {
        this.emit('progressError', { requestId, error: `artifact store failed: ${(e as Error).message}` });
      }

      // Deliverable + provenance claim, then close the request.
      const summary = rawTranscript.slice(0, 4000);
      const out = await this.ledger.append({
        tenant,
        subject: `jcode:${req.targetScope}`,
        kind: 'OBSERVATION',
        statement: `harness run: ${toolCalls.length} tool calls, ${usage.input + usage.output} tokens${transcriptTruncated ? ' (transcript truncated)' : ''}`,
        value: {
          toolCalls: toolCalls.slice(0, MAX_CLAIM_TOOL_CALLS),
          totalToolCalls: toolCalls.length,
          toolCallsTruncated: toolCalls.length > MAX_CLAIM_TOOL_CALLS,
          transcriptTruncated,
          usage,
          permissions,
          fullTextRef: artifactRef ?? null,
        },
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
          rawArtifactRef: artifactRef,
        },
      });
      claimIds.push(out.id);

      if (status === 'COMPLETED') {
        // complete() records claims, not cost: every token already flowed
        // through reportUsage mid-run, so re-adding usage here would
        // double-count. spent.tokens on the request IS the run's total.
        await this.coord.complete(tenant, requestId, {
          claims: claimIds,
          cost: {
            tokens: usage.input + usage.output,
            dollars: (usage.input + usage.output) * (rates.dollarPerToken ?? 0),
          },
        });
        await this.recordTrace(tenant, req, sessionId, summary, usage);
      } else {
        // The request may already be TERMINATED_BUDGET — reportUsage can kill
        // it mid-run before the in-memory ceiling trips. Failing it again
        // would overwrite TERMINATED_BUDGET with FAILED (terminal→FAILED is
        // legal), so read first and only fail a non-terminal request.
        const current = await this.coord.get(tenant, requestId);
        if (current?.state === 'TERMINATED_BUDGET') {
          status = 'TERMINATED_BUDGET';
          refusalReason = current.refusalReason ?? refusalReason;
        } else {
          await this.coord.fail(tenant, requestId, refusalReason ?? 'unknown failure');
        }
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
      const msg = (e as Error).message;
      status = msg.includes('[jcode:HALTED]') || msg.includes('[jcode:DENIED]') ? 'DENIED' : 'FAILED';
      refusalReason = msg;
      try {
        await this.coord.fail(tenant, requestId, refusalReason);
      } catch {
        /* already terminal */
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
    } finally {
      clearInterval(leaseHeartbeat);
      client.close();
    }
  }

  private waitForTurn(
    client: JcodeClient,
    sessionId: string,
    _maxDollars: number,
    budgetHit: () => boolean,
    errorHit: () => string | null,
    timeoutMs: number,
  ): Promise<'done' | 'budget' | 'timeout' | 'error'> {
    return new Promise((resolve) => {
      const finish = (v: 'done' | 'budget' | 'timeout' | 'error'): void => {
        clearInterval(poll);
        clearTimeout(limit);
        client.removeListener('frame:turn_done', done);
        resolve(v);
      };
      // Await the cancel round-trip so the harness actually observes it
      // before the run closes the socket under the write. If the harness is
      // gone, the budget breach stands regardless — resolve anyway.
      const finishBudget = () => {
        clearInterval(poll);
        clearTimeout(limit);
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
        else if (errorHit() !== null) finish('error');
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
        if (errorHit() !== null) {
          finish('error');
          return;
        }
        finish('done');
      }
      client.on('frame:turn_done', done);
      const finishTimeout = () => {
        clearInterval(poll);
        clearTimeout(limit);
        client.removeListener('frame:turn_done', done);
        let settled = false;
        const fin = (): void => {
          if (!settled) {
            settled = true;
            resolve('timeout');
          }
        };
        client.cancel(sessionId).then(fin, fin);
        setTimeout(fin, 2000).unref?.();
      };
      const limit = setTimeout(() => {
        finishTimeout();
      }, timeoutMs);
      limit.unref?.();
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
