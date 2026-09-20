import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { parseExecutionSpecFromDecision } from '../coord/execution-spec.ts';
import { renderDeliverableSection } from './deliverable.ts';
import { claimDetailUrl, requestDetailUrl } from './render.ts';
import type { DetailNavContext } from './render.ts';
import { operatorFields, REVIEW_SCRIPT, type ReviewOptions } from './review.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const claimUrl = (id: string): string => `/console/claims/${encodeURIComponent(id)}`;
const dump = (value: unknown): string => esc(JSON.stringify(value ?? null, null, 2));
const PAGE_SIZE = 20;

function pagination(path: string, page: number, total: number, returnTo?: string): string {
  const suffix = returnTo ? `&amp;return=${encodeURIComponent(returnTo)}` : '';
  return `<nav aria-label="Evidence pages">${page > 0 ? `<a href="${esc(path)}?page=${page - 1}${suffix}">Previous evidence</a>` : ''}
Page ${page + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}
${(page + 1) * PAGE_SIZE < total ? `<a href="${esc(path)}?page=${page + 1}${suffix}">Next evidence</a>` : ''}</nav>`;
}

export function parseDetailNav(search: string): { page: number; returnTo: string | null; requestId: string | null } {
  const params = new URLSearchParams(search);
  const rawPage = Number(params.get('page') ?? '0');
  const page = Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
  const rawReturn = params.get('return');
  const returnTo = rawReturn !== null && rawReturn.startsWith('/') ? rawReturn : null;
  const requestId = params.get('requestId');
  return { page, returnTo, requestId };
}

export function detailBackTarget(returnTo: string | null | undefined, home: string): string {
  if (returnTo && returnTo.startsWith('/')) {
    return returnTo;
  }
  return home;
}

/** Lineage tag without nested ternaries: current beats historical beats raw status. */
function lineageTag(id: string, status: string, currentId: string | undefined): string {
  if (id === currentId) return 'current';
  if (status === 'SUPERSEDED') return 'historical';
  return status;
}

/** Human phase label for a request state without nested ternaries. */
export function requestPhase(state: string, humanMinutes: number): string {
  if (state === 'ADMITTED' && humanMinutes > 0) return 'Pending human review';
  if (state === 'ACCEPTED') return 'Approved: awaiting execution';
  if (state === 'IN_FLIGHT') return 'Executing';
  if (state === 'COMPLETED') return 'Executed; measurement may still be pending';
  return state;
}

