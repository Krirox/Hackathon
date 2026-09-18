/**
 * Shared console UX states (FLOW-027 cross-cutting checklist).
 *
 * Small string helpers so every console journey renders the same
 * Loading / Success / Empty / Error / 403 / Partial / Timeout /
 * Refresh / Destructive vocabulary without inventing per-page copy.
 * No behavior lives here — pages compose these fragments.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Responsive + skip-link + focus CSS shared by page() and detailDocument(). */
export const CONSOLE_SHARED_CSS = [
  "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');",
  'body{font-family:\'Inter\',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAFAF8;color:#0A0F14;line-height:1.5;-webkit-font-smoothing:antialiased;letter-spacing:-0.011em}',
  'a{color:#0F5C57;text-decoration:none}a:hover{text-decoration:underline}',
  'a.skip-link{position:absolute;left:-9999px;top:0;background:#0F5C57;color:#fff;padding:8px 14px;z-index:100;border-radius:0 0 6px 0;font-weight:500;font-size:13px}',
  'a.skip-link:focus{left:0}',
  'button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #0F5C57;outline-offset:2px}',
  'input,textarea,select{border:1px solid #E4E4E1;border-radius:6px;padding:9px 12px;background:#fff;color:#0A0F14;font-family:inherit;font-size:13px;transition:border-color .15s ease,box-shadow .15s ease}',
  'input:focus,textarea:focus,select:focus{border-color:#0F5C57;box-shadow:0 0 0 3px rgba(15,92,87,.12);outline:none}',
  'button{background:#0F5C57;color:#fff;font-weight:600;padding:9px 16px;border-radius:6px;border:0;cursor:pointer;font-family:inherit;font-size:13px;transition:background .15s ease,transform .1s ease}',
  'button:hover{background:#0B4A45}',
  'button:active{transform:translateY(1px)}',
  'button:disabled{opacity:0.6;cursor:not-allowed}',
  '.card{border:1px solid #E4E4E1;border-radius:10px;padding:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.03),0 1px 2px rgba(0,0,0,0.02);transition:border-color .15s ease,box-shadow .15s ease}',
  '.card:hover{border-color:#D1D1CB;box-shadow:0 4px 12px rgba(0,0,0,0.05)}',
  ".badge{display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;padding:3px 8px;border-radius:4px;border:1px solid #E4E4E1;background:#fff}",
  "pre,code{font-family:'JetBrains Mono',monospace}",
  'pre{background:#F5F5F3;border:1px solid #E4E4E1;border-radius:6px;padding:12px 14px;overflow-x:auto}',
  'table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}',
  '.table-wrap{overflow-x:auto;max-width:100%}',
  '@media (max-width:640px){body{padding:12px}form{max-width:100%}input,textarea,select,button{min-height:44px}}',
  '@media (max-width:600px){.card-grid{display:block}.card{margin-bottom:12px}table.stacked thead{display:none}table.stacked tr{display:block;border:1px solid #E4E4E1;border-radius:8px;margin-bottom:8px}table.stacked td{display:block;border:0}}',
  '.err{color:#B91C1C;font-size:13px}.sub{color:#6B7280;font-size:12px}',
  '.error-summary{border:1px solid #FCA5A5;border-radius:8px;padding:14px 16px;margin:12px 0;background:#FEF2F2;color:#991B1B}',
  '.success{border:1px solid #86EFAC;border-radius:8px;padding:14px 16px;margin:12px 0;background:#F0FDF4;color:#166534}',
].join('\n');

export function skipLink(target = '#main'): string {
  return `<a class="skip-link" href="${esc(target)}">Skip to main content</a>`;
}

export interface FieldError {
  field: string;
  message: string;
}

/** Accessible error summary: role=alert, links to fields, focus target. */
export function errorSummary(errors: FieldError[], opts: { heading?: string } = {}): string {
  if (errors.length === 0) return '';
  const items = errors.map((e) => `<li><a href="#${esc(e.field)}">${esc(e.message)}</a></li>`).join('');
  return `<div class="error-summary" role="alert" tabindex="-1" data-error-summary><p><strong>${esc(opts.heading ?? 'There is a problem')}</strong></p><ul>${items}</ul></div>`;
}

