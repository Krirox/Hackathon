import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve as resolvePath, sep as pathSep } from 'node:path';
import type { Socket } from 'node:net';
import { withStatementCount, type AsyncDb } from '../core/db.ts';
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
  disableConfirmations,
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
  setUserTeam,
  signupTenant,
  tenantAccessState,
  tryPasswordReset,
  atLeast,
  assertAccountActivated,
  grantableRoles,
  isEngineer,
  parseRole,
  parseTeam,
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
  checkMfaLockout,
  recordMfaFailure,
  clearMfaFailures,
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
import { REQUEST_STATES } from '../core/types.ts';
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
import {
  DEFAULT_THEME,
  THEME_TOGGLE_MARKER,
  THEME_TOGGLE_SCRIPT,
  themeDocument,
  themeHead,
  themeToggleButton,
} from './theme.ts';
import { renderReview } from './review.ts';
import { renderLearningPage, renderLearningCardPage } from './learning.ts';
// `renderAuditPage` / `renderDataPage` moved with their routes (routes/compliance.ts):
// the pages are rendered there, so this module no longer imports them.
import { renderErasureReceiptPage } from './data.ts';
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
import { buildTenantJourney, renderJourneyMilestone } from './journey.ts';
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
// Route table: declared capability per route, enforced in one place below.
import { capabilityAllows, matchRoute, validateRoutes, type AuthContext, type RouteDef } from './routes/registry.ts';
import { observabilityRoutes, type ObservabilityEnv } from './routes/observability.ts';
import { complianceRoutes, type ComplianceEnv } from './routes/compliance.ts';
import { requestsRoutes, type RequestsEnv } from './routes/requests.ts';
import { listsRoutes, type ListsEnv } from './routes/lists.ts';
import { agentTasksRoutes, type AgentTasksEnv } from './routes/agent-tasks.ts';
import { learningRoutes, type LearningEnv } from './routes/learning.ts';
import { reviewRoutes, type ReviewEnv } from './routes/review.ts';
import { issuesRoutes, type IssuesEnv } from './routes/issues.ts';
import { createRequestStats, memo as memoize, withRequestCache } from '../core/request-cache.ts';
// `shellMetrics as shellMetricsFor`: the page branches below keep local
// `shellMetrics` / `teamMetrics` bindings, and shadowing the import there would
// make it easy to call the unmemoized path by accident.
import { roomHealth, roomRecency, shellMetrics as shellMetricsFor } from './shell-reads.ts';
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
  describeExecutorHealth,
  describeStops,
  haltEffects,
  listHaltEvidence,
  liveness,
  readWorkerHeartbeat,
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
import { renderConsoleShell } from './console-shell.ts';
import {
  getGitHubPushError,
  getGitHubSyncConfig,
  listIssues,
  markGitHubSyncError,
  parseGitHubRepoPath,
  authorizeGitHubRepo,
  saveGitHubSyncConfig,
  syncGitHubProject,
  unlinkGitHubSyncConfig,
} from './issues.ts';
import { maybeBuzzSurface } from '../talk/buzz-runtime.ts';
import {
  CANONICAL_ROOMS,
  normalizeScope,
  saveRoomConfig,
  loadTenantRooms,
  ROOM_BUDGET_MAX_DOLLARS,
  ROOM_BUDGET_MAX_TOKENS,
} from '../talk/rooms.ts';
import { renderCompilerView, renderCompilerParts } from './compiler-view.ts';
import { renderOperationsDashboard } from './operations-dashboard.ts';
import { ScopeHealthEvaluator } from '../talk/health.ts';
import { executeRoomCommand } from '../talk/commands.ts';
import { TimeTravelForkEngine } from '../talk/fork.ts';
import { AmbientMorningBriefingSynthesizer } from '../talk/huddle.ts';
import { RoomBudgetTracker } from '../talk/budget-gauge.ts';
import { LiveCanvasSynchronizer } from '../talk/canvas.ts';
import { type DashboardDepartment } from './dashboard-views.ts';
import { MeetingService } from '../meetings/service.ts';
import type { MeetingPipelineOptions } from '../meetings/pipeline.ts';
import { WhisperSttProvider } from '../meetings/stt.ts';
import { MeetingSignalingHub, createWebSocketUpgradeHandler } from '../meetings/signaling.ts';
import {
  renderMeetingRoomView,
  renderMeetingDetailView,
  renderMeetingLibraryView,
  meetingRoomAsset,
  meetingIceServers,
} from './meetings.ts';
import { listTranscriptSegments } from '../meetings/db.ts';

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
  /**
   * Outbound HTTP for GitHub board sync, injected so tests can stub the network
   * instead of calling api.github.com. Defaults to the global `fetch`.
   */
  fetchFn?: typeof fetch;
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