export function detailDocument(title: string, body: string, opts: ReviewOptions): string {
  // List pages own their heading (renderListPage renders the page title and the
  // result count), so they pass hideHeader and this header is skipped —
  // otherwise the title and the actor line each appeared twice on the page.
  const header = opts.hideHeader
    ? ''
    : `<h1>${esc(title)}</h1><p class="v-sub" style="font-size:13px">Signed in as <strong style="color:var(--v-ink)">${esc(opts.actorLabel ?? opts.actor)}</strong></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Vital</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>body{font-family:var(--font-body);font-size:14px;line-height:1.5;background:var(--v-bg-0);color:var(--v-ink);margin:0 auto;padding:28px 20px;max-width:960px;letter-spacing:-0.011em;-webkit-font-smoothing:antialiased}
h1{font-size:30px;font-weight:700;letter-spacing:-0.02em;font-style:normal}
h2{font-size:20px;font-weight:650;font-style:normal}
a{color:var(--v-accent);text-decoration:none}a:hover{text-decoration:underline}
body>a:first-of-type+a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:8px;font-size:13px;font-weight:500;color:var(--v-accent);margin-bottom:16px;box-shadow:var(--v-card-shadow)}
body>a:first-of-type+a:hover{background:var(--v-bg-2);border-color:var(--v-line-strong);text-decoration:none}
pre{font-family:var(--font-mono);font-size:12px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:8px;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:var(--font-mono);font-size:12px;background:var(--v-bg-2);padding:2px 5px;border-radius:4px}
label{display:block;margin:12px 0;font-weight:500;font-size:13px;color:var(--v-ink-2)}
input,textarea,select{width:100%;box-sizing:border-box;border:1px solid var(--v-line-strong);border-radius:10px;padding:9px 12px;background:var(--v-input-bg);color:var(--v-ink);transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{border-color:var(--v-accent);box-shadow:0 0 0 3px var(--v-accent-dim);outline:none}
button{background:var(--v-accent);color:var(--v-accent-ink);font-weight:600;padding:9px 16px;border-radius:10px;border:0;cursor:pointer;transition:filter .15s ease}
button:hover{filter:brightness(1.07)}
button:disabled{opacity:.55;cursor:not-allowed}
article{border:1px solid var(--v-line);border-radius:var(--radius-card);padding:20px;margin:16px 0;background:var(--v-bg-1);box-shadow:var(--v-card-shadow)}
nav a{margin-right:16px}dt{font-weight:600;color:var(--v-ink-2)}dd{margin-bottom:12px}
a.skip-link{position:absolute;left:-9999px;top:0;background:var(--v-accent);color:var(--v-accent-ink);padding:8px 14px;z-index:100;border-radius:0 0 6px 0}a.skip-link:focus{left:0}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--v-focus);outline-offset:2px}
.error-summary{border:1px solid var(--v-line);border-left:3px solid var(--v-risk);border-radius:8px;padding:12px 16px;margin:12px 0;background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink)}
.success{border:1px solid var(--v-line);border-left:3px solid var(--v-fact);border-radius:8px;padding:12px 16px;margin:12px 0;background:var(--v-tint-good-bg);color:var(--v-tint-good-ink)}
@media (max-width:640px){body{padding:16px}h1{font-size:24px}}
input,button,textarea,select{font-family:inherit;font-size:13px}
textarea{min-height:100px}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}.table-wrap{overflow-x:auto;max-width:100%}
.v-table{width:100%;border-collapse:collapse;font-size:13.5px;display:table}
.v-table th{text-align:left;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--v-muted);padding:10px 14px;border-bottom:1px solid var(--v-line);white-space:nowrap}
.v-table td{padding:12px 14px;border-bottom:1px solid var(--v-line);vertical-align:middle}
.v-table tbody tr:hover{background:var(--v-bg-2)}
@media (max-width:640px){body{margin:0;padding:16px}form{max-width:100%}input,textarea,select,button{min-height:44px}}
@media (max-width:600px){article{padding:14px}}</style>
</head><body><a class="skip-link" href="#main">Skip to main content</a><a href="${esc(opts.home ?? '/')}">Back to console</a><main id="main">${header}${body}</main></body></html>`;
}

