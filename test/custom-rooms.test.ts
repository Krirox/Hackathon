import { T, eq, TEN, NOW, fresh } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant, createInvitation, acceptInvitation } from '../src/core/auth.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import {
  createCustomRoom,
  listCustomRooms,
  resolveRoomDef,
  isCanonicalScope,
  isRoomCategory,
  categoryForScope,
  loadRoomConfig,
} from '../src/talk/rooms.ts';
import { ScopeHealthEvaluator } from '../src/talk/health.ts';

/**
 * User-made chat rooms: creating a room via the setup surface makes it
 * appear in the roster, sidebar, and health rollups, with its own thread
 * view. Unknown scopes still 404 instead of rendering the wrong room.
 */

console.log('\n\x1b[1mCustom rooms — user-made chat rooms\x1b[1m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

async function setupTestApp() {
  const ctx = await fresh();
  const { db } = ctx;
  const comp = new OrganizationalCompiler(db);
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  return { ...ctx, comp };
}

async function ownerSession(port: number) {
  const base = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${base}/login`, { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { cookie: preCookie },
    body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, headers: { cookie } as Record<string, string> };
}

T('custom rooms: create validates scope, agent, and collisions', async () => {
  const { db } = await setupTestApp();
  try {
    const created = await createCustomRoom(
      db,
      TEN,
      { id: 'design', name: 'design', scope: 'design', agentName: 'design-agent', mission: 'Design reviews.' },
      'human:owner',
    );
    eq(created.scope, 'design');
    eq(created.channel, 'chan-design');
    const listed = await listCustomRooms(db, TEN);
    eq(
      listed.some((c) => c.scope === 'design'),
      true,
    );
    eq(isCanonicalScope('design'), false);
    eq(isCanonicalScope('general'), true);

    let taken = '';
    try {
      await createCustomRoom(
        db,
        TEN,
        { id: 'x', name: 'x', scope: 'design', agentName: 'other-agent', mission: '' },
        'human:owner',
      );
    } catch (e) {
      taken = (e as Error).message;
    }
    eq(taken.includes('SCOPE_TAKEN'), true, 'duplicate scope is refused:');

    let builtin = '';
    try {
      await createCustomRoom(
        db,
        TEN,
        { id: 'x', name: 'x', scope: 'finance', agentName: 'other-agent', mission: '' },
        'human:owner',
      );
    } catch (e) {
      builtin = (e as Error).message;
    }
    eq(builtin.includes('SCOPE_TAKEN'), true, 'built-in scope is refused:');

    let badAgent = '';
    try {
      await createCustomRoom(
        db,
        TEN,
        { id: 'x', name: 'x', scope: 'uniq-scope', agentName: 'notanagent', mission: '' },
        'human:owner',
      );
    } catch (e) {
      badAgent = (e as Error).message;
    }
    eq(badAgent.includes('BAD_AGENT'), true, 'agent name shape is enforced:');

    let badCategory = '';
    try {
      await createCustomRoom(
        db,
        TEN,
        {
          id: 'y',
          name: 'y',
          scope: 'uniq-scope-2',
          agentName: 'other-agent',
          mission: '',
          category: 'department-xyz',
        },
        'human:owner',
      );
    } catch (e) {
      badCategory = (e as Error).message;
    }
    eq(badCategory.includes('BAD_CATEGORY'), true, 'category is a closed set:');

    const launched = await createCustomRoom(
      db,
      TEN,
      { id: 'war', name: 'war', scope: 'war-room', agentName: 'war-agent', mission: '', category: 'launch' },
      'human:owner',
    );
    eq(launched.category, 'launch', 'category is stored:');
    eq((await resolveRoomDef(db, TEN, 'war-room'))?.category, 'launch', 'def carries the category:');
  } finally {
    await db.close();
  }
});

T('custom rooms: def resolution, config, and health rollups', async () => {
  const { db } = await setupTestApp();
  try {
    await createCustomRoom(
      db,
      TEN,
      { id: 'design', name: 'design', scope: 'design', agentName: 'design-agent', mission: 'Design reviews.' },
      'human:owner',
    );
    const def = await resolveRoomDef(db, TEN, 'design');
    eq(def?.name, 'design');
    eq(def?.agentName, 'design-agent');
    eq(await resolveRoomDef(db, TEN, 'no-such-room-xyz'), null, 'unknown scopes resolve to null:');
    const cfg = await loadRoomConfig(db, TEN, 'design');
    eq(cfg.name, 'design', 'config uses the custom name, not the general fallback:');
    eq(cfg.agentName, 'design-agent');
    const evals = await new ScopeHealthEvaluator(db, TEN, {}).evaluateAll();
    eq(
      evals.some((e) => e.scope === 'design' && e.roomName === 'design'),
      true,
      'custom room joins the health rollup:',
    );
    eq(isRoomCategory('launch'), true, 'closed category set:');
    eq(isRoomCategory('department-xyz'), false, 'open-ended categories refused:');
    eq(categoryForScope('general'), 'core', 'canonical group mapping:');
    eq(categoryForScope('infra'), 'product', 'canonical group mapping:');
    eq(categoryForScope('finance'), 'launch', 'canonical group mapping:');
  } finally {
    await db.close();
  }
});

T('room policy mutation requires admin: members refused, ceilings capped', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const ownerRec = (await db.prepare('SELECT id FROM users WHERE tenant = ? AND email = ?').get(TEN, OWNER.email)) as {
    id: string;
  };
  const { token: inviteToken } = await createInvitation(
    db,
    TEN,
    { email: 'member@acme.test', name: 'Member', role: 'member', team: 'unassigned' },
    { userId: ownerRec.id, role: 'owner' },
    NOW,
  );
  await acceptInvitation(db, inviteToken, 'a-long-enough-password', NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const loginAs = async (email: string, password: string) => {
      const pre = await fetch(`${url}/login`, { redirect: 'manual' });
      const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
      const loginRes = await fetch(`${url}/login`, {
        method: 'POST',
        headers: { cookie: preCookie },
        body: `csrf=${preToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
        redirect: 'manual',
      });
      if (loginRes.status !== 303) throw new Error(`login failed for ${email}: ${loginRes.status}`);
      const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const homeRes = await fetch(`${url}/`, { headers: { cookie } });
      if (homeRes.status !== 200) throw new Error(`home failed for ${email}: ${homeRes.status}`);
      const home = await homeRes.text();
      const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
      return { cookie, csrf };
    };
    const member = await loginAs('member@acme.test', 'a-long-enough-password');
    const memberPost = await fetch(`${url}/setup/rooms`, {
      method: 'POST',
      headers: { cookie: member.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${member.csrf}&mission_general=member+rewrite`,
      redirect: 'manual',
    });
    eq(memberPost.status, 403, 'member cannot mutate room policy:');

    const owner = await loginAs(OWNER.email, OWNER.password);
    const overCap = await fetch(`${url}/setup/rooms`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&budget_general=999999999`,
      redirect: 'manual',
    });
    eq(overCap.status, 400, 'over-cap ceiling refused:');
    const cfg = await loadRoomConfig(db, TEN, 'general');
    eq(cfg.budgetCeilingDollars <= 100_000, true, 'ceiling unchanged by over-cap attempt:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('custom rooms: setup POST creates the room; roster, thread, and 404 behave', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const base = `http://127.0.0.1:${server.port}`;
    const createRes = await fetch(`${base}/setup/rooms`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: session.csrf,
        newRoomId: 'design',
        newRoomName: 'design',
        newRoomScope: 'design',
        newRoomAgent: 'design-agent',
        newRoomMission: 'Design reviews.',
        newRoomCategory: 'launch',
      }).toString(),
      redirect: 'manual',
    });
    eq(createRes.status, 303, 'create redirects:');

    const roster = await (await fetch(`${base}/console/buzz`, { headers: session.headers })).text();
    eq(roster.includes('#design</a>'), true, 'roster lists the new room:');
    eq(roster.includes('@design-agent'), true, 'roster shows the custom agent:');
    // The roster is the Buzz surface, which mirrors upstream Buzz's own layout
    // and is deliberately not re-skinned by the Console design system, so it
    // renders no category chip — a custom room lands in the sidebar's catch-all
    // group the way any non-canonical scope does. The category is a real stored
    // field and is asserted where it drives the Console sidebar's groups and
    // the setup form; see the data-layer assertions above.

    const room = await fetch(`${base}/console/buzz/design`, { headers: session.headers });
    eq(room.status, 200, 'custom room thread renders:');
    const roomHtml = await room.text();
    eq(roomHtml.includes('design-agent'), true, 'thread shows the custom agent:');

    const missing = await fetch(`${base}/console/buzz/no-such-room-xyz`, {
      headers: session.headers,
      redirect: 'manual',
    });
    eq(missing.status, 404, 'unknown scopes still 404:');
  } finally {
    await server.close();
    await db.close();
  }
});
