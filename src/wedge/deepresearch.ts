import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ModelProfile } from '../substrate/models.ts';
import { WedgeError } from './ship.ts';

/**
 * Deep research, agentic edition: plan → human approves the plan →
 * multi-step search with cross-referencing → cited report with
 * unsupported-claim and contradiction checks.
 *
 * Status vocabulary:
 *   PLANNED      — plan created, not yet approved
 *   APPROVED     — plan approved, ready to run
 *   RUNNING      — execution in progress (has execution lease)
 *   COMPLETED    — all sub-questions answered within budget
 *   PAUSED_BUDGET — budget hit before all sub-questions answered; resumable
 *   CANCELLED    — cancelled by a named actor; completed steps are preserved
 */

export type ResearchStatus =
  'PLANNED' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'PAUSED_BUDGET' | 'FAILED' | 'CANCELLED';

export interface SearchHit {
  uri: string;
  title: string;
  snippet: string;
}

export type SearchFn = (subquestion: string) => Promise<SearchHit[]>;

/** Per-subquestion coverage statistics recorded during execution. */
export interface SubquestionCoverage {
  subquestion: string;
  /** True if the step ran but produced zero acceptable findings. */
  noResults: boolean;
  /** Number of results accepted (banked as findings). */
  accepted: number;
}

/** Aggregate rejection counts for the run. */
export interface RejectionCounts {
  /** URIs rejected due to blocklist. */
  blocklist: number;
  /** URIs skipped because they were previously seen (counted as corroboration). */
  corroborated: number;
  /** URIs skipped due to allowlist filtering. */
  allowlist: number;
  /** URIs skipped due to per-question result cap. */
  capped: number;
}

export interface ResearchRun {
  id: string;
  revision?: number;
  executionToken?: string | null;
  failure?: { code: string; subquestion: string | null } | null;
  tenant: string;
  question: string;
  subquestions: string[];
  allowlist: string[];
  blocklist: string[];
  status: ResearchStatus;
  approvedBy: string | null;
  /** Approved plan budgets (persisted to prevent per-call reset on resume). */
  approvedBudgets?: Partial<ResearchBudgets>;
  /** Actor who cancelled the run; null if not cancelled. */
  cancelledBy: string | null;
  completedSteps: string[];
  findingIds: string[];
  seenUris: string[];
  /** URIs observed more than once (corroboration evidence). */
  corroboratedUris: string[];
  /**
   * Maps URI → subquestions that encountered it (first banked + corroborations).
   * Enables bibliography entries to know which questions a source answered.
   */
  uriSubquestions: Record<string, string[]>;
  /**
   * Per-subquestion coverage: records zero-result steps for gap analysis.
   */
  coverage: SubquestionCoverage[];
  /** Aggregate rejection counts. */
  rejected: RejectionCounts;
  /**
   * Cumulative search count across all execution attempts including resumes.
   * Persisted so budget is never accidentally reset on re-entry.
   */
  totalSearches: number;
  /** Execution owner (actor id) holding the current execution lease. */
  executionOwner: string | null;
  /** ISO timestamp when the execution lease was claimed. */
  executionLeaseAt: string | null;
  /** ISO timestamp of last update (for lease staleness checks). */
  updatedAt: string | null;
  report: ResearchReport | null;
  createdAt: string;
}

export interface ReportBullet {
  text: string;
  /** Absent or empty = recommendation without direct evidence (inference). */
  claimIds?: string[];
  /** Explicitly labeled inference bullets attach without citations. */
  kind?: 'inference';
}

export interface ResearchReport {
  question: string;
  sections: { heading: string; bullets: ReportBullet[] }[];
  /**
   * Bibliography: only claims actually cited in section bullets.
   * Each entry records which subquestions that source answered.
   */
  sources: { claimId: string; uri: string; subquestions: string[] }[];
  /**
   * Sub-questions that completed execution but produced zero findings.
   */
  gaps: string[];
  /** Claim IDs under active contradiction in the ledger. */
  contradictions: string[];
  /**
   * Bullet indices (0-based) that are labeled inferences (no citations,
   * kind = 'inference'). These are valid in the report but are not findings.
   */
  inferences: number[];
  /** Aggregate rejection counts from the run (for transparency). */
  rejectedSources: RejectionCounts;
  /** Per-subquestion coverage preserved in the report artifact. */
  coverage: SubquestionCoverage[];
}

export interface ResearchProgress {
  completedSteps: string[];
  remainingQuestions: string[];
  searchesUsed: number;
  gaps: string[];
}

const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

