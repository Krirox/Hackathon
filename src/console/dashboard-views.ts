/**
 * Role-Based & Departmental Dashboard Scope Views.
 *
 * Tailors /console/dashboard to departmental focus:
 * - Legal & Compliance (scope:legal, GDPR, audit verification, trust stops)
 * - Marketing & Growth (scope:research, scope:product, scope:business, market signals)
 * - Finance & Spend (scope:finance, dollar spend, token burn rates, billing claims)
 * - Engineering & Infra (scope:infra, scope:data, scope:core, microVM status, compiler gaps)
 * - All Departments / Overview (Executive high-level composite summary)
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
import type { RoomHealthEvaluation } from '../talk/health.ts';

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
          <p style="font-size:12.5px;color:#475569;margin:0;">Regulatory compliance, cryptographic audit trails, gate review decisions, and GDPR Article 17 privacy rights.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <a href="${esc(home)}console/data" style="font-size:12px;padding:6px 12px;background:#0F5C57;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Data &amp; GDPR Portability →</a>
          <a href="${esc(home)}console#audit" style="font-size:12px;padding:6px 12px;background:#fff;border:1px solid #CBD5E1;color:#334155;border-radius:6px;text-decoration:none;font-weight:500;">Audit Trail →</a>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#compliance Channel</div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-top:2px;">${legalRoom?.badge ?? '🟢'} ${legalRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">${legalRoom?.pendingApprovals ?? 0} gate(s) awaiting review</div>
        </div>
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#risk-monitor Channel</div>
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-top:2px;">${riskRoom?.badge ?? '🟢'} ${riskRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Active stops: ${riskRoom?.activeStops ?? 0}</div>
        </div>
        <div style="background:#fff;border:1px solid #E2E8F0;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Epistemic Contradictions</div>
          <div style="font-size:14px;font-weight:700;color:#0F7A3D;margin-top:2px;">0 Contradictions</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Canonical reality is consistent</div>
        </div>
      </div>
    </div>`;
  }

  if (activeScope === 'marketing') {
    const researchRoom = getScope('research');
    const productRoom = getScope('product');
    const bizRoom = getScope('business');
    return `<div style="background:#F0FDF4;border:1px solid #DCFCE7;border-left:4px solid #16A34A;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#14532D;margin:0 0 4px;">📈 Marketing, Growth &amp; Feedback Hub</h2>
          <p style="font-size:12.5px;color:#166534;margin:0;">Competitive market intelligence, user sentiment observations, customer feedback synthesis, and business expansion metrics.</p>
        </div>
        <a href="${esc(home)}console/buzz/market-intel" style="font-size:12px;padding:6px 12px;background:#16A34A;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open #market-intel →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #DCFCE7;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#market-intel</div>
          <div style="font-size:14px;font-weight:700;color:#14532D;margin-top:2px;">${researchRoom?.badge ?? '🟢'} ${researchRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">DeepResearch runs active</div>
        </div>
        <div style="background:#fff;border:1px solid #DCFCE7;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#user-feedback</div>
          <div style="font-size:14px;font-weight:700;color:#14532D;margin-top:2px;">${productRoom?.badge ?? '🟢'} ${productRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Feedback ingestion live</div>
        </div>
        <div style="background:#fff;border:1px solid #DCFCE7;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#growth</div>
          <div style="font-size:14px;font-weight:700;color:#14532D;margin-top:2px;">${bizRoom?.badge ?? '🟢'} ${bizRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Autonomous experiments</div>
        </div>
      </div>
    </div>`;
  }

  if (activeScope === 'finance') {
    const finRoom = getScope('finance');
    return `<div style="background:#FEFCE8;border:1px solid #FEF08A;border-left:4px solid #CA8A04;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#713F12;margin:0 0 4px;">💳 Financial Operations &amp; Budget Ledger</h2>
          <p style="font-size:12.5px;color:#854D0E;margin:0;">Attention accounting, daily spend caps, token consumption per hour, billing statement reconciliations, and financial gate reviews.</p>
        </div>
        <a href="${esc(home)}console/buzz/finance" style="font-size:12px;padding:6px 12px;background:#CA8A04;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open #finance →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Spend Today</div>
          <div style="font-size:16px;font-weight:700;color:#713F12;margin-top:2px;">$${finRoom?.spendDollars ?? 0} / $${finRoom?.spendCeilingDollars ?? 1500}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Ceiling utilization: ${finRoom?.budgetPercentage ?? 0}%</div>
        </div>
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Token Burn Rate</div>
          <div style="font-size:16px;font-weight:700;color:#713F12;margin-top:2px;">${((finRoom?.spendTokens ?? 0) / 1000).toFixed(0)}k tokens/hr</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Budget gate: &lt; 500k/hr</div>
        </div>
        <div style="background:#fff;border:1px solid #FEF08A;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">Cost-Per-Signal</div>
          <div style="font-size:16px;font-weight:700;color:#0F7A3D;margin-top:2px;">$0.0034 / signal</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Target gate: &lt; $0.0050</div>
        </div>
      </div>
    </div>`;
  }

  if (activeScope === 'engineering') {
    const opsRoom = getScope('infra');
    const dataRoom = getScope('data');
    const coreRoom = getScope('core');
    return `<div style="background:#EFF6FF;border:1px solid #DBEAFE;border-left:4px solid #2563EB;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:#1E3A8A;margin:0 0 4px;">⚙️ Engineering &amp; Infrastructure Command</h2>
          <p style="font-size:12.5px;color:#1E40AF;margin:0;">Isolated team microVM sandboxes, Organizational Compiler gaps, GitHub Releases ingestion pipelines, and substrate health.</p>
        </div>
        <a href="${esc(home)}console/buzz/ops" style="font-size:12px;padding:6px 12px;background:#2563EB;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open #ops →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;">
        <div style="background:#fff;border:1px solid #DBEAFE;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#ops · MicroVM Status</div>
          <div style="font-size:14px;font-weight:700;color:#1E3A8A;margin-top:2px;">${opsRoom?.badge ?? '🟢'} ${opsRoom?.status ?? 'guarded'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">team-infra VM ready</div>
        </div>
        <div style="background:#fff;border:1px solid #DBEAFE;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#data-pipeline</div>
          <div style="font-size:14px;font-weight:700;color:#1E3A8A;margin-top:2px;">${dataRoom?.badge ?? '🟢'} ${dataRoom?.status ?? 'healthy'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">GitHub ingestion synced</div>
        </div>
        <div style="background:#fff;border:1px solid #DBEAFE;padding:12px;border-radius:6px;">
          <div style="font-size:11px;color:#64748B;font-weight:600;text-transform:uppercase;">#reality-core</div>
          <div style="font-size:14px;font-weight:700;color:#1E3A8A;margin-top:2px;">${coreRoom?.badge ?? '🟢'} ${coreRoom?.status ?? 'guarded'}</div>
          <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Nostr cryptographic keys active</div>
        </div>
      </div>
    </div>`;
  }

  return '';
}
