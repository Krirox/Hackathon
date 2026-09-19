// Code review — the index that made the review page findable.
//
// `GET /console/review/:missionId` has existed since the per-mission human gate
// was built, and it is a substantial surface: side-by-side and inline diffs,
// hunk/file decisions, a secret scan, human edits, comments sent back to the
// agent, verification runs, and the snapshot binding. Nothing linked to it. A
// review document is keyed by mission (`review:<tenant>:<missionId>`) and no page
// ever listed those keys, so the only way in was to already know the id — which
// is the definition of an orphaned page.
//
// One route, two verbs:
//   GET  /console/review  — the list, plus the form that opens a review
//   POST /console/review  — open one (CSRF, session)
//
// The per-mission page stays on the legacy chain, deliberately. It is a large
// surface on its own and shares no branch with the index, so the route-table test
// pins the boundary rather than implying both moved. `action=open` on the POST is
// declared with a body policy rather than checked in the body: a mutating route
// whose token check lives in its handler is only reviewable by reading the whole
// handler.

import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import { listReviews, openReview } from '../../coding/review.ts';

export interface ReviewEnv {
  db: AsyncDb;
  tenant: string;
  /** Console base path. */
  home: string;
  /**
   * The shelled console page. Supplied by the server so this module owns no
   * chrome: it cannot drift from the rail, the top bar or the account cluster.
   */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean; drawer?: boolean },
  ): Promise<string>;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

/** Errors come back on the page the user was looking at, with the reason. */
function errorPath(base: string, message: string): string {
  return `${base}?notice=${encodeURIComponent(message.slice(0, 300))}`;
}

/**
 * The index. `notice` carries a failure from a POST back to the eye that caused
 * it, in the same place the review page shows its own errors.
 */
/**
 * A review's status as a badge. The status text itself is the label, so the
 * colour is a second channel rather than the only one — a reader who cannot
 * distinguish the tints still reads "REJECTED_ALL".
 */
const STATUS_TONE: Record<string, 'good' | 'warn' | 'risk'> = {
  COMPLETED: 'good',
  CHANGES_ACCEPTED: 'warn',
  CHANGES_REQUESTED: 'warn',
  AGENT_FIX: 'warn',
  REJECTED_ALL: 'risk',
};

function statusBadge(status: string): string {
  return `<span class="v-badge v-badge-${STATUS_TONE[status] ?? 'info'}">${esc(status)}</span>`;
}

