import { T, eq } from './helpers.ts';
import {
  accountNav,
  formErrorShape,
  isRetainableField,
  loginPath,
  passwordChangeKind,
  passwordChangeResult,
  preSessionGuidance,
  reauthResume,
  retainDraftFields,
  safeReturnPath,
  sessionCookieMaxAge,
  sessionExpiredPayload,
  sessionLifetimeGuidance,
} from '../src/console/session-flow.ts';
import { SESSION_ABSOLUTE_TTL_MS, SESSION_TTL_MS } from '../src/core/auth.ts';

console.log('\n\x1b[1mSession flow — FLOW-010 helpers\x1b[0m');

T('safeReturnPath blocks open redirects', () => {
  eq(safeReturnPath('/console/claims/c1'), '/console/claims/c1');
  eq(safeReturnPath('//evil.test/phish'), undefined);
  eq(safeReturnPath('https://evil.test'), undefined);
  eq(safeReturnPath(undefined), undefined);
});

T('loginPath preserves next and expiry reason', () => {
  eq(loginPath({ next: '/console', reason: 'expired' }), '/login?next=%2Fconsole&reason=expired');
  eq(loginPath({ reset: true }), '/login?reset=ok');
});

T('sessionExpiredPayload returns sign-in-to-continue contract', () => {
  const body = sessionExpiredPayload('/console/requests/r1');
  eq(body.ok, false);
  eq(body.code, 'SESSION_EXPIRED');
  eq(body.error.includes('Sign in to continue'), true);
  eq(body.loginUrl.includes('reason=expired'), true);
  eq(body.loginUrl.includes('next=%2Fconsole%2Frequests%2Fr1'), true);
});

T('FLOW-010: session lifetime guidance aligns DB and cookie', () => {
  const g = sessionLifetimeGuidance();
  eq(g.idleMs, SESSION_TTL_MS);
  eq(g.absoluteMs, SESSION_ABSOLUTE_TTL_MS);
  eq(g.absoluteMs > g.idleMs, true);
  eq(g.cookie.includes('cookie'), true);
  const session = {
    id: 'tok',
    userId: 'usr_1',
    tenant: 'acme',
    csrfToken: 'c'.repeat(64),
    createdAt: '2026-09-09T12:00:00.000Z',
    expiresAt: '2026-09-10T00:00:00.000Z',
  };
  eq(sessionCookieMaxAge(session, '2026-09-09T12:00:00.000Z'), Math.floor(SESSION_TTL_MS / 1000));
  eq(sessionCookieMaxAge(session, '2026-09-10T00:00:01.000Z'), 0);
});

T('FLOW-010: draft retention never keeps secrets', () => {
  eq(isRetainableField('goal'), true);
  eq(isRetainableField('summary'), true);
  eq(isRetainableField('password'), false);
  eq(isRetainableField('newPassword'), false);
  eq(isRetainableField('operatorSecret'), false);
  eq(isRetainableField('signature'), false);
  eq(isRetainableField('csrf'), false);
  eq(isRetainableField('token'), false);
  eq(isRetainableField('apiKey'), false);
  eq(isRetainableField(''), false);
  const kept = retainDraftFields({
    goal: 'ship it',
    scope: 'engineering',
    password: 'correct horse battery staple',
    csrf: 'abc123',
    signature: 'deadbeef',
    operatorSecret: 'hunter2-hunter2',
    missing: undefined,
  });
  eq(kept, { goal: 'ship it', scope: 'engineering' });
});

T('FLOW-010: reauth resume requires resubmission and never replays approvals', () => {
  const r = reauthResume('/console/requests/r1');
  eq(r.requiresResubmission, true);
  eq(r.replaysApprovals, false);
  eq(r.notice.includes('Sign in to continue'), true);
  eq(r.notice.includes('never replayed'), true);
  eq(r.loginUrl.includes('reason=expired'), true);
  eq(r.loginUrl.includes('next=%2Fconsole%2Frequests%2Fr1'), true);
  eq(reauthResume('//evil.test').loginUrl.includes('next='), false);
});

T('FLOW-010: pre-session guidance keeps multiple tabs valid', () => {
  const g = preSessionGuidance();
  eq(g.multiTab.includes('stay valid'), true);
  eq(g.expiredForm.includes('reload'), true);
});

T('FLOW-010: browser form errors carry status, message, and retry timing', () => {
  const invalid = formErrorShape('validation');
  eq(invalid.status, 400);
  eq(invalid.code, 'INVALID_INPUT');
  eq(invalid.retryAfterMs, null);
  eq(invalid.retainValues, true);
  const expired = formErrorShape('csrf-expired');
  eq(expired.status, 400);
  eq(expired.code, 'FORM_EXPIRED');
  eq(expired.message.includes('reload'), true);
  const limited = formErrorShape('rate-limited', { retryAfterMs: 60_000 });
  eq(limited.status, 429);
  eq(limited.code, 'RATE_LIMITED');
  eq(limited.retryAfterMs, 60_000);
  eq(limited.message.includes('wait'), true);
  eq(formErrorShape('rate-limited').retryAfterMs !== null, true);
});

T('FLOW-010: password change kind and result separate forced activation from voluntary change', () => {
  eq(passwordChangeKind({ mustChangePassword: true }), 'forced');
  eq(passwordChangeKind({ mustChangePassword: false }), 'voluntary');
  const forced = passwordChangeResult('forced');
  eq(forced.heading.includes('activated'), true);
  eq(forced.signInAgain, true);
  eq(forced.nextStep.includes('Sign in'), true);
  const voluntary = passwordChangeResult('voluntary');
  eq(voluntary.heading.includes('Password changed'), true);
  eq(voluntary.sessionNote.includes('every other session'), true);
  eq(voluntary.signInAgain, true);
});

T('FLOW-010: account nav exposes account and team destinations', () => {
  const nav = accountNav('account');
  eq(
    nav.map((n) => n.href),
    ['/account', '/team'],
  );
  eq(nav[0]!.active, true);
  eq(nav[1]!.active, false);
  eq(accountNav('team')[1]!.active, true);
});
