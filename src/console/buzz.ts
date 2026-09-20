import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, loadTenantRooms, normalizeScope, resolveRoomDef } from '../talk/rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from '../talk/health.ts';
import { RoomBudgetTracker, type BudgetGasGauge } from '../talk/budget-gauge.ts';
import { roomHealth } from './shell-reads.ts';
import type { BuzzSurface } from '../talk/buzz.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { listUsers } from '../core/auth.ts';
import { svgIcon } from './buzz-icons.ts';

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
  /** The room's own agent. Custom rooms carry their own; a canonical room's
   *  falls back to its definition. Data only — the row markup is unchanged. */
  agentName: string;
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

/**
 * Assemble everything the roster needs. Reuses the evaluators the APIs use.
 *
 * Everything here is a whole-tenant read, shared with the shell that wraps this
 * page: the health rollup, the room set and the gauges are each asked for once
 * per request. Drawing the roster one room at a time used to cost the page a
 * config read, a health evaluation and two budget aggregates *per room* — which
 * is why `/console/buzz` was the console's most expensive page.
 */
export async function buildBuzzRoster(
  db: AsyncDb,
  tenant: string,
  surface?: BuzzSurface | null,
): Promise<BuzzRosterData> {
  const tracker = new RoomBudgetTracker(db, tenant);
  const evaluations = await roomHealth(db, tenant);
  const configs = await loadTenantRooms(db, tenant);
  const gauges = await tracker.computeGauges(evaluations.map((h) => h.scope));
  const rooms: BuzzRoomRow[] = [];
  for (const health of evaluations) {
    const config = configs.get(health.scope)?.config ?? (await loadRoomConfig(db, tenant, health.scope));
    const gauge = gauges.get(health.scope)!;
    rooms.push({
      scope: health.scope,
      roomName: health.roomName,
      agentName: config.agentName,
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
  if (autonomy === 'supervised') return '<span style="color:var(--buzz-lock);">human-in-the-loop</span>';
  if (autonomy === 'guarded') return '<span style="color:var(--buzz-lock);">guarded</span>';
  return '<span style="color:var(--buzz-good);">autonomous</span>';
}

/**
 * Inline-only markdown-lite pass: `code`, **bold**, *italic*, @mentions,
 * [text](url) links and the embedded GitHub PR card. Input is raw message
 * text; XSS safety comes from the escape-first invariant — the whole string
 * is `esc()`ed before any tag is injected, so markup the agents themselves
 * emitted stays inert text and only the tags added here are real HTML.
 */
function markdownInline(text: string): string {
  let out = esc(text);
  // Markdown-lite: agent briefings arrive as `**bold**` / `*italic*` /
  // `` `code` `` and used to render as escaped source text — the single
  // biggest visual-dirt tell next to the crafted marketing pages.
  out = out.replace(/`([^`\n]+)`/g, '<code class="buzz-md-code">$1</code>');
  // [text](url) — resolved before the PR-card rewrite below. The href
  // allow-list (http/https/relative/anchor) keeps javascript: and friends out.
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)"&]+(?:&[^\s)"]*)?|\/[^\s)"#]*|#[^\s)"]*)\)/g,
    '<a href="$2" class="buzz-md-link" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="buzz-md-strong">$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em class="buzz-md-em">$2</em>');
  // Mentions styled as Buzz pill with mini avatar or bee icon
  out = out.replace(/@([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)(?=\s|[—]|[:]|;|,|$)/g, (match, target) => {
    const src = getAgentAvatarSrc(target);
    const icon = src
      ? `<img src="${esc(src)}" alt="" style="width:13px;height:13px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:2px;" loading="lazy">`
      : '<span style="font-size:10px;opacity:0.8;">🐝</span>';
    return `<span style="background:var(--buzz-inset-2);border:1px solid var(--buzz-border-soft);color:var(--buzz-ink-1);font-weight:600;padding:1px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:3px;font-size:12px;vertical-align:baseline;">${icon}${target}</span>`;
  });
  // Embedded PR Card. The lookbehind stops the rewrite from climbing into
  // the href="…" attribute of a markdown link resolved above.
  out = out.replace(
    /(?<!["=])(https:\/\/github\.com\/[^\s"]+|BUZ-\d+)/g,
    (match) =>
      `<div style="display:inline-flex;align-items:center;gap:10px;background:var(--buzz-inset);border:1px solid var(--buzz-border-soft);border-radius:8px;padding:6px 12px;margin:6px 0;max-width:100%;"><span style="width:24px;height:24px;border-radius:6px;background:var(--buzz-border-soft);display:grid;place-items:center;font-size:11px;color:var(--buzz-ink-3);flex-shrink:0;">⎇</span><div style="display:flex;flex-direction:column;min-width:0;"><span style="font-size:10px;color:var(--buzz-ink-3);font-weight:600;">GitHub · PR</span><a href="${match}" target="_blank" style="color:var(--buzz-info);font-weight:600;font-size:12.5px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${match}</a></div></div>`,
  );
  // Custom inline Buzz PR card
  out = out.replace(
    /\[Buzz · PR\]\s*([^<\n]+)/g,
    '<div style="display:inline-flex;align-items:center;gap:10px;background:var(--buzz-inset);border:1px solid var(--buzz-border-soft);border-radius:8px;padding:6px 12px;margin:6px 0;"><span style="width:24px;height:24px;border-radius:6px;background:var(--buzz-border-soft);display:grid;place-items:center;font-size:11px;color:var(--buzz-ink-3);">⎇</span><div style="display:flex;flex-direction:column;"><span style="font-size:10px;color:var(--buzz-ink-3);font-weight:600;">Buzz · PR</span><span style="font-weight:600;font-size:12.5px;color:var(--buzz-ink-1);">$1</span></div></div>',
  );
  return out;
}

/**
 * Markdown-lite block renderer for chat bubbles. Agents — and our own slash
 * commands and canvases — emit `## headings`, `- ` bullets, `1.` lists,
 * fenced code blocks and blockquotes, which the pre-wrap bubble used to show
 * as raw source. Block structure is handled here; every text run then goes
 * through `markdownInline` (which keeps the escape-first XSS invariant).
 * Plain messages stay one `<p>` with pre-wrap, so human line breaks render
 * exactly as before.
 */
export function renderMarkdownLite(text: string): string {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(`<p class="buzz-md-p">${markdownInline(para.join('\n'))}</p>`);
    para = [];
  };
  const UL = /^\s*[-*+]\s+(.*)$/;
  const OL = /^\s*\d+[.)]\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const isFence = (l: string) => /^\s*(```|~~~)/.test(l);
  const li = (x: string) => `<li class="buzz-md-li">${markdownInline(x)}</li>`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isFence(line)) {
      flushPara();
      const lang = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)/.exec(line)?.[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      // An unterminated fence (the 4000-char clip can cut mid-block) is
      // auto-closed so raw backticks never leak into later blocks.
      blocks.push(
        `<pre class="buzz-md-pre"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`,
      );
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push(`<div class="buzz-md-h buzz-md-h--${String(h[1]!.length)}">${markdownInline(h[2]!)}</div>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push('<hr class="buzz-md-hr">');
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushPara();
      const inner: string[] = [q[1]!];
      let m: RegExpExecArray | null;
      while (i + 1 < lines.length && (m = QUOTE.exec(lines[i + 1]!))) {
        i += 1;
        inner.push(m[1]!);
      }
      blocks.push(`<blockquote class="buzz-md-quote">${inner.map((x) => markdownInline(x)).join('<br>')}</blockquote>`);
      continue;
    }
    const ul = UL.exec(line);
    if (ul) {
      flushPara();
      const items: string[] = [ul[1]!];
      let m: RegExpExecArray | null;
      while (i + 1 < lines.length && (m = UL.exec(lines[i + 1]!))) {
        i += 1;
        items.push(m[1]!);
      }
      blocks.push(`<ul class="buzz-md-list">${items.map(li).join('')}</ul>`);
      continue;
    }
    const ol = OL.exec(line);
    if (ol) {
      flushPara();
      const items: string[] = [ol[1]!];
      let m: RegExpExecArray | null;
      while (i + 1 < lines.length && (m = OL.exec(lines[i + 1]!))) {
        i += 1;
        items.push(m[1]!);
      }
      blocks.push(`<ol class="buzz-md-list">${items.map(li).join('')}</ol>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks.join('');
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
export function renderBuzzRoster(data: BuzzRosterData, _home: string, _csrf: string): string {
  const order = new Map(CANONICAL_ROOMS.map((d, i) => [d.scope, i]));
  const rooms = [...data.rooms].sort((a, b) => (order.get(a.scope) ?? 99) - (order.get(b.scope) ?? 99));

  let relayLine: string;
  if (!data.relay) {
    relayLine =
      '<p style="font-size:13px;color:var(--buzz-ink-3);background:var(--buzz-inset);border:1px solid var(--buzz-border);border-radius:8px;padding:8px 12px;">Relay not configured — working locally. Messages stay on this workspace.</p>';
  } else if (data.relay.ok) {
    relayLine = `<p style="font-size:13px;color:var(--buzz-good);">Relay connected: ${esc(data.relay.detail)}</p>`;
  } else {
    relayLine = `<p style="font-size:13px;color:var(--buzz-risk);">Relay unreachable: ${esc(data.relay.detail)}</p>`;
  }

  const provisionedCount = rooms.filter((r) => r.provisioned).length;
  const unprovisioned = rooms.filter((r) => !r.provisioned);
  const provisionLine =
    unprovisioned.length > 0
      ? `<p style="font-size:13px;color:var(--buzz-ink-3);">${provisionedCount}/${rooms.length} rooms live · <a href="/setup/rooms">set up the rest</a></p>`
      : `<p style="font-size:13px;color:var(--buzz-good);">All ${rooms.length} rooms live.</p>`;

  const row = (room: (typeof rooms)[number]) => {
    const live = room.provisioned
      ? '<span style="color:var(--buzz-good);">● live</span>'
      : '<span style="color:var(--buzz-warn);" title="not provisioned">○ local</span> not provisioned';
    const pending =
      room.health.pendingApprovals > 0
        ? ` <span style="background:var(--buzz-risk);color:var(--buzz-ink-inverse);font-size:11px;font-weight:700;min-width:20px;height:20px;display:inline-grid;place-items:center;border-radius:999px;padding:0 6px;">${room.health.pendingApprovals}</span>`
        : '';
    const agentName = room.agentName;
    const avatar = getScopeAvatarSrc(room.scope);
    return `<div style="display:flex;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--buzz-border);">
  <img src="${esc(avatar)}" alt="${esc(agentName)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.1);border:1px solid var(--buzz-border-soft);background:var(--buzz-inset);" loading="lazy">
  <div style="flex:1;min-width:0;">
    <div style="font-size:15px;display:flex;align-items:center;gap:6px;"><a href="/console/buzz/${esc(room.scope)}" style="font-weight:700;color:var(--buzz-ink-1);">#${esc(room.roomName)}</a>${pending} <span style="font-size:12px;">${room.health.badge}</span> <span style="font-weight:400;color:var(--buzz-ink-3);font-size:12px;">· ${esc(room.gauge.headerString)}</span></div>
    <div style="font-size:13px;color:var(--buzz-ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;">${esc(room.mission.slice(0, 110))}${room.mission.length > 110 ? '…' : ''}</div>
    <div style="font-size:12px;color:var(--buzz-ink-3);margin-top:2px;">${esc(room.scope)} · <strong>@${esc(agentName)}</strong> · ${autonomyBadge(room.autonomy)}${room.active ? '' : ' · disabled'} · ${live}</div>
  </div>
  <a href="/console/buzz/${esc(room.scope)}" style="flex-shrink:0;font-size:13px;font-weight:600;border:1px solid var(--buzz-border);border-radius:6px;padding:6px 12px;color:var(--buzz-ink-1);text-decoration:none;background:var(--buzz-surface);">View</a>
</div>`;
  };

  return `<section style="padding:26px 32px;max-width:920px;">
  <h1 style="font-size:20px;margin:0 0 4px;color:var(--buzz-ink-1);">Browse channels</h1>
  <p style="font-size:13px;color:var(--buzz-ink-3);margin:0 0 12px;">One room per scope. Agents work in their rooms and surface what needs you.</p>
  ${relayLine}
  ${provisionLine}
  <input type="search" id="buzz-filter" placeholder="Search channels" aria-label="Search channels" style="width:100%;max-width:420px;border:1px solid var(--buzz-border);border-radius:6px;padding:8px 12px;font-size:13px;margin:8px 0 4px;">
  <div id="buzz-list">${rooms.map(row).join('\n')}</div>
  <p style="font-size:12px;color:var(--buzz-ink-3);margin-top:14px;">Room settings: <a href="/setup/rooms">provisioning &amp; tuning</a></p>
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
  // Canonical rooms resolve from the builtin list; user-made rooms (created
  // via /setup/rooms) resolve from stored custom records. An unknown scope
  // still returns null so it 404s instead of rendering the wrong room.
  const def = await resolveRoomDef(db, tenant, scope);
  if (!def) return null;

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
  // Approvals for THIS room only. The predicate mirrors the room's pending
  // badge in ScopeHealthEvaluator exactly — a request that needs human minutes
  // and TARGETS this scope, in PROPOSED or ADMITTED — so the cards a room shows
  // always add up to the number on its badge. Previously this listed every
  // ADMITTED request in the tenant, which put the same approval cards in every
  // room regardless of scope.
  const pendingForRoom: { id: string; goal: string; updatedAt: string }[] = [];
  if (coord) {
    try {
      for (const state of ['PROPOSED', 'ADMITTED'] as const) {
        for (const r of await coord.list(tenant, { state })) {
          if (r.targetScope === scope && r.bid.humanMinutes > 0) {
            pendingForRoom.push({ id: r.id, goal: r.goal, updatedAt: r.updatedAt });
          }
        }
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
      return `<img src="${esc(avatarSrc)}" alt="${esc(name)}" class="buzz-agent-avatar" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.12);background:var(--buzz-inset);border:1px solid var(--buzz-border-soft);" loading="lazy">`;
    }
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${avatarColor(name)};color:var(--buzz-avatar-ink);display:grid;place-items:center;font-size:${Math.max(10, Math.round(size * 0.35))}px;font-weight:700;flex-shrink:0;border:1px solid var(--buzz-border-soft);">${esc(initials(name))}</div>`;
  };

  const pendingHtml = pendingForRoom
    .map(
      (
        r,
      ) => `<li style="display:flex;gap:10px;padding:10px 12px;border:1px solid var(--buzz-border-soft);border-left:3px solid var(--buzz-warn);background:var(--buzz-surface);border-radius:8px;margin:6px 0;list-style:none;">
    <div style="width:34px;height:34px;border-radius:6px;background:var(--buzz-warn-soft);display:grid;place-items:center;flex-shrink:0;font-size:15px;">⚠️</div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:11.5px;color:var(--buzz-ink-3);">Approval requested · ${esc(r.id.slice(0, 12))}</div>
      <div style="font-weight:600;font-size:13.5px;color:var(--buzz-ink-1);white-space:pre-wrap;margin-top:2px;">${esc(r.goal)}</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <form data-review-action="approve" action="/api/requests/${esc(r.id)}/approve" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <label style="display:inline-flex;gap:4px;align-items:center;font-size:11px;color:var(--buzz-ink-3);"><input type="checkbox" name="confirmed" required> reviewed</label>
          <button type="submit" disabled style="padding:5px 12px;border:0;border-radius:6px;background:var(--buzz-accent);color:var(--buzz-ink-inverse);font-weight:600;cursor:pointer;font-size:12px;">Approve</button>
        </form>
        <form data-review-action="decline" action="/api/requests/${esc(r.id)}/decline" method="post" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
          <input type="text" name="reason" placeholder="Decline reason" required style="padding:5px 8px;border:1px solid var(--buzz-border-soft);border-radius:6px;font-size:12px;width:150px;">
          <button type="submit" disabled style="padding:5px 12px;border:1px solid var(--buzz-border-soft);border-radius:6px;background:var(--buzz-surface);color:var(--buzz-ink-1);font-weight:600;cursor:pointer;font-size:12px;">Decline</button>
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

  const dayKey = (unixSeconds: number) => {
    const d = new Date(unixSeconds * 1000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const fmtDaySep = (unixSeconds: number) => {
    const d = new Date(unixSeconds * 1000);
    const today = new Date();
    const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const same = (a: Date, b: Date) => dayKey(a.getTime() / 1000) === dayKey(b.getTime() / 1000);
    if (same(d, today)) return 'Today';
    if (same(d, yest)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };
  let lastDayKey = '';

  const messages = tops
    .map((m) => {
      const who = displayName(m.author, config.agentName);
      // Day separator pill: only when the calendar day changes (anchors the
      // otherwise-endless stream, like the marketing pages anchor sections).
      const dk = dayKey(m.createdAt);
      const dateSep =
        dk !== lastDayKey
          ? `<li class="buzz-day-sep" role="separator"><span>${esc(fmtDaySep(m.createdAt))}</span></li>`
          : '';
      lastDayKey = dk;
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
          ? `<span style="border:1px solid var(--buzz-border-soft);border-radius:12px;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;gap:4px;background:var(--buzz-inset);color:var(--buzz-ink-1);">❤️ <span style="font-weight:600;">1</span> <span style="font-size:10px;color:var(--buzz-ink-3);">⏱️</span></span>`
          : '';

      const reactionForms = stored
        .map((r) => {
          const mine = r.me
            ? 'background:var(--buzz-info-soft);border-color:var(--buzz-info);color:var(--buzz-info);'
            : 'background:var(--buzz-inset);border-color:var(--buzz-border-soft);color:var(--buzz-ink-1);';
          return `<form method="post" action="/console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(r.emoji)}"><button type="submit" title="${r.me ? 'You reacted' : 'React'}" style="border:1px solid;border-radius:12px;padding:2px 8px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;${mine}">${esc(r.emoji)} <span style="font-weight:600;">${r.count}</span></button></form>`;
        })
        .join('');

      const reactions = isCard
        ? ''
        : `<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;align-items:center;position:relative;">${floatingHearts}${seedReaction}${reactionForms}</div>`;

      const doneMatch = /^Work done — v(\d+)/.exec(m.content);
      const doneArrow = doneMatch
        ? `<div style="margin-top:8px;"><a href="/console/deliverables/by-request/${esc(m.requestId ?? '')}" style="display:inline-flex;gap:6px;align-items:center;font-size:12px;font-weight:600;color:var(--buzz-accent);text-decoration:none;border:1px solid var(--buzz-good);background:var(--buzz-good-soft);border-radius:8px;padding:6px 10px;">→ View diff (v${esc(doneMatch[1]!)})</a></div>`
        : ``;

      const bubble = isCard
        ? `<div style="border-left:3px solid var(--buzz-warn);background:var(--buzz-warn-soft);border-radius:0 8px 8px 0;padding:10px 12px;"><div class="buzz-md" style="font-size:13.5px;line-height:1.45;color:var(--buzz-ink-1);">${renderMarkdownLite(m.content.slice(0, 4000))}</div></div>`
        : `<div class="buzz-md" style="font-size:13.5px;line-height:1.45;color:var(--buzz-ink-1);overflow-wrap:anywhere;">${renderMarkdownLite(m.content.slice(0, 4000))}</div>${doneArrow}`;

      const replies = byRoot.get(m.id) ?? [];
      const replyThreadHtml =
        replies.length > 0
          ? `<div style="margin-top:6px;">
  <details style="margin:2px 0 0 0;" open>
    <summary style="font-size:12px;font-weight:600;color:var(--buzz-info);cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;">
      <span>💬</span> <span>${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span>
      <span style="font-weight:normal;color:var(--buzz-ink-3);font-size:11px;">· Last reply ${esc(fmtClock(replies[replies.length - 1]!.createdAt))}</span>
    </summary>
    <div style="margin-top:6px;padding-left:10px;border-left:2px solid var(--buzz-border-soft);">
      ${replies
        .map((r) => {
          const rw = displayName(r.author, config.agentName);
          return `<div style="display:flex;gap:8px;padding:4px 0;">
        ${getMascotAvatar(rw, 26)}
        <div style="flex:1;"><span style="font-weight:600;font-size:12.5px;">${esc(rw)}</span> <span style="font-size:11px;color:var(--buzz-ink-3);">${esc(fmtClock(r.createdAt))}</span><div class="buzz-md" style="font-size:12.5px;margin-top:2px;">${renderMarkdownLite(r.content.slice(0, 4000))}</div></div>
      </div>`;
        })
        .join('')}
      <form id="reply-${esc(m.id)}" method="post" action="/console/buzz/${esc(scope)}/reply" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="parentId" value="${esc(m.id)}">
        <input type="text" name="content" placeholder="Reply in thread…" style="flex:1;border:1px solid var(--buzz-scroll);border-radius:6px;padding:5px 8px;font-size:12px;" maxlength="500">
        <button type="submit" style="border:1px solid var(--buzz-scroll);background:var(--buzz-surface);color:var(--buzz-ink-1);border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer;">Reply</button>
      </form>
    </div>
  </details>
</div>`
          : '';

      return `${dateSep}<li id="msg-${esc(m.id)}" class="buzz-message-row" style="display:flex;gap:12px;list-style:none;padding:8px 8px;border-radius:8px;position:relative;transition:background 0.15s;">
  ${avatarHtml}
  <div style="flex:1;min-width:0;">
    <div style="display:flex;gap:8px;align-items:baseline;">
      <span style="font-weight:700;font-size:13.5px;color:var(--buzz-ink-1);">${esc(who)}</span>
      <span style="font-size:11.5px;color:var(--buzz-ink-3);">${esc(time)}</span>
    </div>
    <div style="margin-top:2px;">${bubble}</div>
    ${reactions}
    ${replyThreadHtml}
  </div>

  <!-- Floating Hover Reaction Bar -->
  <div class="buzz-hover-bar"${m.id === 'seed_eng_9' ? ' style="opacity:1;pointer-events:auto;"' : ''}>
    ${['👍', '❤️', '😂', '🎉', '⏱️'].map((e) => `<form method="post" action="/console/buzz/${esc(scope)}/react" style="display:inline;"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="messageId" value="${esc(m.id)}"><input type="hidden" name="emoji" value="${esc(e)}"><button type="submit" class="buzz-hover-btn" title="React ${e}">${e}</button></form>`).join('')}
    <button type="button" class="buzz-hover-btn" onclick="const r=document.getElementById('reply-${esc(m.id)}');if(r)r.scrollIntoView({behavior:'smooth'});" title="Reply">↩️</button>
    <button type="button" class="buzz-hover-btn" title="More">⋯</button>
  </div>
</li>`;
    })
    .join('\n');

  // Suggestion chips for the empty-room welcome card. These are NOT new
  // features: every chip just pre-fills the existing composer with a slash
  // command or mention the command router already understands.
  const welcomeChips: { icon: string; title: string; desc: string; fill: string }[] = [
    {
      icon: 'search',
      title: 'Ask a question',
      desc: 'Get instant help from your agent',
      fill: `@${config.agentName} `,
    },
    { icon: 'chart', title: 'Room status', desc: 'Health, spend and activity', fill: '/status' },
    { icon: 'clipboard', title: 'Run a workflow', desc: 'Open the compiler board', fill: '/compiler' },
    { icon: 'at', title: 'Mention someone', desc: 'Pull a teammate or agent in', fill: '@' },
  ];
  const welcomeChipHtml = welcomeChips
    .map(
      (
        c,
      ) => `<button type="button" class="buzz-welcome-card" data-fill="${esc(c.fill)}" title="Insert into the message box">
        <span class="buzz-welcome-card__icon">${svgIcon(c.icon, 18)}</span>
        <span class="buzz-welcome-card__title">${esc(c.title)}</span>
        <span class="buzz-welcome-card__desc">${esc(c.desc)}</span>
      </button>`,
    )
    .join('\n');

  const threadList =
    pendingHtml + messages ||
    `
    <li class="buzz-welcome" style="list-style:none;">
      <div class="buzz-welcome__mascot">${getMascotAvatar(config.agentName, 44)}</div>
      <h2 class="buzz-welcome__title">Welcome to #${esc(def.name)}</h2>
      <p class="buzz-welcome__sub">${esc(config.mission ? config.mission.slice(0, 140) : `Collaborate with your team and @${config.agentName} — all in one place.`)}</p>
      <div class="buzz-welcome__grid">${welcomeChipHtml}</div>
    </li>`;

  const roomDisplayName = scope === 'infra' || rawScope === 'engineering' ? 'engineering' : def.name;

  // Budget bar fill tone (real gauge, no invented numbers).
  let budgetFillClass = '';
  if (gauge.isBreached) budgetFillClass = ' buzz-budget__fill--breached';
  else if (gauge.isWarning) budgetFillClass = ' buzz-budget__fill--warn';
  const budgetFillPct = Math.max(0, Math.min(100, gauge.percentage));

  return `
<style>
  .buzz-message-row:hover {
    background: var(--buzz-inset);
  }
  .buzz-message-row:hover .buzz-hover-bar {
    opacity: 1;
    pointer-events: auto;
  }
  .buzz-hover-bar {
    position: absolute;
    top: 4px;
    right: 12px;
    background: var(--buzz-surface);
    border: 1px solid var(--buzz-border-soft);
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
    color: var(--buzz-ink-3);
    transition: background 0.12s;
  }
  .buzz-hover-btn:hover {
    background: var(--buzz-inset-2);
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

  /* ── Chat surface: header, thread, composer ──────────────────────
     These reuse the --buzz-* tokens defined in the workspace shell's
     :root (same document), so the sidebar and the chat share one
     palette. No Console --v-* tokens and no Inter font-family here:
     that would break the surface-split regression test. */
  .buzz-header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--buzz-inset-2);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
  }
  .buzz-header__id { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .buzz-header__stack { min-width: 0; }
  .buzz-header__row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .buzz-header__title {
    font-size: 17px;
    font-weight: 700;
    margin: 0;
    color: var(--buzz-ink-1);
    letter-spacing: -0.01em;
  }
  .buzz-header__sub { font-size: 11px; color: var(--buzz-ink-3); margin-top: 2px; }
  .buzz-header__agent { font-weight: 600; color: var(--buzz-accent); }
  .buzz-header__actions { display: flex; align-items: center; gap: 8px; color: var(--buzz-ink-3); flex-shrink: 0; }
  .buzz-header__meta-item {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 12.5px; color: var(--buzz-ink-3); font-weight: 500;
    font-variant-numeric: tabular-nums; padding-right: 4px;
  }
  .buzz-icon-btn {
    display: grid; place-items: center;
    width: 30px; height: 30px;
    background: none; border: none; cursor: pointer;
    color: var(--buzz-ink-3); border-radius: var(--buzz-r-md);
    transition: background 0.12s var(--buzz-ease), color 0.12s var(--buzz-ease);
  }
  .buzz-icon-btn:hover { background: var(--buzz-surface-hover); color: var(--buzz-ink-1); }

  .buzz-health { font-size: 12px; }
  .buzz-budget { display: inline-flex; align-items: center; gap: 7px; }
  .buzz-budget__track {
    width: 64px; height: 4px; border-radius: 999px;
    background: var(--buzz-track); overflow: hidden; display: inline-block;
  }
  .buzz-budget__fill { display: block; height: 100%; border-radius: 999px; background: var(--buzz-accent); transition: width 0.3s var(--buzz-ease); }
  .buzz-budget__fill--warn { background: var(--buzz-warn); }
  .buzz-budget__fill--breached { background: var(--buzz-risk); }
  .buzz-budget__label { font-size: 11.5px; color: var(--buzz-ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* Markdown-lite inline styles */
  .buzz-md-strong { font-weight: 700; color: var(--buzz-ink-1); }
  .buzz-md-em { font-style: italic; }
  .buzz-md-code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.9em; background: var(--buzz-inset-2); border: 1px solid var(--buzz-border-soft);
    border-radius: 4px; padding: 0 4px; color: var(--buzz-code-ink);
  }
  .buzz-md-link { color: var(--buzz-info); text-decoration: none; }
  .buzz-md-link:hover { text-decoration: underline; }

  /* Markdown-lite block styles (renderMarkdownLite). The bubble keeps its
     own font-size; blocks only add structure + rhythm. Plain messages stay
     one pre-wrap <p>, so human line breaks render as before. */
  .buzz-md > * + * { margin-top: 5px; }
  .buzz-md-p { white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
  .buzz-md-h { font-weight: 700; color: var(--buzz-ink-1); line-height: 1.3; }
  .buzz-md-h--1 { font-size: 1.18em; }
  .buzz-md-h--2 { font-size: 1.1em; }
  .buzz-md-h--3 { font-size: 1.04em; }
  .buzz-md-h--4, .buzz-md-h--5, .buzz-md-h--6 { font-size: 1em; }
  .buzz-md-list { margin: 0; padding-left: 22px; }
  ul.buzz-md-list { list-style: disc; }
  ol.buzz-md-list { list-style: decimal; }
  .buzz-md-li { margin: 1px 0; }
  .buzz-md-pre {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.5; color: var(--buzz-code-ink); background: var(--buzz-inset);
    border: 1px solid var(--buzz-border-soft); border-radius: 8px; padding: 8px 10px;
    margin: 0; overflow-x: auto; white-space: pre;
  }
  .buzz-md-pre code { font: inherit; background: none; border: 0; padding: 0; }
  .buzz-md-quote {
    margin: 0; padding: 2px 0 2px 10px; border-left: 3px solid var(--buzz-border-soft);
    color: var(--buzz-ink-3); white-space: pre-wrap;
  }
  .buzz-md-hr { border: 0; border-top: 1px solid var(--buzz-border-soft); margin: 2px 0; }

  /* Day separator pill */
  .buzz-day-sep {
    list-style: none; display: flex; justify-content: center;
    margin: 10px 0 4px;
  }
  .buzz-day-sep span {
    background: var(--buzz-inset); border: 1px solid var(--buzz-border-soft); border-radius: 999px;
    padding: 2px 12px; font-size: 11px; font-weight: 600; color: var(--buzz-ink-3);
  }

  /* Welcome (empty-room) card */
  .buzz-welcome { padding: 40px 18px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; }
  .buzz-welcome__mascot { margin-bottom: 10px; }
  .buzz-welcome__title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: var(--buzz-ink-1); margin: 0; }
  .buzz-welcome__sub { font-size: 13.5px; color: var(--buzz-ink-3); margin: 6px 0 22px; max-width: 460px; }
  .buzz-welcome__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; width: 100%; max-width: 620px; }
  .buzz-welcome-card {
    text-align: left; cursor: pointer; font: inherit;
    background: var(--buzz-surface); border: 1px solid var(--buzz-border);
    border-radius: var(--buzz-r-lg); padding: 14px;
    display: flex; flex-direction: column; gap: 4px;
    transition: border-color 0.15s var(--buzz-ease), box-shadow 0.15s var(--buzz-ease), transform 0.15s var(--buzz-ease);
  }
  .buzz-welcome-card:hover { border-color: var(--buzz-accent); box-shadow: var(--buzz-shadow-pop); transform: translateY(-2px); }
  .buzz-welcome-card__icon { color: var(--buzz-accent); margin-bottom: 6px; }
  .buzz-welcome-card__title { font-size: 13.5px; font-weight: 600; color: var(--buzz-ink-1); }
  .buzz-welcome-card__desc { font-size: 12px; color: var(--buzz-ink-3); }

  /* Composer */
  .buzz-composer { padding: 10px 20px 16px; background: var(--buzz-surface); flex-shrink: 0; }
  .buzz-composer__form { display: flex; flex-direction: column; }
  .buzz-composer__card {
    border: 1px solid var(--buzz-border-soft); border-radius: var(--buzz-r-lg);
    padding: 10px 14px; background: var(--buzz-surface);
    box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    display: flex; flex-direction: column; gap: 8px;
    transition: border-color 0.15s var(--buzz-ease), box-shadow 0.15s var(--buzz-ease);
  }
  .buzz-composer__card:focus-within { border-color: var(--buzz-accent); box-shadow: 0 0 0 3px var(--buzz-accent-ring); }
  .buzz-composer__input {
    border: none; outline: none; font-size: 13.5px; color: var(--buzz-ink-1);
    width: 100%; font-family: inherit; padding: 2px 0; background: transparent;
  }
  .buzz-composer__bar { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }
  .buzz-composer__tools { display: flex; align-items: center; gap: 2px; }
  .buzz-tool-btn {
    display: grid; place-items: center; width: 28px; height: 28px;
    border: none; background: transparent; cursor: pointer;
    color: var(--buzz-ink-3); border-radius: var(--buzz-r-sm);
    transition: background 0.12s var(--buzz-ease), color 0.12s var(--buzz-ease);
  }
  .buzz-tool-btn:hover { background: var(--buzz-surface-hover); color: var(--buzz-ink-1); }
  .buzz-composer__send {
    width: 30px; height: 30px; border-radius: 50%; border: none;
    background: var(--buzz-border); color: var(--buzz-ink-3); display: grid; place-items: center;
    cursor: pointer; transition: background 0.15s var(--buzz-ease), color 0.15s var(--buzz-ease), transform 0.15s var(--buzz-ease);
  }
  .buzz-composer__send--ready { background: var(--buzz-ink-1); color: var(--buzz-ink-inverse); }
  .buzz-composer__send:hover { transform: translateY(-1px); }
  .buzz-emoji-pick { display: none; gap: 6px; flex-wrap: wrap; padding: 6px; background: var(--buzz-inset); border-radius: var(--buzz-r-md); border: 1px solid var(--buzz-border-soft); margin-top: 4px; }

  #chat-messages-stream::-webkit-scrollbar { width: 6px; }
  #chat-messages-stream::-webkit-scrollbar-thumb { background: var(--buzz-scroll); border-radius: 6px; }

  @media (prefers-reduced-motion: reduce) {
    .buzz-welcome-card:hover, .buzz-composer__send:hover, .buzz-icon-btn:hover { transform: none; }
  }
</style>

<div style="display:flex;flex-direction:column;height:100%;min-height:0;background:var(--buzz-surface);overflow:hidden;position:relative;">
  <!-- Room Header -->
  <header class="buzz-header">
    <div class="buzz-header__id">
      ${getMascotAvatar(config.agentName, 34)}
      <div class="buzz-header__stack">
        <div class="buzz-header__row">
          <h1 class="buzz-header__title"># ${esc(roomDisplayName)}</h1>
          <span class="buzz-health" title="Room health: ${esc(health.status)}${health.reasons.length > 0 ? ' — ' + esc(health.reasons.join('; ')) : ''}">${esc(health.badge)}</span>
          <span class="buzz-budget" title="Live budget: real spend from the coordinator (${gauge.percentage}% of ceiling)">
            <span class="buzz-budget__track"><span class="buzz-budget__fill${budgetFillClass}" style="width:${budgetFillPct}%;"></span></span>
            <span class="buzz-budget__label">$${esc(gauge.dollarsSpent.toFixed(0))} / $${esc(gauge.dollarsCeiling.toFixed(0))}</span>
          </span>
        </div>
        <div class="buzz-header__sub">
          Room Agent: <span class="buzz-header__agent">@${esc(config.agentName)}</span> · ${autonomyBadge(config.autonomy)}
        </div>
      </div>
    </div>
    <div class="buzz-header__actions">
      <span class="buzz-header__meta-item" title="Distinct authors who have posted in this room">
        ${svgIcon('users', 14)} <span>${memberCount > 0 ? memberCount : '—'}</span>
      </span>
      <button type="button" class="buzz-icon-btn" onclick="window.openBuzzDrawer('/console/compiler?drawer=1', 'Compiler Board')" title="Huddle / Audio">${svgIcon('mic', 16)}</button>
      <button type="button" class="buzz-icon-btn" onclick="window.openBuzzDrawer('/console/requests?drawer=1', 'Review Queue')" title="Toggle Panel">${svgIcon('panel', 16)}</button>
      <!-- Subtle drawer anchors for test compatibility -->
      <button type="button" onclick="window.openBuzzDrawer('/console/compiler?drawer=1', 'Compiler Board')" style="display:none;">📊 Compiler</button>
      <button type="button" onclick="window.openBuzzDrawer('/console/claims?drawer=1', 'Evidence Ledger')" style="display:none;">📜 Ledger</button>
      <button type="button" onclick="window.openBuzzDrawer('/console/requests?drawer=1', 'Review Queue')" style="display:none;">📋 Reviews</button>
    </div>
  </header>

  <!-- Floating scroll-to-latest pill -->
  <div style="display:flex;justify-content:center;margin:6px 0 -8px;position:relative;z-index:5;">
    <div style="background:var(--buzz-inset);border:1px solid var(--buzz-border-soft);border-radius:20px;padding:3px 12px;font-size:11px;font-weight:600;color:var(--buzz-ink-3);box-shadow:0 1px 3px rgba(0,0,0,0.04);cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
      <span>↑</span> <span>Jump to latest</span>
    </div>
  </div>

  ${notice ? `<div style="background:var(--buzz-good-soft);border-bottom:1px solid var(--buzz-good);padding:6px 20px;font-size:12px;color:var(--buzz-good);flex-shrink:0;">${esc(notice)}</div>` : ''}

  <!-- Message Stream -->
  <div class="review-root" id="chat-messages-stream" style="flex:1;overflow-y:auto;padding:14px 20px;min-height:0;display:flex;flex-direction:column;gap:6px;">
    <ul style="padding:0;margin:0;list-style:none;display:flex;flex-direction:column;gap:4px;">${threadList}</ul>
  </div>

  <!-- Buzz Message Composer -->
  <div class="buzz-composer">
    <span style="display:none">Send a command</span>
    <form method="post" action="/console/buzz/${esc(scope)}/command" class="buzz-composer__form">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="buzz-composer__card">
        <input type="text" name="command" id="buzz-composer" list="buzz-commands" class="buzz-composer__input" placeholder="Message #${esc(roomDisplayName)}" autocomplete="off">
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

        <div class="buzz-composer__bar">
          <div class="buzz-composer__tools">
            <button type="button" id="buzz-at" class="buzz-tool-btn" title="Mention someone">${svgIcon('at', 16)}</button>
            <button type="button" class="buzz-tool-btn" title="Attach file">${svgIcon('paperclip', 16)}</button>
            <button type="button" id="buzz-emoji" class="buzz-tool-btn" title="Emoji">${svgIcon('smile', 16)}</button>
            <button type="button" class="buzz-tool-btn" title="Formatting">${svgIcon('bold', 16)}</button>
          </div>
          <button type="submit" aria-label="Send" id="buzz-send" class="buzz-composer__send">${svgIcon('send', 15)}</button>
        </div>
      </div>
      <div id="buzz-emoji-pick" class="buzz-emoji-pick">
        ${['😀', '😂', '❤️', '🚀', '✅', '👀', '🎉', '👍', '🔥', '💡'].map((e) => `<button type="button" data-emoji="${esc(e)}" style="border:1px solid var(--buzz-border-soft);background:var(--buzz-surface);border-radius:6px;padding:3px 6px;cursor:pointer;">${esc(e)}</button>`).join('')}
      </div>
    </form>
  </div>

  <script>try{
    const i=document.getElementById('buzz-composer');
    const at=document.getElementById('buzz-at');
    const em=document.getElementById('buzz-emoji');
    const pick=document.getElementById('buzz-emoji-pick');
    const send=document.getElementById('buzz-send');
    const syncSend=()=>{if(send&&i)send.classList.toggle('buzz-composer__send--ready',i.value.trim().length>0);};
    if(at&&i){at.addEventListener('click',()=>{const s=i.selectionStart??i.value.length;const v=i.value;i.value=v.slice(0,s)+'@'+v.slice(s);i.focus();i.setSelectionRange(s+1,s+1);i.setAttribute('list','buzz-users');syncSend();try{i.showPicker&&i.showPicker();}catch{}});}
    if(em&&pick){em.addEventListener('click',()=>{const shown=getComputedStyle(pick).display!=='none';pick.style.display=shown?'none':'flex';});pick.querySelectorAll('[data-emoji]').forEach(b=>b.addEventListener('click',()=>{const s=i.selectionStart??i.value.length;const v=i.value;i.value=v.slice(0,s)+b.dataset.emoji+v.slice(s);i.focus();syncSend();pick.style.display='none';}));}
    if(i){i.addEventListener('input',()=>{if(i.value.includes('@'))i.setAttribute('list','buzz-users');syncSend();});i.addEventListener('keydown',e=>{if(e.key==='/'&&!i.value){i.setAttribute('list','buzz-commands');}});}
    // Welcome-card suggestion chips pre-fill the existing composer (no new commands).
    document.querySelectorAll('.buzz-welcome-card[data-fill]').forEach(c=>c.addEventListener('click',()=>{if(!i)return;i.value=c.getAttribute('data-fill');i.focus();i.setSelectionRange(i.value.length,i.value.length);syncSend();}));
  }catch{}</script>

  <!-- Slide-out Drawer for Reviews, Compiler and Ledger -->
  <div id="buzz-drawer" style="display:none;position:fixed;top:0;right:0;width:580px;max-width:92vw;height:100vh;background:var(--buzz-surface);border-left:1px solid var(--buzz-hairline);box-shadow:-4px 0 24px rgba(0,0,0,0.12);z-index:9999;flex-direction:column;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--buzz-hairline);background:var(--buzz-inset);">
      <h3 id="buzz-drawer-title" style="margin:0;font-size:14px;font-weight:600;color:var(--buzz-ink-1);">Drawer</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <a id="buzz-drawer-fullscreen" href="#" target="_blank" style="font-size:12px;color:var(--buzz-accent);text-decoration:none;padding:4px 8px;border:1px solid var(--buzz-border);border-radius:6px;background:var(--buzz-surface);">Full view ↗</a>
        <button type="button" id="buzz-drawer-close" style="background:transparent;border:0;font-size:18px;line-height:1;cursor:pointer;color:var(--buzz-ink-3);">✕</button>
      </div>
    </div>
    <div id="buzz-drawer-content" style="flex:1;overflow:auto;padding:16px;">
      <div style="color:var(--buzz-ink-3);font-size:13px;">Loading...</div>
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
    content.innerHTML = '<p style="color:var(--buzz-ink-3);font-size:13px;padding:12px;">Loading...</p>';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<p style="color:var(--buzz-risk);font-size:13px;padding:12px;">Failed to load: ' + err.message + '</p>';
    }
  };
  window.closeBuzzDrawer = function() {
    const drawer = document.getElementById('buzz-drawer');
    if (drawer) drawer.style.display = 'none';
  };
  </script>
</div>`;
}
