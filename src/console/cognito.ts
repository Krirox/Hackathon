import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * AWS Cognito identity backend for production deployments (no AWS SDK).
 *
 * Why this exists: when the console runs in production it should not be the
 * vault — Cognito User Pools own credentials, password policy, and brute-force
 * protection there, while the console keeps its own session cookie, tenant
 * binding, and user rows (a local mirror, JIT-created at first sign-in) so
 * every authorization seam downstream stays exactly as it is.
 *
 * Why no AWS SDK: repo policy keeps production dependencies to pg+zod, so
 * SigV4 is implemented here with node:crypto only — the same shape as
 * ledger/s3store.ts (HMAC chain kDate/kRegion/kService/kSigning over the
 * canonical request, service "cognito-idp").
 *
 * Activation: entirely env-gated. cognitoFromEnv() returns null unless
 * VITAL_COGNITO_USER_POOL_ID and VITAL_COGNITO_CLIENT_ID are both set, so
 * local dev, the test suite, and every self-hosted deployment keep the
 * self-contained flow untouched.
 *
 * Credentials: explicit AWS_ACCESS_KEY_ID/SECRET (+ AWS_SESSION_TOKEN) win;
 * otherwise the ECS task-role endpoint (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
 * / _FULL_URI) is read and cached until expiry — that is what Fargate hands
 * out, and the S3 snapshot path deliberately cannot use it (see the note in
 * deploy/aws/main.tf), so this is the first consumer of task-role creds.
 *
 * Trust boundaries: the pool endpoint is https-only (same downgrade argument as
 * s3store). Passwords are never logged and never appear in error messages;
 * Cognito error bodies carry codes, not secrets.
 */

/** Namespaced refusal, following the repo's `[module:CODE]` convention. */
export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[cognito:${code}] ${message}`);
  }
}

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
  /** Override for LocalStack-style testing. https required unless local. */
  endpoint?: string;
}

export interface CognitoCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Injectable transport (tests stub the network; CI spends nothing). */
export type CognitoFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  body: string;
}>;

export const nodeCognitoFetch: CognitoFetchFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, body: await res.text() };
};

/** Env resolution; null when Cognito is not configured (self-hosted mode). */
export function cognitoFromEnv(env: NodeJS.ProcessEnv = process.env): CognitoConfig | null {
  const userPoolId = env.VITAL_COGNITO_USER_POOL_ID?.trim();
  const clientId = env.VITAL_COGNITO_CLIENT_ID?.trim();
  if (!userPoolId || !clientId) return null;
  const region = (env.VITAL_COGNITO_REGION ?? env.AWS_REGION ?? 'us-east-1').trim();
  const cfg: CognitoConfig = { userPoolId, clientId, region };
  if (env.VITAL_COGNITO_ENDPOINT?.trim()) cfg.endpoint = env.VITAL_COGNITO_ENDPOINT.trim();
  return cfg;
}

function resolveBase(cfg: CognitoConfig): string {
  if (!cfg.endpoint) return `https://cognito-idp.${cfg.region}.amazonaws.com`;
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new CognitoError('BAD_ENDPOINT', 'VITAL_COGNITO_ENDPOINT is not a parseable URL');
  }
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !local)
    throw new CognitoError('BAD_ENDPOINT', 'Cognito endpoint must be https:// (http allowed only for localhost)');
  return url.origin;
}

// ------------------------------------------------------------ credentials --

interface CachedCreds {
  creds: CognitoCredentials;
  /** epoch ms after which the cached record must be refetched */
  refreshAfterMs: number;
}
let containerCredCache: CachedCreds | null = null;

