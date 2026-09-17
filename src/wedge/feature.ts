import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter, HarnessOutcome } from '../substrate/harness.ts';
import type { Manifest } from '../substrate/sandbox.ts';
import type { SourceTier } from '../core/types.ts';
import { WedgeError } from './ship.ts';

/**
 * Third workflow: feature-request with deep research (eng room loop).
 *
 *   eng asks (typed REQUEST) → optional deep research on how others do it
 *   → plan an improved version citing the research → human approval
 *   (DECISION + Context Bundle) → code runs ONLY against the approved
 *   decision + an admitted request.
 *
 * Research findings enter as OBSERVATIONs with source URIs — never FACTs.
 * Competitor blogs land SELF_SERVED/SINGLE_SOURCE, so the integrity
 * discount and the ≥2-paths corroboration rule apply downstream. Plans
 * cite live research; uncited plan sentences are refused. Coding without
 * a verified, human-approved decision throws instead of starting.
 */

export interface CompetitorFinding {
  sourceUri: string;
  summary: string;
  sourceTier?: SourceTier;
}

const RESEARCH_TIERS: readonly SourceTier[] = ['PRIMARY', 'CORROBORATED', 'SINGLE_SOURCE', 'SELF_SERVED'];

/** Stage 1 — deep research: competitor findings become cited OBSERVATIONs. */
export async function researchCompetitors(
  ledger: Ledger,
  tenant: string,
  input: { feature: string; findings: CompetitorFinding[]; by: string; scope: string; now: string },
): Promise<string[]> {
  if (input.findings.length === 0) {
    throw new WedgeError(
      'EMPTY_RESEARCH',
      'deep research with no findings researched nothing — cite sources or skip the stage',
    );
  }
  const ids: string[] = [];
  for (const f of input.findings) {
    if (!f.sourceUri) throw new WedgeError('UNSOURCED_FINDING', `research finding cites no source: "${f.summary}"`);
    if (!f.summary) throw new WedgeError('EMPTY_FINDING', `sourced finding with no content: ${f.sourceUri}`);
    const tier = f.sourceTier ?? 'SINGLE_SOURCE';
    if (!RESEARCH_TIERS.includes(tier)) {
      throw new WedgeError(
        'RESEARCH_MINTS_FACT',
        'research observes; it does not mint ground truth — promotion is governed',
      );
    }
    const c = await ledger.append({
      tenant,
      subject: `research:${input.feature}`,
      kind: 'OBSERVATION',
      statement: f.summary,
      confidence: 0.6,
      owner: input.by,
      scope: input.scope,
      authorType: 'agent',
      observedAt: input.now,
      validFrom: input.now,
      now: input.now,
      provenance: {
        sourceUri: f.sourceUri,
        sourceTier: tier,
        extractor: 'feature-research',
        extractorVersion: '1.0.0',
        retrievedAt: input.now,
      },
    });
    ids.push(c.id);
  }
  return ids;
}

export interface PlanItem {
  improvement: string;
  researchIds: string[];
}

export interface FeaturePlan {
  feature: string;
  items: { improvement: string; researchIds: string[] }[];
  fingerprint: string;
}

const UNUSABLE = ['STALE', 'DISPUTED', 'SUPERSEDED', 'RETIRED'] as const;

export function computePlanFingerprint(
  feature: string,
  items: { improvement: string; researchIds: string[] }[],
): string {
  const itemSigs = items.map((i) => `${i.improvement}#${[...i.researchIds].sort().join(',')}`);
  return `feature:${feature}:${itemSigs.join('|')}`;
}

/** Stage 2 — plan the improved version. Every improvement cites live research. */
export async function planFeature(
  ledger: Ledger,
  tenant: string,
  input: { feature: string; items: PlanItem[]; now: string },
): Promise<FeaturePlan> {
  if (input.items.length === 0) throw new WedgeError('EMPTY_PLAN', 'a plan with no improvements improves nothing');
  const items: { improvement: string; researchIds: string[] }[] = [];
  for (const it of input.items) {
    if (it.researchIds.length === 0) {
      throw new WedgeError('UNCITED_PLAN', `improvement cites no research: "${it.improvement}"`);
    }
    const bad: string[] = [];
    for (const id of it.researchIds) {
      const c = await ledger.get(tenant, id);
      if (!c) {
        bad.push(id);
        continue;
      }
      if ((UNUSABLE as readonly string[]).includes(c.status)) bad.push(id);
      else if (c.validUntil && c.validUntil <= input.now) bad.push(id);
    }
    if (bad.length > 0) {
      throw new WedgeError('STALE_RESEARCH', `plan cites unusable research: ${bad.join(', ')}`);
    }
    items.push({ improvement: it.improvement, researchIds: [...it.researchIds] });
  }
  return {
    feature: input.feature,
    items,
    fingerprint: computePlanFingerprint(input.feature, items),
  };
}

