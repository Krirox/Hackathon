import { createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';

/**
 * Governance plane, part 3 (TODO §3.3): approval sampling, batch ceilings,
 * per-capability rate limits. The machinery that keeps oversight honest
 * once autonomous volume exists: a deterministic sample of auto-approved
 * work is force-reviewed, batches are legal only where blast radius is
 * small, and external actions are rate-limited per capability.
 */

export class ReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[review:${code}] ${message}`);
  }
}

/**
 * Deterministic sampling: the same request id always samples the same way,
 * so nobody can re-roll for a kinder draw. Rate is the fraction forced
 * into deep human review (e.g. 0.05).
 */
export function sampleForReview(id: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const v = createHash('sha256').update(`sample:${id}`).digest().readUInt32BE(0) / 0xffffffff;
  return v < rate;
}

/** Split a batch of auto-approved request ids into review vs pass-through. */
export function selectReviewSample(ids: string[], rate: number): { review: string[]; pass: string[] } {
  const review = ids.filter((id) => sampleForReview(id, rate));
  const reviewSet = new Set(review);
  return { review, pass: ids.filter((id) => !reviewSet.has(id)) };
}

export interface BatchItem {
  id: string;
  actionClass: string;
  reversible: boolean;
  dollars: number;
}

/**
 * Batch ceilings: a batch is approvable as one unit only if EVERY item is
 * reversible, low-blast-radius (each under the cap, total under 3× cap),
 * and no item is irreversible. Anything else goes individual, in the open.
 */
export function checkBatch(items: BatchItem[], maxDollarsPerItem: number): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (items.length === 0) return { ok: false, reasons: ['empty batches approve nothing'] };
  for (const it of items) {
    if (it.actionClass === 'ACT_IRREVERSIBLE') reasons.push(`${it.id}: irreversible actions never batch`);
    if (!it.reversible) reasons.push(`${it.id}: irreversible effect never batches`);
    if (it.dollars > maxDollarsPerItem)
      reasons.push(`${it.id}: $${it.dollars} exceeds per-item batch cap $${maxDollarsPerItem}`);
  }
  const total = items.reduce((s, it) => s + it.dollars, 0);
  if (total > maxDollarsPerItem * 3) reasons.push(`batch total $${total} exceeds batch cap $${maxDollarsPerItem * 3}`);
  return { ok: reasons.length === 0, reasons };
}

/** Per-capability external-action rate limit, backed by `meta` counters. */
export async function checkRateLimit(
  db: AsyncDb,
  tenant: string,
  capability: string,
  maxPerDay: number,
  now: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const day = now.slice(0, 10);
  const key = `ratelimit:${tenant}:${capability}:${day}`;
  // Compare-and-swap with bounded retries: the read and the write are one
  // guarded move (UPDATE ... WHERE value = observed), so concurrent callers
  // serialize on the retry instead of overwriting each other's increment.
  // A blind read-then-write would hand two callers the same `used` and count
  // one of them twice — the counter would under-count and the cap would leak.
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, '0');
  for (let attempt = 0; attempt < 25; attempt++) {
    const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
    const used = Number(row?.value ?? 0);
    if (!Number.isFinite(used)) {
      await db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('0', key);
      continue;
    }
    if (used >= maxPerDay) return { allowed: false, remaining: 0 };
    const out = await db
      .prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(String(used + 1), key, String(used));
    if (out.changes === 0) continue;
    return { allowed: true, remaining: maxPerDay - used - 1 };
  }
  return { allowed: false, remaining: 0 };
}
