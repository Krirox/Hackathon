// The list surfaces — `/console/requests`, `/console/claims`, `/console/rooms`,
// `/console/human-work`.
//
// These four shared two dispatcher branches, and both branches opened with the
// same six lines copied: resolve the session, redirect an anonymous caller,
// reject a foreign tenant, refuse an un-activated account. Four pages agreeing by
// copy-paste is four places to get it wrong, and the drift is invisible because
// every copy looks locally correct.
//
// Here the six lines are gone: `capability: 'session'`, `surface: 'html'`,
// `activation: 'required'` and the dispatcher's tenant check cover all of it
// (see registry.ts and the dispatch block in serve.ts). What is left in each
// handler is the page.
//
// Rooms is included even though the request named three pages, because it shares
// a branch with human work: migrating one out of a shared branch would leave the
// other's authorisation depending on which branch happened to run first.
//
// Deliberately not here: `POST /api/requests/:id/approve|decline`. Those write a
// ledger decision inside a transaction, with duplicate-submission receipts and an
// operator-signature path. They are one reviewed change on their own, and the
// route-table test pins that boundary so "the lists moved" cannot be read as
// "approvals moved".

import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type Capability, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import type { Coordinator } from '../../coord/coordinator.ts';
import type { Ledger } from '../../ledger/ledger.ts';
import { atLeast, type Role } from '../../core/auth.ts';
import { statusChip } from '../components.ts';
import {
  claimDetailUrl,
  esc,
  renderListPage,
  renderListSection,
  renderTable,
  requestDetailUrl,
  withReturnTo,
} from '../render.ts';
import {
  clearFilterUrl,
  decodeListState,
  listStateUrl,
  noResultsModel,
  partitionRequestsByDecision,
  searchClaims,
  searchRequests,
} from '../report.ts';
import { renderReview } from '../review.ts';
import { roomHealth } from '../shell-reads.ts';
import { ROOM_CATEGORIES, ROOM_CATEGORY_LABELS } from '../../talk/rooms.ts';

export interface ListsEnv {
  /**
   * Present because these pages read the database directly (they render
   * inventories), not because the route layer needs it for anything else. Room
   * health is read through `shell-reads`, which memoizes it for the request, so
   * a page and the shell around it pay for one evaluation.
   */
  db: AsyncDb;
  tenant: string;
  /** Console base path. */
  home: string;
  coord: Coordinator;
  ledger: Ledger;
  /**
   * Role threshold for approving, from the server's configuration. It is read
   * from the environment rather than baked in because a tenant may raise it —
   * which is exactly why the tables below pass it to the review form instead of
   * assuming "a member may approve".
   */
  approverMin: Role;
  /** How operator authorisation reaches an approval: none, a secret, a signature. */
  operatorMode: 'session' | 'secret' | 'signature';
  /** Human-readable actor for an authenticated session. */
  actorOf(auth: AuthContext): string;
  actorLabel(auth: AuthContext): string;
  /**
   * The shelled console page. Supplied by the server so this module owns no
   * chrome: it cannot drift from the rail, the top bar or the account cluster.
   * `drawer` is the list-in-a-drawer rendering the detail links use.
   */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean; drawer?: boolean },
  ): Promise<string>;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE });
  res.end(JSON.stringify(body));
}

/** The return target a detail link carries, so its Back button keeps filters. */
function hereOf(ctx: { path: string; url: URL }): string {
  return ctx.path + (ctx.url.search || '');
}

