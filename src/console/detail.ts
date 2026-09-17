import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { operatorFields, REVIEW_SCRIPT, type ReviewOptions } from './review.ts';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const claimUrl = (id: string): string => `/console/claims/${encodeURIComponent(id)}`;
const dump = (value: unknown): string => esc(JSON.stringify(value ?? null, null, 2));
const PAGE_SIZE = 20;

function pagination(path: string, page: number, total: number): string {
  return `<nav aria-label="Evidence pages">${page > 0 ? `<a href="${esc(path)}?page=${page - 1}">Previous evidence</a>` : ''}
Page ${page + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}
${(page + 1) * PAGE_SIZE < total ? `<a href="${esc(path)}?page=${page + 1}">Next evidence</a>` : ''}</nav>`;
}

export function detailDocument(title: string, body: string, opts: ReviewOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Vital</title>
<style>body{font:16px system-ui;margin:24px;max-width:960px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:12px 0}textarea{width:100%;min-height:100px}input,button,textarea{font:inherit}article{border:1px solid #ccc;padding:16px;margin:16px 0}nav a{margin-right:16px}dt{font-weight:bold}dd{margin-bottom:12px}</style>
</head><body><a href="${esc(opts.home ?? '/')}">Back to console</a><h1>${esc(title)}</h1><p>Signed in as ${esc(opts.actor)}</p>${body}</body></html>`;
}

export async function requestDetail(coord: Coordinator, ledger: Ledger, id: string, page: number, opts: ReviewOptions): Promise<string | null> {
  const r = await coord.get(opts.tenant, id);
  if (!r) return null;
  const refs = [...new Set([...r.claimRefs, ...r.chainClaimIds])];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(refs.length / PAGE_SIZE) - 1));
  const claims = [];
  for (const cid of refs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)) {
    const c = await ledger.get(opts.tenant, cid);
    claims.push(c ? `<article><h2><a href="${esc(claimUrl(cid))}">${esc(cid)}</a></h2><p>${esc(c.kind)} · ${esc(c.status)}</p><pre>${esc(c.statement)}</pre><p><a href="${esc(claimUrl(cid))}">Full provenance, history and correction</a></p></article>` : `<p>${esc(cid)} — evidence unavailable</p>`);
  }
  return detailDocument('Request evidence', `<h2>${esc(r.goal)}</h2><p>${esc(r.state)} · ${esc(r.id)}</p>
<details><summary>Request, budget and execution metadata</summary><pre>${dump(r)}</pre></details>
<h2>Evidence (${refs.length})</h2>${pagination(`/console/requests/${encodeURIComponent(id)}`, currentPage, refs.length)}${claims.join('') || '<p>No evidence references.</p>'}`, opts);
}

export async function claimDetail(db: AsyncDb, ledger: Ledger, id: string, page: number, opts: ReviewOptions): Promise<string | null> {
  const c = await ledger.get(opts.tenant, id);
  if (!c) return null;
  // Join both endpoints: a link is visible only when both claims belong to this tenant.
  const links = await db.prepare(`SELECT l.from_id, l.to_id, l.link FROM claim_links l
    JOIN claims a ON a.id = l.from_id JOIN claims b ON b.id = l.to_id
    WHERE a.tenant = ? AND b.tenant = ? AND (l.from_id = ? OR l.to_id = ?)
    ORDER BY l.from_id, l.to_id, l.link`).all(opts.tenant, opts.tenant, id, id) as { from_id: string; to_id: string; link: string }[];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(links.length / PAGE_SIZE) - 1));
  const history = links.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(l =>
    `<li><a href="${esc(claimUrl(l.from_id))}">${esc(l.from_id)}</a> ${esc(l.link)} <a href="${esc(claimUrl(l.to_id))}">${esc(l.to_id)}</a></li>`).join('');
  const canCorrect = !['SUPERSEDED', 'RETIRED'].includes(c.status);
  let source = esc(c.provenance.sourceUri);
  try {
    const uri = new URL(c.provenance.sourceUri);
    if (['https:', 'http:'].includes(uri.protocol)) source = `<a href="${esc(uri.href)}" rel="noreferrer noopener" target="_blank">${source}</a>`;
  } catch { /* Non-web provenance remains readable, never executable. */ }
  const form = canCorrect ? `<section id="pending-review"><article data-review-request="${esc(id)}"><h2>Correct claim</h2>
<p>This creates a replacement claim and retains this version. Request evidence references are not silently rewritten.</p>
<form method="post" action="/api/claims/${esc(encodeURIComponent(id))}/correct" data-review-action="correct">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>Corrected statement<textarea name="statement" required>${esc(c.statement)}</textarea></label>
<label>Structured value<select name="valueMode"><option value="clear">Clear value and unit</option><option value="number">Set a numeric value</option></select></label>
<p>Clearing avoids retaining an old machine-readable value after editing the statement. Non-numeric structured values require the library API.</p>
<label>Numeric value<input name="value" type="number" step="any" value="${typeof c.value === 'number' ? c.value : ''}"></label>
<label>Unit<input name="unit" value="${esc(c.unit ?? '')}"></label>
${operatorFields(opts, id, 'correct')}
<label><input name="confirmed" type="checkbox" required>I reviewed the replacement statement and value</label>
<button type="submit" disabled>Save correction</button></form><p data-review-status role="status" aria-live="polite"></p></article>
<a href="#" data-review-refresh>Refresh claim</a><noscript>JavaScript is required to submit a correction.</noscript></section><script>${REVIEW_SCRIPT}</script>` : '<p>This is historical evidence. Follow its supersession links to correct the current claim.</p>';
  return detailDocument('Claim evidence', `<p><code>${esc(c.id)}</code> · ${esc(c.kind)} · ${esc(c.status)}</p>
<h2>Statement</h2><pre>${esc(c.statement)}</pre><h2>Value and unit</h2><pre>${dump({ value: c.value, unit: c.unit })}</pre>
<p>Source: ${source}</p><h2>Full claim and provenance</h2><pre>${dump(c)}</pre>
<h2>Evidence history (${links.length})</h2>${pagination(claimUrl(id), currentPage, links.length)}<ul>${history || '<li>No linked claims.</li>'}</ul>${form}`, opts);
}
