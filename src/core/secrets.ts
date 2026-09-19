import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for third-party credentials stored in the database
 * (GitHub PATs and the like). AES-256-GCM with a random IV per value;
 * the key comes from VITAL_SECRETS_KEY (64 hex chars or 44-char base64,
 * i.e. 32 bytes) and is never persisted, logged, or returned.
 *
 * Sealed values are self-describing (`vsec1.` prefix), so keyed and
 * unkeyed deployments can be told apart and legacy plaintext rows keep
 * working until they are re-saved. Reading a sealed value without the key
 * throws loudly instead of silently downgrading.
 */

export const SEALED_PREFIX = 'vsec1.';

export function secretsKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.VITAL_SECRETS_KEY ?? '').trim();
  if (!raw) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      throw new Error('[secrets:BAD_KEY] VITAL_SECRETS_KEY must be 64 hex chars or base64 of 32 bytes');
    }
  }
  if (key.length !== 32) {
    throw new Error('[secrets:BAD_KEY] VITAL_SECRETS_KEY must decode to exactly 32 bytes');
  }
  return key;
}

export function isSealed(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEALED_PREFIX}${Buffer.concat([iv, ciphertext, tag]).toString('base64url')}`;
}

export function openSecret(sealed: string, key: Buffer): string {
  if (!isSealed(sealed)) throw new Error('[secrets:NOT_SEALED] value is not a sealed secret');
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
  } catch {
    throw new Error('[secrets:CORRUPT] sealed secret is not decodable');
  }
  if (raw.length < 12 + 16 + 1) throw new Error('[secrets:CORRUPT] sealed secret is truncated');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('[secrets:WRONG_KEY] sealed secret did not open with this key');
  }
}
