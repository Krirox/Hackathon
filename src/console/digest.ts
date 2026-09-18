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
  requestIds: string[];
  startedAt: string;
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
export async function composeDigest(
  db: AsyncDb,
  tenant: string,
  now: string,
  opts: { since?: string } = {},
): Promise<DigestEntry[]> {
  const rows = (
    (await db
      .prepare(
        `SELECT id, goal, origin_scope, updated_at
           FROM requests
          WHERE tenant = ? AND message_class = 'NOTICE' AND updated_at <= ?${opts.since ? ' AND updated_at >= ?' : ''}
          ORDER BY updated_at, id`,
      )
      .all(...(opts.since ? [tenant, now, opts.since] : [tenant, now]))) as {
      id: string;
      goal: string;
      origin_scope: string;
      updated_at: string;
    }[]
  ).map((r) => ({ id: String(r.id), goal: String(r.goal), scope: String(r.origin_scope), at: String(r.updated_at) }));

  const entries: DigestEntry[] = [];
  const latest = new Map<string, DigestEntry>();
  for (const n of rows) {
    const key = JSON.stringify([n.scope, norm(n.goal)]);
    const open = latest.get(key);
    if (open && Date.parse(n.at) - Date.parse(open.updatedAt) <= FOLLOW_ON_WINDOW_MS) {
      open.followOnCount += 1;
      open.requestIds.push(n.id);
      open.updatedAt = n.at;
      continue;
    }
    const entry = {
      requestId: n.id,
      requestIds: [n.id],
      startedAt: n.at,
      goal: n.goal,
      scope: n.scope,
      followOnCount: 0,
      updatedAt: n.at,
    };
    entries.push(entry);
    latest.set(key, entry);
  }
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.requestId.localeCompare(b.requestId));
}

/**
 * Render the digest section for the console HTML — the Feed never shows
 * these; the digest is where they land, visibly but not interruptingly.
 * Uses the same evidence-chip language as the rooms for visual continuity.
 */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function renderDigest(
  coord: Coordinator,
  db: AsyncDb,
  tenant: string,
  now: string,
  opts: { since?: string } = {},
): Promise<string> {
  const entries = await composeDigest(db, tenant, now, opts);
  const window = `<p>NOTICE activity window (UTC): ${opts.since ? esc(opts.since) : 'all recorded history'} through ${esc(now)}, inclusive.</p>
<p>Informational only — no approval required and no review attention consumed. Same-scope topics are grouped when successive notices are at most 24 hours apart within this window; latest activity first.</p>`;
  if (entries.length === 0) return `${window}<p class="sub">Digest empty — no notices in this time window.</p>`;
  const groups: string[] = [];
  for (const entry of entries) {
    const notices: string[] = [];
    for (const id of entry.requestIds) {
      const request = await coord.get(tenant, id);
      if (!request) continue;
      const evidence: string[] = [];
      for (const cid of new Set([...request.claimRefs, ...request.chainClaimIds])) {
        const claim = await db.prepare('SELECT id FROM claims WHERE tenant = ? AND id = ?').get(tenant, cid);
        if (claim) evidence.push(`<a href="/console/claims/${esc(encodeURIComponent(cid))}">Evidence ${esc(cid)}</a>`);
        else evidence.push('Evidence unavailable');
      }
      notices.push(
        `<li><a href="/console/requests/${esc(encodeURIComponent(id))}">Request ${esc(id)}</a> · ${esc(request.updatedAt)}<br>${evidence.join(' · ') || 'No evidence references.'}</li>`,
      );
    }
    groups.push(`<article><h2>${esc(entry.goal)}</h2><p>${esc(entry.scope)} · ${entry.followOnCount + 1} notice(s)${entry.followOnCount ? ` · +${entry.followOnCount} more` : ''}</p>
<p>First activity: ${esc(entry.startedAt)} · Latest activity: ${esc(entry.updatedAt)}</p><ul>${notices.join('')}</ul></article>`);
  }
  return window + groups.join('');
}

export const DIGEST_PATH = '/console/digest';

export type DigestDays = '1' | '7' | '30' | 'all';

export function digestUrl(days?: DigestDays): string {
  if (days === undefined || days === '7') {
    return DIGEST_PATH;
  }
  return `${DIGEST_PATH}?days=${days}`;
}

export function digestWindowSince(now: string, days: DigestDays): string | undefined {
  if (days === 'all') {
    return undefined;
  }
  return new Date(Date.parse(now) - Number(days) * 86_400_000).toISOString();
}

export function digestRequestUrl(id: string): string {
  return `/console/requests/${encodeURIComponent(id)}`;
}

export function digestClaimUrl(id: string): string {
  return `/console/claims/${encodeURIComponent(id)}`;
}

export function consumesReviewAttention(messageClass: string): boolean {
  return messageClass !== 'NOTICE';
}

export interface DigestDestination {
  label: string;
  href: string;
  count: number;
}

export function digestDestination(count: number, days: DigestDays = '7'): DigestDestination {
  return { label: `${count} notices → digest`, href: digestUrl(days), count };
}
