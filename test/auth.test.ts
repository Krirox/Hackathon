import { T, eq, rejects, fresh, TEN, NOW, sor, base } from './helpers.ts';
import type { AsyncDb } from '../src/core/db.ts';
import {
  installAuthSchema,
  uninstallAuthSchema,
  signupTenant,
  getTenant,
  acceptInvitation,
  changeUserRole,
  countOutstandingWork,
  createAccountNotice,
  createInvitation,
  disableConfirmation,
  disableConfirmations,
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
  sessionUser,
  verifySession,
  logout,
  revokeUserSessions,
  disableUser,
  sweepSessions,
  changePassword,
  claimTenantOwner,
  requestPasswordReset,
  confirmPasswordReset,
  tryPasswordReset,
  tenantAccessState,
  operatorSetPassword,
  hashPassword,
  verifyPassword,
  atLeast,
  requireRole,
  canGrantRole,
  grantableRoles,
  assertGrantRole,
  assertAccountActivated,
  isLoopbackAddress,
  signupRequiresSetupSecret,
  setupSecretOk,
  csrfOk,
  sessionCookie,
  LOCKOUT_THRESHOLD,
  MIN_PASSWORD_LENGTH,
  type Role,
} from '../src/core/auth.ts';
import { startConsoleServer, LOGIN_RATE, prepareCoHostedSiteHtml, type ConsoleServer } from '../src/console/serve.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';

console.log('\n\x1b[1mAuth — identity, tenancy, and the session that names a human\x1b[0m');

const SIGNUP = {
  slug: 'acme',
  name: 'Acme Inc',
  email: 'owner@acme.test',
  password: 'correct horse battery staple',
  ownerName: 'Ada Owner',
};

/** A fresh world with auth tables + one signed-up tenant and its owner. */
async function authed() {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const { tenant, owner } = await signupTenant(ctx.db, SIGNUP, NOW);
  return { ...ctx, tenant, owner };
}

/** Login helper returning user + session + token + a Cookie header value. */
async function loginCookie(db: AsyncDb, email: string, password: string) {
  const { user, session, token } = await login(db, { tenant: TEN, email, password }, NOW);
  return { user, session, token, cookie: sessionCookie(token, NOW) };
}

function csrfFrom(cookie: string, html: string): string {
  void cookie;
  const m = html.match(/name="vital-csrf" content="([0-9a-f]+)"/);
  if (!m) throw new Error('no csrf meta tag in page');
  return m[1]!;
}

// ------------------------------------------------------------- migrations ----

T('auth migrations apply, are idempotent, and roll back clean', async () => {
  const { db } = await fresh();
  const first = await installAuthSchema(db, NOW);
  eq(first.includes('0001_auth_core'), true);
  const second = await installAuthSchema(db, NOW);
  eq(second.length, 0, 'second apply is a no-op:');
  await uninstallAuthSchema(db);
  const t = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  eq(t, undefined, 'down migration dropped the users table:');
  await installAuthSchema(db, NOW);
});

// -------------------------------------------------------------- passwords ----

T('passwords are salted scrypt and never comparable', async () => {
  const a = hashPassword('correct horse battery staple');
  const b = hashPassword('correct horse battery staple');
  eq(a === b, false, 'same password, different salt:');
  eq(verifyPassword('correct horse battery staple', a), true);
  eq(verifyPassword('wrong password entirely', a), false);
  eq(verifyPassword('x', 'garbage'), false, 'malformed stored hash verifies false, never throws:');
  rejects(() => hashPassword('short'), 'WEAK_PASSWORD');
  eq(MIN_PASSWORD_LENGTH >= 12, true, 'the floor is 12+ chars:');
});

// ----------------------------------------------------------------- signup ----

