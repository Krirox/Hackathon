import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';

/**
 * Digest composition (TODO §2.2, built 2026-09-17).
 *
 * NOTICEs are informational: no budget, never a human interrupt. Their
 * contract is "goes to the digest, never the Feed" — the Feed is for work
 * that needs a decision, and an unread informational ping is how escalation
 * fatigue starts. This composes those NOTICEs into one per-scope digest
 * entry from the same tables the console reads; it adds no notification
 * channel of its own (Buzz exists).
 *
 * Queries are scoped to an instant (`now`) so composition is deterministic
 * and replayable — the digest is a read model, not a queue.
 */

export interface DigestEntry {
  /** The NOTICE that opened the group. */
  requestId: string;
  goal: string;
  scope: string;
  /** How many NOTICEs landed on this topic after the first, same normalized goal. */
  followOnCount: number;
  updatedAt: string;
}

/** Window that groups follow-on NOTICEs into one entry, in ms. Default 24h. */
const FOLLOW_ON_WINDOW_MS = 24 * 3_600_000;

/** Normalize a goal so "v1.2 shipped" and "v1.2 shipped " dedupe together. */
const norm = (goal: string): string => goal.trim().toLowerCase();

/**
 * Group the tenant's NOTICEs into digest entries: the first NOTICE on a
 * topic opens the entry; NOTICEs with the same normalized goal inside the
 * window become follow-on counts. Most recent topic first.
 */
export async function composeDigest(db: AsyncDb, tenant: string, now: string): Promise<DigestEntry[]> {
  const rows = (
    (await db
      .prepare(
        `SELECT id, goal, origin_scope, updated_at
           FROM requests
          WHERE tenant = ? AND message_class = 'NOTICE' AND updated_at <= ?
          ORDER BY updated_at`,
      )
      .all(tenant, now)) as { id: string; goal: string; origin_scope: string; updated_at: string }[]
  ).map((r) => ({ id: String(r.id), goal: String(r.goal), scope: String(r.origin_scope), at: String(r.updated_at) }));

  const entries: DigestEntry[] = [];
  for (const n of rows) {
    const open = entries.find((e) => e.scope === n.scope && norm(e.goal) === norm(n.goal));
    if (open && Date.parse(n.at) - Date.parse(open.updatedAt) <= FOLLOW_ON_WINDOW_MS) {
      open.followOnCount += 1;
      open.updatedAt = n.at;
      continue;
    }
    entries.push({ requestId: n.id, goal: n.goal, scope: n.scope, followOnCount: 0, updatedAt: n.at });
  }
  return entries.reverse();
}

/**
 * Render the digest section for the console HTML — the Feed never shows
 * these; the digest is where they land, visibly but not interruptingly.
 * Uses the same evidence-chip language as the rooms for visual continuity.
 */
export async function renderDigest(coord: Coordinator, db: AsyncDb, tenant: string, now: string): Promise<string> {
  const entries = await composeDigest(db, tenant, now);
  if (entries.length === 0) return '<p class="sub">digest empty</p>';
  return entries
    .map(
      (e) =>
        `<div style="border-left:3px solid #E4E4E1;padding:6px 10px;margin:6px 0;">
  <div style="font-size:12px;">${e.goal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')} <span style="color:#6B7280;font-size:11px">${e.followOnCount > 0 ? `+${e.followOnCount} more` : 'notice'} · ${e.scope}</span></div>
</div>`,
    )
    .join('');
}
