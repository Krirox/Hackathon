// Live End-to-End Verification of Account Settings, Role-Based Dashboard, and Reality Ledger RAG
import assert from 'node:assert';

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'owner@e2e.test';
const PASSWORD = 'e2e-owner-password-01';

async function main() {
  console.log('--- Starting Live E2E Verification against', BASE, '---');

  // 1. Health check
  const healthRes = await fetch(`${BASE}/healthz`);
  assert.strictEqual(healthRes.status, 200, 'Healthz should return 200');
  console.log('✔ Healthz OK');

  // 2. Login
  const pre = await fetch(`${BASE}/login`, { redirect: 'manual' });
  const preCookies = (pre.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const preHtml = await pre.text();
  const preCsrf = preHtml.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(preCsrf, 'CSRF token extracted from login page');

  const loginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'cookie': preCookies,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf: preCsrf,
      email: EMAIL,
      password: PASSWORD,
    }).toString(),
    redirect: 'manual',
  });
  assert.strictEqual(loginRes.status, 303, 'Login should redirect with 303');
  const sessionCookie = (loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  console.log('✔ Authenticated as', EMAIL);

  // 3. Verify /account settings inside workspace shell
  const accountRes = await fetch(`${BASE}/account`, {
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(accountRes.status, 200, '/account should return 200');
  const accountHtml = await accountRes.text();
  assert.ok(accountHtml.includes('Account and security'), 'Contains Account and security heading');
  assert.ok(accountHtml.includes('Change password'), 'Contains Change password section');
  assert.ok(accountHtml.includes('Two-factor authentication'), 'Contains Two-factor authentication section');
  assert.ok(accountHtml.includes('vital-dashboard-btn'), 'Wrapped in workspace shell with dashboard button');
  assert.ok(accountHtml.includes('#general'), 'Workspace shell sidebar has canonical rooms');
  console.log('✔ Account Settings page verified inside Buzz Workspace Shell');

  // 4. Verify /console/dashboard departmental views
  // 4a. Legal view
  const legalRes = await fetch(`${BASE}/console/dashboard?scope=legal`, {
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(legalRes.status, 200, 'Dashboard legal scope should return 200');
  const legalHtml = await legalRes.text();
  assert.ok(legalHtml.includes('Legal &amp; Compliance Portal'), 'Legal dashboard portal rendered');
  assert.ok(legalHtml.includes('Data &amp; GDPR Portability'), 'GDPR link rendered');
  console.log('✔ Legal & Compliance Department Dashboard verified');

  // 4b. Finance view
  const finRes = await fetch(`${BASE}/console/dashboard?scope=finance`, {
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(finRes.status, 200, 'Dashboard finance scope should return 200');
  const finHtml = await finRes.text();
  assert.ok(finHtml.includes('Financial Operations &amp; Budget Ledger'), 'Finance dashboard portal rendered');
  assert.ok(finHtml.includes('Token Burn Rate'), 'Token burn rate rendered');
  console.log('✔ Finance & Budget Department Dashboard verified');

  // 4c. Engineering view
  const engRes = await fetch(`${BASE}/console/dashboard?scope=engineering`, {
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(engRes.status, 200, 'Dashboard engineering scope should return 200');
  const engHtml = await engRes.text();
  assert.ok(engHtml.includes('Engineering &amp; Infrastructure Command'), 'Engineering dashboard portal rendered');
  assert.ok(engHtml.includes('MicroVM Status'), 'MicroVM telemetry rendered');
  console.log('✔ Engineering & MicroVM Department Dashboard verified');

  // 5. Verify Reality Ledger RAG Business Intelligence Q&A in Buzz room
  const genRoomRes = await fetch(`${BASE}/console/buzz/general`, {
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(genRoomRes.status, 200, '/console/buzz/general returned 200');
  const genHtml = await genRoomRes.text();
  const buzzCsrf = genHtml.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(buzzCsrf, 'Buzz CSRF extracted');

  // Ask business inquiry
  const postInquiry = await fetch(`${BASE}/console/buzz/general/command`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf: buzzCsrf,
      command: 'What is going on currently in the business?',
    }).toString(),
    redirect: 'manual',
  });
  assert.strictEqual(postInquiry.status, 303, 'Command post should redirect');

  // Read back room timeline
  const afterRes = await fetch(`${BASE}/console/buzz/general`, {
    headers: { cookie: sessionCookie },
  });
  const afterHtml = await afterRes.text();
  assert.ok(afterHtml.includes('general-agent'), 'general-agent is author of reply');
  assert.ok(afterHtml.includes('Vital Business Intelligence Briefing'), 'Briefing title rendered');
  assert.ok(afterHtml.includes('Grounded in Reality Ledger'), 'Grounded in reality ledger rendered');
  assert.ok(afterHtml.includes('Spend &amp; Attention Telemetry') || afterHtml.includes('Spend & Attention Telemetry'), 'Spend telemetry rendered');
  console.log('✔ Live Reality Ledger RAG Business Intelligence Q&A verified in #general');

  console.log('\n🎉 ALL LIVE END-TO-END VERIFICATIONS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
