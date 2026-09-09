import type { SourceTier } from '../core/types.ts';

/**
 * World Sense, part 2 (TODO §6.3): the Integrity Gate.
 *
 * This is the sibling of QM's content screen, covering a different trust
 * problem. QM asks "is this content trying to hijack the agent?" We ask "is
 * this content trying to hijack the company's strategy?" A competitor can
 * publish a fake pricing page, seed a plausible repo, or farm mentions to
 * steer a roadmap — the gate that stops that sits here.
 *
 * Rules: ≥2 independent provenance paths before strategic escalation
 * (else CANDIDATE); self-serving sources get a prior discount; mention
 * spikes (young accounts, co-timed clusters) stay CANDIDATE; external text
 * is quoted data — never a system role, never a tool selector.
 */

export type IntegrityVerdict = 'ESCALATE' | 'CANDIDATE';

export interface WorldSignal {
  uri: string;
  sourceTier: SourceTier;
  /** Independent provenance paths corroborating this signal. */
  corroborationPaths: string[];
  mention?: {
    /** Mean account age in days across mentioning accounts. */
    meanAccountAgeDays: number;
    /** Accounts posting within the same short window. */
    clusterSize: number;
  };
}

export interface IntegrityResult {
  verdict: IntegrityVerdict;
  reasons: string[];
  /** Applied even on ESCALATE: downstream weighs discounted signals less. */
  selfServingDiscount: boolean;
}

const SELF_SERVING: readonly SourceTier[] = ['SELF_SERVED', 'SINGLE_SOURCE'];

export function integrityScreen(signal: WorldSignal): IntegrityResult {
  const reasons: string[] = [];
  const selfServingDiscount = SELF_SERVING.includes(signal.sourceTier);
  if (selfServingDiscount) {
    reasons.push(`self-serving prior discount: tier ${signal.sourceTier} weighs less`);
  }
  const independent = new Set(signal.corroborationPaths).size;
  if (independent < 2) {
    return {
      verdict: 'CANDIDATE',
      reasons: [...reasons, `only ${independent} independent path(s) — needs ≥2 before strategic escalation`],
      selfServingDiscount,
    };
  }
  reasons.push(`${independent} independent corroboration paths`);
  const m = signal.mention;
  if (m && (m.meanAccountAgeDays < 30 || m.clusterSize >= 10)) {
    return {
      verdict: 'CANDIDATE',
      reasons: [
        ...reasons,
        `mention-spike anomaly (mean age ${m.meanAccountAgeDays}d, cluster ${m.clusterSize}) — possible astroturf`,
      ],
      selfServingDiscount,
    };
  }
  return { verdict: 'ESCALATE', reasons, selfServingDiscount };
}

/**
 * External text is quoted data. This wrapper is the enforcement shape:
 * anything crossing into reasoning carries its source chrome and a kind
 * tag that no prompt template may mistake for instructions.
 */
export interface QuotedData {
  kind: 'quoted-data';
  sourceUri: string;
  sourceTier: SourceTier;
  text: string;
}

export function quoteExternal(text: string, sourceUri: string, sourceTier: SourceTier): QuotedData {
  return { kind: 'quoted-data', sourceUri, sourceTier, text };
}
