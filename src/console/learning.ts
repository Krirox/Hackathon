import type { AsyncDb } from '../core/db.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { cardEvaluationEvidence, describeCardReadOnly } from '../compiler/registry.ts';
import type { CognitiveRouter } from '../router/router.ts';

/**
 * FINAL-004: the human surface for learning review.
 *
 * Before this page the only links offered to humans pointed at the JSON APIs
 * (`/api/learning/cards/:id`), which render as an unstyled blob in a browser.
 * These are read/act pages: the labeling queue labels a routing decision, and
 * a card page shows why a card is not trusted yet. Linking evidence never
 * promotes a card — promotion still runs only through the transfer path.
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
  return `<p class="sub" role="status">${esc(notice)}</p>`;
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
      ? '<p class="sub">No unlabeled routing decisions. The queue fills as the router makes shadow decisions.</p>'
      : `<table class="stacked"><thead><tr class="sub"><th align="left">decision</th><th align="left">task</th><th align="left">proposed → executed</th><th align="left">evidence</th><th align="left">label</th></tr></thead><tbody>${queue
          .map((d) => {
            const rate = d.evidence.successRate === null ? '—' : `${(d.evidence.successRate * 100).toFixed(0)}%`;
            return `<tr>
<td>${esc(String(d.id))}</td>
<td>${esc(d.taskType)} <span class="sub">· ${esc(d.scope)}</span></td>
<td>${esc(d.proposed)} → ${esc(d.executed)}</td>
<td class="sub">${d.evidence.traces} traces · ${rate}</td>
<td><form method="post" action="/console/learning/label" style="display:inline">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="decisionId" value="${esc(String(d.id))}">
<select name="correctTier">${ROUTING_TIERS.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
<button type="submit">Label</button>
</form></td></tr>`;
          })
          .join('')}</tbody></table>`;

  const cardRowList = await Promise.all(
    cards.slice(0, 100).map(async (card) => {
      const gaps = await describeCardReadOnly(db, comp, tenant, card.id)
        .then((d) => d.trustGaps)
        .catch((): string[] => []);
      const gapText = gaps.length === 0 ? '—' : `${gaps.length} open`;
      return `<tr>
<td><a href="/console/learning/${esc(encodeURIComponent(card.id))}">${esc(card.id)}</a></td>
<td>${esc(card.intent)}</td>
<td>${esc(card.state)} <span class="sub">v${card.version}</span></td>
<td class="sub">${esc(gapText)}</td></tr>`;
    }),
  );
  const cardRows =
    cards.length === 0
      ? '<p class="sub">No skill cards yet. Cards appear after repeated successful procedures are mined.</p>'
      : `<table class="stacked"><thead><tr class="sub"><th align="left">card</th><th align="left">intent</th><th align="left">state</th><th align="left">trust gaps</th></tr></thead><tbody>${cardRowList.join('')}</tbody></table>`;

  return `<p class="sub"><a href="/console/workflows">← Workflows</a></p>
<h1>Learning review</h1>
<p class="sub">Signed in as ${esc(opts.actor)}. Label routing decisions and inspect why each skill card is not trusted yet. Linking evidence never promotes a card.</p>
${labeledNotice(opts.notice)}
<h2>Labeling queue (${queue.length})</h2>
${queueRows}
<h2>Skill cards (${cards.length})</h2>
${cardRows}`;
}

export async function renderLearningCardPage(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  cardId: string,
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
              `<li>${esc(t.kind)}${t.variant ? ` (${esc(t.variant)})` : ''} — ${t.passed ? 'passed' : '<strong>failed</strong>'} · ${t.score.toFixed(2)} · v${t.cardVersion}${t.evaluator ? ` · ${esc(t.evaluator)}` : ''}</li>`,
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

  return `<p class="sub"><a href="/console/learning">← Learning review</a></p>
<h1>${esc(card.intent)}</h1>
<p><code>${esc(card.id)}</code> · ${esc(card.state)} · v${card.version} · ${esc(card.trustTier)}</p>
<p class="sub">${esc(evidence.evidenceOnly)}</p>
<h2>Why not trusted yet</h2>
${gaps}
<h2>Transfer tests</h2>
${transfers}
<h2>Evaluation runs${evidence.evalRef ? ` (${esc(evidence.evalRef)})` : ''}</h2>
${runs}`;
}
