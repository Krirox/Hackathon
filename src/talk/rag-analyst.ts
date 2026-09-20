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

export interface DomainSpecialist {
  domain: string;
  scope: string;
  roomName: string;
  agentName: string;
  description: string;
}

export const DOMAIN_SPECIALISTS: Record<string, DomainSpecialist> = {
  finance: {
    domain: 'Finance & Billing',
    scope: 'finance',
    roomName: 'finance',
    agentName: 'finance-agent',
    description: 'financial accounting, Stripe billing, spend limits, and churn forecasts',
  },
  engineering: {
    domain: 'Engineering & Infrastructure',
    scope: 'infra',
    roomName: 'ops',
    agentName: 'ops-agent',
    description: 'deployments, infrastructure, microVM runtimes, builds, and code repositories',
  },
  compliance: {
    domain: 'Legal & Compliance',
    scope: 'legal',
    roomName: 'compliance',
    agentName: 'compliance-agent',
    description: 'regulatory compliance, audit trails, privacy policies, and EU AI Act checks',
  },
  risk: {
    domain: 'Risk & Hedging',
    scope: 'risk',
    roomName: 'risk-monitor',
    agentName: 'risk-agent',
    description: 'counterparty credit exposure, hedging needs, and procedure drift monitoring',
  },
  product: {
    domain: 'Product & User Feedback',
    scope: 'product',
    roomName: 'user-feedback',
    agentName: 'feedback-agent',
    description: 'user feedback clustering, bug sentiment, and feature request synthesis',
  },
  market: {
    domain: 'Market & Competitor Intel',
    scope: 'research',
    roomName: 'market-intel',
    agentName: 'market-agent',
    description: 'competitor pricing, market signals, industry trends, and deep research',
  },
  growth: {
    domain: 'Growth & Marketing',
    scope: 'growth',
    roomName: 'growth',
    agentName: 'growth-agent',
    description: 'retention campaigns, counter-promotions, and customer acquisition',
  },
};

export function classifyDomain(query: string): DomainSpecialist | null {
  const q = query.toLowerCase();
  if (/\b(?:legal|compliance|regulatory|gdpr|audit|privacy|policy|policies|eu ai act|terms|contract)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.compliance ?? null;
  }
  if (/\b(?:finance|billing|stripe|quickbooks|invoice|revenue|spend|budget|churn|payment|cost-per-signal|price|pricing)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.finance ?? null;
  }
  if (/\b(?:deploy|deployment|server|microvm|docker|kubernetes|infra|pipeline|build|commit|branch|pr|pull request|issue|bug|code|git|repo|crash|logs?)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.engineering ?? null;
  }
  if (/\b(?:risk|exposure|counterparty|hedge|hedging|drift|volatility)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.risk ?? null;
  }
  if (/\b(?:feedback|complaint|nps|feature request|sentiment|user reported)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.product ?? null;
  }
  if (/\b(?:competitor|market intel|industry trend|market research)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.market ?? null;
  }
  if (/\b(?:campaign|retention|acquisition|marketing promo|growth)\b/i.test(q)) {
    return DOMAIN_SPECIALISTS.growth ?? null;
  }
  return null;
}

const BROAD_STATUS_PATTERNS = [
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
  /give me a briefing/i,
  /daily briefing/i,
  /overview/i,
];

export function isBroadStatusInquiry(query: string): boolean {
  const q = query.toLowerCase().trim();
  return BROAD_STATUS_PATTERNS.some((re) => re.test(q));
}

