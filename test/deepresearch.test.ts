import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, type AsyncDb } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { T, eq, TEN, NOW, fresh, rejects } from './helpers.ts';
import {
  approveAndPersistResearchPlan,
  approveResearchPlan,
  attachResearchReport,
  cancelPersistedResearchRun,
  cancelResearchRun,
  createResearchRun,
  executeResearchRun,
  loadResearchRun,
  parseResearchReport,
  persistResearchRun,
  planFingerprint,
  proposeSubquestions,
  researchProgress,
  resumeResearchRun,
  runResearchSession,
  serializeResearchReport,
  verifyResearchReport,
  type SearchHit,
} from '../src/wedge/deepresearch.ts';
import { prodProfile } from '../src/substrate/models.ts';

console.log('\n\x1b[1mWedge — agentic deep research\x1b[0m');

const hits: Record<string, SearchHit[]> = {
  'magic link expiry': [
    { uri: 'https://slack.engineering/magic', title: 'Magic links at Slack', snippet: 'ten-minute single-use tokens' },
    { uri: 'https://vendor.blog/sso', title: 'Vendor SSO blog', snippet: 'buy our sso, magic included' },
  ],
  'magic link device check': [
    {
      uri: 'https://slack.engineering/magic',
      title: 'Magic links at Slack',
      snippet: 'device binding mentioned again',
    },
    { uri: 'https://auth.example/guide', title: 'Auth guide', snippet: 'bind token to device fingerprint' },
  ],
};
const search = async (q: string): Promise<SearchHit[]> => hits[q] ?? [];

const planned = () =>
  approveResearchPlan(
    createResearchRun(TEN, 'How do others do magic-link login?', ['magic link expiry', 'magic link device check'], {
      now: NOW,
    }),
    'human:priya',
  );

T('plans are reviewed before anything runs; empty plans refused', async () => {
  const run = createResearchRun(TEN, 'q?', ['a', 'b'], { now: NOW });
  eq(run.status, 'PLANNED');
  eq(run.completedSteps, []);
  await rejects(async () => createResearchRun(TEN, 'q?', [], { now: NOW }), 'EMPTY_PLAN');
  await rejects(async () => approveResearchPlan(run, ''), 'NO_APPROVER');
  const approved = approveResearchPlan(run, 'human:priya');
  eq(approved.status, 'APPROVED');
  await rejects(async () => approveResearchPlan(approved, 'human:priya'), 'BAD_PLAN_STATE');
});

T('execution searches, dedupes URIs, banks cited observations', async () => {
  const { ledger } = await fresh();
  const done = await executeResearchRun(ledger, planned(), search, { by: 'agent:eng', scope: 'engineering', now: NOW });
  eq(done.status, 'COMPLETED');
  eq(done.completedSteps.length, 2);
  eq(done.findingIds.length, 3);
  eq((await ledger.get(TEN, done.findingIds[0]!))!.kind, 'OBSERVATION');
  eq((await ledger.get(TEN, done.findingIds[0]!))!.provenance.sourceTier, 'SINGLE_SOURCE');
});

T('blocklists filter; budgets cap; cancellation keeps completed work', async () => {
  const { ledger } = await fresh();
  const run = approveResearchPlan(
    createResearchRun(TEN, 'q?', ['magic link expiry', 'magic link device check'], {
      blocklist: ['vendor.blog'],
      now: NOW,
    }),
    'human:priya',
  );
  const done = await executeResearchRun(ledger, run, search, { by: 'a', scope: 'e', now: NOW });
  const uris = await Promise.all(done.findingIds.map(async (id) => (await ledger.get(TEN, id))!.provenance.sourceUri));
  eq(
    uris.some((u) => u.includes('vendor.blog')),
    false,
    'blocked host never banked:',
  );
  const capped = await executeResearchRun(ledger, planned(), search, {
    by: 'a',
    scope: 'e',
    now: NOW,
    budgets: { maxSearches: 1, maxResultsPerQuestion: 8 },
  });
  eq(capped.completedSteps.length, 1, 'search budget respected:');
  eq(capped.status, 'PAUSED_BUDGET', 'budget exhaustion pauses instead of claiming completion:');
  let calls = 0;
  const slow = async (q: string) => {
    calls++;
    return search(q);
  };
  const cancelled = await executeResearchRun(ledger, planned(), slow, {
    by: 'a',
    scope: 'e',
    now: NOW,
    cancelled: () => calls >= 1,
  });
  eq(cancelled.status, 'CANCELLED');
  eq(cancelled.findingIds.length > 0, true, 'completed research survives cancellation:');
});

