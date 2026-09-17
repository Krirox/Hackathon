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

/**
 * Versioned rates (audit cost finding): the dashboard used to price every
 * decision at fixed code constants, which silently reprices history whenever
 * the constants move. Rates now live in meta per tenant with an audit trail;
 * readers resolve what is stored, writers bump explicitly.
 */
export const DEFAULT_RATES: Rates = { dollarPerToken: 0.001, dollarPerHumanMinute: 1 };

export async function getRates(db: AsyncDb, tenant: string): Promise<Rates> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`rates:${tenant}`)) as
    { value: string } | undefined;
  if (!r) return { ...DEFAULT_RATES };
  try {
    const v = JSON.parse(String(r.value)) as Partial<Rates>;
    const dollarPerToken = Number(v.dollarPerToken);
    const dollarPerHumanMinute = Number(v.dollarPerHumanMinute);
    if (
      !Number.isFinite(dollarPerToken) ||
      dollarPerToken < 0 ||
      !Number.isFinite(dollarPerHumanMinute) ||
      dollarPerHumanMinute < 0
    ) {
      throw new AttributionError('BAD_RATES', 'stored rates are not usable — refusing to price on garbage');
    }
    return { dollarPerToken, dollarPerHumanMinute };
  } catch (e) {
    if (e instanceof AttributionError) throw e;
    throw new AttributionError('BAD_RATES', 'stored rates are not parseable');
  }
}

export async function setRates(db: AsyncDb, tenant: string, rates: Rates, by: string, now?: string): Promise<Rates> {
  if (!by) throw new AttributionError('NO_OWNER', 'a rate change without a named human is theater');
  if (
    !Number.isFinite(rates.dollarPerToken) ||
    rates.dollarPerToken < 0 ||
    !Number.isFinite(rates.dollarPerHumanMinute) ||
    rates.dollarPerHumanMinute < 0
  ) {
    throw new AttributionError('BAD_RATES', 'rates must be finite and non-negative');
  }
  const at = now ?? new Date().toISOString();
  const next = { dollarPerToken: rates.dollarPerToken, dollarPerHumanMinute: rates.dollarPerHumanMinute };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`rates:${tenant}`, JSON.stringify(next));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, by, 'RATES_SET', `rates:${tenant}`, JSON.stringify(next), at);
  return next;
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
  const all = await costsOfDecisions(db, coord, ledger, tenant, [decisionId], rates);
  const one = all.get(decisionId);
  if (!one) throw new AttributionError('MISSING_DECISION', `unknown decision ${decisionId}`);
  return one;
}

/**
 * Bulk cost roll-up: 3 bounded queries for N decisions instead of ~4N
 * sequential round trips (getDecision + request + traces + outcomes each).
 * The console cost curve is the driver — per-decision costing over a
 * lifetime of decisions is what made every dashboard GET history-sized.
 */
