import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, eq, TEN, NOW, fresh, sor, rejects } from './helpers.ts';
import { installAuthSchema, signupTenant, listUsers } from '../src/core/auth.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import {
  buildActivationState,
  recordSignupAt,
  recordFirstReviewAt,
  runConfiguredIngestion,
  saveActivationConfig,
  startFirstReleaseWorkflow,
  type ActivationConfig,
} from '../src/console/activation.ts';
import { LocalEchoAdapter } from '../src/substrate/harness.ts';
import { produceReleaseAsset } from '../src/wedge/ship.ts';
import {
  approveAndPersistResearchPlan,
  attachResearchReport,
  cancelPersistedResearchRun,
  createResearchRun,
  executeResearchRun,
  loadResearchRun,
  researchProgress,
  resumeResearchRun,
  verifyResearchReport,
  type SearchHit,
} from '../src/wedge/deepresearch.ts';
import { fileDiffCollector } from '../src/ingest/collectors.ts';
import {
  deriveIntegrationState,
  getIntegrationHealth,
  pollCollectorWithHealth,
  recordPollHealth,
} from '../src/ingest/health.ts';
import { loadFanOutRun } from '../src/wedge/fanout-workflow.ts';
import { runIngestionWorker } from '../src/ingest/worker.ts';
import { checkReadiness } from '../src/gov/trust.ts';

console.log('\n\x1b[1mE2E regression gates — open set\x1b[0m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

async function loginCookies(port: number, next?: string) {
  const base = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${base}/login`, { redirect: 'manual' });
  const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const body = `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { cookie: preCookie },
    body,
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, status: res.status, location: res.headers.get('location') };
}

async function provisioned() {
  const ctx = await fresh();
  const { db } = ctx;
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  return ctx;
}

// E2E-01: website CTA → deployment → owner setup → first source → first cited review.
T('E2E-01: site CTA resolves same-origin; owner setup ingests a first source into a release workflow', async () => {
  const html = readFileSync(join(process.cwd(), 'site', 'index.html'), 'utf8');
  eq(html.includes('data-cta="console-signin"'), true, 'signin CTA marked:');
  eq(html.includes('href="/login"'), true, 'signin CTA is same-origin /login:');
  eq(html.includes('<meta name="vital-console-url" content=""/>'), true, 'no shipped visitor-localhost:');

  const { db, ledger, coord } = await provisioned();
  try {
    await recordSignupAt(db, TEN, NOW);
    const users = await listUsers(db, TEN);
    const owner = users.find((u) => u.role === 'owner')!;
    const src = mkdtempSync(join(tmpdir(), 'vital-e2e01-src-'));
    const art = mkdtempSync(join(tmpdir(), 'vital-e2e01-art-'));
    writeFileSync(join(src, 'CHANGELOG.md'), '# v2.14\n- EU streaming ships\n');
    const config: ActivationConfig = {
      scope: 'engineering',
      sourceKind: 'files',
      sourcePath: src,
      artifactDir: art,
      accountableOwnerId: owner.id,
      approverRole: 'member',
      dailyBudgetDollars: 100,
      humanMinutesBudget: 60,
      configuredAt: NOW,
    };
    await saveActivationConfig(db, TEN, config);
    const ing = await runConfiguredIngestion(db, ledger, TEN, config);
    eq(ing.claimIds.length > 0, true, 'first real source becomes ledger evidence:');
    const claim = (await ledger.get(TEN, ing.claimIds[0]!))!;
    eq(claim.kind, 'OBSERVATION');
    const runId = await startFirstReleaseWorkflow(db, coord, TEN, config, owner, NOW);
    eq(typeof runId, 'string');
    const run = await loadFanOutRun(db, TEN, runId);
    eq(run !== null, true, 'release workflow run persists:');
    eq(run!.legs.length > 0, true, 'workflow fans out legs:');
    const legRequestId = run!.legs.map((l) => l.requestId).find((id): id is string => Boolean(id));
    eq(Boolean(legRequestId), true, 'at least one leg submits a request:');
    const req = await coord.get(TEN, legRequestId!);
    eq(req !== null, true, 'leg request exists:');
    eq(req!.claimRefs.includes(ing.claimIds[0]!), true, 'workflow cites the ingested evidence:');
    await recordFirstReviewAt(db, TEN, NOW);
    const state = await buildActivationState(db, ledger, coord, TEN, NOW, await listUsers(db, TEN));
    eq(state.checklist.find((i) => i.id === 'ingested')!.status, 'done');
    eq(state.checklist.find((i) => i.id === 'workflow')!.status, 'done');
  } finally {
    await db.close();
  }
});

