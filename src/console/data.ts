import type { ErasureReceiptVerification } from '../core/erasure.ts';

/**
 * FINAL-007: self-serve data export and GDPR erasure surface.
 *
 * Exposes exportLedger (Article 20 portability) and eraseTenant (Article 17 erasure)
 * in-product with export-first verification, typed confirmation, and audit receipts.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DataPageOptions {
  csrf: string;
  notice?: string;
  error?: string;
  home?: string;
}

export function renderDataPage(tenant: string, opts: DataPageOptions): string {
  const noticeHtml = opts.notice
    ? `<div class="success" role="status"><p><strong>${esc(opts.notice)}</strong></p></div>`
    : '';
  const errorHtml = opts.error
    ? `<div class="error-summary" role="alert"><p><strong>${esc(opts.error)}</strong></p></div>`
    : '';

  // No page-level back link: detailDocument already renders one above this
  // body, and repeating it produced "Back to console ← Back to console".
  return `<h1>Data &amp; retention</h1>
<p class="sub">Manage organization data portability, cryptographic audit exports, and GDPR Article 17 erasure.</p>
${noticeHtml}
${errorHtml}

<div class="card">
  <h2>Export Reality Ledger</h2>
  <p class="sub">
    Download the complete portable snapshot of this organization's history: typed claims, claim links, decisions, Context Bundles, measured outcomes, and the append-only audit trail (JSON format).
  </p>
  <div style="margin-top:16px;">
    <a href="/console/data/export" download="${esc(tenant)}-ledger-export.json" style="display:inline-flex;align-items:center;gap:6px;background:var(--v-accent);color:var(--v-accent-ink);font-weight:600;padding:10px 18px;border-radius:10px;text-decoration:none;font-size:13px;">
      ⬇ Download Ledger Export (JSON)
    </a>
  </div>
</div>

<div class="card">
  <h2>Backup &amp; restore</h2>
  <p class="sub">
    Backups are <strong>operator-managed infrastructure</strong>, not a console feature in this build.
    The supported disaster-recovery path is a point-in-time copy of the database file (with artifact
    store) taken by your platform operator — restoring is a file restore, verified by the
    backup/restore drill, <em>not</em> an in-app import. The export below is a portable evidence
    record and is explicitly <strong>not a backup</strong> and cannot be restored by import.
  </p>
  <p class="sub">
    To confirm current operational health, run <code>vital status --readiness</code> (or see the
    System readiness strip on the console home) and check your operator's backup job for the
    database file <code>${esc(tenant)}</code>.
  </p>
</div>

<div class="card">
  <h2>Verify Erasure Receipt</h2>
  <p class="sub">
    Check the cryptographic audit trail of a previously erased tenant to verify deletion completeness and retained proof rows.
  </p>
  <form method="get" action="/receipts/erasure" style="margin-top:12px;display:flex;gap:8px;max-width:480px;">
    <input name="slug" placeholder="Organization slug (e.g. acme)" required style="flex:1;">
    <button type="submit" style="background:var(--v-ink-2);">Verify Receipt</button>
  </form>
</div>

<div class="card" style="border-color:var(--v-risk);background:var(--v-tint-risk-bg);">
  <h2 style="color:var(--v-tint-risk-ink);">Danger Zone — Permanent Tenant Erasure</h2>
  <p class="sub">
    Permanently delete all claims, decisions, outcomes, credentials, and member sessions for <strong>${esc(tenant)}</strong>.
    An in-memory export is verified before deletion commits, and an immutable proof receipt is recorded under <code>erased:${esc(tenant)}</code>.
  </p>
  <p class="sub" style="color:var(--v-tint-risk-ink);font-weight:500;">
    ⚠️ This action cannot be undone. To proceed, type the organization slug <code>${esc(tenant)}</code> below and confirm.
  </p>
  <form method="post" action="/console/data/erase" style="margin-top:16px;max-width:480px;display:grid;gap:12px;">
    <input type="hidden" name="csrf" value="${esc(opts.csrf)}">
    <label style="font-size:13px;font-weight:500;color:var(--v-ink-2);">
      Confirm organization slug
      <input name="confirmSlug" required placeholder="${esc(tenant)}" style="margin-top:4px;">
    </label>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--v-ink-2);">
      <input type="checkbox" name="confirmed" required>
      I understand that this will permanently erase all data for ${esc(tenant)}.
    </label>
    <div>
      <button type="submit" style="background:var(--v-risk);color:var(--v-bg-1);border:none;padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;">
        Permanently Erase Organization
      </button>
    </div>
  </form>
</div>`;
}

import { CONSOLE_SHARED_CSS, skipLink } from './states.ts';

export function renderErasureReceiptPage(verification: ErasureReceiptVerification, home = '/'): string {
  const content =
    !verification.found || !verification.receipt
      ? `<p class="sub"><a href="${esc(home)}">← Back</a></p>
<h1>Erasure receipt verification</h1>
<div class="error-summary" role="alert">
  <p><strong>No erasure receipt found for slug: ${esc(verification.slug)}</strong></p>
  <p class="sub">Either this organization was never erased, or the slug was mistyped.</p>
</div>`
      : (() => {
          const r = verification.receipt!;
          const deletedRows = Object.entries(r.deleted)
            .map(([tbl, count]) => `<li><code>${esc(tbl)}</code>: ${count} row(s) deleted</li>`)
            .join('');

          const retainedRows = r.retained
            .map(
              (ret) =>
                `<li><strong>${esc(ret.category)}</strong>: ${esc(ret.reason)} (${ret.items.length} item(s))</li>`,
            )
            .join('');

          return `<p class="sub"><a href="${esc(home)}">← Back</a></p>
<h1>Erasure verification receipt</h1>
<div class="success" role="status">
  <p><strong>✓ Verified: Organization <code>${esc(verification.slug)}</code> was erased.</strong></p>
  <p class="sub">Erased at: ${esc(verification.erasedAt ?? r.exportedAt)} · Export policy: ${esc(r.exportPolicy)}</p>
</div>

<div class="card">
  <h2>Deletion summary</h2>
  <p class="sub">All tenant-scoped tables were cleared in an atomic transaction:</p>
  <ul>${deletedRows}</ul>
</div>

<div class="card">
  <h2>Retained proof &amp; metadata</h2>
  <p class="sub">Deliberately retained per GDPR Article 17 accountability requirements:</p>
  <ul>
    ${retainedRows || '<li>None</li>'}
  </ul>
</div>`;
        })();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Erasure verification receipt</title>
  <style>
    ${CONSOLE_SHARED_CSS}
  </style>
</head>
<body style="max-width:800px;margin:32px auto;padding:0 24px;">
  ${skipLink('#main')}
  <main id="main">
    ${content}
  </main>
</body>
</html>`;
}
