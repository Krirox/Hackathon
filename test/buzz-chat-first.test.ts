import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';

console.log('\n\x1b[1mBuzz Chat-First & Drawer Integration Test Suite\x1b[0m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };
const MARKETING_USER = { email: 'growth.marketing@acme.test', password: 'the-console-password' };

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
  await signupTenant(
    db,
    { slug: 'growth-tenant', name: 'Growth', email: MARKETING_USER.email, password: MARKETING_USER.password, ownerName: 'Mark' },
    NOW,
  );
  await db
    .prepare(
      'INSERT INTO decisions (id, tenant, goal, action, action_class, context_bundle, decided_by, scope, autonomy, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('dec_1', TEN, 'goal', 'action', 'class', '{}', 'owner', 'business', 'autonomous', NOW);
  return { ...ctx, comp };
}

async function loginUser(port: number, email: string, password: string) {
  const base_ = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${base_}/login`, {
    method: 'POST',
    headers: { cookie: preCookie },
    body: `csrf=${preToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const loginLocation = loginRes.headers.get('location');
  return { cookie, loginLocation };
}

T('GET / redirects 302 to /console/buzz/general and returns vital-csrf meta tag', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie, loginLocation } = await loginUser(server.port, OWNER.email, OWNER.password);
    eq(loginLocation?.includes('/console/buzz/general'), true);

    const rootRes = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie },
      redirect: 'manual',
    });
    eq(rootRes.status, 302);
    const loc = rootRes.headers.get('location');
    eq(loc?.includes('/console/buzz/general'), true);

    const body = await rootRes.text();
    const csrfMatch = body.match(/name="vital-csrf" content="([0-9a-f]+)"/);
    eq(Boolean(csrfMatch && csrfMatch[1]), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('GET /console/dashboard serves full system dashboard with reality health, compiler & sidebar button', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const dashRes = await fetch(`http://127.0.0.1:${server.port}/console/dashboard`, {
      headers: { cookie },
    });
    eq(dashRes.status, 200);
    const html = await dashRes.text();
    eq(html.includes('Reality health'), true);
    eq(html.includes('id="vital-dashboard-btn"'), true);
    eq(html.includes('href="/console/dashboard"'), true);
    eq(html.includes('Workspace'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('GET /?view=dashboard renders full system dashboard', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const res = await fetch(`http://127.0.0.1:${server.port}/?view=dashboard`, {
      headers: { cookie },
      redirect: 'manual',
    });
    eq(res.status, 200);
    const html = await res.text();
    eq(html.includes('Reality health'), true);
    eq(html.includes('id="vital-dashboard-btn"'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('GET /console/compiler serves Kanban board and supports ?drawer=1 fragment mode', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);

    // Full page mode
    const fullRes = await fetch(`http://127.0.0.1:${server.port}/console/compiler`, {
      headers: { cookie },
    });
    eq(fullRes.status, 200);
    const fullHtml = await fullRes.text();
    eq(fullHtml.includes('Compiler') && fullHtml.includes('Why not trusted yet'), true);
    eq(fullHtml.includes('Workspace'), true); // wrapped in shell

    // Drawer mode
    const drawerRes = await fetch(`http://127.0.0.1:${server.port}/console/compiler?drawer=1`, {
      headers: { cookie },
    });
    eq(drawerRes.status, 200);
    const drawerHtml = await drawerRes.text();
    eq(drawerHtml.includes('Compiler') && drawerHtml.includes('Why not trusted yet'), true);
    eq(drawerHtml.includes('<!DOCTYPE html>'), false); // fragment only
    eq(drawerHtml.includes('<aside style="background:#F4F7F5;'), false); // no outer shell
  } finally {
    await server.close();
    await db.close();
  }
});

T('Room console includes drawer buttons and slide-out panel markup', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const res = await fetch(`http://127.0.0.1:${server.port}/console/buzz/general`, {
      headers: { cookie },
    });
    eq(res.status, 200);
    const html = await res.text();
    eq(html.includes('openBuzzDrawer'), true);
    eq(html.includes('📊 Compiler'), true);
    eq(html.includes('📜 Ledger'), true);
    eq(html.includes('📋 Reviews'), true);
    eq(html.includes('id="buzz-drawer"'), true);
    eq(html.includes('id="vital-dashboard-btn"'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('Ledger search method returns matching claims by statement or subject', async () => {
  const { db, ledger } = await setupTestApp();
  try {
    await ledger.append({
      tenant: TEN,
      subject: 'brand:repositioning',
      kind: 'HYPOTHESIS',
      statement: 'Q4 marketing campaign targets enterprise healthcare',
      confidence: 0.95,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'marketing-agent',
      scope: 'business',
      authorType: 'agent',
      provenance: sor(),
    });

    const results = await ledger.search(TEN, { q: 'healthcare' });
    eq(results.length > 0, true);
    eq(results[0]?.subject, 'brand:repositioning');

    const empty = await ledger.search(TEN, { q: 'nonexistent-query-string-xyz' });
    eq(empty.length, 0);
  } finally {
    await db.close();
  }
});

T('Cross-room mention in command box dispatches handoff to target room agent', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const rootRes = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const csrf = (await rootRes.text()).match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;

    // Post cross-room mention from #general to @business-agent
    const postRes = await fetch(`http://127.0.0.1:${server.port}/console/buzz/general/command`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}&command=${encodeURIComponent('@business-agent prepare budget analysis for Q4')}`,
      redirect: 'manual',
    });
    eq([302, 303].includes(postRes.status), true);

    // Verify chat message and swarm dispatch in audit log
    const auditRows = (await db
      .prepare('SELECT action, target, actor FROM audit_log WHERE tenant = ? ORDER BY seq DESC')
      .all(TEN)) as { action: string; target: string; actor: string }[];

    const chatAction = auditRows.find((r) => r.action === 'buzz.chat');
    eq(Boolean(chatAction), true);

    const dispatchAction = auditRows.find((r) => r.action === 'buzz.dispatch');
    eq(Boolean(dispatchAction), true);
  } finally {
    await server.close();
    await db.close();
  }
});
