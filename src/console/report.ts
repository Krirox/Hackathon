import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler, SkillState } from '../compiler/compiler.ts';
import { describeCard } from '../compiler/registry.ts';
import { costOfDecision } from '../attrib/attribution.ts';

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
  const oldestOpenHours = openAts.length === 0 ? null : (Date.parse(now) - Math.min(...openAts)) / 3_600_000;

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
  for (const [i, d] of decisions.entries()) {
    let cost: number | null;
    try {
      cost = (
        await costOfDecision(db, coord, ledger, tenant, String(d.id), {
          dollarPerToken: 0.001,
          dollarPerHumanMinute: 1,
        })
      ).costPerGoodDecision;
    } catch {
      cost = null;
    }
    costCurve.push({ at: String(d.signed_at), label: `D${i + 1}`, costPerGoodDecision: cost });
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

  const needsHuman: HumanItem[] = openHuman.map((r) => ({
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
    for (const c of await comp.list(tenant, { state })) {
      const desc = await describeCard(comp, tenant, c.id);
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
  for (const scope of scopes) {
    const mine = requests.filter((r) => r.originScope === scope || r.targetScope === scope);
    const open = mine.filter((r) => !TERMINAL.includes(r.state)).length;
    const failed = mine.filter((r) => r.state === 'FAILED' || r.state === 'TERMINATED_BUDGET').length;
    let health: RoomView['health'] = 'healthy';
    if (open === 0 && mine.length > 0) health = 'idle';
    else if (failed > 0 || open > 3) health = 'degraded';
    const roomRequests: RoomView['requests'] = [];
    for (const r of mine.slice(-20)) {
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
  };
}
