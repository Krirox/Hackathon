// Route table — the single place a console route declares *what it is* and *who
// may call it*.
//
// Why this exists: in the 7,000-line dispatcher, whether a route required a
// session was a property of that route's body, so a new route was reachable by
// default unless its author remembered. Authorisation you cannot enumerate is
// authorisation you cannot review. Here every route carries a `capability`, and
// `authorize()` is the only thing that decides access — the dispatcher calls it,
// never re-implements it.
//
// Scope of this module: policy and matching only. It does not know about HTTP
// status codes, cookies, sessions or the database. The server resolves a session
// into an `AuthContext` and asks `authorize()` for a decision; turning a denial
// into a 401/403/redirect is a transport concern and stays in the server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Role, Session, User } from '../../core/auth.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What a caller must be to reach a route.
 *
 * - `public`  — no session. Deliberate and rare: liveness and the status pill.
 * - `session` — any authenticated user of the tenant.
 * - `owner`   — authenticated user whose role is owner or admin.
 *
 * Deliberately *not* a capability: "must have changed the bootstrap password".
 * That is a session-freshness rule applied to HTML surfaces, and encoding it
 * here as three booleans would make it easy to pick the wrong one. Routes that
 * need it state it in the handler, where the redirect shape is visible.
 */
export type Capability = 'public' | 'session' | 'owner';

/** Resolved identity for one request. `null` means no valid session. */
export interface AuthContext {
  user: User;
  session: Session;
}

/**
 * What a denial *looks* like when the caller is a browser rather than an API
 * client. Declared next to the capability so a reviewer sees both halves of the
 * decision at once: who may call this, and what everyone else gets.
 *
 * Required for `owner` HTML routes — an unprivileged user following a nav link
 * to an admin page deserves that page's own "you need the admin role" message,
 * not a JSON body rendered in a browser tab.
 */
export interface DeniedPage {
  title: string;
  message: string;
  /** Shell nav item to highlight. Omitted → no nav item is active. */
  navKey?: string;
  /** `page` renders the console shell around the message; `text` sends it bare. */
  as?: 'page' | 'text';
}

/** Per-request memo — see src/core/request-cache.ts. */
export interface RequestMemo {
  memo<T>(key: string, produce: () => Promise<T> | T): Promise<T>;
}

/**
 * What a handler receives. `Env` is whatever the server assembles once at boot
 * (db, tenant, clock) plus per-request services; keeping it generic is what lets
 * this module stay free of console imports and stay testable without a server.
 */
export interface RouteCtx<Env> {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  params: Readonly<Record<string, string>>;
  /** Client IP as resolved through the trusted-proxy policy, or null. */
  ip: string | null;
  /** Server clock, already sampled for this request. */
  at: string;
  /** Non-null only when the capability required a session and it was valid. */
  auth: AuthContext | null;
  /** Parsed body: non-null exactly when the route declared `body: 'csrf'`. */
  call: ParsedBody | null;
  env: Env;
  memo: RequestMemo;
}

export interface RouteDef<Env> {
  method: HttpMethod;
  /** Exact path, or with `:name` segments: `/console/issues/:id`. */
  pattern: string;
  capability: Capability;
  /**
   * How a denial is transported, and what a browser gets on success. This is
   * not decoration: an anonymous call to an HTML page must redirect to the login
   * form (with a return path), while an anonymous call to a JSON endpoint must
   * answer 401 so the caller can act on it. Making it explicit is what lets the
   * dispatcher stop guessing.
   */
  surface: Surface;
  /** Required for `owner` HTML routes; see DeniedPage. */
  denied?: DeniedPage;
  /**
   * How the request body is read and checked *before* the handler runs.
   *
   * `csrf` — parse the body and require the session's CSRF token, both done by
   * the dispatcher and handed to the handler as `ctx.call`. Declared rather than
   * left to the handler for the same reason as `capability`: a state-changing
   * route whose CSRF check lives in its body is only verifiable by reading that
   * body. Required for every mutating method, enforced at boot.
   */
  body?: BodyPolicy;
  /** One line for the manifest (used by the route-table test). */
  note?: string;
  handler(ctx: RouteCtx<Env>): Promise<void> | void;
}

/** `api` = JSON transport, `html` = a browser page (redirects, shell chrome). */
export type Surface = 'api' | 'html';

/** See `RouteDef.body`. */
export type BodyPolicy = 'none' | 'csrf';

/** A parsed request body. structurable: the server's `Call` satisfies it. */
export interface ParsedBody {
  csrf: string | null;
  fields: Record<string, string>;
  json?: Record<string, unknown>;
}

export interface RouteMatch<Env> {
  route: RouteDef<Env>;
  params: Record<string, string>;
}

export interface ManifestEntry {
  method: HttpMethod;
  pattern: string;
  capability: Capability;
  surface: Surface;
  note: string;
}

const PARAM_SEGMENT = /^:(.+)$/;

