import { schnorr } from '@noble/curves/secp256k1.js';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Real Nostr cryptography for the Buzz surface.
 *
 * Why this module exists: the previous Buzz integration signed events with a
 * plain `sha256(pubkey + id)` string and derived the "pubkey" as
 * `sha256("vital:agent:<name>")`. Buzz's relay calls `verify_event()` on every
 * ingested event (`crates/buzz-relay/src/handlers/ingest.rs` ->
 * `buzz-core/src/verification.rs`), which requires a valid BIP-340 Schnorr
 * signature over secp256k1 — so every event Vital published would be rejected
 * with `invalid: bad signature`. `node:crypto` cannot do secp256k1-Schnorr
 * (see the note in `src/gov/operator.ts`), which is why this module is the one
 * place in Vital that takes a crypto dependency.
 *
 * Contracts that callers must respect:
 * - A Nostr `pubkey` is the 32-byte x-only public key, lowercase hex (64 chars).
 * - A Nostr `id` is sha256 over the canonical serialization
 *   `[0, pubkey, created_at, kind, tags, content]` (NIP-01). `JSON.stringify`
 *   matches that canonical form: no whitespace, and the only escapes it emits
 *   are the ones NIP-01 permits.
 * - A Nostr `sig` is a 64-byte BIP-340 signature over the raw 32-byte id.
 *
 * Key material never comes from source. Agent identities are derived from a
 * master secret (`BUZZ_AGENT_MASTER_KEY`) so provisioning 12 rooms is
 * idempotent without committing 12 private keys.
 */

export class NostrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[nostr:${code}] ${message}`);
  }
}

export interface NostrKeypair {
  /** 32-byte x-only public key, lowercase hex. Safe to log. */
  readonly pubkey: string;
  /** 32-byte secp256k1 secret. Never log or persist outside a secret store. */
  readonly secretKey: Uint8Array;
}

export interface NostrEventInput {
  kind: number;
  tags: string[][];
  content: string;
  createdAt: number;
}

export interface SignedNostrEvent extends NostrEventInput {
  pubkey: string;
  id: string;
  sig: string;
}

/**
 * The Nostr wire shape. Relays deserialize `created_at`, not `createdAt`
 * (verified against a live Buzz relay, which answers a camelCase body with
 * `invalid event JSON: missing field \`created_at\``). This is the only
 * serialization that may ever be sent to a relay.
 */
export interface WireNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Convert an internally-signed event into the Nostr wire shape. */
export function toWireEvent(evt: SignedNostrEvent): WireNostrEvent {
  return {
    id: evt.id,
    pubkey: evt.pubkey,
    created_at: evt.createdAt,
    kind: evt.kind,
    tags: evt.tags,
    content: evt.content,
    sig: evt.sig,
  };
}

/** Parse a wire event back into the internal shape (for ingest/verification). */
export function fromWireEvent(raw: unknown): SignedNostrEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<WireNostrEvent>;
  if (typeof e.created_at !== 'number') return null;
  if (
    typeof e.id !== 'string' ||
    typeof e.pubkey !== 'string' ||
    typeof e.kind !== 'number' ||
    !Array.isArray(e.tags) ||
    typeof e.content !== 'string' ||
    typeof e.sig !== 'string'
  ) {
    return null;
  }
  return {
    id: e.id,
    pubkey: e.pubkey,
    kind: e.kind,
    tags: e.tags as string[][],
    content: e.content,
    sig: e.sig,
    createdAt: e.created_at,
  };
}

const HEX_RE = /^[0-9a-f]+$/;

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new NostrError('BAD_HEX', `expected even-length lowercase hex, got "${hex.slice(0, 16)}…"`);
  }
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

/** A 32-byte secret is the only valid length for secp256k1. */
function assertSecret(secret: Uint8Array): void {
  if (secret.length !== 32) {
    throw new NostrError('BAD_SECRET', `a secp256k1 secret key is 32 bytes, got ${secret.length}`);
  }
}

/** Derive the x-only public key for a secret. Throws on an invalid secret. */
export function pubkeyFromSecret(secret: Uint8Array): string {
  assertSecret(secret);
  const scalar = BigInt(`0x${bytesToHex(secret)}`);
  if (scalar === 0n) throw new NostrError('BAD_SECRET', 'secret key must be non-zero');
  try {
    return bytesToHex(schnorr.getPublicKey(secret));
  } catch (e) {
    throw new NostrError('BAD_SECRET', `secret key is not a valid secp256k1 scalar: ${(e as Error).message}`);
  }
}

export function nostrKeypairFromSecretHex(secretHex: string): NostrKeypair {
  const secretKey = hexToBytes(secretHex);
  return { secretKey, pubkey: pubkeyFromSecret(secretKey) };
}

/** Fresh random identity — for tests and first-run provisioning. */
export function generateNostrKeypair(): NostrKeypair {
  const secretKey = new Uint8Array(randomBytes(32));
  return { secretKey, pubkey: pubkeyFromSecret(secretKey) };
}

/**
 * Deterministic derivation of one agent identity from a master secret.
 *
 * Deriving (rather than storing) keeps 12 room agent keys out of the source
 * tree and out of the database while staying idempotent: re-running
 * provisioning reproduces the same identities. The master secret is the only
 * thing that must live in a secret store.
 */
