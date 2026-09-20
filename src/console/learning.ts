import type { AsyncDb } from '../core/db.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { cardEvaluationEvidence, describeCardReadOnly } from '../compiler/registry.ts';
import type { CognitiveRouter } from '../router/router.ts';
import { COMPILE_MIN_SUCCESSES, type CompileCandidate } from './learning-actions.ts';

/**
 * FINAL-004: the human surface for learning review.
 *
 * Before this page the only links offered to humans pointed at the JSON APIs
 * (`/api/learning/cards/:id`), which render as an unstyled blob in a browser.
 * These are read/act pages: the labeling queue labels a routing decision, and
 * a card page shows why a card is not trusted yet. Linking evidence never
 * promotes a card — promotion runs only through the transfer path, which this
 * module can now *queue* (see routes/learning.ts) rather than only describe.
 * Compilation is likewise reachable: `renderCompilePage` below.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const ROUTING_TIERS = ['CACHE', 'MODEL', 'WORKFLOW', 'HUMAN'] as const;

export interface LearningPageOptions {
  tenant: string;
  actor: string;
  csrf: string;
  notice?: string;
}

function labeledNotice(notice?: string): string {
  if (!notice) return '';
  return `<div class="v-success" role="status">${esc(notice)}</div>`;
}

export async function renderLearningPage(
  db: AsyncDb,
  router: CognitiveRouter,
  comp: OrganizationalCompiler,
  tenant: string,
  opts: LearningPageOptions,
): Promise<string> {
  const queue = await router.labelingQueue(tenant, 50);
  const cards = await comp.list(tenant, {});

  const queueRows =
    queue.length === 0
      ? '<div class="v-empty" style="margin-top:12px;"><h3>No unlabeled routing decisions</h3><p>The queue fills as the router makes shadow decisions.</p></div>'
      : `<div class="v-table-wrap"><table class="v-table"><thead><tr><th>decision</th><th>task</th><th>proposed → executed</th><th>evidence</th><th>label</th></tr></thead><tbody>${queue
          .map((d) => {
            const rate = d.evidence.successRate === null ? 'n/a' : `${(d.evidence.successRate * 100).toFixed(0)}%`;
            return `<tr>
<td><span class="v-code-pill">${esc(String(d.id))}</span></td>
<td><strong>${esc(d.taskType)}</strong> <span class="v-meta">· ${esc(d.scope)}</span></td>
<td>${esc(d.proposed)} <span class="v-meta">→</span> ${esc(d.executed)}</td>
<td class="v-meta">${d.evidence.traces} traces · ${rate}</td>
<td><form method="post" action="/console/learning/label" style="display:flex;align-items:center;gap:8px;">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="decisionId" value="${esc(String(d.id))}">
<select name="correctTier" class="v-input" style="width:auto;min-height:34px;padding:5px 10px;font-size:12.5px;">${ROUTING_TIERS.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
<button type="submit" class="v-btn v-btn-primary v-btn-sm">Label</button>
</form></td></tr>`;
          })
          .join('')}</tbody></table></div>`;

  const cardRowList = await Promise.all(
    cards.slice(0, 100).map(async (card) => {
      const gaps = await describeCardReadOnly(db, comp, tenant, card.id)
        .then((d) => d.trustGaps)
        .catch((): string[] => []);
      const gapCell =
        gaps.length === 0
          ? '<span class="v-badge v-badge-good">none</span>'
          : `<span class="v-badge v-badge-warn">${gaps.length} open</span>`;
      return `<tr>
<td><a href="/console/learning/${esc(encodeURIComponent(card.id))}"><code>${esc(card.id)}</code></a></td>
<td><strong>${esc(card.intent)}</strong></td>
<td><span class="v-badge">${esc(card.state)}</span> <span class="v-meta">v${card.version}</span></td>
<td>${gapCell}</td></tr>`;
    }),
  );
  const cardRows =
    cards.length === 0
      ? '<div class="v-empty" style="margin-top:12px;"><h3>No skill cards yet</h3><p>Cards appear after repeated successful procedures are mined; <a href="/console/learning/compile">compile one</a> to create the first card.</p></div>'
      : `<div class="v-table-wrap"><table class="v-table"><thead><tr><th>card</th><th>intent</th><th>state</th><th>trust gaps</th></tr></thead><tbody>${cardRowList.join('')}</tbody></table></div>`;

  return `<div class="v-page-head">
  <div>
    <p class="v-eyebrow">System</p>
    <h1 class="v-page-title">Learning review</h1>
    <p class="v-sub" style="margin-top:6px;">Label routing decisions and inspect why each skill card is not trusted yet. Linking evidence never promotes a card. <a href="/console/learning/compile">Compile a mined candidate</a>, and queue transfer evidence from a card's page.</p>
  </div>
  <a class="v-btn v-btn-secondary v-btn-sm" href="/console/workflows">← Workflows</a>
</div>
${labeledNotice(opts.notice)}
<div class="v-list-group">
  <h2>Labeling queue (${queue.length})</h2>
  ${queueRows}
</div>
<div class="v-list-group">
  <h2>Skill cards (${cards.length})</h2>
  ${cardRows}
</div>`;
}

export interface CompilePageOptions {
  csrf: string;
  home: string;
  error?: string;
  notice?: string;
}

/**
 * The compile form for mined candidates.
 *
 * Each candidate states what the evidence supports (scopes, models, tiers, the
 * traces that would be cited) and, when it cannot be compiled, why not. The
 * fields the operator fills in describe a procedure — the evidence fields are
 * shown as fact, not offered as input.
 */
