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
    ? `<p style="color:#B91C1C"><strong>Check failed:</strong> ${esc(item.checkFailed)}</p>`
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
    return '<p style="color:#0F7A3D">All grounding checks passed.</p>';
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

export async function renderDeliverableSection(
  db: AsyncDb,
  ledger: Ledger,
  requestId: string,
  opts: ReviewOptions,
  artifactDir?: string,
): Promise<string> {
  const record = await loadDeliverableByRequest(db, opts.tenant, requestId);
  if (!record) return '';
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
    reviewForms = `<form data-review-action="approve-deliverable" action="/api/deliverables/${esc(encodeURIComponent(version.id))}/approve" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="fingerprint" value="${esc(version.fingerprint)}">
${operatorFields(opts, version.id, 'approve-deliverable')}
<label><input type="checkbox" name="confirmed" required> I inspected this exact asset (v${version.version}, fingerprint <code>${esc(version.fingerprint.slice(0, 12))}…</code>) and approve publication</label>
<button type="submit" disabled>Approve deliverable</button>
</form>
<form data-review-action="request-changes" action="/api/deliverables/${esc(encodeURIComponent(version.id))}/request-changes" method="post">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>Request changes <textarea name="notes" required maxlength="2000" placeholder="What must change before this can ship?"></textarea></label>
${operatorFields(opts, version.id, 'request-changes')}
<label><input type="checkbox" name="confirmed" required> I reviewed this draft and it needs revision before approval</label>
<button type="submit" disabled>Request changes</button>
</form>`;
  } else if (version.status === 'approved') {
    reviewForms = `<p>Final deliverable approved${version.decisionId ? ` — <a href="/console/decisions/${esc(encodeURIComponent(version.decisionId))}">view receipt</a>` : ''}.</p>`;
  } else {
    reviewForms = `<p>Deliverable review requires the ${esc(opts.requiredRole)} role or higher.</p>`;
  }

  const externalNote = version.externalPublish
    ? '<p><strong>External publish</strong> — irreversible action; approval records human-command authorization only.</p>'
    : '';

  return `<section id="deliverable-review" class="card" data-review-request="${esc(requestId)}">
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
<p role="status" aria-live="polite" data-review-status></p>
<noscript>JavaScript is required for deliverable approval controls.</noscript>
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
  return `<p><a href="/console/requests/${esc(encodeURIComponent(record.requestId))}">Back to request</a></p>${section}`;
}
