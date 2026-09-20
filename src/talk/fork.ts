import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { type BuzzSurface } from './buzz.ts';
import type { ChatMessage } from '../substrate/models.ts';

export interface ForkRunParams {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ForkModelRun {
  model: string;
  provider: string;
  temperature: number;
  maxOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  recommendation: string;
  reasoning: string;
}

export interface DecisionForkDiff {
  originalDecisionId: string;
  requestId: string;
  originalParams: {
    model: string;
    temperature: number;
    tokens: number;
    recommendation: string;
    confidence: number;
  };
  forkedParams: {
    model: string;
    temperature: number;
    tokens: number;
    recommendation: string;
    confidence: number;
  };
  reasoningDiff: {
    original: string;
    forked: string;
  };
  sandboxRequestId: string;
  sideBySideMarkdown: string;
}

/**
 * Time-travel fork: re-runs a past decision through a real model with
 * alternative parameters and posts the side-by-side diff.
 *
 * Honesty contract (AUDIT.md F15 lesson — simulated improvements must never
 * pose as real ones): the forked side of the diff is produced by an actual
 * model call through the approved-model chokepoint, or the whole fork fails
 * closed. The old implementation invented both sides — hardcoded
 * `claude-3-haiku` original params and a forked recommendation chosen by
 * substring-matching the model name — which produced confident, fabricated
 * counterfactuals.
 */
export class TimeTravelForkEngine {
  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord?: Coordinator,
    private readonly surface?: BuzzSurface,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Real original-run metadata from the traces table; unknown fields stay 'unknown'. */
  private async loadOriginalRun(
    tenant: string,
    requestId: string,
  ): Promise<{ model: string; temperature: number; tokens: number }> {
    const row = (await this.db
      .prepare(`SELECT cost_json FROM traces WHERE tenant = ? AND request_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(tenant, requestId)) as { cost_json: string } | undefined;
    let cost: { model?: string; temperature?: number; tokens?: number; input?: number; output?: number } = {};
    try {
      if (row?.cost_json) cost = JSON.parse(row.cost_json);
    } catch {
      // unknown cost payload stays unknown
    }
    const rawSum = Number(cost.input ?? 0) + Number(cost.output ?? 0);
    const tokens = Number(cost.tokens ?? (rawSum || 0));
    return {
      model: typeof cost.model === 'string' && cost.model ? cost.model : 'unknown',
      temperature: Number.isFinite(Number(cost.temperature)) ? Number(cost.temperature) : 0,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    };
  }

  /** Executes a real forked model call through the approved-model chokepoint. */
  private async runForkedModel(
    tenant: string,
    goal: string,
    grounding: string,
    original: { recommendation: string; reasoning: string },
    params: ForkRunParams,
    env: NodeJS.ProcessEnv = process.env,
    fetchFn: typeof fetch = fetch,
  ): Promise<ForkModelRun> {
    const { devProfile, prodProfile, readApiKey, completeChat, assertApproved, ModelError } =
      await import('../substrate/models.ts');

    // The fork runs on the production lane by default (a counterfactual wants
    // the strongest approved model); an explicit dev lane override keeps CI
    // and local experiments honest without touching prod keys.
    const lane = env.VITAL_FORK_LANE === 'dev' ? 'dev' : 'production';
    const profile = lane === 'dev' ? devProfile(env) : prodProfile(env);
    if (params.model) profile.model = params.model;
    if (params.temperature !== undefined) profile.temperature = params.temperature;
    if (params.maxTokens !== undefined) profile.maxOutputTokens = params.maxTokens;

    // Fail closed before any wire call: an unapproved or unconfigured model
    // means NO fork, not a fork with invented output.
    assertApproved(profile, lane, env);
    const apiKey = readApiKey(env, profile);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        text:
          'You are re-running a past decision under alternative parameters (a counterfactual fork). ' +
          'Ground only in the provided evidence. Reply with your recommended action and a one-line rationale.',
      },
      {
        role: 'user',
        text: [
          `Decision context: ${goal}`,
          grounding ? `Evidence on record:\n${grounding}` : 'No evidence claims are bound to this decision.',
          `The original run decided: "${original.recommendation}" (${original.reasoning})`,
          'Decide afresh from the evidence; do not simply restate the original decision.',
        ].join('\n\n'),
      },
    ];

    let result;
    try {
      result = await completeChat(profile, apiKey, messages, fetchFn);
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw new ModelError('MODEL_CALL_FAILED', String((e as Error).message ?? e));
    }
    const text = result.text.trim();
    if (!text) {
      throw new ModelError('EMPTY_RESPONSE', 'forked model returned no content: no counterfactual exists');
    }

    return {
      model: profile.model,
      provider: profile.provider,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      recommendation: text,
      reasoning: `Executed fork on ${profile.provider}/${profile.model} at temperature ${profile.temperature}.`,
    };
  }

  async forkRun(
    tenant: string,
    targetIdentifier: { requestId?: string; decisionId?: string },
    forkParams: ForkRunParams,
    opts: { threadRoot?: string; channel?: string; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {},
  ): Promise<DecisionForkDiff> {
    const at = this.now();
    let requestId = targetIdentifier.requestId;

    // ---- Original side: only real recorded data. Missing pieces stay
    // 'unknown' rather than borrowing a plausible-looking default. ----
    const originalDecisionId = targetIdentifier.decisionId ?? 'unknown';
    let originalRec = 'unknown';
    let originalReasoning = 'No decision record found for this identifier.';

    let dec: Awaited<ReturnType<Ledger['getDecision']>> | null = null;
    if (targetIdentifier.decisionId) {
      dec = (await this.ledger.getDecision(tenant, targetIdentifier.decisionId)) ?? null;
      requestId = requestId ?? dec?.requestId ?? undefined;
    } else if (requestId) {
      dec = (await this.ledger.getDecisionByRequest(tenant, requestId)) ?? null;
    }
    if (dec) {
      originalRec = dec.action;
      originalReasoning =
        dec.bundle.claims && dec.bundle.claims.length > 0
          ? `Grounded in ${dec.bundle.claims.length} evidence claim(s): ${dec.bundle.claims
              .map((c) => c.id)
              .join(', ')}.`
          : 'No evidence claims were bound to this decision.';
    }

    if (!requestId) {
      throw new Error('[fork:UNKNOWN_TARGET] no requestId or decisionId resolved: nothing to fork');
    }

    const {
      model: originalModel,
      temperature: originalTemp,
      tokens: originalTokens,
    } = await this.loadOriginalRun(tenant, requestId);

    // ---- Sandbox request: recorded so the fork leaves a durable trail. ----
    const sandboxRequestId = `snd_${randomUUID().slice(0, 8)}`;
    if (this.coord) {
      // Origin inherits the original request's scope where possible; the
      // coordinator refuses self-delegation, so the #sandbox target can never
      // also be the origin (the old experimental→experimental submit was
      // silently swallowed and never actually created a request).
      let originScope = dec?.scope && dec.scope !== 'experimental' ? dec.scope : 'general';
      try {
        const orig = await this.coord.get(tenant, requestId);
        if (orig?.originScope && orig.originScope !== 'experimental') {
          originScope = orig.originScope;
        } else if (orig?.targetScope && orig.targetScope !== 'experimental') {
          originScope = orig.targetScope;
        }
      } catch {
        // unknown origin falls back to general or dec.scope
      }
      const targetScope = originScope === 'experimental' ? 'general' : 'experimental';
      try {
        await this.coord.submit({
          tenant,
          messageClass: 'REQUEST',
          originScope,
          targetScope,
          goal: `[FORK-RUN] Re-run of ${requestId} with model=${forkParams.model ?? 'default'}`,
          claimRefs: dec?.bundle.claims?.length ? dec.bundle.claims.map((c) => c.id) : ['clm_sandbox_grounding'],
          deliverableSchema: 'fork.sandbox_diff',
          bid: { dollars: 5, tokens: 100_000, humanMinutes: 0 },
          onBehalfOf: 'human:time_travel_fork',
          now: at,
        });
      } catch (e) {
        throw new Error(`[fork:SANDBOX_SUBMIT_FAILED] ${String((e as Error).message ?? e)}`, { cause: e });
      }
    }

    // ---- Forked side: a real model execution, or fail closed. ----
    const grounding = dec?.bundle.claims.map((c) => `- [${c.id}] ${c.statement}`).join('\n') ?? '';
    let forked: ForkModelRun;
    try {
      forked = await this.runForkedModel(
        tenant,
        dec?.goal ?? requestId,
        grounding,
        {
          recommendation: originalRec,
          reasoning: originalReasoning,
        },
        forkParams,
        opts.env,
        opts.fetchFn ?? fetch,
      );
    } catch (e) {
      // Fail closed with the model error intact — the operator sees exactly
      // why no counterfactual exists (missing key, unapproved model, wire
      // failure, empty response).
      throw new Error(`[fork:MODEL_RUN_FAILED] ${String((e as Error).message ?? e)}`, { cause: e });
    }

    // ---- Record the forked decision so the diff has provenance. ----
    if (dec) {
      try {
        await this.ledger.recordDecision({
          tenant,
          requestId: sandboxRequestId,
          goal: `Fork alternative for ${requestId}`,
          action: forked.recommendation,
          actionClass: 'RECOMMEND',
          claimIds: dec.bundle.claims.map((c) => c.id),
          decidedBy: `fork:${forked.model}`,
          scope: 'experimental',
          // Ledger decision vocabulary is autonomous|approval|human-command.
          autonomy: 'approval',
        });
      } catch (e) {
        throw new Error(`[fork:DECISION_RECORD_FAILED] ${String((e as Error).message ?? e)}`, { cause: e });
      }
    }

    // ---- Persist the real token spend on the sandbox request row. ----
    // Dollar charging stays with coord.charge/reportUsage — this line never
    // invents a dollar figure for a call whose price is unknown here.
    try {
      await this.db
        .prepare(`UPDATE requests SET spent_tokens = spent_tokens + ?, updated_at = ? WHERE id = ? AND tenant = ?`)
        .run(forked.inputTokens + forked.outputTokens, at, sandboxRequestId, tenant);
    } catch {
      // usage persistence is best-effort; the trace is the authority
    }

    const forkedTokens = forked.inputTokens + forked.outputTokens;
    // Grounding flag, not a probability: 1 when the forked decision binds the
    // same evidence claims as the original, 0 when nothing is grounded. The
    // old code rendered an arbitrary 0.74 → 0.93 confidence delta from
    // nowhere — a number with no measurement behind it.
    const grounded = dec !== null && dec.bundle.claims.length > 0;

    // ---- Side-by-side diff. Both sides are real runs now. ----
    const sideBySideMarkdown = [
      `🔀 **[TIME-TRAVEL FORK: real re-run on ${forked.provider}/${forked.model}]**`,
      `Re-executed decision for request \`${requestId}\` in #sandbox with alternative parameters.`,
      '',
      `| Dimension | Original Run (\`${originalDecisionId}\`) | Forked Re-Run (\`${sandboxRequestId}\`) |`,
      `| :--- | :--- | :--- |`,
      `| **Model** | \`${originalModel}\` | \`${forked.model}\` |`,
      `| **Temperature** | \`${originalTemp}\` | \`${forked.temperature}\` |`,
      `| **Token Spend** | \`${originalTokens.toLocaleString()}\` | \`${forkedTokens.toLocaleString()}\` |`,
      `| **Recommendation** | ${originalRec} | **${forked.recommendation}** |`,
      '',
      `**Reasoning Trajectory Delta**:`,
      `- **Original**: *"${originalReasoning}"*`,
      `- **Forked**: *"${forked.reasoning}"*`,
      '',
      `[ 👍 Apply Forked Outcome ] · [ ❌ Discard Sandbox Run ]`,
    ].join('\n');

    // ---- Post comparison back into originating thread. ----
    if (this.surface && opts.channel) {
      void this.surface
        .post({
          channel: opts.channel,
          threadRoot: opts.threadRoot,
          requestId: sandboxRequestId,
          step: 1,
          tokens: forkedTokens,
          state: 'FORK_DIFF',
          text: sideBySideMarkdown,
        })
        .catch(() => {});
    }

    return {
      originalDecisionId,
      requestId,
      originalParams: {
        model: originalModel,
        temperature: originalTemp,
        tokens: originalTokens,
        recommendation: originalRec,
        confidence: grounded ? 1 : 0,
      },
      forkedParams: {
        model: forked.model,
        temperature: forked.temperature,
        tokens: forkedTokens,
        recommendation: forked.recommendation,
        confidence: grounded ? 1 : 0,
      },
      reasoningDiff: {
        original: originalReasoning,
        forked: forked.reasoning,
      },
      sandboxRequestId,
      sideBySideMarkdown,
    };
  }
}
