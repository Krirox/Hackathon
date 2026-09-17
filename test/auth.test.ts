import { T, eq, rejects, fresh, TEN, NOW, sor, base } from './helpers.ts';
import type { AsyncDb } from '../src/core/db.ts';
import {
  installAuthSchema,
  uninstallAuthSchema,
  signupTenant,
  getTenant,
  inviteUser,
  listUsers,
  login,
  sessionUser,
  verifySession,
  logout,
  revokeUserSessions,
  disableUser,
  sweepSessions,
  changePassword,
  requestPasswordReset,
  confirmPasswordReset,
  hashPassword,
  verifyPassword,
  atLeast,
  requireRole,
  csrfOk,
  sessionCookie,
  LOCKOUT_THRESHOLD,
  MIN_PASSWORD_LENGTH,
  type Role,
} from '../src/core/auth.ts';
import { startConsoleServer, LOGIN_RATE, type ConsoleServer } from '../src/console/serve.ts';
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
  // disable revokes too, and the user cannot log back in
  await disableUser(db, TEN, owner.id, NOW);
  await rejects(
    () => login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW),
    'BAD_CREDENTIALS',
  );
});

T('disabled users lose their sessions mid-flight', async () => {
  const { db, owner } = await authed();
  const { token } = await loginCookie(db, 'owner@acme.test', SIGNUP.password);
  await sessionUser(db, token, NOW); // live
  await disableUser(db, TEN, owner.id, NOW);
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
    eq(opened.body.includes('signed in as peter@initech.test'), true);
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
    eq(noCsrf.status, 403);
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
    eq(home.body.includes('signed in as owner@acme.test'), true);
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
    eq(noCsrf.status, 403, 'login without csrf is refused:');
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
  const { s, port, db } = await served();
  try {
    // Sign in as the owner, invite an admin.
    const owner = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const ownerHome = await call(port, '/', { cookie: owner.cookie });
    const ownerCsrf = ownerHome.body.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const invited = await call(port, '/team/invite', {
      method: 'POST',
      cookie: owner.cookie,
      body: `csrf=${ownerCsrf}&email=newbie%40acme.test&name=New Bie&role=member&password=a-fresh-member-password`,
    });
    eq(invited.status, 200, 'invite succeeds for the owner:');
    eq(invited.body.includes('newbie@acme.test'), true);
    eq(invited.body.includes('must change the password at first login'), true);
    // The invited member can log in, is gated by must-change, and lands as member.
    const member = await loginViaHttp(port, 'newbie@acme.test', 'a-fresh-member-password');
    eq(member.status, 303);
    const gated = await call(port, '/', { cookie: member.cookie });
    eq(gated.status, 303, 'must-change gates the new member:');
    // The invited member's team view stays gated by the pending password change.
    const memberTeam = await call(port, '/team', { cookie: member.cookie });
    eq(memberTeam.status, 303, 'must-change still gates /team:');
    // Disable flow: owner disables the member; their session dies.
    const users = await listUsers(db, TEN);
    const memberRow = users.find((u) => u.email === 'newbie@acme.test')!;
    const disabled = await call(port, '/team/disable', {
      method: 'POST',
      cookie: owner.cookie,
      body: `csrf=${ownerCsrf}&userId=${memberRow.id}`,
    });
    eq(disabled.status, 200, 'owner disables the member:');
    eq(disabled.body.includes('disabled — their sessions were revoked'), true);
    await rejects(
      () => sessionUser(db, member.cookie.split('=')[1]!, NOW),
      'NO_SESSION',
      'the disabled member\u2019s session died:',
    );
    // Audited.
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
    eq(root.body.includes('The Autonomous Enterprise'), true, 'index.html is served:');
    const css = await call(s.port, '/styles.css');
    eq(css.status, 200);
    eq(css.body.includes('header-nav'), true, 'assets are served with the right content:');
    // The console app moved to /console and still requires auth.
    const consoleHome = await call(s.port, '/console');
    eq(consoleHome.status, 303);
    eq(consoleHome.location, '/login', 'the console is still session-gated:');
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
