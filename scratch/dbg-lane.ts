import { fresh, TEN, NOW, base, sor } from '../test/helpers.ts';
import { ApplicationWorker, runApplicationWorker } from '../src/substrate/worker.ts';
import { CognitiveRouter } from '../src/router/router.ts';

const { db, ledger, coord, comp } = await fresh();
const clm = await ledger.append({
  tenant: TEN,
  subject: 'test:lane',
  kind: 'OBSERVATION',
  statement: 'x',
  confidence: 1,
  observedAt: NOW,
  validFrom: NOW,
  owner: 'agent:test',
  scope: 'engineering',
  authorType: 'system',
  provenance: sor(),
});
const { request } = await coord.submit(base({ id: 'req-lane', goal: 'draft', claimRefs: [clm.id] }));
const router = new CognitiveRouter(db);
const decision = await router.route({
  tenant: TEN,
  taskType: 'engineering.implement',
  scope: 'engineering',
  actionClass: 'ACT_REVERSIBLE',
  importance: 0.3,
  reversible: true,
  skillCard: null,
  model: 'local-echo',
  now: NOW,
});
console.log('tier', decision.tier, 'shadow', decision.shadow, JSON.stringify(decision.reasons ?? []));
const worker = new ApplicationWorker(db, ledger, coord, {
  tenant: TEN,
  executorLane: 'cloud',
  relayOutbox: false,
});
const res = await worker.tick(NOW);
console.log('tick', JSON.stringify(res), worker.status().lastError);
console.log('requests', JSON.stringify(await db.prepare('SELECT id, state FROM requests').all()));
await db.close();
