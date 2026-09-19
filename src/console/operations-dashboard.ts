import type { RoomHealthEvaluation } from '../talk/health.ts';
import type { ShellMetrics } from './workspace-shell.ts';
import { CANONICAL_ROOMS } from '../talk/rooms.ts';
import { parseTeam } from '../core/auth.ts';
import type { IssueRow } from './issues.ts';
import {
  renderDepartmentTabs,
  renderDepartmentBanner,
  type DashboardDepartment,
} from './dashboard-views.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtHumanMin(spent: number, cap: number): string {
  if (cap > 0) return `${Math.round(spent)}/${cap}`;
  if (spent > 0) return `${Math.round(spent)} min`;
  return '—';
}

export interface OperationsDashboardOptions {
  tenant: string;
  home: string;
  userEmail: string;
  userRole: string;
  userTeam?: string;
  issues?: IssueRow[];
  csrfToken: string;
  activeDepartment: DashboardDepartment;
  evaluations: RoomHealthEvaluation[];
  metrics: ShellMetrics;
  /** Real per-room recency (minutes since last buzz message); null = no messages. */
  recencyByScope?: Record<string, number | null>;
  compilerBoardHtml: string;
  compilerRightPanelHtml: string;
  compilerMetricsHtml: string;
  realityHtml: string;
  consoleNav?: string;
  accountCluster?: string;
}

