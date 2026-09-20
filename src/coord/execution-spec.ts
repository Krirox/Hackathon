import { createHash } from 'node:crypto';
import type { Ledger, DecisionRecord } from '../ledger/ledger.ts';
import type { Coordinator } from './coordinator.ts';
import type { CoordinationRequest, CostBid } from '../core/types.ts';
import { EXECUTABLE_STATES } from './coordinator.ts';

/** FLOW-002: versioned execution specification bound at approval time. */
export const EXECUTION_SPEC_VERSION = 1;

export type ApprovalStage = 'begin-work' | 'final-deliverable';

export interface EvidenceVersion {
  id: string;
  seq: number;
  hash: string;
}

export interface ExecutionSpec {
  version: typeof EXECUTION_SPEC_VERSION;
  approvalStage: ApprovalStage;
  requestId: string;
  requestUpdatedAt: string;
  goal: string;
  /** Task instruction authorized for execution — defaults to goal for begin-work. */
  command: string;
  deliverableSchema: string;
  originScope: string;
  targetScope: string;
  budget: CostBid;
  stopCondition: string;
  evidence: EvidenceVersion[];
  planFingerprint?: string;
  assetVersion?: string;
  fingerprint: string;
}

export class ExecutionSpecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`[execspec:${code}] ${message}`);
  }
}

function hashEvidence(
  id: string,
  seq: number,
  kind: string,
  statement: string,
  status: string,
  confidence: number,
): string {
  return createHash('sha256')
    .update([id, String(seq), kind, statement, status, String(confidence)].join('|'))
    .digest('hex');
}

type SpecBody = Omit<ExecutionSpec, 'fingerprint'>;

function canonicalSpecBody(body: SpecBody): string {
  const evidence = [...body.evidence]
    .map((e) => ({ id: e.id, seq: e.seq, hash: e.hash }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    version: body.version,
    approvalStage: body.approvalStage,
    requestId: body.requestId,
    requestUpdatedAt: body.requestUpdatedAt,
    goal: body.goal,
    command: body.command,
    deliverableSchema: body.deliverableSchema,
    originScope: body.originScope,
    targetScope: body.targetScope,
    budget: body.budget,
    stopCondition: body.stopCondition,
    evidence,
    planFingerprint: body.planFingerprint ?? null,
    assetVersion: body.assetVersion ?? null,
  });
}

export function fingerprintSpec(body: SpecBody): string {
  return createHash('sha256').update(canonicalSpecBody(body)).digest('hex');
}

export async function evidenceVersionsFor(
  ledger: Ledger,
  tenant: string,
  claimIds: string[],
): Promise<EvidenceVersion[]> {
  const out: EvidenceVersion[] = [];
  for (const id of claimIds) {
    const c = await ledger.get(tenant, id);
    if (!c) throw new ExecutionSpecError('MISSING_EVIDENCE', `evidence claim ${id} is not in the ledger`);
    out.push({
      id: c.id,
      seq: c.seq,
      hash: hashEvidence(c.id, c.seq, c.kind, c.statement, c.status, c.confidence),
    });
  }
  return out;
}

export async function buildBeginWorkSpec(
  ledger: Ledger,
  request: CoordinationRequest,
  opts: { planFingerprint?: string; assetVersion?: string; command?: string } = {},
): Promise<ExecutionSpec> {
  const evidence = await evidenceVersionsFor(ledger, request.tenant, request.claimRefs);
  const body: SpecBody = {
    version: EXECUTION_SPEC_VERSION,
    approvalStage: 'begin-work',
    requestId: request.id,
    requestUpdatedAt: request.updatedAt,
    goal: request.goal,
    command: opts.command ?? request.goal,
    deliverableSchema: request.deliverableSchema,
    originScope: request.originScope,
    targetScope: request.targetScope,
    budget: request.bid,
    stopCondition: request.stopCondition,
    evidence,
    planFingerprint: opts.planFingerprint,
    assetVersion: opts.assetVersion,
  };
  return { ...body, fingerprint: fingerprintSpec(body) };
}

export function serializeExecutionSpec(spec: ExecutionSpec): string {
  return JSON.stringify(spec);
}

