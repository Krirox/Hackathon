import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { T, eq, throws } from './helpers.ts';
import {
  deriveNostrKeypair,
  fromWireEvent,
  generateNostrKeypair,
  hexToBytes,
  nip98AuthHeader,
  nostrEventId,
  pubkeyFromSecret,
  signNostrEvent,
  verifyNostrEvent,
  verifySchnorrSignature,
  NostrError,
  NIP98_AUTH_KIND,
} from '../src/talk/nostr.ts';

/**
 * These are the official BIP-340 vectors, copied verbatim from
 * bitcoin/bips `bip-0340/test-vectors.csv`. They are the falsifiable guard on
 * "Vital signs real Nostr events": if the primitives drift, the published
 * events stop being accepted by any Buzz relay, and these fail first.
 *
 * Signing is deterministic *given* `aux_rand`, which is why the vectors pin it.
 * Vector 3 additionally fails if the message is reduced modulo p or n.
 */
const BIP340_VECTORS = [
  {
    index: 0,
    secret: '0000000000000000000000000000000000000000000000000000000000000003',
    pubkey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    message: '0000000000000000000000000000000000000000000000000000000000000000',
    signature:
      'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0',
  },
  {
    index: 1,
    secret: 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef',
    pubkey: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    message: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    signature:
      '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a',
  },
  {
    index: 2,
    secret: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9',
    pubkey: 'dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8',
    aux: 'c87aa53824b4d7ae2eb035a2b5bbbccc080e76cdc6d1692c4b0b62d798e6d906',
    message: '7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c',
    signature:
      '5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7',
  },
  {
    index: 3,
    secret: '0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710',
    pubkey: '25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517',
    aux: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    message: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    signature:
      '7eb0509757e246f19449885651611cb965ecc1a187dd51b64fda1edc9637d5ec97582b9cb13db3933705b32ba982af5af25fd78881ebb32771fc5922efc66ea3',
  },
];

/**
 * Verification-only valid vector (empty secret key): the pubkey has an odd
 * x-coordinate, so this is the `lift_x` edge case that a naive implementation
 * gets wrong. It must verify.
 */
const BIP340_VALID_VERIFY_ONLY = [
  {
    pubkey: 'd69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9',
    message: '4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703',
    signature:
      '00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c6376afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4',
  },
];

/** Verification-only vectors (empty secret key): each must be rejected. */
const BIP340_INVALID = [
  {
    pubkey: 'eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34',
    message: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    signature:
      '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b',
    comment: 'public key not on the curve',
  },
  {
    pubkey: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
    message: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    signature:
      'fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a14602975563cc27944640ac607cd107ae10923d9ef7a73c643e166be5ebeafa34b1ac553e2',
    comment: 'has_even_y(R) is false',
  },
  {
    pubkey: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
    message: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    signature:
      '1fa62e331edbc21c394792d2ab1100a7b432b013df3f6ff4f99fcb33e0e1515f28890b3edb6e7189b630448b515ce4f8622a954cfe545735aaea5134fccdb2bd',
    comment: 'negated message',
  },
];

console.log('\n\x1b[1mNostr — BIP-340 identity over secp256k1\x1b[0m');

T('BIP-340 official vectors reproduce exactly (pubkey, signature, verification)', () => {
  for (const v of BIP340_VECTORS) {
    const secret = hexToBytes(v.secret);
    eq(pubkeyFromSecret(secret), v.pubkey, `vector ${v.index}: pubkey`);
    // The vectors sign a raw 32-byte message, so drive the raw primitive with
    // the pinned aux_rand and compare byte for byte.
    const raw = Buffer.from(schnorr.sign(hexToBytes(v.message), secret, hexToBytes(v.aux))).toString('hex');
    eq(raw, v.signature, `vector ${v.index}: signature matches BIP-340`);
    eq(verifySchnorrSignature(v.signature, v.message, v.pubkey), true, `vector ${v.index}: verifies`);
  }
});

T('vector 0 signed through the event signer verifies over its own event id', () => {
  // Bind the BIP-340 vectors to the production signer: build an event with the
  // vector's key, then check the signature the signer emitted verifies against
  // the event id it computed. If signNostrEvent ever signs the wrong bytes,
  // this fails even though the raw vectors above still pass.
  const kp = { pubkey: BIP340_VECTORS[0]!.pubkey, secretKey: hexToBytes(BIP340_VECTORS[0]!.secret) };
  const evt = signNostrEvent(kp, { kind: 1, tags: [], content: '', createdAt: 0 }, hexToBytes(BIP340_VECTORS[0]!.aux));
  eq(evt.pubkey, BIP340_VECTORS[0]!.pubkey);
  eq(evt.sig.length, 128, 'signature is 64 bytes (128 hex chars)');
  eq(verifyNostrEvent(evt), true, 'the signed event verifies end to end');
});

T('BIP-340 verification-only valid vectors still verify', () => {
  for (const v of BIP340_VALID_VERIFY_ONLY) {
    eq(verifySchnorrSignature(v.signature, v.message, v.pubkey), true, 'odd-x lift_x vector verifies');
  }
});

T('BIP-340 invalid vectors are rejected', () => {
  for (const v of BIP340_INVALID) {
    eq(verifySchnorrSignature(v.signature, v.message, v.pubkey), false, `invalid vector rejected: ${v.comment}`);
  }
});

