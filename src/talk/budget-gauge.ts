import type { AsyncDb } from '../core/db.ts';
import { type BuzzSurface } from './buzz.ts';
import {
  roomForScope,
  normalizeScope,
  loadRoomConfig,
  loadTenantRooms,
  saveRoomConfig,
  type RoomConfig,
} from './rooms.ts';
import { STATUS_BADGES } from './health.ts';

export interface BudgetGasGauge {
  scope: string;
  roomName: string;
  dollarsSpent: number;
  dollarsCeiling: number;
  tokensSpent: number;
  tokensCeiling: number;
  tokensPerHour: number;
  percentage: number;
  bar: string;
  headerString: string;
  isWarning: boolean; // >= 80%
  isBreached: boolean; // >= 100%
}

export function renderProgressBar(percentage: number, totalBlocks = 8): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * totalBlocks);
  const empty = totalBlocks - filled;
  return `[${'■'.repeat(filled)}${'□'.repeat(empty)}]`;
}

export function formatTokenRate(rate: number): string {
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M tokens/hr`;
  if (rate >= 1_000) return `${Math.round(rate / 1_000)}k tokens/hr`;
  return `${rate} tokens/hr`;
}

export class RoomBudgetTracker {
  constructor(
    private readonly db: AsyncDb,
    private readonly tenant: string,
    private readonly surface?: BuzzSurface,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Computes the live gas gauge for a room */
  async computeGauge(rawScope: string): Promise<BudgetGasGauge> {
    const scope = normalizeScope(rawScope);
    const gauges = await this.computeGauges([scope]);
    // `computeGauges` answers every scope it was asked about, normalized.
    return gauges.get(scope)!;
  }

  /**
   * Live gas gauges for many rooms from two grouped reads.
   *
   * The roster drew one gauge per room, and each gauge was two aggregates plus a
   * config read of its own — so the page cost grew with the tenant's room count.
   * Grouping by scope makes the same numbers cost two statements in total. Rooms
   * with no spend have no row and report zero, which is what the per-room
   * aggregate returned for them.
   */
  async computeGauges(rawScopes: readonly string[]): Promise<Map<string, BudgetGasGauge>> {
    const scopes = [...new Set(rawScopes.map(normalizeScope))].filter(Boolean);
    const out = new Map<string, BudgetGasGauge>();
    if (scopes.length === 0) return out;

    const rooms = await loadTenantRooms(this.db, this.tenant);
    const at = this.now();
    const oneHourAgo = new Date(Date.parse(at) - 3600 * 1000).toISOString();
    const inList = scopes.map(() => '?').join(', ');

    // 1. All-time/month spend
    const spendRows = (await this.db
      .prepare(
        `SELECT target_scope AS scope,
                COALESCE(SUM(spent_dollars), 0) as dollars,
                COALESCE(SUM(spent_tokens), 0) as tokens
         FROM requests WHERE tenant = ? AND target_scope IN (${inList})
         GROUP BY target_scope`,
      )
      .all(this.tenant, ...scopes)) as { scope: string; dollars: number; tokens: number }[];

    // 2. Tokens in last 1 hour
    const rateRows = (await this.db
      .prepare(
        `SELECT target_scope AS scope, COALESCE(SUM(spent_tokens), 0) as hourlyTokens
         FROM requests WHERE tenant = ? AND target_scope IN (${inList}) AND created_at >= ?
         GROUP BY target_scope`,
      )
      .all(this.tenant, ...scopes, oneHourAgo)) as { scope: string; hourlyTokens: number }[];

    const spend = new Map(spendRows.map((r) => [r.scope, r]));
    const rate = new Map(rateRows.map((r) => [r.scope, Number(r.hourlyTokens ?? 0)]));

    for (const scope of scopes) {
      const entry = rooms.get(scope);
      // A scope the tenant has no room for still gauges against its defaults,
      // exactly as `loadRoomConfig` alone answered before.
      const config = entry?.config ?? (await loadRoomConfig(this.db, this.tenant, scope));
      const room = entry?.room ?? roomForScope(scope);
      const dollarsSpent = Number(spend.get(scope)?.dollars ?? 0);
      const tokensSpent = Number(spend.get(scope)?.tokens ?? 0);
      // Real throughput only. A quiet room reports 0 — inventing a floor
      // (the old 84k "realistic default") fabricated load that never ran
      // and would have made budget headroom look consumed when it was not.
      const tokensPerHour = Number(rate.get(scope) ?? 0);

      const dollarPct = config.budgetCeilingDollars > 0 ? (dollarsSpent / config.budgetCeilingDollars) * 100 : 0;
      const tokenPct = config.budgetCeilingTokens > 0 ? (tokensSpent / config.budgetCeilingTokens) * 100 : 0;
      const percentage = Math.round(Math.max(dollarPct, tokenPct));

      const isWarning = percentage >= 80;
      const isBreached = percentage >= 100;
      const bar = renderProgressBar(percentage, 8);

      let badge = STATUS_BADGES.healthy;
      if (isBreached) {
        badge = STATUS_BADGES.halted;
      } else if (isWarning) {
        badge = STATUS_BADGES.degraded;
      }
      const headerString = `${badge} #${room.name} ${bar} $${dollarsSpent.toFixed(0)} / $${config.budgetCeilingDollars.toFixed(0)} · ${formatTokenRate(tokensPerHour)}`;

      out.set(scope, {
        scope,
        roomName: room.name,
        dollarsSpent,
        dollarsCeiling: config.budgetCeilingDollars,
        tokensSpent,
        tokensCeiling: config.budgetCeilingTokens,
        tokensPerHour,
        percentage,
        bar,
        headerString,
        isWarning,
        isBreached,
      });
    }
    return out;
  }

  /**
   * Checks room budget and emits the 80% threshold warning if needed:
   * "Budget at 80%. Increase ceiling to $1,500 or switch non-critical queries to Flash/Haiku tier?"
   */
  async checkBudgetAlert(
    rawScope: string,
    opts: { threadRoot?: string; forceAlert?: boolean } = {},
  ): Promise<{ alerted: boolean; gauge: BudgetGasGauge; message?: string }> {
    const gauge = await this.computeGauge(rawScope);
    if (!gauge.isWarning && !opts.forceAlert) {
      return { alerted: false, gauge };
    }

    const alertKey = `budget:warned:${this.tenant}:${gauge.scope}`;
    const warnedRow = (await this.db.prepare('SELECT value FROM meta WHERE key = ?').get(alertKey)) as
      { value: string } | undefined;

    // Check if warned recently within last 24h
    if (warnedRow && !opts.forceAlert) {
      return { alerted: false, gauge };
    }

    const room = roomForScope(gauge.scope);
    const suggestedCeiling = Math.round(gauge.dollarsCeiling * 1.5);
    const message =
      `⚠️ **Budget at ${gauge.percentage}%** ($${gauge.dollarsSpent.toFixed(0)} / $${gauge.dollarsCeiling.toFixed(0)} · ${formatTokenRate(gauge.tokensPerHour)}).\n` +
      `Increase ceiling to **$${suggestedCeiling}** or switch non-critical queries to Flash/Haiku tier?\n` +
      `[ ⬆️ Increase Ceiling to $${suggestedCeiling} ] · [ ⚡ Switch to Flash/Haiku Tier ]`;

    // Record that we alerted
    await this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(alertKey, this.now());

    if (this.surface) {
      void this.surface
        .post({
          channel: room.channel,
          threadRoot: opts.threadRoot,
          requestId: `budget_warn_${gauge.scope}_${Date.now()}`,
          step: 1,
          tokens: 100,
          state: 'BUDGET_WARNING',
          text: message,
        })
        .catch(() => {});
    }

    return { alerted: true, gauge, message };
  }

  /** Operator action: Increase budget ceiling */
  async increaseCeiling(rawScope: string, newCeilingDollars: number, by = 'operator'): Promise<RoomConfig> {
    const scope = normalizeScope(rawScope);
    return saveRoomConfig(this.db, this.tenant, { scope, budgetCeilingDollars: newCeilingDollars }, by);
  }

  /** Operator action: Switch non-critical queries to Flash / Haiku tier */
  async switchModelTier(rawScope: string, tier: 'flash' | 'haiku', by = 'operator'): Promise<RoomConfig> {
    const scope = normalizeScope(rawScope);
    const modelPolicy = tier === 'haiku' ? 'Claude 3.5 Haiku / Bounded Cost' : 'Gemini 1.5 Flash / High Throughput';
    return saveRoomConfig(this.db, this.tenant, { scope, modelPolicy }, by);
  }
}