// E2E-02: existing org login → intended destination, no creation loop.
T('E2E-02: provisioned console sends login to the intended destination, never a creation loop', async () => {
  const { db, ledger, coord, comp } = await provisioned();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const signup = await fetch(`${base}/signup`, { redirect: 'manual' });
    eq(signup.status, 303, 'provisioned tenant has no org-creation form:');
    eq(signup.headers.get('location'), '/login', 'creation attempt redirects to login:');
    const login = await loginCookies(server.port, '/console/workflows');
    eq(login.status, 303, 'login redirects:');
    eq(login.location, '/console/workflows', 'login lands on the intended destination:');
    const dest = await fetch(`${base}/console/workflows`, { headers: { cookie: login.cookie } });
    eq(dest.status, 200, 'intended destination serves:');
    const again = await fetch(`${base}/login`, {
      headers: { cookie: login.cookie },
      redirect: 'manual',
    });
    eq(again.status, 303, 'signed-in user is not looped through login:');
  } finally {
    await server.close();
    await db.close();
  }
});

// E2E-06: approval → frozen decision → exact execution → artifact → outcome → replay.
T('E2E-06: approval freezes a decision; execution, artifact, outcome, and replay bind to it', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  });
  try {
    const adapter = new LocalEchoAdapter(db, ledger, coord);
    const a = await ledger.append({
      tenant: TEN,
      subject: 'release:v6',
      kind: 'FACT',
      statement: 'Postgres streaming replication enabled',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor('https://github.com/acme/app/releases'),
    });
    const asset = await produceReleaseAsset(
      coord,
      ledger,
      adapter,
      TEN,
      {
        releaseId: 'e2e-06',
        scope: 'marketing',
        goal: 'launch blog post for streaming replication',
        deliverableSchema: 'launch-pack.v1',
        claimIds: [a.id],
        onBehalfOf: 'human:founder',
        approvedBy: 'human:priya',
        command: 'write marketing blog copy for streaming replication',
        draftText: 'Postgres streaming replication is now live with 0ms downtime.',
        now: NOW,
        measurement: {
          metric: 'launch_reach_impressions',
          predicted: 1000,
          actual: 1250,
          basis: 'blog views analytics',
        },
        executeAction: () => ({
          executed: true,
          receiptId: 'rcpt_e2e06_blog',
          output: { url: 'https://blog.acme.com/e2e06' },
        }),
      },
      db,
    );
    eq(asset.stage, 'MEASURED');
    eq(asset.actionReceipt?.receiptId, 'rcpt_e2e06_blog', 'exact execution receipt:');
    eq(asset.measuredOutcome.metric, 'launch_reach_impressions');
    const replay = await ledger.replayDecision(TEN, asset.decisionId);
    eq(replay.record.id, asset.decisionId, 'frozen decision replays:');
    eq(
      replay.drift.every((d) => !d.drifted),
      true,
      'no drift at approval time:',
    );
    eq(
      replay.record.bundle.claims.some((c) => c.id === a.id),
      true,
      'frozen bundle holds the approved evidence:',
    );
  } finally {
    await db.close();
  }
});

const hits: Record<string, SearchHit[]> = {
  q1: [{ uri: 'https://example.test/a', title: 'A', snippet: 'device binding mentioned' }],
  q2: [{ uri: 'https://example.test/b', title: 'B', snippet: 'ten-minute single-use tokens' }],
};
const search = async (q: string): Promise<SearchHit[]> => hits[q] ?? [];

