import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import {
  diffDeliverableVersions,
  listDeliverableVersions,
  loadDeliverableByRequest,
  loadDeliverableVersion,
  readDeliverableArtifact,
  type DeliverableItem,
  type DeliverableVersion,
} from '../wedge/deliverable-artifact.ts';
import { operatorFields, REVIEW_SCRIPT, type ReviewOptions } from './review.ts';
import { destructiveConfirm } from './states.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const classLabel = (c: DeliverableItem['classification']): string => {
  switch (c) {
    case 'finding':
      return 'Finding';
    case 'hypothesis':
      return 'Hypothesis';
    case 'unsupported':
      return 'Unsupported';
  }
};

function renderItem(item: DeliverableItem): string {
  const fail = item.checkFailed
    ? `<p style="color:var(--v-risk)"><strong>Check failed:</strong> ${esc(item.checkFailed)}</p>`
    : '';
  const cites =
    item.claimIds.length > 0
      ? `<p><small>Citations: ${item.claimIds.map((id) => `<a href="/console/claims/${esc(encodeURIComponent(id))}"><code>${esc(id)}</code></a>`).join(', ')}</small></p>`
      : '<p><small>No citations</small></p>';
  return `<li><p><strong>${esc(classLabel(item.classification))}</strong> — ${esc(item.text)}</p>${cites}${fail}</li>`;
}

function renderChecks(version: DeliverableVersion): string {
  const draft = version.draftCheck;
  if (draft.ok && !version.items.some((i) => i.checkFailed)) {
    return '<p style="color:var(--v-fact)">All grounding checks passed.</p>';
  }
  const parts: string[] = [];
  if (draft.unverified.length > 0) {
    parts.push(
      `<p><strong>Unverified citations:</strong> ${draft.unverified.map((id) => `<code>${esc(id)}</code>`).join(', ')}</p>`,
    );
  }
  if (draft.deniedPhrases.length > 0) {
    parts.push(
      `<p><strong>Denied phrases:</strong> ${draft.deniedPhrases.map((p) => `<code>${esc(p)}</code>`).join(', ')}</p>`,
    );
  }
  const failed = version.items.filter((i) => i.checkFailed);
  if (failed.length > 0) {
    parts.push(`<p><strong>Item failures:</strong> ${failed.length} item(s) lack sufficient evidence.</p>`);
  }
  return parts.join('') || '<p>Checks did not pass.</p>';
}

