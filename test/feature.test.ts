import { T, eq, TEN, NOW, fresh, sor, base, rejects } from './helpers.ts';
import { approveFeaturePlan, codeApprovedFeature, planFeature, researchCompetitors } from '../src/wedge/feature.ts';
import { LocalEchoAdapter } from '../src/substrate/harness.ts';

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
