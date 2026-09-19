// Requests & approvals — the migration's first *mutating* JSON surface.
//
// What moves here, and what does not (the honest boundary):
//
//   migrated : POST /api/requests/:id/refresh-evidence
//              GET /console/requests · /console/claims · /console/human-work ·
//              /console/rooms — see routes/lists.ts, moved after this one
//   next     : POST /api/requests/:id/approve · decline  (one transaction each,
//              against the ledger, with an operator-signature path)
//
// The two halves are split because they carry different risk: this route is a
// coordinator call plus an audit line, while approve/decline writes a decision
// inside a transaction and has a duplicate-submission receipt path. Landing them
// together would mean a single rollback unit for both, and a reviewer unable to
// see which part changed.
//
// The interesting part is what this route *no longer has to write*: session
// resolution, tenant check, activation, CSRF and body parsing are all declared
// on the route and enforced by the dispatcher (see registry.ts). What is left
// here is the operation.

import { requireAuth, type Capability, type RouteDef } from './registry.ts';
import type { Coordinator } from '../../coord/coordinator.ts';
import type { Ledger } from '../../ledger/ledger.ts';

export interface RequestsEnv {
  tenant: string;
  /** Coordinator: owns the request lifecycle and the evidence refresh. */
  coord: Coordinator;
  /** Ledger: resolves whether a cited claim has been superseded. */
  ledger: Ledger;
  /** Append one console audit entry (the server owns the writer). */
  audit(actor: string, action: string, target: string, at: string): Promise<void>;
  /** Human-readable actor for an authenticated session. */
  actorOf(auth: Parameters<typeof requireAuth>[0]['auth'] & object): string;
}

export function requestsRoutes(): RouteDef<RequestsEnv>[] {
  return [
    {
      method: 'POST',
      pattern: '/api/requests/:id/refresh-evidence',
      capability: 'session',
      surface: 'api',
      // The dispatcher parses the body and verifies the token before the handler.
      body: 'csrf',
      activation: 'required',
      note: 'Re-reads a request\u2019s cited evidence after a claim was superseded. Session-only; audited.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const raw = ctx.params.id ?? '';
        // The matcher hands over a segment that would not decode rather than
        // throwing (a throwing matcher is a 500 on a malformed public path), so
        // the validation belongs here.
        let requestId: string;
        try {
          requestId = decodeURIComponent(raw);
        } catch {
          ctx.res.writeHead(400, { 'content-type': 'application/json' });
          ctx.res.end(JSON.stringify({ ok: false, error: 'malformed request id' }));
          return;
        }
        const jsonOut = (status: number, body: unknown): void => {
          ctx.res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          ctx.res.end(JSON.stringify(body));
        };
        try {
          const next = await ctx.env.coord.refreshEvidence(
            ctx.env.tenant,
            requestId,
            // A claim that has been replaced is followed to its replacement, so
            // the refreshed request cites what the ledger actually holds.
            async (claimId) => {
              const current = await ctx.env.ledger.currentReplacement(ctx.env.tenant, claimId);
              return current && current.id !== claimId ? current.id : null;
            },
          );
          await ctx.env.audit(
            ctx.env.actorOf(auth),
            'console.refresh_evidence',
            `request:${requestId}`,
            ctx.at,
          );
          jsonOut(200, {
            ok: true,
            id: requestId,
            state: next.state,
            claimRefs: next.claimRefs,
            chainClaimIds: next.chainClaimIds,
          });
        } catch (e) {
          // NOT_FOUND is a missing request; anything else is a conflict with the
          // request's current state (the caller refreshes and retries).
          const code = (e as { code?: string }).code;
          jsonOut(code === 'NOT_FOUND' ? 404 : 409, {
            ok: false,
            error: (e as Error).message,
          });
        }
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const REQUESTS_CAPABILITIES: Record<
  string,
  { capability: Capability; surface: 'api' | 'html' }
> = {
  'POST /api/requests/:id/refresh-evidence': { capability: 'session', surface: 'api' },
};
