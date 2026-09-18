import { openDb, migrate } from '../src/core/db.ts';
import { jsonNumber, jsonText } from '../src/core/db.ts';
import { createCoordinator, DEFAULT_LIMITS } from '../src/coord/coordinator.ts';
import {
  buildBeginWorkSpec,
  parseExecutionSpec,
  serializeExecutionSpec,
  validateApprovalBoundary,
  validateExecutionAgainstSpec,
} from '../src/coord/execution-spec.ts';
import { T, eq, TEN, NOW, DAY_LATER, fresh, base, rejects } from './helpers.ts';
console.log('\n\x1b[1mCoordination — the channel model\x1b[0m');

T('FLOW-002: accepting claimed work rejects without resetting execution ownership', async () => {
  const { db, coord } = await fresh();
  try {
    const { request } = await coord.submit(base());
    await coord.claimExecution(TEN, request.id, 'worker-one', NOW);
    await rejects(() => coord.accept(TEN, request.id), 'INVALID_TRANSITION');
    const running = (await coord.get(TEN, request.id))!;
    eq(running.state, 'IN_FLIGHT');
    eq(running.execOwner, 'worker-one');
    eq(running.execAttempt, 1);
    await rejects(() => coord.claimExecution(TEN, request.id, 'worker-two', NOW), 'CLAIM_LOST');
  } finally {
    await db.close();
  }
});

T('QUERY/REQUEST require grounding in claims', async () => {
  const { coord } = await fresh();
  await rejects(async () => await coord.submit(base({ claimRefs: [] })), 'UNGROUNDED_WORK');
});

T('self-delegation is refused', async () => {
  const { coord } = await fresh();
  await rejects(async () => await coord.submit(base({ targetScope: 'marketing' })), 'SELF_DELEGATION');
});

T('idempotency: duplicate in-flight ask dedupes to the same thread', async () => {
  const { coord } = await fresh();
  const a = await coord.submit(base());
  const b = await coord.submit(base());
  eq(a.admitted, true);
  eq(b.dedupedTo, a.request.id);
});

T('idempotency: re-emitted identical NOTICE replays the finished thread', async () => {
  const { coord } = await fresh();
  const a = await coord.submit(base({ messageClass: 'NOTICE', claimRefs: [], goal: 'backup ran' }));
  eq(a.admitted, true);
  // Same content, later instant — the old code crashed on UNIQUE(tenant, idem_key)
  // because NOTICEs persist COMPLETED (terminal) and skipped the in-flight check.
  const b = await coord.submit(base({ messageClass: 'NOTICE', claimRefs: [], goal: 'backup ran', now: DAY_LATER }));
  eq(b.admitted, false, 'not a new thread:');
  eq(b.dedupedTo, a.request.id, 'replayed onto the finished one:');
  eq(b.state, 'COMPLETED');
  const c = await coord.get(TEN, a.request.id);
  eq(c?.state, 'COMPLETED', 'and the original thread is untouched');
});

T('approval latency breaks down per human and per target scope', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'b1', goal: 'slow scope work', now: NOW }));
  await coord.submit(base({ id: 'b2', goal: 'quick scope work', targetScope: 'design', now: NOW }));
  await coord.submit(base({ id: 'b3', goal: 'declined work', now: NOW }));
  // NOW is 2026-09-09T12:00Z: b1 approved +6h, b2 +1s, b3 declined +12h.
  await coord.recordApprovalLatency(TEN, 'b1', 'approve', 'human:slow', '2026-09-09T18:00:00.000Z');
  await coord.recordApprovalLatency(TEN, 'b2', 'approve', 'human:quick', '2026-09-09T12:00:01.000Z');
  await coord.recordApprovalLatency(TEN, 'b3', 'decline', 'human:slow', '2026-09-10T00:00:00.000Z');

  const s = await coord.approvalLatencyStats(TEN);
  eq(s.n, 3, 'declines count as decisions too:');
  eq(s.maxSeconds, 43200);
  eq(s.byHuman[0]!.human, 'human:slow', 'slowest human first:');
  eq(s.byHuman[0]!.n, 2);
  eq(s.byHuman[0]!.medianSeconds, 32400, 'median of 6h and 12h:');
  eq(s.byHuman[1]!.human, 'human:quick');
  eq(s.byHuman[1]!.medianSeconds, 1);
  eq(s.byScope[0]!.scope, 'engineering', 'the scope holding the slow work first:');
  eq(s.byScope[0]!.n, 2);
  eq(s.byScope[1]!.scope, 'design');
  eq(s.byScope[1]!.medianSeconds, 1);
});

