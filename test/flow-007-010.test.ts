import { T, eq, rejects, fresh, TEN, NOW } from './helpers.ts';
import {
  installAuthSchema,
  signupTenant,
  login,
  verifySession,
  sessionCookie,
  sessionRemainingMs,
  nextSessionExpiry,
  SESSION_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  EMAIL_VERIFICATION_TTL_MS,
  MFA_RECENT_AUTH_WINDOW_MS,
  MFA_TOTP_STEP_SEC,
  requestEmailVerification,
  confirmEmailVerification,
  isEmailVerified,
  verifyEmailBeforeRecovery,
  recoveryChannelStatus,
  newTotpSecret,
  totpCode,
  verifyTotpCode,
  confirmMfaEnrollment,
  listMfaFactors,
  isMfaEnabled,
  removeMfaFactor,
  verifyMfaCode,
  generateMfaRecoveryCodes,
  consumeMfaRecoveryCode,
  countLiveRecoveryCodes,
  assertRecentAuthForSensitiveOp,
  mfaPolicy,
  inviteUser,
} from '../src/core/auth.ts';
import {
  addPreCsrfToken,
  parsePreCsrfFamily,
  preCsrfFamilyOk,
  expiredDraftCarry,
  sessionExpiredWithDraft,
  sessionCookieMaxAge,
} from '../src/console/session-flow.ts';
import { startConsoleServer, type ConsoleServer } from '../src/console/serve.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';

console.log('\n\x1b[1mFLOW-007/010 — email verification, MFA, lifetimes, drafts, multi-tab\x1b[0m');

const SIGNUP = {
  slug: 'acme',
  name: 'Acme Inc',
  email: 'owner@acme.test',
  password: 'correct horse battery staple',
  ownerName: 'Ada Owner',
};

async function authed() {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const { tenant, owner } = await signupTenant(ctx.db, SIGNUP, NOW);
  return { ...ctx, tenant, owner };
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
    { tenant: TEN, now },
  );
  return { ...ctx, s, port: s.port };
}

async function preCsrf(port: number, path = '/login'): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();
  const m = html.match(/name="csrf" value="([0-9a-f]+)"/);
  if (!m) throw new Error(`no pre-session csrf on ${path}`);
  return { cookie, csrf: m[1]! };
}

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

// ------------------------------------------------- FLOW-007 email verification ----

T('FLOW-007: email verification lifecycle — request, confirm, persistent flag', async () => {
  const { db, owner } = await authed();
  eq(await isEmailVerified(db, TEN, owner.id), false, 'fresh owner starts unverified:');
  eq(await verifyEmailBeforeRecovery(db, TEN, owner.id, NOW), false);
  const token = await requestEmailVerification(db, TEN, owner.id, NOW);
  eq(token.length > 20, true);
  const stored = (await db.prepare('SELECT token_hash FROM email_verifications').all()) as { token_hash: string }[];
  eq(
    stored.some((r) => r.token_hash.includes(token)),
    false,
    'the token is never stored raw:',
  );
  const user = await confirmEmailVerification(db, token, NOW);
  eq(user.id, owner.id);
  eq(await isEmailVerified(db, TEN, owner.id), true, 'confirmation sets the persistent flag:');
  eq(await verifyEmailBeforeRecovery(db, TEN, owner.id, NOW), true);
  // Single use + unknown token.
  await rejects(() => confirmEmailVerification(db, token, NOW), 'BAD_VERIFICATION_TOKEN', 'single use:');
  await rejects(() => confirmEmailVerification(db, 'nope', NOW), 'BAD_VERIFICATION_TOKEN');
});

