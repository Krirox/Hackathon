import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { approvalMessage } from '../gov/operator.ts';
import { SAMPLE_REQUEST_PREFIX, SAMPLE_SCOPE } from './activation.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ReviewOptions {
  tenant: string;
  actor: string;
  csrf: string;
  canApprove: boolean;
  requiredRole: string;
  operatorMode: 'session' | 'secret' | 'signature';
  page?: number;
  home?: string;
  notice?: string;
  draft?: boolean;
  /**
   * Skip the document's own <h1> and "signed in as" line. Set by list pages,
   * whose body (renderListPage) already renders the page title — without this
   * the heading and the actor line each appear twice.
   */
  hideHeader?: boolean;
  /**
   * The viewer's name for display (email). Deliberately separate from `actor`,
   * which is the audited, signature-bound `usr_… (email)` value — that one must
   * keep its exact shape, this one is only ever painted.
   */
  actorLabel?: string;
}

export function operatorFields(opts: ReviewOptions, id: string, action: string): string {
  if (opts.operatorMode === 'secret')
    return '<label>Operator secret <input type="password" name="operatorSecret" required autocomplete="off"></label>';
  if (opts.operatorMode !== 'signature') return '';
  const message = approvalMessage(opts.tenant, id, action, opts.actor);
  return `<details><summary>Message to sign with your operator key</summary><pre>${esc(message)}</pre></details><label>Operator signature <input type="password" name="operatorSignature" required autocomplete="off"></label>`;
}

/** Token-scoped queue styles (design.md Workbench voice). Logic untouched. */
export const REVIEW_STYLE = `<style>
.rv-queue{font-family:var(--font-body)}
.rv-eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--v-muted)}
.rv-title{font-size:18px;font-weight:700;margin:2px 0 0;color:var(--v-ink);font-style:normal}
.rv-actor{font-size:12px;color:var(--v-muted);margin:6px 0 0}
.rv-note{font-size:11.5px;color:var(--v-faint);margin:4px 0 0;max-width:70ch}
.rv-pager{font-size:12px;color:var(--v-muted);margin:10px 0;display:flex;gap:12px;align-items:center}
.rv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:12px;margin-top:12px}
.rv-card{background:var(--v-bg-1);border:1px solid var(--v-line);border-left:3px solid var(--v-hypo);border-radius:var(--radius-card);padding:14px 16px;box-shadow:var(--v-card-shadow)}
.rv-card h3{font-size:13.5px;font-weight:700;margin:0 0 4px;font-style:normal}
.rv-card h3 a{color:var(--v-ink);text-decoration:none}
.rv-card h3 a:hover{color:var(--v-accent)}
.rv-meta{font-size:11px;color:var(--v-faint);font-family:var(--font-mono);overflow-wrap:anywhere}
.rv-row{font-size:12px;color:var(--v-ink-2);margin:6px 0 0}
.rv-evidence{background:var(--v-tint-prose-bg);border:1px solid var(--v-line);border-radius:8px;padding:8px 10px;margin:8px 0 0;font-size:12px}
.rv-evidence summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--v-ink)}
.rv-evidence ul{margin:8px 0 0;padding-left:18px;display:grid;gap:6px}
.rv-evidence code{font-family:var(--font-mono);font-size:11px}
.rv-forms{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.rv-forms form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rv-forms button{border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;min-height:36px}
.rv-approve button{background:var(--v-accent);color:var(--v-accent-ink);border:0}
.rv-approve button:hover{filter:brightness(1.1)}
.rv-decline button{background:transparent;color:var(--v-ink);border:1px solid var(--v-line-strong)}
.rv-decline button:hover{border-color:var(--v-risk)}
.rv-empty{border:1px dashed var(--v-line-strong);border-radius:var(--radius-card);padding:28px 20px;text-align:center;color:var(--v-muted);font-size:13px;background:transparent}
.rv-refresh{font-size:12px;margin-top:10px;display:inline-block}
</style>`;

