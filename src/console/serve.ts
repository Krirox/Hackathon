import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve as resolvePath, sep as pathSep } from 'node:path';
import type { Socket } from 'node:net';
import type { AsyncDb } from '../core/db.ts';
import {
  AuthError,
  changePassword,
  csrfOk,
  disableUser,
  getUser,
  installAuthSchema,
  inviteUser,
  listUsers,
  login,
  logout,
  sessionCookie,
  sessionUser,
  signupTenant,
  atLeast,
  CLEAR_SESSION_COOKIE,
  type Session,
  type User,
} from '../core/auth.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { buildReport } from './report.ts';
import { renderHtml } from './render.ts';
import { proposeEvalFromCorrection } from '../evals/runner.ts';
import { CognitiveRouter } from '../router/router.ts';

/**
 * Console serve mode (TODO V2.1 + V2.1.1): the read-model report plus working
 * Approve/Decline actions, behind real authentication. The console refuses
 * anonymous approvals — and since V2.1.1 there is an account to be: a named
 * human is an authenticated session, never a string in a request body.
 *
 * Enforcement shape:
 *  - every page and every POST requires a live session (fail closed);
 *  - every state-changing POST carries the session's CSRF token (header on
 *    JSON calls, hidden field on forms), compared constant-time;
 *  - identity for approvals comes from the session — the request body cannot
 *    name a human;
 *  - sessions are tenant-scoped at login, so the console only ever reads the
 *    tenant it was started for, and login cannot reach another tenant's users;
 *  - every security event and every approve/decline lands in audit_log.
 */

export interface ConsoleServer {
  port: number;
  close(): Promise<void>;
}

/** Cap on JSON bodies: the approve/decline/correct payloads are tens of
 *  bytes — anything near a megabyte is a body bomb, not an approval. */
const MAX_BODY_BYTES = 1_000_000;

