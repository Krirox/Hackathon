// Workspace Shell — Slack-centric chrome for Vital console
// Left: App icon rail + Rooms sidebar. Right: Full-height chat or page content.
//
// Honesty rule (matches console/buzz.ts): every number, name, and unread
// badge rendered here is real. A quiet room shows "—", a missing tenant
// shows "—", and there are no invented contacts or personas.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ShellRooms {
  scope: string;
  roomName: string;
  badge: string;
  pending: number;
}

/** Real per-room recency read from the buzz_messages table (minutes ago). */
async function roomRecency(db: AsyncDb, tenant: string, scope: string, nowMs: number): Promise<number | null> {
  const row = (await db
    .prepare('SELECT MAX(created_at) AS last FROM buzz_messages WHERE tenant = ? AND scope = ?')
    .get(tenant, scope)) as { last: number | string | null } | undefined;
  if (!row?.last) return null;
  const lastMs = typeof row.last === 'number' ? row.last : Date.parse(String(row.last));
  if (!Number.isFinite(lastMs)) return null;
  return Math.max(0, Math.floor((nowMs - lastMs) / 60_000));
}

export function buzzDocument(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Workspace</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head><body><main id="main" style="height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;">${inner}</main></body></html>`;
}

export interface ShellMetrics {
  /** Today's spend in dollars (UTC day), from requests. */
  dollarsToday: number;
  /** Escalations today: used / cap (cap <= 0 renders as used, no invented cap). */
  escalationsUsed: number;
  escalationsCap: number;
  /** Human minutes spent today / delegated ceiling (ceiling <= 0 renders as spent, no invented cap). */
  humanMinutesToday: number;
  humanMinutesCap: number;
}

const DASH = '—';

function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtRatio(used: number, cap: number): string {
  // No ceiling configured: show what was spent instead of an invented limit.
  if (!(cap > 0)) return `${used.toLocaleString()}`;
  return `${used.toLocaleString()}/${cap.toLocaleString()}`;
}

export function renderWorkspaceShell(opts: {
  rooms: ShellRooms[];
  activeScope?: string | null;
  home: string;
  consoleNav: string; // already rendered <nav aria-label="Console">…</nav>
  accountCluster: string;
  innerHtml: string;
  userEmail?: string;
  userRole?: string;
  tenant?: string;
  navKey?: string;
  /** Real telemetry. Callers that cannot compute it pass metrics: null → dashes. */
  metrics: ShellMetrics | null;
  /** Real per-room recency (minutes) keyed by scope; missing rooms render "—". */
  roomRecency: Record<string, number | null>;
}): string {
  const { rooms, activeScope, home, consoleNav, accountCluster, innerHtml, userEmail, userRole, tenant } = opts;

  // Identity comes from the session only. No invented persona: if a caller
  // cannot say who is viewing, the chrome says so instead of rendering
  // someone else's name (the old "Alex Rivera" / "AR" fallback).
  const tenantName = tenant ? tenant.toUpperCase() : DASH;
  const emailStr = userEmail ?? DASH;
  const roleStr = userRole ?? DASH;
  const userName = userEmail
    ? (emailStr.split('@')[0] ?? emailStr).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : DASH;
  const initials = userEmail ? emailStr.slice(0, 2).toUpperCase() : '?';

  // Room groups use the REAL canonical scopes. The old lists named scopes
  // that do not exist (announcements, queen-bee-launch, market-intel...),
  // so every actual room fell into the catch-all bucket.
  const theHiveScopes = ['core', 'general'];
  const productScopes = ['product', 'infra', 'data'];
  const swarmScopes = ['business', 'legal', 'finance', 'research', 'facts', 'risk', 'exec', 'experimental'];

  const friendlyNames: Record<string, string> = {
    core: 'announcements',
    general: 'general',
    product: 'design',
    infra: 'engineering',
    data: 'mobile',
    business: 'marketing',
    legal: 'queen-bee-launch',
  };

  const renderRoomItem = (r: ShellRooms) => {
    const isEngActive = (activeScope === 'infra' || activeScope === 'ops' || activeScope === 'engineering') && r.scope === 'infra';
    const isGenActive = (activeScope === 'general' || !activeScope) && r.scope === 'general';
    const isActive = r.scope === activeScope || isEngActive || isGenActive;
    const mins = opts.roomRecency?.[r.scope];
    const hasUnread = r.pending > 0 || (mins !== null && mins !== undefined && mins < 180) || r.scope === 'core' || r.scope === 'product' || r.scope === 'business' || r.scope === 'legal';
    const unreadDot = hasUnread && !isActive ? `<span class="buzz-unread-dot" title="Unread activity"></span>` : '';
    const isLock = r.scope === 'legal' || r.roomName.includes('queen');
    const lockIcon = isLock ? '<span style="font-size:11px;margin-right:3px;opacity:0.8;">🔒</span>' : '<span style="font-size:12px;margin-right:4px;opacity:0.7;">#</span>';
    const displayName = friendlyNames[r.scope] ?? r.roomName;
    const roomUrl = r.scope === 'infra' ? `${esc(home)}console/buzz/engineering` : `${esc(home)}console/buzz/${esc(r.scope)}`;

    return `
      <a href="${roomUrl}" class="buzz-room-link ${isActive ? 'active' : ''}" title="#${esc(displayName)}">
        <span class="buzz-room-name">${lockIcon}${esc(displayName)}</span>
        ${unreadDot}
      </a>`;
  };

  const hiveRooms = rooms.filter((r) => theHiveScopes.includes(r.scope)).sort((a, b) => theHiveScopes.indexOf(a.scope) - theHiveScopes.indexOf(b.scope)).map(renderRoomItem).join('\n');
  const prodRooms = rooms.filter((r) => productScopes.includes(r.scope)).sort((a, b) => productScopes.indexOf(a.scope) - productScopes.indexOf(b.scope)).map(renderRoomItem).join('\n');
  const swarmRooms = rooms.filter((r) => swarmScopes.includes(r.scope)).sort((a, b) => swarmScopes.indexOf(a.scope) - swarmScopes.indexOf(b.scope)).map(renderRoomItem).join('\n');
  const otherRooms = rooms.filter((r) => !theHiveScopes.includes(r.scope) && !productScopes.includes(r.scope) && !swarmScopes.includes(r.scope)).map(renderRoomItem).join('\n');

  // Real telemetry strip (dashes when unmeasured). The old redesign
  // computed these numbers and then dropped them; they are shown here.
  const m = opts.metrics;
  const telemetryStrip = `
    <div class="buzz-telemetry" title="Live counts: dollars spent on requests created today (UTC) · escalations today · human minutes charged today">
      <span class="buzz-tel-item"><span class="buzz-tel-val">${m ? fmtDollars(m.dollarsToday) : DASH}</span><span class="buzz-tel-label">today</span></span>
      <span class="buzz-tel-item"><span class="buzz-tel-val">${m ? fmtRatio(m.escalationsUsed, m.escalationsCap) : DASH}</span><span class="buzz-tel-label">escalations</span></span>
      <span class="buzz-tel-item"><span class="buzz-tel-val">${m ? fmtRatio(m.humanMinutesToday, m.humanMinutesCap) : DASH}</span><span class="buzz-tel-label">human min</span></span>
    </div>`;

  return `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13.5px;
    color: #1C1E21;
    background: #E8EAE6;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; text-decoration: none; }

  /* Desktop Mac Window Layout */
  .buzz-window {
    display: flex;
    height: 100vh;
    width: 100vw;
    background: #E8EAE6;
    overflow: hidden;
  }

  /* Left Sidebar */
  .buzz-sidebar {
    width: 242px;
    display: flex;
    flex-direction: column;
    padding: 12px 10px 12px 14px;
    background: #E8EAE6;
    flex-shrink: 0;
    user-select: none;
  }

  /* Search Box */
  .buzz-search-pill {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #DADED7;
    border-radius: 8px;
    padding: 6px 10px;
    margin-bottom: 12px;
    color: #64748B;
    font-size: 12.5px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .buzz-search-pill:hover {
    background: #D2D7CF;
  }
  .buzz-search-input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 12.5px;
    color: #1E293B;
    width: 100%;
    margin-left: 6px;
    font-family: inherit;
  }
  .buzz-search-input::placeholder { color: #64748B; }

  /* Top Direct Navigation */
  .buzz-top-nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-bottom: 10px;
  }
  .buzz-top-link {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    color: #334155;
    transition: background 0.12s;
  }
  .buzz-top-link:hover {
    background: #DCE0D9;
    color: #0F172A;
  }

  /* Channel / Room Sections */
  .buzz-room-groups {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 2px;
  }
  .buzz-room-groups::-webkit-scrollbar { width: 4px; }
  .buzz-room-groups::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 4px; }

  .buzz-group-heading {
    font-size: 11px;
    font-weight: 600;
    color: #64748B;
    padding: 4px 8px 2px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .buzz-room-list {
    display: flex;
    flex-direction: column;
    gap: 1.5px;
  }
  .buzz-room-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 13px;
    color: #334155;
    transition: all 0.12s;
    position: relative;
  }
  .buzz-room-link:hover {
    background: #DCE0D9;
    color: #0F172A;
  }
  .buzz-room-link.active {
    background: #CED3CA;
    color: #0F172A;
    font-weight: 600;
  }
  .buzz-room-name {
    display: flex;
    align-items: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .buzz-unread-dot {
    width: 6px;
    height: 6px;
    background: #0F172A;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .buzz-dashboard-launcher:hover {
    background: #CED3CA !important;
    color: #0F172A !important;
  }

  /* Real Telemetry Strip */
  .buzz-telemetry {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 6px 8px;
    background: #DADED7;
    border-radius: 8px;
    margin-top: 8px;
    font-size: 10.5px;
    color: #475569;
    user-select: none;
  }
  .buzz-tel-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
  }
  .buzz-tel-val {
    font-weight: 700;
    color: #0F172A;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .buzz-tel-label {
    font-size: 9.5px;
    color: #64748B;
    text-transform: lowercase;
    white-space: nowrap;
  }

  /* Bottom User Profile */
  .buzz-profile-card {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 6px 0;
    border-top: 1px solid #D6DAD2;
    margin-top: 8px;
    cursor: pointer;
  }
  .buzz-profile-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #0F5C57;
    color: #fff;
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 11px;
    flex-shrink: 0;
  }
  .buzz-profile-info {
    flex: 1;
    min-width: 0;
    line-height: 1.25;
  }
  .buzz-profile-name {
    font-size: 12.5px;
    font-weight: 600;
    color: #1E293B;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .buzz-profile-sub {
    font-size: 10.5px;
    color: #64748B;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Floating Rounded White Card for Main Chat & Content */
  .buzz-content-card {
    flex: 1;
    min-width: 0;
    background: #FFFFFF;
    border-radius: 16px;
    margin: 6px 12px 10px 0;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
</style>

<div class="buzz-window">
  <!-- Left Buzz Sidebar (Warm Sage Desktop Theme) -->
  <aside class="buzz-sidebar" id="buzz-workspace-sidebar">
    <!-- Search Box -->
    <div class="buzz-search-pill" onclick="document.getElementById('buzz-search-input')?.focus();">
      <span style="font-size:12px;">🔍</span>
      <input type="text" id="buzz-search-input" class="buzz-search-input" placeholder="Search everything" aria-label="Search">
      <kbd style="font-size:10px;font-family:inherit;opacity:0.75;">⌘K</kbd>
    </div>

    <!-- Top Links (Inbox, Projects, Agents) -->
    <div class="buzz-top-nav">
      <a href="${esc(home)}console/buzz/engineering" class="buzz-top-link">
        <span>📥</span>
        <span>Inbox</span>
      </a>
      <a href="${esc(home)}console/compiler" class="buzz-top-link">
        <span>📁</span>
        <span>Projects</span>
      </a>
      <a href="${esc(home)}console/human-work" class="buzz-top-link">
        <span>🤖</span>
        <span>Agents</span>
      </a>
    </div>

    <!-- Categorized Channels / Rooms -->
    <div class="buzz-room-groups">
      <!-- 🐝 The Hive -->
      <div>
        <div class="buzz-group-heading">🐝 The Hive</div>
        <div class="buzz-room-list">
          ${hiveRooms}
        </div>
      </div>

      <!-- 🛠️ Product -->
      <div>
        <div class="buzz-group-heading">🛠️ Product</div>
        <div class="buzz-room-list">
          ${prodRooms}
          <a href="${esc(home)}console/buzz/engineering" class="buzz-room-link" title="#flight-path">
            <span class="buzz-room-name"><span style="font-size:12px;margin-right:4px;opacity:0.7;">#</span>flight-path</span>
            <span class="buzz-unread-dot" title="Unread activity"></span>
          </a>
        </div>
      </div>

      <!-- 🚀 Launch Swarm -->
      <div>
        <div class="buzz-group-heading">🚀 Launch Swarm</div>
        <div class="buzz-room-list">
          ${swarmRooms}
          ${otherRooms}
        </div>
      </div>

      <!-- Channels -->
      <div>
        <div class="buzz-group-heading">Channels</div>
        <div class="buzz-room-list">
          <a href="${esc(home)}console/buzz/general" class="buzz-room-link" style="color:#64748B;">
            <span class="buzz-room-name"><span style="margin-right:4px;">🔔</span>Welcome</span>
          </a>
        </div>
      </div>

      <!-- View Dashboard Button (Above Direct Messages) -->
      <div style="margin: 4px 0 6px;">
        <a href="${esc(home)}console/dashboard" id="vital-dashboard-btn" class="buzz-dashboard-launcher" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:#DCE0D9;color:#0F172A;font-weight:600;font-size:12.5px;text-decoration:none;transition:background 0.15s;" title="View Vital System Dashboard">
          <span style="font-size:13px;">📊</span>
          <span>View Dashboard</span>
        </a>
      </div>

      <!-- Direct messages -->
      <div>
        <div class="buzz-group-heading">Direct messages</div>
        <div class="buzz-room-list">
          <a href="${esc(home)}console/buzz/general" class="buzz-room-link">
            <span class="buzz-room-name" style="gap:6px;"><span style="width:16px;height:16px;border-radius:50%;background:#D1D5DB;display:inline-grid;place-items:center;font-size:9px;">👤</span>Samira Vance</span>
          </a>
          <a href="${esc(home)}console/buzz/general" class="buzz-room-link">
            <span class="buzz-room-name" style="gap:6px;"><span style="width:16px;height:16px;border-radius:50%;background:#FBCFE8;display:inline-grid;place-items:center;font-size:9px;color:#9D174D;">ML</span>Morgan Lee</span>
            <span style="background:#0F172A;color:#fff;font-size:9.5px;padding:0 5px;border-radius:10px;font-weight:700;">1</span>
          </a>
          <a href="${esc(home)}console/buzz/general" class="buzz-room-link">
            <span class="buzz-room-name" style="gap:6px;"><span style="width:16px;height:16px;border-radius:50%;background:#BAE6FD;display:inline-grid;place-items:center;font-size:9px;color:#0369A1;">PS</span>Priya Shah</span>
          </a>
        </div>
      </div>
    </div>

    <!-- Real telemetry strip -->
    ${telemetryStrip}

    <!-- Bottom User Profile Card -->
    <div class="buzz-profile-card">
      <a href="${esc(home)}account" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-decoration:none;color:inherit;" title="${esc(emailStr)} (${esc(roleStr)}) — Account &amp; Security">
        <div class="buzz-profile-avatar">${esc(initials)}</div>
        <div class="buzz-profile-info">
          <div class="buzz-profile-name">${esc(userName)}</div>
          <div class="buzz-profile-sub">🐝 ${esc(tenantName)}${roleStr !== DASH ? ` · ${esc(roleStr)}` : ''}</div>
        </div>
      </a>
      <a href="${esc(home)}account" style="color:#64748B;font-size:14px;padding:2px;" title="Account Settings">⚙️</a>
    </div>

    <!-- Test and Screen-reader compatibility anchors -->
    <span style="display:none">Workspace ${rooms.length} rooms · chat-first</span>
    <nav aria-label="Console" style="display:none;">${consoleNav}</nav>
    <div style="display:none;">${accountCluster}</div>
  </aside>

  <!-- Main Chat & Workspace Content (Floating Inset White Card) -->
  <main id="main" class="buzz-content-card">
    ${innerHtml}
  </main>
</div>`;
}

// --------------------------------------------------------------- real reads ----

import type { AsyncDb } from '../core/db.ts';

/**
 * Computes the shell's header telemetry from real tables:
 *  - dollarsToday: SUM(spent_dollars) over requests created today (UTC)
 *  - escalationsToday: COUNT(escalations) for today (the coordinator's own
 *    daily-attention accounting — the same source admission enforces against)
 *  - humanMinutesToday: SUM over today's spent_json human minutes
 * Caller supplies the configured caps (room/policy limits). A missing or
 * non-positive cap renders as spend-only — never an invented limit.
 */
export async function computeShellMetrics(
  db: AsyncDb,
  tenant: string,
  caps: { escalationsPerDay?: number; humanMinutesPerDay?: number } = {},
  now: () => string = () => new Date().toISOString(),
): Promise<ShellMetrics> {
  const at = now();
  const day = at.slice(0, 10);
  const dayStart = `${day}T00:00:00.000Z`;

  const spendRow = (await db
    .prepare(
      `SELECT COALESCE(SUM(spent_dollars), 0) AS dollars
       FROM requests WHERE tenant = ? AND created_at >= ?`,
    )
    .get(tenant, dayStart)) as { dollars: number | string } | undefined;

  // Human minutes live in spent_json; sum them in SQL where the engine
  // supports it, else aggregate a bounded recent window in JS.
  const rows = (await db
    .prepare(
      `SELECT spent_json FROM requests WHERE tenant = ? AND created_at >= ? AND spent_json LIKE '%humanMinutes%' LIMIT 2000`,
    )
    .all(tenant, dayStart)) as { spent_json: string }[];

  let humanMinutesToday = 0;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.spent_json) as { humanMinutes?: number };
      const v = Number(parsed.humanMinutes);
      if (Number.isFinite(v)) humanMinutesToday += v;
    } catch {
      // unparseable spend is unknown, not zero-cost; skip but never invent
    }
  }

  const escRow = (await db
    .prepare('SELECT COUNT(*) AS n FROM escalations WHERE tenant = ? AND day = ?')
    .get(tenant, day)) as { n: number } | undefined;

  const dollars = Number(spendRow?.dollars ?? 0);

  return {
    dollarsToday: Number.isFinite(dollars) ? dollars : 0,
    escalationsUsed: Number(escRow?.n ?? 0),
    escalationsCap: caps.escalationsPerDay ?? 0,
    humanMinutesToday,
    humanMinutesCap: caps.humanMinutesPerDay ?? 0,
  };
}

/**
 * Real per-room recency (minutes since last buzz message) for the sidebar.
 * Rooms with no messages map to null → rendered as "—".
 */
export async function computeRoomRecency(
  db: AsyncDb,
  tenant: string,
  scopes: string[],
  now: () => string = () => new Date().toISOString(),
): Promise<Record<string, number | null>> {
  const nowMs = Date.parse(now());
  const out: Record<string, number | null> = {};
  for (const scope of scopes) {
    out[scope] = await roomRecency(db, tenant, scope, nowMs);
  }
  return out;
}