async function fetchContainerCredentials(env: NodeJS.ProcessEnv): Promise<CognitoCredentials> {
  const rel = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const url = full ?? (rel ? `http://169.254.170.2${rel}` : undefined);
  if (!url) throw new CognitoError('NO_CREDENTIALS', 'no AWS credentials in env and no ECS container credential URI');
  if (containerCredCache && containerCredCache.refreshAfterMs > Date.now()) return containerCredCache.creds;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw new CognitoError('CREDENTIALS_UNREACHABLE', `container credential endpoint failed: ${(e as Error).message}`);
  }
  if (!res.ok)
    throw new CognitoError('CREDENTIALS_UNREACHABLE', `container credential endpoint answered ${res.status}`);
  const j = (await res.json()) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
    Expiration?: string;
  };
  if (!j.AccessKeyId || !j.SecretAccessKey)
    throw new CognitoError('NO_CREDENTIALS', 'container credential response lacked an access key pair');
  const creds: CognitoCredentials = {
    accessKeyId: j.AccessKeyId,
    secretAccessKey: j.SecretAccessKey,
    ...(j.Token ? { sessionToken: j.Token } : {}),
  };
  // Refresh well before the real expiry; the 15-minute granularity of task
  // role rotations makes a fixed 60s safety margin plenty.
  const expMs = j.Expiration ? Date.parse(j.Expiration) : Date.now() + 15 * 60_000;
  containerCredCache = { creds, refreshAfterMs: Math.max(Date.now() + 5_000, expMs - 60_000) };
  return creds;
}

export async function resolveCognitoCredentials(env: NodeJS.ProcessEnv = process.env): Promise<CognitoCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
  return fetchContainerCredentials(env);
}

// ---------------------------------------------------------------- signing --

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const dateStamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  return {
    amzDate: `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`,
    dateStamp,
  };
}

