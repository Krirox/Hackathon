import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { WatchContractRow } from '../core/rows.ts';

/**
 * World Sense, part 1 (TODO §6.1): Genome → Watch Contract compiler.
 *
 * Attention stops being a vibe when it becomes a query plan with a bill
 * attached: entities, predicates, a materiality gate (a signal must link to
 * a live GOAL or a revenue/cost/risk path), thresholds, cost caps, and a
 * 30-day re-review date. Stale contracts stop firing; over-budget contracts
 * suspend instead of silently spending.
 *
 * Deliberately late in the roadmap (Phase 6): external intelligence is
 * worthless while internal coordination is unproven. The L0/L1/L2 funnel
 * needs the §0.5 scheduler; what lives here is the contract law it runs on.
 */

export class WatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[watch:${code}] ${message}`);
  }
}

const genomeSchema = z
  .object({
    id: z.string().min(1).optional(),
    tenant: z.string().min(1),
    name: z.string().min(1),
    entities: z.array(z.string().min(1)).min(1),
    predicates: z.array(z.string().min(1)).min(1),
    /** A signal must link to a live GOAL or a revenue/cost/risk path. */
    goalRefs: z.array(z.string().min(1)).default([]),
    revenueCostRisk: z.array(z.string().min(1)).default([]),
    thresholds: z.record(z.string(), z.number()),
    maxDollars: z.number().min(0),
    maxTokens: z.number().int().min(0),
    now: z.string().optional(),
  })
  .strict();

export type GenomeInput = z.input<typeof genomeSchema>;

export interface WatchContract {
  version: 1;
  id: string;
  tenant: string;
  name: string;
  entities: string[];
  predicates: string[];
  goalRefs: string[];
  revenueCostRisk: string[];
  thresholds: Record<string, number>;
  budgets: { maxDollars: number; maxTokens: number };
  spent: { dollars: number; tokens: number };
  compiledAt: string;
  /** Re-review date. Past it, the contract stops firing. */
  expiresAt: string;
  state: 'ACTIVE' | 'SUSPENDED_BUDGET' | 'EXPIRED';
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export const CONTRACT_TTL_MS = 30 * 86_400_000;

export function compileWatchContract(input: GenomeInput): WatchContract {
  const g = genomeSchema.parse(input);
  const now = g.now ?? new Date().toISOString();
  if (g.goalRefs.length === 0 && g.revenueCostRisk.length === 0) {
    throw new WatchError(
      'NO_MATERIALITY',
      'a contract with no goal and no revenue/cost/risk path watches everything, which is watching nothing',
    );
  }
  const id = g.id ?? `watch_${createHash('sha256').update(`${g.tenant}:${g.name}:${now}`).digest('hex').slice(0, 16)}`;
  return {
    version: 1,
    id,
    tenant: g.tenant,
    name: g.name,
    entities: [...new Set(g.entities)],
    predicates: [...new Set(g.predicates)],
    goalRefs: [...g.goalRefs],
    revenueCostRisk: [...g.revenueCostRisk],
    thresholds: { ...g.thresholds },
    budgets: { maxDollars: g.maxDollars, maxTokens: g.maxTokens },
    spent: { dollars: 0, tokens: 0 },
    compiledAt: now,
    expiresAt: new Date(Date.parse(now) + CONTRACT_TTL_MS).toISOString(),
    state: 'ACTIVE',
    reviewedAt: null,
    reviewedBy: null,
  };
}

export interface Signal {
  entityRefs: string[];
  goalRefs: string[];
  revenueCostRiskRefs?: string[];
  predicates?: string[];
  scores: Record<string, number>;
}

export interface MaterialityVerdict {
  material: boolean;
  state?: 'ACTIVE' | 'SUSPENDED_BUDGET' | 'EXPIRED';
  reasons: string[];
}

export interface AuthoritativeEvalOptions {
  now?: string;
  liveGoalIds?: readonly string[];
  spent?: { dollars: number; tokens: number };
  requireAllThresholds?: boolean;
}

/**
 * One authoritative contract evaluation:
 * - Checks active contract status against expiry and dollar/token spend budgets
 * - Checks entity scope
 * - Checks predicate matching
 * - Checks live goals or revenue/cost/risk materiality
 * - Checks that all required contract thresholds are met
 */
export function evaluateContract(
  contract: WatchContract,
  signal: Signal,
  opts: AuthoritativeEvalOptions = {},
): MaterialityVerdict {
  const now = opts.now ?? new Date().toISOString();
  const spent = opts.spent ?? contract.spent ?? { dollars: 0, tokens: 0 };
  const liveGoalIds = opts.liveGoalIds ?? contract.goalRefs;
  const status = contractStatus(contract, now, spent);
  if (status.state !== 'ACTIVE') {
    return {
      material: false,
      state: status.state,
      reasons: [`contract is ${status.state} — re-review before it fires again`],
    };
  }

  const reasons: string[] = [];
  const liveGoals = signal.goalRefs.filter((g) => liveGoalIds.includes(g));
  const priced = (signal.revenueCostRiskRefs ?? []).filter((r) => contract.revenueCostRisk.includes(r));
  if (liveGoals.length === 0 && priced.length === 0) {
    return { material: false, state: 'ACTIVE', reasons: ['no live GOAL and no revenue/cost/risk path — archive'] };
  }
  if (liveGoals.length > 0) reasons.push(`links live goal(s): ${liveGoals.join(', ')}`);
  if (priced.length > 0) reasons.push(`touches revenue/cost/risk: ${priced.join(', ')}`);

  const unknownEntities = signal.entityRefs.filter((e) => !contract.entities.includes(e));
  if (unknownEntities.length > 0) {
    return {
      material: false,
      state: 'ACTIVE',
      reasons: [...reasons, `outside contract entities: ${unknownEntities.join(', ')} — archive`],
    };
  }

  // Predicate matching: if signal carries predicates, at least one must match contract
  if (signal.predicates && signal.predicates.length > 0) {
    const matching = signal.predicates.filter((p) => contract.predicates.includes(p));
    if (matching.length === 0) {
      return {
        material: false,
        state: 'ACTIVE',
        reasons: [
          ...reasons,
          `no matching contract predicate (signal: ${signal.predicates.join(', ')}, contract requires: ${contract.predicates.join(', ')}) — archive`,
        ],
      };
    }
    reasons.push(`matches predicate(s): ${matching.join(', ')}`);
  }

  // Required threshold verification
  const requireAll = opts.requireAllThresholds ?? true;
  if (requireAll) {
    for (const [k, required] of Object.entries(contract.thresholds)) {
      const score = signal.scores[k];
      if (score === undefined) {
        return {
          material: false,
          state: 'ACTIVE',
          reasons: [...reasons, `missing required threshold score for "${k}" (needs >= ${required}) — archive`],
        };
      }
      if (score < required) {
        return {
          material: false,
          state: 'ACTIVE',
          reasons: [...reasons, `score ${k}=${score} below threshold ${required} — archive`],
        };
      }
    }
  } else {
    for (const [k, v] of Object.entries(signal.scores)) {
      const t = contract.thresholds[k];
      if (t !== undefined && v < t) {
        return {
          material: false,
          state: 'ACTIVE',
          reasons: [...reasons, `score ${k}=${v} below threshold ${t} — archive`],
        };
      }
    }
  }

  return { material: true, state: 'ACTIVE', reasons };
}

/**
 * The materiality gate: a signal that links to no live GOAL and no
 * revenue/cost/risk path archives, no matter how loud it is.
 */
export function materialityCheck(
  contract: WatchContract,
  signal: Signal,
  liveGoalIds: readonly string[],
  opts: { requireAllThresholds?: boolean } = {},
): MaterialityVerdict {
  return evaluateContract(contract, signal, {
    liveGoalIds,
    requireAllThresholds: opts.requireAllThresholds ?? false,
  });
}

/** Contracts past re-review stop firing; contracts past budget suspend. */
export function contractStatus(
  contract: WatchContract,
  now: string,
  spent: { dollars: number; tokens: number },
): WatchContract {
  if (now > contract.expiresAt) return { ...contract, state: 'EXPIRED', spent };
  if (spent.dollars > contract.budgets.maxDollars || spent.tokens > contract.budgets.maxTokens) {
    return { ...contract, state: 'SUSPENDED_BUDGET', spent };
  }
  return { ...contract, state: 'ACTIVE', spent };
}

export function rowToWatchContract(row: WatchContractRow, now?: string): WatchContract {
  const spent = { dollars: Number(row.spent_dollars), tokens: Number(row.spent_tokens) };
  const c: WatchContract = {
    version: 1,
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    entities: JSON.parse(row.entities_json) as string[],
    predicates: JSON.parse(row.predicates_json) as string[],
    goalRefs: JSON.parse(row.goal_refs_json) as string[],
    revenueCostRisk: JSON.parse(row.revenue_cost_risk_json) as string[],
    thresholds: JSON.parse(row.thresholds_json) as Record<string, number>,
    budgets: { maxDollars: Number(row.max_dollars), maxTokens: Number(row.max_tokens) },
    spent,
    compiledAt: row.compiled_at,
    expiresAt: row.expires_at,
    state: row.state as WatchContract['state'],
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
  return contractStatus(c, now ?? new Date().toISOString(), spent);
}

export async function saveWatchContract(db: AsyncDb, contract: WatchContract): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watch_contracts (
        id, tenant, name, state, entities_json, predicates_json, goal_refs_json,
        revenue_cost_risk_json, thresholds_json, max_dollars, max_tokens,
        spent_dollars, spent_tokens, compiled_at, expires_at, reviewed_at, reviewed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        entities_json = excluded.entities_json,
        predicates_json = excluded.predicates_json,
        goal_refs_json = excluded.goal_refs_json,
        revenue_cost_risk_json = excluded.revenue_cost_risk_json,
        thresholds_json = excluded.thresholds_json,
        max_dollars = excluded.max_dollars,
        max_tokens = excluded.max_tokens,
        spent_dollars = excluded.spent_dollars,
        spent_tokens = excluded.spent_tokens,
        expires_at = excluded.expires_at,
        reviewed_at = excluded.reviewed_at,
        reviewed_by = excluded.reviewed_by`,
    )
    .run(
      contract.id,
      contract.tenant,
      contract.name,
      contract.state,
      JSON.stringify(contract.entities),
      JSON.stringify(contract.predicates),
      JSON.stringify(contract.goalRefs),
      JSON.stringify(contract.revenueCostRisk),
      JSON.stringify(contract.thresholds),
      contract.budgets.maxDollars,
      contract.budgets.maxTokens,
      contract.spent.dollars,
      contract.spent.tokens,
      contract.compiledAt,
      contract.expiresAt,
      contract.reviewedAt,
      contract.reviewedBy,
    );
}

