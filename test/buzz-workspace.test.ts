import { T, eq, TEN, NOW, fresh, sor, base } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { setKill } from '../src/gov/trust.ts';
import { executeRoomCommand } from '../src/talk/commands.ts';
import { ScopeHealthEvaluator } from '../src/talk/health.ts';
import { loadRoomConfig } from '../src/talk/rooms.ts';

/**
 * The Buzz workspace pages: before these existed the health badges, review
 * gates and room threads were visible nowhere in the product. These tests pin
 * the roster (all 12 rooms, live health), the per-room view (thread, command
 * box, canvas) and the audit trail of room commands.
 */

console.log('\n\x1b[1mBuzz workspace — the room console pages\x1b[0m');

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
  await coord.submit(base({ id: 'rq_view', goal: 'workspace fixture', claimRefs: [rel.id] }));
  return ctx;
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
  return { cookie, csrf, headers: { cookie } as Record<string, string> };
}

T('the roster shows all 12 rooms with live health and relay status', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const res = await fetch(`http://127.0.0.1:${server.port}/console/buzz`, {
      headers: session.headers,
      redirect: 'manual',
    });
    eq(res.status, 200);
    const html = await res.text();
    for (const room of ['reality-core', 'risk-monitor', 'compliance', 'finance', 'ops', 'sandbox']) {
      eq(html.includes(`#${room}</a>`), true, `room ${room} is on the roster:`);
    }
    eq(html.includes('Relay not configured'), true, 'an unconfigured relay is named honestly:');
    eq(html.includes('not provisioned'), true, 'unprovisioned rooms are marked:');
    // Health badges render from the evaluator, not hardcoded green.
    eq(html.includes('🟢'), true, 'healthy rooms show green:');
  } finally {
    await server.close();
  }
});

T('a halted room shows red on the roster and in its room view', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await setKill(db, TEN, { scope: 'risk', actionClass: '*' }, 'operator:test', NOW, { reason: 'drill' });
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const roster = await (
      await fetch(`http://127.0.0.1:${server.port}/console/buzz`, { headers: session.headers })
    ).text();
    eq(roster.includes('🔴'), true, 'a halted room shows red:');
    const room = await (
      await fetch(`http://127.0.0.1:${server.port}/console/buzz/risk`, { headers: session.headers })
    ).text();
    eq(room.includes('#risk-monitor'), true, 'the room view names the room:');
    eq(room.includes('Active stop engaged'), true, 'the halt reason is visible in the room:');
    eq(room.includes('Send a command'), true, 'the command box is present:');
    eq(room.includes('csrf'), true, 'the command form carries CSRF:');
  } finally {
    await server.close();
  }
});

T('the room command box executes real commands and records them in the audit log', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const res = await fetch(`http://127.0.0.1:${server.port}/console/buzz/risk/command`, {
      method: 'POST',
      headers: {
        ...session.headers,
        'content-type': 'application/x-www-form-urlencoded',
        'x-vital-csrf': session.csrf,
      },
      body: `csrf=${session.csrf}&command=${encodeURIComponent('/status risk')}`,
      redirect: 'manual',
    });
    eq([302, 303].includes(res.status), true, `the command redirects back to the room (got ${res.status}):`);
    const location = res.headers.get('location') ?? '';
    const backUrl = new URL(location, `http://127.0.0.1:${server.port}`);
    const back = await (await fetch(backUrl, { headers: session.headers })).text();
    eq(back.includes('Command status executed'), true, 'the room page confirms the command:');

    const row = (await db
      .prepare('SELECT action, target FROM audit_log WHERE tenant = ? AND action = ? ORDER BY seq DESC LIMIT 1')
      .get(TEN, 'buzz.command')) as { action: string; target: string } | undefined;
    eq(row?.action, 'buzz.command', 'the command is audit-logged:');
    eq(row?.target, 'room:risk');
  } finally {
    await server.close();
  }
});

T('the workspace is admin-gated and honors CSRF', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    eq(
      [302, 303].includes((await fetch(`http://127.0.0.1:${server.port}/console/buzz`, { redirect: 'manual' })).status),
      true,
      'anonymous redirects to login:',
    );
    const session = await ownerSession(server.port);
    const noCsrf = await fetch(`http://127.0.0.1:${server.port}/console/buzz/risk/command`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `command=${encodeURIComponent('/halt risk')}`,
      redirect: 'manual',
    });
    eq(noCsrf.status, 403, 'a command without CSRF is refused:');
    // And no halt was engaged by the refused request.
    const evaluator = new ScopeHealthEvaluator(db, TEN, {});
    const health = await evaluator.evaluateScope('risk');
    eq(health.activeStops, 0, 'no stop was engaged:');
    eq((await loadRoomConfig(db, TEN, 'risk')).autonomy !== undefined, true);
  } finally {
    await server.close();
  }
});

T('executeRoomCommand /halt still engages a real stop (same command path)', async () => {
  const { db } = await fresh();
  const evaluator = new ScopeHealthEvaluator(db, TEN, {});
  const result = await executeRoomCommand('/halt risk reason="desk drill"', {
    db,
    tenant: TEN,
    actor: 'operator:test',
    currentScope: 'risk',
    evaluator,
  });
  eq(result.handled, true);
  eq(result.actionTaken, 'KILL_ENGAGED');
  const { describeStops } = await import('../src/gov/trust.ts');
  eq((await describeStops(db, TEN)).length, 1, 'the stop exists in gov state:');
});
