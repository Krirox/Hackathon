import type { AsyncDb } from '../core/db.ts';
import { jsonNumber } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { listStops, type StopRecord } from '../gov/trust.ts';
import {
  normalizeScope,
  roomForScope,
  loadRoomConfig,
  loadTenantRooms,
  resolveRoomDef,
  categoryForScope,
  type RoomCategory,
  type TenantRoom,
} from './rooms.ts';
import { type BuzzSurface, type BuzzNostrEvent } from './buzz.ts';

export type RoomHealthStatus = 'healthy' | 'degraded' | 'halted' | 'idle';

export interface RoomHealthEvaluation {
  scope: string;
  channel: string;
  roomName: string;
  /** Sidebar group. Canonical rooms map via categoryForScope; customs carry their own. */
  category: RoomCategory;
  status: RoomHealthStatus;
  badge: string; // '🟢' | '🟡' | '🔴' | '⚪'
  reasons: string[];
  activeStops: number;
  driftingCards: number;
  pendingApprovals: number;
  spendDollars: number;
  spendCeilingDollars: number;
  spendTokens: number;
  spendCeilingTokens: number;
  budgetPercentage: number;
  contradictions: number;
  verifiedCalibrated: boolean;
  evaluatedAt: string;
}

export const STATUS_BADGES: Record<RoomHealthStatus, string> = {
  healthy: '🟢',
  degraded: '🟡',
  halted: '🔴',
  idle: '⚪',
};

/** Nostr Kind 30315: User / Room Status Event (NIP-315). */
export const BUZZ_STATUS_BEACON_KIND = 30315;

export interface HealthEvaluatorOptions {
  coord?: Coordinator;
  compiler?: OrganizationalCompiler;
  ledger?: Ledger;
  now?: () => string;
}

/** One room's budget rollup, read for every room in a single grouped query. */
interface SpendReading {
  dollars: number;
  tokens: number;
  totalRequests: number;
}

/** One room's trust row. The first row per scope wins, matching the single read. */
interface TrustReading {
  frozen: number;
  honeyMisses: number;
}

/**
 * Everything the composite status is built from, for a set of rooms.
 *
 * Every field is filled by a query that spans all the rooms at once: the health
 * of one room is never worth a round trip of its own. `evaluateAll` on a
 * thirteen-room tenant used to issue five statements per room per render, which
 * is how the shell's cost grew with the tenant instead of with the page.
 */
interface RoomReadings {
  stops: StopRecord[];
  spend: Map<string, SpendReading>;
  pending: Map<string, number>;
  contradictions: Map<string, number>;
  trust: Map<string, TrustReading>;
  drifting: Map<string, number>;
}

const EMPTY_READINGS: RoomReadings = {
  stops: [],
  spend: new Map(),
  pending: new Map(),
  contradictions: new Map(),
  trust: new Map(),
  drifting: new Map(),
};

export class ScopeHealthEvaluator {
  private readonly now: () => string;