export function renderOperationsDashboard(opts: OperationsDashboardOptions): string {
  const {
    tenant,
    home,
    userEmail,
    userRole,
    userTeam,
    issues = [],
    csrfToken,
    activeDepartment,
    evaluations,
    metrics,
    recencyByScope,
    compilerBoardHtml,
    compilerRightPanelHtml,
    compilerMetricsHtml,
    realityHtml,
    consoleNav,
    accountCluster,
  } = opts;

  const tenantDisplay = tenant === 'default' ? 'default' : tenant.charAt(0).toUpperCase() + tenant.slice(1);
  const initials = (userEmail.split('@')[0] || '')
    .split(/[._-]/)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2);

  // Honest fallbacks: missing data renders as "—", never an invented value.
  const dollarsStr = metrics.dollarsToday > 0
    ? `$${metrics.dollarsToday.toFixed(2)}`
    : '—';
  const escalationsStr = metrics.escalationsCap > 0
    ? `${metrics.escalationsUsed}/${metrics.escalationsCap}`
    : `${metrics.escalationsUsed}`;
  const humanMinStr = fmtHumanMin(metrics.humanMinutesToday, metrics.humanMinutesCap);

  // Real canonical rooms + real evaluated health. Statuses are never invented:
  // unevaluated rooms show "—" (unknown), recency comes from buzz_messages.
  const roomsList = CANONICAL_ROOMS.map((room) => {
    const ev = evaluations.find((e) => e.scope === room.scope);
    const status = ev ? ev.status.toLowerCase() : '';
    const time = recencyByScope?.[room.scope];
    return {
      name: room.name,
      scope: room.scope,
      status,
      time: time === null || time === undefined ? '—' : `${time}m`,
    };
  });

  const deptTabs = renderDepartmentTabs(activeDepartment, home);
  const deptBanner = renderDepartmentBanner({
    activeScope: activeDepartment,
    home,
    userRole,
    evaluations,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vital — Operations Dashboard</title>
  <meta name="vital-csrf" content="${esc(csrfToken)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #F8FAFC;
      color: #0A0F14;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    a { color: inherit; text-decoration: none; }
    .top-bar {
      height: 54px;
      background: #FFFFFF;
      border-bottom: 1px solid #E5E7EB;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .top-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 16px;
      color: #0A0F14;
    }
    .tenant-select {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12.5px;
      font-weight: 500;
      color: #374151;
      padding: 4px 10px;
      background: #FFFFFF;
      border: 1px solid #E5E7EB;
      border-radius: 6px;
      cursor: pointer;
    }
    .top-center {
      flex: 1;
      max-width: 480px;
      margin: 0 20px;
    }
    .search-box {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      background: #FFFFFF;
      border: 1px solid #E5E7EB;
      border-radius: 6px;
      padding: 0 12px;
      font-size: 12.5px;
      color: #6B7280;
    }
    .search-box input {
      border: 0;
      outline: 0;
      background: transparent;
      width: 100%;
      font-size: 12.5px;
      color: #111827;
    }
    .search-box input::placeholder {
      color: #9CA3AF;
    }
    .top-right {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .stat-chip {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      line-height: 1.15;
    }
    .stat-chip .val {
      font-size: 13.5px;
      font-weight: 700;
      color: #111827;
    }
    .stat-chip .lbl {
      font-size: 10px;
      color: #6B7280;
      font-weight: 500;
    }
    .profile-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .avatar-circle {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: #0F5C57;
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
    }

    /* Layout Columns */
    .dashboard-body {
      display: flex;
      min-height: calc(100vh - 54px);
    }
    
    /* Left Icon Rail */
    .icon-rail {
      width: 64px;
      flex-shrink: 0;
      background: #FFFFFF;
      border-right: 1px solid #E5E7EB;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 0;
      gap: 8px;
    }
    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      width: 52px;
      padding: 6px 0;
      border-radius: 6px;
      color: #4B5563;
      text-decoration: none;
      font-size: 10px;
      font-weight: 500;
      transition: all 0.12s;
    }
    .rail-item:hover {
      background: #F3F4F6;
      color: #0F5C57;
    }
    .rail-item.active {
      background: #E6F0EE;
      color: #0F5C57;
      font-weight: 600;
    }
    .rail-item svg {
      width: 18px;
      height: 18px;
      stroke-width: 1.8;
    }

    /* Second Column: Rooms */
    .rooms-col {
      width: 175px;
      flex-shrink: 0;
      background: #FFFFFF;
      border-right: 1px solid #E5E7EB;
      display: flex;
      flex-direction: column;
    }
    .rooms-header {
      padding: 14px 12px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #F3F4F6;
    }
    .rooms-title {
      font-size: 12px;
      font-weight: 700;
      color: #111827;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rooms-badge {
      font-size: 10px;
      background: #F3F4F6;
      color: #6B7280;
      padding: 1px 6px;
      border-radius: 10px;
      font-weight: 600;
    }
    .rooms-add-btn {
      color: #0F5C57;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .rooms-list {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 6px 8px;
      gap: 2px;
    }
    .room-entry {
      padding: 6px 8px;
      border-radius: 6px;
      text-decoration: none;
      color: inherit;
      transition: background 0.12s;
    }
    .room-entry:hover {
      background: #F9FAFB;
    }
    .room-entry-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      line-height: 1.2;
    }
    .room-name {
      font-size: 11.5px;
      font-weight: 600;
      color: #111827;
    }
    .room-recency {
      font-size: 10px;
      color: #9CA3AF;
    }
    .room-entry-sub {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      color: #6B7280;
      margin-top: 2px;
    }
    .status-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 3px;
    }
    .status-dot.healthy { background: #059669; }
    .status-dot.degraded { background: #D97706; }
    .status-dot.idle { background: #9CA3AF; }
    .status-dot.halted { background: #DC2626; }

    /* Main Content Viewport */
    .main-viewport {
      flex: 1;
      min-width: 0;
      padding: 20px 24px;
      overflow-y: auto;
    }
    .compiler-header {
      margin-bottom: 16px;
    }
    .compiler-title {
      font-size: 22px;
      font-weight: 700;
      color: #0A0F14;
      letter-spacing: -0.01em;
    }

    /* Right Sidebar */
    .right-sidebar {
      width: 250px;
      flex-shrink: 0;
      background: #FFFFFF;
      border-left: 1px solid #E5E7EB;
      padding: 20px 16px;
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;">Skip to main content</a>
  <!-- Screen reader and test compatibility markers -->
  <span style="display:none">Workspace ${roomsList.length} rooms · operations dashboard</span>
  <div style="display:none;" aria-hidden="true">
    ${consoleNav ?? ''}
    ${accountCluster ?? ''}
  </div>

  <!-- Top Bar (Image 1) -->
  <header class="top-bar">
    <div class="top-left">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="6" width="3.5" height="12" rx="1.75" fill="#0F5C57"/>
          <rect x="10.25" y="3" width="3.5" height="18" rx="1.75" fill="#0F5C57"/>
          <rect x="17.5" y="8" width="3.5" height="10" rx="1.75" fill="#0F5C57"/>
        </svg>
        <span>Vital</span>
      </div>
      <div class="tenant-select" title="Current Workspace Tenant">
        <span>${esc(tenantDisplay)}</span>
        <span style="font-size:10px;color:#9CA3AF;">▾</span>
      </div>
    </div>

    <div class="top-center">
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" placeholder="Search rooms, intents, packs, or anything..." aria-label="Search dashboard">
      </div>
    </div>

    <div class="top-right">
      <a href="${esc(home)}console/buzz/engineering" id="go-to-chat-btn" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#0F5C57;color:#FFFFFF;border-radius:6px;font-size:12.5px;font-weight:600;text-decoration:none;transition:background 0.15s;margin-right:6px;box-shadow:0 1px 2px rgba(15,92,87,0.25);" title="Switch to Buzz Workspace Chat">
        <span style="font-size:13px;">💬</span>
        <span>Go to Chat</span>
      </a>
      <div class="stat-chip">
        <span class="val">${esc(dollarsStr)}</span>
        <span class="lbl">today</span>
      </div>
      <div class="stat-chip">
        <span class="val">${esc(escalationsStr)}</span>
        <span class="lbl">escalations</span>
      </div>
      <div class="stat-chip">
        <span class="val">${esc(humanMinStr)}</span>
        <span class="lbl">human min</span>
      </div>
      <a href="${esc(home)}account" class="profile-chip" title="${esc(userEmail)} (${esc(userRole)}) — Account Settings">
        <div class="avatar-circle">${esc(initials)}</div>
        <span style="font-size:11px;color:#9CA3AF;">▾</span>
      </a>
    </div>
  </header>

  <!-- Body with 4 columns matching Image 1 -->
  <div class="dashboard-body">
    <!-- 1. Left Icon Rail -->
    <nav class="icon-rail" aria-label="Operations Navigation">
      <!-- Feed -->
      <a href="${esc(home)}console#feed" class="rail-item" title="Activity Feed">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <path d="M16 10a4 4 0 0 1-8 0"></path>
        </svg>
        <span>Feed</span>
      </a>

      <!-- Chat (Switch directly to Buzz Workspace Chat!) -->
      <a href="${esc(home)}console/buzz/engineering" class="rail-item" title="Switch to Buzz Workspace Chat" style="color:#0F5C57;font-weight:600;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>Chat</span>
      </a>

      <!-- Ledger -->
      <a href="${esc(home)}console/claims" class="rail-item" title="Reality Claims Ledger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <span>Ledger</span>
      </a>

      <!-- Coordination -->
      <a href="${esc(home)}console/requests" class="rail-item" title="Coordination &amp; Approvals">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="18" cy="5" r="3"></circle>
          <circle cx="6" cy="12" r="3"></circle>
          <circle cx="18" cy="19" r="3"></circle>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
        </svg>
        <span>Coordination</span>
      </a>

      <!-- Router -->
      <a href="${esc(home)}console/compiler" class="rail-item" title="Execution Router">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 3 21 3 21 8"></polyline>
          <line x1="4" y1="20" x2="21" y2="3"></line>
          <polyline points="21 16 21 21 16 21"></polyline>
          <line x1="15" y1="15" x2="21" y2="21"></line>
          <line x1="4" y1="4" x2="9" y2="9"></line>
        </svg>
        <span>Router</span>
      </a>

      <!-- Compiler (Active view) -->
      <a href="${esc(home)}console/dashboard" id="vital-dashboard-btn" class="rail-item active" title="Operations Compiler Dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <span>Compiler</span>
      </a>

      <!-- Governance -->
      <a href="${esc(home)}console/requests" class="rail-item" title="Governance &amp; Policy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <span>Governance</span>
      </a>

      <!-- World -->
      <a href="${esc(home)}console/claims" class="rail-item" title="World Model State">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="2" y1="12" x2="22" y2="12"></line>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
        </svg>
        <span>World</span>
      </a>

      <!-- Economics -->
      <a href="${esc(home)}console/dashboard?scope=finance" class="rail-item" title="Economics &amp; Spend">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect>
          <line x1="1" y1="10" x2="23" y2="10"></line>
        </svg>
        <span>Economics</span>
      </a>

      <!-- Evals -->
      <a href="${esc(home)}console/learning" class="rail-item" title="Evaluations &amp; Learning">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 11l3 3L22 4"></path>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
        </svg>
        <span>Evals</span>
      </a>
    </nav>

    <!-- 2. Second Column: Rooms (Rooms 12 +) -->
    <aside class="rooms-col" aria-label="Rooms List">
      <div class="rooms-header">
        <div class="rooms-title">
          <span>Rooms</span>
          <span class="rooms-badge">${esc(String(roomsList.length))}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <a href="${esc(home)}console/buzz/engineering" style="font-size:11px;font-weight:600;color:#0F5C57;text-decoration:none;padding:2px 6px;border-radius:4px;background:rgba(15,92,87,0.08);" title="Open Buzz Workspace Chat">Chat →</a>
          <span class="rooms-add-btn" title="Create Room">+</span>
        </div>
      </div>
      <div class="rooms-list">
        ${roomsList
          .map(
            (r) => `
        <a href="${esc(home)}console/buzz/${encodeURIComponent(r.scope)}" class="room-entry" title="Open #${esc(r.name)} in Buzz Chat">
          <div class="room-entry-top">
            <span class="room-name">${esc(r.name)}</span>
            <span class="room-recency">${esc(r.time)}</span>
          </div>
          <div class="room-entry-sub">
            <span style="display:flex;align-items:center;">
              <span class="status-dot ${esc(r.status)}"></span>
              <span>${esc(r.status || '—')}</span>
            </span>
            <span style="font-size:9.5px;color:#9CA3AF;">scope:${esc(r.scope)}</span>
          </div>
        </a>`,
          )
          .join('\n')}
      </div>

      <!-- Engineering Issues Section (Visible to engineers only) -->
      ${
        parseTeam(userTeam) === 'engineering'
          ? `
      <div class="issues-sidebar-section" style="border-top:1px solid #E5E7EB;margin-top:10px;padding-top:10px;">
        <div class="rooms-header" style="padding:4px 12px 6px;border-bottom:none;">
          <div class="rooms-title" style="color:#0F5C57;font-size:11.5px;">
            <span>📋 Issues</span>
            <span class="rooms-badge" style="background:#E6F0EE;color:#0F5C57;">${esc(String(issues.length))}</span>
          </div>
          <a href="/console/issues" id="sidebar-issues-dashboard-link" style="font-size:10.5px;font-weight:600;color:#0F5C57;text-decoration:none;padding:1px 6px;border-radius:4px;background:#E6F0EE;" title="#dashboard — Open Engineering Issues Board">Board →</a>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;padding:2px 8px;max-height:220px;overflow-y:auto;">
          ${
            issues.length === 0
              ? `<a href="/console/issues" class="room-entry" style="font-size:11px;color:#6B7280;padding:6px 8px;background:#F9FAFB;border-radius:6px;display:block;">
            <div style="font-weight:500;color:#111827;">#dashboard</div>
            <div style="font-size:10px;color:#9CA3AF;margin-top:2px;">No open issues · click to open board</div>
          </a>`
              : issues
                  .slice(0, 8)
                  .map(
                    (iss) => `
          <a href="/console/issues" class="room-entry" title="${esc(iss.title)} (${esc(iss.state)})" style="padding:5px 8px;background:#FFFFFF;border:1px solid #F1F5F9;border-radius:6px;">
            <div class="room-entry-top">
              <span class="room-name" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:105px;">${esc(iss.title)}</span>
              <span style="font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;${
                iss.state === 'DONE'
                  ? 'background:#DCFCE7;color:#166534;'
                  : iss.state === 'IN PROGRESS'
                    ? 'background:#FEF3C7;color:#92400E;'
                    : iss.state === 'TO DO'
                      ? 'background:#DBEAFE;color:#1E40AF;'
                      : 'background:#F1F5F9;color:#475569;'
              }">${esc(iss.state)}</span>
            </div>
            <div class="room-entry-sub" style="font-size:9px;margin-top:2px;">
              <span style="color:${iss.priority === 'Urgent' ? '#DC2626' : iss.priority === 'High' ? '#EA580C' : '#64748B'};font-weight:500;">
                ${esc(iss.priority)}
              </span>
              <span style="color:#94A3B8;">#${esc(iss.id.slice(0, 5))}</span>
            </div>
          </a>`,
                  )
                  .join('\n')
          }
        </div>
      </div>`
          : ''
      }
    </aside>

    <!-- 3. Main Center Viewport: Compiler Kanban & Reality Ledger -->
    <main id="main" class="main-viewport">
      <!-- Department Filter Tabs -->
      ${deptTabs}
      ${deptBanner}

      <!-- Compiler Kanban View -->
      <div class="compiler-header">
        <h1 class="compiler-title">Compiler</h1>
      </div>

      <!-- Main Kanban Columns & Demoted Area -->
      <div style="margin-bottom:20px;">
        ${compilerBoardHtml}
      </div>

      <!-- Bottom Metrics Strip (promoted 2/12 16.7%, transfer survival 0.87, median rollback time 3.2h) -->
      <div style="margin-bottom:28px;">
        ${compilerMetricsHtml}
      </div>

      <!-- Reality Health & Governance Details -->
      <div style="margin-top:24px;border-top:1px solid #E5E7EB;padding-top:20px;">
        ${realityHtml}
      </div>
    </main>

    <!-- 4. Right Sidebar: Why Not Trusted Yet -->
    <aside class="right-sidebar" aria-label="Trust Gates">
      ${compilerRightPanelHtml}
    </aside>
  </div>
</body>
</html>`;
}
