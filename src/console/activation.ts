import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import { memo } from '../core/request-cache.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { User } from '../core/auth.ts';
import { fileDiffCollector, gitHubReleasesCollector, stripeInvoicesCollector } from '../ingest/collectors.ts';
import {
  getIntegrationHealth,
  testFileDirectory,
  testGitHubRepo,
  type IntegrationHealth,
  type IntegrationState,
} from '../ingest/health.ts';
import { runIngestionWorker } from '../ingest/worker.ts';
import { fanOutWorkflow } from '../wedge/ship.ts';
import { loadFanOutRun } from '../wedge/fanout-workflow.ts';

/**
 * FLOW-012: guided activation for empty organizations.
 *
 * Readiness is computed from durable state — checklist items are never
 * cosmetic. Sample walkthrough data lives in scope `sample:walkthrough`
 * and is labeled everywhere it appears.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const SAMPLE_SCOPE = 'sample:walkthrough';
export const SAMPLE_REQUEST_PREFIX = 'sample-walkthrough-';

export type SourceConnectionState = IntegrationState;

export type ChecklistStatus = 'done' | 'pending' | 'blocked';

export interface ActivationConfig {
  scope: string;
  sourceKind: 'files' | 'github' | 'stripe';
  sourcePath: string;
  artifactDir: string;
  accountableOwnerId: string;
  approverRole: 'member' | 'admin' | 'owner';
  dailyBudgetDollars: number;
  humanMinutesBudget: number;
  configuredAt: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
  actionHref?: string;
  actionLabel?: string;
}

export interface FirstReceiptPreview {
  id: string;
  summary: string;
  status: string;
  createdAt: string;
  claimId: string | null;
}

export interface ActivationState {
  showPanel: boolean;
  checklist: ChecklistItem[];
  checklistComplete: boolean;
  sourceState: SourceConnectionState;
  sourceStateDetail: string;
  sourceHealth: IntegrationHealth | null;
  firstReceipt: FirstReceiptPreview | null;
  nextAction: { label: string; href: string; detail: string } | null;
  timeToFirstReview: {
    signupAt: string;
    firstReviewAt: string | null;
    elapsedSeconds: number | null;
  } | null;
  sampleActive: boolean;
  config: ActivationConfig | null;
  releaseWorkflowId: string | null;
}

const configKey = (tenant: string): string => `activation:config:${tenant}`;
const signupKey = (tenant: string): string => `activation:signupAt:${tenant}`;
const firstReviewKey = (tenant: string): string => `activation:firstReviewAt:${tenant}`;
const sampleKey = (tenant: string): string => `activation:sample:${tenant}`;

/**
 * One activation meta value, read at most once per request.
 *
 * The dashboard asks for the same keys from several widgets — the activation
 * panel, the journey milestone and the readiness block each read the config — so
 * before this the dashboard issued three identical lookups for one page view.
 * Memoization is per request and off for mutating methods, so a POST that writes
 * a key and then reads it back still sees its own write.
 */
async function metaGet(db: AsyncDb, key: string): Promise<string | null> {
  return memo(`activation:meta:${key}`, async () => {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as
      | { value: string }
      | undefined;
    return r ? String(r.value) : null;
  });
}

async function metaSet(db: AsyncDb, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export async function loadActivationConfig(db: AsyncDb, tenant: string): Promise<ActivationConfig | null> {
  const raw = await metaGet(db, configKey(tenant));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActivationConfig;
  } catch {
    return null;
  }
}

export async function saveActivationConfig(db: AsyncDb, tenant: string, config: ActivationConfig): Promise<void> {
  await metaSet(db, configKey(tenant), JSON.stringify(config));
}

export async function recordSignupAt(db: AsyncDb, tenant: string, at: string): Promise<void> {
  const existing = await metaGet(db, signupKey(tenant));
  if (!existing) await metaSet(db, signupKey(tenant), at);
}

export async function recordFirstReviewAt(db: AsyncDb, tenant: string, at: string): Promise<void> {
  const existing = await metaGet(db, firstReviewKey(tenant));
  if (!existing) await metaSet(db, firstReviewKey(tenant), at);
}