/** Session-specific controls must never enter the shared report cache or static exports. */
export async function renderReview(coord: Coordinator, ledger: Ledger, opts: ReviewOptions): Promise<string> {
  const pending = (await coord.list(opts.tenant, { state: 'ADMITTED' })).filter(
    (r) => r.messageClass === 'REQUEST' && r.bid.humanMinutes > 0,
  );
  const cards: string[] = [];
  const page = Math.min(opts.page ?? 0, Math.max(0, Math.ceil(pending.length / 100) - 1));
  for (const r of pending.slice(page * 100, (page + 1) * 100)) {
    const evidence: string[] = [];
    for (const id of r.claimRefs.slice(0, 20)) {
      const c = await ledger.get(opts.tenant, id);
      evidence.push(
        c
          ? `<li><a href="/console/claims/${esc(encodeURIComponent(id))}"><code>${esc(id)}</code></a> · ${esc(c.kind)} · ${esc(c.status)}<br>${esc(c.statement)}<br><small>Source: ${esc(c.provenance.sourceUri)}</small></li>`
          : `<li><code>${esc(id)}</code> — unavailable evidence; review before approving</li>`,
      );
    }
    const forms = opts.canApprove
      ? ['approve', 'decline']
          .map((action) => {
            return `<form class="${action === 'approve' ? 'rv-approve' : 'rv-decline'}" data-review-action="${action}" action="/api/requests/${esc(encodeURIComponent(r.id))}/${action}" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="requestUpdatedAt" value="${esc(r.updatedAt)}">
${action === 'decline' ? '<label>Decline reason <textarea name="reason" required maxlength="2000"></textarea></label>' : ''}
${operatorFields(opts, r.id, action)}
<label><input type="checkbox" name="confirmed" required> ${action === 'approve' ? 'I reviewed the evidence and approve beginning work on this request' : 'I confirm this request should be declined'}</label>
<button type="submit">${action === 'approve' ? 'Approve' : 'Decline'}</button>
</form>`;
          })
          .join('')
      : `<p>Review requires the ${esc(opts.requiredRole)} role or higher.</p>`;
    const sampleBanner =
      r.id.startsWith(SAMPLE_REQUEST_PREFIX) || r.originScope === SAMPLE_SCOPE
        ? `<p style="background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);padding:8px 10px;border-radius:8px;font-weight:700;font-size:12px;border:1px solid var(--v-line);">SAMPLE WALKTHROUGH — labeled demo data in scope ${esc(SAMPLE_SCOPE)}, not customer evidence.</p>`
        : '';
    cards.push(`<article class="rv-card" data-review-request="${esc(r.id)}">
${sampleBanner}
<h3><a href="/console/requests/${esc(encodeURIComponent(r.id))}">${esc(r.goal)}</a></h3><p class="rv-meta">${esc(r.id)} · ${esc(r.originScope)} → ${esc(r.targetScope)}</p>
<p class="rv-row">Deliverable: ${esc(r.deliverableSchema)} · Deadline: ${esc(r.bid.deadline)}</p>
<p class="rv-row">Budget: ${r.bid.dollars} dollars · ${r.bid.tokens} tokens · ${r.bid.humanMinutes} human minutes</p>
<details class="rv-evidence"><summary>Evidence (${r.claimRefs.length} references)</summary><ul>${evidence.join('') || '<li>No evidence references</li>'}</ul>${r.claimRefs.length > 20 ? `<p>Only the first 20 references are shown. <a href="/console/requests/${esc(encodeURIComponent(r.id))}">Inspect all evidence before approving.</a></p>` : ''}</details>
<div class="rv-forms">${forms}</div><p role="status" aria-live="polite" data-review-status></p></article>`);
  }
  return `${REVIEW_STYLE}<section id="pending-review" class="review-root rv-queue"><p class="rv-eyebrow">Approval queue · ${pending.length} awaiting</p><h2 class="rv-title">Pending review</h2>
<p class="rv-actor">Signed in as ${esc(opts.actorLabel ?? opts.actor)}</p>
<p class="rv-note">Approval records a decision to BEGIN work, not final-deliverable authorization or evidence of execution or measurement.</p>
<nav class="rv-pager" aria-label="Review pages">${page > 0 ? `<a href="${esc(opts.home ?? '/')}?reviewPage=${page - 1}#pending-review">Previous reviews</a>` : ''}<span>Page ${page + 1} of ${Math.max(1, Math.ceil(pending.length / 100))}</span>${pending.length > (page + 1) * 100 ? `<a href="${esc(opts.home ?? '/')}?reviewPage=${page + 1}#pending-review">Next reviews</a>` : ''}</nav>
<noscript><p class="sub">JavaScript disabled: standard full-page form submission is active.</p></noscript>
<div class="rv-grid">${cards.join('') || '<div class="rv-empty">Queue clear — no admitted requests awaiting human review.</div>'}</div>
<p><a class="rv-refresh" href="#" data-review-refresh>Refresh review queue</a></p></section>
<script>${REVIEW_SCRIPT}</script>`;
}

