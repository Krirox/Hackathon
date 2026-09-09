import { T, eq, TEN, NOW, fresh, sor, rejects } from './helpers.ts';
import { createHmacSurface, statementHashOf } from '../src/talk/surface.ts';
console.log('\n\x1b[1mTalk surface — the ledger survives a swap\x1b[0m');

T('a claim bound on one surface verifies; the ledger stores only the opaque binding', async () => {
  const { ledger } = await fresh();
  const c = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: 'Pro is $99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const surface = createHmacSurface('tenant-secret');
  const env = surface.bindClaim({
    claimId: c.id,
    seq: c.seq,
    statementHash: statementHashOf(c.statement),
    scope: c.scope,
    tenant: TEN,
    boundAt: NOW,
  });
  // The ledger carries the envelope as an opaque string — no surface shape leaks in.
  const bound = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'OBSERVATION',
    statement: 'published to talk surface',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'agent',
    buzzEventSig: JSON.stringify(env),
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  const back = surface.verifyEnvelope(JSON.parse(String(bound.buzzEventSig)));
  eq(back.claimId, c.id);
  eq(back.seq, c.seq);
});

T('a tampered binding fails loudly, never degrades silently', async () => {
  const surface = createHmacSurface('tenant-secret');
  const env = surface.bindClaim({
    claimId: 'clm_1',
    seq: 7,
    statementHash: statementHashOf('Pro is $99'),
    scope: 'x',
    tenant: TEN,
    boundAt: NOW,
  });
  await rejects(
    async () =>
      surface.verifyEnvelope({ ...env, binding: { ...env.binding, statementHash: statementHashOf('Pro is $9') } }),
    'TAMPERED_ENVELOPE',
  );
  await rejects(async () => createHmacSurface('other-secret').verifyEnvelope(env), 'TAMPERED_ENVELOPE');
  await rejects(async () => surface.verifyEnvelope({ ...env, surface: 'buzz' }), 'WRONG_SURFACE');
  await rejects(async () => createHmacSurface(''), 'NO_SECRET');
});