/** First human approval across the whole tenant (null before the first one). */
export async function firstReviewAt(db: AsyncDb, tenant: string): Promise<string | null> {
  return metaGet(db, firstReviewKey(tenant));
}

/** When this tenant's journey began — signup or the web claim of an unprovisioned console. */
export async function signupAt(db: AsyncDb, tenant: string): Promise<string | null> {
  return metaGet(db, signupKey(tenant));
}

export function parseGitHubRepo(path: string): [string, string] | null {
  let clean = path.trim();
  if (clean.startsWith('github:')) clean = clean.slice(7);
  if (clean.endsWith(':releases')) clean = clean.slice(0, -9);
  const match = clean.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  return match ? [match[1]!, match[2]!] : null;
}

export function collectorName(sourcePath: string): string {
  const gh = parseGitHubRepo(sourcePath);
  if (gh) return `github:${gh[0]}/${gh[1]}:releases`;
  return `files:${resolve(sourcePath)}`;
}

async function ingestClaimCount(db: AsyncDb, tenant: string): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims
       WHERE tenant = ? AND scope <> ? AND extractor IN ('file-diff', 'github-releases')`,
    )
    .get(tenant, SAMPLE_SCOPE)) as { n: number };
  return Number(row.n);
}

async function releaseWorkflowId(db: AsyncDb, tenant: string): Promise<string | null> {
  const rows = (await db.prepare('SELECT key FROM meta WHERE key LIKE ?').all(`wedge:fanout:${tenant}:%`)) as {
    key: string;
  }[];
  for (const row of rows) {
    const id = row.key.slice(`wedge:fanout:${tenant}:`.length);
    const run = await loadFanOutRun(db, tenant, id);
    if (run?.kind === 'ship') return id;
  }
  return null;
}

/** Checklist tri-state without nested ternaries: done beats pending beats blocked. */
function stepStatus(done: boolean, ready: boolean): 'done' | 'pending' | 'blocked' {
  if (done) return 'done';
  if (ready) return 'pending';
  return 'blocked';
}

function sourceSyncDetail(ingested: boolean, state: string): string {
  if (ingested) return 'At least one source item became ledger evidence';
  if (state === 'empty') return 'Source is empty. Add a file, then sync';
  if (state === 'failed') return 'Ingestion failed. Inspect the source status below';
  return 'Run ingestion after configuring a source';
}

function firstWorkflowDetail(workflowId: string | null, ingested: boolean): string {
  if (workflowId) return `Ship-to-Result workflow ${workflowId} is running`;
  if (ingested) return 'Start the governed release fan-out from your first evidence';
  return 'Available after the first source receipt succeeds';
}

function firstWorkflowHref(workflowId: string | null, ingested: boolean): string | undefined {
  if (workflowId) return `/console/workflows/${encodeURIComponent(workflowId)}`;
  if (ingested) return '/setup#workflow';
  return undefined;
}

function firstWorkflowLabel(workflowId: string | null, ingested: boolean): string | undefined {
  if (workflowId) return 'Open workflow';
  if (ingested) return 'Start release workflow';
  return undefined;
}

function elapsedSince(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

export async function buildActivationState(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  tenant: string,
  now: string,
  users: User[],
  opts: { approverRole?: 'member' | 'admin' | 'owner' } = {},
): Promise<ActivationState> {
  const config = await loadActivationConfig(db, tenant);
  const collector = config ? collectorName(config.sourcePath) : null;
  const sourceHealth = collector
    ? await getIntegrationHealth(db, tenant, collector, {
        configured: true,
        scope: config?.scope ?? null,
        now,
      })
    : null;
  const source = sourceHealth
    ? { state: sourceHealth.state, detail: sourceHealth.stateDetail }
    : { state: 'unconfigured' as const, detail: 'choose a source directory on the setup page' };
  const stats = sourceHealth?.inbox ?? { pending: 0, claimed: 0, done: 0, failed: 0, total: 0 };
  const activeUsers = users.filter((u) => !u.disabled);
  const ownerReady = activeUsers.some((u) => u.role === 'owner' && !u.mustChangePassword);
  const accountable =
    config && activeUsers.some((u) => u.id === config.accountableOwnerId)
      ? activeUsers.find((u) => u.id === config.accountableOwnerId)!
      : null;
  const ingested = stats.done > 0 || (await ingestClaimCount(db, tenant)) > 0;
  const workflowId = await releaseWorkflowId(db, tenant);
  const decisions = (await db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE tenant = ?').get(tenant)) as {
    n: number;
  };
  const sampleActive = (await metaGet(db, sampleKey(tenant))) !== null;

  const checklist: ChecklistItem[] = [
    {
      id: 'owner',
      label: 'Authorized owner',
      status: ownerReady ? 'done' : 'pending',
      detail: ownerReady ? 'An active owner can sign in' : 'Complete password activation before configuring sources',
      actionHref: ownerReady ? undefined : '/change-password',
      actionLabel: ownerReady ? undefined : 'Activate account',
    },
    {
      id: 'accountable',
      label: 'Accountable human',
      status: stepStatus(accountable !== null, ownerReady),
      detail: accountable
        ? `${accountable.name} (${accountable.email}) owns incoming evidence`
        : 'Name the human responsible for reviewing ingested evidence',
      actionHref: '/setup#accountable',
      actionLabel: 'Choose owner',
    },
    {
      id: 'scope',
      label: 'Scope',
      status: stepStatus(config?.scope !== undefined && config.scope !== '', ownerReady),
      detail: config?.scope
        ? `Release evidence will land in scope "${config.scope}"`
        : 'Pick the room/scope that owns release changes',
      actionHref: '/setup#scope',
      actionLabel: 'Set scope',
    },
    {
      id: 'source',
      label: 'Source directory',
      status: stepStatus(config?.sourcePath !== undefined && config.sourcePath !== '', ownerReady),
      detail: config?.sourcePath
        ? `Watching ${config.sourcePath}`
        : 'Point Vital at a changelog or release-notes directory',
      actionHref: '/setup#source',
      actionLabel: 'Configure source',
    },
    {
      id: 'policy',
      label: 'Approval policy',
      status: stepStatus(config !== null, ownerReady),
      detail: config
        ? `Reviews require the ${config.approverRole} role or higher`
        : `Default approver role: ${opts.approverRole ?? 'member'}`,
      actionHref: '/setup#policy',
      actionLabel: 'Review policy',
    },
    {
      id: 'budget',
      label: 'Attention budget',
      status: stepStatus(config !== null, ownerReady),
      detail: config
        ? `$${config.dailyBudgetDollars}/day · ${config.humanMinutesBudget} human minutes/day`
        : 'Set daily spend and human-minute ceilings',
      actionHref: '/setup#budget',
      actionLabel: 'Set budget',
    },
    {
      id: 'ingested',
      label: 'First source receipt',
      status: stepStatus(ingested, config !== null),
      detail: sourceSyncDetail(ingested, source.state),
      actionHref: config && !ingested ? '/setup#sync' : undefined,
      actionLabel: config && !ingested ? 'Sync source' : undefined,
    },
    {
      id: 'workflow',
      label: 'First release workflow',
      status: stepStatus(workflowId !== null, ingested),
      detail: firstWorkflowDetail(workflowId, ingested),
      actionHref: firstWorkflowHref(workflowId, ingested),
      actionLabel: firstWorkflowLabel(workflowId, ingested),
    },
  ];

  const checklistComplete = checklist.every((item) => item.status === 'done');
  const signupAt = await metaGet(db, signupKey(tenant));
  const firstReviewAt = await metaGet(db, firstReviewKey(tenant));
  const timeToFirstReview = signupAt
    ? {
        signupAt,
        firstReviewAt,
        elapsedSeconds: elapsedSince(signupAt, firstReviewAt ?? now),
      }
    : null;

  let nextAction: ActivationState['nextAction'] = null;
  const next = checklist.find((item) => item.status === 'pending');
  if (next?.actionHref && next.actionLabel) {
    nextAction = { label: next.actionLabel, href: next.actionHref, detail: next.detail };
  } else if (!ingested && config) {
    nextAction = {
      label: 'Sync source now',
      href: '/setup#sync',
      detail: 'Pull the first file from your configured directory into the ledger',
    };
  } else if (ingested && !workflowId) {
    nextAction = {
      label: 'Start first release workflow',
      href: '/setup#workflow',
      detail: 'Fan out launch work from your first cited evidence',
    };
  }

  const showPanel = !checklistComplete && (Number(decisions.n) === 0 || config !== null);

  return {
    showPanel,
    checklist,
    checklistComplete,
    sourceState: config ? source.state : 'unconfigured',
    sourceStateDetail: config ? source.detail : 'No source configured yet',
    sourceHealth,
    firstReceipt: sourceHealth?.lastReceipt ?? null,
    nextAction,
    timeToFirstReview,
    sampleActive,
    config,
    releaseWorkflowId: workflowId,
  };
}

export function defaultArtifactDir(tenant: string): string {
  return resolve('var', 'artifacts', tenant);
}

export function parseActivationConfigInput(
  fields: Record<string, string | undefined>,
  users: User[],
  now: string,
  tenant: string,
): ActivationConfig {
  const scope = (fields.scope ?? '').trim();
  const sourcePath = (fields.sourcePath ?? '').trim();
  const artifactDir = (fields.artifactDir ?? '').trim() || defaultArtifactDir(tenant);
  const accountableOwnerId = (fields.accountableOwnerId ?? '').trim();
  const approverRole = (fields.approverRole ?? 'member').trim() as ActivationConfig['approverRole'];
  const dailyBudgetDollars = Number(fields.dailyBudgetDollars ?? '100');
  const humanMinutesBudget = Number(fields.humanMinutesBudget ?? '60');
  if (!scope) throw new Error('scope is required');
  if (!sourcePath) throw new Error('source directory is required');
  if (!['member', 'admin', 'owner'].includes(approverRole)) throw new Error('invalid approver role');
  if (!Number.isFinite(dailyBudgetDollars) || dailyBudgetDollars <= 0)
    throw new Error('daily budget must be a positive number');
  if (!Number.isFinite(humanMinutesBudget) || humanMinutesBudget <= 0)
    throw new Error('human minutes budget must be a positive number');
  const owner = users.find((u) => u.id === accountableOwnerId && !u.disabled);
  if (!owner) throw new Error('choose an active accountable human');
  const gh = parseGitHubRepo(sourcePath);
  const sourceKind: 'files' | 'github' = gh || fields.sourceKind === 'github' ? 'github' : 'files';
  const finalSourcePath = gh ? `${gh[0]}/${gh[1]}` : resolve(sourcePath);
  return {
    scope,
    sourceKind,
    sourcePath: finalSourcePath,
    artifactDir: resolve(artifactDir),
    accountableOwnerId: owner.id,
    approverRole,
    dailyBudgetDollars,
    humanMinutesBudget,
    configuredAt: now,
  };
}

export async function testConfiguredSource(config: ActivationConfig) {
  const gh = parseGitHubRepo(config.sourcePath);
  if (config.sourceKind === 'github' || gh) {
    const [owner, repo] = gh ?? config.sourcePath.split('/');
    return testGitHubRepo(owner!, repo!, process.env.GITHUB_TOKEN);
  }
  return testFileDirectory(config.sourcePath, {
    maxEntries: 500,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
  });
}

export async function runConfiguredIngestion(
  db: AsyncDb,
  ledger: Ledger,
  tenant: string,
  config: ActivationConfig,
  signal?: AbortSignal,
): Promise<{ processed: number; failed: number; claimIds: string[]; errors: string[] }> {
  mkdirSync(config.artifactDir, { recursive: true });
  const gh = parseGitHubRepo(config.sourcePath);
  if (config.sourceKind === 'stripe' || config.sourcePath.startsWith('stripe:')) {
    const apiKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    const collector = stripeInvoicesCollector({ apiKey });
    const result = await runIngestionWorker(db, ledger, collector, {
      tenant,
      scope: config.scope || 'finance',
      artifactDir: config.artifactDir,
      maxReceipts: 50,
      signal,
    });
    return {
      processed: result.processed,
      failed: result.failed,
      claimIds: result.claimIds,
      errors: result.errors,
    };
  }
  if (config.sourceKind === 'github' || gh) {
    const [owner, repo] = gh ?? config.sourcePath.split('/');
    const token = process.env.GITHUB_TOKEN;
    const collector = gitHubReleasesCollector(owner!, repo!, (url) =>
      fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Vital-Ingest/1.0',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
    const result = await runIngestionWorker(db, ledger, collector, {
      tenant,
      scope: config.scope,
      artifactDir: config.artifactDir,
      maxReceipts: 50,
      signal,
    });
    return {
      processed: result.processed,
      failed: result.failed,
      claimIds: result.claimIds,
      errors: result.errors,
    };
  }
  const collector = fileDiffCollector(collectorName(config.sourcePath), config.sourcePath, 'SINGLE_SOURCE', {
    maxEntries: 500,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
  });
  const result = await runIngestionWorker(db, ledger, collector, {
    tenant,
    scope: config.scope,
    artifactDir: config.artifactDir,
    maxReceipts: 50,
    signal,
  });
  return {
    processed: result.processed,
    failed: result.failed,
    claimIds: result.claimIds,
    errors: result.errors,
  };
}

export async function startFirstReleaseWorkflow(
  db: AsyncDb,
  coord: Coordinator,
  tenant: string,
  config: ActivationConfig,
  accountable: User,
  now: string,
): Promise<string> {
  const claim = (await db
    .prepare(
      `SELECT id, statement FROM claims
       WHERE tenant = ? AND scope = ? AND kind = 'OBSERVATION'
       ORDER BY created_at LIMIT 1`,
    )
    .get(tenant, config.scope)) as { id: string; statement: string } | undefined;
  if (!claim) throw new Error('no ingested evidence found: sync your source first');
  const run = await fanOutWorkflow(db, coord, tenant, {
    release: `first-${claim.id.slice(0, 8)}`,
    claimIds: [claim.id],
    onBehalfOf: `human:${accountable.id}`,
    now,
    summary: `First release workflow from ingested evidence: ${claim.statement}`,
  });
  return run.id;
}

/** Labeled demo only — never mixed into customer evidence scopes. */
export async function seedSampleWalkthrough(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  tenant: string,
  accountable: User,
  now: string,
): Promise<{ claimId: string; requestId: string }> {
  await metaSet(db, sampleKey(tenant), now);
  const claim = await ledger.append({
    tenant,
    subject: 'sample:release-notes',
    kind: 'OBSERVATION',
    statement: 'SAMPLE ONLY: v0.1 adds export receipts (not customer evidence)',
    confidence: 1,
    observedAt: now,
    validFrom: now,
    owner: accountable.id,
    scope: SAMPLE_SCOPE,
    authorType: 'system',
    provenance: {
      sourceUri: 'sample://walkthrough/release-notes.md',
      sourceTier: 'SINGLE_SOURCE',
      extractor: 'sample-walkthrough',
      extractorVersion: '1.0.0',
      retrievedAt: now,
    },
  });
  const admitted = await coord.submit({
    tenant,
    id: `${SAMPLE_REQUEST_PREFIX}${claim.id.slice(0, 8)}`,
    messageClass: 'REQUEST',
    originScope: SAMPLE_SCOPE,
    targetScope: 'marketing',
    goal: 'SAMPLE WALKTHROUGH: draft launch copy from labeled demo evidence',
    claimRefs: [claim.id],
    deliverableSchema: 'launch-copy.v1',
    bid: { dollars: 0, tokens: 0, humanMinutes: 5, deadline: now, maxRounds: 1, maxHops: 1 },
    onBehalfOf: `human:${accountable.id}`,
    stopCondition: 'sample walkthrough only',
  });
  if (admitted.state !== 'ADMITTED') {
    throw new Error(`sample request was not admitted: ${admitted.reason ?? admitted.state}`);
  }
  return { claimId: claim.id, requestId: admitted.request.id };
}

/**
 * Status is communicated by tint + text, never by color alone: every badge
 * carries its own label and a leading dot.
 */
const CHECK_TONE: Record<ChecklistStatus, string> = {
  done: 'v-badge-good',
  pending: 'v-badge-warn',
  blocked: 'v-badge-risk',
};

const SOURCE_TONE: Record<SourceConnectionState, string> = {
  unconfigured: 'v-badge',
  disabled: 'v-badge',
  syncing: 'v-badge-info',
  empty: 'v-badge-warn',
  delayed: 'v-badge-warn',
  rate_limited: 'v-badge-info',
  rejected: 'v-badge-risk',
  failed: 'v-badge-risk',
  ready: 'v-badge-good',
};

function statusBadge(tone: string, label: string): string {
  return `<span class="v-badge ${tone}"><span class="dot"></span>${esc(label)}</span>`;
}

function renderSourceHealthCard(state: ActivationState): string {
  const health = state.sourceHealth;
  if (!health) return '';
  const checkpoint = health.checkpoint
    ? `<div class="sub">checkpoint · ${esc(health.checkpoint.length > 80 ? `${health.checkpoint.slice(0, 77)}…` : health.checkpoint)}</div>`
    : '';
  const freshness =
    health.freshnessSeconds !== null
      ? `<div class="sub">freshness · ${esc(String(health.freshnessSeconds))}s since last successful poll</div>`
      : '';
  const err = health.lastError
    ? `<p class="err">${esc(health.lastError.code)}: ${esc(health.lastError.detail)}</p>`
    : '';
  const inbox = `<div class="sub">inbox · pending ${health.inbox.pending} · claimed ${health.inbox.claimed} · done ${health.inbox.done} · failed ${health.inbox.failed}</div>`;
  return `${checkpoint}${freshness}${inbox}${err}<p class="sub">${esc(health.permissionNote)}</p><p class="sub">${esc(health.actionsNote)}</p>`;
}

export function renderActivationPanel(state: ActivationState, csrf: string, home: string): string {
  if (!state.showPanel) return '';
  const items = state.checklist
    .map((item) => {
      const action =
        item.actionHref && item.actionLabel ? ` <a href="${esc(item.actionHref)}">${esc(item.actionLabel)}</a>` : '';
      return `<li class="v-row" style="align-items:flex-start;">
