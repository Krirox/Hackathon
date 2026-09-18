import { T, eq, TEN, NOW, fresh, sor, base } from './helpers.ts';
import { evaluateDispatch, guardedApprovalThresholdDollars, scopeSpend } from '../src/talk/enforce.ts';
import { saveRoomConfig } from '../src/talk/rooms.ts';
import { ApplicationWorker } from '../src/substrate/worker.ts';

/**
 * The wizard's autonomy tiers and budget ceilings used to be display-only:
 * setting "Supervised" or a $250 approval threshold changed nothing. These
 * tests pin the enforcement seam the dispatch loop now calls.
 */

async function requestIn(db: Awaited<ReturnType<typeof fresh>>['db'], scope: string, spend = 0) {
  const id = `req_${Math.random().toString(36).slice(2, 8)}`;
  await db
    .prepare(
      `INSERT INTO requests (id, tenant, message_class, target_scope, origin_scope, goal, state, spent_dollars, spent_tokens, spent_json, bid_json, claim_refs, deliverable, on_behalf_of, hop_chain, chain_claims, idem_key, stop_condition, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      TEN,
      'REQUEST',
      scope,
      'core',
      'test request',
      'ADMITTED',
      spend,
      0,
      JSON.stringify({ dollars: spend, tokens: 0 }),
      JSON.stringify({ dollars: 10, tokens: 100_000, humanMinutes: 0 }),
      '[]',
      'test',
      'human:test',
      '[]',
      '[]',
      `idem_${id}`,
      'never',
      NOW,
      NOW,
    );
  return id;
}

T('an inactive room refuses dispatch, with a reason an operator can act on', async () => {
  const { db } = await fresh();
  await saveRoomConfig(db, TEN, { scope: 'risk', active: false });
  const decision = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(decision.allowed, false);
  if (!decision.allowed) {
    eq(decision.code, 'ROOM_INACTIVE');
    eq(decision.reason.includes('disabled'), true, 'the reason names the fix:');
  }
});

T('budget ceilings bind every autonomy tier', async () => {
  const { db } = await fresh();
  await saveRoomConfig(db, TEN, { scope: 'risk', budgetCeilingDollars: 100 });
  const under = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(under.allowed, true, 'spend under the ceiling dispatches:');

  await requestIn(db, 'risk', 100);
  const at = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(at.allowed, false, 'spend at the ceiling refuses:');
  if (!at.allowed) {
    eq(at.code, 'BUDGET_EXCEEDED');
    eq(at.reason.includes('$100'), true, 'the reason names the ceiling:');
  }
});

T('supervised rooms wait for a human on every dispatch', async () => {
  const { db } = await fresh();
  await saveRoomConfig(db, TEN, { scope: 'risk', autonomy: 'supervised', budgetCeilingDollars: 1000 });
  const decision = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(decision.allowed, false);
  if (!decision.allowed) eq(decision.code, 'SUPERVISED');
});

T('guarded rooms dispatch below the threshold and gate above it', async () => {
  const { db } = await fresh();
  await saveRoomConfig(db, TEN, { scope: 'risk', autonomy: 'guarded', budgetCeilingDollars: 1000 });
  eq(guardedApprovalThresholdDollars(1000), 850, 'the guarded threshold is 85% of the ceiling:');

  await requestIn(db, 'risk', 400);
  const below = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(below.allowed, true, 'under the threshold, guarded rooms dispatch:');

  await requestIn(db, 'risk', 500);
  const above = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(above.allowed, false, 'at the threshold, guarded rooms gate:');
  if (!above.allowed) {
    eq(above.code, 'GUARDED_GATE');
    eq(above.reason.includes('approve'), true, 'the reason asks for approval:');
  }
});

T('autonomous rooms dispatch freely within budget', async () => {
  const { db } = await fresh();
  await saveRoomConfig(db, TEN, { scope: 'risk', autonomy: 'autonomous', budgetCeilingDollars: 1000 });
  await requestIn(db, 'risk', 900);
  const decision = await evaluateDispatch(db, TEN, { targetScope: 'risk' });
  eq(decision.allowed, true, 'autonomous dispatches even past the guarded threshold:');
});

T('scope spend is computed from real requests, not the config', async () => {
  const { db } = await fresh();
  await requestIn(db, 'risk', 250);
  await requestIn(db, 'risk', 125);
  await requestIn(db, 'finance', 999);
  const spend = await scopeSpend(db, TEN, 'risk');
  eq(spend.dollars, 375, 'risk spend sums only risk requests:');
  const finance = await scopeSpend(db, TEN, 'finance');
  eq(finance.dollars, 999, 'scopes do not leak into each other:');
});

T('the worker refuses to dispatch into a supervised room and says why', async () => {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'task',
    kind: 'OBSERVATION',
    statement: 'do work',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:w',
    scope: 'risk',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({
      id: 'sup1',
      goal: 'supervised work',
      claimRefs: [clm.id],
      bid: { dollars: 1, tokens: 1000 },
      targetScope: 'risk',
    }),
  );
  await coord.accept(TEN, request.id);
  await saveRoomConfig(db, TEN, { scope: 'risk', autonomy: 'supervised', budgetCeilingDollars: 1000 });

  const executed: string[] = [];
  const worker = new ApplicationWorker(db, ledger, coord, {
    tenant: TEN,
    adapter: {
      name: 'fake-model',
      category: 'model',
      isTestBaseline: false,
      async run() {
        executed.push('ran');
        throw new Error('must never run');
      },
    } as never,
    dispatchRequests: true,
    relayOutbox: false,
    enableLearningLoop: false,
    sweepIntervalMs: 99_999,
  });
  await worker.tick();

  eq(executed.length, 0, 'nothing executed in a supervised room:');
  // The worker's own status does not carry the errors array (only the last
  // error), so assert on the lastError surface the operator sees.
  eq(
    (worker.status().lastError ?? '').includes('ROOM_GATE') &&
      (worker.status().lastError ?? '').includes('supervised') &&
      (worker.status().lastError ?? '').includes(request.id),
    true,
    'the refusal is visible to the operator:',
  );
});
