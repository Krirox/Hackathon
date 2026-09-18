import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { BuzzSigner } from './buzz.ts';

export type RoomAutonomy = 'autonomous' | 'guarded' | 'supervised';

export interface CanonicalRoomDefinition {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly channel: string;
  readonly agentName: string;
  readonly duties: string;
  readonly triggers: string;
  readonly healthMetric: string;
  readonly defaultMission: string;
  readonly defaultAutonomy: RoomAutonomy;
  readonly defaultBudgetDollars: number;
  readonly defaultBudgetTokens: number;
  readonly defaultSoRs: readonly string[];
  readonly recommendedModel: string;
}

export const CANONICAL_ROOMS: readonly CanonicalRoomDefinition[] = [
  {
    id: 'reality-core',
    name: 'reality-core',
    scope: 'core',
    channel: 'chan-reality-core',
    agentName: 'reality-agent',
    duties: 'Ingests canonical truth; maintains epistemic consistency; deduplicates claims.',
    triggers: 'Resolving unsolvable logical contradictions; model schema upgrades.',
    healthMetric: 'Epistemic contradiction rate < 0.1%',
    defaultMission: 'Ingest canonical truth, maintain epistemic consistency, deduplicate claims, and reconcile contradictions.',
    defaultAutonomy: 'guarded',
    defaultBudgetDollars: 2000,
    defaultBudgetTokens: 10_000_000,
    defaultSoRs: ['warehouse', 'github', 'files'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'fact-check',
    name: 'fact-check',
    scope: 'facts',
    channel: 'chan-fact-check',
    agentName: 'fact-agent',
    duties: 'Real-time assertion verification against system-of-record (SoR); cross-source triangulation.',
    triggers: 'Disputed assertions with confidence scores < 0.70; stale ground truth.',
    healthMetric: 'Unverified claim queue depth <= 5',
    defaultMission: 'Verify assertions in real time against system-of-record sources and triangulate evidence.',
    defaultAutonomy: 'autonomous',
    defaultBudgetDollars: 1000,
    defaultBudgetTokens: 5_000_000,
    defaultSoRs: ['warehouse', 'bloomberg', 'sec_edgar'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Flash',
  },
  {
    id: 'market-intel',
    name: 'market-intel',
    scope: 'research',
    channel: 'chan-market-intel',
    agentName: 'market-agent',
    duties: 'Deep web crawl; competitor pricing & positioning updates; sentiment mining.',
    triggers: 'Approving external research budgets; query redirection.',
    healthMetric: 'Research task turnaround time < 45m',
    defaultMission: 'Continuously track competitor pricing, product changes, market signals, and industry trends.',
    defaultAutonomy: 'guarded',
    defaultBudgetDollars: 1500,
    defaultBudgetTokens: 8_000_000,
    defaultSoRs: ['web', 'sec_edgar', 'news'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'risk-monitor',
    name: 'risk-monitor',
    scope: 'risk',
    channel: 'chan-risk-monitor',
    agentName: 'risk-agent',
    duties: 'Continuous exposure tracking; procedure card drift monitoring; counterparty checks.',
    triggers: 'Drift demotion alerts (checkDrift); variance spikes > 10%.',
    healthMetric: 'Procedure EWMA drift score < 0.05',
    defaultMission: 'Monitor counterparty credit exposure, hedging needs, and procedure card drift.',
    defaultAutonomy: 'guarded',
    defaultBudgetDollars: 1000,
    defaultBudgetTokens: 5_000_000,
    defaultSoRs: ['warehouse', 'bloomberg', 'sec_edgar'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'user-feedback',
    name: 'user-feedback',
    scope: 'product',
    channel: 'chan-user-feedback',
    agentName: 'feedback-agent',
    duties: 'Feedback clustering; feature request synthesis; bug sentiment categorization.',
    triggers: 'Prioritization steering; sensitive user complaints.',
    healthMetric: 'Unprocessed feedback backlog < 2h',
    defaultMission: 'Cluster incoming customer feedback, detect dissatisfaction spikes, and synthesize product insights.',
    defaultAutonomy: 'autonomous',
    defaultBudgetDollars: 800,
    defaultBudgetTokens: 4_000_000,
    defaultSoRs: ['zendesk', 'discourse', 'github'],
    recommendedModel: 'Gemini Flash / Claude 3.5 Haiku',
  },
  {
    id: 'compliance',
    name: 'compliance',
    scope: 'legal',
    channel: 'chan-compliance',
    agentName: 'compliance-agent',
    duties: 'Regulatory watch; policy diffing; audit trail verification; EU AI Act compliance checks.',
    triggers: 'High-risk AI categorization; policy changes; export approvals.',
    healthMetric: 'Zero unreviewed high-risk classifications',
    defaultMission: 'Audit regulatory adherence, trace model approvals, verify EU AI Act constraints, and review high-risk actions.',
    defaultAutonomy: 'supervised',
    defaultBudgetDollars: 1200,
    defaultBudgetTokens: 6_000_000,
    defaultSoRs: ['audit_log', 'sec_edgar', 'internal_policies'],
    recommendedModel: 'Claude 3.5 Sonnet / GPT-4o',
  },
  {
    id: 'finance',
    name: 'finance',
    scope: 'finance',
    channel: 'chan-finance',
    agentName: 'finance-agent',
    duties: 'Churn metric aggregation; Stripe/QuickBooks sync; cost-per-signal accounting.',
    triggers: 'Spend requests exceeding scope limit (>$500); ledger reconciliation.',
    healthMetric: 'Cost-per-signal within budget gate',
    defaultMission: 'Reconcile billing statements, compute churn probabilities, track cost-per-signal, and gate financial disbursements.',
    defaultAutonomy: 'guarded',
    defaultBudgetDollars: 1500,
    defaultBudgetTokens: 6_000_000,
    defaultSoRs: ['stripe', 'quickbooks', 'warehouse'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'ops',
    name: 'ops',
    scope: 'infra',
    channel: 'chan-ops',
    agentName: 'ops-agent',
    duties: 'Cluster health; rate limit monitoring; worker thread pool sweeps; relay connectivity.',
    triggers: 'Infrastructure failovers; DLQ exhaustion; cluster scaling.',
    healthMetric: 'Worker sweep interval < 1000ms',
    defaultMission: 'Monitor background worker sweeps, database connectivity, relay health, rate limits, and dead-letter queues.',
    defaultAutonomy: 'autonomous',
    defaultBudgetDollars: 1000,
    defaultBudgetTokens: 5_000_000,
    defaultSoRs: ['cloudwatch', 'prometheus', 'docker'],
    recommendedModel: 'Gemini Flash / Claude 3.5 Haiku',
  },
  {
    id: 'growth',
    name: 'growth',
    scope: 'business',
    channel: 'chan-growth',
    agentName: 'growth-agent',
    duties: 'Launch copy generation; conversion attribution; SEO & distribution experiments.',
    triggers: 'Brand tone overrides; public launch sign-off.',
    healthMetric: 'Experiment velocity >= 3/week',
    defaultMission: 'Orchestrate marketing experiments, analyze conversion attribution, and propose counter-promotions.',
    defaultAutonomy: 'autonomous',
    defaultBudgetDollars: 1200,
    defaultBudgetTokens: 7_000_000,
    defaultSoRs: ['analytics', 'stripe', 'hubspot'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'data-pipeline',
    name: 'data-pipeline',
    scope: 'data',
    channel: 'chan-data-pipeline',
    agentName: 'pipeline-agent',
    duties: 'ETL batches; artifact content-addressing; database indexing & partition management.',
    triggers: 'Pipeline backpressure; failed partition migrations.',
    healthMetric: 'Receipt processing lag < 30s',
    defaultMission: 'Manage ETL batches, content-addressing, storage partitions, and ingestion stream integrity.',
    defaultAutonomy: 'autonomous',
    defaultBudgetDollars: 800,
    defaultBudgetTokens: 4_000_000,
    defaultSoRs: ['s3', 'postgres', 'kafka'],
    recommendedModel: 'Gemini Flash / Claude 3.5 Haiku',
  },
  {
    id: 'exec',
    name: 'exec',
    scope: 'exec',
    channel: 'chan-exec',
    agentName: 'exec-agent',
    duties: 'Cross-scope KPI rollups; executive digest generation; company priority tracking.',
    triggers: 'Strategic pivots; OKR adjustments; resource reallocation.',
    healthMetric: 'Daily executive digest punctuality',
    defaultMission: 'Roll up cross-department telemetry, produce morning audio briefings, and coordinate executive decisions.',
    defaultAutonomy: 'guarded',
    defaultBudgetDollars: 2500,
    defaultBudgetTokens: 12_000_000,
    defaultSoRs: ['warehouse', 'audit_log', 'coord'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
  {
    id: 'sandbox',
    name: 'sandbox',
    scope: 'experimental',
    channel: 'chan-sandbox',
    agentName: 'sandbox-agent',
    duties: 'Canary testing; unvalidated skill cards; adversarial red-teaming; time-travel forking.',
    triggers: 'Promoting card from QUARANTINE to BOUNDED_PILOT.',
    healthMetric: 'Zero production spillover',
    defaultMission: 'Safely execute quarantined skill cards, test alternative model forks, and probe adversarial canaries.',
    defaultAutonomy: 'supervised',
    defaultBudgetDollars: 500,
    defaultBudgetTokens: 3_000_000,
    defaultSoRs: ['mock', 'sandbox'],
    recommendedModel: 'Claude 3.5 Sonnet / Gemini Pro',
  },
];

export interface RoomAgentIdentity {
  name: string;
  scope: string;
  pubkey: string;
  signer: BuzzSigner;
}

export function deterministicAgentSigner(agentName: string): BuzzSigner {
  const seed = `vital:agent:${agentName}`;
  const pubkey = createHash('sha256').update(seed).digest('hex');
  return {
    pubkey,
    sign: (id: string) => `sig:${createHash('sha256').update(`${pubkey}:${id}`).digest('hex').slice(0, 32)}`,
  };
}

const AGENT_IDENTITIES = new Map<string, RoomAgentIdentity>();

export function normalizeScope(raw: string): string {
  if (!raw) return 'core';
  let clean = raw.trim().toLowerCase();
  if (clean.startsWith('scope:')) clean = clean.slice(6);
  if (clean.startsWith('chan-')) clean = clean.slice(5);
  // Also map room IDs, channels, and names to scopes
  const match = CANONICAL_ROOMS.find(
    (r) => r.id === clean || r.name === clean || r.scope === clean || r.channel === clean || r.channel === raw,
  );
  return match ? match.scope : clean;
}

export function roomForScope(rawScope: string): CanonicalRoomDefinition {
  const scope = normalizeScope(rawScope);
  const found = CANONICAL_ROOMS.find((r) => r.scope === scope || r.id === scope);
  return found ?? CANONICAL_ROOMS[0]!;
}

export function agentForScope(rawScope: string): RoomAgentIdentity {
  const scope = normalizeScope(rawScope);
  const def = roomForScope(scope);
  const cached = AGENT_IDENTITIES.get(def.agentName);
  if (cached) return cached;
  const signer = deterministicAgentSigner(def.agentName);
  const id: RoomAgentIdentity = {
    name: def.agentName,
    scope: def.scope,
    pubkey: signer.pubkey,
    signer,
  };
  AGENT_IDENTITIES.set(def.agentName, id);
  return id;
}

export function channelForScope(rawScope: string): string {
  return roomForScope(rawScope).channel;
}

export function channelForRequest(
  _requestId: string,
  req?: { targetScope?: string; originScope?: string; scope?: string },
): { channel: string; threadRoot?: string } {
  const target = req?.targetScope ?? req?.scope ?? req?.originScope ?? 'core';
  return { channel: channelForScope(target) };
}

export interface RoomConfig {
  id: string;
  name: string;
  scope: string;
  channel: string;
  agentName: string;
  mission: string;
  autonomy: RoomAutonomy;
  budgetCeilingDollars: number;
  budgetCeilingTokens: number;
  connectedSoRs: string[];
  modelPolicy: string;
  active: boolean;
  verifiedCalibrated: boolean;
  calibratedAt?: string;
  updatedAt: string;
}

const configKey = (tenant: string, scope: string): string => `room:config:${tenant}:${normalizeScope(scope)}`;

export async function loadRoomConfig(db: AsyncDb, tenant: string, rawScope: string): Promise<RoomConfig> {
  const def = roomForScope(rawScope);
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(configKey(tenant, def.scope))) as
    | { value: string }
    | undefined;
  if (!row) {
    return {
      id: def.id,
      name: def.name,
      scope: def.scope,
      channel: def.channel,
      agentName: def.agentName,
      mission: def.defaultMission,
      autonomy: def.defaultAutonomy,
      budgetCeilingDollars: def.defaultBudgetDollars,
      budgetCeilingTokens: def.defaultBudgetTokens,
      connectedSoRs: [...def.defaultSoRs],
      modelPolicy: def.recommendedModel,
      active: true,
      verifiedCalibrated: false,
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<RoomConfig>;
    return {
      id: def.id,
      name: def.name,
      scope: def.scope,
      channel: def.channel,
      agentName: def.agentName,
      mission: parsed.mission ?? def.defaultMission,
      autonomy: parsed.autonomy ?? def.defaultAutonomy,
      budgetCeilingDollars: parsed.budgetCeilingDollars ?? def.defaultBudgetDollars,
      budgetCeilingTokens: parsed.budgetCeilingTokens ?? def.defaultBudgetTokens,
      connectedSoRs: parsed.connectedSoRs ?? [...def.defaultSoRs],
      modelPolicy: parsed.modelPolicy ?? def.recommendedModel,
      active: parsed.active !== undefined ? Boolean(parsed.active) : true,
      verifiedCalibrated: Boolean(parsed.verifiedCalibrated),
      calibratedAt: parsed.calibratedAt,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return loadRoomConfig(db, tenant, def.scope);
  }
}

export async function saveRoomConfig(
  db: AsyncDb,
  tenant: string,
  cfg: Partial<RoomConfig> & { scope: string },
  by = 'system',
): Promise<RoomConfig> {
  const current = await loadRoomConfig(db, tenant, cfg.scope);
  const now = new Date().toISOString();
  const updated: RoomConfig = {
    ...current,
    ...cfg,
    scope: current.scope,
    channel: current.channel,
    updatedAt: now,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(configKey(tenant, current.scope), JSON.stringify(updated));

  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(
      tenant,
      by,
      'POLICY_MUTATE',
      `room:${current.scope}`,
      JSON.stringify({
        autonomy: updated.autonomy,
        budgetCeilingDollars: updated.budgetCeilingDollars,
        budgetCeilingTokens: updated.budgetCeilingTokens,
        mission: updated.mission,
        connectedSoRs: updated.connectedSoRs,
        active: updated.active,
      }),
      now,
    );

  return updated;
}

export async function listRoomConfigs(db: AsyncDb, tenant: string): Promise<RoomConfig[]> {
  const list: RoomConfig[] = [];
  for (const def of CANONICAL_ROOMS) {
    list.push(await loadRoomConfig(db, tenant, def.scope));
  }
  return list;
}
