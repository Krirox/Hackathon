import type { ConsoleReport, CostPoint, TierBucket } from './report.ts';
import { COST_CURVE_BUDGET, MAX_CARDS_PER_STATE, MAX_NEEDS_HUMAN, MAX_ROOMS, ROOM_REQUESTS } from './report.ts';

import { THEME_INIT_SCRIPT, THEME_TOGGLE_SCRIPT, themeStyleBlock, themeToggleButton } from './theme.ts';

/**
 * Static renderer for the console read model: one self-contained HTML file,
 * inline SVG charts, zero dependencies, zero backend. Numbers are computed
 * by `buildReport`; this file only draws them. Glyphs accompany every
 * semantic color (never color alone); surfaces resolve via `var(--v-*)`
 * tokens (dark default, light opt-in — see theme.ts).
 */

const INK = 'var(--v-ink)';
const MUTED = 'var(--v-muted)';
const TEAL = 'var(--v-accent)';
const HAIRLINE = 'var(--v-line)';
const FACT = 'var(--v-fact)';
const HYPO = 'var(--v-hypo)';
const PRED = 'var(--v-pred)';
const RISK = 'var(--v-risk)';

export const esc = (s: string): string =>
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
  // Iterative maximum: one point per decision means history-sized spreads
  // would overflow the call stack — walk the values instead.
  let max = target * 1.3;
  if (max < 1) max = 1;
  for (const p of points) {
    const v = p.costPerGoodDecision;
    if (v !== null && v > max) max = v;
  }
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

const TIER_COLORS = { REFLEX: 'var(--v-accent)', WORKFLOW: 'var(--v-accent-2)', MODEL: 'var(--v-pred)', HUMAN: 'var(--v-faint)' } as const;

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
  return `<span style="display:inline-block;background:${s.color};color:var(--v-bg-1);font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">${s.glyph} ${esc(kind)}</span>`;
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

function needsHumanCard(
  n: { requestId: string; goal: string; scope: string; deadline: string; state: string },
  live: boolean,
): string {
  let title = esc(n.goal);
  if (live) {
    title = `<a href="${esc(needsHumanTaskUrl(n.requestId))}">${esc(n.goal)}</a>`;
  }
  return `<div class="card"><div class="sub"><span style="display:inline-block;background:${RISK};color:var(--v-bg-1);font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;">! RISK</span> · ${esc(n.scope)} · due ${esc(n.deadline)}</div><div style="font-weight:700">${title}</div><div class="sub">${esc(n.state)}</div></div>`;
}