/**
 * Compile a pattern into a matcher. Returns null when the path does not match,
 * otherwise the extracted params. Kept deliberately absolute: no wildcards, no
 * optional segments — a route table that needs those is usually a route table
 * that should be several routes.
 */
export function compilePattern(pattern: string): (path: string) => Record<string, string> | null {
  // Segments are compared verbatim after the leading slash: no filtering of
  // empty segments. `/api/metrics/` must NOT reach the `/api/metrics` route —
  // the legacy dispatcher compared paths strictly, and a matcher that is more
  // lenient than the thing it replaces silently changes routing.
  const want = pattern.split('/').slice(1);
  return (path: string) => {
    const got = path.split('/').slice(1);
    if (got.length !== want.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const g = got[i]!;
      const param = PARAM_SEGMENT.exec(w);
      if (param) {
        if (g.length === 0) return null;
        params[param[1]!] = decodeURIComponent(g);
        continue;
      }
      if (w !== g) return null;
    }
    return params;
  };
}

/** First route whose method and pattern match. Registration order is priority. */
export function matchRoute<Env>(
  routes: ReadonlyArray<RouteDef<Env>>,
  method: string,
  path: string,
): RouteMatch<Env> | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = compilePattern(route.pattern)(path);
    if (params) return { route, params };
  }
  return null;
}

/**
 * The policy decision, and nothing else. Pure on purpose: it is the one function
 * a reviewer has to read to know whether a capability is enforced correctly.
 */
export function capabilityAllows(capability: Capability, auth: AuthContext | null): boolean {
  if (capability === 'public') return true;
  if (!auth) return false;
  if (capability === 'owner') return isOwner(auth.user.role);
  return true;
}

export function isOwner(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * The session a non-`public` handler was promised. The dispatcher resolves the
 * session *before* it calls a handler and never calls one whose capability was
 * denied, so a missing auth here is a wiring bug — throwing is how it surfaces
 * at the first request instead of as a null dereference deep inside a page.
 */
export function requireAuth(ctx: RouteCtx<unknown>): AuthContext {
  if (!ctx.auth) throw new Error(`[route-table] ${ctx.method} ${ctx.path} ran without a session`);
  return ctx.auth;
}

/**
 * Structural checks that must never fail at request time: every route declares a
 * capability, patterns and methods are unique, params are well formed. Throws
 * with the offending entries rather than dropping them, because a route that
 * silently fails to register is a 404 in production.
 */
export function validateRoutes<Env>(routes: ReadonlyArray<RouteDef<Env>>): void {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const route of routes) {
    const id = `${route.method} ${route.pattern}`;
    if (seen.has(id)) problems.push(`duplicate route ${id} (also declared at ${seen.get(id)})`);
    else seen.set(id, id);
    if (!route.capability) problems.push(`${id} declares no capability`);
    if (route.surface !== 'api' && route.surface !== 'html')
      problems.push(`${id} declares no surface (expected "api" or "html")`);
    // An admin-only HTML route must say what a non-admin sees. Without it the
    // dispatcher would have to invent a message, and inventing user-facing copy
    // is how "Forbidden" ends up in front of a customer.
    if (route.surface === 'html' && route.capability === 'owner' && !route.denied)
      problems.push(`${id} is an owner-only HTML route and must declare \`denied\``);
    if (route.pattern.length === 0 || !route.pattern.startsWith('/'))
      problems.push(`${id} pattern must start with "/"`);
    for (const seg of route.pattern.split('/')) {
      // A param segment is `:name` and nothing else: `:a:b` and a bare `:` would
      // both compile into a param nobody can address.
      if (seg.includes(':') && (!PARAM_SEGMENT.test(seg) || seg.slice(1).includes(':')))
        problems.push(`${id} has a malformed param segment "${seg}"`);
    }
    if (typeof route.handler !== 'function') problems.push(`${id} has no handler`);
    // A mutating route must say how its body is handled. "Every state change
    // checked a token" is not a claim anyone can verify by reading a 7,000-line
    // dispatcher; here it is one table column.
    const mutating = route.method !== 'GET';
    if (mutating && (route.body !== 'csrf' && route.body !== 'none'))
      problems.push(`${id} must declare a body policy ("csrf" or "none")`);
    if (!mutating && route.body !== undefined)
      problems.push(`${id} declares a body policy but does not mutate`);
    // A public route has no session, so there is no token to check: `csrf` there
    // would be a check that can never pass.
    if (route.body === 'csrf' && route.capability === 'public')
      problems.push(`${id} declares a CSRF check but is public (no session exists)`);
  }
  if (problems.length > 0) throw new Error(`[route-table] ${problems.join('; ')}`);
}

/** Machine-readable inventory: the artefact a reviewer or a test can enumerate. */
export function routeManifest<Env>(routes: ReadonlyArray<RouteDef<Env>>): ManifestEntry[] {
  return routes.map((r) => ({
    method: r.method,
    pattern: r.pattern,
    capability: r.capability,
    surface: r.surface,
    note: r.note ?? '',
  }));
}
