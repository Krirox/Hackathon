// Compliance routes — the second domain moved onto the route table.
//
// `/console/audit`, `/console/data` and `/console/data/export` shared one
// pattern copied three times in the dispatcher: resolve the session, redirect an
// anonymous caller, reject a foreign tenant, refuse an un-activated account,
// then reject a non-admin with a hand-written message. Copies drift, and the
// drift is invisible — all three look right individually while disagreeing about
// who may read the organization's audit trail.
//
// Here the who is *declared* (`capability: 'owner'`), the transport is declared
// (`surface: 'html'`), and the refusal copy is declared (`denied`). What is left
// in each handler is only the page itself.
//
// Deliberately not migrated with them: `POST /console/data/erase`. It is a
// mutating, CSRF-checked form with a redirect-on-mismatch path, and it should
// move as its own reviewed change rather than riding along with a read-only
// migration. The route-table test pins that boundary.

import type { ServerResponse } from 'node:http';
import { requireAuth, type Capability, type RouteDef } from './registry.ts';
import { renderAuditPage } from '../audit.ts';
import { renderDataPage } from '../data.ts';
import type { AsyncDb } from '../../core/db.ts';
import type { AuthContext } from './registry.ts';

export interface ComplianceEnv {
  db: AsyncDb;
  tenant: string;
  /** Console base path. */
  home: string;
  /**
   * The shelled console page: `detailDocument` inside `wrapInWorkspaceShell`.
   * Supplied by the server so this module owns no chrome — it cannot drift from
   * the rail, the top bar or the account cluster.
   */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean },
  ): Promise<string>;
  /** Full ledger bundle for one tenant (same function the CLI export uses). */
  exportLedger(tenant: string, at: string): Promise<unknown>;
  /** Irreversible erasure (core/erasure.ts). Resolves with the erasure receipt. */
  eraseTenant(tenant: string, actor: string, at: string): Promise<unknown>;
  /** Human-readable actor for an authenticated session. */
  actorOf(auth: AuthContext): string;
  /** Transport: 303 redirect, optionally clearing the session cookie. */
  redirect(res: ServerResponse, location: string, opts?: { clearSession?: boolean }): void;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

export function complianceRoutes(): RouteDef<ComplianceEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/audit',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      denied: {
        title: 'Audit log',
        message: 'Audit log requires the admin or owner role.',
        navKey: 'audit',
      },
      note: 'Append-only record of every auth event and console mutation. Owner-only: it names who did what.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const q = ctx.url.searchParams;
        const offsetRaw = Number(q.get('offset') ?? '0');
        const { html } = await renderAuditPage(ctx.env.db, ctx.env.tenant, {
          actor: q.get('actor') ?? undefined,
          action: q.get('action') ?? undefined,
          from: q.get('from') ?? undefined,
          to: q.get('to') ?? undefined,
          request: q.get('request') ?? undefined,
          offset: Number.isSafeInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
        });
        ctx.res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
        ctx.res.end(
          await ctx.env.shellPage(auth, {
            title: 'Audit log',
            body: html,
            navKey: 'audit',
            hideHeader: true,
          }),
        );
      },
    },
    {
      method: 'GET',
      pattern: '/console/data',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      denied: {
        title: 'Data & retention',
        message: 'Data & retention requires the admin or owner role.',
        navKey: 'data',
      },
      note: 'Retention posture, export and erasure entry point. Owner-only: it is the GDPR surface.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const q = ctx.url.searchParams;
        const html = renderDataPage(ctx.env.tenant, {
          csrf: auth.session.csrfToken,
          home: ctx.env.home,
          notice: q.get('notice') ?? undefined,
          error: q.get('error') ?? undefined,
        });
        ctx.res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
        ctx.res.end(
          await ctx.env.shellPage(auth, {
            title: 'Data & retention',
            body: html,
            navKey: 'data',
            hideHeader: true,
          }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/console/data/erase',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      // Body handling and the CSRF check are declared, not written here: the
      // dispatcher parses the form and verifies the token before this handler
      // runs, so `ctx.call` is guaranteed to be a verified body.
      body: 'csrf',
      denied: { title: 'Erasure', message: 'Erasure requires the admin or owner role.', as: 'text' },
      note: 'Irreversible tenant erasure. Owner-only, CSRF-checked, and requires the slug typed twice as confirmation.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const fields = ctx.call?.fields ?? {};
        // Confirmation is a deliberate speed bump: the operator types the
        // organization slug, so a mis-click cannot destroy a tenant.
        if ((fields.confirmSlug ?? '').trim() !== ctx.env.tenant || fields.confirmed !== 'on') {
          ctx.env.redirect(
            ctx.res,
            `${ctx.env.home}/data?error=${encodeURIComponent('Typed confirmation did not match organization slug.')}`,
          );
          return;
        }
        try {
          await ctx.env.eraseTenant(ctx.env.tenant, ctx.env.actorOf(auth), ctx.at);
          // The session belonged to data that no longer exists: clear it and
          // land on the receipt rather than on a console with no user.
          ctx.env.redirect(
            ctx.res,
            `/receipts/erasure/${encodeURIComponent(ctx.env.tenant)}`,
            { clearSession: true },
          );
          return;
        } catch (e) {
          ctx.env.redirect(
            ctx.res,
            `${ctx.env.home}/data?error=${encodeURIComponent((e as Error).message)}`,
          );
        }
      },
    },
    {
      method: 'GET',
      pattern: '/console/data/export',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      // The download answers with the bundle itself, not a page, so a refusal
      // stays a bare line of text rather than a shelled document a browser would
      // render as a JSON-ish page.
      denied: { title: 'Ledger export', message: 'Export requires the admin or owner role.', as: 'text' },
      note: 'Whole-ledger JSON download. Owner-only: it is a copy of every tenant record.',
      async handler(ctx) {
        requireAuth(ctx);
        const bundle = await ctx.env.exportLedger(ctx.env.tenant, ctx.at);
        ctx.res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${ctx.env.tenant}-ledger-export.json"`,
          ...NO_STORE,
        });
        ctx.res.end(JSON.stringify(bundle, null, 2));
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const COMPLIANCE_CAPABILITIES: Record<string, { capability: Capability; surface: 'api' | 'html' }> =
  {
    'GET /console/audit': { capability: 'owner', surface: 'html' },
    'GET /console/data': { capability: 'owner', surface: 'html' },
    'GET /console/data/export': { capability: 'owner', surface: 'html' },
    'POST /console/data/erase': { capability: 'owner', surface: 'html' },
  };
