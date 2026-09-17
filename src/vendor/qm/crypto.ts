/**
 * PROVENANCE — vendored, not written.
 *   source:        https://github.com/yc-software/qm
 *   commit:        60ba79195dc84aa85a23f238749656e11c88696c (2026-09-08)
 *   upstream path: src/util/crypto.ts (14 lines)
 *   license:       MIT — see LICENSE-THIRD-PARTY.md
 *
 * WHAT WAS CHANGED AND WHY
 *   Nothing. Verbatim copy: imports only `node:crypto`, zero coupling.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hashId(parts: readonly string[], len = 16): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, len);
}

export const shortHash = (s: string): string => hashId([s], 6);
