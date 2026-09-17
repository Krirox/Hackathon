import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base, rejects } from './helpers.ts';
import {
  checkDraft,
  fanOut,
  fanOutWorkflow,
  getFanOutWorkflow,
  getReleaseStage,
  isKnownRelease,
  joinReleaseDeliverables,
  markReleaseKnown,
  produceReleaseAsset,
  recordReleaseStage,
  resumeFanOutWorkflow,
  summarizeRelease,
  type CustomerSegment,
} from '../src/wedge/ship.ts';
import { churnRespond, churnRespondWorkflow, executeChurnPlay } from '../src/wedge/churn.ts';
import { stableFanOutRunId } from '../src/wedge/fanout-workflow.ts';
import { LocalEchoAdapter } from '../src/substrate/harness.ts';
import type { Collector } from '../src/ingest/collectors.ts';

console.log('\n\x1b[1mWedge — Ship-to-Result coordination half\x1b[0m');

const marks = async (db: Awaited<ReturnType<typeof fresh>>['db']) =>
  ((await db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'wedge:summary:%'").get()) as { n: number }).n;

const relClaim = async (ledger: Awaited<ReturnType<typeof fresh>>['ledger'], subject: string, statement: string) =>
  await ledger.append({
    tenant: TEN,
    subject,
    kind: 'FACT',
    statement,
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor('https://github.com/acme/app/releases'),
  });

T('a change summary cites every bullet; uncited sentences are refused', async () => {
  const { ledger } = await fresh();
  const a = await relClaim(ledger, 'release:v2.14', 'EU streaming ships behind flag eu_streaming');
  const s = await summarizeRelease(
    ledger,
    TEN,
    'v2.14',
    [{ text: 'EU streaming available', claimIds: [a.id], affected: ['sales'] }],
    NOW,
  );
  eq(s.whatChanged[0]!.claimIds, [a.id]);
  eq(s.sources[0]!.claimId, a.id);
  await rejects(
    async () =>
      await summarizeRelease(ledger, TEN, 'v2.14', [{ text: 'uncited hype', claimIds: [], affected: [] }], NOW),
    'UNCITED_SENTENCE',
  );
  await rejects(
    async () =>
      await summarizeRelease(
        ledger,
        TEN,
        'v2.14',
        [{ text: 'cites a ghost', claimIds: ['clm_nope'], affected: [] }],
        NOW,
      ),
    'UNVERIFIABLE_CITATION',
  );
});

T('a stale-cited summary is refused, not softened', async () => {
  const { ledger } = await fresh();
  const expiring = await ledger.append({
    tenant: TEN,
    subject: 'release:v9',
    kind: 'FACT',
    statement: 'old news',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.markStale(TEN, NOW);
  eq((await ledger.get(TEN, expiring.id))!.status, 'STALE');
  const live = await ledger.append({
    tenant: TEN,
    subject: 'release:v9',
    kind: 'FACT',
    statement: 'current',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  // stale claim id must fail; live one passes
  await rejects(
    async () =>
      await summarizeRelease(
        ledger,
        TEN,
        'v9',
        [{ text: 'says old thing', claimIds: [expiring.id], affected: [] }],
        NOW,
      ),
    'UNVERIFIABLE_CITATION',
  );
  const s = await summarizeRelease(
    ledger,
    TEN,
    'v9',
    [{ text: 'says current thing', claimIds: [live.id], affected: [] }],
    NOW,
  );
  eq(s.whatChanged.length, 1);
});

T('novelty: a re-deploy is recognised, not re-summarised', async () => {
  const { db } = await fresh();
  eq(await isKnownRelease(db, 'fp-1'), false);
  await markReleaseKnown(db, 'fp-1', 'sum_1');
  eq(await isKnownRelease(db, 'fp-1'), true);
});

T('fan-out reaches four teams as typed REQUESTs through the scheduler only', async () => {
  // Four of the five legs need human minutes — the default 3/day founder cap
  // would (correctly) deny the fourth, so this pilot tenant raises it.
  const { ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 10,
  });
  const a = await relClaim(ledger, 'release:v2.14', 'EU streaming ships');
  const out = await fanOut(coord, TEN, {
    release: 'v2.14',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'EU streaming',
  });
  eq(Object.keys(out).length, 5);
  for (const id of Object.values(out)) {
    const r = (await coord.get(TEN, id))!;
    eq(r.state, 'ADMITTED');
    eq(r.claimRefs, [a.id], 'every fan-out leg is grounded:');
  }
  const toSales = (await coord.get(TEN, out.sales))!;
  eq(toSales.targetScope, 'sales');
  eq(toSales.deliverableSchema, 'battlecard.v1');
});

T('the claims checker blocks unverified citations and regulated phrases', async () => {
  const { ledger } = await fresh();
  const good = await relClaim(ledger, 'r', 'latency p99 120ms');
  const guess = await ledger.append({
    tenant: TEN,
    subject: 'r',
    kind: 'BELIEF',
    statement: 'users will love it',
    confidence: 0.4,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:m',
    scope: 'x',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  eq((await checkDraft(ledger, TEN, { text: 'Latency p99 120ms.', claimIds: [good.id] }, NOW)).ok, true);
  const bad = await checkDraft(ledger, TEN, { text: 'Users will love it.', claimIds: [guess.id] }, NOW);
  eq(bad.ok, false);
  eq(bad.unverified, [guess.id]);
  const reg = await checkDraft(ledger, TEN, { text: 'Guaranteed 40% returns, risk-free.', claimIds: [good.id] }, NOW);
  eq(reg.ok, false);
  eq(reg.deniedPhrases.length > 0, true, 'regulated phrases force a human:');
});

T('fan-out legs inherit the base() grounding rule — ungrounded work never leaves', async () => {
  const { coord } = await fresh();
  await rejects(async () => await coord.submit(base({ claimRefs: [] })), 'UNGROUNDED_WORK');
});

T('a second loop (churn-response) runs on the same reality without colliding', async () => {
  const limits = {
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  };
  const { ledger, coord } = await fresh(limits);
  const rel = await ledger.append({
    tenant: TEN,
    subject: 'release:v2.14',
    kind: 'FACT',
    statement: 'EU streaming ships',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const risk = await ledger.append({
    tenant: TEN,
    subject: 'churn:emea',
    kind: 'BELIEF',
    statement: 'EMEA trial churn rising',
    confidence: 0.6,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:cs',
    scope: 'customer',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'CORROBORATED' },
  });
  const ship = await fanOut(coord, TEN, {
    release: 'v2.14',
    claimIds: [rel.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'EU streaming',
  });
  const churn = await churnRespond(coord, ledger, TEN, {
    segment: 'EMEA trials',
    riskClaimIds: [risk.id],
    onBehalfOf: 'human:priya',
    now: NOW,
  });
  // Both loops admitted through the one scheduler; both decisions replay.
  eq((await coord.get(TEN, Object.values(ship)[0]!))!.state, 'ADMITTED');
  eq((await coord.get(TEN, churn.outreachRequestId))!.state, 'ADMITTED');
  const r1 = await ledger.replayDecision(TEN, churn.decisionId);
  eq(
    r1.drift.every((d) => !d.drifted),
    true,
    'fresh bundles show no drift:',
  );
  // Ungrounded churn loops are refused like ungrounded anything else.
  await rejects(
    async () => await churnRespond(coord, ledger, TEN, { segment: 'x', riskClaimIds: [], onBehalfOf: 'h', now: NOW }),
    'UNGROUNDED_LOOP',
  );
  // Expired risk is not live basis, even as a belief.
  const staleRisk = await ledger.append({
    tenant: TEN,
    subject: 'churn:old',
    kind: 'BELIEF',
    statement: 'old worry',
    confidence: 0.5,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 'agent:cs',
    scope: 'customer',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  await rejects(
    async () =>
      await churnRespond(coord, ledger, TEN, {
        segment: 'x',
        riskClaimIds: [staleRisk.id],
        onBehalfOf: 'h',
        now: DAY_LATER,
      }),
    'UNVERIFIABLE_CITATION',
  );
});

console.log('\n\x1b[1mWedge — retryable fan-out (F04)\x1b[0m');

T('re-run fan-out reuses deduped legs: no refusal, no duplicate REQUEST', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 10,
  });
  const a = await relClaim(ledger, 'release:v2.14', 'EU streaming ships');
  const input = {
    release: 'v2.14',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'EU streaming',
  };
  const first = await fanOut(coord, TEN, input);
  const count = async () =>
    ((await db.prepare('SELECT COUNT(*) AS n FROM requests WHERE tenant = ?').get(TEN)) as { n: number }).n;
  eq(await count(), 5);
  // A retry (crash after fan-out, same release) resubmits identical legs:
  // the coordinator dedupes them onto the live threads, and fan-out reuses
  // those ids instead of throwing FANOUT_REFUSED.
  const second = await fanOut(coord, TEN, input);
  eq(second, first, 'identical re-run reuses every leg:');
  eq(await count(), 5, 'no duplicate REQUEST rows:');
  // Same rule on the churn loop: legs reused, only the decision is new.
  const risk = await ledger.append({
    tenant: TEN,
    subject: 'churn:emea',
    kind: 'BELIEF',
    statement: 'EMEA trial churn rising',
    confidence: 0.6,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:cs',
    scope: 'customer',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'CORROBORATED' },
  });
  const c1 = await churnRespond(coord, ledger, TEN, {
    segment: 'EMEA trials',
    riskClaimIds: [risk.id],
    onBehalfOf: 'human:priya',
    now: NOW,
  });
  const c2 = await churnRespond(coord, ledger, TEN, {
    segment: 'EMEA trials',
    riskClaimIds: [risk.id],
    onBehalfOf: 'human:priya',
    now: NOW,
  });
  eq(c2.outreachRequestId, c1.outreachRequestId, 'dedupe-hit churn leg reused, not refused:');
  eq(c2.offerRequestId, c1.offerRequestId);
});

T('dogfood marks the release known only after ALL stages complete', async () => {
  // Importing the script module must not run its CLI body.
  process.env['VITAL_DOGFOOD_NO_MAIN'] = '1';
  const { runShipPipeline } = await import('../scripts/dogfood-ship.ts');
  const events = [
    {
      source: 'test:dogfood',
      uri: 'https://example.com/c1',
      fingerprint: 'fp-df-1',
      occurredAt: NOW,
      summary: 'dogfood change 1',
      payload: {},
    },
  ];
  const collector: Collector = {
    name: 'test:dogfood',
    sourceTier: 'PRIMARY',
    extractor: 'test-dogfood',
    extractorVersion: '1.0.0',
    poll: () => events,
  };
  // A pipeline that dies mid-way (fan-out denied: zero escalation budget)
  // must NOT leave the release marked — otherwise the retry no-ops.
  const bad = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 0,
  });
  await rejects(
    async () =>
      await runShipPipeline({
        db: bad.db,
        ledger: bad.ledger,
        coord: bad.coord,
        comp: bad.comp,
        tenant: TEN,
        now: NOW,
        collector,
        events,
      }),
    'FANOUT_REFUSED',
  );
  eq(await marks(bad.db), 0, 'failed run leaves the release unmarked:');
  // A full run marks exactly once, and the next run short-circuits as known.
  const good = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  });
  const deps = {
    db: good.db,
    ledger: good.ledger,
    coord: good.coord,
    comp: good.comp,
    tenant: TEN,
    now: NOW,
    collector,
    events,
  };
  const done = await runShipPipeline(deps);
  eq(done.alreadyKnown, false);
  eq(await marks(good.db), 1, 'completed run marks the release:');
  const again = await runShipPipeline(deps);
  eq(again.alreadyKnown, true, 'completed work is recognised, not re-fanned:');
  eq(await marks(good.db), 1, 'the mark stays idempotent:');
  // F15: a simulated run reports itself as such and records no outcome.
  eq(done.simulated, true, 'simulated dogfood run says so:');
  eq(done.outcomeBasis, null, 'no outcome is fabricated:');
  const syntheticKeys = async (db: Awaited<ReturnType<typeof fresh>>['db']) =>
    ((await db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'synthetic:%'").get()) as { n: number }).n;
  eq(await syntheticKeys(good.db), 2, 'decision + card are tagged synthetic:');
});

T('F15: a blocked draft aborts the run before any evidence is minted', async () => {
  process.env['VITAL_DOGFOOD_NO_MAIN'] = '1';
  const { runShipPipeline } = await import('../scripts/dogfood-ship.ts');
  // The draft text is built from the first ingested claim's statement — so
  // the denylisted phrase must ride the event itself. The run must die
  // BEFORE the decision, trace, and card exist (fan-out already happened:
  // that leg is recoverable via dedupe; minted evidence is not un-minted).
  const events = [
    {
      source: 'test:dogfood',
      uri: 'https://example.com/c1',
      fingerprint: 'fp-df-blocked',
      occurredAt: NOW,
      summary: 'we guarantee 100% uptime for all customers',
      payload: {},
    },
  ];
  const collector: Collector = {
    name: 'test:dogfood',
    sourceTier: 'PRIMARY',
    extractor: 'test-dogfood',
    extractorVersion: '1.0.0',
    poll: () => events,
  };
  const bad = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  });
  await rejects(
    async () =>
      await runShipPipeline({
        db: bad.db,
        ledger: bad.ledger,
        coord: bad.coord,
        comp: bad.comp,
        tenant: TEN,
        now: NOW,
        collector,
        events,
      }),
    'DRAFT_BLOCKED',
  );
  const count = async (sql: string) => ((await bad.db.prepare(sql).get()) as { n: number }).n;
  eq(await count('SELECT COUNT(*) AS n FROM decisions'), 0, 'no decision minted:');
  eq(await count('SELECT COUNT(*) AS n FROM outcomes'), 0, 'no outcome minted:');
  eq(await count('SELECT COUNT(*) AS n FROM traces'), 0, 'no trace minted:');
  eq(await count('SELECT COUNT(*) AS n FROM skill_cards'), 0, 'no card minted:');
  eq(await marks(bad.db), 0, 'failed run leaves the release unmarked:');
});

console.log('\n\x1b[1mWedge — durable partial fan-out (FLOW-013)\x1b[0m');

T('FLOW-013: parent run id exists before legs; fourth human leg hits default escalation cap', async () => {
  const { db, ledger, coord } = await fresh();
  const a = await relClaim(ledger, 'release:v2.15', 'APAC billing ships');
  const runId = stableFanOutRunId(TEN, 'ship', 'v2.15', [a.id]);
  const before = await getFanOutWorkflow(db, TEN, runId);
  eq(before, null, 'no run before fan-out:');
  const run = await fanOutWorkflow(db, coord, TEN, {
    release: 'v2.15',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'APAC billing',
  });
  eq(run.id, runId, 'stable parent run id:');
  eq(run.legs[0]!.status, 'ADMITTED');
  eq(run.legs[4]!.key, 'finance');
  eq(run.legs[4]!.status, 'DENIED', 'fourth human-minute leg refused at default cap:');
  eq(run.status, 'PARTIAL');
  const escalations = await coord.dailyEscalations(TEN, NOW.slice(0, 10));
  eq(escalations, 3, 'default cap spends exactly three human escalations:');
});

T('FLOW-013: partial fan-out persists progress and returns created request ids', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 0,
  });
  const a = await relClaim(ledger, 'release:partial', 'partial rollout');
  const run = await fanOutWorkflow(db, coord, TEN, {
    release: 'partial',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'partial',
  });
  eq(run.status, 'BLOCKED');
  eq(run.legs[0]!.status, 'DENIED');
  eq(run.legs[0]!.requestId !== null, true, 'refused leg still has a request id:');
  const reloaded = await getFanOutWorkflow(db, TEN, run.id);
  eq(reloaded?.legs[0]!.requestId, run.legs[0]!.requestId, 'partial progress survives reload:');
});