T('event ids are NIP-01 canonical and signing round-trips', () => {
  const kp = generateNostrKeypair();
  const evt = { kind: 9, tags: [['h', 'chan-x']], content: 'hello "world"\n', createdAt: 1_700_000_000 };
  const signed = signNostrEvent(kp, evt);
  eq(signed.pubkey, kp.pubkey);
  eq(signed.id, nostrEventId(kp.pubkey, evt));
  eq(signed.id.length, 64);
  eq(verifyNostrEvent(signed), true);
});

T('tampering with any field breaks verification', () => {
  const kp = generateNostrKeypair();
  const signed = signNostrEvent(kp, {
    kind: 9,
    tags: [['h', 'chan-x']],
    content: 'original',
    createdAt: 1_700_000_000,
  });
  eq(verifyNostrEvent({ ...signed, content: 'tampered' }), false, 'content change');
  eq(verifyNostrEvent({ ...signed, tags: [['h', 'chan-y']] }), false, 'tag change');
  eq(verifyNostrEvent({ ...signed, createdAt: signed.createdAt + 1 }), false, 'timestamp change');
  eq(verifyNostrEvent({ ...signed, kind: 7 }), false, 'kind change');
  eq(verifyNostrEvent({ ...signed, id: 'f'.repeat(64) }), false, 'forged id');
  eq(verifyNostrEvent({ ...signed, sig: `${signed.sig.slice(0, -2)}00` }), false, 'flipped signature');
  const other = generateNostrKeypair();
  eq(verifyNostrEvent({ ...signed, pubkey: other.pubkey }), false, 'swapped pubkey');
});

T('malformed events are rejected without throwing', () => {
  eq(verifyNostrEvent(null), false);
  eq(verifyNostrEvent({}), false);
  eq(verifyNostrEvent({ pubkey: 'zz', id: 'x', sig: 'y', kind: 9, tags: [], content: '', createdAt: 0 }), false);
  // A short pubkey that is valid hex must not slip through.
  eq(
    verifyNostrEvent({
      pubkey: 'aa'.repeat(32),
      id: 'bb'.repeat(32),
      sig: 'cc'.repeat(32),
      kind: 9,
      tags: [],
      content: '',
      createdAt: 1,
    }),
    false,
    'signature with the wrong scalar is refused',
  );
});

T('NIP-98 auth header carries a verifiable kind-27235 event bound to url, method and payload', () => {
  const kp = generateNostrKeypair();
  const body = JSON.stringify({ ok: true });
  const header = nip98AuthHeader(kp, 'http://localhost:3000/events', 'POST', body, 1_700_000_000);
  eq(header.startsWith('Nostr '), true);
  const decoded = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'));
  eq(decoded.kind, NIP98_AUTH_KIND);
  eq(decoded.pubkey, kp.pubkey);
  // The header carries the Nostr wire shape (`created_at`), which is what a
  // relay deserializes; verification works on the internal shape.
  eq(typeof decoded.created_at, 'number', 'the auth event travels in the wire shape');
  const internal = fromWireEvent(decoded);
  eq(Boolean(internal), true, 'the wire auth event round-trips');
  eq(verifyNostrEvent(internal), true, 'the auth event itself is a valid signed event');
  const tags = new Map(decoded.tags.map((t: string[]) => [t[0], t[1]]));
  eq(tags.get('u'), 'http://localhost:3000/events');
  eq(tags.get('method'), 'POST');
  eq(tags.get('payload'), createHash('sha256').update(body, 'utf8').digest('hex'), 'payload tag binds the body hash');
  // Without a body there is no payload tag to bind.
  const headerNoBody = nip98AuthHeader(kp, 'http://localhost:3000/query', 'GET', undefined, 1);
  const decodedNoBody = JSON.parse(Buffer.from(headerNoBody.slice('Nostr '.length), 'base64').toString('utf8'));
  eq(
    decodedNoBody.tags.some((t: string[]) => t[0] === 'payload'),
    false,
  );
  eq(verifyNostrEvent(fromWireEvent(decodedNoBody)), true);
});

T('agent identities derive deterministically from a master secret, per label', () => {
  const master = 'a'.repeat(64);
  const risk = deriveNostrKeypair(master, 'risk-agent');
  const riskAgain = deriveNostrKeypair(master, 'risk-agent');
  const finance = deriveNostrKeypair(master, 'finance-agent');
  eq(risk.pubkey, riskAgain.pubkey, 'same label derives the same identity');
  eq(risk.pubkey !== finance.pubkey, true, 'different labels are different agents');
  eq(risk.pubkey.length, 64);
  const otherMaster = deriveNostrKeypair('b'.repeat(64), 'risk-agent');
  eq(otherMaster.pubkey !== risk.pubkey, true, 'a different master secret yields a different agent');
  // The master secret must never appear in the derived key.
  eq(Buffer.from(risk.secretKey).toString('hex').includes('aaaaaaaa'), false);
});

T('weak or malformed key material is refused', () => {
  throws(() => deriveNostrKeypair('aabb', 'risk-agent'), 'WEAK_MASTER_SECRET');
  throws(() => deriveNostrKeypair('a'.repeat(64), '   '), 'BAD_LABEL');
  throws(() => hexToBytes('nothex'), 'BAD_HEX');
  throws(() => pubkeyFromSecret(new Uint8Array(31)), 'BAD_SECRET');
  try {
    pubkeyFromSecret(new Uint8Array(32));
    throw new Error('expected a zero secret to be refused');
  } catch (e) {
    eq(e instanceof NostrError, true);
    eq((e as NostrError).code, 'BAD_SECRET');
  }
});
