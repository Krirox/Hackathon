import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';

/**
 * Gov operator identity (console mutations): who approved this, proven —
 * not self-asserted.
 *
 * The old shared-secret floor (`x-vital-operator`) proves the caller knows
 * a secret but says nothing about WHICH human decided; `by` was theater.
 * Ed25519 keys fix that: each operator holds a private key, the server
 * lists public keys, and every mutation carries a signature over the exact
 * decision (tenant, request, action, human). Schnorr/secp256k1 would match
 * the Nostr story, but node:crypto has no secp256k1-schnorr — ed25519 is
 * what the stdlib signs natively, so ed25519 it is. No new dependencies.
 *
 * Canonical message (exact, versioned — verifiers must rebuild it byte for
 * byte): `vital-approve-v1|tenant|requestId|action|by`, where action is
 * `approve` | `decline` for request routes and `correct` for claim
 * corrections (requestId is then the claim id). Fields containing `|` or
 * control characters are refused rather than signed: joining ambiguous
 * fields would let `a|b` as one field verify as two.
 *
 * Signatures travel as base64 in `x-vital-signature`. Key ids are the
 * first 16 hex chars of sha256 over the SPKI DER bytes (stable across
 * PEM re-wraps, short enough for responses, never key material).
 */

export class OperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[operator:${code}] ${message}`);
  }
}

export interface OperatorKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Fresh ed25519 identity: PEM-encoded SPKI public key + PKCS#8 private key. */
export function generateOperatorKey(): OperatorKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const hasFieldSeparator = (s: string): boolean => /[|\r\n\x00]/.test(s);

/**
 * The exact bytes that get signed. Every field is required and must not
 * contain the `|` separator — an unsigned-looking message must never
 * verify, so ambiguous inputs throw instead of producing a signable blob.
 */
export function approvalMessage(tenant: string, requestId: string, action: string, by: string): string {
  for (const [name, v] of [
    ['tenant', tenant],
    ['requestId', requestId],
    ['action', action],
    ['by', by],
  ] as const) {
    if (!v) throw new OperatorError('BAD_APPROVAL_FIELDS', `cannot sign an approval with an empty ${name}`);
    if (hasFieldSeparator(v))
      throw new OperatorError('BAD_APPROVAL_FIELDS', `cannot sign an approval whose ${name} is ambiguous`);
  }
  return `vital-approve-v1|${tenant}|${requestId}|${action}|${by}`;
}

/** Sign the canonical message; returns the base64 wire form. Never logs the key. */
export function signApproval(privateKeyPem: string, msg: string): string {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    // Parse failure only: the message names the problem, never the key.
    throw new OperatorError('BAD_PRIVATE_KEY', 'operator private key is not a parseable PEM');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new OperatorError('BAD_PRIVATE_KEY', 'operator private key is not ed25519');
  try {
    return sign(null, Buffer.from(msg, 'utf8'), key).toString('base64');
  } catch {
    throw new OperatorError('BAD_PRIVATE_KEY', 'operator private key cannot sign');
  }
}

/**
 * True when `sigBase64` is a valid signature over `msg` by this key.
 * Returns false for bad signatures (the caller's 401 path); throws only
 * for unusable keys, which are a deploy-time config error, not a verdict.
 */
export function verifyApproval(publicKeyPem: string, msg: string, sigBase64: string): boolean {
  const key = loadOperatorPublicKey(publicKeyPem);
  if (!sigBase64) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(sigBase64, 'base64');
  } catch {
    return false;
  }
  // Ed25519 signatures are exactly 64 bytes: anything else was never
  // produced by sign() above, so skip the verify call entirely.
  if (sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(msg, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** Stable subject id for responses: first 16 hex of sha256(SPKI DER). */
export function operatorKeyId(publicKeyPem: string): string {
  const key = loadOperatorPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function loadOperatorPublicKey(publicKeyPem: string): ReturnType<typeof createPublicKey> {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new OperatorError('BAD_PUBLIC_KEY', 'operator public key is not a parseable PEM');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new OperatorError('BAD_PUBLIC_KEY', 'operator public key is not ed25519');
  return key;
}

/**
 * Operator key registry (rotation + revocation + human→key assignment).
 *
 * Env config (`VITAL_OPERATOR_KEYS`) names keys but never humans: there is
 * no label, no history, and removing a key means a redeploy. The registry
 * fixes that at runtime, per tenant, in `meta` under `operatorkeys:<tenant>`
 * (a JSON object keyId → { name, pubkeyPem, addedBy, addedAt, revoked }).
 *
 * Three rules, all fail-closed:
 * - entries are never deleted — revocation flips `revoked: true` so the
 *   audit trail still shows who held authority when;
 * - a revoked keyId is rejected everywhere, even if its PEM still sits in
 *   the env list (revocation wins; config cleanup becomes explicit and safe);
 * - a corrupt registry throws loudly (`OPERATOR_REGISTRY_CORRUPT`) instead
 *   of returning an empty set — callers (serve.ts) turn that into a 401,
 *   never a 500 and never an allow. A missing registry is the one quiet
 *   case: no keys means deny-all in key mode, which is fail-closed and
 *   correct.
 *
 * No key material in logs, errors, or audit detail: audit rows carry the
 * keyId + human label, never the PEM.
 */

export interface OperatorKeyEntry {
  keyId: string;
  name: string;
  publicKeyPem: string;
  addedBy: string;
  addedAt: string;
  revoked: boolean;
}

export interface RegisterOperatorKeyInput {
  /** Human label, e.g. `human:priya` — shown back as `keyName`, never signed. */
  name: string;
  publicKeyPem: string;
  addedBy: string;
  now?: string;
}

export interface EffectiveOperatorKey {
  publicKeyPem: string;
  keyId: string;
  /** The registry label, or null for env-only keys (which have no label). */
  name: string | null;
}

const registryKeyOf = (tenant: string): string => `operatorkeys:${tenant}`;

/** Stored row shape (spec-literal `pubkeyPem`); reads accept either spelling. */
interface StoredOperatorKey {
  name?: unknown;
  pubkeyPem?: unknown;
  publicKeyPem?: unknown;
  addedBy?: unknown;
  addedAt?: unknown;
  revoked?: unknown;
}

/**
 * Read + validate the raw registry map. Throws OPERATOR_REGISTRY_CORRUPT
 * on anything unparseable or misshapen — a half-readable registry must
 * never silently become an empty (deny-all surprise) or partial allow-list.
 */
async function readRegistryMap(db: AsyncDb, tenant: string): Promise<Record<string, StoredOperatorKey>> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(registryKeyOf(tenant))) as
    { value: string } | undefined;
  if (!row) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.value));
  } catch {
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} is not an object`);
  return parsed as Record<string, StoredOperatorKey>;
}