// E2E-08: budget pause → partial → resume → complete report with gaps/contradictions retained.
T('E2E-08: research pauses on budget, resumes, and reports with gaps retained', async () => {
  const { db, ledger } = await fresh();
  try {
    const id = 'e2e08_run';
    await approveAndPersistResearchPlan(
      db,
      createResearchRun(TEN, 'q?', ['q1', 'q2', 'q-empty'], { now: NOW, id }),
      'human:priya',
      NOW,
    );
    const paused = await executeResearchRun(ledger, (await loadResearchRun(db, TEN, id))!, search, {
      by: 'a',
      scope: 'e',
      now: NOW,
      budgets: { maxSearches: 1, maxResultsPerQuestion: 8 },
      db,
    });
    eq(paused.status, 'PAUSED_BUDGET');
    const progress = researchProgress((await loadResearchRun(db, TEN, id))!);
    eq(progress.remainingQuestions.length > 0, true, 'partial results name remaining work:');
    const resumed = await resumeResearchRun(db, TEN, id);
    eq(resumed.approvedBy, 'human:priya', 'resume needs no re-approval:');
    const done = await executeResearchRun(ledger, resumed, search, { by: 'a', scope: 'e', now: NOW, db });
    eq(done.status, 'COMPLETED');
    const sections = [
      { heading: 'Findings', bullets: done.findingIds.map((cid) => ({ text: `finding ${cid}`, claimIds: [cid] })) },
    ];
    const v = await verifyResearchReport(ledger, TEN, done, sections, NOW);
    eq(v.ok, true);
    eq(v.gaps.includes('q-empty'), true, 'zero-result question survives as a gap:');
    const reported = await attachResearchReport(ledger, TEN, done, sections, NOW, { db });
    eq(Array.isArray(reported.report?.sources), true, 'cited-only bibliography persisted:');
    eq(reported.report?.gaps.includes('q-empty'), true, 'gaps persist in the attached report:');
  } finally {
    await db.close();
  }
});

// E2E-09: cancellation followed by refresh/restart/stale caller → no silent resume.
T('E2E-09: cancelled research stays cancelled across refresh, restart, and stale callers', async () => {
  const { db, ledger } = await fresh();
  try {
    const id = 'e2e09_run';
    const approved = await approveAndPersistResearchPlan(
      db,
      createResearchRun(TEN, 'q?', ['q1', 'q2'], { now: NOW, id }),
      'human:priya',
      NOW,
    );
    await cancelPersistedResearchRun(db, approved, 'human:priya', NOW);
    eq((await loadResearchRun(db, TEN, id))!.status, 'CANCELLED');
    // Stale in-memory caller cannot execute past the persisted cancellation.
    const stale = await executeResearchRun(ledger, approved, search, { by: 'a', scope: 'e', now: NOW, db });
    eq(stale.status, 'CANCELLED');
    // Restart (fresh load) still sees the cancellation; resume is refused.
    eq((await loadResearchRun(db, TEN, id))!.status, 'CANCELLED');
    await rejects(async () => await resumeResearchRun(db, TEN, id), 'RUN_CANCELLED');
  } finally {
    await db.close();
  }
});

// E2E-10: session expiry during review → retained context → recheck → explicit submit.
T('E2E-10: expired review session preserves destination, rechecks, and never auto-submits', async () => {
  const { db, ledger, coord, comp } = await provisioned();
  const admitted = await coord.submit({
    tenant: TEN,
    messageClass: 'REQUEST',
    originScope: 'product',
    targetScope: 'engineering',
    goal: 'review me after expiry',
    claimRefs: ['clm_1'],
    deliverableSchema: 'feasibility.v1',
    onBehalfOf: 'human:priya',
    now: NOW,
  });
  const target = `/console/requests/${admitted.request.id}`;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const session = await loginCookies(server.port);
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE tenant = ?').get(TEN)) as {
      n: number;
    };
    // Expire the session server-side (simulates expiry mid-review).
    await db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const gated = await fetch(`${base}${target}`, { headers: { cookie: session.cookie }, redirect: 'manual' });
    eq(gated.status, 303, 'expired review redirects to sign-in:');
    const location = gated.headers.get('location')!;
    eq(location.includes('reason=expired'), true, 'expiry reason retained:');
    eq(location.includes(encodeURIComponent(target)), true, 'review destination retained:');
    const api = await fetch(`${base}/api/metrics`, { headers: { cookie: session.cookie } });
    eq(api.status, 401, 'API callers get an explicit expired payload:');
    eq(((await api.json()) as { code: string }).code, 'SESSION_EXPIRED');
    // Re-authenticate to the retained destination; nothing was auto-submitted.
    const back = await loginCookies(server.port, target);
    eq(back.location, target);
    const page = await fetch(`${base}${target}`, { headers: { cookie: back.cookie } });
    eq(page.status, 200, 'recheck serves the same review after sign-in:');
    const after = (await db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE tenant = ?').get(TEN)) as {
      n: number;
    };
    eq(after.n, before.n, 'no approval was replayed by the expiry:');
  } finally {
    await server.close();
    await db.close();
  }
});

