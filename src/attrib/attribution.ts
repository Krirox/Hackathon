import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';

/**
 * Attribution (TODO §§2.4, 3.2): results must be counterfactual, and costs
 * must roll up to the north-star curve.
 *
 *   decision_id → Σ(inference $ + tool $ + human_minutes × rate) → outcomes
 *               → cost per good decision
 *
 * A "good" decision is one whose measured OUTCOME meets the prediction made
 * before the pilot started (or has no prediction and a non-null actual —
 * measured is measured). Pre-registration is the anti-self-deception
 * control: metrics + thresholds agreed BEFORE the pilot, tamper-evident in
 * the audit log. Holdout lanes live outside this repo (segment/geo splits
 * in the customer's systems); what lives here is deterministic assignment
 * so "adoption rose" can mean something.
 */

export class AttributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[attrib:${code}] ${message}`);
  }
}

export interface Rates {
  dollarPerToken: number;
  dollarPerHumanMinute: number;
}

export interface DecisionCost {
  decisionId: string;
  tokens: number;
  humanMinutes: number;
  requestDollars: number;
  dollars: number;
  outcomes: { metric: string; predicted: number | null; actual: number; holdoutRef: string | null }[];
  goodDecisions: number;
  /** Null when no good outcome exists yet — not zero, unknown. */
  costPerGoodDecision: number | null;
}

export async function costOfDecision(
  db: AsyncDb,
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  decisionId: string,
  rates: Rates,
): Promise<DecisionCost> {
  const dec = await ledger.getDecision(tenant, decisionId);
  if (!dec) throw new AttributionError('MISSING_DECISION', `unknown decision ${decisionId}`);
  let tokens = 0;
  let humanMinutes = 0;
  let requestDollars = 0;
  if (dec.requestId) {
    const req = await coord.get(tenant, dec.requestId);
    if (req) {
      humanMinutes += req.spent.humanMinutes;
      requestDollars += req.spent.dollars;
    }
    const traces = (await db
      .prepare('SELECT cost_json FROM traces WHERE tenant = ? AND request_id = ?')
      .all(tenant, dec.requestId)) as { cost_json: string }[];
    for (const t of traces) {
      try {
        tokens += Number((JSON.parse(String(t.cost_json)) as { tokens?: number }).tokens ?? 0);
      } catch {
        /* a malformed cost blob contributes nothing — it does not poison the roll-up */
      }
    }
  }
  const outcomes = (await db
    .prepare('SELECT metric, predicted, actual, holdout_ref FROM outcomes WHERE tenant = ? AND decision_id = ?')
    .all(tenant, decisionId)) as {
    metric: string;
    predicted: number | null;
    actual: number;
    holdout_ref: string | null;
  }[];
  const rows = outcomes.map((o) => ({
    metric: String(o.metric),
    predicted: o.predicted === null ? null : Number(o.predicted),
    actual: Number(o.actual),
    holdoutRef: o.holdout_ref === null ? null : String(o.holdout_ref),
  }));
  const good = rows.filter((o) => (o.predicted === null ? o.actual !== 0 : o.actual >= o.predicted)).length;
  const dollars = requestDollars + tokens * rates.dollarPerToken + humanMinutes * rates.dollarPerHumanMinute;
  return {
    decisionId,
    tokens,
    humanMinutes,
    requestDollars,
    dollars,
    outcomes: rows,
    goodDecisions: good,
    costPerGoodDecision: good === 0 ? null : dollars / good,
  };
}

/** Deterministic holdout assignment: same key, same lane, every time. */
export function assignHoldout(key: string, holdoutRatio = 0.1): 'holdout' | 'treated' {
  if (holdoutRatio <= 0 || holdoutRatio >= 1)
    throw new AttributionError('BAD_RATIO', 'holdout ratio must be in (0, 1)');
  const h = createHash('sha256').update(`holdout:${key}`).digest();
  const v = h.readUInt32BE(0) / 0xffffffff;
  return v < holdoutRatio ? 'holdout' : 'treated';
}

export interface Preregistration {
  id: string;
  tenant: string;
  decisionId: string | null;
  metrics: { name: string; threshold: number }[];
  agreedBy: string;
  agreedAt: string;
}

/** Metrics + thresholds agreed BEFORE the pilot starts. Visible in audit; that is the tamper evidence. */
export async function preregister(
  db: AsyncDb,
  tenant: string,
  input: { decisionId?: string; metrics: { name: string; threshold: number }[]; agreedBy: string; now?: string },
): Promise<Preregistration> {
  const at = input.now ?? new Date().toISOString();
  if (input.metrics.length === 0)
    throw new AttributionError('EMPTY_PREREG', 'pre-registering no metrics promises nothing');
  if (!input.agreedBy) throw new AttributionError('NO_OWNER', 'a pre-registration without a named owner is theater');
  const id = `prereg_${createHash('sha256')
    .update(`${tenant}:${at}:${JSON.stringify(input.metrics)}`)
    .digest('hex')
    .slice(0, 16)}`;
  const rec: Preregistration = {
    id,
    tenant,
    decisionId: input.decisionId ?? null,
    metrics: input.metrics,
    agreedBy: input.agreedBy,
    agreedAt: at,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`prereg:${id}`, JSON.stringify(rec));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, input.agreedBy, 'PREREGISTER', id, JSON.stringify(input.metrics), at);
  return rec;
}

export async function getPrereg(db: AsyncDb, tenant: string, id: string): Promise<Preregistration | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`prereg:${id}`)) as
    { value: string } | undefined;
  if (!r) return null;
  const rec = JSON.parse(String(r.value)) as Preregistration;
  return rec.tenant === tenant ? rec : null;
}

/** Tier mix over a window: is routine work actually moving to REFLEX/WORKFLOW? */
export async function tierMix(db: AsyncDb, tenant: string): Promise<Record<string, number>> {
  const rows = (await db
    .prepare('SELECT tier AS tier, COUNT(*) AS n FROM traces WHERE tenant = ? GROUP BY tier')
    .all(tenant)) as {
    tier: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.tier)] = Number(r.n);
  return out;
}

/** Cost of misrouting (TODO §4): labelled decisions where the router proposed wrong, by tier. */
export async function misroutingCounts(
  db: AsyncDb,
  tenant: string,
): Promise<{ tier: string; misses: number; samples: number }[]> {
  const rows = (await db
    .prepare(
      `SELECT proposed AS tier, COUNT(*) AS samples,
              SUM(CASE WHEN proposed <> correct_tier THEN 1 ELSE 0 END) AS misses
         FROM routing_decisions WHERE tenant = ? AND labeled = 1 AND correct_tier IS NOT NULL
         GROUP BY proposed`,
    )
    .all(tenant)) as { tier: string; samples: number; misses: number }[];
  return rows.map((r) => ({ tier: String(r.tier), misses: Number(r.misses), samples: Number(r.samples) }));
}

/**
 * Metric-deception checks, honest edition (TODO §3.2): we cannot detect
 * seasonality or cannibalisation without the data those need, so this
 * returns the BLOCKING caveats — claims you may not make until the
 * evidence exists. A report with an empty caveat list is trustworthy;
 * anything else is a TODO list, not a result.
 */
export function attributionCaveats(input: {
  daysObserved: number;
  hasHoldout: boolean;
  hasBaseline: boolean;
  hasPrereg: boolean;
}): string[] {
  const caveats: string[] = [];
  if (!input.hasPrereg)
    caveats.push('no pre-registration: thresholds were not agreed before the pilot — delta claims are post-hoc');
  if (!input.hasBaseline) caveats.push('no baseline captured: there is no delta to prove');
  if (!input.hasHoldout) caveats.push('no holdout lane: cannot rule out seasonality or cannibalisation');
  if (input.daysObserved < 14)
    caveats.push(`only ${input.daysObserved} day(s) observed: too short to separate signal from week-effects`);
  return caveats;
}
