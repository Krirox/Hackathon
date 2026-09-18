import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { nextSeq } from '../core/db.ts';
import type { ClaimRow, DecisionRow, SubjectRow } from '../core/rows.ts';
import {
  ACTION_CLASSES,
  AGENT_CREATABLE_KINDS,
  CLAIM_KINDS,
  SOURCE_TIERS,
  TIER_RANK,
  type Claim,
  type ClaimKind,
  type LinkType,
  type SourceTier,
} from '../core/types.ts';

/**
 * Reality Ledger — append-only, bi-temporal, typed claims.
 *
 * This is the grounding layer. Everything else in the system reads from it and
 * writes to it; nothing else is allowed to be the system of record.
 *
 * HARD INVARIANTS (enforced in code, not documented as policy):
 *   I1  No generated facts.        AGENT_CREATABLE_KINDS excludes FACT/MEASUREMENT.
 *   I2  FACT requires ground tier.  source_tier ∈ {SYSTEM_OF_RECORD, MEASURED}.
 *   I3  Every claim has an owner.   no orphan claims.
 *   I4  Contradiction is an event.  linking `contradicts` opens a resolution ticket.
 *   I5  Staleness is computed.      valid_until expiry ⇒ STALE ⇒ excluded from context.
 *   I6  Provisional never acts.     onboarding-inferred claims cannot trigger autonomy.
 *   I7  Append-only.                rows are never UPDATEd; supersede by new row + link.
 */

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`[ledger:${code}] ${message}`);
  }
}

