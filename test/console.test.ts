import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base } from './helpers.ts';
import { request as httpRequest } from 'node:http';
import { buildReport } from '../src/console/report.ts';
import { lineChart, renderHtml, tierStack } from '../src/console/render.ts';
import { composeDigest } from '../src/console/digest.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { listCases } from '../src/evals/runner.ts';

console.log('\n\x1b[1mConsole — the ledger as a read model\x1b[0m');

async function seeded() {
  const ctx = await fresh();
  const { db, ledger, coord } = ctx;
  const rel = await ledger.append({
    tenant: TEN,
    subject: 'release:v1',
    kind: 'FACT',
    statement: 'ships',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({ id: 'r1', claimRefs: [rel.id], bid: { dollars: 10, humanMinutes: 30 } }),
  );
  await coord.accept(TEN, request.id);
  await coord.charge(TEN, request.id, { dollars: 4, humanMinutes: 20 });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tr1',
      TEN,
      request.id,
      'engineering',
      'engineering.implement',
      'code:x',
      '[]',
      'MODEL',
      'SUCCESS',
      JSON.stringify({ tokens: 1000 }),
      null,
      0.9,
      NOW,
    );
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'launch',
    action: 'ship',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: [rel.id],
    decidedBy: 'human:priya',
    scope: 'engineering',
    autonomy: 'approval',
    requestId: request.id,
    now: NOW,
  });
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'adoption',
    predicted: 0.2,
    actual: 0.31,
    basis: 'warehouse:a',
    resolvedBy: 'h',
    scope: 'engineering',
    owner: 'h',
    now: NOW,
  });
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run('tr2', TEN, null, 'marketing', 'release.detect', 'i', '[]', 'REFLEX', 'SUCCESS', '{}', null, 0.9, NOW);
  return { ...ctx, rel, dec };
}

T('the report aggregates health, cost, tiers, queue, and rooms from the database', async () => {
  const { db, ledger, coord, comp, rel, dec } = await seeded();
  void dec;
  const r = await buildReport(db, ledger, coord, comp, TEN, NOW);
  eq(r.tenant, TEN);
  eq(r.health.orphanClaims, 0);
  eq(r.health.provenanceComplete, 1);
  eq(r.costCurve.length, 1);
  eq(r.costCurve[0]!.costPerGoodDecision, 25);
  eq(r.tierMix.length, 1, 'both traces in one week bucket:');
  eq(r.rooms.length > 0, true);
  const eng = r.rooms.find((x) => x.scope === 'engineering')!;
  eq(eng.requests[0]!.evidence[0]!.id, rel.id, 'rooms carry evidence chips:');
  eq(r.digestCount, 0);
});

T('the approval queue lists human-minute work with slots', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const r = await buildReport(db, ledger, coord, comp, TEN, NOW);
  eq(r.needsHuman.length, 1);
  eq(r.needsHuman[0]!.scope, 'engineering');
  eq(r.health.escalations, { open: 1, cap: 3 });
  eq(r.health.humanMinutes.spentToday, 20);
});

T('charts draw data, not decoration — values appear in the SVG', async () => {
  const svg = lineChart(
    [
      { at: 'a', label: 'D1', costPerGoodDecision: 11.5 },
      { at: 'b', label: 'D2', costPerGoodDecision: null },
      { at: 'c', label: 'D3', costPerGoodDecision: 4.25 },
    ],
    3.0,
  );
  eq(svg.includes('11.50'), true);
  eq(svg.includes('target $3.0'), true);
  const stack = tierStack([{ label: 'W1', REFLEX: 3, WORKFLOW: 1, MODEL: 0, HUMAN: 0 }]);
  eq(stack.includes('REFLEX'), true);
});

T('the HTML report carries headlines, evidence tags, and compiler gaps', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const html = renderHtml(await buildReport(db, ledger, coord, comp, TEN, NOW));
  for (const needle of ['Reality health', '$25', 'Needs a human', 'Compiler', 'Rooms', '✓ FACT', 'FAFAF8']) {
    eq(html.includes(needle), true, `report contains "${needle}":`);
  }
});

