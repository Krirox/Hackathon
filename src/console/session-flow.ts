import type { IncomingMessage } from 'node:http';
import type { Session } from '../core/auth.ts';
import { sessionRemainingMs } from '../core/auth.ts';

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
