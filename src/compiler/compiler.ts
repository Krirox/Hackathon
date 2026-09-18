import { z } from 'zod';
import { groupConcat, type AsyncDb } from '../core/db.ts';
import type { SkillCardRevisionRow, SkillCardRow, SkillTransferTestRow } from '../core/rows.ts';
import type { RoutingClass } from '../core/types.ts';

/**
 * Organizational Compiler v2.
 *
 * QM already gives us the plumbing: scope-owned skills, sharing by grant,
 * admin-gated promotion to the whole org, skill packs imported from git.
 * What QM does NOT give us is the EVIDENCE required before promotion. That is
 * this file.
 *
 * Lifecycle:
 *   TRACE → CANDIDATE → QUARANTINE → SHADOW → BOUNDED_PILOT → PROMOTED(scoped)
 *                                                              ↓ drift
 *                                                         DEMOTED → MODEL/HUMAN
 *
 * THE PROBLEM THIS EXISTS FOR: current research (AFTER, arXiv 2606.23127)
 * finds procedural memory yields real gains but that skills specialize to their
 * origin role and can degrade under transfer. So a card may NOT be promoted
 * beyond its origin scope until it passes cross-role, cross-model and
 * data-regime tests. Anything that only works where it was born stays there
 * forever — which is honest, not a failure.
 *
 * COUPLING GUARD: a card records the routing tier it was validated at. The
 * router may not execute it anywhere else. This is what stops router+compiler
 * compounding transfer failure.
 */

export const SKILL_STATES = [
  'TRACE',
  'CANDIDATE',
  'QUARANTINE',
  'SHADOW',
  'BOUNDED_PILOT',
  'PROMOTED',
  'DEMOTED',
  'RETIRED',
] as const;
export type SkillState = (typeof SKILL_STATES)[number];

/** Promotion order. A card may only advance one step, and only through its gate. */
export const STATE_ORDER: Record<SkillState, number> = {
  TRACE: 0,
  CANDIDATE: 1,
  QUARANTINE: 2,
  SHADOW: 3,
  BOUNDED_PILOT: 4,
  PROMOTED: 5,
  DEMOTED: 6,
  RETIRED: 7,
};

export interface TransferTest {
  kind: 'cross_role' | 'cross_model' | 'data_regime' | 'regression' | 'harness_smoke';
  /** Role/model/regime the test was run under. */
  variant: string;
  passed: boolean;
  score: number;
  ranAt: string;
  cardVersion?: number;
  evalRunId?: string | null;
  evaluator?: string | null;
  model?: string | null;
}