T('F16: an in-flight search is aborted and its result never banked when cancellation fires mid-search', async () => {
  const { ledger, db } = await fresh();
  const run = approveResearchPlan(
    createResearchRun(TEN, 'in-flight abort?', ['slow question', 'later question'], { now: NOW }),
    'human:priya',
  );
  let searchesStarted = 0;
  let searchResolved = 0;
  const slowSearch = async (q: string): Promise<SearchHit[]> => {
    searchesStarted += 1;
    // Long enough that the cancellation poll (250ms) fires mid-search.
    await new Promise((r) => setTimeout(r, 1500));
    searchResolved += 1;
    return search(q);
  };
  // Cancel once the FIRST search is in flight (before it resolves).
  const result = await executeResearchRun(ledger, run, slowSearch, {
    by: 'a',
    scope: 'e',
    now: NOW,
    cancelled: () => searchesStarted >= 1,
  });
  eq(result.status, 'CANCELLED', 'mid-search cancellation settles CANCELLED:');
  eq(result.completedSteps.length, 0, 'the aborted step is not marked completed:');
  eq(result.findingIds.length, 0, 'the aborted search banks nothing:');
  eq(result.cancelledBy, 'a', 'cancelling actor recorded:');
  // Give the abandoned promise a chance to settle, then confirm it never banked.
  await new Promise((r) => setTimeout(r, 1700));
  eq(searchResolved >= 1, true, 'the discarded search promise settles on its own:');
  const claims = (await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number };
  eq(Number(claims.n), 0, 'no claims from the aborted search:');
});

T('unapproved runs never execute', async () => {
  const { ledger } = await fresh();
  const run = createResearchRun(TEN, 'q?', ['a'], { now: NOW });
  let code = '';
  try {
    await executeResearchRun(ledger, run, search, { by: 'a', scope: 'e', now: NOW });
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('UNAPPROVED_RESEARCH'), true);
});

T('reports attach only when every bullet is cited; gaps and contradictions flagged', async () => {
  const { ledger } = await fresh();
  const done = await executeResearchRun(ledger, planned(), search, { by: 'agent:eng', scope: 'engineering', now: NOW });
  const [f1, f2] = done.findingIds;
  const good = [{ heading: 'Expiry', bullets: [{ text: 'ten-minute single-use tokens', claimIds: [f1!] }] }];
  const v = await verifyResearchReport(ledger, TEN, done, good, NOW);
  eq(v.ok, true);
  const bad = [{ heading: 'Hype', bullets: [{ text: 'everyone loves it' }, { text: 'cited', claimIds: [f2!] }] }];
  const v2 = await verifyResearchReport(ledger, TEN, done, bad, NOW);
  eq(v2.ok, false);
  eq(v2.unsupported, [0], 'uncited bullet flagged as testable inference:');
  await rejects(async () => await attachResearchReport(ledger, TEN, done, bad, NOW), 'UNSUPPORTED_REPORT');
  const attached = await attachResearchReport(ledger, TEN, done, good, NOW);
  eq(attached.report!.sources.length, 1, 'bibliography cites only evidence used in bullets:');
  await rejects(
    async () => await attachResearchReport(ledger, TEN, { ...done, status: 'RUNNING' }, good, NOW),
    'UNFINISHED_RUN',
  );
  const running = { ...done, status: 'RUNNING' as const };
  eq(cancelResearchRun(running, 'h').status, 'CANCELLED');
  await rejects(async () => cancelResearchRun(done, 'h'), 'BAD_PLAN_STATE', 'completed runs are history:');
});

T('the planner assist drafts sub-questions; humans still approve them', async () => {
  const profile = prodProfile({} as NodeJS.ProcessEnv);
  const subs = await proposeSubquestions(profile, 'k', 'How do others do magic links?', async () => ({
    text: '["expiry windows", "expiry windows", "device binding", "  "]',
  }));
  eq(subs, ['expiry windows', 'device binding'], 'deduped, trimmed, capped:');
  const run = approveResearchPlan(
    createResearchRun(TEN, 'How do others do magic links?', subs, { now: NOW }),
    'human:priya',
  );
  eq(run.status, 'APPROVED');
  let code = '';
  try {
    await proposeSubquestions(profile, 'k', 'q?', async () => ({ text: 'just some prose' }));
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('PROPOSAL_UNPARSEABLE'), true);
  let code2 = '';
  try {
    await proposeSubquestions(profile, 'k', 'q?', async () => {
      throw new Error('model down');
    });
  } catch (e) {
    code2 = (e as Error).message;
  }
  eq(code2.includes('PROPOSAL_FAILED'), true);
});

T('resume after a crash skips done steps without new searches', async () => {
  const { db, ledger } = await fresh();
  const question = 'How do others do magic-link login?';
  const subs = ['magic link expiry', 'magic link device check'];
  let calls = 0;
  const counting = async (q: string) => {
    calls++;
    return search(q);
  };
  const attempt = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, question, subs, { now: NOW, id: 'rsr_resume_1' }),
    'human:priya',
    NOW,
  );
  const partial = await executeResearchRun(ledger, attempt, counting, {
    by: 'a',
    scope: 'e',
    now: NOW,
    budgets: { maxSearches: 1, maxResultsPerQuestion: 8 },
    db,
  });
  eq(partial.completedSteps.length, 1);
  eq(partial.status, 'PAUSED_BUDGET', 'budget exhaustion pauses, not completes:');
  eq(calls, 1);
  const resumed = await resumeResearchRun(db, TEN, 'rsr_resume_1');
  eq(resumed.approvedBy, 'human:priya', 'no re-approval required:');
  const done = await executeResearchRun(ledger, resumed, counting, { by: 'a', scope: 'e', now: NOW, db });
  eq(done.completedSteps.length, 2);
  eq(calls, 2, 'only the remaining step searched:');
  eq(done.findingIds.length, 3);
});