T('provisional reality is unmistakable — a CANDIDATE chip never looks like a fact', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const obs = await ledger.append({
    tenant: TEN,
    subject: 'release:v2',
    kind: 'OBSERVATION',
    statement: 'changelog moved — nobody has reviewed it',
    confidence: 0.4,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provisional: true,
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  await coord.submit(base({ id: 'r2', claimRefs: [obs.id], bid: { dollars: 1 } }));

  const r = await buildReport(db, ledger, coord, comp, TEN, NOW);
  const eng = r.rooms.find((x) => x.scope === 'engineering')!;
  const chip = eng.requests.find((q) => q.id === 'r2')!.evidence[0]!;
  eq(chip.provisional, true, 'the read model carries the flag:');

  const html = renderHtml(r);
  eq(html.includes('· PROVISIONAL OBSERVATION'), true, 'provisional chip is labeled in text:');
  eq(html.includes('border:1px dashed'), true, 'provisional chip is the only dashed chip:');
  eq(html.includes('✓ FACT'), true, 'verified facts keep their chip:');
  eq(html.includes('approval latency'), true, 'latency card renders even with no data (—):');
});

T('digest composition: NOTICEs land here, grouped, never in the Feed', async () => {
  const { db, coord } = await fresh();
  await coord.submit(base({ id: 'n1', messageClass: 'NOTICE', goal: 'v1.2 shipped', claimRefs: [] }));
  // Distinct idem key (different deliverableSchema): a byte-identical NOTICE
  // would replay onto n1's thread (by design), not insert a second row.
  await coord.submit(
    base({ id: 'n2', messageClass: 'NOTICE', goal: 'v1.2 shipped', claimRefs: [], deliverableSchema: 'notice.v2' }),
  );
  await coord.submit(base({ id: 'n3', messageClass: 'NOTICE', goal: 'backup ran', claimRefs: [] }));
  // A REQUEST is work, not digest material — it must never appear here.
  await coord.submit(base({ id: 'w1', goal: 'v1.2 shipped' }));

  const entries = await composeDigest(db, TEN, NOW);
  eq(entries.length, 2, 'two NOTICE topics, one REQUEST excluded:');
  const shipped = entries.find((e) => e.goal === 'v1.2 shipped')!;
  eq(shipped.followOnCount, 1, 'the repeat NOTICE became a follow-on count:');
  eq(shipped.requestId, 'n2', 'newest topic first:');
  eq(entries.find((e) => e.goal === 'backup ran')!.requestId, 'n3');

  // Not-a-date guard: a NOTICE beyond the query instant is invisible.
  eq((await composeDigest(db, TEN, '2026-01-01T00:00:00.000Z')).length, 0);
});

T('override capture: correcting a claim stores the diff and feeds the eval spine', async () => {
  const { db, ledger, coord, comp } = await fresh();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const claim = await ledger.append({
      tenant: TEN,
      subject: 'pricing',
      kind: 'FACT',
      statement: 'the launch plan is $99/mo',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human:priya',
      scope: 'marketing',
      authorType: 'human',
      provenance: { ...sor() },
    });

    const r = (await (
      await fetch(`${base_}/api/claims/${claim.id}/correct`, {
        method: 'POST',
        body: JSON.stringify({ by: 'human:priya', statement: 'the launch plan is $149/mo' }),
      })
    ).json()) as {
      ok: boolean;
      supersedes: string;
      supersededBy: string;
      diff: { before: string; after: string };
      evalCaseId: string | null;
    };
    eq(r.ok, true, 'the correction lands:');
    eq(r.supersedes, claim.id);
    eq(r.diff.before, 'the launch plan is $99/mo', 'the diff captures what was wrong:');
    eq(r.diff.after, 'the launch plan is $149/mo');
    eq(r.evalCaseId !== null, true, 'the spine got a regression case:');

    // The new claim exists, supersedes the old, and the old is gone from bySubject.
    const neu = await ledger.get(TEN, r.supersededBy);
    eq(neu?.statement, 'the launch plan is $149/mo');
    const superseded = await ledger.get(TEN, claim.id);
    eq(superseded?.status, 'SUPERSEDED');

    // The spine case is real, in the overrides suite, and expects the correction.
    const cases = await listCases(db, TEN, 'overrides');
    eq(
      cases.some((c) => c.id === r.evalCaseId),
      true,
      'the case is listed in the overrides suite:',
    );
    const kase = cases.find((c) => c.id === r.evalCaseId)!;
    eq(kase.kind, 'correction-regression');
    eq((kase.expect as { statement: string }).statement, 'the launch plan is $149/mo');

    // Validation and unknown-claim refusals keep the surface honest.
    const noBy = (await (
      await fetch(`${base_}/api/claims/${claim.id}/correct`, { method: 'POST', body: '{}' })
    ).json()) as {
      ok: boolean;
    };
    eq(noBy.ok, false, 'anonymous corrections refused:');
    const missing = (await (
      await fetch(`${base_}/api/claims/clm_nope/correct`, {
        method: 'POST',
        body: JSON.stringify({ by: 'h', statement: 'x' }),
      })
    ).json()) as { ok: boolean };
    eq(missing.ok, false);
  } finally {
    await server.close();
  }
});

