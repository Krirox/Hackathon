import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, normalizeScope, roomForScope } from '../talk/rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { RoomBudgetTracker, type BudgetGasGauge } from '../talk/budget-gauge.ts';
import { LiveCanvasSynchronizer } from '../talk/canvas.ts';
import { describeAutonomy } from '../talk/enforce.ts';
import type { BuzzSurface } from '../talk/buzz.ts';

/**
 * The Buzz workspace — the human-facing room console.
 *
 * Before this page existed, every Buzz capability lived behind unauthenticated
 * JSON APIs that nothing in the product consumed: the health badges, review
 * cards, gauges and slash commands the TODO promised were invisible to the
 * humans they were built for. This module renders them as first-class console
 * pages: a roster of the 12 canonical rooms with live health, and a per-room
 * view with the real relay thread, pending review cards, budget gauge, canvas
 * and a command box.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface BuzzRoomRow {
  scope: string;
  roomName: string;
  health: RoomHealthEvaluation;
  gauge: BudgetGasGauge;
  autonomy: string;
  mission: string;
  active: boolean;
  channelId: string | null;
  provisioned: boolean;
}

export interface BuzzRosterData {
  rooms: BuzzRoomRow[];
  relay: { ok: boolean; detail: string } | null;
}

/** Assemble everything the roster needs. Reuses the evaluators the APIs use. */
export async function buildBuzzRoster(
  db: AsyncDb,
  tenant: string,
  surface?: BuzzSurface | null,
): Promise<BuzzRosterData> {
  const evaluator = new ScopeHealthEvaluator(db, tenant, {});
  const tracker = new RoomBudgetTracker(db, tenant);
  const evaluations = await evaluator.evaluateAll();
  const rooms: BuzzRoomRow[] = [];
  for (const health of evaluations) {
    const config = await loadRoomConfig(db, tenant, health.scope);
    const gauge = await tracker.computeGauge(health.scope);
    rooms.push({
      scope: health.scope,
      roomName: health.roomName,
      health,
      gauge,
      autonomy: config.autonomy,
      mission: config.mission,
      active: config.active,
      channelId: config.channelId ?? null,
      provisioned: Boolean(config.channelId),
    });
  }
  let relay: BuzzRosterData['relay'] = null;
  if (surface) {
    const h = await surface.health();
    relay = {
      ok: h.ok,
      detail: h.ok
        ? `${h.software ?? 'buzz relay'} ${h.version ?? ''} @ ${h.communityHost ?? h.relayUrl} (${h.authMode})`.trim()
        : `relay unreachable: ${h.error ?? 'unknown error'}`,
    };
  }
  return { rooms, relay };
}

export interface BuzzThreadMessage {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  isReviewCard: boolean;
  requestId: string | null;
  threadRoot: string | null;
}

/** Read the room's real relay thread, falling back to local telemetry. */
export async function loadRoomThread(
  db: AsyncDb,
  tenant: string,
  scope: string,
  surface?: BuzzSurface | null,
): Promise<{ messages: BuzzThreadMessage[]; source: 'relay' | 'local'; error?: string }> {
  if (surface) {
    try {
      const config = await loadRoomConfig(db, tenant, scope);
      if (config.channelId) {
        const events = await surface.query([{ kinds: [9], '#h': [config.channelId], limit: 50 }]);
        const messages: BuzzThreadMessage[] = events
          .sort((a, b) => a.created_at - b.created_at)
          .map((ev) => {
            const vitalReq = ev.tags.find((t) => t[0] === 'vital-request');
            const root = ev.tags.find((t) => t[0] === 'e');
            return {
              id: ev.id,
              author: ev.pubkey,
              content: ev.content,
              createdAt: ev.created_at,
              isReviewCard: ev.content.includes('[HUMAN ATTENTION REQUIRED]'),
              requestId: vitalReq?.[1] ?? null,
              threadRoot: root?.[1] ?? null,
            };
          });
        return { messages, source: 'relay' };
      }
    } catch (e) {
      // Fall through to local telemetry rather than an empty page: the room
      // still has health, spend and approvals to show.
      const local = await localRoomActivity(db, tenant, scope);
      return { messages: local, source: 'local', error: (e as Error).message };
    }
  }
  const local = await localRoomActivity(db, tenant, scope);
  return { messages: local, source: 'local' };
}

