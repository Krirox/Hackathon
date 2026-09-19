// Shell reads — the console's hot path, deduplicated per request.
//
// Measured on a seeded tenant before this existed (see the statement counts in
// the same change):
//
//   GET /console/rooms  181 statements — evaluateAll() ran TWICE, because the
//                       page asks for room health and then wrapInWorkspaceShell
//                       asks for it again to draw the rail
//   every shelled page  `listStops()` ran 13× — once per room evaluated
//
// The functions here are the same reads, keyed per request, so the second ask is
// free. None of them is a cache in the invalidation sense: the entry dies with
// the response, and `memo` is switched off entirely for a request that can write
// (see core/request-cache.ts), so a handler that writes and re-renders still
// reads fresh.
//
// Deliberately *not* here: any read whose result depends on arguments other than
// the ones in the key. `roomHealth` takes no evaluator dependencies on purpose —
// passing them would make the key a guess, and two callers with different
// dependencies would silently share one evaluation.

import { memo } from '../core/request-cache.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { computeRoomRecency, computeShellMetrics, type ShellMetrics } from './workspace-shell.ts';
import type { AsyncDb } from '../core/db.ts';

/**
 * Every canonical and custom room with its health, evaluated once per request.
 *
 * This is the expensive one: one evaluation per room, each several queries, so a
 * shelled page that shows rooms was paying for the full set twice.
 */
export function roomHealth(db: AsyncDb, tenant: string): Promise<RoomHealthEvaluation[]> {
  return memo(`shell:room-health:${tenant}`, () =>
    new ScopeHealthEvaluator(db, tenant, {}).evaluateAll(),
  );
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
  return memo(`shell:metrics:${tenant}:${caps.escalationsPerDay ?? ''}:${caps.humanMinutesPerDay ?? ''}:${caps.dailyBudgetDollars ?? ''}`, () =>
    computeShellMetrics(db, tenant, caps),
  );
}

/**
 * Minutes since the last message per room. One query per scope, so callers that
 * overlap (a rail and a page body asking about the same rooms) share the pass.
 */
export function roomRecency(
  db: AsyncDb,
  tenant: string,
  scopes: string[],
): Promise<Record<string, number | null>> {
  return memo(`shell:recency:${tenant}:${scopes.join(',')}`, () =>
    computeRoomRecency(db, tenant, scopes),
  );
}
