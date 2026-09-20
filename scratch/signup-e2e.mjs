async function setup() {
  const base = 'http://127.0.0.1:3100';
  const pre = await fetch(base + '/signup', { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preHtml = await pre.text();
  const preCsrf = preHtml.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  console.log('CSRF:', preCsrf);
  const res = await fetch(base + '/signup', {
    method: 'POST',
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${preCsrf}&orgname=Acme+Corp&ownerName=Kulratan+Thapar&email=owner%40acme.test&password=the-console-password`,
    redirect: 'manual',
  });
  console.log('Signup status:', res.status, res.headers.get('location'));
}
setup().catch(console.error);