<span class="v-row-main" style="align-items:flex-start;">${statusBadge(CHECK_TONE[item.status], item.status)}
<span style="min-width:0;"><strong>${esc(item.label)}</strong><br><span class="v-sub">${esc(item.detail)}</span></span></span>${action}
</li>`;
    })
    .join('');
  const receipt = state.firstReceipt
    ? `<div class="v-card" style="margin-top:12px;"><p class="v-eyebrow">First source item</p>
<p style="font-weight:650;margin:6px 0 2px;">${esc(state.firstReceipt.summary)}</p>
<p class="v-meta">status ${esc(state.firstReceipt.status)} · ${esc(state.firstReceipt.createdAt)}${state.firstReceipt.claimId ? ` · <a href="/console/claims/${esc(encodeURIComponent(state.firstReceipt.claimId))}">view evidence</a>` : ''}</p></div>`
    : '';
  const timing = state.timeToFirstReview
    ? `<p class="sub">Time since signup: ${esc(String(state.timeToFirstReview.elapsedSeconds ?? 0))}s${state.timeToFirstReview.firstReviewAt ? ` · first review after ${esc(String(state.timeToFirstReview.elapsedSeconds ?? 0))}s` : ' · awaiting first trustworthy review'}</p>`
    : '';
  const next = state.nextAction
    ? `<div class="v-card" style="border-left:3px solid var(--v-accent);">
