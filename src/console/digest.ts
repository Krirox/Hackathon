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
  // The window note is the page's fixed frame, so it reads as a lead sentence
  // rather than a bare paragraph. The exact since/now instants stay on the page
  // because "the last 7 days" is only auditable if you can see the boundaries.
  const window = `<p class="v-sub">NOTICE activity window (UTC): ${opts.since ? esc(opts.since) : 'all recorded history'} through ${esc(now)}, inclusive.</p>
<p class="v-meta">Informational only — no approval required and no review attention consumed. Same-scope topics are grouped when successive notices are at most 24 hours apart within this window; latest activity first.</p>`;
  if (entries.length === 0) {
    // The window note stays even when empty: "no notices in this window" is
    // only meaningful alongside the window it refers to.
    return `${window}<div class="v-empty" style="margin-top:16px;">
  <h3>Digest empty — no notices in this time window</h3>
  <p>NOTICEs are informational: they never ask for a decision and never consume review attention, so an empty digest is a healthy digest. Widen the window to look further back.</p>
  <p><a class="v-btn v-btn-secondary v-btn-sm" href="${esc(digestUrl('all'))}">Show all history</a></p>
</div>`;
  }
  const groups: string[] = [];
  for (const entry of entries) {
    const notices: string[] = [];
    for (const id of entry.requestIds) {
      const request = await coord.get(tenant, id);
      if (!request) continue;
      const evidence: string[] = [];
      for (const cid of new Set([...request.claimRefs, ...request.chainClaimIds])) {
        const claim = await db.prepare('SELECT id FROM claims WHERE tenant = ? AND id = ?').get(tenant, cid);
        if (claim) evidence.push(`<a href="${esc(digestClaimUrl(cid))}">Evidence ${esc(cid)}</a>`);
        else evidence.push('Evidence unavailable');
      }
      notices.push(
        `<li class="v-row"><span class="v-row-main"><a href="${esc(digestRequestUrl(id))}">Request ${esc(id)}</a><span class="v-meta">${esc(request.updatedAt)}</span></span><span class="v-meta">${evidence.join(' · ') || 'No evidence references.'}</span></li>`,
      );
    }
    const followOn = entry.followOnCount ? `<span class="v-badge">+${entry.followOnCount} more</span>` : '';
    groups.push(`<article class="v-card" style="margin-bottom:14px;">
  <div class="v-split" style="align-items:flex-start;margin-bottom:8px;">
    <div style="min-width:0;">
      <p class="v-eyebrow">${esc(entry.scope)}</p>
      <h2 class="v-card-title" style="margin-top:4px;">${esc(entry.goal)}</h2>
    </div>
    <span class="v-badge"><span class="dot"></span>${entry.followOnCount + 1} notice(s)</span>${followOn}
  </div>
  <p class="v-meta">First activity: ${esc(entry.startedAt)} · Latest activity: ${esc(entry.updatedAt)}</p>
  <ul class="v-list">${notices.join('')}</ul>
</article>`);
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
