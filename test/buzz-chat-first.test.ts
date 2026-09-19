import { T, eq, TEN, NOW, fresh, sor, withVmRoot } from './helpers.ts';
import { existsSync } from 'node:fs';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { ApplicationWorker } from '../src/substrate/worker.ts';

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
    {
      slug: 'growth-tenant',
      name: 'Growth',
      email: MARKETING_USER.email,
      password: MARKETING_USER.password,
      ownerName: 'Mark',
    },
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

T(
  'Tagging @coding-agent dispatches downstream task, provisions team microVM, multiplexes agents and saves snapshot',
  async () => {
    await withVmRoot(async (root) => {
      const { db, ledger, coord, comp } = await setupTestApp();
      const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
      try {
        const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
        const rootRes = await fetch(`http://127.0.0.1:${server.port}/`, {
          headers: { cookie },
          redirect: 'manual',
        });
        const csrf = (await rootRes.text()).match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;

        // 1. Post cross-room mention tagging @coding-agent from #general
        const postRes = await fetch(`http://127.0.0.1:${server.port}/console/buzz/general/command`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: `csrf=${csrf}&command=${encodeURIComponent('@coding-agent implement auth session rotation in microVM')}`,
          redirect: 'manual',
        });
        eq([302, 303].includes(postRes.status), true);

        // Verify request created in target_scope = 'infra'
        const pending = (await coord.list(TEN, { state: 'ADMITTED' })).filter((r) => r.targetScope === 'infra');
        eq(pending.length > 0, true, 'coordination request admitted for infra scope');
        const codingReq = pending[0]!;

        // 2. Run ApplicationWorker with real VM lifecycle (non-baseline adapter)
        let executedWorkingDir = '';
        const worker = new ApplicationWorker(db, ledger, coord, {
          tenant: TEN,
          adapter: {
            name: 'claude-code',
            category: 'model',
            isTestBaseline: false,
            async run(_t, _reqId, opts) {
              executedWorkingDir = opts.workingDir ?? '';
              return {
                status: 'COMPLETED',
                adapter: 'claude-code',
                requestId: _reqId,
                transcript: 'done',
                permissions: [],
                tools: ['bash', 'file_write'],
                usage: { input: 150, output: 250 },
                costDollars: 0.05,
                artifactRef: 'art_session_rot_v1',
                isTestBaseline: false,
              };
            },
          },
          dispatchRequests: true,
          relayOutbox: false,
          enableLearningLoop: false,
          sweepIntervalMs: 99_999,
        });

        const tickRes = await worker.tick(NOW);
        eq(tickRes.requestsCompleted, 1, 'worker completed the coding task');
        eq(executedWorkingDir.startsWith(root), true, 'executed inside team microVM root');
        eq(existsSync(executedWorkingDir), true, 'microVM working directory was created on disk');

        // 3. Verify snapshot was recorded
        const snapRow = (await db
          .prepare(`SELECT detail FROM audit_log WHERE tenant = ? AND action = 'VM_SNAPSHOT' ORDER BY seq DESC LIMIT 1`)
          .get(TEN)) as { detail: string } | undefined;
        eq(
          Boolean(snapRow && snapRow.detail.includes('art_session_rot_v1')),
          true,
          'VM snapshot saved with artifact ref',
        );

        // 4. Multiplexing: another agent (@ops-agent) runs in same scope -> reuses same microVM
        let secondWorkingDir = '';
        await coord.submit({
          tenant: TEN,
          messageClass: 'REQUEST',
          originScope: 'business',
          targetScope: 'infra',
          goal: 'verify relay logs',
          claimRefs: codingReq.claimRefs,
          deliverableSchema: 'ops.audit',
          bid: { dollars: 5, tokens: 5000, humanMinutes: 0 },
          onBehalfOf: 'agent:ops-agent',
          now: NOW,
        });

        const secondWorker = new ApplicationWorker(db, ledger, coord, {
          tenant: TEN,
          adapter: {
            name: 'claude-code',
            category: 'model',
            isTestBaseline: false,
            async run(_t, _reqId, opts) {
              secondWorkingDir = opts.workingDir ?? '';
              return {
                status: 'COMPLETED',
                adapter: 'claude-code',
                requestId: _reqId,
                transcript: 'done',
                permissions: [],
                tools: ['bash'],
                usage: { input: 100, output: 100 },
                costDollars: 0.02,
                artifactRef: 'art_relay_v1',
                isTestBaseline: false,
              };
            },
          },
          dispatchRequests: true,
          relayOutbox: false,
          enableLearningLoop: false,
          sweepIntervalMs: 99_999,
        });

        await secondWorker.tick(NOW);
        eq(secondWorkingDir, executedWorkingDir, 'second agent multiplexes inside the exact same team microVM');

        // 5. On fatal error or throw, team microVM is destroyed to prevent taint
        await coord.submit({
          tenant: TEN,
          messageClass: 'REQUEST',
          originScope: 'business',
          targetScope: 'infra',
          goal: 'tainted job',
          claimRefs: codingReq.claimRefs,
          deliverableSchema: 'ops.audit',
          bid: { dollars: 5, tokens: 5000, humanMinutes: 0 },
          onBehalfOf: 'agent:ops-agent',
          now: NOW,
        });

        const failingWorker = new ApplicationWorker(db, ledger, coord, {
          tenant: TEN,
          adapter: {
            name: 'claude-code',
            category: 'model',
            isTestBaseline: false,
            async run() {
              throw new Error('sandbox corrupted');
            },
          },
          dispatchRequests: true,
          relayOutbox: false,
          enableLearningLoop: false,
          sweepIntervalMs: 99_999,
        });

        const failTick = await failingWorker.tick(NOW);
        eq(failTick.requestsFailed, 1, 'failing task recorded failure');
        eq(existsSync(executedWorkingDir), false, 'corrupted team microVM destroyed on disk');
        const metaAfterFail = await db.prepare('SELECT value FROM meta WHERE key = ?').get(`vm:team:${TEN}:infra`);
        eq(metaAfterFail, undefined, 'VM meta registration deleted after teardown');
      } finally {
        await server.close();
        await db.close();
      }
    });
  },
);