export function renderCompilePage(candidates: CompileCandidate[], opts: CompilePageOptions): string {
  const notice = opts.notice ? `<p class="sub" role="status">${esc(opts.notice)}</p>` : '';
  const error = opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : '';
  if (candidates.length === 0) {
    return `<p class="sub"><a href="/console/learning">← Learning review</a></p>
<h1>Compile a skill card</h1>
${notice}${error}
<div class="v-empty"><h3>No candidates yet</h3>
<p>Compilation starts from repeated successes: an intent the router did not doubt, traced successfully at least ${COMPILE_MIN_SUCCESSES} times. Nothing has met that bar for this tenant yet.</p>
<p><a class="v-btn v-btn-secondary v-btn-sm" href="/console/learning">Back to learning review</a></p></div>`;
  }
  const rows = candidates
    .map((c) => {
      if (c.blocked) {
        return `<article class="card"><h3>${esc(c.intent)}</h3>
<p class="sub">${c.repeats} successes · ${(c.successRate * 100).toFixed(0)}% of traces</p>
<p class="err">Not compilable: ${esc(c.blocked)}</p></article>`;
      }
      return `<article class="card"><h3>${esc(c.intent)}</h3>
<p class="sub">${c.repeats} successes · ${(c.successRate * 100).toFixed(0)}% of traces · traces ${esc(c.traceIds.join(', '))}</p>
<p class="sub">Scopes: ${esc(c.scopes.join(', ') || 'none')} · models: ${esc(c.originModels.join(', ') || 'none')} · tiers: ${esc(c.tiers.join(', ') || 'none')}</p>
<form method="post" action="/console/learning/compile">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="intent" value="${esc(c.intent)}">
<label>Scope <select name="scope">${c.scopes.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></label>
<label>Tier validated at <select name="tier">${c.tiers.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></label>
<label>Preconditions (one per line) <textarea name="predicates" rows="2" required placeholder="a release summary exists and is cited"></textarea></label>
<label>Steps (one per line) <textarea name="steps" rows="3" required placeholder="read the cited claims&#10;draft the copy&#10;check every bullet against a live claim"></textarea></label>
<label>Success tests (one per line) <textarea name="tests" rows="2" required placeholder="every bullet cites a live claim"></textarea></label>
<label>Tool grants (comma separated) <input name="toolGrants" placeholder="read_file, write_file"></label>
<button type="submit">Compile candidate</button>
<p class="sub">The card enters CANDIDATE. Trace ids, models and tier come from the evidence above and are re-checked server-side.</p>
</form></article>`;
    })
    .join('\n');
  return `<p class="sub"><a href="/console/learning">← Learning review</a></p>
<h1>Compile a skill card</h1>
<p class="sub">Compiling turns repeated successful traces into a procedure the router may use. It enters CANDIDATE. Promotion still requires transfer evidence and drift watching.</p>
${notice}${error}
${rows}`;
}

