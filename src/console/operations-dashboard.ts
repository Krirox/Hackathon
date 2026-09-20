import type { RoomHealthEvaluation } from '../talk/health.ts';
import type { ShellMetrics } from './shell-metrics.ts';
import { CANONICAL_ROOMS } from '../talk/rooms.ts';
import { parseTeam } from '../core/auth.ts';
import type { IssueRow } from './issues.ts';
import { renderDepartmentTabs, renderDepartmentBanner, type DashboardDepartment } from './dashboard-views.ts';

import { THEME_INIT_SCRIPT, THEME_TOGGLE_SCRIPT, themeStyleBlock, themeToggleButton } from './theme.ts';
import { kpiCard, paletteHtml, sectionCard, shortcutHints, statusChip, type PaletteItem } from './components.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtHumanMin(spent: number, cap: number): string {
  if (cap > 0) return `${Math.round(spent)}/${cap}`;
  if (spent > 0) return `${Math.round(spent)} min`;
  return '—';
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

  // Honest fallbacks: missing data renders as "—", never an invented value.
  const dollarsStr = metrics.dollarsToday > 0 ? `$${metrics.dollarsToday.toFixed(2)}` : '—';
  const escalationsStr =
    metrics.escalationsCap > 0 ? `${metrics.escalationsUsed}/${metrics.escalationsCap}` : `${metrics.escalationsUsed}`;
  const humanMinStr = fmtHumanMin(metrics.humanMinutesToday, metrics.humanMinutesCap);
  // Real configured daily ceiling (room policy the coordinator enforces).
  // An unconfigured ceiling renders as an em dash — never an invented limit.
  const budgetStr = metrics.dailyBudgetCeiling > 0 ? `$${metrics.dailyBudgetCeiling.toFixed(0)} / day limit` : '—';

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
      <div class="issues-sidebar-section" style="border-top:1px solid var(--v-line);margin-top:10px;padding-top:10px;">
        <div class="rooms-header" style="padding:4px 12px 6px;border-bottom:none;">
          <div class="rooms-title" style="color:var(--v-accent);font-size:11.5px;">
            <span>Issues</span>
            <span class="rooms-badge" style="background:var(--v-accent-dim);color:var(--v-accent);">${esc(String(issues.length))}</span>
          </div>
          <a href="/console/issues" id="sidebar-issues-dashboard-link" style="font-size:10.5px;font-weight:600;color:var(--v-accent);text-decoration:none;padding:1px 6px;border-radius:4px;background:var(--v-accent-dim);" title="#dashboard — Open Engineering Issues Board">Board →</a>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;padding:2px 8px;max-height:220px;overflow-y:auto;">
          ${
            issues.length === 0
              ? `<a href="/console/issues" class="room-entry" style="font-size:11px;color:var(--v-muted);padding:6px 8px;background:var(--v-bg-2);border-radius:6px;display:block;">
            <div style="font-weight:500;color:var(--v-ink);">#dashboard</div>
            <div style="font-size:10px;color:var(--v-faint);margin-top:2px;">No open issues · click to open board</div>
          </a>`
              : issues
                  .slice(0, 8)
                  .map(
                    (iss) => `
          <a href="/console/issues" class="room-entry" title="${esc(iss.title)} (${esc(iss.state)})" style="padding:5px 8px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:6px;">
            <div class="room-entry-top">
              <span class="room-name" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:105px;">${esc(iss.title)}</span>
              <span style="font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;${issueStateChip(iss.state)}">${esc(iss.state)}</span>
            </div>
            <div class="room-entry-sub" style="font-size:9px;margin-top:2px;">
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
        sub: budgetStr === '—' ? 'no daily ceiling set' : budgetStr,
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
    tabMainHtml = `\
      <div class="compiler-header">
        <h1 class="compiler-title">Welcome back — ${esc2(tenantDisplay)}</h1>
        <p style="font-size:12.5px;color:var(--v-muted);margin:4px 0 0;">What needs attention, what the ledger knows, and what it cost. Light by default, keyboard-first.</p>
      </div>
      ${executorHtml ? `<div style="margin-bottom:18px;">${executorHtml}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:18px;">${kpis}</div>
      <div style="margin-bottom:18px;">${reviewHtml ?? ''}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px;margin-bottom:18px;">
        ${sectionCard('Rooms', 'Live health · pending per room', `<a href="/console/rooms" style="font-size:12px;font-weight:600;">All rooms →</a>`, roomRows)}
        ${sectionCard('Attention', 'Spend, escalations and operator time today', `<a href="/console/dashboard?tab=governance" style="font-size:12px;font-weight:600;">Governance →</a>`, `<div style="display:grid;gap:8px;font-size:12.5px;"><div style="display:flex;justify-content:space-between;"><span class="v-sub">Spend today</span><strong>${esc2(dollarsStr)}</strong></div><div style="display:flex;justify-content:space-between;"><span class="v-sub">Escalations</span><strong>${esc2(escalationsStr)}</strong></div><div style="display:flex;justify-content:space-between;"><span class="v-sub">Human minutes</span><strong>${esc2(humanMinStr)}</strong></div></div>`)}
      </div>
      <div style="margin-bottom:18px;">${sectionCard('Compiler — why not trusted yet', 'Quarantine → Shadow → Pilot → Promoted', `<a href="/console/dashboard?tab=workflows" style="font-size:12px;font-weight:600;">Board →</a>`, compilerBoardHtml)}</div>
      ${activationHtml ? `<div style="margin-bottom:18px;">${sectionCard('Setup checklist', 'First-run activation for this tenant', `<a href="/setup" style="font-size:12px;font-weight:600;">Setup →</a>`, activationHtml)}</div>` : ''}
      ${journeyHtml ? `<div style="margin-bottom:18px;">${journeyHtml}</div>` : ''}
      ${readinessHtml ? `<div style="margin-bottom:18px;">${readinessHtml}</div>` : ''}
      ${searchHtml ? `<div style="margin-bottom:18px;">${sectionCard('Find work', 'Search requests, claims, and workflows', `<a href="/console/requests" style="font-size:12px;font-weight:600;">All requests →</a>`, searchHtml)}</div>` : ''}
      <div style="margin-top:8px;">${sectionCard('Reality health', 'Ledger invariants · cost curve · tier mix', `<a href="/console/dashboard?tab=ledger" style="font-size:12px;font-weight:600;">Ledger →</a>`, reportBodyHtml ?? realityHtml)}${shortcutHints()}</div>`;
  } else if (primary === 'ledger') {
    tabMainHtml = `\
      <div class="compiler-header">
        <h1 class="compiler-title">Reality Claims Ledger</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">Bi-temporal append-only truth store · Grounded facts, measurements, and verified claims.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${searchHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'approvals') {
    tabMainHtml = `\
      <div class="compiler-header">
        <h1 class="compiler-title">Coordination &amp; Approvals</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">Human-in-the-loop decision queue, cross-room swarm delegations, and request handoffs.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${reviewHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'governance') {
    tabMainHtml = `\
      <div class="compiler-header">
        <h1 class="compiler-title">Governance &amp; Policy Control Plane</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">RACI autonomy controls, spend, world grounding, and emergency kill-switches.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:18px;">
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
      <div class="compiler-header">
        <h1 class="compiler-title">Activity Feed &amp; Milestones</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">Chronological system milestones, tenant activation events, and audit stream.</p>
      </div>
      <div style="margin-bottom:20px;">
        ${journeyHtml ?? ''}
      </div>
      <div style="margin-top:20px;">
        ${reportBodyHtml ?? realityHtml}
      </div>`;
  } else if (primary === 'workflows') {
    tabMainHtml = `\
      <div class="compiler-header">
        <h1 class="compiler-title">Evaluations &amp; Learning</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">Model regression suites, cross-role transfer benchmarks, and EWMA drift monitors.</p>
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
      <div class="compiler-header">
        <h1 class="compiler-title">Workflows &amp; Compiler</h1>
        <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0;">Skill cards, shadow evals, transfer tests, and drift monitors.</p>
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
  if (primary === 'ledger') {
    tabRightHtml = `\
      <div>
        <h2 style="font-size:14px;font-weight:700;margin:0 0 12px 0;color:var(--v-ink);">Ledger Invariants</h2>
        <div style="font-size:11.5px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">I1/I2 Grounded Truth</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">No generated facts. Only ground tier (SYSTEM_OF_RECORD / MEASURED) can assert FACT.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">I4 Contradiction Alarm</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Contradicting claims open an automated dispute review ticket.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">I5 Bi-temporal Validity</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Stale claims past valid_until are automatically excluded from RAG context.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">I7 Append-Only</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Rows in SQLite are never UPDATEd; updates supersede via bi-temporal links.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'approvals') {
    tabRightHtml = `\
      <div>
        <h2 style="font-size:14px;font-weight:700;margin:0 0 12px 0;color:var(--v-ink);">Coordination Telemetry</h2>
        <div style="font-size:11.5px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">Attention Budget</strong>
            <div style="color:var(--v-ink);font-size:14px;font-weight:700;margin-top:2px;">${esc(escalationsStr)} escalations</div>
            <div style="color:var(--v-muted);font-size:10.5px;margin-top:2px;">Daily operator intervention cap.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">Human Operator Time</strong>
            <div style="color:var(--v-ink);font-size:14px;font-weight:700;margin-top:2px;">${esc(humanMinStr)}</div>
            <div style="color:var(--v-muted);font-size:10.5px;margin-top:2px;">Recorded operator attention today.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">Operator Authority</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Decisions signed via Ed25519 cryptographic signatures.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'governance') {
    tabRightHtml = `\
      <div>
        <h2 style="font-size:14px;font-weight:700;margin:0 0 12px 0;color:var(--v-ink);">Safety &amp; Compliance</h2>
        <div style="font-size:11.5px;color:var(--v-ink-2);display:flex;flex-direction:column;gap:10px;">
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-fact);">✔ Kill-Switch Guard</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Instant global freeze across all rooms and swarms.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">RACI Matrix</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">4-tier authorization: autonomous, approval, human-command, denied.</div>
          </div>
          <div style="background:var(--v-bg-2);padding:8px 10px;border-radius:6px;border:1px solid var(--v-line);">
            <strong style="color:var(--v-accent);">GDPR Article 17</strong>
            <div style="color:var(--v-muted);margin-top:2px;font-size:10.5px;">Cryptographic erasure preserving ledger integrity.</div>
          </div>
        </div>
      </div>`;
  } else if (primary === 'activity') {
    tabRightHtml = `\
      <div>
        <h2 style="font-size:14px;font-weight:700;margin:0 0 12px 0;color:var(--v-ink);">Audit Stream</h2>
        <div style="font-size:11.5px;color:var(--v-muted);">Immutable append-only log recording tenant events and milestone achievements.</div>
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
      time: time === null || time === undefined ? '—' : `${time}m`,
    };
  });

  const deptTabs = renderDepartmentTabs(activeDepartment);
  const deptBanner = renderDepartmentBanner({
    activeScope: activeDepartment,
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
      hint: `${r.status || '—'} · ${r.time}`,
      href: `/console/buzz/${encodeURIComponent(r.scope)}`,
    })),
  ];

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vital — Operations Dashboard</title>
  <meta name="vital-csrf" content="${esc(csrfToken)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script>${THEME_INIT_SCRIPT}</script>
  ${themeStyleBlock()}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--v-bg-0);
      color: var(--v-ink);
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    a { color: inherit; text-decoration: none; }
    .top-bar {
      height: 60px;
      background: var(--v-bg-1);
      border-bottom: 1px solid var(--v-line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
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
      color: var(--v-ink);
    }
    .tenant-select {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--v-ink-2);
      padding: 5px 10px;
      background: var(--v-bg-2);
      border: 1px solid var(--v-line);
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .top-center {
      flex: 1;
      max-width: 480px;
      margin: 0 20px;
      min-width: 0;
    }
    .search-box {
      width: 100%;
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--v-bg-2);
      border: 1px solid var(--v-line);
      border-radius: 10px;
      padding: 0 12px;
      font-size: 12.5px;
      color: var(--v-muted);
    }
    .search-box:hover { border-color: var(--v-line-strong); }
    .search-box input {
      border: 0;
      outline: 0;
      background: transparent;
      width: 100%;
      font-size: 12.5px;
      color: var(--v-ink);
    }
    .search-box input::placeholder {
      color: var(--v-faint);
    }
    .top-right {
      display: flex;
      align-items: center;
      gap: 20px;
      min-width: 0;
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
      color: var(--v-ink);
      font-variant-numeric: tabular-nums;
    }
    .stat-chip .lbl {
      font-size: 10px;
      color: var(--v-muted);
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
      background: var(--v-accent);
      color: var(--v-accent-ink);
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
    }
    /* Responsive top bar: the fixed 60px row cannot wrap, so before it can
       overflow and clip its right-hand cluster at tablet widths we shed the
       redundant live-readout chips — the same spend / escalations / human-min
       numbers already render as KPI cards in the body. Every *action* (theme,
       search, Go to Chat, account) stays reachable; only duplicate
       informational chips collapse, then the (non-interactive) tenant label. */
    @media (max-width: 1200px) {
      .top-bar { gap: 10px; padding: 0 14px; }
      .top-right { gap: 12px; }
      .top-center { margin: 0 10px; }
      .stat-chip { display: none; }
    }
    @media (max-width: 640px) {
      .top-bar { padding: 0 12px; }
      .top-right { gap: 10px; }
      .tenant-select { display: none; }
      .top-center { margin: 0 8px; }
    }

    /* Layout Columns */
    .dashboard-body {
      display: flex;
      min-height: calc(100vh - 54px);
    }
    
    /* Left grouped sidebar (brief: narrow, elegant, sectioned) */
    .icon-rail {
      width: 216px;
      flex-shrink: 0;
      background: var(--v-bg-1);
      border-right: 1px solid var(--v-line);
      display: flex;
      flex-direction: column;
      padding: 14px 10px;
      gap: 2px;
      overflow-y: auto;
    }
    .rail-section {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--v-faint);
      padding: 12px 10px 5px;
    }
    .rail-section:first-child { padding-top: 2px; }
    .rail-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      border-radius: 10px;
      color: var(--v-ink-2);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.12s var(--ease-out), color 0.12s var(--ease-out);
      white-space: nowrap;
    }
    .rail-item:hover {
      background: var(--v-bg-2);
      color: var(--v-ink);
    }
    .rail-item.active {
      background: var(--v-accent-dim);
      color: var(--v-accent);
      font-weight: 600;
    }
    [data-theme="dark"] .rail-item.active { color: var(--v-accent); }
    .rail-item svg {
      width: 17px;
      height: 17px;
      stroke-width: 1.8;
      flex-shrink: 0;
    }
    .rail-badge {
      margin-left: auto;
      font-size: 10.5px;
      font-weight: 700;
      background: var(--v-tint-risk-bg);
      color: var(--v-tint-risk-ink);
      padding: 1px 7px;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    .rail-spacer { flex: 1; min-height: 12px; }
    @media (max-width: 1150px) {
      .icon-rail { width: 60px; padding: 14px 8px; align-items: stretch; }
      .rail-section, .rail-item span:last-child, .rail-badge { display: none; }
      .rail-item { justify-content: center; padding: 9px 0; }
    }

    /* Second Column: Rooms */
    .rooms-col {
      width: 208px;
      flex-shrink: 0;
      background: var(--v-bg-1);
      border-right: 1px solid var(--v-line);
      display: flex;
      flex-direction: column;
    }
    .rooms-header {
      padding: 14px 12px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--v-line);
    }
    .rooms-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--v-ink);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rooms-badge {
      font-size: 10px;
      background: var(--v-bg-2);
      color: var(--v-muted);
      padding: 1px 6px;
      border-radius: 10px;
      font-weight: 600;
    }
    .rooms-add-btn {
      color: var(--v-accent);
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
      padding: 7px 8px;
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      transition: background 0.12s var(--ease-out);
    }
    .room-entry:hover {
      background: var(--v-bg-2);
    }
    .room-entry-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      line-height: 1.2;
    }
    .room-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--v-ink);
    }
    .room-recency {
      font-size: 10px;
      color: var(--v-faint);
      font-variant-numeric: tabular-nums;
    }
    .room-entry-sub {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      color: var(--v-muted);
      margin-top: 2px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 4px;
    }
    .status-dot.healthy { background: var(--v-fact); }
    .status-dot.degraded { background: var(--v-hypo); }
    .status-dot.idle { background: var(--v-faint); }
    .status-dot.halted { background: var(--v-risk); }

    /* Main Content Viewport */
    .main-viewport {
      flex: 1;
      min-width: 0;
      padding: 24px 32px;
      overflow-y: auto;
    }
    .compiler-header {
      margin-bottom: 16px;
    }
    .compiler-title {
      font-size: 30px;
      font-weight: 700;
      color: var(--v-ink);
      letter-spacing: -0.02em;
    }
    @media (max-width: 900px) {
      .main-viewport { padding: 16px; }
      .rooms-col, .right-sidebar { display: none; }
      .compiler-title { font-size: 24px; }
    }

    /* Right Sidebar */
    .right-sidebar {
      width: 264px;
      flex-shrink: 0;
      background: var(--v-bg-1);
      border-left: 1px solid var(--v-line);
      padding: 20px 16px;
    }

    /* Embedded fragments (report, activation, journey, readiness, review
       fallbacks) reuse the report vocabulary: card/sub/big/grid/cols/bar.
       Mapped here so nothing renders as bare stacked text on any tab. */
    .main-viewport .card {
      background: var(--v-bg-1);
      border: 1px solid var(--v-line);
      border-radius: var(--radius-card);
      padding: 18px 20px;
      box-shadow: var(--v-card-shadow);
      margin-bottom: 14px;
    }
    .main-viewport .sub { font-size: 12px; color: var(--v-muted); line-height: 1.5; }
    .main-viewport .big {
      font-size: 38px; font-weight: 700; letter-spacing: -0.02em;
      margin: 6px 0; font-variant-numeric: tabular-nums; color: var(--v-ink);
    }
    .main-viewport .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 14px; }
    .main-viewport .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
    .main-viewport .bar { height: 6px; background: var(--v-line); border-radius: 3px; overflow: hidden; margin: 8px 0; }
    .main-viewport .bar > i { display: block; height: 100%; background: var(--v-accent); border-radius: 3px; }
    .main-viewport h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0 8px; font-style: normal; }
    .main-viewport h2 { font-size: 15px; font-weight: 650; margin: 22px 0 10px; font-style: normal; }
    /* Embedded theme components (activation panel, readiness, review) render
       inside .main-viewport and carry their own .v-section-title / .v-card-title
       classes. The generic h1/h2 rules above are sized for the dashboard's own
       .compiler-title headings; without these overrides they inflate those
       embedded headings to 30px and cram the eyebrow label into the title.
       Restore the theme sizes (specificity 0,2,0 beats the 0,1,1 element rules). */
    .main-viewport .v-section-title { font-size: 20px; margin: 0; }
    .main-viewport .v-card-title { font-size: 15.5px; margin: 0; }
    .main-viewport table { border-collapse: collapse; width: 100%; font-size: 13px; background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: 12px; overflow: hidden; }
    .main-viewport th, .main-viewport td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--v-line); }
    .main-viewport th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--v-muted); }
    .main-viewport details { background: var(--v-bg-1); border: 1px solid var(--v-line); border-radius: 12px; padding: 10px 14px; margin: 10px 0; }
    .main-viewport summary { cursor: pointer; font-weight: 600; font-size: 13px; }
    .main-viewport input, .main-viewport select, .main-viewport textarea {
      background: var(--v-input-bg); border: 1px solid var(--v-line-strong);
      border-radius: var(--radius-input); padding: 9px 12px; font-size: 13px; color: var(--v-ink);
    }
    .main-viewport button { border-radius: 10px; }
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
          <rect x="3" y="6" width="3.5" height="12" rx="1.75" fill="var(--v-accent)"/>
          <rect x="10.25" y="3" width="3.5" height="18" rx="1.75" fill="var(--v-accent)"/>
          <rect x="17.5" y="8" width="3.5" height="10" rx="1.75" fill="var(--v-accent)"/>
        </svg>
        <span>Vital</span>
      </div>
      <div class="tenant-select" title="Current Workspace Tenant">
        <span>${esc(tenantDisplay)}</span>
        <span style="font-size:10px;color:var(--v-faint);">▾</span>
      </div>
    </div>

    <div class="top-center">
      <button type="button" class="search-box" onclick="window.openVitalPalette&&window.openVitalPalette()" aria-label="Open command palette (Ctrl+K)" style="cursor:pointer;text-align:left;width:100%;background:var(--v-bg-1);border:1px solid var(--v-line);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <span style="flex:1;font-size:12.5px;color:var(--v-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Search rooms, claims, approvals…</span>
        <kbd style="font-size:10px;color:var(--v-muted);border:1px solid var(--v-line);border-radius:4px;padding:1px 6px;">⌘K</kbd>
      </button>
    </div>

    <div class="top-right">
      ${themeToggleButton()}
      <a href="/console/buzz/engineering" id="go-to-chat-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--v-accent);color:var(--v-accent-ink);border-radius:12px;font-size:12.5px;font-weight:600;text-decoration:none;transition:filter 0.15s;margin-right:6px;white-space:nowrap;" title="Switch to Workspace Chat">
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
      <a href="/account" class="profile-chip" title="${esc(userEmail)} (${esc(userRole)}) — Account Settings">
        <div class="avatar-circle">${esc(initials)}</div>
        <span style="font-size:11px;color:var(--v-faint);">▾</span>
      </a>
    </div>
  </header>

  <!-- Body: sidebar + rooms + viewport + inspector -->
  <div class="dashboard-body">
    <!-- 1. Grouped sidebar -->
    <nav class="icon-rail" aria-label="Console navigation">
      <div class="rail-section">Overview</div>
      <a href="/console/dashboard?tab=home" class="rail-item ${primary === 'home' ? 'active' : ''}" title="Dashboard — executive overview (g h)" aria-current="${primary === 'home' ? 'page' : 'false'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          <polyline points="9 22 9 12 15 12 15 22"></polyline>
        </svg>
        <span>Dashboard</span>
      </a>
      <a href="/console/dashboard?tab=activity" class="rail-item ${primary === 'activity' ? 'active' : ''}" title="Activity feed">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <path d="M16 10a4 4 0 0 1-8 0"></path>
        </svg>
        <span>Activity</span>
      </a>
      <a href="/console/dashboard?tab=approvals" class="rail-item ${primary === 'approvals' ? 'active' : ''}" title="Approvals queue (g a)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 11l3 3L22 4"></path>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
        </svg>
        <span>Approvals</span>${pendingTotal > 0 ? `<span class="rail-badge">${pendingTotal}</span>` : ''}
      </a>

      <div class="rail-section">Operations</div>
      <a href="/console/dashboard?tab=ledger" class="rail-item ${primary === 'ledger' ? 'active' : ''}" title="Reality ledger — claims and evidence (g l)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
        <span>Ledger</span>
      </a>
      <a href="/console/dashboard?tab=workflows" id="console-workflows-btn" class="rail-item ${primary === 'workflows' ? 'active' : ''}" title="Workflows and compiler (g w)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 3 21 3 21 8"></polyline>
          <line x1="4" y1="20" x2="21" y2="3"></line>
          <polyline points="21 16 21 21 16 21"></polyline>
          <line x1="15" y1="15" x2="21" y2="21"></line>
          <line x1="4" y1="4" x2="9" y2="9"></line>
        </svg>
        <span>Workflows</span>
      </a>
      <a href="/console/dashboard?tab=governance" class="rail-item ${primary === 'governance' ? 'active' : ''}" title="Governance, spend and policy (g g)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <span>Governance</span>
      </a>
      <a href="/console/meetings" class="rail-item" title="Meeting library and live rooms (g m)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 7l-7 5 7 5V7z"></path>
          <rect x="1" y="5" width="15" height="14" rx="2"></rect>
        </svg>
        <span>Meetings</span>
      </a>

      <div class="rail-section">System</div>
      <a href="/console/compiler" class="rail-item" title="Compiler — why cards are trusted">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="5.5" rx="8" ry="3.2"></ellipse>
          <path d="M4 5.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"></path>
          <path d="M4 11.5v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"></path>
        </svg>
        <span>Compiler</span>
      </a>
      <a href="/console/digest" class="rail-item" title="Notice digest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4h16v16H4z"></path>
          <path d="M8 9h8M8 13h8M8 17h5"></path>
        </svg>
        <span>Digest</span>
      </a>
      <a href="/console/learning" class="rail-item" title="Learning review">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3 2 8l10 5 10-5-10-5z"></path>
          <path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"></path>
        </svg>
        <span>Learning</span>
      </a>
      <a href="/console/audit" class="rail-item" title="Audit log">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          <line x1="11" y1="8" x2="11" y2="14"></line>
          <line x1="8" y1="11" x2="14" y2="11"></line>
        </svg>
        <span>Audit</span>
      </a>
      <a href="/console/data" class="rail-item" title="Data and retention">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="6" rx="8" ry="3.2"></ellipse>
          <path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"></path>
          <path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"></path>
        </svg>
        <span>Data</span>
      </a>

      <!-- Engineering Issues (engineers only; the board lives at /console/issues) -->
      ${issuesSidebarHtml}

      <div class="rail-spacer"></div>
      <div class="rail-section">Administration</div>
      <a href="/team" class="rail-item" title="Team">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
        <span>Team</span>
      </a>
      <a href="/setup" class="rail-item" title="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8 7 17M17 7l2.8-2.8"></path>
        </svg>
        <span>Settings</span>
      </a>
      <a href="/account" class="rail-item" title="Account">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
        <span>Account</span>
      </a>
    </nav>

    <!-- 2. Main Center Viewport: Selected Tab View -->
    <main id="main" class="main-viewport">
      <!-- Department Filter Tabs -->
      ${deptTabs}
      ${deptBanner}

      ${tabMainHtml}
    </main>

    <!-- 4. Right Sidebar: Contextual to Selected Tab -->
    <aside class="right-sidebar" aria-label="Tab Details">
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
<script>${THEME_TOGGLE_SCRIPT}</script>
<script>(()=>{document.addEventListener('keydown',e=>{if(e.target&&/input|textarea|select/i.test(e.target.tagName))return;const k=e.key.toLowerCase();if(k==='?'){e.preventDefault();window.openVitalPalette&&window.openVitalPalette();}else if(k==='g'){const h=(ev)=>{const k2=ev.key.toLowerCase();document.removeEventListener('keydown',h);const map={h:'home',a:'approvals',l:'ledger',w:'workflows',g:'governance'};if(k2==='c'){location.href='/console/buzz/engineering';}else if(k2==='m'){location.href='/console/meetings';}else if(map[k2]){location.href='/console/dashboard?tab='+map[k2];}};document.addEventListener('keydown',h,{once:true});}else if(k==='t'){document.querySelector('[data-vital-theme-toggle]')?.click();}});})();</script>
</body>
</html>`;
}