<p class="v-eyebrow">next useful action</p>
<p style="font-size:17px;font-weight:650;margin:6px 0 4px;"><a href="${esc(state.nextAction.href)}">${esc(state.nextAction.label)}</a></p>
<p class="v-sub">${esc(state.nextAction.detail)}</p></div>`
    : '';
  const sample = state.sampleActive
    ? `<p class="v-sub">Sample walkthrough is active. Evidence in scope <code>${esc(SAMPLE_SCOPE)}</code> is labeled demo data, not customer proof.</p>`
    : `<form method="post" action="/setup/sample"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-secondary v-btn-sm">Run labeled sample walkthrough</button></form>`;
  return `<section id="activation-setup" style="margin-bottom:16px;">
<div class="v-split">
  <div><p class="v-eyebrow">Activation</p><h1 class="v-section-title" style="margin-top:4px;">Organization setup</h1></div>
  <div class="v-tabs"><a class="v-tab" href="/setup">Open setup</a><a class="v-tab" href="${esc(home)}">Dashboard</a></div>
</div>
<p class="v-lede">Finish these steps to reach your first cited review without using the CLI.</p>
${next}
<div class="v-card">
<p class="v-eyebrow">Source connection</p>
<p style="margin:6px 0 0;">${statusBadge(SOURCE_TONE[state.sourceState], state.sourceState)}</p>
<p class="v-sub" style="margin-top:6px;">${esc(state.sourceStateDetail)}</p>
${renderSourceHealthCard(state)}
${receipt}
</div>
<ol class="v-stack-sm" style="list-style:none;padding:0;margin:0;">${items}</ol>
${timing}
<p>${sample}</p>
</section>`;
}

