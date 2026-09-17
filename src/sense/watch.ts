import { z } from 'zod';

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
  tenant: string;
  name: string;
  entities: string[];
  predicates: string[];
  goalRefs: string[];
  revenueCostRisk: string[];
  thresholds: Record<string, number>;
  budgets: { maxDollars: number; maxTokens: number };
  compiledAt: string;
  /** Re-review date. Past it, the contract stops firing. */
  expiresAt: string;
  state: 'ACTIVE' | 'SUSPENDED_BUDGET' | 'EXPIRED';
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
  return {
    version: 1,
    tenant: g.tenant,
    name: g.name,
    entities: [...new Set(g.entities)],
    predicates: [...new Set(g.predicates)],
    goalRefs: [...g.goalRefs],
    revenueCostRisk: [...g.revenueCostRisk],
    thresholds: { ...g.thresholds },
    budgets: { maxDollars: g.maxDollars, maxTokens: g.maxTokens },
    compiledAt: now,
    expiresAt: new Date(Date.parse(now) + CONTRACT_TTL_MS).toISOString(),
    state: 'ACTIVE',
  };
}

export interface Signal {
  entityRefs: string[];
  goalRefs: string[];
  revenueCostRiskRefs?: string[];
  scores: Record<string, number>;
}

export interface MaterialityVerdict {
  material: boolean;
  reasons: string[];
}

/**
 * The materiality gate: a signal that links to no live GOAL and no
 * revenue/cost/risk path archives, no matter how loud it is.
 */
export function materialityCheck(
  contract: WatchContract,
  signal: Signal,
  liveGoalIds: readonly string[],
): MaterialityVerdict {
  const reasons: string[] = [];
  if (contract.state !== 'ACTIVE') {
    return { material: false, reasons: [`contract is ${contract.state} — re-review before it fires again`] };
  }
  const liveGoals = signal.goalRefs.filter((g) => liveGoalIds.includes(g));
  const priced = (signal.revenueCostRiskRefs ?? []).filter((r) => contract.revenueCostRisk.includes(r));
  if (liveGoals.length === 0 && priced.length === 0) {
    return { material: false, reasons: ['no live GOAL and no revenue/cost/risk path — archive'] };
  }
  if (liveGoals.length > 0) reasons.push(`links live goal(s): ${liveGoals.join(', ')}`);
  if (priced.length > 0) reasons.push(`touches revenue/cost/risk: ${priced.join(', ')}`);
  const unknownEntities = signal.entityRefs.filter((e) => !contract.entities.includes(e));
  if (unknownEntities.length > 0) {
    return {
      material: false,
      reasons: [...reasons, `outside contract entities: ${unknownEntities.join(', ')} — archive`],
    };
  }
  for (const [k, v] of Object.entries(signal.scores)) {
    const t = contract.thresholds[k];
    if (t !== undefined && v < t) {
      return { material: false, reasons: [...reasons, `score ${k}=${v} below threshold ${t} — archive`] };
    }
  }
  return { material: true, reasons };
}

/** Contracts past re-review stop firing; contracts past budget suspend. */
export function contractStatus(
  contract: WatchContract,
  now: string,
  spent: { dollars: number; tokens: number },
): WatchContract {
  if (now > contract.expiresAt) return { ...contract, state: 'EXPIRED' };
  if (spent.dollars > contract.budgets.maxDollars || spent.tokens > contract.budgets.maxTokens) {
    return { ...contract, state: 'SUSPENDED_BUDGET' };
  }
  return contract;
}