function parseRegistryEntry(keyId: string, tenant: string, stored: StoredOperatorKey): OperatorKeyEntry {
  const pem = typeof stored.pubkeyPem === 'string' ? stored.pubkeyPem : stored.publicKeyPem;
  if (typeof stored.name !== 'string' || stored.name.length === 0)
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} holds an unnamed key`);
  if (typeof pem !== 'string' || pem.length === 0)
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} holds a keyless entry`);
  if (typeof stored.addedBy !== 'string' || typeof stored.addedAt !== 'string' || typeof stored.revoked !== 'boolean')
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} holds a misshapen entry`);
  // Recompute the id: a stored PEM that does not hash to its map key is a
  // swap or corruption, not a key — refuse it loudly (never the PEM itself
  // in the message).
  let actual: string;
  try {
    actual = operatorKeyId(pem);
  } catch {
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} holds an unusable key`);
  }
  if (actual !== keyId)
    throw new OperatorError('OPERATOR_REGISTRY_CORRUPT', `operator key registry for ${tenant} holds a mismatched key`);
  return {
    keyId,
    name: stored.name,
    publicKeyPem: pem,
    addedBy: stored.addedBy,
    addedAt: stored.addedAt,
    revoked: stored.revoked,
  };
}

async function writeRegistryMap(db: AsyncDb, tenant: string, map: Record<string, StoredOperatorKey>): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(registryKeyOf(tenant), JSON.stringify(map));
}

/** Every key on record, revoked included (revocation is state, not absence). */
export async function listOperatorKeys(db: AsyncDb, tenant: string): Promise<OperatorKeyEntry[]> {
  const map = await readRegistryMap(db, tenant);
  return Object.entries(map).map(([keyId, stored]) => parseRegistryEntry(keyId, tenant, stored));
}

/** The entry iff present AND not revoked — revoked keys resolve to null. */
export async function resolveOperatorKey(db: AsyncDb, tenant: string, keyId: string): Promise<OperatorKeyEntry | null> {
  const map = await readRegistryMap(db, tenant);
  const stored = map[keyId];
  if (!stored) return null;
  const entry = parseRegistryEntry(keyId, tenant, stored);
  return entry.revoked ? null : entry;
}

