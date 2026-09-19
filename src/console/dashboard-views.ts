/**
 * Role-Based & Departmental Dashboard Scope Views.
 *
 * Tailors /console/dashboard to departmental focus:
 * - Legal & Compliance (scope:legal, GDPR, audit verification, trust stops)
 * - Marketing & Growth (scope:research, scope:product, scope:business)
 * - Finance & Spend (scope:finance, real spend rollups)
 * - Engineering & Infra (scope:infra, scope:data, scope:core)
 * - All Departments / Overview (Executive high-level composite summary)
 *
 * Honesty rule: every tile renders values from the RoomHealthEvaluation
 * rollups, or an explicit "no room data" state. The earlier version of this
 * file hardcoded "$0.0034 / signal", invented ceilings, fake "VM ready /
 * keys active" claims, and 🟢-healthy defaults for rooms that do not exist —
 * exactly the fabrication the anti-fabrication guard exists to prevent.
 */

import type { RoomHealthEvaluation } from '../talk/health.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type DashboardDepartment = 'all' | 'legal' | 'marketing' | 'finance' | 'engineering';

export interface DepartmentalSummaryOptions {
  activeScope: DashboardDepartment;
  home: string;
  userRole: string;
  evaluations: RoomHealthEvaluation[];
}

export function renderDepartmentTabs(activeScope: DashboardDepartment, home: string): string {
  const tabs: Array<{ id: DashboardDepartment; label: string; icon: string }> = [
    { id: 'all', label: 'All Departments (Overview)', icon: '🏢' },
    { id: 'legal', label: 'Legal & Compliance', icon: '⚖️' },
    { id: 'marketing', label: 'Marketing & Growth', icon: '📈' },
    { id: 'finance', label: 'Finance & Spend', icon: '💳' },
    { id: 'engineering', label: 'Engineering & Infra', icon: '⚙️' },
  ];

  const tabHtml = tabs
    .map((t) => {
      const isSelected = activeScope === t.id;
      const activeStyle = isSelected
        ? 'background:#0F5C57;color:#fff;border-color:#0F5C57;font-weight:600;'
        : 'background:#fff;color:#374151;border-color:#E5E7EB;';
      const url = t.id === 'all' ? `${home}console/dashboard` : `${home}console/dashboard?scope=${t.id}`;
      return `<a href="${esc(url)}" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;border:1px solid;font-size:12.5px;text-decoration:none;transition:all .15s;${activeStyle}">
        <span>${t.icon}</span>
        <span>${esc(t.label)}</span>
      </a>`;
    })
    .join('');

  return `<nav aria-label="Department Views" style="display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 20px;">
    ${tabHtml}
  </nav>`;
}

/** Real status cell: never a fabricated 🟢 for a room with no evaluation. */
function statusOf(room: RoomHealthEvaluation | undefined): string {
  return room ? `${room.badge} ${esc(room.status)}` : '⚪ no room data';
}

/** Real ceiling display: an unset (0) ceiling says so instead of inventing one. */
function ceilingOf(room: RoomHealthEvaluation | undefined, kind: 'dollars' | 'tokens'): string {
  if (!room) return '—';
  const v = kind === 'dollars' ? room.spendCeilingDollars : room.spendCeilingTokens;
  return v > 0 ? v.toLocaleString() : 'unset';
}

