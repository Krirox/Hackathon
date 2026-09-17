import { T, eq, rejects, TEN, NOW, fresh } from './helpers.ts';
import {
  approvalMessage,
  effectiveKeys,
  generateOperatorKey,
  listOperatorKeys,
  operatorKeyId,
  registerOperatorKey,
  revokeOperatorKey,
  signApproval,
  verifyApproval,
} from '../src/gov/operator.ts';

console.log('\n\x1b[1mOperator identity — signed approvals, keyed humans\x1b[0m');

/**
 * The console enforces sessions (auth.test.ts covers that path); this module
 * is the underlying identity primitive — who approved this, proven by an
 * Ed25519 signature over the exact decision, not self-asserted in a body.
 * These tests cover the crypto and the registry: keygen→sign→verify,
 * canonical-message refusals, keyId stability, and the fail-closed registry
 * (rotation, revocation-wins-over-env, no deletion, corrupt registry).
 */

T('keygen → sign → verify round-trip; the wrong message or key fails', async () => {
  const { publicKeyPem, privateKeyPem } = generateOperatorKey();
  const msg = approvalMessage(TEN, 'r1', 'approve', 'human:priya');
  const sig = signApproval(privateKeyPem, msg);
  eq(verifyApproval(publicKeyPem, msg, sig), true, 'honest signature verifies:');
  eq(
    verifyApproval(publicKeyPem, approvalMessage(TEN, 'r1', 'decline', 'human:priya'), sig),
    false,
    'a signature over approve does not verify over decline:',
  );
  eq(
    verifyApproval(publicKeyPem, approvalMessage(TEN, 'r2', 'approve', 'human:priya'), sig),
    false,
    'the request id is bound:',
  );
  eq(
    verifyApproval(publicKeyPem, approvalMessage(TEN, 'r1', 'approve', 'human:mallory'), sig),
    false,
    'the human is bound:',
  );
  const { publicKeyPem: stranger } = generateOperatorKey();
  eq(verifyApproval(stranger, msg, sig), false, 'a stranger key never verifies:');
  eq(verifyApproval(publicKeyPem, msg, 'not-base64-signature'), false, 'garbage signature is false, not a throw:');
  eq(verifyApproval(publicKeyPem, msg, ''), false, 'empty signature is false:');
});

T('ambiguous fields refuse to sign; non-ed25519 or garbage keys refuse loudly', async () => {
  const { publicKeyPem, privateKeyPem: _privateKeyPem } = generateOperatorKey();
  // A `|` in a field would let `a|b` as one field verify as two.
  rejects(
    async () => await Promise.resolve(approvalMessage(TEN, 'r|1', 'approve', 'human:priya')),
    'BAD_APPROVAL_FIELDS',
  );
  rejects(async () => await Promise.resolve(approvalMessage(TEN, 'r1', 'approve', '')), 'BAD_APPROVAL_FIELDS');
  rejects(
    async () => await Promise.resolve(signApproval('not a pem', approvalMessage(TEN, 'r1', 'approve', 'h'))),
    'BAD_PRIVATE_KEY',
  );
  rejects(async () => await Promise.resolve(verifyApproval('also not a pem', 'msg', 'sig')), 'BAD_PUBLIC_KEY');
  void publicKeyPem;
});

T('operatorKeyId is stable across PEM re-serialization and distinct per key', async () => {
  const a = generateOperatorKey();
  const b = generateOperatorKey();
  eq(operatorKeyId(a.publicKeyPem), operatorKeyId(a.publicKeyPem), 'same key, same id:');
  eq(operatorKeyId(a.publicKeyPem) === operatorKeyId(b.publicKeyPem), false, 'different keys, different ids:');
  eq(operatorKeyId(a.publicKeyPem).length, 16, '16 hex chars:');
});

T('registry: register, list, revoke — revocation is monotonic and audited', async () => {
  const { db } = await fresh();
  const a = generateOperatorKey();
  const entry = await registerOperatorKey(db, TEN, {
    name: 'priya',
    publicKeyPem: a.publicKeyPem,
    addedBy: 'human:owner',
    now: NOW,
  });
  eq(entry.keyId, operatorKeyId(a.publicKeyPem));
  eq(entry.revoked, false);
  const listed = await listOperatorKeys(db, TEN);
  eq(listed.length, 1);
  eq(listed[0]!.name, 'priya');
  // Re-registering a live key refuses.
  rejects(
    async () =>
      await registerOperatorKey(db, TEN, {
        name: 'again',
        publicKeyPem: a.publicKeyPem,
        addedBy: 'human:owner',
        now: NOW,
      }),
    'OPERATOR_KEY_EXISTS',
  );
  // Revocation flips the flag, keeps the row, and is idempotent.
  const revoked = await revokeOperatorKey(db, TEN, entry.keyId, 'human:owner', NOW);
  eq(revoked.revoked, true);
  eq((await listOperatorKeys(db, TEN)).length, 1, 'the row is kept, not deleted:');
  const again = await revokeOperatorKey(db, TEN, entry.keyId, 'human:owner', NOW);
  eq(again.revoked, true, 're-revoking is a no-op:');
  const audit = (await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'OPERATOR_KEY_REVOKED'")
    .get()) as { n: number };
  eq(audit.n, 1, 'no duplicate audit row for the re-revoke:');
  // A revoked key cannot be re-registered under its old id.
  rejects(
    async () =>
      await registerOperatorKey(db, TEN, {
        name: 'phoenix',
        publicKeyPem: a.publicKeyPem,
        addedBy: 'human:owner',
        now: NOW,
      }),
    'OPERATOR_KEY_REVOKED',
  );
  // Unknown ids refuse.
  rejects(async () => await revokeOperatorKey(db, TEN, 'nope', 'human:owner', NOW), 'OPERATOR_KEY_UNKNOWN');
});

T('effectiveKeys: the union of env and registry, minus every revoked keyId', async () => {
  const keep = generateOperatorKey();
  const drop = generateOperatorKey();
  const regOnly = generateOperatorKey();
  const { db } = await fresh();
  const regEntry = await registerOperatorKey(db, TEN, {
    name: 'registry-human',
    publicKeyPem: regOnly.publicKeyPem,
    addedBy: 'human:owner',
    now: NOW,
  });
  const droppedEntry = await registerOperatorKey(db, TEN, {
    name: 'leaver',
    publicKeyPem: drop.publicKeyPem,
    addedBy: 'human:owner',
    now: NOW,
  });
  await revokeOperatorKey(db, TEN, droppedEntry.keyId, 'human:owner', NOW);
  const envKeys = [keep.publicKeyPem, drop.publicKeyPem];
  const effective = effectiveKeys(envKeys, await listOperatorKeys(db, TEN));
  const ids = effective.map((e) => e.keyId);
  eq(ids.includes(operatorKeyId(keep.publicKeyPem)), true, 'env key survives:');
  eq(ids.includes(droppedEntry.keyId), false, 'revocation wins even against the env list:');
  eq(ids.includes(regEntry.keyId), true, 'registered key joins the allow-list:');
  const reg = effective.find((e) => e.keyId === regEntry.keyId)!;
  eq(reg.name, 'registry-human', 'registry keys carry their human label:');
  const envOnly = effective.find((e) => e.keyId === operatorKeyId(keep.publicKeyPem))!;
  eq(envOnly.name, null, 'env-only keys keep name null — no label invented:');
  // Dedupe: the same key in both places appears once.
  const dup = effectiveKeys([keep.publicKeyPem, keep.publicKeyPem], []);
  eq(dup.length, 1, 'duplicate env keys dedupe by keyId:');
});