T('p90 ranks over sorted values, not insertion order', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'p1', goal: 'slow first', now: NOW }));
  await coord.submit(base({ id: 'p2', goal: 'fast second', now: NOW }));
  // Audit order is [21600, 1]: reading the percentile off insertion order
  // reported p90 = 1 for a distribution whose slow tail is 6h.
  await coord.recordApprovalLatency(TEN, 'p1', 'approve', 'human:a', '2026-09-09T18:00:00.000Z');
  await coord.recordApprovalLatency(TEN, 'p2', 'approve', 'human:b', '2026-09-09T12:00:01.000Z');
  const s = await coord.approvalLatencyStats(TEN);
  eq(s.n, 2);
  eq(s.p90Seconds, 21600, 'p90 is the slow tail regardless of arrival order:');
  eq(s.maxSeconds, 21600);
});

T('reportUsage flows spend mid-run without burning rounds', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'u1' }));
  await coord.reportUsage(TEN, 'u1', { tokens: 400 });
  await coord.reportUsage(TEN, 'u1', { tokens: 100 });
  const r = await coord.get(TEN, 'u1');
  eq(r!.spent.tokens, 500);
  eq(r!.spent.rounds, 0, 'a token flow is continuous activity, not coordination rounds:');
  eq(r!.state, 'IN_FLIGHT', 'first flow moves ADMITTED to IN_FLIGHT:');
});

T('reportUsage budget-death terminates the run mid-flight', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'u2', bid: { tokens: 100 } }));
  const r = await coord.reportUsage(TEN, 'u2', { tokens: 101 });
  eq(r.state, 'TERMINATED_BUDGET');
  eq(r.refusalReason!.includes('mid-run'), true, 'the breach names itself:');
  eq((await coord.get(TEN, 'u2'))!.spent.tokens, 101, 'overspend is recorded, not dropped:');
});

T('spent mirrors track the JSON through every writer', async () => {
  const { db, coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'm1' }));
  await coord.charge(TEN, request.id, { dollars: 4, tokens: 100, humanMinutes: 5 });
  await coord.reportUsage(TEN, request.id, { tokens: 50, dollars: 1 });
  const r = await coord.get(TEN, request.id);
  eq(r!.spent.dollars, 5);
  eq(r!.spent.tokens, 150);
  eq(r!.spent.humanMinutes, 5);
  eq(r!.spent.rounds, 1, 'charge burned one round, reportUsage none:');
  eq(r!.spent.diskBytes, 0);
  const row = (await db
    .prepare('SELECT spent_tokens AS t, spent_dollars AS d FROM requests WHERE id = ?')
    .get(request.id)) as { t: number; d: number };
  eq(Number(row.t), 150, 'mirror follows the atomic update:');
  eq(Number(row.d), 5, 'mirror follows the atomic update:');
});

T('NOTICE never interrupts a human — completes straight to digest', async () => {
  const { coord } = await fresh();
  const r = await coord.submit(
    base({ messageClass: 'NOTICE' as const, claimRefs: [], goal: 'fyi we shipped', bid: { humanMinutes: 30 } }),
  );
  eq(r.request.state, 'COMPLETED');
  eq(r.admitted, true);
});

