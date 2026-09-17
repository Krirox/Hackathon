/**
 * Vital — core type vocabulary.
 *
 * Three-layer rule enforced throughout the codebase:
 *   Buzz  = where humans and agents TALK   (projection surface)
 *   QM    = where agents COMPUTE           (execution substrate)
 *   Ledger= the ONLY place CLAIMS live     (system of record)
 * Never let a message be the thing that carries work.
 */

// ---------------------------------------------------------------- claims ----

/**
 * FACT is unreachable for any model. Promotion requires a SYSTEM_OF_RECORD or
 * MEASURED provenance tier. This single invariant is what stops an
 * organization from agreeing with its own hallucinations.
 */
export const CLAIM_KINDS = [
  'OBSERVATION',
  'MEASUREMENT',
  'FACT',
  'BELIEF',
  'ASSUMPTION',
  'HYPOTHESIS',
  'PREDICTION',
  'GOAL',
  'DECISION',
  'ACTION',
  'OUTCOME',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Kinds an LLM / agent may create. FACT and MEASUREMENT are excluded by design. */
export const AGENT_CREATABLE_KINDS: readonly ClaimKind[] = [
  'OBSERVATION',
  'BELIEF',
  'ASSUMPTION',
  'HYPOTHESIS',
  'PREDICTION',
  'DECISION',
  'ACTION',
];

/** Kinds that may only originate from a system of record or a measurement. */
export const GROUND_ONLY_KINDS: readonly ClaimKind[] = ['FACT', 'MEASUREMENT', 'OUTCOME'];

export const SOURCE_TIERS = [
  'SYSTEM_OF_RECORD',
  'MEASURED',
  'PRIMARY',
  'CORROBORATED',
  'SINGLE_SOURCE',
  'SELF_SERVED',
] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/** Ordered trust. Higher index = less trustworthy. */
export const TIER_RANK: Record<SourceTier, number> = {
  SYSTEM_OF_RECORD: 0,
  MEASURED: 1,
  PRIMARY: 2,
  CORROBORATED: 3,
  SINGLE_SOURCE: 4,
  SELF_SERVED: 5,
};

export const CLAIM_STATUSES = ['CANDIDATE', 'VERIFIED', 'DISPUTED', 'SUPERSEDED', 'STALE', 'RETIRED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const LINK_TYPES = ['supports', 'contradicts', 'supersedes', 'derived_from'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface Provenance {
  sourceUri: string;
  sourceTier: SourceTier;
  extractor: string;
  extractorVersion: string;
  retrievedAt: string;
  rawArtifactRef?: string;
  /** Independent corroboration paths, for the integrity gate. */
  corroborationPaths?: string[];
}

export interface Claim<T = unknown> {
  id: string;
  tenant: string;
  subject: string;
  kind: ClaimKind;
  statement: string;
  value?: T;
  unit?: string;
  confidence: number;
  provenance: Provenance;
  observedAt: string;
  validFrom: string;
  validUntil?: string | null;
  verifiedAt?: string | null;
  status: ClaimStatus;
  owner: string;
  /** Room/scope that authored the claim. */
  scope: string;
  /** Set when the claim was inferred during onboarding, never when observed. */
  provisional: boolean;
  /** Signature binding to the public record surface (Buzz/Nostr in production). */
  buzzEventSig?: string | null;
  createdAt: string;
  seq: number;
}

// ------------------------------------------------------- autonomy classes ----

export const ACTION_CLASSES = ['READ', 'ANALYZE', 'RECOMMEND', 'ACT_REVERSIBLE', 'ACT_IRREVERSIBLE'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const ROUTING_CLASSES = ['REFLEX', 'WORKFLOW', 'MODEL', 'HUMAN'] as const;
export type RoutingClass = (typeof ROUTING_CLASSES)[number];

// ---------------------------------------------------- coordination objects --

/**
 * The three message classes. Collapsing these is the single most common way
 * agent coordination dies: only REQUEST is work, only REQUEST consumes budget,
 * only REQUEST may be refused, and NOTICE may never interrupt a human.
 */
export const MESSAGE_CLASSES = ['QUERY', 'REQUEST', 'NOTICE'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export const REQUEST_STATES = [
  'PROPOSED',
  'QUEUED',
  'ADMITTED',
  'DEFERRED',
  'DENIED',
  'IN_FLIGHT',
  'ACCEPTED',
  'DECLINED',
  'REDIRECTED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'TERMINATED_BUDGET',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TERMINAL_REQUEST_STATES: readonly RequestState[] = [
  'COMPLETED',
  'DECLINED',
  'FAILED',
  'EXPIRED',
  'TERMINATED_BUDGET',
];

/**
 * F03: where a settled request lands when a WORKER'S COMPLETION report
 * arrives late. A request DECLINED by its human and executed anyway must
 * not read COMPLETED — the refusal stands, and the row settles FAILED with
 * the worker's objection preserved behind the `REFUSAL|` prefix
 * ("REFUSAL|<why the worker disagrees>"). The same applies to work that
 * reports completion after EXPIRED/TERMINATED_BUDGET.
 *
 * Deliberately ABSENT: COMPLETED (a late failure report cannot un-finish
 * delivered work — that is a new incident, not this request's history) and
 * FAILED (redelivery recovery FAILED→COMPLETED is handled explicitly in
 * the coordinator, and is REFUSED when the FAILED row was a preserved
 * refusal — a refusal is never resurrected).
 */
export const LATE_COMPLETION_SETTLEMENT: ReadonlyMap<RequestState, RequestState> = new Map([
  ['DECLINED', 'FAILED'],
  ['EXPIRED', 'FAILED'],
  ['TERMINATED_BUDGET', 'FAILED'],
] as const);

export interface CostBid {
  /** Inference budget, USD. */
  dollars: number;
  tokens: number;
  /** Human attention is the scarce resource, so it is budgeted explicitly. */
  humanMinutes: number;
  /** Wall-clock deadline, ISO instant. */
  deadline: string;
  maxRounds: number;
  maxHops: number;
  /**
   * Peak bytes this request may occupy in its scope's sandbox. Disk is the
   * resource every other budget ignores: an agent loop that writes logs,
   * clones a repo, or materialises test data can fill a per-tenant VPS and
   * take down an "always reachable" box without ever spending a token.
   * A disk-full execution plane is an outage, and it is the most likely one.
   */
  maxDiskBytes: number;
}

export interface CoordinationRequest {
  id: string;
  tenant: string;
  messageClass: MessageClass;
  /** Scope that opened the request and whose human owns the outcome. */
  originScope: string;
  targetScope: string;
  goal: string;
  /** Claim IDs the request is grounded in. Required — no ungrounded work. */
  claimRefs: string[];
  /** Deliverable shape the target must produce to count as done. */
  deliverableSchema: string;
  bid: CostBid;
  onBehalfOf: string;
  hopChain: string[];
  /** Claims minted inside this request's own chain — used for cycle detection. */
  chainClaimIds: string[];
  idempotencyKey: string;
  stopCondition: string;
  state: RequestState;
  spent: { dollars: number; tokens: number; humanMinutes: number; rounds: number; diskBytes: number };
  refusalReason?: string | null;
  parentRequestId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** F05: who holds the exclusive execution claim (null when unclaimed). */
  execOwner?: string | null;
  /** F05: monotonic per-request claim counter — fencing token for stale workers. */
  execAttempt?: number;
}