/** Stage 3 — human approval. No named approver, no decision, no coding. */
export async function approveFeaturePlan(
  ledger: Ledger,
  tenant: string,
  input: {
    plan: FeaturePlan;
    researchIds: string[];
    decidedBy: string;
    approvedBy?: string;
    scope: string;
    requestId?: string;
    now: string;
  },
): Promise<string> {
  if (!input.approvedBy) {
    throw new WedgeError('NEEDS_APPROVAL', 'a feature plan without a named human approver never reaches coding');
  }

  // Immutable binding check: all research citations in the plan must be included in the decision evidence
  const planResearch = new Set(input.plan.items.flatMap((i) => i.researchIds));
  const providedResearch = new Set(input.researchIds);
  const missingResearch = [...planResearch].filter((id) => !providedResearch.has(id));
  if (missingResearch.length > 0) {
    throw new WedgeError(
      'UNGROUNDED_PLAN',
      `approval research does not ground all plan citations: missing ${missingResearch.join(', ')}`,
    );
  }

  const dec = await ledger.recordDecision({
    tenant,
    goal: `build ${input.plan.feature}`,
    action: `[plan:${input.plan.fingerprint}] ${input.plan.items.map((i) => i.improvement).join('; ')}`,
    actionClass: 'ACT_REVERSIBLE',
    claimIds: input.researchIds,
    decidedBy: input.decidedBy,
    approvedBy: input.approvedBy,
    scope: input.scope,
    autonomy: 'approval',
    requestId: input.requestId ?? null,
    now: input.now,
  });
  return dec.id;
}

export interface CodedFeature {
  decisionId: string;
  outcome: HarnessOutcome;
  verificationStatus: 'VERIFIED' | 'FAILED';
  verificationReason?: string;
}

/** Stage 4 — code runs ONLY against a verified, human-approved decision. */
export async function codeApprovedFeature(
  coord: Coordinator,
  ledger: Ledger,
  adapter: HarnessAdapter,
  tenant: string,
  input: {
    decisionId: string;
    requestId: string;
    command: string;
    claimIds: string[];
    onBehalfOf: string;
    maxDollars: number;
    maxTokens: number;
    plan?: FeaturePlan;
    now?: string;
    workingDir?: string;
    scopeToken?: string;
    coreSecret?: string;
    sandboxManifest?: Manifest;
  },
): Promise<CodedFeature> {
  const now = input.now ?? new Date().toISOString();
  const replay = await ledger.replayDecision(tenant, input.decisionId);
  if (!replay.record.approvedBy) {
    throw new WedgeError('UNAPPROVED_CODE', `decision ${input.decisionId} has no human approver — coding refused`);
  }
  if (replay.record.autonomy !== 'approval' && replay.record.autonomy !== 'human-command') {
    throw new WedgeError(
      'UNAPPROVED_CODE',
      `decision ${input.decisionId} autonomy is ${replay.record.autonomy} — coding refused`,
    );
  }

  // Request binding: decision approved for a specific request must not be used on another
  if (replay.record.requestId && replay.record.requestId !== input.requestId) {
    throw new WedgeError(
      'REQUEST_MISMATCH',
      `decision ${input.decisionId} is bound to request ${replay.record.requestId}, not ${input.requestId}`,
    );
  }

  // Plan binding: plan fingerprint must match approved action
  if (input.plan && !replay.record.action.includes(input.plan.fingerprint)) {
    throw new WedgeError(
      'PLAN_MISMATCH',
      `plan fingerprint "${input.plan.fingerprint}" does not match approved action in decision ${input.decisionId}`,
    );
  }

  // Drift and reapproval check: any mutation/superseding/staleness in the evidence bundle rejects execution
  const drifted = replay.drift.filter((d) => d.drifted);
  if (drifted.length > 0) {
    const details = drifted.map((d) => `${d.id}:${d.frozenStatus}->${d.currentStatus}`).join(', ');
    throw new WedgeError(
      'DRIFTED_DECISION',
      `decision evidence has drifted since approval (${details}) — reapproval required`,
    );
  }

  // Check cited claims for unusable status or expiry
  for (const entry of replay.record.bundle.claims) {
    const live = await ledger.get(tenant, entry.id);
    if (!live || (UNUSABLE as readonly string[]).includes(live.status)) {
      throw new WedgeError(
        'DRIFTED_DECISION',
        `decision cites claim ${entry.id} which is now ${live ? live.status : 'missing'} — reapproval required`,
      );
    }
    if (live.validUntil && live.validUntil <= now) {
      throw new WedgeError(
        'DRIFTED_DECISION',
        `decision cites claim ${entry.id} which expired at ${live.validUntil} — reapproval required`,
      );
    }
  }

  const req = await coord.get(tenant, input.requestId);
  // F03: same executable set as every worker — ACCEPTED (human-approved) is
  // claimable, so an approved coding plan can actually run.
  if (!req || (req.state !== 'ADMITTED' && req.state !== 'ACCEPTED' && req.state !== 'IN_FLIGHT')) {
    throw new WedgeError('UNADMITTED_CODE', `request ${input.requestId} is not executable — coding refused`);
  }

  const outcome = await adapter.run(tenant, input.requestId, {
    command: input.command,
    workingDir: input.workingDir,
    claimRefs: input.claimIds,
    onBehalfOf: input.onBehalfOf,
    maxDollars: input.maxDollars,
    maxTokens: input.maxTokens,
    scopeToken: input.scopeToken,
    coreSecret: input.coreSecret,
    sandboxManifest: input.sandboxManifest,
    approvedDecisionId: input.decisionId,
    approvedBy: replay.record.approvedBy,
  });

  const deniedPermissions = outcome.permissions.filter((p) => p.decision === 'deny');
  const isCompleted = outcome.status === 'COMPLETED';
  const verificationStatus: 'VERIFIED' | 'FAILED' =
    isCompleted && deniedPermissions.length === 0 ? 'VERIFIED' : 'FAILED';
  let verificationReason: string | undefined;
  if (deniedPermissions.length > 0) {
    verificationReason = `execution had denied permissions: ${deniedPermissions.map((p) => p.tool).join(', ')}`;
  } else if (!isCompleted) {
    verificationReason = `harness execution status was ${outcome.status}`;
  }

  return {
    decisionId: input.decisionId,
    outcome,
    verificationStatus,
    verificationReason,
  };
}