T('a paid QUERY is rejected — that is a REQUEST in disguise', async () => {
  const { coord } = await fresh();
  const r = await coord.submit(base({ messageClass: 'QUERY' as const, bid: { dollars: 5 } }));
  eq(r.state, 'DENIED');
});

T('hop limit: 4th hop is refused and tells you to escalate to origin', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'r1' }));
  await coord.submit(base({ id: 'r2', originScope: 'engineering', targetScope: 'product', parentRequestId: 'r1' }));
  const r3 = await coord.submit(
    base({ id: 'r3', originScope: 'product', targetScope: 'finance', parentRequestId: 'r2' }),
  );
  eq(r3.admitted, true, 'three hops ok:');
  await rejects(
    async () =>
      await coord.submit(base({ id: 'r4', originScope: 'finance', targetScope: 'legal', parentRequestId: 'r3' })),
    'HOP_LIMIT',
  );
});

T('cycle: a request may not bounce back to a scope already in its chain', async () => {
  const { coord } = await fresh();
  await coord.submit(base({ id: 'c1' }));
  await rejects(
    async () =>
      await coord.submit(
        base({ id: 'c2', originScope: 'engineering', targetScope: 'marketing', parentRequestId: 'c1' }),
      ),
    'CYCLE_DETECTED',
  );
});

T('budget death terminates rather than continuing silently', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ bid: { dollars: 1, maxRounds: 2 } }));
  await coord.charge(TEN, request.id, { dollars: 0.6 });
  const after = await coord.charge(TEN, request.id, { dollars: 0.6 });
  eq(after.state, 'TERMINATED_BUDGET');
});

T('refusal is first-class and counted (sycophancy metric)', async () => {
  const { coord } = await fresh();
  const a = await coord.submit(base({ id: 'f1' }));
  const b = await coord.submit(base({ id: 'f2', goal: 'other ask' }));
  await coord.decline(TEN, a.request.id, 'out of scope this quarter');
  await coord.complete(TEN, b.request.id, { claims: [], cost: { dollars: 0.1 } });
  const s = await coord.refusalStats(TEN);
  eq(s.total, 2);
  eq(s.refused, 1);
});

T('org daily budget denies further work', async () => {
  const db = openDb(':memory:');
  await migrate(db);
  const coord = createCoordinator(db, {
    maxConcurrentPerScope: 99,
    maxDailyDollars: 1,
    maxDailyTokens: 1e9,
    maxHumanEscalationsPerDay: 3,
  });
  const a = await coord.submit(base({ id: 'b1', bid: { dollars: 0.9 } }));
  await coord.charge(TEN, a.request.id, { dollars: 0.9 });
  const b = await coord.submit(base({ id: 'b2', goal: 'second', bid: { dollars: 0.9 } }));
  eq(b.state, 'DENIED');
});

T('the human escalation cap blocks, not just counts', async () => {
  const { coord } = await fresh();
  const ask = async (n: number) =>
    await coord.submit(base({ id: `e${n}`, goal: `human eyes ${n}`, bid: { humanMinutes: 10 } }));
  eq((await ask(1)).admitted, true);
  eq((await ask(2)).admitted, true);
  eq((await ask(3)).admitted, true);
  eq(await coord.openEscalations(TEN, NOW.slice(0, 10)), 3);
  const fourth = await ask(4);
  eq(fourth.admitted, false);
  eq(fourth.state, 'DENIED');
  eq(fourth.reason.includes('escalation cap'), true, 'says why:');
});

T('expireStale retires past-deadline work', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'x1', bid: { deadline: NOW } }));
  eq(request.state, 'ADMITTED');
  const expired = await coord.expireStale(TEN, DAY_LATER);
  eq(expired, [request.id]);
  eq((await coord.get(TEN, request.id))!.state, 'EXPIRED');
});