/** SigV4-sign one cognito-idp JSON call (host, x-amz-date, x-amz-target, body). */
export function signCognitoRequest(opts: {
  cfg: CognitoConfig;
  creds: CognitoCredentials;
  target: string;
  body: string;
  now: Date;
}): { url: string; headers: Record<string, string> } {
  const { cfg, creds, target, body } = opts;
  const base = resolveBase(cfg);
  const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const { amzDate, dateStamp } = amzDates(opts.now);
  const host = new URL(base).host;
  const canonicalHeaders: Array<[string, string]> = [
    ['content-type', 'application/x-amz-json-1.1'],
    ['host', host],
    ['x-amz-date', amzDate],
    ['x-amz-target', target],
  ];
  if (creds.sessionToken) canonicalHeaders.push(['x-amz-security-token', creds.sessionToken]);
  canonicalHeaders.sort((a, b) => {
    if (a[0] === b[0]) return 0;
    return a[0] < b[0] ? -1 : 1;
  });
  const signedHeaders = canonicalHeaders.map(([k]) => k).join(';');
  const canonicalHeadersStr = canonicalHeaders.map(([k, v]) => `${k}:${v.trim()}\n`).join('');
  const canonicalRequest = `POST\n/\n\n${canonicalHeadersStr}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${cfg.region}/cognito-idp/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const kDate = createHmac('sha256', `AWS4${creds.secretAccessKey}`).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(cfg.region, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update('cognito-idp', 'utf8').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-date': amzDate,
    'x-amz-target': target,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  return { url: `${base}/`, headers };
}

// ------------------------------------------------------------- API calls --

/** AWS speaks error codes in two places depending on the gateway; check both. */
function errorTypeOf(status: number, body: string): string {
  let type = '';
  try {
    const j = JSON.parse(body) as { __type?: string; code?: string };
    type = j.__type ?? j.code ?? '';
  } catch {
    /* non-JSON body: fall through to the status mapping below */
  }
  return type.split('#').pop() ?? '';
}

function mapError(status: number, body: string, op: string): CognitoError {
  const type = errorTypeOf(status, body);
  // Bodies can carry user-supplied context; codes are the safe surface.
  const msg = `cognito ${op} failed (${status}${type ? ` ${type}` : ''})`;
  switch (type) {
    case 'UsernameExistsException':
      return new CognitoError('USER_EXISTS', 'an account with this email already exists in the user pool');
    case 'UserNotFoundException':
      return new CognitoError('USER_NOT_FOUND', 'no such account in the user pool');
    case 'InvalidPasswordException':
      return new CognitoError('WEAK_PASSWORD', 'the user pool rejected this password (check its policy)');
    case 'InvalidParameterException':
      return new CognitoError('BAD_REQUEST', 'the user pool rejected the request parameters');
    case 'NotAuthorizedException':
      return new CognitoError('BAD_CREDENTIALS', 'invalid credentials');
    case 'UserNotConfirmedException':
      return new CognitoError('UNCONFIRMED', 'the account still needs email confirmation');
    case 'PasswordResetRequiredException':
      return new CognitoError('RESET_REQUIRED', 'the pool requires a password reset before sign-in');
    case 'TooManyFailedAttemptsException':
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return new CognitoError('THROTTLED', 'the user pool is rate-limiting this action; try again later');
    default:
      if (status === 429)
        return new CognitoError('THROTTLED', 'the user pool is rate-limiting this action; try again later');
      if (status >= 500) return new CognitoError('IDP_DOWN', 'the identity provider is unreachable right now');
      return new CognitoError('IDP_ERROR', msg);
  }
}

async function call(
  cfg: CognitoConfig,
  creds: CognitoCredentials,
  target: string,
  payload: Record<string, unknown>,
  fetchFn: CognitoFetchFn,
  now: () => Date,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const { url, headers } = signCognitoRequest({ cfg, creds, target, body, now: now() });
  let res: { status: number; body: string };
  try {
    res = await fetchFn(url, { method: 'POST', headers, body });
  } catch (e) {
    throw new CognitoError('IDP_DOWN', `the identity provider is unreachable right now (${(e as Error).message})`);
  }
  if (res.status < 200 || res.status >= 300) throw mapError(res.status, res.body, target.split('.').pop() ?? target);
  if (!res.body) return {};
  try {
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new CognitoError('IDP_ERROR', `cognito ${target} returned a non-JSON body`);
  }
}

export interface SignUpResult {
  sub: string;
  userConfirmed: boolean;
}

/** Register the account in the pool. The pool (not this server) owns the password from here on. */
export async function cognitoSignUp(
  cfg: CognitoConfig,
  input: { email: string; password: string; givenName?: string; familyName?: string },
  opts: { fetchFn?: CognitoFetchFn; creds?: CognitoCredentials; env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<SignUpResult> {
  const creds = opts.creds ?? (await resolveCognitoCredentials(opts.env));
  // email_verified is an admin-scope attribute: the SignUp API refuses it, so
  // confirmation comes from the pool's "sign-in without verifying email"
  // setting (Terraform: auto_verified_attribute_names = ["email"]).
  const userAttributes = [{ Name: 'email', Value: input.email }];
  if (input.givenName) userAttributes.push({ Name: 'given_name', Value: input.givenName });
  if (input.familyName) userAttributes.push({ Name: 'family_name', Value: input.familyName });
  const j = await call(
    cfg,
    creds,
    'CognitoIdentityProvider.SignUp',
    { ClientId: cfg.clientId, Username: input.email, Password: input.password, UserAttributes: userAttributes },
    opts.fetchFn ?? nodeCognitoFetch,
    opts.now ?? (() => new Date()),
  );
  const sub = (j.UserSub as string) ?? '';
  return { sub, userConfirmed: Boolean(j.UserConfirmed) };
}

export interface VerifyResult {
  accessToken: string;
  idToken: string;
}

/**
 * USER_PASSWORD_AUTH verification. Throws CognitoError('USER_NOT_FOUND') when
 * the account lives only in the local DB (bootstrap owner, invitees) so the
 * caller can fall back to local verification; everything else is a denial.
 */
export async function cognitoVerifyPassword(
  cfg: CognitoConfig,
  input: { email: string; password: string },
  opts: { fetchFn?: CognitoFetchFn; creds?: CognitoCredentials; env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<VerifyResult> {
  const creds = opts.creds ?? (await resolveCognitoCredentials(opts.env));
  const j = await call(
    cfg,
    creds,
    'CognitoIdentityProvider.InitiateAuth',
    {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cfg.clientId,
      AuthParameters: { USERNAME: input.email, PASSWORD: input.password },
    },
    opts.fetchFn ?? nodeCognitoFetch,
    opts.now ?? (() => new Date()),
  );
  const ch = (j.AuthenticationResult ?? {}) as { AccessToken?: string; IdToken?: string };
  if (!ch.AccessToken || !ch.IdToken)
    throw new CognitoError('IDP_ERROR', 'cognito returned no tokens for a successful authentication');
  return { accessToken: ch.AccessToken, idToken: ch.IdToken };
}

/** Timing-safe comparison for caller-side token checks (not used by the flows above). */
export function constantEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