  constructor(
    private readonly db: AsyncDb,
    private readonly tenant: string,
    private readonly opts: HealthEvaluatorOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async evaluateScope(rawScope: string): Promise<RoomHealthEvaluation> {
    const scope = normalizeScope(rawScope);
    const customDef = await resolveRoomDef(this.db, this.tenant, scope);
    const config = await loadRoomConfig(this.db, this.tenant, scope);
    const entry: TenantRoom = {
      config,
      room: customDef ?? roomForScope(scope),
      category: customDef?.category ?? categoryForScope(scope),
    };
    const readings = await this.readAll([scope]);
    return this.compose(scope, entry, readings, this.now());
  }

  /**
   * The tenant-wide reads behind every room's status, in one pass each.
   *
   * The scope list is built here rather than by the caller because a batched
   * query needs it: one grouped rollup answers every room, instead of one
   * aggregate query per room. `IN (…)` keeps the index usable and the result set
   * to the rooms actually being evaluated.
   */
  private async readAll(scopes: string[]): Promise<RoomReadings> {
    if (scopes.length === 0) return EMPTY_READINGS;
    const stops = await listStops(this.db, this.tenant);
    const inList = scopes.map(() => '?').join(', ');

    const spendRows = (await this.db
      .prepare(
        `SELECT target_scope AS scope,
                COALESCE(SUM(spent_dollars), 0) AS dollars,
                COALESCE(SUM(spent_tokens), 0) AS tokens,
                COUNT(*) AS totalRequests
         FROM requests WHERE tenant = ? AND target_scope IN (${inList})
         GROUP BY target_scope`,
      )
      .all(this.tenant, ...scopes)) as { scope: string; dollars: number; tokens: number; totalRequests: number }[];

    const pendingRows = (await this.db
      .prepare(
        `SELECT target_scope AS scope, COUNT(*) AS n FROM requests
         WHERE tenant = ? AND target_scope IN (${inList})
         AND state IN ('PROPOSED', 'ADMITTED')
         AND ${jsonNumber(this.db.engine, 'bid_json', 'humanMinutes')} > 0
         GROUP BY target_scope`,
      )
      .all(this.tenant, ...scopes)) as { scope: string; n: number }[];

    const contraRows = (await this.db
      .prepare(
        `SELECT c.scope AS scope, COUNT(*) AS n FROM claims c
         JOIN claim_links l ON c.id = l.from_id
         WHERE c.tenant = ? AND c.scope IN (${inList}) AND l.link = 'contradicts' AND c.status = 'ACCEPTED'
         GROUP BY c.scope`,
      )
      .all(this.tenant, ...scopes)) as { scope: string; n: number }[];

    // Ordered so "the first row" is the lowest action class, which is the row a
    // single-scope read returns today (the primary key orders scope, then class).
    const trustRows = (await this.db
      .prepare(
        `SELECT scope, frozen, honey_misses FROM trust_scores
         WHERE tenant = ? AND scope IN (${inList}) ORDER BY scope, action_class`,
      )
      .all(this.tenant, ...scopes)) as { scope: string; frozen: number; honey_misses: number }[];

    const spend = new Map<string, SpendReading>();
    for (const r of spendRows) {
      spend.set(r.scope, {
        dollars: Number(r.dollars ?? 0),
        tokens: Number(r.tokens ?? 0),
        totalRequests: Number(r.totalRequests ?? 0),
      });
    }
    const pending = new Map<string, number>(pendingRows.map((r) => [r.scope, Number(r.n ?? 0)]));
    const contradictions = new Map<string, number>(contraRows.map((r) => [r.scope, Number(r.n ?? 0)]));
    const trust = new Map<string, TrustReading>();
    for (const r of trustRows) {
      if (!trust.has(r.scope)) trust.set(r.scope, { frozen: Number(r.frozen), honeyMisses: Number(r.honey_misses) });
    }
    const drifting = await this.readDrift(scopes);

    return { stops, spend, pending, contradictions, trust, drifting };
  }

  /**
   * Drifting or demoted cards per scope. `list` is one read for the tenant — not
   * one per scope — and the per-card drift check stays per card, because that is
   * what the compiler's own API asks for.
   */
  private async readDrift(scopes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.opts.compiler) return out;
    try {
      const wanted = new Set(scopes);
      for (const card of await this.opts.compiler.list(this.tenant)) {
        if (!wanted.has(card.originScope)) continue;
        if (card.state === 'DEMOTED') {
          out.set(card.originScope, (out.get(card.originScope) ?? 0) + 1);
        } else if (card.state === 'PROMOTED') {
          const drift = await this.opts.compiler.checkDrift(this.tenant, card.id);
          if (drift.drifting) out.set(card.originScope, (out.get(card.originScope) ?? 0) + 1);
        }
      }
    } catch {
      // compiler check is best-effort
    }
    return out;
  }

  /**
   * One room's status from the readings already in hand. Pure, so the batched
   * and single-scope paths cannot disagree about what a reading means.
   */
  private compose(scope: string, entry: TenantRoom, readings: RoomReadings, at: string): RoomHealthEvaluation {
    const room = entry.room;
    const category: RoomCategory = entry.category;
    const config = entry.config;
    const reasons: string[] = [];

    // 1. Check if room is deactivated
    if (!config.active) {
      return {
        scope,
        channel: room.channel,
        roomName: room.name,
        category,
        status: 'idle',
        badge: STATUS_BADGES.idle,
        reasons: ['Room is currently disabled / dormant'],
        activeStops: 0,
        driftingCards: 0,
        pendingApprovals: 0,
        spendDollars: 0,
        spendCeilingDollars: config.budgetCeilingDollars,
        spendTokens: 0,
        spendCeilingTokens: config.budgetCeilingTokens,
        budgetPercentage: 0,
        contradictions: 0,
        verifiedCalibrated: config.verifiedCalibrated,
        evaluatedAt: at,
      };
    }

    // 2. Active stops check (governance kill switch)
    const matchingStops = readings.stops.filter((s) => s.scope === '*' || s.scope === scope);
    if (matchingStops.length > 0) {
      for (const stop of matchingStops) {
        reasons.push(`Active stop engaged: ${stop.scope}/${stop.actionClass}${stop.reason ? ` (${stop.reason})` : ''}`);
      }
    }

    // 3. Budget spend rollup
    const spendRow = readings.spend.get(scope);
    const spendDollars = Number(spendRow?.dollars ?? 0);
    const spendTokens = Number(spendRow?.tokens ?? 0);
    const totalRequests = Number(spendRow?.totalRequests ?? 0);
    const dollarPct = config.budgetCeilingDollars > 0 ? (spendDollars / config.budgetCeilingDollars) * 100 : 0;
    const tokenPct = config.budgetCeilingTokens > 0 ? (spendTokens / config.budgetCeilingTokens) * 100 : 0;
    const budgetPercentage = Math.round(Math.max(dollarPct, tokenPct));

    if (budgetPercentage >= 100) {
      reasons.push(
        `Budget ceiling breached: ${budgetPercentage}% consumed ($${spendDollars.toFixed(2)} / $${config.budgetCeilingDollars})`,
      );
    } else if (budgetPercentage >= 80) {
      reasons.push(`Budget warning threshold reached: ${budgetPercentage}% consumed`);
    }

    // 4. Pending approvals check
    const pendingApprovals = Number(readings.pending.get(scope) ?? 0);
    if (pendingApprovals > 0) {
      reasons.push(`${pendingApprovals} workflow request(s) awaiting human approval`);
    }

    // 5. Cognitive procedure drift check
    const driftingCards = Number(readings.drifting.get(scope) ?? 0);
    if (driftingCards > 0) {
      reasons.push(`${driftingCards} procedure card(s) in drift or demoted state`);
    }

    // 6. Contradictions check
    const contradictions = Number(readings.contradictions.get(scope) ?? 0);
    if (contradictions > 0) {
      reasons.push(`${contradictions} open epistemic contradiction(s) in scope`);
    }

    // 7. Trust freeze check
    const trustRow = readings.trust.get(scope);
    if (trustRow && Number(trustRow.frozen) === 1) {
      reasons.push(`Trust ledger is frozen (honey misses: ${trustRow.honeyMisses})`);
    }

    // Determine composite status
    let status: RoomHealthStatus = 'healthy';
    if (matchingStops.length > 0 || budgetPercentage >= 100) {
      status = 'halted';
    } else if (
      pendingApprovals > 0 ||
      driftingCards > 0 ||
      budgetPercentage >= 80 ||
      contradictions > 0 ||
      (trustRow && Number(trustRow.frozen) === 1)
    ) {
      status = 'degraded';
    } else if (totalRequests === 0 && (scope === 'experimental' || scope === 'sandbox')) {
      status = 'idle';
    }

    return {
      scope,
      channel: room.channel,
      roomName: room.name,
      category,
      status,
      badge: STATUS_BADGES[status],
      reasons,
      activeStops: matchingStops.length,
      driftingCards,
      pendingApprovals,
      spendDollars,
      spendCeilingDollars: config.budgetCeilingDollars,
      spendTokens,
      spendCeilingTokens: config.budgetCeilingTokens,
      budgetPercentage,
      contradictions,
      verifiedCalibrated: config.verifiedCalibrated,
      evaluatedAt: at,
    };
  }