export function parseExecutionSpec(action: string): ExecutionSpec | null {
  try {
    const raw = JSON.parse(action) as ExecutionSpec;
    if (!raw || raw.version !== EXECUTION_SPEC_VERSION || typeof raw.fingerprint !== 'string') return null;
    const { fingerprint, ...body } = raw;
    if (fingerprintSpec(body as SpecBody) !== fingerprint) return null;
    return raw;
  } catch {
    return null;
  }
}

export function parseExecutionSpecFromDecision(record: DecisionRecord): ExecutionSpec | null {
  return parseExecutionSpec(record.action);
}

export interface ApprovalBoundaryInput {
  expectedRequestUpdatedAt?: string;
  planFingerprint?: string;
  assetVersion?: string;
  command?: string;
}

/**
 * FLOW-002: freshness gate shared by approval and decline. A stale review
 * page must not authorize or refuse different content than the reviewer saw:
 * the rejection carries the current version plus a diff, and the reviewer
 * resubmits explicitly after re-review.
 */
export function assertFreshReview(request: CoordinationRequest, expectedRequestUpdatedAt?: string): void {
  if (expectedRequestUpdatedAt && expectedRequestUpdatedAt !== request.updatedAt) {
    throw new ExecutionSpecError(
      'STALE_REVIEW',
      'the request changed since this page was loaded: review the current version and submit again',
      {
        expected: expectedRequestUpdatedAt,
        current: request.updatedAt,
        requiresReReview: true,
        diff: [
          `goal: ${request.goal}`,
          `budget: ${request.bid.dollars} dollars, ${request.bid.tokens} tokens, ${request.bid.humanMinutes} human minutes`,
          `scope: ${request.originScope} to ${request.targetScope}`,
          `evidence: ${request.claimRefs.join(', ') || 'none'}`,
          `state: ${request.state}, updated ${request.updatedAt}`,
        ],
      },
    );
  }
}

/**
 * Revalidate request state, deadline, and evidence at approval time.
 * Returns the frozen execution specification to record on the decision.
 */
export async function validateApprovalBoundary(
  ledger: Ledger,
  request: CoordinationRequest,
  now: string,
  input: ApprovalBoundaryInput = {},
): Promise<ExecutionSpec> {
  if (request.state !== 'ADMITTED') {
    throw new ExecutionSpecError('NOT_REVIEWABLE', `request ${request.id} is ${request.state}, not awaiting review`, {
      state: request.state,
    });
  }
  if (request.claimRefs.length === 0) {
    throw new ExecutionSpecError('UNGROUNDED', 'approval requires grounded evidence on the request');
  }
  assertFreshReview(request, input.expectedRequestUpdatedAt);
  const deadline = Date.parse(request.bid.deadline);
  if (Number.isFinite(deadline) && deadline <= Date.parse(now)) {
    throw new ExecutionSpecError('DEADLINE_PASSED', `request deadline ${request.bid.deadline} has passed`);
  }
  const usable = await ledger.contextFor(request.tenant, request.claimRefs, now);
  if (usable.length !== request.claimRefs.length) {
    const usableIds = new Set(usable.map((c) => c.id));
    const dropped = request.claimRefs.filter((id) => !usableIds.has(id));
    const diff: string[] = [];
    for (const id of dropped) {
      const old = await ledger.get(request.tenant, id);
      const cur = await ledger.currentReplacement(request.tenant, id);
      if (old && cur && cur.id !== old.id) {
        diff.push(
          `evidence ${id}: "${old.statement}" (seq ${old.seq}) superseded by ${cur.id}: "${cur.statement}" (seq ${cur.seq})`,
        );
      } else if (old) {
        diff.push(
          `evidence ${id}: "${old.statement}" (seq ${old.seq}, ${old.status}) has no usable current replacement`,
        );
      } else {
        diff.push(`evidence ${id} is no longer in the ledger`);
      }
    }
    throw new ExecutionSpecError(
      'STALE_EVIDENCE',
      `evidence changed since this page was loaded: ${dropped.join(', ')}: review the current evidence and submit again`,
      { dropped, requiresReReview: true, diff },
    );
  }
  return buildBeginWorkSpec(ledger, request, {
    planFingerprint: input.planFingerprint,
    assetVersion: input.assetVersion,
    command: input.command,
  });
}

