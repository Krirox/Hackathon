import { T, eq, TEN, NOW, fresh, sor, base } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant, inviteUser, listUsers } from '../src/core/auth.ts';
import { describeStops } from '../src/gov/trust.ts';
import { mintReviewToken, verifyReviewToken, reviewSecretFromEnv } from '../src/talk/review-card.ts';
import { CANONICAL_ROOMS } from '../src/talk/rooms.ts';

/**
 * These tests exist because every route under `/api/buzz` was reachable with no
 * session at all. An anonymous caller could read tenant ledger content, rewrite
 * room policy, engage the scope kill switch and approve a pending
 * human-approval request. Each assertion below is one of those capabilities.
 */

console.log('\n\x1b[1mBuzz HTTP surface — authenticated or not\x1b[0m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

async function seeded() {
  const ctx = await fresh();
  const { db, ledger, coord } = ctx;
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const rel = await ledger.append({
    tenant: TEN,
    subject: 'release:v1',
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
  // A request waiting on a human: the exact thing an anonymous approval could
  // have waved through.
  const pending = await coord.submit(base({ id: 'rq_pending', goal: 'needs human sign-off', claimRefs: [rel.id] }));
  return { ...ctx, rel, pending: pending.request };
}

async function ownerSession(port: number) {
  const url = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${url}/login`, { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { cookie: preCookie },
    body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${url}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, headers: { cookie, 'x-vital-csrf': csrf } as Record<string, string> };
}

T('every /api/buzz route refuses an anonymous caller', async () => {
  const { db, ledger, coord, comp, pending } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const attempts: [string, RequestInit][] = [
      ['GET /api/buzz/rooms', { method: 'GET' }],
      ['GET /api/buzz/canvas/risk', { method: 'GET' }],
      ['GET /api/buzz/huddle/audio', { method: 'GET' }],
      [
        'POST /api/buzz/rooms/configure',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'risk', mission: 'INJECTED BY AN ANONYMOUS CALLER' }),
        },
      ],
      [
        'POST /api/buzz/commands (/halt)',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: '/halt scope:risk reason="anonymous"', scope: 'risk' }),
        },
      ],
      [
        'POST /api/buzz/webhook (approve, no token)',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'approve', requestId: pending.id }),
        },
      ],
      [`GET /api/buzz/webhook (approve link, no token)`, { method: 'GET' }],
    ];

    for (const [label, init] of attempts) {
      const target = label.includes('webhook')
        ? `${url}/api/buzz/webhook?action=approve&req=${pending.id}`
        : `${url}${label.split(' ')[1]}`;
      const res = await fetch(target, init);
      eq(res.status, 401, `${label} must refuse an anonymous caller:`);
    }

    // The dangerous part is not the status code, it is the state: an anonymous
    // /halt must not have engaged a stop, and an anonymous approve must not have
    // admitted the request.
    eq((await describeStops(db, TEN)).length, 0, 'no stop was engaged by an anonymous caller:');
    eq((await coord.get(TEN, pending.id))!.state, 'ADMITTED', 'the pending request is still pending:');

    // Neither must the room config have been rewritten.
    const { loadRoomConfig } = await import('../src/talk/rooms.ts');
    const cfg = await loadRoomConfig(db, TEN, 'risk');
    eq(cfg.mission.includes('INJECTED BY AN ANONYMOUS CALLER'), false, 'room policy was not rewritten:');
  } finally {
    await server.close();
  }
});

T('a forged or missing-secret review token never approves anything', async () => {
  const { db, ledger, coord, comp, pending } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    // A token minted under the old hard-coded secret must not be accepted, and
    // with VITAL_REVIEW_SECRET unset no token can verify at all.
    const legacy = mintReviewToken('vital-review-secret', TEN, pending.id, 'approve');
    const forged = mintReviewToken('some-other-secret', TEN, pending.id, 'approve');
    for (const [label, token] of [
      ['legacy hard-coded secret', legacy],
      ['attacker-chosen secret', forged],
    ] as const) {
      const res = await fetch(`${url}/api/buzz/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', requestId: pending.id, token }),
      });
      eq(res.status, 401, `a token signed with the ${label} is refused:`);
    }
    eq((await coord.get(TEN, pending.id))!.state, 'ADMITTED', 'the request is still pending:');
  } finally {
    await server.close();
  }
});

T('review tokens verify only under the configured secret, and fail closed when unset', async () => {
  const previous = process.env.VITAL_REVIEW_SECRET;
  try {
    delete process.env.VITAL_REVIEW_SECRET;
    eq(reviewSecretFromEnv(), null, 'an unconfigured deployment has no review secret:');

    process.env.VITAL_REVIEW_SECRET = 'a-configured-review-secret';
    const token = mintReviewToken('a-configured-review-secret', TEN, 'req_1', 'decline');
    const verified = verifyReviewToken(token, 'a-configured-review-secret');
    eq(verified.valid, true);
    eq(verified.action, 'decline');
    eq(verified.tenant, TEN);
    eq(verifyReviewToken(token, 'another-secret').valid, false, 'a different secret does not verify:');

    process.env.VITAL_REVIEW_SECRET = 'short';
    let threw = false;
    try {
      reviewSecretFromEnv();
    } catch {
      threw = true;
    }
    eq(threw, true, 'a too-short secret is refused rather than silently used:');
  } finally {
    if (previous === undefined) delete process.env.VITAL_REVIEW_SECRET;
    else process.env.VITAL_REVIEW_SECRET = previous;
  }
});

