import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base } from './helpers.ts';
import { request as httpRequest } from 'node:http';
import { buildReport, COST_CURVE_BUDGET, MAX_ROOMS, ROOM_REQUESTS } from '../src/console/report.ts';
import { lineChart, renderHtml, tierStack } from '../src/console/render.ts';
import { composeDigest } from '../src/console/digest.ts';
import { DEFAULT_BIND_HOST, isLoopbackBindHost, startConsoleServer } from '../src/console/serve.ts';
import {
  buildActivationState,
  loadActivationConfig,
  SAMPLE_REQUEST_PREFIX,
  SAMPLE_SCOPE,
} from '../src/console/activation.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listCases } from '../src/evals/runner.ts';
import { rIn } from './helpers.ts';
import { installAuthSchema, signupTenant, inviteUser, listUsers } from '../src/core/auth.ts';
import { approvalMessage, generateOperatorKey, operatorKeyId, signApproval } from '../src/gov/operator.ts';
import { seedTrace, cardInput } from './helpers.ts';
import { renderReview, REVIEW_SCRIPT } from '../src/console/review.ts';
import { buildWorkspaceView, loadWorkspaceOverlay } from '../src/console/release-workspace.ts';
import { fanOutWorkflow } from '../src/wedge/ship.ts';
import { persistDeliverableVersion } from '../src/wedge/deliverable-artifact.ts';
import { runInNewContext } from 'node:vm';
import { parseExecutionSpec } from '../src/coord/execution-spec.ts';
import { recordTrustOutcome, setKill } from '../src/gov/trust.ts';

console.log('\n\x1b[1mConsole — the ledger as a read model\x1b[0m');