T('expireStale sweeps backlog in bounded batches with full coverage', async () => {
  const { coord } = await fresh();
  // 505 expired rows force a second round past the 500 batch cap.
  for (let i = 0; i < 505; i++) {
    await coord.submit(base({ id: `sweep${i}`, goal: `sweep work ${i}`, bid: { deadline: NOW } }));
  }
  const expired = await coord.expireStale(TEN, DAY_LATER);
  eq(expired.length, 505, 'every expired row retired across rounds:');
  eq(new Set(expired).size, 505, 'no double-expire:');
  eq((await coord.list(TEN, { state: 'EXPIRED' })).length, 505);
});

T('json accessors emit the right dialect per engine', async () => {
  eq(jsonNumber('sqlite', 'spent_json', 'dollars'), "json_extract(spent_json,'$.dollars')");
  eq(jsonNumber('postgres', 'spent_json', 'dollars'), "((spent_json::jsonb ->> 'dollars'))::float");
  eq(jsonText('sqlite', 'bid_json', 'deadline'), "json_extract(bid_json,'$.deadline')");
  eq(jsonText('postgres', 'bid_json', 'deadline'), "(bid_json::jsonb ->> 'deadline')");
});

T('fuzz: 120 random delegations never exceed 3 hops or cycle', async () => {
  const { coord } = await fresh();
  const scopes = ['marketing', 'engineering', 'product', 'finance', 'legal', 'sales'];
  let s = 1234567;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = () => scopes[Math.floor(rnd() * scopes.length)]!;
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    const o = pick();
    const t = pick();
    if (o === t) continue;
    const parent = ids.length > 0 && rnd() < 0.6 ? ids[Math.floor(rnd() * ids.length)]! : undefined;
    try {
      const r = await coord.submit(
        base({ goal: `fuzz ${i} ${o}>${t}`, originScope: o, targetScope: t, parentRequestId: parent }),
      );
      ids.push(r.request.id);
    } catch (e) {
      if (!/HOP_LIMIT|CYCLE_DETECTED|SELF_DELEGATION/.test((e as Error).message)) throw e;
    }
  }
  eq(ids.length > 0, true, 'fuzz admitted something:');
  for (const r of await coord.list(TEN)) {
    eq(r.hopChain.length <= 3, true, `chain too long on ${r.id}:`);
    // What submit() actually enforces, and therefore what must hold on every
    // stored row: the target was never already in the chain (both
    // CYCLE_DETECTED checks), and depth is capped. Origins alone MAY repeat:
    // redirect() keeps the origin and retries a new target, which is a retry,
    // not a loop — and any attempt to *use* a revisited scope as a target
    // throws. Depth is capped, so no unbounded circulation exists.
    eq(r.hopChain.includes(r.targetScope), false, `cycle on ${r.id}: [${[...r.hopChain, r.targetScope].join(' → ')}]`);
  }
});

T('a request decomposes into budgeted, grounded, parented steps', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'd0', bid: { dollars: 10 } }));
  const kids = await coord.decompose(TEN, request.id, [
    { goal: 'research competitors', deliverableSchema: 'research.v1', bid: { dollars: 3 } },
    { goal: 'draft plan', deliverableSchema: 'plan.v1', bid: { dollars: 3 } },
    { goal: 'implement', deliverableSchema: 'code.v1', targetScope: 'engineering', bid: { dollars: 3 } },
  ]);
  eq(kids.length, 3);
  eq(
    kids.every((k) => k.admitted),
    true,
  );
  for (const k of kids) {
    eq(k.request.claimRefs, ['clm_1'], 'steps inherit the parent grounding:');
  }
  await rejects(
    async () =>
      await coord.decompose(TEN, request.id, [{ goal: 'gold-plate', deliverableSchema: 'x.v1', bid: { dollars: 4 } }]),
    'BUDGET_SPLIT',
    'children fit inside unspent budget:',
  );
  await rejects(async () => await coord.decompose(TEN, request.id, []), 'EMPTY_DECOMPOSE');
  await coord.decline(TEN, request.id, 'no');
  await rejects(
    async () => await coord.decompose(TEN, request.id, [{ goal: 'late', deliverableSchema: 'x.v1' }]),
    'BAD_PARENT',
  );
  await rejects(
    async () => await coord.decompose(TEN, 'req_nope', [{ goal: 'x', deliverableSchema: 'y' }]),
    'NOT_FOUND',
  );
});