export function listsRoutes(): RouteDef<ListsEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/requests',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Permissioned, paginated request index, grouped by decision state. Session-only: it names goals and scopes.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const state = decodeListState(ctx.url.search);
        const here = hereOf(ctx);
        try {
          const pageResult = await searchRequests(db, tenant, {
            q: state.q,
            states: state.states,
            scope: state.scopes?.[0],
            messageClass: state.messageClass,
            workflowId: state.workflowId,
            since: state.since,
            until: state.until,
            limit: state.limit,
            offset: state.offset,
          });
          const groups = partitionRequestsByDecision(pageResult.rows);
          const row = (r: { id: string; goal: string; state: string }): string[] => [
            `<a class="v-strong" href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.goal)}</a>`,
            `<span class="v-mono v-meta">${esc(r.id)}</span>`,
            statusChip(r.state),
          ];
          const REQUEST_COLUMNS = ['Request', 'ID', 'State'];
          const group = (heading: string, rows2: { id: string; goal: string; state: string }[]): string =>
            rows2.length === 0
              ? ''
              : renderListSection(
                  `${heading} (${rows2.length})`,
                  renderTable(REQUEST_COLUMNS, rows2.map(row)),
                );
          let body = '';
          if (pageResult.total === 0) {
            const model = noResultsModel('/console/requests', state);
            body = `<p class="sub">${esc(model.title)}: ${esc(model.body)} <a href="${esc(model.clearUrl)}">Clear search and filters</a></p>`;
          } else {
            body += group('Pending decision', groups.pending);
            body += group('Approved or executing', groups.active);
            body += group('Other states', groups.other);
            if (pageResult.truncated)
              body += `<p class="sub">explicit truncation: showing ${pageResult.rows.length} of ${pageResult.total} matching requests</p>`;
          }
          const prev =
            pageResult.offset > 0
              ? listStateUrl('/console/requests', {
                  ...state,
                  offset: Math.max(0, pageResult.offset - pageResult.limit),
                })
              : null;
          const next = pageResult.hasMore
            ? listStateUrl('/console/requests', { ...state, offset: pageResult.offset + pageResult.rows.length })
            : null;
          sendHtml(
            ctx.res,
            await ctx.env.shellPage(auth, {
              title: 'Requests',
              navKey: 'requests',
              hideHeader: true,
              drawer: ctx.url.searchParams.get('drawer') === '1',
              body: renderListPage({
                title: 'Requests',
                heading: 'Requests',
                searchAction: '/console/requests',
                query: state.q ?? '',
                total: pageResult.total,
                truncated: pageResult.truncated,
                shown: pageResult.rows.length,
                prevUrl: prev,
                nextUrl: next,
                clearUrl: clearFilterUrl('/console/requests'),
                body,
              }),
            }),
          );
        } catch (e) {
          // Unchanged from the legacy branch: a bad filter is the caller's, so it
          // answers 400 rather than rendering an error page.
          sendJson(ctx.res, 400, { ok: false, error: (e as Error).message });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/console/claims',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Permissioned, paginated claim index with its filters. Session-only: claims are tenant evidence.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const state = decodeListState(ctx.url.search);
        const here = hereOf(ctx);
        try {
          const pageResult = await searchClaims(db, tenant, {
            q: state.q,
            kinds: state.kinds,
            statuses: state.statuses,
            scope: state.scopes?.[0],
            since: state.since,
            until: state.until,
            limit: state.limit,
            offset: state.offset,
          });
          let body: string;
          if (pageResult.total === 0) {
            const model = noResultsModel('/console/claims', state);
            body = `<p class="sub">${esc(model.title)}: ${esc(model.body)} <a href="${esc(model.clearUrl)}">Clear search and filters</a></p>`;
          } else {
            body =
              renderTable(
                ['Subject', 'ID', 'Kind', 'Status'],
                pageResult.rows.map((c) => [
                  `<a class="v-strong" href="${esc(withReturnTo(claimDetailUrl(c.id), here))}">${esc(c.subject)}</a>`,
                  `<span class="v-mono v-meta">${esc(c.id)}</span>`,
                  `<span class="v-badge">${esc(c.kind)}</span>`,
                  statusChip(c.status),
                ]),
              ) +
              (pageResult.truncated
                ? `<p class="v-meta">explicit truncation: showing ${pageResult.rows.length} of ${pageResult.total} matching claims</p>`
                : '');
          }
          const prev =
            pageResult.offset > 0
              ? listStateUrl('/console/claims', {
                  ...state,
                  offset: Math.max(0, pageResult.offset - pageResult.limit),
                })
              : null;
          const next = pageResult.hasMore
            ? listStateUrl('/console/claims', { ...state, offset: pageResult.offset + pageResult.rows.length })
            : null;
          sendHtml(
            ctx.res,
            await ctx.env.shellPage(auth, {
              title: 'Claims',
              navKey: 'claims',
              hideHeader: true,
              drawer: ctx.url.searchParams.get('drawer') === '1',
              body: renderListPage({
                title: 'Claims',
                heading: 'Claims',
                searchAction: '/console/claims',
                query: state.q ?? '',
                total: pageResult.total,
                truncated: pageResult.truncated,
                shown: pageResult.rows.length,
                prevUrl: prev,
                nextUrl: next,
                clearUrl: clearFilterUrl('/console/claims'),
                body,
              }),
            }),
          );
        } catch (e) {
          sendJson(ctx.res, 400, { ok: false, error: (e as Error).message });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/console/rooms',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Every room with its own category, status, pending approvals and budget use. Session-only: it is the tenant\u2019s org chart of agents.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const state = decodeListState(ctx.url.search);
        const here = hereOf(ctx);
        const limit =
          state.limit !== undefined && Number.isSafeInteger(state.limit) && state.limit > 0
            ? Math.min(state.limit, 100)
            : 20;
        const offset =
          state.offset !== undefined && Number.isSafeInteger(state.offset) && state.offset >= 0 ? state.offset : 0;
        const q = (state.q ?? '').trim().toLowerCase();
        // The rooms page lists ROOMS, not whichever scopes happen to appear
        // in requests. Deriving it from `requests` hid any room with no
        // traffic and stripped every room of its category — the grouping the
        // chat roster no longer displays. `evaluateAll` returns every
        // canonical and custom room with its own category, so this page can
        // carry that grouping instead of a flat list of derived strings.
        const evaluations = await roomHealth(db, tenant);
        let roomRows = evaluations.map((e) => ({
          scope: e.scope,
          roomName: e.roomName,
          category: e.category,
          status: e.status,
          pending: e.pendingApprovals,
          budget: e.budgetPercentage,
          stops: e.activeStops,
        }));
        if (q) {
          roomRows = roomRows.filter((r) => `${r.roomName} ${r.scope}`.toLowerCase().includes(q));
        }
        // Stable order regardless of evaluation order: category, then name.
        const categoryRank = new Map(ROOM_CATEGORIES.map((c, i) => [c, i] as const));
        roomRows.sort(
          (a, b) =>
            (categoryRank.get(a.category) ?? ROOM_CATEGORIES.length) -
              (categoryRank.get(b.category) ?? ROOM_CATEGORIES.length) ||
            a.roomName.localeCompare(b.roomName),
        );
        const total = roomRows.length;
        const pageRooms = roomRows.slice(offset, offset + limit);
        const roomUrl = (scope: string) =>
          scope === 'infra' ? '/console/buzz/engineering' : `/console/buzz/${encodeURIComponent(scope)}`;
        const roomRow = (r: (typeof roomRows)[number]) => [
          `<a class="v-strong" href="${esc(roomUrl(r.scope))}">#${esc(r.roomName)}</a>`,
          `<span class="v-mono v-meta">${esc(r.scope)}</span>`,
          `<a href="${esc(`/console/requests?scope=${encodeURIComponent(r.scope)}&return=${encodeURIComponent(here)}`)}" class="v-meta">${statusChip(r.status)}</a>`,
          r.pending > 0
            ? `<span class="v-badge v-badge-risk"><span class="dot"></span>${r.pending} waiting</span>`
            : '<span class="v-meta">—</span>',
          r.stops > 0
            ? `<span class="v-badge v-badge-risk"><span class="dot"></span>${r.stops} stop${r.stops === 1 ? '' : 's'}</span>`
            : '<span class="v-meta">—</span>',
          `<span class="v-num v-meta">${Math.round(r.budget)}%</span>`,
        ];
        // Group the current page by category, in the canonical order.
        const roomGroups = ROOM_CATEGORIES.map((category) => {
          const inGroup = pageRooms.filter((r) => r.category === category);
          if (inGroup.length === 0) return '';
          return `<section class="v-list-group">
<h2>${esc(ROOM_CATEGORY_LABELS[category])}<span class="v-meta" style="font-weight:500;">${inGroup.length} room${inGroup.length === 1 ? '' : 's'}</span></h2>
${renderTable(['Room', 'Scope', 'Status', 'Pending', 'Stops', 'Budget used'], inGroup.map(roomRow))}
</section>`;
        })
          .filter(Boolean)
          .join('');
        const body =
          total === 0
            ? `<p class="sub">No results: no rooms match this search. <a href="${esc(clearFilterUrl('/console/rooms'))}">Clear search and filters</a></p>`
            : roomGroups +
              (offset + pageRooms.length < total
                ? `<p class="v-meta">explicit truncation: showing ${pageRooms.length} of ${total} rooms</p>`
                : '');
        const prev =
          offset > 0 ? listStateUrl('/console/rooms', { ...state, offset: Math.max(0, offset - limit) }) : null;
        const next =
          offset + pageRooms.length < total
            ? listStateUrl('/console/rooms', { ...state, offset: offset + pageRooms.length })
            : null;
        sendHtml(
          ctx.res,
          await ctx.env.shellPage(auth, {
            title: 'Rooms',
            navKey: 'rooms',
            hideHeader: true,
            body: renderListPage({
              title: 'Rooms',
              heading: 'Rooms',
              searchAction: '/console/rooms',
              query: state.q ?? '',
              total,
              truncated: offset + pageRooms.length < total,
              shown: pageRooms.length,
              prevUrl: prev,
              nextUrl: next,
              clearUrl: clearFilterUrl('/console/rooms'),
              body,
            }),
          }),
        );
      },
    },
    {
      method: 'GET',
      pattern: '/console/human-work',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'The approval queue plus the inventory of work that consumed human minutes. Session-only because members may approve unless the tenant raised the threshold.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { tenant } = ctx.env;
        const state = decodeListState(ctx.url.search);
        const here = hereOf(ctx);
        const limit =
          state.limit !== undefined && Number.isSafeInteger(state.limit) && state.limit > 0
            ? Math.min(state.limit, 100)
            : 20;
        const offset =
          state.offset !== undefined && Number.isSafeInteger(state.offset) && state.offset >= 0 ? state.offset : 0;
        const q = (state.q ?? '').trim().toLowerCase();
        const all = await ctx.env.coord.list(tenant);
        const terminal = new Set(['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED']);
        let work = all.filter(
          (r) => r.messageClass === 'REQUEST' && r.bid.humanMinutes > 0 && !terminal.has(r.state),
        );
        if (q) work = work.filter((r) => `${r.goal} ${r.id}`.toLowerCase().includes(q));
        work.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const total = work.length;
        const pageWork = work.slice(offset, offset + limit);
        // The approval queue belongs on this page, not only on the legacy
        // dashboard chrome. "Human work" is where a person is asked to decide,
        // and a page that says "Pending human review" without offering Approve
        // or Decline is a dead end. renderReview already owns the request
        // approval contract (csrf, requestUpdatedAt optimistic locking, the
        // explicit `confirmed` checkbox, decline reason, operator fields), so
        // this reuses it rather than inventing a second approval path.
        const approvalQueue = await renderReview(ctx.env.coord, ctx.env.ledger, {
          tenant,
          actor: ctx.env.actorOf(auth),
          actorLabel: ctx.env.actorLabel(auth),
          csrf: auth.session.csrfToken,
          canApprove: atLeast(auth.user.role, ctx.env.approverMin),
          requiredRole: ctx.env.approverMin,
          operatorMode: ctx.env.operatorMode,
          home: ctx.env.home,
        });
        const body =
          total === 0
            ? `<p class="sub">No results: no human work matches this search. <a href="${esc(clearFilterUrl('/console/human-work'))}">Clear search and filters</a></p>`
            : renderTable(
                ['Work', 'ID', 'State'],
                pageWork.map((r) => [
                  `<a class="v-strong" href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.goal)}</a>`,
                  `<span class="v-mono v-meta">${esc(r.id)}</span>`,
                  statusChip(r.state),
                ]),
              ) +
              (offset + pageWork.length < total
                ? `<p class="v-meta">explicit truncation: showing ${pageWork.length} of ${total} items</p>`
                : '');
        const prev =
          offset > 0 ? listStateUrl('/console/human-work', { ...state, offset: Math.max(0, offset - limit) }) : null;
        const next =
          offset + pageWork.length < total
            ? listStateUrl('/console/human-work', { ...state, offset: offset + pageWork.length })
            : null;
        // The page is the approval queue plus the inventory behind it, so its
        // title names the job (decide) rather than the row type (human work).
        sendHtml(
          ctx.res,
          await ctx.env.shellPage(auth, {
            title: 'Approvals',
            navKey: 'approvals',
            hideHeader: true,
            body: renderListPage({
              title: 'Approvals',
              heading: 'Approvals',
              searchAction: '/console/human-work',
              query: state.q ?? '',
              total,
              truncated: offset + pageWork.length < total,
              shown: pageWork.length,
              prevUrl: prev,
              nextUrl: next,
              clearUrl: clearFilterUrl('/console/human-work'),
              // Queue first — the decision is the point of the page; the table
              // below is the full inventory of work that touched human minutes.
              body: `${approvalQueue}${approvalQueue ? '<p class="v-eyebrow" style="margin:22px 0 8px;">All human work</p>' : ''}${body}`,
            }),
          }),
        );
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const LISTS_CAPABILITIES: Record<
  string,
  { capability: Capability; surface: 'api' | 'html' }
> = {
  'GET /console/requests': { capability: 'session', surface: 'html' },
  'GET /console/claims': { capability: 'session', surface: 'html' },
  'GET /console/rooms': { capability: 'session', surface: 'html' },
  'GET /console/human-work': { capability: 'session', surface: 'html' },
};
