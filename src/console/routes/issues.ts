// Issues — the engineering board's request handling.
//
// Eight routes, one capability: `engineer`. Every one of them gates on
// *department* (`team === 'engineering'`), never on role — a marketing admin is
// refused and an engineering member is admitted, which is the distinction the
// `engineer` capability exists to express. The policy itself lives in
// routes/registry.ts; this module only says which routes want it.
//
// The board is a Console surface, so it renders through `shellPage`, the one
// console chrome. It used to be wrapped in the Workspace (chat) shell under the
// `buzz` nav key, and that had one consequence nobody intended: the chat shell
// deliberately injects no Console tokens (`wrapInWorkspaceShell` says so — the
// point is that restyling the Console can never re-font the chat), while every
// rule in ../issues.ts is written against `var(--v-*)`. On the chat path those
// variables are undefined, so the board's own stylesheet resolved to nothing,
// and the rail highlighted Chat while you were reading Issues.
//
// Not here yet: the GitHub link/unlink sub-surface. Its webhook is called by
// GitHub itself, anonymously, when a repo is linked — a capability that depends
// on tenant state rather than on the caller, which one declared value cannot
// state. It stays on the legacy chain behind the same `isEngineer` check until
// that question is answered on purpose.

import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type Capability, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import { isEngineer, listUsers } from '../../core/auth.ts';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  addComment,
  createIssue,
  deleteIssue,
  getGitHubPushError,
  getGitHubSyncConfig,
  getIssue,
  listComments,
  listIssues,
  moveIssue,
  pushCommentToGitHub,
  pushCreateToGitHub,
  pushDeleteToGitHub,
  pushUpdateToGitHub,
  renderIssuesBoard,
  syncIssues,
  updateIssue,
  type IssuePriority,
  type IssueState,
} from '../issues.ts';

export interface IssuesEnv {
  db: AsyncDb;
  tenant: string;
  home: string;
  /** The shelled console page — supplied by the server so this owns no chrome. */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean },
  ): Promise<string>;
  /** Append one console audit entry (the server owns the writer). */
  audit(actor: string, action: string, target: string, at: string, detail?: string): Promise<void>;
  /**
   * Fire-and-forget outbound GitHub push. The human's write already succeeded
   * and GitHub's latency is not theirs to wait on, but a failure must not
   * vanish: the server's implementation records it against the sync config and
   * audits it. Injected rather than reimplemented here so there is one policy.
   */
  pushAfterLocalWrite(
    kind: string,
    target: string,
    actor: string,
    run: () => Promise<{ ok: boolean; error?: string }>,
  ): void;
  /** The acting user rendered the way every console write renders it. */
  actorOf(auth: AuthContext): string;
  /** Outbound fetch for pushes; injectable so a test can drive a failure. */
  fetchFn: typeof fetch;
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

/**
 * The board's one error shape. A `STALE_WRITE` is a 409 — the row moved under
 * the writer, which is a retryable conflict and not a bad request — and the
 * store's `[issues:…]` prefix is stripped so the caller sees the reason rather
 * than the module path.
 */
function failure(res: ServerResponse, e: unknown): void {
  const raw = (e as Error).message;
  sendJson(res, raw.includes('STALE_WRITE') ? 409 : 400, {
    ok: false,
    error: raw.replace(/^\[issues:[^\]]+\]\s*/, ''),
  });
}

/** Who the board may assign to: engineers, and nobody else. */
async function engineerList(db: AsyncDb, tenant: string): Promise<{ email: string; name: string }[]> {
  return (await listUsers(db, tenant))
    .filter((u) => isEngineer(u) && !u.disabled)
    .map((u) => ({ email: u.email, name: u.name }));
}