T('agents bid low, never high — the scheduler clamps quotas', async () => {
  const db = openDb(':memory:');
  await migrate(db);
  const coord = createCoordinator(db, {
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 1e9,
    maxHumanEscalationsPerDay: 5,
    maxBid: { dollars: 1, maxDiskBytes: 100 },
  });
  const r = await coord.submit(base({ id: 'cap1', bid: { dollars: 50, maxDiskBytes: 99999 } }));
  eq(r.admitted, true);
  eq(r.request.bid.dollars, 1, 'clamped to the ceiling:');
  eq(r.request.bid.maxDiskBytes, 100);
  // Out of the box there is a ceiling: the org's daily allowance. An agent
  // bidding $500 is clamped to $40, never quietly handed a blank cheque.
  const byDefault = await fresh();
  const d = await byDefault.coord.submit(base({ id: 'cap2', bid: { dollars: 500 } }));
  eq(d.request.bid.dollars, 40, 'default ceiling clamps to the daily allowance:');

  // An operator can still say "no ceiling" — but has to say it.
  const uncapped = await fresh({ ...DEFAULT_LIMITS, maxBid: {} });
  const u = await uncapped.coord.submit(base({ id: 'cap3', bid: { dollars: 500 } }));
  eq(u.request.bid.dollars, 500, 'an explicit empty ceiling means no clamping:');
});

T('disk overruns terminate loudly like every other budget', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'd1', bid: { dollars: 10, maxDiskBytes: 100 } }));
  eq(request.bid.maxDiskBytes, 100, 'disk quota survives bid parsing:');
  await coord.charge(TEN, request.id, { diskBytes: 50 });
  eq((await coord.get(TEN, request.id))!.spent.diskBytes, 50, 'high-water mark, not accumulation:');
  await coord.charge(TEN, request.id, { diskBytes: 40 });
  eq((await coord.get(TEN, request.id))!.spent.diskBytes, 50, 'lower report does not lower the mark:');
  const dead = await coord.charge(TEN, request.id, { diskBytes: 150 });
  eq(dead.state, 'TERMINATED_BUDGET');
  eq(dead.refusalReason!.includes('MiB disk'), true);
});

// ---- F03: one approval→admission→execution→settlement graph -------------

T('F03: an approved request is claimable and completes', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'f3a' }));
  await coord.accept(TEN, request.id);
  eq((await coord.get(TEN, request.id))!.state, 'ACCEPTED');
  // The old CAS only took ADMITTED — approval stranded the request in a
  // state no executor read.
  await coord.claimExecution(TEN, request.id, 'worker:f3', NOW);
  eq((await coord.get(TEN, request.id))!.state, 'IN_FLIGHT', 'approved work claims:');
  await coord.complete(TEN, request.id, { claims: [], cost: {} });
  eq((await coord.get(TEN, request.id))!.state, 'COMPLETED');
});

T('F03: charging an ACCEPTED request does not erase the approval marker', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'f3b' }));
  await coord.accept(TEN, request.id);
  await coord.reportUsage(TEN, request.id, { tokens: 50 });
  eq((await coord.get(TEN, request.id))!.state, 'IN_FLIGHT', 'usage moves it to work:');
  const { request: r2 } = await coord.submit(base({ id: 'f3b2', goal: 'second charge probe' }));
  await coord.accept(TEN, r2.id);
  await coord.charge(TEN, r2.id, { dollars: 0.1 });
  eq((await coord.get(TEN, r2.id))!.state, 'IN_FLIGHT', 'charge moves it to work too:');
});

