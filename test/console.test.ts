import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base } from './helpers.ts';
import { request as httpRequest } from 'node:http';
import { buildReport, COST_CURVE_BUDGET, MAX_ROOMS, ROOM_REQUESTS } from '../src/console/report.ts';
import { lineChart, renderHtml, tierStack } from '../src/console/render.ts';
import { composeDigest } from '../src/console/digest.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { listCases } from '../src/evals/runner.ts';
import { rIn } from './helpers.ts';
import { installAuthSchema, signupTenant, listUsers } from '../src/core/auth.ts';
import { approvalMessage, generateOperatorKey, operatorKeyId, signApproval } from '../src/gov/operator.ts';
import { seedTrace, cardInput } from './helpers.ts';
import { renderReview, REVIEW_SCRIPT } from '../src/console/review.ts';
import { runInNewContext } from 'node:vm';

console.log('\n\x1b[1mConsole — the ledger as a read model\x1b[0m');

T('merged console keeps operator secret checks in addition to session authentication', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await coord.submit(base({ id: 'merged-secret', goal: 'review with both credentials' }));
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
    operatorSecret: 'opaque',
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const endpoint = `${url}/api/requests/merged-secret/approve`;
    eq((await fetch(endpoint, { method: 'POST', headers: session.headers, body: '{}' })).status, 401);
    eq(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...session.headers, 'content-type': 'application/json', 'x-vital-operator': 'opaque' },
          body: '{}',
        })
      ).status,
      200,
    );
    eq((await fetch(`${url}/api/metrics`)).status, 401);
    const metrics = (await (await fetch(`${url}/api/metrics`, { headers: session.headers })).json()) as {
      requests: number;
      reportBuilds: number;
    };
    eq(metrics.requests > 0, true);
    eq(metrics.reportBuilds > 0, true);
    eq((await fetch(`${url}/healthz`)).status, 200);
  } finally {
    await server.close();
    await db.close();
  }
});

