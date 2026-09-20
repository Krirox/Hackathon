// Scratch (not shipped): walk the live dev stack and assert each surface.
//
//   node scratch/verify-live.mjs [http://127.0.0.1:3200]
//
// Exits non-zero if any check fails, so it can gate a manual session.
const base = process.argv[2] ?? 'http://127.0.0.1:3200';
let failed = 0;

const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const pre = await fetch(`${base}/login`, { redirect: 'manual' });
const preCookies = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const csrf = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
if (!csrf) {
  console.log('FAIL could not read the login form');
  process.exit(1);
}
const login = await fetch(`${base}/login`, {
  method: 'POST',
  headers: { cookie: preCookies, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    csrf,
    email: 'owner@acme.test',
    password: 'the-console-password',
  }).toString(),
  redirect: 'manual',
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log(`\nSign in: ${login.status} ${login.headers.get('location') ?? ''}`);
if (!cookie) {
  console.log('FAIL no session cookie — is the dev database seeded?');
  process.exit(1);
}

const pages = [
  ['/console/dashboard', 200, ['Console', 'go-to-chat-btn']],
  ['/console/rooms', 200, ['Rooms']],
  ['/console/requests', 200, ['Requests']],
  ['/console/human-work', 200, ['Approvals']],
  ['/console/claims', 200, ['Claims']],
  ['/console/audit', 200, ['Audit log']],
  ['/console/data', 200, ['Data &amp; retention']],
  ['/console/compiler', 200, []],
  ['/console/issues', null, []],
  ['/account', 200, ['Account and security', 'go-to-chat-btn']],
  ['/team', 200, []],
  ['/console/buzz/general', 200, ['vital-dashboard-btn']],
  ['/healthz', 200, []],
  ['/api/health', 200, []],
];

console.log('');
for (const [path, want, needles] of pages) {
  const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  const html = await res.text();
  const missing = needles.filter((n) => !html.includes(n));
  const statusOk = want === null ? res.status < 500 : res.status === want;
  check(
    `${path.padEnd(24)} ${res.status} ${String(html.length).padStart(7)}b`,
    statusOk && missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : '',
  );
}

// The one action that matters most on this surface: can a human approve here?
const queue = await (await fetch(`${base}/console/human-work`, { headers: { cookie } })).text();
const approveForms = (queue.match(/\/api\/requests\/[^"]+\/approve/g) ?? []).length;
const declineForms = (queue.match(/\/api\/requests\/[^"]+\/decline/g) ?? []).length;
console.log(`\nApprovals queue: ${approveForms} approve target(s), ${declineForms} decline target(s)`);
check('the queue can approve when work is pending', approveForms === declineForms);

// Separate surfaces, each linked from the other (product requirement).
const dash = await (await fetch(`${base}/console/dashboard`, { headers: { cookie } })).text();
check('console links to the chat', dash.includes('go-to-chat-btn'));
check(
  'chat links to the console',
  (await (await fetch(`${base}/console/buzz/general`, { headers: { cookie } })).text()).includes('vital-dashboard-btn'),
);
check('console carries the console palette', dash.includes('--v-bg-0'));

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