T('F03: deferred work is readmitted when the scope frees up', async () => {
  const { coord } = await fresh({
    maxConcurrentPerScope: 1,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 5,
  });
  // Distinct goals: identical content would dedupe onto thread one instead
  // of parking a second request in DEFERRED.
  const a = await coord.submit(base({ id: 'f3c1', goal: 'first deferred probe' }));
  eq(a.admitted, true);
  const b = await coord.submit(base({ id: 'f3c2', goal: 'second deferred probe' }));
  eq(b.admitted, false, 'cap hit:');
  eq(b.state, 'DEFERRED');
  eq(await coord.readmitDeferred(TEN), [], 'scope still busy:');
  await coord.complete(TEN, a.request.id, { claims: [], cost: {} });
  eq(await coord.readmitDeferred(TEN), [b.request.id], 'freed cap readmits:');
  eq((await coord.get(TEN, b.request.id))!.state, 'ADMITTED', 'deferred work is runnable again:');
});

T('F03: terminal history is never overwritten — refusal wins over late completion', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base({ id: 'f3d' }));
  await coord.decline(TEN, request.id, 'not this quarter');
  // A worker that never saw the refusal reports COMPLETED: the refusal must
  // stay in the record, not be overwritten (the old terminal rule allowed
  // exactly this).
  const settled = await coord.complete(TEN, request.id, { claims: [], cost: {} });
  eq(settled.state, 'FAILED', 'settled FAILED, not COMPLETED:');
  eq(settled.refusalReason!.startsWith('REFUSAL|'), true, 'worker objection preserved behind REFUSAL|:');
  // And the preserved refusal is not resurrectable: a redelivery trying
  // FAILED→COMPLETED recovery is refused outright.
  await rejects(async () => await coord.complete(TEN, request.id, { claims: [], cost: {} }), 'TERMINAL');
  // A genuinely failed row (no REFUSAL| marker) DOES recover on redelivery.
  const { request: f3e } = await coord.submit(base({ id: 'f3e', goal: 'retryable failure probe' }));
  await coord.fail(TEN, f3e.id, 'transient model error');
  const recovered = await coord.complete(TEN, f3e.id, { claims: [], cost: {} });
  eq(recovered.state, 'COMPLETED', 'redelivery recovery works on real failures:');
  // Same-state re-settlement is idempotent, not a second history.
  const again = await coord.complete(TEN, f3e.id, { claims: [], cost: {} });
  eq(again.state, 'COMPLETED');
  // Ordinary terminal rules still hold: no DECLINED from COMPLETED.
  await rejects(async () => await coord.decline(TEN, f3e.id, 'too late'), 'TERMINAL');
  // A late failure report cannot un-finish delivered work.
  const { request: f3f } = await coord.submit(base({ id: 'f3f', goal: 'late failure probe' }));
  await coord.complete(TEN, f3f.id, { claims: [], cost: {} });
  await rejects(async () => await coord.fail(TEN, f3f.id, 'late failure'), 'TERMINAL');
});

T('F20: humanMinutes budget is enforced by charging and reportUsage', async () => {
  const { coord } = await fresh();
  // 1. Charge over humanMinutes
  const { request: r1 } = await coord.submit(base({ id: 'hm1', goal: 'review 1', bid: { humanMinutes: 15 } }));
  eq(r1.state, 'ADMITTED');
  const charged = await coord.charge(TEN, r1.id, { humanMinutes: 20 });
  eq(charged.state, 'TERMINATED_BUDGET');
  eq(charged.refusalReason?.includes('20/15 human minutes'), true);

  // 2. reportUsage over humanMinutes
  const { request: r2 } = await coord.submit(base({ id: 'hm2', goal: 'review 2', bid: { humanMinutes: 10 } }));
  const reported = await coord.reportUsage(TEN, r2.id, { humanMinutes: 12 });
  eq(reported.state, 'TERMINATED_BUDGET');
  eq(reported.refusalReason?.includes('12/10 human minutes'), true);
});

