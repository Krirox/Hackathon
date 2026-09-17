import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve as resolvePath, sep as pathSep } from 'node:path';
import type { Socket } from 'node:net';
import type { AsyncDb } from '../core/db.ts';
import {
  AuthError,
  changePassword,
  claimTenantOwner,
  confirmPasswordReset,
  csrfOk,
  acceptInvitation,
  changeUserRole,
  createInvitation,
  disableUser,
  getTenant,
  getUser,
  installAuthSchema,
  inviteUser,
  listInvitations,
  listUsers,
  membershipStatus,
  peekInvitationByToken,
  reactivateUser,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  login,
  logout,
  sessionCookie,
  sessionUser,
  signupTenant,
  tenantAccessState,
  tryPasswordReset,
  atLeast,
  assertAccountActivated,
  grantableRoles,
  parseRole,
  setupSecretOk,
  signupRequiresSetupSecret,
  CLEAR_SESSION_COOKIE,
  type Invitation,
  type Session,
  type TenantAccessState,
  type User,
} from '../core/auth.ts';
import { LedgerError, type Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { approvalMessage, effectiveKeys, listOperatorKeys, operatorKeyId, verifyApproval } from '../gov/operator.ts';
import { buildReport } from './report.ts';
import { renderHtml } from './render.ts';
import { renderReview } from './review.ts';
import {
  buildActivationState,
  loadActivationConfig,
  parseActivationConfigInput,
  recordFirstReviewAt,
  recordSignupAt,
  renderActivationPanel,
  renderSetupPage,
  collectorName,
  runConfiguredIngestion,
  saveActivationConfig,
  seedSampleWalkthrough,
  startFirstReleaseWorkflow,
  testConfiguredSource,
} from './activation.ts';
import { getIntegrationHealth } from '../ingest/health.ts';
import { claimDetail, decisionDetail, detailDocument, requestDetail } from './detail.ts';
import {
  buildWorkspaceView,
  cancelWorkflow,
  captureWorkflowOutcome,
  listWorkflows,
  preregisterWorkflowMetrics,
  renderWorkflowDetailPage,
  renderWorkflowListPage,
  retryWorkflow,
} from './release-workspace.ts';
import { deliverableDetailPage } from './deliverable.ts';
import {
  approveDeliverableVersion,
  loadDeliverableVersion,
  readDeliverableArtifact,
  requestDeliverableRevision,
} from '../wedge/deliverable-artifact.ts';
import { join } from 'node:path';
import { proposeEvalFromCorrection } from '../evals/runner.ts';
import { CognitiveRouter } from '../router/router.ts';
import {
  isBrowserForm,
  loginPath,
  safeReturnPath,
  sessionExpiredPayload,
} from './session-flow.ts';

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
  /** Address the HTTP server bound to (e.g. `127.0.0.1` or `0.0.0.0`). */
  host: string;
  port: number;
  /** Bound listen target (`host:port`). */
  address: string;
  close(): Promise<void>;
}

/** Default console bind — loopback only; production sets HOST=0.0.0.0 explicitly. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** True when the bind address accepts only local connections. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function hasBootstrapCreds(): boolean {
  const email = process.env.VITAL_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  return Boolean(email && process.env.VITAL_BOOTSTRAP_PASSWORD);
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
  /**
   * Additional mutation gate via `x-vital-operator`, never a replacement
   * for session, tenant, role or CSRF checks. Ignored when operatorKeys is
   * nonempty; key mode must not downgrade to a shared secret.
   */
  operatorSecret?: string;
  /**
   * Nonempty keys require additional ed25519 proof via x-vital-signature.
   * Sign the canonical envelope using the SESSION identity `userId (email)`,
   * not the body's by field. Live registry keys join the configured keys;
   * revocation wins and registry corruption denies. Responses add keyId and
   * an optional registry keyName (a label, not the authenticated identity).
   */
  operatorKeys?: string[];
  /**
   * FLOW-007: deliberate authorization for first-owner web claiming. When set
   * (or when the caller is not loopback and no secret is configured), /signup
   * POST requires `x-vital-setup` or a matching `setupSecret` form field.
   */
  setupSecret?: string;
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

async function loginTenantContext(db: AsyncDb, slug: string): Promise<{ boundSlug: string; boundName: string }> {
  const t = await getTenant(db, slug);
  return { boundSlug: slug, boundName: t?.name ?? slug };
}

function loginPage(
  csrf: string,
  opts: {
    error?: string;
    notice?: string;
    next?: string;
    recovery?: boolean;
    email?: string;
    expired?: boolean;
    boundSlug?: string;
    boundName?: string;
  } = {},
): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  const slug = opts.boundSlug ?? 'this-organization';
  const name = opts.boundName ?? slug;
  const expiredNotice = opts.expired
    ? '<p class="sub"><strong>Sign in to continue</strong> — your session expired. You will return to your task after signing in.</p>'
    : '';
  return page(
    'Vital Console — sign in',
    `<h1>Sign in to ${esc(name)}</h1>
<p class="sub">This console serves the organization <code>${esc(slug)}</code>. Membership is invite-only — ask your administrator if you need access.</p>
${expiredNotice}
${opts.notice ? `<p class="sub">${esc(opts.notice)}</p>` : ''}
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
${
  opts.recovery
    ? `<p class="sub">This organization has accounts but no usable owner. Ask your operator to run <code>vital passwd</code> or issue a reset link with <code>vital reset-link</code>.</p>`
    : ''
}
<form method="post" action="/login">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${nextField}
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" value="${esc(opts.email ?? '')}" autocomplete="username" required>
  <label class="sub" for="password">password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="sub"><a href="/forgot-password${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}">Forgot password?</a></p>
<p class="sub">Deploying a new instance? <a href="mailto:hello@vital.company">Contact us</a> for a pilot walkthrough — this console does not create additional tenants.</p>`,
  );
}

function forgotPasswordPage(csrf: string, opts: { error?: string; notice?: string; next?: string } = {}): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  return page(
    'Vital Console — reset password',
    `<h1>Reset your password</h1>
<p class="sub">Enter the email for your account. If it exists, a single-use reset link is issued.
There is no outbound mailer yet — your operator can deliver the link with <code>vital reset-link</code>,
or set a temporary password with <code>vital passwd</code>.</p>
${opts.notice ? `<p class="sub">${esc(opts.notice)}</p>` : ''}
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<form method="post" action="/forgot-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${nextField}
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <button type="submit">Request reset link</button>
</form>
<p class="sub"><a href="/login">Back to sign in</a></p>`,
  );
}

function resetPasswordPage(
  csrf: string,
  token: string,
  opts: { error?: string; next?: string } = {},
): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  return page(
    'Vital Console — choose a new password',
    `<h1>Choose a new password</h1>
<p class="sub">This link is single-use and expires shortly. Saving a new password signs out every other session.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<form method="post" action="/reset-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="token" value="${esc(token)}">
  ${nextField}
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save new password</button>
</form>
<p class="sub"><a href="/login">Back to sign in</a></p>`,
  );
}

function recoveryPage(boundSlug: string): string {
  return page(
    'Vital Console — owner recovery required',
    `<h1>Owner recovery required</h1>
<p class="sub">The organization <strong>${esc(boundSlug)}</strong> has member accounts but no active owner.
Self-serve claiming is closed to protect established organizations.</p>
<p class="sub">Ask your operator to:</p>
<ul class="sub">
  <li>set a temporary password: <code>vital passwd --tenant ${esc(boundSlug)} --email &lt;owner&gt; --password '…'</code> (forces a change at next sign-in), or</li>
  <li>issue a browser reset link: <code>vital reset-link --tenant ${esc(boundSlug)} --email &lt;owner&gt;</code></li>
</ul>
<p class="sub"><a href="/login">Back to sign in</a> · <a href="/forgot-password">Forgot password?</a></p>`,
  );
}

