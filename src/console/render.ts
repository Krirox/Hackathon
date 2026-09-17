import type { ConsoleReport, CostPoint, TierBucket } from './report.ts';

/**
 * Static renderer for the console read model: one self-contained HTML file,
 * inline SVG charts, zero dependencies, zero backend. Numbers are computed
 * by `buildReport`; this file only draws them. Glyphs accompany every
 * semantic color (never color alone); canvas is #FAFAF8, ink #0A0F14,
 * accent deep teal #0F5C57 per the deck system (idea.md §27).
 */

const INK = '#0A0F14';
const MUTED = '#6B7280';
const TEAL = '#0F5C57';
const HAIRLINE = '#E4E4E1';
const FACT = '#0F7A3D';
const HYPO = '#B45309';
const PRED = '#4338CA';
const RISK = '#B91C1C';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Seconds → human duration: sub-minute stays seconds, minutes, then hours. */
const fmtDuration = (sec: number): string => {
  if (sec < 90) return `${Math.round(sec)}s`;
  const mins = sec / 60;
  if (mins < 90) return `${Math.round(mins)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
};

const KIND_STYLE: Record<string, { color: string; glyph: string }> = {
  FACT: { color: FACT, glyph: '✓' },
  MEASUREMENT: { color: FACT, glyph: '✓' },
  HYPOTHESIS: { color: HYPO, glyph: '?' },
  PREDICTION: { color: PRED, glyph: '→' },
  BELIEF: { color: HYPO, glyph: '?' },
  ASSUMPTION: { color: HYPO, glyph: '?' },
  GOAL: { color: TEAL, glyph: '◎' },
  DECISION: { color: TEAL, glyph: '◆' },
  ACTION: { color: TEAL, glyph: '▶' },
  OBSERVATION: { color: MUTED, glyph: '○' },
  OUTCOME: { color: FACT, glyph: '✓' },
};

/** Line chart with a dashed target line. Points with null values are gaps, not zeros. */
export function lineChart(points: CostPoint[], target: number, w = 560, h = 220): string {
  const vals = points.map((p) => p.costPerGoodDecision).filter((v): v is number => v !== null);
  const max = Math.max(target * 1.3, ...vals, 1);
  const pad = 34;
  const x = (i: number) => (points.length === 1 ? pad : pad + (i * (w - pad - 8)) / (points.length - 1));
  const y = (v: number) => h - 24 - (v / max) * (h - 48);
  const dots = points
    .map((p, i) =>
      p.costPerGoodDecision === null
        ? ''
        : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.costPerGoodDecision).toFixed(1)}" r="3.5" fill="${TEAL}"><title>${esc(p.label)}: $${p.costPerGoodDecision.toFixed(2)}</title></circle>`,
    )
    .join('');
  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (p.costPerGoodDecision === null) {
      if (run.length > 1)
        segments.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${TEAL}" stroke-width="2"/>`);
      run = [];
    } else {
      run.push(`${x(i).toFixed(1)},${y(p.costPerGoodDecision).toFixed(1)}`);
    }
  });
  if (run.length > 1)
    segments.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${TEAL}" stroke-width="2"/>`);
  const labels = points
    .map(
      (p, i) =>
        `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="${MUTED}" text-anchor="middle">${esc(p.label)}</text>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="intelligence cost per good decision">
    <line x1="${pad}" y1="${y(target).toFixed(1)}" x2="${w - 8}" y2="${y(target).toFixed(1)}" stroke="${MUTED}" stroke-dasharray="5 4"/>
    <text x="${w - 10}" y="${(y(target) - 5).toFixed(1)}" font-size="10" fill="${MUTED}" text-anchor="end">target $${target.toFixed(1)}</text>
    ${segments.join('')}${dots}${labels}</svg>`;
}

const TIER_COLORS = { REFLEX: '#0F5C57', WORKFLOW: '#3E8E87', MODEL: '#93C4BE', HUMAN: '#D8E8E5' } as const;