T('F20: daily escalation cap tracks cumulative interruptions regardless of completion', async () => {
  const { coord } = await fresh();
  const ask = async (n: number) =>
    await coord.submit(base({ id: `esc_cum_${n}`, goal: `eyes on ${n}`, bid: { humanMinutes: 5 } }));
  eq((await ask(1)).admitted, true);
  eq((await ask(2)).admitted, true);
  eq((await ask(3)).admitted, true);

  // Complete the first request - in the old code, openEscalations dropped to 2 and let ask(4) through
  await coord.complete(TEN, 'esc_cum_1', { claims: [], cost: {} });
  eq(await coord.dailyEscalations(TEN, NOW.slice(0, 10)), 3);
  eq(await coord.openEscalations(TEN, NOW.slice(0, 10)), 2);

  // Even though open escalations is 2, cumulative interruptions reached 3 today: ask(4) is DENIED
  const fourth = await ask(4);
  eq(fourth.admitted, false);
  eq(fourth.state, 'DENIED');
  eq(fourth.reason.includes('escalation cap'), true);
});

T('FLOW-003: correction exposes pending requests and refresh rebinds evidence', async () => {
  const { ledger, coord } = await fresh();
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'pricing',
    kind: 'FACT',
    statement: '$99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'human',
    provenance: {
      sourceUri: 'https://example.com',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'test',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });
  const { request } = await coord.submit(base({ id: 'flow3', claimRefs: [claim.id], bid: { humanMinutes: 5 } }));
  eq(
    (await coord.listPendingAffectedByClaim(TEN, claim.id)).map((r) => r.id),
    [request.id],
  );
  const { claim: neu } = await ledger.correctClaim(TEN, claim.id, '$79', 'human:priya', DAY_LATER);
  eq(
    (await coord.listPendingAffectedByClaim(TEN, claim.id)).map((r) => r.id),
    [request.id],
  );
  const refreshed = await coord.refreshEvidence(TEN, request.id, async (id) => {
    const cur = await ledger.currentReplacement(TEN, id);
    return cur && cur.id !== id ? cur.id : null;
  });
  eq(refreshed.claimRefs, [neu.id], 'pending request cites the current replacement:');
  await coord.claimExecution(TEN, request.id, 'worker:flow3', NOW);
  await rejects(
    async () =>
      await coord.refreshEvidence(TEN, request.id, async (id) => {
        const cur = await ledger.currentReplacement(TEN, id);
        return cur && cur.id !== id ? cur.id : null;
      }),
    'NOT_REFRESHABLE',
  );
});

T('F20: parent decomposition accounts for completed children and omitted bid defaults', async () => {
  const { coord } = await fresh();
  const { request: parent } = await coord.submit(base({ id: 'par1', bid: { dollars: 10 } }));

  // Decompose child 1 with $4
  const [c1] = await coord.decompose(TEN, parent.id, [
    { id: 'kid1', goal: 'part 1', deliverableSchema: 'res.v1', bid: { dollars: 4 } },
  ]);
  eq(c1!.admitted, true);

  // Kid1 runs and completes, spending $4
  await coord.charge(TEN, 'kid1', { dollars: 4 });
  await coord.complete(TEN, 'kid1', { claims: [], cost: {} });

  // Now remaining budget on par1 is $10 - $4 = $6.
  // Decomposing with $7 must fail even though kid1 is terminal!
  await rejects(
    async () =>
      await coord.decompose(TEN, parent.id, [
        { id: 'kid2_too_much', goal: 'part 2', deliverableSchema: 'res.v1', bid: { dollars: 7 } },
      ]),
    'BUDGET_SPLIT',
  );

  // Omitted bids must default to DEFAULT_BID.dollars (0.25), not 0.
  // Submit a step with omitted bid when only $0.10 is left:
  const { request: parentTight } = await coord.submit(
    base({ id: 'par_tight', goal: 'tight parent goal', bid: { dollars: 0.3 } }),
  );
  // Child with $0.20
  await coord.decompose(TEN, parentTight.id, [
    { id: 'kid_tight_1', goal: 'takes 0.20', deliverableSchema: 'res.v1', bid: { dollars: 0.2 } },
  ]);
  // Remaining is $0.10. An omitted bid needs $0.25, so it must be rejected!
  await rejects(
    async () =>
      await coord.decompose(TEN, parentTight.id, [
        { id: 'kid_omitted', goal: 'omitted bid step', deliverableSchema: 'res.v1' },
      ]),
    'BUDGET_SPLIT',
  );

  // Standalone child submission via submit() also respects parent unspent budget
  const directChild = await coord.submit(
    base({ id: 'kid_direct', goal: 'direct child', parentRequestId: parentTight.id, bid: { dollars: 0.5 } }),
  );
  eq(directChild.admitted, false);
  eq(directChild.state, 'DENIED');
  eq(directChild.reason.includes('exceeds parent'), true);
});