console.log('\n\x1b[1mWedge — durable research state (FLOW-017)\x1b[0m');

T('FLOW-017: budget-limited run pauses with remaining questions exposed', async () => {
  const { db, ledger } = await fresh();
  const subs = ['magic link expiry', 'magic link device check'];
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', subs, { now: NOW, id: 'rsr_flow17_budget' }),
    'human:priya',
    NOW,
    { maxSearches: 1, maxResultsPerQuestion: 8 },
  );
  const paused = await executeResearchRun(ledger, approved, search, { by: 'a', scope: 'e', now: NOW, db });
  eq(paused.status, 'PAUSED_BUDGET');
  const progress = researchProgress((await loadResearchRun(db, TEN, 'rsr_flow17_budget'))!);
  eq(progress.remainingQuestions.length, 1);
  eq(progress.searchesUsed, 1);
  eq(progress.completedSteps.length, 1);
});

T('FLOW-017: direct resume by run id without re-approval', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_resume';
  const subs = ['magic link expiry', 'magic link device check'];
  await approveAndPersistResearchPlan(db, createResearchRun(TEN, 'q?', subs, { now: NOW, id }), 'human:priya', NOW);
  const stub = await loadResearchRun(db, TEN, id);
  await executeResearchRun(ledger, stub!, search, {
    budgets: { maxSearches: 1, maxResultsPerQuestion: 8 },
    by: 'a',
    scope: 'e',
    now: NOW,
    db,
  });
  eq((await loadResearchRun(db, TEN, id))!.status, 'PAUSED_BUDGET');
  const resumed = await resumeResearchRun(db, TEN, id);
  eq(resumed.status, 'APPROVED', 'resume re-enters without re-approval:');
  const done = await executeResearchRun(ledger, resumed, search, { by: 'a', scope: 'e', now: NOW, db });
  eq(done.status, 'COMPLETED');
});

T('FLOW-017: persisted cancellation blocks stale callers after restart', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_cancel';
  const run = createResearchRun(TEN, 'q?', ['magic link expiry', 'magic link device check'], { now: NOW, id });
  const approved = await approveAndPersistResearchPlan(db, run, 'human:priya', NOW);
  await cancelPersistedResearchRun(db, approved, 'human:priya', NOW);
  const stored = await loadResearchRun(db, TEN, id);
  eq(stored!.status, 'CANCELLED');
  eq(stored!.cancelledBy, 'human:priya');
  const stale = await executeResearchRun(ledger, approved, search, { by: 'a', scope: 'e', now: NOW, db });
  eq(stale.status, 'CANCELLED');
  await rejects(async () => await resumeResearchRun(db, TEN, id), 'RUN_CANCELLED');
});

T('FLOW-017: concurrent execution ownership rejects competing executors', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_owner';
  const subs = ['magic link expiry', 'magic link device check'];
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', subs, { now: NOW, id }),
    'human:priya',
    NOW,
  );
  const leaseAt = NOW;
  await persistResearchRun(db, {
    ...(await loadResearchRun(db, TEN, id))!,
    status: 'RUNNING',
    executionOwner: 'agent:a',
    executionLeaseAt: leaseAt,
    updatedAt: leaseAt,
  });
  await rejects(
    async () =>
      await executeResearchRun(ledger, approved, search, {
        by: 'b',
        scope: 'e',
        now: leaseAt,
        db,
        owner: 'agent:b',
      }),
    'EXECUTION_CONFLICT',
  );
});

T('FLOW-017: changed plan rejected against persisted approved plan', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_plan';
  await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', ['magic link expiry'], { now: NOW, id }),
    'human:priya',
    NOW,
  );
  const tampered = createResearchRun(TEN, 'q?', ['different question'], { now: NOW, id });
  await rejects(
    async () =>
      await executeResearchRun(ledger, { ...tampered, status: 'APPROVED', approvedBy: 'human:priya' }, search, {
        by: 'a',
        scope: 'e',
        now: NOW,
        db,
      }),
    'PLAN_MISMATCH',
  );
  eq(planFingerprint('q?', ['magic link expiry']) !== planFingerprint('q?', ['different question']), true);
});