export async function requestDetail(
  db: AsyncDb,
  coord: Coordinator,
  ledger: Ledger,
  id: string,
  page: number,
  opts: ReviewOptions,
  artifactDir?: string,
  nav: DetailNavContext = {},
): Promise<string | null> {
  const r = await coord.get(opts.tenant, id);
  if (!r) return null;
  const decision = await ledger.getDecisionByRequest(opts.tenant, id);
  const refs = [...new Set([...r.claimRefs, ...r.chainClaimIds])];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(refs.length / PAGE_SIZE) - 1));
  const claimCtx: DetailNavContext = nav.returnTo ? { requestId: id, returnTo: nav.returnTo } : {};
  // FLOW-002: staleness is scanned across ALL references, not just the
  // visible page — approval validates every ref, so a superseded claim on
  // page 3 must still surface its refresh prompt on page 1.
  let staleEvidence = false;
  for (const cid of refs) {
    const c = await ledger.get(opts.tenant, cid);
    if (c && ['SUPERSEDED', 'RETIRED', 'STALE'].includes(c.status)) {
      const replacement = await ledger.currentReplacement(opts.tenant, cid);
      if (replacement && replacement.id !== cid) {
        staleEvidence = true;
        break;
      }
    }
  }
  const claims = [];
  for (const cid of refs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)) {
    const c = await ledger.get(opts.tenant, cid);
    const replacement =
      c && ['SUPERSEDED', 'RETIRED', 'STALE'].includes(c.status)
        ? await ledger.currentReplacement(opts.tenant, cid)
        : null;
    if (replacement && replacement.id !== cid) staleEvidence = true;
    let statusNote = '';
    if (c && ['SUPERSEDED', 'RETIRED', 'STALE'].includes(c.status)) {
      statusNote = ' · <strong>historical</strong>';
      if (replacement && replacement.id !== cid) {
        statusNote += ` · current: <a href="${esc(claimDetailUrl(replacement.id, claimCtx))}">${esc(replacement.id)}</a>`;
      }
    }
    if (c) {
      claims.push(
        `<article><h2><a href="${esc(claimDetailUrl(cid, claimCtx))}">${esc(cid)}</a></h2><p>${esc(c.kind)} · ${esc(c.status)}${statusNote}</p><pre>${esc(c.statement)}</pre><p><a href="${esc(claimDetailUrl(cid, claimCtx))}">Full provenance, history and correction</a></p></article>`,
      );
    } else {
      claims.push(`<p>${esc(cid)}: evidence unavailable</p>`);
    }
  }
  const refreshable = ['ADMITTED', 'DEFERRED', 'ACCEPTED'].includes(r.state);
  let refreshForm = '';
  if (staleEvidence && refreshable) {
    refreshForm = `<section id="pending-review" class="review-root"><article data-review-request="${esc(id)}">
<p>Some cited evidence is historical. Refresh binds this request to current claim replacements without rewriting past decisions.</p>
<form method="post" action="/api/requests/${esc(encodeURIComponent(id))}/refresh-evidence" data-review-action="refresh-evidence">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<button type="submit">Refresh evidence and re-review</button></form>
<p data-review-status role="status" aria-live="polite"></p></article><noscript><p class="sub">JavaScript disabled: standard full-page form submission is active.</p></noscript><script>${REVIEW_SCRIPT}</script></section>`;
  } else if (staleEvidence) {
    refreshForm =
      '<p>Some cited evidence is historical. This request is no longer pending, so its evidence references stay frozen.</p>';
  }
  const deliverable = await renderDeliverableSection(
    db,
    ledger,
    id,
    opts,
    artifactDir ?? process.env.ARTIFACT_DIR ?? join('data', 'artifacts'),
  );
  const phase = requestPhase(r.state, r.bid.humanMinutes);
  return detailDocument(
    'Request evidence',
    `${opts.notice ? `<div class="success" role="status"><p><strong>${esc(opts.notice)}</strong></p></div>` : ''}<h2>${esc(r.goal)}</h2><p><strong>${esc(phase)}</strong> · ${esc(r.state)} · ${esc(r.id)}</p>
${decision ? `<p><a href="/console/decisions/${esc(encodeURIComponent(decision.id))}">View approval receipt</a>. This is approval to begin work, not final-deliverable authorization or evidence of execution or measurement.</p>` : ''}
${deliverable}
${refreshForm}
<details><summary>Request, budget and execution metadata</summary><pre>${dump(r)}</pre></details>
<h2>Evidence (${refs.length})</h2>${pagination(`/console/requests/${encodeURIComponent(id)}`, currentPage, refs.length, nav.returnTo)}${claims.join('') || '<p>No evidence references.</p>'}`,
    opts,
  );
}

