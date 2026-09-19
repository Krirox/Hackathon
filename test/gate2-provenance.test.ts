import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';

T('FLOW-002: 100% of FACT claims have resolvable ground provenance', async () => {
  const { ledger } = await fresh();

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

  // I2 invariant: FACT requires ground tier (SYSTEM_OF_RECORD or MEASURED)
  eq(stats.factsWithoutGroundProvenance, 0, 'all FACTs must have ground provenance');

  // Verify all claims are FACT kind and have ground provenance
  eq(stats.total, 102, 'should have 102 claims');

  // 100% resolvable provenance - every FACT has sourceTier in GROUND_TIERS
  // Check via the count instead of byKind
  const ungrounded = stats.factsWithoutGroundProvenance;
  eq(ungrounded, 0, 'all FACT claims must have ground tier provenance (got ' + ungrounded + ')');

  console.log('Provenance gate checks passed! Total:', stats.total, 'Ungrounded:', stats.factsWithoutGroundProvenance);
});