T('Inquiry in #general triggers Reality Ledger RAG and synthesizes grounded business briefing', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  // Insert a sample claim into Reality Ledger
  await db
    .prepare(
      `INSERT INTO claims (id, tenant, subject, kind, statement, confidence, source_uri, source_tier, extractor, extractor_ver, retrieved_at, observed_at, valid_from, status, owner, scope, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'clm_test_1',
      TEN,
      'Billing Reconciliation',
      'OBSERVATION',
      'Q3 statements reconciled with 0 discrepancies found.',
      1.0,
      'https://finance.acme/q3',
      'PRIMARY',
      'file-diff',
      '1.0',
      NOW,
      NOW,
      NOW,
      'ACTIVE',
      'agent:finance',
      'finance',
      NOW,
      1,
    );

  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const roomUrl = `http://127.0.0.1:${server.port}/console/buzz/general`;
    const getRes = await fetch(roomUrl, { headers: { cookie } });
    const csrf = (await getRes.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;

    // Post business inquiry
    const postRes = await fetch(`${roomUrl}/command`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf,
        command: 'What is going on currently in the business?',
      }).toString(),
      redirect: 'manual',
    });
    eq(postRes.status, 303, 'inquiry posted successfully');

    // Fetch updated room history
    const afterRes = await fetch(roomUrl, { headers: { cookie } });
    const afterHtml = await afterRes.text();

    eq(afterHtml.includes('general-agent'), true, 'general-agent replied in the thread');
    eq(afterHtml.includes('Vital Business Intelligence Briefing'), true, 'briefing heading rendered');
    eq(afterHtml.includes('Grounded in Reality Ledger'), true, 'grounded in reality ledger stated');
    eq(afterHtml.includes('Billing Reconciliation'), true, 'cited real claim from Reality Ledger');
  } finally {
    await server.close();
    await db.close();
  }
});

T('/console/dashboard renders role-based departmental views (legal, finance)', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);

    // 1. Legal view
    const legalRes = await fetch(`http://127.0.0.1:${server.port}/console/dashboard?scope=legal`, {
      headers: { cookie },
    });
    eq(legalRes.status, 200, 'legal dashboard returned 200');
    const legalHtml = await legalRes.text();
    eq(legalHtml.includes('Legal &amp; Compliance Portal'), true, 'renders legal & compliance portal');
    eq(legalHtml.includes('Data &amp; GDPR Portability'), true, 'renders GDPR link');

    // 2. Finance view
    const finRes = await fetch(`http://127.0.0.1:${server.port}/console/dashboard?scope=finance`, {
      headers: { cookie },
    });
    eq(finRes.status, 200, 'finance dashboard returned 200');
    const finHtml = await finRes.text();
    eq(finHtml.includes('Financial Operations &amp; Budget Ledger'), true, 'renders finance operations portal');
    eq(finHtml.includes('Token Burn Rate'), true, 'renders token burn rate telemetry');
  } finally {
    await server.close();
    await db.close();
  }
});