export interface ExecutionAttempt {
  command: string;
  claimRefs: string[];
  planFingerprint?: string;
  specFingerprint?: string;
  decisionId?: string;
}

/**
 * Execute only the work frozen in the approved specification — not a replacement instruction.
 */
export async function validateExecutionAgainstSpec(
  ledger: Ledger,
  coord: Coordinator,
  tenant: string,
  requestId: string,
  attempt: ExecutionAttempt,
  now: string,
): Promise<{ spec: ExecutionSpec; decisionId: string }> {
  const request = await coord.get(tenant, requestId);
  if (!request) throw new ExecutionSpecError('NOT_FOUND', `unknown request ${requestId}`);
  if (!EXECUTABLE_STATES.includes(request.state)) {
    throw new ExecutionSpecError('NOT_EXECUTABLE', `request ${requestId} is ${request.state}, not executable`, {
      state: request.state,
    });
  }

  const decision =
    (attempt.decisionId ? await ledger.getDecision(tenant, attempt.decisionId) : null) ??
    (await ledger.getDecisionByRequest(tenant, requestId));
  if (!decision) {
    throw new ExecutionSpecError('NO_APPROVAL', `request ${requestId} has no approval decision to execute against`);
  }
  if (decision.requestId && decision.requestId !== requestId) {
    throw new ExecutionSpecError(
      'REQUEST_MISMATCH',
      `decision ${decision.id} is bound to request ${decision.requestId}, not ${requestId}`,
    );
  }

  const spec = parseExecutionSpecFromDecision(decision);
  if (!spec) {
    throw new ExecutionSpecError('INVALID_SPEC', `decision ${decision.id} has no valid execution specification`);
  }
  if (spec.requestId !== requestId) {
    throw new ExecutionSpecError(
      'REQUEST_MISMATCH',
      `execution spec is bound to request ${spec.requestId}, not ${requestId}`,
    );
  }
  if (attempt.specFingerprint && attempt.specFingerprint !== spec.fingerprint) {
    throw new ExecutionSpecError(
      'SPEC_MISMATCH',
      'submitted execution specification fingerprint does not match the approved authorization',
      { expected: spec.fingerprint, got: attempt.specFingerprint },
    );
  }
  if (attempt.command !== spec.command) {
    throw new ExecutionSpecError('TASK_MISMATCH', 'execution command does not match the approved specification', {
      approved: spec.command,
      submitted: attempt.command,
    });
  }
  const approvedEvidence = [...spec.evidence].map((e) => e.id).sort();
  const submittedEvidence = [...attempt.claimRefs].sort();
  if (approvedEvidence.join('|') !== submittedEvidence.join('|')) {
    throw new ExecutionSpecError('EVIDENCE_MISMATCH', 'execution evidence does not match the approved specification', {
      approved: approvedEvidence,
      submitted: submittedEvidence,
    });
  }
  if (attempt.planFingerprint && spec.planFingerprint && attempt.planFingerprint !== spec.planFingerprint) {
    throw new ExecutionSpecError(
      'PLAN_MISMATCH',
      'execution plan fingerprint does not match the approved specification',
      { approved: spec.planFingerprint, submitted: attempt.planFingerprint },
    );
  }

  const deadline = Date.parse(spec.budget.deadline);
  if (Number.isFinite(deadline) && deadline <= Date.parse(now)) {
    throw new ExecutionSpecError('DEADLINE_PASSED', `approved deadline ${spec.budget.deadline} has passed`);
  }

  const replay = await ledger.replayDecision(tenant, decision.id);
  const drifted = replay.drift.filter((d) => d.drifted);
  if (drifted.length > 0) {
    throw new ExecutionSpecError(
      'DRIFTED_APPROVAL',
      `approved evidence drifted since authorization (${drifted.map((d) => d.id).join(', ')}): re-review required`,
      { drifted: drifted.map((d) => d.id) },
    );
  }

  return { spec, decisionId: decision.id };
}

/** Human-review requests must not execute before approval. */
export function requiresHumanApproval(request: CoordinationRequest): boolean {
  return request.bid.humanMinutes > 0;
}