T('FLOW-013: retry skips completed/deduped legs and retains terminal refusals', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 0,
  });
  const a = await relClaim(ledger, 'release:retry', 'retry rollout');
  const first = await fanOutWorkflow(db, coord, TEN, {
    release: 'retry',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'retry',
  });
  const deniedId = first.legs[0]!.requestId!;
  const count = async () =>
    ((await db.prepare('SELECT COUNT(*) AS n FROM requests WHERE tenant = ?').get(TEN)) as { n: number }).n;
  eq(await count(), 1);
  const second = await resumeFanOutWorkflow(db, coord, TEN, first.id);
  eq(second.legs[0]!.status, 'DENIED');
  eq(second.legs[0]!.requestId, deniedId, 'denied leg is not re-submitted:');
  eq(await count(), 1, 'retry does not mint duplicate requests for refused legs:');
});

T('FLOW-013: churn retry reuses run and keeps one recommendation decision', async () => {
  const limits = {
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  };
  const { db, ledger, coord } = await fresh(limits);
  const risk = await ledger.append({
    tenant: TEN,
    subject: 'churn:emea',
    kind: 'BELIEF',
    statement: 'EMEA trial churn rising',
    confidence: 0.6,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:cs',
    scope: 'customer',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'CORROBORATED' },
  });
  const input = { segment: 'EMEA trials', riskClaimIds: [risk.id], onBehalfOf: 'human:priya', now: NOW };
  const r1 = await churnRespondWorkflow(db, coord, ledger, TEN, input);
  eq(r1.status, 'COMPLETE');
  const r2 = await churnRespondWorkflow(db, coord, ledger, TEN, input);
  eq(r2.id, r1.id, 'churn retry reuses the same workflow run:');
  eq(r2.decisionId, r1.decisionId, 'churn retry does not mint a second recommendation decision:');
  eq(r2.legs.every((l) => l.status === 'ADMITTED' || l.status === 'DEDUPED'), true);
  const decisions = ((await db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE tenant = ?').get(TEN)) as { n: number })
    .n;
  eq(decisions, 1, 'only one churn recommendation decision exists:');
});

T('FLOW-013: deduped legs are success, not refusal', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 10,
  });
  const a = await relClaim(ledger, 'release:dedupe', 'dedupe rollout');
  const input = {
    release: 'dedupe',
    claimIds: [a.id],
    onBehalfOf: 'human:priya',
    now: NOW,
    summary: 'dedupe',
  };
  const first = await fanOutWorkflow(db, coord, TEN, input);
  eq(first.status, 'COMPLETE');
  const second = await fanOutWorkflow(db, coord, TEN, input);
  eq(second.status, 'COMPLETE');
  eq(
    second.legs.filter((l) => l.status === 'DEDUPED').length,
    5,
    'identical re-run marks every leg deduped, not refused:',
  );
});