export async function decisionDetail(ledger: Ledger, id: string, opts: ReviewOptions): Promise<string | null> {
  const decision = await ledger.getDecision(opts.tenant, id);
  if (!decision) return null;
  const { record, drift } = await ledger.replayDecision(opts.tenant, id);
  const spec = parseExecutionSpecFromDecision(record);
  const specHtml = spec
    ? `<h2>Approved execution specification</h2>
<p>Stage: ${esc(spec.approvalStage)} · fingerprint <code>${esc(spec.fingerprint.slice(0, 16))}…</code></p>
<dl>
<dt>Authorized command</dt><dd><pre>${esc(spec.command)}</pre></dd>
<dt>Deliverable schema</dt><dd>${esc(spec.deliverableSchema)}</dd>
<dt>Request version</dt><dd>${esc(spec.requestUpdatedAt)}</dd>
<dt>Evidence versions</dt><dd><pre>${dump(spec.evidence)}</pre></dd>
</dl>`
    : `<h2>Frozen action</h2><pre>${esc(record.action)}</pre>
<p>No versioned execution specification is attached to this decision.</p>`;
  return detailDocument(
    'Approval receipt',
    `<p>This records approval to BEGIN work. It is not final-deliverable authorization and does not establish that execution or measurement has occurred.</p>
<dl><dt>Decision id</dt><dd>${esc(record.id)}</dd>
<dt>Actor (decided by)</dt><dd>${esc(record.decidedBy)}</dd>
<dt>Approved by</dt><dd>${esc(record.approvedBy ?? 'Not recorded')}</dd>
<dt>Request</dt><dd>${record.requestId === null ? 'No linked request' : `<a href="/console/requests/${esc(encodeURIComponent(record.requestId))}">${esc(record.requestId)}</a>`}</dd>
<dt>Signed at</dt><dd>${esc(record.signedAt)}</dd>
<dt>Scope</dt><dd>${esc(record.scope)}</dd></dl>
<h2>Frozen goal</h2><pre>${esc(record.goal)}</pre>
${specHtml}
<h2>Frozen context bundle</h2><pre>${dump(record.bundle)}</pre>
<h2>Evidence drift since approval</h2><pre>${dump(drift)}</pre>`,
    opts,
  );
}

