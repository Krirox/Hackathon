// Compiler board — real skill cards from the OrganizationalCompiler, rendered
// from durable state only. The previous version rendered 14 invented demo
// cards ("fraud-detector 0.78"), a hardcoded sparkline for every card, and
// fabricated board metrics ("promoted 2 / 12 · 16.7%", "transfer survival
// 0.87", "median rollback 3.2h") plus invented trust-gate percentages in the
// "Why not trusted yet" panel. Honesty rules now enforced here:
//   - empty compiler → honest empty state (no demo deck fills the board)
//   - no per-card success score is claimed unless computed from real traces
//   - board metrics are computed from the cards actually listed
//   - trust gaps come from describeCardReadOnly (the same evaluator the
//     detail page uses) — never invented percentages
//
// Presentation follows the Console design system (theme.ts): the page owns a
// v-page-head frame, the board is a kanban of lifecycle columns, metrics are
// KPI cards, and the right rail explains the trust ladder. No inline palette —
// every colour is a --v-* token so light/dark themes both render correctly.

import type { AsyncDb } from '../core/db.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import type { SkillCard } from '../compiler/compiler.ts';
import { describeCardReadOnly } from '../compiler/registry.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CompilerViewOptions {
  cardId?: string;
  stateFilter?: string;
}

export interface CompilerParts {
  boardHtml: string;
  metricsHtml: string;
  rightPanelHtml: string;
}

const BOARD_COLUMNS = ['TRACE', 'CANDIDATE', 'QUARANTINE', 'SHADOW', 'PILOT', 'PROMOTED', 'DEMOTED'] as const;

function columnFor(state: string): string {
  const s = String(state);
  if (s === 'BOUNDED_PILOT' || s === 'PILOT') return 'PILOT';
  if (s === 'PROMOTED' || s === 'UNCONSTRAINED') return 'PROMOTED';
  if (s === 'QUARANTINE' || s === 'QUARANTINED') return 'QUARANTINE';
  if (s === 'SHADOW' || s === 'SHADOW_EVAL') return 'SHADOW';
  if (s === 'DEMOTED') return 'DEMOTED';
  if (s === 'TRACE') return 'TRACE';
  return 'CANDIDATE';
}

interface CardRow {
  card: SkillCard;
  col: string;
  trustGaps: string[];
  driftEwma: number | null;
  driftSamples: number | null;
}

function driftNote(row: CardRow): string {
  if (row.driftSamples !== null && row.driftSamples < 10) {
    return `<div class="v-meta" style="margin-top:5px;">insufficient samples for drift (${esc(String(row.driftSamples))})</div>`;
  }
  if (row.driftEwma !== null) {
    return `<div class="v-meta" style="margin-top:5px;">drift EWMA ${esc(row.driftEwma.toFixed(2))}</div>`;
  }
  return '';
}