console.log('\n\x1b[1mWedge — Ship-to-Result closed-loop and churn execution (F14)\x1b[0m');

T('F14: customer segmentation is grounded in summarizeRelease', async () => {
  const { ledger } = await fresh();
  const a = await relClaim(ledger, 'release:v3.0', 'Enterprise SSO support launched');
  const b = await relClaim(ledger, 'release:v3.0', 'Billing webhook latency reduced to 50ms');

  // Default segmentation grounded in affected scopes
  const sDefault = await summarizeRelease(
    ledger,
    TEN,
    'v3.0',
    [
      { text: 'Enterprise SSO support launched', claimIds: [a.id], affected: ['security', 'enterprise'] },
      { text: 'Billing webhook latency reduced', claimIds: [b.id], affected: ['finance'] },
    ],
    NOW,
  );
  eq(sDefault.customerSegments.length, 4); // engineering (from relClaim), security, enterprise, finance
  eq(
    sDefault.customerSegments.some((c) => c.id === 'seg:enterprise'),
    true,
  );
  eq(
    sDefault.customerSegments.find((c) => c.id === 'seg:enterprise')!.impact,
    'Directly affected by changes in enterprise',
  );

  // Explicit customer segments preserved
  const explicit: CustomerSegment[] = [
    {
      id: 'seg:tier1-emea',
      name: 'Tier 1 EMEA Customers',
      tier: 'ENTERPRISE',
      impact: 'SSO rollout requirement',
      rationale: 'Mandatory security upgrade',
      region: 'EMEA',
    },
  ];
  const sExplicit = await summarizeRelease(
    ledger,
    TEN,
    'v3.0',
    [{ text: 'Enterprise SSO support launched', claimIds: [a.id], affected: ['security'] }],
    NOW,
    explicit,
  );
  eq(sExplicit.customerSegments, explicit);
});

