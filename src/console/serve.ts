import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  confirmEmailVerification,
  csrfOk,
  acceptInvitation,
  assertRecentAuthForSensitiveOp,
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
  isEmailVerified,
  listInvitations,
  listUsers,
  membershipRoster,
  membershipStatus,
  peekInvitationByToken,
  reactivateUser,
  recoveryChannelStatus,
  requestEmailVerification,
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
import {
  confirmMfaEnrollment,
  consumeMfaRecoveryCode,
  countLiveRecoveryCodes,
  generateMfaRecoveryCodes,
  isMfaEnabled,
  listMfaFactors,
  newTotpSecret,
  removeMfaFactor,
  startSessionForUser,
  verifyLoginCredentials,
  verifyMfaCode,
  type MfaFactor,
} from '../core/auth.ts';
import { LedgerError, type Ledger } from '../ledger/ledger.ts';
import {
  auditLinks,
  exportLedger,
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
import { cardEvaluationEvidence, describeCardReadOnly } from '../compiler/registry.ts';
import { eraseTenant, verifyErasureReceipt } from '../core/erasure.ts';
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
  renderListPage,
  requestDetailUrl,
  resolveConsoleHome,
  withReturnTo,
} from './render.ts';
import { renderDigest, digestWindowSince, type DigestDays } from './digest.ts';
import { renderReview } from './review.ts';
import { renderLearningPage, renderLearningCardPage } from './learning.ts';
import { renderAuditPage } from './audit.ts';
import { renderDataPage, renderErasureReceiptPage } from './data.ts';
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
import { getIntegrationHealth, integrationReadinessState, listKnownCollectors } from '../ingest/health.ts';
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
  persistDeliverableVersion,
  readDeliverableArtifact,
  requestDeliverableRevision,
} from '../wedge/deliverable-artifact.ts';
import { join } from 'node:path';
import { proposeEvalFromCorrection } from '../evals/runner.ts';
import { CognitiveRouter } from '../router/router.ts';
import { isBrowserForm, loginPath, safeReturnPath, sessionExpiredPayload } from './session-flow.ts';
import {
  accountNav,
  addPreCsrfToken,
  expiredDraftCarry,
  formErrorShape,
  passwordChangeResult,
  preCsrfFamilyOk,
  reauthResume,
  retainDraftFields,
  sessionExpiredWithDraft,
} from './session-flow.ts';
import {
  checkReadiness,
  correlateDiagnostic,
  describeDrillMode,
  describeStops,
  haltEffects,
  listHaltEvidence,
  liveness,
  recoverStop,
  retryGuidance,
  workerReadiness,
  type StopDisplay,
} from '../gov/trust.ts';
import { recordReviewOutcome } from '../gov/review.ts';
import { renderRoomsSetupPage, handleRoomsSetupPost } from './rooms-setup.ts';
import { reviewSecretFromEnv, verifyReviewToken } from '../talk/review-card.ts';
import { buildBuzzRoster, renderBuzzRoster, renderBuzzRoom } from './buzz.ts';
import { buzzDocument, renderWorkspaceShell } from './workspace-shell.ts';
import { maybeBuzzSurface } from '../talk/buzz-runtime.ts';
import { loadRoomConfig, normalizeScope, saveRoomConfig } from '../talk/rooms.ts';
import { renderCompilerView } from './compiler-view.ts';
import { ScopeHealthEvaluator } from '../talk/health.ts';
import { executeRoomCommand } from '../talk/commands.ts';
import { TimeTravelForkEngine } from '../talk/fork.ts';
import { AmbientMorningBriefingSynthesizer } from '../talk/huddle.ts';
import { RoomBudgetTracker } from '../talk/budget-gauge.ts';
import { LiveCanvasSynchronizer } from '../talk/canvas.ts';
import { renderDepartmentTabs, renderDepartmentBanner, type DashboardDepartment } from './dashboard-views.ts';

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
  /**
   * Loopback readiness probe (FLOW-013 / activation-ready). Issues an HTTP
   * request to the console and classifies activation into `ready` (the
   * console answers), `blocked` (activation is not yet usable/denied) or
   * `failed` (the probe itself errored). Lets `vital serve` surface a
   * *useful* result instead of only a bound address.
   */
  ready(): Promise<{ ok: boolean; status: 'ready' | 'blocked' | 'failed'; detail: string }>;
  close(): Promise<void>;
}

/** Default console bind — loopback only; production sets HOST=0.0.0.0 explicitly. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** True when the bind address accepts only local connections. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * FLOW-006: load-balancer-to-task path. In the supported topology the ALB
 * terminates TLS and forwards plain HTTP to the task, attaching
 * `X-Forwarded-For` (client IP chain) and `X-Forwarded-Proto` (the
 * client-facing scheme). These headers are honored ONLY when `trustProxy`
 * is set (`vital serve --trust-proxy` / `TRUST_PROXY=1`, always on in the
 * ECS task): on open loopback or direct exposure they stay ignored so a
 * client can never spoof its own IP or scheme.
 */
export interface ForwardedContext {
  /** Client IP used for rate limiting: forwarded first-hop when trusted, else the socket peer. */
  clientIp: string;
  /** Where the client IP came from — never ambiguous in logs. */
  clientIpSource: 'forwarded' | 'socket';
  /** Client-facing scheme: forwarded proto when trusted, else plain http (in-process TLS is not served). */
  scheme: 'http' | 'https';
  /** The Host header as received (what the LB routed on). */
  host: string | null;
  /** True when proxy headers were present and trusted. */
  viaProxy: boolean;
}

function firstHeaderValue(raw: string | string[] | undefined): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return null;
  const value = first.split(',')[0]?.trim();
  return value ? value : null;
}