T('merged signed approval retains the authenticated session identity', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const key = generateOperatorKey();
  const owner = (await listUsers(db, TEN)).find((u) => u.email === OWNER.email)!;
  const who = `${owner.id} (${owner.email})`;
  await coord.submit(base({ id: 'merged-signed', goal: 'review with signed session identity' }));
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
    operatorKeys: [key.publicKeyPem],
  });
  try {
    const session = await ownerSession(server.port);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/merged-signed/approve`, {
      method: 'POST',
      headers: {
        ...session.headers,
        'content-type': 'application/json',
        'x-vital-signature': signApproval(key.privateKeyPem, approvalMessage(TEN, 'merged-signed', 'approve', who)),
      },
      body: JSON.stringify({ by: 'ignored body identity' }),
    });
    eq(response.status, 200);
    const result = (await response.json()) as { by: string; keyId: string };
    eq(result.by, who);
    eq(result.keyId, operatorKeyId(key.publicKeyPem));
  } finally {
    await server.close();
    await db.close();
  }
});

T('merged report preserves local bounded chart and room windows', async () => {
  const { db, ledger, coord, comp } = await fresh();
  try {
    for (let i = 0; i < 500; i++) {
      await db
        .prepare(
          'INSERT INTO decisions (id,tenant,goal,action,action_class,context_bundle,decided_by,approved_by,scope,autonomy,request_id,signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          `window_${i}`,
          TEN,
          'g',
          'a',
          'READ',
          '{}',
          'h',
          null,
          'x',
          'autonomous',
          null,
          new Date(Date.parse(NOW) + i * 1000).toISOString(),
        );
    }
    for (let i = 0; i < 60; i++) {
      await coord.submit(base({ id: `window_req_${i}`, originScope: `scope-${i}`, goal: `work ${i}` }));
    }
    const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
    eq(report.costCurve.length <= COST_CURVE_BUDGET, true);
    eq(report.costCurve[0]!.label, 'D1');
    eq(report.costCurve[report.costCurve.length - 1]!.label, 'D500');
    eq(report.rooms.length <= MAX_ROOMS, true);
    eq(
      report.rooms.every((room) => room.requests.length <= ROOM_REQUESTS),
      true,
    );
  } finally {
    await db.close();
  }
});

T('merged report never demotes a drifting card or writes audit rows', async () => {
  const { db, ledger, coord, comp } = await fresh();
  try {
    await seedTrace(comp, db, 'merged_trace', 'SUCCESS', 0.95);
    const card = await comp.compile(cardInput(['merged_trace']));
    await db.prepare("UPDATE skill_cards SET state='PROMOTED' WHERE id = ?").run(card.id);
    for (let i = 0; i < 20; i++) {
      await db
        .prepare(
          'INSERT INTO traces (id,tenant,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          `merged_bad_${i}`,
          TEN,
          'marketing',
          'x',
          'draft-launch-copy',
          '[]',
          'WORKFLOW',
          'FAILURE',
          '{}',
          card.id,
          0.9,
          NOW,
        );
    }
    const before = await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN);
    const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
    eq((await comp.get(TEN, card.id))!.state, 'PROMOTED');
    eq(await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?').get(TEN), before);
    eq(
      report.compiler
        .find((c) => c.state === 'PROMOTED')!
        .cards.find((c) => c.id === card.id)!
        .trustGaps.includes('drifting: live success below validated baseline'),
      true,
    );
  } finally {
    await db.close();
  }
});

T('F02: rendered review controls approve and decline through the authenticated API', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const evidence = await ledger.append({
    tenant: TEN,
    subject: 'review:release',
    kind: 'FACT',
    statement: 'Release is available',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:release',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  for (const action of ['approve', 'decline']) {
    const result = await coord.submit(
      base({
        id: `review-${action}`,
        goal: `Review ${action} <example>`,
        targetScope: `review-${action}`,
        claimRefs: [evidence.id],
        bid: { humanMinutes: 1 },
      }),
    );
    eq(result.state, 'ADMITTED', `review fixture must be admitted (${result.reason}):`);
  }
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const html = await (await fetch(url, { headers: session.headers })).text();
    eq(html.includes('id="pending-review"'), true);
    eq(html.includes('data-review-request="r1"'), false, 'already accepted work has no review controls:');
    eq(html.includes('Review approve &lt;example&gt;'), true);
    eq(html.includes('Deliverable: feasibility.v1'), true);
    eq(html.includes('Source: https://linear.net/bug/1'), true);
    for (const action of ['approve', 'decline']) {
      const endpoint = `/api/requests/review-${action}/${action}`;
      eq(html.includes(`action="${endpoint}"`), true);
      const result = await fetch(url + endpoint, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Not ready for execution' }),
      });
      eq(result.status, 200);
      eq(((await result.json()) as { state: string }).state, action === 'approve' ? 'ACCEPTED' : 'DECLINED');
    }
    const refreshed = await (await fetch(url, { headers: session.headers })).text();
    eq(refreshed.includes('data-review-request="review-approve"'), false);
    eq(refreshed.includes('data-review-request="review-decline"'), false);
    eq(
      renderHtml(await buildReport(db, ledger, coord, comp, TEN, NOW)).includes('data-review-action'),
      false,
      'static report stays read-only:',
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('F02: review controls are role-aware and operator inputs never contain credentials', async () => {
  const { db, ledger, coord } = await fresh();
  try {
    await coord.submit(base({ id: 'role-review', goal: 'Role-aware review', bid: { humanMinutes: 1 } }));
    const options = {
      tenant: TEN,
      actor: 'user (owner@acme.test)',
      csrf: 'session-csrf',
      canApprove: false,
      requiredRole: 'admin',
      operatorMode: 'session' as const,
    };
    const denied = await renderReview(coord, ledger, options);
    eq(denied.includes('Review requires the admin role'), true);
    eq(denied.includes('data-review-action="approve"'), false);
    const secret = await renderReview(coord, ledger, { ...options, canApprove: true, operatorMode: 'secret' });
    eq(secret.includes('name="operatorSecret" required autocomplete="off"'), true);
    const signed = await renderReview(coord, ledger, { ...options, canApprove: true, operatorMode: 'signature' });
    eq(signed.includes('name="operatorSignature"'), true);
    eq(signed.includes('vital-approve-v1|acme|role-review|approve|user (owner@acme.test)'), true);
    eq(signed.includes('name="operatorSecret"'), false, 'signature mode never falls back to a secret:');
  } finally {
    await db.close();
  }
});

T('F02: review client treats successful declines as success and restores controls on error', async () => {
  for (const fails of [false, true]) {
    const status = { textContent: '' };
    const credential = { value: 'entered-secret', disabled: false };
    const button = { disabled: true };
    const card = {
      dataset: {} as Record<string, string>,
      setAttribute() {},
      removeAttribute() {},
      querySelector: () => status,
      querySelectorAll: () => [credential, button],
    };
    class Form {
      dataset = { reviewAction: 'decline' };
      action = 'http://localhost/api/requests/review/decline';
      matches() {
        return true;
      }
      closest() {
        return card;
      }
      reportValidity() {
        return true;
      }
      querySelectorAll() {
        return [credential];
      }
    }
    let submit: ((event: unknown) => Promise<void>) | undefined;
    const root = {
      querySelectorAll: () => [button],
      querySelector: () => ({ addEventListener() {} }),
      addEventListener: (_event: string, listener: typeof submit) => {
        submit = listener;
      },
    };
    const fields = new Map([
      ['csrf', 'csrf-token'],
      ['reason', 'Not ready'],
      ['operatorSecret', 'entered-secret'],
    ]);
    let sent: { headers: Record<string, string>; body: string; credentials: string } | undefined;
    runInNewContext(REVIEW_SCRIPT, {
      document: { getElementById: () => root },
      HTMLFormElement: Form,
      FormData: class {
        get(key: string) {
          return fields.get(key);
        }
        has(key: string) {
          return fields.has(key);
        }
      },
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async (_url: string, init: typeof sent) => {
        sent = init;
        eq(card.dataset.busy, 'true');
        eq(button.disabled, true);
        return {
          ok: !fails,
          status: fails ? 409 : 200,
          json: async () => (fails ? { error: 'Request changed' } : { ok: false, state: 'DECLINED' }),
        };
      },
    });
    eq(button.disabled, false, 'script enables progressive controls:');
    let prevented = false;
    await submit!({
      target: new Form(),
      preventDefault() {
        prevented = true;
      },
    });
    eq(prevented, true);
    eq(sent!.credentials, 'same-origin');
    eq(sent!.headers['x-vital-csrf'], 'csrf-token');
    eq(sent!.headers['x-vital-operator'], 'entered-secret');
    eq(JSON.parse(sent!.body), { reason: 'Not ready' });
    eq(credential.value, '', 'credentials cleared after request:');
    eq(button.disabled, !fails);
    eq(status.textContent.includes(fails ? 'Request changed' : 'Declined.'), true);
  }
});

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

/**
 * HTTP-login as the provisioned owner (seeded() provisions the tenant) and
 * return { cookie, csrf, headers } — the headers carry the session cookie
 * AND the page's CSRF token, ready to spread into authenticated API calls.
 */
async function ownerSession(port: number) {
  const base_ = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
  const preCsrf = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${base_}/login`, {
    method: 'POST',
    headers: { cookie: preCsrf },
    body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${base_}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, headers: { cookie, 'x-vital-csrf': csrf } as Record<string, string> };
}