export interface ConsoleServerOptions {
  port?: number;
  host?: string;
  tenant?: string;
  now?: () => string;
  /** Set behind TLS so the session cookie gains `Secure`. */
  secureCookies?: boolean;
  /**
   * Serve a static site (marketing page, assets) from this directory when
   * set — console routes always take precedence, `/` shows the site, and
   * the console app moves to `/console`. Opt-in (`vital serve --site`);
   * never enabled implicitly.
   */
  siteDir?: string;
  /**
   * Minimum role that may approve/decline requests. Default `member` — the
   * room-agent model: any human of the tenant is a valid approver. Raise it
   * (e.g. `admin`) per tenant policy; the R/A/I matrix governs AGENT
   * autonomy, not which human may approve.
   */
  approverRole?: 'member' | 'admin' | 'owner';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let capped = false;
    req.on('data', (c: Buffer) => {
      if (capped) return; // draining after the cap tripped: discard, don't keep
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Reject once, then resume-discard the rest: destroying the socket
        // here poisons the client's keep-alive pool (every later request on
        // the pooled connection dies with socket hang up). Memory — the
        // actual threat — is protected because chunks are discarded, not kept.
        capped = true;
        reject(new Error('[console:BODY_TOO_LARGE] body exceeds 1MB cap'));
        req.resume();
        return;
      }
      body += c.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, code: number, value: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

/** Oversized bodies are 413, malformed JSON is 400 — never conflated. */
const bodyError = (res: ServerResponse, e: unknown): void => {
  if ((e as Error).message.includes('BODY_TOO_LARGE')) {
    json(res, 413, { ok: false, error: 'body exceeds 1MB cap' });
    return;
  }
  json(res, 400, { ok: false, error: 'malformed JSON body' });
};

const redirect = (res: ServerResponse, location: string, cookie?: string): void => {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(303, headers);
  res.end();
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#0A0F14;margin:0;padding:24px}
form{max-width:360px;display:grid;gap:10px}input{padding:8px;border:1px solid #E4E4E1;border-radius:6px}
button{padding:8px 14px;border:0;border-radius:6px;background:#0F5C57;color:#fff;font-weight:600;cursor:pointer}
.err{color:#B91C1C;font-size:13px}.sub{color:#6B7280;font-size:12px}</style>
</head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------- pre-session CSRF --
// Login and signup run BEFORE a session exists, so the session's CSRF token
// cannot protect them. These pages use the double-submit pattern instead: the
// server sets a random `vital_csrf` cookie on GET and the form must echo it.
// A cross-site attacker can submit a form but cannot read the cookie to fill
// the field, so the post is refused. (HttpOnly is fine: OUR server reads the
// cookie and injects the value into the rendered form.)
const PRE_CSRF_COOKIE = 'vital_csrf';

function preCsrfCookie(token: string, secure: boolean): string {
  return `${PRE_CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`;
}

function preCsrfOk(req: IncomingMessage, presented: string | null): boolean {
  const cookie = cookieValue(req, PRE_CSRF_COOKIE);
  if (!cookie || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ rate limit --
// Buckets are keyed by client IP and owned by EACH SERVER INSTANCE (the map
// lives inside startConsoleServer): per-process state in production, and no
// leakage between instances anywhere. Protects signup from spam and backs the
// per-account login lockout with a per-source flood cap. Behind a reverse
// proxy, terminate on the proxy or configure trusted XFF first.
export const LOGIN_RATE = { limit: 30, windowMs: 10 * 60_000 };
export const SIGNUP_RATE = { limit: 10, windowMs: 10 * 60_000 };

/** Friendly text for AuthError codes surfacing on public forms. */
function signupErrorMessage(e: unknown): string {
  const code = e instanceof AuthError ? e.code : '';
  switch (code) {
    case 'TENANT_EXISTS':
      return 'that organization handle is already taken';
    case 'BAD_SLUG':
      return 'organization handle must be 2-63 chars of a-z, 0-9 and hyphens, starting alphanumeric';
    case 'BAD_EMAIL':
      return 'a valid work email is required';
    case 'BAD_NAME':
      return 'your name and the organization name are required';
    case 'WEAK_PASSWORD':
      return 'password must be at least 12 characters';
    default:
      return 'could not create the organization';
  }
}

function loginPage(csrf: string, error?: string): string {
  return page(
    'Vital Console — sign in',
    `<h1>Vital Console</h1>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label class="sub" for="password">password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="sub">New organization? <a href="/signup">Create one</a>.</p>`,
  );
}

function signupPage(
  csrf: string,
  boundSlug: string,
  error?: string,
  values: { email?: string; ownerName?: string; orgname?: string } = {},
): string {
  return page(
    'Vital Console — provision this organization',
    `<h1>Provision this console</h1>
<p class="sub">This console serves the organization <strong>${esc(boundSlug)}</strong> and has no owner yet.
Claiming it makes you its owner. Membership in already-running organizations is invite-only.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/signup">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="orgname">organization name</label>
  <input id="orgname" name="orgname" value="${esc(values.orgname ?? boundSlug)}" required>
  <label class="sub" for="ownerName">your name</label>
  <input id="ownerName" name="ownerName" value="${esc(values.ownerName ?? '')}" required>
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" value="${esc(values.email ?? '')}" autocomplete="username" required>
  <label class="sub" for="password">password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <button type="submit">Claim this organization</button>
</form>
<p class="sub">Already have an account? <a href="/login">Sign in</a>.</p>`,
  );
}

function changePasswordPage(csrf: string, error?: string): string {
  return page(
    'Vital Console — set a new password',
    `<h1>Set a new password</h1>
<p class="sub">Your account must change its password before continuing.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/change-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save and continue</button>
</form>`,
  );
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

interface Call {
  csrf: string | null;
  fields: Record<string, string>;
}

async function parseCall(req: IncomingMessage): Promise<Call> {
  const raw = await readBody(req);
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    const parseJson = (raw: string): Record<string, unknown> => {
      try {
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        throw new Error('malformed JSON body');
      }
    };
    const body = parseJson(raw);
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') flat[k] = v;
    return { csrf: (req.headers['x-vital-csrf'] as string | undefined) ?? null, fields: flat };
  }
  const fields = new URLSearchParams(raw);
  return { csrf: fields.get('csrf'), fields: Object.fromEntries(fields) };
}

/**
 * Headless bootstrap: when the tenant exists but has no usable account and
 * VITAL_BOOTSTRAP_EMAIL/PASSWORD are configured, seed its first owner
 * (forced password change at first login). Returns whether an owner was
 * seeded; without env credentials the caller stays unprovisioned and web
 * signup claims the tenant instead — there is deliberately no default
 * password anywhere.
 */
async function ensureBootstrapOwner(db: AsyncDb, tenant: string, now: string): Promise<boolean> {
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?').get(tenant);
  if (Number((existing as { n: number }).n) > 0) return true;
  const email = process.env.VITAL_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.VITAL_BOOTSTRAP_PASSWORD;
  if (!email || !password) return false;
  const known = await db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(tenant);
  if (!known) {
    await signupTenant(db, { slug: tenant, name: tenant, email, password, ownerName: 'Console Owner' }, now);
    return true;
  }
  await inviteUser(
    db,
    tenant,
    { email, name: 'Console Owner', role: 'owner', password },
    { userId: 'bootstrap', role: 'owner' },
    now,
  );
  return true;
}

// ------------------------------------------------------------- static site --

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve one file from `siteDir` with path-traversal defence: resolve and
 * verify the real path stays inside the root. Returns null when the request
 * does not map to a file (caller falls through to its own routing).
 */
async function serveStatic(siteDir: string, pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const root = resolvePath(siteDir);
  const target = resolvePath(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + pathSep)) return null; // traversal
  try {
    const st = await stat(target);
    if (!st.isFile()) return null;
    const type = MIME[extname(target)] ?? 'application/octet-stream';
    return { body: await readFile(target), type };
  } catch {
    return null;
  }
}

/** An admin (or the owner) may disable a member; nobody disables an owner but the owner, or themselves. */
function canDisable(viewer: User, u: User): boolean {
  if (u.disabled) return false;
  if (!atLeast(viewer.role, 'admin')) return false;
  if (u.role === 'owner' && viewer.role !== 'owner') return false;
  return u.id !== viewer.id;
}

function disableForm(csrf: string, u: User): string {
  return `<form method="post" action="/team/disable" style="display:inline">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="userId" value="${esc(u.id)}">
      <button type="submit" style="background:#6B7280">Disable</button>
    </form>`;
}

function teamPage(csrf: string, viewer: User, users: User[], notice?: string): string {
  const canInvite = atLeast(viewer.role, 'admin');
  const rows = users
    .map(
      (u) => `<tr>
  <td>${esc(u.email)}${u.id === viewer.id ? ' <span class="sub">(you)</span>' : ''}</td>
  <td>${esc(u.name)}</td>
  <td>${esc(u.role)}</td>
  <td>${u.disabled ? '<span class="err">disabled</span>' : 'active'}</td>
  <td>${canDisable(viewer, u) ? disableForm(csrf, u) : ''}</td>
</tr>`,
    )
    .join('');
  return page(
    'Vital Console — team',
    `<p class="sub"><a href="/">← console</a></p>
<h1>Team</h1>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
<table style="border-collapse:collapse;min-width:520px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th></th></tr></thead>
  ${rows}
</table>
${
  canInvite
    ? `<h2>Invite a member</h2>
<form method="post" action="/team/invite">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" required>
  <label class="sub" for="name">name</label>
  <input id="name" name="name" required>
  <label class="sub" for="role">role</label>
  <select id="role" name="role">
    <option value="member">member</option>
    <option value="admin">admin</option>
    <option value="owner">owner</option>
  </select>
  <label class="sub" for="password">initial password (they must change it at first login)</label>
  <input id="password" name="password" type="password" minlength="12" required>
  <button type="submit">Invite</button>
</form>`
    : '<p class="sub">Ask an admin or the owner to invite members.</p>'
}
`,
  );
}

/** Stable audit identity string for a user. */
const by = (u: User): string => `${u.id} (${u.email})`;

async function auditConsole(
  db: AsyncDb,
  tenant: string,
  actor: string,
  action: string,
  target: string,
  at: string,
  detail?: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tenant, actor, action, target, detail ?? null, at);
}

export function startConsoleServer(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  opts: ConsoleServerOptions = {},
): Promise<ConsoleServer> {
  const tenant = opts.tenant ?? 'acme';
  const now = opts.now ?? (() => new Date().toISOString());
  const secure = opts.secureCookies ?? false;
  const approverMin = opts.approverRole ?? 'member';
  const siteDir = opts.siteDir ? resolvePath(opts.siteDir) : undefined;
  // When a site is mounted, the marketing page owns `/` and the console app
  // lives under `/console` (login/signup/change-password keep their paths —
  // they are console routes regardless).
  const home = siteDir ? '/console' : '/';

  // Per-instance rate-limit buckets (see the rate-limit note above): a server
  // owns its own counters, so cohabiting instances never share one.
  const buckets = new Map<string, { n: number; reset: number }>();
  const rateOk = (key: string, limit: number, windowMs: number, atMs: number): boolean => {
    const b = buckets.get(key);
    if (!b || atMs > b.reset) {
      buckets.set(key, { n: 1, reset: atMs + windowMs });
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (atMs > v.reset) buckets.delete(k);
      return true;
    }
    b.n += 1;
    return b.n <= limit;
  };

  return (async () => {
    // Auth tables live outside the base SCHEMA (named migrations with tested
    // down SQL), so the server installs them itself: `vital serve` is always
    // bootable regardless of which migration path created the rest.
    //
    // Provisioning model — the console serves exactly ONE tenant:
    //   ready          the tenant exists and has an owner; signup is closed
    //                  (membership is invite-only) and login works;
    //   unprovisioned  the tenant is missing or ownerless: env credentials
    //                  seed the first owner if present, else /signup claims
    //                  the tenant on first use. Everything else redirects to
    //                  /signup. This is what makes a fresh `vital serve`
    //                  bootable by a stranger without a seeded credential.
    await installAuthSchema(db, now());
    // Env credentials (when present) provision headless: creating the tenant
    // if missing, or seeding an owner for an ownerless one. Without them the
    // console starts unprovisioned and /signup claims the tenant.
    let provisioned = await ensureBootstrapOwner(db, tenant, now());

    const server: Server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://console');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const ip = req.socket.remoteAddress ?? undefined;
        const at = now();

        const sessionOf = async (): Promise<{ session: Session; user: User } | null> => {
          const token = cookieValue(req, 'vital_session');
          if (!token) return null;
          try {
            return await sessionUser(db, token, at);
          } catch {
            return null;
          }
        };

        // ---------------------------------------------------------- auth pages
        if (path === '/login' && method === 'GET') {
          if (!provisioned) return redirect(res, '/signup');
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(loginPage(csrf));
          return;
        }
        if (path === '/login' && method === 'POST') {
          if (!provisioned) return redirect(res, '/signup');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          // Login-CSRF: the form must echo the pre-session cookie value.
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          if (!rateOk(`login:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at)))
            return json(res, 429, { ok: false, error: 'too many attempts — slow down' });
          try {
            const { user, token } = await login(
              db,
              { tenant, email: call.fields.email ?? '', password: call.fields.password ?? '', ip },
              at,
            );
            if (user.mustChangePassword) return redirect(res, '/change-password', sessionCookie(token, at, secure));
            return redirect(res, home, sessionCookie(token, at, secure));
          } catch (e) {
            // One message for every credential failure — no user enumeration —
            // EXCEPT lockout, which the user must see to know it is not their
            // password that is wrong.
            const locked = e instanceof AuthError && e.code === 'LOCKED';
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
            res.end(loginPage(call.csrf ?? '', locked ? (e as AuthError).message : 'invalid credentials'));
            return;
          }
        }
        if (path === '/signup' && method === 'GET') {
          // Signup exists only to claim an UNPROVISIONED console. Once the
          // tenant has an owner, membership is invite-only — by design, this
          // is multi-tenant isolation at the front door.
          if (provisioned) return redirect(res, '/login');
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(signupPage(csrf, tenant));
          return;
        }
        if (path === '/signup' && method === 'POST') {
          if (provisioned) return json(res, 403, { ok: false, error: 'signup is closed — membership is invite-only' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          if (!rateOk(`signup:${ip ?? '-'}:${tenant}`, SIGNUP_RATE.limit, SIGNUP_RATE.windowMs, Date.parse(at)))
            return json(res, 429, { ok: false, error: 'too many attempts — slow down' });
          const values = {
            orgname: call.fields.orgname ?? '',
            email: call.fields.email ?? '',
            ownerName: call.fields.ownerName ?? '',
          };
          try {
            // The claimed tenant is the one this console is BOUND to — a
            // signup cannot conjure an arbitrary tenant and land on someone
            // else's report. The handle is not attacker-controlled input.
            const { tenant: created } = await signupTenant(
              db,
              {
                slug: tenant,
                name: call.fields.orgname?.trim() || tenant,
                email: call.fields.email ?? '',
                password: call.fields.password ?? '',
                ownerName: call.fields.ownerName ?? '',
              },
              at,
            );
            await auditConsole(
              db,
              created.slug,
              'web-signup',
              'auth.tenant_provisioned_web',
              `tenant:${created.slug}`,
              at,
            );
            provisioned = true;
            // Sign the new owner straight in: one flow, no dead end. The
            // signup password was chosen interactively — no forced change.
            const { token } = await login(
              db,
              { tenant: created.slug, email: call.fields.email ?? '', password: call.fields.password ?? '', ip },
              at,
            );
            return redirect(res, home, sessionCookie(token, at, secure));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(signupPage(call.csrf ?? '', tenant, signupErrorMessage(e), values));
            return;
          }
        }
        if (path === '/change-password' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(changePasswordPage(auth.session.csrfToken));
          return;
        }
        if (path === '/change-password' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          try {
            await changePassword(db, auth.user.tenant, auth.user.id, call.fields.password ?? '', at);
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(changePasswordPage(auth.session.csrfToken, (e as Error).message));
            return;
          }
          // changePassword revoked every session, including this one — re-login.
          return redirect(res, '/login', CLEAR_SESSION_COOKIE);
        }
        if (path === '/logout' && method === 'POST') {
          const auth = await sessionOf();
          if (auth) {
            let call: Call;
            try {
              call = await parseCall(req);
            } catch {
              return json(res, 400, { ok: false, error: 'malformed body' });
            }
            if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
            const token = cookieValue(req, 'vital_session');
            if (token) await logout(db, token, at);
          }
          return redirect(res, '/login', CLEAR_SESSION_COOKIE);
        }

        // ------------------------------------------------------- the console
        // Public, unauthenticated, rate-limited: lets a static site show a
        // live console pill. Deliberately returns nothing sensitive.
        if (method === 'GET' && path === '/api/health') {
          if (!rateOk(`health:${ip ?? '-'}`, 60, 60_000, Date.parse(at)))
            return json(res, 429, { ok: false, error: 'slow down' });
          // CORS open on purpose: this route is for public status pills on
          // the static site and carries nothing sensitive.
          res.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          });
          res.end(JSON.stringify({ ok: true, engine: db.engine, at }));
          return;
        }
        if (method === 'GET' && path === home) {
          if (!provisioned) return redirect(res, '/signup');
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const html = renderHtml(await buildReport(db, ledger, coord, comp, tenant, at));
          // The CSRF token rides in the page so same-origin form posts and
          // same-origin fetches can both present it.
          const withCsrf = html.replace(
            '</head>',
            `<meta name="vital-csrf" content="${esc(auth.session.csrfToken)}"></head>`,
          );
          const withUser = withCsrf.replace(
            '</body>',
            `<div style="margin-top:24px;display:flex;gap:12px;align-items:center" class="sub">
  <span>signed in as ${esc(auth.user.email)} · ${esc(auth.user.role)}</span>
  <a href="/team">team</a>
  <form method="post" action="/logout" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(auth.session.csrfToken)}">
    <button type="submit" style="background:#6B7280">Sign out</button>
  </form>
</div></body>`,
          );
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(withUser);
          return;
        }

        // ------------------------------------------------------------ team
        if (method === 'GET' && path === '/team') {
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const html = teamPage(auth.session.csrfToken, auth.user, await listUsers(db, tenant));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (path === '/team/invite' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          try {
            const invited = await inviteUser(
              db,
              tenant,
              {
                email: call.fields.email ?? '',
                name: call.fields.name ?? '',
                role: (call.fields.role as User['role']) ?? 'member',
                password: call.fields.password ?? '',
              },
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'team.invite',
              `user:${invited.id}`,
              at,
              `role=${invited.role}`,
            );
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              `${invited.email} invited as ${invited.role} — they must change the password at first login`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              `invite failed: ${(e as Error).message}`,
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/disable' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirect(res, '/login');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          try {
            const target = await getUser(db, tenant, call.fields.userId ?? '');
            if (!target) return json(res, 404, { ok: false, error: 'no such user' });
            // An admin may not disable an owner; the owner may disable anyone.
            if (target.role === 'owner' && auth.user.role !== 'owner')
              return json(res, 403, { ok: false, error: 'only the owner may disable the owner' });
            if (target.id === auth.user.id) return json(res, 400, { ok: false, error: 'you cannot disable yourself' });
            await disableUser(db, tenant, target.id, at);
            await auditConsole(db, tenant, by(auth.user), 'team.disable', `user:${target.id}`, at);
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              `${target.email} disabled — their sessions were revoked`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              `disable failed: ${(e as Error).message}`,
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }

        const act = path.match(/^\/api\/requests\/([^/]+)\/(approve|decline)$/);
        if (method === 'POST' && act) {
          const auth = await sessionOf();
          if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          // Role policy: the R/A/I matrix governs agent autonomy; this gate
          // governs which HUMAN role may approve. Default `member` (room-agent
          // model); tenants may raise it.
          if (!atLeast(auth.user.role, approverMin))
            return json(res, 403, {
              ok: false,
              error: `approving requires ${approverMin} (you are ${auth.user.role})`,
            });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const id = decodeURIComponent(act[1]!);
          const current = await coord.get(tenant, id);
          if (!current) {
            json(res, 404, { ok: false, error: `unknown request ${id}` });
            return;
          }
          // The approver is the authenticated identity — the body cannot
          // name a human, so "approval theater" needs a compromised session.
          const who = by(auth.user);
          try {
            if (act[2] === 'approve') {
              const next = await coord.accept(tenant, id);
              await auditConsole(db, tenant, who, 'console.approve', `request:${id}`, at);
              json(res, 200, { ok: true, id, state: next.state, by: who });
            } else {
              const next = await coord.decline(tenant, id, call.fields.reason || `declined by ${who}`);
              await auditConsole(db, tenant, who, 'console.decline', `request:${id}`, at);
              json(res, 200, { ok: false, id, state: next.state, by: who });
            }
          } catch (e) {
            json(res, 409, { ok: false, error: (e as Error).message });
          }
          return;
        }

        // Approval-latency distribution (TODO 2.3): the curation-cost clock.
        // Session-gated like every other read — a latency distribution leaks
        // who approves what, and how slowly.
        if (method === 'GET' && path === '/api/approval-latency') {
          const auth = await sessionOf();
          if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          json(res, 200, await coord.approvalLatencyStats(tenant));
          return;
        }

        // Cost-per-signal (TODO 4.1): the spend-side gate — MODEL share of
        // arrivals vs <1%. Read-only, but it leaks routing economics; keep it
        // behind the same session gate as the other read APIs.
        if (method === 'GET' && path === '/api/cost-per-signal') {
          const auth = await sessionOf();
          if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          json(res, 200, await new CognitiveRouter(db).costPerSignal(tenant));
          return;
        }

        // Override capture (TODO 2.3): a human edits a claim → correctClaim
        // supersedes the old row and audits the diff; then the eval spine
        // converts the audit row into a regression case, so every override
        // teaches the machine exactly what it got wrong. The corrector is the
        // SESSION identity — the body's `by` is ignored here, as in approvals.
        const fix = path.match(/^\/api\/claims\/([^/]+)\/correct$/);
        if (method === 'POST' && fix) {
          const auth = await sessionOf();
          if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const statement = call.fields.statement ?? '';
          if (!statement) {
            json(res, 400, {
              ok: false,
              error: 'a correction needs the corrected statement — pass { statement }',
            });
            return;
          }
          let id: string;
          try {
            id = decodeURIComponent(fix[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed claim id' });
            return;
          }
          try {
            const old = await ledger.get(tenant, id);
            if (!old) {
              json(res, 404, { ok: false, error: `unknown claim ${id}` });
              return;
            }
            const who = by(auth.user);
            const neu = await ledger.correctClaim(tenant, id, statement, who, at);
            await auditConsole(db, tenant, who, 'console.correct', `claim:${id}`, at, `superseded_by=${neu.id}`);
            // Feed the eval spine. The CLAIM_CORRECTED audit row (target
            // `oldId->newId`) is the spine's intake; a spine failure must not
            // un-correct the claim, so this degrades to evalCaseId: null.
            let evalCaseId: string | null = null;
            try {
              const seqRow = (await db
                .prepare(
                  "SELECT seq FROM audit_log WHERE tenant = ? AND action = 'CLAIM_CORRECTED' AND target = ? ORDER BY seq DESC LIMIT 1",
                )
                .get(tenant, `${old.id}->${neu.id}`)) as { seq: number } | undefined;
              if (seqRow) {
                const kase = await proposeEvalFromCorrection(
                  db,
                  (cid) =>
                    ledger.get(tenant, cid).then((c) => (c ? { subject: c.subject, statement: c.statement } : null)),
                  tenant,
                  Number(seqRow.seq),
                  'overrides',
                );
                evalCaseId = kase.id;
              }
            } catch {
              evalCaseId = null;
            }
            json(res, 200, {
              ok: true,
              supersedes: old.id,
              supersededBy: neu.id,
              diff: { before: old.statement, after: neu.statement },
              evalCaseId,
            });
          } catch (e) {
            json(res, 409, { ok: false, error: (e as Error).message });
          }
          return;
        }

        // Static site fallthrough (opt-in via siteDir). Console routes and
        // the auth pages always take precedence; only unmatched GETs fall
        // through to files, with traversal-defence inside serveStatic.
        if (siteDir && method === 'GET') {
          const file = await serveStatic(siteDir, path);
          if (file) {
            res.writeHead(200, { 'content-type': file.type });
            res.end(file.body);
            return;
          }
        }

        json(res, 404, { ok: false, error: 'not found' });
      })().catch(() => {
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
        else res.end();
      });
    });

    return new Promise<ConsoleServer>((resolve, reject) => {
      // Track sockets so close() never waits on keep-alive connections.
      const open = new Set<Socket>();
      server.on('connection', (sock) => {
        open.add(sock);
        sock.on('close', () => open.delete(sock));
      });
      server.once('error', reject);
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('[console:UNBOUND] server did not bind'));
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((r) => {
              for (const sock of open) sock.destroy();
              server.close(() => r());
            }),
        });
      });
    });
  })();
}
