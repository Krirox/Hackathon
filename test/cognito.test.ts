import { T, eq, rejects, fresh, TEN } from './helpers.ts';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import {
  cognitoFromEnv,
  cognitoSignUp,
  cognitoVerifyPassword,
  resolveCognitoCredentials,
  signCognitoRequest,
  type CognitoConfig,
  type CognitoFetchFn,
} from '../src/console/cognito.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { inviteUser } from '../src/core/auth.ts';

console.log('\n\x1b[1mCognito — production identity lane, stubbed transport\x1b[0m');

const FIXED_NOW = new Date('2026-09-20T12:00:00.000Z');
const CFG: CognitoConfig = {
  userPoolId: 'us-east-1_TESTPOOL',
  clientId: 'client123',
  region: 'us-east-1',
};
const CREDS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test-123' };

const stubFetch =
  (
    calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>,
    respond: () => { status: number; body: string },
  ): CognitoFetchFn =>
  async (url, init) => {
    calls.push({ url, init });
    return respond();
  };

T('cognitoFromEnv gates on pool+client and resolves the region chain', () => {
  eq(cognitoFromEnv({}), null);
  eq(cognitoFromEnv({ VITAL_COGNITO_USER_POOL_ID: 'p' }), null);
  const cfg = cognitoFromEnv({
    VITAL_COGNITO_USER_POOL_ID: 'p',
    VITAL_COGNITO_CLIENT_ID: 'c',
    AWS_REGION: 'eu-west-1',
  });
  eq(cfg?.region, 'eu-west-1');
  const over = cognitoFromEnv({
    VITAL_COGNITO_USER_POOL_ID: 'p',
    VITAL_COGNITO_CLIENT_ID: 'c',
    AWS_REGION: 'eu-west-1',
    VITAL_COGNITO_REGION: 'ap-south-1',
  });
  eq(over?.region, 'ap-south-1');
});

T('signCognitoRequest: deterministic SigV4 scoped to cognito-idp with sorted headers', () => {
  const body = JSON.stringify({ ClientId: 'c' });
  const a = signCognitoRequest({
    cfg: CFG,
    creds: CREDS,
    target: 'AWSCognitoIdentityProviderService.SignUp',
    body,
    now: FIXED_NOW,
  });
  const b = signCognitoRequest({
    cfg: CFG,
    creds: CREDS,
    target: 'AWSCognitoIdentityProviderService.SignUp',
    body,
    now: FIXED_NOW,
  });
  eq(a.headers.Authorization, b.headers.Authorization);
  eq(a.url, 'https://cognito-idp.us-east-1.amazonaws.com/');
  eq(a.headers.Authorization!.includes('Credential=AKIDTEST/20260920/us-east-1/cognito-idp/aws4_request'), true);
  eq(a.headers['x-amz-date'], '20260920T120000Z');
  eq(a.headers['x-amz-target'], 'AWSCognitoIdentityProviderService.SignUp');
  const signed = a.headers.Authorization!.split('SignedHeaders=')[1]!.split(',')[0]!.split(';');
  eq(signed, [...signed].sort());
  eq(signed.includes('x-amz-target'), true);
  // Every x-amz-* header on the wire must be covered by the signature.
  eq(signed.includes('x-amz-content-sha256'), true);
  // A session token must ride in the signature, not just the headers.
  const withTok = signCognitoRequest({
    cfg: CFG,
    creds: { ...CREDS, sessionToken: 'tok' },
    target: 'AWSCognitoIdentityProviderService.SignUp',
    body,
    now: FIXED_NOW,
  });
  eq(withTok.headers['x-amz-security-token'], 'tok');
  eq(withTok.headers.Authorization === a.headers.Authorization, false);
});

T('endpoint allowlist: https everywhere, http only for localhost', async () => {
  const remote = { ...CFG, endpoint: 'http://evil.example.com' };
  await rejects(
    () =>
      cognitoSignUp(
        remote,
        { email: 'a@b.co', password: 'Secret-123456' },
        {
          creds: CREDS,
          now: () => FIXED_NOW,
          fetchFn: stubFetch([], () => ({ status: 200, body: '{}' })),
        },
      ),
    'cognito:BAD_ENDPOINT',
  );
  const local = { ...CFG, endpoint: 'http://127.0.0.1:9999' };
  const r = await cognitoSignUp(
    local,
    { email: 'a@b.co', password: 'Secret-123456' },
    {
      creds: CREDS,
      now: () => FIXED_NOW,
      fetchFn: stubFetch([], () => ({ status: 200, body: '{"UserSub":"sub-1","UserConfirmed":true}' })),
    },
  );
  eq(r.sub, 'sub-1');
});

