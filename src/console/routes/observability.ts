// Observability routes — the first domain moved onto the route table.
//
// These four were chosen to migrate first because they are the surfaces that
// *must not* drift: liveness is what the ALB target group and the deploy smoke
// check believe, and the two analytics reads are session-gated. Moving them here
// makes their capability explicit (`public` vs `session`) instead of implied by
// where their `if` happened to sit in the dispatcher.
//
// Handlers implement the success path only. Capability enforcement, the 401/403
// shapes, and redirects for HTML callers stay in the server — see
// registry.ts's note on policy vs transport.

import { type Capability, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';

export interface ObservabilityEnv {
  db: AsyncDb;
  tenant: string;
  /** Build string, so the liveness payload cannot drift from the release. */
  vitalVersion: string;
  /** Actually-bound address (host:port), as reported by the listener. */
  boundAddress: string;
  /**
   * Scheme + trusted-proxy verdict for this request. Passed in rather than
   * recomputed here so the LB→task path is proven by the same policy the rest
   * of the server uses (FLOW-006).
   */
  forwarded(req: Parameters<RouteDef<ObservabilityEnv>['handler']>[0]['req']): {
    scheme: string;
    viaProxy: boolean;
  };
  /** Liveness snapshot at a sampled instant (gov/trust.ts). */
  liveness(at: string): Record<string, unknown>;
  /** Shared rate limiter. Injected so this module owns no process state. */
  rateOk(key: string, limit: number, windowMs: number, atMs: number): boolean;
  approvalLatency(tenant: string): Promise<unknown>;
  costPerSignal(tenant: string): Promise<unknown>;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function observabilityRoutes(): RouteDef<ObservabilityEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/healthz',
      capability: 'public',
      surface: 'api',
      note: 'ALB target-group probe + deploy smoke check. Public on purpose: it carries no tenant data.',
      handler(ctx) {
        const fwd = ctx.env.forwarded(ctx.req);
        ctx.res.writeHead(200, { 'content-type': 'application/json', ...NO_STORE });
        ctx.res.end(
          JSON.stringify({
            ok: true,
            vital: ctx.env.vitalVersion,
            listen: ctx.env.boundAddress,
            proto: fwd.scheme,
            viaProxy: fwd.viaProxy,
            ...ctx.env.liveness(ctx.at),
          }),
        );
      },
    },
    {
      method: 'GET',
      pattern: '/api/health',
      capability: 'public',
      surface: 'api',
      note: 'Live console pill on the static site. Public + rate-limited; returns nothing sensitive.',
      handler(ctx) {
        if (!ctx.env.rateOk(`health:${ctx.ip ?? '-'}`, 60, 60_000, Date.parse(ctx.at))) {
          ctx.res.writeHead(429, { 'content-type': 'application/json', ...NO_STORE });
          ctx.res.end(JSON.stringify({ ok: false, error: 'slow down' }));
          return;
        }
        ctx.res.writeHead(200, {
          'content-type': 'application/json',
          // CORS open on purpose: public status pill, nothing sensitive.
          'access-control-allow-origin': '*',
          ...NO_STORE,
        });
        ctx.res.end(JSON.stringify({ ok: true, engine: ctx.env.db.engine, at: ctx.at }));
      },
    },
    {
      method: 'GET',
      pattern: '/api/approval-latency',
      capability: 'session',
      surface: 'api',
      note: 'Curation-cost clock. Session-gated: a latency distribution leaks who approves what, and how slowly.',
      async handler(ctx) {
        ctx.res.writeHead(200, { 'content-type': 'application/json', ...NO_STORE });
        ctx.res.end(JSON.stringify(await ctx.memo.memo('approval-latency', () => ctx.env.approvalLatency(ctx.env.tenant))));
      },
    },
    {
      method: 'GET',
      pattern: '/api/cost-per-signal',
      capability: 'session',
      surface: 'api',
      note: 'Spend-side gate (MODEL share of arrivals). Read-only but leaks routing economics.',
      async handler(ctx) {
        ctx.res.writeHead(200, { 'content-type': 'application/json', ...NO_STORE });
        ctx.res.end(JSON.stringify(await ctx.memo.memo('cost-per-signal', () => ctx.env.costPerSignal(ctx.env.tenant))));
      },
    },
  ];
}

/** Capability of each route, for the manifest test and reviewer readability. */
export const OBSERVABILITY_CAPABILITIES: Record<string, Capability> = {
  'GET /healthz': 'public',
  'GET /api/health': 'public',
  'GET /api/approval-latency': 'session',
  'GET /api/cost-per-signal': 'session',
};
