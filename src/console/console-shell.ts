// Console Shell — the chrome for the Console pages (dashboard tabs, requests,
// claims, audit, rooms, workflows, learning, data, account, team).
//
// The Workspace/chat pages deliberately do NOT use this shell: they render the
// Buzz shell in workspace-shell.ts, which mirrors the upstream Buzz client and
// keeps its own native font stack and palette. Splitting the two is what stops
// a Console restyle from re-skinning the chat.
//
// Like the Buzz shell, every number here is real: telemetry comes from the
// tables the coordinator charges against, a quiet room shows an em dash, and a
// caller that cannot compute metrics passes `metrics: null` to get dashes rather
// than invented figures. Icons are one 1.8px-stroke SVG set (no emoji, no icon
// fonts) and every colour is a `var(--v-*)` token from theme.ts.

import type { ShellMetrics } from './workspace-shell.ts';
import { parseTeam } from '../core/auth.ts';
import { THEME_TOGGLE_SCRIPT, themeToggleButton } from './theme.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ConsoleShellRooms {
  scope: string;
  roomName: string;
  badge: string;
  pending: number;
  /** Sidebar group. Canonical rooms map via categoryForScope; customs carry their own. */
  category: string;
}

/** Renders as an em dash whenever a real value is unavailable. */
const DASH = '—';
function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtRatio(used: number, cap: number): string {
  // No ceiling configured: show what was spent instead of an invented limit.
  if (!(cap > 0)) return `${used.toLocaleString()}`;
  return `${used.toLocaleString()}/${cap.toLocaleString()}`;
}

