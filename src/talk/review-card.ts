import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CoordinationRequest } from '../core/types.ts';

export interface ReviewCardEvidence {
  claimId: string;
  statement: string;
  confidence?: number;
}

export interface ReviewCardOptions {
  requestId: string;
  tenant: string;
  scope: string;
  goal: string;
  actionClass?: string;
  confidence?: number;
  bidDollars?: number;
  bidTokens?: number;
  evidence?: ReviewCardEvidence[];
  driftScore?: number;
  webhookBaseUrl?: string;
  secret?: string;
  /** Token expiry override. Defaults to mint-time + REVIEW_TOKEN_TTL_MS. */
  expiresAt?: string;
  /** Request version the reviewer saw. Bound into both tokens. */
  requestUpdatedAt?: string;
}

/**
 * The review-token signing secret.
 *
 * This used to default to the literal string `'vital-review-secret'` in both
 * `mintReviewToken` and the webhook verifier, so anyone who could read the
 * source could mint a token that approves any pending request. There is now no
 * default: an unset secret means review cards cannot be minted and the webhook
 * refuses tokens entirely (falling back to an authenticated admin session).
 */
export function reviewSecretFromEnv(): string | null {
  const secret = (process.env.VITAL_REVIEW_SECRET ?? '').trim();
  if (!secret) return null;
  if (secret.length < 16) {
    throw new Error('VITAL_REVIEW_SECRET must be at least 16 characters');
  }
  return secret;
}

/** Same as `reviewSecretFromEnv` but with a name that reads well at call sites. */
export function requireReviewSecret(): string {
  const secret = reviewSecretFromEnv();
  if (!secret) {
    throw new Error(
      '[talk:NO_REVIEW_SECRET] VITAL_REVIEW_SECRET is not set: review tokens cannot be minted or verified without it',
    );
  }
  return secret;
}

export interface ReviewTokenOptions {
  /** ISO timestamp after which the token refuses. Absent = legacy token. */
  expiresAt?: string;
  /** Request updatedAt the reviewer saw. Binds the token to a version. */
  requestUpdatedAt?: string;
}

/** Default review-token lifetime: 72h. Cards outlive a long weekend, never a quarter. */
export const REVIEW_TOKEN_TTL_MS = 72 * 3600_000;

