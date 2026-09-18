import type { IncomingMessage } from 'node:http';
import type { Session } from '../core/auth.ts';
import { SESSION_ABSOLUTE_TTL_MS, SESSION_TTL_MS, sessionRemainingMs } from '../core/auth.ts';

/** Same-origin relative paths only — blocks open redirects. */
export function safeReturnPath(next: string | null | undefined): string | undefined {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return undefined;
  return next;
}

export type LoginReason = 'expired' | 'reset';

/** Build a login URL preserving a safe return destination. */
export function loginPath(opts: { next?: string; reason?: LoginReason; reset?: boolean } = {}): string {
  const params = new URLSearchParams();
  const next = safeReturnPath(opts.next);
  if (next) params.set('next', next);
  if (opts.reason === 'expired') params.set('reason', 'expired');
  if (opts.reset) params.set('reset', 'ok');
  const q = params.toString();
  return q ? `/login?${q}` : '/login';
}

/** JSON body for API callers when a session is missing or expired. */
export function sessionExpiredPayload(returnPath?: string): {
  ok: false;
  code: 'SESSION_EXPIRED';
  error: string;
  loginUrl: string;
} {
  const next = safeReturnPath(returnPath);
  return {
    ok: false,
    code: 'SESSION_EXPIRED',
    error: 'Your session expired. Sign in to continue.',
    loginUrl: loginPath({ next, reason: 'expired' }),
  };
}

/** Form posts (not JSON API calls) should receive HTML error pages. */
export function isBrowserForm(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'] ?? '';
  return !ct.includes('application/json');
}

/** Cookie Max-Age aligned with the database session row. */
export function sessionCookieMaxAge(session: Session, now: string): number {
  return Math.max(0, Math.floor(sessionRemainingMs(session, now) / 1000));
}

export interface SessionLifetimeGuidance {
  idleMs: number;
  absoluteMs: number;
  idleLabel: string;
  absoluteLabel: string;
  cookie: string;
}

export function sessionLifetimeGuidance(): SessionLifetimeGuidance {
  return {
    idleMs: SESSION_TTL_MS,
    absoluteMs: SESSION_ABSOLUTE_TTL_MS,
    idleLabel: 'sessions expire after 12 hours without activity',
    absoluteLabel: 'sessions expire 7 days after sign-in regardless of activity',
    cookie: 'the browser cookie Max-Age tracks the database session row',
  };
}

const NON_RETAINABLE_RE =
  /password|passwd|passkey|secret|token|signature|csrf|credential|apikey|privatekey|authorization|mnemonic/i;

export function isRetainableField(name: string): boolean {
  if (!name) return false;
  return !NON_RETAINABLE_RE.test(name);
}

export function retainDraftFields(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!isRetainableField(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface ReauthResume {
  notice: string;
  loginUrl: string;
  requiresResubmission: boolean;
  replaysApprovals: boolean;
}

export function reauthResume(returnPath?: string): ReauthResume {
  const next = safeReturnPath(returnPath);
  return {
    notice: 'Sign in to continue. Review the form and submit it again — approvals are never replayed automatically.',
    loginUrl: loginPath({ next, reason: 'expired' }),
    requiresResubmission: true,
    replaysApprovals: false,
  };
}

export interface PreSessionGuidance {
  pattern: string;
  multiTab: string;
  expiredForm: string;
}

export function preSessionGuidance(): PreSessionGuidance {
  return {
    pattern: 'sign-in forms use a double-submit cookie token issued per page load',
    multiTab: 'several open sign-in tabs stay valid — each form carries its own token',
    expiredForm: 'a form that lost its token says the form expired — reload for a fresh form and try again',
  };
}

export type FormErrorKind = 'validation' | 'csrf-expired' | 'rate-limited';

export interface FormErrorShape {
  status: number;
  code: string;
  message: string;
  retryAfterMs: number | null;
  retainValues: boolean;
}

export function formErrorShape(kind: FormErrorKind, opts: { retryAfterMs?: number } = {}): FormErrorShape {
  if (kind === 'rate-limited')
    return {
      status: 429,
      code: 'RATE_LIMITED',
      message: 'too many attempts — wait before trying again',
      retryAfterMs: opts.retryAfterMs ?? 10 * 60 * 1000,
      retainValues: true,
    };
  if (kind === 'csrf-expired')
    return {
      status: 400,
      code: 'FORM_EXPIRED',
      message: 'this form expired — reload the page for a fresh form and try again',
      retryAfterMs: null,
      retainValues: true,
    };
  return {
    status: 400,
    code: 'INVALID_INPUT',
    message: 'check the highlighted fields and try again',
    retryAfterMs: null,
    retainValues: true,
  };
}

export type PasswordChangeKind = 'forced' | 'voluntary';

export function passwordChangeKind(user: { mustChangePassword: boolean }): PasswordChangeKind {
  if (user.mustChangePassword) return 'forced';
  return 'voluntary';
}

export interface PasswordChangeResult {
  heading: string;
  sessionNote: string;
  nextStep: string;
  signInAgain: boolean;
}

export function passwordChangeResult(kind: PasswordChangeKind): PasswordChangeResult {
  if (kind === 'forced')
    return {
      heading: 'Account activated',
      sessionNote: 'activation revoked every session issued before the change',
      nextStep: 'Sign in with the new password to continue.',
      signInAgain: true,
    };
  return {
    heading: 'Password changed',
    sessionNote: 'saving a new password signed out every other session',
    nextStep: 'Sign in again on this device with the new password.',
    signInAgain: true,
  };
}

export type AccountNavKey = 'account' | 'team';

export interface AccountNavItem {
  key: AccountNavKey;
  href: string;
  label: string;
  active: boolean;
}

export function accountNav(current: AccountNavKey): AccountNavItem[] {
  return [
    { key: 'account', href: '/account', label: 'Account and security', active: current === 'account' },
    { key: 'team', href: '/team', label: 'Team', active: current === 'team' },
  ];
}