T('FLOW-007: verification tokens expire after 24h; the verified flag never lapses', async () => {
  const { db, owner } = await authed();
  const token = await requestEmailVerification(db, TEN, owner.id, NOW);
  const late = new Date(Date.parse(NOW) + EMAIL_VERIFICATION_TTL_MS + 1000).toISOString();
  await rejects(() => confirmEmailVerification(db, token, late), 'BAD_VERIFICATION_TOKEN', 'stale token refused:');
  const fresh2 = await requestEmailVerification(db, TEN, owner.id, NOW);
  await confirmEmailVerification(db, fresh2, NOW);
  const yearLater = new Date(Date.parse(NOW) + 366 * 24 * 60 * 60 * 1000).toISOString();
  eq(await isEmailVerified(db, TEN, owner.id), true, 'verified stays verified — no re-lapse:');
  eq(await verifyEmailBeforeRecovery(db, TEN, owner.id, yearLater), true);
  await rejects(() => requestEmailVerification(db, TEN, 'usr_missing', NOW), 'UNKNOWN_USER');
});

T('FLOW-007: recovery messaging gates on verification without enumerating strangers', async () => {
  const { db, owner } = await authed();
  const unverified = await recoveryChannelStatus(db, TEN, 'owner@acme.test');
  eq(unverified, { exists: true, verified: false, userId: owner.id });
  const ghost = await recoveryChannelStatus(db, TEN, 'ghost@acme.test');
  eq(ghost.exists, false);
  eq(ghost.verified, false);
  const token = await requestEmailVerification(db, TEN, owner.id, NOW);
  await confirmEmailVerification(db, token, NOW);
  eq((await recoveryChannelStatus(db, TEN, 'owner@acme.test')).verified, true);
});

T('FLOW-007: forgot-password warns when the address is unverified', async () => {
  process.env.VITAL_EXPOSE_RESET_TOKEN = '1';
  const { s, port } = await served();
  try {
    const pre = await preCsrf(port, '/forgot-password');
    const real = await fetch(`http://127.0.0.1:${port}/forgot-password`, {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&email=owner%40acme.test`,
    });
    const html = await real.text();
    eq(real.status, 200);
    eq(html.includes('not yet verified') || html.includes('unverified'), true, 'unverified recovery warns:');
    // Strangers get the same neutral shape (no oracle either way).
    const ghost = await fetch(`http://127.0.0.1:${port}/forgot-password`, {
      method: 'POST',
      headers: { cookie: pre.cookie },
      body: `csrf=${pre.csrf}&email=ghost%40acme.test`,
    });
    const ghostHtml = await ghost.text();
    eq(ghostHtml.includes('If an account exists'), true);
    eq(ghostHtml.includes('not yet verified'), false, 'unknown accounts are not distinguished:');
  } finally {
    delete process.env.VITAL_EXPOSE_RESET_TOKEN;
    await s.close();
  }
});

T('FLOW-007: verify-email HTTP confirms a requested link; reuse fails', async () => {
  process.env.VITAL_EXPOSE_VERIFY_LINK = '1';
  const { s, port, db, owner } = await served();
  try {
    const { cookie } = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const home = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })).text();
    const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const reqRes = await fetch(`http://127.0.0.1:${port}/account/email/request`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}`,
    });
    eq(reqRes.status, 200);
    const issued = (await reqRes.json()) as { ok: boolean; verifyLink: string };
    eq(issued.ok, true);
    const first = await fetch(`http://127.0.0.1:${port}${issued.verifyLink}`);
    eq(first.status, 200);
    eq((await first.text()).includes('Email verified'), true);
    eq(await isEmailVerified(db, TEN, owner.id), true);
    const again = await fetch(`http://127.0.0.1:${port}${issued.verifyLink}`);
    eq(again.status, 400, 'single use over HTTP too:');
  } finally {
    delete process.env.VITAL_EXPOSE_VERIFY_LINK;
    await s.close();
  }
});