T('signup creates a tenant and its owner in one transaction', async () => {
  const { db, tenant, owner } = await authed();
  eq(tenant.slug, TEN);
  eq(owner.role, 'owner');
  eq(owner.email, 'owner@acme.test');
  eq((await getTenant(db, TEN))?.name, 'Acme Inc');
  const audits = await db.prepare('SELECT action FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN);
  const actions = audits.map((r) => String((r as { action: string }).action));
  eq(actions.includes('auth.tenant_created'), true, 'tenant creation audited:');
  eq(actions.includes('auth.user_created'), true, 'owner creation audited:');
});

T('signup validates and refuses duplicate tenants and malformed input', async () => {
  const { db } = await authed();
  rejects(() => signupTenant(db, SIGNUP, NOW), 'TENANT_EXISTS');
  rejects(() => signupTenant(db, { ...SIGNUP, slug: 'Bad_Slug' }, NOW), 'BAD_SLUG');
  rejects(() => signupTenant(db, { ...SIGNUP, slug: 'ok', email: 'not-an-email' }, NOW), 'BAD_EMAIL');
  rejects(() => signupTenant(db, { ...SIGNUP, slug: 'ok', password: 'short' }, NOW), 'WEAK_PASSWORD');
  rejects(() => signupTenant(db, { ...SIGNUP, slug: 'ok', ownerName: '' }, NOW), 'BAD_NAME');
});

// ----------------------------------------------------------------- invites ----

T('membership is invite-only and roles gate who may invite', async () => {
  const { db, owner } = await authed();
  const invited = await inviteUser(
    db,
    TEN,
    { email: 'dev@acme.test', name: 'Dev Member', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq(invited.mustChangePassword, true, 'invited users must change their password:');
  const users = await listUsers(db, TEN);
  eq(users.length, 2);
  // A member cannot invite.
  await rejects(
    () =>
      inviteUser(
        db,
        TEN,
        { email: 'x@acme.test', name: 'X', role: 'member', password: 'another-long-password' },
        { userId: invited.id, role: 'member' },
        NOW,
      ),
    'FORBIDDEN',
  );
  // An admin can.
  const admin = await inviteUser(
    db,
    TEN,
    { email: 'admin@acme.test', name: 'An Admin', role: 'admin', password: 'a-long-admin-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await inviteUser(
    db,
    TEN,
    { email: 'y@acme.test', name: 'Y', role: 'member', password: 'another-long-password' },
    { userId: admin.id, role: admin.role },
    NOW,
  );
  eq((await listUsers(db, TEN)).length, 4);
});

// ------------------------------------------------------------------- login ----

T('login stamps last_login_at; must-change survives login until the password actually changes', async () => {
  const { db, owner } = await authed();
  await db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(owner.id);
  const { user } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  eq(user.id, owner.id);
  const row = (await db
    .prepare('SELECT last_login_at, must_change_password FROM users WHERE id = ?')
    .get(owner.id)) as {
    last_login_at: string;
    must_change_password: number;
  };
  eq(row.last_login_at, NOW);
  eq(
    row.must_change_password,
    1,
    'logging in does not retire the gate — changing the password does (see changePassword test):',
  );
});

T('login fails closed: wrong password, unknown user — one message for both', async () => {
  const { db } = await authed();
  await rejects(
    () => login(db, { tenant: TEN, email: 'owner@acme.test', password: 'not the password' }, NOW),
    'BAD_CREDENTIALS',
  );
  await rejects(
    () => login(db, { tenant: TEN, email: 'ghost@acme.test', password: 'whatever-long' }, NOW),
    'BAD_CREDENTIALS',
  );
  await rejects(
    () => login(db, { tenant: 'other', email: 'owner@acme.test', password: SIGNUP.password }, NOW),
    'BAD_CREDENTIALS',
    'another tenant cannot log in here:',
  );
});

T('failed logins lock the key after the threshold, then unlock', async () => {
  const { db } = await authed();
  const bad = { tenant: TEN, email: 'owner@acme.test', password: 'wrong-password-here' };
  for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
    await rejects(() => login(db, bad, NOW), 'BAD_CREDENTIALS');
  }
  // 6th attempt is now locked, even with the CORRECT password.
  await rejects(
    () => login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW),
    'LOCKED',
    'a locked key rejects correct credentials too:',
  );
  // A different email is not locked (the key is per tenant+ip+email).
  await rejects(
    () => login(db, { tenant: TEN, email: 'ghost@acme.test', password: 'wrong-password-here' }, NOW),
    'BAD_CREDENTIALS',
  );
  // After the lockout window (clock moves), the correct password works again.
  const later = new Date(Date.parse(NOW) + 16 * 60 * 1000).toISOString();
  const { user } = await login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, later);
  eq(user.email, 'owner@acme.test');
});

// ---------------------------------------------------------------- sessions ----

T('sessions verify, roll their expiry, and die at expiry', async () => {
  const { db } = await authed();
  const { token } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  const s1 = await verifySession(db, token, NOW);
  const later = new Date(Date.parse(NOW) + 60 * 1000).toISOString();
  const s2 = await verifySession(db, token, later);
  eq(s2.expiresAt > s1.expiresAt, true, 'sliding window re-arms:');
  const dead = new Date(Date.parse(NOW) + 13 * 60 * 60 * 1000).toISOString();
  await rejects(() => verifySession(db, token, dead), 'EXPIRED_SESSION');
  eq(await db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get(), { n: 0 }, 'expired session swept on read:');
  await rejects(() => verifySession(db, 'no-such-token', NOW), 'NO_SESSION');
});

T('FLOW-010: absolute session cap expires even when idle window would extend', async () => {
  const { db } = await authed();
  const { token, session } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  const touched = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
  await verifySession(db, token, touched);
  const beyondAbsolute = new Date(Date.parse(session.createdAt) + 7 * 24 * 60 * 60 * 1000 + 1000).toISOString();
  await rejects(() => verifySession(db, token, beyondAbsolute), 'EXPIRED_SESSION');
});

T('logout revokes exactly once; revoked sessions are NO_SESSION', async () => {
  const { db } = await authed();
  const { token } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  await logout(db, token, NOW);
  await rejects(() => verifySession(db, token, NOW), 'NO_SESSION');
  await logout(db, token, NOW); // idempotent, no audit spam
  const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.logout'").get();
  eq(Number((audits as { n: number }).n), 1, 'exactly one logout event:');
});

T('disableUser and revokeUserSessions kill every live session', async () => {
  const { db, owner } = await authed();
  await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  const n = await revokeUserSessions(db, TEN, owner.id, NOW);
  eq(n, 2);
  const rows = await db.prepare('SELECT revoked_at FROM auth_sessions').all();
  eq(
    rows.every((r) => (r as { revoked_at: string }).revoked_at !== null),
    true,
  );
  const member = await inviteUser(
    db,
    TEN,
    { email: 'dev@acme.test', name: 'Dev', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const { token: memberToken } = await loginCookie(db, 'dev@acme.test', 'a-long-member-password');
  await disableUser(db, TEN, member.id, NOW);
  await rejects(
    () => login(db, { tenant: TEN, email: 'dev@acme.test', password: 'a-long-member-password' }, NOW),
    'BAD_CREDENTIALS',
  );
  await rejects(() => sessionUser(db, memberToken, NOW), 'NO_SESSION');
});

T('disabled users lose their sessions mid-flight', async () => {
  const { db, owner } = await authed();
  const member = await inviteUser(
    db,
    TEN,
    { email: 'dev@acme.test', name: 'Dev', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const { token } = await loginCookie(db, 'dev@acme.test', 'a-long-member-password');
  await sessionUser(db, token, NOW); // live
  await disableUser(db, TEN, member.id, NOW);
  await rejects(() => sessionUser(db, token, NOW), 'NO_SESSION');
});

T('sweepSessions drops expired sessions and stale attempt counters', async () => {
  const { db } = await authed();
  const { token } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  const yesterday = new Date(Date.parse(NOW) - 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.parse(NOW) - 1000).toISOString(), token);
  await db
    .prepare("INSERT INTO login_attempts (key, day, fails, locked_until, updated_at) VALUES ('k', ?, 4, NULL, ?)")
    .run(yesterday.slice(0, 10), yesterday);
  await sweepSessions(db, NOW);
  eq(await db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get(), { n: 0 });
  eq(await db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get(), { n: 0 });
});

// ------------------------------------------------------- password changes ----

T('changePassword revokes all sessions and clears the must-change flag', async () => {
  const { db, owner } = await authed();
  const { token } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  await changePassword(db, TEN, owner.id, 'a much better password now', NOW);
  await rejects(() => verifySession(db, token, NOW), 'NO_SESSION', 'old session dead:');
  const row = (await db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(owner.id)) as {
    must_change_password: number;
  };
  eq(row.must_change_password, 0);
  const { user } = await login(
    db,
    { tenant: TEN, email: 'owner@acme.test', password: 'a much better password now' },
    NOW,
  );
  eq(user.id, owner.id, 'the new password logs in:');
  await rejects(() => changePassword(db, TEN, owner.id, 'short', NOW), 'WEAK_PASSWORD');
});

T('password reset tokens are single-use, hashed at rest, and expiring', async () => {
  const { db, owner } = await authed();
  const { token: session } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  const reset = await requestPasswordReset(db, TEN, 'owner@acme.test', NOW);
  eq(reset.length > 20, true);
  const stored = (await db.prepare('SELECT token_hash FROM password_resets').all()) as { token_hash: string }[];
  eq(
    stored.some((r) => r.token_hash.includes(reset)),
    false,
    'the token is never stored raw:',
  );
  await confirmPasswordReset(db, reset, 'the reset password here', NOW);
  await rejects(() => confirmPasswordReset(db, reset, 'x'.repeat(20), NOW), 'BAD_RESET_TOKEN', 'single use:');
  await rejects(
    () => login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW),
    'BAD_CREDENTIALS',
  );
  const { user } = await login(db, { tenant: TEN, email: 'owner@acme.test', password: 'the reset password here' }, NOW);
  eq(user.id, owner.id);
  await rejects(() => verifySession(db, session, NOW), 'NO_SESSION', 'reset killed the old session:');
  // expiring + unknown tokens
  const reset2 = await requestPasswordReset(db, TEN, 'owner@acme.test', NOW);
  const later = new Date(Date.parse(NOW) + 20 * 60 * 1000).toISOString();
  await rejects(() => confirmPasswordReset(db, reset2, 'another reset password', later), 'BAD_RESET_TOKEN');
  await rejects(() => confirmPasswordReset(db, 'nope', 'another reset password', NOW), 'BAD_RESET_TOKEN');
  await rejects(() => requestPasswordReset(db, TEN, 'ghost@acme.test', NOW), 'UNKNOWN_USER');
});

// ------------------------------------------------------------------- roles ----

T('roles rank, gate, and fail closed', async () => {
  eq(atLeast('owner', 'admin'), true);
  eq(atLeast('admin', 'admin'), true);
  eq(atLeast('member', 'admin'), false);
  requireRole('admin', 'member');
  requireRole('owner', 'admin');
  await rejects(() => requireRole('member', 'admin'), 'FORBIDDEN');
  // An unrecognized role fails closed (cannot rank above anything).
  await rejects(() => requireRole('unknown' as Role, 'member'), 'FORBIDDEN');
});

T('FLOW-007: role-grant matrix is enforced in core authorization', async () => {
  eq(canGrantRole('owner', 'owner'), true);
  eq(canGrantRole('owner', 'admin'), true);
  eq(canGrantRole('owner', 'member'), true);
  eq(canGrantRole('admin', 'admin'), true);
  eq(canGrantRole('admin', 'member'), true);
  eq(canGrantRole('admin', 'owner'), false);
  eq(canGrantRole('member', 'member'), false);
  eq(grantableRoles('owner').join(','), 'member,admin,owner');
  eq(grantableRoles('admin').join(','), 'member,admin');
  eq(grantableRoles('member').length, 0);
  await rejects(() => assertGrantRole('admin', 'owner'), 'FORBIDDEN');
});

T('FLOW-007: only owners may invite another owner', async () => {
  const { db, owner } = await authed();
  const admin = await inviteUser(
    db,
    TEN,
    { email: 'admin@acme.test', name: 'An Admin', role: 'admin', password: 'a-long-admin-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await rejects(
    () =>
      inviteUser(
        db,
        TEN,
        { email: 'other-owner@acme.test', name: 'Other Owner', role: 'owner', password: 'another-long-password' },
        { userId: admin.id, role: admin.role },
        NOW,
      ),
    'FORBIDDEN',
  );
});

T('FLOW-007: activation gate blocks mutations until password change completes', async () => {
  const { db, owner } = await authed();
  const pending = { ...owner, mustChangePassword: true };
  await rejects(() => assertAccountActivated(pending), 'ACTIVATION_REQUIRED');
  assertAccountActivated({ ...owner, mustChangePassword: false });
  void db;
});

T('FLOW-007: remote signup requires deliberate setup authorization', () => {
  eq(isLoopbackAddress('127.0.0.1'), true);
  eq(isLoopbackAddress('::1'), true);
  eq(isLoopbackAddress('203.0.113.4'), false);
  eq(signupRequiresSetupSecret('127.0.0.1', null), false);
  eq(signupRequiresSetupSecret('203.0.113.4', null), true);
  eq(signupRequiresSetupSecret('127.0.0.1', 'secret'), true);
  eq(setupSecretOk('secret', 'secret'), true);
  eq(setupSecretOk('wrong', 'secret'), false);
});

// -------------------------------------------------------------------- csrf ----

T('csrf comparison is constant-time-ish and strict', async () => {
  const { db } = await authed();
  const { session } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  eq(csrfOk(session, session.csrfToken), true);
  eq(csrfOk(session, null), false);
  eq(csrfOk(session, ''), false);
  eq(csrfOk(session, `${session.csrfToken}00`), false, 'appended garbage fails:');
  eq(csrfOk(session, session.csrfToken.slice(0, -2)), false, 'truncated fails:');
  eq(csrfOk(session, 'f'.repeat(64)), false, 'same length, wrong value fails:');
  void db;
});

T('the session cookie is HttpOnly, SameSite=Lax, and Secure behind TLS', () => {
  const c = sessionCookie('tok', NOW);
  eq(c.includes('HttpOnly'), true);
  eq(c.includes('SameSite=Lax'), true);
  eq(c.includes('Secure'), false, 'no Secure without TLS:');
  eq(sessionCookie('tok', NOW, true).includes('Secure'), true);
});

T('FLOW-006: secureCookies reaches the response, so the session cannot ride a plaintext downgrade', async () => {
  // The unit above proves sessionCookie() *can* add Secure. This proves the
  // server actually asks it to: behind the ALB the cookie must be Secure, and a
  // flag that stops at the CLI is not a security control. Both directions are
  // asserted so a hardcoded `true` cannot pass this by accident either.
  const { db } = await authed();
  try {
    for (const secureCookies of [false, true]) {
      const s = await startConsoleServer(db, createLedger(db), createCoordinator(db), new OrganizationalCompiler(db), {
        tenant: TEN,
        now: () => NOW,
        secureCookies,
      });
      try {
        const pre = await preCsrf(s.port);
        const res = await fetch(`http://127.0.0.1:${s.port}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { cookie: pre.cookie },
          body: `csrf=${pre.csrf}&email=${encodeURIComponent(SIGNUP.email)}&password=${encodeURIComponent(SIGNUP.password)}`,
        });
        eq(res.status, 303, `login succeeds (secure=${secureCookies}):`);
        const session = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vital_session=')) ?? '';
        eq(session.length > 0, true, `a session cookie is issued (secure=${secureCookies}):`);
        eq(session.includes('HttpOnly'), true, `HttpOnly (secure=${secureCookies}):`);
        eq(session.includes('Secure'), secureCookies, `Secure tracks secureCookies=${secureCookies}:`);
      } finally {
        await s.close();
      }
    }
  } finally {
    await db.close();
  }
});

// -------------------------------------------------------- tenant isolation ----

T('tenants are isolated: same email, different tenant, different account', async () => {
  const { db } = await authed();
  await signupTenant(
    db,
    { slug: 'globex', name: 'Globex', email: 'owner@acme.test', password: 'globex-owner-password', ownerName: 'G' },
    NOW,
  );
  const acmeIn = await login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW);
  const globexIn = await login(
    db,
    { tenant: 'globex', email: 'owner@acme.test', password: 'globex-owner-password' },
    NOW,
  );
  eq(acmeIn.user.tenant, TEN);
  eq(globexIn.user.tenant, 'globex');
  eq(acmeIn.user.id !== globexIn.user.id, true, 'separate accounts:');
  // acme's password does not work in globex, and vice versa
  await rejects(
    () => login(db, { tenant: 'globex', email: 'owner@acme.test', password: SIGNUP.password }, NOW),
    'BAD_CREDENTIALS',
  );
  // sessions stay inside their tenant
  const { user } = await sessionUser(db, acmeIn.token, NOW);
  eq(user.tenant, TEN);
});

// ------------------------------------------------------------- HTTP surface ----

interface Http {
  status: number;
  setCookie: string[];
  body: string;
  location?: string | null;
}

async function call(port: number, path: string, opts: RequestInit & { cookie?: string } = {}): Promise<Http> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers, redirect: 'manual' });
  return {
    status: res.status,
    setCookie: res.headers.getSetCookie?.() ?? [],
    body: await res.text(),
    location: res.headers.get('location'),
  };
}

async function served(
  now: () => string = () => NOW,
): Promise<{ s: ConsoleServer; port: number } & Awaited<ReturnType<typeof authed>>> {
  const ctx = await authed();
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    {
      tenant: TEN,
      now,
    },
  );
  return { ...ctx, s, port: s.port };
}

const cookieOf = (setCookies: string[]): string => setCookies.map((c) => c.split(';')[0]).join('; ');

/** Fetch a public form page and extract its pre-session CSRF pair. */
async function preCsrf(port: number, path = '/login'): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();
  const m = html.match(/name="csrf" value="([0-9a-f]+)"/);
  if (!m) throw new Error(`no pre-session csrf on ${path}`);
  return { cookie, csrf: m[1]! };
}

/** Login over HTTP and return the session cookie. */
async function loginViaHttp(
  port: number,
  email: string,
  password: string,
): Promise<{ status: number; cookie: string }> {
  const pre = await preCsrf(port);
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: pre.cookie },
    body: `csrf=${pre.csrf}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
  });
  return { status: res.status, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}

/**
 * First login for an INVITED user: sign in, hit the forced password change,
 * set a new password, sign back in. Returns the settled session.
 */
async function firstLogin(port: number, email: string, tempPassword: string, newPassword: string) {
  const first = await loginViaHttp(port, email, tempPassword);
  eq(first.status, 303, 'the first login is gated, not refused:');
  const gate = await call(port, '/change-password', { cookie: first.cookie });
  eq(gate.status, 200, 'the forced-change page renders:');
  const csrf = gate.body.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const changed = await call(port, '/change-password', {
    method: 'POST',
    cookie: first.cookie,
    body: `csrf=${csrf}&password=${encodeURIComponent(newPassword)}`,
  });
  eq(changed.status, 303, 'the new password is accepted:');
  const again = await loginViaHttp(port, email, newPassword);
  eq(again.status, 303, 'the new password signs in:');
  return again;
}

T('the console redirects anonymous users to login and 401s anonymous API calls', async () => {
  const { s, port } = await served();
  try {
    const home = await call(port, '/');
    eq(home.status, 303);
    eq(home.setCookie.length, 0);
    const api = await call(port, '/api/requests/whatever/approve', { method: 'POST', body: '{}' });
    eq(api.status, 401);
  } finally {
    await s.close();
  }
});

T('a fresh boot is unprovisioned: the console offers signup, not a login wall', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: 'initech', now: () => NOW },
  );
  try {
    // Everything else points at the claiming form.
    const home = await call(s.port, '/');
    eq(home.status, 303, 'the console redirects to signup:');
    eq(home.location, '/signup', 'to /signup, specifically:');
    eq((await call(s.port, '/login')).location, '/signup');
    // The claiming form is CSRF-protected too.
    const noCsrf = await call(s.port, '/signup', {
      method: 'POST',
      body: 'orgname=Initech&ownerName=Peter&email=peter%40initech.test&password=flair-is-mandatory',
    });
    eq(noCsrf.status, 403, 'signup without the pre-session token is refused:');
    eq(
      (await ctx.db.prepare('SELECT slug FROM tenants WHERE slug = ?').get('initech')) as unknown,
      undefined,
      'the refused post created nothing:',
    );
    // Claim the console.
    const pre = await preCsrf(s.port, '/signup');
    const ok = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=Peter&email=peter%40initech.test&password=flair-is-mandatory`,
    });
    eq(ok.status, 303, 'claiming redirects straight into the console:');
    const cookie = cookieOf(ok.setCookie);
    eq(cookie.includes('vital_session='), true, 'a session was issued:');
    const opened = await call(s.port, '/', { cookie });
    eq(opened.status, 200, 'the new owner lands on their console:');
    eq(opened.body.includes('signed in as'), true);
    eq(opened.body.includes('peter@initech.test'), true);
    // Signup closes the moment the tenant has an owner.
    eq((await call(s.port, '/signup')).location, '/login', 'the form is gone:');
    // The refusal happens before CSRF checking — no token needed to be told no.
    const closed = await call(s.port, '/signup', {
      method: 'POST',
      body: 'orgname=Again&ownerName=Q&email=q%40x.test&password=another-long-one',
    });
    eq(closed.status, 403);
    eq(closed.body.includes('invite-only'), true, 'the refusal says why:');
  } finally {
    await s.close();
  }
});

T('signup closes once the tenant has an owner: membership is invite-only', async () => {
  const { s, port, db } = await served();
  try {
    eq((await call(port, '/signup')).location, '/login', 'no claiming form on a running tenant:');
    const closed = await call(port, '/signup', {
      method: 'POST',
      body: 'orgname=X&ownerName=Q&email=q%40x.test&password=another-long-one',
    });
    eq(closed.status, 403);
    const row = (await db.prepare('SELECT id FROM users WHERE email = ?').get('q@x.test')) as unknown;
    eq(row, undefined, 'no user was created by the closed signup:');
  } finally {
    await s.close();
  }
});

T(
  'an env-configured bootstrap owner is created for an account-less tenant, with a forced password change',
  async () => {
    const { db, owner } = await authed();
    // The edge ensureBootstrapOwner exists for: the tenant exists but holds no
    // usable account (e.g. the owner was removed during offboarding).
    await db.prepare('DELETE FROM users WHERE tenant = ?').run(TEN);
    void owner;
    process.env.VITAL_BOOTSTRAP_EMAIL = 'first@acme.test';
    process.env.VITAL_BOOTSTRAP_PASSWORD = 'bootstrap-password-1';
    try {
      const s = await startConsoleServer(db, createLedger(db), createCoordinator(db), new OrganizationalCompiler(db), {
        tenant: TEN,
        now: () => NOW,
      });
      try {
        const users = await listUsers(db, TEN);
        eq(users.length, 1);
        eq(users[0]!.role, 'owner');
        eq(users[0]!.mustChangePassword, true, 'forced to change at first login:');
      } finally {
        await s.close();
      }
    } finally {
      delete process.env.VITAL_BOOTSTRAP_EMAIL;
      delete process.env.VITAL_BOOTSTRAP_PASSWORD;
    }
  },
);

T('login → force change → login → console, the full first-boot flow over HTTP', async () => {
  const { s, port, db } = await served();
  try {
    // Flag the owner as needing a password change (simulates an invited user).
    await db.prepare('UPDATE users SET must_change_password = 1 WHERE tenant = ?').run(TEN);
    const badPw = await loginViaHttp(port, 'owner@acme.test', 'wrong-password');
    eq(badPw.status, 401);
    const first = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    eq(first.status, 303, 'login redirects:');
    const cookie = first.cookie;
    eq(cookie.includes('vital_session='), true);
    // Landing on / redirects to the change-password page.
    const gated = await call(port, '/', { cookie });
    eq(gated.status, 303, 'must-change gates the console:');
    const cp = await call(port, '/change-password', { cookie });
    eq(cp.status, 200);
    eq(cp.body.includes('new password'), true);
    // CSRF is required even here.
    const noCsrf = await call(port, '/change-password', {
      method: 'POST',
      cookie,
      body: 'password=a-brave-new-password',
    });
    eq(noCsrf.status, 400, 'missing CSRF returns an HTML recovery page:');
    eq(noCsrf.body.includes('form expired'), true);
    const csrf = cp.body.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const weak = await call(port, '/change-password', {
      method: 'POST',
      cookie,
      body: `csrf=${csrf}&password=short`,
    });
    eq(weak.status, 400, 'weak password refused:');
    const ok = await call(port, '/change-password', {
      method: 'POST',
      cookie,
      body: `csrf=${csrf}&password=a-brave-new-password`,
    });
    eq(ok.status, 303);
    const clearedCookie = ok.setCookie.find((c) => c.startsWith('vital_session='));
    eq(clearedCookie !== undefined, true, 'the cookie is cleared:');
    eq(clearedCookie!.includes('Max-Age=0'), true, 'and it expires now:');
    // Old session is dead (changePassword revoked all), new password works.
    await rejects(() => sessionUser(db, cookie.split('=')[1]!, NOW), 'NO_SESSION');
    const second = await loginViaHttp(port, 'owner@acme.test', 'a-brave-new-password');
    eq(second.status, 303);
    const cookie2 = second.cookie;
    const home = await call(port, '/', { cookie: cookie2 });
    eq(home.status, 200);
    eq(home.body.includes('Reality health'), true);
    eq(home.body.includes('signed in as'), true);
    eq(home.body.includes('owner@acme.test'), true);
    eq(home.body.includes('vital-csrf'), true, 'page carries the CSRF token:');
  } finally {
    await s.close();
  }
});

T('approvals are CSRF-checked and named by the session, not the body', async () => {
  const { s, port, coord, db, ledger } = await served();
  try {
    const rel = await ledger.append({
      tenant: TEN,
      subject: 'release:v9',
      kind: 'FACT',
      statement: 'ships',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(base({ id: 'r1', claimRefs: [rel.id], bid: { dollars: 1, humanMinutes: 1 } }));
    const stateBefore = (await coord.get(TEN, 'r1'))!.state;
    const loginRes = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const cookie = loginRes.cookie;
    const home = await call(port, '/', { cookie });
    const csrf = csrfFrom(cookie, home.body);
    // no CSRF → 403, nothing happens
    const noCsrf = await call(port, '/api/requests/r1/approve', { method: 'POST', cookie, body: '{}' });
    eq(noCsrf.status, 403);
    eq((await coord.get(TEN, 'r1'))!.state, stateBefore, 'the refused call moved nothing:');
    // wrong CSRF → 403
    const badCsrf = await call(port, '/api/requests/r1/approve', {
      method: 'POST',
      cookie,
      headers: { 'x-vital-csrf': 'f'.repeat(64) },
      body: '{}',
    });
    eq(badCsrf.status, 403);
    // right CSRF, JSON with header → approved as the session's identity
    const good = await call(port, '/api/requests/r1/approve', {
      method: 'POST',
      cookie,
      headers: { 'x-vital-csrf': csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    eq(good.status, 200);
    const out = JSON.parse(good.body) as { ok: boolean; by: string };
    eq(out.ok, true);
    eq(out.by.includes('owner@acme.test'), true, 'the approver is the session identity:');
    eq(out.by.includes('body'), false, 'the body never named the approver:');
    // audited with the identity
    const audits = (await db.prepare("SELECT actor FROM audit_log WHERE action = 'console.approve'").all()) as {
      actor: string;
    }[];
    eq(
      audits.some((a) => a.actor.includes('owner@acme.test')),
      true,
    );
  } finally {
    await s.close();
  }
});

T('logout over HTTP kills the session; the cleared cookie is sent', async () => {
  const { s, port } = await served();
  try {
    const { cookie } = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const home = await call(port, '/', { cookie });
    const csrf = home.body.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const out = await call(port, '/logout', { method: 'POST', cookie, body: `csrf=${csrf}` });
    eq(out.status, 303);
    const cleared = cookieOf(out.setCookie).replace(/;+$/, '');
    eq(cleared, 'vital_session=', 'cookie cleared:');
    const after = await call(port, '/', { cookie });
    eq(after.status, 303, 'the old session no longer opens the console:');
  } finally {
    await s.close();
  }
});

T('a locked-out user is refused at the HTTP layer without enumeration', async () => {
  const { s, port } = await served();
  try {
    const pre = await preCsrf(port);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await call(port, '/login', {
        method: 'POST',
        headers: { cookie: pre.cookie },
        body: `csrf=${pre.csrf}&email=owner%40acme.test&password=wrong-password-here`,
      });
    }
    const locked = await call(port, '/login', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&email=owner%40acme.test&password=${encodeURIComponent(SIGNUP.password)}`,
    });
    eq(locked.status, 401);
    eq(locked.body.includes('locked until'), true, 'lock is named, credentials are not:');
    eq(locked.body.includes(SIGNUP.password), false);
  } finally {
    await s.close();
  }
});

T('login and signup refuse posts without the pre-session CSRF token', async () => {
  const { s, port } = await served();
  try {
    const noCsrf = await call(port, '/login', {
      method: 'POST',
      body: 'email=owner%40acme.test&password=whatever-long',
    });
    eq(noCsrf.status, 200, 'login without csrf returns HTML recovery:');
    eq(noCsrf.body.includes('form expired'), true);
    eq(noCsrf.body.includes('owner@acme.test'), true);
    const jsonCsrf = await call(port, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@acme.test', password: 'whatever-long' }),
    });
    eq(jsonCsrf.status, 403, 'JSON login without csrf is still refused:');
  } finally {
    await s.close();
  }
});

T('FLOW-007: signup with configured setup secret requires authorization', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: 'initech', now: () => NOW, setupSecret: 'claim-me-now' },
  );
  try {
    const pre = await preCsrf(s.port, '/signup');
    const blocked = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=P&email=p%40initech.test&password=a-long-enough-pass`,
    });
    eq(blocked.status, 403);
    eq(blocked.body.includes('setup authorization required'), true);
    const ok = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie, 'x-vital-setup': 'claim-me-now' },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=P&email=p%40initech.test&password=a-long-enough-pass`,
    });
    eq(ok.status, 303, 'authorized claim succeeds:');
  } finally {
    await s.close();
  }
});

