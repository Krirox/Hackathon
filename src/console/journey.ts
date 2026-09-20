// First-run tenant journey — the north-star loop from Final_TODO:
//   signup → setup → first source → approval → deliverable → measured outcome.
//
// Honesty rule: every milestone is derived from a durable record that the
// corresponding flow already writes (meta keys, claims, decisions, outcomes,
// deliverable versions). Nothing here fabricates progress: a tenant that has
// only signed up shows one done milestone and five "not yet". No stage is
// simulated, and timestamps are the records' own.

import type { AsyncDb } from '../core/db.ts';
import { firstReviewAt, loadActivationConfig, signupAt, SAMPLE_SCOPE } from './activation.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type JourneyStageId = 'signup' | 'setup' | 'source' | 'approval' | 'deliverable' | 'outcome';

export interface JourneyStage {
  id: JourneyStageId;
  label: string;
  /** ISO timestamp of the durable record, when the stage is done. */
  at: string | null;
  /** Where to go to advance past this stage, when an in-product path exists. */
  href: string | null;
  detail: string;
}

export interface TenantJourney {
  tenant: string;
  stages: JourneyStage[];
  /** Index of the first not-done stage (null when the loop is closed). */
  currentIndex: number | null;
  /** Set once the measured outcome exists — the north-star loop is closed. */
  completedAt: string | null;
}

interface OutcomeRow {
  metric: string;
  predicted: number | null;
  actual: number | null;
  basis: string;
  resolved_at: string | null;
  created_at: string;
}

const DASH = 'n/a';

