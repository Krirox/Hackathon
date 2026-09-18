import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, normalizeScope, roomForScope } from '../talk/rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { RoomBudgetTracker, type BudgetGasGauge } from '../talk/budget-gauge.ts';
import { LiveCanvasSynchronizer } from '../talk/canvas.ts';
import type { BuzzSurface } from '../talk/buzz.ts';
import { listUsers } from '../core/auth.ts';

/**
 * The Workspace (internal: buzz) — the human-facing chat console.
 *
 * User-facing name is Workspace/Rooms, never Buzz — see BUZZ_FINAL_TODO.md.
 * Renders the 12 canonical rooms as a chat workspace (Image 1), not the old
 * ops table (Image 2). Health badges, budget gauges and slash commands are
 * preserved but shown as room presence, not table columns.
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

export async function getReactions(db: AsyncDb, tenant: string, messageIds: string[]): Promise<Map<string, { emoji: string; count: number; me: boolean }[]>> {
  if (messageIds.length === 0) return new Map();
  const ph = messageIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(`SELECT message_id, emoji, COUNT(*) as c FROM buzz_reactions WHERE tenant = ? AND message_id IN (${ph}) GROUP BY message_id, emoji`)
    .all(tenant, ...messageIds)) as { message_id: string; emoji: string; c: number }[];
  const out = new Map<string, { emoji: string; count: number; me: boolean }[]>();
  for (const r of rows) {
    const arr = out.get(String(r.message_id)) ?? [];
    arr.push({ emoji: String(r.emoji), count: Number(r.c), me: false });
    out.set(String(r.message_id), arr);
  }
  return out;
}

export async function toggleReaction(
  db: AsyncDb,
  tenant: string,
  messageId: string,
  emoji: string,
  userId: string,
  now?: string,
): Promise<{ added: boolean; count: number }> {
  const at = now ?? new Date().toISOString();
  const exists = (await db
    .prepare('SELECT 1 FROM buzz_reactions WHERE tenant = ? AND message_id = ? AND emoji = ? AND user_id = ?')
    .get(tenant, messageId, emoji, userId)) as Record<string, unknown> | undefined;
  if (exists) {
    await db.prepare('DELETE FROM buzz_reactions WHERE tenant = ? AND message_id = ? AND emoji = ? AND user_id = ?').run(tenant, messageId, emoji, userId);
  } else {
    await db
      .prepare('INSERT INTO buzz_reactions (tenant, message_id, emoji, user_id, created_at) VALUES (?,?,?, ?, ?)')
      .run(tenant, messageId, emoji, userId, at);
  }
  const cnt = (await db
    .prepare('SELECT COUNT(*) as c FROM buzz_reactions WHERE tenant = ? AND message_id = ? AND emoji = ?')
    .get(tenant, messageId, emoji)) as { c: number } | undefined;
  return { added: !exists, count: Number(cnt?.c ?? 0) };
}

export async function createLocalReply(
  db: AsyncDb,
  tenant: string,
  scope: string,
  parentId: string | null,
  author: string,
  content: string,
  now?: string,
): Promise<string> {
  const at = now ?? new Date().toISOString();
  const id = `msg_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await db
    .prepare('INSERT INTO buzz_messages (id, tenant, scope, parent_id, author, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, tenant, normalizeScope(scope), parentId, author, content.slice(0, 2000), at);
  return id;
}

/** Local stand-in when the relay is not configured: recent audit + approvals. */
async function localRoomActivity(db: AsyncDb, tenant: string, scope: string): Promise<BuzzThreadMessage[]> {
  const localMsgs = (await db
    .prepare('SELECT id, author, content, parent_id, created_at FROM buzz_messages WHERE tenant = ? AND scope = ? ORDER BY created_at ASC LIMIT 50')
    .all(tenant, normalizeScope(scope))) as {
    id: string;
    author: string;
    content: string;
    parent_id: string | null;
    created_at: string;
  }[];
  if (localMsgs.length > 0) {
    return localMsgs.map((r) => ({
      id: String(r.id),
      author: String(r.author),
      content: String(r.content),
      createdAt: Math.floor(Date.parse(String(r.created_at)) / 1000),
      isReviewCard: String(r.content).includes('[HUMAN ATTENTION REQUIRED]'),
      requestId: null,
      threadRoot: r.parent_id ? String(r.parent_id) : null,
    }));
  }
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

function autonomyBadge(autonomy: string): string {
  if (autonomy === 'supervised') return '<span style="color:#B45309;">human-in-the-loop</span>';
  if (autonomy === 'guarded') return '<span style="color:#B45309;">guarded</span>';
  return '<span style="color:#047857;">autonomous</span>';
}

/** The roster: workspace home — sidebar of rooms like Slack/Discord, not a ops table. */
export function renderBuzzRoster(data: BuzzRosterData, home: string, _csrf: string): string {
  const order = new Map(CANONICAL_ROOMS.map((d, i) => [d.scope, i]));
  const rooms = [...data.rooms].sort((a, b) => (order.get(a.scope) ?? 99) - (order.get(b.scope) ?? 99));

  let relayLine: string;
  if (!data.relay) {
    relayLine =
      '<p class="sub" style="background:#F8FAF9;border:1px solid #E6EDE9;border-radius:8px;padding:10px 12px;">Workspace is working locally. Relay not configured — messages stay on this workspace.</p>';
  } else if (data.relay.ok) {
    relayLine = `<p class="sub" style="color:#047857;">Workspace relay connected: ${esc(data.relay.detail)}</p>`;
  } else {
    relayLine = `<p class="sub" style="color:#B91C1C;">Workspace relay unreachable: ${esc(data.relay.detail)}</p>`;
  }

  const provisionedCount = rooms.filter((r) => r.provisioned).length;
  const unprovisioned = rooms.filter((r) => !r.provisioned);
  const provisionLine =
    unprovisioned.length > 0
      ? `<p class="sub" style="color:#B45309;">${provisionedCount}/${rooms.length} rooms ready. <a href="${esc(home)}setup/rooms">Set up the remaining ${unprovisioned.length}</a>.</p>`
      : `<p class="sub" style="color:#047857;">All ${rooms.length} rooms ready.</p>`;

  const sidebar = rooms
    .map((room) => {
      let dot = '🟢';
      if (room.health.status === 'halted') dot = '🔴';
      else if (room.health.status === 'degraded') dot = '🟡';
      else if (!room.active) dot = '⚪';
      const flag = room.active ? '' : ' · disabled';
      const pending =
        room.health.pendingApprovals > 0
          ? ` <span style="background:#FEF3C7;color:#92400E;font-size:11px;padding:2px 6px;border-radius:10px;">${room.health.pendingApprovals}</span>`
          : '';
      const bg = room.health.pendingApprovals > 0 ? 'background:#FFFBEB;' : '';
      return `<a href="${esc(home)}console/buzz/${esc(room.scope)}" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;text-decoration:none;color:#0A0F14;${bg}">
  <span style="font-size:10px;">${dot}</span>
  <span style="font-weight:600;">#${esc(room.roomName)}</span>
  <span style="font-size:11px;color:#6B7280;">${esc(room.scope)}</span>
  <span style="margin-left:auto;font-size:11px;color:#6B7280;">${autonomyBadge(room.autonomy)}${flag}</span>
  ${pending}
</a>`;
    })
    .join('\n');

  const previewRow = (room: (typeof rooms)[number]) =>
    `<div style="display:flex;gap:10px;padding:10px 12px;border:1px solid #E6EDE9;border-radius:8px;background:#fff;align-items:center;">
  <span style="font-size:14px;">${room.health.badge}</span>
  <div style="flex:1;min-width:0;">
    <div style="font-weight:600;font-size:13px;"><a href="${esc(home)}console/buzz/${esc(room.scope)}">#${esc(room.roomName)}</a> <span style="font-weight:400;color:#6B7280;">· ${esc(room.gauge.headerString)}</span></div>
    <div style="font-size:12px;color:#6B7280;">${esc(room.mission.slice(0, 88))}${room.mission.length > 88 ? '…' : ''}</div>
  </div>
  <span style="font-size:12px;">${room.provisioned ? '<span style="color:#047857;">● live</span>' : '<span style="color:#92400E;" title="not provisioned">○ local</span> not provisioned'}</span>
</div>`;

  return `<section>
  <h1 style="font-size:22px;margin-bottom:6px;">Workspace</h1>
  <p class="sub" style="margin-top:0;">Twelve rooms, one per scope. Agents work in their rooms and surface what needs you — step in when a dot turns 🟡 or 🔴.</p>
  ${relayLine}
  ${provisionLine}
  <div style="display:grid;grid-template-columns:280px 1fr;gap:16px;margin-top:16px;align-items:start;">
    <nav aria-label="Rooms" style="background:#F4F7F5;border:1px solid #D8DED9;border-radius:10px;padding:8px;position:sticky;top:16px;">
      <div style="font-size:11px;letter-spacing:0.06em;color:#6B7280;padding:6px 8px 8px;">ROOMS</div>
      ${sidebar}
    </nav>
    <div style="display:grid;gap:10px;">
      ${rooms.map(previewRow).join('\n')}
    </div>
  </div>
  <p class="sub" style="margin-top:16px;">Room settings: <a href="${esc(home)}setup/rooms">provisioning &amp; tuning</a> · Approvals also live under <a href="${esc(home)}#pending-review">Reviews</a>.</p>
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
  const users = await listUsers(db, tenant);
  const userOptions = users.map((u) => `<option value="@${esc(u.name)} (${esc(u.email)})"></option>`).join('');

  const fmtClock = (unixSeconds: number) => {
    const d = new Date(unixSeconds * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', ' ');
  };
  const avatarColor = (key: string) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const hues = ['#E0F2FE', '#FEF3C7', '#F3E8FF', '#DCFCE7', '#FEE2E2', '#E0E7FF'];
    return hues[h % hues.length]!;
  };
  const initials = (name: string) =>
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '•';
  const displayName = (author: string, fallback: string) => {
    if (author.startsWith('local_')) return fallback;
    if (author.includes('@')) return author.split('@')[0]!;
    if (author.length > 16 && /^[0-9a-f]+$/.test(author)) return fallback;
    return author;
  };
  const linkify = (text: string) => {
    let out = esc(text);
    out = out.replace(/(BUZ-\d+)/g, '<a href="#" style="color:#0F5C57;text-decoration:underline;">$1</a>');
    out = out.replace(/@([A-Za-z ]+?)(?=\s|[—]|$)/g, '<span style="background:#E0F2FE;padding:1px 4px;border-radius:4px;">@$1</span>');
    out = out.replace(/\[([^\]]+)\]/g, '<code style="background:#F4F7F5;padding:1px 4px;border-radius:4px;">$1</code>');
    return out;
  };
  const reactionMap = await getReactions(
    db,
    tenant,
    thread.messages.map((m) => m.id),
  );
  const messages = thread.messages
    .map((m) => {
      const who = displayName(m.author, config.agentName);
      const isCard = m.isReviewCard;
      const time = fmtClock(m.createdAt);
      const cardExtra = isCard
        ? `<div style="margin-top:8px;padding:10px 12px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;display:flex;gap:10px;align-items:center;">
  <span style="width:28px;height:28px;border-radius:6px;background:#EFF6FF;display:grid;place-items:center;font-size:14px;">◈</span>
  <div><div style="font-size:12px;color:#6B7280;">Linear · issue</div><div style="font-weight:600;font-size:13px;">${esc(m.requestId ?? 'Review')} · ${esc(m.content.slice(0, 48))}</div></div>
</div>`
        : '';
      const stored = reactionMap.get(m.id) ?? [];
      const picker = ['✅', '🚀', '❤️'];
      const reactionForms = stored
        .map(
          (r) =>
            `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(r.emoji)}"><button type="submit" style="border:1px solid #E5E7EB;border-radius:999px;padding:2px 7px;font-size:11px;background:#F9FAFB;cursor:pointer;">${esc(r.emoji)} ${r.count}</button></form>`,
        )
        .join('');
      const addPickers = picker
        .map(
          (e) =>
            `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(e)}"><button type="submit" title="React ${esc(e)}" style="border:1px dashed #D1D5DB;border-radius:999px;padding:2px 6px;font-size:11px;background:#fff;cursor:pointer;opacity:0.7;">${esc(e)}</button></form>`,
        )
        .join('');
      const reactions = isCard
        ? ''
        : `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">${reactionForms}${addPickers}<span style="font-size:11px;color:#9CA3AF;margin-left:4px;">· <a href="#reply-${esc(m.id)}" style="color:#6B7280;text-decoration:none;">Reply</a></span></div>`;
      const isReply = Boolean(m.threadRoot);
      const bubble = isCard
        ? `<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:10px;padding:10px 12px;"><div style="white-space:pre-wrap;font-size:13px;line-height:1.5;">${linkify(m.content.slice(0, 700))}</div>${cardExtra}</div>`
        : `<div style="white-space:pre-wrap;font-size:13.5px;line-height:1.5;color:#111827;">${linkify(m.content.slice(0, 700))}</div>`;
      return `<li id="msg-${esc(m.id)}" style="display:flex;gap:10px;padding:10px 0 10px ${isReply ? '28px' : '0'};border-bottom:1px solid #F3F4F6;list-style:none;${isReply ? 'background:#F9FAFB;margin-left:32px;border-left:2px solid #E5E7EB;padding-left:10px;border-radius:6px;' : ''}">
  <div style="width:32px;height:32px;border-radius:999px;background:${avatarColor(who)};display:grid;place-items:center;font-size:11px;font-weight:700;color:#374151;flex-shrink:0;">${esc(initials(who))}</div>
  <div style="flex:1;min-width:0;">
    <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;"><span style="font-weight:600;font-size:13px;">${esc(who)}</span><span style="font-size:11px;color:#6B7280;">${esc(time)}</span>${m.requestId ? `<span style="font-size:11px;color:#6B7280;">· <code>${esc(m.requestId.slice(0, 10))}</code></span>` : ''}</div>
    <div style="margin-top:3px;">${bubble}</div>
    ${reactions}
    <form id="reply-${esc(m.id)}" method="post" action="${esc(home)}console/buzz/${esc(scope)}/reply" style="display:flex;gap:6px;margin-top:8px;">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="parentId" value="${esc(m.id)}">
      <input type="text" name="content" placeholder="Reply…" style="flex:1;border:1px solid #E5E7EB;border-radius:999px;padding:5px 10px;font-size:12px;" maxlength="500">
      <button type="submit" style="border:0;background:#0F5C57;color:#fff;border-radius:999px;padding:5px 10px;font-size:11px;cursor:pointer;">Reply</button>
    </form>
  </div>
</li>`;
    })
    .join('\n');
  const threadList =
    messages ||
    `<li style="list-style:none;padding:18px;text-align:center;color:#6B7280;">
  <div style="font-size:13px;">No messages yet in #${esc(def.name)}</div>
  <div style="font-size:12px;margin-top:4px;">Agents will post progress here. Try <code>/status</code> below.</div>
</li>`;

  let threadNote: string;
  if (thread.source === 'relay') {
    threadNote = '<span style="font-size:11px;color:#047857;">● Live from relay</span>';
  } else if (thread.error) {
    threadNote = `<span style="font-size:11px;color:#B45309;">○ Relay unavailable — showing local activity</span>`;
  } else {
    threadNote = '<span style="font-size:11px;color:#6B7280;">○ Local workspace</span>';
  }

  const gates =
    health.pendingApprovals > 0
      ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:#92400E;">🟡 ${health.pendingApprovals} request(s) waiting — <a href="${esc(home)}#pending-review">review now</a></div>`
      : '';

  return `<section style="max-width:860px;margin:0 auto;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;"><a href="${esc(home)}console/buzz" style="font-size:13px;color:#0F5C57;text-decoration:none;">← Workspace</a><span style="margin-left:auto;">${threadNote}</span></div>
  ${notice ? `<div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;">${esc(notice)}</div>` : ''}
  <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;"><h1 style="font-size:20px;margin:0;">#${esc(def.name)}</h1><span style="font-size:13px;">${esc(health.badge)}</span><span style="font-size:12px;color:#6B7280;"><code>${esc(config.agentName)}</code> · ${autonomyBadge(config.autonomy)}</span></div>
  <div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(config.mission)} · ${esc(gauge.headerString)}${config.active ? '' : ' · <strong style="color:#B91C1C;">disabled</strong>'}</div>
  ${gates}
  ${health.reasons.length > 0 ? `<div style="margin-top:8px;font-size:12px;color:#B45309;">${health.reasons.map((r) => `⚠ ${esc(r)}`).join('<br>')}</div>` : ''}
  <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;margin-top:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04);">
    <div style="max-height:62vh;overflow:auto;padding:4px 16px;">
      <ul style="padding:0;margin:0;">${threadList}</ul>
    </div>
    <div style="border-top:1px solid #E5E7EB;padding:10px 12px;background:#F9FAFB;position:relative;">
      <h2 style="font-size:13px;margin:0 0 8px;color:#374151;">Send a command</h2>
      <form method="post" action="${esc(home)}console/buzz/${esc(scope)}/command" style="display:flex;flex-direction:column;gap:8px;">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div style="display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #D1D5DB;border-radius:10px;padding:8px 10px;box-shadow:0 1px 2px rgba(0,0,0,0.04);position:relative;">
          <input type="text" name="command" id="buzz-composer" list="buzz-commands" placeholder="Message #${esc(def.name)}" style="flex:1;border:0;outline:none;font-size:13px;" autocomplete="off">
          <datalist id="buzz-commands">
            <option value="/halt " label="Halt room — engage kill switch"></option>
            <option value="/recover " label="Recover room"></option>
            <option value="/status" label="Room health & spend"></option>
            <option value="/cost" label="Budget gauge"></option>
            <option value="/policy set autonomy=guarded" label="Set autonomy"></option>
          </datalist>
          <datalist id="buzz-users">${userOptions}</datalist>
          <button type="submit" style="width:28px;height:28px;border-radius:999px;border:0;background:#0F5C57;color:#fff;display:grid;place-items:center;cursor:pointer;">↑</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:#6B7280;flex-wrap:wrap;">
          <span style="display:flex;gap:6px;align-items:center;">
            <button type="button" id="buzz-at" style="border:1px solid #E5E7EB;background:#fff;border-radius:999px;padding:2px 7px;font-size:11px;cursor:pointer;" title="Mention someone">@</button>
            <button type="button" style="border:0;background:transparent;cursor:pointer;" title="Attach">📎</button>
            <button type="button" id="buzz-emoji" style="border:0;background:transparent;cursor:pointer;" title="Emoji">😊</button>
            <button type="button" style="border:0;background:transparent;cursor:pointer;" title="Format">Aa</button>
          </span>
          <span style="margin-left:auto;">Type <code>/</code> for commands · <code>/halt</code> <code>/recover</code> <code>/status</code> <code>/cost</code></span>
        </div>
        <div id="buzz-emoji-pick" style="display:none;gap:6px;flex-wrap:wrap;margin-top:4px;">
          ${['😀', '😂', '❤️', '🚀', '✅', '👀', '🎉', '👍', '🔥', '💡'].map((e) => `<button type="button" data-emoji="${esc(e)}" style="border:1px solid #E5E7EB;background:#fff;border-radius:8px;padding:4px 7px;cursor:pointer;">${esc(e)}</button>`).join('')}
        </div>
      </form>
      <script>try{
        const i=document.getElementById('buzz-composer');
        const at=document.getElementById('buzz-at');
        const em=document.getElementById('buzz-emoji');
        const pick=document.getElementById('buzz-emoji-pick');
        if(at&&i){at.addEventListener('click',()=>{const s=i.selectionStart??i.value.length;const v=i.value;i.value=v.slice(0,s)+'@'+v.slice(s);i.focus();i.setSelectionRange(s+1,s+1);i.setAttribute('list','buzz-users');try{i.showPicker&&i.showPicker();}catch{}});}
        if(em&&pick){em.addEventListener('click',()=>{pick.style.display=pick.style.display==='none'?'flex':'none';});pick.querySelectorAll('[data-emoji]').forEach(b=>b.addEventListener('click',()=>{const s=i.selectionStart??i.value.length;const v=i.value;i.value=v.slice(0,s)+b.dataset.emoji+v.slice(s);i.focus();pick.style.display='none';}));}
        if(i){i.addEventListener('input',()=>{if(i.value.includes('@'))i.setAttribute('list','buzz-users');});i.addEventListener('keydown',e=>{if(e.key==='/'&&!i.value){i.setAttribute('list','buzz-commands');}});}
      }catch{}</script>
    </div>
  </div>
  <details style="margin-top:14px;"><summary style="font-size:13px;color:#6B7280;cursor:pointer;">Live canvas &amp; budget</summary>
    <pre style="background:#F4F7F5;border:1px solid #D8DED9;border-radius:6px;padding:12px;white-space:pre-wrap;margin-top:8px;font-size:12px;">${esc(canvas.markdown).slice(0, 4000)}</pre>
    <p style="font-size:12px;color:#6B7280;margin-top:6px;"><strong>Budget:</strong> ${esc(gauge.headerString)}</p>
  </details>
</section>`;
}