export function renderHtml(r: ConsoleReport, live = false): string {
  const h = r.health;
  // Defensive second bound: the report is already windowed, but the
  // renderer never trusts its input to be bounded — a caller handing a
  // hand-built report must still get a bounded page.
  const curve = r.costCurve.slice(-COST_CURVE_BUDGET);
  const needsHuman = r.needsHuman.slice(0, MAX_NEEDS_HUMAN);
  const roomsCapped = r.rooms.slice(0, MAX_ROOMS);
  const cards = (state: string): string => {
    const col = r.compiler.find((c) => c.state === state);
    if (!col || col.cards.length === 0) return '<p style="color:' + MUTED + ';font-size:12px">—</p>';
    return col.cards
      .slice(0, MAX_CARDS_PER_STATE)
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
  const rooms = roomsCapped
    .map(
      (
        room,
      ) => `<div style="margin-bottom:14px;"><div style="font-weight:700">${esc(room.scope)} ${healthDot(room.health)}</div>
        ${room.requests
          .slice(-ROOM_REQUESTS)
          .map(
            (
              q,
            ) => `<div style="border-left:3px solid ${q.state === 'COMPLETED' ? FACT : HAIRLINE};padding:6px 10px;margin:6px 0;">
            <div style="font-size:12px;">${live ? `<a href="/console/requests/${esc(encodeURIComponent(q.id))}">${esc(q.goal)}</a>` : esc(q.goal)} <span style="color:${MUTED};font-size:11px">${esc(q.state)} · ${esc(q.originScope)}→${esc(q.targetScope)}</span></div>
            ${q.evidence.map((e) => `<div style="font-size:11px;margin-top:4px;">${live ? `<a href="/console/claims/${esc(encodeURIComponent(e.id))}">${evidenceChip(e)}</a>` : evidenceChip(e)} ${esc(e.statement.slice(0, 120))} <span style="color:${MUTED}">${esc(e.tier)} · ${esc(e.status)}</span></div>`).join('')}
          </div>`,
          )
          .join('')}</div>`,
    )
    .join('');
  // F26: bounded sections surface what the window omits — 0 means the
  // window held everything; >0 links to the unbounded list page.
  const omittedLine = (): string => {
    const parts: string[] = [];
    if (r.omitted.needsHuman > 0)
      parts.push(`${r.omitted.needsHuman} more in queue → <a href="/console/human-work">human work</a>`);
    if (r.omitted.rooms > 0) parts.push(`${r.omitted.rooms} rooms hidden → <a href="/console/rooms">all rooms</a>`);
    if (r.omitted.decisions > 0) parts.push(`${r.omitted.decisions} decisions beyond the chart window`);
    if (r.omitted.cards > 0) parts.push(`${r.omitted.cards} cards beyond the compiler columns`);
    return parts.length > 0 ? `<p class="sub">Also beyond this view: ${parts.join(' · ')}</p>` : '';
  };
  return `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vital Console — ${esc(r.tenant)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script>${THEME_INIT_SCRIPT}</script>
${themeStyleBlock()}
<style>body{font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--v-bg-0);color:var(--v-ink);margin:0 auto;padding:28px 24px;max-width:1280px;line-height:1.5;letter-spacing:-0.011em;-webkit-font-smoothing:antialiased}h1{font-size:26px;font-weight:600;letter-spacing:-0.025em;margin:16px 0 12px}h2{font-size:15px;font-weight:600;letter-spacing:-0.015em;margin:28px 0 12px;color:var(--v-ink)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card,.v-card{border:1px solid var(--v-line);border-radius:10px;padding:18px;background:var(--v-bg-1);box-shadow:var(--v-card-shadow);transition:border-color .15s ease,box-shadow .15s ease}.card:hover{border-color:var(--v-line-strong)}.big{font-size:28px;font-weight:700;letter-spacing:-0.02em;margin:4px 0}.sub,.v-sub{font-size:12px;color:var(--v-muted);line-height:1.4}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.bar{height:6px;background:var(--v-line);border-radius:3px;overflow:hidden;margin:6px 0}.bar>i{display:block;height:100%;background:var(--v-accent);border-radius:3px}a{color:var(--v-accent);text-decoration:none}a:hover{text-decoration:underline}code,pre{font-family:'JetBrains Mono',monospace}button{font-family:inherit}nav[aria-label="Console"]{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:8px;margin-top:24px}nav[aria-label="Console"] a{padding:6px 12px;border-radius:5px;font-size:13px;font-weight:500;color:var(--v-muted);text-decoration:none;transition:all 0.15s ease}nav[aria-label="Console"] a:hover{background:var(--v-bg-2);color:var(--v-ink)}nav[aria-label="Console"] a[aria-current="page"]{background:var(--v-accent);color:var(--v-accent-ink)}</style>
</head><body>
<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><p class="sub">${esc(r.tenant)} · ${esc(r.at)}</p>${themeToggleButton()}</div>${omittedLine()}
<h1>Reality health</h1>
<div class="grid">
<div class="card"><div class="sub">stale-fact rate</div><div class="big">${(h.staleFactRate * 100).toFixed(1)}%</div><div class="bar"><i style="width:${Math.min(100, (h.staleFactRate / h.staleFactGate) * 100).toFixed(0)}%"></i></div><div class="sub">gate &lt; ${(h.staleFactGate * 100).toFixed(0)}%</div></div>
<div class="card"><div class="sub">contradictions open</div><div class="big">${h.contradictions.open}</div><div class="sub">MTTR ${h.contradictions.mttrHours === null ? 'unmeasured — resolution timestamps pending' : h.contradictions.mttrHours.toFixed(0) + 'h'} · SLA ${h.contradictions.slaHours}h</div></div>
<div class="card"><div class="sub">provenance complete</div><div class="big">${(h.provenanceComplete * 100).toFixed(0)}%</div><div class="sub">FACT + MEASUREMENT with ground provenance</div></div>
<div class="card"><div class="sub">orphan claims</div><div class="big">${h.orphanClaims}</div><div class="sub">target 0</div></div>
<div class="card"><div class="sub">approval latency</div><div class="big">${r.approvalLatency.medianSeconds === null ? '—' : fmtDuration(r.approvalLatency.medianSeconds)}</div><div class="sub">median · n=${r.approvalLatency.n}${r.approvalLatency.p90Seconds === null ? '' : ` · p90 ${fmtDuration(r.approvalLatency.p90Seconds)}`}${r.approvalLatency.byHuman.length === 0 ? '' : ` · slowest: ${esc(r.approvalLatency.byHuman[0]!.human)} ${fmtDuration(r.approvalLatency.byHuman[0]!.medianSeconds)}`}</div></div>
<div class="card"><div class="sub">cost per signal</div>${r.costPerSignal === null ? '<div class="big">—</div><div class="sub">no router configured</div>' : `<div class="big">${(r.costPerSignal.modelShare * 100).toFixed(2)}%</div><div class="sub">model share of ${r.costPerSignal.arrivals} arrivals · gate &lt; ${(r.costPerSignal.gate * 100).toFixed(0)}%${r.costPerSignal.withinGate ? ' · within gate' : ' · OVER GATE'}</div>`}</div>
</div>
 <h2>Intelligence cost per good decision</h2>
 <div class="sub" style="margin-bottom:8px">Observed spend per good decision (descriptive — see caveats for causal attribution)</div>
 <div class="card">${lineChart(curve, r.costTarget)}</div>
<h2>Tier mix</h2>
<div class="card">${tierStack(r.tierMix)}</div>
<h2>Needs a human (${needsHuman.length} shown${r.omitted.needsHuman > 0 ? ` of ${needsHuman.length + r.omitted.needsHuman}` : ''} · ${r.health.escalations.open}/${r.health.escalations.cap} slots · ${live ? `<a href="/console/digest">${r.digestCount} notices → digest</a>` : `${r.digestCount} notices → digest`})</h2>
<div class="grid">${needsHuman.map((n) => needsHumanCard(n, live)).join('') || '<p class="sub">queue clear</p>'}</div>
<h2>Compiler — why not trusted yet</h2>
<div class="cols">${['CANDIDATE', 'QUARANTINE', 'SHADOW', 'BOUNDED_PILOT', 'PROMOTED', 'DEMOTED'].map((s) => `<div><div class="sub">${s}</div>${cards(s)}</div>`).join('')}</div>
<h2>Rooms</h2>
${rooms || '<p class="sub">no rooms yet</p>'}
<script>${THEME_TOGGLE_SCRIPT}</script>
</body></html>`;
}

export type NavKey =
  | 'reviews'
  | 'requests'
  | 'claims'
  | 'rooms'
  | 'humanWork'
  | 'workflows'
  | 'buzz'
  | 'digest'
  | 'learning'
  | 'review'
  | 'audit'
  | 'settings'
  | 'data'
  | 'team'
  | 'account';

export interface NavAvailability {
  reviews: boolean;
  requests: boolean;
  claims: boolean;
  rooms: boolean;
  humanWork: boolean;
  workflows: boolean;
  buzz: boolean;
  digest: boolean;
  learning: boolean;
  review: boolean;
  audit: boolean;
  settings: boolean;
  data: boolean;
  team: boolean;
  account: boolean;
}

export interface NavDestination {
  key: NavKey;
  label: string;
  href: string;
}

export interface DetailNavContext {
  evidencePage?: number;
  queuePage?: number;
  requestId?: string;
  returnTo?: string;
}

export function resolveConsoleHome(siteDir?: string | null): string {
  if (siteDir) {
    return '/console';
  }
  return '/';
}

export function buildConsoleNav(home: string, availability: Partial<NavAvailability> = {}): NavDestination[] {
  const open: NavAvailability = {
    reviews: true,
    requests: false,
    claims: false,
    rooms: false,
    humanWork: false,
    workflows: true,
    buzz: false,
    digest: true,
    learning: false,
    review: false,
    audit: false,
    settings: false,
    data: false,
    team: true,
    account: true,
    ...availability,
  };
  const items: NavDestination[] = [];
  if (open.reviews) {
    items.push({ key: 'reviews', label: 'Reviews', href: `${home}#pending-review` });
  }
  if (open.requests) {
    items.push({ key: 'requests', label: 'Requests', href: '/console/requests' });
  }
  if (open.claims) {
    items.push({ key: 'claims', label: 'Claims', href: '/console/claims' });
  }
  if (open.rooms) {
    items.push({ key: 'rooms', label: 'Rooms', href: '/console/rooms' });
  }
  if (open.humanWork) {
    items.push({ key: 'humanWork', label: 'Human work', href: '/console/human-work' });
  }
  if (open.workflows) {
    items.push({ key: 'workflows', label: 'Workflows', href: '/console/workflows' });
  }
  if (open.buzz) {
    items.push({ key: 'buzz', label: 'Workspace', href: '/console/buzz' });
  }
  if (open.digest) {
    items.push({ key: 'digest', label: 'Digest', href: '/console/digest' });
  }
  if (open.learning) {
    items.push({ key: 'learning', label: 'Learning', href: '/console/learning' });
  }
  if (open.review) {
    items.push({ key: 'review', label: 'Code review', href: '/console/review' });
  }
  if (open.audit) {
    items.push({ key: 'audit', label: 'Audit', href: '/console/audit' });
  }
  if (open.settings) {
    items.push({ key: 'settings', label: 'Settings', href: '/setup' });
  }
  if (open.data) {
    items.push({ key: 'data', label: 'Data', href: '/console/data' });
  }
  if (open.team) {
    items.push({ key: 'team', label: 'Team', href: '/team' });
  }
  if (open.account) {
    items.push({ key: 'account', label: 'Account', href: '/account' });
  }
  return items;
}

export function renderConsoleNav(items: NavDestination[], current?: NavKey): string {
  const links = items
    .map((item, i) => {
      const tab = i === 0 ? ' tabindex="0"' : ' tabindex="-1"';
      const roving = ' data-console-nav-link';
      if (current !== undefined && item.key === current) {
        return `<a href="${esc(item.href)}" aria-current="page"${tab}${roving}>${esc(item.label)}</a>`;
      }
      return `<a href="${esc(item.href)}"${tab}${roving}>${esc(item.label)}</a>`;
    })
    .join(' · ');
  return `<nav aria-label="Console">${links}</nav><script>${CONSOLE_NAV_SCRIPT}</script>`;
}

/**
 * FLOW-019 keyboard traversal: roving tabindex with arrow-key movement
 * inside the shared console nav. Links remain plain Tab stops (first link
 * tabindex 0); ArrowLeft/Right/Home/End move focus without activating.
 */
export const CONSOLE_NAV_SCRIPT = `(() => {
  const nav = document.querySelector('nav[aria-label="Console"]');
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll('a[data-console-nav-link]'));
  if (links.length === 0) return;
  nav.addEventListener('keydown', (event) => {
    const current = document.activeElement;
    const i = links.indexOf(current);
    if (i < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (i + 1) % links.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + links.length) % links.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = links.length - 1;
    else return;
    event.preventDefault();
    links.forEach((l) => l.tabIndex = -1);
    links[next].tabIndex = 0;
    links[next].focus();
  });
})();`;

export function renderAccountCluster(email: string, role: string, csrf: string): string {
  return `<div style="margin-top:24px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:12px;box-shadow:var(--v-card-shadow)" class="sub"><span>signed in as <strong style="color:var(--v-ink)">${esc(email)}</strong> · <span class="v-mono" style="font-size:11px;background:var(--v-bg-2);padding:2px 6px;border-radius:4px;border:1px solid var(--v-line)">${esc(role)}</span></span><a href="/account" style="color:var(--v-accent);font-weight:500">account</a><a href="/team" style="color:var(--v-accent);font-weight:500">team</a><a href="/settings/rooms" style="color:var(--v-accent);font-weight:500">rooms</a><form method="post" action="/logout" style="display:inline;margin-left:auto"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" style="background:var(--v-ink-2);color:var(--v-bg-1);border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer">Sign out</button></form></div>`;
}

export function needsHumanTaskUrl(requestId: string): string {
  return `/console/requests/${encodeURIComponent(requestId)}`;
}

function validDetailPage(n: number | undefined): n is number {
  return n !== undefined && Number.isSafeInteger(n) && n >= 0;
}

export function requestDetailUrl(id: string, ctx: DetailNavContext = {}): string {
  const params = new URLSearchParams();
  if (validDetailPage(ctx.evidencePage) && ctx.evidencePage > 0) {
    params.set('page', String(ctx.evidencePage));
  }
  if (ctx.returnTo) {
    params.set('return', ctx.returnTo);
  }
  const query = params.toString();
  const base = `/console/requests/${encodeURIComponent(id)}`;
  if (query) {
    return `${base}?${query}`;
  }
  return base;
}

export function claimDetailUrl(id: string, ctx: DetailNavContext = {}): string {
  const params = new URLSearchParams();
  if (validDetailPage(ctx.evidencePage) && ctx.evidencePage > 0) {
    params.set('page', String(ctx.evidencePage));
  }
  if (ctx.requestId) {
    params.set('requestId', ctx.requestId);
  }
  if (ctx.returnTo) {
    params.set('return', ctx.returnTo);
  }
  const query = params.toString();
  const base = `/console/claims/${encodeURIComponent(id)}`;
  if (query) {
    return `${base}?${query}`;
  }
  return base;
}

export function queueReturnUrl(home: string, ctx: DetailNavContext = {}): string {
  if (ctx.returnTo) {
    return ctx.returnTo;
  }
  if (validDetailPage(ctx.queuePage) && ctx.queuePage > 0) {
    return `${home}?reviewPage=${String(ctx.queuePage)}#pending-review`;
  }
  return home;
}

export function withReturnTo(url: string, returnTo?: string): string {
  if (!returnTo) {
    return url;
  }
  if (url.includes('?')) {
    return `${url}&return=${encodeURIComponent(returnTo)}`;
  }
  return `${url}?return=${encodeURIComponent(returnTo)}`;
}

/** Shared paginated list shell for the /console view-all routes (FLOW-020). */
/**
 * Console data table. Cell contents are pre-built HTML — callers own their own
 * escaping (they already escape every user-controlled value they interpolate).
 * Returns '' for an empty row set so a caller never renders a bare header.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  return `<div class="v-table-wrap"><table class="v-table">
<thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
}

/** A titled group inside a list page (e.g. "Pending decision (3)"). */
export function renderListSection(heading: string, body: string): string {
  return `<section class="v-list-group"><h2>${esc(heading)}</h2>${body}</section>`;
}

/**
 * The Console list-page frame: page title, a search/filter bar, an explicit
 * result count, the caller's body, and pagination.
 *
 * This owns the page's <h1>, so a caller that wraps it in `detailDocument`
 * must pass `hideHeader: true` — otherwise the title renders twice. That
 * duplication is what this frame replaced.
 */
export function renderListPage(opts: {
  title: string;
  heading: string;
  searchAction: string;
  query: string;
  total: number;
  truncated: boolean;
  shown: number;
  prevUrl: string | null;
  nextUrl: string | null;
  clearUrl: string;
  body: string;
  returnNote?: string;
}): string {
  const pages = [
    opts.prevUrl ? `<a class="v-btn v-btn-secondary v-btn-sm" href="${esc(opts.prevUrl)}">← Previous</a>` : '',
    opts.nextUrl ? `<a class="v-btn v-btn-secondary v-btn-sm" href="${esc(opts.nextUrl)}">Next →</a>` : '',
  ]
    .filter(Boolean)
    .join('');
  const count = `${opts.total.toLocaleString()} total · showing ${opts.shown.toLocaleString()}`;
  return `<div class="v-page-head">
  <div>
    <p class="v-eyebrow">${esc(opts.title)}</p>
    <h1 class="v-page-title">${esc(opts.heading)}</h1>
  </div>
</div>
<form class="v-filterbar" method="get" action="${esc(opts.searchAction)}" role="search">
  <label class="v-sr-only" for="q">Search ${esc(opts.heading.toLowerCase())}</label>
  <input id="q" name="q" class="v-input" type="search" value="${esc(opts.query)}" placeholder="Search ${esc(opts.heading.toLowerCase())}…" autocomplete="off">
  <button class="v-btn v-btn-primary" type="submit">Search</button>
  <a class="v-btn v-btn-ghost" href="${esc(opts.clearUrl)}">Clear</a>
</form>
<p class="v-meta v-count">${esc(count)}${opts.truncated ? ' · explicit truncation: narrow the search or page further' : ''}</p>
${opts.body}
${pages ? `<nav class="v-pager" aria-label="Pagination">${pages}</nav>` : ''}
${opts.returnNote ? `<p class="v-meta">${esc(opts.returnNote)}</p>` : ''}`;
}