T('F14: isKnownRelease and markReleaseKnown support tenant namespacing with fallback', async () => {
  const { db } = await fresh();
  const fp = 'fp-tenant-test';

  // Initially unknown for both tenants
  eq(await isKnownRelease(db, fp, 'tenant-a'), false);
  eq(await isKnownRelease(db, fp, 'tenant-b'), false);

  // Mark known for tenant-a
  await markReleaseKnown(db, fp, 'sum_tenant_a', 'tenant-a');
  eq(await isKnownRelease(db, fp, 'tenant-a'), true);
  eq(await isKnownRelease(db, fp, 'tenant-b'), false);

  // Legacy record without tenant prefix falls back properly
  const legacyFp = 'fp-legacy';
  await markReleaseKnown(db, legacyFp, 'sum_legacy');
  eq(await isKnownRelease(db, legacyFp, 'tenant-any'), true);
});

T('F14: durable release stages progress and recover across failures', async () => {
  const { db } = await fresh();
  const releaseId = 'rel-stage-test';

  eq(await getReleaseStage(db, TEN, releaseId), null);

  await recordReleaseStage(db, TEN, releaseId, 'SUMMARIZED', NOW, { bulletCount: 3 });
  const st1 = await getReleaseStage(db, TEN, releaseId);
  eq(st1?.stage, 'SUMMARIZED');
  eq((st1?.metadata as { bulletCount: number }).bulletCount, 3);

  await recordReleaseStage(db, TEN, releaseId, 'MEASURED', NOW, { actual: 5 });
  const st2 = await getReleaseStage(db, TEN, releaseId);
  eq(st2?.stage, 'MEASURED');
  eq((st2?.metadata as { actual: number }).actual, 5);
});

