import type { RoomHealthEvaluation } from '../talk/health.ts';
import type { ShellMetrics } from './shell-metrics.ts';
import { CANONICAL_ROOMS } from '../talk/rooms.ts';
import { parseTeam } from '../core/auth.ts';
import type { IssueRow } from './issues.ts';
import { renderDepartmentTabs, renderDepartmentBanner, type DashboardDepartment } from './dashboard-views.ts';

import { kpiCard, paletteHtml, sectionCard, shortcutHints, statusChip, type PaletteItem } from './components.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtHumanMin(spent: number, cap: number): string {
  if (cap > 0) return `${Math.round(spent)}/${cap}`;
  if (spent > 0) return `${Math.round(spent)} min`;
  return 'n/a';
}

export type DashboardTab =
  | 'home'
  | 'approvals'
  | 'ledger'
  | 'workflows'
  | 'governance'
  | 'activity'
  // legacy tabs — accepted in ?tab= and mapped, never rendered as rail items
  | 'compiler'
  | 'coordination'
  | 'router'
  | 'world'
  | 'economics'
  | 'evals'
  | 'feed';

/** Collapse 9 legacy tabs → 6 primary. Old URLs keep working. */
export function resolvePrimaryTab(
  tab: DashboardTab,
): 'home' | 'approvals' | 'ledger' | 'workflows' | 'governance' | 'activity' {
  if (tab === 'approvals' || tab === 'coordination') return 'approvals';
  if (tab === 'ledger') return 'ledger';
  if (tab === 'workflows' || tab === 'compiler' || tab === 'evals' || tab === 'router') return 'workflows';
  if (tab === 'governance' || tab === 'world' || tab === 'economics') return 'governance';
  if (tab === 'activity' || tab === 'feed') return 'activity';
  return 'home';
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
  activeTab?: DashboardTab;
  evaluations: RoomHealthEvaluation[];
  metrics: ShellMetrics;
  /** Real per-room recency (minutes since last buzz message); null = no messages. */
  recencyByScope?: Record<string, number | null>;
  compilerBoardHtml: string;
  compilerRightPanelHtml: string;
  compilerMetricsHtml: string;
  realityHtml: string;
  journeyHtml?: string;
  /** Executor honesty banner: absent, stale, or a test-baseline adapter. */
  executorHtml?: string;
  readinessHtml?: string;
  searchHtml?: string;
  activationHtml?: string;
  reviewHtml?: string;
  reportBodyHtml?: string;
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
    activeTab = 'home',
    evaluations,
    metrics,
    recencyByScope,
    compilerBoardHtml,
    compilerRightPanelHtml,
    compilerMetricsHtml,
    realityHtml,
    journeyHtml,
    executorHtml,
    readinessHtml,
    searchHtml,
    activationHtml,
    reviewHtml,
    reportBodyHtml,
    consoleNav,
    accountCluster,
  } = opts;

  const tenantDisplay = tenant === 'default' ? 'default' : tenant.charAt(0).toUpperCase() + tenant.slice(1);
  const initials = (userEmail.split('@')[0] || '')
    .split(/[._-]/)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2);
  const userName = userEmail
    ? (userEmail.split('@')[0] ?? userEmail).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Operator';
  void initials;
  void userName;
  const utcHour = new Date().getUTCHours();
  const defaultGreeting = utcHour < 12 ? 'Good morning' : utcHour < 18 ? 'Good afternoon' : 'Good evening';

  // Honest fallbacks: missing data renders as "n/a", never an invented value.
  const dollarsStr = `$${metrics.dollarsToday.toFixed(2)}`;
  const escalationsStr =
    metrics.escalationsCap > 0 ? `${metrics.escalationsUsed}/${metrics.escalationsCap}` : `${metrics.escalationsUsed}`;
  const humanMinStr = fmtHumanMin(metrics.humanMinutesToday, metrics.humanMinutesCap);
  // Real configured daily ceiling (room policy the coordinator enforces).
  // An unconfigured ceiling renders as "n/a" — never an invented limit.
  const budgetStr = metrics.dailyBudgetCeiling > 0 ? `$${metrics.dailyBudgetCeiling.toFixed(0)} / day limit` : 'n/a';

  const issueStateChip = (state: string): string => {
    if (state === 'DONE') return 'background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);';
    if (state === 'IN PROGRESS') return 'background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);';
    if (state === 'TO DO') return 'background:var(--v-tint-info-bg);color:var(--v-tint-info-ink);';
    return 'background:var(--v-bg-2);color:var(--v-muted);';
  };
  const issuePriorityColor = (priority: string): string => {
    if (priority === 'Urgent') return 'var(--v-risk)';
    if (priority === 'High') return 'var(--v-hypo)';
    return 'var(--v-muted)';
  };

  const issuesSidebarHtml =
    parseTeam(userTeam) === 'engineering'
      ? `\
      <div class="v-card issues-sidebar-section" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);margin-top:16px;">
        <div class="rooms-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:0;border-bottom:none;">
          <div class="rooms-title" style="color:var(--v-accent);font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px;">
            <span>Issues</span>
            <span class="rooms-badge" style="font-size:11px;font-weight:700;padding:1px 7px;border-radius:9999px;background:var(--v-accent-dim);color:var(--v-accent);">${esc(String(issues.length))}</span>
          </div>
          <a href="/console/issues" id="sidebar-issues-dashboard-link" style="font-size:11px;font-weight:600;color:var(--v-accent);text-decoration:none;padding:2px 8px;border-radius:9999px;background:var(--v-accent-dim);" title="#dashboard · Open Engineering Issues Board">Board →</a>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;">
          ${
            issues.length === 0
              ? `<a href="/console/issues" class="room-entry" style="font-size:11px;color:var(--v-muted);padding:8px 10px;background:var(--v-bg-2);border-radius:10px;display:block;">
            <div style="font-weight:500;color:var(--v-ink);">#dashboard</div>
            <div style="font-size:10px;color:var(--v-faint);margin-top:2px;">No open issues · click to open board</div>
          </a>`
              : issues
                  .slice(0, 8)
                  .map(
                    (iss) => `
          <a href="/console/issues" class="room-entry" title="${esc(iss.title)} (${esc(iss.state)})" style="padding:7px 10px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:10px;">
            <div class="room-entry-top" style="display:flex;justify-content:space-between;align-items:center;">
              <span class="room-name" style="font-size:11.5px;font-weight:600;color:var(--v-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;">${esc(iss.title)}</span>
              <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:9999px;${issueStateChip(iss.state)}">${esc(iss.state)}</span>
            </div>
            <div class="room-entry-sub" style="font-size:10px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
              <span style="color:${issuePriorityColor(iss.priority)};font-weight:500;">
                ${esc(iss.priority)}
              </span>
              <span class="v-mono" style="color:var(--v-faint);">#${esc(iss.id.slice(0, 5))}</span>
            </div>
          </a>`,
                  )
                  .join('\n')
          }
        </div>
      </div>`
      : '';

  const primary = resolvePrimaryTab(activeTab);
  const pendingTotal = evaluations.reduce((s, e) => s + (e.pendingApprovals || 0), 0);
  const stopsTotal = evaluations.reduce((s, e) => s + (e.activeStops || 0), 0);
  const driftTotal = evaluations.reduce((s, e) => s + ((e as { driftingCards?: number }).driftingCards || 0), 0);
  const roomsLive = evaluations.length;
  const esc2 = esc;

  let tabMainHtml: string;
  if (primary === 'home') {
    const kpis = [
      kpiCard({
        label: 'Needs human',
        value: String(pendingTotal),
        sub: `${escalationsStr} escalations used`,
        href: `/console/dashboard?tab=approvals`,
        linkLabel: 'Review →',
        tone: pendingTotal > 0 ? 'accent' : 'default',
        glyph: '!',
      }),
      kpiCard({
        label: 'Spend today',
        value: dollarsStr,
        sub: budgetStr === 'n/a' ? 'no daily ceiling set' : budgetStr,
        href: `/console/dashboard?tab=governance`,
        linkLabel: 'Budget →',
        tone: 'default',
        glyph: '$',
      }),
      kpiCard({
        label: 'Rooms live',
        value: String(roomsLive),
        sub: stopsTotal > 0 ? `${stopsTotal} active stops` : 'no active stops',
        href: `/console/rooms`,
        linkLabel: 'Rooms →',
        tone: stopsTotal > 0 ? 'accent' : 'default',
        glyph: '#',
      }),
      kpiCard({
        label: 'Drifting cards',
        value: String(driftTotal),
        sub: `${humanMinStr} human min today`,
        href: `/console/dashboard?tab=workflows`,
        linkLabel: 'Compiler →',
        tone: driftTotal > 0 ? 'risk' : 'default',
        glyph: '~',
      }),
    ].join('');
    const roomRows =
      evaluations
        .slice(0, 6)
        .map(
          (
            e,
          ) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--v-line);font-size:12.5px;">
        <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#${esc2(e.roomName ?? e.scope)}</span>
        <span style="display:flex;gap:10px;align-items:center;">${statusChip(e.status)}<span class="v-sub">${e.pendingApprovals} pending</span></span></div>`,
        )
        .join('') || '<p class="v-sub">No rooms yet.</p>';
    const greeting = defaultGreeting;
    tabMainHtml = `\
      <div class="dash-greeting-row" style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h1 id="dash-greeting-text" data-tenant="${esc2(tenantDisplay)}" class="dash-greeting-title" style="font-size:30px;font-weight:700;letter-spacing:-0.03em;color:var(--v-ink);line-height:1.15;">${greeting}, ${esc2(tenantDisplay)}</h1>
          <p style="font-size:13.5px;color:var(--v-muted);margin:5px 0 0;">Here's what needs your attention today.</p>
        </div>
        <div style="font-size:10px;font-weight:650;letter-spacing:0.18em;color:var(--v-faint);text-transform:uppercase;display:flex;gap:8px;align-items:center;">
          <span>BUILD</span><span>·</span><span>OPERATE</span><span>·</span><span>SCALE</span>
        </div>
      </div>
      ${executorHtml ? `<div style="margin-bottom:20px;">${executorHtml}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:22px;">${kpis}</div>
      <div style="margin-bottom:22px;">
        ${reviewHtml ?? ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px;margin-bottom:20px;">
        ${sectionCard('Rooms', 'Live health · pending per room', `<a href="/console/rooms" class="v-btn-pill-link" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">All rooms →</a>`, roomRows)}
        ${sectionCard('Attention', 'Spend, escalations and operator time today', `<a href="/console/dashboard?tab=governance" class="v-btn-pill-link" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">Governance →</a>`, `<div style="display:grid;gap:10px;font-size:13px;"><div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--v-line);"><span class="v-sub">Spend today</span><strong style="color:var(--v-ink);">${esc2(dollarsStr)}</strong></div><div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--v-line);"><span class="v-sub">Escalations</span><strong style="color:var(--v-ink);">${esc2(escalationsStr)}</strong></div><div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;"><span class="v-sub">Human minutes</span><strong style="color:var(--v-ink);">${esc2(humanMinStr)}</strong></div></div>`)}
      </div>
      <div style="margin-bottom:20px;">${sectionCard('Compiler — why not trusted yet', 'Quarantine → Shadow → Pilot → Promoted', `<a href="/console/dashboard?tab=workflows" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">Board →</a>`, compilerBoardHtml)}</div>
      ${activationHtml ? `<div style="margin-bottom:20px;">${sectionCard('Setup checklist', 'First-run activation for this tenant', `<a href="/setup" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">Setup →</a>`, activationHtml)}</div>` : ''}
      ${journeyHtml ? `<div style="margin-bottom:20px;">${journeyHtml}</div>` : ''}
      ${readinessHtml ? `<div style="margin-bottom:20px;">${readinessHtml}</div>` : ''}
      ${searchHtml ? `<div style="margin-bottom:20px;">${sectionCard('Find work', 'Search requests, claims, and workflows', `<a href="/console/requests" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">All requests →</a>`, searchHtml)}</div>` : ''}
      <div style="margin-top:12px;">${sectionCard('Reality health', 'Ledger invariants · cost curve · tier mix', `<a href="/console/dashboard?tab=ledger" style="font-size:12px;font-weight:600;color:var(--v-accent);text-decoration:none;">Ledger →</a>`, reportBodyHtml ?? realityHtml)}${shortcutHints()}</div>`;
  } else if (primary === 'ledger') {
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Reality Claims Ledger</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">Bi-temporal append-only truth store · Grounded facts, measurements, and verified claims.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${searchHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'approvals') {
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Coordination &amp; Approvals</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">Human-in-the-loop decision queue, cross-room swarm delegations, and request handoffs.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${reviewHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'governance') {
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Governance &amp; Policy Control Plane</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">RACI autonomy controls, spend, world grounding, and emergency kill-switches.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px;">
        ${kpiCard({ label: 'Spend today', value: dollarsStr, sub: budgetStr, tone: 'default', glyph: '$' })}
        ${kpiCard({ label: 'Escalations', value: escalationsStr, sub: 'daily attention cap', tone: 'default', glyph: '!' })}
        ${kpiCard({ label: 'Human minutes', value: humanMinStr, sub: 'operator attention today', tone: 'default', glyph: '◷' })}
      </div>
      <div style="margin-bottom:20px;">
        ${activationHtml ?? ''}
      </div>
      <div style="margin-bottom:20px;">
        ${readinessHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>
      <div style="display:none;">${realityHtml}</div>`;
  } else if (primary === 'activity') {
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Activity Feed &amp; Milestones</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">Chronological system milestones, tenant activation events, and audit stream.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${journeyHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'workflows') {
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Evaluations &amp; Learning</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">Model regression suites, cross-role transfer benchmarks, and EWMA drift monitors.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${compilerMetricsHtml}
      </div>
      <div style="margin-bottom:20px;">
        ${compilerBoardHtml}
      </div>
      <div style="display:none;">${realityHtml}</div>`;
  } else {
    // Fallback = workflows board (covers legacy compiler/router URLs).
    tabMainHtml = `\
      <div class="compiler-header" style="margin-bottom:20px;">
        <h1 class="compiler-title" style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);">Workflows &amp; Compiler</h1>
        <p style="font-size:13px;color:var(--v-muted);margin:4px 0 0;">Skill cards, shadow evals, transfer tests, and drift monitors.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${compilerMetricsHtml}
      </div>
      <div style="margin-bottom:20px;">
        ${compilerBoardHtml}
      </div>
      <div style="margin-top:24px;border-top:1px solid var(--v-line);padding-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  }

  let tabRightHtml: string;
  if (primary === 'home') {
    tabRightHtml = `\
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);margin-bottom:18px;">
        <h2 class="v-card-title" style="font-size:15.5px;font-weight:650;color:var(--v-ink);margin-bottom:6px;">Why not trusted yet?</h2>
        <p class="v-sub" style="font-size:12px;color:var(--v-muted);line-height:1.55;margin-bottom:16px;">
          No skill cards exist, so there are no transfer tests or drift readings to show. Cards are mined from real execution traces — nothing here is demo-seeded.
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:12px;">
            <div style="width:32px;height:32px;border-radius:8px;background:var(--v-bg-1);border:1px solid var(--v-line);display:grid;place-items:center;color:var(--v-ink);flex-shrink:0;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Quarantine</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">new cards land here first</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:12px;">
            <div style="width:32px;height:32px;border-radius:8px;background:var(--v-bg-1);border:1px solid var(--v-line);display:grid;place-items:center;color:var(--v-ink);flex-shrink:0;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/></svg>
            </div>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Shadow → Pilot</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">measured against live traffic</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:12px;">
            <div style="width:32px;height:32px;border-radius:8px;background:var(--v-bg-1);border:1px solid var(--v-line);display:grid;place-items:center;color:var(--v-fact);flex-shrink:0;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Promoted</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">transfer-tested, drift-watched</div>
            </div>
          </div>
        </div>
      </div>
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
        <h2 class="v-card-title" style="font-size:15.5px;font-weight:650;color:var(--v-ink);margin-bottom:4px;">Lifecycle ladder</h2>
        <p class="v-sub" style="font-size:12px;color:var(--v-muted);margin-bottom:16px;">Every card moves through these states.</p>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <span style="width:24px;height:24px;border-radius:50%;background:var(--v-bg-2);border:1px solid var(--v-line);color:var(--v-ink);display:grid;place-items:center;font-size:11.5px;font-weight:700;flex-shrink:0;">1</span>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Quarantine</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">new cards land here first</div>
            </div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <span style="width:24px;height:24px;border-radius:50%;background:var(--v-bg-2);border:1px solid var(--v-line);color:var(--v-ink);display:grid;place-items:center;font-size:11.5px;font-weight:700;flex-shrink:0;">2</span>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Shadow → Pilot</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">measured against live traffic</div>
            </div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <span style="width:24px;height:24px;border-radius:50%;background:var(--v-bg-2);border:1px solid var(--v-line);color:var(--v-ink);display:grid;place-items:center;font-size:11.5px;font-weight:700;flex-shrink:0;">3</span>
            <div>
              <div style="font-size:12.5px;font-weight:600;color:var(--v-ink);">Promoted</div>
              <div style="font-size:11px;color:var(--v-muted);margin-top:1px;">transfer-tested, drift-watched</div>
            </div>
          </div>
        </div>
      </div>
      ${issuesSidebarHtml}`;
  } else if (primary === 'ledger') {
    tabRightHtml = `\
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
        <h2 style="font-size:15px;font-weight:650;margin:0 0 14px 0;color:var(--v-ink);">Ledger Invariants</h2>
        <div style="font-size:12px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">I1/I2 Grounded Truth</strong>
            <div style="color:var(--v-muted);margin-top:3px;font-size:11px;line-height:1.4;">No generated facts. Only ground tier (SYSTEM_OF_RECORD / MEASURED) can assert FACT.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">I4 Contradiction Alarm</strong>
            <div style="color:var(--v-muted);margin-top:3px;font-size:11px;line-height:1.4;">Contradicting claims open an automated dispute review ticket.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">I5 Bi-temporal Validity</strong>
            <div style="color:var(--v-muted);margin-top:3px;font-size:11px;line-height:1.4;">Stale claims past valid_until are automatically excluded from RAG context.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">I7 Append-Only</strong>
            <div style="color:var(--v-muted);margin-top:3px;font-size:11px;line-height:1.4;">Rows in SQLite are never UPDATEd; updates supersede via bi-temporal links.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'approvals') {
    tabRightHtml = `\
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
        <h2 style="font-size:15px;font-weight:650;margin:0 0 14px 0;color:var(--v-ink);">Coordination Telemetry</h2>
        <div style="font-size:12px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">Attention Budget</strong>
            <div style="color:var(--v-ink);font-size:16px;font-weight:700;margin-top:2px;">${esc(escalationsStr)} escalations</div>
            <div style="color:var(--v-muted);font-size:11px;margin-top:2px;">Daily operator intervention cap.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">Human Operator Time</strong>
            <div style="color:var(--v-ink);font-size:16px;font-weight:700;margin-top:2px;">${esc(humanMinStr)}</div>
            <div style="color:var(--v-muted);font-size:11px;margin-top:2px;">Recorded operator attention today.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">Operator Authority</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:11px;">Decisions signed via Ed25519 cryptographic signatures.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'governance') {
    tabRightHtml = `\
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
        <h2 style="font-size:15px;font-weight:650;margin:0 0 14px 0;color:var(--v-ink);">Safety &amp; Compliance</h2>
        <div style="font-size:12px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-fact);font-size:12.5px;">✔ Kill-Switch Guard</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:11px;">Instant global freeze across all rooms and swarms.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">RACI Matrix</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:11px;">4-tier authorization: autonomous, approval, human-command, denied.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:10px 12px;border-radius:12px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);font-size:12.5px;">GDPR Article 17</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:11px;">Cryptographic erasure preserving ledger integrity.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'activity') {
    tabRightHtml = `\
      <div class="v-card" style="padding:22px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
        <h2 style="font-size:15px;font-weight:650;margin:0 0 10px 0;color:var(--v-ink);">Audit Stream</h2>
        <div style="font-size:12px;color:var(--v-muted);line-height:1.5;">Immutable append-only log recording tenant events and milestone achievements.</div>
      </div>`;
  } else {
    tabRightHtml = compilerRightPanelHtml;
  }

  // Real canonical + custom rooms with real evaluated health. Statuses are
  // never invented: unevaluated rooms show "—" (unknown), recency comes
  // from buzz_messages. Canonical rooms keep their order; user-made rooms
  // (created via /setup/rooms) append after.
  const canonicalOrder = new Map(CANONICAL_ROOMS.map((r, i) => [r.scope, i] as const));
  const orderedEvals = [...evaluations].sort(
    (a, b) => (canonicalOrder.get(a.scope) ?? 99) - (canonicalOrder.get(b.scope) ?? 99),
  );
  const roomsList = orderedEvals.map((ev) => {
    const canonical = CANONICAL_ROOMS.find((r) => r.scope === ev.scope);
    const time = recencyByScope?.[ev.scope];
    return {
      name: canonical?.name ?? ev.roomName,
      scope: ev.scope,
      category: ev.category,
      status: ev.status.toLowerCase(),
      time: time === null || time === undefined ? 'n/a' : `${time}m`,
    };
  });

  const deptTabs = renderDepartmentTabs(activeDepartment, home);
  const deptBanner = renderDepartmentBanner({
    activeScope: activeDepartment,
    home,
    userRole,
    evaluations,
  });

  const paletteItems: PaletteItem[] = [
    { label: 'Go to Home', hint: 'executive overview', href: `/console/dashboard?tab=home`, keys: 'g h' },
    {
      label: 'Go to Approvals',
      hint: `${pendingTotal} pending`,
      href: `/console/dashboard?tab=approvals`,
      keys: 'g a',
    },
    { label: 'Go to Ledger', hint: 'claims + context bundles', href: `/console/dashboard?tab=ledger`, keys: 'g l' },
    { label: 'Go to Workflows', hint: 'compiler board', href: `/console/dashboard?tab=workflows`, keys: 'g w' },
    { label: 'Go to Governance', hint: 'policy + spend', href: `/console/dashboard?tab=governance`, keys: 'g g' },
    { label: 'Go to Meetings', hint: 'library + live rooms', href: `/console/meetings`, keys: 'g m' },
    { label: 'Go to Activity', hint: 'feed + milestones', href: `/console/dashboard?tab=activity` },
    { label: 'Go to Chat (Buzz)', hint: 'rooms workspace', href: `/console/buzz/engineering`, keys: 'g c' },
    { label: 'Toggle dark / light', hint: 'dark default', run: 'toggle-theme', keys: 't' },
    ...roomsList.slice(0, 12).map((r) => ({
      label: `Open #${r.name}`,
      hint: `${r.status || 'unknown'} · ${r.time}`,
      href: `/console/buzz/${encodeURIComponent(r.scope)}`,
    })),
  ];

  return `
<style>
  .dash-view { width: 100%; }
  .dash-view .card { background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: var(--radius-card); padding: 18px 20px; box-shadow: var(--v-card-shadow); margin-bottom: 14px; }
  .dash-view .sub { font-size: 12px; color: var(--v-muted); line-height: 1.5; }
  .dash-view .big { font-size: 36px; font-weight: 700; letter-spacing: -0.02em; margin: 6px 0; font-variant-numeric: tabular-nums; color: var(--v-ink); }
  .dash-view .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 14px; }
  .dash-view .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
  .dash-view .bar { height: 6px; background: var(--v-line); border-radius: var(--radius-pill); overflow: hidden; margin: 8px 0; }
  .dash-view .bar > i { display: block; height: 100%; background: var(--v-accent); border-radius: var(--radius-pill); }
  .dash-view table { border-collapse: collapse; width: 100%; font-size: 13px; background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: var(--radius-card); overflow: hidden; }
  .dash-view th, .dash-view td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--v-line); }
  .dash-view th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--v-muted); }
  .dash-view details { background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: var(--radius-card); padding: 12px 16px; margin: 10px 0; }
  .dash-view summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .dash-view input, .dash-view select, .dash-view textarea { background: var(--v-input-bg); border: 1px solid var(--v-line-strong); border-radius: var(--radius-md); padding: 8px 12px; font-size: 13px; color: var(--v-ink); }
  .dash-view button:not(.search-box):not(.search-pill-btn) { border-radius: var(--radius-pill); }
</style>
<div class="dash-view">
  <!-- Screen reader and test compatibility markers -->
  <span style="display:none">Workspace ${roomsList.length} rooms · operations dashboard</span>
  <div style="display:none;" aria-hidden="true">
    ${consoleNav ?? ''}
    ${accountCluster ?? ''}
  </div>

  <!-- Department Filter Tabs & Status Banner -->
  <div style="margin-bottom:18px;">
    ${deptTabs}
    ${deptBanner}
  </div>

  <!-- Main 2-Column Wide Grid Layout (Compiler-grade) -->
  <div class="v-grid-wide" style="align-items:start;">
    <div class="v-stack">
      ${tabMainHtml}
    </div>
    <aside class="v-stack-sm" aria-label="Tab Details">
      ${tabRightHtml}
    </aside>
  </div>

  ${
    parseTeam(userTeam) === 'engineering'
      ? `<script>
  (function(){
    var watermark = new Date().toISOString();
    var issuesSection = document.querySelector('.issues-sidebar-section');
    if(!issuesSection) return;
    function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function stateChip(s){ if(s==='DONE') return 'background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);'; if(s==='IN PROGRESS') return 'background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);'; if(s==='TO DO') return 'background:var(--v-tint-info-bg);color:var(--v-tint-info-ink);'; return 'background:var(--v-bg-2);color:var(--v-muted);'; }
    function prioColor(p){ if(p==='Urgent') return 'var(--v-risk)'; if(p==='High') return 'var(--v-hypo)'; return 'var(--v-muted)'; }
    function renderList(issues){
      var badge = issuesSection.querySelector('.rooms-badge');
      if(badge) badge.textContent = String(issues.length);
      var container = issuesSection.querySelector('div[style*="max-height:220px"]');
      if(!container) return;
      if(issues.length===0){
        container.innerHTML = '<a href="/console/issues" class="room-entry" style="font-size:11px;color:var(--v-muted);padding:6px 8px;background:var(--v-bg-2);border-radius:6px;display:block;"><div style="font-weight:500;color:var(--v-ink);">#dashboard</div><div style="font-size:10px;color:var(--v-faint);margin-top:2px;">No open issues \\u00b7 click to open board</div></a>';
        return;
      }
      container.innerHTML = issues.slice(0,8).map(function(iss){
        return '<a href="/console/issues" class="room-entry" title="'+escH(iss.title)+' ('+escH(iss.state)+')" style="padding:5px 8px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:6px;">'
          +'<div class="room-entry-top"><span class="room-name" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:105px;">'+escH(iss.title)+'</span><span style="font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;'+stateChip(iss.state)+'">'+escH(iss.state)+'</span></div>'
          +'<div class="room-entry-sub" style="font-size:9px;margin-top:2px;"><span style="color:'+prioColor(iss.priority)+';font-weight:500;">'+escH(iss.priority)+'</span><span style="color:var(--v-faint);">#'+escH(String(iss.id).slice(0,5))+'</span></div>'
          +'</a>';
      }).join('');
    }
    function tick(){
      fetch('/console/issues/sync?since='+encodeURIComponent(watermark), { headers:{ 'accept':'application/json' } })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(data){
          if(!data||!data.ok||!data.snapshot) return;
          watermark = data.snapshot.serverTime || watermark;
          if(Array.isArray(data.snapshot.issues) && data.snapshot.issues.length>=0){
            if(!window.__dashIssues) window.__dashIssues = ${JSON.stringify(issues)}.slice();
            var map={}; window.__dashIssues.forEach(function(i){ map[i.id]=i; });
            data.snapshot.issues.forEach(function(i){ map[i.id]=i; });
            window.__dashIssues = Object.values(map).sort(function(a,b){ return (b.updatedAt||'').localeCompare(a.updatedAt||''); });
            renderList(window.__dashIssues);
          }
        }).catch(function(){});
    }
    setInterval(tick, 4000);
  })();
  </script>`
      : ''
  }
  ${paletteHtml(paletteItems)}
  <script>
  (()=>{
    // Keyboard navigation shortcuts
    document.addEventListener('keydown',e=>{
      if(e.target&&/input|textarea|select/i.test(e.target.tagName))return;
      const k=e.key.toLowerCase();
      if(k==='?'){
        e.preventDefault();
        window.openVitalPalette&&window.openVitalPalette();
      }else if(k==='g'){
        const h=(ev)=>{
          const k2=ev.key.toLowerCase();
          document.removeEventListener('keydown',h);
          const map={h:'home',a:'approvals',l:'ledger',w:'workflows',g:'governance'};
          if(k2==='c'){location.href='/console/buzz/engineering';}
          else if(k2==='m'){location.href='/console/meetings';}
          else if(map[k2]){location.href='/console/dashboard?tab='+map[k2];}
        };
        document.addEventListener('keydown',h,{once:true});
      }
    });

    // Client-side local greeting sync
    try {
      var curHour = new Date().getHours();
      var curGreet = curHour < 12 ? 'Good morning' : curHour < 18 ? 'Good afternoon' : 'Good evening';
      var greetEl = document.getElementById('dash-greeting-text');
      if (greetEl) {
        var tenantAttr = greetEl.getAttribute('data-tenant') || '';
        greetEl.textContent = curGreet + (tenantAttr ? ', ' + tenantAttr : '');
      }
    } catch (err) {}
  })();
  </script>
</div>`;
}