async function seeded() {
  const ctx = await fresh();
  const { db, ledger, coord } = ctx;
  // Every served-console test below posts approvals over HTTP: the auth
  // layer is unconditional, so provision the tenant + owner once here.
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: 'owner@acme.test', password: 'the-console-password', ownerName: 'Ada' },
    NOW,
  );
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
  // A second request left open for the served-console approval flow. Id
  // 'rq1' — remote-side tests own 'r2', and a colliding id would UPDATE that
  // row (persist is upsert-by-id), corrupting their evidence.
  // Distinct goal → distinct idempotency key (same goal would dedupe to r1).
  const rq1 = await coord.submit(
    base({ id: 'rq1', goal: 'queued for approval', claimRefs: [rel.id], bid: { dollars: 1, humanMinutes: 5 } }),
  );
  const rqState = rq1.request.state;
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
  return { ...ctx, rel, dec, rqState };
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
  // r1 (accepted+charged) and r2 (queued for the served-console flow) both
  // need a human; the console flow approves r2 in the authed test below.
  eq(r.needsHuman.length, 2);
  eq(
    r.needsHuman.every((n) => n.scope === 'engineering'),
    true,
  );
  eq(r.health.escalations, { open: 2, cap: 3 });
  eq(r.health.humanMinutes.spentToday, 20, 'r2 has not spent anything yet:');
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
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const authed = await ownerSession(server.port);
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
        headers: { ...authed.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'the launch plan is $149/mo' }),
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

    // Typed correction via HTTP API updates statement and structured value together.
    const typedRes = (await (
      await fetch(`${base_}/api/claims/${r.supersededBy}/correct`, {
        method: 'POST',
        headers: { ...authed.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'the launch plan is $179/mo', value: 179, unit: 'USD/mo' }),
      })
    ).json()) as { ok: boolean; supersededBy: string };
    eq(typedRes.ok, true);
    const typedClaim = await ledger.get(TEN, typedRes.supersededBy);
    eq(typedClaim?.statement, 'the launch plan is $179/mo');
    eq(typedClaim?.value, 179);
    eq(typedClaim?.unit, 'USD/mo');

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
      await fetch(`${base_}/api/claims/${claim.id}/correct`, {
        method: 'POST',
        headers: { cookie: authed.cookie },
        body: '{}',
      })
    ).json()) as {
      ok: boolean;
    };
    eq(noBy.ok, false, 'a correction without a statement refused:');
    const missing = (await (
      await fetch(`${base_}/api/claims/clm_nope/correct`, {
        method: 'POST',
        headers: { ...authed.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'x' }),
      })
    ).json()) as { ok: boolean };
    eq(missing.ok, false);
  } finally {
    await server.close();
  }
});

