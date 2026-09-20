/**
 * Scratch (not shipped): boot the console with seeded data, log in as the
 * owner, fetch every major route and write the HTML to tmp/ui/<name>.html so
 * the redesign can be inspected in a browser. Prints token/coherence
 * diagnostics: which pages define :root tokens, which reference them without
 * a definition, and which still carry the legacy palette.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEN, NOW, fresh, sor, base } from '../test/helpers.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { startConsoleServer } from '../src/console/serve.ts';

const OUT = join('tmp', 'ui');
mkdirSync(OUT, { recursive: true });

const ctx = await fresh();
const { db, ledger, coord, comp } = ctx as any;
await installAuthSchema(db, NOW);
await signupTenant(
  db,
  { slug: TEN, name: 'Acme', email: 'owner@acme.test', password: 'the-console-password', ownerName: 'Ada' },
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
await coord.submit(base({ id: 'r1', claimRefs: [rel.id], bid: { dollars: 10, humanMinutes: 30 } }));
await coord.submit(
  base({ id: 'r2', goal: 'Draft the launch blog for the release', claimRefs: [rel.id], bid: { dollars: 4, humanMinutes: 12 } }),
);
await coord.submit(base({ id: 'n1', goal: 'overnight sync completed', messageClass: 'NOTICE', claimRefs: [rel.id] }));

const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
const baseUrl = `http://127.0.0.1:${server.port}`;

const pre = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const preHtml = await pre.text();
const preToken = preHtml.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
const loginRes = await fetch(`${baseUrl}/login`, {
  method: 'POST',
  headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: `csrf=${preToken}&email=owner%40acme.test&password=the-console-password`,
  redirect: 'manual',
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const routes: Array<[string, string]> = [
  ['dashboard', '/console/dashboard'],
  ['dashboard-approvals', '/console/dashboard?tab=approvals'],
  ['dashboard-ledger', '/console/dashboard?tab=ledger'],
  ['dashboard-workflows', '/console/dashboard?tab=workflows'],
  ['dashboard-governance', '/console/dashboard?tab=governance'],
  ['dashboard-activity', '/console/dashboard?tab=activity'],
  ['dashboard-finance', '/console/dashboard?scope=finance'],
  ['buzz-engineering', '/console/buzz/engineering'],
  ['digest', '/console/digest'],
  ['rooms', '/console/rooms'],
  ['human-work', '/console/human-work'],
  ['requests', '/console/requests'],
  ['claims', '/console/claims'],
  ['audit', '/console/audit'],
  ['data', '/console/data'],
  ['learning', '/console/learning'],
  ['compiler', '/console/compiler'],
  ['workflows', '/console/workflows'],
  ['team', '/team'],
  ['account', '/account'],
  ['setup', '/setup'],
  ['login', '/login'],
  ['request-detail', '/console/requests/r2'],
  ['claim-detail', `/console/claims/${rel.id}`],
];

const LEGACY = ['#FAFAF8', '#0A0F14', '#0F5C57', '#E4E4E1', '#111827', '#B91C1C', '#166534', '#F9F9F8'];

for (const [name, route] of routes) {
  const res = await fetch(baseUrl + route, { headers: { cookie }, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  writeFileSync(join(OUT, `${name}.html`), html || `<!-- ${res.status} -->`);
  const tokenDef = html.includes('--v-bg-0:');
  const usesToken = html.includes('var(--v-');
  const legacy = LEGACY.filter((hex) => html.includes(hex));
  const flags = [
    `status=${res.status}`,
    tokenDef ? 'tokens:yes' : usesToken ? 'tokens:MISSING' : 'tokens:n/a',
    `len=${html.length}`,
  ];
  if (legacy.length) flags.push(`legacy=${legacy.join(',')}`);
  for (const marker of ['id="system-readiness"', 'id="tenant-journey"', 'name="state"', 'v-kpi', 'rail-item', 'buzz-window']) {
    if (html.includes(marker)) flags.push(marker);
  }
  console.log(`${name.padEnd(20)} ${flags.join('  ')}`);
}

writeFileSync(join(OUT, 'index.txt'), routes.map(([n, r]) => `${n} ${r}`).join('\n'));
await server.close();
await db.close();