/** Wire a field to its error via aria-describedby. Caller renders the <span id>. */
export function fieldErrorId(field: string): string {
  return `${field}-error`;
}

export function fieldErrorText(field: string, message: string): string {
  return `<span class="err" id="${esc(fieldErrorId(field))}">${esc(message)}</span>`;
}

export type EmptyKind = 'unconfigured' | 'no-data' | 'no-match';

export function emptyState(kind: EmptyKind, opts: { title?: string; body?: string; clearUrl?: string } = {}): string {
  if (kind === 'unconfigured')
    return `<p class="sub">${esc(opts.title ?? 'Not configured yet')}${opts.body ? ` — ${esc(opts.body)}` : ''}</p>`;
  if (kind === 'no-data')
    return `<p class="sub">${esc(opts.title ?? 'No data yet')}${opts.body ? ` — ${esc(opts.body)}` : ''}</p>`;
  const clear = opts.clearUrl ? ` <a href="${esc(opts.clearUrl)}">Clear search and filters</a>` : '';
  return `<p class="sub">${esc(opts.title ?? 'No results')}: ${esc(opts.body ?? 'No matching work found.')}${clear}</p>`;
}

export function loadingNote(action: string): string {
  return `<p class="sub" role="status" aria-live="polite" aria-busy="true">Submitting ${esc(action)}… the button is disabled to prevent a duplicate submission.</p>`;
}

export function successReceipt(what: string, next: { href: string; label: string } | null): string {
  const link = next ? ` <a href="${esc(next.href)}">${esc(next.label)}</a>` : '';
  return `<div class="success" role="status"><p><strong>${esc(what)}</strong>${link}</p></div>`;
}

export function errorBlock(stage: string, preserved: string, recovery: string): string {
  return `<div class="error-summary" role="alert"><p><strong>Failed at ${esc(stage)}.</strong> ${esc(preserved)} Recovery: ${esc(recovery)}</p></div>`;
}

/** 403 without leaking restricted data: names the required authority only. */
export function forbiddenBlock(required: string): string {
  return `<div class="error-summary" role="alert"><p><strong>Not permitted.</strong> This action requires ${esc(required)}. No restricted data is shown.</p></div>`;
}

export interface PartialLists {
  succeeded?: string[];
  failed?: { item: string; reason: string }[];
  refused?: string[];
  deferred?: string[];
  untouched?: string[];
}

export function partialBlock(lists: PartialLists): string {
  const row = (label: string, items: string[]): string =>
    items.length > 0 ? `<li>${esc(label)} (${items.length}): ${items.map(esc).join(', ')}</li>` : '';
  const failed = (lists.failed ?? []).map((f) => `${f.item} (${f.reason})`);
  const items =
    row('Succeeded', lists.succeeded ?? []) +
    row('Failed', failed) +
    row('Refused', lists.refused ?? []) +
    row('Deferred', lists.deferred ?? []) +
    row('Untouched', lists.untouched ?? []);
  if (!items) return '';
  return `<div role="status"><p><strong>Partial completion.</strong></p><ul>${items}</ul></div>`;
}

export function timeoutBlock(): string {
  return `<div class="error-summary" role="alert"><p><strong>Timed out with an unknown result.</strong> Refresh to reconcile server state before retrying — the action may already have landed, so never assume nothing happened.</p></div>`;
}

export function refreshBlock(what: string): string {
  return `<p class="sub" role="status">${esc(what)} Refresh restores durable progress; authoritative cancellation and approval state are preserved across restart.</p>`;
}

export function destructiveConfirm(opts: {
  target: string;
  consequences: string;
  retained: string;
  confirmLabel?: string;
}): string {
  return `<div class="error-summary" role="alert"><p><strong>Destructive action: ${esc(opts.target)}.</strong> ${esc(opts.consequences)} Retained: ${esc(opts.retained)}</p></div>`;
}

/** Consistent action labels across review / correction / approval / erasure. */
export const ACTION_LABELS = {
  approve: 'Approve — begin work',
  decline: 'Decline request',
  correct: 'Save correction',
  refreshEvidence: 'Refresh evidence and re-review',
  recoverStop: 'Recover stop',
  disableMember: 'Disable member',
  signIn: 'Sign in',
} as const;