/** One 1.8px stroke icon set, sized to the surrounding text. */
const icon = (paths: string, size = 16): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="flex-shrink:0;">${paths}</svg>`;

const ICONS = {
  dashboard: icon('<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>'),
  activity: icon('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
  approvals: icon('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  ledger: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  workflows: icon('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
  governance: icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  meetings: icon('<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
  rooms: icon('<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M17 3.5a4 4 0 0 1 0 7.5"/>'),
  chat: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  humanWork: icon('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 21v-1.5a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6V21"/>'),
  compiler: icon('<ellipse cx="12" cy="5.5" rx="8" ry="3.2"/><path d="M4 5.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"/><path d="M4 11.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"/>'),
  digest: icon('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  learning: icon('<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"/>'),
  audit: icon('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
  data: icon('<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>'),
  issues: icon('<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none"/>'),
  team: icon('<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.4 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.7l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  account: icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  plus: icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  menu: icon('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
  close: icon('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  help: icon('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2A2.7 2.7 0 0 1 12 7.4c1.6 0 2.7 1 2.7 2.3 0 2-2.7 2.1-2.7 4.2"/><circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none"/>'),
};

interface RailItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  /** Real pending count; 0 renders no badge. */
  count?: number;
  id?: string;
  title?: string;
}

function railSection(label: string, items: RailItem[], active: string): string {
  if (items.length === 0) return '';
  return `<div class="ws-rail-group">
      <p class="ws-rail-label">${esc(label)}</p>
      ${items
        .map(
          (i) => `<a href="${esc(i.href)}" class="ws-rail-item${active === i.key ? ' is-active' : ''}"${i.id ? ` id="${esc(i.id)}"` : ''}${i.title ? ` title="${esc(i.title)}"` : ''}${active === i.key ? ' aria-current="page"' : ''}>
        ${i.icon}<span class="ws-rail-text">${esc(i.label)}</span>${i.count && i.count > 0 ? `<span class="ws-rail-count">${i.count}</span>` : ''}
      </a>`,
        )
        .join('')}
    </div>`;
}

export function renderConsoleShell(opts: {
  rooms: ConsoleShellRooms[];
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
  const { rooms, activeScope, home: _home, consoleNav, accountCluster, innerHtml, userEmail, userRole, tenant, navKey } = opts;
  void _home;

  // Identity comes from the session only. No invented persona: if a caller
  // cannot say who is viewing, the chrome says so instead of rendering
  // someone else's name.
  const tenantName = tenant ? tenant.toUpperCase() : DASH;
  const emailStr = userEmail ?? DASH;
  const roleStr = userRole ?? DASH;
  const userName = userEmail
    ? (emailStr.split('@')[0] ?? emailStr).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : DASH;
  const initials = userEmail ? emailStr.slice(0, 2).toUpperCase() : '?';
  const isEngineer = parseTeam(opts.userTeam) === 'engineering';

  // Rooms live in the Workspace shell, not here: this sidebar navigates
  // console pages only. The single topbar Chat button is the way to chat.

  // Real telemetry strip (dashes when unmeasured).
  const m = opts.metrics;
  const telemetryStrip = `<div class="ws-telemetry" title="Live counts: dollars spent on requests created today (UTC) · escalations today · human minutes charged today">
      <span class="ws-tel"><span class="ws-tel-val">${m ? fmtDollars(m.dollarsToday) : DASH}</span><span class="ws-tel-label">today</span></span>
      <span class="ws-tel"><span class="ws-tel-val">${m ? fmtRatio(m.escalationsUsed, m.escalationsCap) : DASH}</span><span class="ws-tel-label">escalations</span></span>
      <span class="ws-tel"><span class="ws-tel-val">${m ? fmtRatio(m.humanMinutesToday, m.humanMinutesCap) : DASH}</span><span class="ws-tel-label">human min</span></span>
    </div>`;

  // Which rail entry is current. `navKey` is the caller's page identity and
  // 'buzz' is the chat alias; an unknown key falls back to the dashboard
  // rather than highlighting nothing.
  const pendingTotal = rooms.reduce((s, r) => s + (r.pending || 0), 0);
  const inChat = Boolean(activeScope && activeScope !== 'dashboard' && activeScope !== 'issues');
  const RAIL_KEYS = new Set([
    'dashboard', 'activity', 'approvals', 'ledger', 'workflows', 'governance', 'meetings', 'chat', 'rooms',
    'humanWork', 'compiler', 'digest', 'learning', 'audit', 'data', 'issues', 'team', 'setup', 'account',
    // Reachable from the console but not pinned in the rail: they still need a
    // title here, and must not falsely highlight Dashboard as the current page.
    'requests', 'claims',
  ]);
  const candidate = navKey === 'buzz' ? 'chat' : (navKey ?? (inChat ? 'chat' : 'dashboard'));
  const active = RAIL_KEYS.has(candidate) ? candidate : 'dashboard';

  const titleFor: Record<string, string> = {
    dashboard: 'Dashboard',
    activity: 'Activity',
    approvals: 'Approvals',
    ledger: 'Reality ledger',
    workflows: 'Workflows',
    governance: 'Governance',
    meetings: 'Meetings',
    chat: activeScope ? `#${rooms.find((r) => r.scope === activeScope)?.roomName ?? activeScope}` : 'Workspace chat',
    rooms: 'Rooms',
    humanWork: 'Human work',
    compiler: 'Compiler',
    digest: 'Digest',
    learning: 'Learning review',
    requests: 'Requests',
    claims: 'Claims',
    audit: 'Audit log',
    data: 'Data & retention',
    issues: 'Issues',
    team: 'Team',
    setup: 'Setup',
    account: 'Account and security',
  };
  const pageTitle = titleFor[active] ?? 'Console';

  const overview: RailItem[] = [
    { key: 'dashboard', label: 'Dashboard', href: '/console/dashboard', icon: ICONS.dashboard, id: 'vital-dashboard-btn', title: 'Executive overview (g h)' },
    { key: 'activity', label: 'Activity', href: '/console/dashboard?tab=activity', icon: ICONS.activity, title: 'Chronological milestones (g f)' },
  ];
  const operations: RailItem[] = [
    // Approvals is the shelled queue at /console/human-work, which renders the
    // same request-approval contract (renderReview) in the Console chrome. It
    // used to point at /console/dashboard?tab=approvals, which yanked you out of
    // the Console into the legacy dashboard chrome to press the same button.
    { key: 'approvals', label: 'Approvals', href: '/console/human-work', icon: ICONS.approvals, count: pendingTotal, title: 'Human decision queue (g a)' },
    { key: 'ledger', label: 'Ledger', href: '/console/dashboard?tab=ledger', icon: ICONS.ledger, title: 'Reality ledger (g l)' },
    { key: 'workflows', label: 'Workflows', href: '/console/dashboard?tab=workflows', icon: ICONS.workflows, title: 'Compiler and skill cards (g w)' },
    { key: 'governance', label: 'Governance', href: '/console/dashboard?tab=governance', icon: ICONS.governance, title: 'Policy, spend and stops (g g)' },
    { key: 'meetings', label: 'Meetings', href: '/console/meetings', icon: ICONS.meetings, title: 'Meeting library and live rooms' },
    // Chat and Rooms live in the Workspace shell, not here: the rail keeps a
    // single topbar Chat button as the way out, never a second nav copy.
  ];
  const system: RailItem[] = [
    { key: 'compiler', label: 'Compiler', href: '/console/compiler', icon: ICONS.compiler, title: 'Why cards are trusted (or not)' },
    { key: 'digest', label: 'Digest', href: '/console/digest', icon: ICONS.digest, title: 'Grouped NOTICEs' },
    { key: 'learning', label: 'Learning', href: '/console/learning', icon: ICONS.learning, title: 'Label routing decisions' },
    { key: 'audit', label: 'Audit', href: '/console/audit', icon: ICONS.audit, title: 'Immutable tenant log' },
    { key: 'data', label: 'Data', href: '/console/data', icon: ICONS.data, title: 'Export and erasure' },
  ];
  if (isEngineer) {
    operations.push({ key: 'issues', label: 'Issues', href: '/console/issues', icon: ICONS.issues, id: 'sidebar-issues-dashboard-link', title: 'Engineering issues board' });
  }
  const admin: RailItem[] = [
    { key: 'team', label: 'Team', href: '/team', icon: ICONS.team, title: 'Members, invitations and roles' },
    { key: 'setup', label: 'Setup', href: '/setup', icon: ICONS.settings, title: 'Activation and sources' },
    { key: 'account', label: 'Account', href: '/account', icon: ICONS.account, title: 'Password, MFA and sessions' },
  ];

  const railActive = (key: string) => (active === key ? 'is-active' : '');
  const railHtml = [
    railSection('Overview', overview, active),
    railSection('Operations', operations, active),
    railSection('System', system, active),
    railSection('Administration', admin, active),
  ].join('');

  return `
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; font-size: 13.5px; color: var(--v-ink); background: var(--v-bg-0); overflow: hidden; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: none; }

  /* ------------------------------------------------------------- structure */
  .ws-window { display: flex; height: 100vh; width: 100%; background: var(--v-bg-0); }

  .ws-rail {
    width: 252px; flex-shrink: 0; display: flex; flex-direction: column;
    padding: 14px 10px 12px; background: var(--v-bg-0); min-height: 0;
  }
  .ws-rail::-webkit-scrollbar { width: 5px; }
  .ws-rail::-webkit-scrollbar-thumb { background: var(--v-line-strong); border-radius: 99px; }

  .ws-brand { display: flex; align-items: center; gap: 9px; padding: 2px 8px 12px; }
  .ws-brand-mark {
    width: 28px; height: 28px; border-radius: 9px; background: var(--v-accent);
    display: grid; place-items: center; flex-shrink: 0;
  }
  .ws-brand-name { font-size: 13px; font-weight: 700; letter-spacing: .14em; color: var(--v-ink); text-transform: uppercase; }
  .ws-brand-sub { font-size: 10.5px; color: var(--v-faint); letter-spacing: .04em; margin-top: 1px; }

  .ws-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; margin: 0 4px 12px; border-radius: var(--radius-md); background: var(--v-bg-2); border: 1px solid transparent; color: var(--v-muted); transition: border-color .15s var(--ease-out), background .15s var(--ease-out); }
  .ws-search:hover, .ws-search:focus-within { border-color: var(--v-line-strong); background: var(--v-bg-1); }
  .ws-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-family: inherit; font-size: 12.5px; color: var(--v-ink); }
  .ws-search input::placeholder { color: var(--v-faint); }
  .ws-search kbd { font-family: var(--font-body); font-size: 10px; color: var(--v-faint); border: 1px solid var(--v-line); background: var(--v-bg-1); border-radius: 5px; padding: 1px 5px; }

  .ws-rail-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 2px 8px; }
  .ws-rail-group { margin-bottom: 10px; }
  .ws-rail-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--v-faint); margin: 10px 8px 5px; }
  .ws-rail-item {
    display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 9px;
    color: var(--v-ink-2); font-size: 13px; font-weight: 500; position: relative;
    transition: background .12s var(--ease-out), color .12s var(--ease-out);
  }
  .ws-rail-item:hover { background: var(--v-bg-2); color: var(--v-ink); }
  .ws-rail-item.is-active { background: var(--v-accent-dim); color: var(--v-accent); font-weight: 600; }
  .ws-rail-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-rail-count {
    font-size: 10.5px; font-weight: 700; background: var(--v-tint-risk-bg); color: var(--v-tint-risk-ink);
    padding: 1px 6px; border-radius: 99px; font-variant-numeric: tabular-nums;
  }

  .ws-room { display: flex; align-items: center; gap: 7px; padding: 5px 9px; border-radius: 8px; color: var(--v-ink-2); font-size: 12.5px; transition: background .12s var(--ease-out), color .12s var(--ease-out); }
  .ws-room:hover { background: var(--v-bg-2); color: var(--v-ink); }
  .ws-room.is-active { background: var(--v-bg-3); color: var(--v-ink); font-weight: 600; }
  .ws-room-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-room-meta { font-size: 10px; color: var(--v-faint); font-variant-numeric: tabular-nums; }
  .ws-hash { opacity: .55; font-size: 12px; }
  .ws-unread { width: 6px; height: 6px; border-radius: 50%; background: var(--v-accent); flex-shrink: 0; }

  .ws-rail-foot { border-top: 1px solid var(--v-line); padding-top: 10px; margin-top: 4px; }
  .ws-telemetry { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px; background: var(--v-bg-2); border-radius: var(--radius-md); margin: 0 2px 8px; }
  .ws-tel { display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .ws-tel-val { font-size: 11px; font-weight: 700; color: var(--v-ink); font-variant-numeric: tabular-nums; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-tel-label { font-size: 9.5px; color: var(--v-muted); white-space: nowrap; }

  .ws-profile { display: flex; align-items: center; gap: 9px; padding: 7px 6px 0; }
  .ws-profile-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--v-accent); color: var(--v-accent-ink); display: grid; place-items: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
  .ws-profile-info { flex: 1; min-width: 0; line-height: 1.25; }
  .ws-profile-name { font-size: 12.5px; font-weight: 600; color: var(--v-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-profile-sub { font-size: 10.5px; color: var(--v-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ------------------------------------------------------------------ body */
  .ws-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .ws-topbar {
    display: flex; align-items: center; gap: 12px; height: 58px; padding: 0 18px; flex-shrink: 0;
    border-bottom: 1px solid var(--v-line); background: var(--v-bg-0);
  }
  .ws-topbar-title { min-width: 0; display: flex; align-items: center; gap: 10px; }
  /* Chrome, not the page's heading — the content owns the document heading
     (renderListPage / detailDocument / the page module). Keeping this a plain
     element is what guarantees one heading per page rather than two. */
  .ws-topbar-title-text { display: block; font-size: 16px; font-weight: 650; letter-spacing: -0.015em; color: var(--v-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ws-topbar-crumbs { font-size: 11.5px; color: var(--v-faint); }
  .ws-topbar-spacer { flex: 1; }
  .ws-topbar-search { display: flex; align-items: center; gap: 8px; height: 34px; width: 260px; max-width: 34vw; padding: 0 10px; border-radius: var(--radius-pill); background: var(--v-bg-2); border: 1px solid transparent; color: var(--v-muted); }
  .ws-topbar-search:focus-within { border-color: var(--v-line-strong); background: var(--v-bg-1); }
  .ws-topbar-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-family: inherit; font-size: 12.5px; color: var(--v-ink); }
  .ws-topbar-search input::placeholder { color: var(--v-faint); }
  .ws-topbar-search kbd { font-family: var(--font-body); font-size: 10px; color: var(--v-faint); border: 1px solid var(--v-line); background: var(--v-bg-1); border-radius: 99px; padding: 1px 6px; }
  .ws-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--radius-pill); border: 1px solid var(--v-line); background: var(--v-bg-1); color: var(--v-ink-2); cursor: pointer; position: relative; transition: background .15s var(--ease-out), color .15s var(--ease-out), border-color .15s var(--ease-out); }
  .ws-icon-btn:hover { background: var(--v-bg-2); color: var(--v-ink); border-color: var(--v-line-strong); }
  .ws-icon-btn .ws-dot { position: absolute; top: 6px; right: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--v-risk); border: 1.5px solid var(--v-bg-1); }
  /* The bridge to the chat. It sits beside the search field on every console
     page, so the Workspace is one click away from anywhere in the Console and
     the Console stays one click away from the Workspace. The chat's own shell
     carries the reciprocal launcher (workspace-shell.ts: #vital-dashboard-btn). */
  .ws-topbar-chat { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: var(--radius-pill); background: var(--v-accent); color: var(--v-accent-ink); font-size: 12.5px; font-weight: 600; white-space: nowrap; flex-shrink: 0; transition: filter .15s var(--ease-out); }
  .ws-topbar-chat:hover { filter: brightness(1.08); }
  .ws-topbar-chat:focus-visible { outline: 2px solid var(--v-accent); outline-offset: 2px; }

  main#main { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 18px 16px; overflow: hidden; }
  .ws-surface {
    flex: 1; min-height: 0; display: flex; flex-direction: column; height: 100%;
    background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: var(--radius-card);
    box-shadow: var(--v-card-shadow); overflow: hidden;
  }
  /* Scrollable reading surface for non-chat pages. Chat manages its own
     scroll container, so it keeps overflow hidden on the surface. */
  .ws-surface > .ws-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 26px 28px; }
  @media (max-width: 900px) {
    .ws-surface > .ws-scroll { padding: 16px; }
    /* Icon-only rather than a two-line label on narrow screens. */
    .ws-topbar-chat span { display: none; }
    .ws-topbar-chat { padding: 0 10px; }
  }

  .ws-backdrop { display: none; }
  .ws-bottom-nav { display: none; }

  /* --------------------------------------------------------- tablet/mobile */
  @media (max-width: 1080px) {
    .ws-rail { position: fixed; top: 0; bottom: 0; left: 0; z-index: 70; background: var(--v-bg-1); border-right: 1px solid var(--v-line); box-shadow: 12px 0 40px rgba(0,0,0,.14); transform: translateX(-102%); transition: transform .2s var(--ease-out); }
    .ws-rail.is-open { transform: translateX(0); }
    .ws-backdrop { display: block; position: fixed; inset: 0; background: rgba(10,15,20,.4); z-index: 69; border: 0; padding: 0; }
    .ws-backdrop[hidden] { display: none; }
    main#main { padding: 10px 12px 12px; }
  }
  @media (min-width: 1081px) { .ws-rail-toggle { display: none; } }
  @media (max-width: 760px) {
    .ws-topbar-search { display: none; }
    /* The bottom nav owns the mobile Chat entry, so the topbar button would be
       a duplicate target at this width. */
    .ws-topbar-chat { display: none; }
    .ws-topbar { height: 54px; padding: 0 12px; }
    [data-vital-theme-toggle] [data-theme-label] { display: none; }
    .ws-bottom-nav {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; flex-shrink: 0;
      border-top: 1px solid var(--v-line); background: var(--v-bg-1); padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    }
    .ws-bottom-nav a { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 5px 2px; border-radius: 10px; font-size: 10px; font-weight: 600; color: var(--v-muted); }
    .ws-bottom-nav a.is-active { background: var(--v-accent-dim); color: var(--v-accent); }
    main#main { padding: 8px 8px 0; }
  }
</style>

<a class="skip-link" href="#main">Skip to main content</a>
<div class="ws-window">
  <aside class="ws-rail" id="buzz-workspace-sidebar" aria-label="Workspace navigation">
    <a class="ws-brand" href="/console/dashboard" title="Vital Console — home">
      <span class="ws-brand-mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="6" width="3.5" height="12" rx="1.75" fill="var(--v-accent-ink)"/>
          <rect x="10.25" y="3" width="3.5" height="18" rx="1.75" fill="var(--v-accent-ink)"/>
          <rect x="17.5" y="8" width="3.5" height="10" rx="1.75" fill="var(--v-accent-ink)"/>
        </svg>
      </span>
      <span style="min-width:0;">
        <span class="ws-brand-name">Vital Console</span>
        <span class="ws-brand-sub" style="display:block;">${esc(tenantName)}</span>
      </span>
    </a>

    <form class="ws-search" method="get" action="/console/requests" role="search">
      ${ICONS.audit}
      <input type="search" id="buzz-search-input" name="q" placeholder="Search work…" aria-label="Search requests and claims">
      <kbd>⌘K</kbd>
    </form>

    <div class="ws-rail-scroll">
      ${railHtml}
    </div>

    <div class="ws-rail-foot">
      ${telemetryStrip}
      <div class="ws-profile">
        <a href="/account" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;" title="${esc(emailStr)} (${esc(roleStr)}) — account and security">
          <span class="ws-profile-avatar">${esc(initials)}</span>
          <span class="ws-profile-info">
            <span class="ws-profile-name" style="display:block;">${esc(userName)}</span>
            <span class="ws-profile-sub" style="display:block;">${esc(tenantName)}${roleStr !== DASH ? ` · ${esc(roleStr)}` : ''}</span>
          </span>
        </a>
        <a href="/account" class="ws-icon-btn" data-vtip="Account and security" aria-label="Account and security" style="width:30px;height:30px;">${ICONS.account}</a>
      </div>
    </div>

    <!-- Test and screen-reader compatibility anchors -->
    <span style="display:none">Workspace ${rooms.length} rooms · chat-first</span>
    <nav aria-label="Console" style="display:none;">${consoleNav}</nav>
    <div style="display:none;">${accountCluster}</div>
  </aside>

  <button class="ws-backdrop" id="ws-rail-backdrop" type="button" aria-label="Close navigation" hidden></button>

  <div class="ws-body">
    <header class="ws-topbar">
      <button class="ws-icon-btn ws-rail-toggle" id="ws-rail-toggle" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="buzz-workspace-sidebar">${ICONS.menu}</button>
      <div class="ws-topbar-title">
        <span style="min-width:0;">
          <span class="ws-topbar-title-text">${esc(pageTitle)}</span>
          <span class="ws-topbar-crumbs">${esc(tenantName)}${inChat && activeScope ? ` · #${esc(activeScope)}` : ''}</span>
        </span>
      </div>
      <span class="ws-topbar-spacer"></span>
      <form class="ws-topbar-search" method="get" action="/console/requests" role="search">
        ${ICONS.audit}
        <input type="search" name="q" placeholder="Search anything…" aria-label="Search requests and claims">
        <kbd>⌘K</kbd>
      </form>
      <a class="ws-topbar-chat" href="/console/buzz/engineering" id="go-to-chat-btn" title="Open the Workspace chat (g c)">${ICONS.chat}<span>Chat</span></a>
      <a class="ws-icon-btn" href="/console/dashboard?tab=approvals" aria-label="Approvals${pendingTotal > 0 ? ` — ${pendingTotal} waiting` : ''}" data-vtip="Approvals">${ICONS.approvals}${pendingTotal > 0 ? '<span class="ws-dot"></span>' : ''}</a>
      <a class="ws-icon-btn" href="/setup" aria-label="Help and setup" data-vtip="Help">${ICONS.help}</a>
      <span style="display:flex;align-items:center;gap:8px;">${themeToggleButton()}<a href="/account" class="ws-profile-avatar" style="width:32px;height:32px;" title="${esc(emailStr)} (${esc(roleStr)})">${esc(initials)}</a></span>
    </header>

    <main id="main">${renderSurface(innerHtml, inChat)}</main>

    <nav class="ws-bottom-nav" aria-label="Primary">
      <a href="/console/dashboard" class="${railActive('dashboard')}">${ICONS.dashboard}<span>Home</span></a>
      <a href="/console/human-work" class="${railActive('approvals')}">${ICONS.approvals}<span>Review</span></a>
      <a href="/console/buzz/engineering" class="${railActive('chat')}">${ICONS.chat}<span>Chat</span></a>
    </nav>
  </div>
</div>
<script>
(() => {
  const rail = document.getElementById('buzz-workspace-sidebar');
  const toggle = document.getElementById('ws-rail-toggle');
  const backdrop = document.getElementById('ws-rail-backdrop');
  const setOpen = (open) => {
    if (!rail || !toggle || !backdrop) return;
    rail.classList.toggle('is-open', open);
    backdrop.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle?.addEventListener('click', () => setOpen(!rail.classList.contains('is-open')));
  backdrop?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      const field = document.querySelector('.ws-topbar-search input') || document.getElementById('buzz-search-input');
      if (field) { event.preventDefault(); field.focus(); field.select?.(); }
    }
  });
})();
</script>
<script>${THEME_TOGGLE_SCRIPT}</script>`;
}

/**
 * Non-chat pages scroll inside the surface; chat pages own their scroll
 * container, so the surface stays a fixed-height flex box.
 */
function renderSurface(innerHtml: string, inChat: boolean): string {
  return inChat
    ? `<div class="ws-surface">${innerHtml}</div>`
    : `<div class="ws-surface"><div class="ws-scroll">${innerHtml}</div></div>`;
}