T('FLOW-017: step failure lands in a durable FAILED state with the failing question', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_failed';
  const subs = ['magic link expiry', 'magic link device check'];
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', subs, { now: NOW, id }),
    'human:priya',
    NOW,
  );
  let calls = 0;
  const boom = async (q: string) => {
    calls++;
    if (calls === 1) return search(q);
    throw new Error('search provider down');
  };
  const failed = await executeResearchRun(ledger, approved, boom, { by: 'a', scope: 'e', now: NOW, db });
  eq(failed.status, 'FAILED');
  eq(failed.failure?.subquestion, 'magic link device check');
  eq(failed.completedSteps.length, 1, 'partial work is checkpointed before the failure:');
  eq(failed.findingIds.length, 2);
  eq(failed.executionOwner, null, 'failure releases the execution lease:');
  const stored = await loadResearchRun(db, TEN, id);
  eq(stored!.status, 'FAILED');
  eq(stored!.failure?.subquestion, 'magic link device check');
  const progress = researchProgress(stored!);
  eq(progress.completedSteps.length, 1);
  eq(progress.remainingQuestions, ['magic link device check']);
  const recovered = await resumeResearchRun(db, TEN, id, {
    by: 'agent:b',
    expectedRevision: stored!.revision!,
    now: NOW,
  });
  eq(recovered.status, 'APPROVED');
  const done = await executeResearchRun(ledger, recovered, search, { by: 'b', scope: 'e', now: NOW, db });
  eq(done.status, 'COMPLETED');
  eq(done.failure, null);
  eq(done.completedSteps.length, 2);
  eq(done.findingIds.length, 3, 'banked findings survive the failure:');
});

T('FLOW-017: FAILED resumes with recovery while CANCELLED stays terminal even with recovery', async () => {
  const { db, ledger } = await fresh();
  const failedApproved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'resume me?', ['magic link expiry'], { now: NOW, id: 'rsr_flow17_fail_vs_cancel_a' }),
    'human:priya',
    NOW,
  );
  const failed = await executeResearchRun(
    ledger,
    failedApproved,
    async () => {
      throw new Error('provider down');
    },
    { by: 'a', scope: 'e', now: NOW, db },
  );
  eq(failed.status, 'FAILED');
  eq(failed.findingIds, [], 'failure before banking preserves partial (empty) results, not phantom findings:');
  // FAILED without explicit recovery refuses — the operator must name recovery.
  await rejects(() => resumeResearchRun(db, TEN, failedApproved.id), 'EXECUTION_CONFLICT');
  const recovered = await resumeResearchRun(db, TEN, failedApproved.id, {
    by: 'agent:b',
    expectedRevision: failed.revision!,
    now: NOW,
  });
  eq(recovered.status, 'APPROVED', 'FAILED reopens to the exact approved plan:');
  eq(recovered.failure, { code: 'RESEARCH_STEP_FAILED', subquestion: 'magic link expiry' });

  const cancelApproved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'stay dead?', ['magic link expiry'], { now: NOW, id: 'rsr_flow17_fail_vs_cancel_b' }),
    'human:priya',
    NOW,
  );
  const cancelled = await cancelPersistedResearchRun(db, cancelApproved, 'human:priya', NOW);
  eq(cancelled.status, 'CANCELLED');
  // CANCELLED rejects even explicit named recovery — cancellation is terminal.
  await rejects(
    () =>
      resumeResearchRun(db, TEN, cancelApproved.id, {
        by: 'agent:b',
        expectedRevision: cancelled.revision!,
        now: NOW,
      }),
    'RUN_CANCELLED',
    'cancelled runs never reopen, even with recovery:',
  );
  await db.close();
});

T('FLOW-017: recovering an interrupted RUNNING run is fenced by revision', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_recovery';
  await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', ['magic link expiry'], { now: NOW, id }),
    'human:priya',
    NOW,
  );
  const before = (await loadResearchRun(db, TEN, id))!;
  const crashed = await persistResearchRun(db, {
    ...before,
    status: 'RUNNING',
    executionOwner: 'agent:crashed',
    executionLeaseAt: NOW,
  });
  eq(crashed === undefined, true, 'persist returns void; check via loadResearchRun:');
  const stored = (await loadResearchRun(db, TEN, id))!;
  eq(stored.status, 'RUNNING');
  eq(stored.executionOwner, 'agent:crashed');
  await rejects(async () => await resumeResearchRun(db, TEN, id), 'EXECUTION_CONFLICT');
  await rejects(
    async () => await resumeResearchRun(db, TEN, id, { by: 'agent:b', expectedRevision: 99, now: NOW }),
    'REVISION_CONFLICT',
  );
  const resumed = await resumeResearchRun(db, TEN, id, { by: 'agent:b', expectedRevision: stored.revision!, now: NOW });
  eq(resumed.status, 'APPROVED');
  eq(resumed.executionOwner, null);
  const done = await executeResearchRun(ledger, resumed, search, { by: 'b', scope: 'e', now: NOW, db });
  eq(done.status, 'COMPLETED');
});

T('FLOW-017: execution may tighten but never exceed approved budgets', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_budget_gate';
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', ['magic link expiry', 'magic link device check'], { now: NOW, id }),
    'human:priya',
    NOW,
    { maxSearches: 5, maxResultsPerQuestion: 8 },
  );
  await rejects(
    async () =>
      await executeResearchRun(ledger, approved, search, {
        by: 'a',
        scope: 'e',
        now: NOW,
        db,
        budgets: { maxSearches: 99 },
      }),
    'BUDGET_EXCEEDS_APPROVAL',
  );
  const tightened = await executeResearchRun(ledger, approved, search, {
    by: 'a',
    scope: 'e',
    now: NOW,
    db,
    budgets: { maxSearches: 1, maxResultsPerQuestion: 1 },
  });
  eq(tightened.status, 'PAUSED_BUDGET');
  eq(tightened.totalSearches, 1);
  eq(tightened.coverage[0]!.accepted, 1);
});

