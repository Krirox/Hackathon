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
 * rollups, or an explicit "no room data" state. Nothing is invented.
 * Visual voice: design.md Workbench + brief §13 filter pills.
 */

import type { RoomHealthEvaluation } from '../talk/health.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type DashboardDepartment = 'all' | 'legal' | 'marketing' | 'finance' | 'engineering';

export interface DepartmentalSummaryOptions {
  activeScope: DashboardDepartment;
  userRole: string;
  evaluations: RoomHealthEvaluation[];
}

// No `home` parameter: every tab points at `/console/dashboard`, which the
// server serves with the same handler as the console root (see the dashboard
// branch in serve.ts). A second address argument that no branch reads is a
// promise the signature cannot keep.
export function renderDepartmentTabs(activeScope: DashboardDepartment): string {
  const tabs: Array<{ id: DashboardDepartment; label: string }> = [
    { id: 'all', label: 'All Departments' },
    { id: 'legal', label: 'Legal & Compliance' },
    { id: 'marketing', label: 'Marketing & Growth' },
    { id: 'finance', label: 'Finance & Spend' },
    { id: 'engineering', label: 'Engineering & Infra' },
  ];

  const tabHtml = tabs
    .map((t) => {
      const isSelected = activeScope === t.id;
      const activeStyle = isSelected
        ? 'background:var(--v-ink);color:var(--v-bg-1);border-color:var(--v-ink);font-weight:600;'
        : 'background:var(--v-bg-1);color:var(--v-ink-2);border-color:var(--v-line-strong);';
      const url = t.id === 'all' ? `/console/dashboard` : `/console/dashboard?scope=${t.id}`;
      const aria = isSelected ? ' aria-current="true"' : '';
      return `<a href="${esc(url)}"${aria} style="display:inline-flex;align-items:center;padding:7px 14px;border-radius:999px;border:1px solid;font-size:12.5px;text-decoration:none;transition:all .15s var(--ease-out);white-space:nowrap;${activeStyle}">
        <span>${esc(t.label)}</span>
      </a>`;
    })
    .join('');

  return `<nav aria-label="Department Views" style="display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 16px;">
    ${tabHtml}
  </nav>`;
}

/** Real status cell: never a fabricated healthy default for missing rooms. */
function statusOf(room: RoomHealthEvaluation | undefined): string {
  if (!room)
    return '<span class="v-badge"><span class="dot" style="background:var(--v-faint);"></span>no room data</span>';
  let tone = 'v-badge-warn';
  if (room.status === 'healthy' || room.badge.includes('🟢')) tone = 'v-badge-good';
  else if (room.status === 'halted' || room.badge.includes('🔴')) tone = 'v-badge-risk';
  return `<span class="v-badge ${tone}">${esc(room.badge)} ${esc(room.status)}</span>`;
}

/** Real ceiling display: an unset (0) ceiling says so instead of inventing one. */
function ceilingOf(room: RoomHealthEvaluation | undefined, kind: 'dollars' | 'tokens'): string {
  if (!room) return '—';
  const v = kind === 'dollars' ? room.spendCeilingDollars : room.spendCeilingTokens;
  return v > 0 ? v.toLocaleString() : 'unset';
}

function bannerShell(opts: {
  tintBg: string;
  tintInk: string;
  bar: string;
  title: string;
  sub: string;
  actions: string;
  tiles: string;
}): string {
  return `<div class="v-card" style="border-left:3px solid ${opts.bar};padding:18px 20px;margin-bottom:18px;background:${opts.tintBg};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
        <div style="min-width:0;">
          <h2 class="v-card-title" style="color:${opts.tintInk};">${opts.title}</h2>
          <p class="v-sub" style="font-size:12.5px;margin:3px 0 0;">${opts.sub}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${opts.actions}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:14px;">
        ${opts.tiles}
      </div>
    </div>`;
}

function tile(label: string, value: string, sub: string): string {
  return `<div style="background:var(--v-bg-1);border:1px solid var(--v-line);padding:12px 14px;border-radius:12px;min-width:0;">
          <div class="v-eyebrow">${esc(label)}</div>
          <div style="font-size:15px;font-weight:700;color:var(--v-ink);margin-top:3px;overflow-wrap:anywhere;">${value}</div>
          <div class="v-meta" style="margin-top:2px;">${sub}</div>
        </div>`;
}

function actionBtn(href: string, label: string, primary: boolean): string {
  return `<a href="${esc(href)}" class="v-btn ${primary ? 'v-btn-primary' : 'v-btn-secondary'}" style="min-height:34px;padding:7px 14px;font-size:12px;">${esc(label)}</a>`;
}