export async function costsOfDecisions(
  db: AsyncDb,
  coord: Coordinator,
  ledger: Ledger,
  tenant: string,
  decisionIds: string[],
  rates: Rates,
): Promise<Map<string, DecisionCost>> {
  const out = new Map<string, DecisionCost>();
  const ids = [...new Set(decisionIds)];
  if (ids.length === 0) return out;
  const inList = ids.map(() => '?').join(',');
  const decs = (await db
    .prepare(`SELECT id, request_id FROM decisions WHERE tenant = ? AND id IN (${inList})`)
    .all(tenant, ...ids)) as { id: string; request_id: string | null }[];
  const byId = new Map(decs.map((d) => [String(d.id), d.request_id === null ? null : String(d.request_id)]));
  const reqIds = [...new Set([...byId.values()].filter((r): r is string => r !== null))];
  const spentByReq = new Map<string, { humanMinutes: number; dollars: number }>();
  if (reqIds.length > 0) {
    const reqList = reqIds.map(() => '?').join(',');
    const rows = (await db
      .prepare(`SELECT id, spent_json FROM requests WHERE tenant = ? AND id IN (${reqList})`)
      .all(tenant, ...reqIds)) as { id: string; spent_json: string }[];
    for (const r of rows) {
      try {
        const s = JSON.parse(String(r.spent_json)) as { humanMinutes?: number; dollars?: number };
        spentByReq.set(String(r.id), { humanMinutes: Number(s.humanMinutes ?? 0), dollars: Number(s.dollars ?? 0) });
      } catch {
        spentByReq.set(String(r.id), { humanMinutes: 0, dollars: 0 });
      }
    }
  }
  const tokensByReq = new Map<string, number>();
  if (reqIds.length > 0) {
    const reqList = reqIds.map(() => '?').join(',');
    const rows = (await db
      .prepare(`SELECT request_id, cost_json FROM traces WHERE tenant = ? AND request_id IN (${reqList})`)
      .all(tenant, ...reqIds)) as { request_id: string; cost_json: string }[];
    for (const t of rows) {
      try {
        const n = Number((JSON.parse(String(t.cost_json)) as { tokens?: number }).tokens ?? 0);
        tokensByReq.set(String(t.request_id), (tokensByReq.get(String(t.request_id)) ?? 0) + n);
      } catch {
        /* malformed cost blobs contribute nothing — same rule as the single path */
      }
    }
  }
  const outcomesByDec = new Map<string, DecisionCost['outcomes']>();
  const decList = ids.map(() => '?').join(',');
  const orows = (await db
    .prepare(
      `SELECT decision_id, metric, predicted, actual, holdout_ref FROM outcomes WHERE tenant = ? AND decision_id IN (${decList})`,
    )
    .all(tenant, ...ids)) as {
    decision_id: string;
    metric: string;
    predicted: number | null;
    actual: number;
    holdout_ref: string | null;
  }[];
  for (const o of orows) {
    const list = outcomesByDec.get(String(o.decision_id)) ?? [];
    list.push({
      metric: String(o.metric),
      predicted: o.predicted === null ? null : Number(o.predicted),
      actual: Number(o.actual),
      holdoutRef: o.holdout_ref === null ? null : String(o.holdout_ref),
    });
    outcomesByDec.set(String(o.decision_id), list);
  }
  void coord;
  void ledger;
  for (const id of ids) {
    if (!byId.has(id)) continue;
    const reqId = byId.get(id);
    const spent = reqId ? (spentByReq.get(reqId) ?? { humanMinutes: 0, dollars: 0 }) : { humanMinutes: 0, dollars: 0 };
    const tokens = reqId ? (tokensByReq.get(reqId) ?? 0) : 0;
    const outcomes = outcomesByDec.get(id) ?? [];
    // F21: Evaluate metric direction — lower is better for cost/latency/churn/error/defect.
    const isPassingOutcome = (o: DecisionCost['outcomes'][number]): boolean => {
      const lowerIsBetter = /latency|error|churn|cost|time|defect|delay/i.test(o.metric);
      if (o.predicted === null) return o.actual > 0 && !lowerIsBetter;
      return lowerIsBetter ? o.actual <= o.predicted : o.actual >= o.predicted;
    };
    const passingCount = outcomes.filter(isPassingOutcome).length;
    // One decision-level outcome policy:
    // When multiple outcomes exist for a decision, all evaluated outcomes must pass
    // for the decision as a whole to be considered a "good decision".
    const isGoodDecision = outcomes.length > 0 && passingCount === outcomes.length;
    const good = isGoodDecision ? 1 : 0;
    const dollars = spent.dollars + tokens * rates.dollarPerToken + spent.humanMinutes * rates.dollarPerHumanMinute;
    out.set(id, {
      decisionId: id,
      tokens,
      humanMinutes: spent.humanMinutes,
      requestDollars: spent.dollars,
      dollars,
      outcomes,
      goodDecisions: good,
      costPerGoodDecision: good === 0 ? null : dollars,
    });
  }
  return out;
}

/** Deterministic holdout assignment: same key, same lane, every time. */
export function assignHoldout(key: string, holdoutRatio = 0.1): 'holdout' | 'treated' {
  if (holdoutRatio <= 0 || holdoutRatio >= 1)
    throw new AttributionError('BAD_RATIO', 'holdout ratio must be in (0, 1)');
  const h = createHash('sha256').update(`holdout:${key}`).digest();
  const v = h.readUInt32BE(0) / 0xffffffff;
  return v < holdoutRatio ? 'holdout' : 'treated';
}

export interface PreregisteredMetric {
  name: string;
  threshold: number;
  direction?: 'higher' | 'lower';
}

export interface Preregistration {
  id: string;
  tenant: string;
  decisionId: string | null;
  metrics: PreregisteredMetric[];
  agreedBy: string;
  agreedAt: string;
}

/** Metrics + thresholds agreed BEFORE the pilot starts. Visible in audit; that is the tamper evidence. */
export async function preregister(
  db: AsyncDb,
  tenant: string,
  input: { decisionId?: string; metrics: PreregisteredMetric[]; agreedBy: string; now?: string },
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