T('FLOW-007: account page names the verification state', async () => {
  const { s, port, db, owner } = await served();
  try {
    const { cookie } = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    const before = await (await fetch(`http://127.0.0.1:${port}/account`, { headers: { cookie } })).text();
    eq(before.includes('not yet verified'), true, 'unverified state is explicit:');
    const token = await requestEmailVerification(db, TEN, owner.id, NOW);
    await confirmEmailVerification(db, token, NOW);
    const after = await (await fetch(`http://127.0.0.1:${port}/account`, { headers: { cookie } })).text();
    eq(after.includes('Email verified'), true);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ FLOW-007 MFA ----

T('FLOW-007: mfaPolicy pins the supported strategy', () => {
  const p = mfaPolicy();
  eq(p.secondFactor.includes('TOTP'), true);
  eq(p.recovery.includes('recovery codes'), true);
  eq(p.recentAuthWindowMs, MFA_RECENT_AUTH_WINDOW_MS);
  eq(p.sensitiveOps.includes('role-change'), true);
  eq(p.sensitiveOps.includes('disable'), true);
  eq(p.webauthn.includes('not an offered factor'), true);
});

T('FLOW-007: TOTP enroll → verify → wrong code fails, skew window holds', async () => {
  const { db, owner } = await authed();
  eq(await isMfaEnabled(db, owner.id), false);
  const secret = newTotpSecret();
  const atMs = Date.parse(NOW);
  const code = totpCode(secret, atMs);
  eq(verifyTotpCode(secret, code, atMs), true);
  eq(verifyTotpCode(secret, '000000', atMs), false, 'wrong code fails:');
  eq(verifyTotpCode(secret, 'not-digits', atMs), false);
  // Adjacent 30s step still verifies (clock skew); two steps out does not.
  eq(verifyTotpCode(secret, totpCode(secret, atMs - MFA_TOTP_STEP_SEC * 1000), atMs), true);
  eq(verifyTotpCode(secret, totpCode(secret, atMs - 3 * MFA_TOTP_STEP_SEC * 1000), atMs), false);
  await rejects(
    () => confirmMfaEnrollment(db, TEN, owner.id, secret, '000000', NOW),
    'BAD_TOTP_CODE',
    'enrollment needs a live code:',
  );
  const factor = await confirmMfaEnrollment(db, TEN, owner.id, secret, code, NOW);
  eq(factor.kind, 'totp');
  eq(await isMfaEnabled(db, owner.id), true);
  eq((await listMfaFactors(db, owner.id)).length, 1);
  eq(await verifyMfaCode(db, TEN, owner.id, totpCode(secret, atMs), NOW), true);
  eq(await verifyMfaCode(db, TEN, owner.id, '000000', NOW), false);
  await removeMfaFactor(db, TEN, owner.id, factor.id, NOW);
  eq(await isMfaEnabled(db, owner.id), false);
  await rejects(() => removeMfaFactor(db, TEN, owner.id, factor.id, NOW), 'UNKNOWN_MFA_FACTOR');
});

T('FLOW-007: recovery codes are single-use hashed sets with rotation', async () => {
  const { db, owner } = await authed();
  const codes = await generateMfaRecoveryCodes(db, TEN, owner.id, NOW);
  eq(codes.length, 10);
  eq(await countLiveRecoveryCodes(db, owner.id), 10);
  const stored = (await db.prepare('SELECT code_hash FROM mfa_recovery_codes').all()) as { code_hash: string }[];
  eq(
    stored.some((r) => codes.some((c) => r.code_hash.includes(c))),
    false,
    'codes never persist raw:',
  );
  eq(await consumeMfaRecoveryCode(db, TEN, owner.id, codes[0]!, NOW), true);
  eq(await countLiveRecoveryCodes(db, owner.id), 9);
  eq(await consumeMfaRecoveryCode(db, TEN, owner.id, codes[0]!, NOW), false, 'consumed codes die:');
  eq(await consumeMfaRecoveryCode(db, TEN, owner.id, 'bogus-code', NOW), false);
  // Rotation: a fresh set discards the unused old ones.
  const rotated = await generateMfaRecoveryCodes(db, TEN, owner.id, NOW);
  eq(await countLiveRecoveryCodes(db, owner.id), 10);
  eq(await consumeMfaRecoveryCode(db, TEN, owner.id, codes[1]!, NOW), false, 'old set is dead:');
  eq(await consumeMfaRecoveryCode(db, TEN, owner.id, rotated[0]!, NOW), true);
});

T('FLOW-007: recent-auth step-up passes fresh, fails stale and sessionless', async () => {
  const { db, owner } = await authed();
  await rejects(() => assertRecentAuthForSensitiveOp(db, owner.id, NOW), 'REAUTH_REQUIRED', 'no session:');
  await login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW);
  await assertRecentAuthForSensitiveOp(db, owner.id, NOW);
  const stale = new Date(Date.parse(NOW) + MFA_RECENT_AUTH_WINDOW_MS + 1000).toISOString();
  await rejects(() => assertRecentAuthForSensitiveOp(db, owner.id, stale), 'REAUTH_REQUIRED', 'stale session:');
});

T('FLOW-007: stale-but-live sessions hit REAUTH_REQUIRED on sensitive ops', async () => {
  let at = NOW;
  const ctx = await authed();
  const s = await startConsoleServer(
    ctx.db,
    createLedger(ctx.db),
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: TEN, now: () => at },
  );
  try {
    const member = await inviteUser(
      ctx.db,
      TEN,
      { email: 'dev@acme.test', name: 'Dev', role: 'member', password: 'a-long-member-password' },
      { userId: ctx.owner.id, role: ctx.owner.role },
      NOW,
    );
    const logged = await loginViaHttp(s.port, 'owner@acme.test', SIGNUP.password);
    const home = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { cookie: logged.cookie } })).text();
    const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    // 16 minutes later: inside the 12h idle window (live) but past the 15min
    // step-up window (stale for sensitive ops).
    at = new Date(Date.parse(NOW) + 16 * 60 * 1000).toISOString();
    const role = await fetch(`http://127.0.0.1:${s.port}/team/role`, {
      method: 'POST',
      headers: { cookie: logged.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}&userId=${member.id}&role=admin`,
    });
    eq(role.status, 403);
    const roleBody = (await role.json()) as { code: string };
    eq(roleBody.code, 'REAUTH_REQUIRED');
    // The refusal changed nothing.
    eq((await ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(member.id)) as unknown, { role: 'member' });
    const disable = await fetch(`http://127.0.0.1:${s.port}/team/disable`, {
      method: 'POST',
      headers: { cookie: logged.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}&userId=${member.id}&confirmEmail=dev%40acme.test`,
    });
    eq(disable.status, 403);
    eq(((await disable.json()) as { code: string }).code, 'REAUTH_REQUIRED');
    // A fresh sign-in clears the gate.
    at = NOW;
    const freshLogin = await loginViaHttp(s.port, 'owner@acme.test', SIGNUP.password);
    const freshHome = await (
      await fetch(`http://127.0.0.1:${s.port}/`, { headers: { cookie: freshLogin.cookie } })
    ).text();
    const freshCsrf = freshHome.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    const ok = await fetch(`http://127.0.0.1:${s.port}/team/role`, {
      method: 'POST',
      headers: { cookie: freshLogin.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${freshCsrf}&userId=${member.id}&role=admin`,
    });
    eq(ok.status, 200);
    eq((await ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(member.id)) as unknown, { role: 'admin' });
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------- FLOW-010 lifetimes ----

T('FLOW-010: idle expiry, sliding refresh, and absolute cap are distinct', async () => {
  const { db } = await authed();
  const { token, session } = await login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW);
  // Sliding: an early touch re-arms the full idle window.
  const touched = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
  const s2 = await verifySession(db, token, touched);
  eq(s2.expiresAt, nextSessionExpiry(session.createdAt, touched), 'touch re-arms idle:');
  // Idle death: silence past the window kills the session.
  const idleDead = new Date(Date.parse(touched) + SESSION_TTL_MS + 1000).toISOString();
  await rejects(() => verifySession(db, token, idleDead), 'EXPIRED_SESSION', 'idle expiry:');
  // Absolute cap: steady activity keeps idle alive for days, yet the session
  // still dies at creation + 7d.
  const { token: token2, session: session2 } = await login(
    db,
    { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password },
    NOW,
  );
  let atMs = Date.parse(NOW);
  for (let i = 0; i < 15; i++) {
    atMs += 11 * 60 * 60 * 1000; // every 11h — inside each idle window
    await verifySession(db, token2, new Date(atMs).toISOString());
  }
  eq(atMs > Date.parse(NOW) + 6 * 24 * 60 * 60 * 1000, true, 'the session stayed active ~7 days:');
  const beyondAbsolute = new Date(Date.parse(session2.createdAt) + SESSION_ABSOLUTE_TTL_MS + 1000).toISOString();
  await rejects(() => verifySession(db, token2, beyondAbsolute), 'EXPIRED_SESSION', 'absolute expiry:');
});

T('FLOW-010: cookie Max-Age tracks the database row (idle and absolute)', async () => {
  const { db } = await authed();
  const { token, session } = await login(db, { tenant: TEN, email: 'owner@acme.test', password: SIGNUP.password }, NOW);
  const cookie = sessionCookie(token, NOW, false, session);
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)![1]);
  eq(maxAge, Math.floor(SESSION_TTL_MS / 1000), 'fresh cookie spans the idle window:');
  eq(maxAge, sessionCookieMaxAge(session, NOW), 'helper and header agree:');
  eq(sessionRemainingMs(session, NOW), SESSION_TTL_MS);
  // Near the absolute cap (after days of 11-hourly activity) the cookie
  // shrinks to the remaining absolute time instead of the idle window.
  let atMs = Date.parse(NOW);
  let live = session;
  for (let i = 0; i < 15; i++) {
    atMs += 11 * 60 * 60 * 1000;
    live = await verifySession(db, token, new Date(atMs).toISOString());
  }
  const late = new Date(atMs).toISOString();
  const lateCookie = sessionCookie(token, late, false, live);
  const lateMax = Number(lateCookie.match(/Max-Age=(\d+)/)![1]);
  eq(lateMax < Math.floor(SESSION_TTL_MS / 1000), true, 'cookie honors the absolute cap, not the idle window:');
  eq(lateMax, sessionCookieMaxAge(live, late), 'helper and header still agree at the cap:');
  eq(sessionRemainingMs(live, late) <= 3 * 60 * 60 * 1000 + 1000, true);
});

T('FLOW-010: verified page views refresh the cookie alongside the DB row', async () => {
  let at = NOW;
  const { s, port } = await served(() => at);
  try {
    const { cookie } = await loginViaHttp(port, 'owner@acme.test', SIGNUP.password);
    at = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
    eq(res.status, 200);
    const refreshed = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vital_session='));
    eq(refreshed !== undefined, true, 'the console re-issues the cookie on verified views:');
    eq(/Max-Age=(\d+)/.test(refreshed!), true);
    eq(Number(refreshed!.match(/Max-Age=(\d+)/)![1]) > 0, true);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------- FLOW-010 drafts ----

T('FLOW-010: expired correction keeps the non-secret draft, never secrets', () => {
  const carried = expiredDraftCarry({
    statement: 'corrected wording',
    reason: 'stale evidence',
    password: 'correct horse battery staple',
    csrf: 'abc123',
    token: 'opaque',
    signature: 'deadbeef',
    operatorSecret: 'x',
  });
  eq(carried, { statement: 'corrected wording', reason: 'stale evidence' });
  const envelope = sessionExpiredWithDraft('/console/claims/c1', {
    statement: 'keep me',
    password: 'drop me',
  });
  eq(envelope.code, 'SESSION_EXPIRED');
  eq(envelope.draft, { statement: 'keep me' });
  eq(envelope.loginUrl.includes('reason=expired'), true);
});

T('FLOW-010: expired correction POST returns the draft for resubmission', async () => {
  let at = NOW;
  const ctx = await authed();
  const ledger = createLedger(ctx.db);
  const s = await startConsoleServer(
    ctx.db,
    ledger,
    createCoordinator(ctx.db),
    new OrganizationalCompiler(ctx.db),
    { tenant: TEN, now: () => at },
  );
  try {
    const rel = await ledger.append({
      tenant: TEN,
      subject: 'draft:carry',
      kind: 'FACT',
      statement: 'original',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: { sourceUri: 'https://example.test/x', sourceTier: 'SYSTEM_OF_RECORD', extractor: 't', extractorVersion: '1', retrievedAt: NOW },
    });
    const { cookie } = await loginViaHttp(s.port, 'owner@acme.test', SIGNUP.password);
    const home = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { cookie } })).text();
    const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    // Expire the session (past the 12h idle window), then post a correction
    // carrying a secret-looking field alongside the real draft.
    at = new Date(Date.parse(NOW) + 13 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`http://127.0.0.1:${s.port}/api/claims/${rel.id}/correct`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-vital-csrf': csrf },
      body: JSON.stringify({ statement: 'fixed wording', password: 'correct horse battery staple' }),
    });
    eq(res.status, 401);
    const body = (await res.json()) as { code: string; draft: Record<string, string>; loginUrl: string };
    eq(body.code, 'SESSION_EXPIRED');
    eq(body.draft, { statement: 'fixed wording' }, 'draft survives, secrets do not:');
    eq(body.loginUrl.includes('reason=expired'), true);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------- FLOW-010 multi-tab ----

T('FLOW-010: pre-session token family keeps concurrent forms valid', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  let family = addPreCsrfToken(undefined, first);
  eq(parsePreCsrfFamily(family), [first]);
  family = addPreCsrfToken(family, second);
  eq(parsePreCsrfFamily(family), [first, second], 'tab B appends, tab A survives:');
  eq(preCsrfFamilyOk(family, first), true);
  eq(preCsrfFamilyOk(family, second), true);
  eq(preCsrfFamilyOk(family, 'c'.repeat(64)), false);
  eq(preCsrfFamilyOk(undefined, first), false);
  // Bounded: the family never grows past its cap.
  let big = '';
  for (let i = 0; i < 25; i++) big = addPreCsrfToken(big, `${i.toString(16).padStart(64, '0')}`);
  eq(parsePreCsrfFamily(big).length, 10);
  eq(preCsrfFamilyOk(big, '0'.repeat(64)), false, 'the oldest token ages out:');
  eq(preCsrfFamilyOk(big, (24).toString(16).padStart(64, '0')), true);
});

T('FLOW-010: two open login tabs both submit without invalidation', async () => {
  const { s, port } = await served();
  try {
    // Tab A loads the form.
    const tabA = await preCsrf(port, '/login');
    // Tab B loads the form WITH tab A's cookie (same browser): the family
    // must carry both tokens back.
    const resB = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { cookie: tabA.cookie },
      redirect: 'manual',
    });
    const cookieB = (resB.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const htmlB = await resB.text();
    const csrfB = htmlB.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    eq(csrfB !== tabA.csrf, true, 'each load mints its own token:');
    // Tab A submits first with the COMBINED cookie — valid.
    const submitA = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookieB },
      body: `csrf=${tabA.csrf}&email=owner%40acme.test&password=${encodeURIComponent(SIGNUP.password)}`,
    });
    eq(submitA.status, 303, 'tab A still submits after tab B loaded:');
    // Tab B submits too — also valid.
    const submitB = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookieB },
      body: `csrf=${csrfB}&email=owner%40acme.test&password=${encodeURIComponent(SIGNUP.password)}`,
    });
    eq(submitB.status, 303, 'tab B submits as well:');
  } finally {
    await s.close();
  }
});