  /**
   * Every room this tenant has, evaluated against one pass of tenant-wide
   * reads: six statements for the whole rollup, whatever the room count.
   */
  async evaluateAll(): Promise<RoomHealthEvaluation[]> {
    const rooms = await loadTenantRooms(this.db, this.tenant);
    const scopes = [...rooms.keys()];
    const readings = await this.readAll(scopes);
    const at = this.now();
    return scopes.map((scope) => this.compose(scope, rooms.get(scope)!, readings, at));
  }
}

/** Formats a one-line room status summary for status beacons and room headers. */
export function formatStatusBeacon(h: RoomHealthEvaluation): string {
  const badge = STATUS_BADGES[h.status];
  const calib = h.verifiedCalibrated ? ' [🟢 calibrated]' : '';
  const spend = `$${h.spendDollars.toFixed(0)} / $${h.spendCeilingDollars}`;
  const pending = h.pendingApprovals > 0 ? ` · ${h.pendingApprovals} review gate(s)` : '';
  const drift = h.driftingCards > 0 ? ` · ${h.driftingCards} drift alert(s)` : '';
  const reasonText = h.reasons.length > 0 && h.status !== 'healthy' ? ` [${h.reasons[0]}]` : '';
  return `${badge} #${h.roomName}${calib} [${h.status.toUpperCase()}] · ${spend} (${h.budgetPercentage}% quota)${pending}${drift}${reasonText}`;
}

/**
 * Publish a Kind 30315 status beacon — the event that drives a room's
 * 🟢/🟡/🔴 indicator in Buzz. Signing is the surface's job, so this takes no
 * signer: a caller cannot accidentally publish an unsigned or fake-signed
 * beacon.
 */
export async function publishRoomStatusBeacon(
  surface: BuzzSurface,
  evaluation: RoomHealthEvaluation,
  now: number | string = Math.floor(Date.now() / 1000),
  ..._rest: any[]
): Promise<BuzzNostrEvent> {
  const content = formatStatusBeacon(evaluation);
  const tags: string[][] = [
    ['d', 'room-status'],
    ['h', evaluation.channel],
    ['s', evaluation.scope],
    ['status', evaluation.status],
    ['badge', evaluation.badge],
    ['vital-health', evaluation.status, `${evaluation.budgetPercentage}%`, `${evaluation.pendingApprovals} pending`],
    ['vital-spend', String(evaluation.spendDollars), String(evaluation.spendCeilingDollars)],
  ];
  if (evaluation.verifiedCalibrated) {
    tags.push(['vital-calibrated', 'true']);
  }
  for (const reason of evaluation.reasons) {
    tags.push(['vital-reason', reason]);
  }

  // Publish the beacon as its own kind, not as chat text: `#h` addresses the
  // room's relay channel UUID, which the surface resolves.
  return surface.publish({
    kind: BUZZ_STATUS_BEACON_KIND,
    tags: [['d', `status:${evaluation.scope}`], ['published_at', String(now)], ...tags],
    content,
  });
}