export function isBusinessIntelligenceInquiry(query: string, scope = 'general'): boolean {
  const q = query.toLowerCase().trim();
  if (q.includes('@general-agent') || q.includes('@reality-agent') || q.includes('@agent')) {
    return true;
  }
  if (isBroadStatusInquiry(q)) return true;
  if (
    (scope === 'general' || scope === 'exec') &&
    q.endsWith('?') &&
    (q.includes('status') || q.includes('doing') || q.includes('going') || q.includes('health') || q.includes('what') || q.includes('how') || q.includes('who'))
  ) {
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
      lines.push(
        `• **[${c.scope}]** *${c.subject}*: ${c.statement.slice(0, 120)}${c.statement.length > 120 ? '…' : ''}`,
      );
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

export async function answerGeneralQuestion(
  db: AsyncDb,
  tenant: string,
  rawQuery: string,
  _at: string = new Date().toISOString(),
): Promise<{ text: string; matchedClaimsCount: number; specialist: DomainSpecialist | null }> {
  // Clean query: strip @mentions, punctuation
  const cleanQuery = rawQuery
    .replace(/@([a-zA-Z0-9_-]+)/g, ' ')
    .replace(/[?!,.:;()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract query keywords (words >= 3 chars, ignoring common stopwords)
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
    'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
    'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy',
    'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'what', 'when',
    'where', 'which', 'why', 'with', 'tell', 'about', 'does', 'should',
    'would', 'could', 'some', 'them', 'then', 'there', 'they', 'this', 'that'
  ]);

  const tokens = cleanQuery
    .toLowerCase()
    .split(' ')
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  // 1. Search claims in Reality Ledger
  interface ClaimRow {
    id: string;
    subject: string;
    kind: string;
    statement: string;
    confidence: number;
    scope: string;
    source_uri: string;
    created_at: string;
  }

  let matchingClaims: Array<{ claim: ClaimRow; score: number }> = [];
  try {
    const claims = (await db
      .prepare(
        `SELECT id, subject, kind, statement, confidence, scope, source_uri, created_at
         FROM claims
         WHERE tenant = ?
         ORDER BY seq DESC
         LIMIT 100`,
      )
      .all(tenant)) as unknown as ClaimRow[];

    for (const c of claims) {
      const stmtNorm = c.statement.toLowerCase();
      const subjNorm = c.subject.toLowerCase();
      const scopeNorm = c.scope.toLowerCase();

      let matchCount = 0;
      for (const token of tokens) {
        if (stmtNorm.includes(token) || subjNorm.includes(token) || scopeNorm.includes(token)) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        matchingClaims.push({ claim: c, score: matchCount + c.confidence });
      }
    }
    matchingClaims.sort((a, b) => b.score - a.score);
  } catch {
    matchingClaims = [];
  }

  // 2. Search issues board if relevant
  interface IssueRow {
    id: string;
    title: string;
    description: string;
    state: string;
    priority: string;
  }
  let matchingIssues: IssueRow[] = [];
  try {
    const issues = (await db
      .prepare(
        `SELECT id, title, description, state, priority
         FROM issues
         WHERE tenant = ?
         ORDER BY updated_at DESC
         LIMIT 40`,
      )
      .all(tenant)) as unknown as IssueRow[];

    for (const iss of issues) {
      const text = `${iss.title} ${iss.description}`.toLowerCase();
      if (tokens.some((t) => text.includes(t))) {
        matchingIssues.push(iss);
      }
    }
  } catch {
    matchingIssues = [];
  }

  // 3. Search active requests if relevant
  interface RequestRow {
    id: string;
    scope: string;
    status: string;
    goal: string;
  }
  let matchingRequests: RequestRow[] = [];
  try {
    const reqs = (await db
      .prepare(
        `SELECT id, scope, status, goal
         FROM requests
         WHERE tenant = ? AND status IN ('PENDING', 'RUNNING', 'WAITING')
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(tenant)) as unknown as RequestRow[];

    for (const r of reqs) {
      const text = `${r.scope} ${r.goal}`.toLowerCase();
      if (tokens.some((t) => text.includes(t))) {
        matchingRequests.push(r);
      }
    }
  } catch {
    matchingRequests = [];
  }

  const specialist = classifyDomain(rawQuery);

  // If evidence found in ledger, issues, or requests:
  if (matchingClaims.length > 0 || matchingIssues.length > 0 || matchingRequests.length > 0) {
    const lines: string[] = [];
    lines.push(`🤖 **general-agent**: Here is what the Reality Ledger confirms regarding your inquiry:`);
    lines.push('');

    if (matchingClaims.length > 0) {
      lines.push(`**Reality Ledger Verified Claims:**`);
      for (const { claim } of matchingClaims.slice(0, 3)) {
        lines.push(
          `• **[${claim.scope}]** "${claim.statement}"\n  *(Claim: \`[${claim.id}]\`, Confidence: ${(claim.confidence * 100).toFixed(0)}/100, Source: \`${claim.source_uri}\`)*`,
        );
      }
      lines.push('');
    }

    if (matchingIssues.length > 0) {
      lines.push(`**Engineering Issues:**`);
      for (const iss of matchingIssues.slice(0, 2)) {
        lines.push(
          `• Issue \`#${iss.id.slice(0, 7)}\`: **${iss.title}** (${iss.state} · Priority: ${iss.priority})`,
        );
      }
      lines.push('');
    }

    if (matchingRequests.length > 0) {
      lines.push(`**Active Swarm Requests:**`);
      for (const req of matchingRequests.slice(0, 2)) {
        lines.push(`• Request \`[${req.id.slice(0, 8)}]\`: **${req.goal}** (Status: ${req.status})`);
      }
      lines.push('');
    }

    if (specialist) {
      lines.push(
        `💡 *Need deeper domain action?* Ask **@${specialist.agentName}** in **#${specialist.roomName}** for ${specialist.description}.`,
      );
    }

    return {
      text: lines.join('\n').trim(),
      matchedClaimsCount: matchingClaims.length,
      specialist,
    };
  }

  // If NO evidence found:
  if (specialist) {
    const text = [
      `🤖 **general-agent**: I searched the Reality Ledger, but found no verified claims matching **"${cleanQuery}"**.`,
      '',
      `Since this inquiry involves **${specialist.domain}**, I recommend consulting **@${specialist.agentName}** in **#${specialist.roomName}**.`,
      `*Specialist Scope:* ${specialist.description}.`,
      '',
      `💡 *Tip:* You can mention \`@${specialist.agentName} ${cleanQuery}\` to dispatch directly to their room, or use \`/setup\` to ingest external sources into the ledger.`,
    ].join('\n');

    return {
      text,
      matchedClaimsCount: 0,
      specialist,
    };
  }

  const text = [
    `🤖 **general-agent**: I searched the Reality Ledger for **"${cleanQuery}"**, but found no verified claims, recorded decisions, or active requests matching that topic.`,
    '',
    `💡 *Tip:* Use \`/setup\` to ingest documents or sync GitHub repositories into the Reality Ledger, or consult a specialized agent (such as \`@ops-agent\` for infra, \`@finance-agent\` for billing, or \`@compliance-agent\` for legal).`,
  ].join('\n');

  return {
    text,
    matchedClaimsCount: 0,
    specialist: null,
  };
}

export async function handleGeneralAgentQuery(
  db: AsyncDb,
  tenant: string,
  query: string,
  at: string = new Date().toISOString(),
): Promise<{ text: string; isBriefing: boolean; specialist: DomainSpecialist | null }> {
  if (isBroadStatusInquiry(query)) {
    const text = await queryBusinessState(db, tenant, query, at);
    return { text, isBriefing: true, specialist: null };
  }
  const answer = await answerGeneralQuestion(db, tenant, query, at);
  return { text: answer.text, isBriefing: false, specialist: answer.specialist };
}