export function renderSetupPage(
  state: ActivationState,
  users: User[],
  csrf: string,
  home: string,
  message?: string,
): string {
  const config = state.config;
  const ownerOptions = users
    .filter((u) => !u.disabled)
    .map(
      (u) =>
        `<option value="${esc(u.id)}"${config?.accountableOwnerId === u.id || (!config && u.role === 'owner') ? ' selected' : ''}>${esc(u.name)} (${esc(u.email)})</option>`,
    )
    .join('');
  const msg = message ? `<p class="err">${esc(message)}</p>` : '';
  const healthCard = state.sourceHealth
    ? `<div class="v-card" style="margin:0 0 16px;"><div class="v-split" style="margin-bottom:6px;"><h2 class="v-card-title">Connection health</h2>${statusBadge(SOURCE_TONE[state.sourceState], state.sourceState)}</div>
<p class="v-sub">${esc(state.sourceStateDetail)}</p>
${renderSourceHealthCard(state)}</div>`
    : '';
  const syncForm = config
    ? `<section id="sync" class="v-card" style="margin:0 0 16px;"><h2 class="v-card-title">Sync source</h2>
<p class="v-sub" style="margin:4px 0 12px;">Pull new or changed files from <code>${esc(config.sourcePath)}</code> into scope <code>${esc(config.scope)}</code>.</p>
<div class="v-tabs"><form method="post" action="/setup/test-source" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-secondary v-btn-sm">Test connection</button></form>
<form method="post" action="/setup/ingest" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-primary v-btn-sm">Sync now</button></form></div>
<p class="v-meta" style="margin-top:12px;">States: unconfigured · disabled · empty · delayed · rate_limited · syncing · ready · failed · rejected</p>
</section>`
    : '';
  const workflowForm =
    config && state.sourceState === 'ready'
      ? `<section id="workflow" class="v-card" style="margin:0 0 16px;"><h2 class="v-card-title">First release workflow</h2>
<p class="v-sub" style="margin:4px 0 12px;">Your first ingested evidence can start the Ship-to-Result fan-out.</p>
<form method="post" action="/setup/start-release"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-primary v-btn-sm">Start release workflow</button></form></section>`
      : '';
  const roomsSection = `<section id="rooms" class="v-card" style="margin:0 0 16px;"><h2 class="v-card-title">Rooms</h2>
<p class="v-sub" style="margin:4px 0 12px;">Choose which autonomous rooms are active and tune their mandate, autonomy, spend ceiling, and connected data feeds.</p>
<a class="v-btn v-btn-secondary v-btn-sm" href="/setup/rooms">Open room provisioning</a></section>`;
  const dataSection = `<section id="data" class="v-card" style="margin:0 0 16px;"><h2 class="v-card-title">Data portability &amp; retention</h2>
<p class="v-sub" style="margin:4px 0 12px;">Download your reality ledger export, cryptographic audit history, or manage GDPR Article 17 erasure.</p>
<a class="v-btn v-btn-secondary v-btn-sm" href="/console/data">Open Data &amp; Retention</a></section>`;
  // Layout-only rules; every color, radius and shadow comes from the token
  // system injected at the response boundary (theme.ts).
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup: organization activation</title>
<style>
body{margin:0 auto;padding:28px 20px 48px;max-width:840px}
form.settings{display:grid;gap:16px}
label{font-size:12.5px;font-weight:600;color:var(--v-muted);display:grid;gap:5px;margin-bottom:4px}
fieldset{border:0;margin:0;padding:0}
</style>
</head><body>
<a class="skip-link" href="#main">Skip to main content</a>
<main id="main">
<nav class="v-breadcrumb" aria-label="Breadcrumb" style="margin-bottom:14px;"><a href="${esc(home)}">Console</a><span class="sep">/</span><strong>Setup</strong><span class="sep">·</span><a href="/setup/rooms">Rooms &amp; autonomy</a><span class="sep">·</span><a href="/console/data">Data &amp; retention</a></nav>
<h1 class="v-page-title">Guided setup</h1>
<p class="v-lede">Configure source, accountable human, scope, approval policy, and budget. Sample walkthrough data is always labeled and kept in scope <code>${esc(SAMPLE_SCOPE)}</code>.</p>
${msg}
${healthCard}
<form class="settings" method="post" action="/setup">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<section id="accountable" class="v-card" style="margin:0;"><p class="v-eyebrow">Step 1</p><h2 class="v-card-title">Accountable human</h2>
<p class="v-sub" style="margin:4px 0 10px;">Every claim needs a named human owner (invariant I3).</p>
<label>Owner <select class="v-input v-select" name="accountableOwnerId" required>${ownerOptions}</select></label></section>
<section id="scope" class="v-card" style="margin:0;"><p class="v-eyebrow">Step 2</p><h2 class="v-card-title">Scope</h2>
<p class="v-sub" style="margin:4px 0 10px;">The scope gates which rooms and grants the work inherits.</p>
<label>Release scope <input class="v-input" name="scope" required value="${esc(config?.scope ?? 'engineering')}" placeholder="engineering"></label></section>
<section id="source" class="v-card" style="margin:0;"><p class="v-eyebrow">Step 3</p><h2 class="v-card-title">Evidence source</h2>
<p class="v-sub" style="margin:4px 0 10px;">Collection is deterministic (L0); no model reads raw material.</p>
<label>Source directory or GitHub repository (e.g. <code>owner/repo</code> or <code>/path/to/changelog</code>) <input class="v-input" name="sourcePath" required value="${esc(config?.sourcePath ?? '')}" placeholder="owner/repo or /path/to/changelog"></label>
<label>Artifact store <input class="v-input" name="artifactDir" value="${esc(config?.artifactDir ?? defaultArtifactDir(users[0]?.tenant ?? 'tenant'))}"></label></section>
<section id="policy" class="v-card" style="margin:0;"><p class="v-eyebrow">Step 4</p><h2 class="v-card-title">Approval policy</h2>
<p class="v-sub" style="margin:4px 0 10px;">Who may approve beginning work for this scope.</p>
<label>Minimum approver role
<select class="v-input v-select" name="approverRole">
<option value="member"${config?.approverRole === 'member' || !config ? ' selected' : ''}>member</option>
<option value="admin"${config?.approverRole === 'admin' ? ' selected' : ''}>admin</option>
<option value="owner"${config?.approverRole === 'owner' ? ' selected' : ''}>owner</option>
</select></label></section>
<section id="budget" class="v-card" style="margin:0;"><p class="v-eyebrow">Step 5</p><h2 class="v-card-title">Attention budget</h2>
<p class="v-sub" style="margin:4px 0 10px;">Hard ceilings the coordinator enforces on spend and operator minutes.</p>
<label>Daily dollars <input class="v-input" name="dailyBudgetDollars" type="number" min="1" step="1" value="${esc(String(config?.dailyBudgetDollars ?? 100))}"></label>
<label>Human minutes / day <input class="v-input" name="humanMinutesBudget" type="number" min="1" step="1" value="${esc(String(config?.humanMinutesBudget ?? 60))}"></label></section>
<button type="submit" class="v-btn v-btn-primary" style="justify-self:start;">Save setup</button>
</form>
${syncForm}
${workflowForm}
${roomsSection}
${dataSection}
</main>
</body></html>`;
}
