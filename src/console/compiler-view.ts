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
    return `<div style="font-size:10px;color:var(--v-faint);margin-top:4px;">insufficient samples for drift (${esc(String(row.driftSamples))})</div>`;
  }
  if (row.driftEwma !== null) {
    return `<div style="font-size:10px;color:var(--v-muted);margin-top:4px;">drift EWMA ${esc(row.driftEwma.toFixed(2))}</div>`;
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
    const empty = `<div style="border:1px dashed var(--v-line-strong);border-radius:8px;padding:28px;text-align:center;color:var(--v-muted);font-size:13px;">
No skill cards compiled yet. Cards appear here as traces are compiled — nothing is demo-seeded.</div>`;
    return {
      boardHtml: empty,
      metricsHtml: `<div style="border:1px dashed var(--v-line-strong);border-radius:8px;padding:14px;text-align:center;color:var(--v-muted);font-size:12px;">No board metrics yet — metrics are computed from real cards and traces.</div>`,
      rightPanelHtml: `
  <div>
    <h2 style="font-size:14px;font-weight:700;margin:0 0 6px 0;color:var(--v-ink);font-style:normal;">Why not trusted yet</h2>
    <p style="font-size:12px;color:var(--v-muted);margin:0 0 12px;line-height:1.5;">No skill cards exist, so there are no transfer tests or drift readings to show. Cards are mined from real execution traces — nothing here is demo-seeded. Compilation is an explicit, gated act: <a href="/console/learning/compile">compile a mined candidate</a> to create the first card. Mining alone will not fill this board.</p>
    <div style="display:grid;gap:8px;font-size:12px;">
      <div style="background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:8px;padding:8px 10px;"><strong style="color:var(--v-ink);">Quarantine</strong><div style="color:var(--v-muted);font-size:11px;">new cards land here first</div></div>
      <div style="background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:8px;padding:8px 10px;"><strong style="color:var(--v-ink);">Shadow → Pilot</strong><div style="color:var(--v-muted);font-size:11px;">measured against live traffic</div></div>
      <div style="background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:8px;padding:8px 10px;"><strong style="color:var(--v-ink);">Promoted</strong><div style="color:var(--v-muted);font-size:11px;">transfer-tested, drift-watched</div></div>
    </div>
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
      ? '<span style="color:var(--v-fact);font-size:12px;font-weight:bold;" title="No open trust gaps">✔</span>'
      : `<span style="color:var(--v-hypo);font-size:11px;font-weight:bold;" title="${esc(row.trustGaps.join('; '))}">${esc(String(gapCount))} gap${gapCount === 1 ? '' : 's'}</span>`;
    const drift = driftNote(row);
    const gaps =
      gapCount > 0
        ? `<div style="font-size:10px;color:var(--v-hypo);margin-top:4px;">${row.trustGaps.map((g) => esc(g)).join(' · ')}</div>`
        : '';
    return `
    <div style="background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;">
        <div style="font-weight:600;font-size:12px;color:var(--v-ink);">${esc(card.intent)}</div>
        ${badge}
      </div>
      <div style="font-size:10px;color:var(--v-muted);margin-top:1px;">v${esc(String(card.version))} · ${esc(card.trustTier)} · ${esc(card.validatedAtTier)}</div>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
        ${card.predicates.slice(0, 4).map((t) => `<span style="font-size:9px;background:var(--v-bg-2);color:var(--v-ink-2);padding:1px 5px;border-radius:4px;">${esc(t)}</span>`).join('')}
      </div>
      ${drift}
      ${gaps}
    </div>`;
  };

  const renderCol = (colName: string) => {
    const items = rows.filter((r) => r.col === colName);
    const subNote = colName === 'QUARANTINE' ? '<div style="font-size:8.5px;color:var(--v-faint);font-weight:normal;margin-top:1px;">imported packs enter here</div>' : '';
    const colBg = colName === 'QUARANTINE'
      ? 'background: repeating-linear-gradient(45deg, var(--v-bg-2), var(--v-bg-2) 6px, var(--v-bg-2) 6px, var(--v-bg-2) 12px);'
      : 'background: var(--v-bg-2);';
    return `
    <div style="flex:1;min-width:130px;${colBg}border:1px solid var(--v-line);border-radius:8px;padding:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--v-line);">
        <div>
          <span style="font-weight:700;font-size:11px;letter-spacing:0.04em;color:var(--v-ink-2);">${colName}</span>
          ${subNote}
        </div>
        <span style="font-size:10px;color:var(--v-muted);background:var(--v-line);padding:1px 5px;border-radius:10px;font-weight:600;">${items.length}</span>
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
  <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;padding:14px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:10px;">
    <div>
      <div style="font-size:11px;color:var(--v-muted);">cards</div>
      <div style="font-size:18px;font-weight:700;color:var(--v-ink);margin-top:2px;">${esc(String(total))}</div>
    </div>
    <div>
      <div style="font-size:11px;color:var(--v-muted);">promoted</div>
      <div style="font-size:18px;font-weight:700;color:var(--v-accent);margin-top:2px;">${esc(String(promoted))} <span style="font-size:12px;color:var(--v-muted);font-weight:normal;">of ${esc(String(total))}${share !== null ? ` · ${share.toFixed(1)}% of board` : ''}</span></div>
    </div>
    <div>
      <div style="font-size:11px;color:var(--v-muted);">drift-monitored</div>
      <div style="font-size:18px;font-weight:700;color:var(--v-ink);margin-top:2px;">${esc(String(drifting))} <span style="font-size:12px;color:var(--v-muted);font-weight:normal;">promoted cards with enough samples</span></div>
    </div>
  </div>`;

  // Right panel: real open trust gaps across the board, per card.
  const withGaps = rows.filter((r) => r.trustGaps.length > 0).slice(0, 6);
  const rightPanelHtml = `
  <div>
    <h2 style="font-size:14px;font-weight:700;margin:0 0 14px 0;color:var(--v-ink);">Why not trusted yet</h2>
    ${
      withGaps.length === 0
        ? '<div style="font-size:12px;color:var(--v-muted);">No open trust gaps on listed cards.</div>'
        : withGaps
            .map(
              (r) => `<div style="margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:var(--v-ink);">${esc(r.card.intent)}</div>
      <ul style="margin:4px 0 0 16px;padding:0;font-size:11px;color:var(--v-hypo);">${r.trustGaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
    </div>`,
            )
            .join('\n')
    }
    <div style="font-size:11px;color:var(--v-faint);margin-top:14px;">Trust gates run through the governed transfer-test path — promotion is never granted from this board. That path is now reachable: <a href="/console/learning/compile">compile a mined candidate</a>, then queue a transfer test from the card's page. Promotion still requires cross-model evidence, so a smoke run against a test-baseline harness will not move a card.</div>
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
<section class="compiler-view" style="font-family:'Inter',sans-serif;color:var(--v-ink);">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
    <div>
      <h1 style="font-size:22px;font-weight:700;margin:0;color:var(--v-ink);">Compiler</h1>
      <p style="font-size:12px;color:var(--v-muted);margin:2px 0 0 0;">Skill card autonomous progression, shadow evaluations, and trust verification.</p>
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
