# Vital — Final User-Flow Remediation TODO

Created: 2026-09-18
Source: end-user / enterprise flow audit of `site/`, `src/console/`, `src/core/auth.ts`,
and `src/cli.ts`. Findings are reproduced independently of `AUDIT.md` and `flow_TODO.md`.

## Goal

Close the gaps between what the console claims and what a user can actually do:
one trustworthy, reachable journey with no orphaned pages and no dead ends.

**Website → sign in (optional MFA) → persistent setup → first source → release
workflow → produce a deliverable → grounded preview → approve (receipt) →
measured outcome → replay**, with admin side-journeys for Team, Audit, Learning,
and Data & retention reachable from one shared nav.

## How to use

- Every item starts unchecked. An audit finding is not a fix.
- `[x]` means implemented **and verified** (test, run, or browser check).
- Preserve existing security, provenance, budget, refusal, and append-only guarantees.
- Do not weaken a guard to make a happy path pass; provide a recovery journey around it.

### Priority

| Priority | Meaning                                                      |
| -------- | ------------------------------------------------------------ |
| P0       | Dead end, broken link, or unreachable core action; fix first |
| P1       | Required for a supported pilot or enterprise review          |
| P2       | Consistency, discoverability, and polish                     |

---

## Progress

| Item                                           | Status                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| FINAL-001 cross-page back links                | Done — `test/auth.test.ts`                                  |
| FINAL-002 persistent Settings nav              | Done — `test/console.test.ts`                               |
| FINAL-003 surface Rooms wizard                 | Done — `test/console.test.ts` (link)                        |
| FINAL-004 learning review page (no JSON links) | Done — `test/console.test.ts`                               |
| FINAL-005 MFA enroll + login                   | Done — `test/console.test.ts`                               |
| FINAL-006 admin audit-log page                 | Done — `test/console.test.ts`                               |
| FINAL-007 self-serve data export & erasure     | Done — `test/console.test.ts`                               |
| FINAL-008…014                                  | Done — `test/console.test.ts` (85/85), `npm test` (739/739) |

Full suite green at 739/739 (`npm test`), typecheck/lint/format clean for every file.

---

## P0 — Broken links, dead ends, and unreachable core actions

### FINAL-001 — Fix cross-page back/return links (co-hosted & default modes)

**Source:** Issue 8. `teamPage` does not receive `home` and hard-codes
`<a href="/">← console</a>`; Buzz approval pages and the Rooms wizard hard-code
`/console`, which 404s in default (non-`--site`) mode.
**Done (2026-09-18):** `teamPage` now takes `home` via its options and every one of
its 17 call sites passes it; the Buzz approve/decline pages and the Rooms wizard use
`home`. Verified: `test/auth.test.ts` (FINAL-001 ×1, runs both `siteDir=undefined`
and `siteDir='site'`); no bare `href="/console"` remains in `src/`; typecheck clean.

- [x] Pass `home` into `teamPage` and replace the hard-coded `/` back link.
- [x] Replace hard-coded `/console` links in the Buzz approve/decline pages with `home`.
- [x] Replace the Rooms wizard `/console` back link with `home` (thread it through).
- [x] Verify every authenticated page's back link resolves in both modes.

**Acceptance:** No authenticated page sends a user to a 404 or to the marketing site.

**Tests:** console HTTP test asserting the Team page back link equals `home` for a
plain serve and for `--site`.

### FINAL-002 — Make organization Setup reachable after activation

**Source:** Issue 4. `/setup` is only linked from the activation panel, which
hides once the checklist completes. `buildConsoleNav` omits Setup.
**Done (2026-09-18):** `buildConsoleNav` gained a `settings` destination (`/setup`)
defaulting closed; the dashboard passes `{ settings: isAdmin }`. Verified:
`test/console.test.ts` (FINAL-002 ×1 — owner sees it, member does not; `/setup`
still renders).