T('cognitoSignUp sends the pool contract and returns the sub', async () => {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetchFn = stubFetch(calls, () => ({ status: 200, body: '{"UserSub":"sub-42","UserConfirmed":true}' }));
  const r = await cognitoSignUp(
    CFG,
    { email: 'ada@example.com', password: 'Calcograph-1843-x', givenName: 'Ada', familyName: 'Lovelace' },
    { creds: CREDS, fetchFn, now: () => FIXED_NOW },
  );
  eq(r.sub, 'sub-42');
  eq(r.userConfirmed, true);
  const sent = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
  eq(sent.ClientId, 'client123');
  eq(sent.Username, 'ada@example.com');
  const attrs = sent.UserAttributes as Array<{ Name: string; Value: string }>;
  eq(
    attrs.some((a) => a.Name === 'email' && a.Value === 'ada@example.com'),
    true,
  );
  eq(
    attrs.some((a) => a.Name === 'given_name'),
    true,
  );
  // email_verified is admin-scope: the SignUp API refuses it on real pools.
  eq(
    attrs.some((a) => a.Name === 'email_verified'),
    false,
  );
  eq(calls[0]!.init.headers['x-amz-target'], 'AWSCognitoIdentityProviderService.SignUp');
});

T('pool errors map to named codes, never raw bodies', async () => {
  const mk = (status: number, type: string) =>
    stubFetch([], () => ({ status, body: JSON.stringify({ __type: type }) }));
  const opts = (f: CognitoFetchFn) => ({ creds: CREDS, fetchFn: f, now: () => FIXED_NOW });
  await rejects(
    () => cognitoSignUp(CFG, { email: 'a@b.co', password: 'Secret-123456' }, opts(mk(400, 'UsernameExistsException'))),
    'cognito:USER_EXISTS',
  );
  await rejects(
    () => cognitoSignUp(CFG, { email: 'a@b.co', password: 'x' }, opts(mk(400, 'InvalidPasswordException'))),
    'cognito:WEAK_PASSWORD',
  );
  await rejects(
    () => cognitoVerifyPassword(CFG, { email: 'a@b.co', password: 'x' }, opts(mk(400, 'UserNotFoundException'))),
    'cognito:USER_NOT_FOUND',
  );
  await rejects(
    () => cognitoVerifyPassword(CFG, { email: 'a@b.co', password: 'x' }, opts(mk(400, 'NotAuthorizedException'))),
    'cognito:BAD_CREDENTIALS',
  );
  await rejects(
    () => cognitoVerifyPassword(CFG, { email: 'a@b.co', password: 'x' }, opts(mk(429, 'TooManyRequestsException'))),
    'cognito:THROTTLED',
  );
  await rejects(
    () => cognitoVerifyPassword(CFG, { email: 'a@b.co', password: 'x' }, opts(mk(500, 'InternalErrorException'))),
    'cognito:IDP_DOWN',
  );
  // A transport failure is the provider being down, not a credential denial.
  await rejects(
    () =>
      cognitoVerifyPassword(
        CFG,
        { email: 'a@b.co', password: 'x' },
        {
          creds: CREDS,
          now: () => FIXED_NOW,
          fetchFn: async () => {
            throw new Error('socket hang up');
          },
        },
      ),
    'cognito:IDP_DOWN',
  );
});

T('a successful verify without tokens is refused, not half-trusted', async () => {
  const fetchFn = stubFetch([], () => ({ status: 200, body: '{"AuthenticationResult":{}}' }));
  await rejects(
    () =>
      cognitoVerifyPassword(CFG, { email: 'a@b.co', password: 'x' }, { creds: CREDS, fetchFn, now: () => FIXED_NOW }),
    'cognito:IDP_ERROR',
  );
});

T('credentials: static env wins; nothing configured refuses loudly', async () => {
  const c = await resolveCognitoCredentials({
    AWS_ACCESS_KEY_ID: 'AK',
    AWS_SECRET_ACCESS_KEY: 'SK',
    AWS_SESSION_TOKEN: 'T',
  });
  eq(c.accessKeyId, 'AK');
  eq(c.sessionToken, 'T');
  await rejects(() => resolveCognitoCredentials({}), 'cognito:NO_CREDENTIALS');
});

// ------------------------------------------------------- integration lane --

interface PoolAccount {
  email: string;
  password: string;
}

/** A tiny stand-in for the cognito-idp JSON endpoint (same wire shape). */
async function startMockPool(): Promise<{ server: Server; accounts: PoolAccount[]; port: number }> {
  const accounts: PoolAccount[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? '');
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const reply = (status: number, obj: unknown) => {
        res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify(obj));
      };
      if (target.endsWith('.SignUp')) {
        const email = String(body.Username);
        if (accounts.some((a) => a.email === email)) {
          return reply(400, { __type: 'UsernameExistsException', message: 'prelogin' });
        }
        accounts.push({ email, password: String(body.Password) });
        return reply(200, { UserConfirmed: true, UserSub: `sub-${email}` });
      }
      if (target.endsWith('.InitiateAuth')) {
        const p = body.AuthParameters as { USERNAME: string; PASSWORD: string };
        const acct = accounts.find((a) => a.email === p.USERNAME);
        if (!acct) return reply(400, { __type: 'UserNotFoundException', message: 'user' });
        if (acct.password !== p.PASSWORD) return reply(400, { __type: 'NotAuthorizedException', message: 'nope' });
        return reply(200, { AuthenticationResult: { AccessToken: 'at', IdToken: 'it' } });
      }
      return reply(400, { __type: 'InvalidParameterException' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, accounts, port };
}