T('approval latency is instrumented: recorded per decision, aggregated, served', async () => {
  const { db, ledger, coord, comp } = await fresh();
  // Mutable so each decision can happen at a chosen instant.
  let clock = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => clock });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    // r1 submitted at NOW and approved instantly (0s); r2 submitted a day
    // later and approved 6h after that — the distribution must reflect both.
    // Distinct goals: identical content would dedupe onto one thread (by design).
    const r1 = await coord.submit(base({ id: 'lat1', now: NOW, goal: 'latency probe one' }));
    const r2 = await coord.submit(base({ id: 'lat2', now: DAY_LATER, goal: 'latency probe two' }));
    eq(r1.admitted, true);
    eq(r2.admitted, true);

    const a1 = (await (
      await fetch(`${base_}/api/requests/lat1/approve`, { method: 'POST', body: JSON.stringify({ by: 'human:priya' }) })
    ).json()) as {
      ok: boolean;
      latencySeconds: number | null;
    };
    eq(a1.ok, true);
    eq(a1.latencySeconds, 0, 'instant approval measures ~0s:');

    const at2 = '2026-09-10T18:00:00.000Z';
    clock = at2;
    const a2 = (await (
      await fetch(`${base_}/api/requests/lat2/approve`, { method: 'POST', body: JSON.stringify({ by: 'human:priya' }) })
    ).json()) as { ok: boolean; latencySeconds: number | null };
    eq(a2.ok, true);
    eq(a2.latencySeconds, (Date.parse(at2) - Date.parse(DAY_LATER)) / 1000, 'stale approval measures the gap:');

    const stats = (await (await fetch(`${base_}/api/approval-latency`)).json()) as {
      n: number;
      medianSeconds: number | null;
      p90Seconds: number | null;
      maxSeconds: number | null;
    };
    eq(stats.n, 2, 'both decisions recorded:');
    eq(stats.medianSeconds, 10800, 'true median: even count averages the middle pair:');
    eq(stats.p90Seconds, 21600);
    eq(stats.maxSeconds, 21600);
  } finally {
    await server.close();
  }
});

T('the served console approves and declines through the coordinator', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const home: string = await (await fetch(`${base_}/`)).text();
    eq(home.includes('Reality health'), true, 'serves the report:');
    const anon = (await (await fetch(`${base_}/api/requests/r1/approve`, { method: 'POST', body: '{}' })).json()) as {
      ok: boolean;
      error: string;
    };
    eq(anon.ok, false, 'anonymous approval refused:');
    const approved = (await (
      await fetch(`${base_}/api/requests/r1/approve`, { method: 'POST', body: JSON.stringify({ by: 'human:priya' }) })
    ).json()) as { ok: boolean; state: string };
    eq(approved.ok, true);
    eq(approved.state, 'ACCEPTED');
    eq((await coord.get(TEN, 'r1'))!.state, 'ACCEPTED', 'the transition landed in the ledger path:');
    const missing = (await (
      await fetch(`${base_}/api/requests/nope/decline`, {
        method: 'POST',
        body: JSON.stringify({ by: 'h', reason: 'no' }),
      })
    ).json()) as { ok: boolean };
    eq(missing.ok, false);
  } finally {
    await server.close();
  }
});

T('malformed ids and body bombs fail loud, never hang or crash the server', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  // fetch (undici) refuses to send malformed percent-encoding client-side,
  // so the crash probe goes over a raw socket — exact bytes on the wire.
  const postRaw = (path: string, body: string): Promise<{ status: number; json: { ok: boolean } }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => {
            data += c.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as { ok: boolean } }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const bad = await postRaw('/api/requests/%E0%A4%A/approve', JSON.stringify({ by: 'human:priya' }));
    eq(bad.status, 400, 'malformed percent-encoding is a 400:');
    eq(bad.json.ok, false, 'not a crash:');
    const bigRes = await fetch(`${base_}/api/requests/r1/approve`, { method: 'POST', body: 'x'.repeat(1_000_001) });
    eq(bigRes.status, 413, 'oversized body is a 413:');
    const big = (await bigRes.json()) as { ok: boolean };
    eq(big.ok, false, 'not a hang:');
    // The server is still alive for real work afterwards.
    const ok = (await (
      await fetch(`${base_}/api/requests/r1/approve`, {
        method: 'POST',
        body: JSON.stringify({ by: 'human:priya' }),
      })
    ).json()) as { ok: boolean };
    eq(ok.ok, true, 'server survives both:');
  } finally {
    await server.close();
  }
});
