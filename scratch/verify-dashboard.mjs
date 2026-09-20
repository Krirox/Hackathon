async function verify() {
  const base = 'http://127.0.0.1:3100';
  const pre = await fetch(base + '/login', { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preHtml = await pre.text();
  const preCsrf = preHtml.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];

  const loginRes = await fetch(base + '/login', {
    method: 'POST',
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${preCsrf}&email=owner%40acme.test&password=the-console-password`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log('Login status:', loginRes.status, loginRes.headers.get('location'));

  const dashRes = await fetch(base + '/console/dashboard', { headers: { cookie } });
  console.log('Dashboard status:', dashRes.status);
  const html = await dashRes.text();
  console.log('Has Compiler heading:', html.includes('<h1 class="compiler-title">Compiler</h1>'));
  console.log('Has Why not trusted yet:', html.includes('Why not trusted yet'));
  console.log('Has cross-model transfer:', html.includes('cross-model transfer'));
  console.log('Has 12 Rooms:', html.includes('Rooms') && html.includes('scope:engineering'));
  console.log('Has Vital logo & brand:', html.includes('Vital') && html.includes('Acme Corp'));
  console.log(
    'Has telemetry chips:',
    html.includes('today') && html.includes('escalations') && html.includes('human min'),
  );
  console.log('Chars 1500-3500 of dashboard:\n', html.slice(1500, 3500));
}
verify().catch(console.error);
