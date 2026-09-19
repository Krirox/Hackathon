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
    return `<div style="font-size:10px;color:#9CA3AF;margin-top:4px;">insufficient samples for drift (${esc(String(row.driftSamples))})</div>`;
  }
  if (row.driftEwma !== null) {
    return `<div style="font-size:10px;color:#6B7280;margin-top:4px;">drift EWMA ${esc(row.driftEwma.toFixed(2))}</div>`;
  }
  return '';
}

export async function renderCompilerParts(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  _opts: CompilerViewOptions = {},
): Promise<CompilerParts> {
  const cards = await comp.list(tenant, {}).catch(() => [] as SkillCard[]);

  if (cards.length === 0) {
    const empty = `<div style="border:1px dashed #D1D5DB;border-radius:8px;padding:28px;text-align:center;color:#6B7280;font-size:13px;">
No skill cards compiled yet. Cards appear here as traces are compiled — nothing is demo-seeded.</div>`;
    return {
      boardHtml: empty,
      metricsHtml: `<div style="border:1px dashed #D1D5DB;border-radius:8px;padding:14px;text-align:center;color:#6B7280;font-size:12px;">No board metrics yet — metrics are computed from real cards and traces.</div>`,
      rightPanelHtml: `
  <div>
    <h2 style="font-size:14px;font-weight:700;margin:0 0 14px 0;color:#111827;">Why not trusted yet</h2>
    <div style="font-size:12px;color:#6B7280;">No trust gates to report until cards exist.</div>
  </div>`,
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
    const badge = gapCount === 0
      ? '<span style="color:#059669;font-size:12px;font-weight:bold;" title="No open trust gaps">✔</span>'
      : `<span style="color:#D97706;font-size:11px;font-weight:bold;" title="${esc(row.trustGaps.join('; '))}">${esc(String(gapCount))} gap${gapCount === 1 ? '' : 's'}</span>`;
    const drift = driftNote(row);
    const gaps =
      gapCount > 0
        ? `<div style="font-size:10px;color:#B45309;margin-top:4px;">${row.trustGaps.map((g) => esc(g)).join(' · ')}</div>`
        : '';
    return `
    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;">
        <div style="font-weight:600;font-size:12px;color:#111827;">${esc(card.intent)}</div>
        ${badge}
      </div>
      <div style="font-size:10px;color:#6B7280;margin-top:1px;">v${esc(String(card.version))} · ${esc(card.trustTier)} · ${esc(card.validatedAtTier)}</div>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
        ${card.predicates.slice(0, 4).map((t) => `<span style="font-size:9px;background:#F3F4F6;color:#4B5563;padding:1px 5px;border-radius:4px;">${esc(t)}</span>`).join('')}
      </div>
      ${drift}
      ${gaps}
    </div>`;
  };

  const renderCol = (colName: string) => {
    const items = rows.filter((r) => r.col === colName);
    const subNote = colName === 'QUARANTINE' ? '<div style="font-size:8.5px;color:#9CA3AF;font-weight:normal;margin-top:1px;">imported packs enter here</div>' : '';
    const colBg = colName === 'QUARANTINE'
      ? 'background: repeating-linear-gradient(45deg, #F9FAFB, #F9FAFB 6px, #F3F4F6 6px, #F3F4F6 12px);'
      : 'background: #F9FAFB;';
    return `
    <div style="flex:1;min-width:130px;${colBg}border:1px solid #E5E7EB;border-radius:8px;padding:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #E5E7EB;">
        <div>
          <span style="font-weight:700;font-size:11px;letter-spacing:0.04em;color:#374151;">${colName}</span>
          ${subNote}
        </div>
        <span style="font-size:10px;color:#6B7280;background:#E5E7EB;padding:1px 5px;border-radius:10px;font-weight:600;">${items.length}</span>
      </div>
      <div>
        ${items.map(renderCardItem).join('\n')}
      </div>
    </div>`;
  };

  const boardHtml = `
  <div>
    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;">
      ${BOARD_COLUMNS.map(renderCol).join('\n')}
    </div>
  </div>`;

  // Metrics computed from the cards actually listed — no invented constants.
  const promoted = rows.filter((r) => r.col === 'PROMOTED').length;
  const total = rows.length;
  const share = total > 0 ? (promoted / total) * 100 : null;
  const drifting = rows.filter((r) => r.driftEwma !== null && r.driftSamples !== null && r.driftSamples >= 10).length;
  const metricsHtml = `
  <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;padding:14px;background:#fff;border:1px solid #E5E7EB;border-radius:10px;">
    <div>
      <div style="font-size:11px;color:#6B7280;">cards</div>
      <div style="font-size:18px;font-weight:700;color:#111827;margin-top:2px;">${esc(String(total))}</div>
    </div>
    <div>
      <div style="font-size:11px;color:#6B7280;">promoted</div>
      <div style="font-size:18px;font-weight:700;color:#0F5C57;margin-top:2px;">${esc(String(promoted))} <span style="font-size:12px;color:#6B7280;font-weight:normal;">of ${esc(String(total))}${share !== null ? ` · ${share.toFixed(1)}% of board` : ''}</span></div>
    </div>
    <div>
      <div style="font-size:11px;color:#6B7280;">drift-monitored</div>
      <div style="font-size:18px;font-weight:700;color:#111827;margin-top:2px;">${esc(String(drifting))} <span style="font-size:12px;color:#6B7280;font-weight:normal;">promoted cards with enough samples</span></div>
    </div>
  </div>`;

  // Right panel: real open trust gaps across the board, per card.
  const withGaps = rows.filter((r) => r.trustGaps.length > 0).slice(0, 6);
  const rightPanelHtml = `
  <div>
    <h2 style="font-size:14px;font-weight:700;margin:0 0 14px 0;color:#111827;">Why not trusted yet</h2>
    ${
      withGaps.length === 0
        ? '<div style="font-size:12px;color:#6B7280;">No open trust gaps on listed cards.</div>'
        : withGaps
            .map(
              (r) => `<div style="margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:#111827;">${esc(r.card.intent)}</div>
      <ul style="margin:4px 0 0 16px;padding:0;font-size:11px;color:#B45309;">${r.trustGaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
    </div>`,
            )
            .join('\n')
    }
    <div style="font-size:11px;color:#9CA3AF;margin-top:14px;">Trust gates run through the governed transfer-test path — promotion is never granted from this board.</div>
  </div>`;

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
<section class="compiler-view" style="font-family:'Inter',sans-serif;color:#111827;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
    <div>
      <h1 style="font-size:22px;font-weight:700;margin:0;color:#0A0F14;">Compiler</h1>
      <p style="font-size:12px;color:#6B7280;margin:2px 0 0 0;">Skill card autonomous progression, shadow evaluations, and trust verification.</p>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 260px;gap:16px;align-items:start;">
    <div>
      ${parts.boardHtml}
      <div style="margin-top:16px;">
        ${parts.metricsHtml}
      </div>
    </div>
    <div>
      ${parts.rightPanelHtml}
    </div>
  </div>
</section>`;
}
