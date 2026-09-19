/**
 * Shared console UX states (FLOW-027 cross-cutting checklist).
 *
 * Small string helpers so every console journey renders the same
 * Loading / Success / Empty / Error / 403 / Partial / Timeout /
 * Refresh / Destructive vocabulary without inventing per-page copy.
 * No behavior lives here — pages compose these fragments.
 */

import { themeCss } from './theme.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Shared console stylesheet: the design system plus the handful of rules a
 * standalone console document needs (skip link, stacked tables). Token-only —
 * a literal color here would be a second palette that drifts from
 * `theme.ts`.
 */
export const CONSOLE_SHARED_CSS = `${themeCss()}
body{padding:28px 20px 48px;max-width:960px;margin:0 auto}
a.skip-link{position:absolute;left:-9999px;top:0;background:var(--v-accent);color:var(--v-accent-ink);padding:8px 14px;z-index:100;border-radius:0 0 var(--radius-sm) 0;font-weight:600;font-size:13px}
a.skip-link:focus{left:0}
pre,code{font-family:var(--font-mono)}
pre{background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:var(--radius-sm);padding:12px 14px;overflow-x:auto;font-size:12px}
.table-wrap{overflow-x:auto;max-width:100%}
.err{color:var(--v-risk);font-size:13px}
.error-summary{border:1px solid var(--v-line);border-left:3px solid var(--v-risk);border-radius:var(--radius-md);padding:14px 16px;margin:12px 0;background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink)}
.success{border:1px solid var(--v-line);border-left:3px solid var(--v-fact);border-radius:var(--radius-md);padding:14px 16px;margin:12px 0;background:var(--v-tint-good-bg);color:var(--v-tint-good-ink)}
@media (max-width:640px){body{padding:14px}table.stacked thead{display:none}table.stacked tr{display:block;border:1px solid var(--v-line);border-radius:var(--radius-sm);margin-bottom:8px}table.stacked td{display:block;border:0}}`;

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