export function deriveNostrKeypair(masterSecretHex: string, label: string): NostrKeypair {
  if (!label.trim()) throw new NostrError('BAD_LABEL', 'derivation label must be non-empty');
  // The master secret may be hex or any passphrase-style byte string: HKDF
  // only needs entropy, not an encoding. Hex is validated when it is the
  // obvious shape; anything else is used raw.
  const looksHex = /^[0-9a-fA-F]+$/.test(masterSecretHex) && masterSecretHex.length % 2 === 0;
  const master = looksHex ? hexToBytes(masterSecretHex) : new Uint8Array(Buffer.from(masterSecretHex, 'utf8'));
  if (master.length < 16) {
    throw new NostrError(
      'WEAK_MASTER_SECRET',
      'master secret must be at least 16 bytes (32 hex chars or a longer passphrase)',
    );
  }
  const derived = hkdfSync('sha256', master, Buffer.from('vital-buzz-agent-v1'), Buffer.from(label), 32);
  const secretKey = new Uint8Array(derived);
  return { secretKey, pubkey: pubkeyFromSecret(secretKey) };
}

/** NIP-01 canonical serialization. Verifiers must rebuild this byte for byte. */
export function serializeEvent(pubkey: string, evt: NostrEventInput): string {
  return JSON.stringify([0, pubkey, evt.createdAt, evt.kind, evt.tags, evt.content]);
}

/** NIP-01 event id: sha256 of the canonical serialization. */
export function nostrEventId(
  pubkey: string,
  evtOrCreatedAt: NostrEventInput | number,
  kind?: number,
  tags?: string[][],
  content?: string,
): string {
  const evt: NostrEventInput =
    typeof evtOrCreatedAt === 'number'
      ? { createdAt: evtOrCreatedAt, kind: kind ?? 1, tags: tags ?? [], content: content ?? '' }
      : evtOrCreatedAt;
  return createHash('sha256').update(serializeEvent(pubkey, evt), 'utf8').digest('hex');
}

/**
 * Sign an event with the room agent's key.
 *
 * `auxRand` is left to the library except in tests, where passing the BIP-340
 * vector's `aux_rand` is what makes the signature reproducible.
 */
export function signNostrEvent(kp: NostrKeypair, evt: NostrEventInput, auxRand?: Uint8Array): SignedNostrEvent {
  const id = nostrEventId(kp.pubkey, evt);
  const idBytes = hexToBytes(id);
  let sigBytes: Uint8Array;
  try {
    sigBytes = auxRand ? schnorr.sign(idBytes, kp.secretKey, auxRand) : schnorr.sign(idBytes, kp.secretKey);
  } catch (e) {
    throw new NostrError('SIGN_FAILED', `could not sign event: ${(e as Error).message}`);
  }
  return { ...evt, pubkey: kp.pubkey, id, sig: bytesToHex(sigBytes) };
}

/**
 * Verify an event the way a relay does: recompute the id, then check the
 * Schnorr signature. Returns false rather than throwing — this is used on
 * untrusted input, and every failure mode is a rejection, not a crash.
 */
export function verifyNostrEvent(evt: unknown): boolean {
  if (!evt || typeof evt !== 'object') return false;
  const e = evt as Partial<SignedNostrEvent>;
  if (
    typeof e.pubkey !== 'string' ||
    typeof e.id !== 'string' ||
    typeof e.sig !== 'string' ||
    typeof e.kind !== 'number' ||
    typeof e.content !== 'string' ||
    typeof e.createdAt !== 'number' ||
    !Array.isArray(e.tags)
  ) {
    return false;
  }
  if (e.pubkey.length !== 64 || !HEX_RE.test(e.pubkey)) return false;
  if (e.id.length !== 64 || !HEX_RE.test(e.id)) return false;
  if (e.sig.length !== 128 || !HEX_RE.test(e.sig)) return false;
  if (!e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) return false;
  const expectedId = nostrEventId(e.pubkey, {
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    createdAt: e.createdAt,
  });
  if (expectedId !== e.id) return false;
  return verifySchnorrSignature(e.sig, e.id, e.pubkey);
}

/**
 * Raw BIP-340 check over hex inputs. Exposed so the BIP-340 test vectors can
 * exercise the exact primitive `verifyNostrEvent` uses, rather than trusting
 * the library wrapper. Returns false on any malformed input.
 */
export function verifySchnorrSignature(sigHex: string, messageHex: string, pubkeyHex: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sigHex), hexToBytes(messageHex), hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

/** NIP-98 HTTP auth event kind. */
export const NIP98_AUTH_KIND = 27235;

/**
 * Build the `Authorization: Nostr <base64>` header value a Buzz relay expects.
 *
 * Buzz verifies this event against the exact request URL, HTTP method and body
 * (`buzz-relay/src/api/auth` -> `verify_nip98_event`), so the `u` tag must be
 * the URL the relay itself would reconstruct. The payload tag is included
 * whenever there is a body so the relay can bind the auth event to it.
 */
export function nip98AuthHeader(
  kp: NostrKeypair,
  url: string,
  method: string,
  body?: string,
  createdAt?: number,
): string {
  const bodyHash = body === undefined ? undefined : createHash('sha256').update(body, 'utf8').digest('hex');
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (bodyHash) tags.push(['payload', bodyHash]);
  // A nonce guarantees a distinct auth event id even when two requests to the
  // same URL with the same body land in the same second — otherwise the
  // relay's NIP-98 replay guard (a 120s seen-set on the auth event id)
  // rejects the second request as a replay. Buzz ignores unknown tags.
  tags.push(['nonce', randomBytes(12).toString('hex')]);
  const evt = signNostrEvent(kp, {
    kind: NIP98_AUTH_KIND,
    tags,
    content: '',
    createdAt: createdAt ?? Math.floor(Date.now() / 1000),
  });
  // The auth event travels on the wire too, so it must use the wire shape.
  return `Nostr ${Buffer.from(JSON.stringify(toWireEvent(evt)), 'utf8').toString('base64')}`;
}
