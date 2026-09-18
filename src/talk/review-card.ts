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
      '[talk:NO_REVIEW_SECRET] VITAL_REVIEW_SECRET is not set — review tokens cannot be minted or verified without it',
    );
  }
  return secret;
}

export function mintReviewToken(
  secret: string,
  tenant: string,
  requestId: string,
  action: 'approve' | 'decline',
): string {
  const payload = `${tenant}:${requestId}:${action}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ tenant, requestId, action, sig: hmac })).toString('base64url');
}

export function verifyReviewToken(
  token: string,
  secret: string,
): { valid: boolean; tenant?: string; requestId?: string; action?: 'approve' | 'decline' } {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { tenant: string; requestId: string; action: 'approve' | 'decline'; sig: string };
    if (!parsed.tenant || !parsed.requestId || !parsed.action || !parsed.sig) {
      return { valid: false };
    }
    const expect = createHmac('sha256', secret)
      .update(`${parsed.tenant}:${parsed.requestId}:${parsed.action}`)
      .digest('hex');
    const a = Buffer.from(parsed.sig, 'hex');
    const b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false };
    }
    return { valid: true, tenant: parsed.tenant, requestId: parsed.requestId, action: parsed.action };
  } catch {
    return { valid: false };
  }
}

export function renderReviewCard(opts: ReviewCardOptions): string {
  const baseUrl = (opts.webhookBaseUrl ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
  const secret = opts.secret ?? requireReviewSecret();

  const approveToken = mintReviewToken(secret, opts.tenant, opts.requestId, 'approve');
  const declineToken = mintReviewToken(secret, opts.tenant, opts.requestId, 'decline');

  // Approve/decline land on a confirmation page, not a mutating GET: a link
  // that changes state the moment it is fetched is prefetchable and CSRF-able.
  const approveUrl = `${baseUrl}/api/buzz/webhook?action=approve&token=${approveToken}`;
  const declineUrl = `${baseUrl}/api/buzz/webhook?action=decline&token=${declineToken}`;

  const actionClass = opts.actionClass ?? 'MUTATE';
  const confidence = opts.confidence !== undefined ? opts.confidence.toFixed(2) : '0.78';
  const spend = opts.bidDollars !== undefined ? `$${opts.bidDollars.toFixed(2)}` : '$0.00';
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
  opts: { baseUrl?: string; secret?: string; driftScore?: number } = {},
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
  });
}