T('FLOW-007: pending activation cannot approve over HTTP', async () => {
  const { s, port, coord, db, ledger } = await served();
  try {
    const rel = await ledger.append({
      tenant: TEN,
      subject: 'release:gate',
      kind: 'FACT',
      statement: 'ships',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(base({ id: 'gate-r1', claimRefs: [rel.id], bid: { dollars: 1, humanMinutes: 1 } }));
    await db.prepare('UPDATE users SET must_change_password = 1 WHERE tenant = ?').run(TEN);
    const loginRes = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    eq(loginRes.status, 303);
    const home = await call(port, '/change-password', { cookie: loginRes.cookie });
    const csrf = home.body.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const refused = await call(port, '/api/requests/gate-r1/approve', {
      method: 'POST',
      cookie: loginRes.cookie,
      headers: { 'x-vital-csrf': csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    eq(refused.status, 403);
    const out = JSON.parse(refused.body) as { ok: boolean; code: string };
    eq(out.ok, false);
    eq(out.code, 'ACTIVATION_REQUIRED');
    eq((await coord.get(TEN, 'gate-r1'))!.state, 'ADMITTED', 'approval stayed blocked:');
  } finally {
    await s.close();
  }
});

T('signup validation errors round-trip to the form with friendly messages', async () => {
  // A fresh db whose tenant exists but has NO owner: /signup is open, so the
  // claiming form's validation paths are reachable.
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await ctx.db.prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)').run('initech', 'Initech', NOW);
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: 'initech', now: () => NOW },
  );
  try {
    const pre = await preCsrf(s.port, '/signup');
    const weak = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=P&email=p%40initech.test&password=short`,
    });
    eq(weak.status, 400, 'weak password refused:');
    eq(weak.body.includes('at least 12 characters'), true, 'with the friendly message:');
    const badEmail = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=P&email=not-an-email&password=a-long-enough-pass`,
    });
    eq(badEmail.status, 400);
    eq(badEmail.body.includes('valid work email'), true);
    // The tenant still has no owner — nothing was half-created.
    const users = await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?').get('initech');
    eq(Number((users as { n: number }).n), 0, 'failed claims create no user:');
  } finally {
    await s.close();
  }
});