/** Local stand-in when the relay is not configured: recent audit + approvals. */
async function localRoomActivity(db: AsyncDb, tenant: string, scope: string): Promise<BuzzThreadMessage[]> {
  const rows = (await db
    .prepare(
      `SELECT actor, action, target, detail, at FROM audit_log
       WHERE tenant = ? AND (target LIKE ? OR detail LIKE ?)
       ORDER BY seq DESC LIMIT 20`,
    )
    .all(tenant, `room:${normalizeScope(scope)}%`, `%${normalizeScope(scope)}%`)) as Record<string, unknown>[];
  return rows.reverse().map((r, i) => ({
    id: `local_${i}`,
    author: String(r.actor ?? 'system'),
    content: `${String(r.action)} → ${String(r.target)}${r.detail ? ` · ${String(r.detail).slice(0, 120)}` : ''}`,
    createdAt: Math.floor(Date.parse(String(r.at ?? new Date().toISOString())) / 1000),
    isReviewCard: false,
    requestId: null,
    threadRoot: null,
  }));
}

function fmtTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
}

function autonomyBadge(autonomy: string): string {
  if (autonomy === 'supervised') return '<span style="color:#B45309;">human-in-the-loop</span>';
  if (autonomy === 'guarded') return '<span style="color:#B45309;">guarded</span>';
  return '<span style="color:#047857;">autonomous</span>';
}

/** The roster: every room, its health badge, gauge and provisioning state. */
export function renderBuzzRoster(data: BuzzRosterData, home: string, _csrf: string): string {
  const order = new Map(CANONICAL_ROOMS.map((d, i) => [d.scope, i]));
  const rooms = [...data.rooms].sort((a, b) => (order.get(a.scope) ?? 99) - (order.get(b.scope) ?? 99));

  let relayLine: string;
  if (!data.relay) {
    relayLine = '<p class="sub">Relay not configured — rooms run on local telemetry. Set BUZZ_RELAY_URL and BUZZ_AGENT_MASTER_KEY to go live.</p>';
  } else if (data.relay.ok) {
    relayLine = `<p class="sub" style="color:#047857;">Relay connected: ${esc(data.relay.detail)}</p>`;
  } else {
    relayLine = `<p class="sub" style="color:#B91C1C;">Relay unreachable: ${esc(data.relay.detail)}</p>`;
  }

  const provisionedCount = rooms.filter((r) => r.provisioned).length;
  const unprovisioned = rooms.filter((r) => !r.provisioned);
  const provisionLine =
    unprovisioned.length > 0
      ? `<p class="sub" style="color:#B45309;">${provisionedCount}/${rooms.length} rooms provisioned on the relay. <a href="${esc(home)}setup/rooms">Provision the remaining ${unprovisioned.length}</a>.</p>`
      : `<p class="sub" style="color:#047857;">All ${rooms.length} rooms provisioned.</p>`;

  const rows = rooms
    .map((room) => {
      const flag = room.active ? '' : ' · <span style="color:#B91C1C;">disabled</span>';
      return `<tr>
  <td><a href="${esc(home)}console/buzz/${esc(room.scope)}">${esc(room.health.badge)} #${esc(room.roomName)}</a></td>
  <td><code>${esc(room.scope)}</code></td>
  <td>${autonomyBadge(room.autonomy)}${flag}</td>
  <td>${esc(room.gauge.headerString)}</td>
  <td>${room.health.pendingApprovals > 0 ? `<strong style="color:#B45309;">${room.health.pendingApprovals}</strong>` : '0'}</td>
  <td>${room.health.driftingCards > 0 ? `<strong style="color:#B45309;">${room.health.driftingCards}</strong>` : '0'}</td>
  <td>${room.provisioned ? '<span style="color:#047857;">live</span>' : '<span style="color:#92400E;">not provisioned</span>'}</td>
</tr>`;
    })
    .join('\n');

  return `<section>
  <h1>Buzz Workspace</h1>
  <p>Autonomous agent rooms, one per scope. Rooms run their missions and surface work that needs a human; you step in only when a room turns 🟡 or 🔴.</p>
  ${relayLine}
  ${provisionLine}
  <table style="width:100%;border-collapse:collapse;margin-top:16px;">
    <thead>
      <tr style="text-align:left;border-bottom:1px solid #D8DED9;">
        <th>Room</th><th>Scope</th><th>Autonomy</th><th>Budget</th><th>Awaiting you</th><th>Drift</th><th>Relay</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="sub">Room settings: <a href="${esc(home)}setup/rooms">provisioning &amp; tuning</a>. Approvals also appear under <a href="${esc(home)}#pending-review">Reviews</a>.</p>
</section>`;
}

