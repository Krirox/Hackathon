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
      throw new AttributionError('BAD_RATES', 'stored rates are not usable: refusing to price on garbage');
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
  /** Null when no good outcome exists yet OR cost is unknown/malformed. */
  costPerGoodDecision: number | null;
  /** True when any request or trace in the decision's hierarchy has corrupted/unparseable cost data. */
  unknownCost?: boolean;
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
 * Bulk cost roll-up: bounded queries for N decisions.
 * Decomposed child and sub-task requests roll up into their parent decision.
 * Corrupted or unparseable cost payloads flag `unknownCost` rather than masquerading as $0.
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
  const rootReqIds = [...new Set([...byId.values()].filter((r): r is string => r !== null))];

  // Map each descendant request to its root decision request ID
  const rootByDescendant = new Map<string, string>();
  for (const r of rootReqIds) {
    rootByDescendant.set(r, r);
  }
  let currentLayer = [...rootReqIds];
  while (currentLayer.length > 0) {
    const parentList = currentLayer.map(() => '?').join(',');
    const children = (await db
      .prepare(`SELECT id, parent_request FROM requests WHERE tenant = ? AND parent_request IN (${parentList})`)
      .all(tenant, ...currentLayer)) as { id: string; parent_request: string }[];
    currentLayer = [];
    for (const ch of children) {
      const parentRoot = rootByDescendant.get(ch.parent_request);
      if (parentRoot && !rootByDescendant.has(ch.id)) {
        rootByDescendant.set(ch.id, parentRoot);
        currentLayer.push(ch.id);
      }
    }
  }

  const allReqIds = [...rootByDescendant.keys()];
  const spentByRoot = new Map<string, { humanMinutes: number; dollars: number; unknownCost: boolean }>();
  for (const r of rootReqIds) {
    spentByRoot.set(r, { humanMinutes: 0, dollars: 0, unknownCost: false });
  }

  if (allReqIds.length > 0) {
    const reqList = allReqIds.map(() => '?').join(',');
    const rows = (await db
      .prepare(`SELECT id, spent_json FROM requests WHERE tenant = ? AND id IN (${reqList})`)
      .all(tenant, ...allReqIds)) as { id: string; spent_json: string }[];
    for (const r of rows) {
      const root = rootByDescendant.get(String(r.id));
      if (!root) continue;
      const acc = spentByRoot.get(root) ?? { humanMinutes: 0, dollars: 0, unknownCost: false };
      try {
        const s = JSON.parse(String(r.spent_json)) as { humanMinutes?: number; dollars?: number };
        const hm = Number(s.humanMinutes ?? 0);
        const d = Number(s.dollars ?? 0);
        if (!Number.isFinite(hm) || hm < 0 || !Number.isFinite(d) || d < 0) {
          acc.unknownCost = true;
        } else {
          acc.humanMinutes += hm;
          acc.dollars += d;
        }
      } catch {
        acc.unknownCost = true;
      }
      spentByRoot.set(root, acc);
    }
  }

  const tokensByRoot = new Map<string, { tokens: number; unknownCost: boolean }>();
  for (const r of rootReqIds) {
    tokensByRoot.set(r, { tokens: 0, unknownCost: false });
  }

  if (allReqIds.length > 0) {
    const reqList = allReqIds.map(() => '?').join(',');
    const rows = (await db
      .prepare(`SELECT request_id, cost_json FROM traces WHERE tenant = ? AND request_id IN (${reqList})`)
      .all(tenant, ...allReqIds)) as { request_id: string; cost_json: string }[];
    for (const t of rows) {
      const root = rootByDescendant.get(String(t.request_id));
      if (!root) continue;
      const acc = tokensByRoot.get(root) ?? { tokens: 0, unknownCost: false };
      try {
        const parsed = JSON.parse(String(t.cost_json)) as { tokens?: number };
        if (parsed.tokens !== undefined) {
          const n = Number(parsed.tokens);
          if (!Number.isFinite(n) || n < 0) {
            acc.unknownCost = true;
          } else {
            acc.tokens += n;
          }
        }
      } catch {
        acc.unknownCost = true;
      }
      tokensByRoot.set(root, acc);
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

  // Pre-registrations associated with these decisions or the tenant
  const preregRows = (await db.prepare("SELECT key, value FROM meta WHERE key LIKE 'prereg:%'").all()) as {
    key: string;
    value: string;
  }[];
  const preregByDec = new Map<string, PreregisteredMetric[]>();
  for (const pr of preregRows) {
    try {
      const rec = JSON.parse(String(pr.value)) as Preregistration;
      if (rec.tenant === tenant && rec.decisionId && rec.metrics) {
        preregByDec.set(rec.decisionId, rec.metrics);
      }
    } catch {
      /* ignore unparseable meta */
    }
  }

  void coord;
  void ledger;
  for (const id of ids) {
    if (!byId.has(id)) continue;
    const reqId = byId.get(id);
    const rootSpent = reqId
      ? (spentByRoot.get(reqId) ?? { humanMinutes: 0, dollars: 0, unknownCost: false })
      : { humanMinutes: 0, dollars: 0, unknownCost: false };
    const rootTokens = reqId
      ? (tokensByRoot.get(reqId) ?? { tokens: 0, unknownCost: false })
      : { tokens: 0, unknownCost: false };
    const unknownCost = rootSpent.unknownCost || rootTokens.unknownCost;
    const outcomes = outcomesByDec.get(id) ?? [];
    const preregMetrics = preregByDec.get(id);

    // Evaluate metric direction — use preregistered direction/threshold when available,
    // otherwise infer lower-is-better for cost/latency/churn/error/defect.
    const isPassingOutcome = (o: DecisionCost['outcomes'][number]): boolean => {
      const prereg = preregMetrics?.find((m) => m.name.toLowerCase() === o.metric.toLowerCase());
      if (prereg) {
        const lowerIsBetter =
          prereg.direction === 'lower' ||
          (!prereg.direction && /latency|error|churn|cost|time|defect|delay/i.test(o.metric));
        return lowerIsBetter ? o.actual <= prereg.threshold : o.actual >= prereg.threshold;
      }
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
    const dollars =
      rootSpent.dollars +
      rootTokens.tokens * rates.dollarPerToken +
      rootSpent.humanMinutes * rates.dollarPerHumanMinute;
    const costPerGoodDecision = good === 0 || unknownCost ? null : dollars;
    out.set(id, {
      decisionId: id,
      tokens: rootTokens.tokens,
      humanMinutes: rootSpent.humanMinutes,
      requestDollars: rootSpent.dollars,
      dollars,
      outcomes,
      goodDecisions: good,
      costPerGoodDecision,
      ...(unknownCost ? { unknownCost: true } : {}),
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

  // Prevent post-hoc pre-registration:
  // If a decisionId is provided, verify no outcomes already exist for it
  if (input.decisionId) {
    const outcomeCount = (await db
      .prepare('SELECT COUNT(*) AS n FROM outcomes WHERE tenant = ? AND decision_id = ?')
      .get(tenant, input.decisionId)) as { n: number } | undefined;
    if (Number(outcomeCount?.n ?? 0) > 0) {
      throw new AttributionError(
        'POST_HOC_PREREG',
        `cannot pre-register metrics for decision ${input.decisionId}: outcomes already exist`,
      );
    }
  }

  const id = `prereg_${createHash('sha256')
    .update(`${tenant}:${input.decisionId ?? ''}:${at}:${JSON.stringify(input.metrics)}`)
    .digest('hex')
    .slice(0, 16)}`;
  const key = `prereg:${id}`;

  // Immutability check:
  const existingRow = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as
    { value: string } | undefined;
  if (existingRow) {
    const existing = JSON.parse(existingRow.value) as Preregistration;
    if (JSON.stringify(existing.metrics) !== JSON.stringify(input.metrics)) {
      throw new AttributionError('PREREG_IMMUTABLE', 'pre-registration is immutable and cannot be updated');
    }
    return existing;
  }

  const rec: Preregistration = {
    id,
    tenant,
    decisionId: input.decisionId ?? null,
    metrics: input.metrics,
    agreedBy: input.agreedBy,
    agreedAt: at,
  };
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(rec));
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
    caveats.push('no pre-registration: thresholds were not agreed before the pilot: delta claims are post-hoc');
  if (!input.hasBaseline) caveats.push('no baseline captured: there is no delta to prove');
  if (!input.hasHoldout) caveats.push('no holdout lane: cannot rule out seasonality or cannibalisation');
  if (input.daysObserved < 14)
    caveats.push(`only ${input.daysObserved} day(s) observed: too short to separate signal from week-effects`);
  return caveats;
}

export interface TenantCaveatsReport {
  caveats: string[];
  metrics: {
    daysObserved: number;
    hasHoldout: boolean;
    hasBaseline: boolean;
    hasPrereg: boolean;
  };
}

/**
 * Inspects real tenant data (outcomes, holdouts, pre-registrations, observation window)
 * and returns the active blocking caveats derived directly from the database.
 */
export async function evaluateTenantCaveats(db: AsyncDb, tenant: string, now?: string): Promise<TenantCaveatsReport> {
  const at = now ?? new Date().toISOString();
  // 1. Check preregistrations for tenant
  const preregRows = (await db.prepare("SELECT value FROM meta WHERE key LIKE 'prereg:%'").all()) as {
    value: string;
  }[];
  let hasPrereg = false;
  for (const pr of preregRows) {
    try {
      const rec = JSON.parse(String(pr.value)) as Preregistration;
      if (rec.tenant === tenant && Array.isArray(rec.metrics) && rec.metrics.length > 0) {
        hasPrereg = true;
        break;
      }
    } catch {
      /* ignore unparseable */
    }
  }

  // 2. Check holdout lane in outcomes
  const holdoutRow = (await db
    .prepare('SELECT COUNT(*) AS n FROM outcomes WHERE tenant = ? AND holdout_ref IS NOT NULL')
    .get(tenant)) as { n: number } | undefined;
  const hasHoldout = Number(holdoutRow?.n ?? 0) > 0;

  // 3. Check baseline in meta overlays or outcomes
  const baselineMeta = (await db
    .prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE ? AND value LIKE '%baseline%'")
    .get(`workspace_overlay:${tenant}:%`)) as { n: number } | undefined;
  const baselineOutcomes = (await db
    .prepare("SELECT COUNT(*) AS n FROM outcomes WHERE tenant = ? AND basis LIKE '%baseline%'")
    .get(tenant)) as { n: number } | undefined;
  const hasBaseline = Number(baselineMeta?.n ?? 0) > 0 || Number(baselineOutcomes?.n ?? 0) > 0;

  // 4. Days observed from earliest decision or outcome
  const earliestDecision = (await db
    .prepare('SELECT MIN(signed_at) AS min_at FROM decisions WHERE tenant = ?')
    .get(tenant)) as { min_at: string | null } | undefined;
  const earliestOutcome = (await db
    .prepare('SELECT MIN(created_at) AS min_at FROM outcomes WHERE tenant = ?')
    .get(tenant)) as { min_at: string | null } | undefined;

  const dates = [earliestDecision?.min_at, earliestOutcome?.min_at].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
  let daysObserved = 0;
  if (dates.length > 0) {
    dates.sort();
    const earliestMs = new Date(dates[0]!).getTime();
    const nowMs = new Date(at).getTime();
    if (Number.isFinite(earliestMs) && Number.isFinite(nowMs) && nowMs > earliestMs) {
      daysObserved = Math.max(1, Math.floor((nowMs - earliestMs) / (1000 * 60 * 60 * 24)));
    }
  }

  const caveats = attributionCaveats({ daysObserved, hasHoldout, hasBaseline, hasPrereg });
  return {
    caveats,
    metrics: { daysObserved, hasHoldout, hasBaseline, hasPrereg },
  };
}
