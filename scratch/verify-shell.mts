// Scratch verification: boots the console on a throwaway in-memory app, logs
// in, fetches the five System pages, and asserts the shell layout fix is in
// the served HTML (shell reset must appear AFTER the leaked page-body rule).
import { writeFileSync, readFileSync } from 'node:fs';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { fresh, TEN, NOW } from '../test/helpers.ts';

const ctx = await fresh();
const { db, ledger, coord } = ctx;
const comp = new OrganizationalCompiler(db);
await installAuthSchema(db, NOW);
await signupTenant(
  db,
  { slug: TEN, name: 'Acme', email: 'owner@acme.test', password: 'the-console-password', ownerName: 'Ada' },
  NOW,
);
const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
const base = `http://127.0.0.1:${server.port}`;

const pre = await fetch(`${base}/login`, { redirect: 'manual' });
const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
const loginRes = await fetch(`${base}/login`, {
  method: 'POST',
  headers: { cookie: preCookie },
  body: `csrf=${preToken}&email=owner@acme.test&password=the-console-password`,
  redirect: 'manual',
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

for (const page of ['compiler', 'digest', 'learning', 'audit', 'data']) {
  const res = await fetch(`${base}/console/${page}`, { headers: { cookie } });
  const html = await res.text();
  writeFileSync(new URL(`./${page}.html`, import.meta.url), html);
  check(`${page}: 200`, res.status === 200);
  const leaked = html.indexOf('max-width:960px');
  const shellReset = html.indexOf('max-width: none');
  check(`${page}: shell reset present`, shellReset !== -1);
  check(
    `${page}: reset wins cascade (appears after leaked rule)`,
    leaked === -1 || (shellReset !== -1 && shellReset > leaked),
  );
  check(`${page}: back-link pill rule`, html.includes('.ws-scroll > a:first-of-type'));
}
const compiler = readOut('compiler');
check('compiler: design-system page head', compiler.includes('v-page-title'));
check('compiler: honest empty state', compiler.includes('No skill cards compiled yet'));
check('compiler: lifecycle rail', compiler.includes('Lifecycle ladder'));
const learning = readOut('learning');
check('learning: v-table upgrade', learning.includes('v-table-wrap') || learning.includes('v-empty'));
check('learning: pinned headings', learning.includes('Labeling queue (0)') && learning.includes('Skill cards (0)'));
const data = readOut('data');
check('data: design-system page head', data.includes('v-page-title') && data.includes('Data &amp; retention'));

function readOut(name: string): string {
  return readFileSync(new URL(`./${name}.html`, import.meta.url), 'utf8');
}

await server.close();
await db.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