function readRawBody(req: IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('[console:BODY_TOO_LARGE] body exceeds cap'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

/**
 * Extracts the *content* a page contributes to the workspace shell: the
 * page's own <main> is unwrapped (the shell renders the single
 * `<main id="main">` landmark) and its skip link is dropped for the same
 * reason. Scripts are preserved — they are page behaviour, not layout.
 *
 * A `page()`-built utility document also carries chrome the shell already
 * provides: the `.utility-wrap` container, the `.utility-bar` theme-toggle
 * pill, and its own theme-toggle script (the shell ships one too, and the
 * script is re-entrancy-guarded, but two copies is still two copies).
 * All three are stripped here so the shell owns the chrome.
 */
function workspaceInnerHtml(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return (
    body
      // A standalone `page()` utility document wraps its content in a centered
      // `.utility-wrap` column and a right-aligned `.utility-bar` carrying a
      // private theme toggle. When such a body is extracted to be re-shelled
      // (Team, and any console page rendered through `page()`), that chrome must
      // not survive: the Console shell already owns the search field, theme
      // toggle and full-width surface. Left in, it leaks a second "Dark" pill
      // into the page and clamps the content to an 880px column — the shell's
      // `html,body{max-width:none}` cannot reach a div. Unwrap the column and
      // drop the bar, keeping only the page's <main> (stripped below).
      .replace(
        /<div class="utility-wrap">\s*(?:<div class="utility-bar">[\s\S]*?<\/div>)?\s*(<main\b[\s\S]*?<\/main>)\s*<\/div>/i,
        '$1',
      )
      .replace(/<a\b[^>]*class="skip-link"[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<\/?main\b[^>]*>/gi, '')
      // detailDocument's "Back to console" anchor is kept: it is the only link to
      // the console root that the shell-agnostic tests pin, and a shelled page is
      // still reachable with the rail hidden.
      .trim()
  );
}

/**
 * The utility `<style>` block `page()` writes into its `<head>` uses bare
 * element selectors (`form`, `input`, `button`, `label`). When a `page()`
 * document is merged into the Console shell, those rules reach the shell's
 * own `.ws-search` / `.ws-topbar-search` forms and repaint them as cards —
 * the sidebar placeholder drops below the icon, the topbar field grows to
 * 24px padding, and the theme pill appears twice. The block is identified
 * by its marker comment and stripped from the merged head. Standalone
 * `page()` output (login, signup, error) never goes through this path, so
 * its utility styling is preserved.
 */
function stripUtilityPageStyles(head: string): string {
  return head.replace(
    /<style>\s*\/\*\s*Compact utility surface:[\s\S]*?<\/style>/i,
    '',
  );
}

async function wrapInWorkspaceShell(
  html: string,
  db: import('../core/db.ts').AsyncDb,
  tenant: string,
  home: string,
  auth: { user: import('../core/auth.ts').User; session: { csrfToken: string } },
  // Wider than NavKey on purpose: NavKey covers the legacy console nav, while
  // the shell also names pages that nav never had (compiler). The only consumer
  // that needs a real NavKey is renderConsoleNav, cast there.
  navKey?: string,
  activeScope?: string | null,
  isDrawer?: boolean,
): Promise<string> {
  // The Workspace/chat pages render the Buzz shell (workspace-shell.ts) and
  // keep upstream Buzz's own document, fonts and palette; the Console pages
  // render the redesigned Console shell. Chat is identified by its nav key, the
  // only place the two families differ. This split is deliberate — restyling
  // the Console must never re-skin the chat.
  const isChat = navKey === 'buzz';
  // Buzz keeps upstream's exact body slice: the shell owns a #main landmark and
  // the chat document already supplies one, so nothing is stripped.
  const chatInnerHtml = html.includes('<body>')
    ? html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    : html;
  const innerHtml = isChat ? chatInnerHtml : workspaceInnerHtml(html);
  if (isDrawer) {
    return innerHtml;
  }
  const roomsWithCategory = (await roomHealth(db, tenant)).map((h) => ({
    scope: h.scope,
    roomName: h.roomName,
    badge: h.badge,
    pending: h.pendingApprovals,
    category: h.category,
  }));
  const isAdmin = (await import('../core/auth.ts')).atLeast(auth.user.role, 'admin');
  const avail: Record<string, boolean> = {
    requests: true,
    claims: true,
    rooms: true,
    humanWork: true,
    buzz: isAdmin,
    settings: isAdmin,
    learning: isAdmin,
    audit: isAdmin,
    data: isAdmin,
  };
  const nav = (await import('./render.ts')).renderConsoleNav(
    (await import('./render.ts')).buildConsoleNav(home, avail),
    navKey as import('./render.ts').NavKey | undefined,
  );
  const cluster = (await import('./render.ts')).renderAccountCluster(
    auth.user.email,
    auth.user.role,
    auth.session.csrfToken,
  );
  const shellMetrics = await shellMetricsFor(db, tenant);
  const shellRecency = await roomRecency(
    db,
    tenant,
    roomsWithCategory.map((r) => r.scope),
  );
  if (isChat) {
    // Byte-for-byte upstream Buzz: the chat document's own <head> (system font
    // stack, Buzz palette) is preserved and nothing is theme-injected, so the
    // Workspace looks exactly like Buzz. Adding the Console token block here
    // would re-font the chat and repaint its canvas, which is why it is not
    // applied on this path.
    const shell = renderWorkspaceShell({
      rooms: roomsWithCategory.map(({ category: _category, ...room }) => room),
      activeScope,
      home,
      consoleNav: nav,
      accountCluster: cluster,
      innerHtml,
      userEmail: auth.user.email,
      userRole: auth.user.role,
      userTeam: auth.user.team,
      tenant,
      metrics: shellMetrics,
      roomRecency: shellRecency,
    });
    return html.slice(0, html.indexOf('<body>') + 6) + shell + html.slice(html.indexOf('</body>'));
  }

  const shell = renderConsoleShell({
    rooms: roomsWithCategory,
    activeScope,
    navKey,
    home,
    consoleNav: nav,
    accountCluster: cluster,
    innerHtml,
    userEmail: auth.user.email,
    userRole: auth.user.role,
    userTeam: auth.user.team,
    tenant,
    metrics: shellMetrics,
    roomRecency: shellRecency,
  });
  // Extract the page's own <head> contents only when it IS a full document.
  // Some callers (the meetings library) hand this function a bare body
  // fragment; the old `replace`-to-slice approach left the whole fragment in
  // `head` when no `<head>` tags were present, so the browser hoisted that
  // stray content out of `<head>` and rendered the page a second time above
  // the shell (unscrollable, theme-less). An empty capture means "no head to
  // carry" and the fragment now appears exactly once, inside the shell.
  const head = stripUtilityPageStyles(/<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '');
  const openBody = /<body[^>]*>/i.exec(html)?.[0] ?? '<body>';
  return themeDocument(
    `<!doctype html><html lang="en" data-theme="${DEFAULT_THEME}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head>${openBody}${shell}</body></html>`,
  );
}

/**
 * Standalone compact document: auth, recovery, MFA and utility pages that
 * render before a workspace session exists. Uses the shared design system
 * (theme.ts) rather than a private copy of the tokens, so a token change
 * lands everywhere at once.
 */
function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en" data-theme="${DEFAULT_THEME}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
${themeHead()}
<style>
/* Compact utility surface: one readable column, no rail, generous paper. */
body{margin:0;padding:28px 20px 56px}
.utility-wrap{max-width:880px;margin:0 auto}
.utility-bar{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-bottom:18px}
h1{font-size:clamp(22px,3vw,28px);font-weight:700;letter-spacing:-0.025em;margin:0 0 14px;color:var(--v-ink)}
h2{font-size:16px;font-weight:650;letter-spacing:-0.015em;margin:24px 0 10px;color:var(--v-ink)}
a{color:var(--v-accent);text-decoration:none}a:hover{text-decoration:underline}
form:not([style*="display:inline"]){max-width:400px;display:grid;gap:12px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:var(--radius-card);padding:24px;box-shadow:var(--v-card-shadow)}
form[style*="display:inline"]{display:inline!important;border:none!important;padding:0!important;background:none!important;box-shadow:none!important}
input,textarea,select{padding:10px 12px;border:1px solid var(--v-line-strong);border-radius:var(--radius-input);font-family:inherit;font-size:14px;color:var(--v-ink);background:var(--v-input-bg);transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{border-color:var(--v-accent);box-shadow:0 0 0 3px var(--v-accent-dim);outline:none}
label{font-size:13px;font-weight:500;color:var(--v-muted);display:grid;gap:4px}
button{padding:10px 18px;border:0;border-radius:var(--radius-md);background:var(--v-accent);color:var(--v-accent-ink);font-weight:600;cursor:pointer;min-height:44px;font-family:inherit;font-size:14px;transition:filter .15s ease,transform .1s ease}
button:hover{filter:brightness(1.08)}
button:active{transform:translateY(1px)}
button:disabled{opacity:0.6;cursor:not-allowed}
.card{border:1px solid var(--v-line);border-radius:var(--radius-card);padding:20px 22px;background:var(--v-bg-1);box-shadow:var(--v-card-shadow);margin-bottom:16px}
.err{color:var(--v-risk);font-size:13px}.sub{color:var(--v-muted);font-size:13px;line-height:1.5}
.error-summary{border:1px solid var(--v-line);border-left:3px solid var(--v-risk);border-radius:var(--radius-md);padding:14px 16px;margin:12px 0;background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink)}
.success{border:1px solid var(--v-line);border-left:3px solid var(--v-fact);border-radius:var(--radius-md);padding:14px 16px;margin:12px 0;background:var(--v-tint-good-bg);color:var(--v-tint-good-ink)}
a.skip-link{position:absolute;left:-9999px;top:0;background:var(--v-accent);color:var(--v-accent-ink);padding:8px 14px;z-index:100;border-radius:0 0 6px 0;font-size:13px;font-weight:500}a.skip-link:focus{left:0}
.table-wrap{overflow-x:auto;max-width:100%}
table.stacked thead{}
@media (max-width:640px){body{padding:16px}form{max-width:100%}input,textarea,select,button{min-height:44px}}
@media (max-width:600px){table.stacked thead{display:none}table.stacked tr{display:block;border:1px solid var(--v-line);border-radius:var(--radius-sm);margin-bottom:8px}table.stacked td{display:block;border:0}}
</style>
</head><body><a class="skip-link" href="#main">Skip to main content</a><div class="utility-wrap"><div class="utility-bar">${themeToggleButton()}</div><main id="main">${body}</main></div><script ${THEME_TOGGLE_MARKER}>${THEME_TOGGLE_SCRIPT}</script></body></html>`;
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
async function recentAuthGate(
  db: AsyncDb,
  res: ServerResponse,
  userId: string,
  at: string,
  presentingSessionCreatedAt?: string,
): Promise<boolean> {
  try {
    await assertRecentAuthForSensitiveOp(db, userId, at, undefined, presentingSessionCreatedAt);
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

/*
 * There is no mailer, and there is deliberately no "is a mailer configured"
 * probe any more.
 *
 * `hasMailerConfigured()` returned true when `SMTP_URL` or
 * `VITAL_MAILER_ENABLED=1` was set, and the auth pages used it to relabel
 * themselves as transactional: "a password reset link has been sent to your
 * inbox", "Send verification link". Nothing in `src/` sends mail — there is no
 * SMTP client, no SES call, no `sendMail` — so setting the variable did not
 * enable a mailer, it switched a working honest flow ("ask your operator") into a
 * false promise on the one journey an enterprise probes first: account recovery.
 *
 * The honest copy below is what the product actually does, and it is the only
 * copy now. When a sender ships, it should return its own copy at that point —
 * gated on a sender that exists rather than on a variable a deployment sets.
 */

function forgotPasswordPage(csrf: string, opts: { error?: string; notice?: string; next?: string } = {}): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : '';
  const mailerNote = `<div class="card" style="background:var(--v-bg-2);margin:12px 0 16px 0;padding:14px 16px;">
<p class="sub" style="margin:0 0 6px 0;font-weight:600;color:var(--v-ink);">Operator-assisted password recovery</p>
<p class="sub" style="margin:0;">Transactional outbound email is not configured for this self-hosted installation. Submitting this form records an audited reset token in the ledger.</p>
<p class="sub" style="margin:6px 0 0 0;color:var(--v-muted);"><strong>Next steps:</strong> Ask your system operator to deliver your link using <code>vital reset-link</code>, or contact your team owner. <strong>Expected turnaround:</strong> typically under 1 hour during business hours.</p>
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
  <button type="submit">Request operator reset link</button>
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
  const initials = user.email.slice(0, 2).toUpperCase();
  const displayName = (user.email.split('@')[0] ?? user.email).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const nav = accountNav('account')
    .map((item) => {
      if (item.active) {
        return `<span class="v-badge v-badge-good" aria-current="page">${esc(item.label)}</span>`;
      }
      return `<a href="${esc(item.href)}" class="v-btn v-btn-ghost v-btn-sm">${esc(item.label)}</a>`;
    })
    .join('');

  // --- Email verification status badge + action ---
  const emailStatus = ((): string => {
    if (extra.emailVerified === undefined) return '';
    if (extra.emailVerified) {
      return `<div style="display:flex;align-items:center;gap:10px;margin-top:6px;"><span class="v-badge v-badge-good"><span class="dot"></span>Email verified</span><span class="v-meta">This address may be used for recovery.</span></div>`;
    }
    const badge = `<span class="v-badge v-badge-warn"><span class="dot"></span>Email not yet verified</span>`;
    const action = `<form method="post" action="/account/email/request" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-sm v-btn-secondary" style="min-height:auto;">Request operator verification</button></form>`;
    const hint = `Automatic email delivery is not configured on this host. Ask your system operator to generate your verification link with <code class="v-mono" style="font-size:12px;background:var(--v-bg-2);padding:2px 6px;border-radius:4px;">vital verify-link --tenant ${esc(user.tenant)} --email ${esc(user.email)}</code> (turnaround: typically same-day).`;
    return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;">${badge}${action}</div>
<p class="v-meta" style="margin-top:6px;">${hint}</p>`;
  })();

  // --- Two-factor authentication section ---
  const mfaSection = ((): string => {
    if (extra.mfaHint) return `<p class="v-sub" style="margin:0 0 16px;">${esc(extra.mfaHint)}</p>`;
    if (!extra.mfa) return '';
    if (extra.mfa.enabled) {
      const factorList = extra.mfa.factors
        .map(
          (f) =>
            `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--v-line)">
  <div style="display:flex;align-items:center;gap:10px;">
    <span class="v-badge v-badge-good" style="font-size:11px;"><span class="dot"></span>${esc(f.kind.toUpperCase())}</span>
    <span class="v-meta">Added ${esc(new Date(f.verifiedAt).toLocaleDateString())}${f.lastUsedAt ? ` · Last used ${esc(new Date(f.lastUsedAt).toLocaleDateString())}` : ''}</span>
  </div>
  <form method="post" action="/account/mfa/remove"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="factorId" value="${esc(f.id)}"><button type="submit" class="v-btn v-btn-sm v-btn-ghost" style="color:var(--v-risk);">Remove</button></form>
</div>`,
        )
        .join('');
      return `<div class="v-stack-sm">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
    <span class="v-badge v-badge-good"><span class="dot"></span>Enabled</span>
    <span class="v-meta">${extra.mfa.factors.length} factor(s) · ${extra.mfa.recoveryCount} unused recovery code(s)</span>
  </div>
  ${factorList}
  <form method="post" action="/account/mfa/recovery" style="margin-top:12px;"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-sm v-btn-secondary">Regenerate recovery codes</button></form>
</div>`;
    }
    return `<div style="display:flex;align-items:flex-start;gap:14px;">
  <div style="width:40px;height:40px;border-radius:var(--radius-md);background:var(--v-bg-2);display:grid;place-items:center;flex-shrink:0;">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--v-muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  </div>
  <div>
    <p class="v-sub" style="margin:0 0 10px;">Not enabled. Add an authenticator app so a stolen password alone cannot sign in.</p>
    <a href="/account/mfa/setup" class="v-btn v-btn-primary v-btn-sm">Set up two-factor authentication</a>
  </div>
</div>`;
  })();

  // --- Change password form ---
  const passwordForm = `<form method="post" action="/account/password" style="display:grid;gap:14px;max-width:420px;">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <div style="display:grid;gap:5px;">
    <label for="password" style="font-size:13px;font-weight:600;color:var(--v-ink-2);">New password</label>
    <input id="password" name="password" type="password" class="v-input" autocomplete="new-password" required minlength="12" placeholder="Minimum 12 characters">
    <span class="v-meta">${esc(result.sessionNote)} — ${esc(result.nextStep)}</span>
  </div>
  <button type="submit" class="v-btn v-btn-primary" style="justify-self:start;">Save new password</button>
</form>`;

  // --- Sessions / sign-out ---
  const sessionsSection = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
  <p class="v-sub" style="margin:0;">Signing out ends this session. Other devices remain signed in until their session expires.</p>
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="v-btn v-btn-sm v-btn-secondary" style="color:var(--v-risk);border-color:var(--v-tint-risk-bg);">Sign out</button></form>
</div>`;

  return page(
    'Vital Console — account and security',
    `<div class="v-stack" style="max-width:720px;">

  <!-- Page header -->
  <div>
    <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;margin:0 0 4px;color:var(--v-ink);">Account and security</h1>
    <p class="v-sub" style="margin:0;">Manage your identity, credentials, and session settings.</p>
  </div>

  ${notice ? `<div class="success" style="margin:0;">${esc(notice)}</div>` : ''}
  ${error ? `<div class="error-summary" style="margin:0;">${esc(error)}</div>` : ''}

  <!-- Identity card -->
  <div class="v-card">
    <div class="v-card-head">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:44px;height:44px;border-radius:50%;background:var(--v-accent);color:var(--v-accent-ink);display:grid;place-items:center;font-size:15px;font-weight:700;flex-shrink:0;">${esc(initials)}</div>
        <div>
          <div style="font-size:15px;font-weight:650;color:var(--v-ink);">${esc(displayName)}</div>
          <div class="v-meta">${esc(user.email)}</div>
        </div>
      </div>
      <span class="v-badge">${esc(user.role)}</span>
    </div>
    ${emailStatus}
  </div>

  <!-- Two-factor authentication -->
  <div class="v-card">
    <div class="v-card-head">
      <div>
        <h2 class="v-card-title">Two-factor authentication</h2>
        <p class="v-meta" style="margin:2px 0 0;">Protect your account with a second verification step.</p>
      </div>
    </div>
    ${mfaSection}
  </div>

  <!-- Change password -->
  <div class="v-card">
    <div class="v-card-head">
      <div>
        <h2 class="v-card-title">Change password</h2>
        <p class="v-meta" style="margin:2px 0 0;">Updating your password signs out all other active sessions.</p>
      </div>
    </div>
    ${passwordForm}
  </div>

  <!-- Sessions -->
  <div class="v-card">
    <div class="v-card-head">
      <div>
        <h2 class="v-card-title">Sessions</h2>
        <p class="v-meta" style="margin:2px 0 0;">Active sign-in on this device.</p>
      </div>
    </div>
    ${sessionsSection}
  </div>

  <!-- Footer nav -->
  <div style="display:flex;align-items:center;gap:8px;padding-top:8px;flex-wrap:wrap;">
    <a href="${esc(homeRef)}" class="v-btn v-btn-ghost v-btn-sm">&larr; Back to console</a>
    <span style="color:var(--v-faint);">/</span>
    ${nav}
  </div>

</div>`,
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

/**
 * The `question` field of a RAG request, from whichever shape arrived.
 *
 * Two content types reach this endpoint — a JSON body from the room's fetch
 * calls and a urlencoded form from the no-JS path. `JSON.parse` on a form body
 * throws, and swallowing that with an empty string would answer "question
 * required" to a caller who did send one. The form is the fallback, not the
 * default.
 */
function readQuestion(raw: string): string {
  try {
    return (JSON.parse(raw) as { question?: string }).question ?? '';
  } catch {
    return new URLSearchParams(raw).get('question') ?? '';
  }
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
  <summary style="cursor:pointer;color:var(--v-muted)">Disable</summary>
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
    <button type="submit" class="v-btn v-btn-secondary" style="min-height:auto;">Disable member</button>
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

const TEAM_OPTIONS = ['unassigned', 'engineering', 'marketing', 'finance', 'legal', 'support', 'operations'] as const;

/** Department picker (admins/owners): which team the member belongs to. */
function teamForm(csrf: string, viewer: User, u: User): string {
  if (!atLeast(viewer.role, 'admin') || viewer.mustChangePassword) return `<span class="sub">${esc(u.team)}</span>`;
  const options = TEAM_OPTIONS.map((t) => `<option value="${t}"${t === u.team ? ' selected' : ''}>${t}</option>`).join(
    '',
  );
  return `<form method="post" action="/team/team" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="userId" value="${esc(u.id)}">
    <select name="team" onchange="this.form.submit()" aria-label="Team for ${esc(u.email)}">${options}</select>
  </form>`;
}

/**
 * The acceptance link, rendered to the admin who just issued it.
 *
 * Only `sha256(token)` is stored (core/auth.ts), and this build has no mailer
 * (there is no sender in `src/` — see the note above `forgotPasswordPage`), so this
 * response is the *only* place the plaintext token ever exists. Gating it behind
 * `VITAL_EXPOSE_INVITE_LINK` therefore protected nothing and broke the feature:
 * the operator was told to "deliver the acceptance link out of band" while the
 * link was deliberately withheld, so an invited person could never accept.
 *
 * It is shown once, in the issuing admin's own authenticated response, with the
 * delivery expectation stated. If a mailer ever ships, this becomes the
 * fallback rather than the only path.
 */
/**
 * Meeting pipeline providers, chosen from the environment — or not chosen at all.
 *
 * Empty means "nothing configured", which the pipeline treats as a refusal. The
 * console used to construct `new MeetingService(db)` with no options, so every
 * deployment ran the mock speech-to-text provider and stored its canned script as
 * the transcript of real meetings.
 */
function meetingPipelineOptions(env: NodeJS.ProcessEnv = process.env): MeetingPipelineOptions {
  const apiKey = env.OPENAI_API_KEY?.trim();
  // Whisper is the only speech-to-text implementation here that reaches a real
  // service; it serves live chunk transcription (meetings/stt.ts).
  return apiKey ? { sttProvider: new WhisperSttProvider(apiKey) } : {};
}

function inviteLinkNotice(links: { email: string; link: string }[]): string {
  if (links.length === 0) return '';
  const shown = links.map((l) => (links.length === 1 ? l.link : `${l.email}: ${l.link}`)).join(' · ');
  return ` Acceptance link${links.length === 1 ? '' : 's'} (shown once — deliver securely): ${shown}`;
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
    filter?: {
      q?: string;
      role?: string;
      status?: string;
      team?: string;
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
      <button type="submit" class="v-btn v-btn-sm v-btn-ghost">Revoke</button>
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
  const teamFilter = (extra?.filter?.team ?? '').trim().toLowerCase();

  let filteredUsers = users;
  if (q) {
    filteredUsers = filteredUsers.filter((u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  }
  if (roleFilter) {
    filteredUsers = filteredUsers.filter((u) => u.role.toLowerCase() === roleFilter);
  }
  if (teamFilter) {
    filteredUsers = filteredUsers.filter((u) => u.team.toLowerCase() === teamFilter);
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
      if (!u.disabled) actions.push(teamForm(csrf, viewer, u));
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
  <td>${esc(u.team)}</td>
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
  <select name="team" style="padding:8px 10px;font-size:13px">
    <option value="">All teams</option>
    ${TEAM_OPTIONS.map((t) => `<option value="${t}"${teamFilter === t ? 'selected' : ''}>${t}</option>`).join('')}
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
${teamTabs('members')}
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
<h2>${membersHeading}</h2>
${filterForm}
<table style="border-collapse:collapse;min-width:640px">
  <thead><tr class="sub"><th align="left">email</th><th align="left">name</th><th align="left">role</th><th align="left">team</th><th align="left">status</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="sub">No matching team members found.</td></tr>'}</tbody>
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
  <label class="sub" for="team">team (department)</label>
  <select id="team" name="team">
    ${TEAM_OPTIONS.map((t) => `<option value="${t}"${t === 'unassigned' ? ' selected' : ''}>${t}</option>`).join('')}
  </select>
  <button type="submit">${esc(accountNotice.button)}</button>
</form>`
    : '<p class="sub">Ask an admin or the owner to create accounts.</p>'
}
 `,
  );
}

/**
 * The Team surface is split across two pages so neither reads as a wall of
 * information: "Members" manages people, "Operations" holds the safety and
 * governance read-outs (emergency stops, effective policy, compiler trust gaps,
 * billing scope). This segmented control is the bridge rendered on both halves,
 * built from the shared `.v-tabs` design-system control with the current page
 * marked via `aria-current` (the design system's active-tab hook).
 */
function teamTabs(active: 'members' | 'operations'): string {
  const tab = (key: 'members' | 'operations', label: string, href: string): string =>
    `<a class="v-tab${active === key ? ' v-tab-active' : ''}" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="v-tabs" aria-label="Team sections" style="margin:0 0 20px;">${tab('members', 'Members', '/team')}${tab('operations', 'Operations', '/team/operations')}</nav>`;
}

/** The read-only safety/governance data the Operations half of Team renders. */
type TeamOpsData = {
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
};

/**
 * The operations half of Team. These governance surfaces were crowding the
 * roster, so they live on their own page reached from the Team tab bar. The
 * expensive reads (stop evidence, per-card trust gaps for up to 100 cards)
 * happen only here, which keeps the Members page light.
 */
function teamOperationsPage(csrf: string, viewer: User, home: string, ops: TeamOpsData, notice?: string): string {
  const canManage = atLeast(viewer.role, 'admin') && !viewer.mustChangePassword;
  return page(
    'Vital Console — team operations',
    `<p class="sub"><a href="${esc(home)}">← console</a></p>
<h1>Team</h1>
${teamTabs('operations')}
${notice ? `<p class="sub">${esc(notice)}</p>` : ''}
${stopsSection(csrf, canManage, ops.stops, ops.selfHalts)}
${governanceSection(ops.policy)}
${compilerGapsSection(ops.compilerGaps)}
${billingScopeSection()}
`,
  );
}

/**
 * Wrap a Team page (either half) in the Console workspace shell. Both /team and
 * /team/operations share this so they get the identical rail, topbar, room list,
 * and metrics — and so the rail highlights the Team item (navKey 'team').
 */
async function teamShelledDocument(
  html: string,
  db: import('../core/db.ts').AsyncDb,
  tenant: string,
  home: string,
  auth: { user: User; session: { csrfToken: string } },
): Promise<string> {
  const isAdmin = atLeast(auth.user.role, 'admin');
  const nav = renderConsoleNav(
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
  const cluster = renderAccountCluster(auth.user.email, auth.user.role, auth.session.csrfToken);
  const rooms = (await roomHealth(db, tenant)).map((h) => ({
    scope: h.scope,
    roomName: h.roomName,
    badge: h.badge,
    pending: h.pendingApprovals,
    category: h.category,
  }));
  const shelled = renderConsoleShell({
    rooms,
    home,
    consoleNav: nav,
    accountCluster: cluster,
    innerHtml: workspaceInnerHtml(html),
    userEmail: auth.user.email,
    userRole: auth.user.role,
    userTeam: auth.user.team,
    tenant,
    metrics: await shellMetricsFor(db, tenant),
    roomRecency: await roomRecency(
      db,
      tenant,
      rooms.map((r) => r.scope),
    ),
    navKey: 'team',
  });
  return html.slice(0, html.indexOf('<body>') + 6) + shelled + html.slice(html.indexOf('</body>'));
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
<p class="sub">Skill cards with open transfer or evaluation gaps stay scoped where they were validated until the listed evidence passes. Linking evidence here never promotes a card — promotion runs only through the governed transfer-test path, which is not exposed in this console yet.</p>
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
/**
 * The acting user as recorded: `usr_… (email)`. This string is load-bearing —
 * it is written into audit rows AND it is the message body an operator signs
 * (`approvalMessage`, verified per-request against the same value), so it must
 * not change shape. For the name shown in the interface use `actorLabel`.
 */
const by = (u: User): string => `${u.id} (${u.email})`;

/**
 * How the interface names the viewer. The email — never the internal `usr_…`
 * row id, which is a database key with no place in a page. Distinct from `by`
 * on purpose: `by` is an audit/signature value, this is display only.
 */
const actorLabel = (u: User): string => u.email;

/**
 * Two-segment paths under /console/meetings that are words, not meeting ids.
 *
 * They used to be the query-param aliases (`/console/meetings/detail?id=…`,
 * `/console/meetings/room?id=…`) for the detail and live-room pages. Those
 * routes are deleted: a meeting is addressed by id, at `/console/meetings/:id`
 * and `/console/meetings/:id/room`. Named once because two places must agree on
 * it — the dispatcher must not read the segment as a meeting id, and the
 * request log must not bucket the resulting 404 as a meeting view.
 */
const RETIRED_MEETING_ALIASES = new Set(['/console/meetings/room', '/console/meetings/detail']);

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
  // Filter bar: a search field plus compact controls. Field names are
  // unchanged, so deep links and server-side validation keep working.
  const stateOptions = REQUEST_STATES.map(
    (s) =>
      `<option value="${esc(s)}"${state.states?.[0] === s ? ' selected' : ''}>${esc(s.replace(/_/g, ' ').toLowerCase())}</option>`,
  ).join('');
  const form = `<section aria-label="Search" class="v-card" style="padding:16px 18px;margin-bottom:16px;">
<div class="v-split" style="margin-bottom:12px;">
  <div><h2 class="v-card-title">Search the ledger</h2>
  <p class="v-sub" style="font-size:12px;margin:3px 0 0;">Requests and claims, filtered by status, scope, type and date.</p></div>
  <a href="${esc(clearFilterUrl(base))}" class="v-btn v-btn-secondary v-btn-sm">Clear all</a>
</div>
<form method="get" action="${esc(base)}" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));align-items:end;">
  <label class="v-kpi-label" for="q" style="grid-column:1/-1;display:grid;gap:5px;">Search
    <input class="v-input" id="q" name="q" value="${esc(state.q ?? '')}" placeholder="goal, subject or claim id" style="font-weight:400;text-transform:none;letter-spacing:normal;">
  </label>
  <label class="v-kpi-label" for="state" style="display:grid;gap:5px;">Status
    <select class="v-input v-select" id="state" name="state"><option value="">any</option>${stateOptions}</select>
  </label>
  <label class="v-kpi-label" for="scope" style="display:grid;gap:5px;">Scope
    <input class="v-input" id="scope" name="scope" value="${esc(state.scopes?.[0] ?? '')}" placeholder="any" style="font-weight:400;text-transform:none;letter-spacing:normal;">
  </label>
  <label class="v-kpi-label" for="since" style="display:grid;gap:5px;">Since
    <input class="v-input" id="since" name="since" type="date" value="${esc(state.since ?? '')}">
  </label>
  <label class="v-kpi-label" for="until" style="display:grid;gap:5px;">Until
    <input class="v-input" id="until" name="until" type="date" value="${esc(state.until ?? '')}">
  </label>
  <label class="v-kpi-label" for="workflow" style="display:grid;gap:5px;">Workflow
    <input class="v-input" id="workflow" name="workflow" value="${esc(state.workflowId ?? '')}" placeholder="any id" style="font-weight:400;text-transform:none;letter-spacing:normal;">
  </label>
  <button type="submit" class="v-btn v-btn-primary">Search</button>
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
    return `${form}<div class="v-empty"><h3>${esc(model.title)}</h3><p>${esc(model.body)}</p><p><a class="v-btn v-btn-secondary v-btn-sm" href="${esc(model.clearUrl)}">Clear search and filters</a></p></div></section>`;
  }
  const groups = partitionRequestsByDecision(requests.rows);
  const requestRow = (r: RequestSummary): string =>
    `<a class="v-row" href="${esc(withReturnTo(requestDetailUrl(r.id), returnTo))}"><span class="v-row-main"><strong class="v-truncate">${esc(r.goal)}</strong><span class="v-meta">${esc(r.state)} · ${esc(r.originScope)}→${esc(r.targetScope)}</span></span><span class="v-meta" aria-hidden="true">→</span></a>`;
  const claimRow = (c: ClaimSummary): string =>
    `<a class="v-row" href="${esc(withReturnTo(claimDetailUrl(c.id), returnTo))}"><span class="v-row-main"><strong class="v-truncate">${esc(c.subject)}</strong><span class="v-meta">${esc(c.kind)} · ${esc(c.status)}</span></span><span class="v-meta" aria-hidden="true">→</span></a>`;
  const group = (label: string, rows: string[]): string =>
    rows.length === 0
      ? ''
      : `<h3 class="v-eyebrow" style="margin:16px 0 2px;">${esc(label)}</h3><div class="v-stack-sm" style="gap:0;">${rows.join('')}</div>`;
  let body = `<p class="v-sub v-num" style="font-size:12.5px;">${requests.total} matching request(s) · ${claims.total} matching claim(s)</p>`;
  body += group('Pending decision', groups.pending.map(requestRow));
  body += group('Approved or executing', groups.active.map(requestRow));
  body += group('Other states', groups.other.map(requestRow));
  if (requests.truncated)
    body += `<p class="v-meta" style="margin-top:8px;">explicit truncation: showing ${requests.rows.length} of ${requests.total} matching requests</p>`;
  if (claims.truncated)
    body += `<p class="v-meta">explicit truncation: showing ${claims.rows.length} of ${claims.total} matching claims</p>`;
  body += group('Claims', claims.rows.map(claimRow));
  const pages: string[] = [];
  if (requests.offset > 0)
    pages.push(
      `<a href="${esc(listStateUrl(base, { ...state, offset: Math.max(0, requests.offset - requests.limit) }))}">Previous</a>`,
    );
  if (requests.hasMore)
    pages.push(
      `<a href="${esc(listStateUrl(base, { ...state, offset: requests.offset + requests.rows.length }))}">Next</a>`,
    );
  if (pages.length > 0) body += `<nav class="v-pagination" style="margin-top:12px;">${pages.join('')}</nav>`;
  const paths = viewAllPaths();
  body += `<p class="v-meta" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--v-line);"><a href="${esc(clearFilterUrl(base))}">Clear search and filters</a> · Browse: <a href="${esc(paths.requests)}">All requests</a> · <a href="${esc(paths.claims)}">All claims</a> · <a href="${esc(paths.rooms)}">All rooms</a> · <a href="${esc(paths.humanWork)}">All human work</a> · <a href="${esc(paths.workflows)}">Workflows</a> · <a href="${esc(paths.digest)}">Digest</a></p>`;
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

async function defaultRoomForUser(db: AsyncDb, tenant: string, user: import('../core/auth.ts').User): Promise<string> {
  const row = (await db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(`user:defaultRoom:${tenant}:${user.id}`)) as { value: string } | undefined;
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
        originKind: 'human',
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
    } catch (e) {
      // Budget death, refusal, self-delegation: never a silent no-op — the
      // sender gets a visible notice and the audit log records the refusal
      // (budget death must terminate loudly, never continue silently).
      const reason = (e as Error).message.slice(0, 200);
      const { createLocalReply } = await import('./buzz.ts');
      await createLocalReply(
        opts.db,
        opts.tenant,
        opts.originScope,
        opts.threadRoot ?? null,
        targetRoomDef.agentName,
        `⚠️ Dispatch refused: ${reason}`,
        opts.at,
      );
      await auditConsole(
        opts.db,
        opts.tenant,
        `user:${opts.authorName}`,
        'buzz.dispatch_refused',
        `agent:${targetRoomDef.agentName}`,
        opts.at,
        reason,
      );
    }
  }
}

export function startConsoleServer(
  rawDb: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  opts: ConsoleServerOptions = {},
): Promise<ConsoleServer> {
  // One decorator, here, so every statement the console issues is counted
  // against the request that asked for it — including the ones inside domain
  // modules, which never see the request object.
  const db = withStatementCount(rawDb);
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
  const computeReadiness = async (
    at: string,
  ): Promise<{ ready: boolean; checks: { name: string; status: string; detail?: string }[] }> =>
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
    // Tri-state rather than pass/fail: an optional dependency that was never
    // configured is *grey*, not red — a red pill would claim a failure that
    // never happened.
    if (status === 'ok') return '<span class="v-badge v-badge-good"><span class="dot"></span>ok</span>';
    if (status === 'unconfigured-optional')
      return '<span class="v-badge"><span class="dot" style="background:var(--v-faint)"></span>not configured</span>';
    return '<span class="v-badge v-badge-risk"><span class="dot"></span>needs attention</span>';
  };

  const renderSystemReadiness = async (at: string): Promise<string> => {
    const r = await computeReadiness(at);
    const items = r.checks
      .map(
        (c) =>
          `<li class="v-row"><span class="v-row-main">${readinessPill(c.status)}<strong>${esc(c.name)}</strong></span><span class="v-meta">${c.detail ? esc(c.detail) : ''}</span></li>`,
      )
      .join('');
    const headline = r.ready ? 'System is ready' : 'System needs attention';
    return `<section id="system-readiness" class="v-card" style="margin-bottom:16px;">
<div class="v-split" style="margin-bottom:6px;">
  <div>
    <p class="v-eyebrow">System readiness</p>
    <h2 class="v-card-title" style="margin-top:4px;">${esc(headline)}</h2>
  </div>
  <a class="v-btn v-btn-secondary v-btn-sm" href="/api/metrics" rel="noreferrer">Raw readiness (JSON)</a>
</div>
<ul style="list-style:none;padding:0;margin:6px 0 0">${items}</ul>
<p class="v-meta" style="margin-top:10px;"><a href="/setup">Continue setup</a></p>
</section>`;
  };

  /**
   * Executor honesty banner for the dashboard.
   *
   * Renders nothing when a real executor checked in recently — silence means the
   * ordinary case. It speaks up only when approved work would not run at all, or
   * would "run" through the echo harness, whose runs report COMPLETED without
   * doing work. That last case used to be invisible: the readiness strip said a
   * worker was alive, and the operator had no way to tell an executor from a
   * test double.
   */
  const renderExecutorBanner = async (at: string): Promise<string> => {
    const health = describeExecutorHealth(await readWorkerHeartbeat(db, tenant), at);
    if (health.state === 'live' && !health.baseline) return '';
    const risk = health.state === 'absent' || health.baseline;
    let title = 'Executor silent';
    if (health.baseline) title = 'No real executor attached';
    else if (health.state === 'absent') title = 'No executor deployed';
    let hint = 'It may not have returned yet; legs already EXECUTING are flagged on their workflow page.';
    if (health.state === 'absent') {
      hint = 'Start one with <code>vital worker</code> or <code>vital serve --with-worker</code>.';
    } else if (health.baseline) {
      hint =
        "Approved work will be 'completed' by the test-baseline harness and leave no deliverable to review. Attach a real executor (for example <code>JCODE_API_SOCKET</code>) before trusting these runs.";
    }
    return `<section class="v-card" style="border-color:var(--v-${risk ? 'risk' : 'warn'})">
<div class="v-split" style="align-items:flex-start">
  <div><p class="v-eyebrow">Execution</p><h2 class="v-card-title" style="margin-top:4px;">${esc(title)}</h2>
  <p class="v-meta" style="margin-top:6px;">${esc(health.detail)}</p>
  <p class="v-meta" style="margin-top:6px;">${hint}</p></div>
  <a class="v-btn v-btn-secondary v-btn-sm" href="/console/workflows">Workflows</a>
</div>
</section>`;
  };

  /**
   * Run an outbound GitHub push after the local write has been answered, and
   * record the result instead of discarding it.
   *
   * The push cannot block the response — the human's write already succeeded and
   * GitHub's latency is not theirs to wait on — but it must not vanish either.
   * Every call site used to be `.catch(() => {})`, so a revoked token or a
   * renamed repository left the local board happily diverging from GitHub with
   * no signal anywhere a person would look. A failure now flips the sync status
   * to `error` (visible in the Issues toolbar and dialog) and lands in the audit
   * log with what failed and why.
   */
  const pushAfterLocalWrite = (
    kind: string,
    target: string,
    actor: string,
    run: () => Promise<{ ok: boolean; error?: string }>,
  ): void => {
    const at2 = new Date().toISOString();
    void run()
      .then(async (result) => {
        if (result.ok) return;
        await markGitHubSyncError(db, tenant, {
          kind,
          target,
          error: result.error ?? 'push failed with no reason given',
          at: at2,
        });
        await auditConsole(
          db,
          tenant,
          actor,
          'github.push_failed',
          target,
          at2,
          `${kind}: ${result.error ?? 'no reason'}`.slice(0, 200),
        );
      })
      .catch(async (e: unknown) => {
        await markGitHubSyncError(db, tenant, {
          kind,
          target,
          error: (e as Error).message,
          at: at2,
        });
        await auditConsole(
          db,
          tenant,
          actor,
          'github.push_failed',
          target,
          at2,
          `${kind}: ${(e as Error).message}`.slice(0, 200),
        );
      });
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
  /**
   * Single ingestion point for the design system: whatever page producer
   * answered the request (shell-wrapped, detail document, utility page, legacy
   * producer), the HTML response carries the tokens, the early paint script
   * and the theme toggle exactly once. Fragments and non-HTML bodies pass
   * through untouched, and the marketing site's own stylesheet is never
   * rewritten because only text/html console responses are transformed.
   */
  const themeAwareHtml = (res: ServerResponse): void => {
    const end = res.end.bind(res) as (...args: never[]) => ServerResponse;
    const writeHead = res.writeHead.bind(res) as (...args: never[]) => ServerResponse;
    // `res.writeHead(status, headers)` does not populate `res.getHeader()`,
    // so the content type has to be captured as it is written.
    let contentType = '';
    res.writeHead = ((...args: unknown[]) => {
      for (const arg of args) {
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const raw = (arg as Record<string, unknown>)['content-type'];
          if (raw !== undefined) contentType = String(raw);
        }
      }
      return writeHead(...(args as never[]));
    }) as typeof res.writeHead;
    let settled = false;
    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      if (settled) return end(chunk as never, encoding as never, callback as never);
      settled = true;
      const type = contentType || String(res.getHeader('content-type') ?? '');
      if (type.includes('text/html') && typeof chunk === 'string') {
        return end(themeDocument(chunk) as never, encoding as never, callback as never);
      }
      return end(chunk as never, encoding as never, callback as never);
    }) as typeof res.end;
  };

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

    // Providers are configured from the environment, or the pipeline refuses
    // (meetings/pipeline.ts). Nothing here defaults to a mock: a fabricated
    // meeting transcript would be stored as a fact in the ledger this product
    // exists to keep honest.
    const meetingService = new MeetingService(db, meetingPipelineOptions());
    const signalingHub = new MeetingSignalingHub(db);
    // Identity for a signaling socket is resolved server-side from the
    // session cookie — never from query params, which let anyone claim the
    // host role. The upgrade is refused (401) without a live session on this
    // tenant whose meeting exists.
    const wsUpgrade = createWebSocketUpgradeHandler(signalingHub, {
      resolveIdentity: async (req) => {
        const sessionToken = cookieValue(req, 'vital_session');
        if (!sessionToken) return null;
        let auth: { session: { csrfToken: string }; user: { id: string; name: string; tenant: string } };
        try {
          auth = await sessionUser(db, sessionToken, now());
        } catch {
          return null;
        }
        if (auth.user.tenant !== tenant) return null;
        const u = new URL(req.url ?? '/', 'http://console');
        const meetingId = u.searchParams.get('meetingId') ?? '';
        if (!meetingId) return null;
        const meeting = await meetingService.getMeeting(tenant, meetingId).catch(() => null);
        if (!meeting) return null;
        const name = u.searchParams.get('name');
        return {
          userId: auth.user.id,
          displayName: (name && name.slice(0, 64)) || auth.user.name,
          tenant,
          role: meeting.hostUserId === auth.user.id ? ('host' as const) : ('participant' as const),
        };
      },
    });

    // ---------------------------------------------------------- route table ----
    // Routes moved off the legacy if-chain. Their capability is declared in
    // routes/*.ts and enforced by `matchRoute` + `capabilityAllows` below, so
    // "does this require a session" is answerable by reading one table instead
    // of tracing a branch. Unmigrated routes still fall through to the chain.
    // A union of the env each migrated domain declares. A domain module asks
    // only for what it uses; the server satisfies all of them, and because a
    // handler's parameter is contravariant a narrow handler slots into this
    // wider list without a cast.
    type ConsoleRouteEnv = ObservabilityEnv &
      ComplianceEnv &
      RequestsEnv &
      ListsEnv &
      LearningEnv &
      ReviewEnv &
      IssuesEnv &
      AgentTasksEnv;
    /** Shelled console page: the chrome stays here, the page body comes from the domain. */
    const shellPage: ListsEnv['shellPage'] = async (auth, page) => {
      const opts = {
        tenant,
        actor: by(auth.user),
        actorLabel: actorLabel(auth.user),
        csrf: auth.session.csrfToken,
        canApprove: false,
        requiredRole: approverMin,
        operatorMode: 'session' as const,
        home,
      };
      return wrapInWorkspaceShell(
        detailDocument(page.title, page.body, { ...opts, hideHeader: page.hideHeader }),
        db,
        tenant,
        home,
        auth,
        page.navKey,
        undefined,
        // The drawer rendering the list pages use when a detail link opens in
        // place. Declared on the route, applied by the one shell builder.
        page.drawer,
      );
    };
    // Boot-time capability of the operator channel: a signing key, a shared
    // secret, or none. The same precedence the legacy approval branch used.
    let operatorMode: 'signature' | 'secret' | 'session' = 'session';
    if (keyAuth) operatorMode = 'signature';
    else if (operatorSecret) operatorMode = 'secret';
    const routeEnv: ConsoleRouteEnv = {
      db,
      tenant,
      home,
      shellPage,
      exportLedger: (t, at) => exportLedger(db, t, at),
      eraseTenant: (t, actor, at) => eraseTenant(db, t, actor, at),
      actorOf: (auth) => by(auth.user),
      actorLabel: (auth) => actorLabel(auth.user),
      approverMin,
      operatorMode,
      coord,
      ledger,
      // `detail` is optional so this satisfies both the four-argument domains and
      // the domains (review, issues) that record a detail line.
      audit: (actor: string, action: string, target: string, at: string, detail?: string) =>
        auditConsole(db, tenant, actor, action, target, at, detail),
      redirect: (res, location, opts) => redirect(res, location, opts?.clearSession ? CLEAR_SESSION_COOKIE : undefined),
      vitalVersion: '0.0.1',
      // Read at request time: the address is only known after listen().
      get boundAddress(): string {
        return boundAddress;
      },
      // FLOW-006: liveness answers through the LB path too — the target group's
      // probe and the smoke script land here with ALB proxy headers attached.
      // `scheme`/`viaProxy` let the smoke check prove the LB→task path, not just
      // loopback reachability.
      forwarded: (req) => {
        const fwd = resolveRequestContext(req, trustProxy);
        return { scheme: fwd.scheme, viaProxy: fwd.viaProxy };
      },
      liveness: (at) => liveness(at),
      rateOk,
      approvalLatency: (t) => coord.approvalLatencyStats(t),
      costPerSignal: (t) => new CognitiveRouter(db).costPerSignal(t),
      comp,
      // The board's outbound GitHub pushes. Same closure the legacy GitHub
      // routes use, so "a push failure is recorded, never swallowed" has one
      // implementation.
      pushAfterLocalWrite,
      fetchFn: opts.fetchFn ?? fetch,
    };
    const routes: RouteDef<ConsoleRouteEnv>[] = [
      ...observabilityRoutes(),
      ...complianceRoutes(),
      ...requestsRoutes(),
      ...listsRoutes(),
      ...learningRoutes(),
      ...reviewRoutes(),
      ...issuesRoutes(),
      ...agentTasksRoutes(),
    ];
    // Fail at boot, not at request time: a route that cannot register is a 404
    // in production and a mystery in review.
    validateRoutes(routes);
    const server: Server = createServer((req, res) => {
      const started = Date.now();
      let logPath = 'unmatched';
      themeAwareHtml(res);
      res.on('finish', () => {
        metrics.requests += 1;
        console.log(
          JSON.stringify({
            at: new Date(started).toISOString(),
            method: req.method,
            path: logPath,
            status: res.statusCode,
            ms: Date.now() - started,
            // Render cost, not just latency: `sql` is the statements this
            // request prepared and `memo` the reads it served from the request
            // cache. A page whose sql count climbs is duplicating work again —
            // the failure mode that is invisible in a screenshot and in a
            // functional test, and that only shows up as "the console got
            // slower" months later. Logged for every request; the path is
            // already normalised above, so no tenant data is added here.
            sql: stats.sql,
            memo: stats.memoHits,
          }),
        );
      });
      // One request-scoped cache for everything below: the same read inside this
      // request resolves once, no matter how many widgets ask for it. Mutating
      // methods opt out — a POST that writes and then re-renders must not be
      // handed the pre-write read from earlier in the same request.
      // Reads-only requests memoize; a request that can write does not.
      const readsOnly = (req.method ?? 'GET') === 'GET';
      // Counters live here, outside the request context, because the log line is
      // written on `finish` — after the context that would have held them.
      const stats = createRequestStats();
      void withRequestCache(
        async () => {
          const url = new URL(req.url ?? '/', 'http://console');
          const path = url.pathname;
          const method = req.method ?? 'GET';
          // Route templates avoid logging tenant data, identifiers, or query strings.
          if (/^\/api\/requests\/[^/]+\/(approve|decline)$/.test(path))
            logPath = `/api/requests/:id/${path.endsWith('/approve') ? 'approve' : 'decline'}`;
          else if (/^\/api\/requests\/[^/]+\/refresh-evidence$/.test(path))
            logPath = '/api/requests/:id/refresh-evidence';
          else if (/^\/api\/meetings\/[^/]+\/(join|leave|end|recording|transcript|process|rag|ask|delete)$/.test(path))
            logPath = `/api/meetings/:id/${path.split('/').pop()}`;
          else if (/^\/api\/meetings\/[^/]+$/.test(path)) logPath = '/api/meetings/:id';
          else if (/^\/console\/meetings\/[^/]+\/room$/.test(path)) logPath = '/console/meetings/:id/room';
          else if (/^\/console\/meetings\/[^/]+$/.test(path) && !RETIRED_MEETING_ALIASES.has(path))
            logPath = '/console/meetings/:id';
          // Chat room names are tenant data too, and this is the busiest page in
          // the product — logged as `unmatched` it made the render-cost metric
          // useless for exactly the surface it was most needed on.
          else if (/^\/console\/buzz\/[^/]+$/.test(path)) logPath = '/console/buzz/:room';
          else if (
            [
              home,
              '/console',
              '/console/',
              '/console/rooms',
              '/console/requests',
              '/console/human-work',
              '/console/claims',
              '/console/meetings',
              '/api/meetings',
              '/api/meetings/create',
              '/api/meetings/list',
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
              '/console/buzz',
              '/console/digest',
              '/console/learning',
              '/console/workflows',
              '/console/audit',
              '/console/data',
              '/console/data/export',
              '/console/data/erase',
              '/console/issues',
              '/console/issues/sync',
              '/console/issues/detail',
              '/console/issues/create',
              '/console/issues/move',
              '/console/issues/update',
              '/console/issues/delete',
              '/console/issues/comment',
              '/receipts/erasure',
              '/account/mfa/setup',
              '/account/mfa/enable',
              '/account/mfa/recovery',
              '/account/mfa/remove',
              '/forgot-password',
              '/reset-password',
              '/team',
              '/team/operations',
              '/team/invite',
              '/team/disable',
              '/team/reactivate',
              '/team/role',
              '/team/team',
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
              '/setup/rooms',
              '/api/ingest/health',
              '/healthz',
              '/api/health',
              '/api/metrics',
              '/api/approval-latency',
              '/api/cost-per-signal',
            ].includes(path)
          )
            logPath = path;
          // NOTE: /healthz lives in routes/observability.ts (capability: public).
          // It is dispatched further down, after the session closures exist — and
          // deliberately before any tenant/cookie DB read, because the target
          // group probes it every 30s per task and it must stay constant-cost.
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

          // ------------------------------------------------- route table dispatch
          // The single enforcement point for declared capabilities. A hit is fully
          // handled here and returns; everything not yet migrated falls through to
          // the chain below, so migration can proceed route by route.
          const routeHit = matchRoute(routes, method, path);
          if (routeHit) {
            const declared = routeHit.route;
            // A declared pattern is already identifier-free, so a migrated route
            // can never log as `unmatched` (or leak an id) by being forgotten in
            // the allow-list above — which is how `/console/rooms` spent its time
            // logging as `unmatched` while being the most expensive page.
            logPath = declared.pattern;
            const capability = declared.capability;
            const isPage = declared.surface === 'html';
            // Only pay for a session lookup when the route demands one.
            const auth = capability === 'public' ? null : await sessionOf();
            if (capability !== 'public' && !auth) {
              // A browser following a nav link must land on the login form with a
              // way back; an API caller must get a status it can act on.
              return isPage ? redirectLogin() : sessionExpiredApi();
            }
            // Identical for both surfaces by choice: legacy HTML pages answered a
            // foreign tenant with JSON as well, and the tenant mismatch means the
            // caller's session does not belong to this deployment at all.
            if (auth && auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            // Session freshness precedes the role decision, matching the legacy
            // order: an un-activated account is sent to change its password rather
            // than told about a page it cannot see yet. Declared per route, so the
            // routes that always checked it keep checking it and the ones that
            // never did are not quietly changed.
            if (declared.activation === 'required' && auth && activationDenied(res, auth, !isPage)) return;
            if (!capabilityAllows(capability, auth)) {
              const denied = declared.denied;
              if (isPage && auth && denied && denied.as !== 'text') {
                res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
                res.end(
                  await shellPage(auth, {
                    title: denied.title,
                    body: `<p class="sub">${esc(denied.message)}</p>`,
                    navKey: denied.navKey ?? '',
                  }),
                );
                return;
              }
              if (isPage && denied?.as === 'text') {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(denied.message);
                return;
              }
              return json(res, 403, { ok: false, error: 'forbidden' });
            }
            // Declared body handling: parse + CSRF once, here, so "this route
            // checks its token" is a property of the table rather than of the
            // handler. The parsed body is handed over, so a handler cannot forget
            // to read it or accidentally read it twice.
            let call: Call | null = null;
            if (declared.body === 'csrf') {
              if (!auth) return sessionExpiredApi();
              try {
                call = await parseCall(req);
              } catch (e) {
                return bodyError(res, e); // 413 for body bombs, 400 for malformed JSON
              }
              if (!csrfOk(auth.session, call.csrf)) return json(res, 403, { ok: false, error: 'bad CSRF token' });
            }
            await declared.handler({
              req,
              res,
              url,
              path,
              method,
              params: routeHit.params,
              ip,
              at,
              auth: auth as AuthContext | null,
              call,
              env: routeEnv,
              memo: { memo: memoize },
            });
            return;
          }

          const accessState = await tenantAccessState(db, tenant);
          const exposeResetToken = process.env.VITAL_EXPOSE_RESET_TOKEN === '1';

          // ---------------------------------------------------------- auth pages
          if (path === '/login' && method === 'GET') {
            if (accessState === 'unclaimed') return redirect(res, '/signup');
            const existingAuth = await sessionOf();
            if (existingAuth) {
              const defRoom = await defaultRoomForUser(db, tenant, existingAuth.user);
              return redirect(res, `/console/buzz/${encodeURIComponent(defRoom)}`);
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
              return redirect(res, next ?? `/console/buzz/${encodeURIComponent(defRoom)}`, cookie);
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
            try {
              await checkMfaLockout(db, tenant, entry.userId, at);
            } catch {
              const csrfLocked = randomBytes(32).toString('hex');
              res.writeHead(401, {
                'content-type': 'text/html; charset=utf-8',
                'set-cookie': preCsrfCookie(csrfLocked, secure, cookieValue(req, PRE_CSRF_COOKIE)),
              });
              res.end(
                mfaChallengePage(csrfLocked, {
                  error: 'Too many failed attempts — try again later.',
                  next,
                  recovery: mode,
                }),
              );
              return;
            }
            const accepted = mode
              ? await consumeMfaRecoveryCode(db, tenant, entry.userId, code, at)
              : await verifyMfaCode(db, tenant, entry.userId, code, at);
            if (!accepted) {
              await recordMfaFailure(db, tenant, entry.userId, at);
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
            await clearMfaFailures(db, tenant, entry.userId);
            const { user, session, token } = await startSessionForUser(db, tenant, entry.userId, at);
            const sessionCk = sessionCookie(token, at, secure, session);
            const clearMfa = `${MFA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
            const defRoom = await defaultRoomForUser(db, tenant, user);
            const target = user.mustChangePassword
              ? '/change-password'
              : (next ?? `/console/buzz/${encodeURIComponent(defRoom)}`);
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
            // One honest answer, because there is one real behaviour: the token is
            // recorded and an operator delivers it. Claiming an inbox delivery here
            // was the false promise this branch used to make.
            let notice =
              'If an account exists for that email, the reset request has been recorded. Automatic email delivery is not configured on this host — ask your operator to deliver your single-use link via vital reset-link (turnaround: under 1 hour).';
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
              'Verification token issued. Outbound email is not configured — ask your operator to retrieve your link with vital verify-link (turnaround: under 1 business day).',
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
            // Enrolling an authenticator neutralizes passwords as a sole factor:
            // demand a fresh authentication, not just a live session.
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
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
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
            if (!(await isMfaEnabled(db, auth.user.id))) return redirect(res, '/account');
            const codes = await generateMfaRecoveryCodes(db, tenant, auth.user.id, at);
            await auditConsole(
              db,
              tenant,
              by(auth.user),
              'account.mfa_recovery_regenerated',
              `user:${auth.user.id}`,
              at,
            );
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
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
            try {
              await removeMfaFactor(db, tenant, auth.user.id, call.fields.factorId ?? '', at);
              await auditConsole(db, tenant, by(auth.user), 'account.mfa_removed', `user:${auth.user.id}`, at);
            } catch {
              /* unknown factor — nothing to remove; return to the account page */
            }
            return redirect(res, '/account');
          }
          if (path === '/logout') {
            if (method === 'POST') {
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
            if (method === 'GET') {
              // Logout is a state change: GET renders a confirmation form
              // instead of mutating, so a prefetched link or top-level
              // navigation cannot log the user out (logout-CSRF).
              const auth = await sessionOf();
              if (!auth) return redirect(res, '/login');
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              res.end(
                page(
                  'Vital Console — sign out',
                  `<h1>Sign out?</h1><p class="sub">This ends the current session on this device.</p>
<form method="post" action="/logout">
  <input type="hidden" name="csrf" value="${esc(auth.session.csrfToken)}">
  <button type="submit">Sign out</button>
</form>
<p class="sub"><a href="/">Back to console</a></p>`,
                ),
              );
              return;
            }
          }

          // /api/health — routes/observability.ts (public, rate-limited).
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
              actorLabel: actorLabel(auth.user),
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
            // Wording kept verbatim: the labels are pinned by the digest tests.
            const windows: { value: DigestDays; label: string }[] = [
              { value: '1', label: 'Last 1 day(s)' },
              { value: '7', label: 'Last 7 day(s)' },
              { value: '30', label: 'Last 30 day(s)' },
              { value: 'all', label: 'All history' },
            ];
            const navigation = `<div class="v-page-head">
  <div>
    <p class="v-eyebrow">System</p>
    <h1 class="v-page-title">Digest</h1>
    <p class="v-sub" style="margin-top:6px;">Informational NOTICEs, grouped by topic. Nothing here needs a decision.</p>
  </div>
  <nav class="v-segmented" aria-label="Digest time window">${windows.map((w) => `<a href="/console/digest?days=${w.value}"${w.value === window ? ' aria-current="page"' : ''}>${esc(w.label)}</a>`).join('')}</nav>
</div>`;
            const body = navigation + (await renderDigest(coord, db, tenant, at, { since }));
            const detailOpts = {
              tenant,
              actor: by(auth.user),
              actorLabel: actorLabel(auth.user),
              csrf: auth.session.csrfToken,
              canApprove: false,
              requiredRole: approverMin,
              operatorMode: 'session' as const,
              home,
            };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            // Digest is a nav item, so it wears the same console chrome as every
            // other list page. It used to call detailDocument directly and render
            // as an orphan: no rail, no top bar, no way back.
            res.end(
              await wrapInWorkspaceShell(
                detailDocument('Digest', body, { ...detailOpts, hideHeader: true }),
                db,
                tenant,
                home,
                auth,
                'digest',
              ),
            );
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
              actorLabel: actorLabel(auth.user),
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
                await wrapInWorkspaceShell(
                  detailDocument('Learning review', body, { ...detailOpts, hideHeader: true }),
                  db,
                  tenant,
                  home,
                  auth,
                  'learning',
                ),
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
              await wrapInWorkspaceShell(
                detailDocument('Learning review', body, { ...detailOpts, hideHeader: true }),
                db,
                tenant,
                home,
                auth,
                'learning',
              ),
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
              actorLabel: actorLabel(auth.user),
              csrf: auth.session.csrfToken,
              canApprove: false,
              requiredRole: approverMin,
              operatorMode: 'session' as const,
              home,
            };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(
              await wrapInWorkspaceShell(
                detailDocument('Compiler — Why Not Trusted Yet', content, { ...detailOpts, hideHeader: true }),
                db,
                tenant,
                home,
                auth,
                'compiler',
              ),
            );
            return;
          }
          // ------------------------------------------------------------ Workspace (internal: buzz)
          // The human-facing room console: roster + per-room thread view.
          // Chat is open to every tenant role (the room-agent model: humans talk
          // to their own agent); governance surfaces elsewhere stay admin-gated.
          if (method === 'GET' && path === '/console/buzz') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (activationDenied(res, auth, false)) return;
            // Chat is open to every tenant role; governance surfaces elsewhere
            // (team, learning, policy) keep their admin gates.
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
              actorLabel: actorLabel(auth.user),
              csrf: auth.session.csrfToken,
              canApprove: false,
              requiredRole: approverMin,
              operatorMode: 'session' as const,
              home,
            };

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
                  '<p class="sub">No such room. <a href="/console/buzz">Back to the workspace</a>.</p>',
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
            const call = await parseCall(req);
            if (!csrfOk(auth.session, call.csrf)) {
              return json(res, 403, { ok: false, error: 'bad CSRF token' });
            }
            const scope = decodeURIComponent(buzzRoomCommand[1]!);
            const command = String(call.fields.command ?? '').trim();
            const back = `/console/buzz/${encodeURIComponent(scope)}`;
            if (!command) return redirect(res, back);
            // Chat flows through this endpoint, so it is open to every tenant
            // role — but slash commands that act on the org (halt, recover,
            // policy changes) are governance, and stay admin+.
            const GOVERNANCE_COMMANDS = new Set(['halt', 'recover', 'policy']);
            const firstWord = command.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
            if (GOVERNANCE_COMMANDS.has(firstWord) && !atLeast(auth.user.role, 'admin')) {
              return json(res, 403, { ok: false, error: `${firstWord} requires the admin or owner role` });
            }
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
              const { isBusinessIntelligenceInquiry, handleGeneralAgentQuery } = await import('../talk/rag-analyst.ts');
              if (isBusinessIntelligenceInquiry(command, scope)) {
                const res = await handleGeneralAgentQuery(db, tenant, command, at);
                const agentId = await createLocalReply(db, tenant, scope, newId, 'general-agent', res.text, at);
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
            const messageId = String(call.fields.messageId ?? '')
              .trim()
              .slice(0, 64);
            const emoji = String(call.fields.emoji ?? '')
              .trim()
              .slice(0, 8);
            if (!messageId || !emoji) return redirect(res, `/console/buzz/${encodeURIComponent(scope)}`);
            const { toggleReaction } = await import('./buzz.ts');
            await toggleReaction(db, tenant, messageId, emoji, auth.user.id, at);
            await auditConsole(db, tenant, by(auth.user), 'buzz.react', `msg:${messageId}`, at, emoji);
            return redirect(res, `/console/buzz/${encodeURIComponent(scope)}#msg-${encodeURIComponent(messageId)}`);
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
            const parentId =
              String(call.fields.parentId ?? '')
                .trim()
                .slice(0, 64) || null;
            const content = String(call.fields.content ?? '')
              .trim()
              .slice(0, 500);
            if (!content) return redirect(res, `/console/buzz/${encodeURIComponent(scope)}`);
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
            const { isBusinessIntelligenceInquiry, handleGeneralAgentQuery } = await import('../talk/rag-analyst.ts');
            if (isBusinessIntelligenceInquiry(content, scope)) {
              const res = await handleGeneralAgentQuery(db, tenant, content, at);
              const agentId = await createLocalReply(
                db,
                tenant,
                scope,
                parentId ?? newId,
                'general-agent',
                res.text,
                at,
              );
              targetReplyId = agentId;
            }

            await auditConsole(db, tenant, by(auth.user), 'buzz.reply', `msg:${newId}`, at, content.slice(0, 120));
            return redirect(res, `/console/buzz/${encodeURIComponent(scope)}#msg-${encodeURIComponent(targetReplyId)}`);
          }
          // The per-mission code review moved onto the route table (both verbs,
          // with their CSRF policy declared) and into the console shell. It used
          // to answer a signed-out POST with JSON 401 while every other review
          // form is a browser submission; `surface: 'html'` is the honest half of
          // that pair — a reviewer whose session expired gets the login form.

          // ------------------------------------------------------------ Issues (engineers team only)
          // The board itself moved to routes/issues.ts with a declared
          // `engineer` capability. What stays here is the GitHub sub-surface,
          // whose webhook GitHub calls anonymously once a repo is linked — a
          // capability that depends on tenant state, not on the caller, so it
          // cannot be stated as one declared value yet. `engineerOnly` is the
          // same predicate the `engineer` capability applies.
          const engineerOnly = (auth: { user: User }): boolean => {
            return isEngineer(auth.user) && !auth.user.disabled;
          };

          // ------------------------------------------------------------ GitHub Project Sync (bidirectional)
          {
            const issuesGhConfig = path === '/console/issues/github/config' && method === 'GET';
            const issuesGhAuth = path === '/console/issues/github/authorize' && method === 'POST';
            const issuesGhSync = path === '/console/issues/github/sync' && method === 'POST';
            const issuesGhUnlink = path === '/console/issues/github/unlink' && method === 'POST';
            const issuesGhWebhook = path === '/console/issues/github/webhook' && method === 'POST';
            if (issuesGhConfig || issuesGhAuth || issuesGhSync || issuesGhUnlink || issuesGhWebhook) {
              const auth = await sessionOf();
              // webhook is allowed anonymous if repo linked (GitHub itself calls it); otherwise require engineer session
              if (!issuesGhWebhook) {
                if (!auth) return redirectLogin();
                if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
                if (activationDenied(res, auth, false)) return;
                if (!engineerOnly(auth))
                  return json(res, 403, {
                    ok: false,
                    error: 'the Issues board is available to the engineering team only',
                  });
              }
              if (issuesGhConfig) {
                const a = await sessionOf();
                if (!a) return redirectLogin();
                if (!engineerOnly(a))
                  return json(res, 403, {
                    ok: false,
                    error: 'the Issues board is available to the engineering team only',
                  });
                const config = await getGitHubSyncConfig(db, tenant);
                const pushError = await getGitHubPushError(db, tenant);
                return json(res, 200, {
                  ok: true,
                  config: config
                    ? {
                        repo: config.repo,
                        status: config.status,
                        lastSyncedAt: config.lastSyncedAt,
                        syncedCount: config.syncedCount,
                        hasToken: !!config.token,
                        lastPushError: pushError,
                      }
                    : null,
                });
              }
              if (issuesGhWebhook) {
                const cfg = await getGitHubSyncConfig(db, tenant);
                if (!cfg || !cfg.repo) return json(res, 400, { ok: false, error: 'no repo linked for tenant' });
                const syncRes = await syncGitHubProject(db, tenant, { fetchFn: opts.fetchFn ?? fetch });
                return json(res, 200, { ok: syncRes.ok, syncedCount: syncRes.syncedCount, error: syncRes.error });
              }
              // Parsed, or the parser's own refusal. The union keeps the parser's
              // message visible (a malformed body and a rejected one are
              // different answers) without a `let` whose initial value no reader
              // ever sees.
              const parsed = await parseCall(req).catch((e: unknown) => e as Error);
              if (parsed instanceof Error) {
                return json(res, 400, { ok: false, error: parsed.message });
              }
              const call: Call = parsed;
              if (!auth || !csrfOk(auth.session, call.csrf))
                return json(res, 403, { ok: false, error: 'bad CSRF token' });
              const serverFetchFn = opts.fetchFn ?? fetch;
              const at2 = now();
              if (issuesGhUnlink) {
                // Read the repo first: the audit line is only useful if it names
                // what was disconnected, and the unlink forgets exactly that.
                const before = await getGitHubSyncConfig(db, tenant);
                await unlinkGitHubSyncConfig(db, tenant, auth.user.email, at2);
                await auditConsole(
                  db,
                  tenant,
                  by(auth.user),
                  'github.unlink',
                  'github:sync',
                  at2,
                  before?.repo ? `unlinked ${before.repo}` : undefined,
                );
                return json(res, 200, { ok: true, config: null });
              }
              if (issuesGhAuth) {
                const repoRaw = String(call.fields.repo ?? '').trim();
                const tokenRaw = typeof call.fields.token === 'string' ? call.fields.token.trim() : null;
                const parsed = parseGitHubRepoPath(repoRaw);
                if (!parsed)
                  return json(res, 400, {
                    ok: false,
                    error: 'Invalid repository. Please enter owner/repo or a GitHub URL.',
                  });
                const authRes = await authorizeGitHubRepo(repoRaw, tokenRaw, serverFetchFn);
                if (!authRes.ok)
                  return json(res, 400, { ok: false, error: authRes.error || 'GitHub authorization failed' });
                await saveGitHubSyncConfig(db, tenant, authRes.repoFullName, tokenRaw, auth.user.email, at2);
                const syncRes = await syncGitHubProject(db, tenant, {
                  fetchFn: serverFetchFn,
                  userEmail: auth.user.email,
                });
                await auditConsole(
                  db,
                  tenant,
                  by(auth.user),
                  'issues.github_authorize',
                  `repo:${authRes.repoFullName}`,
                  at2,
                  `synced:${syncRes.syncedCount}`,
                );
                return json(res, 200, {
                  ok: true,
                  repo: authRes.repoFullName,
                  syncedCount: syncRes.syncedCount,
                  error: syncRes.error,
                });
              }
              if (issuesGhSync) {
                const syncRes = await syncGitHubProject(db, tenant, {
                  fetchFn: serverFetchFn,
                  userEmail: auth!.user.email,
                });
                if (!syncRes.ok) return json(res, 400, { ok: false, error: syncRes.error || 'Sync failed' });
                await auditConsole(
                  db,
                  tenant,
                  by(auth!.user),
                  'issues.github_sync',
                  `synced:${syncRes.syncedCount}`,
                  at2,
                );
                return json(res, 200, { ok: true, syncedCount: syncRes.syncedCount });
              }
            }
          }

          // ------------------------------------------------------------- Meetings ----
          if (path === '/console/meetings' && method === 'GET') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (activationDenied(res, auth, false)) return;

            const meetings = await meetingService.listMeetings(tenant);
            const body = renderMeetingLibraryView({ meetings, home, csrf: auth.session.csrfToken });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            // The library is a management surface (browse, review, join), so it
            // renders in the Console shell — never in the chat shell. Only the
            // live room itself is a real-time space.
            res.end(await wrapInWorkspaceShell(body, db, tenant, home, auth, 'meetings'));
            return;
          }

          const roomMatch = path.match(/^\/console\/meetings\/([^/]+)\/room$/);
          if (roomMatch && method === 'GET') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (activationDenied(res, auth, false)) return;

            // The id is a path segment, so it is always present and never empty.
            const meetingId = decodeURIComponent(roomMatch[1]!);
            const meeting = await meetingService.getMeeting(tenant, meetingId);
            if (!meeting) {
              res.writeHead(302, { location: `${home}console/meetings` });
              res.end();
              return;
            }

            const html = renderMeetingRoomView({
              meeting,
              currentUserId: auth.user.id,
              currentUserName: auth.user.name,
              userRole: auth.user.role,
              home,
              csrf: auth.session.csrfToken,
              iceServers: meetingIceServers(),
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html);
            return;
          }

          // Live-room static assets. Content-hashed URLs (the room HTML links
          // ?v=<sha>), so the body is immutable; unhashed requests only get
          // revalidated, never served stale.
          if (
            method === 'GET' &&
            (path === '/console/assets/meeting-room.css' || path === '/console/assets/meeting-room.js')
          ) {
            const kind = path.endsWith('.css') ? 'css' : 'js';
            const asset = meetingRoomAsset(kind);
            if ((req.headers['if-none-match'] ?? '') === asset.etag) {
              res.writeHead(304, { etag: asset.etag });
              res.end();
              return;
            }
            const hashed = (url.searchParams.get('v') ?? '') === asset.etag.slice(3, 13);
            res.writeHead(200, {
              'content-type': asset.type,
              'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
              etag: asset.etag,
            });
            res.end(asset.body);
            return;
          }

          const detailMatch = path.match(/^\/console\/meetings\/([^/]+)$/);
          if (detailMatch && !RETIRED_MEETING_ALIASES.has(path) && method === 'GET') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (activationDenied(res, auth, false)) return;

            const meetingId = decodeURIComponent(detailMatch[1]!);
            const details = await meetingService.getMeetingDetails(tenant, meetingId);
            if (!details) {
              res.writeHead(302, { location: `${home}console/meetings` });
              res.end();
              return;
            }

            const body = renderMeetingDetailView({
              meeting: details.meeting,
              notes: details.notes,
              transcript: details.transcript,
              recording: details.recording,
              participants: details.participants,
              home,
              csrf: auth.session.csrfToken,
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            // Review surface (transcript, notes, intelligence): Console shell.
            res.end(await wrapInWorkspaceShell(body, db, tenant, home, auth, 'meetings'));
            return;
          }

          if ((path === '/api/meetings/create' || path === '/api/meetings') && method === 'POST') {
            const auth = await sessionOf();
            if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });

            const raw = await readBody(req);
            let title = 'Untitled Meeting';
            let scope = 'general';
            let recordingEnabled = true;

            const ctype = req.headers['content-type'] ?? '';
            const headerCsrf = req.headers['x-vital-csrf'];
            if (ctype.includes('application/json')) {
              if (!csrfOk(auth.session, typeof headerCsrf === 'string' ? headerCsrf : null)) {
                return json(res, 403, { ok: false, error: 'bad CSRF token' });
              }
              try {
                const body = JSON.parse(raw);
                title = body.title || title;
                scope = body.scope || scope;
                if (typeof body.recordingEnabled === 'boolean') recordingEnabled = body.recordingEnabled;
              } catch {
                /* not JSON — the form fields above already carried the values */
              }
            } else {
              const params = new URLSearchParams(raw);
              const formCsrf = params.get('csrf');
              if (!csrfOk(auth.session, typeof headerCsrf === 'string' && headerCsrf ? headerCsrf : formCsrf)) {
                return json(res, 403, { ok: false, error: 'bad CSRF token' });
              }
              title = params.get('title') || title;
              scope = params.get('scope') || scope;
              recordingEnabled = params.get('recordingEnabled') === '1' || params.get('recordingEnabled') === 'true';
            }
            title = String(title).trim().slice(0, 200) || 'Untitled Meeting';
            scope = /^[a-z0-9-]{2,32}$/.test(String(scope).trim()) ? String(scope).trim() : 'general';

            const meeting = await meetingService.createMeeting(tenant, {
              title,
              scope,
              hostUserId: auth.user.id,
              hostName: auth.user.name,
              recordingEnabled,
            });

            await auditConsole(db, tenant, by(auth.user), 'meeting.create', `meeting:${meeting.id}`, at, meeting.title);

            if (ctype.includes('application/x-www-form-urlencoded')) {
              res.writeHead(303, { location: `${home}console/meetings/${encodeURIComponent(meeting.id)}/room` });
              res.end();
              return;
            }
            return json(res, 200, { ok: true, meeting });
          }

          if ((path === '/api/meetings/list' || path === '/api/meetings') && method === 'GET') {
            const auth = await sessionOf();
            if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });

            const scope = url.searchParams.get('scope') || undefined;
            const status = (url.searchParams.get('status') as any) || undefined;
            const search = url.searchParams.get('search') || undefined;
            const meetings = await meetingService.listMeetings(tenant, { scope, status, search });
            return json(res, 200, { ok: true, meetings });
          }

          // Meeting-specific routes /api/meetings/:id/...
          const meetingRouteMatch = path.match(/^\/api\/meetings\/([^/]+)(?:\/([a-zA-Z0-9_-]+))?$/);
          if (meetingRouteMatch) {
            const auth = await sessionOf();
            if (!auth) return json(res, 401, { ok: false, error: 'authentication required' });
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            // Every meeting mutation is session-authenticated AND carries the
            // session's CSRF token (header on JSON/blob calls): the session
            // cookie alone never authorizes a state change.
            if (method === 'POST') {
              const presented = req.headers['x-vital-csrf'];
              if (!csrfOk(auth.session, typeof presented === 'string' ? presented : null)) {
                return json(res, 403, { ok: false, error: 'bad CSRF token' });
              }
            }

            const meetingId = meetingRouteMatch[1]!;
            const subAction = meetingRouteMatch[2] || '';

            if (!subAction && method === 'GET') {
              const details = await meetingService.getMeetingDetails(tenant, meetingId);
              if (!details) return json(res, 404, { ok: false, error: 'meeting not found' });
              return json(res, 200, { ok: true, ...details });
            }

            if (subAction === 'join' && method === 'POST') {
              const participant = await meetingService.joinMeeting(tenant, meetingId, {
                id: auth.user.id,
                name: auth.user.name,
              });
              return json(res, 200, { ok: true, participant });
            }

            if (subAction === 'leave' && method === 'POST') {
              await meetingService.leaveMeeting(tenant, meetingId, auth.user.id);
              return json(res, 200, { ok: true });
            }

            if (subAction === 'end' && method === 'POST') {
              const meeting = await meetingService.endMeeting(tenant, meetingId, auth.user.id);
              signalingHub.broadcastToRoom(meetingId, {
                type: 'meeting-ended',
                meetingId,
                senderId: auth.user.id,
                senderName: auth.user.name,
                timestamp: Date.now(),
              });
              await auditConsole(
                db,
                tenant,
                by(auth.user),
                'meeting.end',
                `meeting:${meetingId}`,
                at,
                `duration=${meeting.durationSeconds}s`,
              );
              return json(res, 200, { ok: true, meeting });
            }

            if (subAction === 'recording') {
              if (method === 'POST') {
                let rawBytes: Buffer;
                try {
                  rawBytes = await readRawBody(req);
                } catch (e) {
                  if ((e as Error).message.includes('BODY_TOO_LARGE')) {
                    return json(res, 413, { ok: false, error: 'recording exceeds the 50MB cap' });
                  }
                  throw e;
                }
                const durationSec = Number(url.searchParams.get('durationSeconds') ?? 0);
                const formatParam = url.searchParams.get('format') ?? 'webm';
                if (formatParam !== 'webm' && formatParam !== 'wav' && formatParam !== 'mp4') {
                  return json(res, 400, { ok: false, error: 'format must be webm, wav, or mp4' });
                }
                const recording = await meetingService.saveRecording(
                  tenant,
                  meetingId,
                  rawBytes,
                  formatParam,
                  Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
                );
                return json(res, 200, { ok: true, recording });
              }
              if (method === 'GET') {
                const recording = await (
                  await import('../meetings/db.ts')
                ).getRecordingByMeetingId(db, tenant, meetingId);
                if (!recording) return json(res, 404, { ok: false, error: 'no recording for this meeting' });

                let audioBuffer = await meetingService.getRecordingBytes(recording.storageRef);
                if (!audioBuffer) {
                  const { generateSilentWav } = await import('../meetings/service.ts');
                  audioBuffer = generateSilentWav(Math.min(Math.max(recording.durationSeconds || 5, 2), 15));
                }

                res.writeHead(200, {
                  'content-type': `audio/${recording.format}`,
                  'content-length': audioBuffer.length,
                  'cache-control': 'public, max-age=86400',
                });
                res.end(audioBuffer);
                return;
              }
            }

            if (subAction === 'transcript') {
              if (method === 'POST') {
                const raw = await readBody(req);
                let body: Record<string, unknown>;
                try {
                  body = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                  return json(res, 400, { ok: false, error: 'malformed JSON body' });
                }
                const startTime = Number(body.startTime ?? 0);
                const endTime = Number(body.endTime ?? 0);
                const confidence = Number(body.confidence ?? 0.95);
                const text = String(body.text ?? '');
                if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || !Number.isFinite(confidence)) {
                  return json(res, 400, {
                    ok: false,
                    error: 'startTime, endTime and confidence must be finite numbers',
                  });
                }
                if (text.length > 10000) {
                  return json(res, 400, { ok: false, error: 'segment text exceeds the 10000 character limit' });
                }
                const mgr = meetingService.getLiveTranscriptManager(tenant, meetingId);
                const speakerName =
                  typeof body.speakerName === 'string' && body.speakerName.trim()
                    ? body.speakerName.trim().slice(0, 120)
                    : auth.user.name;
                const segment = await mgr.appendSegment({
                  speakerId: typeof body.speakerId === 'string' && body.speakerId ? body.speakerId : auth.user.id,
                  speakerName,
                  startTime,
                  endTime,
                  text,
                  confidence: Math.min(Math.max(confidence, 0), 1),
                });
                return json(res, 200, { ok: true, segment });
              }
              if (method === 'GET') {
                const segments = await listTranscriptSegments(db, tenant, meetingId);
                return json(res, 200, { ok: true, transcript: segments });
              }
            }

            if (subAction === 'process' && method === 'POST') {
              const status = await meetingService.triggerProcessing(tenant, meetingId);
              return json(res, 200, { ok: true, status });
            }

            if ((subAction === 'rag' || subAction === 'ask') && method === 'POST') {
              const raw = await readBody(req);
              const question = readQuestion(raw);
              if (!question.trim()) {
                return json(res, 400, { ok: false, error: 'question required' });
              }
              if (question.trim().length > 4000) {
                return json(res, 400, { ok: false, error: 'question exceeds the 4000 character limit' });
              }
              const result = await meetingService.askQuestion(tenant, meetingId, auth.user.id, question.trim());
              return json(res, 200, {
                ok: true,
                answer: result.answer,
                sources: result.sources,
                found: result.found,
              });
            }

            if (subAction === 'delete' && method === 'POST') {
              const deleted = await meetingService.deleteMeeting(tenant, meetingId);
              await auditConsole(
                db,
                tenant,
                by(auth.user),
                'meeting.delete',
                `meeting:${meetingId}`,
                at,
                `deleted=${deleted}`,
              );
              return json(res, 200, { ok: true, deleted });
            }
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
              actorLabel: actorLabel(auth.user),
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
                await wrapInWorkspaceShell(
                  detailDocument('Skill card', body, { ...detailOpts, hideHeader: true }),
                  db,
                  tenant,
                  home,
                  auth,
                  'learning',
                ),
              );
              return;
            }
            let cardId: string;
            try {
              cardId = decodeURIComponent(learningCard[1]!);
            } catch {
              return json(res, 400, { ok: false, error: 'malformed card id' });
            }
            // The csrf token is what makes the transfer-test form on this page
            // render at all — a GET carries it for a POST that the route table then
            // verifies. `queued` / `compiled` are the one-line receipts the actions
            // redirect back with; `error` is the refusal, which is the useful half.
            const queuedJob = url.searchParams.get('queued');
            const compiledCard = url.searchParams.get('compiled');
            let queueNotice: string | undefined;
            if (queuedJob) {
              queueNotice = `Transfer test queued (job ${queuedJob}). A worker runs it and banks the result.`;
            } else if (compiledCard) {
              queueNotice = 'Card compiled into CANDIDATE — promotion still requires transfer evidence.';
            }
            const body = await renderLearningCardPage(db, comp, tenant, cardId, {
              csrf: auth.session.csrfToken,
              notice: queueNotice,
              error: url.searchParams.get('error') ?? undefined,
            });
            if (!body) return json(res, 404, { ok: false, error: 'skill card not found' });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(
              await wrapInWorkspaceShell(
                detailDocument('Skill card', body, { ...detailOpts, hideHeader: true }),
                db,
                tenant,
                home,
                auth,
                'learning',
              ),
            );
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
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
          // The compliance surfaces — audit log, data & retention, ledger export
          // and the erasure POST — live in routes/compliance.ts with a declared
          // capability, surface and body policy. Nothing in that domain is left
          // in this chain.
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
            res.end(
              await wrapInWorkspaceShell(
                html,
                db,
                tenant,
                home,
                auth,
                'workflows',
                undefined,
                url.searchParams.get('drawer') === '1',
              ),
            );
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
              actorLabel: actorLabel(auth.user),
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
          if (
            method === 'GET' &&
            (path === home || path === '/console' || path === '/console/' || path === '/console/dashboard')
          ) {
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
              const loc = `/console/buzz/${encodeURIComponent(defRoom)}`;
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
            const executor = await renderExecutorBanner(at);
            const activation = renderActivationPanel(activationState, auth.session.csrfToken, home);
            const journey = renderJourneyMilestone(await buildTenantJourney(db, tenant, at), home);
            const review = await renderReview(coord, ledger, {
              tenant,
              actor: by(auth.user),
              actorLabel: actorLabel(auth.user),
              csrf: auth.session.csrfToken,
              canApprove: atLeast(auth.user.role, approverMin),
              requiredRole: approverMin,
              operatorMode: keyAuth ? 'signature' : fallbackMode,
              page: reviewPage,
              home,
            });
            const rawScope = (url.searchParams.get('scope') ?? 'all').toLowerCase();
            const activeDepartment: DashboardDepartment = [
              'all',
              'legal',
              'marketing',
              'finance',
              'engineering',
            ].includes(rawScope)
              ? (rawScope as DashboardDepartment)
              : 'all';
            const rawTab = (url.searchParams.get('tab') ?? 'home').toLowerCase();
            const validTabs = [
              'home',
              'approvals',
              'ledger',
              'workflows',
              'governance',
              'activity',
              'compiler',
              'coordination',
              'router',
              'world',
              'economics',
              'evals',
              'feed',
            ] as const;
            const activeTab = validTabs.includes(rawTab as any) ? (rawTab as (typeof validTabs)[number]) : 'home';
            const deptEvaluations = await roomHealth(db, tenant);

            const compilerParts = await renderCompilerParts(db, comp, tenant);
            const shellMetrics = await shellMetricsFor(db, tenant, {
              dailyBudgetDollars: coord.limits.maxDailyDollars,
            });
            const recencyByScope = await roomRecency(
              db,
              tenant,
              CANONICAL_ROOMS.map((r) => r.scope),
            );

            const bodyStart = report.indexOf('<body>');
            const bodyEnd = report.lastIndexOf('</body>');
            const reportBody = bodyStart !== -1 && bodyEnd !== -1 ? report.slice(bodyStart + 6, bodyEnd) : report;

            const realitySection = `
            <div id="reality-overview" style="margin-top:10px;">
              ${journey}
              ${readiness}
              ${searchHtml}
              ${activation}
              ${review}
              <div style="margin-top:20px;padding-top:16px;">
                ${reportBody}
              </div>
            </div>`;

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

            let dashboardIssues: import('./issues.ts').IssueRow[] = [];
            if (isEngineer(auth.user)) {
              try {
                const snap = await listIssues(db, tenant);
                dashboardIssues = snap.issues;
              } catch {
                dashboardIssues = [];
              }
            }

            const fullDashboard = renderOperationsDashboard({
              tenant,
              userEmail: auth.user.email,
              userRole: auth.user.role,
              userTeam: auth.user.team,
              issues: dashboardIssues,
              csrfToken: auth.session.csrfToken,
              activeDepartment,
              activeTab,
              evaluations: deptEvaluations,
              metrics: shellMetrics,
              recencyByScope,
              compilerBoardHtml: compilerParts.boardHtml,
              compilerRightPanelHtml: compilerParts.rightPanelHtml,
              compilerMetricsHtml: compilerParts.metricsHtml,
              realityHtml: realitySection,
              journeyHtml: journey,
              executorHtml: executor,
              readinessHtml: readiness,
              searchHtml: searchHtml,
              activationHtml: activation,
              reviewHtml: review,
              reportBodyHtml: reportBody,
              consoleNav,
              accountCluster,
            });

            // FLOW-010: the browser cookie tracks the slid DB row

            const refreshed = sessionCookie(auth.session.id, at, secure, auth.session);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': refreshed });
            res.end(fullDashboard);
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

          if (path === '/setup/rooms' && method === 'GET') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (auth.user.mustChangePassword) return redirect(res, '/change-password');
            const notice =
              url.searchParams.get('saved') === 'ok' ? 'Room configuration saved and deployed.' : undefined;
            const html = await renderRoomsSetupPage(db, tenant, auth.session.csrfToken, notice, home);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
          if (path === '/setup/rooms' && method === 'POST') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (activationDenied(res, auth, false)) return;
            // Room policy is spend policy: ceilings gate the hard budget block
            // and autonomy selects the review posture, so only admins mutate it.
            if (!atLeast(auth.user.role, 'admin')) {
              return json(res, 403, { ok: false, error: 'room configuration requires the admin role' });
            }
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
                    category: String(call.fields.newRoomCategory ?? ''),
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
            // One batch for the whole list. This used to be a loop calling
            // `disableConfirmation` per member — four statements per row the page
            // drew, and a `try`/`catch` that would have swallowed a real database
            // error into a silently missing confirmation. The users here come
            // from `data.users`, so the `UNKNOWN_USER` case the single-user call
            // guarded against cannot arise.
            const confirmations = await disableConfirmations(
              db,
              tenant,
              data.users.filter((u) => canDisable(auth.user, u)),
            );
            const q = url.searchParams.get('q') ?? undefined;
            const role = url.searchParams.get('role') ?? undefined;
            const status = url.searchParams.get('status') ?? undefined;
            const teamParam = url.searchParams.get('team') ?? undefined;
            const rawPage = Number(url.searchParams.get('page') ?? '1');
            const pageNum = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
            const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, undefined, {
              home,
              now: at,
              confirmations,
              filter: { q, role, status, team: teamParam, page: pageNum },
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(await teamShelledDocument(html, db, tenant, home, auth));
            return;
          }
          if (method === 'GET' && path === '/team/operations') {
            const auth = await sessionOf();
            if (!auth) return redirectLogin();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            if (auth.user.mustChangePassword) return redirect(res, '/change-password');
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
            const html = teamOperationsPage(auth.session.csrfToken, auth.user, home, {
              stops,
              selfHalts,
              policy: { approverRole: approverMin, operatorMode },
              compilerGaps,
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(await teamShelledDocument(html, db, tenant, home, auth));
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
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
                    team: parseTeam(call.fields.team ?? 'unassigned'),
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
                const exposeInvite = inviteLinkNotice([{ email: invitation.email, link }]);
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
                const msg =
                  e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
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
            const targetTeam = parseTeam(call.fields.team ?? 'unassigned');
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
                    team: targetTeam,
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
                const msg =
                  e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
                failed.push({ email, error: msg });
              }
            }

            const exposeInvite = inviteLinkNotice(
              invited.map((i) => ({
                email: i.email,
                link: `/accept-invite?token=${encodeURIComponent(i.token)}`,
              })),
            );
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
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
              const exposeInvite = inviteLinkNotice([{ email: invitation.email, link }]);
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
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
          if (path === '/team/team' && method === 'POST') {
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
            const data = await teamData();
            try {
              const user = await setUserTeam(
                db,
                tenant,
                call.fields.userId ?? '',
                parseTeam(call.fields.team ?? 'unassigned'),
                { userId: auth.user.id, role: auth.user.role },
                at,
              );
              await auditConsole(db, tenant, by(auth.user), 'team.team', `user:${user.id}`, at, `team=${user.team}`);
              const html = teamPage(
                auth.session.csrfToken,
                auth.user,
                await listUsers(db, tenant),
                data.invitations,
                `${user.email} is now on the ${user.team} team`,
                { home },
              );
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              res.end(html);
            } catch (e) {
              const msg = e instanceof AuthError ? e.message.replace(/^\[auth:[^\]]+\]\s*/, '') : (e as Error).message;
              const html = teamPage(auth.session.csrfToken, auth.user, data.users, data.invitations, undefined, {
                home,
              });
              res.writeHead(e instanceof AuthError && e.code === 'FORBIDDEN' ? 403 : 400, {
                'content-type': 'text/html; charset=utf-8',
              });
              res.end(html.replace('</body>', `<body><p class="err">${esc(msg)}</p>`));
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
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
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
            if (!(await recentAuthGate(db, res, auth.user.id, at, auth.session.createdAt))) return;
            const data = await teamData();
            try {
              const target = await getUser(db, tenant, call.fields.userId ?? '');
              if (!target) return json(res, 404, { ok: false, error: 'no such user' });
              if (target.role === 'owner' && auth.user.role !== 'owner')
                return json(res, 403, { ok: false, error: 'only the owner may disable the owner' });
              if (target.id === auth.user.id)
                return json(res, 400, { ok: false, error: 'you cannot disable yourself' });
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
            if (!atLeast(auth.user.role, 'admin'))
              return json(res, 403, { ok: false, error: 'requires admin or owner' });
            const scope = (call.fields.scope ?? '').trim();
            const actionClass = (call.fields.actionClass ?? '').trim();
            const reason = (call.fields.reason ?? '').trim();
            if (!scope || !actionClass)
              return json(res, 400, { ok: false, error: 'scope and action class are required' });
            if (!reason) {
              const html = teamOperationsPage(
                auth.session.csrfToken,
                auth.user,
                home,
                {},
                'recover failed: a recorded reason is required',
              );
              res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
              res.end(html);
              return;
            }
            try {
              const recovered = await recoverStop(db, tenant, { scope, actionClass }, by(auth.user), {
                reason,
                now: at,
              });
              await auditConsole(
                db,
                tenant,
                by(auth.user),
                'team.stops_recover',
                `${recovered.scope}/${recovered.actionClass}`,
                at,
                reason,
              );
              return redirect(res, '/team/operations');
            } catch (e) {
              const html = teamOperationsPage(
                auth.session.csrfToken,
                auth.user,
                home,
                {},
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
                    ? ((await ledger.getDecision(tenant, decisionId)) ??
                      (await ledger.getDecisionByRequest(tenant, id)))
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
                  throw new Error(
                    `Request is ${request.state}, not awaiting review. Refresh to see its current status.`,
                  );
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
                json(res, 400, {
                  ok: false,
                  error:
                    'type PUBLISH to confirm you are authorizing an external publication — the console records the authorization and publishes nothing itself',
                });
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

          // /api/approval-latency — routes/observability.ts (capability: session).

          // Live event stream (SSE): replays + tails audit_log for Mission Control.
          if (method === 'GET' && path === '/api/events') {
            const auth = await sessionOf();
            if (!auth) return sessionExpiredApi();
            if (auth.user.tenant !== tenant) return json(res, 403, { ok: false, error: 'wrong tenant' });
            const { handleEventStream } = await import('./events.ts');
            handleEventStream(req, res, db, tenant);
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

          // /api/cost-per-signal — routes/observability.ts (capability: session).

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
          // POST /api/requests/:id/refresh-evidence — routes/requests.ts
          // (capability: session, surface: api, body: csrf, activation required).

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
          //    exact (tenant, request, action) — and only on the webhook path.
          //    A token minted to approve request X never authorizes halt,
          //    configure, or command routes. There is no tokenless path.
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
            const isAdmin =
              buzzAuth !== null && buzzAuth.user.tenant === tenant && atLeast(buzzAuth.user.role, 'admin');
            const signedTokenOk =
              path === '/api/buzz/webhook' &&
              typeof providedToken === 'string' &&
              providedToken.length > 0 &&
              reviewTokenValid(providedToken, tenant);
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
            if (
              isAdmin &&
              method === 'POST' &&
              buzzCall &&
              !signedTokenOk &&
              !csrfOk(buzzAuth!.session, buzzCall.csrf)
            ) {
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
            // Token-only approvals are attributed distinctly — a token proves
            // the link was minted, never which human clicked it. Admin sessions
            // attribute the admin instead.
            let actor = buzzAdminUser ? by(buzzAdminUser) : 'human:buzz-review-token';

            if (method === 'POST' && buzzCall) {
              action = (buzzCall.fields.action ?? buzzCall.json?.action ?? token ?? action) as string;
              token = (buzzCall.fields.token ?? buzzCall.json?.token ?? token) as string;
              requestId = (buzzCall.fields.requestId ?? buzzCall.json?.requestId ?? requestId) as string;
              if (buzzCall.json?.forkedParams) forkedParams = buzzCall.json.forkedParams;
              if (buzzCall.fields.actor && buzzAdminUser) actor = by(buzzAdminUser);
            }

            // A signed token proves exactly one thing: someone legitimately minted
            // this (tenant, request, action). It never supplies an actor identity.
            // Tokens additionally bind the reviewed request version and an expiry:
            // legacy tokens without them are refused outright.
            let tokenUpdatedAt: string | undefined;
            if (token) {
              const secret = reviewSecretFromEnv();
              const verified = secret ? verifyReviewToken(token, secret) : { valid: false as const };
              if (verified.valid && verified.tenant === tenant) {
                action = verified.action ?? action;
                requestId = verified.requestId ?? requestId;
                const exp = (verified as { expiresAt?: string }).expiresAt;
                if (!exp || !Number.isFinite(Date.parse(exp)) || Date.parse(exp) <= Date.parse(at)) {
                  return json(res, 401, {
                    ok: false,
                    error:
                      'review token expired or is a legacy token without expiry — open the request review page and approve there',
                    code: 'TOKEN_EXPIRED',
                  });
                }
                tokenUpdatedAt = (verified as { requestUpdatedAt?: string }).requestUpdatedAt || undefined;
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
                themeDocument(
                  `<!DOCTYPE html><html lang="en" data-theme="${DEFAULT_THEME}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${verb} request — Vital</title>${themeHead()}</head><body style="padding:0"><main id="main" style="max-width:560px;margin:0 auto;padding:40px 20px 64px"><div class="utility-bar" style="display:flex;justify-content:flex-end;margin-bottom:18px">${themeToggleButton()}</div><div class="card" style="padding:26px 28px"><span class="v-badge v-badge-warn"><span class="dot"></span>Human decision</span><h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;margin:12px 0 8px;color:var(--v-ink)">${verb} request <code>${esc(requestId)}</code>?</h1><p class="sub" style="color:var(--v-muted);font-size:13.5px;line-height:1.6;margin:0 0 20px">This request is waiting on a human. Confirming records the decision in the audit log.</p><form method="POST" action="/api/buzz/webhook" style="display:grid;gap:12px;max-width:320px"><input type="hidden" name="token" value="${esc(token ?? '')}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="requestId" value="${esc(requestId)}"><button type="submit" class="v-btn ${action === 'decline' ? 'v-btn-danger' : 'v-btn-primary'}">${verb} request</button></form><p style="margin:20px 0 0"><a href="${esc(home)}" class="v-btn v-btn-ghost v-btn-sm">← Return to Mission Control</a></p></div></main></body></html>`,
                ),
              );
              return;
            }
            if (action === 'approve') {
              try {
                const result = await db.transaction(async () => {
                  await db
                    .prepare(
                      `SELECT id FROM requests WHERE tenant = ? AND id = ?${db.engine === 'postgres' ? ' FOR UPDATE' : ''}`,
                    )
                    .get(tenant, requestId);
                  const request = await coord.get(tenant, requestId);
                  if (!request) throw new Error(`unknown request ${requestId}`);
                  // Tenant-bound full-hash decision id with a buzz prefix, so a
                  // console decision and a buzz decision for one request never
                  // collide and replays return the original receipt.
                  const decisionId = `dec_buzz_${createHash('sha256')
                    .update(JSON.stringify([tenant, requestId]))
                    .digest('hex')}`;
                  const existing =
                    (await ledger.getDecision(tenant, decisionId)) ??
                    (await ledger.getDecisionByRequest(tenant, requestId));
                  if (existing && request.state !== 'ADMITTED') {
                    return {
                      state: request.state,
                      by: existing.approvedBy,
                      decisionId: existing.id,
                      decisionUrl: `/console/decisions/${encodeURIComponent(existing.id)}`,
                      latencySeconds: null,
                      repeated: true as boolean,
                      specFingerprint: null as string | null,
                      requestUpdatedAt: request.updatedAt,
                    };
                  }
                  if (request.state !== 'ADMITTED')
                    throw new Error(
                      `Request is ${request.state}, not awaiting review. Refresh to see its current status.`,
                    );
                  // The token must carry the reviewed version — approving blind
                  // (no bound version) is exactly the TOCTOU this gate closes.
                  if (!tokenUpdatedAt) {
                    throw new ExecutionSpecError(
                      'STALE_REVIEW',
                      'this approval link carries no reviewed request version — open the request review page and approve there',
                      { requiresReReview: true },
                    );
                  }
                  assertFreshReview(request, tokenUpdatedAt);
                  const executionSpec = await validateApprovalBoundary(ledger, request, at, {
                    expectedRequestUpdatedAt: tokenUpdatedAt,
                  });
                  const decision = await ledger.recordDecision({
                    id: decisionId,
                    tenant,
                    goal: request.goal,
                    action: serializeExecutionSpec(executionSpec),
                    actionClass: 'RECOMMEND',
                    claimIds: request.claimRefs,
                    decidedBy: actor,
                    approvedBy: actor,
                    scope: request.targetScope,
                    autonomy: 'approval',
                    requestId,
                    now: at,
                  });
                  const next = await coord.accept(tenant, requestId);
                  await recordReviewOutcome(db, tenant, {
                    requestId,
                    scope: request.targetScope,
                    actionClass: 'RECOMMEND',
                    approved: true,
                    reviewer: actor,
                    now: at,
                  });
                  await auditConsole(db, tenant, actor, 'buzz.approve', `request:${requestId}`, at);
                  let latencySeconds: number | null;
                  try {
                    latencySeconds = await db.transaction(
                      async () => (await coord.recordApprovalLatency(tenant, requestId, action, actor, at)).seconds,
                    );
                  } catch {
                    latencySeconds = null;
                  }
                  return {
                    state: next.state,
                    by: actor,
                    decisionId: decision.id,
                    decisionUrl: `/console/decisions/${encodeURIComponent(decision.id)}`,
                    latencySeconds,
                    repeated: false as boolean,
                    specFingerprint: executionSpec.fingerprint,
                    requestUpdatedAt: request.updatedAt,
                  };
                });
                if (result.state === 'ACCEPTED' && !result.repeated) {
                  await recordFirstReviewAt(db, tenant, at);
                }
                return json(res, 200, { ok: true, action: 'approve', requestId, ...result });
              } catch (e) {
                const code = e instanceof ExecutionSpecError ? e.code : undefined;
                if ((e as Error).message.startsWith('unknown request')) {
                  return json(res, 404, { ok: false, error: (e as Error).message });
                }
                return json(res, 409, {
                  ok: false,
                  error: (e as Error).message,
                  ...(code ? { code, ...(e instanceof ExecutionSpecError ? e.detail : {}) } : {}),
                });
              }
            }

            if (action === 'decline') {
              try {
                const current = await coord.get(tenant, requestId);
                if (!current) return json(res, 404, { ok: false, error: `unknown request ${requestId}` });
                // Declining a stale page refuses different content than reviewed.
                if (tokenUpdatedAt) assertFreshReview(current, tokenUpdatedAt);
                if (current.state === 'ADMITTED') {
                  await coord.decline(tenant, requestId, 'Declined via Buzz review card');
                  await recordReviewOutcome(db, tenant, {
                    requestId,
                    scope: current.targetScope,
                    actionClass: 'RECOMMEND',
                    approved: false,
                    reviewer: actor,
                    reason: 'Declined via Buzz review card',
                    now: at,
                  });
                  await auditConsole(db, tenant, actor, 'buzz.decline', `request:${requestId}`, at);
                }
                return json(res, 200, { ok: true, action: 'decline', requestId, status: 'DECLINED' });
              } catch (e) {
                const code = e instanceof ExecutionSpecError ? e.code : undefined;
                return json(res, 409, {
                  ok: false,
                  error: (e as Error).message,
                  ...(code ? { code, ...(e instanceof ExecutionSpecError ? e.detail : {}) } : {}),
                });
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
            // Config and gauge are whole-tenant reads, not per-room ones: this
            // endpoint used to issue three statements for each room it listed.
            // Both lookups hit by construction: `evaluateAll` enumerates the
            // same room set, and a gauge is computed for every scope it lists.
            const configs = await loadTenantRooms(db, tenant);
            const gauges = await gaugeTracker.computeGauges(allHealth.map((h) => h.scope));
            const rooms = allHealth.map((h) => ({
              ...h,
              config: configs.get(h.scope)!.config,
              gauge: gauges.get(h.scope)!,
            }));
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
            if (body.mission) updates.mission = String(body.mission).slice(0, 2000);
            if (body.autonomy && ['autonomous', 'guarded', 'supervised'].includes(String(body.autonomy))) {
              updates.autonomy = String(body.autonomy);
            }
            const apiBudget = Number(body.budgetCeilingDollars);
            if (body.budgetCeilingDollars && Number.isFinite(apiBudget) && apiBudget > 0) {
              if (apiBudget > ROOM_BUDGET_MAX_DOLLARS) {
                return json(res, 400, { ok: false, error: 'budget ceiling exceeds the cap' });
              }
              updates.budgetCeilingDollars = apiBudget;
            }
            const apiTokens = Number(body.budgetCeilingTokens);
            if (body.budgetCeilingTokens && Number.isFinite(apiTokens) && apiTokens > 0) {
              if (apiTokens > ROOM_BUDGET_MAX_TOKENS) {
                return json(res, 400, { ok: false, error: 'token ceiling exceeds the cap' });
              }
              updates.budgetCeilingTokens = apiTokens;
            }
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

          // Agent SVG mascot images (accessible with or without siteDir)
          if (method === 'GET' && (path.startsWith('/assets/agents/') || path.startsWith('/agents_images/'))) {
            const rawName = path.replace(/^\/(assets\/agents|agents_images)\//, '');
            const fileName = basename(rawName);
            if (/\.(svg|png|webp|jpg|jpeg|gif)$/i.test(fileName)) {
              const target = resolvePath(process.cwd(), 'site', 'assets', 'agents', fileName);
              try {
                const st = await stat(target);
                if (st.isFile()) {
                  const body = await readFile(target);
                  const type = MIME[extname(target)] ?? 'image/svg+xml';
                  res.writeHead(200, {
                    'content-type': type,
                    'cache-control': 'public, max-age=86400, immutable',
                  });
                  res.end(body);
                  return;
                }
              } catch {
                // fall through
              }
            }
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
        },
        { memoize: readsOnly, stats },
      ).catch((err) => {
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
      server.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url ?? '/', 'http://console');
        if (u.pathname.startsWith('/api/meetings/signal')) {
          wsUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });
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
              const loopbackHost =
                publicBind || boundHost === '0.0.0.0' || boundHost === '::' ? '127.0.0.1' : boundHost;
              const probeUrl = `http://${loopbackHost}:${boundPort}/healthz`;
              const probe = new URL(probeUrl);
              const req = httpRequest(probe);
              const timer = setTimeout(() => {
                req.destroy();
                resoleReady({
                  ok: false,
                  status: 'failed',
                  detail: 'readiness probe timed out — console not answering yet',
                });
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
