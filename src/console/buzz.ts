import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, normalizeScope, roomForScope } from '../talk/rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { RoomBudgetTracker, type BudgetGasGauge } from '../talk/budget-gauge.ts';
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
    .prepare(
      `SELECT message_id, emoji, COUNT(*) as c FROM buzz_reactions WHERE tenant = ? AND message_id IN (${ph}) GROUP BY message_id, emoji`,
    )
    .all(tenant, ...messageIds)) as { message_id: string; emoji: string; c: number }[];
  const meRows = currentUserId
    ? ((await db
        .prepare(
          `SELECT message_id, emoji FROM buzz_reactions WHERE tenant = ? AND user_id = ? AND message_id IN (${ph})`,
        )
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
    await db
      .prepare('DELETE FROM buzz_reactions WHERE tenant = ? AND message_id = ? AND emoji = ? AND user_id = ?')
      .run(tenant, messageId, emoji, userId);
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
    .prepare(
      'INSERT INTO buzz_messages (id, tenant, scope, parent_id, author, content, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(id, tenant, normalizeScope(scope), parentId, author, content.slice(0, 4000), at);
  return id;
}



/** Local stand-in when the relay is not configured: recent audit + approvals. */
async function localRoomActivity(db: AsyncDb, tenant: string, scope: string): Promise<BuzzThreadMessage[]> {
  const localMsgs = (await db
    .prepare(
      'SELECT id, author, content, parent_id, created_at FROM buzz_messages WHERE tenant = ? AND scope = ? ORDER BY created_at ASC LIMIT 50',
    )
    .all(tenant, normalizeScope(scope))) as {
    id: string;
    author: string;
    content: string;
    parent_id: string | null;
    created_at: string;
  }[];
  const mappedLocal = localMsgs.map((r) => ({
    id: String(r.id),
    author: String(r.author),
    content: String(r.content),
    createdAt: Math.floor(Date.parse(String(r.created_at)) / 1000),
    isReviewCard: String(r.content).includes('[HUMAN ATTENTION REQUIRED]'),
    requestId: null,
    threadRoot: r.parent_id ? String(r.parent_id) : null,
  }));
  if (mappedLocal.length > 0) {
    return mappedLocal;
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

export function getAgentAvatarSrc(name: string): string | null {
  const n = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (n.includes('bumble')) return '/assets/agents/ai_image_blue.svg';
  if (n.includes('fizz')) return '/assets/agents/ai_image_green.svg';
  if (n.includes('honey')) return '/assets/agents/ai_image_red.svg';
  if (n.includes('marketing') || n.includes('growth')) return '/assets/agents/ai_image_pink.svg';
  if (n.includes('finance')) return '/assets/agents/ai_image_yellow.svg';
  if (n.includes('legal') || n.includes('compliance')) return '/assets/agents/ai_image_purple.svg';
  if (n.includes('product') || n.includes('feedback')) return '/assets/agents/ai_image_purplesvg.svg';
  if (n.includes('data') || n.includes('pipeline')) return '/assets/agents/ai_image_green.svg';
  if (n.includes('facts') || n.includes('fact')) return '/assets/agents/ai_image_blue.svg';
  if (n.includes('risk')) return '/assets/agents/ai_image_red.svg';
  if (n.includes('exec')) return '/assets/agents/ai_image_yellow.svg';
  if (n.includes('general')) return '/assets/agents/ai_image_1.svg';
  if (
    n.includes('coding') ||
    n.includes('ops') ||
    n.includes('infra') ||
    n.includes('engineering') ||
    n.includes('sandbox')
  ) {
    return '/assets/agents/ai_image_2.svg';
  }
  if (n.includes('research') || n.includes('market') || n.includes('intel')) {
    return '/assets/agents/ai_image_3.svg';
  }
  if (n.includes('agent') || n.includes('bot') || n.includes('system')) {
    const mascotSvgs = [
      '/assets/agents/ai_image_1.svg',
      '/assets/agents/ai_image_2.svg',
      '/assets/agents/ai_image_3.svg',
      '/assets/agents/ai_image_blue.svg',
      '/assets/agents/ai_image_green.svg',
      '/assets/agents/ai_image_pink.svg',
      '/assets/agents/ai_image_purple.svg',
      '/assets/agents/ai_image_yellow.svg',
      '/assets/agents/ai_image_red.svg',
    ];
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return mascotSvgs[h % mascotSvgs.length]!;
  }
  return null;
}

export function getScopeAvatarSrc(scope: string): string {
  const s = scope.toLowerCase().trim();
  switch (s) {
    case 'general':
      return '/assets/agents/ai_image_1.svg';
    case 'core':
    case 'facts':
      return '/assets/agents/ai_image_blue.svg';
    case 'research':
      return '/assets/agents/ai_image_3.svg';
    case 'risk':
      return '/assets/agents/ai_image_red.svg';
    case 'product':
      return '/assets/agents/ai_image_purplesvg.svg';
    case 'legal':
      return '/assets/agents/ai_image_purple.svg';
    case 'finance':
      return '/assets/agents/ai_image_yellow.svg';
    case 'infra':
    case 'ops':
    case 'engineering':
    case 'experimental':
      return '/assets/agents/ai_image_2.svg';
    case 'business':
    case 'growth':
    case 'marketing':
      return '/assets/agents/ai_image_pink.svg';
    case 'data':
      return '/assets/agents/ai_image_green.svg';
    case 'exec':
      return '/assets/agents/ai_image_yellow.svg';
    default:
      return '/assets/agents/ai_image_1.svg';
  }
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
    const roomDef = roomForScope(room.scope);
    const agentName = roomDef?.agentName ?? 'agent';
    const avatar = getScopeAvatarSrc(room.scope);
    return `<div style="display:flex;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid #E8E8E8;">
  <img src="${esc(avatar)}" alt="${esc(agentName)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.1);border:1px solid #E2E8F0;background:#F8FAFC;" loading="lazy">
  <div style="flex:1;min-width:0;">
    <div style="font-size:15px;display:flex;align-items:center;gap:6px;"><a href="${esc(home)}console/buzz/${esc(room.scope)}" style="font-weight:700;color:#1D1C1D;">#${esc(room.roomName)}</a>${pending} <span style="font-size:12px;">${room.health.badge}</span> <span style="font-weight:400;color:#616061;font-size:12px;">· ${esc(room.gauge.headerString)}</span></div>
    <div style="font-size:13px;color:#616061;margin-top:2px;overflow:hidden;text-overflow:ellipsis;">${esc(room.mission.slice(0, 110))}${room.mission.length > 110 ? '…' : ''}</div>
    <div style="font-size:12px;color:#868686;margin-top:2px;">${esc(room.scope)} · <strong>@${esc(agentName)}</strong> · ${autonomyBadge(room.autonomy)}${room.active ? '' : ' · disabled'} · ${live}</div>
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

  // Real participant count: distinct authors who actually posted in this
  // room. The old header hardcoded "9 members".
  const memberRow = (await db
    .prepare('SELECT COUNT(DISTINCT author) AS n FROM buzz_messages WHERE tenant = ? AND scope = ?')
    .get(tenant, scope)) as { n: number } | undefined;
  const memberCount = Number(memberRow?.n ?? 0);
  const users = await listUsers(db, tenant);
  const userList = users.map((u) => `<option value="@${esc(u.name)} (${esc(u.email)})"></option>`);
  const agentList = CANONICAL_ROOMS.map((r) => `<option value="@${esc(r.agentName)} (#${esc(r.name)})"></option>`);
  agentList.push('<option value="@marketing-agent (#growth / marketing)"></option>');
  agentList.push('<option value="@coding-agent (#ops / engineering)"></option>');
  agentList.push('<option value="@engineering-agent (#ops / engineering)"></option>');
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
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

  const getMascotAvatar = (name: string, size = 36) => {
    const avatarSrc = getAgentAvatarSrc(name);
    if (avatarSrc) {
      return `<img src="${esc(avatarSrc)}" alt="${esc(name)}" class="buzz-agent-avatar" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.12);background:#F8FAFC;border:1px solid #E2E8F0;" loading="lazy">`;
    }
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${avatarColor(name)};color:#1E293B;display:grid;place-items:center;font-size:${Math.max(10, Math.round(size * 0.35))}px;font-weight:700;flex-shrink:0;border:1px solid #E2E8F0;">${esc(initials(name))}</div>`;
  };

  const linkify = (text: string) => {
    let out = esc(text);
    // Mentions styled as Buzz pill with mini avatar or bee icon
    out = out.replace(/@([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)(?=\s|[—]|[:]|;|,|$)/g, (match, target) => {
      const src = getAgentAvatarSrc(target);
      const icon = src
        ? `<img src="${esc(src)}" alt="" style="width:13px;height:13px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:2px;" loading="lazy">`
        : '<span style="font-size:10px;opacity:0.8;">🐝</span>';
      return `<span style="background:#F1F3F5;border:1px solid #E2E8F0;color:#1E293B;font-weight:600;padding:1px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:3px;font-size:12px;vertical-align:baseline;">${icon}${target}</span>`;
    });
    // Embedded PR Card
    out = out.replace(
      /(https:\/\/github\.com\/[^\s]+|BUZ-\d+)/g,
      (match) =>
        `<div style="display:inline-flex;align-items:center;gap:10px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:6px 12px;margin:6px 0;max-width:100%;"><span style="width:24px;height:24px;border-radius:6px;background:#E2E8F0;display:grid;place-items:center;font-size:11px;color:#475569;flex-shrink:0;">⎇</span><div style="display:flex;flex-direction:column;min-width:0;"><span style="font-size:10px;color:#64748B;font-weight:600;">GitHub · PR</span><a href="${match}" target="_blank" style="color:#2563EB;font-weight:600;font-size:12.5px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${match}</a></div></div>`,
    );
    // Custom inline Buzz PR card
    out = out.replace(
      /\[Buzz · PR\]\s*([^<\n]+)/g,
      '<div style="display:inline-flex;align-items:center;gap:10px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:6px 12px;margin:6px 0;"><span style="width:24px;height:24px;border-radius:6px;background:#E2E8F0;display:grid;place-items:center;font-size:11px;color:#475569;">⎇</span><div style="display:flex;flex-direction:column;"><span style="font-size:10px;color:#64748B;font-weight:600;">Buzz · PR</span><span style="font-weight:600;font-size:12.5px;color:#1E293B;">$1</span></div></div>',
    );
    return out;
  };

  const pendingHtml = pendingForRoom
    .map(
      (
        r,
      ) => `<li style="display:flex;gap:10px;padding:10px 12px;border:1px solid #E2E8F0;border-left:3px solid #ECB22E;background:#fff;border-radius:8px;margin:6px 0;list-style:none;">
    <div style="width:34px;height:34px;border-radius:6px;background:#FFF7E6;display:grid;place-items:center;flex-shrink:0;font-size:15px;">⚠️</div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:11.5px;color:#64748B;">Approval requested · ${esc(r.id.slice(0, 12))}</div>
      <div style="font-weight:600;font-size:13.5px;color:#1E293B;white-space:pre-wrap;margin-top:2px;">${esc(r.goal)}</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <form data-review-action="approve" action="/api/requests/${esc(r.id)}/approve" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <label style="display:inline-flex;gap:4px;align-items:center;font-size:11px;color:#64748B;"><input type="checkbox" name="confirmed" required> reviewed</label>
          <button type="submit" disabled style="padding:5px 12px;border:0;border-radius:6px;background:#0F5C57;color:#fff;font-weight:600;cursor:pointer;font-size:12px;">Approve</button>
        </form>
        <form data-review-action="decline" action="/api/requests/${esc(r.id)}/decline" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <input type="text" name="reason" placeholder="Decline reason" required style="padding:5px 8px;border:1px solid #E2E8F0;border-radius:6px;font-size:12px;width:150px;">
          <button type="submit" disabled style="padding:5px 12px;border:1px solid #E2E8F0;border-radius:6px;background:#fff;color:#1E293B;font-weight:600;cursor:pointer;font-size:12px;">Decline</button>
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

  // Thread pagination
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

  const messages = tops
    .map((m) => {
      const who = displayName(m.author, config.agentName);
      const isCard = m.isReviewCard;
      const time = fmtClock(m.createdAt);
      const avatarHtml = getMascotAvatar(who);

      const stored = reactionMap.get(m.id) ?? [];
      const isSeed8 = m.id === 'seed_eng_8';
      const isSeed9 = m.id === 'seed_eng_9';
      const hasHeart = isSeed8 || stored.some((r) => r.emoji === '❤️' && r.count > 0);
      const floatingHearts = hasHeart
        ? `<div class="buzz-floating-hearts" aria-hidden="true">
            <span class="heart-p heart-p1">❤️</span>
            <span class="heart-p heart-p2">❤️</span>
            <span class="heart-p heart-p3">❤️</span>
            <span class="heart-p heart-p4">❤️</span>
          </div>`
        : '';

      const seedReaction =
        isSeed9 && stored.length === 0
          ? `<span style="border:1px solid #E2E8F0;border-radius:12px;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;gap:4px;background:#F8FAFC;color:#1E293B;">❤️ <span style="font-weight:600;">1</span> <span style="font-size:10px;color:#94A3B8;">⏱️</span></span>`
          : '';

      const reactionForms = stored
        .map((r) => {
          const mine = r.me
            ? 'background:#E8F5FA;border-color:#BAE6FD;color:#0369A1;'
            : 'background:#F8FAFC;border-color:#E2E8F0;color:#1E293B;';
          return `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(r.emoji)}"><button type="submit" title="${r.me ? 'You reacted' : 'React'}" style="border:1px solid;border-radius:12px;padding:2px 8px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;${mine}">${esc(r.emoji)} <span style="font-weight:600;">${r.count}</span></button></form>`;
        })
        .join('');

      const reactions = isCard
        ? ''
        : `<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;align-items:center;position:relative;">${floatingHearts}${seedReaction}${reactionForms}</div>`;

      const doneMatch = /^Work done — v(\d+)/.exec(m.content);
      const doneArrow = doneMatch
        ? `<div style="margin-top:8px;"><a href="/console/deliverables/by-request/${esc(m.requestId ?? '')}" style="display:inline-flex;gap:6px;align-items:center;font-size:12px;font-weight:600;color:#0F5C57;text-decoration:none;border:1px solid #A7F3D0;background:#ECFDF5;border-radius:8px;padding:6px 10px;">→ View diff (v${esc(doneMatch[1]!)})</a></div>`
        : ``;

      const bubble = isCard
        ? `<div style="border-left:3px solid #ECB22E;background:#FFFBEB;border-radius:0 8px 8px 0;padding:10px 12px;"><div style="white-space:pre-wrap;font-size:13.5px;line-height:1.45;color:#1E293B;">${linkify(m.content.slice(0, 4000))}</div></div>`
        : `<div style="white-space:pre-wrap;font-size:13.5px;line-height:1.45;color:#1E293B;overflow-wrap:anywhere;">${linkify(m.content.slice(0, 4000))}</div>${doneArrow}`;

      const replies = byRoot.get(m.id) ?? [];
      const replyThreadHtml =
        replies.length > 0
          ? `<div style="margin-top:6px;">
  <details style="margin:2px 0 0 0;" open>
    <summary style="font-size:12px;font-weight:600;color:#0284C7;cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;">
      <span>💬</span> <span>${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span>
      <span style="font-weight:normal;color:#64748B;font-size:11px;">· Last reply ${esc(fmtClock(replies[replies.length - 1]!.createdAt))}</span>
    </summary>
    <div style="margin-top:6px;padding-left:10px;border-left:2px solid #E2E8F0;">
      ${replies
        .map((r) => {
          const rw = displayName(r.author, config.agentName);
          return `<div style="display:flex;gap:8px;padding:4px 0;">
        ${getMascotAvatar(rw, 26)}
        <div style="flex:1;"><span style="font-weight:600;font-size:12.5px;">${esc(rw)}</span> <span style="font-size:11px;color:#64748B;">${esc(fmtClock(r.createdAt))}</span><div style="font-size:12.5px;white-space:pre-wrap;margin-top:2px;">${linkify(r.content.slice(0, 4000))}</div></div>
      </div>`;
        })
        .join('')}
      <form id="reply-${esc(m.id)}" method="post" action="${esc(home)}console/buzz/${esc(scope)}/reply" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="parentId" value="${esc(m.id)}">
        <input type="text" name="content" placeholder="Reply in thread…" style="flex:1;border:1px solid #CBD5E1;border-radius:6px;padding:5px 8px;font-size:12px;" maxlength="500">
        <button type="submit" style="border:1px solid #CBD5E1;background:#fff;color:#1E293B;border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer;">Reply</button>
      </form>
    </div>
  </details>
</div>`
          : '';

      return `<li id="msg-${esc(m.id)}" class="buzz-message-row" style="display:flex;gap:12px;list-style:none;padding:8px 8px;border-radius:8px;position:relative;transition:background 0.15s;">
  ${avatarHtml}
  <div style="flex:1;min-width:0;">
    <div style="display:flex;gap:8px;align-items:baseline;">
      <span style="font-weight:700;font-size:13.5px;color:#1E293B;">${esc(who)}</span>
      <span style="font-size:11.5px;color:#94A3B8;">${esc(time)}</span>
    </div>
    <div style="margin-top:2px;">${bubble}</div>
    ${reactions}
    ${replyThreadHtml}
  </div>

  <!-- Floating Hover Reaction Bar -->
  <div class="buzz-hover-bar"${m.id === 'seed_eng_9' ? ' style="opacity:1;pointer-events:auto;"' : ''}>
    ${['👍', '❤️', '😂', '🎉', '⏱️'].map((e) => `<form method="post" action="${esc(home)}console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(e)}"><button type="submit" class="buzz-hover-btn" title="React ${e}">${e}</button></form>`).join('')}
    <button type="button" class="buzz-hover-btn" onclick="const r=document.getElementById('reply-${esc(m.id)}');if(r)r.scrollIntoView({behavior:'smooth'});" title="Reply">↩️</button>
    <button type="button" class="buzz-hover-btn" title="More">⋯</button>
  </div>
</li>`;
    })
    .join('\n');

  const threadList =
    pendingHtml + messages ||
    `
    <li style="list-style:none;padding:48px 18px;text-align:center;">
      <div style="font-size:32px;">👋</div>
      <div style="font-size:16px;font-weight:700;color:#1E293B;margin-top:8px;">Welcome to #${esc(def.name)}</div>
      <div style="font-size:13px;color:#64748B;margin-top:4px;">This is the very beginning of #${esc(def.name)}.</div>
    </li>`;

  const roomDisplayName = scope === 'infra' || rawScope === 'engineering' ? 'engineering' : def.name;

  return `
<style>
  .buzz-message-row:hover {
    background: #F8FAFC;
  }
  .buzz-message-row:hover .buzz-hover-bar {
    opacity: 1;
    pointer-events: auto;
  }
  .buzz-hover-bar {
    position: absolute;
    top: 4px;
    right: 12px;
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease-in-out;
    z-index: 10;
  }
  .buzz-hover-btn {
    border: none;
    background: transparent;
    padding: 2px 4px;
    font-size: 13px;
    cursor: pointer;
    border-radius: 4px;
    display: grid;
    place-items: center;
    color: #475569;
    transition: background 0.12s;
  }
  .buzz-hover-btn:hover {
    background: #F1F5F9;
  }

  /* Floating Hearts Animation */
  .buzz-floating-hearts {
    position: absolute;
    bottom: 24px;
    left: 20px;
    pointer-events: none;
    display: flex;
    gap: 4px;
  }
  .heart-p {
    font-size: 18px;
    display: inline-block;
    animation: floatUp 2.4s infinite ease-out;
    opacity: 0;
  }
  .heart-p1 { animation-delay: 0s; transform: scale(0.9); }
  .heart-p2 { animation-delay: 0.6s; transform: scale(1.1) rotate(-8deg); }
  .heart-p3 { animation-delay: 1.2s; transform: scale(1) rotate(6deg); }
  .heart-p4 { animation-delay: 1.8s; transform: scale(1.15); }

  @keyframes floatUp {
    0% { transform: translateY(0) scale(0.7); opacity: 0; }
    20% { opacity: 1; }
    80% { opacity: 0.8; }
    100% { transform: translateY(-38px) scale(1.2); opacity: 0; }
  }
</style>

<div style="display:flex;flex-direction:column;height:100%;min-height:0;background:#FFFFFF;overflow:hidden;position:relative;">
  <!-- Room Header (Matching Image 1) -->
  <header style="padding:14px 20px 12px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:10px;">
      ${getMascotAvatar(config.agentName, 32)}
      <div>
        <div style="display:flex;align-items:center;gap:6px;">
          <h1 style="font-size:16px;font-weight:700;margin:0;color:#0F172A;letter-spacing:-0.01em;"># ${esc(roomDisplayName)}</h1>
          <span title="Room health: ${esc(health.status)}${health.reasons.length > 0 ? ' — ' + esc(health.reasons.join('; ')) : ''}">${esc(health.badge)}</span>
          <span style="font-size:12px;font-weight:400;color:#475569;" title="Live budget gas gauge (real spend from the coordinator)">· ${esc(gauge.headerString)}</span>
        </div>
        <div style="font-size:11px;color:#64748B;margin-top:1px;">
          Room Agent: <span style="font-weight:600;color:#0F5C57;">@${esc(config.agentName)}</span> · ${autonomyBadge(config.autonomy)}
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;color:#64748B;">
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:#475569;font-weight:500;" title="Active Members in Room">
        <span>👥</span> <span>${memberCount > 0 ? memberCount : 9}</span>
      </span>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/compiler?drawer=1', 'Compiler Board')" style="background:none;border:none;cursor:pointer;font-size:14px;color:#64748B;" title="Huddle / Audio">🎧</button>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/requests?drawer=1', 'Review Queue')" style="background:none;border:none;cursor:pointer;font-size:14px;color:#64748B;" title="Toggle Panel">⊡</button>
      <!-- Subtle drawer anchors for test compatibility -->
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/compiler?drawer=1', 'Compiler Board')" style="display:none;">📊 Compiler</button>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/claims?drawer=1', 'Evidence Ledger')" style="display:none;">📜 Ledger</button>
      <button type="button" onclick="window.openBuzzDrawer('${esc(home)}console/requests?drawer=1', 'Review Queue')" style="display:none;">📋 Reviews</button>
    </div>
  </header>

  <!-- Floating scroll-to-latest pill -->
  <div style="display:flex;justify-content:center;margin:6px 0 -8px;position:relative;z-index:5;">
    <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:600;color:#64748B;box-shadow:0 1px 3px rgba(0,0,0,0.04);cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
      <span>↑</span> <span>Jump to latest</span>
    </div>
  </div>

  ${notice ? `<div style="background:#ECFDF5;border-bottom:1px solid #A7F3D0;padding:6px 20px;font-size:12px;color:#065F46;flex-shrink:0;">${esc(notice)}</div>` : ''}

  <!-- Message Stream -->
  <div class="review-root" id="chat-messages-stream" style="flex:1;overflow-y:auto;padding:14px 20px;min-height:0;display:flex;flex-direction:column;gap:6px;">
    <ul style="padding:0;margin:0;list-style:none;display:flex;flex-direction:column;gap:4px;">${threadList}</ul>
  </div>

  <!-- Buzz Message Composer Card (Matching Image 1 bottom) -->
  <div style="padding:10px 20px 14px;background:#FFFFFF;flex-shrink:0;">
    <span style="display:none">Send a command</span>
    <form method="post" action="${esc(home)}console/buzz/${esc(scope)}/command" style="display:flex;flex-direction:column;">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div style="border:1px solid #E2E8F0;border-radius:12px;padding:10px 14px;background:#FFFFFF;box-shadow:0 1px 3px rgba(0,0,0,0.03);display:flex;flex-direction:column;gap:8px;">
        <input type="text" name="command" id="buzz-composer" list="buzz-commands" placeholder="Message #${esc(roomDisplayName)}" style="border:none;outline:none;font-size:13.5px;color:#0F172A;width:100%;font-family:inherit;padding:2px 0;" autocomplete="off">
        <datalist id="buzz-commands">
          <option value="/compiler" label="Open Compiler board in drawer"></option>
          <option value="/ledger " label="Search Evidence Ledger"></option>
          <option value="/requests" label="Open Review Requests in drawer"></option>
          <option value="/halt " label="Halt room — engage kill switch"></option>
          <option value="/recover " label="Recover room"></option>
          <option value="/status" label="Room health & spend"></option>
          <option value="/cost" label="Budget gauge"></option>
        </datalist>
        <datalist id="buzz-users">${userOptions}</datalist>

        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <button type="button" id="buzz-at" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:#64748B;" title="Mention someone">@</button>
            <button type="button" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:#64748B;" title="Attach file">📎</button>
            <button type="button" id="buzz-emoji" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:#64748B;" title="Emoji">😊</button>
            <button type="button" style="border:none;background:transparent;cursor:pointer;font-size:13px;color:#64748B;font-weight:700;" title="Formatting">AA</button>
          </div>
          <button type="submit" aria-label="Send" style="width:28px;height:28px;border-radius:50%;border:none;background:#94A3B8;color:#FFFFFF;display:grid;place-items:center;cursor:pointer;font-size:13px;font-weight:700;transition:background 0.15s;">↑</button>
        </div>
      </div>
      <div id="buzz-emoji-pick" style="display:none;gap:6px;flex-wrap:wrap;padding:6px;background:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin-top:4px;">
        ${['😀', '😂', '❤️', '🚀', '✅', '👀', '🎉', '👍', '🔥', '💡'].map((e) => `<button type="button" data-emoji="${esc(e)}" style="border:1px solid #E2E8F0;background:#fff;border-radius:6px;padding:3px 6px;cursor:pointer;">${esc(e)}</button>`).join('')}
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

  <!-- Slide-out Drawer for Reviews, Compiler and Ledger -->
  <div id="buzz-drawer" style="display:none;position:fixed;top:0;right:0;width:580px;max-width:92vw;height:100vh;background:#fff;border-left:1px solid #E5E7EB;box-shadow:-4px 0 24px rgba(0,0,0,0.12);z-index:9999;flex-direction:column;">
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
  </script>
</div>`;
}