function signupPage(
  csrf: string,
  boundSlug: string,
  error?: string,
  values: { email?: string; ownerName?: string; orgname?: string } = {},
  needsSetupSecret = false,
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
  ${
    needsSetupSecret
      ? `<label class="sub" for="setupSecret">setup authorization</label>
  <input id="setupSecret" name="setupSecret" type="password" autocomplete="off" required>`
      : ''
  }
  <button type="submit">Claim this organization</button>
</form>
<p class="sub">Already have an account? <a href="/login">Sign in</a>.</p>`,
  );
}

function changePasswordPage(csrf: string, error?: string): string {
  return page(
    'Vital Console — activate your account',
    `<h1>Activate your account</h1>
<p class="sub">Your operator issued a temporary password. Choose a new one before using the console.
Saving signs out every other session — you will sign in again afterward.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/change-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save and sign in again</button>
</form>`,
  );
}

function accountPage(csrf: string, user: User, error?: string, notice?: string): string {
  return page(
    'Vital Console — account and security',
    `<h1>Account and security</h1>
<p class="sub">Signed in as ${esc(user.email)} · ${esc(user.role)}</p>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<h2>Change password</h2>
<p class="sub">Saving a new password signs out every other session. You will sign in again on this device afterward.</p>
<form method="post" action="/account/password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save new password</button>
</form>
<p class="sub"><a href="/">Back to console</a> · <a href="/team">Team</a></p>`,
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
  json?: Record<string, unknown>;
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
    return { csrf: (req.headers['x-vital-csrf'] as string | undefined) ?? null, fields: flat, json: body };
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
async function ensureBootstrapOwner(db: AsyncDb, tenant: string, now: string): Promise<TenantAccessState> {
  const state = await tenantAccessState(db, tenant);
  if (state !== 'unclaimed') return state;
  const email = process.env.VITAL_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.VITAL_BOOTSTRAP_PASSWORD;
  if (!email || !password) return 'unclaimed';
  const known = await getTenant(db, tenant);
  if (!known) {
    await signupTenant(db, { slug: tenant, name: tenant, email, password, ownerName: 'Console Owner' }, now);
    return 'ready';
  }
  await inviteUser(
    db,
    tenant,
    { email, name: 'Console Owner', role: 'owner', password },
    { userId: 'bootstrap', role: 'owner' },
    now,
  );
  return 'ready';
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

/** Co-hosted marketing HTML: never ship a visitor-localhost console URL. */
export function prepareCoHostedSiteHtml(body: Buffer<ArrayBufferLike>): Buffer {
  const html = body.toString('utf8');
  return Buffer.from(
    html.replace(
      /<meta\s+name="vital-console-url"\s+content="[^"]*"\s*\/?>/i,
      '<meta name="vital-console-url" content=""/>',
    ),
    'utf8',
  );
}

/**
 * Serve one file from `siteDir` with path-traversal defence: resolve and
 * verify the real path stays inside the root. Returns null when the request
 * does not map to a file (caller falls through to its own routing).
 */
async function serveStatic(
  siteDir: string,
  pathname: string,
  coHosted = false,
): Promise<{ body: Buffer; type: string } | null> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const root = resolvePath(siteDir);
  const target = resolvePath(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + pathSep)) return null; // traversal
  try {
    const st = await stat(target);
    if (!st.isFile()) return null;
    const type = MIME[extname(target)] ?? 'application/octet-stream';
    let body = await readFile(target);
    if (coHosted && type.startsWith('text/html')) body = Buffer.from(prepareCoHostedSiteHtml(body));
    return { body, type };
  } catch {
    return null;
  }
}

function statusLabel(user: User): string {
  const s = membershipStatus(user);
  if (s === 'disabled') return '<span class="err">disabled</span>';
  if (s === 'pending_activation') return '<span class="sub">pending activation</span>';
  return 'active';
}

function invitationLabel(inv: Invitation): string {
  if (inv.status === 'pending') return '<span class="sub">invited</span>';
  if (inv.status === 'expired') return '<span class="err">expired</span>';
  if (inv.status === 'revoked') return '<span class="err">revoked</span>';
  return 'accepted';
}

/** An admin (or the owner) may disable a member; nobody disables an owner but the owner, or themselves. */
function canDisable(viewer: User, u: User): boolean {
  if (u.disabled) return false;
  if (!atLeast(viewer.role, 'admin')) return false;
  if (u.role === 'owner' && viewer.role !== 'owner') return false;
  return u.id !== viewer.id;
}

function canReactivate(viewer: User, u: User): boolean {
  return u.disabled && atLeast(viewer.role, 'admin') && !viewer.mustChangePassword;
}

function canChangeRole(viewer: User, u: User): boolean {
  if (viewer.mustChangePassword || u.disabled) return false;
  if (u.id === viewer.id && viewer.role === 'owner') return false;
  if (u.role === 'owner' && viewer.role !== 'owner') return false;
  return atLeast(viewer.role, 'admin');
}

function handoffOptions(users: User[], excludeId: string): string {
  return users
    .filter((u) => !u.disabled && u.id !== excludeId)
    .map((u) => `<option value="${esc(u.id)}">${esc(u.email)} (${esc(u.role)})</option>`)
    .join('');
}

function disableForm(csrf: string, u: User, users: User[]): string {
  const handoff = handoffOptions(users, u.id);
  return `<details>
  <summary style="cursor:pointer;color:#6B7280">Disable</summary>
  <form method="post" action="/team/disable" style="margin-top:8px;display:grid;gap:8px;max-width:360px">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    <p class="sub">Disabling <strong>${esc(u.name)}</strong> (${esc(u.email)}) revokes every live session immediately. They cannot sign in again until reactivated.</p>
    <label class="sub" for="confirm-${esc(u.id)}">type their email to confirm</label>
    <input id="confirm-${esc(u.id)}" name="confirmEmail" type="email" required placeholder="${esc(u.email)}">
    ${
      handoff
        ? `<label class="sub" for="handoff-${esc(u.id)}">hand outstanding claims/requests to</label>
    <select id="handoff-${esc(u.id)}" name="handoffToUserId">
      <option value="">— choose if they own open work —</option>
      ${handoff}
    </select>`
        : ''
    }
    <button type="submit" style="background:#6B7280">Disable member</button>
  </form>
</details>`;
}

function roleForm(csrf: string, viewer: User, u: User): string {
  const options = grantableRoles(viewer.role)
    .map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${r}</option>`)
    .join('');
  return `<form method="post" action="/team/role" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    <select name="role" onchange="this.form.submit()">${options}</select>
  </form>`;
}

function teamPage(
  csrf: string,
  viewer: User,
  users: User[],
  invitations: Invitation[],
  notice?: string,
): string {
  const canManage = atLeast(viewer.role, 'admin') && !viewer.mustChangePassword;
  const roleOptions = grantableRoles(viewer.role)
    .map((r) => `<option value="${r}">${r}</option>`)
    .join('');
  const pendingInvites = invitations.filter((i) => i.status === 'pending' || i.status === 'expired');
  const inviteRows = pendingInvites
    .map((inv) => {
      const actions =
        canManage && inv.status !== 'accepted'
          ? `<form method="post" action="/team/invitation/resend" style="display:inline">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="invitationId" value="${esc(inv.id)}">
      <button type="submit">Resend</button>
    </form>
    <form method="post" action="/team/invitation/revoke" style="display:inline">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="invitationId" value="${esc(inv.id)}">
      <button type="submit" style="background:#6B7280">Revoke</button>
    </form>`
          : '';
      return `<tr>
  <td>${esc(inv.email)}</td>
  <td>${esc(inv.name)}</td>
  <td>${esc(inv.role)}</td>
  <td>${invitationLabel(inv)}</td>
  <td class="sub">${esc(inv.expiresAt.slice(0, 10))}</td>
  <td>${actions}</td>
</tr>`;
    })
    .join('');
  const rows = users
    .map((u) => {
      const actions: string[] = [];
      if (canChangeRole(viewer, u)) actions.push(roleForm(csrf, viewer, u));
      if (viewer.role === 'owner' && !u.disabled && u.role !== 'owner' && u.id !== viewer.id)
        actions.push(`<form method="post" action="/team/transfer-ownership" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    <button type="submit">Make owner</button>
  </form>`);
      if (canReactivate(viewer, u))
        actions.push(`<form method="post" action="/team/reactivate" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    <button type="submit">Reactivate</button>
  </form>`);
      if (canDisable(viewer, u)) actions.push(disableForm(csrf, u, users));
      return `<tr>
  <td>${esc(u.email)}${u.id === viewer.id ? ' <span class="sub">(you)</span>' : ''}</td>
  <td>${esc(u.name)}</td>
  <td>${esc(u.role)}</td>
  <td>${statusLabel(u)}</td>
  <td>${actions.join(' ')}</td>
</tr>`;
    })
    .join('');
  return page(
    'Vital Console — team',
    `<p class="sub"><a href="/">← console</a></p>
<h1>Team</h1>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
<h2>Members</h2>
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${
  pendingInvites.length
    ? `<h2>Pending invitations</h2>
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th align="left">expires</th><th></th></tr></thead>
  <tbody>${inviteRows}</tbody>
</table>`
    : ''
}
${
  canManage
    ? `<h2>Create account</h2>
<p class="sub">Creates a pending invitation. Deliver the acceptance link to this person out of band (email, chat, ticket). They choose their own password when accepting — you never set it here.</p>
<form method="post" action="/team/invite">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" required>
  <label class="sub" for="name">name</label>
  <input id="name" name="name" required>
  <label class="sub" for="role">role</label>
  <select id="role" name="role">
    ${roleOptions}
  </select>
  <button type="submit">Create account</button>
</form>`
    : '<p class="sub">Ask an admin or the owner to create accounts.</p>'
}
`,
  );
}