/** The lifecycle ladder, rendered as the explainer rail on an empty board. */
function lifecycleRailHtml(): string {
  const steps = [
    { name: 'Quarantine', note: 'new cards land here first' },
    { name: 'Shadow → Pilot', note: 'measured against live traffic' },
    { name: 'Promoted', note: 'transfer-tested, drift-watched' },
  ];
  return `
  <div class="v-card">
    <h2 class="v-card-title">Lifecycle ladder</h2>
    <p class="v-sub" style="margin:6px 0 14px;">Every card moves through these states. The board below shows where each one actually is.</p>
    <div style="display:grid;gap:8px;">
      ${steps
        .map(
          (s, i) => `<div class="v-attention-item" style="border-left:3px solid var(--v-accent);border-radius:14px;padding:11px 13px;">
        <span class="v-badge" style="border-radius:9999px;"><span class="dot"></span>${esc(String(i + 1))}</span>
        <span><strong>${esc(s.name)}</strong><span class="v-meta" style="display:block;">${esc(s.note)}</span></span>
      </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

export async function renderCompilerParts(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  _opts: CompilerViewOptions = {},
): Promise<CompilerParts> {
  const cards = await comp.list(tenant, {}).catch(() => [] as SkillCard[]);

  if (cards.length === 0) {
    const empty = `<div class="v-empty">
  <h3>No skill cards compiled yet</h3>
  <p>Cards appear here as traces are compiled. Nothing is demo-seeded. The board fills column by column as the compiler mines repeated successful procedures.</p>
</div>`;
    return {
      boardHtml: empty,
      metricsHtml: `<div class="v-empty" style="padding:18px 20px;text-align:left;">
  <p style="margin:0;">No board metrics yet. Metrics are computed from real cards and traces.</p>
</div>`,
      rightPanelHtml: `
  <div class="v-card">
    <h2 class="v-card-title">Why not trusted yet</h2>
    <p class="v-sub" style="margin:8px 0 0;line-height:1.55;">No skill cards exist, so there are no transfer tests or drift readings to show. Cards are mined from real execution traces. Nothing here is demo-seeded. Compilation is an explicit, gated act: <a href="/console/learning/compile">compile a mined candidate</a> to create the first card. Mining alone will not fill this board.</p>
  </div>
  ${lifecycleRailHtml()}`,
    };
  }

  // Real per-card reads: trust gaps and drift from the read-only registry
  // (same recipe as evaluation — window 40, alpha 0.2, threshold 0.9, min 10
  // samples). Read-only: a dashboard GET must never run the drift monitor.
  const rows: CardRow[] = await Promise.all(
    cards.map(async (card) => {
      let trustGaps: string[];
      let driftEwma: number | null;
      let driftSamples: number | null;
      try {
        const desc = await describeCardReadOnly(db, comp, tenant, card.id);
        trustGaps = desc.trustGaps;
        driftEwma = desc.drift?.ewma ?? null;
        driftSamples = desc.drift?.samples ?? null;
      } catch {
        // Card unreadable right now: render the card with no claimed gaps.
        trustGaps = [];
        driftEwma = null;
        driftSamples = null;
      }
      return { card, col: columnFor(String(card.state)), trustGaps, driftEwma, driftSamples };
    }),
  );

  const renderCardItem = (row: CardRow) => {
    const { card } = row;
    const gapCount = row.trustGaps.length;
    const badge =
      gapCount === 0
        ? '<span class="v-badge v-badge-good" title="No open trust gaps">✔ trusted</span>'
        : `<span class="v-badge v-badge-warn" title="${esc(row.trustGaps.join('; '))}">${esc(String(gapCount))} gap${gapCount === 1 ? '' : 's'}</span>`;
    const drift = driftNote(row);
    const gaps =
      gapCount > 0
        ? `<div class="v-meta" style="color:var(--v-tint-warn-ink);margin-top:6px;">${row.trustGaps.map((g) => esc(g)).join(' · ')}</div>`
        : '';
    return `
    <div class="v-card v-card-hover" style="padding:12px 13px;margin-bottom:8px;border-radius:var(--radius-md);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">
        <div style="font-weight:600;font-size:12.5px;color:var(--v-ink);min-width:0;">${esc(card.intent)}</div>
        ${badge}
      </div>
      <div class="v-meta" style="margin-top:2px;">v${esc(String(card.version))} · ${esc(card.trustTier)} · ${esc(card.validatedAtTier)}</div>
      <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
        ${card.predicates
          .slice(0, 4)
          .map((t) => `<span class="v-tag">${esc(t)}</span>`)
          .join('')}
      </div>
      ${drift}
      ${gaps}
    </div>`;
  };

  const renderCol = (colName: string) => {
    const items = rows.filter((r) => r.col === colName);
    const subNote =
      colName === 'QUARANTINE'
        ? '<div class="v-meta" style="font-weight:normal;margin-top:1px;">imported packs enter here</div>'
        : '';
    return `
    <div class="v-board-col">
      <div class="v-board-col-head">
        <div>
          <span class="v-eyebrow">${colName}</span>
          ${subNote}
        </div>
        <span class="v-badge" style="padding:1px 8px;font-size:11px;">${items.length}</span>
      </div>
      <div>
        ${items.map(renderCardItem).join('\n')}
      </div>
    </div>`;
  };

  const boardHtml = `
  <div>
    <div class="v-board">
      ${BOARD_COLUMNS.map(renderCol).join('\n')}
    </div>
  </div>`;

  // Metrics computed from the cards actually listed — no invented constants.
  const promoted = rows.filter((r) => r.col === 'PROMOTED').length;
  const total = rows.length;
  const share = total > 0 ? (promoted / total) * 100 : null;
  const drifting = rows.filter((r) => r.driftEwma !== null && r.driftSamples !== null && r.driftSamples >= 10).length;
  const metricsHtml = `
  <div class="v-grid-3">
    <div class="v-card v-kpi-card">
      <span class="v-kpi-label">cards</span>
      <span class="v-kpi">${esc(String(total))}</span>
      <span class="v-meta">compiled from real traces</span>
    </div>
    <div class="v-card v-kpi-card">
      <span class="v-kpi-label">promoted</span>
      <span class="v-kpi" style="color:var(--v-accent);">${esc(String(promoted))}</span>
      <span class="v-meta">of ${esc(String(total))}${share !== null ? ` · ${share.toFixed(1)}% of board` : ''}</span>
    </div>
    <div class="v-card v-kpi-card">
      <span class="v-kpi-label">drift-monitored</span>
      <span class="v-kpi">${esc(String(drifting))}</span>
      <span class="v-meta">promoted cards with enough samples</span>
    </div>
  </div>`;

  // Right panel: real open trust gaps across the board, per card.
  const withGaps = rows.filter((r) => r.trustGaps.length > 0).slice(0, 6);
  const rightPanelHtml = `
  <div class="v-card">
    <h2 class="v-card-title">Why not trusted yet</h2>
    ${
      withGaps.length === 0
        ? '<p class="v-sub" style="margin:8px 0 0;">No open trust gaps on listed cards.</p>'
        : withGaps
            .map(
              (r) => `<div style="margin-top:12px;">
      <div style="font-size:13px;font-weight:600;color:var(--v-ink);">${esc(r.card.intent)}</div>
      <ul class="v-list" style="margin-top:4px;">${r.trustGaps.map((g) => `<li class="v-row" style="font-size:12px;color:var(--v-tint-warn-ink);">${esc(g)}</li>`).join('')}</ul>
    </div>`,
            )
            .join('\n')
    }
    <p class="v-meta" style="margin-top:14px;">Trust gates run through the governed transfer-test path. Promotion is never granted from this board. That path is now reachable: <a href="/console/learning/compile">compile a mined candidate</a>, then queue a transfer test from the card's page. Promotion still requires cross-model evidence, so a smoke run against a test-baseline harness will not move a card.</p>
  </div>
  ${lifecycleRailHtml()}`;

  return { boardHtml, metricsHtml, rightPanelHtml };
}

export async function renderCompilerView(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  opts: CompilerViewOptions = {},
): Promise<string> {
  const parts = await renderCompilerParts(db, comp, tenant, opts);

  return `
<style>
  /* Board chrome lives with the board: kanban columns sized to the surface,
     horizontally scrollable on narrow viewports instead of collapsing. */
  .v-board{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;}
  .v-board-col{flex:1 1 0;min-width:190px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:18px;padding:12px 12px 8px;}
  .v-board-col-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--v-line);}
</style>
<section class="compiler-view">
  <div class="v-page-head">
    <div>
      <p class="v-eyebrow">System</p>
      <h1 class="v-page-title">Compiler</h1>
      <p class="v-sub" style="margin-top:6px;">Skill card autonomous progression, shadow evaluations, and trust verification.</p>
    </div>
  </div>

  <div class="v-grid-wide" style="align-items:start;">
    <div class="v-stack">
      ${parts.boardHtml}
      ${parts.metricsHtml}
    </div>
    <div class="v-stack-sm">
      ${parts.rightPanelHtml}
    </div>
  </div>
</section>`;
}