/** Stacked percentage area over weekly buckets. */
export function tierStack(buckets: TierBucket[], w = 360, h = 220): string {
  const pad = 30;
  const keys = ['REFLEX', 'WORKFLOW', 'MODEL', 'HUMAN'] as const;
  const totals = buckets.map((b) => keys.reduce((s, k) => s + b[k], 0));
  const frac = buckets.map((b, i) => {
    const t = totals[i] === 0 ? 1 : totals[i]!;
    let acc = 0;
    return keys.map((k) => {
      const lo = acc / t;
      acc += b[k];
      return { k, lo, hi: acc / t };
    });
  });
  const x = (i: number) => (buckets.length === 1 ? pad : pad + (i * (w - pad - 8)) / (buckets.length - 1));
  const y = (f: number) => h - 24 - f * (h - 48);
  const bands = keys
    .map((k) => {
      const top = frac.map((f, i) => `${x(i).toFixed(1)},${y(f.find((s) => s.k === k)!.hi).toFixed(1)}`).join(' ');
      const bot = frac
        .map((f, i) => `${x(i).toFixed(1)},${y(f.find((s) => s.k === k)!.lo).toFixed(1)}`)
        .reverse()
        .join(' ');
      return `<polygon points="${top} ${bot}" fill="${TIER_COLORS[k]}" opacity="0.9"><title>${k}</title></polygon>`;
    })
    .join('');
  const labels = buckets
    .map(
      (b, i) =>
        `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="${MUTED}" text-anchor="middle">${esc(b.label)}</text>`,
    )
    .join('');
  const legend = keys.map((k) => `<span style="color:${INK}">■</span> ${k}`).join(' · ');
  return `<div>${bands ? `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="tier mix">${bands}${labels}</svg>` : '<p style="color:' + MUTED + '">no traces yet</p>'}<p style="font-size:11px;color:${MUTED}">${legend}</p></div>`;
}

function tag(kind: string): string {
  const s = KIND_STYLE[kind] ?? { color: MUTED, glyph: '○' };
  return `<span style="display:inline-block;background:${s.color};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">${s.glyph} ${esc(kind)}</span>`;
}

/**
 * Provisional reality must be UNMISTAKABLE (TODO §1.3) — a CANDIDATE chip in
 * the same visual language as a verified fact is exactly the failure mode
 * the Ledger exists to prevent. Four redundant signals, so no single
 * channel (color, glyph, text, spacing) has to be trusted alone:
 *   1. glyph swaps to the · PROVISIONAL text
 *   2. label reads "PROVISIONAL", not the bare claim kind
 *   3. white text → ink on the light chip, every other chip is white-on-dark
 *   4. dashed border — no other chip in the report has one
 * Versioned, because the whole point is that this never silently regresses
 * to looking like every other chip.
 */
export const PROVISIONAL_CHIP_VERSION = 1;

function provisionalTag(kind: string): string {
  return `<span style="display:inline-block;background:${HYPO};color:${INK};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px dashed ${RISK};letter-spacing:0.5px;">· PROVISIONAL ${esc(kind)}</span>`;
}

export function evidenceChip(e: { kind: string; status: string; provisional: boolean }): string {
  return e.provisional || e.status === 'CANDIDATE' ? provisionalTag(e.kind) : tag(e.kind);
}

function healthDot(health: string): string {
  let c = MUTED;
  if (health === 'healthy') c = FACT;
  else if (health === 'degraded') c = HYPO;
  return `<span style="color:${c}">●</span> <span style="font-size:11px;color:${MUTED}">${esc(health)}</span>`;
}

function gapLine(gaps: string[]): string {
  if (gaps.length === 0) return `<div style="font-size:11px;color:${FACT}">✓ no open trust gaps</div>`;
  const extra = gaps.length > 1 ? ` (+${gaps.length - 1})` : '';
  return `<div style="font-size:11px;color:${HYPO}">? ${esc(gaps[0]!)}${extra}</div>`;
}

