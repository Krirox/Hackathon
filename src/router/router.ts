import type { AsyncDb } from '../core/db.ts';
import { ROUTING_CLASSES, type RoutingClass } from '../core/types.ts';

export class RouterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[router:${code}] ${message}`);
  }
}

/**
 * Cognitive Router v2 — FOUR execution classes, not seven tiers.
 *
 *   REFLEX     deterministic code / cached / rule            ~0 cost
 *   WORKFLOW   a PROMOTED Skill Card, in its validated scope  low
 *   MODEL      one reasoning pass on a chosen harness/tier    med-high
 *   HUMAN      human decides, agent supplies evidence         highest
 *
 * Design constraints this file enforces:
 *   R1  Deterministic policy first. A learned model only sees ambiguous input.
 *   R2  Shadow mode until proven. The router proposes; a fixed safe policy
 *       executes; control is granted only after routing precision clears its
 *       gate on the last N tasks.
 *   R3  Asymmetric loss. For irreversible actions, misrouting DOWN is
 *       catastrophic — so the router fails UP (escalate).
 *   R4  Per-class error budgets. Breach ⇒ auto-revert to the fixed policy.
 *   R5  Coupling guard. A Skill Card may only run at the tier, in the scope,
 *       and on the models it was validated at. This is what stops
 *       router+compiler compounding transfer failure.
 */

export const IRREVERSIBLE = new Set(['ACT_IRREVERSIBLE']);
export const REVERSIBLE_OR_LESS = new Set(['READ', 'ANALYZE', 'RECOMMEND', 'ACT_REVERSIBLE']);

export interface RouteInput {
  tenant: string;
  taskType: string;
  scope: string;
  actionClass: string;
  /** 0..1 — caller's estimate of stakes. */
  importance: number;
  reversible: boolean;
  /** 0..1 model/provider confidence, if known. */
  confidence?: number;
  /** External, unverified content involved? Bias upward. */
  touchesExternalUnverified?: boolean;
  /**
   * The model/harness this task will run on, when already known. Model
   * selection usually happens below the tier decision, so this stays
   * optional — but a caller that knows must declare it: it is what lets the
   * coupling guard pin a WORKFLOW card to the models it was validated on.
   */
  model?: string;
  /** A candidate Skill Card for this intent, if one exists. */
  skillCard?: {
    id: string;
    state: string;
    validatedAtTier: RoutingClass;
    scopeRoles: string[];
    scopeModels: string[];
  } | null;
  latencyBudgetMs?: number;
  now?: string;
}

export interface RouteDecision {
  tier: RoutingClass;
  reason: string;
  /** Harness/model hint for MODEL tier; Skill Card id for WORKFLOW. */
  target: string;
  policyRule: string | null;
  shadow: boolean;
  /** The tier a fixed policy WOULD have chosen, for shadow comparison. */
  policyBaseline: RoutingClass;
  /** Coupling-guard violations, if any. */
  guards: string[];
}

export interface RouterConfig {
  /** Fraction of traffic where the router actually controls execution. */
  controlRate: number;
  /** Routing precision required before controlRate may rise. */
  precisionGate: number;
  /** Minimum evaluated tasks before the gate is meaningful. */
  minSamples: number;
  /** Error budget per tier: max acceptable downstream failure rate. */
  errorBudgets: Record<RoutingClass, number>;
  /** Task types the deterministic policy knows how to handle outright. */
  reflexRegistry: Record<string, string>;
  /** Task types that must never go below MODEL. */
  modelFloor: Set<string>;
  /** Task types that must always reach a human. */
  humanOnly: Set<string>;
  modelTier: string;
  /** Random source for the shadow/control split. Injected for reproducibility in tests. */
  rng?: () => number;
  /** Task types the router knows. Unknown types are refused, not guessed. */
  knownTaskTypes?: Set<string>;
  /**
   * R4 overrides: a tier forced onto the fixed baseline after blowing its
   * error budget. Set by `revertBreachedTiers`, cleared by hand after
   * recalibration — auto-revert is immediate, auto-forgive is not a thing.
   */
  tierBaselineOnly?: Partial<Record<RoutingClass, boolean>>;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  controlRate: 0,
  precisionGate: 0.9,
  minSamples: 2000,
  errorBudgets: { REFLEX: 0.02, WORKFLOW: 0.05, MODEL: 0.1, HUMAN: 0.02 },
  reflexRegistry: {
    'release.detect': 'changelog-parser',
    'release.summarize': 'template-change-summary',
    'pricing.fetch': 'pricing-page-diff',
    'metrics.fetch': 'warehouse-query',
    'digest.assemble': 'digest-composer',
  },
  modelFloor: new Set(['launch.copy.draft', 'market.signal.triage', 'customer.pattern.detect']),
  humanOnly: new Set(['claim.external_publish', 'pricing.change', 'contract.sign', 'refund.issue']),
  modelTier: 'frontier',
  /** Every task declares its type or is refused (§4: task-type registry). */
  knownTaskTypes: new Set([
    'release.detect',
    'release.summarize',
    'pricing.fetch',
    'metrics.fetch',
    'digest.assemble',
    'launch.copy.draft',
    'market.signal.triage',
    'customer.pattern.detect',
    'claim.external_publish',
    'pricing.change',
    'contract.sign',
    'refund.issue',
    'engineering.implement',
    'support.macro.draft',
    'sales.battlecard.draft',
    'budget.check',
    'pain.link',
  ]),
};

export class CognitiveRouter {
  constructor(
    private readonly db: AsyncDb,
    private readonly cfg: RouterConfig = DEFAULT_ROUTER_CONFIG,
  ) {}

  /** Fixed, deterministic baseline — the thing that runs while we are in shadow. */
  private baseline(input: RouteInput): { tier: RoutingClass; target: string; rule: string | null } {
    if (this.cfg.humanOnly.has(input.taskType)) {
      return { tier: 'HUMAN', target: 'human:review', rule: 'humanOnly registry' };
    }
    if (IRREVERSIBLE.has(input.actionClass) || !input.reversible) {
      return { tier: 'HUMAN', target: 'human:review', rule: 'fail-up: irreversible action' };
    }
    const reflex = this.cfg.reflexRegistry[input.taskType];
    if (reflex) return { tier: 'REFLEX', target: reflex, rule: 'reflex registry' };
    if (this.cfg.modelFloor.has(input.taskType)) {
      return { tier: 'MODEL', target: this.cfg.modelTier, rule: 'modelFloor registry' };
    }
    return { tier: 'MODEL', target: this.cfg.modelTier, rule: null };
  }

  /** Learned/ambiguous path: only consulted when the policy has no opinion. */
  private async learned(input: RouteInput): Promise<RoutingClass> {
    // Coupling guard: a WORKFLOW is only legal if the card is PROMOTED, was
    // validated at WORKFLOW, the current scope is inside its validated role
    // set, and — when the caller has declared the model — that model is one
    // the card was validated on. Anything else silently degrades to MODEL.
    // An undeclared model is not a bypass: selection happens below the tier
    // decision there, and the card's own execution is bounded to its
    // validated models downstream.
    const card = input.skillCard;
    if (card && card.state === 'PROMOTED' && card.validatedAtTier === 'WORKFLOW') {
      const modelOk = input.model === undefined || card.scopeModels.includes(input.model);
      if (card.scopeRoles.includes(input.scope) && modelOk) return 'WORKFLOW';
    }
    if (input.touchesExternalUnverified) return 'MODEL';
    if ((input.confidence ?? 1) < 0.6 || input.importance > 0.7) return 'MODEL';
    const hist = await this.historicalSuccess(input.tenant, input.taskType);
    if (hist && hist.successRate >= 0.95 && hist.samples >= 50 && input.importance < 0.5) {
      return 'REFLEX';
    }
    return 'MODEL';
  }

  private async historicalSuccess(
    tenant: string,
    taskType: string,
  ): Promise<{ successRate: number; samples: number } | null> {
    // Tenant-scoped by construction: another tenant's outcomes must never
    // route this tenant's work (isolation), and the predicate matches the
    // (tenant, task_type) access shape instead of scanning shared history.
    const row = (await this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END) AS s
           FROM traces WHERE tenant = ? AND task_type = ?`,
      )
      .get(tenant, taskType)) as { n: number; s: number } | undefined;
    if (!row || Number(row.n) === 0) return null;
    return { samples: Number(row.n), successRate: Number(row.s) / Number(row.n) };
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    if (this.cfg.knownTaskTypes && !this.cfg.knownTaskTypes.has(input.taskType)) {
      throw new RouterError(
        'UNKNOWN_TASK_TYPE',
        `task "${input.taskType}" declares no type — register it or refuse the work`,
      );
    }
    const base = this.basePolicy(input);
    const learnedTier = await this.learned(input);
    const guards: string[] = [];

    // R1: policy wins whenever it has a rule.
    let proposed = base.rule ? base.tier : learnedTier;

    // R3: never allow the proposal to sit BELOW the baseline for irreversible or
    // externally-unverified work. Failing up is always acceptable.
    const rank: Record<RoutingClass, number> = { REFLEX: 0, WORKFLOW: 1, MODEL: 2, HUMAN: 3 };
    if (!input.reversible || IRREVERSIBLE.has(input.actionClass)) {
      if (rank[proposed] < rank[base.tier]) {
        guards.push('fail_up_applied');
        proposed = base.tier;
      }
    }
    if (input.skillCard && input.skillCard.state === 'PROMOTED' && !input.skillCard.scopeRoles.includes(input.scope)) {
      guards.push('skill_scope_mismatch_demoted_to_MODEL');
    }
    // A declared model outside the card's validated set is the same
    // transfer-without-evidence failure, one axis over — name it too.
    if (
      input.skillCard &&
      input.skillCard.state === 'PROMOTED' &&
      input.model !== undefined &&
      !input.skillCard.scopeModels.includes(input.model)
    ) {
      guards.push('skill_model_mismatch_demoted_to_MODEL');
    }

    // R2: shadow unless control rate grants it. RNG is injectable via
    // cfg.rng so shadow/control is reproducible in tests.
    const rand = this.cfg.rng ?? Math.random;
    const shadow = rand() >= this.cfg.controlRate;
    let executed = shadow ? base.tier : proposed;
    // R4: a tier past its error budget runs the fixed policy, even in control.
    if (this.cfg.tierBaselineOnly?.[executed] === true && executed !== base.tier) {
      guards.push(`budget_revert_${executed}_to_baseline`);
      executed = base.tier;
    }

    const decision: RouteDecision = {
      tier: executed,
      reason: shadow
        ? `shadow: router proposed ${proposed}, policy executed ${base.tier}`
        : `router control: ${proposed}`,
      target: executed === 'WORKFLOW' ? (input.skillCard?.id ?? this.cfg.modelTier) : base.targetFor(executed, input),
      policyRule: base.rule,
      shadow,
      policyBaseline: base.tier,
      guards,
    };
    await this.record(input, decision, proposed);
    return decision;
  }

  private basePolicy(input: RouteInput) {
    const b = this.baseline(input);
    return {
      ...b,
      targetFor: (tier: RoutingClass, i: RouteInput): string => {
        if (tier === 'REFLEX') return this.cfg.reflexRegistry[i.taskType] ?? 'rule:default';
        if (tier === 'WORKFLOW') return i.skillCard?.id ?? 'workflow:none';
        if (tier === 'HUMAN') return 'human:review';
        return this.cfg.modelTier;
      },
    };
  }

  private async record(input: RouteInput, d: RouteDecision, proposed: RoutingClass): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO routing_decisions
         (tenant, task_type, scope, action_class, proposed, executed, policy_baseline,
          shadow, guards, skill_card, confidence, importance, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.tenant,
        input.taskType,
        input.scope,
        input.actionClass,
        proposed,
        d.tier,
        d.policyBaseline,
        d.shadow ? 1 : 0,
        JSON.stringify(d.guards),
        input.skillCard?.id ?? null,
        input.confidence ?? null,
        input.importance,
        input.now ?? new Date().toISOString(),
      );
  }

  /**
   * Gate for raising controlRate. Compares what the router proposed against the
   * human/outcome-labeled correct tier. Rows stay unlabeled until the outcome
   * resolves, which is why this needs minSamples before it means anything.
   */
  async precision(tenant: string): Promise<{
    samples: number;
    precision: number;
    byTier: Record<string, { n: number; ok: number }>;
    readyForControl: boolean;
  }> {
    const rows = (await this.db
      .prepare(
        `SELECT proposed, correct_tier FROM routing_decisions
           WHERE tenant = ? AND labeled = 1 AND correct_tier IS NOT NULL`,
      )
      .all(tenant)) as { proposed: string; correct_tier: string }[];
    const byTier: Record<string, { n: number; ok: number }> = {};
    let ok = 0;
    for (const r of rows) {
      const k = String(r.proposed);
      byTier[k] ??= { n: 0, ok: 0 };
      byTier[k]!.n += 1;
      if (k === String(r.correct_tier)) {
        byTier[k]!.ok += 1;
        ok += 1;
      }
    }
    const precision = rows.length === 0 ? 0 : ok / rows.length;
    return {
      samples: rows.length,
      precision,
      byTier,
      readyForControl: rows.length >= this.cfg.minSamples && precision >= this.cfg.precisionGate,
    };
  }

  /** Label a tenant's routing decision with an explicit reviewer and atomic audit. */
  async label(tenant: string, id: number, correctTier: RoutingClass, reviewer: string): Promise<void> {
    if (typeof reviewer !== 'string' || !reviewer.trim()) {
      throw new RouterError('NO_REVIEWER', 'a routing label requires a named reviewer');
    }
    if (!ROUTING_CLASSES.includes(correctTier)) {
      throw new RouterError('BAD_TIER', `correctTier must be one of ${ROUTING_CLASSES.join(', ')}`);
    }
    await this.db.transaction(async () => {
      // Serialize relabels on Postgres so the audit's before state is authoritative.
      const lock = this.db.engine === 'postgres' ? ' FOR UPDATE' : '';
      const row = (await this.db
        .prepare(`SELECT labeled, correct_tier FROM routing_decisions WHERE tenant = ? AND id = ?${lock}`)
        .get(tenant, id)) as { labeled: number; correct_tier: RoutingClass | null } | undefined;
      if (!row) throw new RouterError('NOT_FOUND', 'routing decision not found');
      const updated = await this.db
        .prepare('UPDATE routing_decisions SET labeled = 1, correct_tier = ? WHERE tenant = ? AND id = ?')
        .run(correctTier, tenant, id);
      if (updated.changes === 0) throw new RouterError('NOT_FOUND', 'routing decision not found');
      await this.db
        .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
        .run(
          tenant,
          reviewer,
          'ROUTING_DECISION_LABELED',
          String(id),
          JSON.stringify({
            before: { labeled: Boolean(row.labeled), correctTier: row.correct_tier },
            after: { labeled: true, correctTier },
          }),
          new Date().toISOString(),
        );
    });
  }

  /**
   * Label pipeline, honest edition (TODO §4): outcomes NEVER auto-label.
   * Writing `executed` back as `correct_tier` would agree with the router
   * by construction and inflate precision — the metric would lie. Instead
   * this returns the queue: unlabeled decisions with linked trace-outcome
   * evidence, for explicit human review via `label()`.
   */
  async labelingQueue(
    tenant: string,
    limit = 50,
  ): Promise<
    {
      id: number;
      taskType: string;
      scope: string;
      actionClass: string;
      proposed: string;
      executed: string;
      evidence: { traces: number; successRate: number | null };
    }[]
  > {
    const rows = (await this.db
      .prepare(
        `SELECT id, task_type, scope, action_class, proposed, executed FROM routing_decisions
          WHERE tenant = ? AND labeled = 0 ORDER BY id LIMIT ?`,
      )
      .all(tenant, limit)) as {
      id: number;
      task_type: string;
      scope: string;
      action_class: string;
      proposed: string;
      executed: string;
    }[];
    const out: {
      id: number;
      taskType: string;
      scope: string;
      actionClass: string;
      proposed: string;
      executed: string;
      evidence: { traces: number; successRate: number | null };
    }[] = [];
    for (const r of rows) {
      const ev = (await this.db
        .prepare(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END) AS s
             FROM traces WHERE tenant = ? AND task_type = ? AND scope = ?`,
        )
        .get(tenant, String(r.task_type), String(r.scope))) as { n: number; s: number | null };
      const n = Number(ev.n);
      out.push({
        id: Number(r.id),
        taskType: String(r.task_type),
        scope: String(r.scope),
        actionClass: String(r.action_class),
        proposed: String(r.proposed),
        executed: String(r.executed),
        evidence: { traces: n, successRate: n === 0 ? null : Number(ev.s ?? 0) / n },
      });
    }
    return out;
  }

  /**
   * R4: consume error budget per tier from realized trace outcomes.
   * A tier that blows its budget must auto-revert to the fixed policy.
   */
  async budgetBreaches(
    tenant: string,
  ): Promise<{ tier: RoutingClass; failureRate: number; budget: number; samples: number }[]> {
    const breaches: { tier: RoutingClass; failureRate: number; budget: number; samples: number }[] = [];
    for (const tier of ['REFLEX', 'WORKFLOW', 'MODEL', 'HUMAN'] as RoutingClass[]) {
      const row = (await this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN outcome = 'FAILURE' THEN 1 ELSE 0 END) AS f
             FROM traces WHERE tenant = ? AND tier = ?`,
        )
        .get(tenant, tier)) as { n: number; f: number };
      const n = Number(row.n);
      const rate = n === 0 ? 0 : Number(row.f) / n;
      if (n >= 50 && rate > this.cfg.errorBudgets[tier]) {
        breaches.push({ tier, failureRate: rate, budget: this.cfg.errorBudgets[tier], samples: n });
      }
    }
    return breaches;
  }

  setControlRate(rate: number): void {
    this.cfg.controlRate = Math.max(0, Math.min(1, rate));
  }
  get controlRate(): number {
    return this.cfg.controlRate;
  }

  /** Declare a new task type. Undeclared types stay refused. */
  registerTaskType(taskType: string): void {
    (this.cfg.knownTaskTypes ??= new Set()).add(taskType);
  }

  /**
   * R4, wired: every breached tier reverts to the fixed policy immediately.
   * Recovery is manual (`clearTierOverride`) after recalibration proves the
   * tier healthy — the router forgives nothing on its own.
   */
  async revertBreachedTiers(tenant: string): Promise<RoutingClass[]> {
    const reverted: RoutingClass[] = [];
    for (const breach of await this.budgetBreaches(tenant)) {
      (this.cfg.tierBaselineOnly ??= {})[breach.tier] = true;
      reverted.push(breach.tier);
    }
    return reverted;
  }

  clearTierOverride(tier: RoutingClass): void {
    if (this.cfg.tierBaselineOnly) delete this.cfg.tierBaselineOnly[tier];
  }

  /**
   * Reflex coverage (TODO §4): what fraction of routed traffic did the
   * deterministic policy handle alone (REFLEX executed)? Target ≥80% —
   * the learned layer is optional, never load-bearing.
   */
  async reflexCoverage(tenant: string): Promise<{ total: number; reflex: number; rate: number }> {
    const rows = (await this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN executed = 'REFLEX' THEN 1 ELSE 0 END) AS reflex
           FROM routing_decisions WHERE tenant = ?`,
      )
      .get(tenant)) as { total: number; reflex: number | null };
    const total = Number(rows.total);
    const reflex = Number(rows.reflex ?? 0);
    return { total, reflex, rate: total === 0 ? 0 : reflex / total };
  }

  /**
   * Calibration memory (TODO §4): versioned outcomes per
   * (task_type × tier × model). This is what the router consults before
   * trusting a tier with a task on a model — `historicalSuccess` reads the
   * coarse cut; this table keeps the fine one.
   */
  async recordCalibrationSample(
    tenant: string,
    taskType: string,
    tier: RoutingClass,
    model: string,
    correct: boolean,
    now?: string,
  ): Promise<void> {
    const at = now ?? new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO routing_calibration (tenant, task_type, tier, model, ok, total, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant, task_type, tier, model)
       DO UPDATE SET ok = ok + ?, total = total + 1, updated_at = excluded.updated_at`,
      )
      .run(tenant, taskType, tier, model, correct ? 1 : 0, 1, at, correct ? 1 : 0);
  }

  /**
   * Cost-per-signal (TODO §4.1): of all routed arrivals, what share does the
   * expensive tier see? The gate is <1% — an unsorted inbox means every task
   * pays model prices. `propose`-side (what the router wanted) is the signal
   * quality; `executed`-side is what the org actually spent on.
   */
  async costPerSignal(tenant: string): Promise<{
    arrivals: number;
    modelShare: number;
    humanShare: number;
    byTier: Record<string, number>;
    gate: number;
    withinGate: boolean;
  }> {
    const rows = (await this.db
      .prepare('SELECT proposed, executed FROM routing_decisions WHERE tenant = ?')
      .all(tenant)) as { proposed: string; executed: string }[];
    const share = (col: 'proposed' | 'executed'): Record<string, number> => {
      const by: Record<string, number> = {};
      for (const r of rows) {
        const k = String(r[col]);
        by[k] = (by[k] ?? 0) + 1;
      }
      return by;
    };
    const byTier = share('executed');
    const arrivals = rows.length;
    const modelShare = arrivals === 0 ? 0 : (byTier['MODEL'] ?? 0) / arrivals;
    const humanShare = arrivals === 0 ? 0 : (byTier['HUMAN'] ?? 0) / arrivals;
    const gate = 0.01;
    return { arrivals, modelShare, humanShare, byTier, gate, withinGate: modelShare < gate };
  }

  async calibration(
    tenant: string,
    taskType: string,
  ): Promise<{ tier: RoutingClass; model: string; ok: number; total: number; rate: number }[]> {
    const rows = (await this.db
      .prepare('SELECT tier, model, ok, total FROM routing_calibration WHERE tenant = ? AND task_type = ?')
      .all(tenant, taskType)) as { tier: string; model: string; ok: number; total: number }[];
    return rows.map((r) => ({
      tier: r.tier as RoutingClass,
      model: String(r.model),
      ok: Number(r.ok),
      total: Number(r.total),
      rate: Number(r.total) === 0 ? 0 : Number(r.ok) / Number(r.total),
    }));
  }
}
