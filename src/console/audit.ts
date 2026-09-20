import type { AsyncDb } from '../core/db.ts';
import { auditLinks, queryAudit } from '../ledger/export.ts';
import { listUsers } from '../core/auth.ts';

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

  // The `actor` column stores provenance verbatim: auth events record a user
  // id, a login attempt records the email, and machine actions record 'system'
  // or 'operator'. That raw value is the audit contract and must keep filtering
  // exactly as stored — but a page owes the reader a name, so a bare `usr_…` is
  // resolved to its owner for *display only*.
  const people = new Map<string, string>();
  try {
    for (const u of await listUsers(db, tenant)) people.set(u.id, u.email);
  } catch {
    // A failed directory read degrades to showing the stored actor, never to
    // hiding the entry.
  }
  const actorDisplay = (actor: string): string => {
    if (people.has(actor))
      return `${esc(people.get(actor)!)} <span class="v-meta">(${esc(actor.slice(0, 12))}…)</span>`;
    return esc(actor);
  };
  // Machine and system actors read as neutral chips so a human actor stands out.
  const actorCell = (actor: string): string => {
    const human = people.has(actor) || actor.includes('@');
    return human
      ? `<span class="v-strong">${actorDisplay(actor)}</span>`
      : `<span class="v-badge"><span class="dot"></span>${actorDisplay(actor)}</span>`;
  };

  const rows = page.rows
    .map(
      (row) => `<tr>
<td class="v-meta">${esc(row.at)}</td>
<td>${actorCell(row.actor)}</td>
<td><span class="v-code-pill">${esc(row.action)}</span></td>
<td>${esc(row.target)}</td>
<td class="v-meta">${esc(row.detail ?? '')}</td>
<td>${linksCell(row)}</td>
</tr>`,
    )
    .join('');

  const body =
    page.total === 0
      ? `<div class="v-empty"><h3>No audit entries match these filters</h3><p>Every authentication event and console mutation is recorded here. The actor filter is an exact match, so an email and a user id are different searches.</p><p><a class="v-btn v-btn-secondary v-btn-sm" href="/console/audit">Clear filters</a></p></div>`
      : `<div class="v-table-wrap">
<table class="v-table">
<thead><tr><th>at</th><th>actor</th><th>action</th><th>target</th><th>detail</th><th>links</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;

  const prev =
    offset > 0
      ? `<a class="v-btn v-btn-secondary v-btn-sm" href="${esc(buildUrl(Math.max(0, offset - PAGE_SIZE)))}">← Previous</a>`
      : '';
  const next =
    offset + page.rows.length < page.total
      ? `<a class="v-btn v-btn-secondary v-btn-sm" href="${esc(buildUrl(offset + page.rows.length))}">Next →</a>`
      : '';
  const root = buildUrl(0);
  const activeFilters = [opts.actor, opts.action, opts.from, opts.to, opts.request].filter(Boolean).length;
  const count = `${page.total.toLocaleString()} total · showing ${page.rows.length.toLocaleString()}${offset > 0 ? ` from ${(offset + 1).toLocaleString()}` : ''}`;

  return {
    html: `<div class="v-page-head">
  <div>
    <p class="v-eyebrow">System</p>
    <h1 class="v-page-title">Audit log</h1>
    <p class="v-sub" style="margin-top:6px;">Every authentication event and console mutation for this organization. Records are append-only.</p>
  </div>
</div>
<form class="v-filterbar" method="get" action="/console/audit" role="search">
  <label class="v-sr-only" for="actor">Filter by actor (user id or email)</label>
  <input id="actor" name="actor" class="v-input" value="${esc(opts.actor ?? '')}" placeholder="Filter by actor…" autocomplete="off">
  <label class="v-sr-only" for="action">Filter by action</label>
  <input id="action" name="action" class="v-input" value="${esc(opts.action ?? '')}" placeholder="Action — e.g. console.approve" autocomplete="off">
  <button class="v-btn v-btn-primary" type="submit">Filter</button>
  <a class="v-btn v-btn-ghost" href="${esc(root)}">Clear${activeFilters > 0 ? ` (${activeFilters})` : ''}</a>
  <details class="v-disclose">
    <summary class="v-btn v-btn-ghost v-btn-sm">Date range &amp; request</summary>
    <div class="v-fields">
      <label class="v-field"><span class="v-field-label">From (ISO time)</span>
        <input id="from" name="from" class="v-input" value="${esc(opts.from ?? '')}" placeholder="2026-01-01T00:00:00Z"></label>
      <label class="v-field"><span class="v-field-label">To (ISO time)</span>
        <input id="to" name="to" class="v-input" value="${esc(opts.to ?? '')}" placeholder="2026-12-31T23:59:59Z"></label>
      <label class="v-field"><span class="v-field-label">Request / decision id</span>
        <input id="request" name="request" class="v-input" value="${esc(opts.request ?? '')}" placeholder="rq_…"></label>
    </div>
  </details>
</form>
<p class="v-meta v-count">${esc(count)}</p>
${body}
${prev || next ? `<nav class="v-pager" aria-label="Pagination">${[prev, next].filter(Boolean).join('')}</nav>` : ''}`,
  };
}