export function renderDepartmentBanner(opts: DepartmentalSummaryOptions): string {
  const { activeScope, evaluations } = opts;
  if (activeScope === 'all') return '';

  const getScope = (s: string) => evaluations.find((e) => e.scope === s);

  if (activeScope === 'legal') {
    const legalRoom = getScope('legal');
    const riskRoom = getScope('risk');
    return bannerShell({
      tintBg: 'var(--v-tint-info-bg)',
      tintInk: 'var(--v-tint-info-ink)',
      bar: 'var(--v-pred)',
      title: 'Legal &amp; Compliance Portal',
      sub: 'Regulatory compliance posture, gate review decisions, and GDPR Article 17 privacy rights.',
      actions: `${actionBtn(`/console/data`, 'Data & GDPR Portability →', true)}${actionBtn(`/console/audit`, 'Audit Trail →', false)}`,
      tiles: `${tile('#compliance room', statusOf(legalRoom), legalRoom ? `${legalRoom.pendingApprovals} gate(s) awaiting review` : 'no evaluation for this scope')}${tile('#risk-monitor room', statusOf(riskRoom), riskRoom ? `Active stops: ${riskRoom.activeStops}` : 'no evaluation for this scope')}${tile('Open contradictions', legalRoom ? `${legalRoom.contradictions} open` : '—', 'from the room-health rollup (ledger contradiction pairs)')}`,
    });
  }

  if (activeScope === 'marketing') {
    const researchRoom = getScope('research');
    const productRoom = getScope('product');
    const bizRoom = getScope('business');
    const roomTile = (room: RoomHealthEvaluation | undefined, scope: string) =>
      tile(
        `#${scope}`,
        statusOf(room),
        room ? `${room.pendingApprovals} pending · ${room.activeStops} stops` : 'no evaluation for this scope',
      );
    return bannerShell({
      tintBg: 'var(--v-tint-good-bg)',
      tintInk: 'var(--v-tint-good-ink)',
      bar: 'var(--v-fact)',
      title: 'Marketing, Growth &amp; Feedback Hub',
      sub: 'Research ingestion, product feedback evidence, and business expansion signals.',
      actions: actionBtn(`/console/rooms`, 'Browse rooms →', true),
      tiles: `${roomTile(researchRoom, 'research')}${roomTile(productRoom, 'product')}${roomTile(bizRoom, 'business')}`,
    });
  }

  if (activeScope === 'finance') {
    const finRoom = getScope('finance');
    return bannerShell({
      tintBg: 'var(--v-tint-warn-bg)',
      tintInk: 'var(--v-tint-warn-ink)',
      bar: 'var(--v-hypo)',
      title: 'Financial Operations &amp; Budget Ledger',
      sub: 'Attention accounting, daily spend caps, and financial gate reviews — figures below are live rollups.',
      actions: actionBtn(`/console/buzz/finance`, 'Open #finance →', true),
      tiles: `${tile('Spend (all time)', finRoom ? `$${finRoom.spendDollars.toFixed(2)} / $${ceilingOf(finRoom, 'dollars')}` : '—', finRoom ? `Ceiling utilization: ${finRoom.budgetPercentage}%` : 'no evaluation for this scope')}${tile('Tokens spent · Token Burn Rate', finRoom ? finRoom.spendTokens.toLocaleString() : '—', `ceiling ${ceilingOf(finRoom, 'tokens')}`)}${tile('Pending review gates', finRoom ? String(finRoom.pendingApprovals) : '—', 'cost-per-signal needs measured routing outcomes')}`,
    });
  }

  if (activeScope === 'engineering') {
    const opsRoom = getScope('infra');
    const dataRoom = getScope('data');
    const coreRoom = getScope('core');
    const roomTile = (room: RoomHealthEvaluation | undefined, label: string) =>
      tile(
        label,
        statusOf(room),
        room
          ? `${room.driftingCards} drifting card(s) · ${room.pendingApprovals} pending`
          : 'no evaluation for this scope',
      );
    return bannerShell({
      tintBg: 'var(--v-tint-info-bg)',
      tintInk: 'var(--v-tint-info-ink)',
      bar: 'var(--v-accent)',
      title: 'Engineering &amp; Infrastructure Command',
      sub: 'Workspace isolation, Organizational Compiler drift, ingestion pipelines, and substrate health — figures below are live rollups.',
      actions: actionBtn(`/console/buzz/infra`, 'Open #infra →', true),
      tiles: `${roomTile(opsRoom, '#infra')}${roomTile(dataRoom, '#data')}${roomTile(coreRoom, '#reality-core')}`,
    });
  }

  return '';
}
