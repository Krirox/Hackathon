import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { User } from '../core/auth.ts';
import { fileDiffCollector } from '../ingest/collectors.ts';
import {
  getIntegrationHealth,
  testFileDirectory,
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
  sourceKind: 'files';
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

async function metaGet(db: AsyncDb, key: string): Promise<string | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  return r ? String(r.value) : null;
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

export function collectorName(sourcePath: string): string {
  return `files:${resolve(sourcePath)}`;
}

async function ingestClaimCount(db: AsyncDb, tenant: string): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims
       WHERE tenant = ? AND scope <> ? AND extractor = 'file-diff'`,
    )
    .get(tenant, SAMPLE_SCOPE)) as { n: number };
  return Number(row.n);
}

async function releaseWorkflowId(db: AsyncDb, tenant: string): Promise<string | null> {
  const rows = (await db
    .prepare('SELECT key FROM meta WHERE key LIKE ?')
    .all(`wedge:fanout:${tenant}:%`)) as { key: string }[];
  for (const row of rows) {
    const id = row.key.slice(`wedge:fanout:${tenant}:`.length);
    const run = await loadFanOutRun(db, tenant, id);
    if (run?.kind === 'ship') return id;
  }
  return null;
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
      status: accountable ? 'done' : ownerReady ? 'pending' : 'blocked',
      detail: accountable
        ? `${accountable.name} (${accountable.email}) owns incoming evidence`
        : 'Name the human responsible for reviewing ingested evidence',
      actionHref: '/setup#accountable',
      actionLabel: 'Choose owner',
    },
    {
      id: 'scope',
      label: 'Scope',
      status: config?.scope ? 'done' : ownerReady ? 'pending' : 'blocked',
      detail: config?.scope
        ? `Release evidence will land in scope "${config.scope}"`
        : 'Pick the room/scope that owns release changes',
      actionHref: '/setup#scope',
      actionLabel: 'Set scope',
    },
    {
      id: 'source',
      label: 'Source directory',
      status: config?.sourcePath ? 'done' : ownerReady ? 'pending' : 'blocked',
      detail: config?.sourcePath
        ? `Watching ${config.sourcePath}`
        : 'Point Vital at a changelog or release-notes directory',
      actionHref: '/setup#source',
      actionLabel: 'Configure source',
    },
    {
      id: 'policy',
      label: 'Approval policy',
      status: config ? 'done' : ownerReady ? 'pending' : 'blocked',
      detail: config
        ? `Reviews require the ${config.approverRole} role or higher`
        : `Default approver role: ${opts.approverRole ?? 'member'}`,
      actionHref: '/setup#policy',
      actionLabel: 'Review policy',
    },
    {
      id: 'budget',
      label: 'Attention budget',
      status: config ? 'done' : ownerReady ? 'pending' : 'blocked',
      detail: config
        ? `$${config.dailyBudgetDollars}/day · ${config.humanMinutesBudget} human minutes/day`
        : 'Set daily spend and human-minute ceilings',
      actionHref: '/setup#budget',
      actionLabel: 'Set budget',
    },
    {
      id: 'ingested',
      label: 'First source receipt',
      status: ingested ? 'done' : config ? 'pending' : 'blocked',
      detail: ingested
        ? 'At least one source item became ledger evidence'
        : source.state === 'empty'
          ? 'Source is empty — add a file, then sync'
          : source.state === 'failed'
            ? 'Ingestion failed — inspect the source status below'
            : 'Run ingestion after configuring a source',
      actionHref: config && !ingested ? '/setup#sync' : undefined,
      actionLabel: config && !ingested ? 'Sync source' : undefined,
    },
    {
      id: 'workflow',
      label: 'First release workflow',
      status: workflowId ? 'done' : ingested ? 'pending' : 'blocked',
      detail: workflowId
        ? `Ship-to-Result workflow ${workflowId} is running`
        : ingested
          ? 'Start the governed release fan-out from your first evidence'
          : 'Available after the first source receipt succeeds',
      actionHref: ingested && !workflowId ? '/setup#workflow' : workflowId ? `/console/workflows/${encodeURIComponent(workflowId)}` : undefined,
      actionLabel: ingested && !workflowId ? 'Start release workflow' : workflowId ? 'Open workflow' : undefined,
    },
  ];

  const checklistComplete = checklist.every((item) => item.status === 'done');
  const signupAt = await metaGet(db, signupKey(tenant));
  const firstReviewAt = await metaGet(db, firstReviewKey(tenant));
  const timeToFirstReview =
    signupAt
      ? {
          signupAt,
          firstReviewAt,
          elapsedSeconds:
            firstReviewAt
              ? Math.max(0, Math.round((Date.parse(firstReviewAt) - Date.parse(signupAt)) / 1000))
              : Math.max(0, Math.round((Date.parse(now) - Date.parse(signupAt)) / 1000)),
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
  return {
    scope,
    sourceKind: 'files',
    sourcePath: resolve(sourcePath),
    artifactDir: resolve(artifactDir),
    accountableOwnerId: owner.id,
    approverRole,
    dailyBudgetDollars,
    humanMinutesBudget,
    configuredAt: now,
  };
}

export function testConfiguredSource(config: ActivationConfig) {
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
  if (!claim) throw new Error('no ingested evidence found — sync your source first');
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
    statement: 'SAMPLE ONLY — v0.1 adds export receipts (not customer evidence)',
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
    goal: 'SAMPLE WALKTHROUGH — draft launch copy from labeled demo evidence',
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

const STATUS_COLOR: Record<ChecklistStatus, string> = {
  done: '#0F7A3D',
  pending: '#B45309',
  blocked: '#6B7280',
};

const SOURCE_COLOR: Record<SourceConnectionState, string> = {
  unconfigured: '#6B7280',
  disabled: '#6B7280',
  syncing: '#4338CA',
  empty: '#B45309',
  delayed: '#B45309',
  rate_limited: '#4338CA',
  rejected: '#B91C1C',
  failed: '#B91C1C',
  ready: '#0F7A3D',
};

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
    ? `<p class="err">${esc(health.lastError.code)} — ${esc(health.lastError.detail)}</p>`
    : '';
  const inbox = `<div class="sub">inbox · pending ${health.inbox.pending} · claimed ${health.inbox.claimed} · done ${health.inbox.done} · failed ${health.inbox.failed}</div>`;
  return `${checkpoint}${freshness}${inbox}${err}<p class="sub">${esc(health.permissionNote)}</p><p class="sub">${esc(health.actionsNote)}</p>`;
}

export function renderActivationPanel(state: ActivationState, csrf: string, home: string): string {
  if (!state.showPanel) return '';
  const items = state.checklist
    .map((item) => {
      const action = item.actionHref && item.actionLabel
        ? ` <a href="${esc(item.actionHref)}">${esc(item.actionLabel)}</a>`
        : '';
      return `<li style="margin-bottom:10px">
<span style="display:inline-block;background:${STATUS_COLOR[item.status]};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">${esc(item.status)}</span>
<strong>${esc(item.label)}</strong> — ${esc(item.detail)}${action}
</li>`;
    })
    .join('');
  const receipt = state.firstReceipt
    ? `<div class="card"><div class="sub">first source item</div>
<div style="font-weight:700">${esc(state.firstReceipt.summary)}</div>
<div class="sub">status ${esc(state.firstReceipt.status)} · ${esc(state.firstReceipt.createdAt)}${state.firstReceipt.claimId ? ` · <a href="/console/claims/${esc(encodeURIComponent(state.firstReceipt.claimId))}">view evidence</a>` : ''}</div></div>`
    : '';
  const timing = state.timeToFirstReview
    ? `<p class="sub">Time since signup: ${esc(String(state.timeToFirstReview.elapsedSeconds ?? 0))}s${state.timeToFirstReview.firstReviewAt ? ` · first review after ${esc(String(state.timeToFirstReview.elapsedSeconds ?? 0))}s` : ' · awaiting first trustworthy review'}</p>`
    : '';
  const next = state.nextAction
    ? `<div class="card" style="border-color:#0F5C57"><div class="sub">next useful action</div>
<div style="font-size:20px;font-weight:800"><a href="${esc(state.nextAction.href)}">${esc(state.nextAction.label)}</a></div>
<p>${esc(state.nextAction.detail)}</p></div>`
    : '';
  const sample = state.sampleActive
    ? `<p class="sub">Sample walkthrough is active — evidence in scope <code>${esc(SAMPLE_SCOPE)}</code> is labeled demo data, not customer proof.</p>`
    : `<form method="post" action="/setup/sample" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" style="background:#6B7280">Run labeled sample walkthrough</button></form>`;
  return `<section id="activation-setup" style="margin-bottom:24px">
<h1>Organization setup</h1>
<p class="sub">Finish these steps to reach your first cited review without using the CLI. <a href="/setup">Open setup</a> · <a href="${esc(home)}">Dashboard</a></p>
${next}
<div class="card">
<div class="sub">source connection · <span style="color:${SOURCE_COLOR[state.sourceState]}">${esc(state.sourceState)}</span></div>
<p>${esc(state.sourceStateDetail)}</p>
${renderSourceHealthCard(state)}
${receipt}
</div>
<ol style="list-style:none;padding:0">${items}</ol>
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
    ? `<div class="card"><div class="sub">connection health · <span style="color:${SOURCE_COLOR[state.sourceState]}">${esc(state.sourceState)}</span></div>
<p>${esc(state.sourceStateDetail)}</p>
${renderSourceHealthCard(state)}</div>`
    : '';
  const syncForm = config
    ? `<section id="sync"><h2>Sync source</h2>
<p class="sub">Pull new or changed files from <code>${esc(config.sourcePath)}</code> into scope <code>${esc(config.scope)}</code>.</p>
<form method="post" action="/setup/test-source" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" style="background:#6B7280">Test connection</button></form>
<form method="post" action="/setup/ingest" style="display:inline;margin-left:8px"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Sync now</button></form>
<p class="sub">States: <strong>unconfigured</strong> · <strong>disabled</strong> · <strong>empty</strong> · <strong>delayed</strong> · <strong>rate_limited</strong> · <strong>syncing</strong> · <strong>ready</strong> · <strong>failed</strong> · <strong>rejected</strong></p>
</section>`
    : '';
  const workflowForm =
    config && state.sourceState === 'ready'
      ? `<section id="workflow"><h2>First release workflow</h2>
<p class="sub">Your first ingested evidence can start the Ship-to-Result fan-out.</p>
<form method="post" action="/setup/start-release"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Start release workflow</button></form></section>`
      : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Setup — organization activation</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#0A0F14;margin:0;padding:24px;max-width:720px}
form{display:grid;gap:10px}input,select{padding:8px;border:1px solid #E4E4E1;border-radius:6px}
button{padding:8px 14px;border:0;border-radius:6px;background:#0F5C57;color:#fff;font-weight:600;cursor:pointer}
.err{color:#B91C1C}.sub{color:#6B7280;font-size:12px}.card{border:1px solid #E4E4E1;border-radius:10px;padding:16px;background:#fff;margin:16px 0}</style>
</head><body>
<p class="sub"><a href="${esc(home)}">← Dashboard</a></p>
<h1>Guided setup</h1>
<p class="sub">Configure source, accountable human, scope, approval policy, and budget. Sample walkthrough data is always labeled and kept in scope <code>${esc(SAMPLE_SCOPE)}</code>.</p>
${msg}
${healthCard}
<form method="post" action="/setup">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<section id="accountable"><h2>Accountable human</h2>
<label>Owner <select name="accountableOwnerId" required>${ownerOptions}</select></label></section>
<section id="scope"><h2>Scope</h2>
<label>Release scope <input name="scope" required value="${esc(config?.scope ?? 'engineering')}" placeholder="engineering"></label></section>
<section id="source"><h2>Source directory</h2>
<label>Directory to watch <input name="sourcePath" required value="${esc(config?.sourcePath ?? '')}" placeholder="/path/to/changelog"></label>
<label>Artifact store <input name="artifactDir" value="${esc(config?.artifactDir ?? defaultArtifactDir(users[0]?.tenant ?? 'tenant'))}"></label></section>
<section id="policy"><h2>Approval policy</h2>
<label>Minimum approver role
<select name="approverRole">
<option value="member"${config?.approverRole === 'member' || !config ? ' selected' : ''}>member</option>
<option value="admin"${config?.approverRole === 'admin' ? ' selected' : ''}>admin</option>
<option value="owner"${config?.approverRole === 'owner' ? ' selected' : ''}>owner</option>
</select></label></section>
<section id="budget"><h2>Attention budget</h2>
<label>Daily dollars <input name="dailyBudgetDollars" type="number" min="1" step="1" value="${esc(String(config?.dailyBudgetDollars ?? 100))}"></label>
<label>Human minutes / day <input name="humanMinutesBudget" type="number" min="1" step="1" value="${esc(String(config?.humanMinutesBudget ?? 60))}"></label></section>
<button type="submit">Save setup</button>
</form>
${syncForm}
${workflowForm}
</body></html>`;
}
