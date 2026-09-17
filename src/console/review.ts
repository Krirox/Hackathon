import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { approvalMessage } from '../gov/operator.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ReviewOptions {
  tenant: string;
  actor: string;
  csrf: string;
  canApprove: boolean;
  requiredRole: string;
  operatorMode: 'session' | 'secret' | 'signature';
}

/** Session-specific controls must never enter the shared report cache or static exports. */
export async function renderReview(coord: Coordinator, ledger: Ledger, opts: ReviewOptions): Promise<string> {
  const pending = (await coord.list(opts.tenant, { state: 'ADMITTED' })).filter(
    (r) => r.messageClass === 'REQUEST' && r.bid.humanMinutes > 0,
  );
  const cards: string[] = [];
  for (const r of pending.slice(0, 100)) {
    const evidence: string[] = [];
    for (const id of r.claimRefs.slice(0, 20)) {
      const c = await ledger.get(opts.tenant, id);
      evidence.push(
        c
          ? `<li><code>${esc(id)}</code> · ${esc(c.kind)} · ${esc(c.status)}<br>${esc(c.statement)}<br><small>Source: ${esc(c.provenance.sourceUri)}</small></li>`
          : `<li><code>${esc(id)}</code> — unavailable evidence; review before approving</li>`,
      );
    }
    const forms = opts.canApprove
      ? ['approve', 'decline']
          .map((action) => {
            const message =
              opts.operatorMode === 'signature' ? approvalMessage(opts.tenant, r.id, action, opts.actor) : null;
            return `<form data-review-action="${action}" action="/api/requests/${esc(encodeURIComponent(r.id))}/${action}" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
${action === 'decline' ? '<label>Decline reason <textarea name="reason" required maxlength="2000"></textarea></label>' : ''}
${opts.operatorMode === 'secret' ? '<label>Operator secret <input type="password" name="operatorSecret" required autocomplete="off"></label>' : ''}
${message === null ? '' : `<details><summary>Message to sign with your operator key</summary><pre>${esc(message)}</pre></details><label>Operator signature <input type="password" name="operatorSignature" required autocomplete="off"></label>`}
<label><input type="checkbox" name="confirmed" required> ${action === 'approve' ? 'I reviewed the evidence and approve this request' : 'I confirm this request should be declined'}</label>
<button type="submit" disabled>${action === 'approve' ? 'Approve' : 'Decline'}</button>
</form>`;
          })
          .join('')
      : `<p>Review requires the ${esc(opts.requiredRole)} role or higher.</p>`;
    cards.push(`<article class="card" data-review-request="${esc(r.id)}">
<h3>${esc(r.goal)}</h3><p><code>${esc(r.id)}</code> · ${esc(r.originScope)} → ${esc(r.targetScope)}</p>
<p>Deliverable: ${esc(r.deliverableSchema)} · Deadline: ${esc(r.bid.deadline)}</p>
<p>Budget: ${r.bid.dollars} dollars · ${r.bid.tokens} tokens · ${r.bid.humanMinutes} human minutes</p>
<details><summary>Evidence (${r.claimRefs.length} references)</summary><ul>${evidence.join('') || '<li>No evidence references</li>'}</ul>${r.claimRefs.length > 20 ? '<p>Only the first 20 references are shown; inspect remaining evidence before approving.</p>' : ''}</details>
${forms}<p role="status" aria-live="polite" data-review-status></p></article>`);
  }
  return `<section id="pending-review"><h2>Pending review (${pending.length})</h2>
<p>Signed in as ${esc(opts.actor)}. Approval records a decision; it does not mean execution has finished.</p>
${pending.length > 100 ? '<p>Showing the first 100 requests. Refresh after reviewing to see remaining work.</p>' : ''}
<noscript>JavaScript is required for these controls. No request is sent without it.</noscript>
<div class="grid">${cards.join('') || '<p>No admitted requests awaiting human review.</p>'}</div>
<p><a href="#" data-review-refresh>Refresh review queue</a></p></section>
<script>${REVIEW_SCRIPT}</script>`;
}

// Static script: tenant, request, evidence, and credentials are never interpolated into JavaScript.
export const REVIEW_SCRIPT = `
(() => {
  const root = document.getElementById('pending-review');
  root.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = false; });
  root.querySelector('[data-review-refresh]').addEventListener('click', event => {
    event.preventDefault(); location.reload();
  });
  root.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-review-action]')) return;
    event.preventDefault();
    const card = form.closest('[data-review-request]');
    if (card.dataset.busy === 'true' || card.dataset.settled === 'true' || !form.reportValidity()) return;
    const fields = new FormData(form);
    const status = card.querySelector('[data-review-status]');
    const action = form.dataset.reviewAction;
    const headers = { 'content-type': 'application/json', 'x-vital-csrf': fields.get('csrf') };
    if (fields.has('operatorSecret')) headers['x-vital-operator'] = fields.get('operatorSecret');
    if (fields.has('operatorSignature')) headers['x-vital-signature'] = fields.get('operatorSignature');
    const controls = card.querySelectorAll('input, textarea, button');
    card.dataset.busy = 'true'; card.setAttribute('aria-busy', 'true');
    controls.forEach(control => { control.disabled = true; });
    status.textContent = 'Submitting ' + action + '…';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ reason: fields.get('reason') || '' }), signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed (' + response.status + ')');
      const expected = action === 'approve' ? 'ACCEPTED' : 'DECLINED';
      if (result.state !== expected) throw new Error('Unexpected state. Refresh to check the request.');
      card.dataset.settled = 'true';
      status.textContent = action === 'approve' ? 'Approved — awaiting execution. Refresh for updated status.' : 'Declined. Refresh to update the queue.';
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
})();`;
