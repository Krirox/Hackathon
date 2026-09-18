# flow_TODO.md — End-user flow audit backlog

Audit by a product-design / UX / QA lens. Purpose: find flows that are missing,
incomplete, inconsistent, or logically broken **from an end-user perspective** —
not a code inventory. This file records **actionable backlog items** (verified
against the current implementation) rather than restating completed work.

## Current state (verified 2026-09-18)

These flows **already exist and are covered by tests**. They are NOT in the
backlog; do not re-plan them. See `AUDIT.md` (F01–F12) and tests in
`test/{auth,console,session-flow,backup-restore,export-audit,e2e-gates}.test.ts`.

- **Auth**: signup/claim, login, password reset (self-serve email + operator
  `vital reset-link`), MFA (TOTP + recovery codes), logout, lockout, session
  expiry, forced activation, CSRF (incl. multi-tab family), setup secret.
- **Team**: invite, accept link, resend, revoke, disable (with handoff +
  session revocation), reactivate, role change, ownership transfer, roster
  search/filter/pagination.
- **Onboarding**: guided `/setup` activation checklist (owner → accountable →
  scope → source → policy → budget → first receipt → first workflow), source
  test/sync, labeled sample walkthrough, room provisioning.
- **Data portability**: ledger export (snapshot / evidence-package /
  backup-reference **with manifest + retention + artifact ownership**), audit
  log query + links, per-tenant GDPR erasure + browser-verifyable receipt,
  backup/restore file drill (source-level, tested).
- **Resilience**: worker heartbeat + readiness (`/api/metrics`), dep-split
  liveness vs readiness, draft carry across session expiry, reviewer rationale
  draft restore, emergency stop / drill / recover.
- **Readiness**: `vital status --readiness`, `vital verify`, `/api/metrics`
  `readiness`, `integrationReadinessState`, worker staleness detection.

## Backlog — verified gaps (prioritised)

Priority: `[P0]` critical · `[P1]` high · `[P2]` medium · `[P3]` low.
Effort: `S` <1 day · `M` 1–4 days · `L` 1–2 weeks.

---

### [P1] `M` — Activation reports a "bound" address, not a "ready" result — **IMPLEMENTED**
**Flow:** Activation / server start → port select → browser → console load.
**Problem:** `vital serve` resolved after the HTTP server bound (`server.listen`
resolves with the bound address), but the CLI/user was not told whether the
console was actually **ready to serve** (migrated, authed, first request
answered). A first-time user (or a scripted boot) could get a URL before the
console answers, or a port conflict with no clear gate.
**Fix:** `startConsoleServer` now returns a `ready()` loopback probe to
`/healthz` (FLOW-013). `vital serve` awaits it and classifies activation into
`ready` / `blocked` / `failed`, printing a recoverable next step on failure.
**Ideal flow:** run `vital serve` → `vital console ready — URL` on success; on a
non-ready state, a classified `blocked|failed` message names the retry/diagnose
command (`vital status --readiness`).
**Status:** implemented in `src/console/serve.ts` (`ConsoleServer.ready`) +
`src/cli.ts` `serve`; covered by `test/console.test.ts` `FLOW-013: server.ready()
classifies a healthy console as ready, not just bound`.

---

### [P1] `M` — Readiness/health state is not surfaced inside the authenticated console UI — **IMPLEMENTED**
**Flow:** Operator opens console → wants to confirm DB, worker, integrations,
and activation health at a glance.
**Problem:** `/api/metrics` readiness existed (FLOW-023) but as a JSON API.
**Fix:** The console home now renders a **System readiness** strip
(`id="system-readiness"`) using the same `checkReadiness` checks as
`/api/metrics` — DB (required), worker (required once it ever checked in, else
`not configured`), integrations (`not configured` until configured). `needs
attention` renders red, `ok` green, `not configured` grey. Each check links to
`/setup` / `/api/metrics`.
**Status:** implemented in `src/console/serve.ts`
(`computeReadiness`/`renderSystemReadiness`, wired into the home GET handler);
covered by `test/console.test.ts` `FLOW-013: home renders the system-readiness
strip`.

---

### [P1] `M` — Login/session-expiry recovery guidance for GET navigation — **VERIFIED ALREADY HANDLED**
**Flow:** Session expires or absent mid-navigation → refresh → re-login.
**Problem check:** A session-less GET route could dead-end at login with no
return-to-task path.
**Verdict:** Already implemented. `redirectLogin(res)` in `src/console/serve.ts`
redirects session-less GETs via `loginPath({ next: returnPath() })` (so the user
returns to the original page), and expired sessions use
`reauthResume(returnPath())` with the "you will return to your task after signing
in" banner. Draft carry for form posts (`session-flow.ts`) is covered. No further
work needed for GET navigations.

---

