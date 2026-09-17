import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ApprovalLatencyStats, Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler, SkillState } from '../compiler/compiler.ts';
import { CognitiveRouter } from '../router/router.ts';
import { describeCardReadOnly } from '../compiler/registry.ts';
import { costsOfDecisions, getRates } from '../attrib/attribution.ts';

/**
 * Output budgets: the dashboard is a bounded window, never history-sized.
 * COST_CURVE_BUDGET caps chart points (downsampled, endpoints preserved);
 * MAX_ROOMS caps room sections and ROOM_REQUESTS caps requests per room —
 * both sliced BEFORE evidence hydration so a large tenant never pays for
 * rows it will not display. MAX_NEEDS_HUMAN and MAX_CARDS_PER_STATE bound
 * the queue and compiler columns the same way.
 */
export const COST_CURVE_BUDGET = 120;
export const MAX_ROOMS = 50;
export const ROOM_REQUESTS = 20;
export const MAX_NEEDS_HUMAN = 100;
export const MAX_CARDS_PER_STATE = 100;

/**
 * Even-stride downsampling to a fixed point budget. Indices spread evenly
 * across the input with the first and last points always kept, so spikes
 * at the edges survive instead of being sliced off by a head/tail cut.
 */
export function downsampleIndices(n: number, budget: number): number[] {
  if (n <= budget || budget <= 0) return Array.from({ length: n }, (_, i) => i);
  if (budget === 1) return [n - 1];
  const out = new Set<number>();
  const step = (n - 1) / (budget - 1);
  for (let i = 0; i < budget; i++) out.add(Math.round(i * step));
  out.add(0);
  out.add(n - 1);
  return [...out].sort((a, b) => a - b);
}

/**
 * Vital Console, read model (the Ledger is our only bespoke surface).
 *
 * Everything on the three boards — Reality health, Compiler, Room — is a
 * pure function of the database. No chat lives here (Buzz exists); what
 * lives here is what chat cannot be: the numbers, the evidence, and the
 * approval queue, all replayable. `renderHtml` turns this model into a
 * zero-backend static report; the live room surface arrives in V2.1.
 */

export interface HealthReport {
  staleFactRate: number;
  staleFactGate: number;
  provenanceComplete: number;
  orphanClaims: number;
  contradictions: { open: number; oldestOpenHours: number | null; mttrHours: number | null; slaHours: number };
  spendToday: { dollars: number };
  escalations: { open: number; cap: number };
  humanMinutes: { spentToday: number; budget: number };
  refusalRate: number;
}

export interface CostPoint {
  at: string;
  label: string;
  costPerGoodDecision: number | null;
}

export interface TierBucket {
  label: string;
  REFLEX: number;
  WORKFLOW: number;
  MODEL: number;
  HUMAN: number;
}

export interface HumanItem {
  requestId: string;
  goal: string;
  scope: string;
  deadline: string;
  state: string;
}

export interface CompilerColumn {
  state: string;
  cards: {
    id: string;
    intent: string;
    version: number;
    scopeRoles: string[];
    trustTier: string;
    trustGaps: string[];
    transfersPassed: number;
    transfersTotal: number;
  }[];
}

export interface RoomView {
  scope: string;
  health: 'healthy' | 'degraded' | 'idle';
  requests: {
    id: string;
    goal: string;
    state: string;
    messageClass: string;
    originScope: string;
    targetScope: string;
    updatedAt: string;
    evidence: { id: string; kind: string; tier: string; statement: string; status: string; provisional: boolean }[];
  }[];
}

export interface ConsoleReport {
  tenant: string;
  at: string;
  health: HealthReport;
  costCurve: CostPoint[];
  costTarget: number;
  tierMix: TierBucket[];
  needsHuman: HumanItem[];
  digestCount: number;
  compiler: CompilerColumn[];
  rooms: RoomView[];
  /** Approval latency (TODO 2.3): submission → human decision, from APPROVAL_LATENCY audit rows. */
  approvalLatency: ApprovalLatencyStats;
  /** Cost-per-signal (TODO 4.1): the expensive tier's share of routed arrivals vs the <1% gate. */
  costPerSignal: Awaited<ReturnType<CognitiveRouter['costPerSignal']>>;
}

const TERMINAL = ['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED'];