T('FLOW-002: approval freezes a versioned execution specification with evidence versions', async () => {
  const { ledger, coord } = await fresh();
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'launch',
    kind: 'FACT',
    statement: 'v2 ships Tuesday',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'human',
    provenance: {
      sourceUri: 'https://example.com/release',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'test',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });
  const { request } = await coord.submit(
    base({ id: 'flow2-spec', claimRefs: [claim.id], goal: 'draft launch copy', bid: { humanMinutes: 5 } }),
  );
  const spec = await validateApprovalBoundary(ledger, request, NOW);
  eq(spec.requestId, request.id);
  eq(spec.command, request.goal);
  eq(spec.evidence.length, 1);
  eq(spec.evidence[0]!.id, claim.id);
  const roundTrip = parseExecutionSpec(serializeExecutionSpec(spec));
  eq(roundTrip?.fingerprint, spec.fingerprint);
});

T('FLOW-002: stale review and task mismatch reject execution', async () => {
  const { ledger, coord } = await fresh();
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'launch',
    kind: 'FACT',
    statement: 'v2 ships Tuesday',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'human',
    provenance: {
      sourceUri: 'https://example.com/release',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'test',
      extractorVersion: '1',
      retrievedAt: NOW,
    },
  });
  const { request } = await coord.submit(
    base({ id: 'flow2-stale', claimRefs: [claim.id], goal: 'draft launch copy', bid: { humanMinutes: 5 } }),
  );
  await rejects(
    async () => await validateApprovalBoundary(ledger, request, NOW, { expectedRequestUpdatedAt: 'stale-timestamp' }),
    'STALE_REVIEW',
  );
  const spec = await buildBeginWorkSpec(ledger, request);
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: request.goal,
    action: serializeExecutionSpec(spec),
    actionClass: 'RECOMMEND',
    claimIds: request.claimRefs,
    decidedBy: 'human:priya',
    approvedBy: 'human:priya',
    scope: request.targetScope,
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  await coord.accept(TEN, request.id);
  await rejects(
    async () =>
      await validateExecutionAgainstSpec(
        ledger,
        coord,
        TEN,
        request.id,
        {
          command: 'run something else',
          claimRefs: request.claimRefs,
          decisionId: dec.id,
        },
        NOW,
      ),
    'TASK_MISMATCH',
  );
  await validateExecutionAgainstSpec(
    ledger,
    coord,
    TEN,
    request.id,
    {
      command: request.goal,
      claimRefs: request.claimRefs,
      decisionId: dec.id,
      specFingerprint: spec.fingerprint,
    },
    NOW,
  );
});

T('FLOW-002: IN_FLIGHT work cannot be pulled back to ACCEPTED', async () => {
  const { coord } = await fresh();
  const { request } = await coord.submit(base());
  await coord.claimExecution(TEN, request.id, 'worker-one', NOW);
  await rejects(() => coord.accept(TEN, request.id), 'INVALID_TRANSITION');
});