export function renderHtml(r: ConsoleReport): string {
  const h = r.health;
  const cards = (state: string): string => {
    const col = r.compiler.find((c) => c.state === state);
    if (!col || col.cards.length === 0) return '<p style="color:' + MUTED + ';font-size:12px">—</p>';
    return col.cards
      .map(
        (c) => `<div style="border:1px solid ${HAIRLINE};border-radius:8px;padding:10px;margin-bottom:8px;">
          <div style="font-weight:700">${esc(c.intent)} <span style="font-weight:400;color:${MUTED};font-size:11px">v${c.version} · ${esc(c.trustTier)}</span></div>
          <div style="font-size:11px;color:${MUTED}">${c.scopeRoles.map(esc).join(' · ')}</div>
          ${gapLine(c.trustGaps)}
          <div style="font-size:11px;color:${MUTED}">transfer ${c.transfersPassed}/${c.transfersTotal}</div>
        </div>`,
      )
      .join('');
  };
  const rooms = r.rooms
    .map(
      (
        room,
      ) => `<div style="margin-bottom:14px;"><div style="font-weight:700">${esc(room.scope)} ${healthDot(room.health)}</div>
        ${room.requests
          .map(
            (
              q,
            ) => `<div style="border-left:3px solid ${q.state === 'COMPLETED' ? FACT : HAIRLINE};padding:6px 10px;margin:6px 0;">
            <div style="font-size:12px;">${esc(q.goal)} <span style="color:${MUTED};font-size:11px">${esc(q.state)} · ${esc(q.originScope)}→${esc(q.targetScope)}</span></div>
            ${q.evidence.map((e) => `<div style="font-size:11px;margin-top:4px;">${evidenceChip(e)} ${esc(e.statement.slice(0, 120))} <span style="color:${MUTED}">${esc(e.tier)} · ${esc(e.status)}</span></div>`).join('')}
          </div>`,
          )
          .join('')}</div>`,
    )
    .join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Vital Console — ${esc(r.tenant)}</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:${INK};margin:0;padding:24px}h1{font-size:28px;margin:0}h2{font-size:16px;margin:24px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{border:1px solid ${HAIRLINE};border-radius:10px;padding:16px;background:#fff}.big{font-size:32px;font-weight:800}.sub{font-size:11px;color:${MUTED}}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.bar{height:6px;background:${HAIRLINE};border-radius:3px}.bar>i{display:block;height:100%;background:${TEAL};border-radius:3px}</style>
</head><body>
<p class="sub">${esc(r.tenant)} · ${esc(r.at)}</p>
<h1>Reality health</h1>
<div class="grid">
<div class="card"><div class="sub">stale-fact rate</div><div class="big">${(h.staleFactRate * 100).toFixed(1)}%</div><div class="bar"><i style="width:${Math.min(100, (h.staleFactRate / h.staleFactGate) * 100).toFixed(0)}%"></i></div><div class="sub">gate &lt; ${(h.staleFactGate * 100).toFixed(0)}%</div></div>
<div class="card"><div class="sub">contradictions open</div><div class="big">${h.contradictions.open}</div><div class="sub">MTTR ${h.contradictions.mttrHours === null ? 'unmeasured — resolution timestamps pending' : h.contradictions.mttrHours.toFixed(0) + 'h'} · SLA ${h.contradictions.slaHours}h</div></div>
<div class="card"><div class="sub">provenance complete</div><div class="big">${(h.provenanceComplete * 100).toFixed(0)}%</div><div class="sub">FACT only</div></div>
<div class="card"><div class="sub">orphan claims</div><div class="big">${h.orphanClaims}</div><div class="sub">target 0</div></div>
<div class="card"><div class="sub">approval latency</div><div class="big">${r.approvalLatency.medianSeconds === null ? '—' : fmtDuration(r.approvalLatency.medianSeconds)}</div><div class="sub">median · n=${r.approvalLatency.n}${r.approvalLatency.p90Seconds === null ? '' : ` · p90 ${fmtDuration(r.approvalLatency.p90Seconds)}`}</div></div>
</div>
<h2>Intelligence cost per good decision</h2>
<div class="card">${lineChart(r.costCurve, r.costTarget)}</div>
<h2>Tier mix</h2>
<div class="card">${tierStack(r.tierMix)}</div>
<h2>Needs a human (${r.needsHuman.length} open · ${r.health.escalations.open}/${r.health.escalations.cap} slots · ${r.digestCount} notices → digest)</h2>
<div class="grid">${r.needsHuman.map((n) => `<div class="card"><div class="sub"><span style="display:inline-block;background:${RISK};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">! RISK</span> · ${esc(n.scope)} · due ${esc(n.deadline)}</div><div style="font-weight:700">${esc(n.goal)}</div><div class="sub">${esc(n.state)}</div></div>`).join('') || '<p class="sub">queue clear</p>'}</div>
<h2>Compiler — why not trusted yet</h2>
<div class="cols">${['CANDIDATE', 'QUARANTINE', 'SHADOW', 'BOUNDED_PILOT', 'PROMOTED', 'DEMOTED'].map((s) => `<div><div class="sub">${s}</div>${cards(s)}</div>`).join('')}</div>
<h2>Rooms</h2>
${rooms || '<p class="sub">no rooms yet</p>'}
</body></html>`;
}