### [P1] `M` — Backup/restore is operator/CLI-documented but not a discoverable console journey — **SCOPE CLARIFIED**
**Flow:** Operator/enterprise user needs: create backup → verify → restore →
confirm.
**Problem:** Backup/restore was a tested **file-copy drill**
(`test/backup-restore`), and erasure defers `backups` as out-of-scope, but there
was no product surface telling a non-CLI user what backups cover.
**Decision:** DB-file backup/restore management stays out of console scope for
this milestone; the supported portable record is the verified snapshot export.
**Fix (done):** `/console/data` now renders a **Backup &amp; restore** card that
states backups are operator-managed infrastructure, points to
`vital status --readiness` for health, and re-confirms the export is *not* a
backup and cannot be restored by import. No surprise for an enterprise operator
looking for a "Backup" tile.
**Ideal flow:** `/console/data` shows "Backups: operator-managed out of scope —
snapshot export (verified delivery) is the supported portable record".
**Status:** implemented in `src/console/data.ts`; covered by
`test/console.test.ts` `FLOW-013: …backup scope`. If a managed create/verify/
restore surface is later desired, promote this card to a full flow.

---

### [P1] `S` — Every console mutation path audit: confirm success/empty/error copy is consistent
**Flow:** All mutations (setup, team, data, review, workflows, rooms).
**Problem:** Succesful/empty/error states are implemented per-surface but vary in
tone and placement (some inline `.success`, some redirect + notice, some just a
redirect). Inconsistent success copy confuses whether an action landed.
**Fix:** Stand up a lightweight consistency pass: every POST should end in a
success summary naming the object + a follow-up action, or a structured error
with a recoverable next step + correlation id. No silent redirects.

---

### [P2] `S` — Missing entering-flag for "source configured but never synced" on home readiness
**Flow:** Operator configures source in setup → home should reflect "pending
first sync".
**Problem:** `integrationReadinessState` marks `configured` healthy; a configuredbut-never-synced source can read as healthy when the user actually is mid-onboarding.
**Fix:** In the home readiness strip (item above) and the activation panel, surface
`configured, never synced` distinctly from `ready`. Reuse `firstReceipt == null`
with `sourceState != unconfigured`.

---

### [P2] `S` — Empty-state list copy on dashboard/rooms should be user-actionable
**Flow:** New org opens Console home; no sessions/rooms/workflows yet.
**Problem:** Board views render "no results" text but not always a primary action
("Start first workflow" exists only in the activation panel and setup).
**Fix:** Ensure every aggregate list with zero rows shows a one-line reason + the
most relevant action (`/setup`, `/setup/sample`, `/setup/rooms`) rather than a
bare empty count.

---

### [P2] `M` — Import: no user-visible file-import journey (scope decision needed)
**Flow:** User has structured external data → wants it into the ledger.
**Problem:** Ingestion is collector-based (files via directory collector, GitHub,
Serper). There is no general "upload file → map → validate → preview → import"
as evidence, and `export.ts` explicitly documents import as unsupported for
history (append-only). That is a **deliberate** design decision.
**Fix:** Decision needed: (a) keep import unsupported and say so loudly on Data &
Export (recommended for history integrity), and/or (b) add a *new-record* import
as OBSERVATION with validation/preview. Record the decision; do not silently omit.

---

### [P2] `S` — Terminology drift audit (scope/room, request/workflow, review/approval)
**Flow:** Cross-page naming.
**Problem:** Product uses "scope" and "room", "request" and "workflow",
"review" and "approval" somewhat interchangeably across surfaces; new users
infer distinct meanings where none exist.
**Fix:** One glossary-gated pass: align nav + copy to a single term set per
concept, keep aliases in `docs/glossary.md`.

---

### [P3] `S` — Re-auth (15-min) banner on sensitive ops give no countdown expectation
**Flow:** Role change/disable require recent auth; rejection is clear but abrupt.
**Fix:** On the Team page, note which actions require a fresh sign-in and that
the user will be returned to the task (reuse `reauthResume` copy).

---

## Recommended user journey improvements (synthesis)

1. **Activation clarity** — **done**: `vital serve` returns a real `ready` result
   (loopback probe), classified into ready / blocked / failed with a retry step.
2. **Visible system status** — **done**: rendered tri-state System readiness strip
   on home (DB / worker / integrations), red-on-failing, grey-on-not-configured.
3. **Session-expiry continuity** — verified already implemented: GET redirects
   carry `next`; draft carry covers form posts.
4. **Backup/export honesty** — **done**: `/console/data` Backup &amp; restore card
   states operator-managed scope and that exports are not restore sources.
5. **Consistent states** — pending (work item below): success should name the
   object + next action; errors should name a recovery step.
6. **Terminology** — pending: align one concept → one term across copy.

## Suggested overall product-flow score

**7.8 / 10.** Core auth, team, onboarding, export, audit, and resilience flows are
real and tested; the prior gaps in *visibility and continuity* (activation
ready-state, in-UI readiness, backup out-of-scope clarity) are closed. Remaining
work is consistency and polish: uniform success/empty/error copy, "configured-but-
never-synced" surfacing, a possible managed backup surface, and terminology
alignment — no structural flow breaks remain on the audited paths.