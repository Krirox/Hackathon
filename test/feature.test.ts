import { T, eq, TEN, NOW, fresh, sor, base, rejects, withHarness } from './helpers.ts';
import { approveFeaturePlan, codeApprovedFeature, planFeature, researchCompetitors } from '../src/wedge/feature.ts';
import { JcodeAdapter, LocalEchoAdapter } from '../src/substrate/harness.ts';
import { mintScopeToken } from '../src/substrate/identity.ts';
import { buildManifest } from '../src/substrate/sandbox.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

console.log('\n\x1b[1mWedge — feature loop: research, plan, approve, then code\x1b[0m');

const research = async (ledger: Awaited<ReturnType<typeof fresh>>['ledger']) =>
  await researchCompetitors(ledger, TEN, {
    feature: 'magic-link-login',
    findings: [
      {
        sourceUri: 'https://slack.engineering/magic-links',
        summary: 'Slack: short-lived single-use tokens over email',
        sourceTier: 'PRIMARY',
      },
      {
        sourceUri: 'https://vendor.blog/sso',
        summary: 'Vendor: magic links plus device check',
        sourceTier: 'SELF_SERVED',
      },
    ],
    by: 'agent:eng',
    scope: 'engineering',
    now: NOW,
  });

T('research becomes cited observations, never facts — unsourced is refused', async () => {
  const { ledger } = await fresh();
  const ids = await research(ledger);
  eq(ids.length, 2);
  eq((await ledger.get(TEN, ids[0]!))!.kind, 'OBSERVATION');
  await rejects(
    async () => await researchCompetitors(ledger, TEN, { feature: 'x', findings: [], by: 'a', scope: 'e', now: NOW }),
    'EMPTY_RESEARCH',
  );
  await rejects(
    async () =>
      await researchCompetitors(ledger, TEN, {
        feature: 'x',
        findings: [{ sourceUri: '', summary: 'trust me' }],
        by: 'a',
        scope: 'e',
        now: NOW,
      }),
    'UNSOURCED_FINDING',
  );
  await rejects(
    async () =>
      await researchCompetitors(ledger, TEN, {
        feature: 'x',
        findings: [{ sourceUri: 'u', summary: 's', sourceTier: 'SYSTEM_OF_RECORD' }],
        by: 'a',
        scope: 'e',
        now: NOW,
      }),
    'RESEARCH_MINTS_FACT',
  );
});

T('the plan cites live research; uncited improvements are refused', async () => {
  const { ledger } = await fresh();
  const ids = await research(ledger);
  const plan = await planFeature(ledger, TEN, {
    feature: 'magic-link-login',
    items: [
      {
        improvement: 'single-use 10-minute tokens plus device check (better than either source alone)',
        researchIds: ids,
      },
    ],
    now: NOW,
  });
  eq(plan.items.length, 1);
  await rejects(
    async () =>
      await planFeature(ledger, TEN, { feature: 'x', items: [{ improvement: 'vibes', researchIds: [] }], now: NOW }),
    'UNCITED_PLAN',
  );
  await rejects(
    async () =>
      await planFeature(ledger, TEN, {
        feature: 'x',
        items: [{ improvement: 'ghosts', researchIds: ['clm_nope'] }],
        now: NOW,
      }),
    'STALE_RESEARCH',
  );
});

T('no named approver means no decision and no coding', async () => {
  const { db, ledger, coord } = await fresh();
  const ids = await research(ledger);
  const plan = await planFeature(ledger, TEN, {
    feature: 'magic-link-login',
    items: [{ improvement: 'do it', researchIds: ids }],
    now: NOW,
  });
  await rejects(
    async () =>
      await approveFeaturePlan(ledger, TEN, {
        plan,
        researchIds: ids,
        decidedBy: 'agent:eng',
        scope: 'engineering',
        now: NOW,
      }),
    'NEEDS_APPROVAL',
  );
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'feat',
    kind: 'OBSERVATION',
    statement: 'req',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'f1', goal: 'build magic links', claimRefs: [clm.id] }));
  const echo = new LocalEchoAdapter(db, ledger, coord);
  const decisionId = await approveFeaturePlan(ledger, TEN, {
    plan,
    researchIds: ids,
    decidedBy: 'agent:eng',
    approvedBy: 'human:priya',
    scope: 'engineering',
    requestId: request.id,
    now: NOW,
  });
  const out = await codeApprovedFeature(coord, ledger, echo, TEN, {
    decisionId,
    requestId: request.id,
    command: 'implement magic links',
    claimIds: [clm.id],
    onBehalfOf: 'human:priya',
    maxDollars: 1,
    maxTokens: 10_000,
  });
  eq(out.outcome.status, 'COMPLETED');
  eq((await coord.get(TEN, request.id))!.state, 'COMPLETED');
});