T('login rate limit: a flood of valid-format posts hits 429 before the accounts do', async () => {
  const { s, port } = await served();
  try {
    const pre = await preCsrf(port);
    let last = 0;
    for (let i = 0; i < LOGIN_RATE.limit + 2; i++) {
      const r = await call(port, '/login', {
        method: 'POST',
        headers: { cookie: pre.cookie },
        body: `csrf=${pre.csrf}&email=ghost%40acme.test&password=wrong-password-here`,
      });
      last = r.status;
    }
    eq(last, 429, 'the flood is capped by 429:');
  } finally {
    await s.close();
  }
});

T('role enforcement: a member can approve by default, but approverRole raises the bar', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await signupTenant(ctx.db, SIGNUP, NOW);
  await inviteUser(
    ctx.db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const rel = await ctx.ledger.append({
    tenant: TEN,
    subject: 'release:r',
    kind: 'FACT',
    statement: 'ships',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  await ctx.coord.submit(base({ id: 'r1', claimRefs: [rel.id], bid: { dollars: 1, humanMinutes: 1 } }));
  // Default: member may approve (room-agent model).
  const s1 = await startConsoleServer(ctx.db, ctx.ledger, ctx.coord, ctx.comp, { tenant: TEN, now: () => NOW });
  try {
    // The member is INVITED: their first login forces a password change, and
    // only the settled account reaches the console.
    const { cookie } = await firstLogin(s1.port, 'member@acme.test', 'a-members-password', 'a-braver-member-password');
    const home = await call(s1.port, '/', { cookie });
    const csrf = home.body.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const ok = (await (
      await fetch(`http://127.0.0.1:${s1.port}/api/requests/r1/approve`, {
        method: 'POST',
        headers: { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { ok: boolean };
    eq(ok.ok, true, 'a member approves under the default policy:');
  } finally {
    await s1.close();
  }
  // Raised bar: approverRole 'admin' refuses the same member.
  await ctx.coord.submit(
    base({ id: 'r2', goal: 'second one', claimRefs: [rel.id], bid: { dollars: 1, humanMinutes: 1 } }),
  );
  const s2 = await startConsoleServer(ctx.db, ctx.ledger, ctx.coord, ctx.comp, {
    tenant: TEN,
    now: () => NOW,
    approverRole: 'admin',
  });
  try {
    const { cookie } = await loginViaHttp(s2.port, 'member@acme.test', 'a-braver-member-password');
    const home = await call(s2.port, '/', { cookie });
    const csrf = home.body.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const refused = (await (
      await fetch(`http://127.0.0.1:${s2.port}/api/requests/r2/approve`, {
        method: 'POST',
        headers: { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { ok: boolean; error: string };
    eq(refused.ok, false);
    eq(refused.error.includes('requires admin'), true, 'the refusal names the required role:');
    eq((await ctx.coord.get(TEN, 'r2'))!.state !== 'ACCEPTED', true, 'nothing was approved:');
  } finally {
    await s2.close();
  }
});

T('the team page and invite/disable flows are role-gated and audited', async () => {
  const prev = process.env.VITAL_EXPOSE_INVITE_LINK;
  process.env.VITAL_EXPOSE_INVITE_LINK = '1';
  const { s, port, db } = await served();
  try {
    const owner = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const ownerHome = await call(port, '/', { cookie: owner.cookie });
    const ownerCsrf = ownerHome.body.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const invited = await call(port, '/team/invite', {
      method: 'POST',
      cookie: owner.cookie,
      body: `csrf=${ownerCsrf}&email=newbie%40acme.test&name=New%20Bie&role=member`,
    });
    eq(invited.status, 200, 'create account succeeds for the owner:');
    eq(invited.body.includes('Create account'), true);
    eq(invited.body.includes('out of band'), true);
    eq(invited.body.includes('/accept-invite?token='), true);
    eq(
      (await listUsers(db, TEN)).some((u) => u.email === 'newbie@acme.test'),
      false,
      'no user row until acceptance:',
    );
    const pending = (await listInvitations(db, TEN, NOW)).find((i) => i.email === 'newbie@acme.test')!;
    const { token } = await resendInvitation(
      db,
      TEN,
      pending.id,
      { userId: (await listUsers(db, TEN)).find((u) => u.role === 'owner')!.id, role: 'owner' },
      NOW,
    );
    const acceptGet = await call(port, `/accept-invite?token=${encodeURIComponent(token)}`);
    eq(acceptGet.status, 200);
    eq(acceptGet.body.includes('Create my account'), true);
    const acceptCsrf = acceptGet.body.match(/name="csrf" value="([^"]+)"/)![1]!;
    const acceptCookie = acceptGet.setCookie[0]?.split(';')[0] ?? '';
    const accepted = await call(port, '/accept-invite', {
      method: 'POST',
      cookie: acceptCookie,
      body: `csrf=${acceptCsrf}&token=${encodeURIComponent(token)}&password=their-chosen-password`,
    });
    eq(accepted.status, 303, 'acceptance signs the member in:');
    const memberRow = (await listUsers(db, TEN)).find((u) => u.email === 'newbie@acme.test')!;
    eq(membershipStatus(memberRow!), 'active');
    const member = await loginViaHttp(port, 'newbie@acme.test', 'their-chosen-password');
    const memberHome = await call(port, '/', { cookie: member.cookie });
    eq(memberHome.status, 200, 'accepted member reaches the console:');
    const disabled = await call(port, '/team/disable', {
      method: 'POST',
      cookie: owner.cookie,
      body: `csrf=${ownerCsrf}&userId=${memberRow!.id}&confirmEmail=newbie%40acme.test`,
    });
    eq(disabled.status, 200, 'owner disables the member:');
    eq(disabled.body.includes('every live session was revoked'), true);
    await rejects(
      () => sessionUser(db, member.cookie.split('=')[1]!, NOW),
      'NO_SESSION',
      'the disabled member\u2019s session died:',
    );
    const audits = (await db
      .prepare("SELECT action, actor FROM audit_log WHERE action LIKE 'team.%' ORDER BY seq")
      .all()) as { action: string; actor: string }[];
    eq(
      audits.some((a) => a.action === 'team.invite'),
      true,
      'invite audited:',
    );
    eq(
      audits.some((a) => a.action === 'team.disable'),
      true,
      'disable audited:',
    );
  } finally {
    process.env.VITAL_EXPOSE_INVITE_LINK = prev;
    await s.close();
  }
});

T('with siteDir, `/` serves the site, the console lives at /console, and console routes win', async () => {
  const ctx = await authed();
  const s = await startConsoleServer(ctx.db, ctx.ledger, ctx.coord, ctx.comp, {
    tenant: TEN,
    now: () => NOW,
    siteDir: 'site',
  });
  try {
    // The marketing page owns `/` — anonymous, no redirect.
    const root = await call(s.port, '/');
    eq(root.status, 200);
    eq(root.body.includes('Governed release workflow'), true, 'index.html is served:');
    eq(root.body.includes('127.0.0.1'), false, 'co-hosted site strips localhost console URL:');
    eq(root.body.includes('Request a pilot walkthrough'), true, 'pilot CTA is present:');
    eq(root.body.includes('Create your organization'), false, 'no misleading org-creation CTA:');
    const css = await call(s.port, '/styles.css');
    eq(css.status, 200);
    eq(css.body.includes('header-nav'), true, 'assets are served with the right content:');
    // The console app moved to /console and still requires auth.
    const consoleHome = await call(s.port, '/console');
    eq(consoleHome.status, 303);
    eq(consoleHome.location?.startsWith('/login'), true, 'the console is still session-gated:');
    // Console routes take precedence over any same-named site file.
    eq((await call(s.port, '/login')).status, 200, 'the login page still renders:');
    eq((await call(s.port, '/api/health')).status, 200, 'health still answers:');
    // Traversal attempts fall through to 404, never to files outside site/.
    eq((await call(s.port, '/..%2F..%2Fpackage.json')).status, 404, 'encoded traversal refused:');
    // Signed in, the console opens at /console.
    const { cookie } = await loginViaHttp(s.port, 'owner@acme.test', SIGNUP.password);
    const opened = await call(s.port, '/console', { cookie });
    eq(opened.status, 200);
    eq(opened.body.includes('Reality health'), true);
  } finally {
    await s.close();
  }
});

T('FINAL-001: authenticated back links resolve to the console home in both serve modes', async () => {
  for (const siteDir of [undefined, 'site'] as const) {
    const ctx = await authed();
    const s = await startConsoleServer(
      ctx.db,
      createLedger(ctx.db),
      createCoordinator(ctx.db),
      new OrganizationalCompiler(ctx.db),
      { tenant: TEN, now: () => NOW, siteDir },
    );
    try {
      const home = siteDir ? '/console' : '/';
      const { cookie } = await loginViaHttp(s.port, 'owner@acme.test', SIGNUP.password);
      const team = await call(s.port, '/team', { cookie });
      eq(team.status, 200);
      eq(
        team.body.includes(`<a href="${home}">← console</a>`),
        true,
        `team back link is ${home} (siteDir=${siteDir}):`,
      );
      const rooms = await call(s.port, '/setup/rooms', { cookie });
      eq(rooms.status, 200);
      // Presentation of the link is the design system's business; the
      // contract is that it points home and says so.
      eq(
        new RegExp(`<a[^>]*href="${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>← Back to the console</a>`).test(
          rooms.body,
        ),
        true,
        `rooms back link is ${home} (siteDir=${siteDir}):`,
      );
    } finally {
      await s.close();
    }
  }
});

T('FLOW-011: prepareCoHostedSiteHtml clears configured console URL meta', () => {
  const html = Buffer.from(
    '<meta name="vital-console-url" content="http://127.0.0.1:3100"/><title>test</title>',
    'utf8',
  );
  const out = prepareCoHostedSiteHtml(html).toString('utf8');
  eq(out.includes('content="http://127.0.0.1:3100"'), false);
  eq(out.includes('name="vital-console-url" content=""'), true);
});

T('FLOW-011: provisioned login names the tenant and hides org creation', async () => {
  const { s, port } = await served();
  try {
    const login = await call(port, '/login');
    eq(login.status, 200);
    eq(login.body.includes('Sign in to Acme Inc'), true);
    eq(login.body.includes(`<code>${TEN}</code>`), true);
    eq(login.body.includes('invite-only'), true);
    eq(login.body.includes('Create one'), false);
    eq(login.body.includes('Create your organization'), false);
  } finally {
    await s.close();
  }
});

T('unknown routes still 404, and JSON APIs fail closed', async () => {
  const { s, port } = await served();
  try {
    eq((await call(port, '/nope')).status, 404);
    eq(
      (await call(port, '/api/requests/none/approve', { method: 'POST', body: '{}' })).status,
      401,
      'the real route fails closed:',
    );
  } finally {
    await s.close();
  }
});

// ----------------------------------------------------------- FLOW-008 recovery ----

T('FLOW-008: tenantAccessState distinguishes unclaimed, ready, and recovery', async () => {
  const { db, owner } = await authed();
  eq(await tenantAccessState(db, TEN), 'ready');
  const blank = await fresh();
  await installAuthSchema(blank.db, NOW);
  await blank.db.prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)').run('blank', 'Blank', NOW);
  eq(await tenantAccessState(blank.db, 'blank'), 'unclaimed');
  await inviteUser(
    db,
    TEN,
    { email: 'ghost@acme.test', name: 'Ghost', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(owner.id);
  eq(await tenantAccessState(db, TEN), 'recovery');
});

T('FLOW-008: claimTenantOwner claims an account-less tenant without reopening recovery tenants', async () => {
  const { db } = await fresh();
  await installAuthSchema(db, NOW);
  await db.prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)').run('initech', 'Initech', NOW);
  const { owner } = await claimTenantOwner(
    db,
    {
      slug: 'initech',
      email: 'peter@initech.test',
      password: 'flair-is-mandatory',
      ownerName: 'Peter',
    },
    NOW,
  );
  eq(owner.role, 'owner');
  eq(await tenantAccessState(db, 'initech'), 'ready');
  await rejects(
    () =>
      claimTenantOwner(db, { slug: 'initech', email: 'q@x.test', password: 'another-long-one', ownerName: 'Q' }, NOW),
    'TENANT_CLAIMED',
  );
  await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(owner.id);
  await rejects(
    () =>
      claimTenantOwner(db, { slug: 'initech', email: 'q@x.test', password: 'another-long-one', ownerName: 'Q' }, NOW),
    'RECOVERY_REQUIRED',
  );
});

T('FLOW-008: tryPasswordReset and operatorSetPassword support operator-assisted recovery', async () => {
  const { db, owner } = await authed();
  eq(await tryPasswordReset(db, TEN, 'ghost@acme.test', NOW), null);
  const token = await tryPasswordReset(db, TEN, 'owner@acme.test', NOW);
  eq(token !== null, true);
  await operatorSetPassword(db, TEN, owner.id, 'operator-temp-password', NOW);
  const row = (await db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(owner.id)) as {
    must_change_password: number;
  };
  eq(row.must_change_password, 1);
  const { user } = await login(db, { tenant: TEN, email: 'owner@acme.test', password: 'operator-temp-password' }, NOW);
  eq(user.mustChangePassword, true);
});

T('FLOW-008: forgot/reset password over HTTP revokes sessions and avoids enumeration', async () => {
  process.env.VITAL_EXPOSE_RESET_TOKEN = '1';
  const { s, port, db } = await served();
  try {
    const loginRes = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const forgotPage = await call(port, '/forgot-password');
    eq(forgotPage.status, 200);
    eq(forgotPage.body.includes('Forgot password'), false);
    eq(forgotPage.body.includes('reset-link'), true);
    const pre = await preCsrf(port, '/forgot-password');
    const ghost = await call(port, '/forgot-password', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&email=ghost%40acme.test`,
    });
    eq(ghost.status, 200);
    eq(ghost.body.includes('If an account exists'), true);
    const real = await call(port, '/forgot-password', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&email=owner%40acme.test`,
    });
    eq(real.status, 200);
    const m = real.body.match(/Reset link \(development only\): (\/reset-password\?token=[^\s<]+)/);
    if (!m) throw new Error('no reset link in response');
    const resetGet = await call(port, m[1]!);
    eq(resetGet.status, 200);
    const formToken = resetGet.body.match(/name="token" value="([^"]+)"/)![1]!;
    const resetCsrf = resetGet.body.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const resetCookie = cookieOf(resetGet.setCookie);
    const ok = await call(port, '/reset-password', {
      method: 'POST',
      headers: { cookie: resetCookie },
      body: `csrf=${resetCsrf}&token=${encodeURIComponent(formToken)}&password=brand-new-password-here`,
    });
    eq(ok.status, 303);
    eq(ok.location?.includes('reset=ok'), true);
    await rejects(() => sessionUser(db, loginRes.cookie.split('=')[1]!, NOW), 'NO_SESSION');
    const second = await loginViaHttp(port, 'owner@acme.test', 'brand-new-password-here');
    eq(second.status, 303);
    await rejects(
      () => confirmPasswordReset(db, formToken, 'another-reset-password', NOW),
      'BAD_RESET_TOKEN',
      'single use:',
    );
  } finally {
    delete process.env.VITAL_EXPOSE_RESET_TOKEN;
    await s.close();
  }
});

T('FLOW-008: account-less tenant claims through /signup instead of TENANT_EXISTS dead end', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await ctx.db.prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)').run('initech', 'Initech', NOW);
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: 'initech', now: () => NOW },
  );
  try {
    const pre = await preCsrf(s.port, '/signup');
    const ok = await call(s.port, '/signup', {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&orgname=Initech&ownerName=Peter&email=peter%40initech.test&password=flair-is-mandatory`,
    });
    eq(ok.status, 303);
    eq((await listUsers(ctx.db, 'initech')).length, 1);
    eq(await tenantAccessState(ctx.db, 'initech'), 'ready');
  } finally {
    await s.close();
  }
});

T('FLOW-008: disabled owner surfaces recovery instead of a login/signup loop', async () => {
  const { s, port, db, owner } = await served();
  try {
    await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(owner.id);
    eq(await tenantAccessState(db, TEN), 'recovery');
    const signup = await call(port, '/signup');
    eq(signup.status, 200);
    eq(signup.body.includes('Owner recovery required'), true);
    const login = await call(port, '/login');
    eq(login.status, 200);
    eq(login.body.includes('no usable owner'), true);
  } finally {
    await s.close();
  }
});

// ----------------------------------------------------------- FLOW-009 lifecycle ----

T('FLOW-009: invitation lifecycle — create, accept, duplicate, revoke, resend, reactivate', async () => {
  const { db, owner } = await authed();
  const { invitation, token } = await createInvitation(
    db,
    TEN,
    { email: 'new@acme.test', name: 'New Hire', role: 'member' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq(invitation.status, 'pending');
  eq((await listInvitations(db, TEN, NOW)).length, 1);
  await rejects(
    () =>
      createInvitation(
        db,
        TEN,
        { email: 'new@acme.test', name: 'Dup', role: 'member' },
        { userId: owner.id, role: owner.role },
        NOW,
      ),
    'INVITATION_PENDING',
  );
  const { user } = await acceptInvitation(db, token, 'brand-new-password-12', NOW);
  eq(user.email, 'new@acme.test');
  eq(user.mustChangePassword, false);
  await rejects(() => acceptInvitation(db, token, 'brand-new-password-12', NOW), 'BAD_INVITATION');
  const disabled = await inviteUser(
    db,
    TEN,
    { email: 'gone@acme.test', name: 'Gone', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await disableUser(db, TEN, disabled.id, NOW);
  await rejects(
    () =>
      createInvitation(
        db,
        TEN,
        { email: 'gone@acme.test', name: 'Gone', role: 'member' },
        { userId: owner.id, role: owner.role },
        NOW,
      ),
    'DISABLED_USER_EXISTS',
  );
  await reactivateUser(db, TEN, disabled.id, { userId: owner.id, role: owner.role }, NOW);
  eq(
    membershipStatus((await listUsers(db, TEN)).find((u) => u.id === disabled.id)!),
    'pending_activation',
    'reactivated operator-created accounts still owe a password change:',
  );
  const { invitation: revokedInvite } = await createInvitation(
    db,
    TEN,
    { email: 'later@acme.test', name: 'Later', role: 'admin' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await revokeInvitation(db, TEN, revokedInvite.id, { userId: owner.id, role: owner.role }, NOW);
  await rejects(
    () => resendInvitation(db, TEN, revokedInvite.id, { userId: owner.id, role: owner.role }, NOW),
    'INVITATION_REVOKED',
  );
  const { invitation: expiredInvite } = await createInvitation(
    db,
    TEN,
    { email: 'expired@acme.test', name: 'Expired', role: 'member' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await db
    .prepare("UPDATE invitations SET status = 'expired', expires_at = ? WHERE id = ?")
    .run(new Date(Date.parse(NOW) - 1000).toISOString(), expiredInvite.id);
  const { token: resent } = await resendInvitation(
    db,
    TEN,
    expiredInvite.id,
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq(resent.length > 10, true);
});

T('FLOW-009: role change, ownership transfer, and last-owner protection', async () => {
  const { db, owner } = await authed();
  const admin = await inviteUser(
    db,
    TEN,
    { email: 'admin@acme.test', name: 'Admin', role: 'admin', password: 'a-long-admin-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await changeUserRole(db, TEN, admin.id, 'member', { userId: owner.id, role: owner.role }, NOW);
  eq((await listUsers(db, TEN)).find((u) => u.id === admin.id)!.role, 'member');
  await changeUserRole(db, TEN, admin.id, 'admin', { userId: owner.id, role: owner.role }, NOW);
  const { to } = await transferOwnership(db, TEN, admin.id, { userId: owner.id, role: owner.role }, NOW);
  eq(to.role, 'owner');
  eq((await listUsers(db, TEN)).find((u) => u.id === owner.id)!.role, 'admin');
  await rejects(() => disableUser(db, TEN, to.id, NOW), 'LAST_OWNER');
});

T('FLOW-009: disable requires handoff for outstanding claims and requests', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const { owner } = await signupTenant(ctx.db, SIGNUP, NOW);
  const member = await inviteUser(
    ctx.db,
    TEN,
    { email: 'owner-work@acme.test', name: 'Owner Work', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const claim = await ctx.ledger.append({
    tenant: TEN,
    subject: member.email,
    kind: 'BELIEF',
    statement: 'needs a human owner',
    confidence: 0.8,
    provenance: sor('https://example.test/note'),
    observedAt: NOW,
    validFrom: NOW,
    owner: member.email,
    scope: 'product',
    authorType: 'human',
  });
  await ctx.coord.submit(
    base({
      id: 'req_handoff',
      originScope: 'product',
      claimRefs: [claim.id],
      onBehalfOf: member.email,
      goal: 'ship it',
    }),
  );
  eq((await countOutstandingWork(ctx.db, TEN, member)).claimCount, 1);
  eq((await countOutstandingWork(ctx.db, TEN, member)).requestCount, 1);
  await rejects(() => disableUser(ctx.db, TEN, member.id, NOW), 'HANDOFF_REQUIRED');
  const { reassigned } = await disableUser(ctx.db, TEN, member.id, NOW, { handoffToUserId: owner.id });
  eq(reassigned.claims, 1);
  eq(reassigned.requests, 1);
  const reassignedClaim = (await ctx.db.prepare('SELECT owner FROM claims WHERE id = ?').get(claim.id)) as {
    owner: string;
  };
  eq(reassignedClaim.owner, owner.email);
});

T('FLOW-009: membership roster shows invited, active, and disabled', async () => {
  const { db, owner } = await authed();
  const { invitation } = await createInvitation(
    db,
    TEN,
    { email: 'pending@acme.test', name: 'Pending', role: 'member' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const invited = await inviteUser(
    db,
    TEN,
    { email: 'newbie@acme.test', name: 'Newbie', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await disableUser(db, TEN, invited.id, NOW);
  const roster = membershipRoster(await listUsers(db, TEN), await listInvitations(db, TEN, NOW), NOW);
  const byEmail = (email: string) => roster.find((r) => r.email === email)!;
  eq(byEmail('pending@acme.test').kind, 'invited');
  eq(byEmail('pending@acme.test').detail.includes(invitation.expiresAt.slice(0, 10)), true);
  eq(byEmail('owner@acme.test').kind, 'active');
  eq(byEmail('newbie@acme.test').kind, 'disabled');
  eq(byEmail('newbie@acme.test').detail.includes('reactivate'), true);
  await db
    .prepare("UPDATE invitations SET status = 'expired', expires_at = ? WHERE id = ?")
    .run(new Date(Date.parse(NOW) - 1000).toISOString(), invitation.id);
  const relisted = membershipRoster(await listUsers(db, TEN), await listInvitations(db, TEN, NOW), NOW);
  eq(relisted.find((r) => r.email === 'pending@acme.test')!.detail.includes('expired'), true);
});

T('FLOW-009: disable confirmation names the person, sessions, and handoff need', async () => {
  const { db, owner } = await authed();
  const member = await inviteUser(
    db,
    TEN,
    { email: 'dev@acme.test', name: 'Dev Member', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await loginCookie(db, 'dev@acme.test', 'a-long-member-password');
  const confirm = await disableConfirmation(db, TEN, member.id);
  eq(confirm.person.email, 'dev@acme.test');
  eq(confirm.person.name, 'Dev Member');
  eq(confirm.liveSessions, 1);
  eq(confirm.sessionConsequence.includes('revokes every live session'), true);
  eq(confirm.needsHandoff, false);
  eq(confirm.lastUsableOwner, false);
  const ownerConfirm = await disableConfirmation(db, TEN, owner.id);
  eq(ownerConfirm.lastUsableOwner, true);
  await rejects(() => disableConfirmation(db, TEN, 'usr_missing'), 'UNKNOWN_USER');
});

T('FLOW-009: the batched confirmation answers what the per-user calls answered', async () => {
  // The team page asked for its members one at a time — four statements per row,
  // which is a page whose cost grows with the org chart. The batch is one query
  // per question whatever the number of rows, so the thing that must not drift is
  // the answer: person, live sessions, the consequence wording, the
  // outstanding-work counts and the last-usable-owner flag.
  const { db, owner } = await authed();
  const admin = await inviteUser(
    db,
    TEN,
    { email: 'ops@acme.test', name: 'Ops Admin', role: 'admin', password: 'a-long-admin-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const member = await inviteUser(
    db,
    TEN,
    { email: 'dev3@acme.test', name: 'Dev Three', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  await loginCookie(db, 'dev3@acme.test', 'a-long-member-password');
  const everyone = [owner, admin, member];
  const batch = await disableConfirmations(db, TEN, everyone);
  eq(batch.size, everyone.length, 'one confirmation per user:');
  for (const u of everyone) {
    eq(batch.get(u.id), await disableConfirmation(db, TEN, u.id), `${u.email} matches the single call:`);
  }
  eq((await disableConfirmations(db, TEN, [])).size, 0, 'an empty list is an empty map:');
});

T('FLOW-009: duplicate and disabled cases map to next steps', async () => {
  eq(invitationNextSteps('pending_invitation', 'a@x.test').action.includes('Resend'), true);
  eq(invitationNextSteps('expired_invitation', 'a@x.test').action.includes('Resend'), true);
  eq(invitationNextSteps('revoked_invitation', 'a@x.test').action.includes('Create a new account'), true);
  eq(invitationNextSteps('disabled_account', 'a@x.test').action.includes('Reactivate'), true);
  eq(invitationNextSteps('active_account', 'a@x.test').action.includes('role'), true);
  eq(invitationNextSteps('disabled_account', 'gone@acme.test').heading.includes('gone@acme.test'), true);
});

T('FLOW-009: create-account notice labels the out-of-band handoff', () => {
  const notice = createAccountNotice();
  eq(notice.heading, 'Create account');
  eq(notice.button, 'Create account');
  eq(notice.detail.includes('out of band'), true);
  eq(notice.detail.includes('choose their own password'), true);
});

T('FLOW-009: reactivation restores sign-in without reviving revoked sessions', async () => {
  const { db, owner } = await authed();
  const member = await inviteUser(
    db,
    TEN,
    { email: 'dev@acme.test', name: 'Dev', role: 'member', password: 'a-long-member-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const { token } = await loginCookie(db, 'dev@acme.test', 'a-long-member-password');
  await disableUser(db, TEN, member.id, NOW);
  await reactivateUser(db, TEN, member.id, { userId: owner.id, role: owner.role }, NOW);
  await rejects(() => sessionUser(db, token, NOW), 'NO_SESSION', 'the pre-disable session stays dead:');
  const { user } = await login(db, { tenant: TEN, email: 'dev@acme.test', password: 'a-long-member-password' }, NOW);
  eq(user.id, member.id, 'a fresh sign-in works after reactivation:');
});

T('FLOW-009: invitations expire after 7 days and cannot be accepted late', async () => {
  const { db, owner } = await authed();
  const { invitation, token } = await createInvitation(
    db,
    TEN,
    { email: 'late@acme.test', name: 'Late', role: 'member' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq((await peekInvitationByToken(db, token, NOW))?.status, 'pending');
  const eightDays = new Date(Date.parse(NOW) + 8 * 24 * 60 * 60 * 1000).toISOString();
  eq((await peekInvitationByToken(db, token, eightDays))?.status, 'expired', 'peek marks expiry:');
  await rejects(() => acceptInvitation(db, token, 'a-late-member-password', eightDays), 'BAD_INVITATION');
  eq(
    (await listInvitations(db, TEN, eightDays)).find((i) => i.id === invitation.id)?.status,
    'expired',
    'the roster shows it expired rather than pending:',
  );
});