// Static script: tenant, request, evidence, and credentials are never interpolated into JavaScript.
export const REVIEW_SCRIPT = `
(() => {
  // Every review section on the page gets its own wiring: a claim page can
  // carry both a correction and a verification section, and the deliverable
  // section lives under its own id. A single getElementById root left every
  // section but the first permanently disabled.
  const roots = document.querySelectorAll('.review-root');
  let storage = null;
  try { storage = sessionStorage; } catch { /* private mode / tests */ }
  const draftKey = (form) => 'vital:draft:' + form.action;
  const saveDraft = (form, fields) => {
    if (!storage) return;
    const draft = {};
    const statement = fields.get('statement');
    const reason = fields.get('reason');
    if (statement) draft.statement = String(statement);
    if (reason) draft.reason = String(reason);
    if (Object.keys(draft).length) storage.setItem(draftKey(form), JSON.stringify(draft));
  };
  roots.forEach(root => {
  const restoreDrafts = () => {
    if (!storage) return;
    root.querySelectorAll('form[data-review-action]').forEach(form => {
      const raw = storage.getItem(draftKey(form));
      if (!raw) return;
      try {
        const draft = JSON.parse(raw);
        const statement = form.querySelector('[name="statement"]');
        const reason = form.querySelector('[name="reason"]');
        if (statement && draft.statement) statement.value = draft.statement;
        if (reason && draft.reason) reason.value = draft.reason;
      } catch { /* ignore corrupt drafts */ }
    });
  };
  restoreDrafts();
  root.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = false; });
  const refresh = root.querySelector('[data-review-refresh]');
  if (refresh) refresh.addEventListener('click', event => {
    event.preventDefault(); location.reload();
  });
  root.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-review-action]')) return;
    event.preventDefault();
    const card = form.closest('[data-review-request]') || form.closest('#deliverable-review');
    if (!card || card.dataset.busy === 'true' || card.dataset.settled === 'true' || !form.reportValidity()) return;
    const fields = new FormData(form);
    const status = card.querySelector('[data-review-status]');
    const action = form.dataset.reviewAction;
    const headers = { 'content-type': 'application/json', 'x-vital-csrf': fields.get('csrf') };
    if (fields.has('operatorSecret')) headers['x-vital-operator'] = fields.get('operatorSecret');
    if (fields.has('operatorSignature')) headers['x-vital-signature'] = fields.get('operatorSignature');
    if (action === 'correct' && fields.get('valueMode') === 'number' &&
            (!String(fields.get('value') ?? '').trim() || !Number.isFinite(Number(fields.get('value'))))) {
          status.textContent = 'Enter a finite numeric value, or choose Clear value and unit.';
          return;
        }
        const controls = card.querySelectorAll('input, textarea, select, button');
    card.dataset.busy = 'true'; card.setAttribute('aria-busy', 'true');
    controls.forEach(control => { control.disabled = true; });
    status.textContent = 'Submitting ' + action + '…';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify(action === 'correct' ? {
                  statement: fields.get('statement'),
                  expectedSeq: Number(fields.get('expectedSeq') ?? form.dataset.claimSeq),
                  ...(fields.get('valueMode') === 'number' ? { value: fields.get('value'), unit: fields.get('unit') || null } : {}),
                  ...(fields.get('valueMode') === 'clear' ? { value: null, unit: null } : {}),
                } : action === 'refresh-evidence' ? {}
                : action === 'approve-deliverable' ? { fingerprint: fields.get('fingerprint') || '' }
                : action === 'request-changes' ? { notes: fields.get('notes') || '' }
                : {
                  reason: fields.get('reason') || '',
                  requestUpdatedAt: fields.get('requestUpdatedAt') || undefined,
                }), signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 && result.code === 'SESSION_EXPIRED') {
          saveDraft(form, fields);
          const link = document.createElement('a');
          link.href = result.loginUrl || '/login?reason=expired';
          link.textContent = 'Sign in to continue';
          status.textContent = (result.error || 'Your session expired.') + ' ';
          status.appendChild(link);
          status.appendChild(document.createTextNode(' — your draft is preserved. Submit again after signing in.'));
          return;
        }
        if (action === 'correct' && result.conflict) {
          const parts = [result.error || 'Another editor saved first.'];
          if (result.diff) parts.push('Winner: "' + result.diff.after + '" (was "' + result.diff.before + '").');
          if (result.preservedDraft) {
            const draft = form.querySelector('[name="statement"]');
            if (draft) draft.value = result.preservedDraft.statement;
          }
          if (result.winner && result.winner.id) {
            const winner = document.createElement('a');
            winner.href = '/console/claims/' + encodeURIComponent(result.winner.id);
            winner.textContent = 'View winning correction';
            status.textContent = parts.join(' ') + ' Your draft is preserved. ';
            status.appendChild(winner);
          } else {
            status.textContent = parts.join(' ') + ' Your draft is preserved — refresh, then retry on the current claim.';
          }
          return;
        }
        if (response.status === 409 && result.requiresReReview === true) {
          saveDraft(form, fields);
          const parts = [result.error || 'Changed since you loaded this review.'];
          if (Array.isArray(result.diff)) {
            for (const line of result.diff) {
              if (typeof line === 'string' && line) parts.push(line);
            }
          }
          if (result.preservedDraft && typeof result.preservedDraft.reason === 'string') {
            const reason = form.querySelector('[name="reason"]');
            if (reason) reason.value = result.preservedDraft.reason;
          }
          status.textContent = parts.join(' ') + ' Your input is preserved — refresh, review the changes, and submit again.';
          return;
        }
        throw new Error(result.error || 'Request failed (' + response.status + ')');
      }
      if (storage) storage.removeItem(draftKey(form));
      if (action === 'correct') {
        if (!result.ok || typeof result.supersededBy !== 'string') throw new Error('Unexpected correction response. Refresh to check the claim.');
        card.dataset.settled = 'true';
        let msg = 'Correction saved. ' + (result.evalCaseId ? 'Regression case recorded. ' : 'Regression capture is pending; contact an operator. ');
        if (Array.isArray(result.affectedRequests) && result.affectedRequests.length > 0) {
          msg += result.affectedRequests.length + ' pending request(s) may need evidence refresh. ';
        }
        status.textContent = msg;
        const link = document.createElement('a');
        link.href = '/console/claims/' + encodeURIComponent(result.supersededBy);
        link.textContent = 'View corrected claim';
        status.appendChild(link);
        return;
      }
      if (action === 'refresh-evidence') {
        card.dataset.settled = 'true';
        status.textContent = 'Evidence refreshed to current claim replacements. Re-review before approving.';
        return;
      }
      if (action === 'approve-deliverable') {
        card.dataset.settled = 'true';
        status.textContent = 'Final deliverable approved for this asset version. ';
        if (typeof result.decisionId === 'string') {
          const link = document.createElement('a');
          link.href = '/console/decisions/' + encodeURIComponent(result.decisionId);
          link.textContent = 'View publication receipt';
          status.appendChild(link);
        }
        return;
      }
      if (action === 'request-changes') {
        card.dataset.settled = 'true';
        status.textContent = 'Revision requested — submit an updated deliverable tied to this workflow before final approval.';
        return;
      }
      if (action === 'verify') {
        if (!result.ok || typeof result.id !== 'string') throw new Error('Unexpected verification response. Refresh to check the claim.');
        card.dataset.settled = 'true';
        status.textContent = 'Evidence verified as human-curated. Cited work can now proceed to approval — refresh to see the updated status. ';
        const link = document.createElement('a');
        link.href = '/console/claims/' + encodeURIComponent(result.id);
        link.textContent = 'View verified claim';
        status.appendChild(link);
        return;
      }
      const expected = action === 'approve' ? 'ACCEPTED' : 'DECLINED';
      if (result.state !== expected) throw new Error('Unexpected state. Refresh to check the request.');
      card.dataset.settled = 'true';
      status.textContent = action === 'approve' ? 'Approved to BEGIN work — not final-deliverable authorization or evidence of execution or measurement. Refresh for updated status. ' : 'Declined. Refresh to update the queue.';
      if (action === 'approve' && typeof result.decisionId === 'string') {
        const link = document.createElement('a');
        link.href = '/console/decisions/' + encodeURIComponent(result.decisionId);
        link.textContent = 'View approval receipt';
        status.appendChild(link);
      }
    } catch (error) {
      status.textContent = error.name === 'AbortError'
        ? 'Timed out. The decision may have landed; refresh before retrying.'
        : error.message + ' Refresh to check current state before retrying.';
    } finally {
      clearTimeout(timer);
      form.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
      card.dataset.busy = 'false'; card.removeAttribute('aria-busy');
      if (card.dataset.settled !== 'true') controls.forEach(control => { control.disabled = false; });
    }
  });
  });
})();`;