export function issuesRoutes(): RouteDef<IssuesEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/issues',
      capability: 'engineer',
      surface: 'html',
      activation: 'required',
      denied: {
        title: 'Issues',
        message: 'The Issues board is available to the engineering team only.',
        navKey: 'issues',
      },
      note: 'Engineering kanban over the `issues` table. Department-gated: owners on other teams are refused.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const snapshot = await listIssues(db, tenant);
        const body = renderIssuesBoard(snapshot, {
          csrf: auth.session.csrfToken,
          home: ctx.env.home,
          engineers: await engineerList(db, tenant),
          currentEmail: auth.user.email,
          syncConfig: await getGitHubSyncConfig(db, tenant),
          pushError: await getGitHubPushError(db, tenant),
        });
        sendHtml(ctx.res, await ctx.env.shellPage(auth, { title: 'Issues', navKey: 'issues', hideHeader: true, body }));
      },
    },
    {
      method: 'GET',
      pattern: '/console/issues/sync',
      capability: 'engineer',
      surface: 'api',
      activation: 'required',
      note: 'Delta sync for the board: issues changed since `?since=`. Department-gated JSON.',
      async handler(ctx) {
        const since = ctx.url.searchParams.get('since');
        const snapshot = since
          ? await syncIssues(ctx.env.db, ctx.env.tenant, since)
          : await listIssues(ctx.env.db, ctx.env.tenant);
        sendJson(ctx.res, 200, { ok: true, snapshot });
      },
    },
    {
      method: 'GET',
      pattern: '/console/issues/detail',
      capability: 'engineer',
      surface: 'api',
      activation: 'required',
      note: 'One issue plus its comment thread: the payload a card opens with. Department-gated JSON.',
      async handler(ctx) {
        const id = (ctx.url.searchParams.get('id') ?? '').slice(0, 64);
        const issue = id ? await getIssue(ctx.env.db, ctx.env.tenant, id) : null;
        if (!issue) {
          sendJson(ctx.res, 404, { ok: false, error: 'no such issue' });
          return;
        }
        const comments = await listComments(ctx.env.db, ctx.env.tenant, issue.id);
        sendJson(ctx.res, 200, { ok: true, issue, comments });
      },
    },
    {
      method: 'POST',
      pattern: '/console/issues/create',
      capability: 'engineer',
      surface: 'api',
      body: 'csrf',
      activation: 'required',
      note: 'Create an issue. Department-gated, CSRF-checked, audited, pushed to GitHub if linked.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const fields = ctx.call?.fields ?? {};
        try {
          // Labels arrive as a JSON array from the board's own JS and as a
          // comma-separated field from the plain form; both are real callers.
          const rawLabels = (ctx.call?.json?.labels ?? fields.labels) as unknown;
          let labelList: string[] | undefined;
          if (Array.isArray(rawLabels)) {
            labelList = rawLabels.map((l) => String(l));
          } else if (typeof rawLabels === 'string' && rawLabels.trim()) {
            labelList = rawLabels
              .split(/[,;]+/)
              .map((l) => l.trim())
              .filter(Boolean);
          }
          const issue = await createIssue(
            db,
            tenant,
            {
              title: String(fields.title ?? ''),
              description: String(fields.description ?? ''),
              state: ISSUE_STATES.includes(String(fields.state ?? '') as IssueState)
                ? (String(fields.state) as IssueState)
                : undefined,
              priority: ISSUE_PRIORITIES.includes(String(fields.priority ?? '') as IssuePriority)
                ? (String(fields.priority) as IssuePriority)
                : undefined,
              labels: labelList,
              assigneeEmail: String(fields.assigneeEmail ?? '') || null,
            },
            { userId: auth.user.id, email: auth.user.email },
            ctx.at,
          );
          await ctx.env.audit(
            ctx.env.actorOf(auth),
            'issues.create',
            `issue:${issue.id}`,
            ctx.at,
            issue.title.slice(0, 120),
          );
          ctx.env.pushAfterLocalWrite('issue.create', `issue:${issue.id}`, ctx.env.actorOf(auth), () =>
            pushCreateToGitHub(db, tenant, issue, { fetchFn: ctx.env.fetchFn }),
          );
          sendJson(ctx.res, 200, { ok: true, issue });
        } catch (e) {
          failure(ctx.res, e);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/console/issues/move',
      capability: 'engineer',
      surface: 'api',
      body: 'csrf',
      activation: 'required',
      note: 'Move a card to a state, optionally anchored between two neighbours. Department-gated, CSRF-checked.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const fields = ctx.call?.fields ?? {};
        try {
          const id = String(fields.issueId ?? '').slice(0, 64);
          const state = String(fields.state ?? '');
          if (!ISSUE_STATES.includes(state as IssueState)) {
            sendJson(ctx.res, 400, { ok: false, error: 'unknown state' });
            return;
          }
          const issue = await moveIssue(
            db,
            tenant,
            id,
            {
              state: state as IssueState,
              beforeId: String(fields.beforeId ?? '') || null,
              afterId: String(fields.afterId ?? '') || null,
            },
            ctx.at,
          );
          if (!issue) {
            sendJson(ctx.res, 404, { ok: false, error: 'no such issue' });
            return;
          }
          await ctx.env.audit(
            ctx.env.actorOf(auth),
            'issues.move',
            `issue:${issue.id}`,
            ctx.at,
            `state=${issue.state}`,
          );
          ctx.env.pushAfterLocalWrite('issue.move', `issue:${issue.id}`, ctx.env.actorOf(auth), () =>
            pushUpdateToGitHub(db, tenant, issue, { fetchFn: ctx.env.fetchFn }),
          );
          sendJson(ctx.res, 200, { ok: true, issue });
        } catch (e) {
          failure(ctx.res, e);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/console/issues/update',
      capability: 'engineer',
      surface: 'api',
      body: 'csrf',
      activation: 'required',
      note: 'Edit an issue. `expectedUpdatedAt` makes it a compare-and-set: a moved row answers 409. Department-gated.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const fields = ctx.call?.fields ?? {};
        try {
          const id = String(fields.issueId ?? '').slice(0, 64);
          const progressRaw =
            fields.progress === undefined || fields.progress === '' ? undefined : Number(fields.progress);
          const stateRaw =
            fields.state !== undefined && ISSUE_STATES.includes(String(fields.state) as IssueState)
              ? (String(fields.state) as IssueState)
              : undefined;
          const issue = await updateIssue(
            db,
            tenant,
            id,
            {
              title: fields.title === undefined ? undefined : String(fields.title),
              description: fields.description === undefined ? undefined : String(fields.description),
              state: stateRaw,
              priority:
                fields.priority === undefined || !ISSUE_PRIORITIES.includes(String(fields.priority) as IssuePriority)
                  ? undefined
                  : (String(fields.priority) as IssuePriority),
              progress: progressRaw !== undefined && Number.isFinite(progressRaw) ? progressRaw : undefined,
              expectedUpdatedAt: String(fields.expectedUpdatedAt ?? '') || null,
            },
            ctx.at,
          );
          if (!issue) {
            sendJson(ctx.res, 404, { ok: false, error: 'no such issue' });
            return;
          }
          await ctx.env.audit(
            ctx.env.actorOf(auth),
            'issues.update',
            `issue:${issue.id}`,
            ctx.at,
            issue.title.slice(0, 120),
          );
          ctx.env.pushAfterLocalWrite('issue.update', `issue:${issue.id}`, ctx.env.actorOf(auth), () =>
            pushUpdateToGitHub(db, tenant, issue, { fetchFn: ctx.env.fetchFn }),
          );
          sendJson(ctx.res, 200, { ok: true, issue });
        } catch (e) {
          failure(ctx.res, e);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/console/issues/delete',
      capability: 'engineer',
      surface: 'api',
      body: 'csrf',
      activation: 'required',
      note: 'Delete an issue and its comments, and the GitHub issue if one was pushed. Department-gated.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const fields = ctx.call?.fields ?? {};
        try {
          const id = String(fields.issueId ?? '').slice(0, 64);
          const gone = await deleteIssue(db, tenant, id);
          if (!gone) {
            sendJson(ctx.res, 404, { ok: false, error: 'no such issue' });
            return;
          }
          await ctx.env.audit(ctx.env.actorOf(auth), 'issues.delete', `issue:${id}`, ctx.at);
          ctx.env.pushAfterLocalWrite('issue.delete', `issue:${id}`, ctx.env.actorOf(auth), () =>
            pushDeleteToGitHub(db, tenant, id, { fetchFn: ctx.env.fetchFn }),
          );
          sendJson(ctx.res, 200, { ok: true });
        } catch (e) {
          failure(ctx.res, e);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/console/issues/comment',
      capability: 'engineer',
      surface: 'api',
      body: 'csrf',
      activation: 'required',
      note: 'Add a comment to an issue. Department-gated, CSRF-checked, audited, pushed if the repo is linked.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const fields = ctx.call?.fields ?? {};
        try {
          const id = String(fields.issueId ?? '').slice(0, 64);
          const comment = await addComment(db, tenant, id, auth.user.email, String(fields.content ?? ''), ctx.at);
          if (!comment) {
            sendJson(ctx.res, 404, { ok: false, error: 'no such issue' });
            return;
          }
          await ctx.env.audit(
            ctx.env.actorOf(auth),
            'issues.comment',
            `issue:${id}`,
            ctx.at,
            comment.content.slice(0, 120),
          );
          ctx.env.pushAfterLocalWrite('issue.comment', `issue:${id}`, ctx.env.actorOf(auth), () =>
            pushCommentToGitHub(db, tenant, id, comment.content, { fetchFn: ctx.env.fetchFn }),
          );
          sendJson(ctx.res, 200, { ok: true, comment });
        } catch (e) {
          failure(ctx.res, e);
        }
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const ISSUES_CAPABILITIES: Record<string, { capability: Capability; surface: 'api' | 'html' }> = {
  'GET /console/issues': { capability: 'engineer', surface: 'html' },
  'GET /console/issues/sync': { capability: 'engineer', surface: 'api' },
  'GET /console/issues/detail': { capability: 'engineer', surface: 'api' },
  'POST /console/issues/create': { capability: 'engineer', surface: 'api' },
  'POST /console/issues/move': { capability: 'engineer', surface: 'api' },
  'POST /console/issues/update': { capability: 'engineer', surface: 'api' },
  'POST /console/issues/delete': { capability: 'engineer', surface: 'api' },
  'POST /console/issues/comment': { capability: 'engineer', surface: 'api' },
};