T('/account renders in the console shell with one Chat button and no room list', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const accountRes = await fetch(`http://127.0.0.1:${server.port}/account`, {
      headers: { cookie },
    });
    eq(accountRes.status, 200, 'account page returns 200');
    const accountHtml = await accountRes.text();

    eq(accountHtml.includes('Account and security'), true, 'renders account heading');
    eq(accountHtml.includes('Change password'), true, 'renders change password');
    eq(accountHtml.includes('Two-factor authentication'), true, 'renders MFA section');
    eq(accountHtml.includes('vital-dashboard-btn'), true, 'embedded within workspace shell');
    // Split contract: console pages link to chat exactly once (the topbar
    // Chat button) and never embed the room list — rooms live in the chat.
    eq(accountHtml.includes('id="go-to-chat-btn"'), true, 'one Chat button:');
    eq(accountHtml.includes('class="ws-room"'), false, 'no room entries in the console sidebar:');
  } finally {
    await server.close();
    await db.close();
  }
});

/**
 * The two surfaces must stay visually separate. The Workspace mirrors upstream
 * Buzz (its own system font stack and palette); the Console owns the design
 * tokens. These are rendered by two different shells chosen once in
 * `wrapInWorkspaceShell`, and `themeDocument()` — which runs on every
 * text/html response at the `res.end` boundary and whose body rule uses
 * `!important` — must not reach the chat.
 *
 * This is a regression test: the tokens were once injected into the chat, which
 * silently re-fonted it from Buzz's system stack to Inter and repainted its
 * canvas. Nothing else in the suite would have caught that.
 */
T('surface split: the chat carries no Console tokens; the Console does', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const get = async (p: string) => await (await fetch(`http://127.0.0.1:${server.port}${p}`, { headers: { cookie } })).text();

    const chat = await get('/console/buzz/general');
    eq(chat.includes('--v-bg-0:'), false, 'chat carries no Console token definitions:');
    eq(chat.includes('data-theme='), false, 'chat is not given a Console theme attribute:');
    eq(chat.includes('data-vital-no-theme'), true, 'chat opts out of the token injection:');
    eq(chat.includes('class="buzz-window"'), true, 'chat renders the Buzz shell:');
    eq(
      chat.includes('-apple-system, BlinkMacSystemFont'),
      true,
      'chat keeps Buzz\u2019s native system font stack (not Inter):',
    );
    // The only Inter on a chat page is the unused webfont <link>, never a rule.
    eq(/font-family:[^;}]*Inter/i.test(chat), false, 'no CSS rule re-fonts the chat to Inter:');
    eq(chat.includes('data-vital-theme-toggle'), false, 'chat renders no theme toggle:');

    const console_ = await get('/console/requests');
    eq(console_.includes('--v-bg-0:'), true, 'console page carries the token definitions:');
    eq(console_.includes('data-theme='), true, 'console page carries the theme attribute:');
    eq(console_.includes('buzz-window'), false, 'console page does not render the Buzz shell:');
  } finally {
    await server.close();
    await db.close();
  }
});

/**
 * A room shows only the approvals that target ITS scope. The card list used to
 * enumerate every ADMITTED request in the tenant, so the same "Approval
 * requested" cards appeared in every room regardless of scope, and the list did
 * not even agree with the room's own pending badge (which is target-scoped).
 */
T('room approvals are scoped to the room, and agree with its pending badge', async () => {
  const { db, ledger, coord, comp } = await setupTestApp();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const claim = await ledger.append({
      tenant: TEN,
      subject: 'release:approvals',
      kind: 'FACT',
      statement: 'ships',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
      validUntil: null,
    });
    const propose = (targetScope: string, goal: string) =>
      coord.submit({
        tenant: TEN,
        messageClass: 'REQUEST' as const,
        originScope: 'product',
        targetScope,
        goal,
        claimRefs: [claim.id],
        deliverableSchema: 'feasibility.v1',
        onBehalfOf: 'human:owner',
        bid: { dollars: 2, humanMinutes: 10 },
        now: NOW,
      });
    // Distinct goals so cross-room leakage is unambiguous.
    await propose('infra', 'INFRA-ONLY approval');
    await propose('finance', 'FINANCE-ONLY approval');

    const { cookie } = await loginUser(server.port, OWNER.email, OWNER.password);
    const room = async (scope: string) =>
      await (await fetch(`http://127.0.0.1:${server.port}/console/buzz/${scope}`, { headers: { cookie } })).text();

    const infra = await room('infra');
    eq(infra.includes('INFRA-ONLY approval'), true, 'infra room shows its own approval:');
    eq(infra.includes('FINANCE-ONLY approval'), false, 'infra room does not show finance approvals:');

    const finance = await room('finance');
    eq(finance.includes('FINANCE-ONLY approval'), true, 'finance room shows its own approval:');
    eq(finance.includes('INFRA-ONLY approval'), false, 'finance room does not show infra approvals:');

    // A room with no human work of its own shows none at all.
    const legal = await room('legal');
    eq(legal.includes('INFRA-ONLY approval'), false, 'an unrelated room shows no approvals:');
    eq(legal.includes('FINANCE-ONLY approval'), false, 'an unrelated room shows no approvals:');
  } finally {
    await server.close();
    await db.close();
  }
});