function hostOf(uri: string): string {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Deterministic fingerprint over a plan (question + sorted subquestions). */
export function planFingerprint(question: string, subquestions: string[]): string {
  const sorted = [...subquestions].sort();
  const payload = JSON.stringify({ question: question.trim(), subquestions: sorted });
  // Simple stable hash — not cryptographic; for drift detection only.
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  }
  return `pfp_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Compute resumable progress statistics from a run. */
export function researchProgress(run: ResearchRun): ResearchProgress {
  const gaps = run.coverage.filter((c) => c.noResults).map((c) => c.subquestion);
  const remainingQuestions = run.subquestions.filter((s) => !run.completedSteps.includes(s));
  return {
    completedSteps: run.completedSteps,
    remainingQuestions,
    searchesUsed: run.totalSearches,
    gaps,
  };
}

/** Stage 0 — plan. A plan with no sub-questions plans nothing. */
export function createResearchRun(
  tenant: string,
  question: string,
  subquestions: string[],
  opts: { allowlist?: string[]; blocklist?: string[]; now?: string; id?: string } = {},
): ResearchRun {
  if (!question.trim()) throw new WedgeError('EMPTY_QUESTION', 'research with no question researches nothing');
  const subs = [...new Set(subquestions.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (subs.length === 0)
    throw new WedgeError(
      'EMPTY_PLAN',
      'a research plan with no sub-questions is not a plan — review and edit before it begins',
    );
  const now = opts.now ?? new Date().toISOString();
  return {
    id: opts.id ?? `rsr_${crypto.randomUUID()}`,
    tenant,
    question,
    subquestions: subs,
    allowlist: [...(opts.allowlist ?? [])],
    blocklist: [...(opts.blocklist ?? [])],
    status: 'PLANNED',
    approvedBy: null,
    cancelledBy: null,
    completedSteps: [],
    findingIds: [],
    seenUris: [],
    corroboratedUris: [],
    uriSubquestions: {},
    coverage: [],
    rejected: { blocklist: 0, corroborated: 0, allowlist: 0, capped: 0 },
    totalSearches: 0,
    executionOwner: null,
    executionLeaseAt: null,
    updatedAt: null,
    report: null,
    createdAt: now,
  };
}

/** The plan is reviewed and edited BEFORE anything runs. */
export function approveResearchPlan(run: ResearchRun, by: string): ResearchRun {
  if (run.status !== 'PLANNED')
    throw new WedgeError('BAD_PLAN_STATE', `plan is ${run.status}, not PLANNED — only a fresh plan is approved`);
  if (!by) throw new WedgeError('NO_APPROVER', 'a research plan without a named approver never runs');
  return { ...run, status: 'APPROVED', approvedBy: by };
}

/**
 * Cancel from any active state. Completed research survives cancellation
 * (COMPLETED is terminal). The cancelling actor is recorded.
 *
 * Synchronous form: cancelResearchRun(run, by) — returns ResearchRun.
 * Async form: cancelResearchRun(run, by, { db, now }) — persists and returns Promise<ResearchRun>.
 */
export function cancelResearchRun(run: ResearchRun, by: string): ResearchRun;
export function cancelResearchRun(
  run: ResearchRun,
  by: string,
  opts: { db: AsyncDb; now: string },
): Promise<ResearchRun>;
export function cancelResearchRun(
  run: ResearchRun,
  by: string,
  opts?: { db?: AsyncDb; now?: string },
): ResearchRun | Promise<ResearchRun> {
  if (opts?.db && opts.now) return cancelPersistedResearchRun(opts.db, run, by, opts.now);
  if (!by.trim()) throw new WedgeError('NO_CANCELLER', 'cancellation requires a named actor');
  if (run.status === 'COMPLETED') throw new WedgeError('BAD_PLAN_STATE', 'a completed run is history, not cancellable');
  if (run.status === 'CANCELLED') return run;
  return {
    ...run,
    status: 'CANCELLED',
    cancelledBy: by,
    executionOwner: null,
    executionToken: null,
    executionLeaseAt: null,
    updatedAt: opts?.now ?? null,
  };
}

export async function cancelPersistedResearchRun(
  db: AsyncDb,
  run: ResearchRun,
  by: string,
  now: string,
): Promise<ResearchRun> {
  for (;;) {
    const stored = await loadResearchRun(db, run.tenant, run.id);
    if (stored?.status === 'CANCELLED') return stored;
    const cancelled = { ...cancelResearchRun(stored ?? run, by), updatedAt: now };
    try {
      await persistResearchRun(db, cancelled);
      return cancelled;
    } catch (error) {
      if (!(error instanceof WedgeError) || !error.message.includes('REVISION_CONFLICT')) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Durable persistence layer
// ---------------------------------------------------------------------------

const runKeyOf = (tenant: string, id: string): string => `research:run:${tenant}:${id}`;

/** Persist a run to durable storage (upsert). */
export async function persistResearchRun(db: AsyncDb, run: ResearchRun): Promise<void> {
  const revision = (run.revision ?? 0) + 1;
  await db.transaction(async () => {
    const key = runKeyOf(run.tenant, run.id);
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    const stored = row ? (JSON.parse(String(row.value)) as ResearchRun) : null;
    if (stored && stored.status !== 'PLANNED' && approvedPlan(stored) !== approvedPlan(run))
      throw new WedgeError('PLAN_MISMATCH', 'approved research plan is immutable');
    if (stored?.status === 'CANCELLED' && run.status !== 'CANCELLED')
      throw new WedgeError('RUN_CANCELLED', 'cancellation is terminal');
    if (stored?.status === 'COMPLETED' && run.status !== 'COMPLETED')
      throw new WedgeError('TERMINAL_CHECKPOINT', 'completed research is history');
    if (stored && (stored.revision ?? 0) !== (run.revision ?? 0))
      throw new WedgeError('REVISION_CONFLICT', 'research changed; reload before updating');
    if (!stored && (run.revision ?? 0) !== 0) throw new WedgeError('RUN_NOT_FOUND', 'persisted research is missing');
    const value = JSON.stringify({ ...run, revision });
    const result = row
      ? await db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(value, key, row.value)
      : await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value);
    if (result.changes !== 1) throw new WedgeError('REVISION_CONFLICT', 'research changed; reload before updating');
    await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)').run(
      run.tenant,
      run.cancelledBy ?? run.executionOwner ?? run.approvedBy ?? 'deep-research',
      'RESEARCH_CHECKPOINT',
      run.id,
      JSON.stringify({
        status: run.status,
        revision,
        stepsDone: run.completedSteps.length,
        totalSearches: run.totalSearches,
      }),
      run.updatedAt ?? run.createdAt,
    );
  });
  run.revision = revision;
}

function approvedPlan(run: ResearchRun): string {
  return JSON.stringify([
    run.question,
    run.subquestions,
    run.allowlist,
    run.blocklist,
    run.approvedBy,
    run.approvedBudgets?.maxSearches ?? 20,
    run.approvedBudgets?.maxResultsPerQuestion ?? 8,
  ]);
}

function checkedBudgets(budgets?: Partial<ResearchBudgets>): ResearchBudgets {
  const result = {
    maxSearches: budgets?.maxSearches ?? 20,
    maxResultsPerQuestion: budgets?.maxResultsPerQuestion ?? 8,
  };
  if (Object.values(result).some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new WedgeError('INVALID_BUDGET', 'research budgets must be nonnegative safe integers');
  return result;
}

/** Load a run from durable storage. Returns null if not found. */
export async function loadResearchRun(db: AsyncDb, tenant: string, id: string): Promise<ResearchRun | null> {
  try {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(runKeyOf(tenant, id))) as
      { value: string } | undefined;
    if (!r) return null;
    const run = JSON.parse(String(r.value)) as ResearchRun;
    return {
      ...run,
      corroboratedUris: run.corroboratedUris ?? [],
      uriSubquestions: run.uriSubquestions ?? {},
      coverage: run.coverage ?? [],
      rejected: run.rejected ?? { blocklist: 0, corroborated: 0, allowlist: 0, capped: 0 },
      cancelledBy: run.cancelledBy ?? null,
      executionOwner: run.executionOwner ?? null,
      executionToken: run.executionToken ?? null,
      executionLeaseAt: run.executionLeaseAt ?? null,
      failure: run.failure ?? null,
      updatedAt: run.updatedAt ?? null,
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new WedgeError('INVALID_CHECKPOINT', 'research checkpoint is malformed');
    throw error;
  }
}

/**
 * Approve the plan, persist the approved run and its fingerprint.
 * Returns the approved run.
 */
export async function approveAndPersistResearchPlan(
  db: AsyncDb,
  run: ResearchRun,
  by: string,
  now: string,
  budgets?: Partial<ResearchBudgets>,
): Promise<ResearchRun> {
  return db.transaction(async () => {
    const stored = await loadResearchRun(db, run.tenant, run.id);
    if (stored && stored.status !== 'PLANNED')
      throw new WedgeError('BAD_PLAN_STATE', 'an existing approved run cannot be reconstructed or reapproved');
    if (stored && (stored.revision ?? 0) !== (run.revision ?? 0))
      throw new WedgeError('REVISION_CONFLICT', 'reload the plan before approval');
    const approved = {
      ...approveResearchPlan(stored ?? run, by),
      approvedBudgets: checkedBudgets(budgets),
      updatedAt: now,
    };
    await persistResearchRun(db, approved);
    return approved;
  });
}

/**
 * Resume a durable run after a PAUSED_BUDGET stop.
 * Throws TERMINAL_CHECKPOINT if the run is COMPLETED or CANCELLED.
 * Throws RUN_CANCELLED if the run is CANCELLED.
 * Returns the run in APPROVED state so executeResearchRun can run it.
 */
export async function resumeResearchRun(
  db: AsyncDb,
  tenant: string,
  id: string,
  recovery?: { by: string; expectedRevision: number; now: string },
): Promise<ResearchRun> {
  const stored = await loadResearchRun(db, tenant, id);
  if (!stored) throw new WedgeError('RUN_NOT_FOUND', `research run ${id} not found in durable storage`);
  if (stored.status === 'CANCELLED')
    throw new WedgeError('RUN_CANCELLED', `run ${id} was cancelled by ${stored.cancelledBy ?? 'unknown'}`);
  if (recovery) {
    if (!recovery.by.trim()) throw new WedgeError('NO_RECOVERER', 'recovery requires a named actor');
    if (stored.revision !== recovery.expectedRevision)
      throw new WedgeError('REVISION_CONFLICT', 'reload before recovering research');
  }
  if (stored.status === 'COMPLETED') return stored;
  if (!stored.approvedBy || stored.status === 'PLANNED')
    throw new WedgeError('UNAPPROVED_RESEARCH', 'approve the stored plan before resuming');
  if ((stored.status === 'RUNNING' || stored.status === 'FAILED') && !recovery)
    throw new WedgeError('EXECUTION_CONFLICT', 'explicit recovery is required for interrupted or failed research');
  const resumed: ResearchRun = {
    ...stored,
    status: 'APPROVED',
    executionOwner: null,
    executionToken: null,
    executionLeaseAt: null,
    updatedAt: recovery?.now ?? stored.updatedAt,
  };
  await persistResearchRun(db, resumed);
  return resumed;
}

export interface ResearchBudgets {
  maxSearches: number;
  maxResultsPerQuestion: number;
}

// ---------------------------------------------------------------------------
// Stage 1 — execute
// ---------------------------------------------------------------------------

/**
 * Stage 1 — run. Each subquestion searches, filters allow/block lists,
 * dedupes URIs (corroborations tracked), and banks findings as OBSERVATIONs.
 *
 * Status after execution:
 * - COMPLETED     — all sub-questions answered within budget
 * - PAUSED_BUDGET — budget hit; remaining questions can be resumed
 * - CANCELLED     — cancelled by actor between steps
 *
 * Durable resume (opts.db):
 * - Checks stored run for terminal status → throws TERMINAL_CHECKPOINT
 * - Checks plan fingerprint mismatch → throws PLAN_MISMATCH
 * - Checks concurrent execution ownership → throws EXECUTION_CONFLICT
 * - Restores totalSearches from stored run for cumulative budget accounting
 */
export async function executeResearchRun(
  ledger: Ledger,
  run: ResearchRun,
  search: SearchFn,
  opts: {
    by: string;
    scope: string;
    now: string;
    budgets?: Partial<ResearchBudgets>;
    cancelled?: () => boolean;
    owner?: string;
    db?: AsyncDb;
  },
): Promise<ResearchRun> {
  if (opts.db) {
    const stored = await loadResearchRun(opts.db, run.tenant, run.id);
    if (stored?.status === 'CANCELLED') return stored;
    if (stored?.status === 'COMPLETED') throw new WedgeError('TERMINAL_CHECKPOINT', 'research already completed');
    if (stored?.status === 'RUNNING') throw new WedgeError('EXECUTION_CONFLICT', 'research already has an executor');
    if (stored && approvedPlan(stored) !== approvedPlan(run))
      throw new WedgeError('PLAN_MISMATCH', 'caller differs from the approved plan');
    if (stored) run = stored;
  }
  if (run.status !== 'APPROVED' && run.status !== 'RUNNING') {
    throw new WedgeError('UNAPPROVED_RESEARCH', `run is ${run.status} — approve the plan before it executes`);
  }

  const normalized: ResearchRun = {
    ...run,
    cancelledBy: run.cancelledBy ?? null,
    corroboratedUris: run.corroboratedUris ?? [],
    uriSubquestions: run.uriSubquestions ?? {},
    coverage: run.coverage ?? [],
    rejected: run.rejected ?? { blocklist: 0, corroborated: 0, allowlist: 0, capped: 0 },
    executionOwner: run.executionOwner ?? null,
    executionLeaseAt: run.executionLeaseAt ?? null,
    updatedAt: run.updatedAt ?? opts.now,
  };
  let next: ResearchRun = {
    ...normalized,
    status: 'RUNNING',
    executionOwner: opts.owner ?? opts.by,
    executionLeaseAt: opts.now,
    updatedAt: opts.now,
  };

  const approved = checkedBudgets(next.approvedBudgets);
  const requested = checkedBudgets({ ...approved, ...opts.budgets });
  if (requested.maxSearches > approved.maxSearches || requested.maxResultsPerQuestion > approved.maxResultsPerQuestion)
    throw new WedgeError('BUDGET_EXCEEDS_APPROVAL', 'execution may tighten but not increase approved budgets');
  const budgets = requested;
  next.executionToken = crypto.randomUUID();
  next.failure = null;
  if (opts.db) {
    try {
      await persistResearchRun(opts.db, next);
    } catch (error) {
      if (error instanceof WedgeError && error.message.includes('REVISION_CONFLICT'))
        throw new WedgeError('EXECUTION_CONFLICT', 'another executor or state change won ownership');
      throw error;
    }
  }
  let durableRevision = next.revision;
  const checkOwnership = async (): Promise<ResearchRun | null> => {
    if (!opts.db) return null;
    const stored = await loadResearchRun(opts.db, run.tenant, run.id);
    if (!stored) throw new WedgeError('RUN_NOT_FOUND', 'research checkpoint disappeared');
    if (stored.status === 'CANCELLED') return stored;
    if (
      stored.status !== 'RUNNING' ||
      stored.executionToken !== next.executionToken ||
      stored.revision !== next.revision
    )
      throw new WedgeError('EXECUTION_CONFLICT', 'execution ownership changed; discard pending results');
    return null;
  };

  /**
   * F16: in-flight abort — the search promise races a cancellation poll. If
   * cancellation wins, the pending search is aborted (its result discarded,
   * never banked) and the run settles CANCELLED immediately instead of
   * waiting for the step to finish and being cancelled between steps. A
   * slow search's lost work is bounded to the request it was already
   * serving; the abort is cooperative — the search fn's underlying request
   * is cancelled only if it honors the signal.
   */
  const pollMs = 250;
  const runSearchWithAbort = async (sub: string): Promise<SearchHit[] | null> => {
    const searchPromise = search(sub);
    if (!opts.cancelled) return await searchPromise;
    for (;;) {
      let timedOut = false;
      const loser = await Promise.race([
        searchPromise.then(
          () => 'done' as const,
          (e) => Promise.reject(e),
        ),
        new Promise<'poll'>((r) => {
          const t = setTimeout(() => {
            timedOut = true;
            r('poll');
          }, pollMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      if (loser === 'done') return await searchPromise;
      if (!timedOut) continue; // safety: re-poll
      if (opts.cancelled()) {
        // Discard the in-flight result. The promise is left to settle on its
        // own (a rejected search here must not become an unhandled rejection).
        searchPromise.then(
          () => undefined,
          () => undefined,
        );
        return null;
      }
    }
  };

  const subject = `research:${slugOf(run.question)}`;

  let activeQuestion: string | null = null;
  try {
    for (const sub of run.subquestions) {
      if (next.completedSteps.includes(sub)) continue;
      activeQuestion = sub;
      const stopped = await checkOwnership();
      if (stopped) return stopped;
      if (opts.cancelled?.() === true) {
        const cancelled: ResearchRun = { ...cancelResearchRun(next, opts.by), updatedAt: opts.now };
        if (opts.db) await persistResearchRun(opts.db, cancelled);
        return cancelled;
      }
      if (next.totalSearches >= budgets.maxSearches) {
        const paused: ResearchRun = {
          ...next,
          status: 'PAUSED_BUDGET',
          executionOwner: null,
          executionToken: null,
          executionLeaseAt: null,
          updatedAt: opts.now,
        };
        if (opts.db) await persistResearchRun(opts.db, paused);
        return paused;
      }
      next = { ...next, totalSearches: next.totalSearches + 1 };
      if (opts.db) {
        await persistResearchRun(opts.db, next);
        durableRevision = next.revision;
      }
      const hits = await runSearchWithAbort(sub);
      if (hits === null) {
        // In-flight search aborted on cancellation: settle CANCELLED now.
        const cancelled: ResearchRun = { ...cancelResearchRun(next, opts.by), updatedAt: opts.now };
        if (opts.db) await persistResearchRun(opts.db, cancelled);
        return cancelled;
      }
      const stoppedAfterSearch = await checkOwnership();
      if (stoppedAfterSearch) return stoppedAfterSearch;
      const acceptResults = async () => {
        const stoppedBeforeBanking = await checkOwnership();
        if (stoppedBeforeBanking) return stoppedBeforeBanking;
        const acceptedUris = new Set<string>();
        let taken = 0;
        let stepCapped = 0;
        for (const h of hits) {
          if (taken >= budgets.maxResultsPerQuestion) {
            stepCapped++;
            continue;
          }
          const host = hostOf(h.uri);
          if (run.blocklist.some((b) => host === b.toLowerCase() || host.endsWith(`.${b.toLowerCase()}`))) {
            next = { ...next, rejected: { ...next.rejected, blocklist: next.rejected.blocklist + 1 } };
            continue;
          }
          if (
            run.allowlist.length > 0 &&
            !run.allowlist.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`))
          ) {
            next = { ...next, rejected: { ...next.rejected, allowlist: next.rejected.allowlist + 1 } };
            continue;
          }
          if (acceptedUris.has(h.uri)) continue;
          acceptedUris.add(h.uri);
          if (next.seenUris.includes(h.uri)) {
            taken += 1;
            // Corroborated: seen again — record it, track which subquestion corroborated it.
            next = {
              ...next,
              rejected: { ...next.rejected, corroborated: next.rejected.corroborated + 1 },
              corroboratedUris: next.corroboratedUris.includes(h.uri)
                ? next.corroboratedUris
                : [...next.corroboratedUris, h.uri],
              uriSubquestions: {
                ...next.uriSubquestions,
                [h.uri]: [...new Set([...(next.uriSubquestions[h.uri] ?? []), sub])],
              },
            };
            continue;
          }
          const claim = await ledger.append({
            tenant: run.tenant,
            subject,
            kind: 'OBSERVATION',
            statement: `${h.title} — ${h.snippet.slice(0, 500)}`,
            confidence: 0.6,
            owner: opts.by,
            scope: opts.scope,
            authorType: 'agent',
            observedAt: opts.now,
            validFrom: opts.now,
            now: opts.now,
            provenance: {
              sourceUri: h.uri,
              sourceTier: 'SINGLE_SOURCE',
              extractor: 'deep-research',
              extractorVersion: '1.0.0',
              retrievedAt: opts.now,
            },
          });
          next = {
            ...next,
            findingIds: [...next.findingIds, claim.id],
            seenUris: [...next.seenUris, h.uri],
            uriSubquestions: {
              ...next.uriSubquestions,
              [h.uri]: [...new Set([...(next.uriSubquestions[h.uri] ?? []), sub])],
            },
          };
          taken += 1;
        }
        // Per-step rejection accumulation.
        if (stepCapped > 0)
          next = { ...next, rejected: { ...next.rejected, capped: next.rejected.capped + stepCapped } };

        // Coverage: record zero-result steps.
        const cov: SubquestionCoverage = { subquestion: sub, noResults: taken === 0, accepted: taken };
        next = {
          ...next,
          completedSteps: [...next.completedSteps, sub],
          coverage: [...next.coverage.filter((c) => c.subquestion !== sub), cov],
          updatedAt: opts.now,
        };
        if (opts.db) await persistResearchRun(opts.db, next);
        return null;
      };
      const cancelled = opts.db ? await opts.db.transaction(acceptResults) : await acceptResults();
      if (cancelled) return cancelled;
      durableRevision = next.revision;
    }
    const stopped = await checkOwnership();
    if (stopped) return stopped;
    activeQuestion = null;
    const isCancelled = opts.cancelled?.() === true;
    const done: ResearchRun = {
      ...next,
      status: isCancelled ? 'CANCELLED' : 'COMPLETED',
      cancelledBy: isCancelled ? opts.by : null,
      executionOwner: null,
      executionToken: null,
      executionLeaseAt: null,
      updatedAt: opts.now,
    };
    if (opts.db) await persistResearchRun(opts.db, done);
    return done;
  } catch (error) {
    if (opts.db) {
      const stored = await loadResearchRun(opts.db, run.tenant, run.id);
      if (stored?.status === 'CANCELLED') return stored;
      if (
        !stored ||
        stored.executionToken !== next.executionToken ||
        stored.status !== 'RUNNING' ||
        stored.revision !== durableRevision
      )
        throw error;
      next = stored;
    }
    const failed: ResearchRun = {
      ...next,
      status: 'FAILED',
      executionOwner: null,
      executionToken: null,
      executionLeaseAt: null,
      updatedAt: opts.now,
      failure: { code: 'RESEARCH_STEP_FAILED', subquestion: activeQuestion },
    };
    if (opts.db) {
      try {
        await persistResearchRun(opts.db, failed);
      } catch (checkpointError) {
        const stored = await loadResearchRun(opts.db, run.tenant, run.id);
        if (stored?.status === 'CANCELLED') return stored;
        throw checkpointError;
      }
    }
    return failed;
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — verify and attach report
// ---------------------------------------------------------------------------

export interface ReportVerification {
  ok: boolean;
  /** Bullet indices with no live citation (non-inference bullets only). */
  unsupported: number[];
  /** Cited claims under contradiction. */
  contradictions: string[];
  /**
   * Sub-questions that completed execution but produced zero findings.
   * (Questions that never ran due to budget exhaustion are in run.status,
   * not here.)
   */
  gaps: string[];
}

/**
 * Stage 2 — the Unsloth check, enforced: unsupported claims, contradictions,
 * and unresolved gaps are flagged, not laundered.
 *
 * Gap definition: completed steps that produced zero findings.
 * Bullets with kind = 'inference' are exempted from citation requirements.
 */
export async function verifyResearchReport(
  ledger: Ledger,
  tenant: string,
  run: ResearchRun,
  sections: { heading: string; bullets: ReportBullet[] }[],
  now: string,
): Promise<ReportVerification> {
  if (tenant !== run.tenant) throw new WedgeError('TENANT_MISMATCH', 'report tenant differs from research tenant');
  const unsupported: number[] = [];
  const contradictions: string[] = [];
  const GONE = ['STALE', 'SUPERSEDED', 'RETIRED'] as const;
  let n = 0;
  for (const s of sections) {
    for (const b of s.bullets) {
      const cited = b.claimIds ?? [];
      if (cited.length === 0 && b.kind !== 'inference') {
        unsupported.push(n);
      } else {
        for (const id of cited) {
          const c = await ledger.get(tenant, id);
          if (
            !c ||
            !run.findingIds.includes(id) ||
            (GONE as readonly string[]).includes(c.status) ||
            c.validFrom > now ||
            (c.validUntil && c.validUntil <= now)
          ) {
            if (!unsupported.includes(n)) unsupported.push(n);
          } else if (c.status === 'DISPUTED') {
            if (!contradictions.includes(id)) contradictions.push(id);
          } else {
            const linked = await ledger.contradictions(tenant, id);
            if (linked.length > 0 && !contradictions.includes(id)) contradictions.push(id);
          }
        }
      }
      n += 1;
    }
  }
  // Gaps = completed steps with zero findings.
  const gaps = run.coverage.filter((c) => c.noResults).map((c) => c.subquestion);
  return { ok: unsupported.length === 0, unsupported, contradictions, gaps };
}

/**
 * Attach a verified report to the run. Throws if any non-inference bullet
 * lacks live citations. Contradictions are included in the report so the
 * report surface can present contested evidence.
 *
 * Bibliography = only claims cited in section bullets (not all run findings).
 * When opts.db is provided, persists the updated run with the report.
 */
export async function attachResearchReport(
  ledger: Ledger,
  tenant: string,
  run: ResearchRun,
  sections: { heading: string; bullets: ReportBullet[] }[],
  now: string,
  opts?: { db?: AsyncDb },
): Promise<ResearchRun> {
  if (run.status !== 'COMPLETED')
    throw new WedgeError('UNFINISHED_RUN', `run is ${run.status} — execute before reporting`);
  const v = await verifyResearchReport(ledger, tenant, run, sections, now);
  if (!v.ok) {
    throw new WedgeError(
      'UNSUPPORTED_REPORT',
      `bullets [${v.unsupported.join(', ')}] cite nothing live — flag as testable inferences or cut them`,
    );
  }

  // Cited-only bibliography (preserves subquestion attribution).
  const citedIds = new Set<string>();
  const inferences: number[] = [];
  let n = 0;
  for (const s of sections) {
    for (const b of s.bullets) {
      if (b.kind === 'inference') {
        inferences.push(n);
        n++;
        continue;
      }
      for (const id of b.claimIds ?? []) citedIds.add(id);
      n++;
    }
  }
  const sources: { claimId: string; uri: string; subquestions: string[] }[] = [];
  for (const id of citedIds) {
    const c = await ledger.get(tenant, id);
    if (c) {
      const subs = run.uriSubquestions[c.provenance.sourceUri] ?? [];
      sources.push({ claimId: c.id, uri: c.provenance.sourceUri, subquestions: subs });
    }
  }

  const report: ResearchReport = {
    question: run.question,
    sections,
    sources,
    gaps: v.gaps,
    contradictions: v.contradictions,
    inferences,
    rejectedSources: run.rejected,
    coverage: run.coverage,
  };

  const updated: ResearchRun = { ...run, report, updatedAt: now };
  if (opts?.db) await persistResearchRun(opts.db, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Report serialization
// ---------------------------------------------------------------------------

/** Serialize a report to a stable JSON string (for storage / transmission). */
export function serializeResearchReport(report: ResearchReport): string {
  return JSON.stringify(report);
}

/** Parse a serialized report. Throws on malformed input. */
export function parseResearchReport(raw: string): ResearchReport {
  try {
    const r = JSON.parse(raw) as ResearchReport;
    if (!r || !Array.isArray(r.sections)) throw new WedgeError('INVALID_REPORT', 'malformed report JSON');
    // Provide defaults for fields added in later versions.
    const defaults: Partial<ResearchReport> = {
      contradictions: [],
      inferences: [],
      gaps: [],
      coverage: [],
      rejectedSources: { blocklist: 0, corroborated: 0, allowlist: 0, capped: 0 },
      sources: [],
    };
    return { ...defaults, ...r, coverage: r.coverage ?? [] };
  } catch (e) {
    if (e instanceof WedgeError) throw e;
    throw new WedgeError('INVALID_REPORT', `failed to parse report: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// High-level session helper
// ---------------------------------------------------------------------------

export interface RunResearchSessionOpts {
  tenant: string;
  question: string;
  subquestions: string[];
  approvedBy?: string;
  /** If set, resumes this run (no re-approval required). */
  id?: string;
  resume?: boolean;
  recovery?: { by: string; expectedRevision: number; now: string };
  by: string;
  scope: string;
  now: string;
  budgets?: Partial<ResearchBudgets>;
  search: SearchFn;
  sections?: { heading: string; bullets: ReportBullet[] }[];
}

export interface RunResearchSessionResult {
  run: ResearchRun;
  report?: ResearchReport;
}

/**
 * Convenience entry point covering approve → execute → optional report.
 * Persists all steps to db. Useful for tests and scripts.
 */
export async function runResearchSession(
  db: AsyncDb,
  ledger: Ledger,
  opts: RunResearchSessionOpts,
): Promise<RunResearchSessionResult> {
  let run: ResearchRun;
  if (opts.resume) {
    if (!opts.id) throw new WedgeError('RUN_NOT_FOUND', 'resume requires a durable run id');
    run = await resumeResearchRun(db, opts.tenant, opts.id, opts.recovery);
  } else {
    const bare = createResearchRun(opts.tenant, opts.question, opts.subquestions, { now: opts.now, id: opts.id });
    run = await approveAndPersistResearchPlan(db, bare, opts.approvedBy ?? opts.by, opts.now, opts.budgets);
  }
  if (run.status !== 'COMPLETED') {
    run = await executeResearchRun(ledger, run, opts.search, {
      by: opts.by,
      scope: opts.scope,
      now: opts.now,
      budgets: opts.budgets,
      db,
    });
  }
  let report: ResearchReport | undefined = run.report ?? undefined;
  if (opts.sections && run.status === 'COMPLETED') {
    const updated = await attachResearchReport(ledger, opts.tenant, run, opts.sections, opts.now, { db });
    run = updated;
    report = updated.report ?? undefined;
  }
  return { run, report };
}

// ---------------------------------------------------------------------------
// Planner assist
// ---------------------------------------------------------------------------

export type PlanModelFn = (
  profile: ModelProfile,
  apiKey: string,
  messages: { role: 'system' | 'user' | 'assistant'; text: string }[],
) => Promise<{ text: string }>;

/**
 * Planner assist: a model proposes sub-questions, a human still approves
 * the plan (`createResearchRun` + `approveResearchPlan`). The model drafts,
 * it never authorizes — an empty or unparseable proposal throws so the
 * caller falls back to manual planning instead of running on vibes.
 */
export async function proposeSubquestions(
  profile: ModelProfile,
  apiKey: string,
  question: string,
  modelFn: PlanModelFn,
  max = 5,
): Promise<string[]> {
  if (!question.trim()) throw new WedgeError('EMPTY_QUESTION', 'no question, no sub-questions');
  let raw: string;
  try {
    const out = await modelFn(profile, apiKey, [
      {
        role: 'system',
        text: 'Break the research question into focused, non-overlapping sub-questions. Reply with EXACTLY a JSON array of strings, no prose.',
      },
      { role: 'user', text: question },
    ]);
    raw = out.text;
  } catch (e) {
    throw new WedgeError('PROPOSAL_FAILED', `planner assist failed: ${(e as Error).message}`);
  }
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new WedgeError('PROPOSAL_UNPARSEABLE', 'planner did not return a JSON array — plan manually');
  let list: unknown;
  try {
    list = JSON.parse(match[0]) as unknown;
  } catch {
    throw new WedgeError('PROPOSAL_UNPARSEABLE', 'planner returned malformed JSON — plan manually');
  }
  if (!Array.isArray(list))
    throw new WedgeError('PROPOSAL_UNPARSEABLE', 'planner did not return a JSON array — plan manually');
  const subs = [
    ...new Set(
      list
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ].slice(0, max);
  if (subs.length === 0) throw new WedgeError('EMPTY_PROPOSAL', 'planner proposed nothing usable — plan manually');
  return subs;
}