T('an authenticated admin can still administer rooms (no over-correction)', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const session = await ownerSession(server.port);
    const rooms = await fetch(`${url}/api/buzz/rooms`, { headers: session.headers });
    eq(rooms.status, 200, 'an admin session can read the roster:');
    const body = (await rooms.json()) as { ok: boolean; rooms: unknown[] };
    eq(body.rooms.length, CANONICAL_ROOMS.length, 'the roster has every canonical room:');

    const configure = await fetch(`${url}/api/buzz/rooms/configure`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'risk', mission: 'Operator-authored mission' }),
    });
    eq(configure.status, 200, 'an admin can save room policy:');

    // ...but the same call without CSRF is refused: a session alone is not proof
    // the request came from our own UI.
    const noCsrf = await fetch(`${url}/api/buzz/rooms/configure`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'risk', mission: 'no csrf' }),
    });
    eq(noCsrf.status, 403, 'a mutation without CSRF is refused:');
  } finally {
    await server.close();
  }
});

T('a member reads rooms and chats, but governance commands stay admin-only', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    // The owner invites a member with a temporary password.
    const owner = await ownerSession(server.port);
    const usersBefore = await listUsers(db, TEN);
    const ownerUser = usersBefore.find((u) => u.role === 'owner')!;
    await inviteUser(
      db,
      TEN,
      { email: 'maya@acme.test', name: 'Maya Chen', role: 'member', team: 'engineering', password: 'temp-pass-123456' },
      { userId: ownerUser.id, role: ownerUser.role },
      NOW,
    );

    // The member signs in with the temporary password...
    const pre = await fetch(`${url}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const loginRes = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&email=maya%40acme.test&password=temp-pass-123456`,
      redirect: 'manual',
    });
    const tempCookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    // ...is forced through the password change, which revokes the session...
    const cpPage = await fetch(`${url}/change-password`, { headers: { cookie: tempCookie }, redirect: 'manual' });
    const cpHtml = await cpPage.text();
    eq(cpPage.status, 200, 'member lands on the forced password-change page:');
    const cpCsrf = cpHtml.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const cpRes = await fetch(`${url}/change-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: tempCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${cpCsrf}&password=mayas-real-password-9`,
    });
    eq(cpRes.status, 303, 'password change accepted:');

    // ...then signs in for real.
    const pre2 = await fetch(`${url}/login`, { redirect: 'manual' });
    const pre2Cookie = (pre2.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const pre2Token = (await pre2.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const login2 = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { cookie: pre2Cookie },
      body: `csrf=${pre2Token}&email=maya%40acme.test&password=mayas-real-password-9`,
      redirect: 'manual',
    });
    const cookie = (login2.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const home = await (await fetch(`${url}/`, { headers: { cookie }, redirect: 'manual' })).text();
    const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;

    // READ: the member sees the room roster and the room itself.
    const roster = await fetch(`${url}/console/buzz`, { headers: { cookie }, redirect: 'manual' });
    eq(roster.status, 200, 'member can read the room roster:');
    const rosterHtml = await roster.text();
    eq(rosterHtml.includes('general'), true, 'roster lists the general room:');

    const room = await fetch(`${url}/console/buzz/general`, { headers: { cookie }, redirect: 'manual' });
    eq(room.status, 200, 'member can read a room:');
    const roomHtml = await room.text();
    eq(roomHtml.includes('name="csrf"'), true, 'room renders the composer:');

    // CHAT: the member posts a message and it lands in the room.
    const chat = await fetch(`${url}/console/buzz/general/command`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-vital-csrf': csrf },
      body: `csrf=${csrf}&command=hello from the member account`,
    });
    eq(chat.status, 303, 'member can chat:');
    const afterHtml = await (await fetch(`${url}/console/buzz/general`, { headers: { cookie } })).text();
    eq(afterHtml.includes('hello from the member account'), true, 'the message renders in the room:');

    // GOVERNANCE: /halt is refused for a member — the kill switch stays admin+.
    const halt = await fetch(`${url}/console/buzz/general/command`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-vital-csrf': csrf },
      body: `csrf=${csrf}&command=${encodeURIComponent('/halt reason="member overreach"')}`,
    });
    eq(halt.status, 403, 'member cannot /halt:');

    // The owner still can — the gate is a privilege check, not a breakage.
    const halt2 = await fetch(`${url}/console/buzz/general/command`, {
      method: 'POST',
      redirect: 'manual',
      headers: owner.headers,
      body: `csrf=${owner.csrf}&command=${encodeURIComponent('/halt reason="drill"')}`,
    });
    eq(halt2.status, 303, 'owner can still /halt:');

    // Governance actions are audited with the real actor.
    const halted = await db
      .prepare("SELECT actor FROM audit_log WHERE tenant = ? AND action = 'buzz.command' ORDER BY at DESC LIMIT 1")
      .get(TEN);
    eq(String((halted as { actor?: string } | undefined)?.actor ?? '').includes('owner'), true, 'halt audited under the owner:');
  } finally {
    await server.close();
  }
});
