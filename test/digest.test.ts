import { T, eq, rejects, TEN, NOW, DAY_LATER, fresh, base, sor } from './helpers.ts';
import {
  composeDigest,
  renderDigest,
  DIGEST_PATH,
  consumesReviewAttention,
  digestClaimUrl,
  digestDestination,
  digestRequestUrl,
  digestUrl,
  digestWindowSince,
} from '../src/console/digest.ts';
import {
  buildConsoleNav,
  claimDetailUrl,
  needsHumanTaskUrl,
  queueReturnUrl,
  renderAccountCluster,
  renderConsoleNav,
  requestDetailUrl,
  resolveConsoleHome,
  withReturnTo,
} from '../src/console/render.ts';
import { claimDetail, detailBackTarget, parseDetailNav, requestDetail } from '../src/console/detail.ts';

import { buildReport } from '../src/console/report.ts';
import {
  SEARCH_MAX_LIMIT,
  clearFilterUrl,
  decodeListState,
  encodeListState,
  isApprovedOrExecuting,
  isPendingDecision,
  listApprovedExecuting,
  listPendingDecisions,
  listStateUrl,
  noResultsModel,
  partitionRequestsByDecision,
  searchClaims,
  searchRequests,
  searchWorkflows,
  viewAllPaths,
} from '../src/console/report.ts';
import { renderHtml } from '../src/console/render.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { changePassword, disableUser, installAuthSchema, inviteUser, login, signupTenant } from '../src/core/auth.ts';

const password = 'digest-test-password-123';
const at = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();

T('FLOW-021: recurring topics join the latest eligible bucket across windows', async () => {
  const { db, coord } = await fresh();
  try {
    for (const [id, hours, goal] of [
      ['old', 0, 'Release'],
      ['new', 30, 'release'],
      ['follow', 31, ' release '],
    ] as const) {
      await coord.submit(
        base({ id, now: at(hours), messageClass: 'NOTICE', goal, claimRefs: [], deliverableSchema: id }),
      );
    }
    const entries = await composeDigest(db, TEN, at(32));
    eq(
      entries.map((e) => [e.requestId, e.followOnCount, e.updatedAt]),
      [
        ['new', 1, at(31)],
        ['old', 0, at(0)],
      ],
    );
  } finally {
    await db.close();
  }
});

T('FLOW-021: groups sort by final activity, not insertion order', async () => {
  const { db, coord } = await fresh();
  try {
    for (const [id, hours, goal] of [
      ['a', 0, 'A'],
      ['b', 1, 'B'],
      ['a-follow', 2, 'A'],
    ] as const) {
      await coord.submit(
        base({ id, now: at(hours), messageClass: 'NOTICE', goal, claimRefs: [], deliverableSchema: id }),
      );
    }
    eq(
      (await composeDigest(db, TEN, at(3))).map((e) => e.requestId),
      ['a', 'b'],
    );
  } finally {
    await db.close();
  }
});

T('FLOW-021: rolling 24h boundary, independent scopes, ties and inclusive read window', async () => {
  const { db, coord } = await fresh();
  try {
    for (const [id, hours, scope] of [
      ['a', 0, 'one'],
      ['b', 24, 'one'],
      ['c', 48, 'one'],
      ['d', 48, 'two'],
      ['e', 73, 'one'],
      ['future', 74, 'one'],
    ] as const) {
      await coord.submit(
        base({
          id,
          now: at(hours),
          originScope: scope,
          messageClass: 'NOTICE',
          goal: 'Topic',
          claimRefs: [],
          deliverableSchema: id,
        }),
      );
    }
    const entries = await composeDigest(db, TEN, at(73));
    eq(
      entries.map((e) => [e.requestId, e.requestIds]),
      [
        ['e', ['e']],
        ['a', ['a', 'b', 'c']],
        ['d', ['d']],
      ],
    );
    eq(
      (await composeDigest(db, TEN, at(73), { since: at(48) })).map((e) => [e.requestId, e.requestIds]),
      [
        ['e', ['e']],
        ['c', ['c']],
        ['d', ['d']],
      ],
    );
    eq(await composeDigest(db, 'other', at(73)), []);
  } finally {
    await db.close();
  }
});

