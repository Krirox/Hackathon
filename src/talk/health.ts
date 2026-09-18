import type { AsyncDb } from '../core/db.ts';
import { jsonNumber } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { listStops } from '../gov/trust.ts';
import { normalizeScope, roomForScope, loadRoomConfig, type RoomConfig } from './rooms.ts';
import { type BuzzSurface, type BuzzNostrEvent } from './buzz.ts';

export type RoomHealthStatus = 'healthy' | 'degraded' | 'halted' | 'idle';

export interface RoomHealthEvaluation {
  scope: string;
  channel: string;
  roomName: string;
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
    const room = roomForScope(scope);
    const config = await loadRoomConfig(this.db, this.tenant, scope);
    const at = this.now();
    const reasons: string[] = [];

    // 1. Check if room is deactivated
    if (!config.active) {
      return {
        scope,
        channel: room.channel,
        roomName: room.name,
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
    const allStops = await listStops(this.db, this.tenant);
    const matchingStops = allStops.filter((s) => s.scope === '*' || s.scope === scope);
    if (matchingStops.length > 0) {
      for (const stop of matchingStops) {
        reasons.push(`Active stop engaged: ${stop.scope}/${stop.actionClass}${stop.reason ? ` (${stop.reason})` : ''}`);
      }
    }

    // 3. Budget spend rollup
    const spendRow = (await this.db
      .prepare(
        `SELECT COALESCE(SUM(spent_dollars), 0) as dollars,
                COALESCE(SUM(spent_tokens), 0) as tokens,
                COUNT(*) as totalRequests
         FROM requests WHERE tenant = ? AND target_scope = ?`,
      )
      .get(this.tenant, scope)) as { dollars: number; tokens: number; totalRequests: number } | undefined;

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
    let pendingApprovals = 0;
    const pRow = (await this.db
      .prepare(
        `SELECT COUNT(*) as n FROM requests
         WHERE tenant = ? AND target_scope = ? AND state IN ('PROPOSED', 'ADMITTED')
         AND ${jsonNumber(this.db.engine, 'bid_json', 'humanMinutes')} > 0`,
      )
      .get(this.tenant, scope)) as { n: number } | undefined;
    pendingApprovals = Number(pRow?.n ?? 0);
    if (pendingApprovals > 0) {
      reasons.push(`${pendingApprovals} workflow request(s) awaiting human approval`);
    }

    // 5. Cognitive procedure drift check
    let driftingCards = 0;
    if (this.opts.compiler) {
      try {
        const cards = await this.opts.compiler.list(this.tenant);
        const scoped = cards.filter((c) => c.originScope === scope);
        for (const card of scoped) {
          if (card.state === 'DEMOTED') {
            driftingCards += 1;
          } else if (card.state === 'PROMOTED') {
            const drift = await this.opts.compiler.checkDrift(this.tenant, card.id);
            if (drift.drifting) driftingCards += 1;
          }
        }
      } catch {
        // compiler check is best-effort
      }
    }
    if (driftingCards > 0) {
      reasons.push(`${driftingCards} procedure card(s) in drift or demoted state`);
    }

    // 6. Contradictions check
    let contradictions = 0;
    const contraRow = (await this.db
      .prepare(
        `SELECT COUNT(*) as n FROM claims c
         JOIN claim_links l ON c.id = l.from_id
         WHERE c.tenant = ? AND c.scope = ? AND l.link = 'contradicts' AND c.status = 'ACCEPTED'`,
      )
      .get(this.tenant, scope)) as { n: number } | undefined;
    contradictions = Number(contraRow?.n ?? 0);
    if (contradictions > 0) {
      reasons.push(`${contradictions} open epistemic contradiction(s) in scope`);
    }

    // 7. Trust freeze check
    const trustRow = (await this.db
      .prepare(`SELECT frozen, honey_misses FROM trust_scores WHERE tenant = ? AND scope = ?`)
      .get(this.tenant, scope)) as { frozen: number; honey_misses: number } | undefined;
    if (trustRow && Number(trustRow.frozen) === 1) {
      reasons.push(`Trust ledger is frozen (honey misses: ${trustRow.honey_misses})`);
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

  async evaluateAll(): Promise<RoomHealthEvaluation[]> {
    const results: RoomHealthEvaluation[] = [];
    const configs = (await this.db
      .prepare(`SELECT key FROM meta WHERE key LIKE 'room:config:${this.tenant}:%'`)
      .all()) as { key: string }[];

    // Ensure all 12 canonical scopes are evaluated
    const scopesToEval = new Set<string>();
    for (const r of roomForScope('core').channel
      ? [
          'core',
          'facts',
          'research',
          'risk',
          'product',
          'legal',
          'finance',
          'infra',
          'business',
          'data',
          'exec',
          'experimental',
        ]
      : []) {
      scopesToEval.add(r);
    }
    for (const r of configs) {
      const parts = r.key.split(':');
      if (parts[3]) scopesToEval.add(parts[3]);
    }

    for (const s of scopesToEval) {
      results.push(await this.evaluateScope(s));
    }
    return results;
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
