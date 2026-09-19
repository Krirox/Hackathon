import { T, eq, TEN, NOW, fresh, sor, base } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { getAgentAvatarSrc, getScopeAvatarSrc } from '../src/console/buzz.ts';

console.log('\n\x1b[1mBuzz SVG Agent Avatar Integration Test Suite\x1b[0m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

async function seeded() {
  const ctx = await fresh();
  const { db, ledger, coord } = ctx;
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
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
  await coord.submit(base({ id: 'rq_view', goal: 'workspace fixture', claimRefs: [rel.id] }));
  return ctx;
}

async function ownerSession(port: number) {
  const url = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${url}/login`, { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { cookie: preCookie },
    body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${url}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, headers: { cookie } as Record<string, string> };
}

T('agent avatar resolver maps canonical agent identities to drive SVGs', async () => {
  eq(getAgentAvatarSrc('Bumble'), '/assets/agents/ai_image_blue.svg');
  eq(getAgentAvatarSrc('Fizz'), '/assets/agents/ai_image_green.svg');
  eq(getAgentAvatarSrc('Honey'), '/assets/agents/ai_image_red.svg');
  eq(getAgentAvatarSrc('marketing-agent'), '/assets/agents/ai_image_pink.svg');
  eq(getAgentAvatarSrc('finance-agent'), '/assets/agents/ai_image_yellow.svg');
  eq(getAgentAvatarSrc('legal-agent'), '/assets/agents/ai_image_purple.svg');
  eq(getAgentAvatarSrc('feedback-agent'), '/assets/agents/ai_image_purplesvg.svg');
  eq(getAgentAvatarSrc('general-agent'), '/assets/agents/ai_image_1.svg');
  eq(getAgentAvatarSrc('coding-agent'), '/assets/agents/ai_image_2.svg');
  eq(getAgentAvatarSrc('ops-agent'), '/assets/agents/ai_image_2.svg');
  eq(getAgentAvatarSrc('market-agent'), '/assets/agents/ai_image_3.svg');
  eq(getAgentAvatarSrc('research-agent'), '/assets/agents/ai_image_3.svg');
  eq(getAgentAvatarSrc('Ada Lovelace'), null);
});

T('scope avatar resolver maps canonical scopes to corresponding SVGs', async () => {
  eq(getScopeAvatarSrc('general'), '/assets/agents/ai_image_1.svg');
  eq(getScopeAvatarSrc('core'), '/assets/agents/ai_image_blue.svg');
  eq(getScopeAvatarSrc('facts'), '/assets/agents/ai_image_blue.svg');
  eq(getScopeAvatarSrc('research'), '/assets/agents/ai_image_3.svg');
  eq(getScopeAvatarSrc('risk'), '/assets/agents/ai_image_red.svg');
  eq(getScopeAvatarSrc('product'), '/assets/agents/ai_image_purplesvg.svg');
  eq(getScopeAvatarSrc('legal'), '/assets/agents/ai_image_purple.svg');
  eq(getScopeAvatarSrc('finance'), '/assets/agents/ai_image_yellow.svg');
  eq(getScopeAvatarSrc('infra'), '/assets/agents/ai_image_2.svg');
  eq(getScopeAvatarSrc('business'), '/assets/agents/ai_image_pink.svg');
  eq(getScopeAvatarSrc('data'), '/assets/agents/ai_image_green.svg');
  eq(getScopeAvatarSrc('exec'), '/assets/agents/ai_image_yellow.svg');
});

T('console server directly serves SVG images with correct mime and caching headers', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/assets/agents/ai_image_blue.svg`);
    eq(res.status, 200, 'HTTP status is 200');
    eq(res.headers.get('content-type'), 'image/svg+xml');
    eq(res.headers.get('cache-control')?.includes('public'), true);
    const body = await res.text();
    eq(body.includes('<svg'), true, 'body contains svg tag');

    const res2 = await fetch(`http://127.0.0.1:${server.port}/agents_images/ai_image_green.svg`);
    eq(res2.status, 200, 'backward-compatible alias returns 200');
    eq(res2.headers.get('content-type'), 'image/svg+xml');
  } finally {
    await server.close();
  }
});

T('rendered buzz room view includes agent SVG avatar in header and message list', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const res = await fetch(`http://127.0.0.1:${server.port}/console/buzz/general`, {
      headers: session.headers,
    });
    eq(res.status, 200);
    const html = await res.text();
    eq(html.includes('class="buzz-agent-avatar"'), true, 'renders agent SVG avatar in room');
    eq(html.includes('/assets/agents/ai_image_'), true, 'references site assets SVG path');
    eq(html.includes('@general-agent'), true, 'displays agent name in header');
  } finally {
    await server.close();
  }
});
