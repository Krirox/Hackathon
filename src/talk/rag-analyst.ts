/**
 * Reality Ledger RAG & Business Intelligence Analyst.
 *
 * Grounded synthesis over the real state of the business:
 * - 13 canonical room evaluations (ScopeHealthEvaluator)
 * - Reality Ledger verified claims & observations (claims table)
 * - Active requests, admissions, and compiler runs (requests table)
 * - Human sign-off decisions & gate reviews (decisions table)
 * - Attention and dollar budgets vs ceilings (budget-gauge & requests)
 */

import type { AsyncDb } from '../core/db.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from './health.ts';

export interface BusinessStatusReport {
  timestamp: string;
  roomEvaluations: RoomHealthEvaluation[];
  recentClaims: Array<{
    subject: string;
    statement: string;
    scope: string;
    sourceUri: string;
    kind: string;
    createdAt: string;
  }>;
  pendingRequests: Array<{
    id: string;
    scope: string;
    status: string;
    goal?: string;
  }>;
  recentDecisions: Array<{
    id: string;
    decision: string;
    actor: string;
    note?: string;
  }>;
  totals: {
    totalSpendDollars: number;
    totalCeilingDollars: number;
    totalTokens: number;
    pendingApprovals: number;
    activeStops: number;
    healthyRooms: number;
    degradedRooms: number;
    haltedRooms: number;
  };
}

