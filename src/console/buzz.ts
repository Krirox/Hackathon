import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, normalizeScope, roomForScope } from '../talk/rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { RoomBudgetTracker, type BudgetGasGauge } from '../talk/budget-gauge.ts';
import { LiveCanvasSynchronizer } from '../talk/canvas.ts';
import type { BuzzSurface } from '../talk/buzz.ts';
import type { Coordinator } from '../coord/coordinator.ts';
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

export async function getReactions(
  db: AsyncDb,
  tenant: string,
  messageIds: string[],
  currentUserId?: string,
): Promise<Map<string, { emoji: string; count: number; me: boolean }[]>> {
  if (messageIds.length === 0) return new Map();
  const ph = messageIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(`SELECT message_id, emoji, COUNT(*) as c FROM buzz_reactions WHERE tenant = ? AND message_id IN (${ph}) GROUP BY message_id, emoji`)
    .all(tenant, ...messageIds)) as { message_id: string; emoji: string; c: number }[];
  const meRows = currentUserId
    ? ((await db
        .prepare(`SELECT message_id, emoji FROM buzz_reactions WHERE tenant = ? AND user_id = ? AND message_id IN (${ph})`)
        .all(tenant, currentUserId, ...messageIds)) as { message_id: string; emoji: string }[])
    : [];
  const meSet = new Set(meRows.map((r) => `${String(r.message_id)}::${String(r.emoji)}`));
  const out = new Map<string, { emoji: string; count: number; me: boolean }[]>();
  for (const r of rows) {
    const key = `${String(r.message_id)}::${String(r.emoji)}`;
    const arr = out.get(String(r.message_id)) ?? [];
    arr.push({ emoji: String(r.emoji), count: Number(r.c), me: meSet.has(key) });
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

/** The roster: Slack-style channel browser. The sidebar (in the shell)
 *  already lists every room, so this page is the directory, not a second
 *  sidebar. */
export function renderBuzzRoster(data: BuzzRosterData, home: string, _csrf: string): string {
  const order = new Map(CANONICAL_ROOMS.map((d, i) => [d.scope, i]));
  const rooms = [...data.rooms].sort((a, b) => (order.get(a.scope) ?? 99) - (order.get(b.scope) ?? 99));

  let relayLine: string;
  if (!data.relay) {
    relayLine =
      '<p style="font-size:13px;color:#616061;background:#F8F8F8;border:1px solid #DDDDDD;border-radius:8px;padding:8px 12px;">Relay not configured — working locally. Messages stay on this workspace.</p>';
  } else if (data.relay.ok) {
    relayLine = `<p style="font-size:13px;color:#2BAC76;">Relay connected: ${esc(data.relay.detail)}</p>`;
  } else {
    relayLine = `<p style="font-size:13px;color:#E01E5A;">Relay unreachable: ${esc(data.relay.detail)}</p>`;
  }

  const provisionedCount = rooms.filter((r) => r.provisioned).length;
  const unprovisioned = rooms.filter((r) => !r.provisioned);
  const provisionLine =
    unprovisioned.length > 0
      ? `<p style="font-size:13px;color:#616061;">${provisionedCount}/${rooms.length} rooms live · <a href="${esc(home)}setup/rooms">set up the rest</a></p>`
      : `<p style="font-size:13px;color:#2BAC76;">All ${rooms.length} rooms live.</p>`;

  const row = (room: (typeof rooms)[number]) => {
    const live = room.provisioned
      ? '<span style="color:#2BAC76;">● live</span>'
      : '<span style="color:#ECB22E;" title="not provisioned">○ local</span> not provisioned';
    const pending =
      room.health.pendingApprovals > 0
        ? ` <span style="background:#CD2553;color:#fff;font-size:11px;font-weight:700;min-width:20px;height:20px;display:inline-grid;place-items:center;border-radius:999px;padding:0 6px;">${room.health.pendingApprovals}</span>`
        : '';
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 4px;border-bottom:1px solid #E8E8E8;">
  <span style="font-size:15px;margin-top:1px;">${room.health.badge}</span>
  <div style="flex:1;min-width:0;">
    <div style="font-size:15px;"><a href="${esc(home)}console/buzz/${esc(room.scope)}" style="font-weight:700;color:#1D1C1D;">#${esc(room.roomName)}</a>${pending} <span style="font-weight:400;color:#616061;font-size:12px;">· ${esc(room.gauge.headerString)}</span></div>
    <div style="font-size:13px;color:#616061;margin-top:2px;overflow:hidden;text-overflow:ellipsis;">${esc(room.mission.slice(0, 110))}${room.mission.length > 110 ? '…' : ''}</div>
    <div style="font-size:12px;color:#868686;margin-top:2px;">${esc(room.scope)} · ${autonomyBadge(room.autonomy)}${room.active ? '' : ' · disabled'} · ${live}</div>
  </div>
  <a href="${esc(home)}console/buzz/${esc(room.scope)}" style="flex-shrink:0;font-size:13px;font-weight:600;border:1px solid #DDDDDD;border-radius:6px;padding:6px 12px;color:#1D1C1D;text-decoration:none;background:#fff;">View</a>
</div>`;
  };

  return `<section style="padding:26px 32px;max-width:920px;">
  <h1 style="font-size:20px;margin:0 0 4px;color:#1D1C1D;">Browse channels</h1>
  <p style="font-size:13px;color:#616061;margin:0 0 12px;">One room per scope. Agents work in their rooms and surface what needs you.</p>
  ${relayLine}
  ${provisionLine}
  <input type="search" id="buzz-filter" placeholder="Search channels" aria-label="Search channels" style="width:100%;max-width:420px;border:1px solid #DDDDDD;border-radius:6px;padding:8px 12px;font-size:13px;margin:8px 0 4px;">
  <div id="buzz-list">${rooms.map(row).join('\n')}</div>
  <p style="font-size:12px;color:#868686;margin-top:14px;">Room settings: <a href="${esc(home)}setup/rooms">provisioning &amp; tuning</a></p>
  <script>try{const f=document.getElementById('buzz-filter');const l=document.getElementById('buzz-list');if(f&&l){f.addEventListener('input',()=>{const q=f.value.toLowerCase();for(const d of l.children){d.style.display=d.textContent.toLowerCase().includes(q)?'':'none';}});}}catch{}</script>
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
  currentUserId?: string,
  coord?: Coordinator,
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
  const userList = users.map((u) => `<option value="@${esc(u.name)} (${esc(u.email)})"></option>`);
  const agentList = CANONICAL_ROOMS.map((r) => `<option value="@${esc(r.agentName)} (#${esc(r.name)})"></option>`);
  agentList.push('<option value="@marketing-agent (#growth / marketing)"></option>');
  const userOptions = [...agentList, ...userList].join('');
  const pendingForRoom: { id: string; goal: string; updatedAt: string }[] = [];
  if (coord) {
    try {
      const allPending = await coord.list(tenant, { state: 'ADMITTED' });
      for (const r of allPending) {
        if (r.bid.humanMinutes > 0) pendingForRoom.push({ id: r.id, goal: r.goal, updatedAt: r.updatedAt });
      }
    } catch (e) {
      void e;
    }
  }
  const reviewReqs = new Map<string, { updatedAt: string; state: string }>();
  if (coord) {
    for (const m of thread.messages) {
      if (m.isReviewCard && m.requestId) {
        try {
          const r = await coord.get(tenant, m.requestId);
          if (r) reviewReqs.set(m.requestId, { updatedAt: r.updatedAt, state: r.state });
        } catch (e) {
          void e;
        }
      }
    }
  }

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
    out = out.replace(/@([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)(?=\s|[—]|[:]|;|,|$)/g, '<span style="background:#E8F5FA;color:#1264A3;font-weight:600;padding:2px 6px;border-radius:4px;display:inline-block;">@$1</span>');
    out = out.replace(/\[([^\]]+)\]/g, '<code style="background:#F1F5F9;border:1px solid #E2E8F0;color:#0F172A;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px;">$1</code>');
    return out;
  };
  const pendingHtml = pendingForRoom
    .map(
      (r) => `<li style="display:flex;gap:10px;padding:10px 12px;border:1px solid #DDDDDD;border-left:3px solid #ECB22E;background:#fff;border-radius:8px;margin:8px 0;list-style:none;">
    <div style="width:36px;height:36px;border-radius:6px;background:#FFF7E6;display:grid;place-items:center;flex-shrink:0;font-size:16px;">⚠️</div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;color:#868686;">Approval requested · ${esc(r.id.slice(0, 12))}</div>
      <div style="font-weight:600;font-size:13.5px;color:#1D1C1D;white-space:pre-wrap;margin-top:2px;">${esc(r.goal)}</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <form data-review-action="approve" action="/api/requests/${esc(r.id)}/approve" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <label style="display:inline-flex;gap:4px;align-items:center;font-size:11px;color:#616061;"><input type="checkbox" name="confirmed" required> reviewed</label>
          <button type="submit" disabled style="padding:6px 14px;border:0;border-radius:6px;background:#007A5A;color:#fff;font-weight:700;cursor:pointer;font-size:12.5px;">Approve</button>
        </form>
        <form data-review-action="decline" action="/api/requests/${esc(r.id)}/decline" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <input type="text" name="reason" placeholder="Decline reason" required style="padding:6px 8px;border:1px solid #DDDDDD;border-radius:6px;font-size:12px;width:150px;">
          <button type="submit" disabled style="padding:6px 14px;border:1px solid #DDDDDD;border-radius:6px;background:#fff;color:#1D1C1D;font-weight:600;cursor:pointer;font-size:12.5px;">Decline</button>
        </form>
      </div>
      <p role="status" aria-live="polite" data-review-status style="font-size:11px;margin-top:6px;"></p>
    </div>
  </li>`,
    )
    .join('\n');
  const reactionMap = await getReactions(
    db,
    tenant,
    thread.messages.map((m) => m.id),
    currentUserId,
  );
  // Thread pagination: group replies under their root, cap visible to 3 + collapse
  const all = thread.messages;
  const byRoot = new Map<string, typeof all>();
  const tops: typeof all = [];
  for (const m of all) {
    if (m.threadRoot) {
      const arr = byRoot.get(m.threadRoot) ?? [];
      arr.push(m);
      byRoot.set(m.threadRoot, arr);
    } else {
      tops.push(m);
    }
  }
  // Orphan replies (parent is an audit stub like local_0) — synthesize a thread
  // header so the 5 replies still collapse under one group instead of 5 tops.
  for (const [root, replies] of [...byRoot]) {
    if (!all.some((m) => m.id === root)) {
      const first = replies[0]!;
      const synth = {
        id: root,
        author: 'system',
        content: `Thread ${root}`,
        createdAt: first.createdAt - 1,
        isReviewCard: false,
        requestId: null,
        threadRoot: null,
      };
      tops.unshift(synth as (typeof all)[number]);
      // keep replies grouped under the synthetic root
    }
  }
  const messages = tops
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
        .map((r) => {
          const mine = r.me ? 'background:#E8F5FA;border-color:#1D9BD1;color:#1264A3;' : 'background:#F8FAFC;border-color:#E2E8F0;color:#1D1C1D;';
          return `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(r.emoji)}"><button type="submit" title="${r.me ? 'You reacted' : 'React'}" style="border:1px solid;border-radius:12px;padding:2px 8px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .1s;${mine}">${esc(r.emoji)} <span style="font-weight:600;">${r.count}</span></button></form>`;
        })
        .join('');
      const addPickers = picker
        .map(
          (e) =>
            `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(e)}"><button type="submit" title="React ${esc(e)}" style="border:1px solid transparent;border-radius:16px;padding:2px 6px;font-size:12px;background:transparent;cursor:pointer;opacity:.55;">${esc(e)}</button></form>`,
        )
        .join('');
      const reactions = isCard
        ? ''
        : `<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;align-items:center;">${reactionForms}${addPickers}</div>`;
      const doneMatch = /^Work done — v(\d+)/.exec(m.content);
      const doneArrow = doneMatch
        ? `<div style="margin-top:8px;"><a href="/console/deliverables/by-request/${esc(m.requestId ?? '')}" style="display:inline-flex;gap:6px;align-items:center;font-size:12px;font-weight:600;color:#0F5C57;text-decoration:none;border:1px solid #A7F3D0;background:#ECFDF5;border-radius:8px;padding:6px 10px;">→ View diff (v${esc(doneMatch[1]!)})</a></div>`
        : ``;
      const bubble = isCard
        ? `<div style="border-left:3px solid #ECB22E;background:#FFFBEB;border-radius:0 8px 8px 0;padding:10px 12px;"><div style="white-space:pre-wrap;font-size:13.5px;line-height:1.45;color:#1D1C1D;">${linkify(m.content.slice(0, 700))}</div>${cardExtra}</div>`
        : `<div style="white-space:pre-wrap;font-size:14px;line-height:1.5;color:#1D1C1D;overflow-wrap:anywhere;">${linkify(m.content.slice(0, 700))}</div>${doneArrow}`;
      const reviewActions =
        isCard && m.requestId
          ? (() => {
              const req = reviewReqs.get(m.requestId!);
              const updatedAt = req?.updatedAt ?? '';
              const isDone = req ? req.state !== 'ADMITTED' : false;
              if (isDone) return `<div style="font-size:12px;color:#616061;margin-top:6px;">Request ${esc(req!.state)} — <a href="/console/requests/${esc(m.requestId!)}">view</a></div>`;
              return `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">
          <form data-review-action="approve" action="/api/requests/${esc(m.requestId!)}/approve" method="post" style="display:inline-flex;gap:6px;align-items:center;">
            <input type="hidden" name="csrf" value="${esc(csrf)}">
            <input type="hidden" name="requestUpdatedAt" value="${esc(updatedAt)}">
            <label style="display:inline-flex;gap:4px;align-items:center;font-size:11px;color:#616061;"><input type="checkbox" name="confirmed" required> reviewed</label>
            <button type="submit" disabled style="padding:6px 14px;border:0;border-radius:6px;background:#007A5A;color:#fff;font-weight:700;cursor:pointer;font-size:12.5px;">Approve</button>
          </form>
          <form data-review-action="decline" action="/api/requests/${esc(m.requestId!)}/decline" method="post" style="display:inline-flex;gap:6px;align-items:center;">
            <input type="hidden" name="csrf" value="${esc(csrf)}">
            <input type="hidden" name="requestUpdatedAt" value="${esc(updatedAt)}">
            <input type="text" name="reason" placeholder="Decline reason" required style="padding:6px 8px;border:1px solid #DDDDDD;border-radius:6px;font-size:12px;width:150px;">
            <button type="submit" disabled style="padding:6px 14px;border:1px solid #DDDDDD;border-radius:6px;background:#fff;color:#1D1C1D;font-weight:600;cursor:pointer;font-size:12.5px;">Decline</button>
          </form>
        </div><p role="status" aria-live="polite" data-review-status style="font-size:11px;margin-top:6px;"></p>`;
            })()
          : '';
      const replies = byRoot.get(m.id) ?? [];
      const replyThreadHtml =
        replies.length > 0
          ? `<div style="margin-top:6px;">
  <details style="margin:2px 0 0 0;" open>
    <summary style="font-size:12px;font-weight:600;color:#1264A3;cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;">
      <span>💬</span> <span>${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span>
      <span style="font-weight:normal;color:#6B7280;font-size:11px;">· Last reply ${esc(fmtClock(replies[replies.length - 1]!.createdAt))}</span>
    </summary>
    <div style="margin-top:6px;padding-left:10px;border-left:2px solid #E5E7EB;">
      ${replies
        .map((r) => {
          const rw = displayName(r.author, config.agentName);
          return `<div style="display:flex;gap:8px;padding:4px 0;">
        <div style="width:22px;height:22px;border-radius:50%;background:${avatarColor(rw)};display:grid;place-items:center;font-size:9px;font-weight:700;flex-shrink:0;">${esc(initials(rw))}</div>
        <div style="flex:1;"><span style="font-weight:600;font-size:12px;">${esc(rw)}</span> <span style="font-size:11px;color:#6B7280;">${esc(fmtClock(r.createdAt))}</span><div style="font-size:12.5px;white-space:pre-wrap;margin-top:2px;">${linkify(r.content.slice(0, 500))}</div></div>
      </div>`;
        })
        .join('')}
      <form id="reply-${esc(m.id)}" method="post" action="${esc(home)}console/buzz/${esc(scope)}/reply" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="parentId" value="${esc(m.id)}">
        <input type="text" name="content" placeholder="Reply in thread…" style="flex:1;border:1px solid #D1D5DB;border-radius:6px;padding:5px 8px;font-size:12px;" maxlength="500">
        <button type="submit" style="border:1px solid #D1D5DB;background:#fff;color:#1D1C1D;border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer;">Reply</button>
      </form>
    </div>
  </details>
</div>`
          : `<details style="margin-top:4px;">
  <summary style="font-size:11px;color:#6B7280;cursor:pointer;list-style:none;opacity:0.75;" title="Reply to message">Reply</summary>
  <form id="reply-${esc(m.id)}" method="post" action="${esc(home)}console/buzz/${esc(scope)}/reply" style="display:flex;gap:6px;margin-top:6px;">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="parentId" value="${esc(m.id)}">
    <input type="text" name="content" placeholder="Reply in thread…" style="flex:1;border:1px solid #D1D5DB;border-radius:6px;padding:5px 8px;font-size:12px;" maxlength="500">
    <button type="submit" style="border:1px solid #D1D5DB;background:#fff;color:#1D1C1D;border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer;">Reply</button>
  </form>
</details>`;

      const isAgent = who.toLowerCase().includes('agent') || who === config.agentName || who.toLowerCase() === 'bumble' || who.toLowerCase() === 'system';
      const avatarHtml = isAgent
        ? `<div style="width:36px;height:36px;border-radius:8px;background:#E0F2FE;color:#0369A1;display:grid;place-items:center;font-size:18px;flex-shrink:0;">🤖</div>`
        : `<div style="width:36px;height:36px;border-radius:50%;background:${avatarColor(who)};display:grid;place-items:center;font-size:12px;font-weight:700;color:#1D1C1D;flex-shrink:0;">${esc(initials(who))}</div>`;
      const agentBadge = isAgent
        ? `<span style="background:#E5E7EB;color:#374151;font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:3px;text-transform:uppercase;margin-left:4px;">BOT</span>`
        : '';
      const rowStyle = isAgent
        ? 'background:#F9FDFB;border-left:3px solid #10B981;border-radius:6px;padding:8px 10px;margin:0 -8px;'
        : 'background:#fff;border-radius:6px;padding:8px 8px;margin:0 -8px;';

      return `<li id="msg-${esc(m.id)}" onmouseover="if(!${isAgent})this.style.background='#F8F8F8'" onmouseout="if(!${isAgent})this.style.background='#fff'" style="display:flex;gap:10px;list-style:none;transition:background .15s;${rowStyle}">
  ${avatarHtml}
  <div style="flex:1;min-width:0;">
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <span style="font-weight:700;font-size:14px;color:#111827;">${esc(who)}</span>
      ${agentBadge}
      <span style="font-size:11.5px;color:#6B7280;margin-left:2px;">${esc(time)}</span>
      ${m.requestId ? `<span style="font-size:11px;color:#9CA3AF;">· ${esc(m.requestId.slice(0, 10))}</span>` : ''}
    </div>
    <div style="margin-top:2px;">${bubble}</div>
    ${reviewActions}
    ${reactions}
    ${replyThreadHtml}
  </div>
</li>`;
    })
    .join('\n');
  const combined = pendingHtml + messages;
  // Honest empty state — never fabricate chat history. An empty room says so.
  const emptyRoom = `
    <li style="list-style:none;padding:40px 18px;text-align:center;">
      <div style="font-size:30px;">👋</div>
      <div style="font-size:15px;font-weight:700;color:#1D1C1D;margin-top:8px;">Welcome to #${esc(def.name)}</div>
      <div style="font-size:13px;color:#616061;margin-top:4px;">This is the very beginning of the channel. Agents will post progress here — try <code>/status</code> below.</div>
    </li>`;

  const threadList = combined || emptyRoom;

  let threadNote: string;
  if (thread.source === 'relay') {
    threadNote = '<span style="font-size:11px;color:#10B981;" title="Live from relay">● live</span>';
  } else if (thread.error) {
    threadNote = `<span style="font-size:11px;color:#F59E0B;" title="${esc(thread.error)}">○ local</span>`;
  } else {
    threadNote = '<span style="font-size:11px;color:#6B7280;">○ local</span>';
  }

  const gates =
    health.pendingApprovals > 0
      ? `<div style="background:#FFFBEB;border-bottom:1px solid #FDE68A;padding:8px 20px;font-size:13px;color:#92400E;">🟡 ${health.pendingApprovals} request(s) waiting — <a href="${esc(home)}#pending-review" style="color:#0F5C57;font-weight:600;">review now</a></div>`
      : '';

  return `<div style="display:flex;flex-direction:column;height:100vh;min-height:0;background:#fff;overflow:hidden;">
  <!-- Channel Header (Slack Style) -->
  <header style="border-bottom:1px solid #E5E7EB;padding:10px 20px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-shrink:0;background:#fff;">
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <h1 style="font-size:17px;font-weight:700;margin:0;color:#111827;">#${esc(def.name)}</h1>
        <span style="font-size:13px;">${esc(health.badge)}</span>
        <span style="font-size:12px;color:#6B7280;"><code>${esc(config.agentName)}</code> · ${autonomyBadge(config.autonomy)}</span>
      </div>
      <div style="font-size:12px;color:#6B7280;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:8px;" title="${esc(config.mission)}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(config.mission)}</span>
        <span style="background:#F3F4F6;color:#374151;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;flex-shrink:0;">${esc(gauge.headerString)}</span>
        ${config.active ? '' : '<span style="color:#DC2626;font-weight:600;font-size:11px;flex-shrink:0;">Dormant</span>'}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/compiler?drawer=1', 'Compiler Board — Why Not Trusted Yet')" style="border:1px solid #D1D5DB;background:#fff;border-radius:6px;font-size:12px;font-weight:500;padding:5px 10px;cursor:pointer;color:#374151;display:inline-flex;align-items:center;gap:4px;" title="View Kanban Compiler Board">📊 Compiler</button>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/claims?drawer=1', 'Evidence Ledger')" style="border:1px solid #D1D5DB;background:#fff;border-radius:6px;font-size:12px;font-weight:500;padding:5px 10px;cursor:pointer;color:#374151;display:inline-flex;align-items:center;gap:4px;" title="Search Evidence Ledger">📜 Ledger</button>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/requests?drawer=1', 'Review Queue')" style="border:1px solid #D1D5DB;background:#fff;border-radius:6px;font-size:12px;font-weight:500;padding:5px 10px;cursor:pointer;color:#374151;display:inline-flex;align-items:center;gap:4px;" title="Pending Reviews">📋 Reviews${health.pendingApprovals > 0 ? ` (${health.pendingApprovals})` : ''}</button>
      ${threadNote}
    </div>
  </header>

  ${notice ? `<div style="background:#ECFDF5;border-bottom:1px solid #A7F3D0;padding:8px 20px;font-size:13px;color:#065F46;flex-shrink:0;">${esc(notice)}</div>` : ''}
  ${gates ? `<div style="flex-shrink:0;">${gates}</div>` : ''}
  ${health.reasons.length > 0 ? `<div style="background:#FFFBEB;border-bottom:1px solid #FDE68A;padding:8px 20px;font-size:12px;color:#92400E;flex-shrink:0;">${health.reasons.map((r) => `⚠ ${esc(r)}`).join('<br>')}</div>` : ''}

  <!-- Message Stream (Slack Style) -->
  <div class="review-root" id="chat-messages-stream" style="flex:1;overflow-y:auto;padding:16px 20px;min-height:0;display:flex;flex-direction:column;gap:8px;">
    <ul style="padding:0;margin:0;list-style:none;display:flex;flex-direction:column;gap:8px;">${threadList}</ul>
    <details style="margin:8px 0 4px;"><summary style="font-size:12px;color:#868686;cursor:pointer;">Channel details · canvas &amp; budget</summary>
      <pre style="background:#F8F8F8;border:1px solid #DDDDDD;border-radius:8px;padding:12px;white-space:pre-wrap;margin-top:8px;font-size:12px;color:#1D1C1D;">${esc(canvas.markdown).slice(0, 4000)}</pre>
      <p style="font-size:12px;color:#616061;margin-top:6px;">Budget: ${esc(gauge.headerString)}</p>
    </details>
  </div>

  <!-- Agent Working Presence Bar (Matching Image 1 bottom) -->
  <div style="display:flex;align-items:center;gap:8px;padding:6px 20px;background:#FAFAF9;border-top:1px solid #F3F4F6;font-size:12px;color:#4B5563;flex-shrink:0;">
    <span style="width:8px;height:8px;border-radius:50%;background:${config.active ? '#10B981' : '#9CA3AF'};box-shadow:0 0 0 2px rgba(16,185,129,0.25);animation:buzzPulse 2s infinite;display:inline-block;"></span>
    <span><strong>${esc(config.agentName)}</strong>: Working · ${autonomyBadge(config.autonomy)} · <span style="color:#6B7280;">${esc(gauge.headerString)}</span></span>
  </div>
  <style>
    @keyframes buzzPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }
  </style>

  <!-- Slack Composer Card (Matching Image 1) -->
  <div style="padding:10px 20px 14px;background:#fff;border-top:1px solid #E5E7EB;flex-shrink:0;">
    <span style="display:none">Send a command</span>
    <form method="post" action="${esc(home)}console/buzz/${esc(scope)}/command" style="display:flex;flex-direction:column;gap:6px;">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div style="border:1px solid #D1D5DB;border-radius:10px;padding:8px 12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.04);display:flex;flex-direction:column;gap:6px;">
        <input type="text" name="command" id="buzz-composer" list="buzz-commands" placeholder="Message #${esc(def.name)}" style="border:none;outline:none;font-size:13.5px;color:#111827;width:100%;font-family:inherit;padding:4px 0;" autocomplete="off">
        <datalist id="buzz-commands">
          <option value="/compiler" label="Open Compiler board in drawer"></option>
          <option value="/ledger " label="Search Evidence Ledger"></option>
          <option value="/requests" label="Open Review Requests in drawer"></option>
          <option value="/halt " label="Halt room — engage kill switch"></option>
          <option value="/recover " label="Recover room"></option>
          <option value="/status" label="Room health & spend"></option>
          <option value="/cost" label="Budget gauge"></option>
          <option value="/policy set autonomy=guarded" label="Set autonomy"></option>
        </datalist>
        <datalist id="buzz-users">${userOptions}</datalist>

        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid #F3F4F6;">
          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" id="buzz-at" style="border:1px solid #E5E7EB;background:#F9FAFB;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer;color:#4B5563;font-weight:600;" title="Mention someone">@</button>
            <button type="button" style="border:none;background:transparent;cursor:pointer;font-size:13px;color:#6B7280;" title="Attach file">📎</button>
            <button type="button" id="buzz-emoji" style="border:none;background:transparent;cursor:pointer;font-size:13px;" title="Emoji">😊</button>
            <button type="button" style="border:none;background:transparent;cursor:pointer;font-size:12px;color:#6B7280;font-weight:600;" title="Formatting">Aa</button>
            <span style="font-size:11px;color:#9CA3AF;margin-left:8px;">Type <code>/</code> for commands (<code>/compiler</code> <code>/ledger</code> <code>/requests</code> <code>/halt</code>)</span>
          </div>
          <button type="submit" aria-label="Send" style="width:28px;height:28px;border-radius:50%;border:none;background:#0F5C57;color:#fff;display:grid;place-items:center;cursor:pointer;font-size:13px;">↑</button>
        </div>
      </div>
      <div id="buzz-emoji-pick" style="display:none;gap:6px;flex-wrap:wrap;padding:6px;background:#F9FAFB;border-radius:8px;border:1px solid #E5E7EB;">
        ${['😀', '😂', '❤️', '🚀', '✅', '👀', '🎉', '👍', '🔥', '💡'].map((e) => `<button type="button" data-emoji="${esc(e)}" style="border:1px solid #E5E7EB;background:#fff;border-radius:6px;padding:3px 6px;cursor:pointer;">${esc(e)}</button>`).join('')}
      </div>
    </form>
  </div>
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
  <div id="buzz-drawer" style="display:none;position:fixed;top:0;right:0;width:580px;max-width:92vw;height:100vh;background:#fff;border-left:1px solid #E5E7EB;box-shadow:-4px 0 24px rgba(0,0,0,0.12);z-index:9999;flex-direction:column;transition:transform .2s ease-in-out;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #E5E7EB;background:#F9FAFB;">
      <h3 id="buzz-drawer-title" style="margin:0;font-size:14px;font-weight:600;color:#111827;">Drawer</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <a id="buzz-drawer-fullscreen" href="#" target="_blank" style="font-size:12px;color:#0F5C57;text-decoration:none;padding:4px 8px;border:1px solid #D1D5DB;border-radius:6px;background:#fff;">Full view ↗</a>
        <button type="button" id="buzz-drawer-close" style="background:transparent;border:0;font-size:18px;line-height:1;cursor:pointer;color:#6B7280;">✕</button>
      </div>
    </div>
    <div id="buzz-drawer-content" style="flex:1;overflow:auto;padding:16px;">
      <div style="color:#6B7280;font-size:13px;">Loading...</div>
    </div>
  </div>
  <script>
  window.openBuzzDrawer = async function(url, title) {
    const drawer = document.getElementById('buzz-drawer');
    const content = document.getElementById('buzz-drawer-content');
    const titleEl = document.getElementById('buzz-drawer-title');
    const fsEl = document.getElementById('buzz-drawer-fullscreen');
    if (!drawer || !content) return;
    if (titleEl) titleEl.textContent = title || 'Drawer';
    if (fsEl) fsEl.href = url.replace('?drawer=1', '').replace('&drawer=1', '');
    drawer.style.display = 'flex';
    content.innerHTML = '<p style="color:#6B7280;font-size:13px;padding:12px;">Loading...</p>';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<p style="color:#B91C1C;font-size:13px;padding:12px;">Failed to load: ' + err.message + '</p>';
    }
  };
  window.closeBuzzDrawer = function() {
    const drawer = document.getElementById('buzz-drawer');
    if (drawer) drawer.style.display = 'none';
  };
  const closeBtn = document.getElementById('buzz-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', window.closeBuzzDrawer);
  </script>
</div>`;
}