/**
 * Assign a public key to a human. Validates the PEM (ed25519, parseable —
 * the error names the problem, never the key), then persists + audits.
 * Re-registering a live keyId throws OPERATOR_KEY_EXISTS; re-registering a
 * revoked one throws OPERATOR_KEY_REVOKED — revocation is monotonic, a key
 * is never resurrected under its old id (rotate to a fresh key instead).
 */
export async function registerOperatorKey(
  db: AsyncDb,
  tenant: string,
  input: RegisterOperatorKeyInput,
): Promise<OperatorKeyEntry> {
  if (!input.name || !input.addedBy)
    throw new OperatorError('BAD_OPERATOR_NAME', 'operator registration needs a human label and an adder');
  const keyId = operatorKeyId(input.publicKeyPem);
  const map = await readRegistryMap(db, tenant);
  const existing = map[keyId];
  if (existing) {
    const entry = parseRegistryEntry(keyId, tenant, existing);
    if (entry.revoked)
      throw new OperatorError('OPERATOR_KEY_REVOKED', `operator key ${keyId} was revoked and cannot be re-registered`);
    throw new OperatorError('OPERATOR_KEY_EXISTS', `operator key ${keyId} is already registered`);
  }
  const at = input.now ?? new Date().toISOString();
  map[keyId] = { name: input.name, pubkeyPem: input.publicKeyPem, addedBy: input.addedBy, addedAt: at, revoked: false };
  await writeRegistryMap(db, tenant, map);
  // Audit carries keyId + label so the trail shows who held authority when;
  // the PEM itself never lands in the log.
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, input.addedBy, 'OPERATOR_KEY_REGISTERED', keyId, JSON.stringify({ keyId, name: input.name }), at);
  return {
    keyId,
    name: input.name,
    publicKeyPem: input.publicKeyPem,
    addedBy: input.addedBy,
    addedAt: at,
    revoked: false,
  };
}

/**
 * Revoke a key: flip the flag, keep the row, audit the removal. Unknown
 * ids throw OPERATOR_KEY_UNKNOWN (a typo must not read as success);
 * re-revoking is an idempotent no-op with no duplicate audit row.
 */
export async function revokeOperatorKey(
  db: AsyncDb,
  tenant: string,
  keyId: string,
  by: string,
  now?: string,
): Promise<OperatorKeyEntry> {
  if (!keyId || !by) throw new OperatorError('BAD_REVOKE_FIELDS', 'revocation needs a key id and a revoker');
  const map = await readRegistryMap(db, tenant);
  const stored = map[keyId];
  if (!stored) throw new OperatorError('OPERATOR_KEY_UNKNOWN', `no operator key ${keyId} on record`);
  const entry = parseRegistryEntry(keyId, tenant, stored);
  if (entry.revoked) return entry;
  const at = now ?? new Date().toISOString();
  const next: StoredOperatorKey = {
    name: entry.name,
    pubkeyPem: entry.publicKeyPem,
    addedBy: entry.addedBy,
    addedAt: entry.addedAt,
    revoked: true,
  };
  map[keyId] = next;
  await writeRegistryMap(db, tenant, map);
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, by, 'OPERATOR_KEY_REVOKED', keyId, JSON.stringify({ keyId, name: entry.name }), at);
  return { ...entry, revoked: true };
}

/**
 * Pure merge of deploy config and runtime state: the effective allow-list
 * is the union of env PEMs and registered non-revoked keys, minus every
 * revoked keyId — including env PEMs whose id was revoked after deploy.
 * Revocation wins everywhere; dedupe is by keyId, and a registry label
 * rides along when one exists (env-only keys keep name null).
 */
export function effectiveKeys(envKeys: string[], registered: OperatorKeyEntry[]): EffectiveOperatorKey[] {
  const revoked = new Set(registered.filter((r) => r.revoked).map((r) => r.keyId));
  const names = new Map<string, string>();
  for (const r of registered) {
    if (!r.revoked && !names.has(r.keyId)) names.set(r.keyId, r.name);
  }
  const out: EffectiveOperatorKey[] = [];
  const seen = new Set<string>();
  for (const pem of envKeys) {
    const keyId = operatorKeyId(pem);
    if (revoked.has(keyId) || seen.has(keyId)) continue;
    seen.add(keyId);
    out.push({ publicKeyPem: pem, keyId, name: names.get(keyId) ?? null });
  }
  for (const r of registered) {
    if (r.revoked || seen.has(r.keyId)) continue;
    seen.add(r.keyId);
    out.push({ publicKeyPem: r.publicKeyPem, keyId: r.keyId, name: r.name });
  }
  return out;
}