T('coding refuses unapproved decisions and unadmitted requests', async () => {
  const { db, ledger, coord } = await fresh();
  const ids = await research(ledger);
  const plan = await planFeature(ledger, TEN, {
    feature: 'x',
    items: [{ improvement: 'do it', researchIds: ids }],
    now: NOW,
  });
  const sneaky = await ledger.recordDecision({
    tenant: TEN,
    goal: 'sneak',
    action: 'code it',
    actionClass: 'ACT_REVERSIBLE',
    claimIds: ids,
    decidedBy: 'agent:eng',
    scope: 'engineering',
    autonomy: 'approval',
    now: NOW,
  });
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'f',
    kind: 'OBSERVATION',
    statement: 'req',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'f2', goal: 'sneak it in', claimRefs: [clm.id] }));
  const echo = new LocalEchoAdapter(db, ledger, coord);
  const task = {
    decisionId: sneaky.id,
    requestId: request.id,
    command: 'x',
    claimIds: [clm.id],
    onBehalfOf: 'h',
    maxDollars: 1,
    maxTokens: 100,
  };
  let code = '';
  try {
    await codeApprovedFeature(coord, ledger, echo, TEN, task);
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('UNAPPROVED_CODE'), true, 'approval field missing on the decision:');
  await coord.decline(TEN, request.id, 'no');
  const approved = await approveFeaturePlan(ledger, TEN, {
    plan,
    researchIds: ids,
    decidedBy: 'agent:eng',
    approvedBy: 'human:priya',
    scope: 'engineering',
    now: NOW,
  });
  let code2 = '';
  try {
    await codeApprovedFeature(coord, ledger, echo, TEN, { ...task, decisionId: approved });
  } catch (e) {
    code2 = (e as Error).message;
  }
  eq(code2.includes('UNADMITTED_CODE'), true, 'declined request cannot be coded against:');
});

T(
  'F13: plan citations must be strictly grounded in approval research; ungrounded plan throws UNGROUNDED_PLAN',
  async () => {
    const { ledger } = await fresh();
    const ids = await research(ledger);
    const plan = await planFeature(ledger, TEN, {
      feature: 'magic-link-login',
      items: [
        { improvement: 'tokens', researchIds: [ids[0]!] },
        { improvement: 'device-check', researchIds: [ids[1]!] },
      ],
      now: NOW,
    });
    await rejects(
      async () =>
        await approveFeaturePlan(ledger, TEN, {
          plan,
          researchIds: [ids[0]!], // missing ids[1] cited by plan
          decidedBy: 'agent:eng',
          approvedBy: 'human:priya',
          scope: 'engineering',
          now: NOW,
        }),
      'UNGROUNDED_PLAN',
    );
  },
);

T(
  'F13: request binding and plan binding: mismatched request or plan throws REQUEST_MISMATCH / PLAN_MISMATCH',
  async () => {
    const { db, ledger, coord } = await fresh();
    const ids = await research(ledger);
    const plan = await planFeature(ledger, TEN, {
      feature: 'magic-link-login',
      items: [{ improvement: 'tokens', researchIds: ids }],
      now: NOW,
    });
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'feat',
      kind: 'OBSERVATION',
      statement: 'req',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request: req1 } = await coord.submit(base({ id: 'f-bind-1', goal: 'magic links', claimRefs: [clm.id] }));
    const { request: req2 } = await coord.submit(base({ id: 'f-bind-2', goal: 'magic links 2', claimRefs: [clm.id] }));
    const decisionId = await approveFeaturePlan(ledger, TEN, {
      plan,
      researchIds: ids,
      decidedBy: 'agent:eng',
      approvedBy: 'human:priya',
      scope: 'engineering',
      requestId: req1.id,
      now: NOW,
    });

    const echo = new LocalEchoAdapter(db, ledger, coord);
    await rejects(
      async () =>
        await codeApprovedFeature(coord, ledger, echo, TEN, {
          decisionId,
          requestId: req2.id, // Mismatch from req1
          command: 'implement magic links',
          claimIds: [clm.id],
          onBehalfOf: 'human:priya',
          maxDollars: 1,
          maxTokens: 10_000,
        }),
      'REQUEST_MISMATCH',
    );

    const fakePlan = { ...plan, fingerprint: 'feature:other:mismatched' };
    await rejects(
      async () =>
        await codeApprovedFeature(coord, ledger, echo, TEN, {
          decisionId,
          requestId: req1.id,
          command: 'implement magic links',
          claimIds: [clm.id],
          onBehalfOf: 'human:priya',
          maxDollars: 1,
          maxTokens: 10_000,
          plan: fakePlan,
        }),
      'PLAN_MISMATCH',
    );
  },
);

