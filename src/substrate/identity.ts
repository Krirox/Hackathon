import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Substrate, part 5 (TODO §0.5): identity — who is this agent acting as,
 * with what grants, and how is that audited.
 *
 * A scope token binds (scope, grants, expiry) under HMAC with the Vital
 * core secret. Harnesses present it; adapters verify it before executing.
 * No ambient credentials cross the boundary: the token IS the credential,
 * scoped and expiring, and every verification is auditable by the caller.
 */

export class IdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[identity:${code}] ${message}`);
  }
}

export interface ScopeGrant {
  scope: string;
  grants: string[];
  issuedAt: string;
  expiresAt: string;
  /**
   * Request this token is bound to. Execution adapters must refuse tokens
   * whose audience is missing or names a different request — otherwise a
   * token minted for one run replays against any other run in the scope.
   */
  audience?: string;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export function mintScopeToken(secret: string, grant: ScopeGrant): string {
  if (!secret) throw new IdentityError('NO_SECRET', 'cannot mint without a core secret');
  if (!grant.scope) throw new IdentityError('NO_SCOPE', 'a token without a scope is ambient authority');
  const body = b64(JSON.stringify(grant));
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

export function verifyScopeToken(secret: string, token: string, now: string): ScopeGrant {
  const parts = token.split('.');
  // Exactly two segments: destructuring alone would silently ignore a
  // trailing `.anything` appended to a valid token.
  if (parts.length !== 2) throw new IdentityError('MALFORMED_TOKEN', 'token is not body.signature');
  const [body, sig] = parts as [string, string];
  if (!body || !sig) throw new IdentityError('MALFORMED_TOKEN', 'token is not body.signature');
  const expect = createHmac('sha256', secret).update(body).digest('hex');
  // Strict hex check first: Buffer.from(x, 'hex') silently drops invalid
  // trailing characters, which would accept appended garbage as valid.
  if (!/^[0-9a-f]{64}$/.test(sig) || sig.length !== expect.length) {
    throw new IdentityError('BAD_SIGNATURE', 'scope token signature fails');
  }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (!timingSafeEqual(a, b)) {
    throw new IdentityError('BAD_SIGNATURE', 'scope token signature fails');
  }
  let grant: ScopeGrant;
  try {
    grant = JSON.parse(unb64(body)) as ScopeGrant;
  } catch {
    throw new IdentityError('MALFORMED_TOKEN', 'scope token body is not JSON');
  }
  if (!grant.scope || !Array.isArray(grant.grants))
    throw new IdentityError('MALFORMED_TOKEN', 'scope token carries no scope/grants');
  if (grant.grants.length === 0)
    throw new IdentityError(
      'MALFORMED_TOKEN',
      'scope token carries no grants — a token that authorizes nothing verifies to nothing',
    );
  if (now > grant.expiresAt)
    throw new IdentityError('EXPIRED_TOKEN', `scope "${grant.scope}" token lapsed at ${grant.expiresAt}`);
  return grant;
}

/**
 * Bind a verified grant to the request being executed. Scope equality alone
 * leaves cross-request replay open inside the scope; the audience closes it.
 */
export function assertTokenAudience(grant: ScopeGrant, requestId: string): void {
  if (!grant.audience) {
    throw new IdentityError('NO_AUDIENCE', 'scope token names no request — mint with audience set to the request id');
  }
  if (grant.audience !== requestId) {
    throw new IdentityError(
      'AUDIENCE_MISMATCH',
      `scope token audience "${grant.audience}" does not match request "${requestId}"`,
    );
  }
}
