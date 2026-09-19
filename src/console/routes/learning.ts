// Learning domain — the acts, not just the views.
//
// The learning page has existed since FINAL-004 as a read surface: a labeling
// queue, a card list, and a per-card "why not trusted yet" panel. What it could
// not do was the two things the board kept telling operators to do:
//
//   - compile a mined candidate into a card (the board's own empty state said
//     compilation "is not exposed in this console yet")
//   - run a transfer test (three screens promised promotion "runs only through
//     the governed transfer-test path", which no surface could start)
//
// Everything here is `owner`: minting a procedure and running harnesses against
// it are privilege-bearing acts, not reads. The evidence each act depends on is
// read from the database inside the operation — see learning-actions.ts for why
// the form may describe a *procedure* but never its provenance.
//
// Deliberately not migrated here yet: `GET /console/learning`,
// `GET /console/learning/:id` and `POST /console/learning/label` still run on the
// legacy chain. They are reads (plus one label write) with no shared branch with
// these routes, so moving them would widen this change without buying anything —
// and the route-table test pins the boundary so "learning moved onto the table"
// cannot be read as "all of learning moved".

import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import type { OrganizationalCompiler } from '../../compiler/compiler.ts';
import { compileCandidate, enqueueTransferTest, listCompileCandidates } from '../learning-actions.ts';
import { renderCompilePage } from '../learning.ts';

export interface LearningEnv {
  db: AsyncDb;
  comp: OrganizationalCompiler;
  tenant: string;
  home: string;
  /** Human-readable actor for an authenticated session. */
  actorOf(auth: AuthContext): string;
  /** Append one console audit entry (the server owns the writer). */
  audit(actor: string, action: string, target: string, at: string): Promise<void>;
  /** The shelled console page — chrome stays in the server. */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean; drawer?: boolean },
  ): Promise<string>;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, ...NO_STORE });
  res.end();
}

/** One entry per line, blank lines dropped. */
function lines(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Comma-separated, blanks dropped. */
function commas(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function errorPath(base: string, message: string): string {
  return `${base}?error=${encodeURIComponent(message)}`;
}

export function learningRoutes(): RouteDef<LearningEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/learning/compile',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      denied: {
        title: 'Compile a skill card',
        message: 'Compiling a procedure requires the admin or owner role.',
        navKey: 'learning',
      },
      note: 'The compile form for mined candidates. Owner-only: minting a procedure that the router can later execute is privilege-bearing.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const candidates = await listCompileCandidates(ctx.env.db, ctx.env.tenant);
        const q = ctx.url.searchParams;
        ctx.res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
        ctx.res.end(
          await ctx.env.shellPage(auth, {
            title: 'Compile a skill card',
            navKey: 'learning',
            hideHeader: true,
            body: renderCompilePage(candidates, {
              csrf: auth.session.csrfToken,
              home: ctx.env.home,
              error: q.get('error') ?? undefined,
              notice: q.get('notice') ?? undefined,
            }),
          }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/console/learning/compile',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      body: 'csrf',
      denied: { title: 'Compile a skill card', message: 'Requires the admin or owner role.', as: 'text' },
      note: 'Compiles one mined candidate into a CANDIDATE card. Trace ids, scopes, models and tier are read from the evidence, never from the form.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const fields = ctx.call?.fields ?? {};
        try {
          const card = await compileCandidate(ctx.env.db, ctx.env.comp, ctx.env.tenant, {
            intent: (fields.intent ?? '').trim(),
            predicates: lines(fields.predicates ?? ''),
            steps: lines(fields.steps ?? ''),
            tests: lines(fields.tests ?? ''),
            toolGrants: commas(fields.toolGrants ?? ''),
            tier: (fields.tier ?? '').trim(),
            scope: (fields.scope ?? '').trim(),
            owner: ctx.env.actorOf(auth),
            now: ctx.at,
          });
          await ctx.env.audit(ctx.env.actorOf(auth), 'compiler.compile', card.id, ctx.at);
          redirect(ctx.res, `/console/learning/${encodeURIComponent(card.id)}?compiled=1`);
        } catch (e) {
          // Back to the form with the reason — the refusal is the useful part,
          // and several of them (no executor provenance, tier not supported by
          // the evidence) are things the operator can only fix at the source.
          redirect(ctx.res, errorPath('/console/learning/compile', (e as Error).message));
        }
      },
    },
    {
      method: 'POST',
      pattern: '/console/learning/cards/:id/transfer-test',
      capability: 'owner',
      surface: 'html',
      activation: 'required',
      body: 'csrf',
      denied: { title: 'Transfer test', message: 'Requires the admin or owner role.', as: 'text' },
      note: 'Queues a cross-model transfer run for one card. Durable outbox row; the worker runs the harnesses and banks the results.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const fields = ctx.call?.fields ?? {};
        const raw = ctx.params.id ?? '';
        let cardId: string;
        try {
          cardId = decodeURIComponent(raw);
        } catch {
          redirect(ctx.res, errorPath('/console/learning', 'malformed card id'));
          return;
        }
        try {
          const id = await enqueueTransferTest(ctx.env.db, ctx.env.comp, ctx.env.tenant, {
            cardId,
            targetScope: (fields.targetScope ?? '').trim(),
            command: (fields.command ?? '').trim(),
            claimIds: commas(fields.claimIds ?? ''),
            maxDollars: Number(fields.maxDollars),
            maxTokens: Number(fields.maxTokens),
            onBehalfOf: ctx.env.actorOf(auth),
            now: ctx.at,
          });
          await ctx.env.audit(ctx.env.actorOf(auth), 'compiler.transfer_test', cardId, ctx.at);
          redirect(ctx.res, `/console/learning/${encodeURIComponent(cardId)}?queued=${encodeURIComponent(id)}`);
        } catch (e) {
          redirect(ctx.res, errorPath(`/console/learning/${encodeURIComponent(cardId)}`, (e as Error).message));
        }
      },
    },
  ];
}

/** The manifest the route-table test pins, so a capability change is a test edit. */
export const LEARNING_CAPABILITIES: Record<string, { capability: string; surface: string }> = {
  'GET /console/learning/compile': { capability: 'owner', surface: 'html' },
  'POST /console/learning/compile': { capability: 'owner', surface: 'html' },
  'POST /console/learning/cards/:id/transfer-test': { capability: 'owner', surface: 'html' },
};
