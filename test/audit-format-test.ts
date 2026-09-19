import { T, fresh } from './helpers.ts';

T('check audit detail format', async () => {
  const { ledger } = await fresh();

  // Append a claim and check the audit detail format
  const c = await ledger.append({
    tenant: 'acme',
    subject: 'test',
    kind: 'FACT',
    statement: 'test claim',
    confidence: 1,
    observedAt: '2026-09-09T12:00:00.000Z',
    validFrom: '2026-09-09T12:00:00.000Z',
    owner: 'sync:linear',
    scope: 'marketing',
    authorType: 'system',
    provenance: {
      sourceUri: 'https://example.com',
      sourceTier: 'SYSTEM_OF_RECORD',
      extractor: 'linear-sync',
      extractorVersion: '1.0.0',
      retrievedAt: '2026-09-09T12:00:00.000Z',
    },
    validUntil: null,
  });

  console.log('Claim appended:', c.id);

  // Check the audit log - query by tenant and action
  const db = (ledger as any).db;
  const audits = await db
    .prepare('SELECT * FROM audit_log WHERE tenant = ? AND action = ?')
    .get('acme', 'CLAIM_APPEND');
  console.log('CLAIM_APPEND audit:', JSON.stringify(audits, null, 2));

  // Also check recent audits
  const allAudits = await db.prepare('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq DESC').all('acme');
  console.log('All CLAIM_APPEND audits:', JSON.stringify(allAudits, null, 2));
});
