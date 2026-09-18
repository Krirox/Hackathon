import type { CoordinationRequest } from '../core/types.ts';
import type { AsyncDb } from '../core/db.ts';
import { loadRoomConfig, type RoomAutonomy } from './rooms.ts';

/**
 * Room-config enforcement: the point where the wizard's promises become real.
 *
 * Until now `autonomy`, `budgetCeilingDollars` and `budgetCeilingTokens` were
 * read only by display code (health, gauges, canvases) — an operator could set
 * "Supervised" or a $250 approval threshold and nothing anywhere would obey it.
 * This module is the enforcement seam the dispatch loop calls.
 *
 * Semantics, per room autonomy tier:
 * - `autonomous`: dispatch proceeds unless a budget ceiling is already exceeded.
 * - `guarded`: dispatch proceeds only while cumulative scope spend is under the
 *   configured approval threshold (85% of the dollar ceiling, mirroring the
 *   🟡 gauge warning) — above it, the request waits for a human.
 * - `supervised`: every dispatch waits for a human, full stop.
 *
 * A room that is not `active` never dispatches. Budget ceilings are enforced
 * for every tier: exceeding one refuses dispatch regardless of autonomy.
 */

export type DispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: 'ROOM_INACTIVE' | 'BUDGET_EXCEEDED' | 'SUPERVISED' | 'GUARDED_GATE' };

/** Cumulative spend for one scope, from the requests table. */
export async function scopeSpend(
  db: AsyncDb,
  tenant: string,
  scope: string,
): Promise<{ dollars: number; tokens: number }> {
  const row = (await db
    .prepare(
      `SELECT COALESCE(SUM(spent_dollars), 0) AS dollars, COALESCE(SUM(spent_tokens), 0) AS tokens
       FROM requests WHERE tenant = ? AND target_scope = ?`,
    )
    .get(tenant, scope)) as { dollars: number; tokens: number } | undefined;
  return { dollars: Number(row?.dollars ?? 0), tokens: Number(row?.tokens ?? 0) };
}

/** The dollar spend at which a guarded room starts demanding human approval. */
export function guardedApprovalThresholdDollars(budgetCeilingDollars: number): number {
  return budgetCeilingDollars > 0 ? budgetCeilingDollars * 0.85 : 0;
}

/**
 * Decide whether a request may dispatch, given its room's configuration.
 * Pure in the config, async only in the spend lookup — safe to call per tick.
 */
export async function evaluateDispatch(
  db: AsyncDb,
  tenant: string,
  request: Pick<CoordinationRequest, 'targetScope'> & { bid?: { dollars?: number } },
): Promise<DispatchDecision> {
  const config = await loadRoomConfig(db, tenant, request.targetScope);

  if (!config.active) {
    return {
      allowed: false,
      code: 'ROOM_INACTIVE',
      reason: `#${config.name} is disabled — enable it in room settings before dispatching work to ${config.scope}`,
    };
  }

  const spend = await scopeSpend(db, tenant, config.scope);

  // Budget ceilings bind every tier: a hard ceiling is a hard ceiling.
  if (config.budgetCeilingDollars > 0 && spend.dollars >= config.budgetCeilingDollars) {
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: `#${config.name} has spent $${spend.dollars.toFixed(2)} of its $${config.budgetCeilingDollars.toFixed(0)} ceiling — raise the ceiling to resume`,
    };
  }
  if (config.budgetCeilingTokens > 0 && spend.tokens >= config.budgetCeilingTokens) {
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: `#${config.name} has spent ${spend.tokens.toLocaleString()} of its ${config.budgetCeilingTokens.toLocaleString()} token ceiling`,
    };
  }

  const threshold = guardedApprovalThresholdDollars(config.budgetCeilingDollars);
  switch (config.autonomy as RoomAutonomy) {
    case 'supervised':
      return {
        allowed: false,
        code: 'SUPERVISED',
        reason: `#${config.name} is supervised — every dispatch needs a human approval`,
      };
    case 'guarded':
      if (threshold > 0 && spend.dollars >= threshold) {
        return {
          allowed: false,
          code: 'GUARDED_GATE',
          reason: `#${config.name} is guarded and has reached $${spend.dollars.toFixed(2)} of its $${threshold.toFixed(0)} approval threshold — approve to continue`,
        };
      }
      return { allowed: true };
    case 'autonomous':
    default:
      return { allowed: true };
  }
}

/**
 * The strings room settings show the operator, so the UI and the enforcement
 * can never drift apart.
 */
export function describeAutonomy(autonomy: RoomAutonomy, budgetCeilingDollars: number): string {
  switch (autonomy) {
    case 'autonomous':
      return 'Dispatches freely within its budget ceiling.';
    case 'guarded':
      return `Dispatches until scope spend reaches ${guardedApprovalThresholdDollars(budgetCeilingDollars).toFixed(0)} USD, then waits for approval.`;
    case 'supervised':
      return 'Every dispatch waits for a human approval.';
  }
}
