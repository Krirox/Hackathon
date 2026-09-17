import { T, eq, TEN, NOW, fresh, rejects } from './helpers.ts';
import {
  approveResearchPlan,
  attachResearchReport,
  cancelResearchRun,
  createResearchRun,
  executeResearchRun,
  proposeSubquestions,
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
  // 2 + 2 hits, one URI seen twice → 3 findings (corroborated, not duplicated).
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
  eq(attached.report!.sources.length, 3);
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
  // The draft feeds the human-approved plan path, not around it.
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
