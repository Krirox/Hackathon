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
  await approveAndPersistResearchPlan(
    db,
    createResearchRun(TEN, 'q?', subs, { now: NOW, id }),
    'human:priya',
    NOW,
  );
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
  const attached = await attachResearchReport(ledger, TEN, done, [
    { heading: 'Shared', bullets: [{ text: 'slack magic links', claimIds: [f1!] }] },
  ], NOW);
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
      bullets: [{ text: 'ten-minute tokens (contested)', claimIds: [f1!] }, { text: 'device binding', claimIds: [f2!] }],
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
  const attached = await attachResearchReport(ledger, TEN, done, [
    {
      heading: 'Mixed',
      bullets: [
        { text: 'ten-minute tokens', claimIds: [f1!] },
        { text: 'might improve retention', kind: 'inference' },
      ],
    },
  ], NOW);
  eq(attached.report!.inferences, [1]);
  eq(attached.report!.sources.length, 1);
});

T('FLOW-018: report round-trip preserves gaps, contradictions, and coverage', async () => {
  const { ledger } = await fresh();
  const run = approveResearchPlan(createResearchRun(TEN, 'q?', ['empty topic'], { now: NOW }), 'human:priya');
  const done = await executeResearchRun(ledger, run, async () => [], { by: 'a', scope: 'e', now: NOW });
  const attached = await attachResearchReport(ledger, TEN, done, [
    { heading: 'Gaps', bullets: [{ text: 'coverage incomplete', kind: 'inference' }] },
  ], NOW);
  const roundTripped = parseResearchReport(serializeResearchReport(attached.report!));
  eq(roundTripped.gaps.includes('empty topic'), true);
  eq(roundTripped.coverage[0]!.noResults, true);
  eq(roundTripped.inferences, [0]);
  eq(roundTripped.rejectedSources.blocklist, 0);
});
