import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.ts';

/**
 * Talk-layer spike (TODO §0.4): prove the Ledger survives swapping Buzz.
 *
 * The Ledger never stores chat. It stores one opaque string per claim
 * (`buzzEventSig`) plus THIS interface: bind a claim to a signed envelope on
 * the way out, verify the envelope on the way back. Any surface that
 * implements these two functions — Buzz/Nostr today, Slack/HMAC tomorrow —
 * plugs in with zero ledger changes. That is the whole fallback story.
 *
 * Buzz mapping (verified against `.upstream/buzz`, not assumed): Buzz signs
 * with Nostr (`git-sign-nostr` crate). A Vital binding rides as a `kind: 1`
 * note carrying a `["vital-claim", claimId, seq, statementHash]` tag; the
 * Nostr `id` (sha256 of the serialized event) is what lands in
 * `buzzEventSig`, and signature verification stays with the relay/Buzz SDK —
 * it was never ours to reimplement. The HMAC surface below is the §1.4
 * fallback for when Buzz is absent; it must not weaken the audit story, so
 * tampering fails loudly rather than degrading silently.
 */

export class TalkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[talk:${code}] ${message}`);
  }
}

export interface ClaimBinding {
  claimId: string;
  seq: number;
  statementHash: string;
  scope: string;
  tenant: string;
  boundAt: string;
}

export interface SignedEnvelope {
  surface: string;
  binding: ClaimBinding;
  attestation: string;
}

export interface TalkSurface {
  readonly name: string;
  bindClaim(binding: ClaimBinding): SignedEnvelope;
  /** Returns the binding if and only if the attestation checks out. */
  verifyEnvelope(env: SignedEnvelope): ClaimBinding;
}

export function statementHashOf(statement: string): string {
  return createHash('sha256').update(statement, 'utf8').digest('hex');
}

function canonical(b: ClaimBinding): string {
  return JSON.stringify([b.claimId, b.seq, b.statementHash, b.scope, b.tenant, b.boundAt]);
}

/**
 * The §1.4 fallback: HMAC over the canonical binding with a per-tenant
 * secret. No public-key story, no relay — but tamper-evident, which is the
 * property the audit trail actually depends on.
 */
export function createHmacSurface(secret: string, name = 'slack-hmac'): TalkSurface {
  if (!secret) throw new TalkError('NO_SECRET', 'an HMAC surface without a secret attests nothing');
  return {
    name,
    bindClaim(binding: ClaimBinding): SignedEnvelope {
      const attestation = createHmac('sha256', secret).update(canonical(binding)).digest('hex');
      return { surface: name, binding, attestation };
    },
    verifyEnvelope(env: SignedEnvelope): ClaimBinding {
      if (env.surface !== name) {
        throw new TalkError('WRONG_SURFACE', `envelope is for "${env.surface}", this surface is "${name}"`);
      }
      const expect = createHmac('sha256', secret).update(canonical(env.binding)).digest('hex');
      // Strict hex check first: Buffer.from(x, 'hex') silently drops invalid
      // trailing characters, which would accept appended garbage as valid.
      if (!/^[0-9a-f]{64}$/.test(env.attestation)) {
        throw new TalkError('TAMPERED_ENVELOPE', `binding for claim ${env.binding.claimId} fails attestation`);
      }
      const a = Buffer.from(env.attestation, 'hex');
      const b = Buffer.from(expect, 'hex');
      if (!timingSafeEqual(a, b)) {
        throw new TalkError('TAMPERED_ENVELOPE', `binding for claim ${env.binding.claimId} fails attestation`);
      }
      return env.binding;
    },
  };
}

/**
 * Third-party reconstructability (§1.4 gate): a claim carrying an envelope
 * (the publication receipt) names the bound claim inside the envelope.
 * Verification checks the attestation AND that the named claim still exists
 * at the bound seq with the bound statement hash. A hostile surface cannot
 * rebind a valid attestation to different content.
 *
 * What this pins is *content identity* (id/seq/statement). Liveness
 * (SUPERSEDED? DISPUTED?) comes from `replayDecision`, not from the
 * signature — signatures attest what was said, not what is still true.
 */
export interface VerifiedBinding {
  receiptId: string;
  boundId: string;
  binding: ClaimBinding;
}

export async function verifyClaimEnvelope(
  surface: TalkSurface,
  ledger: Ledger,
  tenant: string,
  receiptId: string,
): Promise<VerifiedBinding> {
  const receipt = await ledger.get(tenant, receiptId);
  if (!receipt) throw new TalkError('MISSING_CLAIM', `unknown claim ${receiptId}`);
  if (!receipt.buzzEventSig) throw new TalkError('UNBOUND_CLAIM', `claim ${receiptId} carries no talk binding`);
  let env: SignedEnvelope;
  try {
    env = JSON.parse(receipt.buzzEventSig) as SignedEnvelope;
  } catch {
    throw new TalkError('MALFORMED_ENVELOPE', `claim ${receiptId} binding is not parseable`);
  }
  const binding = surface.verifyEnvelope(env);
  const bound = await ledger.get(tenant, binding.claimId);
  if (!bound) throw new TalkError('BOUND_CLAIM_GONE', `envelope names unknown claim ${binding.claimId}`);
  if (bound.seq !== binding.seq) {
    throw new TalkError(
      'REBOUND_ENVELOPE',
      `envelope binds ${binding.claimId}#${binding.seq} but live is #${bound.seq}`,
    );
  }
  if (binding.statementHash !== statementHashOf(bound.statement)) {
    throw new TalkError('REBOUND_ENVELOPE', `envelope statement hash does not match live claim ${bound.id}`);
  }
  return { receiptId, boundId: bound.id, binding };
}