function sinceLabel(at: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return esc(at);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function renderReviewIndexPage(
  reviews: {
    missionId: string;
    status: string;
    workdir: string;
    baselineRev: string;
    updatedAt: string;
    openComments: number;
  }[],
  opts: { csrf: string; notice?: string; now: string },
): string {
  const rows =
    reviews.length === 0
      ? `<div class="v-empty"><h3>No code reviews opened yet</h3><p>A review compares a working tree against a git baseline and gates the change behind hunk-by-hunk human decisions. Open one below.</p></div>`
      : `<div class="v-table-wrap"><table class="v-table"><thead><tr><th>Mission</th><th>Status</th><th>Baseline</th><th>Working tree</th><th>Comments</th><th>Updated</th></tr></thead><tbody>${reviews
          .map(
            (r) =>
              `<tr><td><a class="v-strong" href="/console/review/${esc(encodeURIComponent(r.missionId))}">${esc(r.missionId)}</a></td><td>${statusBadge(r.status)}</td><td><code class="v-code-pill">${esc(r.baselineRev)}</code></td><td><code class="v-code-pill">${esc(r.workdir)}</code></td><td class="v-num">${r.openComments > 0 ? `${r.openComments} open` : '—'}</td><td class="v-meta">${sinceLabel(r.updatedAt, opts.now)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;

  return `<div class="v-page-head">
<div>
<p class="v-eyebrow">Human gate</p>
<h1 class="v-page-title">Code review</h1>
<p class="v-lede">The diff between a working tree and a git baseline, decided hunk by hunk, with a secret scan, human edits, verification runs, and a snapshot binding.</p>
</div>
<a class="v-btn v-btn-secondary" href="/console/dashboard">Dashboard</a>
</div>
${opts.notice ? `<p class="sub" role="status">${esc(opts.notice)}</p>` : ''}
<div class="v-stack">
<section class="v-card v-card-flush">
<div style="padding:18px 22px 0">
<h2 class="v-card-title">Open reviews${reviews.length > 0 ? ` · ${reviews.length}` : ''}</h2>
<p class="v-lede">A review is keyed by mission id and recomputed from the repository on every load — decisions, comments and verification outcomes are what persist.</p>
</div>
${rows}
</section>
<section class="v-card">
<h2 class="v-card-title">Open a review</h2>
<p class="v-lede">Reuse a mission id to continue a review of the same change set; a new id starts a fresh gate. The working directory is read on this host, so it must exist on the server.</p>
<form method="post" action="/console/review" class="v-stack-sm" style="margin-top:14px">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="action" value="open">
<div class="v-fields">
<div class="v-field"><label class="v-field-label" for="review-mission">Mission id</label><input class="v-input" id="review-mission" name="missionId" required autocomplete="off" placeholder="mis_2026_09_ship-copy"></div>
<div class="v-field"><label class="v-field-label" for="review-workdir">Working directory</label><input class="v-input" id="review-workdir" name="workdir" required autocomplete="off" placeholder="/srv/checkout/repo"></div>
<div class="v-field"><label class="v-field-label" for="review-baseline">Baseline git rev</label><input class="v-input" id="review-baseline" name="baseline" value="HEAD" autocomplete="off"></div>
</div>
<div><button class="v-btn v-btn-primary" type="submit">Open review</button></div>
</form>
</section>
</div>`;
}

/** The manifest the route-table test pins, so a capability change is a test edit. */
export const REVIEW_CAPABILITIES: Record<string, { capability: string; surface: string }> = {
  'GET /console/review': { capability: 'session', surface: 'html' },
  'POST /console/review': { capability: 'session', surface: 'html' },
};

export function reviewRoutes(): RouteDef<ReviewEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/review',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Code-review index: every opened review for this tenant, plus the form that opens one. Session-only — a review binds a working tree on this host to tenant-scoped data.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        // One read for the request; the page is short-lived and showable as-is.
        const reviews = await listReviews(ctx.env.db, ctx.env.tenant);
        const body = renderReviewIndexPage(
          reviews.map((r) => ({
            missionId: r.missionId,
            status: r.status,
            workdir: r.workdir,
            baselineRev: r.baselineRev,
            updatedAt: r.updatedAt,
            openComments: r.comments.filter((c) => c.status !== 'resolved').length,
          })),
          {
            csrf: auth.session.csrfToken,
            notice: ctx.url.searchParams.get('notice') ?? undefined,
            now: ctx.at,
          },
        );
        ctx.res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
        ctx.res.end(await ctx.env.shellPage(auth, { title: 'Code review', navKey: 'review', hideHeader: true, body }));
      },
    },
    {
      method: 'POST',
      pattern: '/console/review',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      body: 'csrf',
      note: 'Open (or re-open) a code review for a mission id against a git baseline in a working directory on this host.',
      async handler(ctx) {
        // No session read here beyond the capability check the dispatcher did:
        // opening a review writes an audit row under the module's own actor, so
        // there is nothing on this path that needs the identity.
        const fields = ctx.call?.fields ?? {};
        if (fields.action !== 'open') {
          return redirect(ctx.res, errorPath('/console/review', `Unknown action "${fields.action ?? ''}".`));
        }
        const missionId = (fields.missionId ?? '').trim();
        const workdir = (fields.workdir ?? '').trim();
        const baseline = (fields.baseline ?? '').trim() || 'HEAD';
        if (!missionId) return redirect(ctx.res, errorPath('/console/review', 'A mission id is required.'));
        if (!workdir) return redirect(ctx.res, errorPath('/console/review', 'A working directory is required.'));
        // Refuse a directory that is not here. Opening a review whose tree cannot
        // be read would create a document that renders as an error forever, and a
        // permanent error page is worse than a refusal at the moment of asking.
        if (!existsSync(workdir)) {
          return redirect(
            ctx.res,
            errorPath('/console/review', `Working directory not readable on this host: ${workdir}`),
          );
        }
        try {
          // `openReview` writes its own REVIEW_READY audit entry, so there is no
          // second one here: the trail should have one row per act, not two.
          await openReview(ctx.env.db, ctx.env.tenant, missionId, baseline, workdir);
          return redirect(ctx.res, `/console/review/${encodeURIComponent(missionId)}`);
        } catch (e) {
          return redirect(ctx.res, errorPath('/console/review', (e as Error).message));
        }
      },
    },
  ];
}