export async function loadWatchContract(
  db: AsyncDb,
  tenant: string,
  id: string,
  now?: string,
): Promise<WatchContract | null> {
  const row = (await db.prepare('SELECT * FROM watch_contracts WHERE tenant = ? AND id = ?').get(tenant, id)) as
    WatchContractRow | undefined;
  if (!row) return null;
  return rowToWatchContract(row, now);
}

export async function recordContractSpend(
  db: AsyncDb,
  tenant: string,
  id: string,
  spend: { dollars: number; tokens: number },
  now?: string,
): Promise<WatchContract> {
  return db.transaction(async () => {
    const existing = await loadWatchContract(db, tenant, id, now);
    if (!existing) throw new WatchError('NOT_FOUND', `watch contract ${id} not found for tenant ${tenant}`);
    const newSpent = {
      dollars: existing.spent.dollars + Math.max(0, spend.dollars),
      tokens: existing.spent.tokens + Math.max(0, Math.floor(spend.tokens)),
    };
    const updated = contractStatus(existing, now ?? new Date().toISOString(), newSpent);
    await db
      .prepare(
        `UPDATE watch_contracts
         SET spent_dollars = ?, spent_tokens = ?, state = ?
         WHERE tenant = ? AND id = ?`,
      )
      .run(newSpent.dollars, newSpent.tokens, updated.state, tenant, id);
    return updated;
  });
}

