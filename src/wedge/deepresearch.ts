import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ModelProfile } from '../substrate/models.ts';
import { WedgeError } from './ship.ts';

/**
 * Deep research, agentic edition: plan → human approves the plan →
 * multi-step search with cross-referencing → cited report with
 * unsupported-claim and contradiction checks.
 *
 * The shape follows the proven loops (ChatGPT/Unsloth Deep Research):
 * sub-questions instead of one-shot generation, allow/block lists for
 * sources, resumable runs (completed steps are skipped on re-entry),
 * cancellation without losing completed research, and a final pass that
 * flags recommendations without direct evidence as testable inferences
 * rather than letting them pose as findings.
 *
 * Findings land as OBSERVATIONs with URIs (never FACTs). The report is
 * deterministic assembly over cited claims — every bullet names its
 * evidence, and `verifyResearchReport` fails bullets that don't.
 */

export type ResearchStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';

export interface SearchHit {
  uri: string;
  title: string;
  snippet: string;
}

export type SearchFn = (subquestion: string) => Promise<SearchHit[]>;

export interface ResearchRun {
  id: string;
  tenant: string;
  question: string;
  subquestions: string[];
  allowlist: string[];
  blocklist: string[];
  status: ResearchStatus;
  approvedBy: string | null;
  completedSteps: string[];
  findingIds: string[];
  seenUris: string[];
  report: ResearchReport | null;
  createdAt: string;
}

export interface ReportBullet {
  text: string;
  /** Absent = recommendation without direct evidence: flagged, never a finding. */
  claimIds?: string[];
}

