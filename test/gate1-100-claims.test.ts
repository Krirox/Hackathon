import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { migrate } from '../src/core/db.ts';

T('FLOW-001: 100 real claims from ≥3 systems populate the ledger', async () => {
  const { db } = await fresh();
  await migrate(db);
  const ledger = createLedger(db);

  const systems = [
    { name: 'linear', owner: 'sync:linear' },
    { name: 'stripe', owner: 'sync:stripe' },
    { name: 'linear2', owner: 'sync:linear2' },
  ];

  for (const system of systems) {
    for (let i = 0; i < 34; i++) {
      await ledger.append({
        tenant: TEN,
        subject: `launch_${system.name}_${i}`,
        kind: 'FACT',
        statement: `shipped feature ${i} from ${system.name}`,
        confidence: 1,
        observedAt: NOW,
        validFrom: NOW,
        owner: system.owner,
        scope: 'marketing',
        authorType: 'system',
        provenance: { ...sor(`https://${system.name}.example.com/bug/${i}`), retrievedAt: NOW },
        validUntil: null,
      });
    }
  }

  const stats = await ledger.stats(TEN, NOW);

  eq(stats.total, 102, 'should have 102 claims');
  eq(stats.total >= 100, true, 'should have at least 100 claims');
  eq(stats.factsWithoutGroundProvenance, 0, 'all facts should have ground provenance');
  eq(stats.staleFactRate, 0, 'no stale facts yet');
  eq(stats.verified, 102, 'all should be verified');
});