export async function renderLearningCardPage(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  cardId: string,
  opts: { csrf?: string; notice?: string; error?: string } = {},
): Promise<string | null> {
  const card = await comp.get(tenant, cardId).catch(() => null);
  if (!card) return null;
  const evidence = await cardEvaluationEvidence(db, comp, tenant, cardId);
  const gaps =
    evidence.trustGaps.length === 0
      ? '<p class="sub">No open trust gaps: this card holds the evidence its state requires.</p>'
      : `<ul>${evidence.trustGaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`;
  const transfers =
    evidence.transfers.length === 0
      ? '<p class="sub">No transfer tests recorded.</p>'
      : `<ul>${evidence.transfers
          .map(
            (t) =>
              `<li>${esc(t.kind)}${t.variant ? ` (${esc(t.variant)})` : ''}: ${t.passed ? 'passed' : '<strong>failed</strong>'} · ${t.score.toFixed(2)} · v${t.cardVersion}${t.evaluator ? ` · ${esc(t.evaluator)}` : ''}</li>`,
          )
          .join('')}</ul>`;
  const runs =
    evidence.runs.length === 0
      ? '<p class="sub">No eval runs recorded for this suite.</p>'
      : `<ul>${evidence.runs
          .map(
            (r) =>
              `<li>${esc(r.id)} · ${esc(r.suite)} · ${r.passed} passed / ${r.failed} failed · ${esc(r.ranAt)}</li>`,
          )
          .join('')}</ul>`;

  // The action that closes the gap this page describes. Without it the panel
  // said "run transfer" and offered nothing to press.
  const transferForm = opts.csrf
    ? `<h3>Run a transfer test</h3>
<p class="sub">Queued as a durable outbox job: the harnesses that produce transfer evidence are attached to a worker, not to this server. A run that fails is recorded as a failed transfer. Negative evidence counts.</p>
<form method="post" action="/console/learning/cards/${esc(encodeURIComponent(card.id))}/transfer-test">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>Target scope <input name="targetScope" required placeholder="a scope other than ${esc(card.originScope)}"></label>
<label>Task command <input name="command" required value="${esc(card.intent)}"></label>
<label>Claim refs (comma separated, at least one) <input name="claimIds" required placeholder="clm_..., clm_..."></label>
<label>Dollar ceiling <input name="maxDollars" type="number" step="0.01" required value="2"></label>
<label>Token ceiling <input name="maxTokens" type="number" required value="20000"></label>
<button type="submit">Queue transfer test</button>
</form>`
    : '';
  const notice = opts.notice ? `<p class="sub" role="status">${esc(opts.notice)}</p>` : '';
  const error = opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : '';
  return `<div class="v-page-head">
  <div>
    <p class="v-eyebrow">Learning review</p>
    <h1 class="v-page-title">${esc(card.intent)}</h1>
    <p class="v-sub" style="margin-top:6px;"><code>${esc(card.id)}</code> · ${esc(card.state)} · v${card.version} · ${esc(card.trustTier)}</p>
  </div>
  <a class="v-btn v-btn-secondary v-btn-sm" href="/console/learning">← Learning review</a>
</div>
${notice}${error}
<p class="v-meta">${esc(evidence.evidenceOnly)}</p>
<h2>Why not trusted yet</h2>
${gaps}
<h2>Transfer tests</h2>
${transfers}
${transferForm}
<h2>Evaluation runs${evidence.evalRef ? ` (${esc(evidence.evalRef)})` : ''}</h2>
${runs}`;
}