export function renderDepartmentBanner(opts: DepartmentalSummaryOptions): string {
  const { activeScope, home, evaluations } = opts;
  if (activeScope === 'all') return '';

  const getScope = (s: string) => evaluations.find((e) => e.scope === s);

  if (activeScope === 'legal') {
    const legalRoom = getScope('legal');
    const riskRoom = getScope('risk');
    return `<div style="background:#F8FAFC;border:1px solid #E2E8F0;border-left:4px solid #0F5C57;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#0F172A;margin:0 0 4px;">⚖️ Legal &amp; Compliance Portal</h2>
          <p style="font-size:12.5px;color:#475569;margin:0;">Regulatory compliance posture, gate review decisions, and GDPR Article 17 privacy rights.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <a href="${esc(home)}console/data" style="font-size:12px;padding:6px 12px;background:#0F5C57;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Data &amp; GDPR Portability →</a>
          <a href="${esc(home)}console/audit" style="font-size:12px;padding:6px 12px;background:#fff;border:1px solid #CBD5E1;color:#334155;border-radius:6px;text-decoration:none;font-weight:500;">Audit Trail →</a>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#compliance room</div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-top:2px;">${statusOf(legalRoom)}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${legalRoom ? `${legalRoom.pendingApprovals} gate(s) awaiting review` : 'no evaluation for this scope'}</div>
        </div>
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#risk-monitor room</div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-top:2px;">${statusOf(riskRoom)}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${riskRoom ? `Active stops: ${riskRoom.activeStops}` : 'no evaluation for this scope'}</div>
        </div>
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Open contradictions</div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-top:2px;">${legalRoom ? `${legalRoom.contradictions} open` : '—'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">from the room-health rollup (ledger contradiction pairs)</div>
        </div>
      </div>
    </div>`;
  }

  if (activeScope === 'marketing') {
    const researchRoom = getScope('research');
    const productRoom = getScope('product');
    const bizRoom = getScope('business');
    const tile = (room: RoomHealthEvaluation | undefined, scope: string) => `
        <div style="background:#fff;border:1px solid #DCFCE7;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#${esc(scope)}</div>
          <div style="font-size:14px;font-weight:700;color:#14532D;margin-top:2px;">${statusOf(room)}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${room ? `${room.pendingApprovals} pending · ${room.activeStops} stops` : 'no evaluation for this scope'}</div>
        </div>`;
    return `<div style="background:#F0FDF4;border:1px solid #DCFCE7;border-left:4px solid #16A34A;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#14532D;margin:0 0 4px;">📈 Marketing, Growth &amp; Feedback Hub</h2>
          <p style="font-size:12.5px;color:#166534;margin:0;">Research ingestion, product feedback evidence, and business expansion signals.</p>
        </div>
        <a href="${esc(home)}console/rooms" style="font-size:12px;padding:6px 12px;background:#16A34A;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Browse rooms →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        ${tile(researchRoom, 'research')}
        ${tile(productRoom, 'product')}
        ${tile(bizRoom, 'business')}
      </div>
    </div>`;
  }

  if (activeScope === 'finance') {
    const finRoom = getScope('finance');
    return `<div style="background:#FEFCE8;border:1px solid #FEF08A;border-left:4px solid #CA8A04;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#713F12;margin:0 0 4px;">💳 Financial Operations &amp; Budget Ledger</h2>
          <p style="font-size:12.5px;color:#854D0E;margin:0;">Attention accounting, daily spend caps, and financial gate reviews — figures below are live rollups.</p>
        </div>
        <a href="${esc(home)}console/buzz/finance" style="font-size:12px;padding:6px 12px;background:#CA8A04;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open #finance →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Spend (all time)</div>
          <div style="font-size:16px;font-weight:700;color:#713F12;margin-top:2px;">$${finRoom ? finRoom.spendDollars.toFixed(2) : '—'} / $${ceilingOf(finRoom, 'dollars')}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${finRoom ? `Ceiling utilization: ${finRoom.budgetPercentage}%` : 'no evaluation for this scope'}</div>
        </div>
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Tokens spent · Token Burn Rate</div>
          <div style="font-size:16px;font-weight:700;color:#713F12;margin-top:2px;">${finRoom ? finRoom.spendTokens.toLocaleString() : '—'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">ceiling ${ceilingOf(finRoom, 'tokens')}</div>
        </div>
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Pending review gates</div>
          <div style="font-size:16px;font-weight:700;color:#713F12;margin-top:2px;">${finRoom ? finRoom.pendingApprovals : '—'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">cost-per-signal is not shown here — it requires measured routing outcomes</div>
        </div>
      </div>
    </div>`;
  }

  if (activeScope === 'engineering') {
    const opsRoom = getScope('infra');
    const dataRoom = getScope('data');
    const coreRoom = getScope('core');
    const tile = (room: RoomHealthEvaluation | undefined, scope: string, label: string) => `
        <div style="background:#fff;border:1px solid #DBEAFE;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">${esc(label)}</div>
          <div style="font-size:14px;font-weight:700;color:#1E3A8A;margin-top:2px;">${statusOf(room)}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${room ? `${room.driftingCards} drifting card(s) · ${room.pendingApprovals} pending` : 'no evaluation for this scope'}</div>
        </div>`;
    return `<div style="background:#EFF6FF;border:1px solid #DBEAFE;border-left:4px solid #2563EB;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#1E3A8A;margin:0 0 4px;">⚙️ Engineering &amp; Infrastructure Command</h2>
          <p style="font-size:12.5px;color:#1E40AF;margin:0;">Workspace isolation, Organizational Compiler drift, ingestion pipelines, and substrate health — figures below are live rollups.</p>
        </div>
        <a href="${esc(home)}console/buzz/infra" style="font-size:12px;padding:6px 12px;background:#2563EB;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open #infra →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        ${tile(opsRoom, 'infra', '#infra')}
        ${tile(dataRoom, 'data', '#data')}
        ${tile(coreRoom, 'core', '#reality-core')}
      </div>
    </div>`;
  }

  return '';
}
