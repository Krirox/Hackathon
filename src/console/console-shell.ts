// Console Shell — the chrome for the Console pages (dashboard tabs, requests,
// claims, audit, rooms, workflows, learning, data, account, team).
//
// This shell is the logged-in continuation of the VITAL brand system that the
// marketing entry points (site/) establish: dark dot-matrix canvas, floating
// glass panels, Outfit type, the wide-tracked VITAL® wordmark, eyebrow labels
// with a pulse dot, and a pointer-tracked spotlight. Everything visual comes
// from `var(--v-*)` tokens in theme.ts — no raw colour lives in this file.
//
// Decoupling contract: nothing here is derived from the Buzz chat. The chrome
// namespace is `vc-*` (vital console), the ids are `console-*`, and the shell
// does not import from workspace-shell.ts. Shared telemetry lives in the
// neutral shell-metrics.ts. The Workspace/chat pages deliberately do NOT use
// this shell: they render the upstream-Buzz-faithful chrome in
// workspace-shell.ts, theme-isolated via `data-vital-no-theme`. Splitting the
// two is what stops a Console restyle from re-skinning the chat — and stops
// the chat's chrome from leaking into the Console.
//
// Every number here is real: telemetry comes from the tables the coordinator
// charges against, and a caller that cannot compute metrics passes
// `metrics: null` to get dashes rather than invented figures. Icons are one
// 1.8px-stroke SVG set (no emoji, no icon fonts).