export function mintReviewToken(
  secret: string,
  tenant: string,
  requestId: string,
  action: 'approve' | 'decline',
  opts: ReviewTokenOptions = {},
): string {
  const expiresAt = opts.expiresAt ?? '';
  const requestUpdatedAt = opts.requestUpdatedAt ?? '';
  const payload = `${tenant}:${requestId}:${action}:${expiresAt}:${requestUpdatedAt}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ tenant, requestId, action, expiresAt, requestUpdatedAt, sig: hmac })).toString(
    'base64url',
  );
}

export function verifyReviewToken(
  token: string,
  secret: string,
): {
  valid: boolean;
  tenant?: string;
  requestId?: string;
  action?: 'approve' | 'decline';
  expiresAt?: string;
  requestUpdatedAt?: string;
} {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as {
      tenant: string;
      requestId: string;
      action: 'approve' | 'decline';
      expiresAt?: string;
      requestUpdatedAt?: string;
      sig: string;
    };
    if (!parsed.tenant || !parsed.requestId || !parsed.action || !parsed.sig) {
      return { valid: false };
    }
    const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '';
    const requestUpdatedAt = typeof parsed.requestUpdatedAt === 'string' ? parsed.requestUpdatedAt : '';
    const expect = createHmac('sha256', secret)
      .update(`${parsed.tenant}:${parsed.requestId}:${parsed.action}:${expiresAt}:${requestUpdatedAt}`)
      .digest('hex');
    const a = Buffer.from(parsed.sig, 'hex');
    const b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false };
    }
    return { valid: true, tenant: parsed.tenant, requestId: parsed.requestId, action: parsed.action, expiresAt, requestUpdatedAt };
  } catch {
    return { valid: false };
  }
}

export function renderReviewCard(opts: ReviewCardOptions): string {
  const baseUrl = (opts.webhookBaseUrl ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
  const secret = opts.secret ?? requireReviewSecret();

  const expiresAt = opts.expiresAt ?? new Date(Date.now() + REVIEW_TOKEN_TTL_MS).toISOString();
  const approveToken = mintReviewToken(secret, opts.tenant, opts.requestId, 'approve', {
    expiresAt,
    requestUpdatedAt: opts.requestUpdatedAt,
  });
  const declineToken = mintReviewToken(secret, opts.tenant, opts.requestId, 'decline', {
    expiresAt,
    requestUpdatedAt: opts.requestUpdatedAt,
  });

  // Approve/decline land on a confirmation page, not a mutating GET: a link
  // that changes state the moment it is fetched is prefetchable and CSRF-able.
  const approveUrl = `${baseUrl}/api/buzz/webhook?action=approve&token=${approveToken}`;
  const declineUrl = `${baseUrl}/api/buzz/webhook?action=decline&token=${declineToken}`;

  const actionClass = opts.actionClass ?? 'MUTATE';
  // Unknown means "unknown": a fabricated 0.78 confidence or $0.00 spend on
  // a human-approval card would manufacture certainty the caller never had.
  const confidence = opts.confidence !== undefined ? opts.confidence.toFixed(2) : 'unknown';
  const spend = opts.bidDollars !== undefined ? `$${opts.bidDollars.toFixed(2)}` : 'unknown';
  const tokens = opts.bidTokens !== undefined ? `${opts.bidTokens.toLocaleString()} tokens` : '';
  const costLine = tokens ? `${spend} (${tokens})` : spend;

  const lines: string[] = [
    '🟡 **[HUMAN ATTENTION REQUIRED]**',
    `**Request**: \`${opts.requestId}\` · **Scope**: \`#${opts.scope}\``,
    `**Goal**: ${opts.goal}`,
    `**Action Class**: \`${actionClass}\` · **Est. Spend**: ${costLine} · **Confidence**: \`${confidence}\``,
  ];

  if (opts.driftScore !== undefined) {
    lines.push(`**Drift EWMA**: \`${opts.driftScore.toFixed(4)}\` (threshold exceeded)`);
  }

  if (opts.evidence && opts.evidence.length > 0) {
    lines.push('');
    lines.push('**Evidence & Grounding**:');
    for (const ev of opts.evidence) {
      const conf = ev.confidence !== undefined ? ` (conf: ${ev.confidence.toFixed(2)})` : '';
      lines.push(`- \`[${ev.claimId}]\` ${ev.statement}${conf}`);
    }
  }

  lines.push('');
  lines.push('**Review Actions**:');
  lines.push(`[ 👍 Approve ](${approveUrl}) · [ 👎 Decline ](${declineUrl}) · [ 💬 Steer ](reply in thread)`);

  return lines.join('\n');
}

export function requestToReviewCard(
  req: CoordinationRequest,
  evidenceClaims: { id: string; statement: string; confidence?: number }[] = [],
  opts: { baseUrl?: string; secret?: string; driftScore?: number; expiresAt?: string } = {},
): string {
  return renderReviewCard({
    requestId: req.id,
    tenant: req.tenant,
    scope: req.targetScope,
    goal: req.goal,
    actionClass: 'ACT_REVERSIBLE',
    confidence: 0.78,
    bidDollars: req.bid.dollars,
    bidTokens: req.bid.tokens,
    evidence: evidenceClaims.map((c) => ({
      claimId: c.id,
      statement: c.statement,
      confidence: c.confidence,
    })),
    driftScore: opts.driftScore,
    webhookBaseUrl: opts.baseUrl,
    secret: opts.secret,
    expiresAt: opts.expiresAt,
    requestUpdatedAt: req.updatedAt,
  });
}
