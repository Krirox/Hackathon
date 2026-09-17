import { T, eq } from './helpers.ts';
import { loginPath, safeReturnPath, sessionExpiredPayload } from '../src/console/session-flow.ts';

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