T('FLOW-021: empty digest is explicit and rendered values and links are escaped', async () => {
  const { db, coord } = await fresh();
  try {
    const empty = await renderDigest(coord, db, TEN, NOW, { since: at(-24) });
    eq(empty.includes('Digest empty'), true);
    eq(empty.includes(at(-24)), true);
    eq(empty.includes(NOW), true);
    await coord.submit(
      base({
        id: 'notice/"<x>',
        messageClass: 'NOTICE',
        goal: '<script>bad</script>',
        originScope: '<img src=x>',
        claimRefs: [],
      }),
    );
    const html = await renderDigest(coord, db, TEN, NOW);
    eq(html.includes('<script>bad'), false);
    eq(html.includes('<img src=x>'), false);
    eq(html.includes('&lt;script&gt;bad&lt;/script&gt;'), true);
    eq(html.includes('/console/requests/notice%2F%22%3Cx%3E'), true);
    eq(html.includes('No evidence references.'), true);
  } finally {
    await db.close();
  }
});

T('FLOW-021: notices and digest reads consume no human attention or mutate work', async () => {
  const { db, ledger, coord, comp } = await fresh({
    maxHumanEscalationsPerDay: 1,
    maxConcurrentPerScope: 5,
    maxDailyDollars: 1000,
    maxDailyTokens: 100000,
  });
  try {
    await coord.submit(base({ id: 'human-work', bid: { humanMinutes: 1 } }));
    const beforeReport = await buildReport(db, ledger, coord, comp, TEN, NOW);
    const beforeEscalations = await coord.dailyEscalations(TEN, NOW.slice(0, 10));
    for (let i = 0; i < 4; i++) {
      const result = await coord.submit(
        base({ id: `notice-${i}`, messageClass: 'NOTICE', goal: `FYI ${i}`, claimRefs: [], bid: { humanMinutes: 10 } }),
      );
      eq(result.state, 'COMPLETED');
      eq(result.request.spent.humanMinutes, 0);
    }
    const requests = await db.prepare('SELECT * FROM requests ORDER BY id').all();
    const audits = await db.prepare('SELECT * FROM audit_log ORDER BY seq').all();
    const decisions = await db.prepare('SELECT * FROM decisions ORDER BY id').all();
    for (let i = 0; i < 2; i++) await renderDigest(coord, db, TEN, NOW);
    const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
    eq(report.needsHuman, beforeReport.needsHuman);
    eq(report.health.escalations, beforeReport.health.escalations);
    eq(report.health.humanMinutes, beforeReport.health.humanMinutes);
    eq(report.digestCount, 4);
    eq(await coord.dailyEscalations(TEN, NOW.slice(0, 10)), beforeEscalations);
    eq(await db.prepare('SELECT * FROM requests ORDER BY id').all(), requests);
    eq(await db.prepare('SELECT * FROM audit_log ORDER BY seq').all(), audits);
    eq(await db.prepare('SELECT * FROM decisions ORDER BY id').all(), decisions);
    eq(renderHtml(report, true).includes('href="/console/digest"'), true);
    eq(renderHtml(report).includes('href="/console/digest"'), false);
  } finally {
    await db.close();
  }
});