T('FLOW-017: final report persists with the run record', async () => {
  const { db, ledger } = await fresh();
  const id = 'rsr_flow17_report';
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', ['magic link expiry'], { now: NOW, id }),
    'human:priya',
    NOW,
  );
  const done = await executeResearchRun(ledger, approved, search, { by: 'a', scope: 'e', now: NOW, db });
  const [f1] = done.findingIds;
  const sections = [{ heading: 'Expiry', bullets: [{ text: 'ten-minute tokens', claimIds: [f1!] }] }];
  await attachResearchReport(ledger, TEN, done, sections, NOW, { db });
  const stored = await loadResearchRun(db, TEN, id);
  eq(stored!.report !== null, true);
  eq(stored!.report!.sections[0]!.heading, 'Expiry');
});

T('FLOW-017: runResearchSession entry point covers approve → execute → report', async () => {
  const { db, ledger } = await fresh();
  const bare = await runResearchSession(db, ledger, {
    tenant: TEN,
    question: 'session entry?',
    subquestions: ['magic link expiry'],
    approvedBy: 'human:priya',
    by: 'agent:eng',
    scope: 'engineering',
    now: NOW,
    search,
  });
  eq(bare.run.status, 'COMPLETED');
  eq(bare.run.findingIds.length > 0, true);
  const withReport = await runResearchSession(db, ledger, {
    tenant: TEN,
    question: 'session entry?',
    subquestions: ['magic link expiry'],
    id: bare.run.id,
    resume: true,
    by: 'agent:eng',
    scope: 'engineering',
    now: NOW,
    search,
    sections: [
      { heading: 'Expiry', bullets: [{ text: 'ten-minute single-use tokens', claimIds: [bare.run.findingIds[0]!] }] },
    ],
  });
  eq(withReport.report !== undefined, true);
  eq(withReport.run.report !== null, true);
});

console.log('\n\x1b[1mWedge — research report uncertainty (FLOW-018)\x1b[0m');

T('FLOW-018: zero-result sub-question recorded as a gap', async () => {
  const { ledger } = await fresh();
  const emptySearch = async (_q: string): Promise<SearchHit[]> => [];
  const run = approveResearchPlan(
    createResearchRun(TEN, 'q?', ['magic link expiry', 'empty topic'], { now: NOW }),
    'human:priya',
  );
  const done = await executeResearchRun(ledger, run, emptySearch, { by: 'a', scope: 'e', now: NOW });
  const zeroCov = done.coverage.find((c) => c.subquestion === 'empty topic');
  eq(zeroCov?.noResults, true, 'searched with no acceptable sources:');
  const progress = researchProgress(done);
  eq(progress.gaps.includes('empty topic'), true);
});

T('FLOW-018: all sources rejected surfaces counts without implying certainty', async () => {
  const { ledger } = await fresh();
  const run = approveResearchPlan(
    createResearchRun(TEN, 'q?', ['magic link expiry'], {
      blocklist: ['slack.engineering', 'vendor.blog'],
      now: NOW,
    }),
    'human:priya',
  );
  const done = await executeResearchRun(ledger, run, search, { by: 'a', scope: 'e', now: NOW });
  eq(done.rejected.blocklist >= 2, true, 'blocked sources counted:');
  eq(done.coverage[0]!.noResults, true);
  const sections = [{ heading: 'Gaps', bullets: [{ text: 'no direct evidence found', kind: 'inference' as const }] }];
  const attached = await attachResearchReport(ledger, TEN, done, sections, NOW);
  eq(attached.report!.rejectedSources.blocklist >= 2, true);
  eq(attached.report!.gaps.includes('magic link expiry'), true);
  eq(attached.report!.sources.length, 0, 'no bibliography without citations:');
});

T('FLOW-018: shared source links to every sub-question that found or corroborated it', async () => {
  const { ledger } = await fresh();
  const done = await executeResearchRun(ledger, planned(), search, { by: 'a', scope: 'e', now: NOW });
  eq(done.rejected.corroborated >= 1, true, 'duplicate URI corroborated not re-banked:');
  const slackSubs = done.uriSubquestions['https://slack.engineering/magic'] ?? [];
  eq(slackSubs.includes('magic link expiry'), true);
  eq(slackSubs.includes('magic link device check'), true);
  const [f1] = done.findingIds;
  const attached = await attachResearchReport(
    ledger,
    TEN,
    done,
    [{ heading: 'Shared', bullets: [{ text: 'slack magic links', claimIds: [f1!] }] }],
    NOW,
  );
  eq(attached.report!.sources[0]!.subquestions.length, 2, 'bibliography preserves question links:');
});