export function resolveRequestContext(req: IncomingMessage, trustProxy: boolean): ForwardedContext {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  const hostHeader = firstHeaderValue(req.headers.host);
  if (!trustProxy) {
    return { clientIp: socketIp, clientIpSource: 'socket', scheme: 'http', host: hostHeader, viaProxy: false };
  }
  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto'])?.toLowerCase();
  const scheme = forwardedProto === 'https' ? 'https' : 'http';
  const viaProxy = forwardedFor !== null || forwardedProto !== null;
  return {
    clientIp: forwardedFor ?? socketIp,
    clientIpSource: forwardedFor !== null ? 'forwarded' : 'socket',
    scheme,
    host: firstHeaderValue(req.headers['x-forwarded-host']) ?? hostHeader,
    viaProxy,
  };
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
  /**
   * FLOW-006: honor ALB proxy headers (`X-Forwarded-For` for client IP,
   * `X-Forwarded-Proto` for the client-facing scheme). Set behind the ALB
   * (the ECS task always sets it); leave off for direct/loopback serving so
   * clients cannot spoof their own IP or scheme.
   */
  trustProxy?: boolean;
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

async function wrapInWorkspaceShell(
  html: string,
  db: import('../core/db.ts').AsyncDb,
  tenant: string,
  home: string,
  auth: { user: import('../core/auth.ts').User; session: { csrfToken: string } },
  navKey?: import('./render.ts').NavKey,
  activeScope?: string | null,
  isDrawer?: boolean,
): Promise<string> {
  const innerHtml = html.includes('<body>')
    ? html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    : html;
  if (isDrawer) {
    return innerHtml;
  }
  const rooms = (await new ScopeHealthEvaluator(db, tenant, {}).evaluateAll()).map((h) => ({
    scope: h.scope,
    roomName: h.roomName,
    badge: h.badge,
    pending: h.pendingApprovals,
  }));
  const isAdmin = (await import('../core/auth.ts')).atLeast(auth.user.role, 'admin');
  const avail: Record<string, boolean> = { requests: true, claims: true, rooms: true, humanWork: true, buzz: isAdmin, settings: isAdmin, learning: isAdmin, audit: isAdmin, data: isAdmin };
  const nav = (await import('./render.ts')).renderConsoleNav((await import('./render.ts')).buildConsoleNav(home, avail), navKey);
  const cluster = (await import('./render.ts')).renderAccountCluster(auth.user.email, auth.user.role, auth.session.csrfToken);
  const shellWs = await import('./workspace-shell.ts');
  const shellMetrics = await shellWs.computeShellMetrics(db, tenant);
  const shellRecency = await shellWs.computeRoomRecency(
    db,
    tenant,
    rooms.map((r) => r.scope),
  );
  const shell = renderWorkspaceShell({
    rooms,
    activeScope,
    home,
    consoleNav: nav,
    accountCluster: cluster,
    innerHtml,
    userEmail: auth.user.email,
    userRole: auth.user.role,
    tenant,
    metrics: shellMetrics,
    roomRecency: shellRecency,
  });
  return html.slice(0, html.indexOf('<body>') + 6) + shell + html.slice(html.indexOf('</body>'));
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAFAF8;color:#0A0F14;margin:0 auto;padding:32px 24px;max-width:880px;line-height:1.5;letter-spacing:-0.011em;-webkit-font-smoothing:antialiased}
h1{font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 16px 0;color:#0A0F14}
h2{font-size:16px;font-weight:600;letter-spacing:-0.015em;margin:24px 0 12px;color:#111827}
a{color:#0F5C57;text-decoration:none}a:hover{text-decoration:underline}
form:not([style*="display:inline"]){max-width:400px;display:grid;gap:12px;background:#fff;border:1px solid #E4E4E1;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.03)}
form[style*="display:inline"]{display:inline!important;border:none!important;padding:0!important;background:none!important;box-shadow:none!important}
input,textarea,select{padding:10px 12px;border:1px solid #E4E4E1;border-radius:6px;font-family:inherit;font-size:14px;color:#0A0F14;background:#fff;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{border-color:#0F5C57;box-shadow:0 0 0 3px rgba(15,92,87,.12);outline:none}
label{font-size:13px;font-weight:500;color:#374151;display:grid;gap:4px}
button{padding:10px 18px;border:0;border-radius:6px;background:#0F5C57;color:#fff;font-weight:600;cursor:pointer;min-height:44px;font-family:inherit;font-size:14px;transition:background .15s ease,transform .1s ease}
button:hover{background:#0B4A45}
button:active{transform:translateY(1px)}
button:disabled{opacity:0.6;cursor:not-allowed}
.card{border:1px solid #E4E4E1;border-radius:10px;padding:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.03);margin-bottom:16px}
.err{color:#B91C1C;font-size:13px}.sub{color:#6B7280;font-size:13px;line-height:1.4}
.error-summary{border:1px solid #FCA5A5;border-radius:8px;padding:14px 16px;margin:12px 0;background:#FEF2F2;color:#991B1B}
.success{border:1px solid #86EFAC;border-radius:8px;padding:14px 16px;margin:12px 0;background:#F0FDF4;color:#166534}
a.skip-link{position:absolute;left:-9999px;top:0;background:#0F5C57;color:#fff;padding:8px 14px;z-index:100;border-radius:0 0 6px 0;font-size:13px;font-weight:500}a.skip-link:focus{left:0}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #0F5C57;outline-offset:2px}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto;background:#fff;border:1px solid #E4E4E1;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.02)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #E4E4E1}
th{background:#F9F9F8;font-size:12px;font-weight:600;color:#4B5563;text-transform:uppercase;letter-spacing:0.04em}
.table-wrap{overflow-x:auto;max-width:100%}
table.stacked thead{}
@media (max-width:640px){body{padding:16px}form{max-width:100%}input,textarea,select,button{min-height:44px}}
@media (max-width:600px){table.stacked thead{display:none}table.stacked tr{display:block;border:1px solid #E4E4E1;border-radius:8px;margin-bottom:8px}table.stacked td{display:block;border:0}}
</style>
</head><body><a class="skip-link" href="#main">Skip to main content</a><main id="main">${body}</main></body></html>`;
}

function prefersHtml(req: IncomingMessage): boolean {
  const accept = req.headers['accept'] || '';
  return accept.includes('text/html') && !accept.includes('application/json') && !accept.includes('*/*');
}

function respondGetError(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  if (prefersHtml(req)) {
    const html = page(
      `Vital Console — ${status}`,
      `<h1>Error ${status}</h1><p class="err">${esc(error)}</p><p class="sub"><a href="javascript:history.back()">← Go back</a> · <a href="/">Console home</a></p>`,
    );
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    json(res, status, { ok: false, error });
  }
}

// ---------------------------------------------------------------- pre-session CSRF --
// Login and signup run BEFORE a session exists, so the session's CSRF token
// cannot protect them. These pages use the double-submit pattern instead: the
// server sets random `vital_csrf` cookie token(s) on GET and the form must
// echo one of them. A cross-site attacker can submit a form but cannot read
// the cookie to fill the field, so the post is refused. (HttpOnly is fine:
// OUR server reads the cookie and injects the value into the rendered form.)
//
// FLOW-010 multi-tab: the cookie carries a TOKEN FAMILY (up to 10,
// dot-joined), not a single slot. Each page load appends its token, so
// several open login/signup forms stay valid at once — opening tab B never
// invalidates tab A. See session-flow.ts parse/add helpers (unit-tested).
const PRE_CSRF_COOKIE = 'vital_csrf';

function preCsrfCookie(token: string, secure: boolean, existing?: string): string {
  const family = addPreCsrfToken(existing, token);
  return `${PRE_CSRF_COOKIE}=${family}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`;
}

function preCsrfOk(req: IncomingMessage, presented: string | null): boolean {
  const cookie = cookieValue(req, PRE_CSRF_COOKIE);
  if (!cookie || !presented) return false;
  // Family match (current) — plus exact single-token match (legacy cookies
  // issued before the family change, which are families of one).
  if (preCsrfFamilyOk(cookie, presented)) return true;
  const a = Buffer.from(presented);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * FLOW-007 step-up: role changes, disables, ownership transfers and
 * reactivations demand a fresh (≤15min) authentication. Returns true when
 * the route may proceed; otherwise answers 403 REAUTH_REQUIRED and returns
 * false. Never weakens the role/activation/CSRF checks — it runs after them.
 */
async function recentAuthGate(db: AsyncDb, res: ServerResponse, userId: string, at: string): Promise<boolean> {
  try {
    await assertRecentAuthForSensitiveOp(db, userId, at);
    return true;
  } catch (e) {
    const msg =
      e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : 'recent authentication required';
    json(res, 403, {
      ok: false,
      error: `${msg} — sign out and sign in again, then retry`,
      code: 'REAUTH_REQUIRED',
    });
    return false;
  }
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
  const errorBlock = opts.error
    ? `<div class="error-summary" role="alert" tabindex="-1" data-error-summary><p><strong>Sign in failed.</strong></p><ul><li><a href="#email">${esc(opts.error)}</a> Your email is preserved — check the highlighted field and try again.</li></ul></div>`
    : '';
  return page(
    'Vital Console — sign in',
    `<h1>Sign in to ${esc(name)}</h1>
<p class="sub">This console serves the organization <code>${esc(slug)}</code>. Membership is invite-only — ask your administrator if you need access.</p>
${expiredNotice}
${opts.notice ? `<p class="sub" role="status">${esc(opts.notice)}</p>` : ''}
${errorBlock}
${
  opts.recovery
    ? `<p class="sub">This organization has accounts but no usable owner. Ask your operator to run <code>vital passwd</code> or issue a reset link with <code>vital reset-link</code>.</p>`
    : ''
}
<form method="post" action="/login">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${nextField}
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" value="${esc(opts.email ?? '')}" autocomplete="username" required${opts.error ? ' aria-describedby="email-error" aria-invalid="true"' : ''}>
  ${opts.error ? `<span class="err" id="email-error">${esc(opts.error)}</span>` : ''}
  <label class="sub" for="password">password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="sub"><a href="/forgot-password${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}">Forgot password?</a></p>
<p class="sub">Deploying a new instance? <a href="mailto:hello@vital.company">Contact us</a> for a pilot walkthrough — this console does not create additional tenants.</p>`,
  );
}

export function hasMailerConfigured(): boolean {
  return Boolean(process.env.SMTP_URL || process.env.VITAL_MAILER_ENABLED === '1');
}

function forgotPasswordPage(csrf: string, opts: { error?: string; notice?: string; next?: string } = {}): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  const mailerNote = hasMailerConfigured()
    ? `<p class="sub">Enter your account email. If an account exists, a single-use password reset link will be sent to your inbox.</p>`
    : `<div class="card" style="background:#F9FAFB;margin:12px 0 16px 0;padding:14px 16px;">
<p class="sub" style="margin:0 0 6px 0;font-weight:600;color:#374151;">Operator-assisted password recovery</p>
<p class="sub" style="margin:0;">Transactional outbound email is not configured for this self-hosted installation. Submitting this form records an audited reset token in the ledger.</p>
<p class="sub" style="margin:6px 0 0 0;color:#4B5563;"><strong>Next steps:</strong> Ask your system operator to deliver your link using <code>vital reset-link</code>, or contact your team owner. <strong>Expected turnaround:</strong> typically under 1 hour during business hours.</p>
</div>`;

  return page(
    'Vital Console — reset password',
    `<h1>Reset your password</h1>
${mailerNote}
${opts.notice ? `<div class="success" role="status"><p class="sub"><strong>${esc(opts.notice)}</strong></p></div>` : ''}
${opts.error ? `<div class="error-summary" role="alert"><p class="err">${esc(opts.error)}</p></div>` : ''}
<form method="post" action="/forgot-password">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${nextField}
  <label class="sub" for="email">work email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <button type="submit">${hasMailerConfigured() ? 'Send reset email' : 'Request operator reset link'}</button>
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

function accountPage(
  csrf: string,
  user: User,
  error?: string,
  notice?: string,
  homeRef = '/',
  extra: {
    emailVerified?: boolean;
    mfaHint?: string;
    mfa?: { enabled: boolean; factors: MfaFactor[]; recoveryCount: number };
  } = {},
): string {
  const result = passwordChangeResult('voluntary');
  const nav = accountNav('account')
    .map((item) => {
      if (item.active) {
        return `<span aria-current="page">${esc(item.label)}</span>`;
      }
      return `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
    })
    .join(' · ');
  const emailBlock = ((): string => {
    if (extra.emailVerified === undefined) return '';
    if (extra.emailVerified) return '<p class="sub">Email verified — this address may be used for recovery.</p>';
    if (hasMailerConfigured()) {
      return `<p class="sub">Email not yet verified — recovery links are not trusted until verification completes. <form method="post" action="/account/email/request" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Send verification link</button></form></p>`;
    }
    return `<p class="sub">Email not yet verified — automatic email delivery is not configured on this host. Ask your system operator to generate your verification link with <code>vital verify-link --tenant ${esc(user.tenant)} --email ${esc(user.email)}</code> (turnaround: typically same-day). <form method="post" action="/account/email/request" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" style="background:#4B5563;">Request operator verification</button></form></p>`;
  })();
  const mfaBlock = extra.mfaHint ? `<p class="sub">${esc(extra.mfaHint)}</p>` : '';
  // FINAL-005: authenticator enrollment, factor list, and recovery codes.
  const mfaSection = ((): string => {
    if (!extra.mfa) return '';
    if (extra.mfa.enabled) {
      const factors = extra.mfa.factors
        .map(
          (f) =>
            `<form method="post" action="/account/mfa/remove" style="display:inline;margin-left:8px"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="factorId" value="${esc(f.id)}"><button type="submit" style="background:#6B7280">Remove ${esc(f.kind)} factor</button></form>`,
        )
        .join('');
      return `<h2>Two-factor authentication</h2>
<p class="sub">Enabled — ${extra.mfa.factors.length} authenticator factor(s); ${extra.mfa.recoveryCount} unused recovery code(s).</p>
<form method="post" action="/account/mfa/recovery" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Regenerate recovery codes</button></form>${factors}`;
    }
    return `<h2>Two-factor authentication</h2>
<p class="sub">Not enabled. Add an authenticator app so a stolen password alone cannot sign in.</p>
<p><a href="/account/mfa/setup">Set up two-factor authentication</a></p>`;
  })();
  return page(
    'Vital Console — account and security',
    `<h1>Account and security</h1>
<p class="sub">Signed in as ${esc(user.email)} · ${esc(user.role)}</p>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
${emailBlock}${mfaBlock}
${mfaSection}
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

/** FINAL-005: otpauth URI for authenticator apps (no dependency). */
export function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`Vital:${email}`);
  const issuer = encodeURIComponent('Vital');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function mfaChallengePage(csrf: string, opts: { error?: string; next?: string; recovery?: boolean } = {}): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  const modeField = opts.recovery ? '<input type="hidden" name="mode" value="recovery">' : '';
  const label = opts.recovery ? 'recovery code' : 'authentication code';
  const hint = opts.recovery
    ? 'Enter one of the single-use recovery codes you saved when you enabled two-factor authentication.'
    : 'Enter the 6-digit code from your authenticator app.';
  const switchLink = opts.recovery
    ? '<a href="/login/mfa">Use an authenticator code instead</a>'
    : '<a href="/login/mfa?mode=recovery">Use a recovery code</a>';
  return page(
    'Vital Console — two-factor verification',
    `<h1>Two-factor verification</h1>
<p class="sub">${hint}</p>
${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ''}
<form method="post" action="/login/mfa">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${nextField}${modeField}
  <label class="sub" for="code">${label}</label>
  <input id="code" name="code" autocomplete="one-time-code" required>
  <button type="submit">Verify</button>
</form>
<p class="sub">${switchLink} · <a href="/login">Back to sign in</a></p>`,
  );
}

function mfaSetupPage(csrf: string, secret: string, email: string, opts: { error?: string } = {}): string {
  const uri = otpauthUri(email, secret);
  return page(
    'Vital Console — enable two-factor authentication',
    `<h1>Enable two-factor authentication</h1>
<p class="sub">Add this secret to your authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ''}
<div class="success"><p><strong>Secret:</strong> <code>${esc(secret)}</code></p><p class="sub">Setup URI: <code>${esc(uri)}</code></p></div>
<form method="post" action="/account/mfa/enable">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="secret" value="${esc(secret)}">
  <label class="sub" for="code">6-digit code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
  <button type="submit">Confirm and enable</button>
</form>
<p class="sub"><a href="/account">Cancel</a></p>`,
  );
}

function mfaRecoveryCodesPage(codes: string[], home: string): string {
  return page(
    'Vital Console — recovery codes',
    `<h1>Save your recovery codes</h1>
<p class="sub">These single-use codes are shown once. Store them somewhere safe — each signs you in once if you lose your authenticator.</p>
<div class="success"><ul>${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul></div>
<p class="sub"><a href="${esc(home)}">Continue to the console</a></p>`,
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
    home?: string;
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
    compilerGaps?: { cardId: string; intent: string; state: string; gaps: string[]; evalRef: string | null }[];
    filter?: {
      q?: string;
      role?: string;
      status?: string;
      page?: number;
      pageSize?: number;
    };
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

  const q = (extra?.filter?.q ?? '').trim().toLowerCase();
  const roleFilter = (extra?.filter?.role ?? '').trim().toLowerCase();
  const statusFilter = (extra?.filter?.status ?? '').trim().toLowerCase();

  let filteredUsers = users;
  if (q) {
    filteredUsers = filteredUsers.filter((u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  }
  if (roleFilter) {
    filteredUsers = filteredUsers.filter((u) => u.role.toLowerCase() === roleFilter);
  }
  if (statusFilter) {
    filteredUsers = filteredUsers.filter((u) => {
      return statusFilter === 'disabled' ? u.disabled : !u.disabled;
    });
  }

  const pageNum = Math.max(1, extra?.filter?.page ?? 1);
  const pageSize = Math.max(1, extra?.filter?.pageSize ?? 20);
  const totalCount = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pagedUsers = filteredUsers.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  const rows = pagedUsers
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

  const filterForm = `<form method="get" action="/team" style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
  <input type="search" name="q" value="${esc(extra?.filter?.q ?? '')}" placeholder="Search email or name…" style="padding:8px 10px;font-size:13px">
  <select name="role" style="padding:8px 10px;font-size:13px">
    <option value="">All roles</option>
    <option value="owner" ${roleFilter === 'owner' ? 'selected' : ''}>owner</option>
    <option value="admin" ${roleFilter === 'admin' ? 'selected' : ''}>admin</option>
    <option value="operator" ${roleFilter === 'operator' ? 'selected' : ''}>operator</option>
    <option value="member" ${roleFilter === 'member' ? 'selected' : ''}>member</option>
    <option value="viewer" ${roleFilter === 'viewer' ? 'selected' : ''}>viewer</option>
  </select>
  <select name="status" style="padding:8px 10px;font-size:13px">
    <option value="">All statuses</option>
    <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>active</option>
    <option value="disabled" ${statusFilter === 'disabled' ? 'selected' : ''}>disabled</option>
  </select>
  <button type="submit" style="min-height:36px;padding:8px 14px;font-size:13px">Filter roster</button>
  ${q || roleFilter || statusFilter ? '<a href="/team" class="sub" style="margin-left:8px">Clear filters</a>' : ''}
</form>`;

  const paginationBar =
    totalPages > 1
      ? `<nav aria-label="Roster pagination" style="margin-top:12px;display:flex;gap:14px;align-items:center">
  ${pageNum > 1 ? `<a href="/team?page=${pageNum - 1}${q ? `&q=${encodeURIComponent(extra?.filter?.q ?? '')}` : ''}${roleFilter ? `&role=${encodeURIComponent(roleFilter)}` : ''}${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ''}">Previous</a>` : ''}
  <span>Page ${pageNum} of ${totalPages} (${totalCount} members)</span>
  ${pageNum < totalPages ? `<a href="/team?page=${pageNum + 1}${q ? `&q=${encodeURIComponent(extra?.filter?.q ?? '')}` : ''}${roleFilter ? `&role=${encodeURIComponent(roleFilter)}` : ''}${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ''}">Next</a>` : ''}
</nav>`
      : '';

  return page(
    'Vital Console — team',
    `<p class="sub"><a href="${esc(extra?.home ?? '/')}">← console</a></p>
<h1>Team</h1>
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
<h2>${membersHeading}</h2>
${filterForm}
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">status</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="sub">No matching team members found.</td></tr>'}</tbody>
</table>
${paginationBar}
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
  <label class="sub" for="email">work email (single or comma/newline separated)</label>
  <textarea id="email" name="email" rows="2" required placeholder="member@acme.test, teammate@acme.test" style="width:100%;font-family:inherit;box-sizing:border-box"></textarea>
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
 ${compilerGapsSection(extra?.compilerGaps)}
 ${billingScopeSection()}
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
  const policyDrill = describeDrillMode('policy-only');
  const runtimeDrill = describeDrillMode('runtime-halt');
  return `<h2>Emergency stops</h2>
<p class="sub">A stop denies new authorizations at once and never force-terminates work already executing. Recovery is audited with a recorded reason — a restart does not clear a stop.</p>
<p class="sub">Drills come in two modes. Policy-only (<code>${policyDrill.evidence}</code>): ${esc(policyDrill.summary)}. Runtime-halt (<code>${runtimeDrill.evidence}</code>): ${esc(runtimeDrill.summary)}. Run <code>vital drill --policy-only</code> or <code>vital drill --runtime --scope &lt;scope&gt; --class &lt;class&gt;</code> — drill evidence never counts as production readiness.</p>
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
        `<li>${esc(h.at)} · ${esc(h.action)} · ${esc(h.target)} by ${esc(h.actor)}${
          h.detail ? ` — ${esc(h.detail.slice(0, 200))}` : ''
        }${
          h.outboxStatus
            ? ` · outbox: ${esc(h.outboxStatus.status)} attempts=${esc(String(h.outboxStatus.attempts))} nextAt=${esc(h.outboxStatus.nextAt)}`
            : ''
        }</li>`,
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

// FLOW-025 companion sections (read-only; never grant autonomy or imply a
// hosted product). compilerGapsSection renders only when gap data is passed;
// billingScopeSection states the pilot/contact model explicitly.
function compilerGapsSection(
  gaps?: { cardId: string; intent: string; state: string; gaps: string[]; evalRef: string | null }[],
): string {
  if (gaps === undefined) return '';
  const withGaps = gaps.filter((g) => g.gaps.length > 0);
  const items = withGaps
    .map(
      (g) =>
        `<li><code>${esc(g.cardId)}</code> ${esc(g.intent)} (${esc(g.state)}) — gaps: ${esc(g.gaps.join('; '))}${g.evalRef ? ` · eval: <code>${esc(g.evalRef)}</code>` : ' · no eval suite reference — evals are the spec'} · <a href="/console/learning/${esc(encodeURIComponent(g.cardId))}">evaluation evidence</a></li>`,
    )
    .join('');
  return `<h2>Compiler trust gaps</h2>
<p class="sub">Skill cards with open transfer or evaluation gaps stay scoped where they were validated until the listed evidence passes. Linking evidence here never promotes a card — promotion runs only through the governed transfer-test path.</p>
${items ? `<ul class="sub">${items}</ul>` : '<p class="sub">No open trust gaps: every card currently holds the evidence its state requires.</p>'}`;
}

function billingScopeSection(): string {
  return `<h2>Engagement and billing scope</h2>
<p class="sub">Engagement is a direct pilot scoped to the Ship-to-Result wedge with pre-registered metrics and kill criteria agreed before the pilot starts — <a href="mailto:hello@vital.company">contact us</a> for a pilot walkthrough. There is no hosted subscription, invoice, or billing flow in this release — do not present the pilot as one. Subscription or invoice flows will only appear if a hosted commercial model is selected.</p>`;
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
  body += `<p class="sub"><a href="${esc(clearFilterUrl(base))}">Clear search and filters</a> · Browse: <a href="${esc(paths.requests)}">All requests</a> · <a href="${esc(paths.claims)}">All claims</a> · <a href="${esc(paths.rooms)}">All rooms</a> · <a href="${esc(paths.humanWork)}">All human work</a> · <a href="${esc(paths.workflows)}">Workflows</a> · <a href="${esc(paths.digest)}">Digest</a></p>`;
  return `${form}${body}</section>`;
}

/**
 * Whether a review token is valid for this tenant.
 *
 * Fails closed when no secret is configured: without `VITAL_REVIEW_SECRET`
 * there is no way to mint a legitimate token, so no token can be trusted.
 * The literal `'vital-review-secret'` that used to be hard-coded here meant
 * anyone who could read the source could approve any pending request.
 */
function reviewTokenValid(token: string, tenant: string): boolean {
  let secret: string | null;
  try {
    secret = reviewSecretFromEnv();
  } catch {
    return false;
  }
  if (!secret) return false;
  const verified = verifyReviewToken(token, secret);
  return verified.valid && verified.tenant === tenant;
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

async function defaultRoomForUser(
  db: AsyncDb,
  tenant: string,
  user: import('../core/auth.ts').User,
): Promise<string> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`user:defaultRoom:${tenant}:${user.id}`)) as
    | { value: string }
    | undefined;
  if (row?.value) {
    return normalizeScope(row.value);
  }
  const emailOrRole = `${user.email} ${user.role}`.toLowerCase();
  if (emailOrRole.includes('marketing')) {
    return 'business';
  }
  return 'general';
}

async function triggerMentionHandoffs(
  text: string,
  opts: {
    db: AsyncDb;
    ledger: Ledger;
    coord: Coordinator;
    tenant: string;
    originScope: string;
    authorName: string;
    threadRoot?: string | null;
    at: string;
  },
) {
  const mentions = Array.from(text.matchAll(/@([a-zA-Z0-9_-]+)/g));
  if (mentions.length === 0) return;
  const surface = await maybeBuzzSurface(opts.db, opts.tenant);
  const { InterAgentSwarmCoordinator } = await import('../talk/swarm.ts');
  const swarm = new InterAgentSwarmCoordinator({
    db: opts.db,
    ledger: opts.ledger,
    coord: opts.coord,
    surface: surface ?? undefined,
    now: () => opts.at,
  });

  const handledTokens = new Set<string>();
  const { resolveDispatchTarget } = await import('../talk/swarm.ts');
  for (const match of mentions) {
    const token = match[1]!.toLowerCase();
    if (handledTokens.has(token)) continue;
    handledTokens.add(token);

    const resolved = await resolveDispatchTarget(opts.db, opts.tenant, token);
    if (!resolved) continue;
    const targetRoomDef = { agentName: resolved.agentName, scope: resolved.targetScope, name: resolved.targetRoom };

    const dispatchText = text.trim().startsWith('@') ? text.trim() : `@${targetRoomDef.agentName} ${text.trim()}`;
    try {
      const handoff = await swarm.executeHandoff({
        tenant: opts.tenant,
        originScope: opts.originScope,
        originAgent: opts.authorName,
        dispatchText,
        threadRoot: opts.threadRoot ?? undefined,
      });
      await auditConsole(
        opts.db,
        opts.tenant,
        `user:${opts.authorName}`,
        'buzz.dispatch',
        `req:${handoff.downstreamRequestId}`,
        opts.at,
        `Handoff to @${targetRoomDef.agentName} in #${targetRoomDef.name}: chain ${handoff.chainId}`,
      );
    } catch {
      // Non-fatal if swarm dispatch refused or already admitted
      // console.error('HANDOFF ERROR:', err);
    }
  }
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
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
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

  // FLOW-013 / readiness strip: the same tri-state checks served at
  // `/api/metrics` (DB required, worker optional-until-first-heartbeat,
  // integrations optional-until-configured), rendered for the operator who
  // opens the console. `ready`/`unconfigured-optional`/`failing` map to a
  // visible green / grey / red pill so a silent worker or broken source is not
  // a support-call mystery.
  const computeReadiness = async (at: string): Promise<{ ready: boolean; checks: { name: string; status: string; detail?: string }[] }> =>
    checkReadiness(
      [
        {
          name: 'database',
          check: async () => {
            await db.prepare('SELECT 1 AS ok').get();
            return { ok: true as const, detail: `${db.engine} reachable` };
          },
        },
        {
          name: 'worker',
          optional: true,
          check: async () => workerReadiness(db, tenant, { now: at }),
        },
        {
          name: 'integrations',
          optional: true,
          check: async () => {
            const config = await loadActivationConfig(db, tenant);
            const collectors = new Set(await listKnownCollectors(db, tenant));
            if (config) collectors.add(collectorName(config.sourcePath));
            if (collectors.size === 0) return { ok: false, unconfigured: true, detail: 'no source configured' };
            const parts: string[] = [];
            let failing: string | null = null;
            for (const collector of collectors) {
              const health = await getIntegrationHealth(db, tenant, collector, {
                configured: true,
                now: at,
              });
              const projected = integrationReadinessState(health);
              parts.push(projected.detail);
              if (!projected.ok && projected.unconfigured !== true && !failing) failing = collector;
            }
            if (failing) return { ok: false, detail: parts.join(' | ') };
            return { ok: true as const, detail: parts.join(' | ') };
          },
        },
      ],
      { now: at },
    );

  const readinessPill = (status: string): string => {
    if (status === 'ok') return '<span style="display:inline-block;background:#0F7A3D;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">ok</span>';
    if (status === 'unconfigured-optional')
      return '<span style="display:inline-block;background:#9CA3AF;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">not configured</span>';
    return '<span style="display:inline-block;background:#B91C1C;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">needs attention</span>';
  };

  const renderSystemReadiness = async (at: string): Promise<string> => {
    const r = await computeReadiness(at);
    const items = r.checks
      .map(
        (c) =>
          `<li style="margin-bottom:6px">${readinessPill(c.status)} <strong>${esc(c.name)}</strong>${c.detail ? ` — <span class="sub">${esc(c.detail)}</span>` : ''}</li>`,
      )
      .join('');
    const headline = r.ready
      ? 'System is ready'
      : 'System needs attention';
    return `<section id="system-readiness" style="margin-bottom:24px">
<h1>${esc(headline)}</h1>
<ul style="list-style:none;padding:0;margin:8px 0 0 0">${items}</ul>
<p class="sub"><a href="/setup">Setup</a> · <a href="/api/metrics" rel="noreferrer">Raw readiness (JSON)</a></p>
</section>`;
  };

  // Per-instance rate-limit buckets (see the rate-limit note above): a server
  // owns its own counters, so cohabiting instances never share one.
  const buckets = new Map<string, { n: number; reset: number }>();
  // FINAL-005: short-lived, per-process MFA challenges. A correct password
  // starts a challenge but mints no session; only the second factor does.
  // Per-instance state (like the rate-limit buckets above) — the console is
  // a single-tenant, single-process surface.
  const mfaChallenges = new Map<string, { userId: string; tenant: string; expiresAtMs: number }>();
  const MFA_COOKIE = 'vital_mfa';
  const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
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
            '/account/email/request',
            '/verify-email',
            '/login/mfa',
            '/console/dashboard',
            '/console/compiler',
            '/console/audit',
            '/console/data',
            '/console/data/export',
            '/console/data/erase',
            '/receipts/erasure',
            '/account/mfa/setup',
            '/account/mfa/enable',
            '/account/mfa/recovery',
            '/account/mfa/remove',
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
        // FLOW-006: liveness answers through the LB path too — the target
        // group's probe and the smoke script both land here with ALB
        // proxy headers attached. `proto`/`viaProxy` let the smoke check
        // prove the LB→task path, not just loopback reachability.
        if (method === 'GET' && path === '/healthz') {
          const fwd = resolveRequestContext(req, trustProxy);
          return json(res, 200, {
            ok: true,
            vital: '0.0.1',
            listen: boundAddress,
            proto: fwd.scheme,
            viaProxy: fwd.viaProxy,
            ...liveness(now()),
          });
        }
        const ip = resolveRequestContext(req, trustProxy).clientIp;
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
          const existingAuth = await sessionOf();
          if (existingAuth) {
            const defRoom = await defaultRoomForUser(db, tenant, existingAuth.user);
            return redirect(res, `${home}console/buzz/${encodeURIComponent(defRoom)}`);
          }
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          const expired = url.searchParams.get('reason') === 'expired';
          const notice =
            url.searchParams.get('reset') === 'ok'
              ? 'Password saved. Every other session was signed out — sign in to continue.'
              : undefined;
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
                'set-cookie': preCsrfCookie(fresh, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
            const user = await verifyLoginCredentials(
              db,
              { tenant, email, password: call.fields.password ?? '', ip },
              at,
            );
            if (await isMfaEnabled(db, user.id)) {
              // Second factor enrolled: a correct password must NOT mint a
              // usable session. Issue a short-lived challenge instead.
              for (const [k, v] of mfaChallenges) if (v.expiresAtMs <= Date.parse(at)) mfaChallenges.delete(k);
              const challenge = randomBytes(32).toString('hex');
              mfaChallenges.set(challenge, {
                userId: user.id,
                tenant,
                expiresAtMs: Date.parse(at) + MFA_CHALLENGE_TTL_MS,
              });
              await auditConsole(db, tenant, user.id, 'auth.mfa_challenge', 'login', at);
              const mfaCookie = `${MFA_COOKIE}=${challenge}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(MFA_CHALLENGE_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
              const loc = next ? `/login/mfa?next=${encodeURIComponent(next)}` : '/login/mfa';
              return redirect(res, loc, mfaCookie);
            }
            const { session, token } = await startSessionForUser(db, tenant, user.id, at);
            const cookie = sessionCookie(token, at, secure, session);
            if (user.mustChangePassword) return redirect(res, '/change-password', cookie);
            const defRoom = await defaultRoomForUser(db, tenant, user);
            return redirect(res, next ?? `${home}console/buzz/${encodeURIComponent(defRoom)}`, cookie);
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
        // FINAL-005: second-factor step. The session is created only after the
        // code verifies; the challenge cookie is not a session.
        if (path === '/login/mfa' && method === 'GET') {
          const challenge = cookieValue(req, MFA_COOKIE);
          const entry = challenge ? mfaChallenges.get(challenge) : undefined;
          if (!entry || entry.tenant !== tenant || entry.expiresAtMs <= Date.parse(at)) {
            return redirect(
              res,
              loginPath({ reason: 'expired' }),
              `${MFA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
            );
          }
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
          });
          res.end(mfaChallengePage(csrf, { next, recovery: url.searchParams.get('mode') === 'recovery' }));
          return;
        }
        if (path === '/login/mfa' && method === 'POST') {
          const challenge = cookieValue(req, MFA_COOKIE);
          const entry = challenge ? mfaChallenges.get(challenge) : undefined;
          if (!entry || entry.tenant !== tenant || entry.expiresAtMs <= Date.parse(at)) {
            return redirect(
              res,
              loginPath({ reason: 'expired' }),
              `${MFA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
            );
          }
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!preCsrfOk(req, call.csrf))
            return json(res, 403, { ok: false, error: 'bad CSRF token — reload the form' });
          if (!rateOk(`mfa:${ip ?? '-'}:${tenant}`, LOGIN_RATE.limit, LOGIN_RATE.windowMs, Date.parse(at))) {
            const shape = formErrorShape('rate-limited');
            return json(res, shape.status, { ok: false, error: shape.message, code: shape.code });
          }
          const code = (call.fields.code ?? '').trim();
          const next = safeReturnPath(call.fields.next);
          const mode = call.fields.mode === 'recovery';
          const accepted = mode
            ? await consumeMfaRecoveryCode(db, tenant, entry.userId, code, at)
            : await verifyMfaCode(db, tenant, entry.userId, code, at);
          if (!accepted) {
            const csrf = randomBytes(32).toString('hex');
            res.writeHead(401, {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
            });
            res.end(
              mfaChallengePage(csrf, {
                error: mode
                  ? 'That recovery code is not valid or was already used.'
                  : 'That code was not accepted. Check your device clock and try again.',
                next,
                recovery: mode,
              }),
            );
            return;
          }
          mfaChallenges.delete(challenge!);
          const { user, session, token } = await startSessionForUser(db, tenant, entry.userId, at);
          const sessionCk = sessionCookie(token, at, secure, session);
          const clearMfa = `${MFA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
          const defRoom = await defaultRoomForUser(db, tenant, user);
          const target = user.mustChangePassword ? '/change-password' : (next ?? `${home}console/buzz/${encodeURIComponent(defRoom)}`);
          res.writeHead(303, { location: target, 'set-cookie': [sessionCk, clearMfa] });
          res.end();
          return;
        }
        if (path === '/forgot-password' && method === 'GET') {
          if (accessState === 'unclaimed') return redirect(res, '/signup');
          if (await sessionOf()) return redirect(res, home);
          const csrf = randomBytes(32).toString('hex');
          const next = safeReturnPath(url.searchParams.get('next'));
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
          let notice = hasMailerConfigured()
            ? 'If an account exists for that email, a password reset link has been sent to your inbox.'
            : 'If an account exists for that email, the reset request has been recorded. Automatic email delivery is not configured on this host — ask your operator to deliver your single-use link via vital reset-link (turnaround: under 1 hour).';
          if (token) {
            // FLOW-007: recovery rides on a verified address. The reset token
            // is still issued (no oracle for strangers), but the owner is
            // told verification is missing so an unverified address is never
            // silently trusted as the recovery channel.
            const channel = await recoveryChannelStatus(db, tenant, email);
            if (channel.exists && !channel.verified)
              notice +=
                ' Note: this email address is not yet verified — verify it from Account and security before relying on it for recovery.';
            if (exposeResetToken) {
              const link = `/reset-password?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
              notice = `Reset link (development only): ${link}${channel.exists && !channel.verified ? ' (email unverified — verify before relying on it)' : ''}`;
            }
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
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
        if (path === '/receipts/erasure' && method === 'GET') {
          const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
          if (slug) {
            return redirect(res, `/receipts/erasure/${encodeURIComponent(slug)}`);
          }
          const verification = { found: false, slug: '' };
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderErasureReceiptPage(verification as any, home));
          return;
        }
        if (path.startsWith('/receipts/erasure/') && method === 'GET') {
          const slug = decodeURIComponent(path.slice('/receipts/erasure/'.length)).trim().toLowerCase();
          const verification = await verifyErasureReceipt(db, slug);
          res.writeHead(verification.found ? 200 : 404, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(renderErasureReceiptPage(verification, home));
          return;
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
            'set-cookie': preCsrfCookie(csrf, secure, cookieValue(req, PRE_CSRF_COOKIE)),
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
          const verified = await isEmailVerified(db, auth.user.tenant, auth.user.id);
          const factors = await listMfaFactors(db, auth.user.id);
          const recoveryCount = await countLiveRecoveryCodes(db, auth.user.id);
          const raw = accountPage(auth.session.csrfToken, auth.user, undefined, undefined, home, {
            emailVerified: verified,
            mfa: { enabled: factors.length > 0, factors, recoveryCount },
          });
          const shelled = await wrapInWorkspaceShell(raw, db, tenant, home, auth, 'account');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(shelled);
          return;
        }
        // FLOW-007: email-verification lifecycle over HTTP. The request route
        // is session-gated (no oracle for strangers); the confirm route bears
        // the single-use token and is valid for 24h.
        if (path === '/account/email/request' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const token = await requestEmailVerification(db, auth.user.tenant, auth.user.id, at);
          if (process.env.VITAL_EXPOSE_VERIFY_LINK === '1') {
            return json(res, 200, {
              ok: true,
              verifyLink: `/verify-email?token=${encodeURIComponent(token)}`,
              notice: 'Verification link issued (development only). Confirm within 24 hours.',
            });
          }
          const verified = await isEmailVerified(db, auth.user.tenant, auth.user.id);
          const raw = accountPage(
            auth.session.csrfToken,
            auth.user,
            undefined,
            hasMailerConfigured()
              ? 'Verification link sent to your inbox. Confirm within 24 hours.'
              : 'Verification token issued. Outbound email is not configured — ask your operator to retrieve your link with vital verify-link (turnaround: under 1 business day).',
            home,
            {
              emailVerified: verified,
            },
          );
          const shelled = await wrapInWorkspaceShell(raw, db, tenant, home, auth, 'account');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(shelled);
          return;
        }
        if (path === '/verify-email' && method === 'GET') {
          const token = url.searchParams.get('token') ?? '';
          if (!token) return redirect(res, '/login');
          try {
            const user = await confirmEmailVerification(db, token, at);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              page(
                'Vital Console — email verified',
                `<h1>Email verified</h1><p class="sub">${esc(user.email)} is now a trusted recovery channel.</p><p class="sub"><a href="/login">Sign in</a></p>`,
              ),
            );
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              page(
                'Vital Console — verification failed',
                `<p class="err">${esc(e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message)}</p><p class="sub">Ask for a fresh link from Account and security.</p>`,
              ),
            );
          }
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
        // FINAL-005: authenticator enrollment + recovery-code management.
        if (path === '/account/mfa/setup' && method === 'GET') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const secret = newTotpSecret();
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(mfaSetupPage(auth.session.csrfToken, secret, auth.user.email));
          return;
        }
        if (path === '/account/mfa/enable' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const secret = call.fields.secret ?? '';
          try {
            await confirmMfaEnrollment(db, tenant, auth.user.id, secret, call.fields.code ?? '', at);
            const codes = await generateMfaRecoveryCodes(db, tenant, auth.user.id, at);
            await auditConsole(db, tenant, by(auth.user), 'account.mfa_enabled', `user:${auth.user.id}`, at);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(mfaRecoveryCodesPage(codes, home));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              mfaSetupPage(auth.session.csrfToken, secret, auth.user.email, {
                error: e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message,
              }),
            );
          }
          return;
        }
        if (path === '/account/mfa/recovery' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          if (!(await isMfaEnabled(db, auth.user.id))) return redirect(res, '/account');
          const codes = await generateMfaRecoveryCodes(db, tenant, auth.user.id, at);
          await auditConsole(db, tenant, by(auth.user), 'account.mfa_recovery_regenerated', `user:${auth.user.id}`, at);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(mfaRecoveryCodesPage(codes, home));
          return;
        }
        if (path === '/account/mfa/remove' && method === 'POST') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          try {
            await removeMfaFactor(db, tenant, auth.user.id, call.fields.factorId ?? '', at);
            await auditConsole(db, tenant, by(auth.user), 'account.mfa_removed', `user:${auth.user.id}`, at);
          } catch {
            /* unknown factor — nothing to remove; return to the account page */
          }
          return redirect(res, '/account');
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
        const deliverableByRequest = path.match(/^\/console\/deliverables\/by-request\/([^/]+)$/);
        if (method === 'GET' && deliverableByRequest) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          let requestId: string;
          try {
            requestId = decodeURIComponent(deliverableByRequest[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed request id' });
          }
          const { loadDeliverableByRequest } = await import('../wedge/deliverable-artifact.ts');
          const record = await loadDeliverableByRequest(db, tenant, requestId);
          if (!record) return json(res, 404, { ok: false, error: 'no deliverable for request' });
          return redirect(res, `/console/deliverables/${encodeURIComponent(record.id)}`);
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
            return respondGetError(req, res, 400, 'days must be 1, 7, 30 or all');
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
        // FINAL-004: human surface for learning review (labeling + card gaps).
        // Replaces the in-product links that previously pointed at the JSON
        // learning APIs, which render as an unstyled blob in a browser.
        if (method === 'GET' && path === '/console/learning') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            const body = '<p class="sub">Learning review requires the admin or owner role.</p>';
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              await wrapInWorkspaceShell(detailDocument('Learning review', body, detailOpts), db, tenant, home, auth, 'learning'),
            );
            return;
          }
          const labeled = url.searchParams.get('labeled');
          const errorParam = url.searchParams.get('error');
          let notice: string | undefined;
          if (labeled === 'ok') notice = 'Decision labeled.';
          else if (errorParam) notice = `Could not label: ${errorParam}`;
          const body = await renderLearningPage(db, new CognitiveRouter(db), comp, tenant, {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            notice,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(
            await wrapInWorkspaceShell(detailDocument('Learning review', body, detailOpts), db, tenant, home, auth, 'learning'),
          );
          return;
        }
        if (method === 'GET' && path === '/console/compiler') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const isDrawer = url.searchParams.get('drawer') === '1';
          const content = await renderCompilerView(db, comp, tenant);
          if (isDrawer) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(content);
            return;
          }
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(
            await wrapInWorkspaceShell(detailDocument('Compiler — Why Not Trusted Yet', content, detailOpts), db, tenant, home, auth),
          );
          return;
        }
        // ------------------------------------------------------------ Workspace (internal: buzz)
        // The human-facing room console: roster + per-room thread view.
        // Authenticated, admin-gated pages over the same evaluators the APIs
        // expose — the first UI that consumes any of it.
        if (method === 'GET' && path === '/console/buzz') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              detailDocument(
                'Workspace',
                '<p class="sub">The workspace requires the admin or owner role.</p>',
                detailOpts,
              ),
            );
            return;
          }
          const surface = await maybeBuzzSurface(db, tenant);
          try {
            const roster = await buildBuzzRoster(db, tenant, surface);
            const body = renderBuzzRoster(roster, home, auth.session.csrfToken);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(await wrapInWorkspaceShell(buzzDocument('Workspace', body), db, tenant, home, auth, 'buzz'));
          } finally {
            // The surface holds no pooled connections of its own; the health
            // probe is one fetch. Nothing to close — this block documents that.
          }
          return;
        }
        const buzzRoom = path.match(/^\/console\/buzz\/([^/]+)$/);
        if (method === 'GET' && buzzRoom) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              detailDocument(
                'Room',
                '<p class="sub">The workspace requires the admin or owner role.</p>',
                detailOpts,
              ),
            );
            return;
          }
          const scope = decodeURIComponent(buzzRoom[1]!);
          const surface = await maybeBuzzSurface(db, tenant);
          const notice = url.searchParams.get('notice') ?? undefined;
          const body = await renderBuzzRoom(
            db,
            tenant,
            scope,
            home,
            auth.session.csrfToken,
            surface,
            notice ?? undefined,
            auth.user.id,
            coord,
          );
          if (!body) {
            res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              detailDocument(
                'Room',
                '<p class="sub">No such room. <a href="' + esc(home) + 'console/buzz">Back to the workspace</a>.</p>',
                detailOpts,
              ),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(await wrapInWorkspaceShell(buzzDocument(`#${scope}`, body), db, tenant, home, auth, 'buzz', scope));
          return;
        }
        const buzzRoomCommand = path.match(/^\/console\/buzz\/([^/]+)\/command$/);
        if (method === 'POST' && buzzRoomCommand) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          if (!atLeast(auth.user.role, 'admin')) {
            return json(res, 403, { ok: false, error: 'admin role required' });
          }
          const call = await parseCall(req);
          if (!csrfOk(auth.session, call.csrf)) {
            return json(res, 403, { ok: false, error: 'bad CSRF token' });
          }
          const scope = decodeURIComponent(buzzRoomCommand[1]!);
          const command = String(call.fields.command ?? '').trim();
          const back = `${home}console/buzz/${encodeURIComponent(scope)}`;
          if (!command) return redirect(res, back);
          const evaluator = new ScopeHealthEvaluator(db, tenant, { coord, compiler: comp, ledger });
          const result = await executeRoomCommand(command, {
            db,
            tenant,
            actor: by(auth.user),
            currentScope: scope,
            coord,
            ledger,
            evaluator,
          });
          if (!result.handled) {
            // Treat unhandled input as a conversation message with @mention dispatch
            const { createLocalReply } = await import('./buzz.ts');
            const byName = auth.user.email.split('@')[0] ?? auth.user.email;
            const newId = await createLocalReply(db, tenant, scope, null, byName, command, at);
            await triggerMentionHandoffs(command, {
              db,
              ledger,
              coord,
              tenant,
              originScope: scope,
              authorName: byName,
              threadRoot: null,
              at,
            });

            let targetId = newId;
            const { isBusinessIntelligenceInquiry, queryBusinessState } = await import('../talk/rag-analyst.ts');
            if (isBusinessIntelligenceInquiry(command, scope)) {
              const replyText = await queryBusinessState(db, tenant, command, at);
              const agentId = await createLocalReply(db, tenant, scope, newId, 'general-agent', replyText, at);
              targetId = agentId;
            }

            await auditConsole(db, tenant, by(auth.user), 'buzz.chat', `room:${scope}`, at, command.slice(0, 200));
            return redirect(res, `${back}#msg-${encodeURIComponent(targetId)}`);
          }
          await auditConsole(db, tenant, by(auth.user), 'buzz.command', `room:${scope}`, at, command.slice(0, 200));
          const notice = `Command ${result.command} executed.`;
          return redirect(res, `${back}?notice=${encodeURIComponent(notice.slice(0, 200))}`);
        }
        const buzzReact = path.match(/^\/console\/buzz\/([^/]+)\/react$/);
        if (method === 'POST' && buzzReact) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const call = await parseCall(req);
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const scope = decodeURIComponent(buzzReact[1]!);
          const messageId = String(call.fields.messageId ?? '').trim().slice(0, 64);
          const emoji = String(call.fields.emoji ?? '').trim().slice(0, 8);
          if (!messageId || !emoji) return redirect(res, `${home}console/buzz/${encodeURIComponent(scope)}`);
          const { toggleReaction } = await import('./buzz.ts');
          await toggleReaction(db, tenant, messageId, emoji, auth.user.id, at);
          await auditConsole(db, tenant, by(auth.user), 'buzz.react', `msg:${messageId}`, at, emoji);
          return redirect(res, `${home}console/buzz/${encodeURIComponent(scope)}#msg-${encodeURIComponent(messageId)}`);
        }
        const buzzReply = path.match(/^\/console\/buzz\/([^/]+)\/reply$/);
        if (method === 'POST' && buzzReply) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const call = await parseCall(req);
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const scope = decodeURIComponent(buzzReply[1]!);
          const parentId = String(call.fields.parentId ?? '').trim().slice(0, 64) || null;
          const content = String(call.fields.content ?? '').trim().slice(0, 500);
          if (!content) return redirect(res, `${home}console/buzz/${encodeURIComponent(scope)}`);
          const { createLocalReply } = await import('./buzz.ts');
          const byName = auth.user.email.split('@')[0] ?? auth.user.email;
          const newId = await createLocalReply(db, tenant, scope, parentId, byName, content, at);
          await triggerMentionHandoffs(content, {
            db,
            ledger,
            coord,
            tenant,
            originScope: scope,
            authorName: byName,
            threadRoot: parentId,
            at,
          });

          let targetReplyId = newId;
          const { isBusinessIntelligenceInquiry, queryBusinessState } = await import('../talk/rag-analyst.ts');
          if (isBusinessIntelligenceInquiry(content, scope)) {
            const replyText = await queryBusinessState(db, tenant, content, at);
            const agentId = await createLocalReply(db, tenant, scope, parentId ?? newId, 'general-agent', replyText, at);
            targetReplyId = agentId;
          }

          await auditConsole(db, tenant, by(auth.user), 'buzz.reply', `msg:${newId}`, at, content.slice(0, 120));
          return redirect(res, `${home}console/buzz/${encodeURIComponent(scope)}#msg-${encodeURIComponent(targetReplyId)}`);
        }
        const learningCard = path.match(/^\/console\/learning\/([^/]+)$/);
        if (method === 'GET' && learningCard) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            const body = '<p class="sub">Learning review requires the admin or owner role.</p>';
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(await wrapInWorkspaceShell(detailDocument('Skill card', body, detailOpts), db, tenant, home, auth, 'learning'));
            return;
          }
          let cardId: string;
          try {
            cardId = decodeURIComponent(learningCard[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed card id' });
          }
          const body = await renderLearningCardPage(db, comp, tenant, cardId);
          if (!body) return json(res, 404, { ok: false, error: 'skill card not found' });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(await wrapInWorkspaceShell(detailDocument('Skill card', body, detailOpts), db, tenant, home, auth, 'learning'));
          return;
        }
        if (path === '/console/learning/label' && method === 'POST') {
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
          const decisionId = Number(call.fields.decisionId);
          const correctTier = call.fields.correctTier ?? '';
          if (!Number.isInteger(decisionId) || decisionId <= 0) {
            return redirect(
              res,
              '/console/learning?error=' + encodeURIComponent('decisionId must be a positive integer'),
            );
          }
          if (!['CACHE', 'MODEL', 'WORKFLOW', 'HUMAN'].includes(correctTier)) {
            return redirect(res, '/console/learning?error=' + encodeURIComponent('invalid routing tier'));
          }
          const reviewer = by(auth.user);
          try {
            await new CognitiveRouter(db).label(tenant, decisionId, correctTier as never, reviewer);
            await auditConsole(
              db,
              tenant,
              reviewer,
              'console.label_decision',
              String(decisionId),
              at,
              `correct_tier=${correctTier}`,
            );
            return redirect(res, '/console/learning?labeled=ok');
          } catch (e) {
            return redirect(res, '/console/learning?error=' + encodeURIComponent((e as Error).message));
          }
        }
        // FINAL-006: admin audit-log surface (the audit API existed with no page).
        if (method === 'GET' && path === '/console/audit') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              await wrapInWorkspaceShell(
                detailDocument('Audit log', '<p class="sub">Audit log requires the admin or owner role.</p>', detailOpts),
                db,
                tenant,
                home,
                auth,
                'audit',
              ),
            );
            return;
          }
          const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
          const { html } = await renderAuditPage(db, tenant, {
            actor: url.searchParams.get('actor') ?? undefined,
            action: url.searchParams.get('action') ?? undefined,
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
            request: url.searchParams.get('request') ?? undefined,
            offset: Number.isSafeInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(await wrapInWorkspaceShell(detailDocument('Audit log', html, detailOpts), db, tenant, home, auth, 'audit'));
          return;
        }
        if (method === 'GET' && path === '/console/data') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              await wrapInWorkspaceShell(
                detailDocument(
                  'Data & retention',
                  '<p class="sub">Data & retention requires the admin or owner role.</p>',
                  detailOpts,
                ),
                db,
                tenant,
                home,
                auth,
                'data',
              ),
            );
            return;
          }
          const html = renderDataPage(tenant, {
            csrf: auth.session.csrfToken,
            home,
            notice: url.searchParams.get('notice') ?? undefined,
            error: url.searchParams.get('error') ?? undefined,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(
            await wrapInWorkspaceShell(detailDocument('Data & retention', html, detailOpts), db, tenant, home, auth, 'data'),
          );
          return;
        }
        if (method === 'GET' && path === '/console/data/export') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end('Export requires the admin or owner role.');
            return;
          }
          const bundle = await exportLedger(db, tenant, at);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${tenant}-ledger-export.json"`,
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(bundle, null, 2));
          return;
        }
        if (method === 'POST' && path === '/console/data/erase') {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, false)) return;
          if (!atLeast(auth.user.role, 'admin')) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end('Erasure requires the admin or owner role.');
            return;
          }
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const confirmSlug = (call.fields.confirmSlug ?? '').trim();
          const confirmed = call.fields.confirmed;
          if (confirmSlug !== tenant || confirmed !== 'on') {
            redirect(
              res,
              `/console/data?error=${encodeURIComponent('Typed confirmation did not match organization slug.')}`,
            );
            return;
          }
          try {
            await eraseTenant(db, tenant, by(auth.user), at);
            return redirect(res, `/receipts/erasure/${encodeURIComponent(tenant)}`, CLEAR_SESSION_COOKIE);
          } catch (e) {
            redirect(res, `/console/data?error=${encodeURIComponent((e as Error).message)}`);
          }
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
          res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'workflows', undefined, url.searchParams.get('drawer') === '1'));
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
          res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'workflows'));
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
        // FLOW-020 view-all routes: permissioned, paginated, tenant-scoped
        // indexes reusing searchRequests/searchClaims/partitionRequestsByDecision.
        // Detail links carry returnTo (the full list URL incl. filters) so the
        // detail Back target preserves filter/sort/page state.
        if (method === 'GET' && (path === '/console/requests' || path === '/console/claims')) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const state = decodeListState(url.search);
          const here = returnPath();
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          try {
            if (path === '/console/requests') {
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
              const row = (r: { id: string; goal: string; state: string }): string =>
                `<li><a href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.goal)}</a> <span class="sub">${esc(r.id)} · ${esc(r.state)}</span></li>`;
              let body = '';
              if (pageResult.total === 0) {
                const model = noResultsModel('/console/requests', state);
                body = `<p class="sub">${esc(model.title)}: ${esc(model.body)} <a href="${esc(model.clearUrl)}">Clear search and filters</a></p>`;
              } else {
                if (groups.pending.length > 0)
                  body += `<h2>Pending decision (${groups.pending.length})</h2><ul>${groups.pending.map(row).join('')}</ul>`;
                if (groups.active.length > 0)
                  body += `<h2>Approved or executing (${groups.active.length})</h2><ul>${groups.active.map(row).join('')}</ul>`;
                if (groups.other.length > 0)
                  body += `<h2>Other states (${groups.other.length})</h2><ul>${groups.other.map(row).join('')}</ul>`;
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
              const html = detailDocument(
                'Requests',
                renderListPage({
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
                detailOpts,
              );
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'requests', undefined, url.searchParams.get('drawer') === '1'));
              return;
            }
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
                `<ul>${pageResult.rows.map((c) => `<li><a href="${esc(withReturnTo(claimDetailUrl(c.id), here))}">${esc(c.subject)}</a> <span class="sub">${esc(c.id)} · ${esc(c.kind)} · ${esc(c.status)}</span></li>`).join('')}</ul>` +
                (pageResult.truncated
                  ? `<p class="sub">explicit truncation: showing ${pageResult.rows.length} of ${pageResult.total} matching claims</p>`
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
            const html = detailDocument(
              'Claims',
              renderListPage({
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
              detailOpts,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'claims', undefined, url.searchParams.get('drawer') === '1'));
            return;
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
        }
        if (method === 'GET' && (path === '/console/rooms' || path === '/console/human-work')) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          const state = decodeListState(url.search);
          const here = returnPath();
          const limit =
            state.limit !== undefined && Number.isSafeInteger(state.limit) && state.limit > 0
              ? Math.min(state.limit, 100)
              : 20;
          const offset =
            state.offset !== undefined && Number.isSafeInteger(state.offset) && state.offset >= 0 ? state.offset : 0;
          const detailOpts = {
            tenant,
            actor: by(auth.user),
            csrf: auth.session.csrfToken,
            canApprove: false,
            requiredRole: approverMin,
            operatorMode: 'session' as const,
            home,
          };
          if (path === '/console/rooms') {
            const q = (state.q ?? '').trim().toLowerCase();
            const allScopes = (await db
              .prepare(
                `SELECT scope FROM (SELECT origin_scope AS scope FROM requests WHERE tenant = ? UNION SELECT target_scope AS scope FROM requests WHERE tenant = ?) ORDER BY scope`,
              )
              .all(tenant, tenant)) as { scope: unknown }[];
            let scopes = allScopes.map((r) => String(r.scope));
            if (q) scopes = scopes.filter((s) => s.toLowerCase().includes(q));
            const total = scopes.length;
            const pageScopes = scopes.slice(offset, offset + limit);
            const items: string[] = [];
            for (const scope of pageScopes) {
              const n = (await db
                .prepare(
                  `SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND (origin_scope = ? OR target_scope = ?)`,
                )
                .get(tenant, scope, scope)) as { n: unknown };
              items.push(
                `<li><a href="${esc(`/console/requests?scope=${encodeURIComponent(scope)}&return=${encodeURIComponent(here)}`)}">${esc(scope)}</a> <span class="sub">${Number(n?.n ?? 0)} request(s)</span></li>`,
              );
            }
            const body =
              total === 0
                ? `<p class="sub">No results: no rooms match this search. <a href="${esc(clearFilterUrl('/console/rooms'))}">Clear search and filters</a></p>`
                : `<ul>${items.join('')}</ul>${offset + pageScopes.length < total ? `<p class="sub">explicit truncation: showing ${pageScopes.length} of ${total} rooms</p>` : ''}`;
            const prev =
              offset > 0 ? listStateUrl('/console/rooms', { ...state, offset: Math.max(0, offset - limit) }) : null;
            const next =
              offset + pageScopes.length < total
                ? listStateUrl('/console/rooms', { ...state, offset: offset + pageScopes.length })
                : null;
            const html = detailDocument(
              'Rooms',
              renderListPage({
                title: 'Rooms',
                heading: 'Rooms',
                searchAction: '/console/rooms',
                query: state.q ?? '',
                total,
                truncated: offset + pageScopes.length < total,
                shown: pageScopes.length,
                prevUrl: prev,
                nextUrl: next,
                clearUrl: clearFilterUrl('/console/rooms'),
                body,
              }),
              detailOpts,
            );
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'rooms'));
            return;
          }
          const q = (state.q ?? '').trim().toLowerCase();
          const all = await coord.list(tenant);
          const terminal = new Set(['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED']);
          let work = all.filter(
            (r) => r.messageClass === 'REQUEST' && r.bid.humanMinutes > 0 && !terminal.has(r.state),
          );
          if (q) work = work.filter((r) => `${r.goal} ${r.id}`.toLowerCase().includes(q));
          work.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          const total = work.length;
          const pageWork = work.slice(offset, offset + limit);
          const body =
            total === 0
              ? `<p class="sub">No results: no human work matches this search. <a href="${esc(clearFilterUrl('/console/human-work'))}">Clear search and filters</a></p>`
              : `<ul>${pageWork.map((r) => `<li><a href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.goal)}</a> <span class="sub">${esc(r.id)} · ${esc(r.state)}</span></li>`).join('')}</ul>${offset + pageWork.length < total ? `<p class="sub">explicit truncation: showing ${pageWork.length} of ${total} items</p>` : ''}`;
          const prev =
            offset > 0 ? listStateUrl('/console/human-work', { ...state, offset: Math.max(0, offset - limit) }) : null;
          const next =
            offset + pageWork.length < total
              ? listStateUrl('/console/human-work', { ...state, offset: offset + pageWork.length })
              : null;
          const html = detailDocument(
            'Human work',
            renderListPage({
              title: 'Human work',
              heading: 'Human work',
              searchAction: '/console/human-work',
              query: state.q ?? '',
              total,
              truncated: offset + pageWork.length < total,
              shown: pageWork.length,
              prevUrl: prev,
              nextUrl: next,
              clearUrl: clearFilterUrl('/console/human-work'),
              body,
            }),
            detailOpts,
          );
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, 'humanWork'));
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
            return respondGetError(req, res, 400, 'malformed detail id');
          }
          const pageIndex = Number(url.searchParams.get('page') ?? '0');
          if (!Number.isSafeInteger(pageIndex) || pageIndex < 0)
            return respondGetError(req, res, 400, 'page must be a nonnegative integer');
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
            notice: url.searchParams.get('notice') ?? undefined,
            draft: url.searchParams.get('draft') === '1',
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
          if (!html) return respondGetError(req, res, 404, 'evidence not found');
          let detailNavKey: import('./render.ts').NavKey | undefined;
          if (detail[1] === 'claims') detailNavKey = 'claims';
          else if (detail[1] === 'requests') detailNavKey = 'requests';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(await wrapInWorkspaceShell(html, db, tenant, home, auth, detailNavKey));
          return;
        }
        const deliverableDraftPost = path.match(/^\/console\/requests\/([^/]+)\/deliverable$/);
        if (method === 'POST' && deliverableDraftPost) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          let id: string;
          try {
            id = decodeURIComponent(deliverableDraftPost[1]!);
          } catch {
            return json(res, 400, { ok: false, error: 'malformed request id' });
          }
          let call: Call;
          try {
            call = await parseCall(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: (e as Error).message });
          }
          if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
          const request = await coord.get(tenant, id);
          if (!request) return json(res, 404, { ok: false, error: 'request not found' });
          const content = String(call.fields.content ?? '').trim();
          if (!content) return json(res, 400, { ok: false, error: 'deliverable content is required' });
          const deliverableSchema = String(
            call.fields.deliverableSchema ?? request.deliverableSchema ?? 'feature-plan.v1',
          ).trim();
          const priorVersionId = String(call.fields.priorVersionId ?? '').trim() || null;
          const revisionNotes = String(call.fields.revisionNotes ?? '').trim() || null;
          const externalPublish = call.fields.externalPublish === 'on' || call.fields.externalPublish === 'true';

          const claimIdSet = new Set<string>();
          for (const m of content.matchAll(/\[claim:([^\]]+)\]/gi)) {
            claimIdSet.add(m[1]!);
          }
          if (claimIdSet.size === 0) {
            for (const cid of [...request.claimRefs, ...request.chainClaimIds]) {
              claimIdSet.add(cid);
            }
          }

          const version = await persistDeliverableVersion(db, ledger, {
            tenant,
            requestId: id,
            workflowId: null,
            deliverableSchema,
            content,
            claimIds: [...claimIdSet],
            createdBy: by(auth.user),
            now: at,
            artifactDir: artifactDir ?? process.env.ARTIFACT_DIR,
            externalPublish,
            revisionNotes,
            priorVersionId,
          });

          await auditConsole(
            db,
            tenant,
            by(auth.user),
            'console.draft-deliverable',
            `deliverable:${version.id}`,
            at,
            `version=${version.version}`,
          );

          return redirect(res, `/console/requests/${encodeURIComponent(id)}`);
        }
        if (method === 'GET' && (path === home || path === '/console' || path === '/console/' || path === '/console/dashboard')) {
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

          const users = await listUsers(db, tenant);
          const activationState = await buildActivationState(db, ledger, coord, tenant, at, users, {
            approverRole: approverMin,
          });

          if (
            (path === home || path === '/console' || path === '/console/') &&
            path !== '/console/dashboard' &&
            url.searchParams.get('view') !== 'dashboard' &&
            !activationState.showPanel &&
            !activationState.sampleActive
          ) {
            const defRoom = await defaultRoomForUser(db, tenant, auth.user);
            const prefix = home.endsWith('/') ? home : `${home}/`;
            const loc = `${prefix}console/buzz/${encodeURIComponent(defRoom)}`;
            const refreshed = sessionCookie(auth.session.id, at, secure, auth.session);
            res.writeHead(302, {
              location: loc,
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': refreshed,
            });
            res.end(
              `<!DOCTYPE html><html><head><meta name="vital-csrf" content="${esc(auth.session.csrfToken)}"></head><body><p>Redirecting to <a href="${esc(loc)}">workspace chat</a>...</p></body></html>`,
            );
            return;
          }
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
          const report = await reportHtml(tenant, at);
          const fallbackMode = operatorSecret ? 'secret' : 'session';
          const readiness = await renderSystemReadiness(at);
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
          const rawScope = (url.searchParams.get('scope') ?? 'all').toLowerCase();
          const activeDepartment: DashboardDepartment = ['all', 'legal', 'marketing', 'finance', 'engineering'].includes(rawScope)
            ? (rawScope as DashboardDepartment)
            : 'all';
          const deptEvaluations = await new ScopeHealthEvaluator(db, tenant, {}).evaluateAll();
          const deptTabs = renderDepartmentTabs(activeDepartment, home);
          const deptBanner = renderDepartmentBanner({
            activeScope: activeDepartment,
            home,
            userRole: auth.user.role,
            evaluations: deptEvaluations,
          });

          const html = report.replace(
            '<h1>Reality health</h1>',
            () => `${deptTabs}${deptBanner}${readiness}${searchHtml}${activation}${review}<h1>Reality health</h1>`,
          );
          // The CSRF token rides in the page so same-origin form posts and
          // same-origin fetches can both present it.
          const withCsrf = html.replace(
            '</head>',
            () => `<meta name="vital-csrf" content="${esc(auth.session.csrfToken)}"></head>`,
          );
          const isAdmin = atLeast(auth.user.role, 'admin');
          const consoleNav = renderConsoleNav(
            buildConsoleNav(home, {
              requests: true,
              claims: true,
              rooms: true,
              humanWork: true,
              settings: isAdmin,
              learning: isAdmin,
              audit: isAdmin,
              data: isAdmin,
              buzz: isAdmin,
            }),
          );
          const accountCluster = renderAccountCluster(auth.user.email, auth.user.role, auth.session.csrfToken);
          const skip = `<a class="skip-link" href="#main">Skip to main content</a>`;
          // Chat-centric shell: every console page lives inside Workspace
          const shellRooms = (await new ScopeHealthEvaluator(db, tenant, {}).evaluateAll()).map((h) => ({
            scope: h.scope,
            roomName: h.roomName,
            badge: h.badge,
            pending: h.pendingApprovals,
          }));
          const inner = withCsrf.slice(withCsrf.indexOf('<body>') + 6, withCsrf.indexOf('</body>'));
          const shellWs = await import('./workspace-shell.ts');
          const shellMetrics = await shellWs.computeShellMetrics(db, tenant);
          const shellRecency = await shellWs.computeRoomRecency(
            db,
            tenant,
            shellRooms.map((r) => r.scope),
          );
          const shelled =
            skip +
            renderWorkspaceShell({
              rooms: shellRooms,
              home,
              consoleNav,
              accountCluster,
              innerHtml: inner,
              userEmail: auth.user.email,
              userRole: auth.user.role,
              tenant,
              metrics: shellMetrics,
              roomRecency: shellRecency,
            });
          const withUser = withCsrf.slice(0, withCsrf.indexOf('<body>') + 6) + shelled + withCsrf.slice(withCsrf.indexOf('</body>'));
          // FLOW-010: the browser cookie tracks the slid DB row — every
          // verified page view re-arms both the idle window (DB) and the
          // cookie Max-Age, so idle and absolute lifetimes stay aligned.
          const refreshed = sessionCookie(auth.session.id, at, secure, auth.session);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': refreshed });
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
          const test = await testConfiguredSource(config);
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

        if (
          (path === '/setup/rooms' || path === '/settings/rooms' || path === '/console/settings/rooms') &&
          method === 'GET'
        ) {
          const auth = await sessionOf();
          if (!auth) return redirectLogin();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (auth.user.mustChangePassword) return redirect(res, '/change-password');
          const notice = url.searchParams.get('saved') === 'ok' ? 'Room configuration saved and deployed.' : undefined;
          const html = await renderRoomsSetupPage(db, tenant, auth.session.csrfToken, notice, home);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (
          (path === '/setup/rooms' || path === '/settings/rooms' || path === '/console/settings/rooms') &&
          method === 'POST'
        ) {
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
          try {
            const wantsCreate = ['newRoomId', 'newRoomName', 'newRoomScope', 'newRoomAgent', 'newRoomMission'].some(
              (k) => (call.fields[k] ?? '').trim() !== '',
            );
            if (wantsCreate) {
              const { createCustomRoom } = await import('../talk/rooms.ts');
              const created = await createCustomRoom(
                db,
                tenant,
                {
                  id: String(call.fields.newRoomId ?? ''),
                  name: String(call.fields.newRoomName ?? ''),
                  scope: String(call.fields.newRoomScope ?? ''),
                  agentName: String(call.fields.newRoomAgent ?? ''),
                  mission: String(call.fields.newRoomMission ?? ''),
                },
                by(auth.user),
              );
              await auditConsole(db, tenant, by(auth.user), 'setup.rooms_create', `room:${created.scope}`, at);
              return redirect(res, '/setup/rooms?saved=ok');
            }
            await handleRoomsSetupPost(db, tenant, call.fields, by(auth.user));
            await auditConsole(db, tenant, by(auth.user), 'setup.rooms', `tenant:${tenant}`, at);
            return redirect(res, '/setup/rooms?saved=ok');
          } catch (e) {
            const html = await renderRoomsSetupPage(db, tenant, auth.session.csrfToken, (e as Error).message, home);
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
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
          const outboxRows = (await db
            .prepare(
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
          // FLOW-025: read-only trust gaps for every card (presentation
          // path only — never the evaluating describeCard).
          const compilerGaps: {
            cardId: string;
            intent: string;
            state: string;
            gaps: string[];
            evalRef: string | null;
          }[] = [];
          try {
            const cards = await comp.list(tenant, {});
            for (const card of cards.slice(0, 100)) {
              try {
                const described = await describeCardReadOnly(db, comp, tenant, card.id);
                compilerGaps.push({
                  cardId: card.id,
                  intent: card.intent,
                  state: card.state,
                  gaps: described.trustGaps,
                  evalRef: card.evalRef,
                });
              } catch {
                continue;
              }
            }
          } catch {
            // No cards or compiler unavailable — the section renders empty.
          }
          const q = url.searchParams.get('q') ?? undefined;
          const role = url.searchParams.get('role') ?? undefined;
          const status = url.searchParams.get('status') ?? undefined;
          const rawPage = Number(url.searchParams.get('page') ?? '1');
          const pageNum = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
          const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, undefined, {
            home,
            now: at,
            confirmations,
            stops,
            selfHalts,
            policy: { approverRole: approverMin, operatorMode },
            compilerGaps,
            filter: { q, role, status, page: pageNum },
          });
          // Chat-centric: Team lives inside Workspace shell
          const isAdmin = atLeast(auth.user.role, 'admin');
          const teamNav = renderConsoleNav(
            buildConsoleNav(home, {
              requests: true,
              claims: true,
              rooms: true,
              humanWork: true,
              settings: isAdmin,
              learning: isAdmin,
              audit: isAdmin,
              data: isAdmin,
              buzz: isAdmin,
            }),
            'team',
          );
          const teamCluster = renderAccountCluster(auth.user.email, auth.user.role, auth.session.csrfToken);
          const teamRooms = (await new ScopeHealthEvaluator(db, tenant, {}).evaluateAll()).map((h) => ({
            scope: h.scope,
            roomName: h.roomName,
            badge: h.badge,
            pending: h.pendingApprovals,
          }));
          const teamInner = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
          const shellWs = await import('./workspace-shell.ts');
          const teamMetrics = await shellWs.computeShellMetrics(db, tenant);
          const teamRecency = await shellWs.computeRoomRecency(
            db,
            tenant,
            teamRooms.map((r) => r.scope),
          );
          const teamShelled = renderWorkspaceShell({
            rooms: teamRooms,
            home,
            consoleNav: teamNav,
            accountCluster: teamCluster,
            innerHtml: teamInner,
            userEmail: auth.user.email,
            userRole: auth.user.role,
            tenant,
            metrics: teamMetrics,
            roomRecency: teamRecency,
          });
          const teamWithShell = html.slice(0, html.indexOf('<body>') + 6) + teamShelled + html.slice(html.indexOf('</body>'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(teamWithShell);
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
          const rawEmail = (call.fields.email ?? '').trim();
          const emailList = rawEmail
            .split(/[\r\n,;]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

          if (emailList.length <= 1) {
            try {
              const { invitation, token } = await createInvitation(
                db,
                tenant,
                {
                  email: emailList[0] ?? '',
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
                { home },
              );
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              res.end(html);
            } catch (e) {
              const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
              const attempted = (emailList[0] ?? '').toLowerCase();
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
                { home },
              );
              res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
              res.end(html);
            }
            return;
          }

          // Bulk onboarding for multiple addresses
          const invited: { email: string; token: string }[] = [];
          const failed: { email: string; error: string }[] = [];
          const targetRole = parseRole(call.fields.role ?? 'member');
          for (const email of emailList) {
            try {
              const { invitation, token } = await createInvitation(
                db,
                tenant,
                {
                  email,
                  name: call.fields.name
                    ? `${call.fields.name} (${email.split('@')[0]})`
                    : (email.split('@')[0] ?? 'Member'),
                  role: targetRole,
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
              invited.push({ email, token });
            } catch (e) {
              const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
              failed.push({ email, error: msg });
            }
          }

          const exposeInvite =
            process.env.VITAL_EXPOSE_INVITE_LINK === '1' && invited.length > 0
              ? ` Acceptance links: ${invited.map((i) => `${i.email}: /accept-invite?token=${encodeURIComponent(i.token)}`).join(' · ')}`
              : ' Deliver acceptance links out of band.';
          const failMsg =
            failed.length > 0
              ? ` (${failed.length} failed: ${failed.map((f) => `${f.email}: ${f.error}`).join(', ')})`
              : '';
          const statusMsg = `${invited.length} members invited as ${targetRole}.${failMsg}${exposeInvite}`;
          const currentInvites = await listInvitations(db, tenant, at);
          const html = teamPage(auth.session.csrfToken, auth.user, data.users, currentInvites, statusMsg, { home });
          res.writeHead(invited.length > 0 ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
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
              { home },
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
              { home },
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
              { home },
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
              { home },
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
          if (!(await recentAuthGate(db, res, auth.user.id, at))) return;
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
              { home },
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
              { home },
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
          if (!(await recentAuthGate(db, res, auth.user.id, at))) return;
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
              { home },
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
              { home },
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
          if (!(await recentAuthGate(db, res, auth.user.id, at))) return;
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
              { home },
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
              { home },
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
          if (!(await recentAuthGate(db, res, auth.user.id, at))) return;
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
              { home },
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
              { home },
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
              { home },
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
              { home },
            );
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
        }

        const act = path.match(/^\/api\/requests\/([^/]+)\/(approve|decline)$/);
        if (method === 'POST' && act) {
          const auth = await sessionOf();
          if (!auth) {
            // FLOW-010: an expired approval POST keeps the reviewer's
            // non-secret rationale for explicit resubmission — the approval
            // itself is never replayed (reauthResume contract).
            let draft: Record<string, string>;
            try {
              draft = expiredDraftCarry((await parseCall(req)).fields);
            } catch {
              draft = {};
            }
            return json(res, 401, sessionExpiredWithDraft(returnPath(), draft));
          }
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
            if (prefersHtml(req)) {
              return redirect(res, `/console/requests/${encodeURIComponent(id)}`);
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
          if (version.externalPublish) {
            const confirmText = String(call.fields.confirmText ?? '').trim();
            if (confirmText !== 'PUBLISH') {
              json(res, 400, { ok: false, error: 'type PUBLISH to confirm external publication' });
              return;
            }
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
            if (prefersHtml(req)) {
              return redirect(res, `/console/requests/${encodeURIComponent(version.requestId)}`);
            }
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
            if (prefersHtml(req)) {
              return redirect(res, `/console/requests/${encodeURIComponent(revised.requestId)}`);
            }
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
          // FLOW-023: readiness is the authenticated worker/integration
          // status. `database` is required; `worker` is required once a
          // worker has ever checked in (a silent worker is an outage) but
          // reports unconfigured-optional before the first heartbeat so
          // fresh installs stay green; `integrations` folds every known
          // collector in — unconfigured-optional when no source was ever
          // set up, failing when a configured source is broken.
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
                name: 'worker',
                // Optional until the first heartbeat: a fresh install with no
                // worker deployed stays green; a stale heartbeat still fails.
                optional: true,
                check: async () => workerReadiness(db, tenant, { now: at }),
              },
              {
                name: 'integrations',
                optional: true,
                check: async () => {
                  const config = await loadActivationConfig(db, tenant);
                  const collectors = new Set(await listKnownCollectors(db, tenant));
                  if (config) collectors.add(collectorName(config.sourcePath));
                  if (collectors.size === 0) return { ok: false, unconfigured: true, detail: 'no source configured' };
                  const parts: string[] = [];
                  let failing: string | null = null;
                  for (const collector of collectors) {
                    const health = await getIntegrationHealth(db, tenant, collector, {
                      configured: true,
                      now: at,
                    });
                    const projected = integrationReadinessState(health);
                    parts.push(projected.detail);
                    if (!projected.ok && projected.unconfigured !== true && !failing) failing = collector;
                  }
                  if (failing) return { ok: false, detail: parts.join(' | ') };
                  return { ok: true as const, detail: parts.join(' | ') };
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
          if (!auth) {
            // FLOW-010: expiry during a correction preserves the non-secret
            // draft (statement/reason, never passwords/secrets) so the human
            // can re-submit after signing in — approvals are never replayed.
            let draft: Record<string, string>;
            try {
              draft = expiredDraftCarry((await parseCall(req)).fields);
            } catch {
              draft = {};
            }
            return json(res, 401, sessionExpiredWithDraft(returnPath(), draft));
          }
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

        // Human curation: promote a CANDIDATE claim to VERIFIED so cited
        // work can proceed to approval. Only roles that may approve may
        // verify — verification is what makes evidence approvable.
        const verify = path.match(/^\/api\/claims\/([^/]+)\/verify$/);
        if (method === 'POST' && verify) {
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
          if (!atLeast(auth.user.role, approverMin))
            return json(res, 403, {
              ok: false,
              error: `verifying requires ${approverMin} (you are ${auth.user.role})`,
            });
          let id: string;
          try {
            id = decodeURIComponent(verify[1]!);
          } catch {
            json(res, 400, { ok: false, error: 'malformed claim id' });
            return;
          }
          const who = by(auth.user);
          const identity = keyAuth ? await verifyingKey(req, id, 'verify', who) : {};
          if (!identity) return json(res, 401, { ok: false, error: 'operator signature invalid' });
          try {
            const claim = await ledger.verifyClaim(tenant, id, who, at);
            await auditConsole(db, tenant, who, 'console.verify', `claim:${id}`, at);
            json(res, 200, {
              ok: true,
              id: claim.id,
              status: claim.status,
              ...(keyAuth ? { by: who, ...identity } : {}),
            });
          } catch (e) {
            if (e instanceof LedgerError && e.code === 'MISSING_CLAIM') {
              json(res, 404, { ok: false, error: (e as Error).message });
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

        // FLOW-004: browser receipt verification for erased tenants.
        // Admin or owner only: reads the surviving erased:<slug> receipt
        // (deleted/retained/deferred/failed) plus the export-file check.
        if (method === 'GET' && path === '/api/erasure/receipt') {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          if (!atLeast(auth.user.role, 'admin')) {
            json(res, 403, { ok: false, error: 'erasure receipt verification requires admin or owner' });
            return;
          }
          const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
          if (!slug) {
            json(res, 400, { ok: false, error: 'slug query parameter is required' });
            return;
          }
          const verification = await verifyErasureReceipt(db, slug);
          if (!verification.found) {
            json(res, 404, { ok: false, error: `no erasure receipt for "${slug}"` });
            return;
          }
          json(res, 200, { ok: true, ...verification });
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
        // FLOW-025: evaluation evidence for one card — trust gaps, eval
        // suite reference, recent runs, and the evidence-only disclaimer.
        // Read-only (describeCardReadOnly): linking evidence never promotes.
        // NOTE: registered before the generic card-detail route below, which
        // would otherwise swallow the /evidence suffix as a card id.
        const cardEvidenceMatch = path.match(/^\/api\/learning\/cards\/([^/]+)\/evidence$/);
        if (method === 'GET' && cardEvidenceMatch) {
          const auth = await sessionOf();
          if (!auth) return sessionExpiredApi();
          if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
          if (activationDenied(res, auth, true)) return;
          const cardId = decodeURIComponent(cardEvidenceMatch[1]!);
          try {
            const evidence = await cardEvaluationEvidence(db, comp, tenant, cardId);
            json(res, 200, { ok: true, ...evidence });
          } catch (e) {
            json(res, 404, { ok: false, error: (e as Error).message });
          }
          return;
        }

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

        // ------------------------------------------------------------ Buzz Webhook & APIs
        //
        // SECURITY: every route under /api/buzz is authenticated. These routes
        // previously had no gate at all, which meant an anonymous caller could
        // read tenant ledger content (`/canvas/:room`), rewrite room policy
        // (`/rooms/configure`), engage the scope kill switch
        // (`/commands` -> `setKill`) and approve a pending human-approval
        // request without a session or token (`/webhook?action=approve`).
        //
        // Two distinct callers are served, and they need different proof:
        //  - A human in the console: session + CSRF + admin role.
        //  - Buzz relay/room tooling: an HMAC-signed review token over the
        //    exact (tenant, request, action). There is no tokenless path.
        let buzzAdminUser: User | null = null;
        // The request body can only be read once. Parsing here and re-using the
        // result is what keeps the POST routes below from blocking forever on a
        // stream that has already ended.
        let buzzCall: Call | null = null;
        if (path === '/api/buzz' || path.startsWith('/api/buzz/')) {
          buzzCall = method === 'POST' ? await parseCall(req).catch(() => null) : null;
          const providedToken =
            method === 'POST'
              ? (buzzCall?.fields.token ?? (buzzCall?.json?.token as string | undefined))
              : url.searchParams.get('token');
          const buzzAuth = await sessionOf();
          const isAdmin = buzzAuth !== null && buzzAuth.user.tenant === tenant && atLeast(buzzAuth.user.role, 'admin');
          const signedTokenOk =
            typeof providedToken === 'string' && providedToken.length > 0 && reviewTokenValid(providedToken, tenant);
          if (!isAdmin && !signedTokenOk) {
            return json(res, 401, {
              ok: false,
              error: buzzAuth
                ? 'admin role required for Buzz room administration'
                : 'authentication required (session cookie or a signed review token)',
            });
          }
          // A session-based mutation still needs CSRF: the session alone is not
          // proof the request came from our own UI.
          if (isAdmin && method === 'POST' && buzzCall && !signedTokenOk && !csrfOk(buzzAuth!.session, buzzCall.csrf)) {
            return json(res, 403, { ok: false, error: 'bad CSRF token' });
          }
          if (isAdmin) {
            buzzAdminUser = buzzAuth!.user;
          }
        }
        if (path === '/api/buzz/webhook' && (method === 'POST' || method === 'GET')) {
          let action = url.searchParams.get('action');
          let token = url.searchParams.get('token');
          let requestId = url.searchParams.get('req');
          let forkedParams: any = {};
          let actor = buzzAdminUser ? by(buzzAdminUser) : 'buzz:token';

          if (method === 'POST' && buzzCall) {
            action = (buzzCall.fields.action ?? buzzCall.json?.action ?? token ?? action) as string;
            token = (buzzCall.fields.token ?? buzzCall.json?.token ?? token) as string;
            requestId = (buzzCall.fields.requestId ?? buzzCall.json?.requestId ?? requestId) as string;
            if (buzzCall.json?.forkedParams) forkedParams = buzzCall.json.forkedParams;
            if (buzzCall.fields.actor && buzzAdminUser) actor = by(buzzAdminUser);
          }

          // A signed token proves exactly one thing: someone legitimately minted
          // this (tenant, request, action). It never supplies an actor identity.
          if (token) {
            const secret = reviewSecretFromEnv();
            const verified = secret ? verifyReviewToken(token, secret) : { valid: false as const };
            if (verified.valid && verified.tenant === tenant) {
              action = verified.action ?? action;
              requestId = verified.requestId ?? requestId;
            } else if (!buzzAdminUser) {
              return json(res, 401, { ok: false, error: 'invalid or expired review token' });
            }
          }

          if (!requestId) {
            return json(res, 400, { ok: false, error: 'missing requestId or valid token' });
          }

          // GET is a confirmation step, never a mutation: a URL that approves
          // on fetch is prefetchable, CSRF-able and gets executed by link
          // scanners. A human (or Buzz) confirms with the form below.
          if (method === 'GET' && (action === 'approve' || action === 'decline')) {
            const verb = action === 'approve' ? 'Approve' : 'Decline';
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0A0F14;color:#F4F7F5;padding:40px;"><h2>${verb} request <code>${esc(requestId)}</code>?</h2><p style="color:#9FB0A9;">This request is waiting on a human. Confirming records the decision in the audit log.</p><form method="POST" action="/api/buzz/webhook"><input type="hidden" name="token" value="${esc(token ?? '')}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="requestId" value="${esc(requestId)}"><button type="submit" style="background:#10B981;color:#04120C;border:0;border-radius:6px;padding:12px 20px;font-size:15px;cursor:pointer;">${verb}</button></form><p><a href="${esc(home)}" style="color:#10B981;">Return to Mission Control</a></p></body></html>`,
            );
            return;
          }

          if (action === 'approve') {
            try {
              const current = await coord.get(tenant, requestId);
              if (!current) return json(res, 404, { ok: false, error: `unknown request ${requestId}` });
              if (current.state === 'ADMITTED') {
                await coord.accept(tenant, requestId);
                const decisionId = `dec_buzz_${createHash('sha256').update(requestId).digest('hex').slice(0, 12)}`;
                await ledger.recordDecision({
                  id: decisionId,
                  tenant,
                  goal: current.goal,
                  action: 'APPROVED via Buzz room review card',
                  actionClass: 'RECOMMEND',
                  claimIds: current.claimRefs,
                  decidedBy: actor,
                  approvedBy: actor,
                  scope: current.targetScope,
                  autonomy: 'approval',
                });
                await auditConsole(db, tenant, actor, 'buzz.approve', `request:${requestId}`, at);
              }
              return json(res, 200, { ok: true, action: 'approve', requestId, status: 'ACCEPTED' });
            } catch (e) {
              return json(res, 409, { ok: false, error: (e as Error).message });
            }
          }

          if (action === 'decline') {
            try {
              const current = await coord.get(tenant, requestId);
              if (!current) return json(res, 404, { ok: false, error: `unknown request ${requestId}` });
              if (current.state === 'ADMITTED') {
                await coord.decline(tenant, requestId, 'Declined via Buzz review card');
                await auditConsole(db, tenant, actor, 'buzz.decline', `request:${requestId}`, at);
              }
              return json(res, 200, { ok: true, action: 'decline', requestId, status: 'DECLINED' });
            } catch (e) {
              return json(res, 409, { ok: false, error: (e as Error).message });
            }
          }

          if (action === 'fork') {
            try {
              const engine = new TimeTravelForkEngine(db, ledger, coord);
              const diff = await engine.forkRun(tenant, { requestId }, forkedParams);
              await auditConsole(db, tenant, actor, 'buzz.fork', `request:${requestId}`, at);
              return json(res, 200, { ok: true, action: 'fork', diff });
            } catch (e) {
              return json(res, 409, { ok: false, error: (e as Error).message });
            }
          }

          return json(res, 400, { ok: false, error: `unsupported action "${action}"` });
        }

        // GET /api/buzz/rooms: list all 12 rooms with config, health status and live gas gauge
        if (path === '/api/buzz/rooms' && method === 'GET') {
          const evaluator = new ScopeHealthEvaluator(db, tenant, { coord, compiler: comp, ledger });
          const gaugeTracker = new RoomBudgetTracker(db, tenant);
          const allHealth = await evaluator.evaluateAll();
          const rooms = [];
          for (const h of allHealth) {
            const cfg = await loadRoomConfig(db, tenant, h.scope);
            const gauge = await gaugeTracker.computeGauge(h.scope);
            rooms.push({ ...h, config: cfg, gauge });
          }
          return json(res, 200, { ok: true, rooms });
        }

        // POST /api/buzz/rooms/configure: configure a room
        if (path === '/api/buzz/rooms/configure' && method === 'POST') {
          if (!buzzCall) return json(res, 400, { ok: false, error: 'empty request body' });
          const call = buzzCall;
          const scope = String(call.fields.scope ?? call.json?.scope ?? '').trim();
          if (!scope) return json(res, 400, { ok: false, error: 'scope is required' });
          const updates: any = {};
          const body = call.json ?? call.fields;
          if (body.mission) updates.mission = body.mission;
          if (body.autonomy) updates.autonomy = body.autonomy;
          if (body.budgetCeilingDollars) updates.budgetCeilingDollars = Number(body.budgetCeilingDollars);
          if (body.budgetCeilingTokens) updates.budgetCeilingTokens = Number(body.budgetCeilingTokens);
          if (body.active !== undefined) updates.active = Boolean(body.active);
          const saved = await saveRoomConfig(db, tenant, { scope, ...updates }, 'api');
          return json(res, 200, { ok: true, config: saved });
        }

        // GET /api/buzz/canvas/:room: return live canvas markdown
        const canvasMatch = path.match(/^\/api\/buzz\/canvas\/([^/]+)$/);
        if (method === 'GET' && canvasMatch) {
          const scope = decodeURIComponent(canvasMatch[1]!);
          const canvasSync = new LiveCanvasSynchronizer({ db, tenant, compiler: comp, ledger });
          const canvas = await canvasSync.generateCanvas(scope);
          return json(res, 200, { ok: true, canvas });
        }

        // GET /api/buzz/huddle/audio: returns 60s morning voice briefing audio WAV
        if (path === '/api/buzz/huddle/audio' && method === 'GET') {
          const huddleSynth = new AmbientMorningBriefingSynthesizer(db, tenant);
          let briefing = await huddleSynth.getLatestBriefing();
          if (!briefing) {
            briefing = await huddleSynth.synthesizeBriefing({ durationSeconds: 60 });
          }
          const audioBuffer = Buffer.from(briefing.audioWavBase64, 'base64');
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': audioBuffer.length,
            'cache-control': 'public, max-age=3600',
          });
          res.end(audioBuffer);
          return;
        }

        // POST /api/buzz/commands: execute in-room slash command
        if (path === '/api/buzz/commands' && method === 'POST') {
          if (!buzzCall) return json(res, 400, { ok: false, error: 'empty request body' });
          const call = buzzCall;
          const command = String(call.fields.command ?? call.json?.command ?? '').trim();
          const roomScope = String(call.fields.scope ?? call.json?.scope ?? 'core');
          const actor = String(call.fields.actor ?? call.json?.actor ?? 'operator');
          const evaluator = new ScopeHealthEvaluator(db, tenant, { coord, compiler: comp, ledger });
          const result = await executeRoomCommand(command, {
            db,
            tenant,
            actor,
            currentScope: roomScope,
            coord,
            ledger,
            evaluator,
          });
          return json(res, 200, { ok: true, result });
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
        const boundHost = addr.address;
        const boundPort = addr.port;
        resolve({
          host: boundHost,
          port: boundPort,
          address: boundAddress,
          ready: () =>
            new Promise((resoleReady) => {
              const loopbackHost = publicBind || boundHost === '0.0.0.0' || boundHost === '::' ? '127.0.0.1' : boundHost;
              const probeUrl = `http://${loopbackHost}:${boundPort}/healthz`;
              const probe = new URL(probeUrl);
              const req = httpRequest(probe);
              const timer = setTimeout(() => {
                req.destroy();
                resoleReady({ ok: false, status: 'failed', detail: 'readiness probe timed out — console not answering yet' });
              }, 2000);
              req.once('response', (resP: IncomingMessage & { resume?: () => void }) => {
                clearTimeout(timer);
                const status = resP.statusCode ?? 500;
                resP.resume();
                if (status === 200) {
                  resoleReady({
                    ok: true,
                    status: 'ready',
                    detail: `console answers on ${boundAddress} (healthz ${status})`,
                  });
                } else {
                  resoleReady({
                    ok: false,
                    status: 'blocked',
                    detail: `console bound on ${boundAddress} but healthz returned ${status}`,
                  });
                }
              });
              req.once('error', () => {
                clearTimeout(timer);
                resoleReady({ ok: false, status: 'failed', detail: 'readiness probe could not reach the console' });
              });
              req.end();
            }),
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