function removedHtml(diff: { removed: string[] }): string {
  if (diff.removed.length === 0) return '';
  return `<p><strong>Removed</strong></p><ul>${diff.removed.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function addedHtml(diff: { added: string[] }): string {
  if (diff.added.length === 0) return '';
  return `<p><strong>Added</strong></p><ul>${diff.added.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function renderClaimChips(claims: string[]): string {
  if (claims.length === 0) return '';
  return `<div class="claim-chips" style="margin:8px 0 10px 0;">
<p class="sub" style="margin:0 0 6px 0;font-size:12px;color:var(--v-muted);">
  Referenced evidence claims (click chip to insert <code>[claim:id]</code>):
</p>
<div style="display:flex;flex-wrap:wrap;gap:6px;">
  ${claims
    .map(
      (cid) =>
        `<button type="button" class="claim-chip" data-cite-claim="${esc(cid)}" style="background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:var(--radius-pill);padding:3px 9px;font-size:11px;font-family:var(--font-mono);cursor:pointer;color:var(--v-ink-2);">+ [claim:${esc(cid)}]</button>`,
    )
    .join('')}
</div>
</div>`;
}

const CLAIM_CITE_SCRIPT = `<script>
document.querySelectorAll('button[data-cite-claim]').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    var parent = btn.closest('form') || btn.closest('details') || document;
    var ta = parent.querySelector('textarea[name="content"]');
    if (!ta) return;
    var tag = '[claim:' + btn.getAttribute('data-cite-claim') + ']';
    if (ta.value.indexOf(tag) === -1) {
      ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + tag + ' ';
    }
    ta.focus();
  });
});
</script>`;

export async function renderDeliverableSection(
  db: AsyncDb,
  ledger: Ledger,
  requestId: string,
  opts: ReviewOptions,
  artifactDir?: string,
): Promise<string> {
  const record = await loadDeliverableByRequest(db, opts.tenant, requestId);
  if (!record) {
    const decision = await ledger.getDecisionByRequest(opts.tenant, requestId);
    const reqRow = (await db
      .prepare('SELECT state, deliverable, claim_refs, chain_claims FROM requests WHERE tenant = ? AND id = ?')
      .get(opts.tenant, requestId)) as
      | {
          state?: string;
          deliverable?: string;
          claim_refs?: string;
          chain_claims?: string;
        }
      | undefined;
    const isApproved = Boolean(decision) || reqRow?.state === 'ADMITTED' || reqRow?.state === 'ACCEPTED';
    if (!isApproved) {
      return `<section id="deliverable-section" class="card">
<h2>Deliverable</h2>
<p class="sub"><strong>Status:</strong> Awaiting request approval</p>
<p>Deliverable authoring and submission opens once this request is approved to begin work.</p>
</section>`;
    }
    const defaultSchema = reqRow?.deliverable || 'feature-plan.v1';
    let referencedClaims: string[];
    try {
      const cRefs = reqRow?.claim_refs ? JSON.parse(reqRow.claim_refs) : [];
      const chainRefs = reqRow?.chain_claims ? JSON.parse(reqRow.chain_claims) : [];
      referencedClaims = [...new Set([...cRefs, ...chainRefs])];
    } catch {
      referencedClaims = [];
    }
    const claimChipsHtml = renderClaimChips(referencedClaims);

    return `<section id="deliverable-section" class="card" data-review-request="${esc(requestId)}">
<h2>Deliverable</h2>
<p class="sub"><strong>Status:</strong> Pending deliverable draft from worker or agent</p>
<p>Work was approved to begin. A worker or agent can submit an artifact against schema <code>${esc(defaultSchema)}</code>, or you can draft the initial deliverable below.</p>
<details ${opts.draft ? 'open' : ''}>
<summary><strong>Draft deliverable in-product</strong></summary>
<form method="post" action="/console/requests/${esc(encodeURIComponent(requestId))}/deliverable" style="margin-top:1rem">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label style="display:block;margin-bottom:0.5rem">
Deliverable content
<textarea name="content" rows="6" required style="width:100%;font-family:'JetBrains Mono',monospace;box-sizing:border-box" placeholder="Enter deliverable text. Use [claim:id] to cite evidence claims."></textarea>
</label>
${claimChipsHtml}
<label style="display:block;margin-bottom:0.5rem">
Deliverable schema
<input type="text" name="deliverableSchema" value="${esc(defaultSchema)}" required>
</label>
<label style="display:block;margin-bottom:0.5rem">
<input type="checkbox" name="externalPublish"> External publication (irreversible — approving it records the authorization; it is not posted or deployed by this console)
</label>
<button type="submit">Submit deliverable draft</button>
</form>
${CLAIM_CITE_SCRIPT}
</details>
</section>`;
  }
  const version = await loadDeliverableVersion(db, opts.tenant, record.currentVersionId);
  if (!version) return '';
  const versions = await listDeliverableVersions(db, opts.tenant, record.id);
  let content: string;
  try {
    content = readDeliverableArtifact(version, artifactDir ?? process.env.ARTIFACT_DIR);
  } catch {
    content = '(artifact content unavailable)';
  }

  const versionLinks = versions
    .map(
      (v) =>
        `<a href="/console/deliverables/${esc(encodeURIComponent(record.id))}?version=${v.version}">v${v.version}</a>${v.id === version.id ? ' (viewing)' : ''}`,
    )
    .join(' · ');

  let diffHtml = '';
  if (versions.length > 1) {
    const prev = versions[versions.length - 2]!;
    try {
      const diff = await diffDeliverableVersions(db, opts.tenant, prev.id, version.id, artifactDir);
      diffHtml = `<details><summary>Diff from v${diff.from} → v${diff.to}</summary>
${removedHtml(diff)}
${addedHtml(diff)}
</details>`;
    } catch {
      // Diff unavailable (e.g., artifact not found) — render without diff.
    }
  }

  const canReview = opts.canApprove && (version.status === 'pending_review' || version.status === 'revision_requested');
  let reviewForms: string;
  if (canReview) {
    const externalConfirm = version.externalPublish
      ? `<label style="display:block;margin:0.5rem 0">Type <code>PUBLISH</code> to confirm you are authorizing an irreversible external action — one that you (or an operator) carry out outside this console: <input type="text" name="confirmText" placeholder="PUBLISH" required></label>`
      : '';
    reviewForms = `<form data-review-action="approve-deliverable" action="/api/deliverables/${esc(encodeURIComponent(version.id))}/approve" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="fingerprint" value="${esc(version.fingerprint)}">
${operatorFields(opts, version.id, 'approve-deliverable')}
<label><input type="checkbox" name="confirmed" required> I inspected this exact asset (v${version.version}, fingerprint <code>${esc(version.fingerprint.slice(0, 12))}…</code>) and approve it${version.externalPublish ? ' — understanding that this records the authorization and publishes nothing by itself' : ''}</label>
${externalConfirm}
<button type="submit">Approve deliverable</button>
</form>
<form data-review-action="request-changes" action="/api/deliverables/${esc(encodeURIComponent(version.id))}/request-changes" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>Request changes <textarea name="notes" required maxlength="2000" placeholder="What must change before this can ship?"></textarea></label>
${operatorFields(opts, version.id, 'request-changes')}
<label><input type="checkbox" name="confirmed" required> I reviewed this draft and it needs revision before approval</label>
<button type="submit">Request changes</button>
</form>`;
  } else if (version.status === 'approved') {
    reviewForms = `<p>Final deliverable approved${version.decisionId ? ` — <a href="/console/decisions/${esc(encodeURIComponent(version.decisionId))}">view receipt</a>` : ''}.</p>`;
  } else {
    reviewForms = `<p>Deliverable review requires the ${esc(opts.requiredRole)} role or higher.</p>`;
  }

  let revisionForm = '';
  if (version.status === 'revision_requested') {
    const reqRow = (await db
      .prepare('SELECT claim_refs, chain_claims FROM requests WHERE tenant = ? AND id = ?')
      .get(opts.tenant, requestId)) as
      | {
          claim_refs?: string;
          chain_claims?: string;
        }
      | undefined;
    let referencedClaims: string[];
    try {
      const cRefs = reqRow?.claim_refs ? JSON.parse(reqRow.claim_refs) : [];
      const chainRefs = reqRow?.chain_claims ? JSON.parse(reqRow.chain_claims) : [];
      referencedClaims = [...new Set([...cRefs, ...chainRefs])];
    } catch {
      referencedClaims = [];
    }
    const revisionClaimChips = renderClaimChips(referencedClaims);

    revisionForm = `<details open style="margin-top:1rem">
<summary><strong>Submit revised deliverable (v${version.version + 1})</strong></summary>
<form method="post" action="/console/requests/${esc(encodeURIComponent(requestId))}/deliverable" style="margin-top:0.75rem">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="priorVersionId" value="${esc(version.id)}">
<input type="hidden" name="deliverableSchema" value="${esc(version.deliverableSchema)}">
<label style="display:block;margin-bottom:0.5rem">
Revised content
<textarea name="content" rows="6" required style="width:100%;font-family:'JetBrains Mono',monospace;box-sizing:border-box">${esc(content)}</textarea>
</label>
${revisionClaimChips}
<label style="display:block;margin-bottom:0.5rem">
Revision notes
<input type="text" name="revisionNotes" placeholder="Summary of changes addressed" style="width:100%;box-sizing:border-box">
</label>
<button type="submit">Submit revised draft</button>
</form>
${CLAIM_CITE_SCRIPT}
</details>`;
  }

  const externalNote = version.externalPublish
    ? destructiveConfirm({
        target: 'External publication',
        // Exactly what the code does: it writes a decision. An approval that reads
        // like a deployment is the kind of copy that gets someone to approve
        // something they believe already happened.
        consequences:
          'Irreversible action. Approving records human-command authorization in the ledger — this console does not publish, post, or deploy; the operator performs the external action outside it.',
        retained: 'Audit ledger and decision receipt',
      })
    : '';

  return `<section id="deliverable-review" class="card review-root" data-review-request="${esc(requestId)}">
<h2>Deliverable preview (${esc(version.kind)} · ${esc(version.deliverableSchema)})</h2>
<p>Version ${version.version} · ${esc(version.status)} · ${versionLinks}</p>
${externalNote}
<p>This is the exact asset under review — not only its schema and goal.</p>
<h3>Content</h3>
<p><a href="/api/deliverables/${esc(encodeURIComponent(version.id))}/artifact" download>Download artifact v${version.version}</a></p>
<pre>${esc(content)}</pre>
<h3>Item analysis</h3><ul>${version.items.map(renderItem).join('') || '<li>No structured items parsed</li>'}</ul>
<h3>Grounding checks</h3>${renderChecks(version)}
${version.revisionNotes ? `<p><strong>Revision notes:</strong> ${esc(version.revisionNotes)}</p>` : ''}
${diffHtml}
${reviewForms}
${revisionForm}
<p role="status" aria-live="polite" data-review-status></p>
<noscript><p class="sub">JavaScript disabled: standard full-page form submission is active.</p></noscript>
<script>${REVIEW_SCRIPT}</script>
</section>`;
}

export async function deliverableDetailPage(
  db: AsyncDb,
  ledger: Ledger,
  deliverableId: string,
  versionNum: number | null,
  opts: ReviewOptions,
  artifactDir?: string,
): Promise<string | null> {
  const { loadDeliverableRecord } = await import('../wedge/deliverable-artifact.ts');
  const record = await loadDeliverableRecord(db, opts.tenant, deliverableId);
  if (!record) return null;
  const versions = await listDeliverableVersions(db, opts.tenant, deliverableId);
  if (versionNum !== null && !versions.some((v) => v.version === versionNum)) return null;
  const section = await renderDeliverableSection(db, ledger, record.requestId, opts, artifactDir);
  return `<p class="sub"><a class="v-btn v-btn-secondary v-btn-sm" href="/console/requests/${esc(encodeURIComponent(record.requestId))}">← Back to request</a></p>${section}`;
}