export async function renewWatchContract(
  db: AsyncDb,
  tenant: string,
  id: string,
  reviewer: string,
  now?: string,
): Promise<WatchContract> {
  const at = now ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(at) + CONTRACT_TTL_MS).toISOString();
  return db.transaction(async () => {
    const existing = await loadWatchContract(db, tenant, id, at);
    if (!existing) throw new WatchError('NOT_FOUND', `watch contract ${id} not found for tenant ${tenant}`);
    const updated: WatchContract = {
      ...existing,
      state: 'ACTIVE',
      expiresAt,
      reviewedAt: at,
      reviewedBy: reviewer,
    };
    await db
      .prepare(
        `UPDATE watch_contracts
         SET state = 'ACTIVE', expires_at = ?, reviewed_at = ?, reviewed_by = ?
         WHERE tenant = ? AND id = ?`,
      )
      .run(expiresAt, at, reviewer, tenant, id);
    return updated;
  });
}

export async function listWatchContracts(
  db: AsyncDb,
  tenant: string,
  state?: string,
  now?: string,
): Promise<WatchContract[]> {
  const at = now ?? new Date().toISOString();
  let sql = 'SELECT * FROM watch_contracts WHERE tenant = ?';
  const args: unknown[] = [tenant];
  if (state) {
    sql += ' AND state = ?';
    args.push(state);
  }
  sql += ' ORDER BY compiled_at DESC';
  const rows = (await db.prepare(sql).all(...args)) as WatchContractRow[];
  return rows.map((r) => rowToWatchContract(r, at));
}
