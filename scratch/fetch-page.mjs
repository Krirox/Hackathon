// Reusable: log into the isolated console (127.0.0.1:3199) and dump a page's
// HTML to a file for inspection. Usage: node scratch/fetch-page.mjs <path> <out>
import { writeFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:3199';
const target = process.argv[2] ?? '/console/meetings';
const out = process.argv[3] ?? 'scratch/page.html';

let cookie = '';
function saveCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const [k] = pair.split('=');
    cookie = cookie
      .split('; ')
      .filter((p) => p && p.split('=')[0] !== k)
      .concat(pair)
      .join('; ');
  }
}

const login = await fetch(`${BASE}/login`, { redirect: 'manual' });
saveCookies(login);
const csrf = /name="csrf" value="([^"]+)"/.exec(await login.text())?.[1] ?? '';
const post = await fetch(`${BASE}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams({ csrf, email: 'owner@acme.test', password: 'Inspect-Passw0rd-2026' }),
});
saveCookies(post);

const res = await fetch(`${BASE}${target}`, { headers: { cookie } });
const html = await res.text();
writeFileSync(out, html);
const has = (re) => (html.match(re) ?? []).length;
console.log(`${target} -> ${res.status}  (${html.length} bytes)  saved ${out}`);
console.log('  vc-topbar (console shell):', has(/class="vc-topbar"/g));
console.log('  console-rail            :', has(/id="console-rail"/g));
console.log('  meeting-library-view    :', has(/class="meeting-library-view"/g));
console.log('  --v-stage-* token uses  :', has(/--v-stage-[a-z0-9-]+/g));
console.log('  stageTokensCss present  :', has(/--v-stage-ink-strong:/g));
console.log('  <style> blocks          :', has(/<style/g));
console.log('  full doc (<!DOCTYPE)    :', has(/<!DOCTYPE|<!doctype/gi));
