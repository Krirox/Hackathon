import { T, eq, TEN, NOW, fresh } from './helpers.ts';
import { createLedger } from '../src/ledger/ledger.ts';

T('FLOW-003: staleFactRate computable and < 2%', async () => {
  const { ledger } = await fresh();

  // Add a claim with validUntil in the future - should not be stale
  await ledger.append({
    tenant: TEN,
    subject: 'test',
    kind: 'FACT',
    statement: 'test claim',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:linear',
    scope: 'marketing',
    authorType: 'system',
    provenance: {
      sourceUri: 'https://example.com',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'linear-sync',
      extractorVersion: '1.0.0',
      retrievedAt: NOW,
    },
    validUntil: null, // No expiry = not stale
  });

  const stats = await ledger.stats(TEN, NOW);
  console.log('staleFactRate:', stats.staleFactRate);
  eq(stats.staleFactRate < 0.02, true, 'staleFactRate must be < 2%');
  eq(stats.staleFactRate, 0, 'should be 0 for fresh claims');
});