T('F14: produceReleaseAsset executes complete closed loop with receipt and measured outcome', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  });
  const adapter = new LocalEchoAdapter(db, ledger, coord);
  const a = await relClaim(ledger, 'release:v4.0', 'Postgres streaming replication enabled');

  // Successful production
  let actionExecuted = false;
  const asset = await produceReleaseAsset(
    coord,
    ledger,
    adapter,
    TEN,
    {
      releaseId: 'rel-4.0',
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
      executeAction: () => {
        actionExecuted = true;
        return {
          executed: true,
          receiptId: 'rcpt_blog_published_42',
          output: { url: 'https://blog.acme.com/v4' },
        };
      },
    },
    db,
  );

  eq(actionExecuted, true);
  eq(asset.stage, 'MEASURED');
  eq(asset.draftCheck.ok, true);
  eq(asset.outcome.status, 'COMPLETED');
  eq(asset.actionReceipt?.receiptId, 'rcpt_blog_published_42');
  eq(asset.measuredOutcome.metric, 'launch_reach_impressions');
  eq(asset.measuredOutcome.actual, 1250);

  // Verify stage is recorded in db as MEASURED
  const stage = await getReleaseStage(db, TEN, 'rel-4.0');
  eq(stage?.stage, 'MEASURED');

  // Verify draft rejection with denylisted phrase
  await rejects(
    async () =>
      await produceReleaseAsset(
        coord,
        ledger,
        adapter,
        TEN,
        {
          releaseId: 'rel-4.0-bad',
          scope: 'marketing',
          goal: 'bad marketing post',
          deliverableSchema: 'launch-pack.v1',
          claimIds: [a.id],
          onBehalfOf: 'human:founder',
          approvedBy: 'human:priya',
          command: 'write copy',
          draftText: 'We guarantee 100% uptime with risk-free migrations.',
          now: NOW,
        },
        db,
      ),
    'DRAFT_BLOCKED',
  );

  // Verify ungrounded asset request is rejected
  await rejects(
    async () =>
      await produceReleaseAsset(
        coord,
        ledger,
        adapter,
        TEN,
        {
          releaseId: 'rel-4.0-ungrounded',
          scope: 'marketing',
          goal: 'ungrounded',
          deliverableSchema: 'launch-pack.v1',
          claimIds: [],
          onBehalfOf: 'human:founder',
          approvedBy: 'human:priya',
          command: 'write copy',
          now: NOW,
        },
        db,
      ),
    'UNGROUNDED_ASSET',
  );
});