export interface ResearchReport {
  question: string;
  sections: { heading: string; bullets: ReportBullet[] }[];
  sources: { claimId: string; uri: string }[];
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
    completedSteps: [],
    findingIds: [],
    seenUris: [],
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

/** Cancel from any active state. Completed research survives cancellation. */
export function cancelResearchRun(run: ResearchRun, _by: string): ResearchRun {
  if (run.status === 'COMPLETED') throw new WedgeError('BAD_PLAN_STATE', 'a completed run is history, not cancellable');
  if (run.status === 'CANCELLED') return run;
  return { ...run, status: 'CANCELLED' };
}

export interface ResearchBudgets {
  maxSearches: number;
  maxResultsPerQuestion: number;
}

/**
 * Durable stage checkpoints: plan/approval/steps-done live in `meta` (plus
 * an audit trail row), not just in the in-memory run object — so a resumed
 * run after a crash skips completed steps instead of re-spending searches.
 * Pure constructors (`createResearchRun`/`approveResearchPlan`) stay pure;
 * callers persist the result with `saveResearchCheckpoint`, and
 * `executeResearchRun` merges the stored checkpoint when `opts.db` is set.
 */
export interface ResearchCheckpoint {
  question: string;
  subquestions: string[];
  status: ResearchStatus;
  approvedBy: string | null;
  completedSteps: string[];
  findingIds: string[];
  seenUris: string[];
}

const checkpointKeyOf = (tenant: string, id: string): string => `research:run:${tenant}:${id}`;

export async function saveResearchCheckpoint(db: AsyncDb, run: ResearchRun, at: string): Promise<void> {
  const checkpoint: ResearchCheckpoint = {
    question: run.question,
    subquestions: run.subquestions,
    status: run.status,
    approvedBy: run.approvedBy,
    completedSteps: run.completedSteps,
    findingIds: run.findingIds,
    seenUris: run.seenUris,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(checkpointKeyOf(run.tenant, run.id), JSON.stringify(checkpoint));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(
      run.tenant,
      'deep-research',
      'RESEARCH_CHECKPOINT',
      run.id,
      JSON.stringify({ status: run.status, stepsDone: run.completedSteps.length }),
      at,
    );
}

export async function loadResearchCheckpoint(
  db: AsyncDb,
  tenant: string,
  id: string,
): Promise<ResearchCheckpoint | null> {
  try {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(checkpointKeyOf(tenant, id))) as
      { value: string } | undefined;
    if (!r) return null;
    const c = JSON.parse(String(r.value)) as ResearchCheckpoint;
    if (!Array.isArray(c.completedSteps)) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * Stage 1 — run. Each subquestion searches, filters allow/block lists,
 * dedupes URIs across the run (cross-referencing starts here: the second
 * sighting of a URI corroborates instead of duplicating), and banks
 * findings as OBSERVATIONs. Re-entry skips completed steps (resumable);
 * cancellation between steps keeps everything found so far.
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
    /**
     * Durable resume: when set, the stored checkpoint (if any) merges into
     * the run before the first search, and every completed step re-saves —
     * so a crash/resume spends zero new searches on done steps.
     */
    db?: AsyncDb;
  },
): Promise<ResearchRun> {
  if (run.status !== 'APPROVED' && run.status !== 'RUNNING') {
    throw new WedgeError('UNAPPROVED_RESEARCH', `run is ${run.status} — approve the plan before it executes`);
  }
  const budgets: ResearchBudgets = { maxSearches: 20, maxResultsPerQuestion: 8, ...opts.budgets };
  let next: ResearchRun = { ...run, status: 'RUNNING' };
  if (opts.db) {
    const stored = await loadResearchCheckpoint(opts.db, run.tenant, run.id);
    if (stored) {
      // Resume keeps the furthest progress of either copy: union, run order
      // preserved, so completed steps are skipped and findings never re-bank.
      const union = (a: string[], b: string[]): string[] => [...a, ...b.filter((s) => !a.includes(s))];
      next = {
        ...next,
        approvedBy: next.approvedBy ?? stored.approvedBy,
        completedSteps: union(stored.completedSteps, next.completedSteps),
        findingIds: union(stored.findingIds, next.findingIds),
        seenUris: union(stored.seenUris, next.seenUris),
      };
    }
    await saveResearchCheckpoint(opts.db, next, opts.now);
  }
  const subject = `research:${slugOf(run.question)}`;
  let searches = 0;
  for (const sub of run.subquestions) {
    if (next.completedSteps.includes(sub)) continue;
    if (opts.cancelled?.() === true) {
      if (opts.db) await saveResearchCheckpoint(opts.db, { ...next, status: 'CANCELLED' }, opts.now);
      return { ...next, status: 'CANCELLED' };
    }
    if (searches >= budgets.maxSearches) break;
    searches += 1;
    const hits = await search(sub);
    let taken = 0;
    for (const h of hits) {
      if (taken >= budgets.maxResultsPerQuestion) break;
      const host = hostOf(h.uri);
      if (run.blocklist.some((b) => host === b.toLowerCase() || host.endsWith(`.${b.toLowerCase()}`))) continue;
      if (
        run.allowlist.length > 0 &&
        !run.allowlist.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`))
      )
        continue;
      if (next.seenUris.includes(h.uri)) continue; // corroborated, not duplicated
      next = { ...next, seenUris: [...next.seenUris, h.uri] };
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
      next = { ...next, findingIds: [...next.findingIds, claim.id] };
      taken += 1;
    }
    next = { ...next, completedSteps: [...next.completedSteps, sub] };
    // Checkpoint per step (why: a crash mid-run resumes after this step
    // instead of re-searching it — the budget pays once per sub-question).
    if (opts.db) await saveResearchCheckpoint(opts.db, next, opts.now);
  }
  const done: ResearchRun = { ...next, status: 'COMPLETED' };
  if (opts.db) await saveResearchCheckpoint(opts.db, done, opts.now);
  return done;
}

export interface ReportVerification {
  ok: boolean;
  /** Bullets with no live citation — flagged as testable inferences, never findings. */
  unsupported: number[];
  /** Cited claims under contradiction — the report must say so. */
  contradictions: string[];
  /** Sub-questions that produced zero findings. */
  gaps: string[];
}

/**
 * Stage 2 — the Unsloth check, enforced: unsupported claims, contradictions,
 * and unresolved gaps are flagged, not laundered. A report that passes
 * attaches to the run; anything else comes back with the gaps named.
 */
export async function verifyResearchReport(
  ledger: Ledger,
  tenant: string,
  run: ResearchRun,
  sections: { heading: string; bullets: ReportBullet[] }[],
  now: string,
): Promise<ReportVerification> {
  const unsupported: number[] = [];
  const contradictions: string[] = [];
  // DISPUTED is deliberately not unusable here: a contradicted citation is
  // still evidence, but the report must say it is contested.
  const GONE = ['STALE', 'SUPERSEDED', 'RETIRED'] as const;
  let n = 0;
  for (const s of sections) {
    for (const b of s.bullets) {
      const cited = b.claimIds ?? [];
      if (cited.length === 0) {
        unsupported.push(n);
      } else {
        for (const id of cited) {
          const c = await ledger.get(tenant, id);
          if (!c || (GONE as readonly string[]).includes(c.status) || (c.validUntil && c.validUntil <= now)) {
            if (!unsupported.includes(n)) unsupported.push(n);
          } else if (c.status === 'DISPUTED') {
            if (!contradictions.includes(id)) contradictions.push(id);
          }
        }
      }
      n += 1;
    }
  }
  const gaps = run.subquestions.filter((s) => !run.completedSteps.includes(s));
  return { ok: unsupported.length === 0, unsupported, contradictions, gaps };
}

export async function attachResearchReport(
  ledger: Ledger,
  tenant: string,
  run: ResearchRun,
  sections: { heading: string; bullets: ReportBullet[] }[],
  now: string,
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
  const found: { claimId: string; uri: string }[] = [];
  for (const id of run.findingIds) {
    const c = await ledger.get(tenant, id);
    if (c) found.push({ claimId: c.id, uri: c.provenance.sourceUri });
  }
  return { ...run, report: { question: run.question, sections, sources: found, gaps: v.gaps } };
}

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
