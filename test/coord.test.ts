import { openDb, migrate } from '../src/core/db.ts';
import { jsonNumber, jsonText } from '../src/core/db.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { T, eq, TEN, NOW, DAY_LATER, fresh, base, rejects } from './helpers.ts';
console.log('\n\x1b[1mCoordination — the channel model\x1b[0m');

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
  const uncapped = await fresh();
  const u = await uncapped.coord.submit(base({ id: 'cap2', bid: { dollars: 50 } }));
  eq(u.request.bid.dollars, 50, 'no ceiling configured means no clamping:');
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