const cardSchema = z
  .object({
    tenant: z.string().min(1),
    intent: z.string().min(1),
    /** Preconditions. A card without predicates cannot be safely applied. */
    predicates: z.array(z.string()).min(1),
    steps: z.array(z.string()).min(1),
    /** Executable success tests — the eval suite IS the spec. */
    tests: z.array(z.string()).min(1),
    toolGrants: z.array(z.string()),
    validatedAtTier: z.enum(['REFLEX', 'WORKFLOW', 'MODEL', 'HUMAN']),
    originScope: z.string().min(1),
    originModels: z.array(z.string()).min(1),
    scopeRoles: z.array(z.string()),
    owner: z.string().min(1),
    /** Trace ids this card was compiled from. */
    traceIds: z.array(z.string()),
    evalRef: z.string().optional(),
    /** Foreign procedures are third-party until transfer-tested here. */
    trustTier: z.enum(['internal', 'third-party']).default('internal'),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

export type NewCardInput = z.input<typeof cardSchema>;

export interface SkillCard {
  id: string;
  tenant: string;
  intent: string;
  predicates: string[];
  steps: string[];
  tests: string[];
  toolGrants: string[];
  validatedAtTier: RoutingClass;
  state: SkillState;
  version: number;
  originScope: string;
  originModels: string[];
  scopeRoles: string[];
  provenance: { traceIds: string[]; compiledAt: string };
  trustTier: 'internal' | 'third-party';
  evalRef: string | null;
  owner: string;
  updatedAt: string;
}

export interface SkillCardRevision {
  tenant: string;
  cardId: string;
  version: number;
  state: SkillState;
  scopeJson: string;
  action: string;
  actor: string;
  detail: string | null;
  recordedAt: string;
}

export class CompilerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[compiler:${code}] ${message}`);
  }
}

/**
 * An imported skill pack is a FOREIGN procedure with unknown transfer
 * properties. It always enters at QUARANTINE, never higher.
 */
export function entryStateFor(source: 'compiled' | 'imported'): SkillState {
  return source === 'imported' ? 'QUARANTINE' : 'CANDIDATE';
}

export class OrganizationalCompiler {
  constructor(private readonly db: AsyncDb) {}

  private rowToCard(r: SkillCardRow): SkillCard {
    const prov = JSON.parse(String(r.provenance)) as { traceIds: string[]; compiledAt: string };
    const scope = JSON.parse(String(r.scope_json)) as {
      originScope: string;
      originModels: string[];
      roles: string[];
    };
    return {
      id: String(r.id),
      tenant: String(r.tenant),
      intent: String(r.intent),
      predicates: JSON.parse(String(r.predicates)) as string[],
      steps: JSON.parse(String(r.steps)) as string[],
      tests: JSON.parse(String(r.tests)) as string[],
      toolGrants: JSON.parse(String(r.tool_grants)) as string[],
      validatedAtTier: String(r.validated_tier) as RoutingClass,
      state: String(r.state) as SkillState,
      version: Number(r.version),
      originScope: scope.originScope,
      originModels: scope.originModels,
      scopeRoles: scope.roles,
      provenance: prov,
      trustTier: (r.trust_tier == null ? 'internal' : String(r.trust_tier)) as SkillCard['trustTier'],
      evalRef: r.eval_ref == null ? null : String(r.eval_ref),
      owner: String(r.owner),
      updatedAt: String(r.updated_at),
    };
  }

  /** Creation only; lifecycle transitions use separate CAS updates. */
  private async persist(c: SkillCard): Promise<void> {
    const out = await this.db
      .prepare(
        `INSERT INTO skill_cards
         (id, tenant, intent, predicates, steps, tests, tool_grants, validated_tier,
          scope_json, state, version, provenance, eval_ref, owner, updated_at, trust_tier)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        c.id,
        c.tenant,
        c.intent,
        JSON.stringify(c.predicates),
        JSON.stringify(c.steps),
        JSON.stringify(c.tests),
        JSON.stringify(c.toolGrants),
        c.validatedAtTier,
        JSON.stringify({ originScope: c.originScope, originModels: c.originModels, roles: c.scopeRoles }),
        c.state,
        c.version,
        JSON.stringify(c.provenance),
        c.evalRef,
        c.owner,
        c.updatedAt,
        c.trustTier,
      );
    if (out.changes === 0) throw new CompilerError('CARD_EXISTS', `card ${c.id} already exists`);
  }

  async get(tenant: string, id: string): Promise<SkillCard | null> {
    const r = (await this.db.prepare('SELECT * FROM skill_cards WHERE id = ? AND tenant = ?').get(id, tenant)) as
      SkillCardRow | undefined;
    return r ? this.rowToCard(r) : null;
  }

  async byIntent(tenant: string, intent: string, state?: SkillState): Promise<SkillCard[]> {
    const rows = state
      ? await this.db
          .prepare('SELECT * FROM skill_cards WHERE tenant = ? AND intent = ? AND state = ? ORDER BY version DESC')
          .all(tenant, intent, state)
      : await this.db
          .prepare('SELECT * FROM skill_cards WHERE tenant = ? AND intent = ? ORDER BY version DESC')
          .all(tenant, intent);
    return (rows as SkillCardRow[]).map((r) => this.rowToCard(r));
  }

  /** Registry listing: every card, filterable. Read-only. */
  async list(tenant: string, opts: { state?: SkillState; intent?: string } = {}): Promise<SkillCard[]> {
    const where = ['tenant = ?'];
    const args: unknown[] = [tenant];
    if (opts.state) {
      where.push('state = ?');
      args.push(opts.state);
    }
    if (opts.intent) {
      where.push('intent = ?');
      args.push(opts.intent);
    }
    return (
      (await this.db
        .prepare(`SELECT * FROM skill_cards WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`)
        .all(...args)) as SkillCardRow[]
    ).map((r) => this.rowToCard(r));
  }

  /**
   * Compile a candidate card from traces. Refuses traces the router flagged
   * low-confidence or whose outcome is unresolved — a compiler that learns from
   * bad traces manufactures bad procedures.
   */
  async compile(input: NewCardInput & { source?: 'compiled' | 'imported' }): Promise<SkillCard> {
    const { source = 'compiled', ...rest } = input;
    const c = cardSchema.parse(rest);
    const now = c.now ?? new Date().toISOString();
    return this.db.transaction(async () => {
      for (const tid of c.traceIds) {
        const t = (await this.db
          .prepare('SELECT outcome, router_confidence FROM traces WHERE tenant = ? AND id = ?')
          .get(c.tenant, tid)) as { outcome: string; router_confidence: number } | undefined;
        if (!t) throw new CompilerError('UNKNOWN_TRACE', `trace ${tid} not found`);
        if (t.outcome === 'UNRESOLVED') {
          throw new CompilerError('UNRESOLVED_TRACE', `trace ${tid} has no resolved outcome; cannot compile from it`);
        }
        if (Number(t.router_confidence) < 0.5) {
          throw new CompilerError(
            'LOW_CONFIDENCE_TRACE',
            `trace ${tid} was routed at confidence ${t.router_confidence}; the compiler may not learn from traces the router doubted`,
          );
        }
      }
      const card: SkillCard = {
        id: c.id ?? `skl_${crypto.randomUUID()}`,
        tenant: c.tenant,
        intent: c.intent,
        predicates: c.predicates,
        steps: c.steps,
        tests: c.tests,
        toolGrants: c.toolGrants,
        validatedAtTier: c.validatedAtTier,
        state: entryStateFor(source),
        version: 1,
        originScope: c.originScope,
        originModels: c.originModels,
        scopeRoles: [c.originScope],
        provenance: { traceIds: c.traceIds, compiledAt: now },
        // Foreign is foreign: an imported pack is third-party no matter what
        // the importer claims. Promotion never launders this — transfer tests do.
        trustTier: source === 'imported' ? 'third-party' : c.trustTier,
        evalRef: c.evalRef ?? null,
        owner: c.owner,
        updatedAt: now,
      };
      await this.persist(card);
      await this.recordRevision(
        card.tenant,
        card.id,
        card.version,
        card.state,
        JSON.stringify({ originScope: card.originScope, originModels: card.originModels, roles: card.scopeRoles }),
        'CARD_COMPILED',
        'compiler',
        `${card.intent} @ ${card.state}`,
        now,
      );
      await this.audit(card.tenant, 'compiler', 'CARD_COMPILED', card.id, `${card.intent} @ ${card.state}`);
      return card;
    });
  }

  async recordTransfer(card: SkillCard, test: TransferTest): Promise<void> {
    const cardVersion = test.cardVersion ?? null;
    // Check persisted ownership in the write itself; a caller-supplied card is not proof.
    const out = await this.db
      .prepare(
        `INSERT INTO skill_transfer_tests (tenant, card_id, card_version, kind, variant, passed, score, ran_at, eval_run_id, evaluator, model)
         SELECT tenant, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM skill_cards WHERE tenant = ? AND id = ?`,
      )
      .run(
        cardVersion,
        test.kind,
        test.variant,
        test.passed ? 1 : 0,
        test.score,
        test.ranAt,
        test.evalRunId ?? null,
        test.evaluator ?? null,
        test.model ?? null,
        card.tenant,
        card.id,
      );
    if (out.changes === 0) throw new CompilerError('UNKNOWN_CARD', `card ${card.id} not found`);
  }

  async transferResults(tenant: string, cardId: string, opts: { cardVersion?: number } = {}): Promise<TransferTest[]> {
    const where = ['t.tenant = ?', 't.card_id = ?'];
    const args: unknown[] = [tenant, cardId];
    if (opts.cardVersion !== undefined) {
      where.push('t.card_version = ?');
      args.push(opts.cardVersion);
    }
    const rows = (await this.db
      .prepare(
        `SELECT t.card_id, t.card_version, t.kind, t.variant, t.passed, t.score, t.ran_at, t.eval_run_id, t.evaluator, t.model
         FROM skill_transfer_tests t JOIN skill_cards c ON c.id = t.card_id AND c.tenant = t.tenant
         WHERE ${where.join(' AND ')} ORDER BY t.ran_at DESC`,
      )
      .all(...args)) as SkillTransferTestRow[];
    return rows.map((r) => {
      const t: TransferTest = {
        kind: String(r.kind) as TransferTest['kind'],
        variant: String(r.variant),
        passed: Number(r.passed) === 1,
        score: Number(r.score),
        ranAt: String(r.ran_at),
      };
      if (r.card_version != null) t.cardVersion = Number(r.card_version);
      if (r.eval_run_id != null) t.evalRunId = String(r.eval_run_id);
      if (r.evaluator != null) t.evaluator = String(r.evaluator);
      if (r.model != null) t.model = String(r.model);
      return t;
    });
  }

  async cardRevisions(tenant: string, cardId: string): Promise<SkillCardRevision[]> {
    const rows = (await this.db
      .prepare(
        `SELECT tenant, card_id, version, state, scope_json, action, actor, detail, recorded_at
         FROM skill_card_revisions
         WHERE tenant = ? AND card_id = ?
         ORDER BY version ASC`,
      )
      .all(tenant, cardId)) as SkillCardRevisionRow[];
    return rows.map((r) => ({
      tenant: String(r.tenant),
      cardId: String(r.card_id),
      version: Number(r.version),
      state: String(r.state) as SkillState,
      scopeJson: String(r.scope_json),
      action: String(r.action),
      actor: String(r.actor),
      detail: r.detail ? String(r.detail) : null,
      recordedAt: String(r.recorded_at),
    }));
  }

  private async recordRevision(
    tenant: string,
    cardId: string,
    version: number,
    state: SkillState,
    scopeJson: string,
    action: string,
    actor: string,
    detail?: string | null,
    recordedAt?: string,
  ): Promise<void> {
    const now = recordedAt ?? new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO skill_card_revisions (tenant, card_id, version, state, scope_json, action, actor, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, card_id, version) DO NOTHING`,
      )
      .run(tenant, cardId, version, state, scopeJson, action, actor, detail ?? null, now);
  }

  /**
   * The promotion gate. Every edge is explicit and every failure returns a
   * reason rather than throwing, because "why can't this be trusted yet" is a
   * question customers will ask and must get a straight answer.
   */
  async attemptAdvance(
    tenant: string,
    cardId: string,
    to: SkillState,
    evidence: {
      shadowRuns?: number;
      shadowSuccessRate?: number;
      pilotRuns?: number;
      pilotSuccessRate?: number;
      evalRunId?: string;
    } = {},
  ): Promise<{ ok: boolean; card: SkillCard | null; reasons: string[] }> {
    const card = await this.get(tenant, cardId);
    if (!card) return { ok: false, card: null, reasons: ['card not found'] };
    const reasons: string[] = [];
    const tests = await this.transferResults(tenant, cardId);
    // F18: Latest test result per (kind, variant) determines active status — historical
    // passes must never mask subsequent regressions or failures.
    const latestByKindVariant = new Map<string, TransferTest>();
    for (const t of tests) {
      const key = `${t.kind}:${t.variant}`;
      const existing = latestByKindVariant.get(key);
      if (!existing || Date.parse(t.ranAt) > Date.parse(existing.ranAt)) {
        latestByKindVariant.set(key, t);
      }
    }
    const activeTests = [...latestByKindVariant.values()];
    const has = (k: TransferTest['kind']) => {
      const matching = activeTests.filter((t) => t.kind === k);
      return matching.length > 0 && matching.every((t) => t.passed);
    };

    if (evidence.evalRunId) {
      const evalRun = (await this.db
        .prepare('SELECT id, suite, passed, failed FROM eval_runs WHERE tenant = ? AND id = ?')
        .get(tenant, evidence.evalRunId)) as { id: string; suite: string; passed: number; failed: number } | undefined;
      if (!evalRun) {
        reasons.push(`referenced eval run ${evidence.evalRunId} not found`);
      } else if (card.evalRef && evalRun.suite !== card.evalRef) {
        reasons.push(`eval run ${evidence.evalRunId} is for suite ${evalRun.suite}, expected ${card.evalRef}`);
      } else if (evalRun.failed > 0 || evalRun.passed === 0) {
        reasons.push(`eval run ${evidence.evalRunId} failed (${evalRun.passed} passed, ${evalRun.failed} failed)`);
      }
    }

    let shadowRuns = evidence.shadowRuns;
    let shadowSuccessRate = evidence.shadowSuccessRate;
    if (shadowRuns === undefined && to === 'BOUNDED_PILOT') {
      const traceRows = (await this.db
        .prepare('SELECT outcome FROM traces WHERE tenant = ? AND skill_card = ?')
        .all(tenant, card.id)) as { outcome: string }[];
      shadowRuns = traceRows.length;
      const successes = traceRows.filter((r) => r.outcome === 'SUCCESS').length;
      shadowSuccessRate = shadowRuns > 0 ? successes / shadowRuns : 0;
    }

    let pilotRuns = evidence.pilotRuns;
    let pilotSuccessRate = evidence.pilotSuccessRate;
    if (pilotRuns === undefined && to === 'PROMOTED') {
      const traceRows = (await this.db
        .prepare('SELECT outcome FROM traces WHERE tenant = ? AND skill_card = ? AND tier = ?')
        .all(tenant, card.id, 'WORKFLOW')) as { outcome: string }[];
      pilotRuns = traceRows.length;
      const successes = traceRows.filter((r) => r.outcome === 'SUCCESS').length;
      pilotSuccessRate = pilotRuns > 0 ? successes / pilotRuns : 0;
    }

    if (STATE_ORDER[to] !== STATE_ORDER[card.state] + 1 && to !== 'DEMOTED' && to !== 'RETIRED') {
      reasons.push(`illegal transition ${card.state} → ${to}; advance one step at a time`);
    }

    switch (to) {
      case 'QUARANTINE':
        break; // entry is always allowed — quarantine is where scrutiny happens, not a reward.
      case 'SHADOW':
        if (!has('regression')) reasons.push('regression tests not passing');
        if (!card.evalRef) reasons.push('card has no eval suite reference (evals are the spec)');
        break;
      case 'BOUNDED_PILOT':
        if (!has('regression')) reasons.push('regression tests not passing');
        if (!has('cross_model')) reasons.push('cross-model transfer test required before pilot');
        if ((shadowRuns ?? 0) < 20) reasons.push(`need ≥20 shadow runs, got ${shadowRuns ?? 0}`);
        if ((shadowSuccessRate ?? 0) < 0.9)
          reasons.push(`shadow success rate ${(shadowSuccessRate ?? 0).toFixed(2)} < 0.90`);
        break;
      case 'PROMOTED':
        // Origin-scope promotion: needs regression + cross-model + data-regime.
        if (!has('regression') || !has('cross_model') || !has('data_regime'))
          reasons.push('promotion requires passing regression, cross_model and data_regime tests');
        if ((pilotRuns ?? 0) < 50) reasons.push(`need ≥50 pilot runs, got ${pilotRuns ?? 0}`);
        if ((pilotSuccessRate ?? 0) < 0.95) reasons.push(`pilot success ${(pilotSuccessRate ?? 0).toFixed(2)} < 0.95`);
        break;
      case 'DEMOTED':
      case 'RETIRED':
        break; // always allowed downward — that is the point.
      default:
        reasons.push(`no gate defined for ${to}`);
    }

    if (reasons.length) return { ok: false, card, reasons };

    // Expected-state CAS: the row moves only if it still holds the state
    // this call gated against. A concurrent advancer wins the single UPDATE;
    // this call sees zero changed rows and throws instead of writing over
    // the winner's version with a stale base. Version rides along atomically
    // (version + 1 in-statement), so no two writers mint the same version.
    const at = new Date().toISOString();
    const out = await this.db
      .prepare('UPDATE skill_cards SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = ?')
      .run(to, at, cardId, card.state);
    if (out.changes === 0) {
      throw new CompilerError(
        'STATE_CONFLICT',
        `card ${cardId} moved under this advance (was ${card.state}) — re-read and gate again`,
      );
    }
    const next = (await this.get(tenant, cardId))!;
    await this.recordRevision(
      tenant,
      cardId,
      next.version,
      next.state,
      JSON.stringify({ originScope: next.originScope, originModels: next.originModels, roles: next.scopeRoles }),
      `CARD_${to}`,
      'compiler',
      `v${next.version} (${card.state} -> ${to})`,
      at,
    );
    await this.audit(tenant, 'compiler', `CARD_${to}`, cardId, `v${next.version}`);
    return { ok: true, card: next, reasons: [] };
  }

  /**
   * Scope expansion is a SEPARATE act from promotion. A card promoted in its
   * origin scope may not serve another role until cross_role transfer passes
   * for that specific role.
   */
  async expandScope(
    tenant: string,
    cardId: string,
    role: string,
  ): Promise<{ ok: boolean; card: SkillCard | null; reasons: string[] }> {
    const card = await this.get(tenant, cardId);
    if (!card) return { ok: false, card: null, reasons: ['card not found'] };
    if (card.state !== 'PROMOTED') return { ok: false, card, reasons: [`card is ${card.state}, not PROMOTED`] };
    const roleTests = (await this.transferResults(tenant, cardId)).filter(
      (x) => x.kind === 'cross_role' && x.variant === role,
    );
    const latestRoleTest = roleTests.sort((a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt))[0];
    if (!latestRoleTest?.passed) {
      return {
        ok: false,
        card,
        reasons: [
          `cross_role transfer test for "${role}" has not passed — a skill that only works where it was born stays there`,
        ],
      };
    }
    if (card.scopeRoles.includes(role)) return { ok: false, card, reasons: ['role already in scope'] };
    return this.db.transaction(async () => {
      // CAS on version: two concurrent expansions for different roles must
      // not merge-lose one role (read-modify-write on scope_json). The loser
      // re-reads and retries rather than silently dropping a role.
      const fresh = await this.get(tenant, cardId);
      if (!fresh || fresh.state !== 'PROMOTED' || fresh.version !== card.version) {
        throw new CompilerError(
          'STATE_CONFLICT',
          `card ${cardId} moved during scope expansion — re-read and gate again`,
        );
      }
      if (fresh.scopeRoles.includes(role)) return { ok: false, card: fresh, reasons: ['role already in scope'] };
      const next: SkillCard = {
        ...fresh,
        scopeRoles: [...fresh.scopeRoles, role],
        version: fresh.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const out = await this.db
        .prepare('UPDATE skill_cards SET scope_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
        .run(
          JSON.stringify({ originScope: next.originScope, originModels: next.originModels, roles: next.scopeRoles }),
          next.version,
          next.updatedAt,
          cardId,
          fresh.version,
        );
      if (out.changes === 0) {
        throw new CompilerError(
          'STATE_CONFLICT',
          `card ${cardId} moved during scope expansion — re-read and gate again`,
        );
      }
      await this.recordRevision(
        tenant,
        cardId,
        next.version,
        next.state,
        JSON.stringify({ originScope: next.originScope, originModels: next.originModels, roles: next.scopeRoles }),
        'CARD_SCOPE_EXPANDED',
        'compiler',
        role,
        next.updatedAt,
      );
      await this.audit(tenant, 'compiler', 'CARD_SCOPE_EXPANDED', cardId, role);
      return { ok: true, card: next, reasons: [] };
    });
  }

  /**
   * Decay: live success rate vs. validated baseline, EWMA over a rolling
   * window. Breach ⇒ auto-demote and open a drift ticket. Silent degradation is
   * the failure mode that kills compiled systems.
   */
  async checkDrift(
    tenant: string,
    cardId: string,
    opts: { window?: number; ewmaAlpha?: number; threshold?: number } = {},
  ): Promise<{
    drifting: boolean;
    ewma: number;
    samples: number;
    demoted: boolean;
  }> {
    const window = opts.window ?? 40;
    const alpha = opts.ewmaAlpha ?? 0.2;
    const threshold = opts.threshold ?? 0.9;
    const card = await this.get(tenant, cardId);
    if (!card || card.state !== 'PROMOTED') return { drifting: false, ewma: 1, samples: 0, demoted: false };

    const rows = (await this.db
      .prepare(
        `SELECT outcome FROM traces WHERE tenant = ? AND intent = ? AND tier = 'WORKFLOW'
           AND skill_card = ? ORDER BY created_at DESC LIMIT ?`,
      )
      // F15: simulated traces are not real execution evidence; a card can
      // only be PROMOTED through genuine cross-model transfer tests, so a
      // `simulated:` intent should never even be here — the filter is
      // defense in depth, not the primary gate.
      .all(
        tenant,
        card.intent.startsWith('simulated:') ? '\u0000no-simulated-intent' : card.intent,
        cardId,
        window,
      )) as {
      outcome: string;
    }[];
    if (rows.length < 10) return { drifting: false, ewma: 1, samples: rows.length, demoted: false };

    let ewma = 1;
    for (const r of [...rows].reverse()) {
      let s = ewma;
      if (r.outcome === 'SUCCESS') s = 1;
      else if (r.outcome === 'FAILURE') s = 0;
      ewma = alpha * s + (1 - alpha) * ewma;
    }
    const drifting = ewma < threshold;
    let demoted = false;
    if (drifting) {
      // Same CAS as promotion: only a still-PROMOTED row demotes. A
      // concurrent advance/retire that already moved the card wins; the
      // zero-change outcome means "already handled", not an error here.
      const out = await this.db
        .prepare(
          "UPDATE skill_cards SET state = 'DEMOTED', version = version + 1, updated_at = ? WHERE id = ? AND state = 'PROMOTED'",
        )
        .run(new Date().toISOString(), cardId);
      if (out.changes === 0) return { drifting, ewma, samples: rows.length, demoted: false };
      const driftAt = new Date().toISOString();
      const nextVersion = card.version + 1;
      await this.recordRevision(
        tenant,
        cardId,
        nextVersion,
        'DEMOTED',
        JSON.stringify({ originScope: card.originScope, originModels: card.originModels, roles: card.scopeRoles }),
        'CARD_AUTO_DEMOTED',
        'compiler',
        `ewma ${ewma.toFixed(3)} < ${threshold}`,
        driftAt,
      );
      await this.audit(tenant, 'compiler', 'CARD_AUTO_DEMOTED', cardId, `ewma ${ewma.toFixed(3)} < ${threshold}`);
      demoted = true;
    }
    return { drifting, ewma, samples: rows.length, demoted };
  }

  /** Executable card lookup used by the router's coupling guard. */
  async executableFor(tenant: string, intent: string, scope: string, model: string): Promise<SkillCard | null> {
    for (const card of await this.byIntent(tenant, intent, 'PROMOTED')) {
      if (!card.scopeRoles.includes(scope)) continue;
      if (model && !card.originModels.includes(model)) {
        // F18: only the LATEST cross_model test for this variant determines
        // eligibility — a stale pass must never mask a subsequent regression.
        const tests = await this.transferResults(tenant, card.id);
        const forModel = tests.filter((t) => t.kind === 'cross_model' && t.variant === model);
        const latest = forModel.sort((a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt))[0];
        if (!latest?.passed) continue;
      }
      return card;
    }
    return null;
  }

  private async audit(tenant: string, actor: string, action: string, target: string, detail?: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, actor, action, target, detail ?? null, new Date().toISOString());
  }
}

export interface MinedCandidate {
  intent: string;
  repeats: number;
  successRate: number;
  scopes: string[];
  taskTypes: string[];
}

/**
 * Candidate mining (TODO §5): repeated intent detection over SUCCESS traces
 * the router did not doubt, deduped by intent. Returns intents worth
 * compiling — compilation itself stays an explicit, gated act.
 *
 * F15: simulated traces (the dogfood pipeline mints `simulated:`-prefixed
 * intents) are excluded BY CONSTRUCTION here, not by a caller convention —
 * a synthetic run can never satisfy a promotion candidate threshold or leak
 * into learning evidence through this path.
 */
export async function mineCandidates(db: AsyncDb, tenant: string, minRepeats = 3): Promise<MinedCandidate[]> {
  const compilable = `SUM(CASE WHEN outcome = 'SUCCESS' AND router_confidence >= 0.5 THEN 1 ELSE 0 END)`;
  const rows = (await db
    .prepare(
      `SELECT intent, ${compilable} AS n, COUNT(*) AS total,
              ${groupConcat(db.engine, 'scope')} AS scopes,
              ${groupConcat(db.engine, 'task_type')} AS types
         FROM traces
        WHERE tenant = ? AND intent NOT LIKE 'simulated:%'
        GROUP BY intent HAVING ${compilable} >= ?`,
    )
    .all(tenant, minRepeats)) as { intent: string; n: number; total: number; scopes: string; types: string }[];
  return rows.map((r) => ({
    intent: String(r.intent),
    repeats: Number(r.n),
    successRate: Number(r.total) === 0 ? 0 : Number(r.n) / Number(r.total),
    scopes: String(r.scopes).split(','),
    taskTypes: String(r.types).split(','),
  }));
}