T('F14: joinReleaseDeliverables aggregates multi-department deliverables into LaunchPack', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 10,
    maxDailyDollars: 200,
    maxDailyTokens: 4_000_000,
    maxHumanEscalationsPerDay: 50,
  });
  const adapter = new LocalEchoAdapter(db, ledger, coord);
  const a = await relClaim(ledger, 'release:v5.0', 'High availability clustering launched');

  const summary = await summarizeRelease(
    ledger,
    TEN,
    'v5.0',
    [{ text: 'High availability clustering launched', claimIds: [a.id], affected: ['product', 'customer'] }],
    NOW,
  );

  const legs = await fanOut(coord, TEN, {
    release: 'v5.0',
    claimIds: [a.id],
    onBehalfOf: 'human:founder',
    now: NOW,
    summary: summary.whyItMatters,
  });

  const pack = await joinReleaseDeliverables(
    coord,
    ledger,
    adapter,
    TEN,
    {
      releaseId: 'v5.0',
      summary,
      legs,
      onBehalfOf: 'human:founder',
      approvedBy: 'human:priya',
      now: NOW,
    },
    db,
  );

  eq(pack.release, 'v5.0');
  eq(pack.allVerified, true);
  eq(Object.keys(pack.deliverables).sort(), ['customer', 'finance', 'marketing', 'product', 'sales']);
  for (const dept of ['customer', 'finance', 'marketing', 'product', 'sales'] as const) {
    eq(pack.deliverables[dept].draftCheck.ok, true);
    eq(pack.deliverables[dept].stage, 'MEASURED');
  }

  const finalStage = await getReleaseStage(db, TEN, 'v5.0');
  eq(finalStage?.stage, 'DELIVERED');
});

