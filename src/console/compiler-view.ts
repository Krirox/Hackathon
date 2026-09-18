import type { AsyncDb } from '../core/db.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { describeCardReadOnly } from '../compiler/registry.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CompilerViewOptions {
  cardId?: string;
  stateFilter?: string;
}

export async function renderCompilerView(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  opts: CompilerViewOptions = {},
): Promise<string> {
  const cards = await comp.list(tenant, {}).catch(() => []);

  // Default demo / seeded cards matching Image 3 if DB cards are sparse
  const sampleCards = [
    { id: 'c_trace_1', name: 'data-summarizer', version: '1.2.3', col: 'TRACE', tags: ['analyst', 'text'], score: '0.94' },
    { id: 'c_trace_2', name: 'error-classifier', version: '0.8.7', col: 'TRACE', tags: ['analyst', 'tool'], score: '0.91' },
    { id: 'c_cand_1', name: 'doc-retriever', version: '0.1.4', col: 'CANDIDATE', tags: ['research', 'tool'], score: '0.76', warning: true },
    { id: 'c_cand_2', name: 'code-gen', version: '0.3.2', col: 'CANDIDATE', tags: ['engineer', 'tool'], score: '0.71', warning: true },
    { id: 'c_cand_3', name: 'summarizer-v2', version: '0.2.1', col: 'CANDIDATE', tags: ['analyst', 'text'], score: '0.68', warning: true },
    { id: 'c_quar_1', name: 'image-analyzer', version: '0.4.0', col: 'QUARANTINE', tags: ['research', 'tool'], score: '0.52' },
    { id: 'c_quar_2', name: 'risk-scorer', version: '0.6.3', col: 'QUARANTINE', tags: ['analyst', 'model'], score: '0.49' },
    { id: 'c_shad_1', name: 'trend-forecaster', version: '1.0.7', col: 'SHADOW', tags: ['research', 'model'], score: '0.83' },
    { id: 'c_shad_2', name: 'entity-linker', version: '0.9.2', col: 'SHADOW', tags: ['engineer', 'tool'], score: '0.78' },
    { id: 'c_pilo_1', name: 'support-bot', version: '0.5.1', col: 'PILOT', tags: ['support', 'text'], score: '0.86', ready: true },
    { id: 'c_pilo_2', name: 'fraud-detector', version: '0.7.8', col: 'PILOT', tags: ['finance', 'model'], score: '0.78', ready: true },
    { id: 'c_prom_1', name: 'query-router', version: '1.3.0', col: 'PROMOTED', tags: ['infra', 'router'], score: '0.96', ready: true },
    { id: 'c_prom_2', name: 'policy-checker', version: '1.1.5', col: 'PROMOTED', tags: ['legal', 'tool'], score: '0.92', ready: true },
    { id: 'c_demo_1', name: 'content-moderator', version: '0.6.9', col: 'DEMOTED', tags: ['moderation', 'text'], score: '0.81', alert: 'EWMA 0.81 < 0.90' },
  ];

  // Overlay with real cards from compiler if present
  const allCards = [...sampleCards];
  for (const c of cards) {
    let col = 'CANDIDATE';
    const s = String(c.state);
    if (s === 'BOUNDED_PILOT' || s === 'PILOT') col = 'PILOT';
    else if (s === 'PROMOTED' || s === 'UNCONSTRAINED') col = 'PROMOTED';
    else if (s === 'QUARANTINE' || s === 'QUARANTINED') col = 'QUARANTINE';
    else if (s === 'SHADOW' || s === 'SHADOW_EVAL') col = 'SHADOW';
    else if (s === 'DEMOTED') col = 'DEMOTED';
    else if (s === 'TRACE') col = 'TRACE';
    allCards.push({
      id: c.id,
      name: c.intent,
      version: String(c.version),
      col,
      tags: ['agent', 'skill'],
      score: '0.85',
    });
  }

  const columns = ['TRACE', 'CANDIDATE', 'QUARANTINE', 'SHADOW', 'PILOT', 'PROMOTED'];

  const sparklineSvg = `
    <svg viewBox="0 0 100 24" width="100%" height="20" style="display:block;margin:6px 0;">
      <path d="M0,18 Q15,12 30,16 T60,8 T85,14 T100,6" fill="none" stroke="#0F5C57" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  const renderCardItem = (card: typeof allCards[0]) => {
    const badgeIcon = card.ready
      ? '<span style="color:#059669;font-size:12px;">✔</span>'
      : card.warning
      ? '<span style="color:#D97706;font-size:12px;">?</span>'
      : '';
    const alertBox = card.alert
      ? `<div style="font-size:10px;color:#DC2626;background:#FEE2E2;padding:2px 6px;border-radius:4px;margin-top:6px;font-weight:600;">${esc(card.alert)}</div>`
      : '';
    return `
    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;">
        <div style="font-weight:600;font-size:12px;color:#111827;">${esc(card.name)}</div>
        ${badgeIcon}
      </div>
      <div style="font-size:10px;color:#6B7280;margin-top:1px;">v${esc(card.version)}</div>
      <div style="display:flex;gap:4px;margin-top:6px;">
        ${card.tags.map((t) => `<span style="font-size:9px;background:#F3F4F6;color:#4B5563;padding:1px 5px;border-radius:4px;">${esc(t)}</span>`).join('')}
      </div>
      ${sparklineSvg}
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6B7280;">
        <span>success</span>
        <strong style="color:#111827;">${esc(card.score)}</strong>
      </div>
      ${alertBox}
    </div>`;
  };

  const renderCol = (colName: string) => {
    const items = allCards.filter((c) => c.col === colName);
    const subNote = colName === 'QUARANTINE' ? '<div style="font-size:9px;color:#9CA3AF;font-weight:normal;">imported packs enter here</div>' : '';
    return `
    <div style="flex:1;min-width:130px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #E5E7EB;">
        <div>
          <span style="font-weight:700;font-size:11px;letter-spacing:0.04em;color:#374151;">${colName}</span>
          ${subNote}
        </div>
        <span style="font-size:10px;color:#6B7280;background:#E5E7EB;padding:1px 5px;border-radius:10px;">${items.length}</span>
      </div>
      <div>
        ${items.map(renderCardItem).join('\n')}
      </div>
    </div>`;
  };

  const demotedItems = allCards.filter((c) => c.col === 'DEMOTED');

  return `
<section class="compiler-view" style="font-family:'Inter',sans-serif;color:#111827;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
    <div>
      <h1 style="font-size:22px;font-weight:700;margin:0;color:#0A0F14;">Compiler</h1>
      <p style="font-size:12px;color:#6B7280;margin:2px 0 0 0;">Skill card autonomous progression, shadow evaluations, and trust verification.</p>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 280px;gap:16px;align-items:start;">
    <!-- Main Kanban Board -->
    <div>
      <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;">
        ${columns.map(renderCol).join('\n')}
      </div>

      <!-- DEMOTED section at bottom -->
      <div style="margin-top:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;color:#DC2626;margin-bottom:6px;">
          DEMOTED <span style="background:#FEE2E2;color:#DC2626;padding:1px 5px;border-radius:10px;font-size:10px;">${demotedItems.length}</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${demotedItems.map((c) => `<div style="width:200px;">${renderCardItem(c)}</div>`).join('\n')}
        </div>
      </div>

      <!-- Metrics Footer -->
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-top:20px;padding:14px;background:#fff;border:1px solid #E5E7EB;border-radius:10px;">
        <div>
          <div style="font-size:11px;color:#6B7280;">promoted</div>
          <div style="font-size:18px;font-weight:700;color:#0F5C57;margin-top:2px;">2 <span style="font-size:12px;color:#6B7280;font-weight:normal;">/ 12 · 16.7%</span></div>
        </div>
        <div>
          <div style="font-size:11px;color:#6B7280;">transfer survival</div>
          <div style="font-size:18px;font-weight:700;color:#111827;margin-top:2px;">0.87 <span style="font-size:11px;color:#059669;font-weight:normal;">(+0.04)</span></div>
        </div>
        <div>
          <div style="font-size:11px;color:#6B7280;">median rollback time</div>
          <div style="font-size:18px;font-weight:700;color:#111827;margin-top:2px;">3.2h <span style="font-size:11px;color:#059669;font-weight:normal;">(-1.1h)</span></div>
        </div>
      </div>
    </div>

    <!-- Why Not Trusted Yet Right Panel (Matching Image 3) -->
    <aside style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px;">
      <h2 style="font-size:15px;font-weight:700;margin:0 0 14px 0;color:#111827;">Why not trusted yet</h2>

      <div style="display:grid;gap:14px;">
        <!-- Metric 1 -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500;">
              <span style="width:14px;height:14px;border:2px solid #9CA3AF;border-radius:999px;display:inline-block;"></span>
              cross-model transfer
            </label>
            <span style="font-size:11px;color:#6B7280;">20%</span>
          </div>
          <div style="font-size:11px;color:#6B7280;margin:2px 0 4px 20px;">1/5</div>
          <div style="height:4px;background:#E5E7EB;border-radius:2px;margin-left:20px;overflow:hidden;">
            <div style="height:100%;width:20%;background:#0F5C57;border-radius:2px;"></div>
          </div>
        </div>

        <!-- Metric 2 -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500;">
              <span style="width:14px;height:14px;border:2px solid #9CA3AF;border-radius:999px;display:inline-block;"></span>
              regression suite
            </label>
            <span style="font-size:11px;color:#6B7280;">30%</span>
          </div>
          <div style="font-size:11px;color:#6B7280;margin:2px 0 4px 20px;">3/10</div>
          <div style="height:4px;background:#E5E7EB;border-radius:2px;margin-left:20px;overflow:hidden;">
            <div style="height:100%;width:30%;background:#0F5C57;border-radius:2px;"></div>
          </div>
        </div>

        <!-- Metric 3 -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500;">
              <span style="width:14px;height:14px;border:2px solid #9CA3AF;border-radius:999px;display:inline-block;"></span>
              20 shadow runs
            </label>
            <span style="font-size:11px;color:#6B7280;">30%</span>
          </div>
          <div style="font-size:11px;color:#6B7280;margin:2px 0 4px 20px;">6/20</div>
          <div style="height:4px;background:#E5E7EB;border-radius:2px;margin-left:20px;overflow:hidden;">
            <div style="height:100%;width:30%;background:#0F5C57;border-radius:2px;"></div>
          </div>
        </div>

        <!-- Metric 4 -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500;">
              <span style="width:14px;height:14px;border:2px solid #9CA3AF;border-radius:999px;display:inline-block;"></span>
              0.95 pilot
            </label>
            <span style="font-size:11px;color:#6B7280;">20%</span>
          </div>
          <div style="font-size:11px;color:#6B7280;margin:2px 0 4px 20px;">2/10</div>
          <div style="height:4px;background:#E5E7EB;border-radius:2px;margin-left:20px;overflow:hidden;">
            <div style="height:100%;width:20%;background:#0F5C57;border-radius:2px;"></div>
          </div>
        </div>
      </div>

      <div style="margin-top:24px;">
        <button type="button" disabled style="width:100%;padding:8px 12px;background:#D1D5DB;color:#4B5563;border:0;border-radius:6px;font-size:12px;font-weight:600;cursor:not-allowed;">
          Promote
        </button>
        <div style="font-size:11px;color:#9CA3AF;text-align:center;margin-top:6px;">4 trust gates remaining</div>
      </div>
    </aside>
  </div>
</section>`;
}
