import { fresh, TEN, NOW, cardInput, seedTrace, sor } from '../test/helpers.ts';
import { ApplicationWorker } from '../src/substrate/worker.ts';
import { LocalEchoAdapter, type HarnessAdapter } from '../src/substrate/harness.ts';
import { enqueueTransferTest } from '../src/console/learning-actions.ts';

const { db, ledger, coord, comp } = await fresh();
await seedTrace(comp, db, 'tr_run');
const clm = await ledger.append({
  tenant: TEN,
  subject: 'test:dbg',
  kind: 'OBSERVATION',
  statement: 'evidence',
  confidence: 1,
  observedAt: NOW,
  validFrom: NOW,
  owner: 'agent:test',
  scope: 'marketing',
  authorType: 'system',
  provenance: sor(),
});
const card = await comp.compile(cardInput(['tr_run']));
const model: HarnessAdapter = {
  name: 'model-b',
  category: 'model',
  isTestBaseline: false,
  model: 'model-b',
  async run(_t, requestId) {
    return {
      adapter: 'model-b',
      requestId,
      status: 'COMPLETED',
      transcript: 'ok',
      tools: [],
      usage: { input: 1, output: 1 },
      permissions: [],
      isTestBaseline: false,
    };
  },
};
await enqueueTransferTest(db, comp, TEN, {
  cardId: card.id,
  targetScope: 'marketing',
  command: 'draft',
  claimIds: [clm.id],
  maxDollars: 1,
  maxTokens: 5000,
  onBehalfOf: 'human:owner',
  now: NOW,
});
try {
  const sub = await coord.submit({
    tenant: TEN,
    messageClass: 'REQUEST',
    originScope: 'marketing',
    targetScope: 'marketing',
    goal: 'debug submit',
    claimRefs: [clm.id],
    deliverableSchema: 'transfer.v1',
    bid: { dollars: 1, tokens: 5000 },
    onBehalfOf: 'human:owner',
    now: NOW,
  });
  console.log('submit ok', JSON.stringify(sub.request?.state), JSON.stringify(sub));
} catch (e) {
  console.log('submit threw', (e as Error).message);
}

try {
  const runs = await (
    await import('../src/compiler/transfer.ts')
  ).runCrossModelEvidence(coord, comp, TEN, card.id, [model], {
    originScope: 'marketing',
    targetScope: 'marketing',
    command: 'draft',
    claimIds: [clm.id],
    onBehalfOf: 'human:owner',
    maxDollars: 1,
    maxTokens: 5000,
    now: NOW,
  });
  console.log('direct runs', JSON.stringify(runs));
} catch (e) {
  console.log('direct threw', (e as Error).message);
}

const worker = new ApplicationWorker(db, ledger, coord, {
  tenant: TEN,
  dispatchRequests: false,
  transferAdapters: [model, new LocalEchoAdapter(db, ledger, coord)],
});
const r = await worker.tick(NOW);
console.log('outboxProcessed', r.outboxProcessed, 'failed', r.outboxFailed);
console.log('lastError', worker.status().lastError);
console.log('transfers', JSON.stringify(await comp.transferResults(TEN, card.id)));
console.log('requests', JSON.stringify(await db.prepare('SELECT id, state, goal FROM requests').all()));
await db.close();