export async function claimDetail(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  id: string,
  page: number,
  opts: ReviewOptions,
  nav: DetailNavContext = {},
): Promise<string | null> {
  const c = await ledger.get(opts.tenant, id);
  if (!c) return null;
  const chain = await ledger.supersedeChain(opts.tenant, id);
  const returnCtx: DetailNavContext = nav.returnTo ? { returnTo: nav.returnTo } : {};
  const isCurrent = chain.current?.id === c.id;
  const isHistorical = ['SUPERSEDED', 'RETIRED'].includes(c.status);
  // Join both endpoints: a link is visible only when both claims belong to this tenant.
  const links = (await db
    .prepare(
      `SELECT l.from_id, l.to_id, l.link FROM claim_links l
    JOIN claims a ON a.id = l.from_id JOIN claims b ON b.id = l.to_id
    WHERE a.tenant = ? AND b.tenant = ? AND (l.from_id = ? OR l.to_id = ?)
    ORDER BY l.from_id, l.to_id, l.link`,
    )
    .all(opts.tenant, opts.tenant, id, id)) as { from_id: string; to_id: string; link: string }[];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(links.length / PAGE_SIZE) - 1));
  const history = links
    .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    .map(
      (l) =>
        `<li><a href="${esc(claimDetailUrl(l.from_id, returnCtx))}">${esc(l.from_id)}</a> ${esc(l.link)} <a href="${esc(claimDetailUrl(l.to_id, returnCtx))}">${esc(l.to_id)}</a></li>`,
    )
    .join('');
  const canCorrect = !isHistorical;
  const affected = await coord.listPendingAffectedByClaim(opts.tenant, id);
  const affectedHtml =
    affected.length > 0
      ? `<h2>Pending work citing this claim (${affected.length})</h2><ul>${affected
          .map(
            (r) => `<li><a href="${esc(requestDetailUrl(r.id, returnCtx))}">${esc(r.goal)}</a> · ${esc(r.state)}</li>`,
          )
          .join('')}</ul><p>Correcting this claim may require evidence refresh and re-review on these requests.</p>`
      : '';
  let source = esc(c.provenance.sourceUri);
  try {
    const uri = new URL(c.provenance.sourceUri);
    if (['https:', 'http:'].includes(uri.protocol))
      source = `<a href="${esc(uri.href)}" rel="noreferrer noopener" target="_blank">${source}</a>`;
  } catch {
    /* Non-web provenance remains readable, never executable. */
  }
  let form: string;
  if (canCorrect) {
    form = `<section id="pending-review" class="review-root"><article data-review-request="${esc(id)}"><h2>Correct claim</h2>
<p>This creates a replacement claim and retains this version. Request evidence references are not silently rewritten.</p>
<form method="post" action="/api/claims/${esc(encodeURIComponent(id))}/correct" data-review-action="correct" data-claim-seq="${c.seq}">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="expectedSeq" value="${c.seq}">
<label>Corrected statement<textarea name="statement" required>${esc(c.statement)}</textarea></label>
<label>Structured value<select name="valueMode"><option value="clear">Clear value and unit</option><option value="number">Set a numeric value</option></select></label>
<p>Clearing avoids retaining an old machine-readable value after editing the statement. Non-numeric structured values require the library API.</p>
<label>Numeric value<input name="value" type="number" step="any" value="${typeof c.value === 'number' ? c.value : ''}"></label>
<label>Unit<input name="unit" value="${esc(c.unit ?? '')}"></label>
${operatorFields(opts, id, 'correct')}
<label><input name="confirmed" type="checkbox" required>I reviewed the replacement statement and value</label>
<button type="submit">Save correction</button></form><p data-review-status role="status" aria-live="polite"></p></article>
<a href="#" data-review-refresh>Refresh claim</a><noscript><p class="sub">JavaScript disabled: standard full-page form submission is active.</p></noscript></section><script>${REVIEW_SCRIPT}</script>`;
  } else if (chain.current) {
    form = `<p>This is historical evidence. <a href="${esc(claimDetailUrl(chain.current.id, returnCtx))}">Correct the current claim (${esc(chain.current.id)})</a> instead.</p>`;
  } else {
    form = '<p>This is historical evidence. Follow its supersession links to correct the current claim.</p>';
  }
  const verifyForm =
    c.status === 'CANDIDATE'
      ? `<section id="verify-evidence" class="review-root"><article data-review-request="${esc(id)}"><h2>Verify this evidence</h2>
<p>Human curation: verifying marks this candidate as reviewed, so cited work can proceed to approval. Only roles that may approve may verify.</p>
<form method="post" action="/api/claims/${esc(encodeURIComponent(id))}/verify" data-review-action="verify">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
${operatorFields(opts, id, 'verify')}
<label><input type="checkbox" name="confirmed" required> I reviewed this evidence and vouch for its accuracy</label>
<button type="submit" disabled>Verify evidence</button></form><p data-review-status role="status" aria-live="polite"></p></article>
<noscript>JavaScript is required to verify evidence.</noscript></section>`
      : '';
  let lineage = '';
  if (chain.history.length > 1) {
    lineage = `<h2>Supersession lineage</h2><ul>${chain.history
      .map((h) => {
        const tag = lineageTag(h.id, h.status, chain.current?.id);
        return `<li><a href="${esc(claimDetailUrl(h.id, returnCtx))}">${esc(h.id)}</a> · ${esc(tag)} · seq ${h.seq}</li>`;
      })
      .join('')}</ul>`;
  }
  let statusBanner = '';
  if (isCurrent) {
    statusBanner = '<p><strong>Current claim</strong>: this is the live replacement in the supersession chain.</p>';
  } else if (isHistorical) {
    statusBanner =
      '<p><strong>Historical claim</strong>: frozen for replay; decisions that cited this version stay unchanged.</p>';
  }
  return detailDocument(
    'Claim evidence',
    `${statusBanner}<p><code>${esc(c.id)}</code> · ${esc(c.kind)} · ${esc(c.status)} · seq ${c.seq}</p>
<h2>Statement</h2><pre>${esc(c.statement)}</pre><h2>Value and unit</h2><pre>${dump({ value: c.value, unit: c.unit })}</pre>
<p>Source: ${source}</p>${lineage}${affectedHtml}<h2>Full claim and provenance</h2><pre>${dump(c)}</pre>
<h2>Evidence history (${links.length})</h2>${pagination(claimUrl(id), currentPage, links.length, nav.returnTo)}<ul>${history || '<li>No linked claims.</li>'}</ul>${form}${verifyForm}`,
    opts,
  );
}