T('production lane: signup lands in the pool, login verifies there, pool-less accounts fall back locally', async () => {
  const mock = await startMockPool();
  const saved = { ...process.env };
  process.env.VITAL_COGNITO_USER_POOL_ID = 'us-east-1_MOCK';
  process.env.VITAL_COGNITO_CLIENT_ID = 'mockclient';
  process.env.VITAL_COGNITO_ENDPOINT = `http://127.0.0.1:${mock.port}`;
  process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret-test-123';
  const { db, ledger, coord, comp } = await fresh();
  let server;
  try {
    server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}`;

    // 1. public sign-up → pool SignUp + local mirror + credits.
    const offer = (await (await fetch(`${url}/api/signup`)).json()) as { csrf: string };
    const res1 = await fetch(`${url}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer.csrf, cookie: `vital_csrf=${offer.csrf}` },
      body: JSON.stringify({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'Calcograph-1843-x',
      }),
    });
    const j1 = (await res1.json()) as { ok: boolean; credits: number };
    eq(j1.ok, true);
    eq(j1.credits, 100);
    eq(
      mock.accounts.some((a) => a.email === 'ada@example.com'),
      true,
    );
    // The durable grant, not just the API echo: meta row + audit event.
    const creditRows = (await db.prepare("SELECT value FROM meta WHERE key LIKE 'credits:acme:%'").all()) as Array<{
      value: string;
    }>;
    eq(creditRows.length, 1);
    eq(JSON.parse(creditRows[0]!.value).balance, 100);
    const grantEvents = (await db
      .prepare("SELECT action FROM audit_log WHERE action = 'credits.granted'")
      .all()) as Array<{ action: string }>;
    eq(grantEvents.length >= 1, true);

    // 2. login verifies against the pool (fresh tenant → ada is also the local owner).
    const offer2 = (await (await fetch(`${url}/api/signup`)).json()) as { csrf: string };
    const res2 = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer2.csrf, cookie: `vital_csrf=${offer2.csrf}` },
      redirect: 'manual',
      body: JSON.stringify({ email: 'ada@example.com', password: 'Calcograph-1843-x' }),
    });
    eq(res2.status, 303);

    // 3. wrong password is a pool denial, not a local one.
    const res3 = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer2.csrf, cookie: `vital_csrf=${offer2.csrf}` },
      redirect: 'manual',
      body: JSON.stringify({ email: 'ada@example.com', password: 'Wrong-Password-123' }),
    });
    eq(res3.status, 401);

    // 4. a local-only account (operator invite, never in the pool) still signs
    //    in: the pool answers UserNotFound and the console falls back locally.
    await inviteUser(
      db,
      TEN,
      { email: 'local@acme.test', name: 'Local Only', role: 'member', password: 'Local-Only-Password-1' },
      { userId: 'seed', role: 'owner' },
      new Date().toISOString(),
    );
    const res4 = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer2.csrf, cookie: `vital_csrf=${offer2.csrf}` },
      redirect: 'manual',
      body: JSON.stringify({ email: 'local@acme.test', password: 'Local-Only-Password-1' }),
    });
    eq(res4.status, 303);
  } finally {
    await server?.close();
    mock.server.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await db.close();
  }
});

T('pool outage is reported honestly and never fakes an account', async () => {
  const saved = { ...process.env };
  process.env.VITAL_COGNITO_USER_POOL_ID = 'us-east-1_DOWN';
  process.env.VITAL_COGNITO_CLIENT_ID = 'mockclient';
  process.env.VITAL_COGNITO_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens
  process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret-test-123';
  const { db, ledger, coord, comp } = await fresh();
  let server;
  try {
    server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}`;
    const offer = (await (await fetch(`${url}/api/signup`)).json()) as { csrf: string };
    const res = await fetch(`${url}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer.csrf, cookie: `vital_csrf=${offer.csrf}` },
      body: JSON.stringify({
        firstName: 'No',
        lastName: 'Body',
        email: 'nobody@example.com',
        password: 'Secret-Password-12',
      }),
    });
    eq(res.status, 503);
    const j = (await res.json()) as { ok: boolean; error: string };
    eq(j.ok, false);
    eq(j.error.includes('unreachable'), true);
    // "Never fakes an account" means the DB agrees: no local mirror exists,
    // so signing in with the same credentials must never mint a session.
    const offer2 = (await (await fetch(`${url}/api/signup`)).json()) as { csrf: string };
    const loginRes = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': offer2.csrf, cookie: `vital_csrf=${offer2.csrf}` },
      redirect: 'manual',
      body: JSON.stringify({ email: 'nobody@example.com', password: 'Secret-Password-12' }),
    });
    const setCookie = loginRes.headers.get('set-cookie') || '';
    eq(setCookie.includes('vital_session='), false);
    // An unclaimed tenant answers 303 to the claim page — that is not a
    // session; anything else must be an explicit denial.
    if (loginRes.status === 303) eq((loginRes.headers.get('location') || '').endsWith('/signup'), true);
    else eq(loginRes.status === 401 || loginRes.status === 503, true);
  } finally {
    await server?.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await db.close();
  }
});