for (const siteDir of [undefined, 'site']) {
  T(`FLOW-021: authenticated read-only digest navigation and evidence (${siteDir ?? 'standalone'})`, async () => {
    const { db, ledger, coord, comp } = await fresh();
    await installAuthSchema(db, NOW);
    await signupTenant(db, { slug: TEN, name: 'Acme', email: 'owner@acme.test', password, ownerName: 'Owner' }, NOW);
    const session = await login(db, { tenant: TEN, email: 'owner@acme.test', password }, NOW);
    const headers = { cookie: `vital_session=${session.token}` };
    const claim = await ledger.append({
      tenant: TEN,
      subject: 'release',
      kind: 'FACT',
      statement: 'Digest evidence',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(
      base({ id: 'digest-notice', messageClass: 'NOTICE', goal: 'Current notice', claimRefs: [claim.id] }),
    );
    await coord.submit(
      base({
        id: 'digest-follow',
        messageClass: 'NOTICE',
        goal: 'Current notice',
        claimRefs: [claim.id],
        deliverableSchema: 'follow',
      }),
    );
    await coord.submit(
      base({ id: 'digest-old', now: at(-8 * 24), messageClass: 'NOTICE', goal: 'Older notice', claimRefs: [] }),
    );
    await coord.submit(
      base({ id: 'digest-future', now: at(1), messageClass: 'NOTICE', goal: 'Future notice', claimRefs: [] }),
    );
    const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW, siteDir });
    try {
      const root = `http://127.0.0.1:${server.port}`;
      const home = siteDir ? '/console' : '/';
      const anonymous = await fetch(`${root}/console/digest?days=30`, { redirect: 'manual' });
      eq(anonymous.status, 303);
      eq(new URL(anonymous.headers.get('location')!, root).searchParams.get('next'), '/console/digest?days=30');
      const dashboard = await (await fetch(root + home, { headers })).text();
      eq(dashboard.includes('href="/console/digest"'), true);
      const requests = await db.prepare('SELECT * FROM requests ORDER BY id').all();
      const audits = await db.prepare('SELECT * FROM audit_log ORDER BY seq').all();
      const response = await fetch(`${root}/console/digest`, { headers });
      eq(response.status, 200);
      eq(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      eq(html.includes(`href="${home}">Back to console`), true);
      eq(html.includes('href="/console/requests/digest-notice"'), true);
      eq(html.includes('href="/console/requests/digest-follow"'), true);
      eq(html.includes(`href="/console/claims/${claim.id}"`), true);
      eq(html.includes(at(-7 * 24)), true);
      eq(html.includes(NOW), true);
      eq(html.includes('Older notice'), false);
      eq(html.includes('Future notice'), false);
      eq(html.includes('<form'), false);
      eq(html.includes('data-review-action'), false);
      for (const value of ['1', '7', '30', 'all']) eq(html.includes(`href="/console/digest?days=${value}"`), true);
      for (const value of ['30', 'all']) {
        const expanded = await (await fetch(`${root}/console/digest?days=${value}`, { headers })).text();
        eq(expanded.includes('Older notice'), true);
        eq(expanded.includes('Future notice'), false);
      }
      for (const value of ['0', '-1', 'abc', '7.5'])
        eq((await fetch(`${root}/console/digest?days=${value}`, { headers })).status, 400);
      const post = await fetch(`${root}/console/digest`, { method: 'POST', headers });
      eq(post.status, 405);
      eq(post.headers.get('allow'), 'GET');
      eq(await db.prepare('SELECT * FROM requests ORDER BY id').all(), requests);
      eq(await db.prepare('SELECT * FROM audit_log ORDER BY seq').all(), audits);
      eq((await fetch(`${root}/console/requests/digest-notice`, { headers })).status, 200);
      eq((await fetch(`${root}/console/claims/${claim.id}`, { headers })).status, 200);
    } finally {
      await server.close();
      await db.close();
    }
  });
}

T('FLOW-021: member read permission, activation, foreign tenants and disabled sessions', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const { owner } = await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: 'owner@acme.test', password, ownerName: 'Owner' },
    NOW,
  );
  await signupTenant(
    db,
    { slug: 'foreign', name: 'Foreign', email: 'owner@foreign.test', password, ownerName: 'Other' },
    NOW,
  );
  const member = await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'Member', role: 'member', password },
    { userId: owner.id, role: 'owner' },
    NOW,
  );
  const pending = await login(db, { tenant: TEN, email: member.email, password }, NOW);
  const other = await login(db, { tenant: 'foreign', email: 'owner@foreign.test', password }, NOW);
  const foreignClaim = await ledger.append({
    tenant: 'foreign',
    subject: 'secret',
    kind: 'FACT',
    statement: 'Foreign evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  await coord.submit(
    base({
      id: 'foreign-notice',
      tenant: 'foreign',
      messageClass: 'NOTICE',
      goal: 'Private foreign topic',
      claimRefs: [foreignClaim.id],
    }),
  );
  await coord.submit(
    base({
      id: 'local-notice',
      messageClass: 'NOTICE',
      goal: 'Local topic',
      claimRefs: [foreignClaim.id, 'missing-claim'],
    }),
  );
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
    approverRole: 'owner',
  });
  try {
    const root = `http://127.0.0.1:${server.port}`;
    const get = (token: string, path = '/console/digest') =>
      fetch(root + path, { headers: { cookie: `vital_session=${token}` }, redirect: 'manual' });
    const denied = await get(pending.token);
    eq(denied.status, 303);
    eq(denied.headers.get('location'), '/change-password');
    eq((await get(other.token)).status, 403);
    await changePassword(db, TEN, member.id, password + '-changed', NOW);
    const active = await login(db, { tenant: TEN, email: member.email, password: password + '-changed' }, NOW);
    const response = await get(active.token, '/console/digest?tenant=foreign');
    eq(response.status, 200);
    const html = await response.text();
    eq(html.includes('Local topic'), true);
    eq(html.includes('Private foreign topic'), false);
    eq(html.includes(foreignClaim.id), false);
    eq(html.includes('Evidence unavailable'), true);
    eq(html.includes('<form'), false);
    eq((await get(active.token, '/console/requests/foreign-notice')).status, 404);
    eq((await get(active.token, `/console/claims/${foreignClaim.id}`)).status, 404);
    await disableUser(db, TEN, member.id, NOW);
    const disabled = await get(active.token);
    eq(disabled.status, 303);
    eq(disabled.headers.get('location')!.startsWith('/login?'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-019: shared nav resolves home and lists only available destinations', async () => {
  eq(resolveConsoleHome(), '/');
  eq(resolveConsoleHome(null), '/');
  eq(resolveConsoleHome('site'), '/console');
  const full = buildConsoleNav('/');
  eq(
    full.map((d) => d.key),
    ['reviews', 'workflows', 'digest', 'team', 'account'],
  );
  eq(full[0]!.href, '/#pending-review');
  eq(full[2]!.href, '/console/digest');
  const cohosted = buildConsoleNav('/console');
  eq(cohosted[0]!.href, '/console#pending-review');
  const partial = buildConsoleNav('/console', { reviews: false, team: false, account: false });
  eq(
    partial.map((d) => d.key),
    ['workflows', 'digest'],
  );
  const html = renderConsoleNav(partial, 'digest');
  eq(html.includes('aria-current="page"'), true);
  eq(html.includes('Reviews'), false);
  eq(html.includes('Team'), false);
  eq(html.includes('Account'), false);
  const evil = renderConsoleNav([{ key: 'digest', label: '<script>', href: '/console/digest?x="y' }]);
  eq(evil.includes('<script>'), false);
  eq(evil.includes('"y'), false);
});

T('FLOW-019: request identity and queue page survive detail navigation', async () => {
  const { db, ledger, coord } = await fresh();
  try {
    const claim = await ledger.append({
      tenant: TEN,
      subject: 'nav',
      kind: 'FACT',
      statement: 'Navigation evidence',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(base({ id: 'req-1', claimRefs: [claim.id] }));
    eq(requestDetailUrl('req-1'), '/console/requests/req-1');
    eq(
      requestDetailUrl('a/b', { evidencePage: 2, returnTo: '/console?reviewPage=3' }),
      '/console/requests/a%2Fb?page=2&return=%2Fconsole%3FreviewPage%3D3',
    );
    eq(
      claimDetailUrl('clm', { requestId: 'req-1', returnTo: '/console/requests/req-1' }),
      '/console/claims/clm?requestId=req-1&return=%2Fconsole%2Frequests%2Freq-1',
    );
    eq(queueReturnUrl('/', { queuePage: 2 }), '/?reviewPage=2#pending-review');
    eq(queueReturnUrl('/', { returnTo: '/console/digest' }), '/console/digest');
    eq(queueReturnUrl('/console', {}), '/console');
    eq(
      withReturnTo('/console/claims/x', '/console?reviewPage=1'),
      '/console/claims/x?return=%2Fconsole%3FreviewPage%3D1',
    );
    eq(withReturnTo('/a?page=1', '/b'), '/a?page=1&return=%2Fb');
    eq(withReturnTo('/a?page=1'), '/a?page=1');
    eq(parseDetailNav('page=2&return=%2Fconsole&requestId=req-1'), {
      page: 2,
      returnTo: '/console',
      requestId: 'req-1',
    });
    eq(parseDetailNav('page=-1&return=https%3A%2F%2Fevil.test'), { page: 0, returnTo: null, requestId: null });
    eq(detailBackTarget('/console?reviewPage=2', '/'), '/console?reviewPage=2');
    eq(detailBackTarget('https://evil.test/', '/console'), '/console');
    eq(detailBackTarget(null, '/console'), '/console');
    const opts = {
      tenant: TEN,
      actor: 'tester',
      csrf: 'csrf',
      canApprove: true,
      requiredRole: 'member',
      operatorMode: 'session' as const,
      home: '/',
    };
    const html = await requestDetail(db, coord, ledger, 'req-1', 0, opts, undefined, {
      returnTo: '/console?reviewPage=3',
    });
    eq(html !== null, true);
    eq(html!.includes('requestId=req-1'), true);
    eq(html!.includes('return='), true);
    const plain = await requestDetail(db, coord, ledger, 'req-1', 0, opts);
    eq(plain!.includes('return='), false);
    eq(plain!.includes(`/console/claims/${claim.id}`), true);
    const linked = await claimDetail(db, ledger, coord, claim.id, 0, opts, {
      returnTo: '/console?reviewPage=3',
    });
    eq(linked!.includes('return='), true);
    eq(linked!.includes('/console/requests/req-1'), true);
  } finally {
    await db.close();
  }
});

T('FLOW-019: needs-human items link to their task and account controls share one location', async () => {
  const { db, ledger, coord, comp } = await fresh();
  try {
    await coord.submit(base({ id: 'task-1', bid: { humanMinutes: 5 } }));
    const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
    eq(report.needsHuman.length, 1);
    eq(report.needsHuman[0]!.requestId, 'task-1');
    const live = renderHtml(report, true);
    eq(live.includes(`href="${needsHumanTaskUrl('task-1')}"`), true);
    const still = renderHtml(report, false);
    eq(still.includes(needsHumanTaskUrl('task-1')), false);
    const cluster = renderAccountCluster('owner@acme.test', 'owner', 'csrf-token');
    eq(cluster.includes('href="/account"'), true);
    eq(cluster.includes('href="/team"'), true);
    eq(cluster.includes('action="/logout"'), true);
    eq(cluster.includes('owner@acme.test'), true);
    eq(cluster.includes('csrf-token'), true);
  } finally {
    await db.close();
  }
});

T('FLOW-020: request index filters, totals, truncation and stable keyset pages', async () => {
  const { db, coord } = await fresh({
    maxConcurrentPerScope: 100,
    maxDailyDollars: 100000,
    maxDailyTokens: 100000000,
    maxHumanEscalationsPerDay: 1000,
  });
  try {
    for (let i = 0; i < 25; i++) {
      const id = `r-${String(i).padStart(2, '0')}`;
      await coord.submit(
        base({
          id,
          goal: i % 2 === 0 ? `ship alpha ${i}` : `fix beta ${i}`,
          originScope: i < 5 ? 'sales' : 'marketing',
          deliverableSchema: `s-${i}`,
          now: i < 20 ? NOW : DAY_LATER,
        }),
      );
    }
    await coord.submit(
      base({ id: 'n-0', messageClass: 'NOTICE', goal: 'notice ping', claimRefs: [], deliverableSchema: 'n-0' }),
    );
    const all = await searchRequests(db, TEN, {});
    eq(all.total, 26);
    eq(all.rows.length, 20);
    eq(all.truncated, true);
    eq(all.hasMore, true);
    const second = await searchRequests(db, TEN, { limit: 10, offset: 10 });
    eq(second.rows.length, 10);
    eq(second.total, 26);
    eq(second.truncated, true);
    const last = await searchRequests(db, TEN, { limit: 10, offset: 20 });
    eq(last.rows.length, 6);
    eq(last.truncated, false);
    eq(last.hasMore, false);
    eq((await searchRequests(db, TEN, { q: 'alpha' })).total, 13);
    eq((await searchRequests(db, TEN, { scope: 'sales' })).total, 5);
    eq((await searchRequests(db, TEN, { states: ['ADMITTED'] })).total, 25);
    eq((await searchRequests(db, TEN, { messageClass: 'NOTICE' })).total, 1);
    eq((await searchRequests(db, TEN, { since: DAY_LATER })).total, 5);
    eq((await searchRequests(db, TEN, { until: NOW })).total, 21);
    eq((await searchRequests(db, TEN, { workflowId: 'missing' })).total, 0);
    const none = await searchRequests(db, TEN, { q: 'zzz-no-match', states: ['COMPLETED'] });
    eq(none.total, 0);
    eq(none.rows, []);
    eq(none.truncated, false);
    await rejects(() => searchRequests(db, TEN, { states: ['BOGUS'] }), '[search:STATE]');
    await rejects(() => searchRequests(db, TEN, { order: 'sideways' }), '[search:ORDER]');
    const window = await searchRequests(db, TEN, { limit: 100 });
    const first = await searchRequests(db, TEN, { limit: 10 });
    const cursor = `${first.rows[9]!.createdAt}|${first.rows[9]!.id}`;
    const keyed = await searchRequests(db, TEN, { limit: 10, cursor });
    eq(
      keyed.rows.map((r) => r.id),
      window.rows.slice(10, 20).map((r) => r.id),
    );
    await coord.submit(base({ id: 'r-zz', goal: 'late arrival', deliverableSchema: 's-zz', now: NOW }));
    const replay = await searchRequests(db, TEN, { limit: 10, cursor });
    eq(
      replay.rows.map((r) => r.id),
      keyed.rows.map((r) => r.id),
    );
  } finally {
    await db.close();
  }
});

T('FLOW-020: claim and workflow indexes are tenant-isolated and bounded', async () => {
  const { db, ledger, coord } = await fresh();
  try {
    await ledger.append({
      tenant: TEN,
      subject: 'release',
      kind: 'FACT',
      statement: 'Local evidence',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await ledger.append({
      tenant: 'foreign',
      subject: 'release',
      kind: 'FACT',
      statement: 'Foreign evidence',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(base({ id: 'mine-1', goal: 'local work' }));
    await coord.submit(base({ id: 'foreign-1', tenant: 'foreign', goal: 'foreign work' }));
    const claims = await searchClaims(db, TEN, { q: 'release' });
    eq(claims.total, 1);
    eq(claims.rows[0]!.statement, 'Local evidence');
    eq((await searchClaims(db, TEN, { kinds: ['FACT'] })).total, 1);
    eq((await searchClaims(db, TEN, { statuses: ['MISSING'] })).total, 0);
    eq((await searchClaims(db, TEN, { scope: 'engineering' })).total, 1);
    const reqs = await searchRequests(db, TEN, { limit: 100 });
    eq(
      reqs.rows.some((r) => r.id === 'foreign-1'),
      false,
    );
    eq((await searchRequests(db, 'foreign', {})).total, 1);
    const clamped = await searchRequests(db, TEN, { limit: 5000 });
    eq(clamped.limit, SEARCH_MAX_LIMIT);
    await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `wedge:fanout:${TEN}:wfr_test`,
      JSON.stringify({
        id: 'wfr_test',
        tenant: TEN,
        kind: 'ship',
        subject: 'v1.2 launch',
        summary: null,
        status: 'IN_PROGRESS',
        onBehalfOf: 'human:priya',
        createdAt: NOW,
        updatedAt: NOW,
        legs: [],
        claimIds: [],
      }),
    );
    await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'wedge:fanout:foreign:wfr_other',
      JSON.stringify({
        id: 'wfr_other',
        tenant: 'foreign',
        kind: 'ship',
        subject: 'v1.2 launch',
        summary: null,
        status: 'IN_PROGRESS',
        onBehalfOf: 'human:other',
        createdAt: NOW,
        updatedAt: NOW,
        legs: [],
        claimIds: [],
      }),
    );
    const flows = await searchWorkflows(db, TEN, {});
    eq(flows.total, 1);
    eq(flows.rows[0]!.id, 'wfr_test');
    eq(flows.rows[0]!.url, '/console/workflows/wfr_test');
    eq(flows.truncated, false);
    eq((await searchWorkflows(db, TEN, { q: 'v1.2' })).total, 1);
    eq((await searchWorkflows(db, TEN, { q: 'v9.9' })).total, 0);
    eq((await searchWorkflows(db, TEN, { kinds: ['churn'] })).total, 0);
    eq((await searchWorkflows(db, TEN, { lifecycles: ['COMPLETE'] })).total, 0);
    eq((await searchWorkflows(db, TEN, { since: DAY_LATER })).total, 0);
    eq((await searchWorkflows(db, 'foreign', {})).total, 1);
  } finally {
    await db.close();
  }
});

T('FLOW-020: pending decisions separate from approved work by state, not bids', async () => {
  const { db, coord } = await fresh();
  try {
    await coord.submit(
      base({ id: 'needs-review', goal: 'review zero-bid work', deliverableSchema: 'z-1', bid: { humanMinutes: 0 } }),
    );
    await coord.submit(
      base({ id: 'will-approve', goal: 'approve zero-bid work', deliverableSchema: 'z-2', bid: { humanMinutes: 0 } }),
    );
    await coord.submit(
      base({ id: 'notice-1', messageClass: 'NOTICE', goal: 'FYI', claimRefs: [], deliverableSchema: 'n1' }),
    );
    await coord.accept(TEN, 'will-approve');
    eq(isPendingDecision('ADMITTED'), true);
    eq(isPendingDecision('ACCEPTED'), false);
    eq(isApprovedOrExecuting('ACCEPTED'), true);
    eq(isApprovedOrExecuting('IN_FLIGHT'), true);
    eq(isApprovedOrExecuting('ADMITTED'), false);
    eq(isApprovedOrExecuting('COMPLETED'), false);
    eq(
      (await listPendingDecisions(db, TEN)).map((r) => r.id),
      ['needs-review'],
    );
    eq(
      (await listApprovedExecuting(db, TEN)).map((r) => r.id),
      ['will-approve'],
    );
    const all = await searchRequests(db, TEN, { limit: 100 });
    const parts = partitionRequestsByDecision(all.rows);
    eq(
      parts.pending.map((r) => r.id),
      ['needs-review'],
    );
    eq(
      parts.active.map((r) => r.id),
      ['will-approve'],
    );
    eq(
      parts.other.map((r) => r.id),
      ['notice-1'],
    );
  } finally {
    await db.close();
  }
});

T('FLOW-020: filter state round-trips through URLs and no-results clears filters', async () => {
  const state = {
    q: 'ship',
    states: ['ADMITTED', 'ACCEPTED'],
    scopes: ['eng', 'mkt'],
    kinds: ['FACT'],
    statuses: ['VERIFIED'],
    messageClass: 'REQUEST',
    workflowId: 'wfr_1',
    since: NOW,
    until: NOW,
    sort: 'updated_at',
    order: 'desc',
    limit: 10,
    offset: 20,
  };
  const encoded = encodeListState(state);
  eq(decodeListState(encoded), state);
  eq(decodeListState(''), {});
  eq(listStateUrl('/console/requests', state), `/console/requests?${encoded}`);
  eq(listStateUrl('/console/requests', {}), '/console/requests');
  const model = noResultsModel('/console/requests', state);
  eq(model.title, 'No results');
  eq(model.body.includes('ship'), true);
  eq(model.body.includes('ADMITTED'), true);
  eq(model.clearUrl, '/console/requests?sort=updated_at&order=desc&limit=10');
  eq(clearFilterUrl('/console/requests', {}), '/console/requests');
  const empty = noResultsModel('/console/requests', {});
  eq(empty.body, 'No matching work found.');
  eq(empty.clearUrl, '/console/requests');
  eq(viewAllPaths(), {
    requests: '/console/requests',
    claims: '/console/claims',
    rooms: '/console/rooms',
    humanWork: '/console/human-work',
    workflows: '/console/workflows',
    digest: '/console/digest',
  });
});

T('FLOW-021: digest destination model links dashboard to drill-down windows', async () => {
  eq(DIGEST_PATH, '/console/digest');
  eq(digestUrl(), '/console/digest');
  eq(digestUrl('7'), '/console/digest');
  eq(digestUrl('1'), '/console/digest?days=1');
  eq(digestUrl('30'), '/console/digest?days=30');
  eq(digestUrl('all'), '/console/digest?days=all');
  eq(digestWindowSince(NOW, 'all'), undefined);
  eq(digestWindowSince(NOW, '7'), new Date(Date.parse(NOW) - 7 * 86_400_000).toISOString());
  eq(digestWindowSince(NOW, '30'), new Date(Date.parse(NOW) - 30 * 86_400_000).toISOString());
  eq(digestRequestUrl('a/b'), '/console/requests/a%2Fb');
  eq(digestClaimUrl('c d'), '/console/claims/c%20d');
  eq(consumesReviewAttention('NOTICE'), false);
  eq(consumesReviewAttention('REQUEST'), true);
  eq(consumesReviewAttention('QUERY'), true);
  eq(digestDestination(4), { label: '4 notices → digest', href: '/console/digest', count: 4 });
  eq(digestDestination(2, '30'), { label: '2 notices → digest', href: '/console/digest?days=30', count: 2 });
  const { db, ledger, coord } = await fresh();
  try {
    const claim = await ledger.append({
      tenant: TEN,
      subject: 'drill',
      kind: 'FACT',
      statement: 'Drill-down evidence',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(base({ id: 'note-1', messageClass: 'NOTICE', goal: 'Drill down', claimRefs: [claim.id] }));
    const html = await renderDigest(coord, db, TEN, NOW);
    eq(html.includes(`href="${digestRequestUrl('note-1')}"`), true);
    eq(html.includes(`href="${digestClaimUrl(claim.id)}"`), true);
    eq(html.includes(NOW), true);
  } finally {
    await db.close();
  }
});