T(
  'F13: drift detection: superseded, modified, or expired research rejects execution with DRIFTED_DECISION',
  async () => {
    const { db, ledger, coord } = await fresh();
    const ids = await research(ledger);
    const plan = await planFeature(ledger, TEN, {
      feature: 'magic-link-login',
      items: [{ improvement: 'tokens', researchIds: ids }],
      now: NOW,
    });
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'feat',
      kind: 'OBSERVATION',
      statement: 'req',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'f-drift-1', goal: 'magic links', claimRefs: [clm.id] }));
    const decisionId = await approveFeaturePlan(ledger, TEN, {
      plan,
      researchIds: ids,
      decidedBy: 'agent:eng',
      approvedBy: 'human:priya',
      scope: 'engineering',
      requestId: request.id,
      now: NOW,
    });

    // Modify / supersede one of the cited claims to trigger drift
    await ledger.correctClaim(TEN, ids[0]!, 'Updated competitor insight: tokens expired', 'human:priya', NOW);

    const echo = new LocalEchoAdapter(db, ledger, coord);
    await rejects(
      async () =>
        await codeApprovedFeature(coord, ledger, echo, TEN, {
          decisionId,
          requestId: request.id,
          command: 'implement magic links',
          claimIds: [clm.id],
          onBehalfOf: 'human:priya',
          maxDollars: 1,
          maxTokens: 10_000,
        }),
      'DRIFTED_DECISION',
    );
  },
);

T('F13: primary execution with JcodeAdapter and permission-aware harness honors human approval', async () => {
  await withHarness(async (h) => {
    h.permissionTool = 'write_file';
    h.strictPermissions = true;
    const { db, ledger, coord } = await fresh();
    const ids = await research(ledger);
    const plan = await planFeature(ledger, TEN, {
      feature: 'magic-link-login',
      items: [{ improvement: 'tokens', researchIds: ids }],
      now: NOW,
    });
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'feat',
      kind: 'OBSERVATION',
      statement: 'req',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'f-jcode-1', goal: 'magic links', claimRefs: [clm.id] }));
    const decisionId = await approveFeaturePlan(ledger, TEN, {
      plan,
      researchIds: ids,
      decidedBy: 'agent:eng',
      approvedBy: 'human:priya',
      scope: 'engineering',
      requestId: request.id,
      now: NOW,
    });

    const jcode = new JcodeAdapter(db, ledger, coord, { socketPath: h.path });
    const out = await codeApprovedFeature(coord, ledger, jcode, TEN, {
      decisionId,
      requestId: request.id,
      command: 'implement magic links',
      claimIds: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 5,
      maxTokens: 10_000,
      plan,
    });

    eq(out.verificationStatus, 'VERIFIED');
    eq(out.outcome.status, 'COMPLETED');
    eq(out.outcome.permissions.length, 1);
    eq(out.outcome.permissions[0]!.decision, 'allow');
    eq(out.outcome.transcript.includes('Done: patch applied.'), true);
  });
});

T('F13: scoped controls and baseline classification', async () => {
  const { db, ledger, coord } = await fresh();
  const echo = new LocalEchoAdapter(db, ledger, coord);
  eq(echo.category, 'test-baseline');
  eq(echo.isTestBaseline, true);

  const ids = await research(ledger);
  const plan = await planFeature(ledger, TEN, {
    feature: 'magic-link-login',
    items: [{ improvement: 'tokens', researchIds: ids }],
    now: NOW,
  });
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'feat',
    kind: 'OBSERVATION',
    statement: 'req',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(base({ id: 'f-scope-1', goal: 'magic links', claimRefs: [clm.id] }));
  const decisionId = await approveFeaturePlan(ledger, TEN, {
    plan,
    researchIds: ids,
    decidedBy: 'agent:eng',
    approvedBy: 'human:priya',
    scope: 'engineering',
    requestId: request.id,
    now: NOW,
  });

  const secret = 'super-secret-key-that-is-long-enough-32-chars!!';
  const badToken = mintScopeToken(secret, {
    scope: 'production', // Mismatch from engineering
    grants: ['read'],
    issuedAt: NOW,
    expiresAt: '2029-01-01T00:00:00.000Z',
  });

  await rejects(
    async () =>
      await codeApprovedFeature(coord, ledger, echo, TEN, {
        decisionId,
        requestId: request.id,
        command: 'implement magic links',
        claimIds: [clm.id],
        onBehalfOf: 'human:priya',
        maxDollars: 1,
        maxTokens: 10_000,
        scopeToken: badToken,
        coreSecret: secret,
      }),
    'SCOPE_MISMATCH',
  );

  const testDir = join(tmpdir(), `vital-test-sandbox-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'test.txt'), 'hello world');
  const manifest = buildManifest('engineering', { 'test.txt': 'hello world' });
  writeFileSync(join(testDir, 'test.txt'), 'tampered content');

  await rejects(
    async () =>
      await codeApprovedFeature(coord, ledger, echo, TEN, {
        decisionId,
        requestId: request.id,
        command: 'implement magic links',
        claimIds: [clm.id],
        onBehalfOf: 'human:priya',
        maxDollars: 1,
        maxTokens: 10_000,
        workingDir: testDir,
        sandboxManifest: manifest,
      }),
    'SANDBOX_FAILED',
  );

  rmSync(testDir, { recursive: true, force: true });
});