function acceptInvitePage(
  csrf: string,
  token: string,
  inv: Invitation,
  opts: { error?: string } = {},
): string {
  return page(
    'Vital Console — accept invitation',
    `<h1>Join ${esc(inv.tenant)}</h1>
<p class="sub">You were invited as <strong>${esc(inv.role)}</strong>. Choose a password to activate <strong>${esc(inv.email)}</strong>.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<form method="post" action="/accept-invite">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="token" value="${esc(token)}">
  <label class="sub" for="name">name</label>
  <input id="name" name="name" value="${esc(inv.name)}" readonly>
  <label class="sub" for="email">email</label>
  <input id="email" name="email" type="email" value="${esc(inv.email)}" readonly>
  <label class="sub" for="password">password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Create my account</button>
</form>
<p class="sub"><a href="/login">Already have an account? Sign in</a></p>`,
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
  const bindHost = opts.host ?? DEFAULT_BIND_HOST;
  const publicBind = !isLoopbackBindHost(bindHost);
  const now = opts.now ?? (() => new Date().toISOString());
  const secure = opts.secureCookies ?? false;
  const approverMin = opts.approverRole ?? 'member';
  const siteDir = opts.siteDir ? resolvePath(opts.siteDir) : undefined;
  // When a site is mounted, the marketing page owns `/` and the console app
  // lives under `/console` (login/signup/change-password keep their paths —
  // they are console routes regardless).
  const home = siteDir ? '/console' : '/';
  const operatorSecret = opts.operatorSecret ?? null;
  const setupSecret = opts.setupSecret ?? process.env.VITAL_SETUP_SECRET ?? null;
  const operatorKeys = opts.operatorKeys ?? [];
  for (const pem of operatorKeys) operatorKeyId(pem);
  const keyAuth = operatorKeys.length > 0;
  const authorized = (req: IncomingMessage): boolean => {
    if (!operatorSecret) return true;
    const got = req.headers['x-vital-operator'];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got);
    const b = Buffer.from(operatorSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const setupAuthorized = (req: IncomingMessage, presented?: string | null): boolean => {
    if (!setupSecret) return !signupRequiresSetupSecret(req.socket.remoteAddress, null);
    const fromHeader = req.headers['x-vital-setup'];
    const token = typeof fromHeader === 'string' ? fromHeader : presented;
    return setupSecretOk(token, setupSecret);
  };
  const activationDenied = (res: ServerResponse, auth: { user: User }, jsonMode: boolean): boolean => {
    try {
      assertAccountActivated(auth.user);
      return false;
    } catch (e) {
      if (jsonMode) {
        json(res, 403, {
          ok: false,
          error: e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message,
          code: e instanceof AuthError ? e.code : 'ACTIVATION_REQUIRED',
        });
      } else {
        redirect(res, '/change-password');
      }
      return true;
    }
  };
  const verifyingKey = async (
    req: IncomingMessage,
    id: string,
    action: string,
    who: string,
  ): Promise<{ keyId: string; keyName?: string } | null> => {
    const sig = req.headers['x-vital-signature'];
    if (typeof sig !== 'string' || !sig) return null;
    try {
      const msg = approvalMessage(tenant, id, action, who);
      for (const key of effectiveKeys(operatorKeys, await listOperatorKeys(db, tenant))) {
        if (verifyApproval(key.publicKeyPem, msg, sig))
          return { keyId: key.keyId, ...(key.name === null ? {} : { keyName: key.name }) };
      }
    } catch {
      // Malformed input or registry corruption must never permit a mutation.
    }
    return null;
  };
  const artifactDir = process.env.ARTIFACT_DIR ?? join('data', 'artifacts');
  const metrics = { requests: 0, errors: 0, reportBuilds: 0, reportBuildMs: 0, startedAt: Date.now() };
  // Share the base report only; inject each session's identity and CSRF afterwards.
  const inflight = new Map<string, Promise<string>>();
  const reportHtml = (t: string, at: string): Promise<string> => {
    const running = inflight.get(t);
    if (running) return running;
    const build = (async () => {
      try {
        const t0 = Date.now();
        const html = renderHtml(await buildReport(db, ledger, coord, comp, t, at), true);
        metrics.reportBuilds += 1;
        metrics.reportBuildMs += Date.now() - t0;
        return html;
      } finally {
        inflight.delete(t);
      }
    })();
    inflight.set(t, build);
    return build;
  };

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
    await ensureBootstrapOwner(db, tenant, now());
    let boundAddress = `${bindHost}:pending`;

    const server: Server = createServer((req, res) => {
      const started = Date.now();
      let logPath = 'unmatched';
      res.on('finish', () => {
        metrics.requests += 1;
        console.log(
          JSON.stringify({
            at: new Date(started).toISOString(),
            method: req.method,
            path: logPath,
            status: res.statusCode,
            ms: Date.now() - started,
          }),
        );
      });
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://console');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        // Route templates avoid logging tenant data, identifiers, or query strings.
        if (/^\/api\/requests\/[^/]+\/(approve|decline)$/.test(path))
          logPath = `/api/requests/:id/${path.endsWith('/approve') ? 'approve' : 'decline'}`;
        else if (/^\/api\/claims\/[^/]+\/correct$/.test(path)) logPath = '/api/claims/:id/correct';
        else if (/^\/api\/requests\/[^/]+\/refresh-evidence$/.test(path))
          logPath = '/api/requests/:id/refresh-evidence';
        else if (
          [
            home,
            '/login',
            '/signup',
            '/logout',
            '/change-password',
            '/account',
            '/account/password',
            '/forgot-password',
            '/reset-password',
            '/team',
            '/team/invite',
            '/team/disable',
            '/team/reactivate',
            '/team/role',
            '/team/transfer-ownership',
            '/team/invitation/resend',
            '/team/invitation/revoke',
            '/accept-invite',
            '/setup',
            '/setup/ingest',
            '/setup/test-source',
            '/setup/sample',
            '/setup/start-release',
            '/api/ingest/health',
            '/healthz',
            '/api/health',
            '/api/metrics',
            '/api/approval-latency',
            '/api/cost-per-signal',
          ].includes(path)
        )
          logPath = path;
        if (method === 'GET' && path === '/healthz')
          return json(res, 200, { ok: true, vital: '0.0.1', listen: boundAddress });
        const ip = req.socket.remoteAddress ?? undefined;
        const at = now();

        const sessionToken = cookieValue(req, 'vital_session');
        const hadSessionCookie = Boolean(sessionToken);
        const sessionOf = async (): Promise<{ session: Session; user: User } | null> => {
          if (!sessionToken) return null;
          try {
            return await sessionUser(db, sessionToken, at);
          } catch {
            return null;
          }
        };
        const returnPath = (): string => path + (url.search || '');
        const redirectLogin = (expired = hadSessionCookie): void => {
          const loc = loginPath({ next: returnPath(), reason: expired ? 'expired' : undefined });
          if (expired && hadSessionCookie) redirect(res, loc, CLEAR_SESSION_COOKIE);
          else redirect(res, loc);
        };
        const sessionExpiredApi = (): void => {
          json(res, 401, sessionExpiredPayload(returnPath()));
        };
        const accessState = await tenantAccessState(db, tenant);
        const exposeResetToken = process.env.VITAL_EXPOSE_RESET_TOKEN === '1';

        // ---------------------------------------------------------- auth pages
        if (path === '/login' && method === 'GET') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          const expired = url.searchParams.get('reason') === 'expired';
          const notice =
            url.searchParams.get('reset') === 'ok'
              ? 'Password saved. Every other session was signed out — sign in to continue.'
              : undefined;
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          const tenantCtx = await loginTenantContext(db, tenant);
          res.end(
            loginPage(csrf, {
              notice,
              next,
              recovery: accessState === 'recovery',
              expired,
              ...tenantCtx,
            }),
          );
          return;
        }
        if (path === '/login' && method === 'POST') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          const next = safeReturnPath(call.fields.next);
          const email = call.fields.email ?? '';
          // Login-CSRF: the form must echo the pre-session cookie value.
          if (!preCsrfOk(req, call.csrf)) {
            const fresh = randomBytes(32).toString('hex');
            const msg = 'This sign-in form expired. Your email is preserved — submit again.';
            if (isBrowserForm(req)) {
              res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'set-cookie': preCsrfCookie(fresh, secure),
              });
              const tenantCtx = await loginTenantContext(db, tenant);
              res.end(
                loginPage(fresh, { error: msg, next, email, recovery: accessState === 'recovery', ...tenantCtx }),
              );
              return;
            }
            return json(res, 403, { ok: false, error: msg });
          }
          if (!rateOk(`login:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at))) {
            const bucket = buckets.get(`login:${ip ?? '-'}:${tenant}`);
            const retryAt = bucket ? new Date(bucket.reset).toISOString() : undefined;
            const msg = retryAt
              ? `too many attempts — try again after ${retryAt}`
              : 'too many attempts — slow down and try again in a few minutes';
            if (isBrowserForm(req)) {
              res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
              const tenantCtx = await loginTenantContext(db, tenant);
              res.end(
                loginPage(call.csrf ?? '', { error: msg, next, email, recovery: accessState === 'recovery', ...tenantCtx }),
              );
              return;
            }
            return json(res, 429, { ok: false, error: msg, retryAt });
          }
          try {
            const { user, session, token } = await login(
              db,
              { tenant, email, password: call.fields.password ?? '', ip },
              at,
            );
            const cookie = sessionCookie(token, at, secure, session);
            if (user.mustChangePassword) return redirect(res, '/change-password', cookie);
            return redirect(res, next ?? home, cookie);
          } catch (e) {
            // One message for every credential failure — no user enumeration —
            // EXCEPT lockout, which the user must see to know it is not their
            // password that is wrong.
            const locked = e instanceof AuthError && e.code === 'LOCKED';
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
            const tenantCtx = await loginTenantContext(db, tenant);
            res.end(
              loginPage(call.csrf ?? '', {
                error: locked ? (e as AuthError).message.replace(/^\[auth:[^\]]+\]\s*/, '') : 'invalid credentials',
                next,
                email,
                recovery: accessState === 'recovery',
                ...tenantCtx,
              }),
            );
            return;
          }
        }
        if (path === '/forgot-password' && method === 'GET') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(forgotPasswordPage(csrf, { next }));
          return;
        }
        if (path === '/forgot-password' && method === 'POST') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          if (!rateOk(`reset:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at)))
            return json(res, 429, { ok: false, error: 'too many attempts — slow down' });
          const next = safeReturnPath(call.fields.next);
          const email = call.fields.email ?? '';
          const token = await tryPasswordReset(db, tenant, email, at);
          let notice =
            'If an account exists for that email, a single-use reset link was issued. Ask your operator to deliver it, or run vital reset-link from the server.';
          if (token && exposeResetToken) {
            const link = `/reset-password?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
            notice = `Reset link (development only): ${link}`;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(forgotPasswordPage(call.csrf ?? '', { notice, next }));
          return;
        }
        if (path === '/reset-password' && method === 'GET') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          const token = url.searchParams.get('token') ?? '';
          if (!token) return redirect(res, '/forgot-password');
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(resetPasswordPage(csrf, token, { next }));
          return;
        }
        if (path === '/accept-invite' && method === 'GET') {
          const token = url.searchParams.get('token') ?? '';
          if (!token) return redirect(res, '/login');
          const inv = await peekInvitationByToken(db, token, at);
          if (!inv || inv.status === 'revoked' || inv.status === 'accepted')
            return json(res, 404, { ok: false, error: 'invitation not found or no longer valid' });
          const csrf = randomBytes(32).toString('hex');
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(acceptInvitePage(csrf, token, inv));
          return;
        }
        if (path === '/accept-invite' && method === 'POST') {
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          const token = call.fields.token ?? '';
          const inv = token ? await peekInvitationByToken(db, token, at) : undefined;
          try {
            const { user, session, token: sessionToken } = await (async () => {
              const { user } = await acceptInvitation(db, token, call.fields.password ?? '', at);
              const { session, token: sessionToken } = await login(
                db,
                { tenant: user.tenant, email: user.email, password: call.fields.password ?? '' },
                at,
              );
              return { user, session, token: sessionToken };
            })();
            return redirect(res, home, sessionCookie(sessionToken, at, secure, session));
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              inv
                ? acceptInvitePage(call.csrf ?? '', token, inv, { error: msg })
                : page('Vital Console — accept invitation', `<p class="err">${esc(msg)}</p><p class="sub"><a href="/login">Sign in</a></p>`),
            );
            return;
          }
        }
        if (path === '/reset-password' && method === 'POST') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          const next = safeReturnPath(call.fields.next);
          const token = call.fields.token ?? '';
          try {
            await confirmPasswordReset(db, token, call.fields.password ?? '', at);
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              resetPasswordPage(call.csrf ?? '', token, {
                error: e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message,
                next,
              }),
            );
            return;
          }
          const loginTarget = `/login?reset=ok${next ? `&next=${encodeURIComponent(next)}` : ''}`;
          return redirect(res, loginTarget, CLEAR_SESSION_COOKIE);
        }
        if (path === '/signup' && method === 'GET') {
          // Signup exists only to claim an UNPROVISIONED console. Once the
          // tenant has an owner, membership is invite-only — by design, this
          // is multi-tenant isolation at the front door.
          if (publicBind && !hasBootstrapCreds()) {
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              `<!doctype html><html><head><meta charset="utf-8"><title>Setup required</title></head><body>
<p>This console is reachable remotely but has no owner yet. Web signup is disabled on non-loopback binds.</p>
<p>Configure <code>VITAL_BOOTSTRAP_EMAIL</code> and <code>VITAL_BOOTSTRAP_PASSWORD</code> before exposing the service, or bind to loopback for local claiming.</p>
</body></html>`,
            );
            return;
          }
          if (accessState === 'ready') return redirect(res, '/login');
          if (accessState === 'recovery') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(recoveryPage(tenant));
            return;
          }
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure),
          });
          res.end(signupPage(csrf, tenant, undefined, {}, signupRequiresSetupSecret(ip, setupSecret)));
          return;
        }
        if (path === '/signup' && method === 'POST') {
          if (publicBind && !hasBootstrapCreds())
            return json(res, 403, {
              ok: false,
              error: 'remote signup is disabled — configure VITAL_BOOTSTRAP_EMAIL and VITAL_BOOTSTRAP_PASSWORD',
            });
          if (accessState === 'ready')
            return json(res, 403, { ok: false, error: 'signup is closed — membership is invite-only' });
          if (accessState === 'recovery')
            return json(res, 403, {
              ok: false,
              error: 'owner recovery is required — contact your operator (see /signup for instructions)',
            });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          if (!setupAuthorized(req, call.fields.setupSecret))
            return json(res, 403, {
              ok: false,
              error: setupSecret
                ? 'setup authorization required — provide the configured setup secret'
                : 'remote organization claiming requires setup authorization — configure VITAL_SETUP_SECRET',
            });
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
            const payload = {
              slug: tenant,
              name: call.fields.orgname?.trim() || tenant,
              email: call.fields.email ?? '',
              password: call.fields.password ?? '',
              ownerName: call.fields.ownerName ?? '',
            };
            const known = await getTenant(db, tenant);
            const { tenant: created } = known
              ? await claimTenantOwner(
                  db,
                  {
                    slug: tenant,
                    email: payload.email,
                    password: payload.password,
                    ownerName: payload.ownerName,
                  },
                  at,
                )
              : await signupTenant(db, payload, at);
            await recordSignupAt(db, created.slug, at);
            await auditConsole(
              db,
              created.slug,
              'web-signup',
              known ? 'auth.tenant_claimed_web' : 'auth.tenant_provisioned_web',
              `tenant:${created.slug}`,
              at,
            );
            // Sign the new owner straight in: one flow, no dead end. The
            // signup password was chosen interactively — no forced change.
            const { session, token } = await login(
              db,
              { tenant: created.slug, email: call.fields.email ?? '', password: call.fields.password ?? '', ip },
              at,
            );
            return redirect(res, home, sessionCookie(token, at, secure, session));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              signupPage(
                call.csrf ?? '',
                tenant,
                signupErrorMessage(e),
                values,
                signupRequiresSetupSecret(ip, setupSecret),
              ),
            );
            return;
          }
        }
        if (path === '/change-password' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (!auth.user.mustChangePassword) return redirect(res, '/account');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(changePasswordPage(auth.session.csrfToken));
          return;
        }
        if (path === '/change-password' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (!auth.user.mustChangePassword) return redirect(res, '/account');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) {
            if (isBrowserForm(req)) {
              res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
              res.end(changePasswordPage(auth.session.csrfToken, 'This form expired — submit again.'));
              return;
            }
            return json(res, 403, { ok: false, error: 'bad CSRF token' });
          }
          try {
            await changePassword(db, auth.user.tenant, auth.user.id, call.fields.password ?? '', at);
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              changePasswordPage(
                auth.session.csrfToken,
                e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message,
              ),
            );
            return;
          }
          // changePassword revoked every session, including this one — re-login.
          const loc = loginPath({ reset: true });
          return redirect(res, loc, CLEAR_SESSION_COOKIE);
        }
        if (path === '/account' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(accountPage(auth.session.csrfToken, auth.user));
          return;
        }
        if (path === '/account/password' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) {
            if (isBrowserForm(req)) {
              res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
              res.end(accountPage(auth.session.csrfToken, auth.user, 'This form expired — submit again.'));
              return;
            }
            return json(res, 403, { ok: false, error: 'bad CSRF token' });
          }
          try {
            await changePassword(db, auth.user.tenant, auth.user.id, call.fields.password ?? '', at);
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              accountPage(
                auth.session.csrfToken,
                auth.user,
                e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message,
              ),
            );
            return;
          }
          const loc = loginPath({ reset: true });
          return redirect(res, loc, CLEAR_SESSION_COOKIE);
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
        const deliverablePage = path.match(/^\/console\/deliverables\/([^/]+)$/);
        if (method === 'GET' && deliverablePage) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let id: string;
          try {
            id = decodeURIComponent(deliverablePage[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed deliverable id' });
          }
          const versionParam = url.searchParams.get('version');
          const versionNum = versionParam === null ? null : Number(versionParam);
          if (versionParam !== null && (!Number.isInteger(versionNum) || versionNum! < 1)) {
            return json(res, 400, { ok: false, error: 'version must be a positive integer' });
          }
          const fallbackMode = operatorSecret ? 'secret' : 'session';
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: atLeast(auth.user.role, approverMin),
            requiredRole: approverMin,
            operatorMode: keyAuth ? ('signature' as const) : (fallbackMode as 'secret' | 'session'),
            home,
          };
          const html = await deliverableDetailPage(db, ledger, id, versionNum, detailOpts, artifactDir);
          if (!html) return json(res, 404, { ok: false, error: 'deliverable not found' });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(detailDocument('Deliverable', html, detailOpts));
          return;
        }
        if (method === 'GET' && path === '/console/workflows') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const items = await listWorkflows(db, ledger, coord, comp, tenant);
          const html = renderWorkflowListPage(items, {
            home,
            csrf: auth.session.csrfToken,
            actor: by(auth.user),
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }
        const workflowDetail = path.match(/^\/console\/workflows\/([^/]+)$/);
        if (method === 'GET' && workflowDetail) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let workflowId: string;
          try {
            workflowId = decodeURIComponent(workflowDetail[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed workflow id' });
          }
          const view = await buildWorkspaceView(db, ledger, coord, comp, tenant, workflowId);
          if (!view) return json(res, 404, { ok: false, error: 'workflow not found' });
          const html = renderWorkflowDetailPage(view, {
            home,
            csrf: auth.session.csrfToken,
            actor: by(auth.user),
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }
        const workflowAction = path.match(/^\/console\/workflows\/([^/]+)\/(preregister|outcome|retry|cancel)$/);
        if (method === 'POST' && workflowAction) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          let workflowId: string;
          try {
            workflowId = decodeURIComponent(workflowAction[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed workflow id' });
          }
          const action = workflowAction[2]!;
          const who = by(auth.user);
          const workflowUrl = `/console/workflows/${encodeURIComponent(workflowId)}`;
          try {
            if (action === 'preregister') {
              await preregisterWorkflowMetrics(db, tenant, workflowId, {
                metrics: [
                  {
                    name: (call.fields.metric ?? 'ship_to_launch_hours').trim(),
                    threshold: Number(call.fields.threshold ?? '24'),
                    direction: 'lower',
                  },
                ],
                baseline: (call.fields.baseline ?? '').trim(),
                comparisonBasis: (call.fields.comparisonBasis ?? '').trim(),
                measurementWindow: {
                  start: (call.fields.windowStart ?? at).trim(),
                  end: (call.fields.windowEnd ?? at).trim(),
                },
                agreedBy: who,
                now: at,
              });
              await auditConsole(db, tenant, who, 'workflow.preregister', workflowId, at);
            } else if (action === 'outcome') {
              const view = await buildWorkspaceView(db, ledger, coord, comp, tenant, workflowId);
              await captureWorkflowOutcome(db, ledger, tenant, workflowId, {
                decisionId: (call.fields.decisionId ?? '').trim(),
                metric: (call.fields.metric ?? '').trim(),
                actual: Number(call.fields.actual),
                basis: (call.fields.basis ?? '').trim(),
                predicted: call.fields.predicted ? Number(call.fields.predicted) : undefined,
                resolvedBy: who,
                owner: who,
                scope: view?.legs[0]?.key ?? 'product',
                now: at,
              });
              await auditConsole(db, tenant, who, 'workflow.outcome', workflowId, at);
            } else if (action === 'retry') {
              await retryWorkflow(db, coord, tenant, workflowId, { retryBlocked: true });
              await auditConsole(db, tenant, who, 'workflow.retry', workflowId, at);
            } else if (action === 'cancel') {
              const reason = (call.fields.reason ?? '').trim();
              if (!reason) throw new Error('cancellation reason is required');
              await cancelWorkflow(db, tenant, workflowId, reason, at);
              await auditConsole(db, tenant, who, 'workflow.cancel', workflowId, at);
            }
            return redirect(res, workflowUrl);
          } catch (e) {
            const view = await buildWorkspaceView(db, ledger, coord, comp, tenant, workflowId);
            if (!view) return json(res, 404, { ok: false, error: 'workflow not found' });
            const html = renderWorkflowDetailPage(view, {
              home,
              csrf: auth.session.csrfToken,
              actor: who,
            }).replace('</body>', `<p class="err">${(e as Error).message}</p></body>`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        const detail = path.match(/^\/console\/(claims|requests|decisions)\/([^/]+)$/);
        if (method === 'GET' && detail) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let id: string;
          try {
            id = decodeURIComponent(detail[2]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed detail id' });
          }
          const pageIndex = Number(url.searchParams.get('page') ?? '0');
          if (!Number.isSafeInteger(pageIndex) || pageIndex < 0)
            return json(res, 400, { ok: false, error: 'page must be a nonnegative integer' });
          const fallbackMode = operatorSecret ? 'secret' : 'session';
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: atLeast(auth.user.role, approverMin),
            requiredRole: approverMin,
            operatorMode: keyAuth ? ('signature' as const) : (fallbackMode as 'secret' | 'session'),
            home,
          };
          let html: string | null;
          if (detail[1] === 'claims') {
            html = await claimDetail(db, ledger, coord, id, pageIndex, detailOpts);
          } else if (detail[1] === 'decisions') {
            html = await decisionDetail(ledger, id, detailOpts);
          } else {
            html = await requestDetail(db, coord, ledger, id, pageIndex, detailOpts);
          }
          if (!html) return json(res, 404, { ok: false, error: 'evidence not found' });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }
        if (method === 'GET' && path === home) {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          if (accessState === 'recovery') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(recoveryPage(tenant));
            return;
          }
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const reviewPage = Number(url.searchParams.get('reviewPage') ?? '0');
          if (!Number.isSafeInteger(reviewPage) || reviewPage < 0)
            return json(res, 400, { ok: false, error: 'reviewPage must be a nonnegative integer' });
          const users = await listUsers(db, tenant);
          const activationState = await buildActivationState(db, ledger, coord, tenant, at, users, {
            approverRole: approverMin,
          });
          const report = await reportHtml(tenant, at);
          const fallbackMode = operatorSecret ? 'secret' : 'session';
          const activation = renderActivationPanel(activationState, auth.session.csrfToken, home);
          const review = await renderReview(coord, ledger, {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: atLeast(auth.user.role, approverMin),
            requiredRole: approverMin,
            operatorMode: keyAuth ? 'signature' : fallbackMode,
            page: reviewPage,
            home,
          });
          const html = report.replace(
            '<h1>Reality health</h1>',
            `${activation}${review}<h1>Reality health</h1>`,
          );
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
  <a href="/account">account</a>
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

        // ---------------------------------------------------------- setup (FLOW-012)
        if (path === '/setup' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const users = await listUsers(db, tenant);
          const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
            approverRole: approverMin,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderSetupPage(state, users, auth.session.csrfToken, home));
          return;
        }
        if (path === '/setup' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const users = await listUsers(db, tenant);
          try {
            const config = parseActivationConfigInput(call.fields, users, at, tenant);
            await saveActivationConfig(db, tenant, config);
            await auditConsole(db, tenant, by(auth.user), 'setup.save', `tenant:${tenant}`, at);
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, 'Setup saved.'));
          } catch (e) {
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, (e as Error).message));
          }
          return;
        }
        if (path === '/api/ingest/health' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return json(res, 401, sessionExpiredPayload('/api/ingest/health'));
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const config = await loadActivationConfig(db, tenant);
          if (!config) return json(res, 200, { ok: true, configured: false, health: null });
          const health = await getIntegrationHealth(db, tenant, collectorName(config.sourcePath), {
            configured: true,
            scope: config.scope,
            now: at,
          });
          return json(res, 200, { ok: true, configured: true, health });
        }
        if (path === '/setup/test-source' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const config = await loadActivationConfig(db, tenant);
          if (!config) return redirect(res, '/setup');
          const users = await listUsers(db, tenant);
          const test = testConfiguredSource(config);
          const preview =
            test.preview && test.preview.samples.length > 0
              ? ` Preview: ${test.preview.samples.map((s) => s.name).join(', ')}.`
              : '';
          const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
            approverRole: approverMin,
          });
          const message = test.ok
            ? `Connection test passed (${test.code}).${preview}`
            : `Connection test failed (${test.code}): ${test.detail}`;
          res.writeHead(test.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderSetupPage(state, users, auth.session.csrfToken, home, message));
          return;
        }
        if (path === '/setup/ingest' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const config = await loadActivationConfig(db, tenant);
          if (!config) return redirect(res, '/setup');
          const users = await listUsers(db, tenant);
          try {
            const result = await runConfiguredIngestion(db, ledger, tenant, config);
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'setup.ingest',
              `tenant:${tenant}`,
              at,
              `processed=${result.processed} failed=${result.failed}`,
            );
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            const detail =
              result.errors.length > 0
                ? `Ingestion finished with ${result.failed} failure(s).`
                : `Synced ${result.processed} receipt(s).`;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, detail));
          } catch (e) {
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, (e as Error).message));
          }
          return;
        }
        if (path === '/setup/sample' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const users = await listUsers(db, tenant);
          try {
            const seeded = await seedSampleWalkthrough(db, ledger, coord, tenant, auth.user, at);
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'setup.sample',
              `request:${seeded.requestId}`,
              at,
            );
            return redirect(res, `${home}#pending-review`);
          } catch (e) {
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, (e as Error).message));
          }
          return;
        }
        if (path === '/setup/start-release' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const config = await loadActivationConfig(db, tenant);
          if (!config) return redirect(res, '/setup');
          const users = await listUsers(db, tenant);
          const accountable = users.find((u) => u.id === config.accountableOwnerId);
          if (!accountable) return redirect(res, '/setup');
          try {
            const runId = await startFirstReleaseWorkflow(db, coord, tenant, config, accountable, at);
            await auditConsole(db, tenant, by(auth.user), 'setup.start_release', `workflow:${runId}`, at);
            return redirect(res, `/console/workflows/${encodeURIComponent(runId)}`);
          } catch (e) {
            const state = await buildActivationState(db, ledger, coord, tenant, at, users, {
              approverRole: approverMin,
            });
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderSetupPage(state, users, auth.session.csrfToken, home, (e as Error).message));
          }
          return;
        }

        // ------------------------------------------------------------ team
        const teamData = async () => ({
          users: await listUsers(db, tenant),
          invitations: await listInvitations(db, tenant, at),
        });

        if (method === 'GET' && path === '/team') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const data = await teamData();
          const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (path === '/team/invite' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const { invitation, token } = await createInvitation(
              db,
              tenant,
              {
                email: call.fields.email ?? '',
                name: call.fields.name ?? '',
                role: parseRole(call.fields.role ?? 'member'),
              },
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'team.invite',
              `invitation:${invitation.id}`,
              at,
              `role=${invitation.role}`,
            );
            const link = `/accept-invite?token=${encodeURIComponent(token)}`;
            const exposeInvite =
              process.env.VITAL_EXPOSE_INVITE_LINK === '1'
                ? ` Acceptance link (deliver out of band): ${link}`
                : ' Deliver the acceptance link out of band — run with VITAL_EXPOSE_INVITE_LINK=1 in development to print it here.';
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              await listInvitations(db, tenant, at),
              `${invitation.email} invited as ${invitation.role}.${exposeInvite}`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const hint =
              e instanceof AuthError && e.code === 'DISABLED_USER_EXISTS'
                ? ' Reactivate the disabled account instead of creating a new invitation.'
                : e instanceof AuthError && e.code === 'INVITATION_PENDING'
                  ? ' Resend or revoke the existing invitation first.'
                  : '';
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `create account failed: ${msg}${hint}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/invitation/resend' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const { invitation, token } = await resendInvitation(
              db,
              tenant,
              call.fields.invitationId ?? '',
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(db, tenant, by(auth.user), 'team.invite_resend', `invitation:${invitation.id}`, at);
            const link = `/accept-invite?token=${encodeURIComponent(token)}`;
            const exposeInvite =
              process.env.VITAL_EXPOSE_INVITE_LINK === '1' ? ` New link: ${link}` : ' Deliver the new acceptance link out of band.';
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              await listInvitations(db, tenant, at),
              `Invitation resent to ${invitation.email}.${exposeInvite}`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `resend failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/invitation/revoke' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const invitation = await revokeInvitation(
              db,
              tenant,
              call.fields.invitationId ?? '',
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(db, tenant, by(auth.user), 'team.invite_revoke', `invitation:${invitation.id}`, at);
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              await listInvitations(db, tenant, at),
              `Invitation to ${invitation.email} revoked`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `revoke failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/reactivate' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const user = await reactivateUser(
              db,
              tenant,
              call.fields.userId ?? '',
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(db, tenant, by(auth.user), 'team.reactivate', `user:${user.id}`, at);
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              data.invitations,
              `${user.email} reactivated — they must sign in again; old sessions stay revoked`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `reactivate failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/role' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const user = await changeUserRole(
              db,
              tenant,
              call.fields.userId ?? '',
              parseRole(call.fields.role ?? 'member'),
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(db, tenant, by(auth.user), 'team.role', `user:${user.id}`, at, `role=${user.role}`);
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              data.invitations,
              `${user.email} is now ${user.role}`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `role change failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/transfer-ownership' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (auth.user.role !== 'owner') return json(res, 403, { ok: false, error: 'only the owner may transfer ownership' });
          const data = await teamData();
          try {
            const { to } = await transferOwnership(
              db,
              tenant,
              call.fields.userId ?? '',
              { userId: auth.user.id, role: auth.user.role },
              at,
            );
            await auditConsole(db, tenant, by(auth.user), 'team.transfer_ownership', `user:${to.id}`, at);
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              data.invitations,
              `Ownership transferred to ${to.email}. You are now an admin.`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `transfer failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/disable' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!atLeast(auth.user.role, 'admin')) return json(res, 403, { ok: false, error: 'requires admin or owner' });
          const data = await teamData();
          try {
            const target = await getUser(db, tenant, call.fields.userId ?? '');
            if (!target) return json(res, 404, { ok: false, error: 'no such user' });
            if (target.role === 'owner' && auth.user.role !== 'owner')
              return json(res, 403, { ok: false, error: 'only the owner may disable the owner' });
            if (target.id === auth.user.id) return json(res, 400, { ok: false, error: 'you cannot disable yourself' });
            const confirm = (call.fields.confirmEmail ?? '').trim().toLowerCase();
            if (confirm !== target.email)
              throw new AuthError('CONFIRM_MISMATCH', 'confirmation email does not match — type the member email exactly');
            const handoffToUserId = call.fields.handoffToUserId?.trim() || undefined;
            const { work, reassigned } = await disableUser(db, tenant, target.id, at, {
              handoffToUserId,
              actorId: auth.user.id,
            });
            await auditConsole(db, tenant, by(auth.user), 'team.disable', `user:${target.id}`, at);
            const handoffMsg =
              reassigned.claims + reassigned.requests > 0
                ? ` ${reassigned.claims} claim(s) and ${reassigned.requests} request(s) were reassigned.`
                : work.claimCount + work.requestCount === 0
                  ? ''
                  : '';
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              await listUsers(db, tenant),
              data.invitations,
              `${target.email} disabled — every live session was revoked immediately.${handoffMsg} Reactivate restores sign-in access but does not restore old sessions.`,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, `disable failed: ${msg}`);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }

        const act = path.match(/^\/api\/requests\/([^/]+)\/(approve|decline)$/);
        if (method === 'POST' && act) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          // Role policy: the R/A/I matrix governs agent autonomy; this gate
          // governs which HUMAN role may approve. Default `member` (room-agent
          // model); tenants may raise it.
          if (!atLeast(auth.user.role, approverMin))
            return json(res, 403, {
              ok: false,
              error: `approving requires ${approverMin} (you are ${auth.user.role})`,
            });
          if (!keyAuth && !authorized(req))
            return json(res, 401, { ok: false, error: 'operator secret required (x-vital-operator)' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e); // 413 for body bombs, 400 for malformed JSON
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          let id: string;
          try {
            // decodeURIComponent throws URIError on malformed % sequences —
            // outside a try this escapes the async handler and kills the
            // process (unauthenticated single-request DoS, notable because
            // the ALB exposes this port publicly).
            id = decodeURIComponent(act[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed request id' });
            return;
          }
          const who = by(auth.user);
          const action: 'approve' | 'decline' = act[2] === 'approve' ? 'approve' : 'decline';
          const identity = keyAuth ? await verifyingKey(req, id, action, who) : {};
          if (!identity) return json(res, 401, { ok: false, error: 'operator signature invalid' });
          const current = await coord.get(tenant, id);
          if (!current) {
            json(res, 404, { ok: false, error: `unknown request ${id}` });
            return;
          }
          // The approver is the authenticated identity — the body cannot
          // name a human, so "approval theater" needs a compromised session.
          try {
            const result = await db.transaction(async () => {
              // PostgreSQL needs a row lock; SQLite's enclosing BEGIN IMMEDIATE
              // already serializes competing reviewers and execution claims.
              await db
                .prepare(
                  `SELECT id FROM requests WHERE tenant = ? AND id = ?${db.engine === 'postgres' ? ' FOR UPDATE' : ''}`,
                )
                .get(tenant, id);
              const request = await coord.get(tenant, id);
              if (!request) throw new Error('Request no longer exists; refresh the review queue.');
              const decisionId = `dec_console_${createHash('sha256')
                .update(JSON.stringify([tenant, id]))
                .digest('hex')}`;
              // Strict FLOW-001 contract: an approval either lands a decision
              // grounded in the request's cited evidence or nothing happens —
              // a refused recordDecision throws inside this transaction and
              // rolls the accept back with it. Duplicate submissions replay
              // the original receipt without rewriting approver or evidence.
              const existing =
                action === 'approve'
                  ? ((await ledger.getDecision(tenant, decisionId)) ?? (await ledger.getDecisionByRequest(tenant, id)))
                  : null;
              if (existing && request.state !== 'ADMITTED') {
                return {
                  state: request.state,
                  by: existing.approvedBy,
                  decisionId: existing.id,
                  decisionUrl: `/console/decisions/${encodeURIComponent(existing.id)}`,
                  latencySeconds: null,
                  repeated: true,
                };
              }
              if (request.state !== 'ADMITTED')
                throw new Error(`Request is ${request.state}, not awaiting review. Refresh to see its current status.`);
              if (action === 'approve' && !existing && request.claimRefs.length === 0) {
                throw new Error(
                  'Request has no valid evidence in the ledger. Review cannot proceed without grounded evidence.',
                );
              }
              const decision =
                action === 'approve' && !existing
                  ? await ledger.recordDecision({
                      id: decisionId,
                      tenant,
                      goal: request.goal,
                      // This records a begin-work review, not authority to run an
                      // arbitrary command or approve an unseen final deliverable.
                      action: JSON.stringify({
                        approvalStage: 'begin-work',
                        requestId: id,
                        requestUpdatedAt: request.updatedAt,
                        deliverableSchema: request.deliverableSchema,
                        originScope: request.originScope,
                        targetScope: request.targetScope,
                        budget: request.bid,
                        stopCondition: request.stopCondition,
                      }),
                      actionClass: 'RECOMMEND',
                      claimIds: request.claimRefs,
                      decidedBy: who,
                      approvedBy: who,
                      scope: request.targetScope,
                      autonomy: 'approval',
                      requestId: id,
                      now: at,
                    })
                  : null;
              const next =
                action === 'approve'
                  ? await coord.accept(tenant, id)
                  : await coord.decline(tenant, id, call.fields.reason || `declined by ${who}`);
              await auditConsole(db, tenant, who, `console.${action}`, `request:${id}`, at);
              let latencySeconds: number | null;
              try {
                // Savepoint isolates optional telemetry failure on PostgreSQL.
                latencySeconds = await db.transaction(
                  async () => (await coord.recordApprovalLatency(tenant, id, action, who, at)).seconds,
                );
              } catch {
                latencySeconds = null;
              }
              const receipt = decision ?? existing;
              return {
                state: next.state,
                by: who,
                latencySeconds,
                repeated: false,
                ...(receipt
                  ? { decisionId: receipt.id, decisionUrl: `/console/decisions/${encodeURIComponent(receipt.id)}` }
                  : {}),
              };
            });
            if (action === 'approve' && result.state === 'ACCEPTED' && !result.repeated) {
              await recordFirstReviewAt(db, tenant, at);
            }
            json(res, 200, { ok: action === 'approve', id, ...result, ...identity });
          } catch (e) {
            json(res, 409, { ok: false, error: (e as Error).message });
          }
          return;
        }

        const deliverableArtifact = path.match(/^\/api\/deliverables\/([^/]+)\/artifact$/);
        if (method === 'GET' && deliverableArtifact) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let versionId: string;
          try {
            versionId = decodeURIComponent(deliverableArtifact[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed deliverable version id' });
            return;
          }
          const version = await loadDeliverableVersion(db, tenant, versionId);
          if (!version) {
            json(res, 404, { ok: false, error: 'deliverable version not found' });
            return;
          }
          const body = readDeliverableArtifact(version, artifactDir);
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename="${version.deliverableId}-v${version.version}.txt"`,
            'cache-control': 'no-store',
          });
          res.end(body);
          return;
        }

        const deliverableApprove = path.match(/^\/api\/deliverables\/([^/]+)\/approve$/);
        if (method === 'POST' && deliverableApprove) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (!atLeast(auth.user.role, approverMin)) {
            json(res, 403, { ok: false, error: `approving requires ${approverMin}` });
            return;
          }
          if (activationDenied(res, auth, true)) return;
          if (!keyAuth && !authorized(req))
            return json(res, 401, { ok: false, error: 'operator secret required (x-vital-operator)' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          let versionId: string;
          try {
            versionId = decodeURIComponent(deliverableApprove[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed deliverable version id' });
            return;
          }
          const fingerprint = String(call.fields.fingerprint ?? '').trim();
          if (!fingerprint) {
            json(res, 400, { ok: false, error: 'fingerprint required — refresh the deliverable preview' });
            return;
          }
          const who = by(auth.user);
          const identity = keyAuth ? await verifyingKey(req, versionId, 'approve-deliverable', who) : {};
          if (!identity) return json(res, 401, { ok: false, error: 'operator signature invalid' });
          const version = await loadDeliverableVersion(db, tenant, versionId);
          if (!version) {
            json(res, 404, { ok: false, error: 'deliverable version not found' });
            return;
          }
          const request = await coord.get(tenant, version.requestId);
          try {
            const result = await db.transaction(async () => {
              const approved = await approveDeliverableVersion(db, ledger, {
                tenant,
                versionId,
                fingerprint,
                approvedBy: who,
                now: at,
                scope: request?.targetScope ?? 'product',
                onBehalfOf: request?.onBehalfOf ?? who,
                goal: request?.goal,
              });
              await auditConsole(db, tenant, who, 'console.approve-deliverable', `deliverable:${versionId}`, at);
              return approved;
            });
            json(res, 200, {
              ok: true,
              decisionId: result.decisionId,
              decisionUrl: `/console/decisions/${encodeURIComponent(result.decisionId)}`,
              status: result.version.status,
              ...identity,
            });
          } catch (e) {
            json(res, 409, { ok: false, error: (e as Error).message.replace(/^\[wedge:[^\]]+\]\s*/, '') });
          }
          return;
        }

        const deliverableChanges = path.match(/^\/api\/deliverables\/([^/]+)\/request-changes$/);
        if (method === 'POST' && deliverableChanges) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (!atLeast(auth.user.role, approverMin)) {
            json(res, 403, { ok: false, error: `review requires ${approverMin}` });
            return;
          }
          if (activationDenied(res, auth, true)) return;
          if (!keyAuth && !authorized(req))
            return json(res, 401, { ok: false, error: 'operator secret required (x-vital-operator)' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const notes = String(call.fields.notes ?? '').trim();
          if (!notes) {
            json(res, 400, { ok: false, error: 'revision notes are required' });
            return;
          }
          let versionId: string;
          try {
            versionId = decodeURIComponent(deliverableChanges[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed deliverable version id' });
            return;
          }
          const who = by(auth.user);
          const identity = keyAuth ? await verifyingKey(req, versionId, 'request-changes', who) : {};
          if (!identity) return json(res, 401, { ok: false, error: 'operator signature invalid' });
          try {
            const revised = await requestDeliverableRevision(db, tenant, versionId, notes, who, at);
            await auditConsole(db, tenant, who, 'console.request-changes', `deliverable:${versionId}`, at);
            json(res, 200, { ok: true, status: revised.status, revisionNotes: revised.revisionNotes, ...identity });
          } catch (e) {
            json(res, 409, { ok: false, error: (e as Error).message.replace(/^\[wedge:[^\]]+\]\s*/, '') });
          }
          return;
        }

        // Approval-latency distribution (TODO 2.3): the curation-cost clock.
        // Session-gated like every other read — a latency distribution leaks
        // who approves what, and how slowly.
        if (method === 'GET' && path === '/api/approval-latency') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          json(res, 200, await coord.approvalLatencyStats(tenant));
          return;
        }

        if (method === 'GET' && path === '/api/metrics') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          json(res, 200, { ...metrics, uptimeMs: Date.now() - metrics.startedAt });
          return;
        }

        // Cost-per-signal (TODO 4.1): the spend-side gate — MODEL share of
        // arrivals vs <1%. Read-only, but it leaks routing economics; keep it
        // behind the same session gate as the other read APIs.
        if (method === 'GET' && path === '/api/cost-per-signal') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
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
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          if (!keyAuth && !authorized(req))
            return json(res, 401, { ok: false, error: 'operator secret required (x-vital-operator)' });
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const statement = (call.fields.statement ?? '').trim();
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
          const who = by(auth.user);
          const identity = keyAuth ? await verifyingKey(req, id, 'correct', who) : {};
          if (!identity) return json(res, 401, { ok: false, error: 'operator signature invalid' });
          try {
            const old = await ledger.get(tenant, id);
            if (!old) {
              json(res, 404, { ok: false, error: `unknown claim ${id}` });
              return;
            }
            const rawSeq = call.json && 'expectedSeq' in call.json ? call.json.expectedSeq : call.fields.expectedSeq;
            const expectedSeq =
              rawSeq === undefined || rawSeq === null || rawSeq === ''
                ? undefined
                : Number(rawSeq);
            if (expectedSeq !== undefined && !Number.isInteger(expectedSeq)) {
              json(res, 400, { ok: false, error: 'expectedSeq must be an integer claim version' });
              return;
            }
            const rawVal = call.json && 'value' in call.json ? call.json.value : call.fields.value;
            let patch: { value?: number | null; unit?: string | null; confidence?: number } | undefined;
            if (rawVal !== undefined) {
              if (rawVal !== null && typeof rawVal !== 'string' && typeof rawVal !== 'number')
                return json(res, 400, { ok: false, error: 'value must be a finite number or null' });
              const numVal = rawVal === '' || rawVal === null ? null : Number(rawVal);
              if (numVal !== null && !Number.isFinite(numVal)) {
                json(res, 400, { ok: false, error: 'value must be a finite number or null' });
                return;
              }
              const rawUnit = call.json && 'unit' in call.json ? call.json.unit : call.fields.unit;
              const rawConf = call.json && 'confidence' in call.json ? call.json.confidence : call.fields.confidence;
              let unitPatch: string | null | undefined;
              if (rawUnit === null) {
                unitPatch = null;
              } else if (rawUnit !== undefined) {
                unitPatch = String(rawUnit);
              }
              patch = {
                value: numVal,
                unit: unitPatch,
                confidence: rawConf !== undefined ? Number(rawConf) : undefined,
              };
            }
            const { claim: neu, supersededId } = await ledger.correctClaim(tenant, id, statement, who, at, {
              patch,
              expectedSeq,
            });
            await auditConsole(db, tenant, who, 'console.correct', `claim:${id}`, at, `superseded_by=${neu.id}`);
            const affectedRequests = (await coord.listPendingAffectedByClaim(tenant, supersededId)).map((r) => ({
              id: r.id,
              goal: r.goal,
              state: r.state,
              url: `/console/requests/${encodeURIComponent(r.id)}`,
            }));
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
              affectedRequests,
              evalCaseId,
              ...(keyAuth ? { by: who, ...identity } : {}),
            });
          } catch (e) {
            if (e instanceof LedgerError && e.code === 'VERSION_CONFLICT') {
              json(res, 409, {
                ok: false,
                conflict: true,
                error: e.message,
                ...(e.detail ?? {}),
              });
              return;
            }
            json(res, 409, { ok: false, error: (e as Error).message });
          }
          return;
        }

        // FLOW-003: rebind pending request evidence to current claim replacements.
        const refresh = path.match(/^\/api\/requests\/([^/]+)\/refresh-evidence$/);
        if (method === 'POST' && refresh) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          let requestId: string;
          try {
            requestId = decodeURIComponent(refresh[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed request id' });
            return;
          }
          const who = by(auth.user);
          try {
            const next = await coord.refreshEvidence(tenant, requestId, async (claimId) => {
              const cur = await ledger.currentReplacement(tenant, claimId);
              return cur && cur.id !== claimId ? cur.id : null;
            });
            await auditConsole(db, tenant, who, 'console.refresh_evidence', `request:${requestId}`, at);
            json(res, 200, {
              ok: true,
              id: requestId,
              state: next.state,
              claimRefs: next.claimRefs,
              chainClaimIds: next.chainClaimIds,
            });
          } catch (e) {
            const code = (e as { code?: string }).code;
            json(res, code === 'NOT_FOUND' ? 404 : 409, { ok: false, error: (e as Error).message });
          }
          return;
        }

        // Static site fallthrough (opt-in via siteDir). Console routes and
        // the auth pages always take precedence; only unmatched GETs fall
        // through to files, with traversal-defence inside serveStatic.
        if (siteDir && method === 'GET') {
          const file = await serveStatic(siteDir, path, true);
          if (file) {
            res.writeHead(200, { 'content-type': file.type });
            res.end(file.body);
            return;
          }
        }

        json(res, 404, { ok: false, error: 'not found' });
      })().catch(() => {
        metrics.errors += 1;
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
        else res.destroy();
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
      server.listen(opts.port ?? 0, bindHost, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('[console:UNBOUND] server did not bind'));
        boundAddress = `${addr.address}:${addr.port}`;
        resolve({
          host: addr.address,
          port: addr.port,
          address: boundAddress,
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