T('FLOW-018: contradicted citation warning carried into attached report', async () => {
  const { ledger } = await fresh();
  const done = await executeResearchRun(ledger, planned(), search, { by: 'a', scope: 'e', now: NOW });
  const [f1, f2] = done.findingIds;
  const disputed = await ledger.append({
    tenant: TEN,
    subject: 'research:test',
    kind: 'OBSERVATION',
    statement: 'conflicting claim',
    confidence: 0.5,
    owner: 'a',
    scope: 'e',
    authorType: 'agent',
    observedAt: NOW,
    validFrom: NOW,
    now: NOW,
    provenance: {
      sourceUri: 'https://example.com/conflict',
      sourceTier: 'SINGLE_SOURCE',
      extractor: 'test',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });
  await ledger.link(TEN, f1!, disputed.id, 'contradicts');
  const sections = [
    {
      heading: 'Contested',
      bullets: [
        { text: 'ten-minute tokens (contested)', claimIds: [f1!] },
        { text: 'device binding', claimIds: [f2!] },
      ],
    },
  ];
  const v = await verifyResearchReport(ledger, TEN, done, sections, NOW);
  eq(v.contradictions.includes(f1!), true);
  const attached = await attachResearchReport(ledger, TEN, done, sections, NOW);
  eq(attached.report!.contradictions.includes(f1!), true);
  eq(attached.report!.sources.length, 2);
});

T('FLOW-018: unsupported bullets rejected; labeled inferences attach without citations', async () => {
  const { ledger } = await fresh();
  const done = await executeResearchRun(ledger, planned(), search, { by: 'a', scope: 'e', now: NOW });
  const [f1] = done.findingIds;
  await rejects(
    async () =>
      await attachResearchReport(ledger, TEN, done, [{ heading: 'H', bullets: [{ text: 'unsupported hype' }] }], NOW),
    'UNSUPPORTED_REPORT',
  );
  const attached = await attachResearchReport(
    ledger,
    TEN,
    done,
    [
      {
        heading: 'Mixed',
        bullets: [
          { text: 'ten-minute tokens', claimIds: [f1!] },
          { text: 'might improve retention', kind: 'inference' },
        ],
      },
    ],
    NOW,
  );
  eq(attached.report!.inferences, [1]);
  eq(attached.report!.sources.length, 1);
});

T('FLOW-018: report round-trip preserves gaps, contradictions, and coverage', async () => {
  const { ledger } = await fresh();
  const run = approveResearchPlan(createResearchRun(TEN, 'q?', ['empty topic'], { now: NOW }), 'human:priya');
  const done = await executeResearchRun(ledger, run, async () => [], { by: 'a', scope: 'e', now: NOW });
  const attached = await attachResearchReport(
    ledger,
    TEN,
    done,
    [{ heading: 'Gaps', bullets: [{ text: 'coverage incomplete', kind: 'inference' }] }],
    NOW,
  );
  const roundTripped = parseResearchReport(serializeResearchReport(attached.report!));
  eq(roundTripped.gaps.includes('empty topic'), true);
  eq(roundTripped.coverage[0]!.noResults, true);
  eq(roundTripped.inferences, [0]);
  eq(roundTripped.rejectedSources.blocklist, 0);
});

T('FLOW-017: stale failure cannot overwrite a newer same-token revision', async () => {
  const { db, ledger } = await fresh();
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'revision race?', ['a'], { now: NOW }),
    'human:priya',
    NOW,
  );
  let newer = '';
  await rejects(
    () =>
      executeResearchRun(
        ledger,
        approved,
        async () => {
          const current = (await loadResearchRun(db, TEN, approved.id))!;
          await persistResearchRun(db, { ...current, updatedAt: '2026-09-10T12:00:00.000Z' });
          newer = JSON.stringify(await loadResearchRun(db, TEN, approved.id));
          throw new Error('provider failed after revision changed');
        },
        { by: 'a', scope: 'e', now: NOW, db },
      ),
    'provider failed',
  );
  eq(JSON.stringify(await loadResearchRun(db, TEN, approved.id)), newer);
  await db.close();
});

