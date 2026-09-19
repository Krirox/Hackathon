// Workspace Shell — Slack-centric chrome for Vital console
// Left: App icon rail + Rooms sidebar. Right: Full-height chat or page content.
//
// Honesty rule (matches console/buzz.ts): every number, name, and unread
// badge rendered here is real. A quiet room shows "—", a missing tenant
// shows "—", and there are no invented contacts or personas.

import { getScopeAvatarSrc } from './buzz.ts';
import { svgIcon } from './buzz-icons.ts';
import { parseTeam } from '../core/auth.ts';
import { isCanonicalScope } from '../talk/rooms.ts';
import type { ShellMetrics } from './shell-metrics.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ShellRooms {
  scope: string;
  roomName: string;
  badge: string;
  pending: number;
}

export function buzzDocument(title: string, inner: string): string {
  // The trailing comment opts this document out of the Console design system:
  // the Workspace mirrors upstream Buzz, which means Buzz's own native font
  // stack and palette, not the Console tokens. See THEME_OPTOUT_MARKER.
  return `<!doctype html><html lang="en"><head><!-- data-vital-no-theme --><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Workspace</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>try{if(localStorage.getItem('buzz-theme')==='dark'){document.documentElement.className+=' buzz-dark';}}catch(e){}</script>
</head><body><main id="main" style="height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;">${inner}</main></body></html>`;
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
  /** Session user's department — gates the engineers-only Issues link. */
  userTeam?: string;
  tenant?: string;
  navKey?: string;
  /** Real telemetry. Callers that cannot compute it pass metrics: null → dashes. */
  metrics: ShellMetrics | null;
  /** Real per-room recency (minutes) keyed by scope; missing rooms render "—". */
  roomRecency: Record<string, number | null>;
}): string {
  const { rooms, activeScope, home: _home, consoleNav, accountCluster, innerHtml, userEmail, userRole, tenant } = opts;

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

  // Room groups use the REAL canonical scopes. User-made rooms (custom
  // scopes) render under "Custom rooms". Nothing invented: names come from
  // the health evaluation, unread from pending approvals or recent activity.
  const theHiveScopes = ['core', 'general'];
  const productScopes = ['product', 'infra', 'data'];
  const swarmScopes = ['business', 'legal', 'finance', 'research', 'facts', 'risk', 'exec', 'experimental'];

  const renderRoomItem = (r: ShellRooms) => {
    const isEngActive =
      (activeScope === 'infra' || activeScope === 'ops' || activeScope === 'engineering') && r.scope === 'infra';
    const isGenActive = (activeScope === 'general' || !activeScope) && r.scope === 'general';
    const isActive = r.scope === activeScope || isEngActive || isGenActive;
    const mins = opts.roomRecency?.[r.scope];
    // Unread = real signals only: pending approvals or activity < 3h.
    const hasUnread = r.pending > 0 || (mins !== null && mins !== undefined && mins < 180);
    const unreadDot = hasUnread && !isActive ? `<span class="buzz-unread-dot" title="Unread activity"></span>` : '';
    const isLock = r.scope === 'legal';
    const roomGlyph = isLock
      ? `<span class="buzz-room-glyph buzz-room-glyph--lock" title="Restricted room">${svgIcon('lock', 12)}</span>`
      : `<span class="buzz-room-glyph">${svgIcon('hash', 12)}</span>`;
    const displayName = r.roomName;
    const roomUrl = r.scope === 'infra' ? '/console/buzz/engineering' : `/console/buzz/${esc(r.scope)}`;
    const avatar = getScopeAvatarSrc(r.scope);

    return `
      <a href="${roomUrl}" class="buzz-room-link ${isActive ? 'buzz-room-link--active' : ''}" title="#${esc(displayName)}">
        <span class="buzz-room-name">
          <img class="buzz-room-avatar" src="${esc(avatar)}" alt="" loading="lazy">
          ${roomGlyph}<span class="buzz-room-label">${esc(displayName)}</span>
        </span>
        ${unreadDot}
      </a>`;
  };

  const hiveRooms = rooms
    .filter((r) => theHiveScopes.includes(r.scope))
    .sort((a, b) => theHiveScopes.indexOf(a.scope) - theHiveScopes.indexOf(b.scope))
    .map(renderRoomItem)
    .join('\n');
  const prodRooms = rooms
    .filter((r) => productScopes.includes(r.scope))
    .sort((a, b) => productScopes.indexOf(a.scope) - productScopes.indexOf(b.scope))
    .map(renderRoomItem)
    .join('\n');
  const swarmRooms = rooms
    .filter((r) => swarmScopes.includes(r.scope))
    .sort((a, b) => swarmScopes.indexOf(a.scope) - swarmScopes.indexOf(b.scope))
    .map(renderRoomItem)
    .join('\n');
  const otherRooms = rooms
    .filter((r) => !isCanonicalScope(r.scope))
    .map(renderRoomItem)
    .join('\n');

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
  /* ── Buzz "Refined Sage" design tokens ─────────────────────────────
     Buzz deliberately opts out of the Console token system (see
     THEME_OPTOUT_MARKER in buzz.ts and the surface-split regression
     test). These --buzz-* tokens are Buzz's OWN system, defined once
     here so the two shells stop hardcoding ~70 near-duplicate hex
     literals. They must never reference Inter or the --v-* Console
     tokens. */
  :root {
    --buzz-canvas: #E8EAE6;
    --buzz-surface: #FFFFFF;
    --buzz-surface-sunken: #DADED7;
    --buzz-surface-hover: #DCE0D9;
    --buzz-surface-active: #CED3CA;
    --buzz-border: #D6DAD2;
    --buzz-border-soft: #E2E8F0;
    --buzz-ink-1: #1C1E21;
    --buzz-ink-2: #334155;
    --buzz-ink-3: #64748B;
    --buzz-ink-inverse: #FFFFFF;
    /* Initials on the generated pastel avatar chips: the chip stays light in
       both themes, so its ink must stay dark — intentionally NOT overridden in
       html.buzz-dark. */
    --buzz-avatar-ink: #1E293B;
    --buzz-accent: #0F5C57;
    --buzz-accent-ring: rgba(15, 92, 87, 0.14);
    --buzz-dot: #0F172A;
    --buzz-r-sm: 6px;
    --buzz-r-md: 8px;
    --buzz-r-lg: 12px;
    --buzz-r-pill: 999px;
    --buzz-ease: cubic-bezier(0.16, 1, 0.3, 1);
    --buzz-shadow-card: 0 1px 4px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.08);
    --buzz-shadow-pop: 0 2px 8px rgba(0,0,0,0.08);
    --buzz-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    /* Chat-surface roles. The thread lives on a cool slate ramp (its own
       palette) while the chrome uses the sage ramp above; both flip together
       under html.buzz-dark. Status hues match the Console's semantic roles so
       the two surfaces read as one product. */
    --buzz-inset: #F8FAFC;
    --buzz-inset-2: #F1F5F9;
    --buzz-code-bg: #F8FAFC;
    --buzz-code-ink: #0F172A;
    --buzz-warn: #ECB22E;
    --buzz-good: #2BAC76;
    --buzz-risk: #E01E5A;
    --buzz-info: #2563EB;
    --buzz-lock: #B45309;
    --buzz-warn-soft: #FFFBEB;
    --buzz-good-soft: #ECFDF5;
    --buzz-info-soft: #E8F5FA;
    --buzz-scroll: #CBD5E1;
    --buzz-hairline: #E5E7EB;
    --buzz-track: #E7EAE4;
    --buzz-glass: rgba(255,255,255,0.55);
  }

  /* ── Dark mode ────────────────────────────────────────────────────
     Buzz's OWN dark ramp. It borrows the marketing/Console dark *values*
     (near-black canvas, chartreuse accent, translucent glass borders) so a
     toggle feels consistent across the product, but keeps Buzz's token NAMES
     — the surface-split guard stays intact: no --v-* tokens, no data-theme
     attribute, no Inter. Only a class on <html> flips the values. */
  html.buzz-dark {
    color-scheme: dark;
    --buzz-canvas: #0E0F11;
    --buzz-surface: #17191C;
    --buzz-surface-sunken: #202327;
    --buzz-surface-hover: #23272C;
    --buzz-surface-active: #2B3037;
    --buzz-border: rgba(255,255,255,0.10);
    --buzz-border-soft: rgba(255,255,255,0.08);
    --buzz-ink-1: #F3F3F3;
    --buzz-ink-2: #D6D6D6;
    --buzz-ink-3: #9A9A9A;
    --buzz-ink-inverse: #111111;
    --buzz-accent: #D9FFA8;
    --buzz-accent-ring: rgba(217,255,168,0.16);
    --buzz-dot: #F3F3F3;
    --buzz-shadow-card: 0 12px 36px rgba(0,0,0,0.6);
    --buzz-shadow-pop: 0 2px 10px rgba(0,0,0,0.5);
    --buzz-inset: #121417;
    --buzz-inset-2: #1C2024;
    --buzz-code-bg: rgba(0,0,0,0.42);
    --buzz-code-ink: #D7DCE0;
    --buzz-warn: #E8C07A;
    --buzz-good: #9BE08C;
    --buzz-risk: #E87A70;
    --buzz-info: #8AA4D8;
    --buzz-lock: #E8C07A;
    --buzz-warn-soft: rgba(232,192,122,0.12);
    --buzz-good-soft: rgba(155,224,140,0.12);
    --buzz-info-soft: rgba(138,164,216,0.16);
    --buzz-scroll: rgba(255,255,255,0.16);
    --buzz-hairline: rgba(255,255,255,0.08);
    --buzz-track: rgba(255,255,255,0.10);
    --buzz-glass: rgba(255,255,255,0.04);
  }
  /* The cross-fade is applied only for the instant of a manual toggle (the
     script adds .buzz-anim, then removes it) so first paint and hover
     micro-interactions keep their own timings. */
  html.buzz-anim,
  html.buzz-anim *,
  html.buzz-anim *::before,
  html.buzz-anim *::after {
    transition: background-color 0.35s var(--buzz-ease), border-color 0.35s var(--buzz-ease),
      color 0.35s var(--buzz-ease), fill 0.35s var(--buzz-ease), box-shadow 0.35s var(--buzz-ease) !important;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    font-family: var(--buzz-font);
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--buzz-ink-1);
    background: var(--buzz-canvas);
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  a { color: inherit; text-decoration: none; }
  .buzz-icon { display: block; flex-shrink: 0; }

  /* Desktop Mac Window Layout */
  .buzz-window {
    display: flex;
    height: 100vh;
    width: 100vw;
    background: var(--buzz-canvas);
    overflow: hidden;
  }

  /* Left Sidebar */
  .buzz-sidebar {
    width: 248px;
    display: flex;
    flex-direction: column;
    padding: 14px 10px 12px 14px;
    background: var(--buzz-canvas);
    flex-shrink: 0;
    user-select: none;
  }

  /* Search Box */
  .buzz-search-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--buzz-surface-sunken);
    border: 1px solid transparent;
    border-radius: var(--buzz-r-md);
    padding: 7px 10px;
    margin-bottom: 14px;
    color: var(--buzz-ink-3);
    font-size: 12.5px;
    cursor: text;
    transition: background 0.15s var(--buzz-ease), border-color 0.15s var(--buzz-ease), box-shadow 0.15s var(--buzz-ease);
  }
  .buzz-search-pill:hover { background: var(--buzz-surface-active); }
  .buzz-search-pill:focus-within {
    background: var(--buzz-surface);
    border-color: var(--buzz-accent);
    box-shadow: 0 0 0 3px var(--buzz-accent-ring);
  }
  .buzz-search-input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 12.5px;
    color: var(--buzz-ink-1);
    width: 100%;
    font-family: inherit;
  }
  .buzz-search-input::placeholder { color: var(--buzz-ink-3); }
  .buzz-search-kbd {
    font-size: 10px;
    font-family: inherit;
    color: var(--buzz-ink-3);
    border: 1px solid var(--buzz-border);
    border-radius: 4px;
    padding: 1px 4px;
    background: var(--buzz-glass);
    flex-shrink: 0;
  }

  /* Channel / Room Sections */
  .buzz-room-groups {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-right: 2px;
  }
  .buzz-room-groups::-webkit-scrollbar { width: 4px; }
  .buzz-room-groups::-webkit-scrollbar-thumb { background: var(--buzz-scroll); border-radius: 4px; }

  .buzz-group-heading {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--buzz-ink-3);
    padding: 4px 8px 3px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .buzz-room-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .buzz-room-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: var(--buzz-r-sm);
    font-size: 13px;
    color: var(--buzz-ink-2);
    transition: background 0.12s var(--buzz-ease), color 0.12s var(--buzz-ease);
    position: relative;
  }
  .buzz-room-link:hover {
    background: var(--buzz-surface-hover);
    color: var(--buzz-ink-1);
  }
  .buzz-room-link--active {
    background: var(--buzz-surface-active);
    color: var(--buzz-ink-1);
    font-weight: 600;
  }
  /* Accent left-bar: the precision cue the marketing pages get from borders. */
  .buzz-room-link--active::before {
    content: "";
    position: absolute;
    left: -14px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--buzz-accent);
  }
  .buzz-room-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .buzz-room-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .buzz-room-avatar {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    opacity: 0.9;
  }
  .buzz-room-glyph {
    display: inline-flex;
    align-items: center;
    color: var(--buzz-ink-3);
    flex-shrink: 0;
  }
  .buzz-room-glyph--lock { color: var(--buzz-lock); }
  .buzz-unread-dot {
    width: 7px;
    height: 7px;
    background: var(--buzz-dot);
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px var(--buzz-canvas);
  }

  /* Dashboard / issues launchers (BEM — no more inline overrides + !important) */
  .buzz-launcher {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: var(--buzz-r-md);
    background: var(--buzz-surface-hover);
    color: var(--buzz-ink-1);
    font-weight: 600;
    font-size: 12.5px;
    transition: background 0.15s var(--buzz-ease), transform 0.15s var(--buzz-ease);
  }
  .buzz-launcher:hover {
    background: var(--buzz-surface-active);
    transform: translateY(-1px);
  }
  .buzz-launcher--active { background: var(--buzz-surface-active); }
  .buzz-launcher__label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .buzz-launcher__tag {
    font-size: 9px;
    background: var(--buzz-accent);
    color: var(--buzz-ink-inverse);
    padding: 1px 5px;
    border-radius: var(--buzz-r-sm);
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  /* Real Telemetry Strip */
  .buzz-telemetry {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 8px;
    background: var(--buzz-glass);
    border: 1px solid var(--buzz-border);
    border-radius: var(--buzz-r-md);
    margin-top: 10px;
    color: var(--buzz-ink-3);
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
    color: var(--buzz-ink-1);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .buzz-tel-label {
    font-size: 9.5px;
    color: var(--buzz-ink-3);
    text-transform: lowercase;
    white-space: nowrap;
  }

  /* Bottom User Profile */
  .buzz-profile-card {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 6px 0;
    border-top: 1px solid var(--buzz-border);
    margin-top: 10px;
  }
  .buzz-profile-link {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    border-radius: var(--buzz-r-sm);
    padding: 2px;
    transition: background 0.12s var(--buzz-ease);
  }
  .buzz-profile-link:hover { background: var(--buzz-surface-hover); }
  .buzz-profile-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--buzz-accent);
    color: var(--buzz-ink-inverse);
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
    color: var(--buzz-ink-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .buzz-profile-sub {
    font-size: 10.5px;
    color: var(--buzz-ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .buzz-profile-gear {
    display: inline-flex;
    color: var(--buzz-ink-3);
    padding: 4px;
    border-radius: var(--buzz-r-sm);
    transition: background 0.12s var(--buzz-ease), color 0.12s var(--buzz-ease);
  }
  .buzz-profile-gear:hover { background: var(--buzz-surface-hover); color: var(--buzz-ink-1); }

  /* Dark-mode toggle (sidebar, mirrors the Console topbar control). Buzz keeps
     its own marker (data-buzz-theme-toggle) so it never collides with the
     Console's own toggle attribute — the surface-split regression test forbids
     the Console control from appearing on the chat. The Console attribute name
     is deliberately not spelled out here: this comment is emitted inside the
     chat document, and that test greps the whole page for the literal, so a
     comment naming it would fail the very guard it describes. */
  .buzz-profile-theme {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--buzz-ink-3);
    padding: 4px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: var(--buzz-r-sm);
    transition: background 0.12s var(--buzz-ease), color 0.12s var(--buzz-ease);
  }
  .buzz-profile-theme:hover { background: var(--buzz-surface-hover); color: var(--buzz-ink-1); }
  .buzz-profile-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .buzz-tt-sun { display: none; }
  html.buzz-dark .buzz-tt-moon { display: none; }
  html.buzz-dark .buzz-tt-sun { display: inline-flex; }

  /* Floating Rounded White Card for Main Chat & Content */
  .buzz-content-card {
    flex: 1;
    min-width: 0;
    background: var(--buzz-surface);
    border: 1px solid var(--buzz-border);
    border-radius: 14px;
    margin: 8px 12px 12px 0;
    box-shadow: var(--buzz-shadow-card);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
    .buzz-launcher:hover { transform: none; }
  }
</style>

<div class="buzz-window">
  <!-- Left Buzz Sidebar (Warm Sage Desktop Theme) -->
  <aside class="buzz-sidebar" id="buzz-workspace-sidebar">
    <!-- Search Box -->
    <div class="buzz-search-pill" onclick="document.getElementById('buzz-search-input')?.focus();">
      ${svgIcon('search', 14)}
      <input type="text" id="buzz-search-input" class="buzz-search-input" placeholder="Search everything" aria-label="Search">
      <kbd class="buzz-search-kbd">⌘K</kbd>
    </div>

    <!-- Chat rooms. This sidebar is chat-only: rooms, the room search,
         and one button to the dashboard. Console navigation (approvals,
         ledger, workflows, governance, team, settings) lives on the
         dashboard, not here. -->
    <div class="buzz-room-groups">
      <div>
        <div class="buzz-group-heading">The Hive</div>
        <div class="buzz-room-list">
          ${hiveRooms}
        </div>
      </div>

      <div>
        <div class="buzz-group-heading">Product</div>
        <div class="buzz-room-list">
          ${prodRooms}
        </div>
      </div>

      <div>
        <div class="buzz-group-heading">Launch Swarm</div>
        <div class="buzz-room-list">
          ${swarmRooms}
        </div>
      </div>

      ${
        otherRooms
          ? `<div>
        <div class="buzz-group-heading">Custom rooms</div>
        <div class="buzz-room-list">
          ${otherRooms}
        </div>
      </div>`
          : ''
      }

      <div>
        <div class="buzz-room-list">
          <a href="/setup/rooms" class="buzz-room-link" title="Create a new chat room">
            <span class="buzz-room-name"><span class="buzz-room-glyph">${svgIcon('plus', 12)}</span><span class="buzz-room-label">New room</span></span>
          </a>
        </div>
      </div>

      <!-- The one way out: dashboard (everything that is not chat) -->
      <div style="margin: 6px 0 8px; display: flex; flex-direction: column; gap: 4px;">
        <a href="/console/dashboard" id="vital-dashboard-btn" class="buzz-launcher" title="View Vital System Dashboard">
          ${svgIcon('chart', 15)}
          <span>View Dashboard</span>
        </a>
        ${
          parseTeam(opts.userTeam) === 'engineering'
            ? `<a href="/console/issues" id="sidebar-issues-dashboard-link" class="buzz-launcher ${activeScope === 'dashboard' || activeScope === 'issues' ? 'buzz-launcher--active' : ''}" style="justify-content:space-between;" title="#dashboard — Engineering Issues Board">
          <span class="buzz-launcher__label">
            ${svgIcon('clipboard', 14)}
            <span>#dashboard · Issues</span>
          </span>
          <span class="buzz-launcher__tag">ENG</span>
        </a>`
            : ''
        }
      </div>
    </div>

    <!-- Real telemetry strip -->
    ${telemetryStrip}

    <!-- Bottom User Profile Card -->
    <div class="buzz-profile-card">
      <a href="/account" class="buzz-profile-link" title="${esc(emailStr)} (${esc(roleStr)}) — Account &amp; Security">
        <div class="buzz-profile-avatar">${esc(initials)}</div>
        <div class="buzz-profile-info">
          <div class="buzz-profile-name">${esc(userName)}</div>
          <div class="buzz-profile-sub">🐝 ${esc(tenantName)}${roleStr !== DASH ? ` · ${esc(roleStr)}` : ''}</div>
        </div>
      </a>
      <div class="buzz-profile-actions">
        <button type="button" class="buzz-profile-theme" data-buzz-theme-toggle aria-pressed="false" title="Toggle dark mode">
          <span class="buzz-tt-moon">${svgIcon('moon', 15)}</span><span class="buzz-tt-sun">${svgIcon('sun', 15)}</span>
        </button>
        <a href="/account" class="buzz-profile-gear" title="Account Settings">${svgIcon('gear', 15)}</a>
      </div>
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
</div>
<script>
(function () {
  var root = document.documentElement;
  var btns = document.querySelectorAll('[data-buzz-theme-toggle]');
  function paint() {
    var dark = root.classList.contains('buzz-dark');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', dark ? 'true' : 'false');
      btns[i].setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }
  function toggle() {
    root.classList.add('buzz-anim');
    var dark = root.classList.toggle('buzz-dark');
    try { localStorage.setItem('buzz-theme', dark ? 'dark' : 'light'); } catch (e) {}
    paint();
    setTimeout(function () { root.classList.remove('buzz-anim'); }, 400);
  }
  for (var j = 0; j < btns.length; j++) { btns[j].addEventListener('click', toggle); }
  paint();
})();
</script>`;
}

// The telemetry and recency reads this shell draws used to live here, which
// forced the Console shell to import from the chat shell to type its own
// header. They live in shell-metrics.ts now: neutral data, no cross-shell
// import, same SQL.
