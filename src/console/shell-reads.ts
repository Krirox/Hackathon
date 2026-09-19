// Shell reads — the real numbers both shells draw, memoized per request.
//
// The telemetry (dollars spent today, escalations, human minutes) and the
// per-room recency are shared by the Console shell and the Workspace shell.
// They live in shell-metrics.ts so neither shell imports the other; the memo
// keys here keep a page that asks twice (shell + page body) paying once.

import { memo } from '../core/request-cache.ts';
import type { AsyncDb } from '../core/db.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { computeRoomRecency, computeShellMetrics, type ShellMetrics } from './shell-metrics.ts';

export type { ShellMetrics } from './shell-metrics.ts';

/**
 * Every canonical and custom room with its health, evaluated once per request.
 *
 * This is the expensive one: one evaluation per room, each several queries, so a
 * shelled page that shows rooms was paying for the full set twice.
 */
export function roomHealth(db: AsyncDb, tenant: string): Promise<RoomHealthEvaluation[]> {
  return memo(`shell:room-health:${tenant}`, () => new ScopeHealthEvaluator(db, tenant, {}).evaluateAll());
}

/**
 * Shell header telemetry (spend today, escalations, human minutes).
 *
 * Keyed on the caps as well as the tenant: the dashboard asks with the
 * coordinator's daily budget while the rail asks without it, and those are
 * different renders of the same numbers — they must not share one entry.
 */
export function shellMetrics(
  db: AsyncDb,
  tenant: string,
  caps: { escalationsPerDay?: number; humanMinutesPerDay?: number; dailyBudgetDollars?: number } = {},
): Promise<ShellMetrics> {
  return memo(
    `shell:metrics:${tenant}:${caps.escalationsPerDay ?? ''}:${caps.humanMinutesPerDay ?? ''}:${caps.dailyBudgetDollars ?? ''}`,
    () => computeShellMetrics(db, tenant, caps),
  );
}

/**
 * Minutes since the last message per room. One query per scope, so callers that
 * overlap (a rail and a page body asking about the same rooms) share the pass.
 */
export function roomRecency(db: AsyncDb, tenant: string, scopes: string[]): Promise<Record<string, number | null>> {
  return memo(`shell:recency:${tenant}:${scopes.join(',')}`, () => computeRoomRecency(db, tenant, scopes));
}