T('FLOW-017: failed research reopens and explicitly resumes the exact approved plan through sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vital-research-'));
  const file = join(dir, 'research.sqlite');
  let db = openDb(file);
  try {
    await migrate(db);
    const approved = await approveAndPersistResearchPlan(
      db,
      createResearchRun(TEN, 'restart?', ['magic link expiry', 'magic link device check'], {
        now: NOW,
        allowlist: ['slack.engineering', 'auth.example'],
        blocklist: ['vendor.blog'],
      }),
      'human:priya',
      NOW,
      { maxSearches: 3, maxResultsPerQuestion: 2 },
    );
    const failed = await executeResearchRun(
      createLedger(db),
      approved,
      async (q) => {
        if (q === 'magic link device check') throw new Error('provider secret must not be persisted');
        return search(q);
      },
      { by: 'a', scope: 'e', now: NOW, db },
    );
    eq(failed.status, 'FAILED');
    eq(failed.totalSearches, 2);
    eq(failed.failure, { code: 'RESEARCH_STEP_FAILED', subquestion: 'magic link device check' });
    eq(failed.executionToken, null);
    eq(failed.executionLeaseAt, null);
    await db.close();
    db = openDb(file);
    const stored = (await loadResearchRun(db, TEN, approved.id))!;
    eq(stored, failed);
    eq(researchProgress(stored).remainingQuestions, ['magic link device check']);
    await rejects(() => resumeResearchRun(db, TEN, approved.id), 'EXECUTION_CONFLICT');
    await rejects(
      () =>
        resumeResearchRun(db, TEN, approved.id, {
          by: 'human:priya',
          expectedRevision: approved.revision!,
          now: NOW,
        }),
      'REVISION_CONFLICT',
    );
    await rejects(
      () =>
        resumeResearchRun(db, TEN, approved.id, {
          by: ' ',
          expectedRevision: stored.revision!,
          now: NOW,
        }),
      'NO_RECOVERER',
    );
    await rejects(
      () =>
        executeResearchRun(createLedger(db), approved, search, {
          by: 'a',
          scope: 'e',
          now: NOW,
          db,
        }),
      'UNAPPROVED_RESEARCH',
    );
    eq(await loadResearchRun(db, TEN, approved.id), stored);
    const searched: string[] = [];
    const result = await runResearchSession(db, createLedger(db), {
      tenant: TEN,
      id: approved.id,
      resume: true,
      question: 'ignored caller reconstruction',
      subquestions: ['ignored'],
      recovery: { by: 'human:priya', expectedRevision: stored.revision!, now: NOW },
      by: 'b',
      scope: 'e',
      now: NOW,
      search: async (q) => {
        searched.push(q);
        return search(q);
      },
    });
    eq(result.run.status, 'COMPLETED');
    eq(searched, ['magic link device check']);
    eq(result.run.totalSearches, 3);
    eq(result.run.failure, null);
    eq(result.run.findingIds.slice(0, stored.findingIds.length), stored.findingIds);
    for (const key of ['question', 'subquestions', 'allowlist', 'blocklist', 'approvedBy', 'approvedBudgets'] as const)
      eq(result.run[key], approved[key]);
    eq(result.run.findingIds.length, 2);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM claims').get())!.n, 2);
    eq(result.report, undefined);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

T('FLOW-017: failed searches consume approved budget even after explicit recovery', async () => {
  const { db, ledger } = await fresh();
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'budget failure?', ['a'], { now: NOW }),
    'human:priya',
    NOW,
    { maxSearches: 1, maxResultsPerQuestion: 1 },
  );
  const failed = await executeResearchRun(
    ledger,
    approved,
    async () => {
      throw new Error('offline');
    },
    { by: 'a', scope: 'e', now: NOW, db },
  );
  const resumed = await resumeResearchRun(db, TEN, approved.id, {
    by: 'human:priya',
    expectedRevision: failed.revision!,
    now: NOW,
  });
  await rejects(
    () =>
      executeResearchRun(ledger, resumed, search, { by: 'a', scope: 'e', now: NOW, db, budgets: { maxSearches: 2 } }),
    'BUDGET_EXCEEDS_APPROVAL',
  );
  let calls = 0;
  const paused = await executeResearchRun(
    ledger,
    resumed,
    async () => {
      calls++;
      return [];
    },
    { by: 'a', scope: 'e', now: NOW, db },
  );
  eq(paused.status, 'PAUSED_BUDGET');
  eq(paused.totalSearches, 1);
  eq(calls, 0);
  eq(researchProgress(paused).remainingQuestions, ['a']);
  await db.close();
});

T('FLOW-017: banking failure rolls back the entire question without phantom findings', async () => {
  const { db, ledger } = await fresh();
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'banking?', ['magic link expiry', 'magic link device check'], { now: NOW }),
    'human:priya',
    NOW,
  );
  const banked: string[] = [];
  let appends = 0;
  const failed = await executeResearchRun(
    {
      ...ledger,
      append: async (input) => {
        appends++;
        if (appends === 4) throw new Error('ledger unavailable');
        const claim = await ledger.append(input);
        banked.push(claim.id);
        return claim;
      },
    },
    approved,
    async (q) =>
      q === 'magic link expiry'
        ? search(q)
        : [
            { uri: 'https://auth.example/new', title: 'new', snippet: 'partial' },
            { uri: 'https://auth.example/fail', title: 'fail', snippet: 'failure' },
          ],
    { by: 'a', scope: 'e', now: NOW, db },
  );
  eq(failed.status, 'FAILED');
  eq(failed.findingIds, banked.slice(0, 2));
  eq(await ledger.get(TEN, banked[2]!), null);
  eq(
    failed.seenUris,
    hits['magic link expiry']!.map((h) => h.uri),
  );
  eq(failed.completedSteps, ['magic link expiry']);
  eq(failed.coverage.length, 1);
  eq(failed.totalSearches, 2);
  eq(await loadResearchRun(db, TEN, approved.id), failed);
  const resumed = await resumeResearchRun(db, TEN, approved.id, {
    by: 'b',
    expectedRevision: failed.revision!,
    now: NOW,
  });
  const done = await executeResearchRun(ledger, resumed, search, { by: 'b', scope: 'e', now: NOW, db });
  eq(done.status, 'COMPLETED');
  eq(done.findingIds.length, 3);
  await db.close();
});