// E2E-12: integration outage/partial → useful status → recovery → no dupes.
T('E2E-12: outage surfaces failed health; recovery settles receipts without duplicate claims', async () => {
  const { db, ledger } = await fresh();
  try {
    const collectorName = 'files:e2e12';
    const failing = {
      name: collectorName,
      extractor: 'file-diff',
      poll: async (): Promise<never> => {
        throw new Error('SERPER_FETCH provider unreachable');
      },
    };
    try {
      await pollCollectorWithHealth(db, TEN, failing as never, NOW);
      throw new Error('outage poll should have thrown');
    } catch (e) {
      eq((e as Error).message.includes('SERPER_FETCH'), true);
    }
    const failed = await getIntegrationHealth(db, TEN, collectorName, { configured: true, now: NOW });
    eq(failed.state, 'failed', 'outage is a useful failed status, not silence:');
    eq(failed.lastError !== null, true);

    // Recovery: a real source syncs through the worker (poll + settle), and
    // re-delivery banks nothing twice.
    const dir = mkdtempSync(join(tmpdir(), 'vital-e2e12-'));
    writeFileSync(join(dir, 'notes.md'), 'hello\n');
    const art = mkdtempSync(join(tmpdir(), 'vital-e2e12-art-'));
    const collector = fileDiffCollector(collectorName, dir);
    const first = await runIngestionWorker(db, ledger, collector, {
      tenant: TEN,
      scope: 'product',
      artifactDir: art,
      maxReceipts: 50,
    });
    eq(first.claimIds.length, 1, 'recovery settles the source into ledger evidence:');
    const again = await runIngestionWorker(db, ledger, collector, {
      tenant: TEN,
      scope: 'product',
      artifactDir: art,
      maxReceipts: 50,
    });
    eq(again.claimIds.length, 0, 'duplicate delivery banks no duplicate claim:');
    const recovered = await getIntegrationHealth(db, TEN, collectorName, {
      configured: true,
      scope: 'product',
      now: NOW,
    });
    eq(recovered.state, 'ready', 'recovery reports ready:');
    eq(recovered.lastReceipt?.claimId, first.claimIds[0], 'receipt links to the settled claim:');
    await recordPollHealth(db, TEN, collectorName, {
      at: NOW,
      ok: false,
      eventsFetched: 0,
      staged: 0,
      errorCode: 'RATE_LIMITED',
    });
    const limited = deriveIntegrationState({
      configured: true,
      disabled: false,
      stats: recovered.inbox,
      lastPoll: { at: NOW, ok: false, eventsFetched: 0, staged: 0, errorCode: 'RATE_LIMITED' },
      lastSuccessAt: recovered.lastSuccessAt,
      nowMs: Date.parse(NOW),
      delayMs: 86_400_000,
    });
    eq(limited.state, 'rate_limited', 'partial delivery (rate limit) keeps its own state:');
  } finally {
    await db.close();
  }
});

// E2E-17: documented topology → reachable app → readiness fails on dependency loss.
T('E2E-17: compose topology serves liveness; readiness fails when a required dependency is lost', async () => {
  const compose = readFileSync(join(process.cwd(), 'deploy', 'compose.yml'), 'utf8');
  eq(compose.includes('postgres:16'), true, 'documented topology pins postgres:16:');
  eq(compose.includes('vital-core'), true, 'topology defines the application service:');
  eq(compose.includes('127.0.0.1:3100:3100'), true, 'application bind stays loopback:');
  eq(compose.includes('service_healthy'), true, 'app waits on a healthy database:');

  const { db, ledger, coord, comp } = await provisioned();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const healthz = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean };
    eq(healthz.ok, true, 'reachable application answers liveness:');
    eq((await fetch(`${base}/api/metrics`)).status, 401, 'readiness stays session-gated:');
    const session = await loginCookies(server.port);
    const metrics = (await (await fetch(`${base}/api/metrics`, { headers: { cookie: session.cookie } })).json()) as {
      readiness: { ready: boolean };
    };
    eq(metrics.readiness.ready, true, 'healthy dependencies report ready:');
    const outage = await checkReadiness(
      [
        { name: 'database', check: async () => ({ ok: true as const }) },
        {
          name: 'postgres',
          check: async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
          },
        },
      ],
      { timeoutMs: 500 },
    );
    eq(outage.ready, false, 'dependency loss fails readiness instead of passing silently:');
    eq(outage.checks.find((c) => c.name === 'postgres')!.status, 'failing');
  } finally {
    await server.close();
    await db.close();
  }
});
