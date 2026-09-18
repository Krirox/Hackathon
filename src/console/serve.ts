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
  createAccountNotice,
  createInvitation,
  disableConfirmation,
  disableUser,
  getTenant,
  getUser,
  installAuthSchema,
  invitationNextSteps,
  inviteUser,
  listInvitations,
  listUsers,
  membershipRoster,
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
  type DisableConfirmation,
  type Invitation,
  type Session,
  type TenantAccessState,
  type User,
} from '../core/auth.ts';
import { LedgerError, type Ledger } from '../ledger/ledger.ts';
import {
  auditLinks,
  exportLedgerWithManifest,
  streamExportLedger,
  queryAudit,
  type AuditQuery,
  type ExportKind,
} from '../ledger/export.ts';
import { changeImpact, effectivePolicy, SETTINGS_INVENTORY } from '../gov/trust.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import {
  ExecutionSpecError,
  assertFreshReview,
  serializeExecutionSpec,
  validateApprovalBoundary,
} from '../coord/execution-spec.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { approvalMessage, effectiveKeys, listOperatorKeys, operatorKeyId, verifyApproval } from '../gov/operator.ts';
import { buildReport } from './report.ts';
import {
  clearFilterUrl,
  decodeListState,
  listStateUrl,
  noResultsModel,
  partitionRequestsByDecision,
  searchClaims,
  searchRequests,
  searchWorkflows,
  viewAllPaths,
  type ClaimSummary,
  type ListState,
  type RequestSummary,
} from './report.ts';
import {
  buildConsoleNav,
  claimDetailUrl,
  queueReturnUrl,
  renderAccountCluster,
  renderConsoleNav,
  renderHtml,
  requestDetailUrl,
  resolveConsoleHome,
  withReturnTo,
} from './render.ts';
import { renderDigest, digestWindowSince, type DigestDays } from './digest.ts';
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
import {
  claimDetail,
  decisionDetail,
  detailBackTarget,
  detailDocument,
  parseDetailNav,
  requestDetail,
} from './detail.ts';
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
import { isBrowserForm, loginPath, safeReturnPath, sessionExpiredPayload } from './session-flow.ts';
import { accountNav, formErrorShape, passwordChangeResult, reauthResume, retainDraftFields } from './session-flow.ts';
import {
  checkReadiness,
  correlateDiagnostic,
  describeStops,
  haltEffects,
  listHaltEvidence,
  liveness,
  recoverStop,
  retryGuidance,
  type StopDisplay,
} from '../gov/trust.ts';
import { recordReviewOutcome } from '../gov/review.ts';

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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#0A0F14;margin:0;padding:24px}
form{max-width:360px;display:grid;gap:10px}input{padding:8px;border:1px solid #E4E4E1;border-radius:6px}
button{padding:8px 14px;border:0;border-radius:6px;background:#0F5C57;color:#fff;font-weight:600;cursor:pointer}
.err{color:#B91C1C;font-size:13px}.sub{color:#6B7280;font-size:12px}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #0F5C57;outline-offset:2px}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}
@media (max-width:640px){body{padding:12px}form{max-width:100%}}</style>
</head><body><main>${body}</main></body></html>`;
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
    ? `<p class="sub"><strong>${esc(reauthResume(opts.next).notice)}</strong> You will return to your task after signing in.</p>`
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

function resetPasswordPage(csrf: string, token: string, opts: { error?: string; next?: string } = {}): string {
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
  const result = passwordChangeResult('forced');
  return page(
    'Vital Console — activate your account',
    `<h1>${esc(result.heading)}</h1>
<p class="sub">Your operator issued a temporary password. Choose a new one before using the console.
${esc(result.sessionNote)} — ${esc(result.nextStep)}</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/change-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save and sign in again</button>
</form>`,
  );
}

function accountPage(csrf: string, user: User, error?: string, notice?: string, homeRef = '/'): string {
  const result = passwordChangeResult('voluntary');
  const nav = accountNav('account')
    .map((item) => {
      if (item.active) {
        return `<span aria-current="page">${esc(item.label)}</span>`;
      }
      return `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
    })
    .join(' · ');
  return page(
    'Vital Console — account and security',
    `<h1>Account and security</h1>
<p class="sub">Signed in as ${esc(user.email)} · ${esc(user.role)}</p>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<h2>Change password</h2>
<p class="sub">${esc(result.sessionNote)} — ${esc(result.nextStep)}</p>
<form method="post" action="/account/password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label class="sub" for="password">new password (min 12 chars)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <button type="submit">Save new password</button>
</form>
<p class="sub"><a href="${esc(homeRef)}">Back to console</a> · ${nav}</p>`,
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

function disableForm(csrf: string, u: User, users: User[], confirmation?: DisableConfirmation): string {
  const handoff = handoffOptions(users, u.id);
  let consequences = `<p class="sub">Disabling <strong>${esc(u.name)}</strong> (${esc(u.email)}) revokes every live session immediately. They cannot sign in again until reactivated.</p>`;
  if (confirmation) {
    const workNote = confirmation.needsHandoff
      ? ` They own ${confirmation.work.claimCount} open claim(s) and ${confirmation.work.requestCount} open request(s) — choose a handoff below.`
      : '';
    const ownerNote = confirmation.lastUsableOwner
      ? ' This is the last usable owner — disabling them leaves the organization without an active owner.'
      : '';
    consequences = `<p class="sub">Disabling <strong>${esc(confirmation.person.name)}</strong> (${esc(confirmation.person.email)}) ${esc(confirmation.sessionConsequence)} ${esc(confirmation.accessConsequence)}${workNote}${ownerNote}</p>`;
  }
  return `<details>
  <summary style="cursor:pointer;color:#6B7280">Disable</summary>
  <form method="post" action="/team/disable" style="margin-top:8px;display:grid;gap:8px;max-width:360px">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    ${consequences}
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
  extra?: {
    now?: string;
    confirmations?: Map<string, DisableConfirmation>;
    stops?: StopDisplay[];
    selfHalts?: {
      action: string;
      actor: string;
      target: string;
      detail: string | null;
      at: string;
      outboxStatus?: { status: string; attempts: number; nextAt: string } | null;
    }[];
    policy?: { approverRole: string; operatorMode: 'signature' | 'secret' | 'session' };
  },
): string {
  const canManage = atLeast(viewer.role, 'admin') && !viewer.mustChangePassword;
  const accountNotice = createAccountNotice();
  const roster = extra?.now !== undefined ? membershipRoster(users, invitations, extra.now) : null;
  let membersHeading = 'Members';
  let invitesHeading = 'Pending invitations';
  if (roster) {
    const active = roster.filter((row) => row.kind === 'active').length;
    const disabled = roster.filter((row) => row.kind === 'disabled').length;
    const invited = roster.filter((row) => row.kind === 'invited').length;
    membersHeading = `Members (${active} active · ${disabled} disabled)`;
    invitesHeading = `Pending invitations (${invited} invited)`;
  }
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
      if (canDisable(viewer, u)) actions.push(disableForm(csrf, u, users, extra?.confirmations?.get(u.id)));
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
<h2>${membersHeading}</h2>
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${
  pendingInvites.length
    ? `<h2>${invitesHeading}</h2>
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th align="left">expires</th><th></th></tr></thead>
  <tbody>${inviteRows}</tbody>
</table>`
    : ''
}
${
  canManage
    ? `<h2>${esc(accountNotice.heading)}</h2>
<p class="sub">${esc(accountNotice.detail)}</p>
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
  <button type="submit">${esc(accountNotice.button)}</button>
</form>`
    : '<p class="sub">Ask an admin or the owner to create accounts.</p>'
}
${stopsSection(csrf, canManage, extra?.stops, extra?.selfHalts)}
${governanceSection(extra?.policy)}
`,
  );
}

function stopsSection(
  csrf: string,
  canManage: boolean,
  stops?: StopDisplay[],
  selfHalts?: { action: string; actor: string; target: string; detail: string | null; at: string }[],
): string {
  if (stops === undefined) return '';
  const entries = stops
    .map((stop) => {
      const effects = haltEffects(stop.scope, stop.actionClass);
      const reason = stop.reason ?? 'no reason recorded';
      const recover = canManage
        ? `<form method="post" action="/team/stops/recover" style="margin-top:8px;display:grid;gap:8px;max-width:360px">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="scope" value="${esc(stop.scope)}">
    <input type="hidden" name="actionClass" value="${esc(stop.actionClass)}">
    <label class="sub" for="reason-${esc(stop.scope)}-${esc(stop.actionClass)}">recovery reason (recorded in the audit log)</label>
    <input id="reason-${esc(stop.scope)}-${esc(stop.actionClass)}" name="reason" required>
    <button type="submit">Recover stop</button>
  </form>`
        : '';
      return `<article>
  <p><strong>scope ${esc(stop.scope)} × class ${esc(stop.actionClass)}</strong> — engaged by ${esc(stop.by)} at ${esc(stop.at)}</p>
  <p class="sub">reason: ${esc(reason)}</p>
  <p class="sub">${esc(stop.affected)}</p>
  <ul class="sub"><li>in-flight work: ${esc(effects.inFlight.detail)}</li><li>queued work: ${esc(effects.queued.detail)}</li><li>external operations: ${esc(effects.external.detail)}</li></ul>
  <p class="sub">recovery: ${esc(stop.recovery)}</p>
  ${recover}
</article>`;
    })
    .join('');
  return `<h2>Emergency stops</h2>
<p class="sub">A stop denies new authorizations at once and never force-terminates work already executing. Recovery is audited with a recorded reason — a restart does not clear a stop.</p>
${entries || '<p class="sub">No active stops.</p>'}${selfHaltEntries(selfHalts)}`;
}

function selfHaltEntries(
  selfHalts?: {
    action: string;
    actor: string;
    target: string;
    detail: string | null;
    at: string;
    outboxStatus?: { status: string; attempts: number; nextAt: string } | null;
  }[],
): string {
  if (!selfHalts || selfHalts.length === 0) return '';
  const items = selfHalts
    .map(
      (h) =>
        `<li>${esc(h.at)} · ${esc(h.action)} · ${esc(h.target)} by ${esc(h.actor)}${h.detail ?
          ` — ${esc(h.detail.slice(0, 200))}` : ''}${h.outboxStatus ?
          ` · outbox: ${esc(h.outboxStatus.status)} attempts=${esc(String(h.outboxStatus.attempts))} nextAt=${esc(h.outboxStatus.nextAt)}` : ''}</li>`,
    )
    .join('');
  return `<h3>Recent automation self-halts</h3>
<p class="sub">Recorded when automation froze itself (trust freeze); the audit log is the delivery fallback — no silent halts.</p>
<ul class="sub">${items}</ul>`;
}

// FLOW-025: effective governance policy with its source. Read-only display:
// startup-only settings name their flag, runtime settings name their API,
// and every row states what it changes, what it does not, and whether a
// restart or re-review is required. No secret values are rendered.
function governanceSection(policy?: {
  approverRole: string;
  operatorMode: 'signature' | 'secret' | 'session';
}): string {
  if (!policy) return '';
  const { policy: values, sources } = effectivePolicy({
    values: { 'approver-role': policy.approverRole, 'operator-mode': policy.operatorMode },
    startupKeys: ['approver-role', 'operator-mode'],
  });
  const sourceOf = new Map(sources.map((s) => [s.setting, s.source]));
  const rows = SETTINGS_INVENTORY.map((entry) => {
    const impact = changeImpact(entry.key);
    return `<tr>
  <td><code>${esc(entry.key)}</code></td>
  <td>${esc(entry.area)}</td>
  <td><code>${esc(values[entry.key] ?? '')}</code></td>
  <td>${esc(sourceOf.get(entry.key) ?? 'default')}</td>
  <td class="sub">${esc(entry.entryPoint)}</td>
  <td class="sub">changes: ${esc(impact.changes)} · does not change: ${esc(impact.notChanges)} · ${esc(impact.requires)}</td>
</tr>`;
  }).join('');
  return `<h2>Governance policy</h2>
<p class="sub">The active policy and where each setting comes from. Startup-only settings require a restart; runtime settings are audited per change. This page never grants autonomy — agents act only inside the R/A/I matrix.</p>
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">setting</th><th align="left">area</th><th align="left">value</th><th align="left">source</th><th align="left">entry point</th><th align="left">impact</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function acceptInvitePage(csrf: string, token: string, inv: Invitation, opts: { error?: string } = {}): string {
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

/**
 * Dashboard search (FLOW-020) over the existing home path: permissioned
 * searchable request/claim indexes with stable pagination, true totals with
 * explicit truncation, meaningful no-results with a clear-filter action, and
 * filter state preserved across refresh via the URL. Returns '' when no
 * filter is active so the default dashboard is byte-identical.
 */
async function dashboardSearchSection(
  db: AsyncDb,
  tenant: string,
  state: ListState,
  base: string,
  returnTo: string,
): Promise<string> {
  const form = `<section aria-label="Search"><h2>Search</h2>
<form method="get" action="${esc(base)}">
  <label class="sub" for="q">search requests and claims</label>
  <input id="q" name="q" value="${esc(state.q ?? '')}">
  <label class="sub" for="state">status (blank for all)</label>
  <input id="state" name="state" value="${esc(state.states?.[0] ?? '')}">
  <label class="sub" for="scope">scope (blank for all)</label>
  <input id="scope" name="scope" value="${esc(state.scopes?.[0] ?? '')}">
  <label class="sub" for="since">since (inclusive date)</label>
  <input id="since" name="since" type="date" value="${esc(state.since ?? '')}">
  <label class="sub" for="until">until (inclusive date)</label>
  <input id="until" name="until" type="date" value="${esc(state.until ?? '')}">
  <label class="sub" for="workflow">workflow id (blank for all)</label>
  <input id="workflow" name="workflow" value="${esc(state.workflowId ?? '')}">
  <button type="submit">Search</button>
  <a href="${esc(clearFilterUrl(base))}">Clear</a>
</form>`;
  const scoped = state.scopes ?? [];
  const filtering =
    (state.q ?? '').trim() !== '' ||
    (state.states ?? []).length > 0 ||
    scoped.length > 0 ||
    (state.messageClass ?? '') !== '' ||
    (state.since ?? '') !== '' ||
    (state.until ?? '') !== '' ||
    (state.workflowId ?? '') !== '';
  if (!filtering) return `${form}</section>`;
  const requests = await searchRequests(db, tenant, {
    q: state.q,
    states: state.states,
    scope: scoped[0],
    messageClass: state.messageClass,
    workflowId: state.workflowId,
    since: state.since,
    until: state.until,
    limit: state.limit,
    offset: state.offset,
  });
  const claims = await searchClaims(db, tenant, {
    q: state.q,
    kinds: state.kinds,
    statuses: state.statuses,
    scope: scoped[0],
    since: state.since,
    until: state.until,
    limit: state.limit,
    offset: state.offset,
  });
  if (requests.total + claims.total === 0) {
    const model = noResultsModel(base, state);
    return `${form}<p class="sub">${esc(model.title)}: ${esc(model.body)} <a href="${esc(model.clearUrl)}">Clear search and filters</a></p></section>`;
  }
  const groups = partitionRequestsByDecision(requests.rows);
  const requestRow = (r: RequestSummary): string =>
    `<li><a href="${esc(withReturnTo(requestDetailUrl(r.id), returnTo))}">${esc(r.goal)}</a> <span class="sub">${esc(r.state)} · ${esc(r.originScope)}→${esc(r.targetScope)}</span></li>`;
  const claimRow = (c: ClaimSummary): string =>
    `<li><a href="${esc(withReturnTo(claimDetailUrl(c.id), returnTo))}">${esc(c.subject)}</a> <span class="sub">${esc(c.kind)} · ${esc(c.status)}</span></li>`;
  let body = `<p class="sub">${requests.total} matching request(s) · ${claims.total} matching claim(s)</p>`;
  if (groups.pending.length > 0) body += `<h3>Pending decision</h3><ul>${groups.pending.map(requestRow).join('')}</ul>`;
  if (groups.active.length > 0)
    body += `<h3>Approved or executing</h3><ul>${groups.active.map(requestRow).join('')}</ul>`;
  if (groups.other.length > 0) body += `<h3>Other states</h3><ul>${groups.other.map(requestRow).join('')}</ul>`;
  if (requests.truncated)
    body += `<p class="sub">explicit truncation: showing ${requests.rows.length} of ${requests.total} matching requests</p>`;
  if (claims.truncated)
    body += `<p class="sub">explicit truncation: showing ${claims.rows.length} of ${claims.total} matching claims</p>`;
  if (claims.rows.length > 0) body += `<h3>Claims</h3><ul>${claims.rows.map(claimRow).join('')}</ul>`;
  const pages: string[] = [];
  if (requests.offset > 0)
    pages.push(
      `<a href="${esc(listStateUrl(base, { ...state, offset: Math.max(0, requests.offset - requests.limit) }))}">Previous</a>`,
    );
  if (requests.hasMore)
    pages.push(
      `<a href="${esc(listStateUrl(base, { ...state, offset: requests.offset + requests.rows.length }))}">Next</a>`,
    );
  if (pages.length > 0) body += `<p class="sub">${pages.join(' · ')}</p>`;
  const paths = viewAllPaths();
  body += `<p class="sub"><a href="${esc(clearFilterUrl(base))}">Clear search and filters</a> · Browse: <a href="${esc(paths.workflows)}">Workflows</a> · <a href="${esc(paths.digest)}">Digest</a></p>`;
  return `${form}${body}</section>`;
}

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
  const home = resolveConsoleHome(siteDir);
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
            '/team/stops/recover',
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
          return json(res, 200, { ok: true, vital: '0.0.1', listen: boundAddress, ...liveness(now()) });
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
          if (expired) {
            const resume = reauthResume(returnPath());
            if (hadSessionCookie) redirect(res, resume.loginUrl, CLEAR_SESSION_COOKIE);
            else redirect(res, resume.loginUrl);
          } else {
            redirect(res, loginPath({ next: returnPath() }));
          }
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
            const shape = formErrorShape('csrf-expired');
            const msg = 'This sign-in form expired. Your email is preserved — submit again.';
            if (isBrowserForm(req)) {
              res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'set-cookie': preCsrfCookie(fresh, secure),
              });
              const tenantCtx = await loginTenantContext(db, tenant);
              const retained = retainDraftFields(call.fields);
              res.end(
                loginPage(fresh, {
                  error: msg,
                  next,
                  email: retained.email ?? '',
                  recovery: accessState === 'recovery',
                  ...tenantCtx,
                }),
              );
              return;
            }
            return json(res, 403, { ok: false, error: msg, code: shape.code });
          }
          if (!rateOk(`login:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at))) {
            const bucket = buckets.get(`login:${ip ?? '-'}:${tenant}`);
            const retryAt = bucket ? new Date(bucket.reset).toISOString() : undefined;
            const shape = formErrorShape('rate-limited', {
              retryAfterMs: bucket ? Math.max(0, bucket.reset - Date.parse(at)) : undefined,
            });
            const guidance = retryGuidance('rate-limit');
            const msg = retryAt ? `${shape.message} — try again after ${retryAt}` : shape.message;
            if (isBrowserForm(req)) {
              res.writeHead(shape.status, { 'content-type': 'text/html; charset=utf-8' });
              const tenantCtx = await loginTenantContext(db, tenant);
              const retained = retainDraftFields(call.fields);
              res.end(
                loginPage(call.csrf ?? '', {
                  error: msg,
                  next,
                  email: retained.email ?? '',
                  recovery: accessState === 'recovery',
                  ...tenantCtx,
                }),
              );
              return;
            }
            return json(res, shape.status, {
              ok: false,
              error: msg,
              code: shape.code,
              retryAfterMs: shape.retryAfterMs,
              retryable: guidance.retryable,
              retryAt,
            });
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
          if (!rateOk(`reset:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at))) {
            const shape = formErrorShape('rate-limited');
            const guidance = retryGuidance('rate-limit');
            return json(res, shape.status, {
              ok: false,
              error: shape.message,
              code: shape.code,
              retryAfterMs: shape.retryAfterMs,
              retryable: guidance.retryable,
            });
          }
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
            const accepted = await acceptInvitation(db, token, call.fields.password ?? '', at);
            const signed = await login(
              db,
              { tenant: accepted.user.tenant, email: accepted.user.email, password: call.fields.password ?? '' },
              at,
            );
            return redirect(res, home, sessionCookie(signed.token, at, secure, signed.session));
          } catch (e) {
            const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              inv
                ? acceptInvitePage(call.csrf ?? '', token, inv, { error: msg })
                : page(
                    'Vital Console — accept invitation',
                    `<p class="err">${esc(msg)}</p><p class="sub"><a href="/login">Sign in</a></p>`,
                  ),
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
              `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup required</title></head><body><main>
<p>This console is reachable remotely but has no owner yet. Web signup is disabled on non-loopback binds.</p>
<p>Configure <code>VITAL_BOOTSTRAP_EMAIL</code> and <code>VITAL_BOOTSTRAP_PASSWORD</code> before exposing the service, or bind to loopback for local claiming.</p>
</main></body></html>`,
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
          if (!rateOk(`signup:${ip ?? '-'}:${tenant}`, SIGNUP_RATE.limit, SIGNUP_RATE.windowMs, Date.parse(at))) {
            const shape = formErrorShape('rate-limited');
            const guidance = retryGuidance('rate-limit');
            return json(res, shape.status, {
              ok: false,
              error: shape.message,
              code: shape.code,
              retryAfterMs: shape.retryAfterMs,
              retryable: guidance.retryable,
            });
          }
          const values = retainDraftFields({
            orgname: call.fields.orgname ?? '',
            email: call.fields.email ?? '',
            ownerName: call.fields.ownerName ?? '',
          });
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
          res.end(accountPage(auth.session.csrfToken, auth.user, undefined, undefined, home));
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
              res.end(
                accountPage(auth.session.csrfToken, auth.user, 'This form expired — submit again.', undefined, home),
              );
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
                undefined,
                home,
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
        if (path === '/console/digest') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          if (method !== 'GET') {
            res.setHeader('allow', 'GET');
            return json(res, 405, { ok: false, error: 'digest is read-only' });
          }
          const days = url.searchParams.get('days') ?? '7';
          if (!['1', '7', '30', 'all'].includes(days))
            return json(res, 400, { ok: false, error: 'days must be 1, 7, 30 or all' });
          const window = days as DigestDays;
          const since = digestWindowSince(at, window);
          const navigation = `<nav aria-label="Digest time window">${(['1', '7', '30', 'all'] as DigestDays[]).map((value) => `<a href="/console/digest?days=${value}"${value === window ? ' aria-current="page"' : ''}>${value === 'all' ? 'All history' : `Last ${value} day(s)`}</a>`).join(' ')}</nav>`;
          const body = navigation + (await renderDigest(coord, db, tenant, at, { since }));
          const html = detailDocument('Digest', body, {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session',
            home,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }
        if (method === 'GET' && path === '/console/workflows') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const items = await listWorkflows(db, ledger, coord, comp, tenant);
          const q = (url.searchParams.get('q') ?? '').trim();
          let shown = items;
          let filterNote = '';
          if (q !== '') {
            let found: { rows: { id: string }[]; total: number };
            try {
              found = await searchWorkflows(db, tenant, { q });
            } catch (e) {
              return json(res, 400, { ok: false, error: (e as Error).message });
            }
            const ids = new Set(found.rows.map((row) => row.id));
            shown = items.filter((item) => ids.has(item.id));
            if (shown.length === 0) {
              const model = noResultsModel('/console/workflows', { q });
              filterNote = `<p class="sub">${esc(model.title)}: ${esc(model.body)} <a href="${esc(model.clearUrl)}">Clear search</a></p>`;
            } else {
              filterNote = `<p class="sub">${shown.length} matching workflow(s) for search "${esc(q)}" (${found.total} total). <a href="/console/workflows">Clear search</a></p>`;
            }
          }
          const listHtml = renderWorkflowListPage(shown, {
            home,
            csrf: auth.session.csrfToken,
            actor: by(auth.user),
          });
          const html = filterNote
            ? listHtml.replace('<h1>Release workflows</h1>', `<h1>Release workflows</h1>${filterNote}`)
            : listHtml;
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
          const detailNav = parseDetailNav(url.search);
          const fallbackMode = operatorSecret ? 'secret' : 'session';
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: atLeast(auth.user.role, approverMin),
            requiredRole: approverMin,
            operatorMode: keyAuth ? ('signature' as const) : (fallbackMode as 'secret' | 'session'),
            home: detailBackTarget(detailNav.returnTo, queueReturnUrl(home, {})),
          };
          const navCtx = {
            returnTo: detailNav.returnTo ?? undefined,
            requestId: detailNav.requestId ?? undefined,
          };
          let html: string | null;
          if (detail[1] === 'claims') {
            html = await claimDetail(db, ledger, coord, id, pageIndex, detailOpts, navCtx);
          } else if (detail[1] === 'decisions') {
            html = await decisionDetail(ledger, id, detailOpts);
          } else {
            html = await requestDetail(db, coord, ledger, id, pageIndex, detailOpts, artifactDir, navCtx);
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
          const listState = decodeListState(url.search);
          let searchHtml: string;
          try {
            searchHtml = await dashboardSearchSection(db, tenant, listState, home, returnPath());
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
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
            `${searchHtml}${activation}${review}<h1>Reality health</h1>`,
          );
          // The CSRF token rides in the page so same-origin form posts and
          // same-origin fetches can both present it.
          const withCsrf = html.replace(
            '</head>',
            `<meta name="vital-csrf" content="${esc(auth.session.csrfToken)}"></head>`,
          );
          const consoleNav = renderConsoleNav(buildConsoleNav(home));
          const accountCluster = renderAccountCluster(auth.user.email, auth.user.role, auth.session.csrfToken);
          const withUser = withCsrf.replace('</body>', `${consoleNav}${accountCluster}</body>`);
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
            await auditConsole(db, tenant, by(auth.user), 'setup.sample', `request:${seeded.requestId}`, at);
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
          const confirmations = new Map<string, DisableConfirmation>();
          for (const u of data.users) {
            if (!canDisable(auth.user, u)) continue;
            try {
              confirmations.set(u.id, await disableConfirmation(db, tenant, u.id));
            } catch {
              continue;
            }
          }
          const stops = await describeStops(db, tenant);
          const haltEvidence = await listHaltEvidence(db, tenant);
          // Query outbox for automation-self-halt rows and pair with audit entries.
          const outboxRows = (await db.prepare(
            `SELECT id, status, attempts, next_at FROM outbox WHERE tenant = ? AND kind = 'automation-self-halt' ORDER BY id DESC LIMIT 5`,
          )
            .all(tenant)) as { id: string; status: string; attempts: number; next_at: string }[];
          const outboxStatus = new Map<string, { status: string; attempts: number; nextAt: string }>();
          for (const r of outboxRows) {
            outboxStatus.set(r.id, { status: r.status, attempts: r.attempts, nextAt: r.next_at });
          }
          const selfHalts = haltEvidence.real
            .filter((h) => h.action === 'AUTOMATION_SELF_HALT' || h.action === 'TRUST_FROZEN')
            .slice(-5)
            .reverse()
            .map((h) => {
              const ob = outboxStatus.get(h.detail ?? '');
              return {
                action: h.action,
                actor: h.actor,
                target: h.target,
                detail: h.detail,
                at: h.at,
                outboxStatus: ob
                  ? { status: ob.status, attempts: ob.attempts, nextAt: ob.nextAt }
                  : { status: 'unknown', attempts: 0, nextAt: '' },
              };
            });
          let operatorMode: 'signature' | 'secret' | 'session' = 'session';
          if (keyAuth) operatorMode = 'signature';
          else if (operatorSecret) operatorMode = 'secret';
          const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, undefined, {
            now: at,
            confirmations,
            stops,
            selfHalts,
            policy: { approverRole: approverMin, operatorMode },
          });
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
            const attempted = (call.fields.email ?? '').trim().toLowerCase();
            let hint = '';
            if (e instanceof AuthError) {
              if (e.code === 'DISABLED_USER_EXISTS') {
                hint = ` ${invitationNextSteps('disabled_account', attempted).action}`;
              } else if (e.code === 'INVITATION_PENDING') {
                hint = ` ${invitationNextSteps('pending_invitation', attempted).action}`;
              } else if (e.code === 'DUPLICATE_USER') {
                hint = ` ${invitationNextSteps('active_account', attempted).action}`;
              }
            }
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `create account failed: ${msg}${hint}`,
            );
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
              process.env.VITAL_EXPOSE_INVITE_LINK === '1'
                ? ` New link: ${link}`
                : ' Deliver the new acceptance link out of band.';
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `resend failed: ${msg}`,
            );
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `revoke failed: ${msg}`,
            );
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `reactivate failed: ${msg}`,
            );
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `role change failed: ${msg}`,
            );
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
          if (auth.user.role !== 'owner')
            return json(res, 403, { ok: false, error: 'only the owner may transfer ownership' });
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `transfer failed: ${msg}`,
            );
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
              throw new AuthError(
                'CONFIRM_MISMATCH',
                'confirmation email does not match — type the member email exactly',
              );
            const handoffToUserId = call.fields.handoffToUserId?.trim() || undefined;
            const { reassigned } = await disableUser(db, tenant, target.id, at, {
              handoffToUserId,
              actorId: auth.user.id,
            });
            await auditConsole(db, tenant, by(auth.user), 'team.disable', `user:${target.id}`, at);
            let handoffMsg = '';
            if (reassigned.claims + reassigned.requests > 0) {
              handoffMsg = ` ${reassigned.claims} claim(s) and ${reassigned.requests} request(s) were reassigned.`;
            }
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
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `disable failed: ${msg}`,
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
          }
          return;
        }
        if (path === '/team/stops/recover' && method === 'POST') {
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
          const scope = (call.fields.scope ?? '').trim();
          const actionClass = (call.fields.actionClass ?? '').trim();
          const reason = (call.fields.reason ?? '').trim();
          if (!scope || !actionClass)
            return json(res, 400, { ok: false, error: 'scope and action class are required' });
          if (!reason) {
            const data = await teamData();
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              'recover failed: a recorded reason is required',
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
          try {
            const recovered = await recoverStop(db, tenant, { scope, actionClass }, by(auth.user), { reason, now: at });
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'team.stops_recover',
              `${recovered.scope}/${recovered.actionClass}`,
              at,
              reason,
            );
            return redirect(res, '/team');
          } catch (e) {
            const data = await teamData();
            const html = teamPage(
              auth.session.csrfToken,
              auth.user,
              data.users,
              data.invitations,
              `recover failed: ${(e as Error).message.replace(/^\[trust:[^\]]+\]\s*/, '')}`,
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
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
              // FLOW-002: a decline on a stale page would refuse different
              // content than reviewed — the explanation is preserved (409
              // preservedDraft) and the reviewer resubmits after re-review.
              if (action === 'decline') assertFreshReview(request, call.fields.requestUpdatedAt);
              const executionSpec =
                action === 'approve' && !existing
                  ? await validateApprovalBoundary(ledger, request, at, {
                      expectedRequestUpdatedAt: call.fields.requestUpdatedAt,
                      planFingerprint: call.fields.planFingerprint,
                      assetVersion: call.fields.assetVersion,
                      command: call.fields.command,
                    })
                  : null;
              const decision =
                action === 'approve' && !existing && executionSpec
                  ? await ledger.recordDecision({
                      id: decisionId,
                      tenant,
                      goal: request.goal,
                      // FLOW-002: frozen, versioned execution specification — not a
                      // replacement instruction or unseen final deliverable.
                      action: serializeExecutionSpec(executionSpec),
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
              await recordReviewOutcome(db, tenant, {
                requestId: id,
                scope: request.targetScope,
                actionClass: 'RECOMMEND',
                approved: action === 'approve',
                reviewer: who,
                reason: action === 'decline' ? call.fields.reason : undefined,
                now: at,
              });
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
                  ? {
                      decisionId: receipt.id,
                      decisionUrl: `/console/decisions/${encodeURIComponent(receipt.id)}`,
                      ...(executionSpec
                        ? { specFingerprint: executionSpec.fingerprint, requestUpdatedAt: request.updatedAt }
                        : {}),
                    }
                  : {}),
              };
            });
            if (action === 'approve' && result.state === 'ACCEPTED' && !result.repeated) {
              await recordFirstReviewAt(db, tenant, at);
            }
            json(res, 200, { ok: action === 'approve', id, ...result, ...identity });
          } catch (e) {
            const code = e instanceof ExecutionSpecError ? e.code : undefined;
            json(res, 409, {
              ok: false,
              error: (e as Error).message,
              ...(code ? { code, ...(e instanceof ExecutionSpecError ? e.detail : {}) } : {}),
              // The reviewer's explanation survives a stale rejection: the
              // client restores it so re-review resubmits the same rationale.
              ...(action === 'decline' && typeof call.fields.reason === 'string' && call.fields.reason.trim() !== ''
                ? { preservedDraft: { reason: call.fields.reason } }
                : {}),
            });
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
          const readiness = await checkReadiness(
            [
              {
                name: 'database',
                check: async () => {
                  await db.prepare('SELECT 1 AS ok').get();
                  return { ok: true as const, detail: `${db.engine} reachable` };
                },
              },
              {
                name: 'ingest-source',
                optional: true,
                check: async () => {
                  const config = await loadActivationConfig(db, tenant);
                  if (!config) return { ok: false, unconfigured: true, detail: 'no source configured' };
                  return { ok: true as const, detail: `source ${collectorName(config.sourcePath)} configured` };
                },
              },
            ],
            { now: at },
          );
          json(res, 200, { ...metrics, uptimeMs: Date.now() - metrics.startedAt, readiness });
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
            const expectedSeq = rawSeq === undefined || rawSeq === null || rawSeq === '' ? undefined : Number(rawSeq);
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

        // FLOW-024: permissioned, read-only ledger export with a manifest.
        // Snapshot is available to any activated member; the full
        // evidence package requires admin or owner. Nothing is written.
        const ledgerExport = path === '/api/ledger/export' && method === 'GET';
        if (ledgerExport) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const kind = url.searchParams.get('kind') ?? 'snapshot';
          if (kind !== 'snapshot' && kind !== 'evidence-package') {
            json(res, 400, {
              ok: false,
              error: 'unknown export kind — snapshot or evidence-package',
            });
            return;
          }
          if (kind === 'evidence-package' && !atLeast(auth.user.role, 'admin')) {
            json(res, 403, { ok: false, error: 'evidence-package export requires admin or owner' });
            return;
          }
          const streamParam = url.searchParams.get('stream');
          const isStream = streamParam === 'true' || streamParam === '1';
          if (isStream) {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="vital-ledger-${tenant}-${kind}.json"`,
              'cache-control': 'no-store',
              'transfer-encoding': 'chunked',
            });
            res.write('{"ok":true,"export":');
            const { manifest } = await streamExportLedger(
              db,
              tenant,
              (chunk) => {
                res.write(chunk);
              },
              { now: at, kind: kind as ExportKind },
            );
            res.write(',"manifest":' + JSON.stringify(manifest) + '}');
            res.end();
            return;
          }
          const { export: data, manifest } = await exportLedgerWithManifest(db, tenant, kind as ExportKind, at);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="vital-ledger-${tenant}-${kind}.json"`,
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true, manifest, export: data }));
          return;
        }

        // FLOW-024: permissioned, paginated, tenant-isolated audit history.
        // Rows carry links to reviewed evidence, authorization, execution
        // receipts, and outcomes where the row references them.
        const auditHistory = path === '/api/audit' && method === 'GET';
        if (auditHistory) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const q = url.searchParams;
          const query: AuditQuery = {};
          const actor = q.get('actor');
          const action = q.get('action');
          const from = q.get('from');
          const to = q.get('to');
          const requestId = q.get('request');
          const decisionId = q.get('decision');
          const limit = q.get('limit');
          const offset = q.get('offset');
          if (actor !== null) query.actor = actor;
          if (action !== null) query.action = action;
          if (from !== null) query.from = from;
          if (to !== null) query.to = to;
          if (requestId !== null) query.requestId = requestId;
          if (decisionId !== null) query.decisionId = decisionId;
          if (limit !== null) query.limit = Number(limit);
          if (offset !== null) query.offset = Number(offset);
          const page = await queryAudit(db, tenant, query);
          json(res, 200, {
            ok: true,
            ...page,
            rows: page.rows.map((row) => ({ ...row, links: auditLinks(row) })),
          });
          return;
        }

        // F23: Authenticated learning review administration — labeling queue
        if (method === 'GET' && path === '/api/learning/labeling-queue') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const rawLimit = url.searchParams.get('limit');
          const limit = rawLimit ? Math.min(Math.max(1, Number(rawLimit)), 200) : 50;
          const queue = await new CognitiveRouter(db).labelingQueue(tenant, limit);
          json(res, 200, { ok: true, queue });
          return;
        }

        // F23: Authenticated learning review administration — label decision
        if (method === 'POST' && path === '/api/learning/label') {
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
          const rawId = call.json && 'decisionId' in call.json ? call.json.decisionId : call.fields.decisionId;
          const decisionId = Number(rawId);
          if (!Number.isInteger(decisionId) || decisionId <= 0) {
            json(res, 400, { ok: false, error: 'decisionId must be a positive integer' });
            return;
          }
          const rawTier = call.json && 'correctTier' in call.json ? call.json.correctTier : call.fields.correctTier;
          const validTiers = ['CACHE', 'MODEL', 'WORKFLOW', 'HUMAN'];
          if (typeof rawTier !== 'string' || !validTiers.includes(rawTier)) {
            json(res, 400, { ok: false, error: `correctTier must be one of: ${validTiers.join(', ')}` });
            return;
          }
          const reviewer = by(auth.user);
          try {
            await new CognitiveRouter(db).label(tenant, decisionId, rawTier as any, reviewer);
            await auditConsole(
              db,
              tenant,
              reviewer,
              'console.label_decision',
              String(decisionId),
              at,
              `correct_tier=${rawTier}`,
            );
            json(res, 200, { ok: true, decisionId, correctTier: rawTier, reviewer });
          } catch (e) {
            json(res, 400, { ok: false, error: (e as Error).message });
          }
          return;
        }

        // F23: Authenticated skill card administration — list cards
        if (method === 'GET' && path === '/api/learning/cards') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const state = url.searchParams.get('state') as any;
          const intent = url.searchParams.get('intent') ?? undefined;
          const cards = await comp.list(tenant, { state: state ?? undefined, intent });
          json(res, 200, { ok: true, cards });
          return;
        }

        // F23: Authenticated skill card administration — get card detail with tests and revisions
        const cardMatch = path.match(/^\/api\/learning\/cards\/([^/]+)$/);
        if (method === 'GET' && cardMatch) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const cardId = decodeURIComponent(cardMatch[1]!);
          const card = await comp.get(tenant, cardId);
          if (!card) {
            json(res, 404, { ok: false, error: `skill card ${cardId} not found` });
            return;
          }
          const tests = await comp.transferResults(tenant, cardId);
          const revisions = await comp.cardRevisions(tenant, cardId);
          json(res, 200, { ok: true, card, tests, revisions });
          return;
        }

        // F23: Authenticated skill card administration — advance card
        const advanceMatch = path.match(/^\/api\/learning\/cards\/([^/]+)\/advance$/);
        if (method === 'POST' && advanceMatch) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          if (!atLeast(auth.user.role, 'admin')) {
            json(res, 403, { ok: false, error: 'card administration requires admin or owner role' });
            return;
          }
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            bodyError(res, e);
            return;
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const cardId = decodeURIComponent(advanceMatch[1]!);
          const rawTo = call.json && 'to' in call.json ? call.json.to : call.fields.to;
          if (typeof rawTo !== 'string' || !rawTo) {
            json(res, 400, { ok: false, error: 'target state (to) is required' });
            return;
          }
          const evidence = (
            call.json && 'evidence' in call.json && typeof call.json.evidence === 'object' ? call.json.evidence : {}
          ) as any;
          try {
            const result = await comp.attemptAdvance(tenant, cardId, rawTo as any, evidence);
            if (result.ok) {
              await auditConsole(db, tenant, by(auth.user), 'console.advance_card', cardId, at, `to=${rawTo}`);
            }
            json(res, result.ok ? 200 : 422, {
              ok: result.ok,
              card: result.card,
              reasons: result.reasons,
            });
          } catch (e) {
            json(res, 400, { ok: false, error: (e as Error).message });
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
      })().catch((err) => {
        metrics.errors += 1;
        const diag = correlateDiagnostic({
          detail: (err as Error).message,
          tenant,
          action: logPath,
          now: new Date().toISOString(),
        });
        if (process.env.VITAL_DEBUG_CONSOLE === '1') console.error('[console]', diag.supportRef, diag.sanitized);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error', supportRef: diag.supportRef });
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