/** One room: thread, pending approvals, gauge, canvas, command box. */
export async function renderBuzzRoom(
  db: AsyncDb,
  tenant: string,
  rawScope: string,
  home: string,
  csrf: string,
  surface?: BuzzSurface | null,
  notice?: string,
): Promise<string | null> {
  const scope = normalizeScope(rawScope);
  const def = roomForScope(scope);
  if (def.scope !== scope) return null;

  const evaluator = new ScopeHealthEvaluator(db, tenant, {});
  const health = await evaluator.evaluateScope(scope);
  const tracker = new RoomBudgetTracker(db, tenant);
  const gauge = await tracker.computeGauge(scope);
  const config = await loadRoomConfig(db, tenant, scope);
  const thread = await loadRoomThread(db, tenant, scope, surface);

  const canvasSync = new LiveCanvasSynchronizer({ db, tenant });
  const canvas = await canvasSync.generateCanvas(scope);

  const messages = thread.messages
    .map(
      (
        m,
      ) => `<li style="margin:8px 0;list-style:none;${m.isReviewCard ? 'background:#FEF3C7;padding:8px;border-radius:6px;' : ''}">
  <div style="color:#6B7280;font-size:12px;">${esc(fmtTime(m.createdAt))} · <code>${esc(m.author.slice(0, 16))}…</code>${m.requestId ? ` · <code>${esc(m.requestId)}</code>` : ''}</div>
  <div style="white-space:pre-wrap;">${esc(m.content).slice(0, 600)}</div>
</li>`,
    )
    .join('\n');
  const threadList = messages || '<li style="list-style:none;color:#6B7280;">No messages yet in this room.</li>';

  let threadNote: string;
  if (thread.source === 'relay') {
    threadNote = '<p class="sub">Live from the relay.</p>';
  } else if (thread.error) {
    threadNote = `<p class="sub" style="color:#B45309;">Relay unavailable (${esc(thread.error).slice(0, 120)}) — showing local activity.</p>`;
  } else {
    threadNote = '<p class="sub">Local activity (relay not configured for this room).</p>';
  }

  const gates =
    health.pendingApprovals > 0
      ? `<p style="color:#B45309;">🟡 ${health.pendingApprovals} request(s) in this scope are waiting on you — <a href="${esc(home)}#pending-review">review them now</a>.</p>`
      : '';

  return `<section>
  <p><a href="${esc(home)}console/buzz">← Buzz Workspace</a></p>
  ${notice ? `<p style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:8px 12px;">${esc(notice)}</p>` : ''}
  <h1>${esc(health.badge)} #${esc(def.name)}</h1>
  <p class="sub"><code>${esc(config.agentName)}</code> · autonomy: ${autonomyBadge(config.autonomy)} · ${esc(describeAutonomy(config.autonomy as 'autonomous', config.budgetCeilingDollars))}${config.active ? '' : ' · <strong style="color:#B91C1C;">room disabled</strong>'}</p>
  ${gates}
  <p><strong>Mission:</strong> ${esc(config.mission)}</p>
  <p><strong>Budget:</strong> ${esc(gauge.headerString)}</p>
  ${health.reasons.length > 0 ? `<p style="color:#B45309;">${health.reasons.map((r) => `⚠ ${esc(r)}`).join('<br>')}</p>` : ''}
  <h2>Room thread</h2>
  ${threadNote}
  <ul style="padding-left:0;">${threadList}</ul>
  <h2>Send a command</h2>
  <p class="sub">Commands act on this room and are audit-logged: <code>/halt …</code>, <code>/recover …</code>, <code>/status</code>, <code>/cost</code>, <code>/policy set autonomy=…</code></p>
  <form method="post" action="${esc(home)}console/buzz/${esc(scope)}/command">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="text" name="command" placeholder="/status" style="width:70%;padding:8px;">
    <button type="submit" style="padding:8px 16px;">Run</button>
  </form>
  <h2>Live canvas</h2>
  <pre style="background:#F4F6F4;border:1px solid #D8DED9;border-radius:6px;padding:12px;white-space:pre-wrap;">${esc(canvas.markdown).slice(0, 4000)}</pre>
</section>`;
}
