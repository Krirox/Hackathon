import { T, eq, throws, fresh, TEN, NOW } from './helpers.ts';
import { installAuthSchema, inviteUser, signupTenant } from '../src/core/auth.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import {
  capabilityAllows,
  compilePattern,
  matchRoute,
  routeManifest,
  validateRoutes,
  type AuthContext,
  type RouteDef,
} from '../src/console/routes/registry.ts';
import { observabilityRoutes, OBSERVABILITY_CAPABILITIES } from '../src/console/routes/observability.ts';
import { complianceRoutes, COMPLIANCE_CAPABILITIES } from '../src/console/routes/compliance.ts';
import { requestsRoutes, REQUESTS_CAPABILITIES } from '../src/console/routes/requests.ts';
import { listsRoutes, LISTS_CAPABILITIES } from '../src/console/routes/lists.ts';
import { learningRoutes, LEARNING_CAPABILITIES } from '../src/console/routes/learning.ts';
import { agentTasksRoutes, AGENT_TASKS_CAPABILITIES } from '../src/console/routes/agent-tasks.ts';
import type { Role } from '../src/core/auth.ts';
import type { AsyncDb } from '../src/core/db.ts';

console.log('\n\x1b[1mRoute table — declared capability, enforced once\x1b[0m');

// ------------------------------------------------------------- registry: pure

const noop = () => {};

function def(over: Partial<RouteDef<unknown>> = {}): RouteDef<unknown> {
  return { method: 'GET', pattern: '/x', capability: 'public', surface: 'api', handler: noop, ...over };
}

T('a route that cannot register fails loudly at boot, not as a 404', () => {
  // A route silently dropped from the table is invisible in production; these
  // throw instead.
  throws(() => validateRoutes([def({ pattern: '/a' }), def({ pattern: '/a' })]), 'duplicate route');
  throws(() => validateRoutes([def({ capability: undefined as never })]), 'no capability');
  throws(() => validateRoutes([def({ pattern: 'no-slash' })]), 'must start with "/"');
  throws(() => validateRoutes([def({ pattern: '/a/:b:c' })]), 'malformed param');
  throws(() => validateRoutes([def({ handler: undefined as never })]), 'has no handler');
  // Surface is not optional either: it decides whether a browser is redirected
  // to the login form or handed a 401, and 'undefined' has no sane default.
  throws(() => validateRoutes([def({ surface: undefined as never })]), 'no surface');
  // An owner-only *page* must declare what a non-owner sees. Without it the
  // dispatcher would have to invent user-facing copy.
  throws(() => validateRoutes([def({ capability: 'owner', surface: 'html' })]), 'must declare `denied`');
  // The valid case must not throw.
  validateRoutes([def({ pattern: '/a' }), def({ pattern: '/a/:id', method: 'POST', body: 'none' })]);
  validateRoutes([
    def({
      pattern: '/page',
      capability: 'owner',
      surface: 'html',
      denied: { title: 'T', message: 'M' },
    }),
    def({ pattern: '/api', capability: 'owner', surface: 'api' }),
  ]);
});

T('matching is exact on method and path, and extracts params', () => {
  const routes = [
    def({ method: 'GET', pattern: '/api/metrics' }),
    def({ method: 'POST', pattern: '/console/issues/:id' }),
  ];
  eq(matchRoute(routes, 'GET', '/api/metrics')?.route.pattern, '/api/metrics');
  // Method is part of identity: GET must not reach a POST route.
  eq(matchRoute(routes, 'GET', '/console/issues/abc'), null);
  eq(matchRoute(routes, 'POST', '/console/issues/abc')?.params.id, 'abc');
  // No partial or prefix matching — a route table that matches loosely is how
  // one route ends up serving another's traffic.
  eq(matchRoute(routes, 'GET', '/api/metrics/extra'), null);
  eq(matchRoute(routes, 'GET', '/api'), null);
  eq(matchRoute(routes, 'GET', '/api/metrics/'), null, 'trailing slash is not a match:');
});

T('compilePattern decodes params and rejects empty segments', () => {
  eq(compilePattern('/a/:id')('/a/hello%20world')?.id, 'hello world');
  eq(compilePattern('/a/:id')('/a/'), null);
  eq(compilePattern('/a')('/a'), {});
  // A malformed escape must not throw: inside a request that is a 500, and from
  // the public port it is a one-request denial of service. The raw segment is
  // handed over and the handler decides what to do with it.
  eq(compilePattern('/a/:id')('/a/%zz')?.id, '%zz');
  eq(compilePattern('/a/:id')('/a/%E0%A4%A')?.id, '%E0%A4%A');
});