function fmtWhen(iso: string | null): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return DASH;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtElapsed(fromIso: string, toIso: string): string {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return DASH;
  let s = Math.floor((to - from) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const sec = s - m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function count(db: AsyncDb, sql: string, ...params: (string | number)[]): Promise<number> {
  const row = (await db.prepare(sql).get(...params)) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Latest measured outcome row, or null when nothing has been measured. */
async function latestOutcomeRow(db: AsyncDb, tenant: string): Promise<OutcomeRow | null> {
  const row = (await db
    .prepare(
      `SELECT metric, predicted, actual, basis, resolved_at, created_at
       FROM outcomes WHERE tenant = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(tenant)) as OutcomeRow | undefined;
  return row ?? null;
}

/** Creation time of the tenant's first user — durable record of tenant birth. */
async function firstUserCreatedAt(db: AsyncDb, tenant: string): Promise<string | null> {
  const row = (await db.prepare('SELECT MIN(created_at) AS n FROM users WHERE tenant = ?').get(tenant)) as
    { n: string | null } | undefined;
  return row?.n ? String(row.n) : null;
}

/** Earliest deliverable-version creation time for the tenant, or null. */
async function firstDeliverableAt(db: AsyncDb, tenant: string): Promise<string | null> {
  const rows = (await db
    .prepare('SELECT value FROM meta WHERE key LIKE ? ORDER BY key ASC LIMIT 500')
    .all(`wedge:deliverable-ver:${tenant}:%`)) as { value: string }[];
  let earliest: string | null = null;
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as { createdAt?: unknown };
      if (typeof v.createdAt === 'string' && (earliest === null || v.createdAt < earliest)) {
        earliest = v.createdAt;
      }
    } catch {
      continue; // unreadable records are skipped, never invented
    }
  }
  return earliest;
}

export async function buildTenantJourney(db: AsyncDb, tenant: string, _now: string): Promise<TenantJourney> {
  // Stage 1 — signup: the web flow records `activation:signupAt`; tenants
  // created via the CLI fall back to the first user row (also durable).
  const signedUpAt = (await signupAt(db, tenant)) ?? (await firstUserCreatedAt(db, tenant));

  // Stage 2 — setup: an ActivationConfig exists (written by /setup POST).
  //
  // Read through activation.ts rather than re-parsing the same key here: two
  // readers of one record meant two SQL statements and two JSON.parse shapes to
  // keep in step. `loadActivationConfig` is request-memoized, so the dashboard's
  // activation panel and this journey share one read. A config that will not
  // parse still renders as not-done, never as guessed data.
  const activationConfig = await loadActivationConfig(db, tenant);
  const configuredAt: string | null = activationConfig?.configuredAt ?? null;
  const setupHref =
    activationConfig && activationConfig.scope !== ''
      ? `/console/buzz/${encodeURIComponent(activationConfig.scope)}`
      : '/setup';

  // Stage 3 — first source: real ingested evidence, excluding the labeled
  // sample walkthrough scope (mirrors ingestClaimCount in activation.ts).
  const sourceWhere = `tenant = ? AND scope <> ? AND extractor IN ('file-diff', 'github-releases')`;
  const sourceCount = await count(db, `SELECT COUNT(*) AS n FROM claims WHERE ${sourceWhere}`, tenant, SAMPLE_SCOPE);
  let firstSourceAt: string | null = null;
  if (sourceCount > 0) {
    const row = (await db
      .prepare(`SELECT created_at FROM claims WHERE ${sourceWhere} ORDER BY created_at ASC LIMIT 1`)
      .get(tenant, SAMPLE_SCOPE)) as { created_at: string } | undefined;
    firstSourceAt = row ? String(row.created_at) : null;
  }

  // Stage 4 — approval: the first human decision, recorded by the review flow.
  const reviewedAt = await firstReviewAt(db, tenant);

  // Stage 5 — deliverable: a versioned deliverable exists (wedge or review flow).
  const deliverableCount = await count(
    db,
    "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'wedge:deliverable-ver:%' AND key LIKE ?",
    `wedge:deliverable-ver:${tenant}:%`,
  );
  const firstDeliverable = deliverableCount > 0 ? await firstDeliverableAt(db, tenant) : null;

  // Stage 6 — measured outcome: a verified outcome row against a decision.
  const outcome = await latestOutcomeRow(db, tenant);
  const outcomeAt = outcome ? (outcome.resolved_at ?? outcome.created_at) : null;

  const stages: JourneyStage[] = [
    {
      id: 'signup',
      label: 'Signup',
      at: signedUpAt,
      href: signedUpAt ? null : '/signup',
      detail: signedUpAt ? `Organization claimed ${fmtWhen(signedUpAt)}` : 'Claim this console at /signup',
    },
    {
      id: 'setup',
      label: 'Setup',
      at: configuredAt,
      href: configuredAt ? setupHref : '/setup',
      detail: configuredAt
        ? `Activation configured ${fmtWhen(configuredAt)}`
        : 'Configure accountable human, scope, source, policy, and budget',
    },
    {
      id: 'source',
      label: 'First source',
      at: firstSourceAt,
      href: configuredAt ? '/setup#sync' : '/setup',
      detail: firstSourceAt
        ? `First ingested evidence ${fmtWhen(firstSourceAt)} (${sourceCount} receipt claim(s))`
        : 'Sync a changelog or release-notes source into the ledger',
    },
    {
      id: 'approval',
      label: 'Approval',
      at: reviewedAt,
      href: '/console/requests',
      detail: reviewedAt ? `First human review ${fmtWhen(reviewedAt)}` : 'Review and approve your first request',
    },
    {
      id: 'deliverable',
      label: 'Deliverable',
      at: firstDeliverable,
      // A deliverable is drafted from an admitted request, and there is no
      // deliverable index — /console/deliverables never existed, so this
      // milestone used to link into a 404.
      href: '/console/requests',
      detail:
        firstDeliverable !== null
          ? `First versioned deliverable ${fmtWhen(firstDeliverable)} (${deliverableCount} version(s))`
          : 'Produce a versioned deliverable from an admitted request',
    },
    {
      id: 'outcome',
      label: 'Measured outcome',
      at: outcomeAt,
      // Pre-registration and outcome capture both live on the release
      // workspace. /console/report was the legacy CLI report and has no route.
      href: '/console/workflows',
      detail: outcome
        ? `${outcome.metric}: predicted ${outcome.predicted ?? DASH} → actual ${outcome.actual ?? DASH} (${outcome.basis})`
        : 'Capture a measured outcome against the pre-registered basis',
    },
  ];

  const currentIndex = stages.findIndex((s) => s.at === null);
  return {
    tenant,
    stages,
    currentIndex: currentIndex === -1 ? null : currentIndex,
    completedAt: outcomeAt,
  };
}

function whenFor(at: string | null, current: boolean): string {
  if (at !== null) return fmtWhen(at);
  if (current) return 'up next';
  return 'not yet';
}

function markerFor(done: boolean, current: boolean): string {
  if (done) return '✓';
  if (current) return '→';
  return '·';
}

function colorFor(done: boolean, current: boolean): string {
  if (done) return 'var(--v-fact)';
  if (current) return 'var(--v-accent)';
  return 'var(--v-faint)';
}

function headlineFor(journey: TenantJourney, signedUp: string | null): string {
  if (journey.completedAt !== null && signedUp !== null) {
    return `Journey closed in ${fmtElapsed(signedUp, journey.completedAt)}; measured outcome recorded ${fmtWhen(journey.completedAt)}.`;
  }
  if (journey.completedAt !== null) {
    return `Measured outcome recorded ${fmtWhen(journey.completedAt)}.`;
  }
  if (journey.currentIndex === null) return 'All milestones recorded.';
  return `Next: ${esc(journey.stages[journey.currentIndex]!.label)}.`;
}

export function renderJourneyMilestone(journey: TenantJourney, home: string): string {
  const signedUp = journey.stages[0]!.at;
  const doneCount = journey.stages.filter((s) => s.at !== null).length;
  const items = journey.stages
    .map((s, i) => {
      const done = s.at !== null;
      const current = journey.currentIndex === i;
      const marker = markerFor(done, current);
      const color = colorFor(done, current);
      const weight = current ? '700' : '600';
      const label = s.href ? `<a href="${esc(s.href)}" style="color:var(--v-ink);text-decoration:none;">${esc(s.label)}</a>` : esc(s.label);
      const when = whenFor(s.at, current);
      const elapsed =
        done && signedUp !== null && s.at !== null && s.id !== 'signup'
          ? ` · +${fmtElapsed(signedUp, s.at)} from signup`
          : '';
      let markerBg = 'var(--v-bg-2)';
      if (done) markerBg = 'var(--v-tint-good-bg)';
      else if (current) markerBg = 'var(--v-accent-dim)';

      return `<li style="display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:14px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--v-line);">
<span aria-hidden="true" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:11.5px;font-weight:700;background:${markerBg};color:${color};flex-shrink:0;margin-top:1px;">${marker}</span>
<span style="min-width:0;"><span style="font-weight:${weight};font-size:13.5px;color:var(--v-ink);">${label}</span><br><span class="v-sub" style="font-size:12px;color:var(--v-muted);line-height:1.45;margin-top:2px;display:inline-block;">${esc(s.detail)}${elapsed}</span></span>
<span class="v-meta" style="white-space:nowrap;font-size:12px;color:var(--v-faint);">${esc(when)}</span>
</li>`;
    })
    .join('');

  const headline = headlineFor(journey, signedUp);

  return `<section id="tenant-journey" class="v-card" style="margin-bottom:20px;padding:22px 24px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
<div class="v-split" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
  <div>
    <p class="v-eyebrow" style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.09em;color:var(--v-muted);">First-run journey</p>
    <h2 class="v-card-title" style="margin-top:4px;font-size:17px;font-weight:650;color:var(--v-ink);">${doneCount} of ${journey.stages.length} milestones recorded</h2>
  </div>
  <div style="display:flex;gap:8px;">
    <a href="${esc(home)}console/requests" class="v-btn v-btn-secondary" style="display:inline-flex;align-items:center;padding:6px 14px;border-radius:9999px;font-size:12px;font-weight:500;text-decoration:none;border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2);">Review queue</a>
    <a href="/setup" class="v-btn v-btn-secondary" style="display:inline-flex;align-items:center;padding:6px 14px;border-radius:9999px;font-size:12px;font-weight:500;text-decoration:none;border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2);">Setup</a>
  </div>
</div>
<p class="v-sub" style="font-size:12.5px;color:var(--v-muted);margin-bottom:10px;">Signup → setup → first source → approval → deliverable → measured outcome. Every milestone is a durable record. Nothing is simulated.</p>
<div style="height:6px;background:var(--v-line);border-radius:9999px;overflow:hidden;margin-bottom:12px;">
  <div style="height:100%;width:${Math.round((doneCount / journey.stages.length) * 100)}%;background:var(--v-fact);border-radius:9999px;transition:width .3s ease;"></div>
</div>
<ol style="list-style:none;padding:0;margin:0;">${items}</ol>
<p class="v-sub" style="margin-top:14px;font-size:12px;color:var(--v-muted);">${headline}</p>
</section>`;
}