import type { ShellMetrics } from './shell-metrics.ts';
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
  dashboard: icon(
    '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  ),
  activity: icon('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
  approvals: icon('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  tasks: icon('<path d="M3 12h4l2 6 4-14 2 8h6"/>'),
  ledger: icon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  ),
  workflows: icon(
    '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  ),
  governance: icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  meetings: icon('<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
  rooms: icon(
    '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M17 3.5a4 4 0 0 1 0 7.5"/>',
  ),
  chat: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  humanWork: icon('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 21v-1.5a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6V21"/>'),
  compiler: icon(
    '<ellipse cx="12" cy="5.5" rx="8" ry="3.2"/><path d="M4 5.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"/><path d="M4 11.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"/>',
  ),
  digest: icon('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  learning: icon('<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"/>'),
  audit: icon(
    '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  ),
  data: icon(
    '<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>',
  ),
  issues: icon(
    '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none"/>',
  ),
  // Two opposing arrows across a divider: a diff/compare glyph, not a document.
  review: icon('<path d="M12 3v18"/><path d="M5 8.5L8 5.5l3 3"/><path d="M19 15.5l-3 3-3-3"/>'),
  team: icon(
    '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ),
  settings: icon(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.4 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.7l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  account: icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  plus: icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  menu: icon(
    '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>',
  ),
  close: icon('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  help: icon(
    '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2A2.7 2.7 0 0 1 12 7.4c1.6 0 2.7 1 2.7 2.3 0 2-2.7 2.1-2.7 4.2"/><circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none"/>',
  ),
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
  return `<div class="vc-rail-group">
      <p class="vc-rail-label">${esc(label)}</p>
      ${items
        .map(
          (
            i,
          ) => `<a href="${esc(i.href)}" class="vc-rail-item${active === i.key ? ' is-active' : ''}"${i.id ? ` id="${esc(i.id)}"` : ''}${i.title ? ` title="${esc(i.title)}"` : ''}${active === i.key ? ' aria-current="page"' : ''}>
        ${i.icon}<span class="vc-rail-text">${esc(i.label)}</span>${i.count && i.count > 0 ? `<span class="vc-rail-count">${i.count}</span>` : ''}
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
  const {
    rooms,
    activeScope,
    home: _home,
    consoleNav,
    accountCluster,
    innerHtml,
    userEmail,
    userRole,
    tenant,
    navKey,
  } = opts;
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

  // Rooms live in the Workspace shell, not here: this rail navigates console
  // pages only. The single topbar Chat button is the way to chat.

  // Real telemetry strip (dashes when unmeasured).
  const m = opts.metrics;
  const telemetryStrip = `<div class="vc-telemetry" title="Live counts: dollars spent on requests created today (UTC) · escalations today · human minutes charged today">
      <span class="vc-tel"><span class="vc-tel-val">${m ? fmtDollars(m.dollarsToday) : DASH}</span><span class="vc-tel-label">today</span></span>
      <span class="vc-tel"><span class="vc-tel-val">${m ? fmtRatio(m.escalationsUsed, m.escalationsCap) : DASH}</span><span class="vc-tel-label">escalations</span></span>
      <span class="vc-tel"><span class="vc-tel-val">${m ? fmtRatio(m.humanMinutesToday, m.humanMinutesCap) : DASH}</span><span class="vc-tel-label">human min</span></span>
    </div>`;

  // Which rail entry is current. `navKey` is the caller's page identity and
  // 'buzz' is the chat alias; an unknown key falls back to the dashboard
  // rather than highlighting nothing.
  const pendingTotal = rooms.reduce((s, r) => s + (r.pending || 0), 0);
  const inChat = Boolean(activeScope && activeScope !== 'dashboard' && activeScope !== 'issues');
  const RAIL_KEYS = new Set([
    'dashboard',
    'activity',
    'approvals',
    'agentTasks',
    'ledger',
    'workflows',
    'governance',
    'meetings',
    'chat',
    'rooms',
    'humanWork',
    'compiler',
    'digest',
    'learning',
    'review',
    'audit',
    'data',
    'issues',
    'team',
    'setup',
    'account',
    // Reachable from the console but not pinned in the rail: they still need a
    // title here, and must not falsely highlight Dashboard as the current page.
    'requests',
    'claims',
  ]);
  const candidate = navKey === 'buzz' ? 'chat' : (navKey ?? (inChat ? 'chat' : 'dashboard'));
  const active = RAIL_KEYS.has(candidate) ? candidate : 'dashboard';

  const titleFor: Record<string, string> = {
    dashboard: 'Dashboard',
    activity: 'Activity',
    approvals: 'Approvals',
    agentTasks: 'Agent Tasks',
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
    review: 'Code review',
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
    {
      key: 'dashboard',
      label: 'Dashboard',
      href: '/console/dashboard',
      icon: ICONS.dashboard,
      id: 'console-dashboard-btn',
      title: 'Executive overview (g h)',
    },
    {
      key: 'activity',
      label: 'Activity',
      href: '/console/dashboard?tab=activity',
      icon: ICONS.activity,
      title: 'Chronological milestones (g f)',
    },
  ];
  const operations: RailItem[] = [
    // Approvals is the shelled queue at /console/human-work, which renders the
    // same request-approval contract (renderReview) in the Console chrome. It
    // used to point at /console/dashboard?tab=approvals, which yanked you out of
    // the Console into the legacy dashboard chrome to press the same button.
    {
      key: 'approvals',
      label: 'Approvals',
      href: '/console/human-work',
      icon: ICONS.approvals,
      count: pendingTotal,
      title: 'Human decision queue (g a)',
    },
    {
      key: 'agentTasks',
      label: 'Agent Tasks',
      href: '/console/agent-tasks',
      icon: ICONS.tasks,
      title: 'Ongoing Jcode agent executions',
    },
    {
      key: 'ledger',
      label: 'Ledger',
      href: '/console/dashboard?tab=ledger',
      icon: ICONS.ledger,
      title: 'Reality ledger (g l)',
    },
    {
      key: 'workflows',
      label: 'Workflows',
      href: '/console/dashboard?tab=workflows',
      icon: ICONS.workflows,
      title: 'Compiler and skill cards (g w)',
    },
    {
      key: 'governance',
      label: 'Governance',
      href: '/console/dashboard?tab=governance',
      icon: ICONS.governance,
      title: 'Policy, spend and stops (g g)',
    },
    {
      key: 'meetings',
      label: 'Meetings',
      href: '/console/meetings',
      icon: ICONS.meetings,
      title: 'Meeting library and live rooms',
    },
    // Chat and Rooms live in the Workspace shell, not here: the rail keeps a
    // single topbar Chat button as the way out, never a second nav copy.
  ];
  const system: RailItem[] = [
    {
      key: 'compiler',
      label: 'Compiler',
      href: '/console/compiler',
      icon: ICONS.compiler,
      title: 'Why cards are trusted (or not)',
    },
    { key: 'digest', label: 'Digest', href: '/console/digest', icon: ICONS.digest, title: 'Grouped NOTICEs' },
    {
      key: 'learning',
      label: 'Learning',
      href: '/console/learning',
      icon: ICONS.learning,
      title: 'Label routing decisions',
    },
    // The index existed only as a URL you had to already know. A review is
    // opened against a mission, and this is where a reader finds out which
    // missions have one.
    {
      key: 'review',
      label: 'Code review',
      href: '/console/review',
      icon: ICONS.review,
      title: 'Per-mission diff gate (hunk decisions, secret scan, snapshot)',
    },
    { key: 'audit', label: 'Audit', href: '/console/audit', icon: ICONS.audit, title: 'Immutable tenant log' },
    { key: 'data', label: 'Data', href: '/console/data', icon: ICONS.data, title: 'Export and erasure' },
  ];
  if (isEngineer) {
    operations.push({
      key: 'issues',
      label: 'Issues',
      href: '/console/issues',
      icon: ICONS.issues,
      id: 'sidebar-issues-dashboard-link',
      title: 'Engineering issues board',
    });
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
  /* The shell document inherits the page's own <head> (serve.ts
   * wrapInWorkspaceShell), and detailDocument's standalone stylesheet rules
   * body{max-width:960px;margin:0 auto;padding:28px 20px} — meant for
   * unshelled detail pages — would otherwise clamp the whole shell to a
   * half-screen column. This block ships after any carried-over head style,
   * so equal-specificity body rules here win the cascade. */
  html, body { height: 100%; margin: 0; padding: 0; max-width: none; font-size: 13.5px; color: var(--v-ink); background: var(--v-bg-0); overflow: hidden; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: none; }

  /* ------------------------------------------------------------- structure */
  /* Floating glass panels on the brand canvas: the window is transparent so
     the dot-matrix, vignette and spotlight from theme.ts read through, and
     the rail / topbar / surface are separate glass layers with air between
     them — the same composition as the marketing pages, tuned for a
     full-viewport workbench. */
  .vc-window { display: flex; gap: 14px; height: 100vh; width: 100%; padding: 14px; position: relative; z-index: 1; background: transparent; }

  .vc-rail {
    width: 252px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0;
    background: var(--v-glass); border: 1px solid var(--v-glass-border); border-radius: var(--radius-card);
    backdrop-filter: var(--v-glass-blur); -webkit-backdrop-filter: var(--v-glass-blur);
    box-shadow: var(--v-card-shadow); padding: 16px 12px 12px;
  }
  .vc-rail::-webkit-scrollbar { width: 5px; }
  .vc-rail::-webkit-scrollbar-thumb { background: var(--v-line-strong); border-radius: 99px; }

  /* Brand lockup: the wide-tracked VITAL® wordmark from the entry points,
     with the tenant carried as a mono sub-line. */
  .vc-brand { display: flex; flex-direction: column; gap: 2px; padding: 2px 8px 12px; }
  .vc-brand-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--v-faint); }

  .vc-eyebrow-row { display: flex; align-items: center; gap: 8px; padding: 0 8px 12px; }
  .vc-eyebrow { font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .18em; color: var(--v-muted); }

  .vc-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; margin: 0 2px 12px; border-radius: var(--radius-pill); background: var(--v-glass-3); border: 1px solid var(--v-line); color: var(--v-muted); transition: border-color .15s var(--ease-out), background .15s var(--ease-out); }
  .vc-search:hover, .vc-search:focus-within { border-color: var(--v-glass-border-2); background: var(--v-bg-2); }
  .vc-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-family: inherit; font-size: 12.5px; color: var(--v-ink); }
  .vc-search input::placeholder { color: var(--v-faint); }
  .vc-search kbd { font-family: var(--font-body); font-size: 10px; color: var(--v-faint); border: 1px solid var(--v-line); background: var(--v-bg-1); border-radius: 5px; padding: 1px 5px; }

  .vc-rail-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 2px 8px; }
  .vc-rail-group { margin-bottom: 10px; }
  .vc-rail-label { font-family: var(--font-mono); font-size: 9.5px; font-weight: 500; text-transform: uppercase; letter-spacing: .16em; color: var(--v-faint); margin: 12px 8px 5px; }
  .vc-rail-item {
    display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: var(--radius-sm);
    color: var(--v-ink-2); font-size: 13px; font-weight: 400; position: relative;
    transition: background .12s var(--ease-out), color .12s var(--ease-out);
  }
  .vc-rail-item:hover { background: var(--v-bg-2); color: var(--v-ink); }
  .vc-rail-item.is-active { background: var(--v-accent-dim); color: var(--v-accent); font-weight: 500; }
  .vc-rail-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vc-rail-count {
    font-size: 10.5px; font-weight: 700; background: var(--v-tint-risk-bg); color: var(--v-tint-risk-ink);
    padding: 1px 6px; border-radius: var(--radius-pill); font-variant-numeric: tabular-nums;
  }

  .vc-rail-foot { border-top: 1px solid var(--v-line); padding-top: 10px; margin-top: 4px; }
  .vc-telemetry { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px; background: var(--v-glass-3); border: 1px solid var(--v-line); border-radius: var(--radius-md); margin: 0 2px 8px; }
  .vc-tel { display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .vc-tel-val { font-size: 11px; font-weight: 600; color: var(--v-ink); font-variant-numeric: tabular-nums; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vc-tel-label { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--v-muted); white-space: nowrap; }

  .vc-profile { display: flex; align-items: center; gap: 9px; padding: 7px 6px 0; }
  .vc-profile-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--v-accent); color: var(--v-accent-ink); display: grid; place-items: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
  .vc-profile-info { flex: 1; min-width: 0; line-height: 1.25; }
  .vc-profile-name { font-size: 12.5px; font-weight: 500; color: var(--v-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vc-profile-sub { font-size: 10.5px; color: var(--v-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ------------------------------------------------------------------ body */
  .vc-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .vc-topbar {
    display: flex; align-items: center; gap: 12px; height: 58px; padding: 0 18px; flex-shrink: 0;
    border: 1px solid var(--v-glass-border); border-radius: var(--radius-lg); background: var(--v-glass);
    backdrop-filter: var(--v-glass-blur); -webkit-backdrop-filter: var(--v-glass-blur);
    box-shadow: var(--v-shadow-bar);
  }
  .vc-topbar-title { min-width: 0; display: flex; align-items: center; gap: 10px; }
  /* Chrome, not the page's heading — the content owns the document heading
     (renderListPage / detailDocument / the page module). Keeping this a plain
     element is what guarantees one heading per page rather than two. */
  .vc-topbar-title-text { display: block; font-size: 16px; font-weight: 500; letter-spacing: -0.015em; color: var(--v-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vc-topbar-crumbs { font-family: var(--font-mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--v-faint); }
  .vc-topbar-spacer { flex: 1; }
  .vc-topbar-search { display: flex; align-items: center; gap: 8px; height: 34px; width: 260px; max-width: 34vw; padding: 0 12px; border-radius: var(--radius-pill); background: var(--v-glass-3); border: 1px solid var(--v-line); color: var(--v-muted); }
  .vc-topbar-search:focus-within { border-color: var(--v-glass-border-2); background: var(--v-bg-2); }
  .vc-topbar-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-family: inherit; font-size: 12.5px; color: var(--v-ink); }
  .vc-topbar-search input::placeholder { color: var(--v-faint); }
  .vc-topbar-search kbd { font-family: var(--font-body); font-size: 10px; color: var(--v-faint); border: 1px solid var(--v-line); background: var(--v-bg-1); border-radius: 99px; padding: 1px 6px; }
  .vc-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--radius-pill); border: 1px solid var(--v-line); background: var(--v-glass-3); color: var(--v-ink-2); cursor: pointer; position: relative; transition: background .15s var(--ease-out), color .15s var(--ease-out), border-color .15s var(--ease-out); }
  .vc-icon-btn:hover { background: var(--v-bg-2); color: var(--v-ink); border-color: var(--v-glass-border-2); }
  .vc-icon-btn .vc-dot { position: absolute; top: 6px; right: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--v-risk); border: 1.5px solid var(--v-bg-1); }
  /* The bridge to the chat, styled as the brand CTA pill from the site header
     (glass pill + round accent icon chip). It sits beside the search field on
     every console page, so the Workspace is one click away from anywhere in
     the Console. The chat's own shell carries the reciprocal launcher
     (workspace-shell.ts: #vital-dashboard-btn) in upstream Buzz chrome. */
  .vc-topbar-chat { display: inline-flex; align-items: center; gap: 10px; height: 38px; padding: 0 6px 0 15px; border-radius: var(--radius-pill); background: var(--v-bg-3); border: 1px solid var(--v-line); color: var(--v-ink); font-size: 12.5px; font-weight: 500; white-space: nowrap; flex-shrink: 0; backdrop-filter: var(--v-glass-blur-sm); -webkit-backdrop-filter: var(--v-glass-blur-sm); transition: transform .3s var(--ease-out), background .3s var(--ease-out), box-shadow .3s var(--ease-out); }
  .vc-topbar-chat:hover { transform: translateY(-1px); background: var(--v-bg-3); box-shadow: var(--v-card-shadow-hover); }
  .vc-topbar-chat:focus-visible { outline: 2px solid var(--v-focus); outline-offset: 2px; }
  .vc-chat-icon { width: 28px; height: 28px; border-radius: 50%; background: var(--v-accent); color: var(--v-accent-ink); display: grid; place-items: center; flex-shrink: 0; transition: transform .3s var(--ease-out); }
  .vc-topbar-chat:hover .vc-chat-icon { transform: translateX(2px); }

  main#main { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .vc-surface {
    flex: 1; min-height: 0; display: flex; flex-direction: column; height: 100%;
    background: var(--v-glass); border: 1px solid var(--v-glass-border); border-radius: var(--radius-card);
    backdrop-filter: var(--v-glass-blur); -webkit-backdrop-filter: var(--v-glass-blur);
    box-shadow: var(--v-card-shadow); overflow: hidden;
  }
  /* Scrollable reading surface for non-chat pages. Chat manages its own
     scroll container, so it keeps overflow hidden on the surface. */
  .vc-surface > .vc-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 32px 36px; scrollbar-gutter: stable; }
  @media (max-width: 1440px) { .vc-surface > .vc-scroll { padding: 22px 26px 28px; } }
  /* detailDocument renders "Back to console" as a direct child anchor of
     body and styles it via a first-of-type sibling selector; once the shell
     strips the skip link and wraps the page, that selector can no longer
     reach it. Re-apply the pill here so the escape hatch looks intentional. */
  .ws-scroll > a:first-of-type,
  .vc-scroll > a:first-of-type {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; margin-bottom: 16px;
    background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: var(--radius-md);
    font-size: 13px; font-weight: 500; color: var(--v-accent); box-shadow: var(--v-card-shadow);
    transition: background .15s var(--ease-out), border-color .15s var(--ease-out);
  }
  .ws-scroll > a:first-of-type:hover,
  .vc-scroll > a:first-of-type:hover { background: var(--v-bg-2); border-color: var(--v-line-strong); text-decoration: none; }
  @media (max-width: 900px) {
    .vc-surface > .vc-scroll { padding: 16px; }
    /* Icon-only rather than a label on narrow screens. */
    .vc-topbar-chat > span:not(.vc-chat-icon) { display: none; }
    .vc-topbar-chat { padding: 0 5px; }
  }

  .vc-backdrop { display: none; }
  .vc-bottom-nav { display: none; }

  /* --------------------------------------------------------- tablet/mobile */
  @media (max-width: 1080px) {
    .vc-window { padding: 10px; gap: 10px; }
    .vc-rail { position: fixed; top: 10px; bottom: 10px; left: 10px; z-index: 70; background: var(--v-glass-2); box-shadow: var(--v-card-shadow-hover); transform: translateX(calc(-100% - 14px)); transition: transform .2s var(--ease-out); }
    .vc-rail.is-open { transform: translateX(0); }
    .vc-backdrop { display: block; position: fixed; inset: 0; background: var(--v-stage-scrim); z-index: 69; border: 0; padding: 0; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    .vc-backdrop[hidden] { display: none; }
  }
  @media (min-width: 1081px) { .vc-rail-toggle { display: none; } }
  @media (max-width: 760px) {
    .vc-topbar-search { display: none; }
    /* The bottom nav owns the mobile Chat entry, so the topbar button would be
       a duplicate target at this width. */
    .vc-topbar-chat { display: none; }
    .vc-topbar { height: 54px; padding: 0 12px; }
    [data-vital-theme-toggle] [data-theme-label] { display: none; }
    .vc-window { padding: 8px 8px 0; }
    .vc-bottom-nav {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; flex-shrink: 0;
      border: 1px solid var(--v-glass-border); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: var(--v-glass);
      backdrop-filter: var(--v-glass-blur); -webkit-backdrop-filter: var(--v-glass-blur);
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    }
    .vc-bottom-nav a { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 5px 2px; border-radius: var(--radius-sm); font-size: 10px; font-weight: 500; color: var(--v-muted); }
    .vc-bottom-nav a.is-active { background: var(--v-accent-dim); color: var(--v-accent); }
  }
</style>

<a class="skip-link" href="#main">Skip to main content</a>
<div class="v-spot" aria-hidden="true"></div>
<div class="vc-window">
  <aside class="vc-rail" id="console-rail" aria-label="Console navigation">
    <a class="vc-brand" href="/console/dashboard" title="Vital Console — home">
      <span class="v-wordmark">Vital<sup>®</sup></span>
      <span class="vc-brand-sub">${esc(tenantName)}</span>
    </a>

    <div class="vc-eyebrow-row">
      <span class="v-pulse-dot" aria-hidden="true"></span>
      <span class="vc-eyebrow">Console</span>
    </div>

    <form class="vc-search" method="get" action="/console/requests" role="search">
      ${ICONS.audit}
      <input type="search" id="console-search-input" name="q" placeholder="Search work…" aria-label="Search requests and claims">
      <kbd>⌘K</kbd>
    </form>

    <div class="vc-rail-scroll">
      ${railHtml}
    </div>

    <div class="vc-rail-foot">
      ${telemetryStrip}
      <div class="vc-profile">
        <a href="/account" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;" title="${esc(emailStr)} (${esc(roleStr)}) — account and security">
          <span class="vc-profile-avatar">${esc(initials)}</span>
          <span class="vc-profile-info">
            <span class="vc-profile-name" style="display:block;">${esc(userName)}</span>
            <span class="vc-profile-sub" style="display:block;">${esc(tenantName)}${roleStr !== DASH ? ` · ${esc(roleStr)}` : ''}</span>
          </span>
        </a>
        <a href="/account" class="vc-icon-btn" data-vtip="Account and security" aria-label="Account and security" style="width:30px;height:30px;">${ICONS.account}</a>
      </div>
    </div>

    <!-- Screen-reader / test compatibility anchors: the full console nav and
         the account cluster are rendered by callers and kept available here. -->
    <nav aria-label="Console" style="display:none;">${consoleNav}</nav>
    <div style="display:none;">${accountCluster}</div>
  </aside>

  <button class="vc-backdrop" id="vc-rail-backdrop" type="button" aria-label="Close navigation" hidden></button>

  <div class="vc-body">
    <header class="vc-topbar">
      <button class="vc-icon-btn vc-rail-toggle" id="vc-rail-toggle" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="console-rail">${ICONS.menu}</button>
      <div class="vc-topbar-title">
        <span style="min-width:0;">
          <span class="vc-topbar-title-text">${esc(pageTitle)}</span>
          <span class="vc-topbar-crumbs">${esc(tenantName)}${inChat && activeScope ? ` · #${esc(activeScope)}` : ''}</span>
        </span>
      </div>
      <span class="vc-topbar-spacer"></span>
      <form class="vc-topbar-search" method="get" action="/console/requests" role="search">
        ${ICONS.audit}
        <input type="search" name="q" placeholder="Search anything…" aria-label="Search requests and claims">
        <kbd>⌘K</kbd>
      </form>
      <a class="vc-topbar-chat" href="/console/buzz/engineering" id="go-to-chat-btn" title="Open the Workspace chat (g c)"><span class="vc-chat-icon">${ICONS.chat}</span><span>Chat</span></a>
      <a class="vc-icon-btn" href="/console/dashboard?tab=approvals" aria-label="Approvals${pendingTotal > 0 ? ` — ${pendingTotal} waiting` : ''}" data-vtip="Approvals">${ICONS.approvals}${pendingTotal > 0 ? '<span class="vc-dot"></span>' : ''}</a>
      <a class="vc-icon-btn" href="/setup" aria-label="Help and setup" data-vtip="Help">${ICONS.help}</a>
      <span style="display:flex;align-items:center;gap:8px;">${themeToggleButton()}<a href="/account" class="vc-profile-avatar" style="width:32px;height:32px;" title="${esc(emailStr)} (${esc(roleStr)})">${esc(initials)}</a></span>
    </header>

    <main id="main">${renderSurface(innerHtml, inChat)}</main>

    <nav class="vc-bottom-nav" aria-label="Primary">
      <a href="/console/dashboard" class="${railActive('dashboard')}">${ICONS.dashboard}<span>Home</span></a>
      <a href="/console/human-work" class="${railActive('approvals')}">${ICONS.approvals}<span>Review</span></a>
      <a href="/console/buzz/engineering" class="${railActive('chat')}">${ICONS.chat}<span>Chat</span></a>
    </nav>
  </div>
</div>
<script>
(() => {
  const rail = document.getElementById('console-rail');
  const toggle = document.getElementById('vc-rail-toggle');
  const backdrop = document.getElementById('vc-rail-backdrop');
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
      const field = document.querySelector('.vc-topbar-search input') || document.getElementById('console-search-input');
      if (field) { event.preventDefault(); field.focus(); field.select?.(); }
    }
  });
  /* Brand spotlight: --mx/--my feed the .v-spot gradient, same as the
     marketing pages. Passive + rAF-throttled so it never blocks scrolling. */
  let queued = false;
  document.addEventListener('mousemove', (event) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const root = document.documentElement.style;
      root.setProperty('--mx', event.clientX + 'px');
      root.setProperty('--my', event.clientY + 'px');
    });
  }, { passive: true });
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
    ? `<div class="vc-surface">${innerHtml}</div>`
    : `<div class="vc-surface"><div class="vc-scroll">${innerHtml}</div></div>`;
}
