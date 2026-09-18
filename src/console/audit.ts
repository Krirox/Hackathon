import type { AsyncDb } from '../core/db.ts';
import { auditLinks, queryAudit } from '../ledger/export.ts';

/**
 * FINAL-006: the admin audit-log surface.
 *
 * `audit_log` already records every auth and mutation event and `GET /api/audit`
 * exposes it — but no page consumed it, so admins could not answer "who did X,
 * when?" in-product. This renders a filterable, paginated view reusing the same
 * query and link-extraction the API uses.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_SIZE = 50;

export interface AuditPageOptions {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  request?: string;
  offset?: number;
}

function linkFor(id: string): string | null {
  // auditLinks returns tokens like `request:rq1` / `claim:clm_x` — strip the
  // type prefix so the link targets the bare id.
  const bare = id.replace(/^(claim|decision|request|clm|dec|req)[:_]/, '');
  if (id.startsWith('clm') || id.startsWith('claim')) return `/console/claims/${encodeURIComponent(bare)}`;
  if (id.startsWith('dec') || id.startsWith('decision')) return `/console/decisions/${encodeURIComponent(bare)}`;
  if (id.startsWith('req') || id.startsWith('request')) return `/console/requests/${encodeURIComponent(bare)}`;
  return null;
}

function linksCell(row: { actor: string; target: string; detail: string | null }): string {
  const links = auditLinks(row);
  const anchors: string[] = [];
  for (const id of links.evidence) {
    const href = linkFor(id);
    if (href) anchors.push(`<a href="${esc(href)}">${esc(id)}</a>`);
    else anchors.push(`<code>${esc(id)}</code>`);
  }
  return anchors.length > 0 ? anchors.join(' · ') : '';
}

export async function renderAuditPage(db: AsyncDb, tenant: string, opts: AuditPageOptions): Promise<{ html: string }> {
  const offset = Number.isSafeInteger(opts.offset) && (opts.offset ?? 0) >= 0 ? (opts.offset as number) : 0;
  const page = await queryAudit(db, tenant, {
    actor: opts.actor || undefined,
    action: opts.action || undefined,
    from: opts.from || undefined,
    to: opts.to || undefined,
    requestId: opts.request || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  const buildUrl = (nextOffset: number): string => {
    const p = new URLSearchParams();
    if (opts.actor) p.set('actor', opts.actor);
    if (opts.action) p.set('action', opts.action);
    if (opts.from) p.set('from', opts.from);
    if (opts.to) p.set('to', opts.to);
    if (opts.request) p.set('request', opts.request);
    if (nextOffset > 0) p.set('offset', String(nextOffset));
    const q = p.toString();
    return `/console/audit${q ? `?${q}` : ''}`;
  };

  const rows = page.rows
    .map(
      (row) => `<tr>
<td class="sub">${esc(row.at)}</td>
<td>${esc(row.actor)}</td>
<td><code>${esc(row.action)}</code></td>
<td>${esc(row.target)}</td>
<td class="sub">${esc(row.detail ?? '')}</td>
<td>${linksCell(row)}</td>
</tr>`,
    )
    .join('');

  const body =
    page.total === 0
      ? '<p class="sub">No audit entries match these filters. <a href="/console/audit">Clear filters</a></p>'
      : `<table class="stacked"><thead><tr class="sub"><th align="left">at</th><th align="left">actor</th><th align="left">action</th><th align="left">target</th><th align="left">detail</th><th align="left">links</th></tr></thead><tbody>${rows}</tbody></table>`;

  const prev = offset > 0 ? `<a href="${esc(buildUrl(Math.max(0, offset - PAGE_SIZE)))}">Previous</a>` : '';
  const next =
    offset + page.rows.length < page.total ? `<a href="${esc(buildUrl(offset + page.rows.length))}">Next</a>` : '';
  const root = buildUrl(0);

  return {
    html: `<h1>Audit log</h1>
<p class="sub">Every authentication event and console mutation for this organization. Records are append-only.</p>
<form method="get" action="/console/audit">
  <label class="sub" for="actor">actor (user id or email)</label>
  <input id="actor" name="actor" value="${esc(opts.actor ?? '')}">
  <label class="sub" for="action">action</label>
  <input id="action" name="action" value="${esc(opts.action ?? '')}" placeholder="e.g. console.approve">
  <label class="sub" for="from">from (ISO time)</label>
  <input id="from" name="from" value="${esc(opts.from ?? '')}">
  <label class="sub" for="to">to (ISO time)</label>
  <input id="to" name="to" value="${esc(opts.to ?? '')}">
  <label class="sub" for="request">request / decision id</label>
  <input id="request" name="request" value="${esc(opts.request ?? '')}">
  <button type="submit">Filter</button> <a href="${esc(root)}">Clear</a>
</form>
<p class="sub">${page.total} total · showing ${page.rows.length}${offset > 0 ? ` from ${offset + 1}` : ''}</p>
${body}
${prev || next ? `<p class="sub">${[prev, next].filter(Boolean).join(' · ')}</p>` : ''}`,
  };
}
