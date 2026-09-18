import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { setKill, recoverStop } from '../gov/trust.ts';
import { normalizeScope, roomForScope, loadRoomConfig, saveRoomConfig, type RoomConfig } from './rooms.ts';
import { ScopeHealthEvaluator, formatStatusBeacon } from './health.ts';

export interface CommandContext {
  db: AsyncDb;
  tenant: string;
  actor: string;
  currentScope?: string;
  coord?: Coordinator;
  ledger?: Ledger;
  evaluator?: ScopeHealthEvaluator;
  now?: string;
}

export interface CommandResult {
  handled: boolean;
  command: string;
  output: string;
  error?: string;
  scope?: string;
  actionTaken?: string;
}

export function isRoomCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

export async function executeRoomCommand(rawText: string, ctx: CommandContext): Promise<CommandResult> {
  const text = rawText.trim();
  if (!text.startsWith('/')) {
    return { handled: false, command: '', output: '' };
  }

  const parts = text.slice(1).split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);
  const at = ctx.now ?? new Date().toISOString();

  // Helper to extract named parameters e.g. reason="..." or model=...
  const parseParams = (tokens: string[]): { positional: string[]; named: Record<string, string> } => {
    const positional: string[] = [];
    const named: Record<string, string> = {};
    const joined = tokens.join(' ');
    // Match key="value" or key=value
    const regex = /(\b[a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let match: RegExpExecArray | null;
    const matchedIndices = new Set<number>();
    while ((match = regex.exec(joined)) !== null) {
      const key = match[1]!;
      const val = match[2] ?? match[3] ?? match[4] ?? '';
      named[key.toLowerCase()] = val;
    }
    // Positional are non-param tokens
    for (const tok of tokens) {
      if (!tok.includes('=')) {
        positional.push(tok.replace(/^["']|["']$/g, ''));
      }
    }
    return { positional, named };
  };

  const { positional, named } = parseParams(args);

  // 1. /halt <scope> [reason="..."]
  if (cmd === 'halt') {
    const rawTarget = positional[0] ?? named.scope ?? ctx.currentScope ?? '*';
    const scope = rawTarget === '*' ? '*' : normalizeScope(rawTarget);
    const reason = named.reason ?? (positional.slice(1).join(' ') || 'Emergency halt initiated via Buzz slash command');

    await setKill(ctx.db, ctx.tenant, { scope, actionClass: '*' }, ctx.actor, at, { reason });

    const roomLabel = scope === '*' ? 'ALL ROOMS' : `#${roomForScope(scope).name}`;
    return {
      handled: true,
      command: 'halt',
      scope,
      actionTaken: 'KILL_ENGAGED',
      output: `🔴 **EMERGENCY HALT ENGAGED** for **${roomLabel}**.\n- Reason: "${reason}"\n- Engaged by: @${ctx.actor}\n- Authorizations stopped. In-flight work held. Use \`/recover ${scope}\` to resume.`,
    };
  }

  // 2. /recover <scope> [reason="..."]
  if (cmd === 'recover') {
    const rawTarget = positional[0] ?? named.scope ?? ctx.currentScope;
    if (!rawTarget) {
      return {
        handled: true,
        command: 'recover',
        output: '⚠️ Missing target scope. Usage: `/recover <scope> reason="explanation of recovery"`',
        error: 'MISSING_SCOPE',
      };
    }
    const scope = rawTarget === '*' ? '*' : normalizeScope(rawTarget);
    const reason = named.reason ?? (positional.slice(1).join(' ') || 'Operator verified recovery conditions met');

    try {
      await recoverStop(ctx.db, ctx.tenant, { scope, actionClass: '*' }, ctx.actor, {
        reason,
        now: at,
      });
      const roomLabel = scope === '*' ? 'ALL ROOMS' : `#${roomForScope(scope).name}`;
      return {
        handled: true,
        command: 'recover',
        scope,
        actionTaken: 'KILL_RECOVERED',
        output: `🟢 **RECOVERY COMPLETED** for **${roomLabel}**.\n- Reason: "${reason}"\n- Cleared by: @${ctx.actor}\n- Normal autonomous dispatch resumed.`,
      };
    } catch (e) {
      return {
        handled: true,
        command: 'recover',
        scope,
        output: `⚠️ Recovery failed: ${(e as Error).message}`,
        error: (e as Error).message,
      };
    }
  }

  // 3. /status [scope]
  if (cmd === 'status') {
    const evaluator =
      ctx.evaluator ?? new ScopeHealthEvaluator(ctx.db, ctx.tenant, { coord: ctx.coord, ledger: ctx.ledger });
    const rawTarget = positional[0] ?? named.scope ?? ctx.currentScope;
    if (rawTarget && rawTarget !== 'all') {
      const scope = normalizeScope(rawTarget);
      const evalResult = await evaluator.evaluateScope(scope);
      const lines = [
        `**Room Health Telemetry**: ${formatStatusBeacon(evalResult)}`,
        `- **Autonomy**: \`${evalResult.status.toUpperCase()}\``,
        `- **Spend**: $${evalResult.spendDollars.toFixed(2)} / $${evalResult.spendCeilingDollars} (${evalResult.budgetPercentage}%)`,
        `- **Pending Reviews**: ${evalResult.pendingApprovals}`,
        `- **Drifting Procedures**: ${evalResult.driftingCards}`,
        `- **Contradictions**: ${evalResult.contradictions}`,
      ];
      if (evalResult.reasons.length > 0) {
        lines.push(`- **Active Alerts**: ${evalResult.reasons.join('; ')}`);
      }
      return {
        handled: true,
        command: 'status',
        scope,
        output: lines.join('\n'),
      };
    }

    const all = await evaluator.evaluateAll();
    const lines = ['**Workspace Room Health Roster**:'];
    for (const h of all) {
      lines.push(formatStatusBeacon(h));
    }
    return {
      handled: true,
      command: 'status',
      output: lines.join('\n'),
    };
  }

  // 4. /cost [scope]
  if (cmd === 'cost') {
    const rawTarget = positional[0] ?? named.scope ?? ctx.currentScope;
    if (rawTarget && rawTarget !== 'all') {
      const scope = normalizeScope(rawTarget);
      const config = await loadRoomConfig(ctx.db, ctx.tenant, scope);
      const row = (await ctx.db
        .prepare(
          `SELECT COALESCE(SUM(spent_dollars), 0) as dollars,
                  COALESCE(SUM(spent_tokens), 0) as tokens,
                  COUNT(*) as total
           FROM requests WHERE tenant = ? AND target_scope = ?`,
        )
        .get(ctx.tenant, scope)) as { dollars: number; tokens: number; total: number } | undefined;

      const dollars = Number(row?.dollars ?? 0);
      const tokens = Number(row?.tokens ?? 0);
      const pct = config.budgetCeilingDollars > 0 ? (dollars / config.budgetCeilingDollars) * 100 : 0;
      const headroom = Math.max(0, config.budgetCeilingDollars - dollars);

      return {
        handled: true,
        command: 'cost',
        scope,
        output: [
          `📊 **Spend & Gas Gauge for #${roomForScope(scope).name}**:`,
          `- **Monthly Spend**: $${dollars.toFixed(2)} / $${config.budgetCeilingDollars.toFixed(2)} (${pct.toFixed(1)}%)`,
          `- **Tokens Consumed**: ${tokens.toLocaleString()} / ${config.budgetCeilingTokens.toLocaleString()}`,
          `- **Available Headroom**: $${headroom.toFixed(2)}`,
          `- **Total Requests**: ${row?.total ?? 0}`,
        ].join('\n'),
      };
    }

    const rows = (await ctx.db
      .prepare(
        `SELECT target_scope,
                COALESCE(SUM(spent_dollars), 0) as dollars,
                COALESCE(SUM(spent_tokens), 0) as tokens
         FROM requests WHERE tenant = ? GROUP BY target_scope`,
      )
      .all(ctx.tenant)) as { target_scope: string; dollars: number; tokens: number }[];

    const lines = ['📊 **Overall Workspace Spend by Room**:'];
    let totalDollars = 0;
    let totalTokens = 0;
    for (const r of rows) {
      const d = Number(r.dollars);
      const t = Number(r.tokens);
      totalDollars += d;
      totalTokens += t;
      lines.push(`- **#${r.target_scope}**: $${d.toFixed(2)} · ${t.toLocaleString()} tokens`);
    }
    lines.push(`**Total Spend**: $${totalDollars.toFixed(2)} · ${totalTokens.toLocaleString()} tokens`);
    return {
      handled: true,
      command: 'cost',
      output: lines.join('\n'),
    };
  }

  // 5. /policy set <key>=<value> or /policy get [key]
  if (cmd === 'policy') {
    const sub = (positional[0] ?? '').toLowerCase();
    const scope = normalizeScope(named.scope ?? positional[1] ?? ctx.currentScope ?? 'core');
    const config = await loadRoomConfig(ctx.db, ctx.tenant, scope);

    if (sub === 'set') {
      const updates: Partial<RoomConfig> = {};
      if (named.autonomy) {
        const a = named.autonomy.toLowerCase();
        if (['autonomous', 'guarded', 'supervised'].includes(a)) {
          updates.autonomy = a as RoomConfig['autonomy'];
        }
      }
      if (named.spend_limit || named.budget || named.dollars) {
        const val = Number(named.spend_limit ?? named.budget ?? named.dollars);
        if (val > 0) updates.budgetCeilingDollars = val;
      }
      if (named.tokens) {
        const val = Number(named.tokens);
        if (val > 0) updates.budgetCeilingTokens = val;
      }
      if (named.mission) {
        updates.mission = named.mission;
      }
      if (named.sor || named.sors) {
        const raw = named.sor ?? named.sors ?? '';
        updates.connectedSoRs = raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }

      if (Object.keys(updates).length === 0) {
        return {
          handled: true,
          command: 'policy',
          scope,
          output: '⚠️ No valid policy settings provided. Example: `/policy set autonomy=guarded spend_limit=500`',
        };
      }

      const saved = await saveRoomConfig(ctx.db, ctx.tenant, { scope, ...updates }, ctx.actor);
      return {
        handled: true,
        command: 'policy',
        scope,
        actionTaken: 'POLICY_MUTATE',
        output: [
          `🛡️ **Updated Policy for #${saved.name}** (audited):`,
          `- **Autonomy**: \`${saved.autonomy}\``,
          `- **Budget Ceiling**: $${saved.budgetCeilingDollars} · ${saved.budgetCeilingTokens.toLocaleString()} tokens`,
          `- **Mission**: "${saved.mission}"`,
          `- **Connected SoRs**: ${saved.connectedSoRs.join(', ') || 'none'}`,
        ].join('\n'),
      };
    }

    // Default get policy
    return {
      handled: true,
      command: 'policy',
      scope,
      output: [
        `🛡️ **Current Policy for #${config.name}**:`,
        `- **Autonomy**: \`${config.autonomy}\``,
        `- **Budget Ceiling**: $${config.budgetCeilingDollars} (${config.budgetCeilingTokens.toLocaleString()} tokens)`,
        `- **Mission**: "${config.mission}"`,
        `- **Connected SoR**: ${config.connectedSoRs.join(', ')}`,
      ].join('\n'),
    };
  }

  // ----------------------------------------------------------- /compiler
  if (cmd === 'compiler') {
    const scope = ctx.currentScope ?? 'core';
    const cardQuery = args[0];
    return {
      handled: true,
      command: 'compiler',
      scope,
      output: `📊 **Compiler Pipeline**: Opening compiler drawer${cardQuery ? ` for \`${cardQuery}\`` : ''}... View status at \`/console/compiler\`.`,
    };
  }

  // ----------------------------------------------------------- /ledger
  if (cmd === 'ledger') {
    const scope = ctx.currentScope ?? 'core';
    const q = args.join(' ');
    let count = 0;
    if (ctx.ledger && q) {
      try {
        const found = await ctx.ledger.search(ctx.tenant, { q, limit: 5 });
        count = found.length;
      } catch {}
    }
    return {
      handled: true,
      command: 'ledger',
      scope,
      output: `📜 **Ledger Search**: Found ${count} claim(s) matching "${q}". Opening ledger drawer...`,
    };
  }

  // ----------------------------------------------------------- /requests
  if (cmd === 'requests') {
    const scope = ctx.currentScope ?? 'core';
    let pendingCount = 0;
    if (ctx.coord) {
      try {
        const list = await ctx.coord.list(ctx.tenant, { state: 'ADMITTED' });
        pendingCount = list.filter((r) => r.bid.humanMinutes > 0).length;
      } catch {}
    }
    return {
      handled: true,
      command: 'requests',
      scope,
      output: `📋 **Pending Reviews**: ${pendingCount} request(s) awaiting human approval. Opening reviews drawer...`,
    };
  }

  return {
    handled: false,
    command: cmd,
    output: `Unknown command: /${cmd}`,
  };
}