for (const rejectsSearch of [false, true]) {
  T(`FLOW-017: persisted cancellation wins an in-flight search ${rejectsSearch ? 'failure' : 'success'}`, async () => {
    const { db, ledger } = await fresh();
    const approved = await approveAndPersistResearchPlan(
      db,
      createResearchRun(TEN, 'cancel race?', ['a'], { now: NOW }),
      'human:priya',
      NOW,
    );
    const started = deferred<void>();
    const pending = deferred<SearchHit[]>();
    const execution = executeResearchRun(
      ledger,
      approved,
      async () => {
        started.resolve();
        return pending.promise;
      },
      { by: 'a', scope: 'e', now: NOW, db },
    );
    await started.promise;
    const cancelled = await cancelPersistedResearchRun(db, approved, 'human:priya', NOW);
    if (rejectsSearch) pending.reject(new Error('late provider failure'));
    else pending.resolve(hits['magic link expiry']!);
    eq(await execution, cancelled);
    eq(await loadResearchRun(db, TEN, approved.id), cancelled);
    eq(cancelled.totalSearches, 1);
    eq(cancelled.findingIds, []);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM claims').get())!.n, 0);
    await db.close();
  });

  T(`FLOW-017: recovered owner fences old executor ${rejectsSearch ? 'failure' : 'results'}`, async () => {
    const { db, ledger } = await fresh();
    const approved = await approveAndPersistResearchPlan(
      db,
      createResearchRun(TEN, 'owner race?', ['a'], { now: NOW }),
      'human:priya',
      NOW,
    );
    const started = deferred<void>();
    const pending = deferred<SearchHit[]>();
    const old = executeResearchRun(
      ledger,
      approved,
      async () => {
        started.resolve();
        return pending.promise;
      },
      { by: 'same-owner', scope: 'e', now: NOW, db },
    );
    const rejected = rejects(() => old, rejectsSearch ? 'late provider failure' : 'EXECUTION_CONFLICT');
    await started.promise;
    const running = (await loadResearchRun(db, TEN, approved.id))!;
    const resumed = await resumeResearchRun(db, TEN, approved.id, {
      by: 'human:priya',
      expectedRevision: running.revision!,
      now: NOW,
    });
    const winner = await executeResearchRun(ledger, resumed, async () => [], {
      by: 'same-owner',
      scope: 'e',
      now: NOW,
      db,
    });
    if (rejectsSearch) pending.reject(new Error('late provider failure'));
    else pending.resolve(hits['magic link expiry']!);
    await rejected;
    eq(winner.status, 'COMPLETED');
    eq(winner.totalSearches, 2);
    eq(await loadResearchRun(db, TEN, approved.id), winner);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM claims').get())!.n, 0);
    await db.close();
  });
}

T('FLOW-017: cancellation between failure read and failure checkpoint remains authoritative', async () => {
  const { db, ledger } = await fresh();
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'failure checkpoint race?', ['a'], { now: NOW }),
    'human:priya',
    NOW,
  );
  let cancelAtCheckpoint = false;
  const racingDb: AsyncDb = {
    ...db,
    transaction: async (fn, options) => {
      if (cancelAtCheckpoint) {
        cancelAtCheckpoint = false;
        await cancelPersistedResearchRun(db, approved, 'human:priya', NOW);
      }
      return db.transaction(fn, options);
    },
  };
  const result = await executeResearchRun(
    ledger,
    approved,
    async () => {
      cancelAtCheckpoint = true;
      throw new Error('provider failed');
    },
    { by: 'a', scope: 'e', now: NOW, db: racingDb },
  );
  eq(result.status, 'CANCELLED');
  eq(result.failure, null);
  eq(await loadResearchRun(db, TEN, approved.id), result);
  await db.close();
});

T('FLOW-017: unavailable failure persistence rejects instead of claiming a durable failure', async () => {
  const { db, ledger } = await fresh();
  const approved = await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'storage failure?', ['a'], { now: NOW }),
    'human:priya',
    NOW,
  );
  const brokenDb: AsyncDb = {
    ...db,
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        ...statement,
        run: async (...params) => {
          if (sql.startsWith('UPDATE meta') && JSON.parse(String(params[0])).status === 'FAILED')
            throw new Error('checkpoint storage unavailable');
          return statement.run(...params);
        },
      };
    },
  };
  await rejects(
    () =>
      executeResearchRun(
        ledger,
        approved,
        async () => {
          throw new Error('provider failed');
        },
        { by: 'a', scope: 'e', now: NOW, db: brokenDb },
      ),
    'checkpoint storage unavailable',
  );
  const stored = (await loadResearchRun(db, TEN, approved.id))!;
  eq(stored.status, 'RUNNING');
  eq(stored.totalSearches, 1);
  await rejects(() => resumeResearchRun(db, TEN, approved.id), 'EXECUTION_CONFLICT');
  await db.close();
});

T('FLOW-017: session resume without an id refuses to create or approve new research', async () => {
  const { db, ledger } = await fresh();
  await rejects(
    () =>
      runResearchSession(db, ledger, {
        tenant: TEN,
        resume: true,
        question: 'not a new plan',
        subquestions: ['a'],
        by: 'a',
        scope: 'e',
        now: NOW,
        search,
      }),
    'RUN_NOT_FOUND',
  );
  eq((await db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'research:%'").get())!.n, 0);
  await db.close();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
