import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { SourceTier } from '../core/types.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ModelProfile } from '../substrate/models.ts';
import {
  loadWatchContract,
  recordContractSpend,
  evaluateContract,
  type WatchContract,
  type Signal,
  WatchError,
} from './watch.ts';
import { triageSignal, type TriageVerdict, type ModelFn } from './triage.ts';
import {
  integrityScreen,
  quoteExternal,
  formatQuotedPrompt,
  type IntegrityResult,
  type QuotedData,
  type WorldSignal,
} from './integrity.ts';

/**
 * Running World Sense Funnel:
 *   Collect / Input Signal
 *      ↓
 *   Stage 0 & 1: Authoritative Watch Contract Evaluation (budget, expiry, entity, predicate, materiality, thresholds)
 *      ↓ (if material)
 *   Stage 2: L1 Small-Model Triage (category, entities, confidence) + spend tracking
 *      ↓
 *   Stage 3: L2 Integrity Gate (domain-aware corroboration paths, self-serving discount, mention anomaly)
 *      ↓
 *   Stage 4: Prompt Boundary Wrapping (untrusted external data enclosed in delimiter markers)
 *      ↓
 *   Stage 5: Final routing (ESCALATE → optional Ledger OBSERVATION, CANDIDATE → awaiting corroboration, or ARCHIVED)
 */

export interface RawSenseSignal {
  id?: string;
  source: string;
  uri: string;
  summary: string;
  sourceTier: SourceTier;
  entityRefs: string[];
  goalRefs: string[];
  revenueCostRiskRefs?: string[];
  predicates?: string[];
  scores: Record<string, number>;
  corroborationPaths?: string[];
  confidence?: number;
  mention?: {
    meanAccountAgeDays: number;
    clusterSize: number;
  };
  rawPayload?: string;
}

export type FunnelVerdict = 'ESCALATE' | 'CANDIDATE' | 'ARCHIVED';

export interface FunnelResult {
  signalId: string;
  contractId: string;
  verdict: FunnelVerdict;
  material: boolean;
  contract: WatchContract;
  triage: TriageVerdict;
  integrity: IntegrityResult;
  quoted: QuotedData;
  formattedPrompt: string;
  reasons: string[];
  spent: { dollars: number; tokens: number };
  observationClaimId?: string;
}

export interface FunnelOptions {
  now?: string;
  liveGoalIds?: readonly string[];
  modelFn?: ModelFn;
  profile?: ModelProfile;
  apiKey?: string;
  ledger?: Ledger;
  authorType?: 'system' | 'agent';
  scope?: string;
  owner?: string;
}

export async function runSenseFunnel(
  db: AsyncDb,
  tenant: string,
  contractId: string,
  signal: RawSenseSignal,
  opts: FunnelOptions = {},
): Promise<FunnelResult> {
  const now = opts.now ?? new Date().toISOString();
  const signalId =
    signal.id ??
    `sig_${createHash('sha256').update(`${tenant}:${signal.source}:${signal.uri}:${now}`).digest('hex').slice(0, 16)}`;

  // Stage 0: Load durable contract
  let contract = await loadWatchContract(db, tenant, contractId, now);
  if (!contract) {
    throw new WatchError('CONTRACT_NOT_FOUND', `watch contract "${contractId}" not found for tenant "${tenant}"`);
  }

  // Stage 1: Authoritative Contract Evaluation
  const evalSignal: Signal = {
    entityRefs: signal.entityRefs,
    goalRefs: signal.goalRefs,
    revenueCostRiskRefs: signal.revenueCostRiskRefs,
    predicates: signal.predicates,
    scores: signal.scores,
  };
  const evalVerdict = evaluateContract(contract, evalSignal, {
    now,
    liveGoalIds: opts.liveGoalIds ?? contract.goalRefs,
    spent: contract.spent,
    requireAllThresholds: true,
  });

  const reasons = [...evalVerdict.reasons];
  const quoted = quoteExternal(signal.rawPayload ?? signal.summary, signal.uri, signal.sourceTier);
  const formattedPrompt = formatQuotedPrompt(quoted);

  if (!evalVerdict.material) {
    return {
      signalId,
      contractId,
      verdict: 'ARCHIVED',
      material: false,
      contract,
      triage: { category: 'UNSPECIFIED', entities: [], confidence: 0 },
      integrity: {
        verdict: 'CANDIDATE',
        reasons: ['not evaluated: immaterial at stage 1'],
        selfServingDiscount: false,
        discountFactor: 1,
        authorities: [],
      },
      quoted,
      formattedPrompt,
      reasons,
      spent: { dollars: 0, tokens: 0 },
    };
  }

  // Stage 2: Small-model L1 Triage
  let triage: TriageVerdict = {
    category: 'UNSPECIFIED',
    entities: signal.entityRefs.map((e) => e.toLowerCase()),
    confidence: signal.confidence ?? 0.5,
  };
  let triageSpent = { dollars: 0, tokens: 0 };

  if (opts.modelFn && opts.profile && opts.apiKey) {
    triage = await triageSignal(opts.profile, opts.apiKey, { summary: signal.summary, uri: signal.uri }, opts.modelFn);
    // Standard L1 triage token estimation
    triageSpent = { dollars: 0.001, tokens: 120 };
    contract = await recordContractSpend(db, tenant, contractId, triageSpent, now);
  }

  // Stage 3: L2 Integrity Screen
  const worldSignal: WorldSignal = {
    uri: signal.uri,
    sourceTier: signal.sourceTier,
    corroborationPaths: signal.corroborationPaths ?? [signal.uri],
    confidence: triage.confidence,
    mention: signal.mention,
  };
  const integrity = integrityScreen(worldSignal);
  reasons.push(...integrity.reasons);

  // Stage 4 & 5: Verdict determination & optional ledger append
  let verdict: FunnelVerdict = 'CANDIDATE';
  let observationClaimId: string | undefined;

  if (integrity.verdict === 'ESCALATE') {
    verdict = 'ESCALATE';
    if (opts.ledger) {
      const claim = await opts.ledger.append({
        tenant,
        subject: signal.entityRefs[0] ?? contract.entities[0] ?? 'world-sense',
        kind: 'OBSERVATION',
        statement: signal.summary,
        confidence: integrity.effectiveConfidence ?? triage.confidence,
        observedAt: now,
        validFrom: now,
        owner: opts.owner ?? 'agent:world-sense',
        scope: opts.scope ?? 'strategy',
        authorType: opts.authorType ?? 'system',
        provenance: {
          sourceUri: signal.uri,
          sourceTier: signal.sourceTier,
          extractor: 'world-sense',
          extractorVersion: '1.0.0',
          retrievedAt: now,
          corroborationPaths: signal.corroborationPaths,
        },
        now,
      });
      observationClaimId = claim.id;
      reasons.push(`recorded as Reality Ledger observation ${claim.id}`);
    }
  }

  return {
    signalId,
    contractId,
    verdict,
    material: true,
    contract,
    triage,
    integrity,
    quoted,
    formattedPrompt,
    reasons,
    spent: triageSpent,
    observationClaimId,
  };
}