T('merged console keeps operator secret checks in addition to session authentication', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(base({ id: 'merged-secret', goal: 'review with both credentials', claimRefs: [rel.id] }));
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
  const { db, ledger, coord, comp, rel } = await seeded();
  const key = generateOperatorKey();
  const owner = (await listUsers(db, TEN)).find((u) => u.email === OWNER.email)!;
  const who = `${owner.id} (${owner.email})`;
  await coord.submit(base({ id: 'merged-signed', goal: 'review with signed session identity', claimRefs: [rel.id] }));
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
      querySelectorAll: (sel?: string) => {
        if (!sel || sel === 'button[type="submit"]') return [button];
        if (sel === 'form[data-review-action]') return [];
        return [];
      },
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
  eq(shipped.requestId, 'n1', 'stable opening notice for equal timestamps:');
  eq(shipped.requestIds, ['n1', 'n2'], 'both notice drilldowns remain available:');
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
        body: JSON.stringify({ statement: 'the launch plan is $149/mo', expectedSeq: claim.seq }),
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
        body: JSON.stringify({
          statement: 'the launch plan is $179/mo',
          expectedSeq: (await ledger.get(TEN, r.supersededBy))!.seq,
          value: 179,
          unit: 'USD/mo',
        }),
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
  const evidence = await ledger.append({
    tenant: TEN,
    subject: 'release:latency',
    kind: 'FACT',
    statement: 'ready for review',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  // Mutable so each decision can happen at a chosen instant.
  let clock = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => clock });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const authed = await ownerSession(server.port);
    // r1 submitted at NOW and approved instantly (0s); r2 submitted a day
    // later and approved 6h after that — the distribution must reflect both.
    // Distinct goals: identical content would dedupe onto one thread (by design).
    const r1 = await coord.submit(base({ id: 'lat1', now: NOW, goal: 'latency probe one', claimRefs: [evidence.id] }));
    const r2 = await coord.submit(
      base({ id: 'lat2', now: DAY_LATER, goal: 'latency probe two', claimRefs: [evidence.id] }),
    );
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

T('HTTP approval freezes a replayable receipt once and gates receipt access by session', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const owner = (await listUsers(db, TEN)).find((u) => u.email === OWNER.email)!;
    const who = `${owner.id} (${owner.email})`;
    const rq1 = (await coord.get(TEN, 'rq1'))!;
    const approve = () =>
      fetch(`${base_}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ by: 'ignored body identity' }),
      });
    const response = await approve();
    eq(response.status, 200);
    const result = (await response.json()) as {
      ok: boolean;
      state: string;
      decisionId: string;
      decisionUrl: string;
    };
    eq(result.ok, true);
    eq(result.state, 'ACCEPTED');
    eq(typeof result.decisionId, 'string');
    eq(result.decisionId.trim().length > 0, true);
    eq(result.decisionUrl, '/console/decisions/' + encodeURIComponent(result.decisionId));
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED');

    const decision = (await ledger.getDecision(TEN, result.decisionId))!;
    eq(decision.requestId, 'rq1');
    eq(decision.approvedBy, who, 'the receipt names the session owner, not the body identity:');
    eq(decision.bundle.claims.map((claim) => claim.id).sort(), [...rq1.claimRefs].sort());
    const replay = await ledger.replayDecision(TEN, result.decisionId);
    eq(replay.record.id, result.decisionId);
    eq(replay.drift.length, rq1.claimRefs.length);
    eq(
      replay.drift.every((claim) => !claim.drifted),
      true,
    );

    const approvalAudits = () =>
      db
        .prepare(
          `SELECT * FROM audit_log WHERE tenant = ? AND
           ((action = 'console.approve' AND target = ?) OR (action = 'APPROVAL_LATENCY' AND target = ?))
           ORDER BY seq`,
        )
        .all(TEN, 'request:rq1', 'rq1');
    const audits = await approvalAudits();
    eq(audits.filter((row) => row.action === 'console.approve').length, 1);
    eq(audits.filter((row) => row.action === 'APPROVAL_LATENCY').length, 1);
    const repeated = await approve();
    eq(repeated.status, 200);
    const again = (await repeated.json()) as { ok: boolean; state: string; decisionId: string };
    eq(again.ok, true);
    eq(again.state, 'ACCEPTED');
    eq(again.decisionId, result.decisionId);
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), [
      { id: result.decisionId },
    ]);
    eq(await approvalAudits(), audits, 'retry must not duplicate approval audit or latency:');

    const receipt = await fetch(`${base_}${result.decisionUrl}`, { headers: session.headers });
    eq(receipt.status, 200);
    eq((await receipt.text()).includes(result.decisionId), true);
    const anonymous = await fetch(`${base_}${result.decisionUrl}`, { redirect: 'manual' });
    eq([303, 401, 403].includes(anonymous.status), true, 'anonymous receipt access is disallowed:');
    eq((await anonymous.text()).includes(result.decisionId), false);
  } finally {
    await server.close();
    await db.close();
  }
});

T('HTTP approval rolls back when recording the decision fails and can then be retried', async () => {
  const { db, ledger, coord, comp } = await seeded();
  let attempts = 0;
  const failingLedger: typeof ledger = {
    ...ledger,
    recordDecision: async () => {
      attempts++;
      throw new Error('injected decision write failure');
    },
  };
  const server = await startConsoleServer(db, failingLedger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const before = await coord.get(TEN, 'rq1');
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: '{}',
      });
    const failed = await approve();
    eq(failed.status >= 400 && failed.status < 600, true);
    eq(((await failed.json()) as { ok: boolean }).ok, false);
    eq(attempts, 1, 'the injected decision write was reached:');
    eq(await coord.get(TEN, 'rq1'), before, 'failed receipt creation must leave the request unchanged:');
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), []);
    eq(
      await db
        .prepare(
          `SELECT action FROM audit_log WHERE tenant = ? AND
           ((action = 'console.approve' AND target = ?) OR (action = 'APPROVAL_LATENCY' AND target = ?))`,
        )
        .all(TEN, 'request:rq1', 'rq1'),
      [],
    );

    failingLedger.recordDecision = ledger.recordDecision;
    const retried = await approve();
    eq(retried.status, 200);
    const result = (await retried.json()) as { ok: boolean; state: string; decisionId: string };
    eq(result.ok, true);
    eq(result.state, 'ACCEPTED');
    eq(typeof result.decisionId, 'string');
    eq(result.decisionId.trim().length > 0, true);
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED');
    eq((await ledger.getDecision(TEN, result.decisionId))!.requestId, 'rq1');
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), [
      { id: result.decisionId },
    ]);
  } finally {
    await server.close();
    await db.close();
  }
});

T('ungrounded HTTP approval returns 409 without changing the request', async () => {
  const { db, ledger, coord, comp } = await seeded();
  // Submission requires a reference; approval must also verify that its evidence exists.
  const { request } = await coord.submit(
    base({ id: 'ungrounded', goal: 'review without evidence', claimRefs: ['missing-approval-evidence'] }),
  );
  eq(await ledger.get(TEN, 'missing-approval-evidence'), null);
  eq(request.state, 'ADMITTED');
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const before = await coord.get(TEN, request.id);
    const audits = await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/${request.id}/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    eq(response.status, 409);
    eq(((await response.json()) as { ok: boolean }).ok, false);
    eq(await coord.get(TEN, request.id), before);
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, request.id), []);
    eq(await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN), audits);
  } finally {
    await server.close();
    await db.close();
  }
});

T('concurrent HTTP approvals of one request return exactly one decision', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: '{}',
      });
    const responses = await Promise.all([approve(), approve()]);
    eq(
      responses.map((response) => response.status),
      [200, 200],
    );
    const results = (await Promise.all(responses.map((response) => response.json()))) as {
      ok: boolean;
      state: string;
      decisionId: string;
    }[];
    const decisionId = results[0]!.decisionId;
    eq(typeof decisionId, 'string');
    eq(decisionId.trim().length > 0, true);
    for (const result of results) {
      eq(result.ok, true);
      eq(result.state, 'ACCEPTED');
      eq(result.decisionId, decisionId);
    }
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED');
    eq((await ledger.getDecision(TEN, decisionId))!.requestId, 'rq1');
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), [
      { id: decisionId },
    ]);
    const audits = await db
      .prepare(
        `SELECT action FROM audit_log WHERE tenant = ? AND
         ((action = 'console.approve' AND target = ?) OR (action = 'APPROVAL_LATENCY' AND target = ?))`,
      )
      .all(TEN, 'request:rq1', 'rq1');
    eq(audits.filter((row) => row.action === 'console.approve').length, 1);
    eq(audits.filter((row) => row.action === 'APPROVAL_LATENCY').length, 1);
  } finally {
    await server.close();
    await db.close();
  }
});

T('HTTP acceptance failure rolls back the newly recorded decision', async () => {
  const { db, ledger, coord, comp } = await seeded();
  let decisionId: string | undefined;
  let attempts = 0;
  const failingCoord: typeof coord = {
    ...coord,
    accept: async (tenant, requestId) => {
      attempts++;
      decisionId = (await ledger.getDecisionByRequest(tenant, requestId))?.id;
      throw new Error('injected acceptance failure');
    },
  };
  const server = await startConsoleServer(db, ledger, failingCoord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const before = await coord.get(TEN, 'rq1');
    const audits = await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN);
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: '{}',
      });
    const failed = await approve();
    eq(failed.status, 409);
    const error = (await failed.json()) as { ok: boolean; error: string };
    eq(error.ok, false);
    eq(error.error.includes('injected acceptance failure'), true);
    eq(attempts, 1);
    eq(typeof decisionId, 'string', 'a decision was recorded before acceptance failed:');
    eq(await ledger.getDecision(TEN, decisionId!), null);
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), []);
    eq(await coord.get(TEN, 'rq1'), before);
    eq(await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN), audits);

    failingCoord.accept = coord.accept;
    const retried = await approve();
    eq(retried.status, 200);
    const result = (await retried.json()) as { ok: boolean; state: string; decisionId: string };
    eq(result.ok, true);
    eq(result.state, 'ACCEPTED');
    eq(result.decisionId, decisionId);
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED');
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), [
      { id: result.decisionId },
    ]);
  } finally {
    await server.close();
    await db.close();
  }
});

T('HTTP approval audit failure rolls back both acceptance and the new decision', async () => {
  const { db, ledger, coord, comp } = await seeded();
  let failAudit = true;
  let attempts = 0;
  let decisionId: string | undefined;
  let stateAtFailure: string | undefined;
  const failingDb: typeof db = {
    ...db,
    prepare: (sql) => {
      const statement = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO audit_log')) return statement;
      return {
        ...statement,
        run: async (...params) => {
          if (failAudit && params[2] === 'console.approve' && params[3] === 'request:rq1') {
            attempts++;
            decisionId = (await ledger.getDecisionByRequest(TEN, 'rq1'))?.id;
            stateAtFailure = (await coord.get(TEN, 'rq1'))?.state;
            throw new Error('injected approval audit failure');
          }
          return statement.run(...params);
        },
      };
    },
  };
  const server = await startConsoleServer(failingDb, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const before = await coord.get(TEN, 'rq1');
    const audits = await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN);
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: '{}',
      });
    const failed = await approve();
    eq(failed.status, 409);
    const error = (await failed.json()) as { ok: boolean; error: string };
    eq(error.ok, false);
    eq(error.error.includes('injected approval audit failure'), true);
    eq(attempts, 1);
    eq(stateAtFailure, 'ACCEPTED', 'acceptance happened before the audit failed:');
    eq(typeof decisionId, 'string', 'the decision existed before the audit failed:');
    eq(await ledger.getDecision(TEN, decisionId!), null);
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), []);
    eq(await coord.get(TEN, 'rq1'), before);
    eq(await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq').all(TEN), audits);

    failAudit = false;
    const retried = await approve();
    eq(retried.status, 200);
    const result = (await retried.json()) as { ok: boolean; state: string; decisionId: string };
    eq(result.ok, true);
    eq(result.state, 'ACCEPTED');
    eq(result.decisionId, decisionId);
    eq((await coord.get(TEN, 'rq1'))!.state, 'ACCEPTED');
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), [
      { id: result.decisionId },
    ]);
    eq(
      (
        await db
          .prepare("SELECT action FROM audit_log WHERE tenant = ? AND action = 'console.approve' AND target = ?")
          .all(TEN, 'request:rq1')
      ).length,
      1,
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-001: HTTP approval records a versioned execution specification receipt', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const rq1 = (await coord.get(TEN, 'rq1'))!;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestUpdatedAt: rq1.updatedAt }),
    });
    eq(response.status, 200);
    const result = (await response.json()) as { decisionId: string; specFingerprint: string };
    const decision = (await ledger.getDecision(TEN, result.decisionId))!;
    const spec = parseExecutionSpec(decision.action);
    eq(spec !== null, true, 'decision action stores execution spec:');
    eq(spec!.fingerprint, result.specFingerprint);
    eq(spec!.requestId, 'rq1');
    eq(spec!.approvalStage, 'begin-work');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-002: stale approval page is rejected without changing the request', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const before = await coord.get(TEN, 'rq1');
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    });
    eq(response.status, 409);
    const body = (await response.json()) as { ok: boolean; code?: string };
    eq(body.ok, false);
    eq(body.code, 'STALE_REVIEW');
    eq(await coord.get(TEN, 'rq1'), before);
    eq(await db.prepare('SELECT id FROM decisions WHERE tenant = ? AND request_id = ?').all(TEN, 'rq1'), []);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-002: stale approval returns a diff and requires re-review', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    });
    eq(response.status, 409);
    const body = (await response.json()) as {
      ok: boolean;
      code?: string;
      requiresReReview?: boolean;
      diff?: unknown;
    };
    eq(body.ok, false);
    eq(body.code, 'STALE_REVIEW');
    eq(body.requiresReReview, true, 'stale approval must demand re-review:');
    eq(Array.isArray(body.diff) && body.diff.length > 0, true, 'stale approval shows what changed:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-002: corrected evidence blocks approval with a before/after diff', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const rq1 = (await coord.get(TEN, 'rq1'))!;
    const cited = rq1.claimRefs[0]!;
    await ledger.correctClaim(TEN, cited, 'ships late', 'human:priya', NOW);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestUpdatedAt: rq1.updatedAt }),
    });
    eq(response.status, 409);
    const body = (await response.json()) as { ok: boolean; code?: string; diff?: string[] };
    eq(body.ok, false);
    eq(body.code, 'STALE_EVIDENCE');
    eq(
      body.diff?.some((line) => line.includes('ships') && line.includes('ships late')),
      true,
      'diff carries the before/after statements:',
    );
    eq((await coord.get(TEN, 'rq1'))!.state, 'ADMITTED', 'no state change without re-review:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-002: stale decline preserves the reviewer explanation for resubmission', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/requests/rq1/decline`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not now', requestUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    });
    eq(response.status, 409);
    const body = (await response.json()) as {
      ok: boolean;
      code?: string;
      preservedDraft?: { reason?: string };
    };
    eq(body.ok, false);
    eq(body.code, 'STALE_REVIEW');
    eq(body.preservedDraft?.reason, 'not now', 'reviewer explanation survives the rejection:');
  } finally {
    await server.close();
    await db.close();
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
    // rq1 is queued and cites seeded ledger evidence; r1 is already accepted.
    const ok = (await (
      await fetch(`${base_}/api/requests/rq1/approve`, {
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

T('FLOW-006: loopback is the default bind and the server reports its actual address', async () => {
  eq(isLoopbackBindHost(DEFAULT_BIND_HOST), true);
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: 'bind-default', now: () => NOW });
  try {
    eq(server.host, '127.0.0.1');
    eq(server.address, `127.0.0.1:${server.port}`);
    const health = (await fetch(`http://127.0.0.1:${server.port}/healthz`).then((r) => r.json())) as {
      ok: boolean;
      listen: string;
    };
    eq(health.ok, true);
    eq(health.listen, server.address);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-006: configured HOST=0.0.0.0 is honored and reachable through loopback', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: 'bind-public',
    host: '0.0.0.0',
    now: () => NOW,
  });
  try {
    eq(server.host, '0.0.0.0');
    eq(server.address, `0.0.0.0:${server.port}`);
    eq((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-006: public bind blocks remote signup until bootstrap credentials are configured', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: 'bind-remote',
    host: '0.0.0.0',
    now: () => NOW,
  });
  try {
    eq((await fetch(`http://127.0.0.1:${server.port}/signup`)).status, 503);
    const blocked = await fetch(`http://127.0.0.1:${server.port}/signup`, {
      method: 'POST',
      body: 'orgname=Remote&ownerName=Q&email=q%40remote.test&password=long-enough-password',
    });
    eq(blocked.status, 403);
    const body = (await blocked.json()) as { error: string };
    eq(body.error.includes('remote signup is disabled'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-012: empty org sees activation checklist before health charts', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`, { headers: session.headers })).text();
    eq(html.includes('id="activation-setup"'), true);
    eq(html.includes('Organization setup'), true);
    eq(html.includes('next useful action'), true);
    const healthPos = html.indexOf('<h1>Reality health</h1>');
    const activationPos = html.indexOf('id="activation-setup"');
    eq(activationPos > 0 && activationPos < healthPos, true, 'activation precedes health charts:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-012: setup page saves config, ingests first source, and starts release workflow', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const owner = await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const sourceDir = join(tmpdir(), `vital-flow012-${Date.now()}`);
  const artifactDir = join(tmpdir(), `vital-flow012-art-${Date.now()}`);
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(sourceDir, 'release.md'), '# v0.1\nFirst public release notes');
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const save = await fetch(`${base_}/setup`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({
        csrf: session.csrf,
        accountableOwnerId: owner.owner.id,
        scope: 'engineering',
        sourcePath: sourceDir,
        artifactDir,
        approverRole: 'member',
        dailyBudgetDollars: '100',
        humanMinutesBudget: '60',
      }),
    });
    eq(save.status, 200);
    const config = await loadActivationConfig(db, TEN);
    eq(config?.scope, 'engineering');
    eq(config?.sourcePath, sourceDir);

    const ingest = await fetch(`${base_}/setup/ingest`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf }),
    });
    eq(ingest.status, 200);
    const stateAfterIngest = await buildActivationState(db, ledger, coord, TEN, NOW, [owner.owner]);
    eq(stateAfterIngest.sourceState, 'ready');
    eq(stateAfterIngest.firstReceipt !== null, true);

    const workflow = await fetch(`${base_}/setup/start-release`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf }),
      redirect: 'manual',
    });
    eq(workflow.status, 303);
    const complete = await buildActivationState(db, ledger, coord, TEN, NOW, [owner.owner]);
    eq(complete.releaseWorkflowId !== null, true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-015: release workspace links fan-out, prereg, outcome, and replay', async () => {
  const { db, ledger, coord, comp } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 100,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 20,
  });
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'release:flow015',
    kind: 'OBSERVATION',
    statement: 'Adds export receipts',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'owner',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const run = await fanOutWorkflow(db, coord, TEN, {
    release: 'flow015',
    claimIds: [claim.id],
    onBehalfOf: 'human:owner',
    now: NOW,
    summary: 'FLOW-015 workspace test',
  });
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const list = await (await fetch(`${base_}/console/workflows`, { headers: session.headers })).text();
    eq(list.includes(run.id), true, 'workflow list includes run:');
    eq(list.includes('FLOW-015 workspace test'), true, 'workflow list shows summary:');

    const detail = await (
      await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}`, { headers: session.headers })
    ).text();
    eq(detail.includes('Source evidence'), true);
    eq(detail.includes(claim.id), true);
    eq(detail.includes('Fan-out legs'), true);
    eq(detail.includes('marketing'), true);
    eq(detail.includes('Pre-register metrics'), true);

    const prereg = await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}/preregister`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({
        csrf: session.csrf,
        metric: 'ship_to_launch_hours',
        threshold: '24',
        baseline: '48h pre-pilot average',
        comparisonBasis: 'holdout segment',
        windowStart: '2026-09-01',
        windowEnd: '2026-10-01',
      }),
      redirect: 'manual',
    });
    eq(prereg.status, 303);
    const overlay = await loadWorkspaceOverlay(db, TEN, run.id);
    eq(overlay?.preregId !== undefined, true, 'prereg persisted:');

    const admittedLeg = run.legs.find((l) => l.requestId && l.status === 'ADMITTED');
    eq(admittedLeg?.requestId !== undefined, true, 'fan-out admitted a reviewable leg:');
    await ledger.recordDecision({
      tenant: TEN,
      goal: `approve ${admittedLeg!.key} leg`,
      action: 'begin fan-out deliverable work',
      actionClass: 'RECOMMEND',
      claimIds: [claim.id],
      decidedBy: 'human:owner',
      approvedBy: 'owner (owner@acme.test)',
      scope: admittedLeg!.key,
      autonomy: 'approval',
      requestId: admittedLeg!.requestId!,
      now: NOW,
    });

    const view = await buildWorkspaceView(db, ledger, coord, comp, TEN, run.id);
    eq(view?.canCaptureOutcome, true, 'outcome capture enabled after prereg and approval:');
    eq((view?.replay?.length ?? 0) > 0, true, 'replay exposes frozen decision evidence:');

    const outcome = await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}/outcome`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({
        csrf: session.csrf,
        decisionId: view!.replay[0]!.decisionId,
        metric: 'ship_to_launch_hours',
        actual: '12',
        basis: 'pilot holdout measurement',
      }),
      redirect: 'manual',
    });
    eq(outcome.status, 303);
    const measured = await buildWorkspaceView(db, ledger, coord, comp, TEN, run.id);
    eq(measured?.lifecycle, 'OUTCOME_VERIFIED');
    eq(measured?.outcomes.length, 1);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-015: workflow cancel and retry are exposed without re-executing replay', async () => {
  const { db, ledger, coord, comp } = await fresh({
    maxConcurrentPerScope: 6,
    maxDailyDollars: 40,
    maxDailyTokens: 2_000_000,
    maxHumanEscalationsPerDay: 0,
  });
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'release:blocked',
    kind: 'OBSERVATION',
    statement: 'Blocked rollout',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'owner',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const run = await fanOutWorkflow(db, coord, TEN, {
    release: 'blocked',
    claimIds: [claim.id],
    onBehalfOf: 'human:owner',
    now: NOW,
    summary: 'blocked fan-out',
  });
  eq(run.status, 'BLOCKED');
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const before = await (
      await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}`, { headers: session.headers })
    ).text();
    eq(before.includes('BLOCKED'), true);
    eq(before.includes('Retry eligible legs'), true);

    const cancel = await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}/cancel`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf, reason: 'pilot paused' }),
      redirect: 'manual',
    });
    eq(cancel.status, 303);
    const after = await (
      await fetch(`${base_}/console/workflows/${encodeURIComponent(run.id)}`, { headers: session.headers })
    ).text();
    eq(after.includes('CANCELLED'), true);
    eq(after.includes('pilot paused'), true);
    eq(after.includes('Replay (frozen vs current)'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: expired session API returns sign-in-to-continue with return path', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(base({ id: 'flow010-expired', goal: 'session expiry review', claimRefs: [rel.id] }));
  let at = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => at });
  try {
    const session = await ownerSession(server.port);
    at = new Date(Date.parse(NOW) + 13 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/requests/flow010-expired/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    eq(res.status, 401);
    const body = (await res.json()) as { code: string; loginUrl: string; error: string };
    eq(body.code, 'SESSION_EXPIRED');
    eq(body.error.includes('Sign in to continue'), true);
    eq(body.loginUrl.includes('reason=expired'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: expired page visit redirects to login with next and expiry notice', async () => {
  const { db, ledger, coord, comp } = await seeded();
  let at = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => at });
  try {
    const session = await ownerSession(server.port);
    at = new Date(Date.parse(NOW) + 13 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`http://127.0.0.1:${server.port}/console/claims/test-claim`, {
      headers: { cookie: session.cookie },
      redirect: 'manual',
    });
    eq(res.status, 303);
    const loc = res.headers.get('location') ?? '';
    eq(loc.includes('/login'), true);
    eq(loc.includes('reason=expired'), true);
    eq(loc.includes('next='), true);
    const login = await fetch(`http://127.0.0.1:${server.port}${loc}`);
    const html = await login.text();
    eq(html.includes('Sign in to continue'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: login CSRF mismatch preserves email on HTML recovery', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const pre = await fetch(`http://127.0.0.1:${server.port}/login`);
    const preCsrf = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const staleToken = 'deadbeef'.repeat(8);
    const res = await fetch(`http://127.0.0.1:${server.port}/login`, {
      method: 'POST',
      headers: { cookie: preCsrf, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${staleToken}&email=owner%40acme.test&password=ignored`,
    });
    eq(res.status, 200);
    const html = await res.text();
    eq(html.includes('form expired'), true);
    eq(html.includes('value="owner@acme.test"'), true);
    eq(
      (res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('vital_csrf=')),
      true,
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-027: account and console documents carry viewport, landmark, and focus styles', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const login = await (await fetch(`http://127.0.0.1:${server.port}/login`)).text();
    eq(login.includes('name="viewport"'), true, 'login page declares a viewport:');
    eq(login.includes('<main>'), true, 'login page has a main landmark:');
    eq(login.includes(':focus-visible'), true, 'keyboard focus stays visible:');
    const session = await ownerSession(server.port);
    const account = await (await fetch(`http://127.0.0.1:${server.port}/account`, { headers: session.headers })).text();
    eq(account.includes('name="viewport"'), true, 'account page declares a viewport:');
    const detail = await (
      await fetch(`http://127.0.0.1:${server.port}/console/requests/rq1`, { headers: session.headers })
    ).text();
    eq(detail.includes('name="viewport"'), true, 'request detail declares a viewport:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: voluntary password change lives under account, forced activation under change-password', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const account = await (await fetch(`http://127.0.0.1:${server.port}/account`, { headers: session.headers })).text();
    eq(account.includes('Account and security'), true);
    eq(account.includes('/account/password'), true);
    const forced = await fetch(`http://127.0.0.1:${server.port}/change-password`, {
      headers: session.headers,
      redirect: 'manual',
    });
    eq(forced.status, 303);
    eq((forced.headers.get('location') ?? '').includes('/account'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-012: sample walkthrough is labeled and separate from customer evidence', async () => {
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
    const session = await ownerSession(server.port);
    const sample = await fetch(`${base_}/setup/sample`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf }),
      redirect: 'manual',
    });
    eq(sample.status, 303);
    const html = await (await fetch(`${base_}/#pending-review`, { headers: session.headers })).text();
    eq(html.includes('SAMPLE WALKTHROUGH'), true);
    eq(html.includes(SAMPLE_SCOPE), true);
    const claim = (await db
      .prepare('SELECT scope FROM claims WHERE tenant = ? ORDER BY created_at DESC LIMIT 1')
      .get(TEN)) as { scope: string };
    eq(claim.scope, SAMPLE_SCOPE);
    const request = (await db
      .prepare('SELECT id FROM requests WHERE tenant = ? ORDER BY created_at DESC LIMIT 1')
      .get(TEN)) as {
      id: string;
    };
    eq(request.id.startsWith(SAMPLE_REQUEST_PREFIX), true);
  } finally {
    await server.close();
    await db.close();
  }
});

async function formSession(port: number, email: string, password: string) {
  const base_ = `http://127.0.0.1:${port}`;
  const loginOnce = async (pw: string): Promise<string> => {
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const res = await fetch(`${base_}/login`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pw)}`,
      redirect: 'manual',
    });
    return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  };
  let cookie = await loginOnce(password);
  const gate = await fetch(`${base_}/change-password`, { headers: { cookie }, redirect: 'manual' });
  if (gate.status === 200) {
    const gateCsrf = (await gate.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const fresh = `${password}-second-settlement`;
    await fetch(`${base_}/change-password`, {
      method: 'POST',
      headers: { cookie },
      body: `csrf=${gateCsrf}&password=${encodeURIComponent(fresh)}`,
      redirect: 'manual',
    });
    cookie = await loginOnce(fresh);
  }
  const home = await (await fetch(`${base_}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  return { cookie, csrf, headers: { cookie, 'x-vital-csrf': csrf } as Record<string, string> };
}

T('FLOW-019: console header renders shared nav with account controls', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`, { headers: session.headers })).text();
    eq(html.includes('<nav aria-label="Console">'), true);
    eq(html.includes('>Reviews</a>'), true);
    eq(html.includes('href="/console/workflows">Workflows</a>'), true);
    eq(html.includes('href="/console/digest">Digest</a>'), true);
    eq(html.includes('href="/team">Team</a>'), true);
    eq(html.includes('href="/account">Account</a>'), true);
    eq(html.includes('signed in as owner@acme.test'), true);
    eq(html.includes('action="/logout"'), true);
    eq(html.includes('href="/console/requests/rq1"'), true, 'every needs-human item links to its task:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-019: detail navigation preserves the queue return destination', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const back = '/?reviewPage=2';
    const detail = await (
      await fetch(`http://127.0.0.1:${server.port}/console/requests/rq1?return=${encodeURIComponent(back)}`, {
        headers: session.headers,
      })
    ).text();
    eq(detail.includes(`<a href="${back}">Back to console</a>`), true);
    eq(detail.includes(`return=${encodeURIComponent(back)}`), true);
    const bad = await fetch(`http://127.0.0.1:${server.port}/console/requests/rq1?page=-1`, {
      headers: session.headers,
    });
    eq(bad.status, 400);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-020: dashboard filters by status, scope, date, and workflow', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  const parent = await coord.submit(
    base({ id: 'flt-parent', goal: 'filter parent', claimRefs: [rel.id], bid: { humanMinutes: 1 } }),
  );
  await coord.submit(
    base({
      id: 'flt-child',
      goal: 'filter child unique',
      claimRefs: [rel.id],
      parentRequestId: parent.request.id,
      bid: { humanMinutes: 1 },
    }),
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const get = (qs: string) => fetch(`${base_}/${qs}`, { headers: session.headers }).then((r) => r.text());
    const form = await get('?q=filter');
    eq(form.includes('name="state"'), true, 'status filter is offered:');
    eq(form.includes('name="since"'), true, 'date filters are offered:');
    eq(form.includes('name="workflow"'), true, 'workflow filter is offered:');
    const byState = await get('?q=filter&state=ADMITTED');
    eq(byState.includes('filter child unique'), true);
    const byScope = await get('?q=filter&scope=engineering');
    eq(byScope.includes('filter child unique'), true);
    const byWorkflow = await get(`?q=filter&workflow=${parent.request.id}`);
    eq(byWorkflow.includes('filter child unique'), true, 'workflow filter keeps the child:');
    eq(byWorkflow.includes('1 matching request(s)'), true, 'workflow filter narrows to one request:');
    const future = await get('?q=filter&since=2030-01-01');
    eq(future.includes('No matching work'), true, 'future date bounds exclude everything:');
    const dated = await get('?q=filter&since=2020-01-01&until=2030-01-01');
    eq(dated.includes('filter child unique'), true, 'inclusive date bounds keep current work:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-020: dashboard search exposes matching work with totals, truncation, and clear-filter', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(base({ id: 'searchable-1', goal: 'zephyr launch hyperdrive review', claimRefs: [rel.id] }));
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const found = await (await fetch(`http://127.0.0.1:${server.port}/?q=zephyr`, { headers: session.headers })).text();
    eq(found.includes('zephyr launch hyperdrive review'), true);
    eq(found.includes('matching request(s)'), true);
    eq(found.includes('Pending decision'), true);
    eq(found.includes('Clear search and filters'), true);
    const missing = await (
      await fetch(`http://127.0.0.1:${server.port}/?q=no-such-work-xyz`, { headers: session.headers })
    ).text();
    eq(missing.includes('No results'), true);
    eq(missing.includes('No matching work for search'), true);
    const truncated = await (
      await fetch(`http://127.0.0.1:${server.port}/?q=a&limit=1`, { headers: session.headers })
    ).text();
    eq(truncated.includes('explicit truncation'), true);
    const invalid = await fetch(`http://127.0.0.1:${server.port}/?state=BOGUS`, { headers: session.headers });
    eq(invalid.status, 400);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-020: workflow list filters by query without changing the unfiltered page', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const plain = await (
      await fetch(`http://127.0.0.1:${server.port}/console/workflows`, { headers: session.headers })
    ).text();
    eq(plain.includes('No release workflows yet'), true);
    const filtered = await (
      await fetch(`http://127.0.0.1:${server.port}/console/workflows?q=zzz-no-such-workflow`, {
        headers: session.headers,
      })
    ).text();
    eq(filtered.includes('No results'), true);
    eq(filtered.includes('Clear search'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-021: digest route serves grouped notices with a time-window navigator', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(
    base({ id: 'notice-1', goal: 'overnight sync completed', messageClass: 'NOTICE', claimRefs: [rel.id] }),
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const digest = await (
      await fetch(`http://127.0.0.1:${server.port}/console/digest`, { headers: session.headers })
    ).text();
    eq(digest.includes('overnight sync completed'), true);
    eq(digest.includes('Last 7 day(s)'), true);
    eq(digest.includes('aria-current="page"'), true);
    eq(digest.includes('/console/digest?days=1'), true);
    eq(
      (await fetch(`http://127.0.0.1:${server.port}/console/digest?days=bogus`, { headers: session.headers })).status,
      400,
    );
    eq(
      (await fetch(`http://127.0.0.1:${server.port}/console/digest`, { method: 'POST', headers: session.headers }))
        .status,
      405,
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-009: team page states disable consequences and invite errors guide next steps', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const team = await (await fetch(`http://127.0.0.1:${server.port}/team`, { headers: session.headers })).text();
    eq(team.includes('Create account'), true);
    eq(team.includes('out of band'), true);
    eq(team.includes('Members ('), true);
    eq(team.includes('Disabling revokes every live session immediately'), true);
    eq(team.includes('never restores revoked sessions'), true);
    const invite = (csrf: string, email: string) =>
      fetch(`http://127.0.0.1:${server.port}/team/invite`, {
        method: 'POST',
        headers: { cookie: session.cookie },
        body: `csrf=${csrf}&email=${encodeURIComponent(email)}&name=Dup&role=member`,
        redirect: 'manual',
      });
    eq((await invite(session.csrf, 'dup@acme.test')).status, 200);
    const repeat = await invite(session.csrf, 'dup@acme.test');
    eq(repeat.status, 400);
    eq((await repeat.text()).includes('Resend the link, or revoke it and create a new account.'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-009: invitation lifecycle over HTTP — invite, accept, resend rotates, revoke kills', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const prev = process.env.VITAL_EXPOSE_INVITE_LINK;
  process.env.VITAL_EXPOSE_INVITE_LINK = '1';
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const invite = (email: string) =>
      fetch(`${base_}/team/invite`, {
        method: 'POST',
        headers: { cookie: session.cookie },
        body: `csrf=${session.csrf}&email=${encodeURIComponent(email)}&name=New&role=member`,
        redirect: 'manual',
      });
    const tokenOf = (html: string): string => {
      const m = html.match(/\/accept-invite\?token=([A-Za-z0-9_-]+)/);
      if (!m) throw new Error(`no acceptance link in invite response: ${html.slice(0, 300)}`);
      return decodeURIComponent(m[1]!);
    };
    // Invitation rows share one created_at timestamp, so row order is not a
    // stable locator — bind each invitationId to its email row instead.
    const invIdFor = (html: string, email: string): string => {
      const m = html.match(
        new RegExp(
          `${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/td>[\\s\\S]*?name="invitationId" value="([^"]+)"`,
        ),
      );
      if (!m) throw new Error(`no invitation row for ${email}`);
      return m[1]!;
    };
    const invited = await invite('new@acme.test');
    eq(invited.status, 200);
    const invitedHtml = await invited.text();
    eq(invitedHtml.includes('invited as member'), true);
    const token = tokenOf(invitedHtml);
    const acceptPage = await fetch(`${base_}/accept-invite?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    eq(acceptPage.status, 200);
    const acceptHtml = await acceptPage.text();
    eq(acceptHtml.includes('Join acme'), true);
    const preCookie = (acceptPage.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = acceptHtml.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const accept = await fetch(`${base_}/accept-invite`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&token=${encodeURIComponent(token)}&password=${encodeURIComponent('a-new-member-password')}`,
      redirect: 'manual',
    });
    eq(accept.status, 303, 'acceptance signs the member straight in:');
    const memberCookie = (accept.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    eq(memberCookie.includes('vital_session='), true);
    const home = await fetch(`${base_}/`, { headers: { cookie: memberCookie }, redirect: 'manual' });
    eq(home.status, 200, 'the new account reaches the console:');
    const replay = await fetch(`${base_}/accept-invite`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&token=${encodeURIComponent(token)}&password=${encodeURIComponent('a-new-member-password')}`,
      redirect: 'manual',
    });
    eq(replay.status, 400, 'an accepted link cannot be reused:');
    const second = await invite('second@acme.test');
    const teamHtml = await second.text();
    const secondToken = tokenOf(teamHtml);
    const invId = invIdFor(teamHtml, 'second@acme.test');
    const resend = await fetch(`${base_}/team/invitation/resend`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: `csrf=${session.csrf}&invitationId=${encodeURIComponent(invId)}`,
      redirect: 'manual',
    });
    eq(resend.status, 200);
    const rotated = tokenOf(await resend.text());
    eq(rotated === secondToken, false, 'resend rotates the acceptance token:');
    const stale = await fetch(`${base_}/accept-invite?token=${encodeURIComponent(secondToken)}`, {
      redirect: 'manual',
    });
    eq(stale.status, 404, 'the superseded link is dead:');
    const fresh = await fetch(`${base_}/accept-invite?token=${encodeURIComponent(rotated)}`, { redirect: 'manual' });
    eq(fresh.status, 200, 'the rotated link opens the acceptance page:');
    const third = await invite('third@acme.test');
    const thirdHtml = await third.text();
    const thirdToken = tokenOf(thirdHtml);
    const thirdId = invIdFor(thirdHtml, 'third@acme.test');
    const revoke = await fetch(`${base_}/team/invitation/revoke`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: `csrf=${session.csrf}&invitationId=${encodeURIComponent(thirdId)}`,
      redirect: 'manual',
    });
    eq(revoke.status, 200);
    eq((await revoke.text()).includes('revoked'), true);
    const killed = await fetch(`${base_}/accept-invite?token=${encodeURIComponent(thirdToken)}`, {
      redirect: 'manual',
    });
    eq(killed.status, 404, 'the revoked link is dead:');
  } finally {
    if (prev === undefined) delete process.env.VITAL_EXPOSE_INVITE_LINK;
    else process.env.VITAL_EXPOSE_INVITE_LINK = prev;
    await server.close();
    await db.close();
  }
});

T('FLOW-009: role change, ownership succession, disable and reactivate over HTTP', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const admin2 = await inviteUser(
    db,
    TEN,
    { email: 'admin2@acme.test', name: 'A2', role: 'admin', password: 'an-admin2-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const member = await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const teamPost = (session: { cookie: string; csrf: string }, path: string, body: string) =>
      fetch(`${base_}${path}`, {
        method: 'POST',
        headers: { cookie: session.cookie },
        body: `csrf=${session.csrf}&${body}`,
        redirect: 'manual',
      });
    const asMember = await formSession(server.port, 'member@acme.test', 'a-members-password');
    // formSession settles forced activation, rotating the password.
    const memberPassword = 'a-members-password-second-settlement';
    const selfPromote = await teamPost(asMember, '/team/role', `userId=${member.id}&role=admin`);
    eq(selfPromote.status, 403, 'members cannot change roles:');
    const promote = await teamPost(owner, '/team/role', `userId=${member.id}&role=admin`);
    eq(promote.status, 200);
    eq((await promote.text()).includes('is now admin'), true);
    const transfer = await teamPost(owner, '/team/transfer-ownership', `userId=${admin2.id}`);
    eq(transfer.status, 200);
    eq((await transfer.text()).includes(`Ownership transferred to ${admin2.email}`), true);
    const secondTransfer = await teamPost(owner, '/team/transfer-ownership', `userId=${member.id}`);
    eq(secondTransfer.status, 403, 'the demoted ex-owner cannot transfer again:');
    const wrongConfirm = await teamPost(owner, '/team/disable', `userId=${member.id}&confirmEmail=wrong%40acme.test`);
    eq(wrongConfirm.status, 400);
    const disabled = await teamPost(owner, '/team/disable', `userId=${member.id}&confirmEmail=member%40acme.test`);
    eq(disabled.status, 200);
    eq((await disabled.text()).includes('every live session was revoked'), true);
    const relogin = await formSession(server.port, 'member@acme.test', memberPassword).then(
      () => 'signed-in',
      () => 'refused',
    );
    eq(relogin, 'refused', 'disabled members cannot sign in:');
    const reactivated = await teamPost(owner, '/team/reactivate', `userId=${member.id}`);
    eq(reactivated.status, 200);
    const back = await formSession(server.port, 'member@acme.test', memberPassword);
    eq(typeof back.cookie, 'string', 'reactivation restores sign-in access:');
    eq(
      (await fetch(`${base_}/`, { headers: back.headers, redirect: 'manual' })).status,
      200,
      'the reactivated member reaches the console:',
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: expiry redirects carry a return path and the flood cap preserves safe context', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const expired = await fetch(`${base_}/login?reason=expired`, { redirect: 'manual' });
    const expiredHtml = await expired.text();
    eq(expiredHtml.includes('Sign in to continue'), true);
    eq(expiredHtml.includes('never replayed'), true);
    const stale = await fetch(`${base_}/console/requests/rq1`, {
      headers: { cookie: 'vital_session=deadbeef' },
      redirect: 'manual',
    });
    eq(stale.status, 303);
    const location = stale.headers.get('location') ?? '';
    eq(location.includes('reason=expired'), true);
    eq(location.includes('next='), true);
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    let lastStatus = 0;
    let lastBody = '';
    for (let i = 0; i < 32; i++) {
      const attempt = await fetch(`${base_}/login`, {
        method: 'POST',
        headers: { cookie: preCookie },
        body: `csrf=${preToken}&email=${encodeURIComponent(`ghost${i}@acme.test`)}&password=wrong-password-here`,
        redirect: 'manual',
      });
      lastStatus = attempt.status;
      lastBody = await attempt.text();
    }
    eq(lastStatus, 429);
    eq(lastBody.includes('wait before trying again'), true);
    eq(lastBody.includes('value="ghost31@acme.test"'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-010: forced activation and voluntary change use distinct success copy', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const first = await fetch(`${base_}/login`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&email=${encodeURIComponent('member@acme.test')}&password=${encodeURIComponent('a-members-password')}`,
      redirect: 'manual',
    });
    eq(first.status, 303);
    const forcedCookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const forced = await (
      await fetch(`${base_}/change-password`, { headers: { cookie: forcedCookie }, redirect: 'manual' })
    ).text();
    eq(forced.includes('Account activated'), true);
    eq(forced.includes('revoked every session'), true);
    const session = await ownerSession(server.port);
    const account = await (await fetch(`${base_}/account`, { headers: session.headers })).text();
    eq(account.includes('Account and security'), true);
    eq(account.includes('every other session'), true);
    eq(account.includes('Back to console'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-022: stops display on the team page and recovery is role-gated and audited', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  await setKill(db, TEN, { scope: 'engineering', actionClass: 'ACT_REVERSIBLE' }, 'human:priya', NOW, {
    reason: 'suspected bad deploy',
  });
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const member = await formSession(server.port, 'member@acme.test', 'a-members-password');
    const team = await (await fetch(`${base_}/team`, { headers: owner.headers })).text();
    eq(team.includes('Emergency stops'), true);
    eq(team.includes('scope engineering × class ACT_REVERSIBLE'), true);
    eq(team.includes('suspected bad deploy'), true);
    eq(team.includes('held at admission'), true);
    eq(team.includes('Recover stop'), true);
    const recover = (session: { cookie: string; csrf: string }, reason: string) =>
      fetch(`${base_}/team/stops/recover`, {
        method: 'POST',
        headers: { cookie: session.cookie },
        body: `csrf=${session.csrf}&scope=engineering&actionClass=ACT_REVERSIBLE&reason=${encodeURIComponent(reason)}`,
        redirect: 'manual',
      });
    eq((await recover(member, 'member attempt')).status, 403);
    const missing = await recover(owner, '');
    eq(missing.status, 400);
    eq((await missing.text()).includes('recorded reason'), true);
    const done = await recover(owner, 'deploy verified healthy');
    eq(done.status, 303);
    const cleared = await (await fetch(`${base_}/team`, { headers: owner.headers })).text();
    eq(cleared.includes('No active stops'), true);
    const audits = (await db
      .prepare("SELECT action FROM audit_log WHERE tenant = ? AND action IN ('KILL_RECOVERED','team.stops_recover')")
      .all(TEN)) as { action: string }[];
    eq(
      audits.some((a) => a.action === 'KILL_RECOVERED'),
      true,
    );
    eq(
      audits.some((a) => a.action === 'team.stops_recover'),
      true,
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-022: automation self-halts surface on the team page', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await recordTrustOutcome(db, TEN, 'engineering', 'ACT_REVERSIBLE', { honeyMiss: true, clean: false, now: NOW });
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const team = await (await fetch(`http://127.0.0.1:${server.port}/team`, { headers: session.headers })).text();
    eq(team.includes('Recent automation self-halts'), true);
    eq(team.includes('AUTOMATION_SELF_HALT'), true);
    eq(team.includes('engineering/ACT_REVERSIBLE'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-023: metrics extend liveness with readiness while the public pill stays stable', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const metrics = (await (await fetch(`${base_}/api/metrics`, { headers: session.headers })).json()) as {
      requests: number;
      reportBuilds: number;
      readiness: { ready: boolean; checks: { name: string; status: string }[] };
    };
    eq(metrics.requests > 0, true);
    eq(metrics.reportBuilds > 0, true);
    eq(metrics.readiness.ready, true);
    eq(
      metrics.readiness.checks.some((c) => c.name === 'database' && c.status === 'ok'),
      true,
    );
    const healthz = (await (await fetch(`${base_}/healthz`)).json()) as { ok: boolean; alive: boolean };
    eq(healthz.ok, true);
    eq(healthz.alive, true);
    const pill = (await (await fetch(`${base_}/api/health`)).json()) as Record<string, unknown>;
    eq(pill.ok, true);
    eq('readiness' in pill, false);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-024: ledger export downloads with a manifest; audit history is searchable and paginated', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    for (const path of ['/console/export', '/console/requests']) {
      eq((await fetch(`${base_}${path}`, { headers: session.headers })).status, 404);
    }
    const anon = await fetch(`${base_}/api/ledger/export?kind=snapshot`);
    eq(anon.status, 401, 'anonymous export is refused:');
    const badKind = await fetch(`${base_}/api/ledger/export?kind=everything`, { headers: session.headers });
    eq(badKind.status, 400);
    const snap = await fetch(`${base_}/api/ledger/export?kind=snapshot`, { headers: session.headers });
    eq(snap.status, 200);
    eq(snap.headers.get('content-disposition')?.includes('attachment'), true, 'served as a download:');
    const body = (await snap.json()) as {
      ok: boolean;
      manifest: {
        kind: string;
        tenant: string;
        contents: string[];
        omissions: string[];
        counts: Record<string, number>;
      };
      export: { claims: unknown[] };
    };
    eq(body.ok, true);
    eq(body.manifest.kind, 'snapshot');
    eq(body.manifest.tenant, TEN);
    eq(body.manifest.contents.includes('decisions'), true);
    eq(body.manifest.omissions.length > 0, true, 'omissions are stated, not hidden:');
    eq(typeof body.manifest.counts.claims, 'number');
    const audit = (await (
      await fetch(`${base_}/api/audit?action=console.approve&limit=5`, { headers: session.headers })
    ).json()) as { ok: boolean; rows: { links: object }[]; total: number; limit: number; offset: number };
    eq(audit.ok, true);
    eq(audit.limit, 5);
    eq(
      audit.rows.every((r) => typeof r.links === 'object'),
      true,
      'rows link evidence/authorization/receipts:',
    );
    const anonAudit = await fetch(`${base_}/api/audit`);
    eq(anonAudit.status, 401, 'anonymous audit history is refused:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-024: evidence-package export requires admin or owner', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const full = await fetch(`${base_}/api/ledger/export?kind=evidence-package`, { headers: owner.headers });
    eq(full.status, 200, 'owners can pull the evidence package:');
    const member = await formSession(server.port, 'member@acme.test', 'a-members-password');
    const snap = await fetch(`${base_}/api/ledger/export?kind=snapshot`, { headers: member.headers });
    eq(snap.status, 200, 'members can pull the snapshot:');
    const denied = await fetch(`${base_}/api/ledger/export?kind=evidence-package`, { headers: member.headers });
    eq(denied.status, 403, 'members cannot pull the full evidence package:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-025: team page shows the effective governance policy with sources and impact', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const team = await (await fetch(`http://127.0.0.1:${server.port}/team`, { headers: session.headers })).text();
    eq(team.includes('Governance policy'), true);
    eq(team.includes('approver-role'), true);
    eq(team.includes('<code>member</code>'), true, 'default approver role is shown:');
    eq(team.includes('startup'), true, 'startup-only settings name their source:');
    eq(team.includes('does not change:'), true, 'impact states what a setting does not change:');
    eq(team.includes('kill-switch'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-014: request detail shows deliverable preview and final approval binds to version', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  const artDir = join(tmpdir(), `vital-flow014-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  process.env.ARTIFACT_DIR = artDir;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const version = await persistDeliverableVersion(db, ledger, {
      tenant: TEN,
      requestId: 'r1',
      deliverableSchema: 'launch-pack.v1',
      content: `- Launch copy cites release [claim:${rel.id}]`,
      claimIds: [rel.id],
      createdBy: 'agent:marketing',
      now: NOW,
      artifactDir: artDir,
    });
    const session = await ownerSession(server.port);
    const detail = await (
      await fetch(`http://127.0.0.1:${server.port}/console/requests/r1`, { headers: session.headers })
    ).text();
    eq(detail.includes('Deliverable preview'), true);
    eq(detail.includes('Launch copy cites release'), true);
    eq(detail.includes('Finding'), true);
    eq(detail.includes('Approve deliverable'), true);
    const approved = await fetch(
      `http://127.0.0.1:${server.port}/api/deliverables/${encodeURIComponent(version.id)}/approve`,
      {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: version.fingerprint }),
      },
    );
    eq(approved.status, 200);
    const body = (await approved.json()) as { decisionId: string };
    const receipt = await (
      await fetch(`http://127.0.0.1:${server.port}/console/decisions/${encodeURIComponent(body.decisionId)}`, {
        headers: session.headers,
      })
    ).text();
    eq(receipt.includes('final-deliverable'), true);
    const download = await fetch(
      `http://127.0.0.1:${server.port}/api/deliverables/${encodeURIComponent(version.id)}/artifact`,
      {
        headers: session.headers,
      },
    );
    eq(download.status, 200);
    eq((await download.text()).includes('Launch copy cites release'), true);
  } finally {
    delete process.env.ARTIFACT_DIR;
    await server.close();
    await db.close();
  }
});

T('F23: authenticated learning review administration and streaming export API', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const urlBase = `http://127.0.0.1`;

  // 1. Seed an unlabeled routing decision
  await db
    .prepare(
      `INSERT INTO routing_decisions (tenant, task_type, scope, action_class, proposed, executed, policy_baseline, shadow, guards, importance, labeled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(TEN, 'task_x', 'engineering', 'READ', 'CACHE', 'CACHE', 'CACHE', 0, '[]', 0.5, 0, NOW);

  const decRow = (await db.prepare('SELECT id FROM routing_decisions WHERE tenant = ? AND labeled = 0').get(TEN)) as {
    id: number;
  };

  // 2. Compile a card
  await seedTrace(comp, db, 'tr_api', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['tr_api']));

  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
  });

  try {
    const port = server.port;

    // Unauthenticated requests fail closed
    const unauthQueue = await fetch(`${urlBase}:${port}/api/learning/labeling-queue`);
    eq(unauthQueue.status, 401);

    const session = await ownerSession(port);

    // Authenticated GET labeling-queue
    const qRes = await fetch(`${urlBase}:${port}/api/learning/labeling-queue`, {
      headers: session.headers,
    });
    eq(qRes.status, 200);
    const qBody = (await qRes.json()) as { ok: boolean; queue: { id: number }[] };
    eq(qBody.ok, true);
    eq(qBody.queue.length >= 1, true);
    eq(
      qBody.queue.some((item) => item.id === decRow.id),
      true,
    );

    // POST label without CSRF fails
    const noCsrfLabel = await fetch(`${urlBase}:${port}/api/learning/label`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: decRow.id, correctTier: 'MODEL' }),
    });
    eq(noCsrfLabel.status, 403);

    // POST label with session & CSRF succeeds
    const labelRes = await fetch(`${urlBase}:${port}/api/learning/label`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: decRow.id, correctTier: 'MODEL' }),
    });
    eq(labelRes.status, 200);
    const labelBody = (await labelRes.json()) as {
      ok: boolean;
      decisionId: number;
      correctTier: string;
      reviewer: string;
    };
    eq(labelBody.ok, true);
    eq(labelBody.decisionId, decRow.id);
    eq(labelBody.correctTier, 'MODEL');
    eq(labelBody.reviewer.length > 0, true);

    // Decision is now labeled in DB
    const labeledCheck = (await db
      .prepare('SELECT labeled, correct_tier FROM routing_decisions WHERE id = ?')
      .get(decRow.id)) as { labeled: number; correct_tier: string };
    eq(labeledCheck.labeled, 1);
    eq(labeledCheck.correct_tier, 'MODEL');

    // GET cards
    const cardsRes = await fetch(`${urlBase}:${port}/api/learning/cards`, {
      headers: session.headers,
    });
    eq(cardsRes.status, 200);
    const cardsBody = (await cardsRes.json()) as { ok: boolean; cards: { id: string }[] };
    eq(cardsBody.ok, true);
    eq(
      cardsBody.cards.some((c) => c.id === card.id),
      true,
    );

    // GET card detail with revisions
    const cardDetailRes = await fetch(`${urlBase}:${port}/api/learning/cards/${encodeURIComponent(card.id)}`, {
      headers: session.headers,
    });
    eq(cardDetailRes.status, 200);
    const detailBody = (await cardDetailRes.json()) as {
      ok: boolean;
      card: { id: string };
      revisions: { version: number; action: string }[];
    };
    eq(detailBody.ok, true);
    eq(detailBody.card.id, card.id);
    eq(detailBody.revisions.length >= 1, true);

    // POST advance card
    const advRes = await fetch(`${urlBase}:${port}/api/learning/cards/${encodeURIComponent(card.id)}/advance`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'QUARANTINE' }),
    });
    eq(advRes.status, 200);
    const advBody = (await advRes.json()) as { ok: boolean; card: { state: string; version: number } };
    eq(advBody.ok, true);
    eq(advBody.card.state, 'QUARANTINE');
    eq(advBody.card.version, 2);

    // GET streaming export
    const streamExportRes = await fetch(`${urlBase}:${port}/api/ledger/export?stream=true&kind=snapshot`, {
      headers: session.headers,
    });
    eq(streamExportRes.status, 200);
    eq(streamExportRes.headers.get('transfer-encoding'), 'chunked');
    const streamBody = (await streamExportRes.json()) as {
      ok: boolean;
      export: { tenant: string; claims: unknown[] };
      manifest: { kind: string; counts: { claims: number } };
    };
    eq(streamBody.ok, true);
    eq(streamBody.export.tenant, TEN);
    eq(streamBody.manifest.kind, 'snapshot');
    eq(streamBody.manifest.counts.claims >= 1, true);
  } finally {
    await server.close();
    await db.close();
  }
});
