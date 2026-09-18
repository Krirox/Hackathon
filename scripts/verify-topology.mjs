// Topology smoke check (FLOW-006, E2E-17).
//
// Validates the documented load-balancer-to-task path, not just a loopback
// probe: Host routing, X-Forwarded-Proto handling, the reachability-only
// public pill, and (with --email/--password) authenticated readiness —
// including readiness failure on dependency loss.
//
//   node scripts/verify-topology.mjs --base-url http://127.0.0.1:3100
//   node scripts/verify-topology.mjs --base-url https://alb.example.com --email o@acme.test --password '...'
//   node scripts/verify-topology.mjs --base-url http://127.0.0.1:3100 --email ... --password ... --expect-ready false
//
// Against `deploy/compose.yml`: boot the stack, run once expecting ready,
// stop postgres (`docker compose stop postgres`), run again expecting
// not-ready while /healthz still answers alive (liveness != readiness),
// then start postgres again. See docs/deployment.md "Topology verification".

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

const baseUrl = (flag('--base-url') ?? '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('usage: node scripts/verify-topology.mjs --base-url <https://alb-or-http://task:3100> [--email E --password P] [--expect-ready true|false]');
  process.exit(2);
}
const email = flag('--email');
const password = flag('--password');
const expectRaw = flag('--expect-ready');
const expectReady = expectRaw === undefined ? undefined : expectRaw === 'true';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures += 1;
};

// 1. Liveness through the entry point (ALB or direct task URL).
const healthz = await fetch(`${baseUrl}/healthz`, { headers: { accept: 'application/json' } });
check('healthz reachable through entry point', healthz.ok, `HTTP ${healthz.status}`);
const live = healthz.ok ? await healthz.json() : {};
if (healthz.ok) {
  check('healthz reports ok+alive', live.ok === true && live.alive === true, JSON.stringify({ ok: live.ok, alive: live.alive }));
  check('healthz names its listen target', typeof live.listen === 'string' && live.listen.length > 0, live.listen);
  console.log(`info - served by ${live.listen} proto=${live.proto ?? '?'} viaProxy=${live.viaProxy ?? '?'}`);
}

// 2. Forwarded-proto handling: the task must see the client-facing scheme.
// A direct (non-LB) task answers http; through an HTTPS ALB with TRUST_PROXY
// the task must report https — otherwise secure-cookie/session assumptions
// silently break behind the load balancer.
const fwd = await fetch(`${baseUrl}/healthz`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' } });
if (fwd.ok) {
  const body = await fwd.json();
  const isHttpsEntry = baseUrl.startsWith('https://');
  console.log(`info - with X-Forwarded-Proto: https the task reports proto=${body.proto} viaProxy=${body.viaProxy}`);
  if (isHttpsEntry) check('task honors X-Forwarded-Proto from the entry point', body.proto === 'https', `proto=${body.proto}`);
  else console.log('info - direct-URL probe only; the https assertion applies when --base-url is the ALB (see docs)');
}

// 3. Public pill stays reachability-only: no readiness, nothing sensitive.
const pill = await fetch(`${baseUrl}/api/health`);
check('public pill reachable', pill.ok, `HTTP ${pill.status}`);
if (pill.ok) {
  const body = await pill.json();
  check('pill reports reachability only', body.ok === true && !('readiness' in body), JSON.stringify(Object.keys(body)));
}

// 4. Authenticated readiness (optional): proves dependency truth through
// the same path — ready with the DB up, failing with it down.
if (email && password) {
  const jar = [];
  const loginPage = await fetch(`${baseUrl}/login`, { headers: { accept: 'text/html' } });
  const setCookies = loginPage.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) jar.push(c.split(';')[0]);
  const html = await loginPage.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  check('login form issues a pre-session CSRF', Boolean(csrf));
  if (csrf) {
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.join('; ') },
      body: new URLSearchParams({ csrf, email, password }),
      redirect: 'manual',
    });
    for (const c of (login.headers.getSetCookie?.() ?? [])) jar.push(c.split(';')[0]);
    check('login succeeds', login.status === 303 || login.status === 302, `HTTP ${login.status}`);
    const metrics = await fetch(`${baseUrl}/api/metrics`, { headers: { cookie: jar.join('; ') } });
    check('authenticated metrics reachable', metrics.ok, `HTTP ${metrics.status}`);
    if (metrics.ok) {
      const body = await metrics.json();
      const readiness = body.readiness;
      check('readiness report present', Boolean(readiness) && Array.isArray(readiness.checks));
      if (readiness) {
        for (const c of readiness.checks) console.log(`info - readiness ${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`);
        const db = readiness.checks.find((c) => c.name === 'database');
        console.log(`info - overall ready=${readiness.ready}`);
        if (expectReady !== undefined) {
          check(`readiness.ready === ${expectReady}`, readiness.ready === expectReady, `ready=${readiness.ready}`);
          if (expectReady === false) {
            check('database dependency reports the outage', db && db.status !== 'ok', db ? `${db.status}` : 'missing');
          }
        }
      }
    }
  }
} else if (expectReady !== undefined) {
  console.error('FAIL - --expect-ready needs --email/--password for the authenticated readiness check');
  failures += 1;
}

if (failures > 0) {
  console.error(`verify-topology: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('verify-topology: OK');