T('capability is the whole policy, and it is a pure function', () => {
  const session = { user: { role: 'member' as Role } as AuthContext['user'], session: {} as AuthContext['session'] };
  const owner = { user: { role: 'owner' as Role } as AuthContext['user'], session: {} as AuthContext['session'] };
  const admin = { user: { role: 'admin' as Role } as AuthContext['user'], session: {} as AuthContext['session'] };
  // public is the only capability that admits an anonymous caller.
  eq(capabilityAllows('public', null), true);
  eq(capabilityAllows('session', null), false);
  eq(capabilityAllows('owner', null), false);
  eq(capabilityAllows('session', session), true);
  // Member is authenticated but not privileged: the distinction the old
  // per-route checks kept getting wrong.
  eq(capabilityAllows('owner', session), false);
  eq(capabilityAllows('owner', owner), true);
  eq(capabilityAllows('owner', admin), true);
});

// ---------------------------------------------------- the migrated domain

T('the observability manifest states each capability, with a reason', () => {
  const routes = observabilityRoutes();
  validateRoutes(routes);
  const manifest = routeManifest(routes);
  const byId = new Map(manifest.map((m) => [`${m.method} ${m.pattern}`, m]));
  // The manifest is the artifact a reviewer reads. Pin it, so a capability
  // change is a deliberate test edit rather than a silent behaviour change.
  for (const [id, capability] of Object.entries(OBSERVABILITY_CAPABILITIES)) {
    eq(byId.get(id)?.capability, capability, `${id} capability:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  eq(manifest.length, Object.keys(OBSERVABILITY_CAPABILITIES).length);
});

T('the compliance manifest states capability and surface, with a reason', () => {
  const routes = complianceRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  for (const [id, want] of Object.entries(COMPLIANCE_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  eq(byId.size, Object.keys(COMPLIANCE_CAPABILITIES).length);
});

T('migrated routes answer exactly as before, and capability is enforced', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // public: liveness answers with no session, and still proves the LB path.
    const healthz = await fetch(`${base}/healthz`);
    eq(healthz.status, 200);
    const live = (await healthz.json()) as Record<string, unknown>;
    eq(live.ok, true);
    eq(typeof live.proto, 'string');
    eq('viaProxy' in live, true, 'healthz reports the proxy verdict:');

    // public: the status pill, with its CORS header kept.
    const health = await fetch(`${base}/api/health`);
    eq(health.status, 200);
    eq(health.headers.get('access-control-allow-origin'), '*');
    eq(((await health.json()) as { ok: boolean }).ok, true);

    // session: anonymous must not read economics.
    eq((await fetch(`${base}/api/approval-latency`)).status, 401);
    eq((await fetch(`${base}/api/cost-per-signal`)).status, 401);

    // session: signed in, both answer 200.
    const cookie = await login(base);
    eq((await fetch(`${base}/api/approval-latency`, { headers: { cookie } })).status, 200);
    eq((await fetch(`${base}/api/cost-per-signal`, { headers: { cookie } })).status, 200);
  } finally {
    await server.close();
    await db.close();
  }
});

T('the compliance pages answer a browser, not an API client', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const { owner } = await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  // A member can sign in but may not read the audit trail. Invited users start
  // un-activated, so clear the flag directly — this test is about the denied
  // page, not the password-change interstitial.
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'Mo', role: 'member', password: 'the-console-password' },
    { userId: owner.id, role: 'owner' },
    NOW,
  );
  await db
    .prepare('UPDATE users SET must_change_password = 0 WHERE tenant = ? AND email = ?')
    .run(TEN, 'member@acme.test');

  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Anonymous: an HTML route redirects (303, like every other console page)
    // to the login form carrying a way back.
    const anon = await fetch(`${base}/console/audit`, { redirect: 'manual' });
    eq(anon.status, 303, 'anonymous audit redirects instead of answering 401:');
    eq((anon.headers.get('location') ?? '').startsWith('/login'), true, 'redirects to login:');

    const cookie = await login(base);
    const audit = await fetch(`${base}/console/audit`, { headers: { cookie } });
    eq(audit.status, 200);
    const body = await audit.text();
    eq(body.includes('Audit log'), true, 'audit page rendered:');
    // The console shell wraps it — the migrated page must not lose its chrome.
    eq(body.includes('Approvals'), true, 'audit page carries the console rail:');
    // A page that can change between reads must not be cached by the browser.
    eq(audit.headers.get('cache-control'), 'no-store');

    const data = await fetch(`${base}/console/data`, { headers: { cookie } });
    eq(data.status, 200);
    eq((await data.text()).includes('Data &amp; retention'), true, 'data page rendered:');

    // The export is a download, not a page.
    const xp = await fetch(`${base}/console/data/export`, { headers: { cookie } });
    eq(xp.status, 200);
    eq(xp.headers.get('content-disposition'), `attachment; filename="${TEN}-ledger-export.json"`);

    // A member is denied as a *page*: the message is the one the route declared.
    const memberCookie = await login(base, 'member@acme.test');
    const denied = await fetch(`${base}/console/audit`, { headers: { cookie: memberCookie } });
    eq(denied.status, 403);
    const deniedBody = await denied.text();
    eq(deniedBody.includes('requires the admin or owner role'), true, 'declared refusal copy:');
    // Still the shell, not a bare string: the rail is how they get back out.
    eq(deniedBody.includes('Approvals'), true, 'refusal keeps the console rail:');
    // The download variant stays bare text — it is not a document.
    const deniedExport = await fetch(`${base}/console/data/export`, { headers: { cookie: memberCookie } });
    eq(deniedExport.status, 403);
    eq(await deniedExport.text(), 'Export requires the admin or owner role.');
  } finally {
    await server.close();
    await db.close();
  }
});

T('a mutating API route is capability-gated, CSRF-checked and audited', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  const url = `${base}/api/requests/rq_nope/refresh-evidence`;
  const post = (headers: Record<string, string>, body: string) =>
    fetch(url, { method: 'POST', headers, body, redirect: 'manual' });
  try {
    // Anonymous: an API caller gets a status it can act on, not a redirect.
    const anon = await post({ 'content-type': 'application/x-www-form-urlencoded' }, 'x=1');
    eq(anon.status, 401);

    const cookie = await login(base);
    // Signed in but without the token: refused before the operation runs.
    const noCsrf = await post({ cookie, 'content-type': 'application/x-www-form-urlencoded' }, 'x=1');
    eq(noCsrf.status, 403);
    eq(((await noCsrf.json()) as { error: string }).error, 'bad CSRF token');

    // With the token: the route runs and reports the domain's own answer. The
    // id does not exist, so it is the 404 the handler maps NOT_FOUND to.
    const token = await freshToken(base, cookie);
    const unknown = await post(
      { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ csrf: token!, x: '1' }).toString(),
    );
    eq(unknown.status, 404);
    eq(((await unknown.json()) as { ok: boolean }).ok, false);
  } finally {
    await server.close();
    await db.close();
  }
});

T('the requests domain declares the same columns as the others', () => {
  const routes = requestsRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  for (const [id, want] of Object.entries(REQUESTS_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  // The route is a mutation, so its body policy is not optional.
  eq(
    routes.every((r) => r.body === 'csrf' || r.body === 'none'),
    true,
    'body declared:',
  );
});

T('the lists domain declares capability, surface and activation, with a reason', () => {
  const routes = listsRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  for (const [id, want] of Object.entries(LISTS_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  // These four pages each carried their own copy of "resolve session, redirect
  // anonymous, reject foreign tenant, refuse un-activated". Now that preamble is
  // declared, so the property is checkable without reading a handler.
  eq(
    routes.every((r) => r.activation === 'required'),
    true,
    'every list page still requires an activated account:',
  );
  // Reads: a body policy here would mean a CSRF check on a GET, which the boot
  // validator rejects — this asserts the table never acquires one.
  eq(
    routes.every((r) => r.body === undefined),
    true,
    'no body policy on a read:',
  );
});

T('the learning domain declares owner-only acts, each with a reason', () => {
  const routes = learningRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  for (const [id, want] of Object.entries(LEARNING_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  // Compiling mints a procedure the router may later execute, and a transfer
  // test spends harness budget and writes trust evidence. Neither is a read.
  eq(
    routes.every((r) => r.capability === 'owner'),
    true,
    'every learning action is owner-only:',
  );
  // Both mutations declare their body policy; the boot validator rejects a
  // mutating route that does not.
  eq(
    routes.filter((r) => r.method === 'POST').every((r) => r.body === 'csrf'),
    true,
    'every learning mutation verifies its token:',
  );
  // An owner-only HTML route must carry denied copy: an unprivileged user
  // following a link deserves the page's own message, not a JSON error body.
  eq(
    routes.filter((r) => r.surface === 'html').every((r) => r.denied !== undefined),
    true,
    'denials are pages:',
  );
});

T('a list page answers a browser and refuses an unauthenticated one', async () => {
  // The behaviour the four duplicated preambles used to provide, asserted once
  // for the whole domain instead of once per page.
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const paths = ['/console/requests', '/console/claims', '/console/rooms', '/console/human-work'];
    for (const path of paths) {
      const anon = await fetch(`${base}${path}`, { redirect: 'manual' });
      eq(anon.status, 303, `${path} anonymous redirects to the login form:`);
    }
    const cookie = await login(base);
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      eq(res.status, 200, `${path} renders for a session:`);
      const body = await res.text();
      // A shelled page, not a bare fragment: the console rail comes with it.
      eq(body.includes('id="console-rail"'), true, `${path} is shelled:`);
    }
  } finally {
    await server.close();
    await db.close();
  }
});

T('the agent-tasks domain declares capability, surface and activation', () => {
  const routes = agentTasksRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  eq(byId.size, Object.keys(AGENT_TASKS_CAPABILITIES).length, 'agent-tasks route count:');
  for (const [id, want] of Object.entries(AGENT_TASKS_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  // A monitor names goals, scopes and spend, so every route — the JSON feed
  // included, since it repeats the page's data — insists on an activated account.
  eq(
    routes.every((r) => r.activation === 'required'),
    true,
    'every agent-tasks route requires an activated account:',
  );
  // It observes the pipeline and never touches it: only reads, no body policy.
  eq(
    routes.every((r) => r.method === 'GET' && r.body === undefined),
    true,
    'agent-tasks is read-only:',
  );
});

T('the agent-tasks pages answer a session and refuse everyone else', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // The two transports differ by declaration, not by a handler remembering:
    // an HTML page redirects a browser, an API endpoint answers 401.
    const anonHtml = await fetch(`${base}/console/agent-tasks`, { redirect: 'manual' });
    eq(anonHtml.status, 303, 'anonymous list redirects to the login form:');
    const anonFeed = await fetch(`${base}/console/agent-tasks/does-not-exist/feed`, { redirect: 'manual' });
    eq(anonFeed.status, 401, 'anonymous feed is a 401, not a redirect:');
    const cookie = await login(base);
    const res = await fetch(`${base}/console/agent-tasks`, { headers: { cookie } });
    eq(res.status, 200, 'the list renders for a session:');
    const body = await res.text();
    eq(body.includes('id="console-rail"'), true, 'the list is shelled:');
    eq(body.includes('Ongoing Tasks'), true, 'the list carries its own heading:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('one page view evaluates the room set once, not once per consumer', async () => {
  // Measured, not assumed: before request-scoped memoization /console/rooms
  // issued 181 statements (the page asked for room health, then the shell asked
  // for it again — ~78 statements of duplication) and every shelled page read
  // the tenant's stop list once per room (13×). This test fails if either comes
  // back, because a duplicate read is invisible in a screenshot and invisible in
  // a functional test — it only shows up as a latency regression nobody owns.
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );

  // Count statements with their arguments: the same SQL with a different scope
  // is the per-room loop (real work), the same SQL with the same arguments is
  // duplicate work.
  const counted = instrument(db);

  const server = await startConsoleServer(counted.proxy, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const cookie = await login(base);
    counted.reset();
    const res = await fetch(`${base}/console/rooms`, { headers: { cookie } });
    eq(res.status, 200);
    await res.text();

    const repeated = [...counted.byKey().entries()].filter(([, n]) => n > 1);
    // Exactly one read legitimately repeats in a shelled page: the session's own
    // user row, fetched once to authenticate and once by the page context. Any
    // *other* repeat means a read was asked for twice within one render.
    eq(
      repeated.map(([id]) => id.split(' | ')[0]),
      ['SELECT * FROM users WHERE id = ?'],
      'no read is issued twice within a page view:',
    );
    // And the room health rollup itself ran once.
    const rollups = [...counted.byKey().keys()].filter((id) =>
      id.startsWith("SELECT key FROM meta WHERE key LIKE 'room:config:"),
    );
    eq(rollups.length, 1, 'room health evaluated once per request:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('every request logs its render cost', async () => {
  // Latency alone cannot show a page that quietly started asking for the same
  // thing twice — it is fast, correct, and twice as expensive. The count is
  // logged per request so that regression is visible in production and not only
  // in a benchmark nobody runs.
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  const original = console.log;
  const lines: string[] = [];
  try {
    const cookie = await login(base);
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await (await fetch(`${base}/console/rooms`, { headers: { cookie } })).text();
      // The line is written on `finish`, a tick after the body is read.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      console.log = original;
    }
  } finally {
    console.log = original;
  }
  try {
    const logged = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { path?: string; sql?: number; memo?: number };
        } catch {
          return null;
        }
      })
      .filter((r): r is { path: string; sql: number; memo: number } => Boolean(r?.path));
    // The line must name the page: a metric bucketed as `unmatched` cannot show
    // which page regressed, and the busiest pages used to log exactly that.
    const page = logged.find((r) => r.path === '/console/rooms');
    eq(Boolean(page), true, `the page logged its own name (got ${logged.map((l) => l.path).join(', ')}):`);
    // A shelled page is not one query: this asserts a real count, so a meter that
    // silently stopped counting (or stopped being wired) fails here.
    eq((page?.sql ?? 0) > 20, true, `sql counted (${page?.sql}):`);
    eq((page?.memo ?? 0) > 0, true, `memo hits logged (${page?.memo}):`);
    // And an identifier-free name: a request log is not a place for tenant data.
    eq(page?.path.includes(':id'), false, 'no raw identifiers in the log path:');
  } finally {
    await server.close();
    await db.close();
  }
});

// --------------------------------------------------------------- sql budgets

/**
 * A statement counter that also records *who* issued each statement.
 *
 * Two questions, one instrument: the total says how expensive a page is, and
 * the module tally says where the cost sits — so a regression reports "gov/trust
 * 4 → 9" instead of "this page is 5 statements heavier than last month".
 *
 * Counting happens at `prepare`/`exec`, the same quantity the server logs as
 * `sql`, so a number here and a number in `var/serve.log` are comparable.
 */
function instrument(db: AsyncDb): {
  proxy: AsyncDb;
  reset(): void;
  statements(): number;
  byKey(): Map<string, number>;
  byModule(): Map<string, number>;
} {
  const byKey = new Map<string, number>();
  const byModule = new Map<string, number>();
  const tally = (mod: string): void => {
    byModule.set(mod, (byModule.get(mod) ?? 0) + 1);
  };
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          tally(moduleOf());
          const stmt = (target as unknown as { prepare(s: string): unknown }).prepare(sql);
          const key = sql.replace(/\s+/g, ' ').trim();
          return new Proxy(stmt as object, {
            get(s, p) {
              const v = Reflect.get(s, p) as unknown;
              if (typeof v !== 'function') return v;
              if (p === 'get' || p === 'all' || p === 'run') {
                return (...args: unknown[]) => {
                  const id = `${key} | ${JSON.stringify(args)}`;
                  byKey.set(id, (byKey.get(id) ?? 0) + 1);
                  return (v as (...a: unknown[]) => unknown).apply(s, args);
                };
              }
              return (v as (...a: unknown[]) => unknown).bind(s);
            },
          });
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          tally(moduleOf());
          return (target as unknown as { exec(s: string): Promise<void> }).exec(sql);
        };
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as AsyncDb;
  return {
    proxy,
    reset(): void {
      byKey.clear();
      byModule.clear();
    },
    statements: () => [...byModule.values()].reduce((a, b) => a + b, 0),
    byKey: () => byKey,
    byModule: () => byModule,
  };
}

const SRC_FRAME = /[\\/]src[\\/]([^\\/:]+)[\\/]([^\\/:]+)\.ts/;

/**
 * The module that issued the statement on the current stack — the first `src/`
 * frame that is not the database layer itself. Attribution is by author, not by
 * callee: a query written in `gov/trust.ts` is `gov/trust` even when the console
 * asked for it, which is what makes "where did the extra statements come from"
 * answerable.
 */
function moduleOf(): string {
  const stack = new Error().stack ?? '';
  for (const frame of stack.split('\n').slice(2)) {
    const m = SRC_FRAME.exec(frame);
    if (!m) continue;
    const mod = `${m[1]}/${m[2]}`;
    if (mod === 'core/db') continue;
    return mod;
  }
  return 'unattributed';
}

interface PageBudget {
  url: string;
  /** Declared pattern, for the dispatch assertion below. */
  pattern: string;
  /**
   * Which mechanism serves this page today, asserted against the route tables.
   * A page that migrates without appearing here fails the dispatch check — so
   * this table is also the migration map, and `legacy` entries are the pages
   * still costing a session lookup inside a 5,000-line if-chain.
   */
  dispatch: 'table' | 'legacy';
  /** Rendered with no session (the login form answers a session with a redirect). */
  anonymous?: true;
  /** Total statements for one render: measured with ~10% headroom. */
  total: number;
  /**
   * Statements per module: the measurement itself, exact. A module count that
   * grows fails and names itself, which is the whole point — an increase of two
   * statements inside `gov/trust` is a different problem from two more shell
   * reads in `console/shell-reads`.
   */
  modules: Record<string, number>;
}

/**
 * Per-page statement budgets.
 *
 * The failure this prevents: a page that quietly starts asking for the same
 * thing twice. It stays fast, it stays correct, it costs double — invisible in
 * a functional test and in a screenshot, and only visible months later as "the
 * console got slower". The memoization work measured `/console/rooms` at 181
 * statements where 103 were justified, which is exactly the shape this catches.
 *
 * The budget is a property of the *code path*, not of a tenant's data:
 * `/console/rooms` evaluates every room, so a tenant with sixty rooms
 * legitimately costs more than the one-room tenant these numbers come from.
 * What must not scale is the number of times the same read is issued per render.
 *
 * What the first per-module measurement showed, and the reason the breakdown is
 * worth freezing: **the shell dominates every page**. `talk/health` (the stop
 * list) is 53 statements and `talk/rooms` 14 and `console/shell-metrics` 16 on
 * every shelled page, so ~83 of each page's ~90 statements belong to chrome, not
 * to the page. `/console/buzz` costs 208 because it asks for the same shell
 * reads per room (talk/health 106, talk/rooms 54). That is where the next
 * performance change should go, and it is visible here without a profiler.
 */
const PAGE_SQL_BUDGETS: readonly PageBudget[] = [
  // Still served by the legacy chain. Budgeted anyway: what a page costs is a
  // property of the page, not of the mechanism that happens to route it — and
  // these are the heaviest pages in the console.
  { url: '/login', pattern: '/login', dispatch: 'legacy', anonymous: true, total: 3, modules: { 'core/auth': 2 } },
  {
    url: '/console/dashboard',
    pattern: '/console/dashboard',
    dispatch: 'legacy',
    total: 119,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'console/activation': 7,
      'core/auth': 6,
      'console/journey': 4,
      'console/report': 2,
      'gov/trust': 2,
      'attrib/attribution': 1,
      'router/router': 1,
      'console/serve': 1,
      'ingest/health': 1,
    },
  },
  {
    url: '/console/buzz',
    pattern: '/console/buzz',
    dispatch: 'legacy',
    total: 229,
    modules: {
      'talk/health': 106,
      'talk/rooms': 54,
      'talk/budget-gauge': 26,
      'console/shell-metrics': 16,
      'core/auth': 5,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/buzz/general',
    pattern: '/console/buzz/:room',
    dispatch: 'legacy',
    total: 113,
    modules: {
      'talk/health': 57,
      'talk/rooms': 17,
      'console/shell-metrics': 16,
      'core/auth': 6,
      'console/buzz': 3,
      'talk/budget-gauge': 2,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/workflows',
    pattern: '/console/workflows',
    dispatch: 'legacy',
    total: 102,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'console/release-workspace': 3,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/meetings',
    pattern: '/console/meetings',
    dispatch: 'legacy',
    total: 99,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'gov/trust': 1,
      'meetings/db': 1,
    },
  },
  {
    url: '/console/learning',
    pattern: '/console/learning',
    dispatch: 'legacy',
    total: 99,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'router/router': 1,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/digest',
    pattern: '/console/digest',
    dispatch: 'legacy',
    total: 99,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'gov/trust': 1,
      'console/digest': 1,
    },
  },
  {
    url: '/console/compiler',
    pattern: '/console/compiler',
    dispatch: 'legacy',
    total: 98,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'gov/trust': 1,
    },
  },
  {
    url: '/team',
    pattern: '/team',
    dispatch: 'legacy',
    total: 104,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 8,
      'gov/trust': 2,
      'console/serve': 1,
    },
  },
  {
    url: '/account',
    pattern: '/account',
    dispatch: 'legacy',
    total: 102,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 8,
      'gov/trust': 1,
    },
  },
  // Not budgeted: `/change-password` answers an activated owner with a redirect
  // by design, so it has no page render to measure — its cost is the redirect.
  // On the route table.
  {
    url: '/console/rooms',
    pattern: '/console/rooms',
    dispatch: 'table',
    total: 97,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 4,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/requests',
    pattern: '/console/requests',
    dispatch: 'table',
    total: 99,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 4,
      'console/report': 2,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/claims',
    pattern: '/console/claims',
    dispatch: 'table',
    total: 99,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 4,
      'console/report': 2,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/human-work',
    pattern: '/console/human-work',
    dispatch: 'table',
    total: 97,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 4,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/audit',
    pattern: '/console/audit',
    dispatch: 'table',
    total: 101,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 5,
      'ledger/export': 2,
      'gov/trust': 1,
    },
  },
  {
    url: '/console/data',
    pattern: '/console/data',
    dispatch: 'table',
    total: 97,
    modules: {
      'talk/health': 53,
      'console/shell-metrics': 16,
      'talk/rooms': 14,
      'core/auth': 4,
      'gov/trust': 1,
    },
  },
];

T('every budgeted page is attributed to the mechanism that really serves it', () => {
  // The budget table doubles as the migration map. If a page moves onto the
  // route table and nobody updates `dispatch`, this fails — which is when the
  // author is looking at the budget and can re-measure it in the same sitting.
  const migrated = new Set([
    ...Object.keys(OBSERVABILITY_CAPABILITIES),
    ...Object.keys(COMPLIANCE_CAPABILITIES),
    ...Object.keys(REQUESTS_CAPABILITIES),
    ...Object.keys(LISTS_CAPABILITIES),
  ]);
  const wrong = PAGE_SQL_BUDGETS.filter((p) => (p.dispatch === 'table') !== migrated.has(`GET ${p.pattern}`)).map(
    (p) => `${p.url} is marked ${p.dispatch}`,
  );
  eq(wrong, [], 'each budgeted page names the mechanism that serves it:');
});

T('every page stays inside its statement budget', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const counted = instrument(db);
  const server = await startConsoleServer(counted.proxy, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const cookie = await login(base);
    const measured: { page: PageBudget; status: number; total: number; modules: Record<string, number> }[] = [];
    for (const page of PAGE_SQL_BUDGETS) {
      counted.reset();
      const res = await fetch(`${base}${page.url}`, {
        headers: page.anonymous ? {} : { cookie },
        redirect: 'manual',
      });
      await res.text();
      measured.push({
        page,
        status: res.status,
        total: counted.statements(),
        modules: Object.fromEntries(counted.byModule()),
      });
    }
    // A page that stopped rendering would otherwise "pass" by costing nothing.
    const broken = measured.filter((m) => m.status !== 200).map((m) => `${m.page.url}=${m.status}`);
    eq(broken, [], `every budgeted page renders (not 200: ${broken.join(', ')}):`);

    const over = measured
      .filter((m) => m.total > m.page.total)
      .map((m) => `${m.page.url} used ${m.total} of ${m.page.total}`);
    eq(over, [], `no page doubled its cost (measured: ${measured.map((m) => `${m.page.url}=${m.total}`).join(' ')}):`);

    // The per-module diff. This is the assertion meant to be *read*: it answers
    // "which statements grew", in the module that owns them, so the fix is
    // visible before opening a profiler.
    const grown: string[] = [];
    for (const m of measured) {
      for (const [mod, n] of Object.entries(m.modules).sort((a, b) => b[1] - a[1])) {
        const was = m.page.modules[mod] ?? 0;
        if (n > was) grown.push(`${m.page.url} ${mod} ${was} → ${n}`);
      }
    }
    eq(
      grown,
      [],
      `statement counts that grew — if intended, update that page\u2019s module counts (breakdown: ${measured
        .map(
          (m) =>
            `${m.page.url}[${Object.entries(m.modules)
              .map(([k, v]) => `${k}:${v}`)
              .join(' ')}]`,
        )
        .join(' ')}):`,
    );

    // And a budget may not go slack: one more than half again over the measured
    // cost is no longer a ratchet, it is decoration. Improving a page means
    // lowering its budget in the same change.
    const slack = measured
      .filter((m) => m.page.total > m.total * 1.5)
      .map((m) => `${m.page.url} ${m.page.total} vs ${m.total}`);
    eq(slack, [], `budgets stay tight (page budget vs measured):`);
  } finally {
    await server.close();
    await db.close();
  }
});

// ------------------------------------------------- boot-time policy validation

T('a mutating route has to declare how its body is handled', () => {
  // The check that matters most and used to be least reviewable: is this
  // POST verifying a token? Now it is a column in the table, enforced at boot.
  throws(() => validateRoutes([def({ method: 'POST', pattern: '/x' })]), 'must declare a body policy');
  // A GET has no body policy to declare.
  throws(
    () => validateRoutes([def({ method: 'GET', pattern: '/y', body: 'csrf' })]),
    'declares a body policy but does not mutate',
  );
  // A public route has no session, so a CSRF check there could never pass — a
  // check that cannot succeed reads like security and is not.
  throws(
    () => validateRoutes([def({ method: 'POST', pattern: '/z', capability: 'public', surface: 'api', body: 'csrf' })]),
    'declares a CSRF check but is public',
  );
  // Activation is a property of an account, so the route needs one.
  throws(
    () =>
      validateRoutes([
        def({ method: 'GET', pattern: '/w', capability: 'public', surface: 'html', activation: 'required' }),
      ]),
    'requires an activated account but is public',
  );
  // And the shape every mutating route in the table actually has passes.
  validateRoutes([def({ method: 'POST', pattern: '/ok', capability: 'session', surface: 'api', body: 'csrf' })]);
});

T('the compliance domain is complete, and erasure checks its token', async () => {
  // Irreversible deletion is the one place a missing check is unrecoverable, so
  // every refusal path is asserted against a live server: a bad token, and a
  // confirmation that does not match, must both leave the tenant standing.
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Ada',
    },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Anonymous: a browser is sent to the login form rather than answered with
    // JSON it cannot act on.
    const anon = await fetch(`${base}/console/data/erase`, {
      method: 'POST',
      redirect: 'manual',
      body: `confirmed=on&confirmSlug=${TEN}`,
    });
    eq(anon.status, 303, 'anonymous erasure redirects:');

    const cookie = await login(base);
    const csrf = await freshToken(base, cookie);
    const erase = async (body: string): Promise<Response> =>
      fetch(`${base}/console/data/erase`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body,
      });

    // A verified session without the session's token is refused...
    const noToken = await erase(`confirmed=on&confirmSlug=${TEN}`);
    eq(noToken.status, 403, 'erasure without a token is refused:');
    eq((await noToken.text()).includes('CSRF'), true, 'and says why:');

    // ...and so is a token that belongs to nobody.
    const forged = await erase(`csrf=${'0'.repeat(64)}&confirmed=on&confirmSlug=${TEN}`);
    eq(forged.status, 403, 'a forged token is refused:');

    // Typed confirmation: a mis-click cannot destroy a tenant.
    const mismatch = await erase(`csrf=${csrf}&confirmed=on&confirmSlug=not-${TEN}`);
    eq(mismatch.status, 303, 'confirmation mismatch redirects back:');
    eq((mismatch.headers.get('location') ?? '').includes('error='), true, 'and carries the reason:');

    // Nothing was erased by any of the three refusals: the session still works
    // and the owner-only pages still render.
    eq(
      (await fetch(`${base}/console/audit`, { headers: { cookie }, redirect: 'manual' })).status,
      200,
      'no partial erase:',
    );
    eq((await fetch(`${base}/console/data`, { headers: { cookie } })).status, 200);
  } finally {
    await server.close();
    await db.close();
  }
});

T('the migration boundary is explicit, not implied', () => {
  // Everything not in these tables is still served by the legacy chain, so it
  // has no declared capability yet. This assertion is the burn-down list: as
  // routes migrate, they disappear from here. It must never be used to claim
  // the work is done.
  const migrated = new Set(
    [
      ...Object.keys(OBSERVABILITY_CAPABILITIES),
      ...Object.keys(COMPLIANCE_CAPABILITIES),
      ...Object.keys(REQUESTS_CAPABILITIES),
      ...Object.keys(LISTS_CAPABILITIES),
      ...Object.keys(LEARNING_CAPABILITIES),
    ].map((id) => `${id.split(' ')[0]} ${id.split(' ')[1]}`),
  );
  // The whole compliance domain now declares its capability, surface and body
  // policy — reads and the one irreversible mutation alike.
  eq(migrated.has('GET /console/audit'), true);
  eq(migrated.has('POST /console/data/erase'), true, 'erasure migrated:');
  eq(migrated.has('POST /api/requests/:id/refresh-evidence'), true, 'evidence refresh migrated:');
  // The four list surfaces. Rooms came along because it shared a dispatcher
  // branch with human work: splitting one branch's authorisation across two
  // mechanisms is worse than migrating both.
  eq(migrated.has('GET /console/requests'), true, 'request index migrated:');
  eq(migrated.has('GET /console/claims'), true, 'claim index migrated:');
  eq(migrated.has('GET /console/human-work'), true, 'approval queue migrated:');
  eq(migrated.has('GET /console/rooms'), true, 'room index migrated:');
  // The learning *acts*. The learning read surfaces (the list, the card page and
  // the label write) are still on the legacy chain and are named below, so
  // "learning is on the table" cannot be read as "all of learning is".
  eq(migrated.has('GET /console/learning/compile'), true, 'compile form migrated:');
  eq(migrated.has('POST /console/learning/compile'), true, 'compilation migrated:');
  eq(migrated.has('POST /console/learning/cards/:id/transfer-test'), true, 'transfer dispatch migrated:');
  eq(migrated.size, 16, 'migrated route count (update deliberately):');
  eq(migrated.has('GET /console/learning'), false, 'the learning read page is still legacy:');
  eq(migrated.has('GET /console/learning/:id'), false, 'the card page is still legacy:');
  eq(migrated.has('POST /console/learning/label'), false, 'the label write is still legacy:');
  // Still on the legacy chain, with no declared capability. Named explicitly so
  // "migrated" cannot quietly mean "everything". These write a ledger decision
  // inside a transaction with a duplicate-submission receipt path — their own
  // reviewed change, not a rider on the read-only migration above.
  eq(migrated.has('POST /api/requests/:id/approve'), false, 'approvals not migrated yet:');
  eq(migrated.has('POST /api/requests/:id/decline'), false, 'declines not migrated yet:');
});

/** A fresh CSRF token for this session (a page render is the easy source). */
async function freshToken(base: string, cookie: string): Promise<string | null> {
  const res = await fetch(`${base}/change-password`, { headers: { cookie } });
  return (await res.text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1] ?? null;
}

async function login(base: string, email = 'owner@acme.test'): Promise<string> {
  const pre = await fetch(`${base}/login`, { redirect: 'manual' });
  const preCookies = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const token = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { cookie: preCookies },
    body: `csrf=${token}&email=${encodeURIComponent(email)}&password=${encodeURIComponent('the-console-password')}`,
    redirect: 'manual',
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}