const newClaimSchema = z
  .object({
    tenant: z.string().min(1),
    subject: z.string().min(1),
    kind: z.enum(CLAIM_KINDS),
    statement: z.string().min(1),
    value: z.unknown().optional(),
    unit: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1),
    provenance: z.object({
      sourceUri: z.string().min(1),
      sourceTier: z.enum(SOURCE_TIERS),
      extractor: z.string().min(1),
      extractorVersion: z.string().min(1),
      retrievedAt: z.string().min(1),
      rawArtifactRef: z.string().optional(),
      corroborationPaths: z.array(z.string()).optional(),
    }),
    observedAt: z.string().min(1),
    validFrom: z.string().min(1),
    validUntil: z.string().nullable().optional(),
    owner: z.string().min(1),
    scope: z.string().min(1),
    provisional: z.boolean().default(false),
    /**
     * Who is writing. `agent` is subject to I1; `system` may write ground-tier
     * kinds after validation; `human` may promote CANDIDATE → VERIFIED.
     */
    authorType: z.enum(['agent', 'human', 'system']).default('agent'),
    buzzEventSig: z.string().nullable().optional(),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

const upsertSubjectSchema = z
  .object({
    tenant: z.string().min(1),
    /** Stable natural key, e.g. "repo:acme/widget" — claims reference this via `subject`. */
    key: z.string().min(1),
    displayName: z.string().min(1),
    kind: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    now: z.string().optional(),
  })
  .strict();

export type NewClaimInput = z.input<typeof newClaimSchema>;

const GROUND_TIERS: readonly SourceTier[] = ['SYSTEM_OF_RECORD', 'MEASURED'];

export interface Subject {
  id: string;
  tenant: string;
  /** Stable natural key claims reference. */
  key: string;
  displayName: string;
  kind: string;
  aliases: string[];
  createdAt: string;
}

export interface CorrectionPatch {
  value?: number | null;
  unit?: string | null;
  confidence?: number;
  validUntil?: string | null;
}

/** FLOW-003: optimistic concurrency + typed patch for a human correction. */
export interface CorrectionInput {
  patch?: CorrectionPatch;
  /** Required for conflict-safe supersede; must match the loaded claim's seq. */
  expectedSeq?: number;
}

export interface CorrectionResult {
  claim: Claim;
  supersededId: string;
}

/** Actionable conflict payload when a correction loses the version race. */
export interface CorrectionConflict {
  expectedSeq?: number;
  currentSeq: number;
  current: Claim;
  winner?: Claim;
  diff?: { before: string; after: string };
  preservedDraft?: { statement: string; by: string; at: string };
}

export interface Ledger {
  append(input: NewClaimInput): Promise<Claim>;
  get(tenant: string, id: string): Promise<Claim | null>;
  bySubject(tenant: string, subject: string, opts?: { includeStale?: boolean }): Promise<Claim[]>;
  link(tenant: string, fromId: string, toId: string, link: LinkType): Promise<void>;
  contradictions(tenant: string, claimId: string): Promise<Claim[]>;
  /** Claims eligible to be placed in a high-tier reasoning context. */
  contextFor(tenant: string, ids: string[], now: string): Promise<Claim[]>;
  markStale(tenant: string, now: string): Promise<string[]>;
  stats(tenant: string, now: string): Promise<LedgerStats>;
  /** §4.4 — freeze the exact claim versions a decision was made on. */
  recordDecision(input: NewDecisionInput): Promise<DecisionRecord>;
  getDecision(tenant: string, id: string): Promise<DecisionRecord | null>;
  /** Latest decision for a request (a request may have several); null when none. */
  getDecisionByRequest(tenant: string, requestId: string): Promise<DecisionRecord | null>;
  /** Reconstruct what was live at decision time + what drifted since. */
  replayDecision(tenant: string, id: string): Promise<DecisionReplay>;
  /** OUTCOME requires a measurement basis — narrative causality is rejected. */
  recordOutcome(input: NewOutcomeInput): Promise<OutcomeRecord>;
  /** Walk `supersedes` links in both directions: { history, current }. */
  supersedeChain(tenant: string, claimId: string): Promise<{ history: Claim[]; current: Claim | null }>;
  /**
   * Bi-temporal snapshot: what the ledger contained at instant `at`
   * (transaction time = created_at, filtered by valid time). APPROXIMATE:
   * status flips are not versioned, so a contradiction opened after `at` is
   * invisible here. Exact replay is what Context Bundles are for.
   */
  believedAt(tenant: string, subject: string, at: string): Promise<Claim[]>;
  /** PREDICTIONs past their resolution date (valid_until) without an OUTCOME. */
  duePredictions(tenant: string, now: string): Promise<Claim[]>;
  /** Void a prediction that will never resolve — retired, never deleted. */
  voidPrediction(tenant: string, id: string, now: string): Promise<void>;
  /** Curation queue: DISPUTED pairs with both sides (owner + SLA live here later). */
  disputedPairs(tenant: string): Promise<{ a: Claim; b: Claim }[]>;
  /** Expiry prompts: VERIFIED FACTs whose TTL lapses within `horizonMs`. */
  dueVerifications(tenant: string, now: string, horizonMs: number): Promise<Claim[]>;
  /** Human correction: old claim SUPERSEDED, new claim appended, counted. */
  correctClaim(
    tenant: string,
    id: string,
    statement: string,
    by: string,
    now: string,
    input?: CorrectionInput,
  ): Promise<CorrectionResult>;
  /** Direct superseding claim for a historical row, if any. */
  supersedingClaim(tenant: string, claimId: string): Promise<Claim | null>;
  /** Walk forward through supersedes links to the live replacement. */
  currentReplacement(tenant: string, claimId: string): Promise<Claim | null>;
  /** Resolve an open prediction to an outcome fact claim, retiring the prediction. */
  resolvePrediction(
    tenant: string,
    id: string,
    outcome: {
      statement: string;
      value?: number | null;
      unit?: string | null;
      confidence?: number;
      refuted?: boolean;
    },
    by: string,
    now: string,
  ): Promise<{ prediction: Claim; outcomeClaim: Claim }>;
  /** Resolve an active contradiction dispute with a chosen winner; loser is superseded. */
  resolveDispute(
    tenant: string,
    idA: string,
    idB: string,
    winnerId: string,
    rationale: string,
    by: string,
    now: string,
  ): Promise<{ winner: Claim; loser: Claim }>;
  /**
   * Human curation: promote a CANDIDATE to VERIFIED, so the organisation may
   * reason on it. Refuses DISPUTED (resolve the contradiction first), STALE
   * (re-check the source), SUPERSEDED and RETIRED (append a new claim).
   */
  verifyClaim(tenant: string, id: string, verifiedBy: string, now?: string): Promise<Claim>;
  correctionCount(tenant: string): Promise<number>;
  /**
   * Register or update the stable identity behind the free-string `subject`.
   * Idempotent per (tenant, key): re-registering with the same values is a
   * no-op; new aliases merge in. Returns the row, existing or new.
   */
  upsertSubject(input: {
    tenant: string;
    key: string;
    displayName: string;
    kind: string;
    aliases?: string[];
    now?: string;
  }): Promise<Subject>;
  /** Exact-key lookup; null when the tenant never registered that key. */
  subjectByKey(tenant: string, key: string): Promise<Subject | null>;
  /** Natural-key resolution: exact key first, then alias. */
  subjectResolve(tenant: string, keyOrAlias: string): Promise<Subject | null>;
  /**
   * Novelty probe: true when no live claim says this statement about this
   * subject. SQL EXISTS — never hydrates the subject's history. History
   * (RETIRED/STALE/SUPERSEDED) does not count as prior art.
   */
  hasLiveClaim(tenant: string, subject: string, statement: string): Promise<boolean>;
  /** Registry listing, filterable by kind. */
  listSubjects(tenant: string, kind?: string): Promise<Subject[]>;
}

export interface LedgerStats {
  total: number;
  verified: number;
  candidate: number;
  disputed: number;
  stale: number;
  superseded: number;
  byKind: Record<string, number>;
  /** I3 — must be 0. */
  orphanClaims: number;
  /** I2 — must be 0. */
  factsWithoutGroundProvenance: number;
  staleFactRate: number;
  provisionalCount: number;
}

// ------------------------------------------------------- decision records ----

const AUTONOMY_LEVELS = ['autonomous', 'approval', 'human-command'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const newDecisionSchema = z
  .object({
    tenant: z.string().min(1),
    goal: z.string().min(1),
    action: z.string().min(1),
    actionClass: z.enum(ACTION_CLASSES),
    /** Claim IDs the decision is grounded in. Non-empty: no basis, no decision. */
    claimIds: z.array(z.string().min(1)),
    decidedBy: z.string().min(1),
    approvedBy: z.string().nullable().optional(),
    scope: z.string().min(1),
    autonomy: z.enum(AUTONOMY_LEVELS),
    requestId: z.string().nullable().optional(),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

export type NewDecisionInput = z.input<typeof newDecisionSchema>;

export interface ContextBundleEntry {
  id: string;
  seq: number;
  kind: ClaimKind;
  statement: string;
  status: Claim['status'];
  confidence: number;
  /** sha256 over the frozen fields — replay verifies the bundle, not trust. */
  hash: string;
}

export interface ContextBundle {
  version: 1;
  frozenAt: string;
  claims: ContextBundleEntry[];
  bundleHash: string;
}

export interface DecisionRecord {
  id: string;
  tenant: string;
  goal: string;
  action: string;
  actionClass: (typeof ACTION_CLASSES)[number];
  bundle: ContextBundle;
  decidedBy: string;
  approvedBy: string | null;
  scope: string;
  autonomy: AutonomyLevel;
  requestId: string | null;
  signedAt: string;
}

export interface DecisionDrift {
  id: string;
  frozenStatus: Claim['status'];
  currentStatus: Claim['status'] | null;
  frozenSeq: number;
  currentSeq: number | null;
  drifted: boolean;
}

export interface DecisionReplay {
  record: DecisionRecord;
  drift: DecisionDrift[];
}

const newOutcomeSchema = z
  .object({
    tenant: z.string().min(1),
    decisionId: z.string().min(1),
    metric: z.string().min(1),
    predicted: z.number().nullable().optional(),
    actual: z.number(),
    /** Measurement reference the outcome is computed from. Required. */
    basis: z.string().min(1),
    holdoutRef: z.string().nullable().optional(),
    resolvedBy: z.string().min(1),
    scope: z.string().min(1),
    owner: z.string().min(1),
    id: z.string().optional(),
    now: z.string().optional(),
  })
  .strict();

export type NewOutcomeInput = z.input<typeof newOutcomeSchema>;

export interface OutcomeRecord {
  id: string;
  tenant: string;
  decisionId: string;
  metric: string;
  predicted: number | null;
  actual: number;
  basis: string;
  holdoutRef: string | null;
  resolvedAt: string;
}

export function createLedger(db: AsyncDb): Ledger {
  const rowToClaim = (r: ClaimRow): Claim => ({
    id: String(r.id),
    tenant: String(r.tenant),
    subject: String(r.subject),
    kind: r.kind as ClaimKind,
    statement: String(r.statement),
    value: r.value_json == null ? undefined : JSON.parse(String(r.value_json)),
    unit: r.unit == null ? undefined : String(r.unit),
    confidence: Number(r.confidence),
    provenance: {
      sourceUri: String(r.source_uri),
      sourceTier: String(r.source_tier) as SourceTier,
      extractor: String(r.extractor),
      extractorVersion: String(r.extractor_ver),
      retrievedAt: String(r.retrieved_at),
      rawArtifactRef: r.raw_ref == null ? undefined : String(r.raw_ref),
      corroborationPaths: r.corrob_json == null ? undefined : (JSON.parse(String(r.corrob_json)) as string[]),
    },
    observedAt: String(r.observed_at),
    validFrom: String(r.valid_from),
    validUntil: r.valid_until == null ? null : String(r.valid_until),
    verifiedAt: r.verified_at == null ? null : String(r.verified_at),
    status: String(r.status) as Claim['status'],
    owner: String(r.owner),
    scope: String(r.scope),
    provisional: Number(r.provisional) === 1,
    buzzEventSig: r.buzz_sig == null ? null : String(r.buzz_sig),
    createdAt: String(r.created_at),
    seq: Number(r.seq),
  });

  const audit = (tenant: string, actor: string, action: string, target: string, detail?: string) =>
    db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, actor, action, target, detail ?? null, new Date().toISOString());

  async function append(input: NewClaimInput): Promise<Claim> {
    const c = newClaimSchema.parse(input);
    const now = c.now ?? new Date().toISOString();

    // I1 — no generated facts. An agent may never mint FACT / MEASUREMENT / OUTCOME.
    if (c.authorType === 'agent' && !AGENT_CREATABLE_KINDS.includes(c.kind)) {
      throw new LedgerError(
        'EPISTEMIC_GUARD',
        `agent may not create kind=${c.kind}; only [${AGENT_CREATABLE_KINDS.join(', ')}]. ` +
          'FACT requires a system-of-record write (authorType="system").',
      );
    }
    // I2 — FACT/MEASUREMENT require ground provenance regardless of author.
    if ((c.kind === 'FACT' || c.kind === 'MEASUREMENT') && !GROUND_TIERS.includes(c.provenance.sourceTier)) {
      throw new LedgerError(
        'UNGOUNDED_FACT',
        `kind=${c.kind} requires source_tier ∈ {${GROUND_TIERS.join(', ')}}, got ${c.provenance.sourceTier}`,
      );
    }
    // SELF_SERVED content may never be VERIFIED on arrival: everything
    // that is not ground-tier FACT/MEASUREMENT starts as CANDIDATE.
    const initialStatus = c.kind === 'FACT' || c.kind === 'MEASUREMENT' ? 'VERIFIED' : 'CANDIDATE';

    const id = c.id ?? `clm_${crypto.randomUUID()}`;
    const seq = await nextSeq(db, c.tenant);

    return db.transaction(async () => {
      await db
        .prepare(
          `INSERT INTO claims (
           id, tenant, subject, kind, statement, value_json, unit, confidence,
           source_uri, source_tier, extractor, extractor_ver, retrieved_at, raw_ref, corrob_json,
           observed_at, valid_from, valid_until, verified_at, status, owner, scope,
           provisional, buzz_sig, created_at, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          c.tenant,
          c.subject,
          c.kind,
          c.statement,
          c.value === undefined ? null : JSON.stringify(c.value),
          c.unit ?? null,
          c.confidence,
          c.provenance.sourceUri,
          c.provenance.sourceTier,
          c.provenance.extractor,
          c.provenance.extractorVersion,
          c.provenance.retrievedAt,
          c.provenance.rawArtifactRef ?? null,
          c.provenance.corroborationPaths ? JSON.stringify(c.provenance.corroborationPaths) : null,
          c.observedAt,
          c.validFrom,
          c.validUntil ?? null,
          initialStatus === 'VERIFIED' ? now : null,
          initialStatus,
          c.owner,
          c.scope,
          c.provisional,
          c.buzzEventSig ?? null,
          now,
          seq,
        );
      await audit(c.tenant, `${c.authorType}:${c.scope}`, 'CLAIM_APPEND', id, `${c.kind} ${c.subject}`);
      return rowToClaim((await db.prepare('SELECT * FROM claims WHERE id = ?').get(id)) as ClaimRow);
    });
  }

  async function get(tenant: string, id: string): Promise<Claim | null> {
    const r = (await db.prepare('SELECT * FROM claims WHERE id = ? AND tenant = ?').get(id, tenant)) as
      ClaimRow | undefined;
    return r ? rowToClaim(r) : null;
  }

  async function link(tenant: string, fromId: string, toId: string, type: LinkType): Promise<void> {
    const a = await get(tenant, fromId);
    const b = await get(tenant, toId);
    if (!a || !b) throw new LedgerError('MISSING_CLAIM', `link between unknown claims ${fromId}/${toId}`);
    await db.transaction(async () => {
      await db
        .prepare(
          'INSERT INTO claim_links (from_id, to_id, link) VALUES (?,?,?) ON CONFLICT(from_id, to_id, link) DO NOTHING',
        )
        .run(fromId, toId, type);
      if (type === 'supersedes' && a.status !== 'RETIRED') {
        // Append-only: we never rewrite history, but we do flip the *status* of a
        // superseded claim so it stops being retrieved into context.
        await db.prepare("UPDATE claims SET status = 'SUPERSEDED' WHERE id = ? AND tenant = ?").run(toId, tenant);
      }
      // I4 — contradiction is an event, never silence.
      if (type === 'contradicts') {
        for (const cid of [fromId, toId]) {
          await db
            .prepare("UPDATE claims SET status = 'DISPUTED' WHERE id = ? AND tenant = ? AND status = 'VERIFIED'")
            .run(cid, tenant);
        }
        await audit(tenant, 'ledger', 'CONTRADICTION_OPEN', `${fromId}<>${toId}`, 'resolution ticket required');
      }
      await audit(tenant, 'ledger', 'CLAIM_LINK', `${fromId}->${toId}`, type);
    });
  }

  async function contradictions(tenant: string, claimId: string): Promise<Claim[]> {
    return (
      await db
        .prepare(
          `SELECT c.* FROM claims c
           JOIN claim_links l ON (l.from_id = c.id OR l.to_id = c.id)
          WHERE c.tenant = ? AND (l.from_id = ? OR l.to_id = ?) AND l.link = 'contradicts'
            AND c.id <> ?`,
        )
        .all(tenant, claimId, claimId, claimId)
    ).map((r) => rowToClaim(r as ClaimRow));
  }

  async function bySubject(tenant: string, subject: string, opts: { includeStale?: boolean } = {}): Promise<Claim[]> {
    const sql = opts.includeStale
      ? "SELECT * FROM claims WHERE tenant = ? AND subject = ? AND status <> 'RETIRED' ORDER BY seq"
      : "SELECT * FROM claims WHERE tenant = ? AND subject = ? AND status NOT IN ('RETIRED','STALE','SUPERSEDED') ORDER BY seq";
    return (await db.prepare(sql).all(tenant, subject)).map((r) => rowToClaim(r as ClaimRow));
  }

  /**
   * I5 + I6: the only claims allowed into a high-tier reasoning context are
   * VERIFIED, unexpired, non-provisional ones. This is what prevents an agent
   * from being handed a stale or self-serving "fact" and reasoning confidently
   * on top of it.
   */
  async function contextFor(tenant: string, ids: string[], now: string): Promise<Claim[]> {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = (
      await db
        .prepare(
          `SELECT * FROM claims WHERE tenant = ? AND id IN (${ph})
           AND status = 'VERIFIED' AND provisional = 0
           AND (valid_until IS NULL OR valid_until > ?)`,
        )
        .all(tenant, ...ids, now)
    ).map((r) => rowToClaim(r as ClaimRow));
    const dropped = ids.length - rows.length;
    if (dropped > 0) {
      await audit(tenant, 'ledger', 'CONTEXT_DROPPED_UNUSABLE', ids.join(','), `${dropped} claim(s) not usable`);
    }
    return rows;
  }

  /** I5 — staleness is computed on a sweep, not felt. */
  async function markStale(tenant: string, now: string): Promise<string[]> {
    // Chunked sweep: each round selects and updates at most SWEEP_BATCH ids,
    // so neither the SELECT nor the IN (...) update ever grows with history.
    // MAX_SWEEP_BATCHES bounds total work per call (the sweep terminates);
    // the audit carries a count, not the id list, so it stays bounded too.
    const SWEEP_BATCH = 500;
    const MAX_SWEEP_BATCHES = 1_000;
    const done: string[] = [];
    return db.transaction(async () => {
      for (let round = 0; round < MAX_SWEEP_BATCHES; round++) {
        const rows = (await db
          .prepare(
            `SELECT id FROM claims WHERE tenant = ? AND status = 'VERIFIED'
               AND valid_until IS NOT NULL AND valid_until <= ? LIMIT ?`,
          )
          .all(tenant, now, SWEEP_BATCH)) as { id: string }[];
        if (rows.length === 0) break;
        const ids = rows.map((r) => String(r.id));
        const ph = ids.map(() => '?').join(',');
        await db.prepare(`UPDATE claims SET status = 'STALE' WHERE tenant = ? AND id IN (${ph})`).run(tenant, ...ids);
        done.push(...ids);
        if (rows.length < SWEEP_BATCH) break;
      }
      if (done.length > 0) {
        await audit(tenant, 'ledger', 'STALENESS_SWEEP', `${done.length}`, `${done.length} claim(s) marked STALE`);
      }
      return done;
    });
  }

  function hashEntry(
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

  async function recordDecision(input: NewDecisionInput): Promise<DecisionRecord> {
    const d = newDecisionSchema.parse(input);
    const now = d.now ?? new Date().toISOString();
    if (d.claimIds.length === 0) {
      throw new LedgerError(
        'UNGROUNDED_DECISION',
        'a decision with no cited basis is refused: cite the claims it was made on',
      );
    }
    // ACT_IRREVERSIBLE is human-command, always (R/A/I matrix, year-1 rule).
    if (d.actionClass === 'ACT_IRREVERSIBLE') {
      if (d.autonomy !== 'human-command') {
        throw new LedgerError(
          'AUTONOMY_VIOLATION',
          `actionClass=ACT_IRREVERSIBLE requires autonomy=human-command, got ${d.autonomy}`,
        );
      }
      if (!d.approvedBy) {
        throw new LedgerError('APPROVAL_REQUIRED', 'ACT_IRREVERSIBLE decisions require a named human approver');
      }
    }
    const frozen = await db.transaction(async () => {
      const entries: ContextBundleEntry[] = [];
      for (const id of d.claimIds) {
        const c = await get(d.tenant, id);
        if (!c) throw new LedgerError('MISSING_CLAIM', `decision basis cites unknown claim ${id}`);
        entries.push({
          id: c.id,
          seq: c.seq,
          kind: c.kind,
          statement: c.statement,
          status: c.status,
          confidence: c.confidence,
          hash: hashEntry(c.id, c.seq, c.kind, c.statement, c.status, c.confidence),
        });
      }
      const bundle: ContextBundle = {
        version: 1,
        frozenAt: now,
        claims: entries,
        bundleHash: createHash('sha256')
          .update([now, ...entries.map((e) => e.hash)].join('|'))
          .digest('hex'),
      };
      const id = d.id ?? `dec_${crypto.randomUUID()}`;
      await db
        .prepare(
          `INSERT INTO decisions
           (id, tenant, goal, action, action_class, context_bundle, decided_by,
            approved_by, scope, autonomy, request_id, signed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          d.tenant,
          d.goal,
          d.action,
          d.actionClass,
          JSON.stringify(bundle),
          d.decidedBy,
          d.approvedBy ?? null,
          d.scope,
          d.autonomy,
          d.requestId ?? null,
          now,
        );
      await audit(d.tenant, `decision:${d.scope}`, 'DECISION_RECORD', id, `${d.actionClass} ${d.goal}`);
      return { id, bundle };
    });
    const rec = await getDecision(d.tenant, frozen.id);
    if (!rec) throw new LedgerError('DECISION_LOST', `decision ${frozen.id} vanished after write`);
    return rec;
  }

  function rowToDecision(r: DecisionRow): DecisionRecord {
    return {
      id: String(r.id),
      tenant: String(r.tenant),
      goal: String(r.goal),
      action: String(r.action),
      actionClass: String(r.action_class) as DecisionRecord['actionClass'],
      bundle: JSON.parse(String(r.context_bundle)) as ContextBundle,
      decidedBy: String(r.decided_by),
      approvedBy: r.approved_by == null ? null : String(r.approved_by),
      scope: String(r.scope),
      autonomy: String(r.autonomy) as AutonomyLevel,
      requestId: r.request_id == null ? null : String(r.request_id),
      signedAt: String(r.signed_at),
    };
  }

  async function getDecision(tenant: string, id: string): Promise<DecisionRecord | null> {
    const r = (await db.prepare('SELECT * FROM decisions WHERE id = ? AND tenant = ?').get(id, tenant)) as
      DecisionRow | undefined;
    return r ? rowToDecision(r) : null;
  }

  async function getDecisionByRequest(tenant: string, requestId: string): Promise<DecisionRecord | null> {
    const r = (await db
      .prepare('SELECT * FROM decisions WHERE tenant = ? AND request_id = ? ORDER BY signed_at DESC, id DESC LIMIT 1')
      .get(tenant, requestId)) as DecisionRow | undefined;
    return r ? rowToDecision(r) : null;
  }

  async function replayDecision(tenant: string, id: string): Promise<DecisionReplay> {
    const rec = await getDecision(tenant, id);
    if (!rec) throw new LedgerError('MISSING_DECISION', `unknown decision ${id}`);
    // Integrity first: the bundle must verify before it means anything.
    const recomputed = createHash('sha256')
      .update([rec.bundle.frozenAt, ...rec.bundle.claims.map((e) => e.hash)].join('|'))
      .digest('hex');
    if (recomputed !== rec.bundle.bundleHash) {
      throw new LedgerError('TAMPERED_BUNDLE', `context bundle for ${id} fails its hash — do not trust this replay`);
    }
    for (const e of rec.bundle.claims) {
      const eh = hashEntry(e.id, e.seq, e.kind, e.statement, e.status, e.confidence);
      if (eh !== e.hash) {
        throw new LedgerError('TAMPERED_BUNDLE', `bundle entry ${e.id} fails its hash`);
      }
    }
    const drift: DecisionDrift[] = [];
    for (const e of rec.bundle.claims) {
      const live = await get(tenant, e.id);
      const moved = !live || live.status !== e.status || live.seq !== e.seq;
      drift.push({
        id: e.id,
        frozenStatus: e.status,
        currentStatus: live ? live.status : null,
        frozenSeq: e.seq,
        currentSeq: live ? live.seq : null,
        drifted: moved,
      });
    }
    return { record: rec, drift };
  }

  async function recordOutcome(input: NewOutcomeInput): Promise<OutcomeRecord> {
    const o = newOutcomeSchema.parse(input);
    const now = o.now ?? new Date().toISOString();
    const dec = await getDecision(o.tenant, o.decisionId);
    if (!dec) throw new LedgerError('MISSING_DECISION', `outcome cites unknown decision ${o.decisionId}`);
    const id = o.id ?? `out_${crypto.randomUUID()}`;
    return db.transaction(async () => {
      await db
        .prepare(
          `INSERT INTO outcomes
           (id, tenant, decision_id, metric, predicted, actual, basis, holdout_ref, resolved_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          o.tenant,
          o.decisionId,
          o.metric,
          o.predicted ?? null,
          o.actual,
          o.basis,
          o.holdoutRef ?? null,
          now,
          now,
        );
      // The OUTCOME is also a ledger claim so it is queryable as ground truth.
      // OUTCOME is ground-only: written as system with MEASURED provenance.
      await append({
        tenant: o.tenant,
        subject: `decision:${o.decisionId}`,
        kind: 'OUTCOME',
        statement: `${o.metric}: predicted ${o.predicted ?? 'n/a'}, actual ${o.actual} (basis ${o.basis})`,
        value: { predicted: o.predicted ?? null, actual: o.actual, holdoutRef: o.holdoutRef ?? null },
        confidence: 1,
        owner: o.owner,
        scope: o.scope,
        authorType: 'system',
        observedAt: now,
        validFrom: now,
        now,
        provenance: {
          sourceUri: o.basis,
          sourceTier: 'MEASURED',
          extractor: 'outcome-recorder',
          extractorVersion: '1.0.0',
          retrievedAt: now,
        },
      });
      await audit(o.tenant, `outcome:${o.scope}`, 'OUTCOME_RECORD', id, `${o.metric}=${o.actual}`);
      return {
        id,
        tenant: o.tenant,
        decisionId: o.decisionId,
        metric: o.metric,
        predicted: o.predicted ?? null,
        actual: o.actual,
        basis: o.basis,
        holdoutRef: o.holdoutRef ?? null,
        resolvedAt: now,
      };
    });
  }

  async function supersedeChain(tenant: string, claimId: string): Promise<{ history: Claim[]; current: Claim | null }> {
    const start = await get(tenant, claimId);
    if (!start) throw new LedgerError('MISSING_CLAIM', `unknown claim ${claimId}`);
    const seen = new Set<string>([claimId]);
    const queue = [claimId];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      const rows = (await db
        .prepare(
          `SELECT from_id AS id, to_id AS other FROM claim_links WHERE from_id = ? AND link = 'supersedes'
           UNION SELECT to_id AS id, from_id AS other FROM claim_links WHERE to_id = ? AND link = 'supersedes'`,
        )
        .all(cur, cur)) as { id: string; other: string }[];
      for (const r of rows) {
        for (const cid of [String(r.id), String(r.other)]) {
          if (!seen.has(cid)) {
            seen.add(cid);
            queue.push(cid);
          }
        }
      }
    }
    const claims: Claim[] = [];
    for (const cid of [...seen]) {
      const c = await get(tenant, cid);
      if (c) claims.push(c);
    }
    claims.sort((a, b) => a.seq - b.seq);
    const live = claims.filter((c) => c.status !== 'SUPERSEDED' && c.status !== 'RETIRED');
    return { history: claims, current: live.length > 0 ? live[live.length - 1]! : null };
  }

  async function believedAt(tenant: string, subject: string, at: string): Promise<Claim[]> {
    return (
      await db
        .prepare(
          `SELECT * FROM claims WHERE tenant = ? AND subject = ?
           AND created_at <= ? AND valid_from <= ?
           AND (valid_until IS NULL OR valid_until > ?)
           AND status <> 'RETIRED' ORDER BY seq`,
        )
        .all(tenant, subject, at, at, at)
    ).map((r) => rowToClaim(r as ClaimRow));
  }

  async function duePredictions(tenant: string, now: string): Promise<Claim[]> {
    return (
      await db
        .prepare(
          `SELECT * FROM claims WHERE tenant = ? AND kind = 'PREDICTION'
           AND status NOT IN ('RETIRED','SUPERSEDED')
           AND valid_until IS NOT NULL AND valid_until <= ? ORDER BY valid_until`,
        )
        .all(tenant, now)
    ).map((r) => rowToClaim(r as ClaimRow));
  }

  async function voidPrediction(tenant: string, id: string, now: string): Promise<void> {
    const c = await get(tenant, id);
    if (!c) throw new LedgerError('MISSING_CLAIM', `unknown claim ${id}`);
    if (c.kind !== 'PREDICTION') throw new LedgerError('NOT_A_PREDICTION', `${id} is ${c.kind}, not PREDICTION`);
    await db.transaction(async () => {
      await db.prepare("UPDATE claims SET status = 'RETIRED' WHERE id = ? AND tenant = ?").run(id, tenant);
      await audit(tenant, 'ledger', 'PREDICTION_VOID', id, `voided at ${now}: will never resolve`);
    });
  }

  async function disputedPairs(tenant: string): Promise<{ a: Claim; b: Claim }[]> {
    const rows = (await db
      .prepare(
        `SELECT DISTINCT l.from_id AS x, l.to_id AS y FROM claim_links l
          JOIN claims ca ON ca.id = l.from_id AND ca.tenant = ?
          JOIN claims cb ON cb.id = l.to_id AND cb.tenant = ?
          WHERE l.link = 'contradicts'
            AND ca.status NOT IN ('RETIRED','SUPERSEDED')
            AND cb.status NOT IN ('RETIRED','SUPERSEDED')`,
      )
      .all(tenant, tenant)) as { x: string; y: string }[];
    const out: { a: Claim; b: Claim }[] = [];
    for (const r of rows) {
      const a = await get(tenant, String(r.x));
      const b = await get(tenant, String(r.y));
      if (a && b) out.push({ a, b });
    }
    return out;
  }

  async function resolveDispute(
    tenant: string,
    idA: string,
    idB: string,
    winnerId: string,
    rationale: string,
    by: string,
    _now: string,
  ): Promise<{ winner: Claim; loser: Claim }> {
    if (winnerId !== idA && winnerId !== idB) {
      throw new LedgerError('INVALID_WINNER', `winner ${winnerId} must be one of the disputed claims (${idA}, ${idB})`);
    }
    const loserId = winnerId === idA ? idB : idA;
    const a = await get(tenant, idA);
    const b = await get(tenant, idB);
    if (!a || !b) throw new LedgerError('MISSING_CLAIM', 'both claims must exist to resolve dispute');
    return db.transaction(async () => {
      // Winner is restored to VERIFIED if it was DISPUTED
      await db
        .prepare("UPDATE claims SET status = 'VERIFIED' WHERE id = ? AND tenant = ? AND status = 'DISPUTED'")
        .run(winnerId, tenant);
      // Loser is marked SUPERSEDED
      await db.prepare("UPDATE claims SET status = 'SUPERSEDED' WHERE id = ? AND tenant = ?").run(loserId, tenant);
      // Link winner supersedes loser
      await link(tenant, winnerId, loserId, 'supersedes');
      await audit(tenant, by, 'DISPUTE_RESOLVED', `${idA}<>${idB}`, `winner=${winnerId}; rationale=${rationale}`);
      const winner = (await get(tenant, winnerId))!;
      const loser = (await get(tenant, loserId))!;
      return { winner, loser };
    });
  }

  async function resolvePrediction(
    tenant: string,
    id: string,
    outcome: {
      statement: string;
      value?: number | null;
      unit?: string | null;
      confidence?: number;
      refuted?: boolean;
    },
    by: string,
    now: string,
  ): Promise<{ prediction: Claim; outcomeClaim: Claim }> {
    const p = await get(tenant, id);
    if (!p) throw new LedgerError('MISSING_CLAIM', `unknown claim ${id}`);
    if (p.kind !== 'PREDICTION') throw new LedgerError('NOT_A_PREDICTION', `${id} is ${p.kind}, not PREDICTION`);
    return db.transaction(async () => {
      const outcomeClaim = await append({
        tenant,
        subject: p.subject,
        kind: 'FACT',
        statement: outcome.statement,
        value: outcome.value ?? null,
        unit: outcome.unit ?? null,
        confidence: outcome.confidence ?? 1.0,
        owner: p.owner,
        scope: p.scope,
        authorType: 'system',
        observedAt: now,
        validFrom: now,
        now,
        provenance: {
          sourceUri: `prediction-resolution:${id}`,
          sourceTier: 'MEASURED',
          extractor: 'prediction-resolver',
          extractorVersion: '1.0.0',
          retrievedAt: now,
        },
      });
      await link(tenant, outcomeClaim.id, id, 'supersedes');
      await db.prepare("UPDATE claims SET status = 'RETIRED' WHERE id = ? AND tenant = ?").run(id, tenant);
      await audit(
        tenant,
        by,
        'PREDICTION_RESOLVED',
        `${id}->${outcomeClaim.id}`,
        `outcome=${outcomeClaim.id}; refuted=${Boolean(outcome.refuted)}`,
      );
      const updatedP = (await get(tenant, id))!;
      return { prediction: updatedP, outcomeClaim };
    });
  }

  async function dueVerifications(tenant: string, now: string, horizonMs: number): Promise<Claim[]> {
    const horizon = new Date(Date.parse(now) + horizonMs).toISOString();
    return (
      await db
        .prepare(
          `SELECT * FROM claims WHERE tenant = ? AND kind = 'FACT' AND status = 'VERIFIED'
           AND valid_until IS NOT NULL AND valid_until > ? AND valid_until <= ?
         ORDER BY valid_until`,
        )
        .all(tenant, now, horizon)
    ).map((r) => rowToClaim(r as ClaimRow));
  }

  const correctionDraftKey = (tenant: string, claimId: string, actor: string) =>
    `correction_draft:${tenant}:${claimId}:${actor}`;

  async function preserveCorrectionDraft(
    tenant: string,
    claimId: string,
    by: string,
    draft: { statement: string; expectedSeq?: number; at: string },
  ): Promise<void> {
    await db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(correctionDraftKey(tenant, claimId, by), JSON.stringify(draft));
  }

  async function getCorrectionDraft(
    tenant: string,
    claimId: string,
    by: string,
  ): Promise<{ statement: string; expectedSeq?: number; at: string } | null> {
    const row = (await db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(correctionDraftKey(tenant, claimId, by))) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.value)) as { statement: string; expectedSeq?: number; at: string };
    } catch {
      return null;
    }
  }

  async function supersedingClaim(tenant: string, claimId: string): Promise<Claim | null> {
    const row = (await db
      .prepare("SELECT from_id AS id FROM claim_links WHERE to_id = ? AND link = 'supersedes' LIMIT 1")
      .get(claimId)) as { id: string } | undefined;
    return row ? await get(tenant, String(row.id)) : null;
  }

  async function currentReplacement(tenant: string, claimId: string): Promise<Claim | null> {
    const { current } = await supersedeChain(tenant, claimId);
    return current;
  }

  async function conflictFor(
    tenant: string,
    old: Claim,
    by: string,
    statement: string,
    expectedSeq?: number,
    now?: string,
  ): Promise<CorrectionConflict> {
    const winner = (await supersedingClaim(tenant, old.id)) ?? (await currentReplacement(tenant, old.id));
    const at = now ?? new Date().toISOString();
    await preserveCorrectionDraft(tenant, old.id, by, { statement, expectedSeq, at });
    const preserved = await getCorrectionDraft(tenant, old.id, by);
    return {
      expectedSeq,
      currentSeq: old.seq,
      current: old,
      winner: winner && winner.id !== old.id ? winner : undefined,
      diff: winner && winner.id !== old.id ? { before: old.statement, after: winner.statement } : undefined,
      preservedDraft: preserved ? { statement: preserved.statement, by, at: preserved.at } : undefined,
    };
  }

  async function correctClaim(
    tenant: string,
    id: string,
    statement: string,
    by: string,
    now: string,
    input?: CorrectionInput,
  ): Promise<CorrectionResult> {
    if (!statement) throw new LedgerError('EMPTY_CORRECTION', 'a correction with no statement corrects nothing');
    const patch = input?.patch;
    const expectedSeq = input?.expectedSeq;
    return db.transaction(async () => {
      const old = await get(tenant, id);
      if (!old) throw new LedgerError('MISSING_CLAIM', `unknown claim ${id}`);
      if (['SUPERSEDED', 'RETIRED'].includes(old.status)) {
        const detail = await conflictFor(tenant, old, by, statement, expectedSeq, now);
        throw new LedgerError(
          'VERSION_CONFLICT',
          `claim ${id} is ${old.status} — refresh and correct its current replacement`,
          detail,
        );
      }
      if (expectedSeq !== undefined && expectedSeq !== old.seq) {
        const detail = await conflictFor(tenant, old, by, statement, expectedSeq, now);
        throw new LedgerError(
          'VERSION_CONFLICT',
          `expected claim version seq ${expectedSeq}, current is ${old.seq}`,
          detail,
        );
      }
      // FLOW-003: one replacement per version — atomic CAS on (id, seq, status).
      const marked = await db
        .prepare(
          `UPDATE claims SET status = 'SUPERSEDED'
             WHERE id = ? AND tenant = ? AND seq = ? AND status NOT IN ('SUPERSEDED','RETIRED')`,
        )
        .run(id, tenant, old.seq);
      if (marked.changes === 0) {
        const current = (await get(tenant, id))!;
        const detail = await conflictFor(tenant, current, by, statement, expectedSeq, now);
        throw new LedgerError(
          'VERSION_CONFLICT',
          `claim ${id} was corrected by another editor — refresh and reconcile`,
          detail,
        );
      }
      // F22: Typed correction contract. If the human edits prose without explicitly
      // supplying a new typed value, invalidate the old structured value/unit rather
      // than silently retaining stale numbers for machine readers.
      const hasExplicitValue = patch && 'value' in patch && patch.value !== undefined;
      const statementChanged = statement.trim() !== old.statement.trim();
      let resolvedValue = old.value;
      let resolvedUnit: string | null | undefined = old.unit;
      if (hasExplicitValue) {
        resolvedValue = patch.value;
        resolvedUnit = patch.unit ?? (patch.value === null ? null : old.unit);
      } else if (statementChanged) {
        resolvedValue = null;
        resolvedUnit = null;
      }
      const resolvedConfidence = patch?.confidence ?? old.confidence;
      const resolvedValidUntil = patch?.validUntil !== undefined ? patch.validUntil : old.validUntil;

      const neu = await append({
        tenant,
        subject: old.subject,
        kind: old.kind,
        statement,
        value: resolvedValue,
        unit: resolvedUnit,
        confidence: resolvedConfidence,
        owner: old.owner,
        scope: old.scope,
        authorType: 'human',
        observedAt: now,
        validFrom: now,
        validUntil: resolvedValidUntil,
        now,
        provenance: {
          sourceUri: `correction:${id}`,
          sourceTier: old.provenance.sourceTier,
          extractor: 'human-correction',
          extractorVersion: '1.0.0',
          retrievedAt: now,
        },
      });
      await db
        .prepare(
          'INSERT INTO claim_links (from_id, to_id, link) VALUES (?,?,?) ON CONFLICT(from_id, to_id, link) DO NOTHING',
        )
        .run(neu.id, old.id, 'supersedes');
      await audit(tenant, by, 'CLAIM_CORRECTED', `${old.id}->${neu.id}`, old.statement);
      return { claim: neu, supersededId: old.id };
    });
  }

  /**
   * The governed step between "the system observed something" and "the
   * organisation may reason on it" (idea §1.1 curation, made explicit).
   *
   * Only CANDIDATE may be verified, and only by a named human: DISPUTED has a
   * contradiction to resolve, STALE has an expired source to re-check, and
   * SUPERSEDED/RETIRED are history. Verifying a provisional claim clears the
   * provisional flag — I6 protects against acting on unreviewed inference,
   * and this human review is precisely that review.
   */
  async function verifyClaim(tenant: string, id: string, verifiedBy: string, now?: string): Promise<Claim> {
    const at = now ?? new Date().toISOString();
    const c = await get(tenant, id);
    if (!c) throw new LedgerError('MISSING_CLAIM', `unknown claim ${id}`);
    if (c.status === 'VERIFIED') return c;
    if (c.status !== 'CANDIDATE') {
      throw new LedgerError(
        'UNVERIFIABLE_STATUS',
        `claim ${id} is ${c.status}; only CANDIDATE may be verified (resolve, re-check, or supersede instead)`,
      );
    }
    return db.transaction(async () => {
      await db
        .prepare("UPDATE claims SET status = 'VERIFIED', verified_at = ?, provisional = 0 WHERE id = ? AND tenant = ?")
        .run(at, id, tenant);
      await audit(tenant, verifiedBy, 'CLAIM_VERIFIED', id, c.statement);
      const updated = await get(tenant, id);
      if (!updated) throw new LedgerError('CLAIM_LOST', `claim ${id} vanished after verification`);
      return updated;
    });
  }

  async function correctionCount(tenant: string): Promise<number> {
    return (
      (await db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ? AND action = 'CLAIM_CORRECTED'`)
        .get(tenant)) as {
        n: number;
      }
    ).n;
  }

  // ---- entity/subject registry (TODO 1.1) ---------------------------------

  /**
   * Alias normalization: trim + lowercase, so " Acme " and "acme" are one
   * identity. Applied on write (upsertSubject) and on read
   * (subjectResolve) alike — the alias table only ever holds normalized
   * forms, which is what makes the lookup an exact match instead of a
   * substring scan.
   */
  const aliasNorm = (a: string): string => a.trim().toLowerCase();

  /** Insert alias rows; a conflicting alias owned by another subject is a
   *  hard refusal — fuzzy suggests, never silently merges. */
  async function claimAliases(tenant: string, subjectId: string, norms: string[]): Promise<void> {
    for (const norm of norms) {
      if (!norm) continue;
      const owner = (await db
        .prepare('SELECT subject_id FROM subject_aliases WHERE tenant = ? AND alias_norm = ?')
        .get(tenant, norm)) as { subject_id: string } | undefined;
      if (owner && String(owner.subject_id) !== subjectId) {
        throw new LedgerError(
          'AMBIGUOUS_ALIAS',
          `alias "${norm}" already resolves to another subject — refusing to merge two identities`,
        );
      }
      await db
        .prepare(
          'INSERT INTO subject_aliases (tenant, subject_id, alias_norm) VALUES (?,?,?) ON CONFLICT(tenant, alias_norm) DO NOTHING',
        )
        .run(tenant, subjectId, norm);
    }
  }

  const rowToSubject = (r: SubjectRow): Subject => ({
    id: String(r.id),
    tenant: String(r.tenant),
    key: String(r.key),
    displayName: String(r.display_name),
    kind: String(r.kind),
    aliases: JSON.parse(String(r.aliases_json ?? '[]')) as string[],
    createdAt: String(r.created_at),
  });

  /**
   * `subject` stops being a free string: this is the stable identity behind
   * it. Registration is idempotent per (tenant, key) — re-registering with
   * unchanged values is a no-op, new aliases merge into the set. Aliases are
   * case-insensitive at resolution time (lowercased here, query lowercased
   * there) so "Acme" and "acme" resolve to one entity.
   */
  async function upsertSubject(input: {
    tenant: string;
    key: string;
    displayName: string;
    kind: string;
    aliases?: string[];
    now?: string;
  }): Promise<Subject> {
    const s = upsertSubjectSchema.parse(input);
    const at = s.now ?? new Date().toISOString();
    const norms = [...new Set(s.aliases.map(aliasNorm).filter((a) => a.length > 0))];
    return db.transaction(async () => {
      const existing = (await db
        .prepare('SELECT * FROM subjects WHERE tenant = ? AND key = ?')
        .get(s.tenant, s.key)) as SubjectRow | undefined;
      if (existing) {
        const merged = [...new Set([...(JSON.parse(String(existing.aliases_json ?? '[]')) as string[]), ...norms])];
        // Claim alias rows before persisting: an alias owned elsewhere
        // refuses here, before any merge could silently steal it.
        await claimAliases(s.tenant, String(existing.id), norms);
        if (
          existing.display_name === s.displayName &&
          existing.kind === s.kind &&
          merged.length === (JSON.parse(String(existing.aliases_json ?? '[]')) as string[]).length
        ) {
          return rowToSubject(existing);
        }
        await db
          .prepare('UPDATE subjects SET display_name = ?, kind = ?, aliases_json = ? WHERE id = ?')
          .run(s.displayName, s.kind, JSON.stringify(merged), String(existing.id));
        await audit(s.tenant, 'system', 'SUBJECT_UPDATED', String(existing.id), s.key);
        return rowToSubject({
          ...existing,
          display_name: s.displayName,
          kind: s.kind,
          aliases_json: JSON.stringify(merged),
        });
      }
      const id = `sub_${crypto.randomUUID()}`;
      await db
        .prepare(
          'INSERT INTO subjects (id, tenant, key, display_name, kind, aliases_json, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, s.tenant, s.key, s.displayName, s.kind, JSON.stringify(norms), at);
      await claimAliases(s.tenant, id, norms);
      await audit(s.tenant, 'system', 'SUBJECT_REGISTERED', id, s.key);
      return {
        id,
        tenant: s.tenant,
        key: s.key,
        displayName: s.displayName,
        kind: s.kind,
        aliases: norms,
        createdAt: at,
      };
    });
  }

  async function subjectByKey(tenant: string, key: string): Promise<Subject | null> {
    const row = (await db.prepare('SELECT * FROM subjects WHERE tenant = ? AND key = ?').get(tenant, key)) as
      SubjectRow | undefined;
    return row ? rowToSubject(row) : null;
  }

  async function subjectResolve(tenant: string, keyOrAlias: string): Promise<Subject | null> {
    const byKey = await subjectByKey(tenant, keyOrAlias);
    if (byKey) return byKey;
    // Exact normalized-alias hit first: indexed equality, no wildcards.
    const norm = aliasNorm(keyOrAlias);
    const hit = (await db
      .prepare('SELECT subject_id FROM subject_aliases WHERE tenant = ? AND alias_norm = ?')
      .get(tenant, norm)) as { subject_id: string } | undefined;
    if (hit) {
      const row = (await db
        .prepare('SELECT * FROM subjects WHERE tenant = ? AND id = ?')
        .get(tenant, String(hit.subject_id))) as SubjectRow | undefined;
      if (row) return rowToSubject(row);
    }
    // Legacy fallback for subjects registered before the alias table
    // existed (their aliases live only in aliases_json). Best-effort
    // suggestion path only: it must never be used to merge identities —
    // only upsertSubject's UNIQUE-guarded claim can attach an alias.
    const row = (await db
      .prepare('SELECT * FROM subjects WHERE tenant = ? AND aliases_json LIKE ? LIMIT 1')
      .get(tenant, `%"${keyOrAlias.toLowerCase()}"%`)) as SubjectRow | undefined;
    return row ? rowToSubject(row) : null;
  }

  /**
   * Novelty as SQL EXISTS: one indexed probe instead of hydrating every
   * live claim for the subject into memory and comparing in JS.
   *
   * No statement-hash column by design: adding one to append-only rows
   * would leave every historical row NULL (a backfill rewrites history,
   * which append-only forbids; lazy computation splits the read path in
   * two). Direct (tenant, subject, statement) equality uses columns that
   * already exist on both engines and answers the exact question asked.
   */
  async function hasLiveClaim(tenant: string, subject: string, statement: string): Promise<boolean> {
    const row = (await db
      .prepare(
        `SELECT 1 AS one FROM claims WHERE tenant = ? AND subject = ? AND statement = ?
           AND status NOT IN ('RETIRED','STALE','SUPERSEDED') LIMIT 1`,
      )
      .get(tenant, subject, statement)) as { one: number } | undefined;
    return row !== undefined;
  }

  async function listSubjects(tenant: string, kind?: string): Promise<Subject[]> {
    const rows = kind
      ? ((await db
          .prepare('SELECT * FROM subjects WHERE tenant = ? AND kind = ? ORDER BY key')
          .all(tenant, kind)) as SubjectRow[])
      : ((await db.prepare('SELECT * FROM subjects WHERE tenant = ? ORDER BY key').all(tenant)) as SubjectRow[]);
    return rows.map(rowToSubject);
  }

  async function stats(tenant: string, now: string): Promise<LedgerStats> {
    const all = (await db.prepare('SELECT * FROM claims WHERE tenant = ?').all(tenant)).map((r) =>
      rowToClaim(r as ClaimRow),
    );
    const byKind: Record<string, number> = {};
    let verified = 0,
      candidate = 0,
      disputed = 0,
      stale = 0,
      superseded = 0,
      orphan = 0,
      ungrounded = 0,
      provisional = 0,
      facts = 0,
      staleFacts = 0;
    for (const c of all) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      if (c.status === 'VERIFIED') verified += 1;
      if (c.status === 'CANDIDATE') candidate += 1;
      if (c.status === 'DISPUTED') disputed += 1;
      if (c.status === 'STALE') stale += 1;
      if (c.status === 'SUPERSEDED') superseded += 1;
      if (!c.owner) orphan += 1;
      if (c.provisional) provisional += 1;
      if (c.kind === 'FACT' || c.kind === 'MEASUREMENT') {
        facts += 1;
        if (!GROUND_TIERS.includes(c.provenance.sourceTier)) ungrounded += 1;
        // Count once: after a sweep a claim is BOTH past TTL and status STALE.
        if (c.status === 'STALE' || (c.validUntil && c.validUntil <= now)) staleFacts += 1;
      }
    }
    return {
      total: all.length,
      verified,
      candidate,
      disputed,
      stale,
      superseded,
      byKind,
      orphanClaims: orphan,
      factsWithoutGroundProvenance: ungrounded,
      staleFactRate: facts === 0 ? 0 : staleFacts / facts,
      provisionalCount: provisional,
    };
  }

  return {
    append,
    get,
    bySubject,
    link,
    contradictions,
    contextFor,
    markStale,
    stats,
    recordDecision,
    getDecision,
    getDecisionByRequest,
    replayDecision,
    recordOutcome,
    supersedeChain,
    believedAt,
    duePredictions,
    voidPrediction,
    resolvePrediction,
    disputedPairs,
    resolveDispute,
    dueVerifications,
    correctClaim,
    supersedingClaim,
    currentReplacement,
    verifyClaim,
    correctionCount,
    upsertSubject,
    subjectByKey,
    subjectResolve,
    hasLiveClaim,
    listSubjects,
  };
}

/** Weakest link wins: a set of claims is only as trustworthy as its worst tier. */
export function weakestTier(claims: Claim[]): SourceTier {
  if (claims.length === 0) return 'SINGLE_SOURCE';
  let worst: SourceTier = claims[0]!.provenance.sourceTier;
  for (const c of claims) {
    const t = c.provenance.sourceTier;
    if (TIER_RANK[t] > TIER_RANK[worst]) worst = t;
  }
  return worst;
}