- [x] Add a persistent "Settings"/"Setup" entry to `buildConsoleNav` (admin-gated).
- [x] Keep `/setup` functional and populated after activation.
- [x] Link Settings from the shared console nav on every authenticated page. _(dashboard nav; FINAL-014 widens to all pages)_

**Acceptance:** An admin can change source/scope/approval/budget at any time from the nav.

**Tests:** console HTTP test that the dashboard nav contains the setup destination.

### FINAL-003 — Surface the orphaned Rooms provisioning wizard

**Source:** Issue 7. `/setup/rooms` has zero inbound links and uses a dark theme
inconsistent with the rest of the console.
**Done (2026-09-18):** the setup page now links `/setup/rooms` ("Open room
provisioning"); the wizard palette was swapped from the dark slate theme to the
console light/teal system. Verified: `test/console.test.ts` (FINAL-002 asserts the
setup link; FINAL-001 asserts the wizard back link).

- [x] Link the Rooms wizard from the setup page and/or nav.
- [x] Restyle the wizard to the console design system (light canvas/teal).
- [x] Fix its back link (FINAL-001).

**Acceptance:** A user can reach room provisioning without guessing a URL.

**Tests:** console HTTP test that the wizard is linked; source check for console palette.

### FINAL-004 — Stop linking humans to raw JSON endpoints

**Source:** Issue 11. The Team page links to `/api/learning/cards/:id` and
`.../evidence`, which return raw JSON in the browser.
**Done (2026-09-18):** added `src/console/learning.ts` and routes
`GET /console/learning`, `GET /console/learning/:id` (admin/owner), and
`POST /console/learning/label`; added an admin "Learning" nav entry; the Team
page's compiler-gap links now target `/console/learning/:id`. The JSON APIs
remain for programmatic callers. Verified: `test/console.test.ts` (FINAL-004 ×1,
FINAL-002 nav gating, FLOW-025 updated) — no in-product href points at
`/api/learning`.

- [x] Add a minimal `/console/learning` page (labeling queue + card detail).
- [x] Point the compiler-gap links at the page, not the JSON API.
- [x] Keep the JSON API for programmatic callers.

**Acceptance:** A non-developer never lands on a JSON blob from an in-product link.

**Tests:** console HTTP test for the learning page; no UI href points at `/api/learning`.

---

## P1 — Enterprise-required surfaces

### FINAL-005 — Expose MFA (enroll / verify / recover) in the console

**Source:** Issue 1. TOTP + recovery codes are implemented and tested in
`src/core/auth.ts` but have no routes or UI; `mfaHint` is never passed.
**Done (2026-09-18):** `login()` was split into `verifyLoginCredentials()` +
`startSessionForUser()` (no behavior change for password-only). The console now
enrolls TOTP (`/account/mfa/setup|enable`), lists/removes factors
(`/account/mfa/remove`), regenerates recovery codes (`/account/mfa/recovery`),
and gates `/login` behind a per-process 5-minute challenge (`/login/mfa`) — no
session is minted until the TOTP code or a recovery code verifies. Verified:
`test/console.test.ts` (FINAL-005 ×1: enroll, no-session-before-2FA, wrong code,
TOTP login, recovery-code login); auth/flow-007-010 suites still green.

- [x] Add Account → Security section: enroll authenticator, confirm code, show save recovery codes.
- [x] Add a second-factor step to `/login` when `isMfaEnabled`.
- [x] Add factor list + remove factor, and recovery-code regeneration.
- [x] Enforce recent-auth step-up consistently with the existing policy. _(unchanged policy; MFA is additive)_

**Acceptance:** An admin can enable MFA, sign in with it, and recover with a code.

**Tests:** HTTP enroll→login-challenge→verify; recovery-code login; remove factor.

**Starting points:** `src/core/auth.ts`, `src/console/serve.ts` (account/login routes).

### FINAL-006 — Add an admin Audit Log page

**Source:** Issue 5. `GET /api/audit` exists; no page consumes it.
**Done (2026-09-18):** added `src/console/audit.ts` and `GET /console/audit`
(admin/owner-gated) with actor/action/from/to/request filters, pagination, and
links to referenced claims/requests/decisions; added an admin "Audit" nav entry.
Reuses `queryAudit` + `auditLinks`. Verified: `test/console.test.ts` (FINAL-006 ×1).

- [x] Add `/console/audit` (admin/owner-gated) with actor/action/date filters + pagination.
- [x] Reuse `queryAudit`; render with the shared list shell. _(custom filter form, same query)_
- [x] Link from the nav.

**Acceptance:** Admins can answer "who did X, when?" in-product.

**Tests:** console HTTP test for filtered audit listing.

### FINAL-007 — Self-serve data export & erasure from the console

**Source:** Issue 6. Export and erasure are CLI/API only.
**Done (2026-09-18):** added `src/console/data.ts` and routes `GET /console/data`,
`GET /console/data/export` (JSON download attachment), `POST /console/data/erase`
(admin/owner-gated with typed slug confirmation, atomic transaction, session
invalidation, and receipt redirect), and public routes `GET /receipts/erasure`
and `GET /receipts/erasure/:slug` for verified erasure proof. Linked from setup
and admin nav. Verified: `test/console.test.ts` (FINAL-007 ×1).

- [x] Add an admin "Data & retention" page: download export bundle; request erasure.
- [x] Erasure uses export-first, typed confirmation, and shows the receipt.
- [x] Add a page/route to verify an erasure receipt.

**Acceptance:** An enterprise admin can export and erase without a terminal.

**Tests:** console HTTP test for export download + erasure request gating.

### FINAL-008 — Make password reset & email verification truthful

**Source:** Issue 2. No mailer; reset/verification cannot complete for a user.
**Done (2026-09-18):** added mailer configuration detection (`hasMailerConfigured()`)
in `src/console/serve.ts`; when no mailer is configured, relabels buttons to
"Request operator reset link" / "Request operator verification", states expected
turnaround (<1 hour for reset, same-day for verification), and explains that an
operator can retrieve the link via `vital reset-link` or `vital verify-link`
(added in `src/cli.ts`). When mailer is configured, switches to transactional
mailer copy ("Send reset email"). Verified: `test/console.test.ts` (FINAL-008 ×1).

- [x] Either integrate transactional email delivery, or relabel as explicit operator-assisted.
- [x] Remove/relabel the "Send verification link" button when delivery is not configured.
- [x] State expected turnaround and contact in the user-facing copy.

**Acceptance:** The user-facing promise matches what the system can actually deliver.

**Tests:** console HTTP copy/behavior test per configured mode.

### FINAL-009 — Give deliverables a visible authoring path

**Source:** Issue 3. Deliverables can be reviewed but not created/uploaded in-product.
**Done (2026-09-18):** added deliverable authoring and empty/pending states in
`src/console/deliverable.ts` and `POST /console/requests/:id/deliverable` in
`src/console/serve.ts`. Approved requests without deliverables display "Pending
deliverable draft from worker or agent" and provide an in-product authoring form.
When revision is requested, a "Submit revised deliverable" form is provided.
The handler extracts content, schema, and `[claim:...]` tags (or request refs),
persists versions via `persistDeliverableVersion`, and audits `console.draft-deliverable`.
Unapproved requests show "Awaiting request approval".
Verified: `test/console.test.ts` (FINAL-009 ×1).

- [x] Add a "Draft deliverable" action on approved requests (or an explicit pending-worker state).
- [x] Show an intentional empty/pending state when no deliverable exists yet.
- [x] Keep grounding checks + versioning in the existing pipeline.

**Acceptance:** A user can reach a reviewable deliverable from an approved request.

**Tests:** console HTTP lifecycle from approved request to deliverable review.

### FINAL-010 — Team roster scale + bulk onboarding

**Source:** Issue 9. `/team` has no search/filter/pagination; invites are one-at-a-time.
**Done (2026-09-18):** added member search (`q`), role filter (`role`), status
filter (`status`), and pagination (`page`, `pageSize`) to `teamPage` and
`GET /team` in `src/console/serve.ts`. Updated `POST /team/invite` to support
multi-address invitations (comma, newline, or semicolon delimited), with summary
counts and error reports. Single invites preserve existing behavior and status codes.
Verified: `test/console.test.ts` (FINAL-010 ×1).

- [x] Add search + role/status filters + pagination to the roster.
- [x] Support multi-address invite entry (and optionally CSV import).

**Acceptance:** A large org can find a member and onboard several at once.

**Tests:** console HTTP test for roster search/pagination.

---

## P2 — Consistency, resilience, and polish

### FINAL-011 — No-JS fallback for approval/correction

**Source:** Issue 10. Core buttons ship `disabled` and require `REVIEW_SCRIPT`.
**Done (2026-09-18):** removed `disabled` attribute from submit buttons across
`src/console/review.ts`, `src/console/detail.ts`, and `src/console/deliverable.ts`.
Updated `<noscript>` hints to clarify that standard full-page form submissions
operate without JavaScript. Added `prefersHtml(req)` detection to
`POST /api/requests/:id/(approve|decline)` and `POST /api/deliverables/:id/(approve|request-changes)`
in `src/console/serve.ts` so browser form submissions redirect back to detail/queue
with flash messages, while preserving JSON responses for API/fetch callers.
Verified: `test/console.test.ts` (FINAL-011 ×1).

- [x] Render plain HTML form POST fallbacks; keep JS as progressive enhancement.

### FINAL-012 — Standardize irreversible-action confirmations

**Source:** Issue 14. External publish uses only a checkbox.
**Done (2026-09-18):** when `version.externalPublish` is true, deliverable approval
in `src/console/deliverable.ts` renders `destructiveConfirm` styling and requires
typing `PUBLISH` (`<input name="confirmText" placeholder="PUBLISH" required>`).
In `POST /api/deliverables/:id/approve` in `src/console/serve.ts`, approval is rejected
with HTTP 400 (`type PUBLISH to confirm external publication`) unless `confirmText === 'PUBLISH'`.
Verified: `test/console.test.ts` (FINAL-012 ×1).

- [x] Apply `destructiveConfirm` + typed confirmation to irreversible actions.

### FINAL-013 — HTML error pages for browser GET validation failures

**Source:** Issue 15. Malformed GET params return JSON in the browser.
**Done (2026-09-18):** added `prefersHtml(req)` and `respondGetError(req, res, status, message)`
in `src/console/serve.ts`. When a browser navigates to malformed GET routes
(e.g., negative/invalid pagination, non-numeric days, invalid request/claim IDs),
returns a styled HTML error page (`errorPage`) with HTTP 400/404 if `Accept: text/html`
is requested, while continuing to return JSON `{ error: message }` for API/fetch callers.
Verified: `test/console.test.ts` (FINAL-013 ×1).

- [x] Render an HTML error page for browser requests; keep JSON for fetch/API callers.

### FINAL-014 — Shared nav + terminology pass

**Source:** Issues 12, 13. Inconsistent shells, terminology drift (Rooms/scopes/Mission
Control; approval variants; "Needs a human"/"Human work").
**Done (2026-09-18):** updated `NavKey`, `NavAvailability`, and `buildConsoleNav`
in `src/console/render.ts` to include top-level entries for `requests` (`/console/requests`),
`claims` (`/console/claims`), `rooms` (`/console/rooms`), and `humanWork` (`/console/human-work`).
Standardized terminology across console pages to "Human work" and "Rooms", ensuring
consistent active navigation states and headers across all authenticated views.
Verified: `test/console.test.ts` (FINAL-014 ×1).

- [x] Use one shared header/nav across all authenticated pages.
- [x] Add top-level entries (or a Browse menu) for Requests/Claims/Rooms/Human work.
- [x] Pick one term per concept and enforce it.

---

## Verification baseline

- `npm run typecheck` must stay at 0 errors.
- `npm test` must stay green; add targeted tests per item.
- Browser state/accessibility claims require their own validation.
