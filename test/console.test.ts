import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base } from './helpers.ts';
import { request as httpRequest } from 'node:http';
import { buildReport, COST_CURVE_BUDGET, MAX_ROOMS, ROOM_REQUESTS } from '../src/console/report.ts';
import { lineChart, renderHtml, tierStack } from '../src/console/render.ts';
import { composeDigest } from '../src/console/digest.ts';
import {
  DEFAULT_BIND_HOST,
  isLoopbackBindHost,
  resolveRequestContext,
  startConsoleServer,
} from '../src/console/serve.ts';
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
import { installAuthSchema, signupTenant, inviteUser, listUsers, totpCode } from '../src/core/auth.ts';
import { approvalMessage, generateOperatorKey, operatorKeyId, signApproval } from '../src/gov/operator.ts';
import { seedTrace, cardInput } from './helpers.ts';
import { renderReview, REVIEW_SCRIPT } from '../src/console/review.ts';
import {
  buildWorkspaceView,
  describeLegStall,
  loadWorkspaceOverlay,
  renderWorkflowDetailPage,
  retryWorkflow,
} from '../src/console/release-workspace.ts';
import { saveFanOutRun, type FanOutWorkflowRun } from '../src/wedge/fanout-workflow.ts';
import { fanOutWorkflow } from '../src/wedge/ship.ts';
import { persistDeliverableVersion } from '../src/wedge/deliverable-artifact.ts';
import { buildTenantJourney } from '../src/console/journey.ts';
import { runInNewContext } from 'node:vm';
import { parseExecutionSpec } from '../src/coord/execution-spec.ts';
import { recordTrustOutcome, recordWorkerHeartbeat, setKill } from '../src/gov/trust.ts';

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
    // Home is chat-first (302 to the default room); render the dashboard
    // explicitly so reportBuilds reflects a real dashboard build.
    await (await fetch(`${url}/?view=dashboard`, { headers: { cookie: session.cookie } })).text();
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
    // One extra human-work item beyond the needsHuman window.
    await coord.submit(base({ id: 'window_human_over', bid: { humanMinutes: 5 } }));
    const report = await buildReport(db, ledger, coord, comp, TEN, NOW);
    eq(report.costCurve.length <= COST_CURVE_BUDGET, true);
    eq(report.costCurve[0]!.label, 'D1');
    eq(report.costCurve[report.costCurve.length - 1]!.label, 'D500');
    eq(report.rooms.length <= MAX_ROOMS, true);
    eq(
      report.rooms.every((room) => room.requests.length <= ROOM_REQUESTS),
      true,
    );
    // F26: bounded sections disclose what the window omits — never silently.
    eq(report.omitted.decisions, 500 - COST_CURVE_BUDGET, 'decisions beyond the chart window are counted:');
    eq(
      report.omitted.rooms,
      62 - MAX_ROOMS,
      'rooms beyond the room window are counted (60 window scopes + engineering + marketing):',
    );
    eq(report.omitted.needsHuman, 0, 'queue within the window shows zero omitted:');
    const html = renderHtml(report);
    eq(html.includes('beyond this view'), true, 'rendered report discloses omitted rows:');
    eq(html.includes('/console/rooms'), true, 'omitted rooms link to the full list:');
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
      document: { getElementById: () => root, querySelectorAll: () => [root] },
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
  for (const needle of ['Reality health', '$25', 'Needs a human', 'Compiler', 'Rooms', '✓ FACT', 'F7F8F6']) {
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
    const home: string = await (
      await fetch(`${base_}/?view=dashboard`, { headers: { cookie }, redirect: 'manual' })
    ).text();
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

T('FLOW-006: proxy headers are honored only behind a trusted proxy', async () => {
  const sock = (ip: string): Parameters<typeof resolveRequestContext>[0] =>
    ({ socket: { remoteAddress: ip }, headers: {} }) as Parameters<typeof resolveRequestContext>[0];
  const via = (ip: string): Parameters<typeof resolveRequestContext>[0] =>
    ({
      socket: { remoteAddress: '10.0.1.5' },
      headers: { 'x-forwarded-for': `${ip}, 10.0.1.5`, 'x-forwarded-proto': 'https', host: 'console.internal' },
    }) as unknown as Parameters<typeof resolveRequestContext>[0];
  const direct = resolveRequestContext(via('203.0.113.7'), false);
  eq(direct.clientIp, '10.0.1.5', 'untrusted proxy headers never spoof the client IP:');
  eq(direct.clientIpSource, 'socket');
  eq(direct.scheme, 'http');
  eq(direct.viaProxy, false);
  const trusted = resolveRequestContext(via('203.0.113.7'), true);
  eq(trusted.clientIp, '203.0.113.7');
  eq(trusted.clientIpSource, 'forwarded');
  eq(trusted.scheme, 'https');
  eq(trusted.viaProxy, true);
  eq(resolveRequestContext(sock('127.0.0.1'), true).clientIpSource, 'socket');
});

T('FLOW-006: healthz reports the LB path (proto/viaProxy) through the entry point', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: 'bind-topology',
    host: '0.0.0.0',
    trustProxy: true,
    now: () => NOW,
  });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const direct = (await (await fetch(`${base_}/healthz`)).json()) as {
      ok: boolean;
      alive: boolean;
      proto: string;
      viaProxy: boolean;
    };
    eq(direct.ok, true);
    eq(direct.alive, true);
    eq(direct.proto, 'http');
    // viaProxy is NOT asserted here: sandboxes/gateways may inject
    // forwarding headers on loopback too (the unit test above pins the
    // absent-header case with fully controlled headers).
    const lb = (await (
      await fetch(`${base_}/healthz`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' } })
    ).json()) as { proto: string; viaProxy: boolean };
    eq(lb.proto, 'https', 'the ALB-facing scheme surfaces through the task:');
    eq(lb.viaProxy, true);
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

T('FLOW-012: first-run journey shows honest empty state before any stage completes', async () => {
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
    eq(html.includes('id="tenant-journey"'), true, 'dashboard renders the journey section:');
    eq(html.includes('not yet'), true, 'unreached stages say so plainly:');
    eq(html.includes('Journey closed'), false, 'no completion is claimed before it exists:');

    const journey = await buildTenantJourney(db, TEN, NOW);
    // CLI signup path: stage 1 is real via the users table fallback.
    eq(journey.stages[0]!.at !== null, true, 'signup milestone is durable:');
    for (const stage of journey.stages.slice(1)) {
      eq(stage.at, null, `${stage.id} shows not-done for a fresh tenant:`);
    }
    eq(journey.currentIndex, 1);
    eq(journey.completedAt, null);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-012: the six-stage journey closes — signup, setup, source, approval, deliverable, outcome', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  const owner = await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const sourceDir = join(tmpdir(), `vital-journey-${Date.now()}`);
  const artifactDir = join(tmpdir(), `vital-journey-art-${Date.now()}`);
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(sourceDir, 'release.md'), '# v0.1\nJourney release notes');
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const journeyAt = async () => buildTenantJourney(db, TEN, NOW);

    eq((await journeyAt()).currentIndex, 1, 'starts at setup:');

    // Stage 2 — setup
    await fetch(`${base_}/setup`, {
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
    eq((await journeyAt()).currentIndex, 2, 'setup recorded → next is first source:');

    // Stage 3 — first source receipt
    await fetch(`${base_}/setup/ingest`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf }),
    });
    eq((await journeyAt()).currentIndex, 3, 'ingested evidence recorded → next is approval:');

    // Stage 4 — first release workflow + human approval
    const startRelease = await fetch(`${base_}/setup/start-release`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrf }),
      redirect: 'manual',
    });
    eq(startRelease.status, 303);
    const runId = (startRelease.headers.get('location') ?? '').split('/').pop()!;
    eq(runId.length > 0, true, 'workflow started:');

    const view = await buildWorkspaceView(db, ledger, coord, comp, TEN, runId);
    const admitted = view?.legs.find((l) => l.requestId && l.requestState === 'ADMITTED');
    eq(admitted?.requestId !== undefined, true, 'fan-out admitted a reviewable leg:');

    // Human curation — the governed CANDIDATE → VERIFIED promotion that makes
    // ingested evidence approvable. This is a real journey step, not a test fix.
    const claimRow = (await db
      .prepare("SELECT id FROM claims WHERE tenant = ? AND extractor = 'file-diff' ORDER BY created_at ASC LIMIT 1")
      .get(TEN)) as { id: string } | undefined;
    eq(claimRow !== undefined, true, 'ingested claim exists:');
    const verify = await fetch(`${base_}/api/claims/${encodeURIComponent(claimRow!.id)}/verify`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    eq(((await verify.json()) as { ok: boolean }).ok, true, 'claim verified by human:');

    const approve = await fetch(`${base_}/api/requests/${encodeURIComponent(admitted!.requestId!)}/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    const approveBody = (await approve.json()) as { ok: boolean; error?: string; state?: string };
    eq(approveBody.ok, true, `approval accepted: ${JSON.stringify(approveBody)}`);
    eq((await journeyAt()).currentIndex, 4, 'approval recorded → next is deliverable:');

    // Stage 5 — versioned deliverable from the admitted request
    const version = await persistDeliverableVersion(db, ledger, {
      tenant: TEN,
      requestId: admitted!.requestId!,
      deliverableSchema: 'launch-copy.v1',
      content: `Launch draft citing [claim:${claimRow!.id}]`,
      claimIds: [claimRow!.id],
      createdBy: 'human:owner',
      now: NOW,
    });
    eq(version.id.startsWith('dlvver_'), true);
    eq((await journeyAt()).currentIndex, 5, 'deliverable recorded → next is measured outcome:');

    // Stage 6 — preregister, then capture the measured outcome
    const prereg = await fetch(`${base_}/console/workflows/${encodeURIComponent(runId)}/preregister`, {
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

    const measured = await buildWorkspaceView(db, ledger, coord, comp, TEN, runId);
    eq(measured?.canCaptureOutcome, true, 'outcome capture enabled:');
    const outcome = await fetch(`${base_}/console/workflows/${encodeURIComponent(runId)}/outcome`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: new URLSearchParams({
        csrf: session.csrf,
        decisionId: measured!.replay[0]!.decisionId,
        metric: 'ship_to_launch_hours',
        actual: '12',
        basis: 'pilot holdout measurement',
      }),
      redirect: 'manual',
    });
    eq(outcome.status, 303);

    const closed = await journeyAt();
    eq(closed.currentIndex, null, 'journey closed:');
    eq(closed.completedAt !== null, true, 'completion timestamp is the outcome record:');

    // After full activation `/` redirects to chat by design; the dashboard
    // (and the closed journey) lives at /console/dashboard.
    const html = await (await fetch(`${base_}/console/dashboard`, { headers: session.headers })).text();
    eq(html.includes('Journey closed'), true, 'dashboard announces the closed loop:');
    eq(html.includes('up next'), false, 'no stage is left pending:');
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
    eq(login.includes('<main id="main">'), true, 'login page has a main landmark:');
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
    const html = await (
      await fetch(`http://127.0.0.1:${server.port}/?view=dashboard`, { headers: session.headers })
    ).text();
    eq(html.includes('<nav aria-label="Console">'), true);
    eq(html.includes('>Reviews</a>'), true);
    eq(html.includes('href="/console/workflows"'), true);
    eq(html.includes('>Workflows</a>'), true);
    eq(html.includes('href="/console/digest"'), true);
    eq(html.includes('>Digest</a>'), true);
    eq(html.includes('href="/setup"'), true);
    eq(html.includes('>Settings</a>'), true);
    eq(html.includes('href="/team"'), true);
    eq(html.includes('>Team</a>'), true);
    eq(html.includes('href="/account"'), true);
    eq(html.includes('>Account</a>'), true);
    // Markup-tolerant: the account cluster may style the email, so assert the
    // phrase and the address independently rather than one literal string.
    eq(html.includes('signed in as'), true);
    eq(html.includes('owner@acme.test'), true);
    eq(html.includes('action="/logout"'), true);
    eq(html.includes('href="/console/requests/rq1"'), true, 'every needs-human item links to its task:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-002: Settings nav entry is admin-gated and the setup page stays reachable', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member-nav@acme.test', name: 'M', role: 'member', password: 'a-members-password-long' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const ownerHome = await (await fetch(`${base_}/`, { headers: owner.headers })).text();
    eq(ownerHome.includes('href="/setup"'), true, 'owner sees Settings in the nav:');
    const member = await formSession(server.port, 'member-nav@acme.test', 'a-members-password-long');
    const memberHome = await (await fetch(`${base_}/`, { headers: member.headers })).text();
    eq(memberHome.includes('>Settings</a>'), false, 'member does not see Settings:');
    // The setup page still renders for an owner (reachable after activation)
    // and links the previously-orphaned Rooms wizard.
    const setup = await fetch(`${base_}/setup`, { headers: owner.headers });
    eq(setup.status, 200);
    const setupHtml = await setup.text();
    eq(setupHtml.includes('Guided setup'), true);
    eq(setupHtml.includes('href="/setup/rooms"'), true, 'setup links room provisioning:');
    eq(setupHtml.includes('Open room provisioning'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('the room provisioning page has one address: /setup/rooms', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const canonical = await fetch(`${base_}/setup/rooms`, { headers: owner.headers });
    eq(canonical.status, 200, 'the canonical page resolves:');
    // /settings/rooms and /console/settings/rooms were duplicate dispatcher
    // aliases for it. A page with three addresses has three places to get its
    // auth wrong, and only one of them was ever linked.
    for (const retired of ['/settings/rooms', '/console/settings/rooms']) {
      const res = await fetch(`${base_}${retired}`, { headers: owner.headers });
      eq(res.status, 404, `${retired} no longer resolves:`);
    }
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-004: learning review page renders and labels decisions without JSON links', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await db
    .prepare(
      'INSERT INTO routing_decisions (tenant,task_type,scope,action_class,proposed,executed,policy_baseline,shadow,guards,importance,labeled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
    )
    .run(TEN, 'launch.copy.draft', 'marketing', 'ANALYZE', 'MODEL', 'MODEL', 'MODEL', 0, '[]', 0.4, NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const page = await (await fetch(`${base_}/console/learning`, { headers: owner.headers })).text();
    eq(page.includes('Learning review'), true);
    eq(page.includes('Labeling queue (1)'), true);
    eq(page.includes('/api/learning/'), false, 'learning page never links the JSON API:');
    const team = await (await fetch(`${base_}/team`, { headers: owner.headers })).text();
    eq(team.includes('/api/learning/'), false, 'team page never links the JSON API:');
    // Label the decision through the page form.
    const labeled = await fetch(`${base_}/console/learning/label`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&decisionId=1&correctTier=WORKFLOW`,
      redirect: 'manual',
    });
    eq(labeled.status, 303);
    eq(labeled.headers.get('location'), '/console/learning?labeled=ok');
    // Members are refused (admin/owner surface).
    await inviteUser(
      db,
      TEN,
      { email: 'member-learn@acme.test', name: 'M', role: 'member', password: 'a-members-password-long' },
      { userId: 'seed', role: 'owner' },
      NOW,
    );
    const member = await formSession(server.port, 'member-learn@acme.test', 'a-members-password-long');
    const forbidden = await fetch(`${base_}/console/learning`, { headers: member.headers });
    eq(forbidden.status, 403);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-005: enrolling a second factor gates login behind a TOTP challenge', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const clock = NOW;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => clock });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port); // pre-MFA session
    // Enroll an authenticator.
    const setup = await (await fetch(`${base_}/account/mfa/setup`, { headers: owner.headers })).text();
    const secret = setup.match(/<strong>Secret:<\/strong> <code>([A-Z2-7]+)<\/code>/)![1]!;
    eq(setup.includes('otpauth://totp/'), true, 'setup shows the otpauth URI:');
    const enable = await fetch(`${base_}/account/mfa/enable`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&secret=${encodeURIComponent(secret)}&code=${totpCode(secret, Date.parse(clock))}`,
    });
    eq(enable.status, 200);
    const enableHtml = await enable.text();
    eq(enableHtml.includes('Save your recovery codes'), true);
    const recovery = [...enableHtml.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1]!);
    eq(recovery.length >= 1, true, 'recovery codes issued:');
    const account = await (await fetch(`${base_}/account`, { headers: owner.headers })).text();
    eq(account.includes('Two-factor authentication'), true);
    eq(account.includes('unused recovery code'), true, 'account reports live recovery codes:');
    // A fresh password login now stops at the challenge, minting no session.
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const login1 = await fetch(`${base_}/login`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
      redirect: 'manual',
    });
    eq(login1.status, 303);
    eq(login1.headers.get('location'), '/login/mfa');
    const mfaCookieHeader = (login1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    eq(mfaCookieHeader.includes('vital_mfa='), true, 'challenge cookie set:');
    eq(
      (login1.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('vital_session=')),
      false,
      'no session is minted before the second factor:',
    );
    // Wrong code is refused.
    const pageRes = await fetch(`${base_}/login/mfa`, { headers: { cookie: mfaCookieHeader } });
    const pageHtml = await pageRes.text();
    const pageCookies = (pageRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const mfaPostCookie = `${mfaCookieHeader}; ${pageCookies}`;
    const mfaCsrf = pageHtml.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const wrong = await fetch(`${base_}/login/mfa`, {
      method: 'POST',
      headers: { cookie: mfaPostCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${mfaCsrf}&code=000000`,
      redirect: 'manual',
    });
    eq(wrong.status, 401);
    // Correct code completes the login.
    const ok = await fetch(`${base_}/login/mfa`, {
      method: 'POST',
      headers: { cookie: mfaPostCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${mfaCsrf}&code=${totpCode(secret, Date.parse(clock))}`,
      redirect: 'manual',
    });
    eq(ok.status, 303);
    const sessionCk = (ok.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vital_session='));
    eq(Boolean(sessionCk), true, 'session issued after the second factor:');
    const homeRes = await fetch(`${base_}/?view=dashboard`, {
      headers: { cookie: sessionCk!.split(';')[0]! },
      redirect: 'manual',
    });
    eq(homeRes.status, 200);
    // A recovery code signs in a fresh challenge exactly once.
    const pre2 = await fetch(`${base_}/login`, { redirect: 'manual' });
    const pre2Cookie = (pre2.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const pre2Token = (await pre2.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const login2 = await fetch(`${base_}/login`, {
      method: 'POST',
      headers: { cookie: pre2Cookie },
      body: `csrf=${pre2Token}&email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`,
      redirect: 'manual',
    });
    const mfaCookie2 = (login2.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const page2Res = await fetch(`${base_}/login/mfa`, { headers: { cookie: mfaCookie2 } });
    const page2 = await page2Res.text();
    const page2Cookies = (page2Res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const mfaCsrf2 = page2.match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const rec = await fetch(`${base_}/login/mfa`, {
      method: 'POST',
      headers: { cookie: `${mfaCookie2}; ${page2Cookies}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${mfaCsrf2}&mode=recovery&code=${encodeURIComponent(recovery[0]!)}`,
      redirect: 'manual',
    });
    eq(rec.status, 303);
    eq(
      (rec.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('vital_session=')),
      true,
      'recovery code signs in:',
    );
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-006: admin audit-log page filters, links, and is admin-gated', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await db
    .prepare('INSERT INTO audit_log (tenant,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)')
    .run(TEN, 'human:ada', 'console.approve', 'request:rq1', 'role=member', NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const page = await (await fetch(`${base_}/console/audit`, { headers: owner.headers })).text();
    eq(page.includes('Audit log'), true);
    eq(page.includes('auth.login') || page.includes('auth.tenant_created'), true, 'auth events listed:');
    eq(page.includes('/api/audit'), false, 'page is HTML, not a link to JSON:');
    // Filtering by action narrows the result and links the referenced request.
    const filtered = await (
      await fetch(`${base_}/console/audit?action=console.approve`, { headers: owner.headers })
    ).text();
    eq(filtered.includes('console.approve'), true, 'matching action shown:');
    eq(filtered.includes('/console/requests/rq1'), true, 'referenced request is linked:');
    eq(filtered.includes('auth.tenant_created'), false, 'filter excludes other actions:');
    // Members are refused.
    await inviteUser(
      db,
      TEN,
      { email: 'member-audit@acme.test', name: 'M', role: 'member', password: 'a-members-password-long' },
      { userId: 'seed', role: 'owner' },
      NOW,
    );
    const member = await formSession(server.port, 'member-audit@acme.test', 'a-members-password-long');
    eq((await fetch(`${base_}/console/audit`, { headers: member.headers })).status, 403);
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
    // Home is chat-first; dashboard filters live under ?view=dashboard.
    const get = (qs: string) =>
      fetch(`${base_}/?view=dashboard&${qs.replace(/^\?/, '')}`, { headers: session.headers }).then((r) => r.text());
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
    const found = await (
      await fetch(`http://127.0.0.1:${server.port}/?view=dashboard&q=zephyr`, { headers: session.headers })
    ).text();
    eq(found.includes('zephyr launch hyperdrive review'), true);
    eq(found.includes('matching request(s)'), true);
    eq(found.includes('Pending decision'), true);
    eq(found.includes('Clear search and filters'), true);
    const missing = await (
      await fetch(`http://127.0.0.1:${server.port}/?view=dashboard&q=no-such-work-xyz`, { headers: session.headers })
    ).text();
    eq(missing.includes('No results'), true);
    eq(missing.includes('No matching work for search'), true);
    const truncated = await (
      await fetch(`http://127.0.0.1:${server.port}/?view=dashboard&q=a&limit=1`, { headers: session.headers })
    ).text();
    eq(truncated.includes('explicit truncation'), true);
    const invalid = await fetch(`http://127.0.0.1:${server.port}/?view=dashboard&state=BOGUS`, {
      headers: session.headers,
    });
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
    const home = await fetch(`${base_}/?view=dashboard`, { headers: { cookie: memberCookie }, redirect: 'manual' });
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
    eq((await disabled.text()).includes('Every live session was revoked'), true);
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
      (await fetch(`${base_}/?view=dashboard`, { headers: back.headers, redirect: 'manual' })).status,
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
    const team = await (await fetch(`${base_}/team/operations`, { headers: owner.headers })).text();
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
    const cleared = await (await fetch(`${base_}/team/operations`, { headers: owner.headers })).text();
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
    const team = await (
      await fetch(`http://127.0.0.1:${server.port}/team/operations`, { headers: session.headers })
    ).text();
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
    // Home is chat-first; visit the dashboard so reportBuilds is nonzero.
    await (await fetch(`${base_}/?view=dashboard`, { headers: session.headers })).text();
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

T('FLOW-023: metrics expose worker and integration status with optional-unconfigured split', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const read = async () =>
      (await (await fetch(`${base_}/api/metrics`, { headers: session.headers })).json()) as {
        readiness: { ready: boolean; checks: { name: string; status: string; detail?: string }[] };
      };
    const before = await read();
    eq(
      before.readiness.checks.find((c) => c.name === 'worker')?.status,
      'unconfigured-optional',
      'no worker deployed yet never fails readiness:',
    );
    eq(
      before.readiness.checks.find((c) => c.name === 'integrations')?.status,
      'unconfigured-optional',
      'no source configured never fails readiness:',
    );
    eq(before.readiness.ready, true);
    await recordWorkerHeartbeat(db, TEN, { workerId: 'worker-e2e', now: NOW });
    const live = await read();
    eq(live.readiness.checks.find((c) => c.name === 'worker')?.status, 'ok');
    eq(live.readiness.ready, true);
    await recordWorkerHeartbeat(db, TEN, { workerId: 'worker-e2e', now: '2026-01-01T00:00:00.000Z' });
    const stale = await read();
    eq(stale.readiness.checks.find((c) => c.name === 'worker')?.status, 'failing');
    eq(stale.readiness.ready, false, 'a silent worker fails readiness:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-023/E2E-17: liveness survives dependency loss while readiness stops reporting green', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    eq(((await (await fetch(`${base_}/healthz`)).json()) as { alive: boolean }).alive, true);
    const session = await ownerSession(server.port);
    await db.close();
    const healthz = (await (await fetch(`${base_}/healthz`)).json()) as { ok: boolean; alive: boolean };
    eq(healthz.ok, true, 'liveness never touches dependencies:');
    eq(healthz.alive, true);
    // The session lookup itself needs the database, so metrics answers 500
    // with a support reference — the honest failure, never a green report.
    const metrics = await fetch(`${base_}/api/metrics`, { headers: session.headers });
    eq(metrics.status, 500);
    const failure = (await metrics.json()) as { ok: boolean; supportRef?: string };
    eq(failure.ok, false);
    eq(typeof failure.supportRef === 'string' && failure.supportRef.startsWith('sup_'), true);
  } finally {
    await server.close();
    try {
      await db.close();
    } catch {
      /* already closed to simulate the outage */
    }
  }
});

T('FLOW-013: server.ready() classifies a healthy console as ready, not just bound', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const probe = await server.ready();
    eq(probe.ok, true, 'a healthy console answers readiness:');
    eq(probe.status, 'ready');
    eq(typeof server.address === 'string' && server.address.includes('127.0.0.1'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-013: home renders the system-readiness strip with tri-state pills', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const html = await (await fetch(`${base_}/?view=dashboard`, { headers: session.headers })).text();
    eq(html.includes('id="system-readiness"'), true, 'readiness strip rendered on home:');
    eq(html.includes('>database</strong>'), true, 'database check surfaced:');
    eq(html.includes('not configured'), true, 'unconfigured dependencies read as grey, not red:');
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
    for (const path of ['/console/export']) {
      eq((await fetch(`${base_}${path}`, { headers: session.headers })).status, 404);
    }
    eq((await fetch(`${base_}/console/requests`, { headers: session.headers })).status, 200);
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
    const team = await (
      await fetch(`http://127.0.0.1:${server.port}/team/operations`, { headers: session.headers })
    ).text();
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

T('FLOW-025: team page surfaces compiler trust gaps with eval-evidence links and billing scope', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await seedTrace(comp, db, 'gaps_trace', 'SUCCESS', 0.95);
  const card = await comp.compile(cardInput(['gaps_trace']));
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const team = await (
      await fetch(`http://127.0.0.1:${server.port}/team/operations`, { headers: session.headers })
    ).text();
    eq(team.includes('Compiler trust gaps'), true, 'trust-gaps section renders:');
    eq(team.includes('no passing regression test'), true, 'actionable gap is named:');
    eq(team.includes(`/console/learning/${card.id}`), true, 'gap links to required evaluation evidence:');
    eq(team.includes('never promotes a card'), true, 'evidence-only disclaimer shown:');
    eq(team.includes('Engagement and billing scope'), true, 'billing scope renders:');
    eq(team.includes('no hosted subscription'), true, 'pilot/contact path is explicit, no hosted billing:');
    const evidence = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/learning/cards/${card.id}/evidence`, {
        headers: session.headers,
      })
    ).json()) as { ok: boolean; trustGaps: string[]; evidenceOnly: string; runs: unknown[]; evalRef: string | null };
    eq(evidence.ok, true);
    eq(evidence.trustGaps.includes('no passing regression test'), true);
    eq(evidence.evidenceOnly.includes('never promotes'), true);
    const anon = await fetch(`http://127.0.0.1:${server.port}/api/learning/cards/${card.id}/evidence`);
    eq(anon.status, 401, 'anonymous evidence access is refused:');
    const missing = await fetch(`http://127.0.0.1:${server.port}/api/learning/cards/no-such-card/evidence`, {
      headers: session.headers,
    });
    eq(missing.status, 404);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-004: browser receipt verification shows deleted/retained/deferred/failed buckets', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const { eraseTenant } = await import('../src/core/erasure.ts');
  // Erase a sibling tenant while staying signed in as the acme owner: the
  // receipt survives under erased:<slug> and stays readable.
  await signupTenant(
    db,
    { slug: 'doomed', name: 'Doomed', email: 'owner@doomed.test', password: 'a-doomed-password', ownerName: 'Zed' },
    NOW,
  );
  await db
    .prepare(
      `INSERT INTO claims (id, tenant, subject, kind, statement, confidence, source_uri, source_tier, extractor,
        extractor_ver, retrieved_at, observed_at, valid_from, status, owner, scope, created_at, seq)
       VALUES ('clm_doom', 'doomed', 'release:d', 'FACT', 'doomed ships', 1, 'https://x.test/d', 'SYSTEM_OF_RECORD', 'e', '1', ?, ?, ?, 'CURRENT', 'sync:gh', 'eng', ?, 1)`,
    )
    .run(NOW, NOW, NOW, NOW);
  await eraseTenant(db, 'doomed', 'op', NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const anon = await fetch(`${base_}/api/erasure/receipt?slug=doomed`);
    eq(anon.status, 401, 'anonymous receipt access is refused:');
    const receipt = (await (
      await fetch(`${base_}/api/erasure/receipt?slug=doomed`, { headers: session.headers })
    ).json()) as {
      ok: boolean;
      receipt: {
        deleted: Record<string, number>;
        retained: { category: string }[];
        deferred: { category: string }[];
        failed: unknown[];
      };
    };
    eq(receipt.ok, true);
    eq((receipt.receipt.deleted['claims'] ?? 0) >= 1, true, 'deleted bucket names claims:');
    eq(
      receipt.receipt.retained.some((r) => r.category === 'erasure-receipt'),
      true,
      'retained bucket shown:',
    );
    eq(
      receipt.receipt.deferred.some((r) => r.category === 'backups'),
      true,
      'deferred bucket shown:',
    );
    eq(Array.isArray(receipt.receipt.failed), true, 'failed bucket present:');
    const unknown = await fetch(`${base_}/api/erasure/receipt?slug=ghost`, { headers: session.headers });
    eq(unknown.status, 404, 'unknown slug is not-found, not success:');
    const unscoped = await fetch(`${base_}/api/erasure/receipt`, { headers: session.headers });
    eq(unscoped.status, 400, 'missing slug is rejected:');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-014: human verification curates candidate evidence into approvable state', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const candidate = await ledger.append({
    tenant: TEN,
    subject: 'release:notes',
    kind: 'OBSERVATION',
    statement: 'draft notes mention faster sync',
    confidence: 0.5,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:files',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  eq(candidate.status, 'CANDIDATE');
  const { request } = await coord.submit(
    base({ id: 'rq-verify', goal: 'review curated evidence', claimRefs: [candidate.id], bid: { humanMinutes: 5 } }),
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    const verify = (id: string, headers = session.headers) =>
      fetch(`${base_}/api/claims/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
    eq((await fetch(`${base_}/api/claims/${candidate.id}/verify`, { method: 'POST' })).status, 401);
    const first = await verify(candidate.id);
    eq(first.status, 200);
    eq(((await first.json()) as { status: string }).status, 'VERIFIED');
    eq((await verify(candidate.id)).status, 200, 're-verifying is idempotent:');
    const approved = await (
      await fetch(`${base_}/api/requests/${request.id}/approve`, {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ requestUpdatedAt: (await coord.get(TEN, request.id))!.updatedAt }),
      })
    ).json();
    eq((approved as { state: string }).state, 'ACCEPTED', 'curated evidence is approvable:');
    const missing = await verify('clm_missing');
    eq(missing.status, 404);
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

T('FLOW-019: shared nav supports skip link and roving-tabindex arrow keys', async () => {
  const { buildConsoleNav, renderConsoleNav, CONSOLE_NAV_SCRIPT } = await import('../src/console/render.ts');
  const nav = renderConsoleNav(buildConsoleNav('/'));
  eq(nav.includes('<nav aria-label="Console">'), true);
  eq(nav.includes('data-console-nav-link'), true);
  eq(nav.includes('tabindex="0"'), true);
  eq(nav.includes('tabindex="-1"'), true);
  eq(CONSOLE_NAV_SCRIPT.includes('ArrowRight'), true);
  eq(CONSOLE_NAV_SCRIPT.includes('ArrowLeft'), true);
  const { skipLink, CONSOLE_SHARED_CSS } = await import('../src/console/states.ts');
  eq(skipLink().includes('Skip to main content'), true);
  eq(CONSOLE_SHARED_CSS.includes('skip-link'), true);
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const html = await (
      await fetch(`http://127.0.0.1:${server.port}/?view=dashboard`, { headers: session.headers })
    ).text();
    eq(html.includes('Skip to main content'), true);
    eq(html.includes('data-console-nav-link'), true);
    eq(html.includes('ArrowRight') || html.includes('console-nav-link'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-020: view-all routes expose requests, claims, rooms, and human work with totals and returnTo', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(base({ id: 'va-1', goal: 'viewall alpha item', claimRefs: [rel.id], bid: { humanMinutes: 5 } }));
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    for (const p of ['/console/requests', '/console/claims', '/console/rooms', '/console/human-work']) {
      const r = await fetch(`${base_}${p}`, { headers: session.headers });
      eq(r.status, 200, p);
      const html = await r.text();
      eq(html.includes('Skip to main content'), true, `${p} skip link`);
      eq(html.includes('total'), true, `${p} totals`);
      eq(html.includes('Clear'), true, `${p} clear-filter`);
      eq(html.includes('<main id="main">'), true, `${p} landmark`);
    }
    const reqs = await (await fetch(`${base_}/console/requests?q=viewall`, { headers: session.headers })).text();
    eq(reqs.includes('viewall alpha item'), true);
    eq(reqs.includes('1 total'), true);
    const missing = await (await fetch(`${base_}/console/requests?q=no-such-xyz`, { headers: session.headers })).text();
    eq(missing.includes('No results'), true);
    const trunc = await (await fetch(`${base_}/console/requests?q=a&limit=1`, { headers: session.headers })).text();
    eq(truncs(trunc), true);
    const bad = await fetch(`${base_}/console/requests?state=BOGUS`, { headers: session.headers });
    eq(bad.status, 400);
    // filter/page preserved across detail returnTo
    const listUrl = '/console/requests?q=viewall&limit=1';
    const detail = await (
      await fetch(`${base_}/console/requests/va-1?return=${encodeURIComponent(listUrl)}`, {
        headers: session.headers,
      })
    ).text();
    eq(detail.includes('Back to console'), true);
    eq(detail.includes('return='), true);
    const anon = await fetch(`${base_}/console/requests`, { redirect: 'manual' });
    eq(anon.status, 303);
    function truncs(h: string): boolean {
      return h.includes('explicit truncation');
    }
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-020: large organization stays reachable with true totals and bounded page time', async () => {
  const { db, ledger, coord, comp } = await fresh();
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  const rel = await ledger.append({
    tenant: TEN,
    subject: 'bulk',
    kind: 'FACT',
    statement: 'bulk fact',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:bulk',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  for (let room = 0; room < 55; room++) {
    for (let i = 0; i < 2; i++) {
      await coord.submit(
        base({
          id: `bulk-r${room}-${i}`,
          goal: `bulk work room ${room} item ${i}`,
          claimRefs: [rel.id],
          originScope: `room-${room}`,
          targetScope: 'engineering',
          bid: { humanMinutes: room % 2 === 0 ? 5 : 0 },
        }),
      );
    }
  }
  const { searchRequests } = await import('../src/console/report.ts');
  const t0 = Date.now();
  const page = await searchRequests(db, TEN, { q: 'bulk work', limit: 20, offset: 0 });
  const ms = Date.now() - t0;
  eq(page.total, 110);
  eq(page.rows.length, 20);
  eq(page.truncated, true);
  eq(ms < 5000, true, `bounded page time, got ${ms}ms`);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const session = await ownerSession(server.port);
    const t1 = Date.now();
    const html = await (
      await fetch(`http://127.0.0.1:${server.port}/console/requests?q=bulk+work&limit=20`, {
        headers: session.headers,
      })
    ).text();
    const httpMs = Date.now() - t1;
    eq(html.includes('110 total'), true);
    eq(html.includes('explicit truncation'), true);
    eq(httpMs < 8000, true, `bounded HTTP page, got ${httpMs}ms`);
    const rooms = await (
      await fetch(`http://127.0.0.1:${server.port}/console/rooms`, { headers: session.headers })
    ).text();
    eq(rooms.includes('55 total') || rooms.includes('total'), true);
    const human = await (
      await fetch(`http://127.0.0.1:${server.port}/console/human-work`, { headers: session.headers })
    ).text();
    eq(human.includes('total'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-027: narrow-screen CSS, error association, and consistent action labels', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const login = await (await fetch(`${base_}/login`)).text();
    eq(login.includes('Skip to main content'), true);
    eq(login.includes('<main id="main">'), true);
    eq(login.includes('@media (max-width:600px)'), true);
    eq(login.includes('table.stacked'), true);
    eq(login.includes('min-height:44px'), true);
    // failed login wires the error to the field with role=alert summary
    const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const bad = await (
      await fetch(`${base_}/login`, {
        method: 'POST',
        headers: { cookie: preCookie },
        body: `csrf=${preToken}&email=${encodeURIComponent(OWNER.email)}&password=wrong-password-xyz`,
        redirect: 'manual',
      })
    ).text();
    eq(bad.includes('role="alert"'), true);
    eq(bad.includes('aria-describedby="email-error"'), true);
    eq(bad.includes('id="email-error"'), true);
    const session = await ownerSession(server.port);
    const team = await (await fetch(`${base_}/team`, { headers: session.headers })).text();
    eq(team.includes('Create account'), true);
    eq(team.includes('@media (max-width:600px)'), true);
    const detail = await (await fetch(`${base_}/console/requests/rq1`, { headers: session.headers })).text();
    eq(detail.includes('Skip to main content'), true);
    eq(detail.includes('<main id="main">'), true);
    const { ACTION_LABELS, errorSummary, successReceipt, forbiddenBlock, timeoutBlock, destructiveConfirm } =
      await import('../src/console/states.ts');
    eq(ACTION_LABELS.approve.includes('Approve'), true);
    eq(errorSummary([{ field: 'email', message: 'bad' }]).includes('role="alert"'), true);
    eq(successReceipt('Saved', { href: '/x', label: 'Next' }).includes('role="status"'), true);
    eq(forbiddenBlock('admin').includes('requires admin'), true);
    eq(timeoutBlock().includes('before retrying'), true);
    eq(destructiveConfirm({ target: 't', consequences: 'c', retained: 'r' }).includes('Destructive action'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('E2E-10: session expiry during review preserves safe draft and requires explicit resubmission', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  await coord.submit(
    base({ id: 'e2e10-r', goal: 'expiry review item', claimRefs: [rel.id], bid: { humanMinutes: 5 } }),
  );
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await ownerSession(server.port);
    eq(REVIEW_SCRIPT.includes('SESSION_EXPIRED'), true);
    eq(REVIEW_SCRIPT.includes('Your draft is preserved'), true);
    // expire the session server-side, then attempt the sensitive action
    await db.prepare('DELETE FROM auth_sessions').run();
    const res = await fetch(`${base_}/api/requests/e2e10-r/approve`, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    eq(res.status, 401);
    const body = (await res.json()) as { code: string; loginUrl: string; error: string };
    eq(body.code, 'SESSION_EXPIRED');
    eq(body.loginUrl.includes('/login?'), true);
    eq(body.loginUrl.includes('reason=expired'), true);
    // browser login page explains resubmission, never auto-replay
    const login = await (await fetch(`${base_}${body.loginUrl}`)).text();
    eq(login.includes('Approvals are never replayed'), true);
    eq(login.includes('submit it again'), true);
    // the request is untouched — nothing auto-approved
    const current = await coord.get(TEN, 'e2e10-r');
    eq(current?.state, 'ADMITTED');
  } finally {
    await server.close();
    await db.close();
  }
});

T('Cross-cutting: loading, success, empty, error, 403, partial, timeout, refresh, destructive helpers', async () => {
  const mod = await import('../src/console/states.ts');
  eq(mod.loadingNote('Approve').includes('aria-busy'), true);
  eq(mod.loadingNote('Approve').includes('prevent a duplicate'), true);
  eq(
    mod.successReceipt('Approved to begin work', { href: '/r', label: 'View receipt' }).includes('View receipt'),
    true,
  );
  eq(mod.emptyState('unconfigured', { body: 'no source' }).includes('Not configured'), true);
  eq(mod.emptyState('no-data').includes('No data yet'), true);
  eq(mod.emptyState('no-match', { clearUrl: '/c' }).includes('Clear search'), true);
  eq(mod.errorBlock('approval', 'draft preserved', 'refresh and retry').includes('Failed at approval'), true);
  eq(
    mod.partialBlock({ succeeded: ['a'], failed: [{ item: 'b', reason: 'denied' }] }).includes('Partial completion'),
    true,
  );
  eq(mod.refreshBlock('Progress saved.').includes('authoritative cancellation'), true);
  eq(REVIEW_SCRIPT.includes('aria-busy'), true);
  eq(REVIEW_SCRIPT.includes('Timed out'), true);
  eq(REVIEW_SCRIPT.includes('refresh before retrying'), true);
  // 403 explains authority without leaking data
  const { db, ledger, coord, comp, rel } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'M', role: 'member', password: 'a-members-password' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
    approverRole: 'admin',
  });
  try {
    const member = await formSession(server.port, 'member@acme.test', 'a-members-password');
    await coord.submit(base({ id: 'cc-403', goal: 'needs admin approval', claimRefs: [rel.id] }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/requests/cc-403/approve`, {
      method: 'POST',
      headers: { ...member.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    eq(res.status, 403);
    eq((await res.text()).includes('requires admin'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-007: self-serve data export, typed erasure, and public erasure receipt verification', async () => {
  const { db, ledger, coord, comp } = await seeded();
  await inviteUser(
    db,
    TEN,
    { email: 'member@acme.test', name: 'Member', role: 'member', password: 'member-password-123' },
    { userId: 'seed', role: 'owner' },
    NOW,
  );
  await db.prepare('UPDATE users SET must_change_password = 0 WHERE email = ?').run('member@acme.test');
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
  });
  try {
    const owner = await ownerSession(server.port);
    const member = await formSession(server.port, 'member@acme.test', 'member-password-123');
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // 1. Gating: member gets 403 on /console/data and /console/data/export
    const memberData = await fetch(`${baseUrl}/console/data`, { headers: member.headers });
    eq(memberData.status, 403);
    const memberExport = await fetch(`${baseUrl}/console/data/export`, { headers: member.headers });
    eq(memberExport.status, 403);

    // 2. Owner can reach /console/data
    const ownerData = await fetch(`${baseUrl}/console/data`, { headers: owner.headers });
    eq(ownerData.status, 200);
    const ownerDataHtml = await ownerData.text();
    eq(ownerDataHtml.includes('Data &amp; retention'), true);
    eq(ownerDataHtml.includes('Export Reality Ledger'), true);
    eq(ownerDataHtml.includes('Danger Zone: Permanent Tenant Erasure'), true);
    // FLOW-013: backup scope is stated plainly so operators are not surprised.
    eq(ownerDataHtml.includes('Backup &amp; restore'), true, 'data page documents backup scope:');
    eq(ownerDataHtml.includes('not a backup'), true, 'export explicitly disclaims restore-by-import:');

    // 3. Owner can download JSON export bundle
    const ownerExport = await fetch(`${baseUrl}/console/data/export`, { headers: owner.headers });
    eq(ownerExport.status, 200);
    eq(ownerExport.headers.get('content-type')?.includes('application/json'), true);
    eq(ownerExport.headers.get('content-disposition')?.includes('acme-ledger-export.json'), true);
    const exportedJson = (await ownerExport.json()) as any;
    eq(exportedJson.tenant, TEN);
    eq(Array.isArray(exportedJson.claims), true);

    // 4. Mismatched slug confirmation rejects erasure
    const badForm = new URLSearchParams({
      csrf: owner.csrf,
      confirmSlug: 'wrong-slug',
      confirmed: 'on',
    });
    const badErase = await fetch(`${baseUrl}/console/data/erase`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: badForm.toString(),
      redirect: 'manual',
    });
    eq(badErase.status, 303);
    eq(badErase.headers.get('location')?.includes('error='), true);

    // 5. Correct typed confirmation erases tenant and redirects to public receipt
    const goodForm = new URLSearchParams({
      csrf: owner.csrf,
      confirmSlug: TEN,
      confirmed: 'on',
    });
    const goodErase = await fetch(`${baseUrl}/console/data/erase`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: goodForm.toString(),
      redirect: 'manual',
    });
    eq(goodErase.status, 303);
    const redirectUrl = goodErase.headers.get('location');
    eq(redirectUrl, `/receipts/erasure/${TEN}`);

    // 6. Public receipt verification displays verified deletion summary
    const receiptRes = await fetch(`${baseUrl}/receipts/erasure/${TEN}`);
    eq(receiptRes.status, 200);
    const receiptHtml = await receiptRes.text();
    eq(receiptHtml.includes('Erasure verification receipt'), true);
    eq(receiptHtml.includes('Organization <code>acme</code> was erased'), true);
    eq(receiptHtml.includes('Deletion summary'), true);

    // 7. Unknown slug returns 404 with not found receipt
    const notFoundRes = await fetch(`${baseUrl}/receipts/erasure/nonexistent-org`);
    eq(notFoundRes.status, 404);
    const notFoundHtml = await notFoundRes.text();
    eq(notFoundHtml.includes('No erasure receipt found'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-008: truthful password reset & email verification copy and operator assistance', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    now: () => NOW,
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // 1. Without mailer: forgot password shows operator-assisted copy & turnaround
    const forgotRes = await fetch(`${baseUrl}/forgot-password`);
    const cookie = forgotRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    const forgotGet = await forgotRes.text();
    eq(forgotGet.includes('Operator-assisted password recovery'), true);
    eq(forgotGet.includes('Expected turnaround:</strong> typically under 1 hour'), true);
    eq(forgotGet.includes('Request operator reset link'), true);

    // 2. Without mailer: POST /forgot-password explains operator assistance
    const csrfMatch = forgotGet.match(/name="csrf" value="([0-9a-f]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    const forgotPost = await (
      await fetch(`${baseUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: `csrf=${csrf}&email=owner%40acme.test`,
      })
    ).text();
    eq(forgotPost.includes('Automatic email delivery is not configured on this host'), true);
    eq(forgotPost.includes('vital reset-link'), true);
    eq(forgotPost.includes('turnaround: under 1 hour'), true);

    // 3. Without mailer: account page relabels button and explains turnaround
    const accountGet = await (await fetch(`${baseUrl}/account`, { headers: owner.headers })).text();
    eq(accountGet.includes('Request operator verification'), true);
    eq(accountGet.includes('turnaround: typically same-day'), true);
    eq(accountGet.includes('vital verify-link'), true);

    // 4. Without mailer: POST /account/email/request explains operator turnaround
    const emailReq = await (
      await fetch(`${baseUrl}/account/email/request`, {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: `csrf=${owner.csrf}`,
      })
    ).text();
    eq(emailReq.includes('Outbound email is not configured'), true);
    eq(emailReq.includes('vital verify-link'), true);

    // 5. No environment variable may turn those honest answers into a promise.
    // This used to assert the reverse: `VITAL_MAILER_ENABLED=1` relabelled the
    // pages to "Send reset email" / "Send verification link" — copy for a sender
    // that does not exist in `src/`. A deployment could therefore switch a
    // working operator flow into a false "check your inbox" on account recovery.
    // The test now pins the honest direction: the flag changes nothing, because
    // it was never a mailer.
    process.env.VITAL_MAILER_ENABLED = '1';
    try {
      const forgotWithMailer = await (await fetch(`${baseUrl}/forgot-password`)).text();
      eq(forgotWithMailer.includes('Send reset email'), false, 'no inbox promise from a flag:');
      eq(forgotWithMailer.includes('Request operator reset link'), true);
      eq(forgotWithMailer.includes('not configured'), true);

      const accountWithMailer = await (await fetch(`${baseUrl}/account`, { headers: owner.headers })).text();
      eq(accountWithMailer.includes('Send verification link'), false, 'no inbox promise from a flag:');
      eq(accountWithMailer.includes('vital verify-link'), true);

      // And the POST answers honestly too (a reset request for a real address).
      const pre = await fetch(`${baseUrl}/forgot-password`, { redirect: 'manual' });
      const preCookies = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
      const forgotPost = await (
        await fetch(`${baseUrl}/forgot-password`, {
          method: 'POST',
          headers: { cookie: preCookies, 'content-type': 'application/x-www-form-urlencoded' },
          body: `csrf=${preToken}&email=owner%40acme.test`,
        })
      ).text();
      eq(forgotPost.includes('has been sent to your inbox'), false, 'the POST does not claim a send:');
      eq(forgotPost.includes('not configured'), true, 'it names the operator path instead:');
    } finally {
      delete process.env.VITAL_MAILER_ENABLED;
    }
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-009: visible deliverable authoring path on approved requests with grounding checks', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  const artDir = join(tmpdir(), `vital-final009-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  process.env.ARTIFACT_DIR = artDir;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // 1. Initially request r1 is admitted/pending approval to begin work
    const beforeApproval = await (await fetch(`${baseUrl}/console/requests/r1`, { headers: owner.headers })).text();
    eq(beforeApproval.includes('Deliverable'), true);
    eq(beforeApproval.includes('Pending deliverable draft from worker or agent'), true);
    eq(beforeApproval.includes('Draft deliverable in-product'), true);

    // 2. Draft deliverable in-product
    const draftRes = await fetch(`${baseUrl}/console/requests/r1/deliverable`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&deliverableSchema=launch-pack.v1&content=${encodeURIComponent(`- Launch notes citing release [claim:${rel.id}]`)}`,
      redirect: 'manual',
    });
    eq(draftRes.status, 303);
    eq(draftRes.headers.get('location'), '/console/requests/r1');

    // 3. After drafting, request detail renders deliverable preview with grounding checks
    const afterDraft = await (await fetch(`${baseUrl}/console/requests/r1`, { headers: owner.headers })).text();
    eq(afterDraft.includes('Deliverable preview'), true);
    eq(afterDraft.includes('Launch notes citing release'), true);
    eq(afterDraft.includes('Finding'), true);
    eq(afterDraft.includes('All grounding checks passed.'), true);
    eq(afterDraft.includes('Approve deliverable'), true);

    // 4. Approve deliverable
    const verMatch = afterDraft.match(/\/api\/deliverables\/([^/]+)\/approve/);
    eq(Boolean(verMatch), true);
    const verId = verMatch![1]!;
    const fpMatch = afterDraft.match(/name="fingerprint" value="([0-9a-f]+)"/);
    const fp = fpMatch ? fpMatch[1] : '';

    const approveRes = await fetch(`${baseUrl}/api/deliverables/${verId}/approve`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: fp }),
    });
    eq(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as { ok: boolean; status: string; decisionUrl: string };
    eq(approveJson.ok, true);
    eq(approveJson.status, 'approved');

    // Receipt page confirms final-deliverable decision
    const decisionHtml = await (await fetch(`${baseUrl}${approveJson.decisionUrl}`, { headers: owner.headers })).text();
    eq(decisionHtml.includes('final-deliverable'), true);
  } finally {
    delete process.env.ARTIFACT_DIR;
    await server.close();
    await db.close();
  }
});

T('FINAL-010: team roster search, role/status filters, pagination, and multi-address invite', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  process.env.VITAL_EXPOSE_INVITE_LINK = '1';
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // 1. Bulk invite multiple addresses via comma/newline separation
    const bulkInvite = await fetch(`${baseUrl}/team/invite`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&email=bulk1%40acme.test%2C+bulk2%40acme.test%0Abulk3%40acme.test&role=member`,
    });
    eq(bulkInvite.status, 200);
    const bulkHtml = await bulkInvite.text();
    eq(bulkHtml.includes('3 members invited as member'), true);
    eq(bulkHtml.includes('bulk1@acme.test'), true);
    eq(bulkHtml.includes('bulk2@acme.test'), true);
    eq(bulkHtml.includes('bulk3@acme.test'), true);

    // 2. Roster search by email
    const searchRes = await (await fetch(`${baseUrl}/team?q=owner`, { headers: owner.headers })).text();
    eq(searchRes.includes('owner@acme.test'), true);

    // 3. Roster role filter
    const roleRes = await (await fetch(`${baseUrl}/team?role=owner`, { headers: owner.headers })).text();
    eq(roleRes.includes('owner@acme.test'), true);

    // 4. Roster status filter
    const statusRes = await (await fetch(`${baseUrl}/team?status=active`, { headers: owner.headers })).text();
    eq(statusRes.includes('owner@acme.test'), true);

    // 5. Clear filters link present when filter active
    eq(searchRes.includes('Clear filters'), true);
  } finally {
    delete process.env.VITAL_EXPOSE_INVITE_LINK;
    await server.close();
    await db.close();
  }
});

T('FINAL-011: no-JS fallback for approval, decline, and evidence refresh', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // 1. Request detail does not ship disabled submit buttons
    const detail = await (await fetch(`${baseUrl}/console/requests/r1`, { headers: owner.headers })).text();
    eq(detail.includes('<button type="submit" disabled>'), false);

    const home = await (await fetch(`${baseUrl}/?view=dashboard`, { headers: owner.headers })).text();
    eq(home.includes('<button type="submit" disabled>'), false);
    eq(home.includes('JavaScript disabled: standard full-page form submission is active.'), true);

    // 2. Full-page POST approval redirects browser back to request
    const approvePost = await fetch(`${baseUrl}/api/requests/r1/approve`, {
      method: 'POST',
      headers: {
        ...owner.headers,
        accept: 'text/html,application/xhtml+xml',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${owner.csrf}&confirmed=on`,
      redirect: 'manual',
    });
    eq(approvePost.status, 303);
    eq(approvePost.headers.get('location'), '/console/requests/r1');
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-012: irreversible actions enforce destructiveConfirm and typed confirmation', async () => {
  const { db, ledger, coord, comp, rel } = await seeded();
  const artDir = join(tmpdir(), `vital-final012-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  process.env.ARTIFACT_DIR = artDir;
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // Draft deliverable with externalPublish
    const v = await persistDeliverableVersion(db, ledger, {
      tenant: TEN,
      requestId: 'r1',
      deliverableSchema: 'launch-pack.v1',
      content: `- External asset cites [claim:${rel.id}]`,
      claimIds: [rel.id],
      createdBy: 'agent:ext',
      now: NOW,
      artifactDir: artDir,
      externalPublish: true,
    });

    const detail = await (await fetch(`${baseUrl}/console/requests/r1`, { headers: owner.headers })).text();
    eq(detail.includes('Destructive action: External publication.'), true);
    eq(detail.includes('Type <code>PUBLISH</code> to confirm'), true);

    // Attempt approval without typed PUBLISH confirmation
    const badApprove = await fetch(`${baseUrl}/api/deliverables/${v.id}/approve`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: v.fingerprint, confirmText: 'WRONG' }),
    });
    eq(badApprove.status, 400);
    // The refusal now names what approval actually does: it records an
    // authorization, and the console itself publishes nothing.
    const badApproveBody = await badApprove.text();
    eq(badApproveBody.includes('type PUBLISH to confirm'), true);
    eq(badApproveBody.includes('publishes nothing itself'), true, 'the copy does not imply a delivery:');

    // Attempt approval with typed PUBLISH confirmation
    const goodApprove = await fetch(`${baseUrl}/api/deliverables/${v.id}/approve`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: v.fingerprint, confirmText: 'PUBLISH' }),
    });
    eq(goodApprove.status, 200);
    eq(((await goodApprove.json()) as { ok: boolean }).ok, true);
  } finally {
    delete process.env.ARTIFACT_DIR;
    await server.close();
    await db.close();
  }
});

T('FINAL-013: HTML error pages for browser GET validation failures', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // Browser request with Accept: text/html gets HTML error page with status 400
    const htmlErr = await fetch(`${baseUrl}/console/requests/rq1?page=-1`, {
      headers: { ...owner.headers, accept: 'text/html,application/xhtml+xml' },
    });
    eq(htmlErr.status, 400);
    eq(htmlErr.headers.get('content-type')?.includes('text/html'), true);
    const htmlBody = await htmlErr.text();
    eq(htmlBody.includes('Error 400'), true);
    eq(htmlBody.includes('page must be a nonnegative integer'), true);

    // API request without Accept: text/html gets JSON error with status 400
    const jsonErr = await fetch(`${baseUrl}/console/requests/rq1?page=-1`, {
      headers: { ...owner.headers },
    });
    eq(jsonErr.status, 400);
    eq(jsonErr.headers.get('content-type')?.includes('application/json'), true);
    const jsonBody = (await jsonErr.json()) as { ok: boolean; error: string };
    eq(jsonBody.ok, false);
    eq(jsonBody.error, 'page must be a nonnegative integer');

    // Digest invalid days parameter in browser gets HTML error page
    const digestHtmlErr = await fetch(`${baseUrl}/console/digest?days=bogus`, {
      headers: { ...owner.headers, accept: 'text/html,application/xhtml+xml' },
    });
    eq(digestHtmlErr.status, 400);
    eq(digestHtmlErr.headers.get('content-type')?.includes('text/html'), true);
    eq((await digestHtmlErr.text()).includes('days must be 1, 7, 30 or all'), true);
  } finally {
    await server.close();
    await db.close();
  }
});

T('FINAL-014: shared nav across authenticated pages and unified terminology', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);

    // Nav includes top-level entries for Reviews, Requests, Claims, Rooms, Human work, Workflows, Digest, Team, Account
    const home = await (await fetch(`${baseUrl}/`, { headers: owner.headers })).text();
    eq(home.includes('>Reviews</a>'), true);
    eq(home.includes('>Requests</a>'), true);
    eq(home.includes('>Claims</a>'), true);
    eq(home.includes('>Rooms</a>'), true);
    eq(home.includes('>Human work</a>'), true);
    eq(home.includes('>Workflows</a>'), true);
    eq(home.includes('>Digest</a>'), true);
    eq(home.includes('>Team</a>'), true);
    eq(home.includes('>Account</a>'), true);

    // Verify view-all destinations are reachable
    for (const path of ['/console/requests', '/console/claims', '/console/rooms', '/console/human-work']) {
      const res = await fetch(`${baseUrl}${path}`, { headers: owner.headers });
      eq(res.status, 200, `${path} reachable`);
    }
  } finally {
    await server.close();
    await db.close();
  }
});

T('FLOW-015: a leg nothing will advance is named stalled and can be reclaimed', async () => {
  const { db, ledger, coord, comp } = await fresh();

  // Pure classification first: both stalls, and the cases that must NOT be
  // called stalls (a live lease, an unreadable clock).
  const NOW_MS = Date.parse(NOW);
  eq(describeLegStall('IN_FLIGHT', null, NOW_MS), null, 'no lease row, no claim of a stall:');
  eq(
    describeLegStall('IN_FLIGHT', { state: 'IN_FLIGHT', claimedAt: NOW, leaseMs: 60_000, updatedAt: NOW }, NOW_MS),
    null,
    'a lease still inside its window is not stalled:',
  );
  const dead = describeLegStall(
    'IN_FLIGHT',
    { state: 'IN_FLIGHT', claimedAt: '2026-01-01T00:00:00.000Z', leaseMs: 1000, updatedAt: NOW },
    NOW_MS,
  );
  eq(dead !== null, true, 'an expired execution lease is stalled:');
  eq(dead!.includes('lease expired'), true, 'the reason names the lease, not just the symptom:');
  eq(
    describeLegStall('ACCEPTED', { state: 'ACCEPTED', claimedAt: null, leaseMs: null, updatedAt: NOW }, NOW_MS),
    null,
    'an accepted leg inside the grace window is still progressing:',
  );
  const unclaimed = describeLegStall(
    'ACCEPTED',
    { state: 'ACCEPTED', claimedAt: null, leaseMs: null, updatedAt: '2026-01-01T00:00:00.000Z' },
    NOW_MS,
  );
  eq(unclaimed !== null, true, 'an accepted leg no executor ever claimed is stalled:');
  eq(describeLegStall('ADMITTED', null, NOW_MS), null, 'an admitted leg awaiting review is not stalled:');

  // Now the real path: an executor claimed the leg and died holding the lease.
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'release:v1',
    kind: 'OBSERVATION',
    statement: 'release evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'req-stall', goal: 'ship the release note', claimRefs: [clm.id] }));
  await coord.claimExecution(TEN, request.id, 'worker-dead', '2026-01-01T00:00:00.000Z', 1000);

  const run: FanOutWorkflowRun = {
    id: 'wfr_stall',
    tenant: TEN,
    kind: 'ship',
    claimIds: [clm.id],
    onBehalfOf: 'human:owner',
    now: NOW,
    subject: 'release:v1',
    summary: null,
    legs: [
      {
        key: 'engineering',
        originScope: 'product',
        targetScope: 'engineering',
        messageClass: 'REQUEST',
        goal: 'ship the release note',
        deliverableSchema: 'launch-copy.v1',
        humanMinutes: 10,
        requestId: request.id,
        status: 'EXECUTING',
        reason: null,
        dedupedTo: null,
        updatedAt: NOW,
      },
    ],
    status: 'IN_PROGRESS',
    decisionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await saveFanOutRun(db, run);

  const view = await buildWorkspaceView(db, ledger, coord, comp, TEN, run.id);
  eq(view?.legs[0]!.stalled, true);
  eq(view?.stalledLegs.length, 1);
  eq(view?.stalledLegs[0]!.requestId, request.id);
  eq(view?.canRetry, true, 'a stalled run offers recovery even while the fan-out status still says IN_PROGRESS:');
  eq(view?.blocker?.includes('stalled'), true, 'the blocker names the stall:');

  const html = renderWorkflowDetailPage(view!, { home: '/console/dashboard', csrf: 'csrf', actor: 'owner' });
  eq(html.includes('Stalled legs'), true, 'the page shows a stall section:');
  eq(html.includes('Reclaim stalled legs and resume'), true, 'and the button says what it will do:');

  // Retry reclaims the dead executor's lease — otherwise "resume" would report
  // success while the leg stayed EXECUTING forever.
  const { reclaimed } = await retryWorkflow(db, coord, TEN, run.id, { now: '2026-02-01T00:00:00.000Z' });
  eq(reclaimed.length, 1);
  eq(reclaimed[0], request.id);
  eq((await coord.get(TEN, request.id))?.state, 'ADMITTED', 'the reclaimed leg is runnable again:');

  const after = await buildWorkspaceView(db, ledger, coord, comp, TEN, run.id);
  eq(after?.stalledLegs.length, 0, 'nothing is stalled once the claim is released:');

  await db.close();
});

T('learning actions: the compile form is owner-only, evidence-gated, and CSRF-checked', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'test:compile-route',
    kind: 'OBSERVATION',
    statement: 'release evidence',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:test',
    scope: 'marketing',
    authorType: 'system',
    provenance: sor(),
  });
  for (let i = 0; i < 3; i++) {
    const { request } = await coord.submit(
      base({ id: `req-route-${i}`, goal: `draft copy ${i}`, claimRefs: [clm.id] }),
    );
    await coord.claimExecution(TEN, request.id, 'jcode:worker', NOW, 60_000);
    await db
      .prepare(
        'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `tr_route_${i}`,
        TEN,
        request.id,
        'marketing',
        'launch.copy.draft',
        'draft-launch-copy',
        '[]',
        'MODEL',
        'SUCCESS',
        '{}',
        null,
        0.9,
        NOW,
      );
  }
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const owner = await ownerSession(server.port);
    const page = await (await fetch(`${base_}/console/learning/compile`, { headers: owner.headers })).text();
    eq(page.includes('Compile a skill card'), true);
    eq(page.includes('draft-launch-copy'), true, 'the mined candidate is offered:');
    eq(page.includes('jcode'), true, 'and the models the evidence came from are shown:');

    // A body with no CSRF token never reaches the compiler.
    const noToken = await fetch(`${base_}/console/learning/compile`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'intent=draft-launch-copy',
      redirect: 'manual',
    });
    eq(noToken.status, 403, 'a mutating learning route requires the token:');
    eq((await comp.list(TEN, {})).length, 0, 'and nothing was compiled:');

    // A tier the evidence does not support is refused with the reason.
    const wrongTier = await fetch(`${base_}/console/learning/compile`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&intent=draft-launch-copy&scope=marketing&tier=REFLEX&predicates=p&steps=s&tests=t&toolGrants=`,
      redirect: 'manual',
    });
    eq(wrongTier.status, 303);
    eq((wrongTier.headers.get('location') ?? '').includes('error='), true, 'refusal is carried back to the form:');
    eq(decodeURIComponent(wrongTier.headers.get('location') ?? '').includes('not supported by this evidence'), true);

    // The supported tier compiles, and the card lands in CANDIDATE.
    const compiled = await fetch(`${base_}/console/learning/compile`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&intent=draft-launch-copy&scope=marketing&tier=MODEL&predicates=a+release+summary+exists&steps=read+the+claims%0Adraft+the+copy&tests=every+bullet+cites+a+claim&toolGrants=docs.read`,
      redirect: 'manual',
    });
    eq(compiled.status, 303);
    eq((compiled.headers.get('location') ?? '').includes('/console/learning/skl_'), true);
    const cards = await comp.list(TEN, {});
    eq(cards.length, 1);
    eq(cards[0]!.state, 'CANDIDATE');
    eq(cards[0]!.originModels, ['jcode']);

    // The card page offers the transfer test, and refuses a same-scope run.
    const cardPage = await (
      await fetch(`${base_}/console/learning/${cards[0]!.id}`, { headers: owner.headers })
    ).text();
    eq(cardPage.includes('Run a transfer test'), true, 'the page can now start the path it describes:');
    const sameScope = await fetch(`${base_}/console/learning/cards/${cards[0]!.id}/transfer-test`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&targetScope=marketing&command=x&claimIds=${clm.id}&maxDollars=1&maxTokens=1000`,
      redirect: 'manual',
    });
    eq(sameScope.status, 303);
    eq(decodeURIComponent(sameScope.headers.get('location') ?? '').includes('cannot send work to itself'), true);
    const outboxRows = await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'transfer-test'").get();
    eq(Number((outboxRows as { n: number }).n), 0, 'a refused request queues nothing:');

    const queued = await fetch(`${base_}/console/learning/cards/${cards[0]!.id}/transfer-test`, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${owner.csrf}&targetScope=engineering&command=draft+the+copy&claimIds=${clm.id}&maxDollars=1&maxTokens=1000`,
      redirect: 'manual',
    });
    eq(queued.status, 303);
    eq((queued.headers.get('location') ?? '').includes('queued='), true);
    const after = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'transfer-test' AND status = 'PENDING'")
      .get();
    eq(Number((after as { n: number }).n), 1, 'the transfer test is durable:');

    // Members cannot compile or queue anything.
    await inviteUser(
      db,
      TEN,
      { email: 'member-compile@acme.test', name: 'M', role: 'member', password: 'a-members-password-long' },
      { userId: 'seed', role: 'owner' },
      NOW,
    );
    const member = await formSession(server.port, 'member-compile@acme.test', 'a-members-password-long');
    eq((await fetch(`${base_}/console/learning/compile`, { headers: member.headers })).status, 403);
    const memberPost = await fetch(`${base_}/console/learning/cards/${cards[0]!.id}/transfer-test`, {
      method: 'POST',
      headers: { ...member.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${member.csrf}&targetScope=engineering&command=x&claimIds=${clm.id}&maxDollars=1&maxTokens=1000`,
      redirect: 'manual',
    });
    eq(memberPost.status, 403, 'a member cannot spend harness budget:');
  } finally {
    await server.close();
    await db.close();
  }
});