T('F14: executeChurnPlay executes investigation, save play, and offer deliverables with draft check', async () => {
  const { db, ledger, coord } = await fresh({
    maxConcurrentPerScope: 10,
    maxDailyDollars: 200,
    maxDailyTokens: 4_000_000,
    maxHumanEscalationsPerDay: 50,
  });
  const adapter = new LocalEchoAdapter(db, ledger, coord);
  const risk = await ledger.append({
    tenant: TEN,
    subject: 'churn:enterprise-apac',
    kind: 'BELIEF',
    statement: 'APAC Enterprise renewal risk due to local compliance requirements',
    confidence: 0.8,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:cs',
    scope: 'customer',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'CORROBORATED' },
  });

  // Successful churn play execution
  const completedPlay = await executeChurnPlay(coord, ledger, adapter, TEN, {
    segment: 'APAC Enterprise',
    riskClaimIds: [risk.id],
    onBehalfOf: 'human:founder',
    approvedBy: 'human:priya',
    savePlayDraftText: 'Custom data residency enablement plan for APAC Enterprise renewals.',
    offerCopyDraftText: 'Complimentary data residency migration assistance for annual commitments.',
    now: NOW,
  });

  eq(completedPlay.status, 'COMPLETED');
  eq(completedPlay.savePlayCheck.ok, true);
  eq(completedPlay.offerCopyCheck.ok, true);
  eq(completedPlay.investigationOutcome.status, 'COMPLETED');

  // Verify approval decision was minted
  const dec = await ledger.getDecision(TEN, completedPlay.decisionId);
  eq(dec?.approvedBy, 'human:priya');
  eq(dec?.autonomy, 'approval');

  // Blocked draft with denylist phrase fails closed
  await rejects(
    async () =>
      await executeChurnPlay(coord, ledger, adapter, TEN, {
        segment: 'APAC Enterprise Bad Draft',
        riskClaimIds: [risk.id],
        onBehalfOf: 'human:founder',
        approvedBy: 'human:priya',
        savePlayDraftText: 'We guarantee 100% profit with risk-free renewals.',
        now: NOW,
      }),
    'DRAFT_BLOCKED',
  );
});