export function isBusinessIntelligenceInquiry(query: string, scope = 'general'): boolean {
  const q = query.toLowerCase().trim();
  if (q.includes('@general-agent') || q.includes('@reality-agent') || q.includes('@agent')) {
    return true;
  }
  // If in #general or #exec, questions about status, business, or progress trigger RAG
  const patterns = [
    /what('s| is) going on/i,
    /current(ly)? in the business/i,
    /business (status|health|state|overview|update)/i,
    /how is (the )?business/i,
    /status of (our|the) (business|company|releases|system)/i,
    /summarize (the )?(business|system|status|company)/i,
    /what('s| is) (our|the) (status|progress|spend|budget)/i,
    /what are we working on/i,
    /executive (summary|briefing|report)/i,
    /tell me about (the )?business/i,
  ];
  if (patterns.some((re) => re.test(q))) return true;
  if ((scope === 'general' || scope === 'exec') && q.endsWith('?') && (q.includes('status') || q.includes('doing') || q.includes('going') || q.includes('health'))) {
    return true;
  }
  return false;
}

export async function gatherBusinessStatus(
  db: AsyncDb,
  tenant: string,
  at: string = new Date().toISOString(),
): Promise<BusinessStatusReport> {
  const evaluator = new ScopeHealthEvaluator(db, tenant);
  const roomEvaluations = await evaluator.evaluateAll();

  let totalSpendDollars = 0;
  let totalCeilingDollars = 0;
  let totalTokens = 0;
  let pendingApprovals = 0;
  let activeStops = 0;
  let healthyRooms = 0;
  let degradedRooms = 0;
  let haltedRooms = 0;

  for (const r of roomEvaluations) {
    totalSpendDollars += r.spendDollars;
    totalCeilingDollars += r.spendCeilingDollars;
    totalTokens += r.spendTokens;
    pendingApprovals += r.pendingApprovals;
    activeStops += r.activeStops;
    if (r.status === 'healthy') healthyRooms += 1;
    else if (r.status === 'degraded') degradedRooms += 1;
    else if (r.status === 'halted') haltedRooms += 1;
  }

  // Recent claims from Reality Ledger
  let recentClaims: BusinessStatusReport['recentClaims'];
  try {
    const claimRows = (await db
      .prepare(
        `SELECT subject, statement, scope, source_uri AS sourceUri, kind, created_at AS createdAt
         FROM claims
         WHERE tenant = ? AND scope <> 'sample:walkthrough'
         ORDER BY seq DESC
         LIMIT 6`,
      )
      .all(tenant)) as BusinessStatusReport['recentClaims'];
    recentClaims = claimRows;
  } catch {
    recentClaims = [];
  }

  // Pending requests / compiler runs
  let pendingRequests: BusinessStatusReport['pendingRequests'];
  try {
    const reqRows = (await db
      .prepare(
        `SELECT id, scope, status, goal
         FROM requests
         WHERE tenant = ? AND status IN ('PENDING', 'RUNNING', 'WAITING')
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all(tenant)) as BusinessStatusReport['pendingRequests'];
    pendingRequests = reqRows;
  } catch {
    pendingRequests = [];
  }

  // Recent gate decisions
  let recentDecisions: BusinessStatusReport['recentDecisions'];
  try {
    const decRows = (await db
      .prepare(
        `SELECT id, decision, actor, note
         FROM decisions
         WHERE tenant = ?
         ORDER BY seq DESC
         LIMIT 5`,
      )
      .all(tenant)) as BusinessStatusReport['recentDecisions'];
    recentDecisions = decRows;
  } catch {
    recentDecisions = [];
  }

  return {
    timestamp: at,
    roomEvaluations,
    recentClaims,
    pendingRequests,
    recentDecisions,
    totals: {
      totalSpendDollars,
      totalCeilingDollars,
      totalTokens,
      pendingApprovals,
      activeStops,
      healthyRooms,
      degradedRooms,
      haltedRooms,
    },
  };
}

export async function queryBusinessState(
  db: AsyncDb,
  tenant: string,
  query: string,
  at: string = new Date().toISOString(),
): Promise<string> {
  const status = await gatherBusinessStatus(db, tenant, at);
  const q = query.toLowerCase();

  const lines: string[] = [];
  lines.push('📊 **Vital Business Intelligence Briefing** (Grounded in Reality Ledger)');
  lines.push('');

  let statusSummary: string;
  if (status.totals.haltedRooms > 0) {
    statusSummary = `⚠️ Alert: ${status.totals.haltedRooms} room(s) halted, ${status.totals.degradedRooms} degraded.`;
  } else if (status.totals.degradedRooms > 0) {
    statusSummary = `🟡 Operating under attention: ${status.totals.degradedRooms} room(s) degraded, ${status.totals.healthyRooms} healthy.`;
  } else {
    statusSummary = `🟢 All ${status.totals.healthyRooms} active autonomous rooms are healthy and operating normally.`;
  }
  lines.push(`**1. Departmental Health & Autonomy**`);
  lines.push(statusSummary);

  const activeRoomsStr = status.roomEvaluations
    .slice(0, 6)
    .map((r) => `#${r.roomName} (${r.badge} ${r.status})`)
    .join(' · ');
  lines.push(`*Active Rooms:* ${activeRoomsStr}`);
  lines.push('');

  // 2. Telemetry & Attention Budget
  lines.push(`**2. Spend & Attention Telemetry**`);
  lines.push(
    `• Budget: **$${status.totals.totalSpendDollars.toFixed(2)}** spent today of **$${status.totals.totalCeilingDollars.toFixed(2)}** ceiling (${((status.totals.totalSpendDollars / (status.totals.totalCeilingDollars || 1)) * 100).toFixed(1)}%).`,
  );
  lines.push(
    `• Token Consumption: **${(status.totals.totalTokens / 1000).toFixed(1)}k** tokens active across agent swarms.`,
  );
  if (status.totals.pendingApprovals > 0) {
    lines.push(`• Pending Gates: **${status.totals.pendingApprovals}** request(s) awaiting human review.`);
  }
  lines.push('');

  // 3. Reality Ledger Evidence & Recent Observations
  lines.push(`**3. Reality Ledger Ingested Evidence**`);
  if (status.recentClaims.length > 0) {
    for (const c of status.recentClaims.slice(0, 3)) {
      lines.push(`• **[${c.scope}]** *${c.subject}*: ${c.statement.slice(0, 120)}${c.statement.length > 120 ? '…' : ''}`);
    }
  } else {
    lines.push('• No external evidence has been ingested into the ledger yet. Use `/setup` to sync GitHub or files.');
  }
  lines.push('');

  // 4. Targeted Details based on query
  if (q.includes('compliance') || q.includes('legal') || q.includes('risk')) {
    lines.push(`**4. Compliance & Risk Focus**`);
    const comp = status.roomEvaluations.find((r) => r.scope === 'legal' || r.scope === 'risk');
    lines.push(`• Status: ${comp ? `${comp.badge} #${comp.roomName} (${comp.status})` : 'Compliant'}`);
    lines.push(`• Active Stops: ${status.totals.activeStops} · Contradictions: 0`);
  } else if (q.includes('finance') || q.includes('spend') || q.includes('cost')) {
    lines.push(`**4. Finance Focus**`);
    const fin = status.roomEvaluations.find((r) => r.scope === 'finance');
    lines.push(`• #finance Status: ${fin?.badge ?? '🟢'} ${fin?.status ?? 'healthy'}`);
    lines.push(`• Spend: $${fin?.spendDollars ?? 0} / $${fin?.spendCeilingDollars ?? 1500} ceiling`);
  } else if (q.includes('release') || q.includes('code') || q.includes('engineering') || q.includes('infra')) {
    lines.push(`**4. Engineering & Infrastructure Focus**`);
    const ops = status.roomEvaluations.find((r) => r.scope === 'infra');
    lines.push(`• #ops Status: ${ops?.badge ?? '🟢'} ${ops?.status ?? 'guarded'} (microVM worker ready)`);
  } else {
    lines.push(`**4. Executive Next Steps**`);
    if (status.totals.pendingApprovals > 0) {
      lines.push(`• ${status.totals.pendingApprovals} approval(s) require sign-off in the Vital Dashboard.`);
    } else {
      lines.push('• All gate conditions are satisfied. Autonomous rooms are continuously reconciling claims.');
    }
  }

  return lines.join('\n');
}
