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
import type { Role } from '../src/core/auth.ts';

console.log('\n\x1b[1mRoute table — declared capability, enforced once\x1b[0m');

// ------------------------------------------------------------- registry: pure

const noop = () => {};

function def(over: Partial<RouteDef<unknown>> = {}): RouteDef<unknown> {
  return { method: 'GET', pattern: '/x', capability: 'public', surface: 'api', handler: noop, ...over };
}

T('a route that cannot register fails loudly at boot, not as a 404', () => {
  // A route silently dropped from the table is invisible in production; these
  // throw instead.
  throws(
    () => validateRoutes([def({ pattern: '/a' }), def({ pattern: '/a' })]),
    'duplicate route',
  );
  throws(() => validateRoutes([def({ capability: undefined as never })]), 'no capability');
  throws(() => validateRoutes([def({ pattern: 'no-slash' })]), 'must start with "/"');
  throws(() => validateRoutes([def({ pattern: '/a/:b:c' })]), 'malformed param');
  throws(() => validateRoutes([def({ handler: undefined as never })]), 'has no handler');
  // Surface is not optional either: it decides whether a browser is redirected
  // to the login form or handed a 401, and 'undefined' has no sane default.
  throws(() => validateRoutes([def({ surface: undefined as never })]), 'no surface');
  // An owner-only *page* must declare what a non-owner sees. Without it the
  // dispatcher would have to invent user-facing copy.
  throws(
    () => validateRoutes([def({ capability: 'owner', surface: 'html' })]),
    'must declare `denied`',
  );
  // The valid case must not throw.
  validateRoutes([def({ pattern: '/a' }), def({ pattern: '/a/:id', method: 'POST' })]);
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
  const routes = [def({ method: 'GET', pattern: '/api/metrics' }), def({ method: 'POST', pattern: '/console/issues/:id' })];
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
    eq(
      xp.headers.get('content-disposition'),
      `attachment; filename="${TEN}-ledger-export.json"`,
    );

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
  const counts = new Map<string, number>();
  const counted = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = (target as unknown as { prepare(s: string): unknown }).prepare(sql);
          const key = sql.replace(/\s+/g, ' ').trim();
          return new Proxy(stmt as object, {
            get(s, p) {
              const v = Reflect.get(s, p) as unknown;
              if (typeof v !== 'function') return v;
              if (p === 'get' || p === 'all' || p === 'run') {
                return (...args: unknown[]) => {
                  const id = `${key} | ${JSON.stringify(args)}`;
                  counts.set(id, (counts.get(id) ?? 0) + 1);
                  return (v as (...a: unknown[]) => unknown).apply(s, args);
                };
              }
              return (v as (...a: unknown[]) => unknown).bind(s);
            },
          });
        };
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as typeof db;

  const server = await startConsoleServer(counted, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const cookie = await login(base);
    counts.clear();
    const res = await fetch(`${base}/console/rooms`, { headers: { cookie } });
    eq(res.status, 200);
    await res.text();

    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    // Exactly one read legitimately repeats in a shelled page: the session's own
    // user row, fetched once to authenticate and once by the page context. Any
    // *other* repeat means a read was asked for twice within one render.
    eq(
      repeated.map(([id]) => id.split(' | ')[0]),
      ['SELECT * FROM users WHERE id = ?'],
      'no read is issued twice within a page view:',
    );
    // And the room health rollup itself ran once.
    const rollups = [...counts.keys()].filter((id) => id.startsWith("SELECT key FROM meta WHERE key LIKE 'room:config:"));
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

T('the migration boundary is explicit, not implied', () => {
  // Everything not in these tables is still served by the legacy chain, so it
  // has no declared capability yet. This assertion is the burn-down list: as
  // routes migrate, they disappear from here. It must never be used to claim
  // the work is done.
  const migrated = new Set(
    [...Object.keys(OBSERVABILITY_CAPABILITIES), ...Object.keys(COMPLIANCE_CAPABILITIES)].map(
      (id) => `${id.split(' ')[0]} ${id.split(' ')[1]}`,
    ),
  );
  // The read half of the compliance domain moved; the one mutating route in it
  // deliberately did not, because a CSRF-checked form deserves its own change.
  eq(migrated.has('GET /console/audit'), true);
  eq(migrated.has('POST /console/data/erase'), false, 'erasure is not migrated yet:');
  eq(migrated.size, 7, 'migrated route count (update deliberately):');
});

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
