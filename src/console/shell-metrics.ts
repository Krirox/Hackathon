// Shell telemetry — the real numbers both shells draw in their chrome.
//
// These reads used to live in workspace-shell.ts, which forced the Console
// shell to import from the chat shell just to type its own header. The two
// surfaces are deliberately separate systems (design.md: two shells, one
// codebase), so the shared *data* lives here, neutral: each shell imports the
// numbers without importing the other. The SQL is byte-identical to what moved.
//
// Honesty rule (matches both shells): every figure is a real read. A missing
// or non-positive cap renders spend-only, a room with no messages renders
// "—" — never an invented limit.

import type { AsyncDb } from '../core/db.ts';

export interface ShellMetrics {
  /** Today's spend in dollars (UTC day), from requests. */
  dollarsToday: number;
  /** Escalations today: used / cap (cap <= 0 renders as used, no invented cap). */
  escalationsUsed: number;
  escalationsCap: number;
  /** Human minutes spent today / delegated ceiling (ceiling <= 0 renders as spent, no invented cap). */
  humanMinutesToday: number;
  humanMinutesCap: number;
  /** Org-wide daily dollar ceiling the coordinator enforces (<= 0 renders as "n/a" — never an invented limit). */
  dailyBudgetCeiling: number;
}

/** Minutes since a room's last buzz message, or null when it has none. */
function minutesSince(last: number | string | null, nowMs: number): number | null {
  if (!last) return null;
  const lastMs = typeof last === 'number' ? last : Date.parse(String(last));
  if (!Number.isFinite(lastMs)) return null;
  return Math.max(0, Math.floor((nowMs - lastMs) / 60_000));
}

/**
 * Computes the shell's header telemetry from real tables:
 *  - dollarsToday: SUM(spent_dollars) over requests created today (UTC)
 *  - escalationsToday: COUNT(escalations) for today (the coordinator's own
 *    daily-attention accounting — the same source admission enforces against)
 *  - humanMinutesToday: SUM over today's spent_json human minutes
 * Caller supplies the configured caps (room/policy limits). A missing or
 * non-positive cap renders as spend-only — never an invented limit.
 */
export async function computeShellMetrics(
  db: AsyncDb,
  tenant: string,
  caps: { escalationsPerDay?: number; humanMinutesPerDay?: number; dailyBudgetDollars?: number } = {},
  now: () => string = () => new Date().toISOString(),
): Promise<ShellMetrics> {
  const at = now();
  const day = at.slice(0, 10);
  const dayStart = `${day}T00:00:00.000Z`;

  const spendRow = (await db
    .prepare(
      `SELECT COALESCE(SUM(spent_dollars), 0) AS dollars
       FROM requests WHERE tenant = ? AND created_at >= ?`,
    )
    .get(tenant, dayStart)) as { dollars: number | string } | undefined;

  // Human minutes live in spent_json; sum them in SQL where the engine
  // supports it, else aggregate a bounded recent window in JS.
  const rows = (await db
    .prepare(
      `SELECT spent_json FROM requests WHERE tenant = ? AND created_at >= ? AND spent_json LIKE '%humanMinutes%' LIMIT 2000`,
    )
    .all(tenant, dayStart)) as { spent_json: string }[];

  let humanMinutesToday = 0;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.spent_json) as { humanMinutes?: number };
      const v = Number(parsed.humanMinutes);
      if (Number.isFinite(v)) humanMinutesToday += v;
    } catch {
      // unparseable spend is unknown, not zero-cost; skip but never invent
    }
  }

  const escRow = (await db
    .prepare('SELECT COUNT(*) AS n FROM escalations WHERE tenant = ? AND day = ?')
    .get(tenant, day)) as { n: number } | undefined;

  const dollars = Number(spendRow?.dollars ?? 0);

  return {
    dollarsToday: Number.isFinite(dollars) ? dollars : 0,
    escalationsUsed: Number(escRow?.n ?? 0),
    escalationsCap: caps.escalationsPerDay ?? 0,
    humanMinutesToday,
    humanMinutesCap: caps.humanMinutesPerDay ?? 0,
    dailyBudgetCeiling: caps.dailyBudgetDollars ?? 0,
  };
}

/**
 * Real per-room recency (minutes since last buzz message) for the sidebar.
 * Rooms with no messages map to null → rendered as "—".
 *
 * One grouped read for every scope, not one read per scope: the rail asks this
 * for every room on every page, so a per-room query made the chrome's cost grow
 * with the tenant's room count. Scopes with no messages have no row and answer
 * null, which is what the per-room `get()` returned for them too.
 */
export async function computeRoomRecency(
  db: AsyncDb,
  tenant: string,
  scopes: string[],
  now: () => string = () => new Date().toISOString(),
): Promise<Record<string, number | null>> {
  const nowMs = Date.parse(now());
  const out: Record<string, number | null> = {};
  const wanted = [...new Set(scopes)];
  for (const scope of wanted) out[scope] = null;
  if (wanted.length === 0) return out;
  const rows = (await db
    .prepare(
      `SELECT scope, MAX(created_at) AS last FROM buzz_messages
       WHERE tenant = ? AND scope IN (${wanted.map(() => '?').join(', ')})
       GROUP BY scope`,
    )
    .all(tenant, ...wanted)) as { scope: string; last: number | string | null }[];
  for (const row of rows) {
    if (!(row.scope in out)) continue;
    out[row.scope] = minutesSince(row.last, nowMs);
  }
  return out;
}