export async function buildReport(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  tenant: string,
  now: string,
  opts: { escalationCap?: number; humanMinutesBudget?: number; costTarget?: number } = {},
): Promise<ConsoleReport> {
  const stats = await ledger.stats(tenant, now);
  const facts = (stats.byKind['FACT'] ?? 0) + (stats.byKind['MEASUREMENT'] ?? 0);
  const pairs = await ledger.disputedPairs(tenant);

  // Oldest open contradiction, from the CONTRADICTION_OPEN audit trail.
  const audits = (await db
    .prepare("SELECT target, at FROM audit_log WHERE tenant = ? AND action = 'CONTRADICTION_OPEN' ORDER BY at")
    .all(tenant)) as { target: string; at: string }[];
  const openKeys = new Set(pairs.flatMap((p) => [`${p.a.id}<>${p.b.id}`, `${p.b.id}<>${p.a.id}`]));
  const openAts = audits.filter((a) => openKeys.has(String(a.target))).map((a) => Date.parse(String(a.at)));
  // Iterative minimum: the audit trail is history-sized and must never be
  // spread into an argument list (call-stack overflow past ~100k rows).
  let oldestOpenHours: number | null = null;
  if (openAts.length > 0) {
    let earliest = openAts[0]!;
    for (let i = 1; i < openAts.length; i++) {
      if (openAts[i]! < earliest) earliest = openAts[i]!;
    }
    oldestOpenHours = (Date.parse(now) - earliest) / 3_600_000;
  }

  const requests = await coord.list(tenant);
  const today = now.slice(0, 10);
  const todays = requests.filter((r) => r.createdAt.slice(0, 10) === today);
  const humanSpent = todays.reduce((s, r) => s + r.spent.humanMinutes, 0);
  const dollarsToday = todays.reduce((s, r) => s + r.spent.dollars, 0);
  const openHuman = requests.filter((r) => !TERMINAL.includes(r.state) && r.bid.humanMinutes > 0);

  // Cost curve: one point per decision with a measured outcome, in time order.
  const decisions = (await db
    .prepare('SELECT id, signed_at FROM decisions WHERE tenant = ? ORDER BY signed_at')
    .all(tenant)) as {
    id: string;
    signed_at: string;
  }[];
  const costCurve: CostPoint[] = [];
  // Downsample BEFORE costing: only the visible window pays for bulk
  // roll-ups, so a 500-decision tenant costs ~120 decisions, not history.
  const visibleIdx = downsampleIndices(decisions.length, COST_CURVE_BUDGET);
  const visibleDecisions = visibleIdx.map((i) => decisions[i]!);
  // One bulk roll-up for all decisions: per-decision costing here used to be
  // ~4 sequential queries each, making every dashboard GET history-sized.
  // Rates resolve per tenant (versioned in meta) — never code constants that
  // silently reprice history when they move.
  const rates = await getRates(db, tenant);
  const bulk = await costsOfDecisions(
    db,
    coord,
    ledger,
    tenant,
    visibleDecisions.map((d) => String(d.id)),
    rates,
  );
  for (const [vi, d] of visibleDecisions.entries()) {
    const origI = visibleIdx[vi]!;
    costCurve.push({
      at: String(d.signed_at),
      label: `D${origI + 1}`,
      costPerGoodDecision: bulk.get(String(d.id))?.costPerGoodDecision ?? null,
    });
  }

  // Tier mix: traces bucketed into 7-day windows from the earliest trace.
  const traces = (await db
    .prepare('SELECT tier, created_at FROM traces WHERE tenant = ? ORDER BY created_at')
    .all(tenant)) as {
    tier: string;
    created_at: string;
  }[];
  const tierMix: TierBucket[] = [];
  if (traces.length > 0) {
    const t0 = Date.parse(String(traces[0]!.created_at));
    const buckets: Record<string, number>[] = [];
    for (const t of traces) {
      const w = Math.floor((Date.parse(String(t.created_at)) - t0) / (7 * 86_400_000));
      const bucket = (buckets[w] ??= { REFLEX: 0, WORKFLOW: 0, MODEL: 0, HUMAN: 0 });
      const tier = String(t.tier);
      if (tier in bucket) bucket[tier] = (bucket[tier] ?? 0) + 1;
    }
    buckets.forEach((b, i) => {
      tierMix.push({
        label: `W${i + 1}`,
        REFLEX: b['REFLEX'] ?? 0,
        WORKFLOW: b['WORKFLOW'] ?? 0,
        MODEL: b['MODEL'] ?? 0,
        HUMAN: b['HUMAN'] ?? 0,
      });
    });
  }

  const needsHuman: HumanItem[] = openHuman.slice(0, MAX_NEEDS_HUMAN).map((r) => ({
    requestId: r.id,
    goal: r.goal,
    scope: r.targetScope,
    deadline: r.bid.deadline,
    state: r.state,
  }));

  const digestCount = requests.filter((r) => r.messageClass === 'NOTICE').length;

  const states: SkillState[] = ['CANDIDATE', 'QUARANTINE', 'SHADOW', 'BOUNDED_PILOT', 'PROMOTED', 'DEMOTED'];
  const compiler: CompilerColumn[] = [];
  for (const state of states) {
    const cards: CompilerColumn['cards'] = [];
    // Presentation read: drift signals are shown, never acted on — a
    // dashboard GET must not demote cards or append audit rows.
    for (const c of (await comp.list(tenant, { state })).slice(0, MAX_CARDS_PER_STATE)) {
      const desc = await describeCardReadOnly(db, comp, tenant, c.id);
      cards.push({
        id: c.id,
        intent: c.intent,
        version: c.version,
        scopeRoles: c.scopeRoles,
        trustTier: c.trustTier,
        trustGaps: desc.trustGaps,
        transfersPassed: desc.transfers.filter((t) => t.passed).length,
        transfersTotal: desc.transfers.length,
      });
    }
    compiler.push({ state, cards });
  }

  const scopes = [...new Set(requests.flatMap((r) => [r.originScope, r.targetScope]))];
  const rooms: RoomView[] = [];
  // Slice the room list BEFORE hydrating evidence: only the visible window
  // pays for ledger.get calls, so room count never drives evidence I/O.
  for (const scope of scopes.slice(0, MAX_ROOMS)) {
    const mine = requests.filter((r) => r.originScope === scope || r.targetScope === scope);
    const open = mine.filter((r) => !TERMINAL.includes(r.state)).length;
    const failed = mine.filter((r) => r.state === 'FAILED' || r.state === 'TERMINATED_BUDGET').length;
    let health: RoomView['health'] = 'healthy';
    if (open === 0 && mine.length > 0) health = 'idle';
    else if (failed > 0 || open > 3) health = 'degraded';
    const roomRequests: RoomView['requests'] = [];
    for (const r of mine.slice(-ROOM_REQUESTS)) {
      const evidence: RoomView['requests'][number]['evidence'] = [];
      for (const id of r.claimRefs) {
        const c = await ledger.get(tenant, id);
        if (c)
          evidence.push({
            id: c.id,
            kind: c.kind,
            tier: c.provenance.sourceTier,
            statement: c.statement,
            status: c.status,
            provisional: c.provisional,
          });
      }
      roomRequests.push({
        id: r.id,
        goal: r.goal,
        state: r.state,
        messageClass: r.messageClass,
        originScope: r.originScope,
        targetScope: r.targetScope,
        updatedAt: r.updatedAt,
        evidence,
      });
    }
    rooms.push({ scope, health, requests: roomRequests });
  }

  return {
    tenant,
    at: now,
    health: {
      staleFactRate: stats.staleFactRate,
      staleFactGate: 0.02,
      provenanceComplete: facts === 0 ? 1 : 1 - stats.factsWithoutGroundProvenance / facts,
      orphanClaims: stats.orphanClaims,
      contradictions: { open: pairs.length, oldestOpenHours, mttrHours: null, slaHours: 48 },
      spendToday: { dollars: dollarsToday },
      escalations: { open: openHuman.length, cap: opts.escalationCap ?? 3 },
      humanMinutes: { spentToday: humanSpent, budget: opts.humanMinutesBudget ?? 60 },
      refusalRate: (await coord.refusalStats(tenant)).rate,
    },
    costCurve,
    costTarget: opts.costTarget ?? 3.0,
    tierMix,
    needsHuman,
    digestCount,
    compiler,
    rooms,
    approvalLatency: await coord.approvalLatencyStats(tenant),
    // Cost-per-signal (TODO 4.1): the router is a passive read-model over
    // routing_decisions — no timers, no writes — so building a throwaway one
    // here is free and keeps every caller's report shape identical.
    costPerSignal: await new CognitiveRouter(db).costPerSignal(tenant),
  };
}