T('approval latency is instrumented: recorded per decision, aggregated, served', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  // Mutable so each decision can happen at a chosen instant.
  let clock = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => clock });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const authed = await ownerSession(server.port);
    // r1 submitted at NOW and approved instantly (0s); r2 submitted a day
    // later and approved 6h after that — the distribution must reflect both.
    // Distinct goals: identical content would dedupe onto one thread (by design).
    const r1 = await coord.submit(base({ id: 'lat1', now: NOW, goal: 'latency probe one' }));
    const r2 = await coord.submit(base({ id: 'lat2', now: DAY_LATER, goal: 'latency probe two' }));
    eq(r1.admitted, true);
    eq(r2.admitted, true);

    const a1 = (await (
      await fetch(`${base_}/api/requests/lat1/approve`, {
        method: 'POST',
        headers: { ...authed.headers, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as {
      ok: boolean;
      latencySeconds: number | null;
    };
    eq(a1.ok, true);
    eq(a1.latencySeconds, 0, 'instant approval measures ~0s:');

    const at2 = '2026-09-10T18:00:00.000Z';
    clock = at2;
    // The clock jumped 30h: the first session (12h TTL, issued at NOW) has
    // expired — re-login at the new instant before the second approval.
    const authed2 = await ownerSession(server.port);
    const a2 = (await (
      await fetch(`${base_}/api/requests/lat2/approve`, {
        method: 'POST',
        headers: { ...authed2.headers, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { ok: boolean; latencySeconds: number | null };
    eq(a2.ok, true);
    eq(a2.latencySeconds, (Date.parse(at2) - Date.parse(DAY_LATER)) / 1000, 'stale approval measures the gap:');

    const stats = (await (
      await fetch(`${base_}/api/approval-latency`, { headers: { cookie: authed2.cookie } })
    ).json()) as {
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

T('the served console is session-gated: login, then approve through the coordinator', async () => {
  const { db, ledger, coord, comp, rqState } = await seeded();
  // (seeded() provisions the tenant + owner — the auth layer is unconditional.)
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const anon = (await (
      await fetch(`${base_}/api/requests/r1/approve`, { method: 'POST', body: '{}', redirect: 'manual' })
    ).json()) as { ok: boolean; error: string };
    eq(anon.ok, false, 'anonymous approval refused:');
    const homeAnon = await fetch(`${base_}/`, { redirect: 'manual' });
    eq(homeAnon.status, 303, 'the report itself is behind the login:');
    // Sign in and carry the session cookie — the login form itself is
    // CSRF-protected via the double-submit pre-session cookie.
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCsrf = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const loginRes = await fetch(`${base_}/login`, {
      method: 'POST',
      headers: { cookie: preCsrf },
      body: `csrf=${preToken}&email=owner%40acme.test&password=the-console-password`,
      redirect: 'manual',
    });
    eq(loginRes.status, 303, 'login redirects to the console:');
    const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    eq(cookie.includes('vital_session='), true);
    // One session for the whole flow — the CSRF token is per-session, so the
    // page and the API call must carry the SAME cookie.
    const home: string = await (await fetch(`${base_}/`, { headers: { cookie }, redirect: 'manual' })).text();
    eq(home.includes('Reality health'), true, 'serves the report:');
    const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
    // CSRF required even with a valid session.
    const csrfLess = (await (
      await fetch(`${base_}/api/requests/rq1/approve`, { method: 'POST', headers: { cookie }, body: '{}' })
    ).json()) as { ok: boolean };
    eq(csrfLess.ok, false, 'a session without the CSRF token cannot approve:');
    eq((await coord.get(TEN, 'rq1'))!.state, rqState, 'the refused call moved nothing:');
    // Approve the queued request as the session identity.
    const approved = (await (
      await fetch(`${base_}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { ok: boolean; state: string; by: string };
    eq(approved.ok, true, `approve failed: ${JSON.stringify(approved)}`);
    eq(approved.state, 'ACCEPTED', `unexpected state: ${JSON.stringify(approved)}`);
    eq(approved.by.includes('owner@acme.test'), true, 'the approver is the authenticated user:');
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED', 'the transition landed in the ledger path:');
    const missing = (await (
      await fetch(`${base_}/api/requests/nope/decline`, {
        method: 'POST',
        headers: { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' },
        body: '{"reason":"no"}',
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
  const authed = await ownerSession(server.port);
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
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            cookie: authed.cookie,
            'x-vital-csrf': authed.csrf,
          },
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
    const bigRes = await fetch(`${base_}/api/requests/r1/approve`, {
      method: 'POST',
      headers: { cookie: authed.cookie },
      body: 'x'.repeat(1_000_001),
    });
    eq(bigRes.status, 413, 'oversized body is a 413:');
    const big = (await bigRes.json()) as { ok: boolean };
    eq(big.ok, false, 'not a hang:');
    // The server is still alive for real work afterwards.
    const ok = (await (
      await fetch(`${base_}/api/requests/r1/approve`, {
        method: 'POST',
        headers: { ...authed.headers, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { ok: boolean };
    eq(ok.ok, true, 'server survives both:');
  } finally {
    await server.close();
  }
});

T('cost-per-signal is surfaced: report card, /api/cost-per-signal, cli status field', async () => {
  const { db, ledger, coord, comp, router } = await fresh();
  // One arrival through the real routing path so routing_decisions has a row.
  await router.route(rIn({ taskType: 'release.detect', importance: 0.1 }));
  const cps = await router.costPerSignal(TEN);
  eq(cps.arrivals, 1);
  eq(cps.modelShare, 0, 'reflex handled it — the gate passes:');

  const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
  eq(report.costPerSignal.arrivals, 1, 'report carries the same read:');
  eq(report.costPerSignal.withinGate, true);
  const html = renderHtml(report);
  eq(html.includes('cost per signal'), true, 'health-grid card renders:');
  eq(html.includes('OVER GATE'), false, 'gate passing reads as passing:');

  // The read APIs are session-gated (V2.1.1): a routing-economics read
  // leaks as much as the latency one, so it needs the same auth. This
  // test never provisions a tenant (unlike seeded()), so claim one —
  // BEFORE the server boots, which caches its provisioned state.
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: 'owner@acme.test', password: 'the-console-password', ownerName: 'Ada' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const authed = await ownerSession(server.port);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/cost-per-signal`, {
      headers: authed.headers,
    });
    eq(res.status, 200);
    const body = (await res.json()) as { arrivals: number; modelShare: number; withinGate: boolean };
    eq(body.arrivals, 1);
    eq(body.withinGate, true);
  } finally {
    await server.close();
  }
});
