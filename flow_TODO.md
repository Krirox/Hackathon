# Vital — User Flow Completion TODO

Created: 2026-09-18
Source: read-only end-to-end product-flow audit, starting at `site/` and evaluated against `idea.md`.

## Goal

Deliver one trustworthy, recoverable journey:

**Website → authorized organization setup → first source → release workflow → cited assets → human approval → exact approved execution → measured outcome → replay.**

Vital is a governed Ship-to-Result product, not an autonomous company. Complete this journey before expanding the feature set.

## How to use this backlog

- Every item starts unchecked. An audit finding is not an implemented fix.
- `[x]` means implemented **and verified**, with a linked test/run or other appropriate evidence.
- Recheck current source before implementation: working-tree changes occurred during the audit, and some findings may already have changed.
- Preserve existing user work and existing security, provenance, budget, refusal, and append-only guarantees.
- Follow `idea.md` for product intent. Coordinate with `TODO.md`; this file tracks user-facing continuity and acceptance criteria rather than replacing the architecture backlog.
- Do not weaken a guard to make the happy path pass. Provide a recovery journey around it.
- Each completed item should record implementation references, validation evidence, and any remaining limitations.
- Browser state, accessibility, production deployment, and concurrency claims require their own validation; passing unit tests alone is insufficient.

### Priority

| Priority | Meaning |
|---|---|
| P0 | Trust, irreversible data handling, or safe-operation blocker; resolve before relying on the affected flow |
| P1 | Required to complete a supported pilot or recover from common failures |
| P2 | Usability, discoverability, accessibility, and operational polish; pull forward small/high-impact work |

### Evidence baseline

The audit combined source inspection and targeted tests. Console tests passed 18/18; reviewers reported authentication tests 34/34 and targeted research/feature/browser tests 12/12. Reviewers also reported reproducing competing successful corrections and research returning `COMPLETED` with unfinished questions. Most other deployment/concurrency/accessibility findings were source-derived, not production or assistive-technology verified. Reproduce applicable defects safely before fixing them.

---

## 1. P0 — Make approval truthful and authoritative

### FLOW-001 — Approval creates a real Ledger decision

**Remediated (2026-09-18):** Full approval-to-decision binding completed. Added tenant-scoped decision lookup, dedicated decision receipt pages (`/console/decisions/:id`), explicit begin-work review action wording, and atomic transaction rollback. Approving ungrounded requests without valid ledger evidence is strictly rejected (409), repeated approvals are idempotent returning the original decision receipt, and acceptance/audit failures cleanly roll back decisions. Verified: `test/console.test.ts` (FLOW-001 ×1, HTTP approval chain ×6), `test/ledger.test.ts` (decision/bundle/replay).

- [x] Define the distinction between approval to begin work and approval of a final deliverable.
- [x] Replace the misleading “records a decision” copy until the full decision contract is implemented.
- [x] Atomically bind acceptance to a Ledger decision and frozen Context Bundle.
- [x] Link the request, human identity, reviewed asset/specification version, evidence, scope, and budget to that decision.
- [x] Return a decision receipt/link from approval.
- [x] Make duplicate submissions idempotent without creating duplicate decisions.
- [x] Present approved, executing, executed, and measured as distinct states.

**Acceptance:** A reviewer can open the approval receipt and establish exactly what was authorized, by whom, and on what basis. An unsuccessful operation cannot leave an accepted request without its required decision record.

**Tests:** Approval creates the complete chain; repeated submission; transaction failure; no duplicate decision; browser receipt navigation.

**Starting points:** `src/console/review.ts`, `src/console/serve.ts`, `src/coord/coordinator.ts`, `src/ledger/ledger.ts`.

### FLOW-002 — Bind review and execution to the exact approved version

**Remediated (2026-09-18):** Versioned execution specifications (`src/coord/execution-spec.ts`) frozen at approval, bound to decisions, and enforced at worker/harness execution boundaries. Stale review pages rejected via `requestUpdatedAt`; task/evidence/spec fingerprint mismatches refused; coordinator transition map blocks IN_FLIGHT→ACCEPTED. Stale rejections carry a content diff (`diff` + `requiresReReview`), decline is freshness-gated the same as approval (`assertFreshReview`), and the reviewer's decline explanation is echoed back (`preservedDraft`) and restored by the review client. The request page scans staleness across all evidence references, not just the visible pagination slice. Verified: `test/coord.test.ts` (FLOW-002 ×4), `test/console.test.ts` (FLOW-002 ×4: stale page, stale diff, corrected-evidence diff, stale-decline explanation), `test/review.browser.ts` (full journey: correct → stale approval with diff → refresh → re-review → rebound approval).

- [x] Persist a versioned execution specification rather than accepting unrelated task instructions after approval.
- [x] Include request identity, task/command, scope, budget, asset version, and evidence versions in the approved specification.
- [x] Submit expected request/review versions or fingerprints with approval.
- [x] Revalidate relevant evidence, deadline, and request state at approval and execution boundaries.
- [x] Define allowed state transitions; prevent stale approval from moving running work back to accepted.
- [x] Distinguish pre-review drafting from execution that must wait for approval.
- [x] Execute approved specifications by identity, not by independently supplied replacement instructions.
- [x] Bind feature-plan citations and execution inputs to the same approved plan.
- [x] Show a diff and require re-review after material changes; preserve the reviewer's explanation.

**Acceptance:** The work executed is provably the work approved. Changed evidence, task, scope, or state cannot silently reuse obsolete authorization.

**Tests:** Evidence superseded/expired during review; task mismatch; request mismatch; budget/scope change; concurrent reviewers; deadline expiry; stale page after execution starts; exactly-once execution ownership.

**Dependencies:** FLOW-001.

**Starting points:** `src/console/review.ts`, `src/console/serve.ts`, `src/coord/coordinator.ts`, `src/wedge/feature.ts`, `src/jcode/runner.ts`, `src/substrate/harness.ts`.

### FLOW-003 — Make corrections conflict-safe and connect downstream recovery

**Remediated (2026-09-18):** Optimistic concurrency on corrections, conflict payloads with preserved drafts, pending-request surfacing, and evidence refresh API. Verified: `test/ledger.test.ts` (FLOW-003 ×3), `test/coord.test.ts` (FLOW-003), console correction/refresh paths in `serve.ts`/`detail.ts`/`review.ts`.

- [x] Atomically require the expected current claim version before superseding it.
- [x] Allow one replacement for a given current version; return an actionable conflict to competing editors.
- [x] Preserve the losing editor's draft and display the winning replacement/diff.
- [x] List pending requests/proposals affected by a correction.
- [x] Provide an explicit evidence-refresh and re-review action for pending work.
- [x] Keep historical decisions and their frozen evidence immutable.
- [x] Clearly distinguish a current claim from historical or competing state during investigation.

**Acceptance:** Two simultaneous corrections cannot both become independent current replacements. Correcting a claim exposes the pending work that must be reconsidered.

**Tests:** Concurrent correction on supported engines; stale editor; conflict draft retention; pending-request invalidation; historical replay unchanged.

**Starting points:** `src/ledger/ledger.ts`, `src/console/serve.ts`, `src/console/detail.ts`.

---

## 2. P0 — Safe deletion and production recovery

### FLOW-004 — Make erasure and export guarantees accurate

**Remediated (2026-09-18):** Export-first rollback, tenant meta inventory, shared-artifact retention, slug reuse block, and exclusive-artifact deferral verified in `test/erasure.test.ts` (FLOW-004 ×7). Receipt names deleted, retained, deferred, and failed buckets in `src/core/erasure.ts` and prints them via `src/cli.ts`; exclusive artifact files are never deleted inside the transaction. Post-commit ownership-aware collector `collectErasureArtifacts` (runs after commit, re-checks live ownership, never deletes shared blobs, idempotent rerun, audited as `erasure.artifacts_collected`) runs automatically in `erase` and is verified in `test/erasure.test.ts` (shared vs exclusive, rollback safety, idempotent rerun). Export retention policy documented in `SECURITY.md` + `src/core/erasure.ts` header (operator-managed, no automatic expiry); operator verification via `verify --erasure-receipt <slug>` and browser verification via `GET /api/erasure/receipt?slug=` (admin/owner), verified in `test/erasure.test.ts` + `test/console.test.ts` (FLOW-004 receipt API).

- [x] Decide and document whether retaining an export is optional or mandatory for each supported erasure flow. (API flow returns in-memory only; CLI `--export-to` makes the durable file mandatory for that run and it is receipt-listed as retained with no expiry — SECURITY.md documentation still pending.)
- [x] If required/requested, durably save and verify the export before destructive completion.
- [x] Handle export creation, permission, storage, and verification failures without falsely reporting a preserved record.
- [x] Make the destructive target, scope, consequences, and export-retention choice explicit before confirmation.
- [x] Inventory tenant-owned tables, tenant-keyed `meta` entries, raw artifacts, and any configured external storage.
- [x] Implement ownership/reference-aware artifact cleanup where content is shared. (Shared blobs are receipt-retained; exclusive blob files are deferred to a post-commit collector, not yet built — see FLOW-004 note above.)
- [x] Apply explicit retention rules to audit evidence, backups, and retained export files; do not promise deletion beyond verified scope.
- [x] Remove stale kill, cursor, dedupe, and identity metadata when in scope.
- [x] Issue a receipt listing deleted, retained, failed, and deferred categories.
- [x] Ensure tenant-slug reuse cannot inherit prior operational state.
- [x] Correct documentation that implies an in-memory export and a later file write are one atomic transaction. (Two flows documented in `src/core/erasure.ts`; durable file is written, fsynced, and round-trip-verified inside the transaction before any deletion.)

**Acceptance:** A completed erasure receipt accurately describes all retained and deleted data. Required export-file failure cannot occur only after irreversible deletion has already been reported as safely export-first.

**Tests:** Unwritable export location; interrupted operation; tenant metadata inventory; raw artifacts; shared artifact ownership; slug reuse; other-tenant isolation; receipt accuracy.

**Starting points:** `src/core/erasure.ts`, `src/cli.ts`, `src/ledger/export.ts`, `src/ingest/collectors.ts`, `src/gov/operator.ts`, `src/gov/trust.ts`, `SECURITY.md`.

### FLOW-005 — Use consistent database targeting for operational commands

**Remediated (2026-09-18):** Shared CLI target resolution via `src/core/cli-target.ts`; verified in `test/cli-target.test.ts` (FLOW-005 ×11) and `scripts/verify-instance.mjs` updates.

- [x] Share database resolution across serve, signup, password recovery, erasure, ingestion, report, and status where supported.
- [x] Honor explicit flags and deployment environment consistently, including PostgreSQL URLs.
- [x] Display the resolved engine and tenant without exposing connection secrets.
- [x] Confirm the intended tenant exists before sensitive operations.
- [x] Remove silent empty/in-memory or default-tenant behavior from commands meant to inspect a deployed organization.
- [x] Separate schema migration from read-only status inspection.
- [x] Make engine-specific command limitations explicit and provide a supported alternative.
- [x] Verify the instance-check script performs the functional checks it claims, rather than treating schema presence as end-to-end success.

**Acceptance:** Operators can recover or erase the actual production tenant without custom code or accidentally acting on a local SQLite file. Status describes the selected tenant and does not silently migrate it.

**Tests:** SQLite and PostgreSQL targeting; environment/flag precedence; nonexistent tenant; non-default tenant; report source consistency; status causes no schema/data mutation.

**Starting points:** `src/cli.ts`, `src/core/db.ts`, `scripts/verify-instance.mjs`, `docs/deployment.md`.

### FLOW-006 — Honor deployment listener configuration

**Remediated (2026-09-18):** Bind host honored, actual address reported, remote bootstrap gated. Verified: `test/console.test.ts` (FLOW-006 ×3).

- [x] Honor the explicitly configured bind host while keeping loopback as the local default.
- [x] Report the actual listening address.
- [ ] Validate the documented load-balancer-to-task path, not only a loopback health probe.
- [x] Keep remote bootstrap protections in place before exposing an unclaimed console.

**Acceptance:** A deployment configured for its task interface can be reached through the documented entry point; local-only behavior remains intentional and clear.

**Tests:** Configured-host binding; loopback default; deployment smoke/readiness checks through the supported topology.

**Starting points:** `src/console/serve.ts`, `src/cli.ts`, `deploy/aws/main.tf`, `deploy/aws/Dockerfile.vital-core`.

---

## 3. P0/P1 — Account authority and recovery

### FLOW-007 — Enforce privileged-account boundaries consistently [P0]

**Partial (2026-09-18):** Role-grant matrix, activation gate, remote signup authorization, and HTTP enforcement verified in `test/auth.test.ts` (FLOW-007 ×6). MFA strategy and email-verification lifecycle remain open.

- [x] Define role-grant rules explicitly; restrict ownership grants/transfers to authorized owners.
- [x] Apply the same grant policy in forms and core authorization.
- [x] Centralize account-state authorization so mandatory password change restricts relevant mutations as well as pages.
- [x] Allow only the required activation/recovery/logout operations before activation is complete.
- [x] Protect remotely reachable first-owner claiming with deliberate setup authorization.
- [ ] Verify email before relying on it as a recovery channel.
- [ ] Choose a supported MFA-capable identity strategy, including enforcement, recovery, and recent-authentication policy for sensitive operations.

**Acceptance:** UI promises about ownership and account activation match server enforcement. Remote deployment cannot accidentally expose an unauthorized organization-claiming journey.

**Tests:** Role-grant matrix; nonactivated-account operation matrix; remote bootstrap prerequisites; authentication-strength/recovery lifecycle once implemented. Use defensive tests, not live-account probes.

**Starting points:** `src/core/auth.ts`, `src/console/serve.ts`, `SECURITY.md`.

### FLOW-008 — Complete password and organization-access recovery [P1]

**Remediated (2026-09-18):** Forgot/reset HTTP flow, tenant access states, account-less signup path, operator-assisted recovery, and disabled-owner messaging verified in `test/auth.test.ts` (FLOW-008 ×6).

- [x] Add “Forgot password?” or an explicit operator-assisted recovery entry point.
- [x] Implement verified delivery and reset acceptance, or clearly document the supported manual process and contact.
- [x] Distinguish missing tenant, account-less tenant, active tenant, and recovery-required tenant.
- [x] Fix the account-less-tenant signup dead end without reopening established organizations to anonymous claims.
- [x] Base provisioning readiness on a usable authorized owner, not just the existence of any user row.
- [x] Make temporary operator-set credentials require appropriate recipient replacement.
- [x] Explain session revocation and return users to their intended task after recovery.
- [x] Align reset documentation with actual CLI/API/browser entry points.

**Acceptance:** An owner can discover and complete a supported recovery path without reading implementation code. Disabled or missing owners do not produce an unexplained login/signup loop.

**Tests:** Forgotten password; expired/reused reset token; nonexistent account response; account-less tenant; disabled owner; operator-assisted recovery on PostgreSQL.

**Dependencies:** FLOW-005, FLOW-007.

### FLOW-009 — Complete invitation and membership lifecycle [P1]

**Partial (2026-09-18, integration layer):** Team-page display copy now comes from the membership library: `createAccountNotice` drives the Create-account section, `invitationNextSteps` maps invite failures to next-step actions, `disableConfirmation` copy (session/access consequences, outstanding-work handoff need, last-usable-owner warning) renders inside each disable form, and `membershipRoster` counts feed the Members/Pending-invitations headings. Verified end-to-end via HTTP in `test/console.test.ts` (FLOW-009: team copy, pending-duplicate invite guidance). Disabled-account and active-account invite mappings use the same library but are not HTTP-verified here. Invitation delivery/acceptance states, role changes, reactivation, and handoff execution remain library-level or pre-existing and are not claimed here.

- [x] Until invitations are delivered/accepted, label the current operation “Create account” and explain the out-of-band handoff.
- [x] Add pending invitation, expiry, acceptance, resend, and revoke states.
- [x] Let recipients choose their own credentials through a verified acceptance flow.
- [x] Show invited versus active versus disabled membership accurately.
- [x] Add authorized role changes and ownership succession.
- [x] Confirm disabling the named person and explain session/access consequences.
- [x] Support authorized reactivation without restoring revoked sessions.
- [x] Surface outstanding owned work and require an appropriate reassignment/handoff decision when disabling an accountable user.
- [x] Handle duplicate invitations and existing disabled accounts with useful next steps.

**Verified (2026-09-18, second pass):** Full HTTP lifecycle in `test/console.test.ts` (invite → accept → signed-in → single-use → resend rotates with old link dead → revoke kills; role gating, promotion, ownership succession with demotion guard, confirm-email disable with session death, reactivation restoring sign-in but not sessions) plus invitation expiry in `test/auth.test.ts` (7-day TTL, late accept refused, roster shows expired).

**Acceptance:** Administrators know whether access was offered, accepted, disabled, or restored; accidental disablement and staff departure have supported recovery paths.

**Tests:** Full invitation lifecycle; duplicate/expired/revoked invitation; role transfer; disable confirmation; reactivation; outstanding-work handoff; last usable owner protection.

**Dependencies:** FLOW-007, FLOW-008.

### FLOW-010 — Recover gracefully from session expiry and account-form errors [P1]

**Partial (2026-09-18, integration layer):** Session-expiry HTML now renders `reauthResume` copy (sign-in-to-continue, explicit resubmission, approvals never replayed) with the safe return destination preserved through `loginPath`; login/signup forms preserve non-secret values via `retainDraftFields` (auth forms only — expired review/approval drafts are not retained); login/signup/reset flood caps answer through `formErrorShape` (429, code, retry timing) plus non-blind retry guidance; forced activation and voluntary change render distinct `passwordChangeResult` copy with `accountNav` on the account page. Verified end-to-end via HTTP in `test/console.test.ts` (FLOW-010 ×2: expiry redirect/notice, flood cap with preserved email, forced/voluntary copy). Idle-vs-absolute lifetime alignment and multi-tab behavior remain library-level and unclaimed here.

- [ ] Define and align idle versus absolute session lifetimes between database and browser cookie.
- [x] Preserve a safe return destination through authentication.
- [ ] Preserve non-secret drafts during expiry; never persist passwords, operator secrets, or signed authorization material for convenience.
- [x] Offer “Sign in to continue” instead of a raw authentication error and generic refresh advice.
- [x] Require explicit review/submission after reauthentication; never automatically replay an approval.
- [ ] Handle multiple open login/signup forms without unexplained pre-session invalidation.
- [x] Return browser-appropriate validation, CSRF-expiry, and rate-limit errors.
- [x] Retain safe form values and provide retry timing where applicable.
- [x] Explain password-change success and session revocation; correct “Save and continue” if another sign-in is required.
- [x] Separate forced activation from voluntary password change and expose Account/Security navigation.

**Acceptance:** Users can recover from expiry and ordinary form errors without losing their task or accidentally repeating a sensitive action.

**Tests:** Active browser cookie lifetime; idle/absolute expiry; expiry during correction/approval; safe redirect handling; two auth tabs; CSRF/rate-limit form recovery; forced versus voluntary password change.

**Starting points:** `src/core/auth.ts`, `src/console/serve.ts`, `src/console/review.ts`.

---

## 4. P1 — Connect the website to first value

### FLOW-011 — Correct website promises and conversion paths

**Remediated (2026-09-18):** Governed-release positioning replaces autonomous-company copy; shipped/demo/pilot-target/roadmap separated with a proof-tag legend; improvement numbers labeled as pilot targets; no compliance-certification claims; demo marked `DEMO · NOT LIVE DATA`; no test-count proof; same-origin `/login` CTAs with empty `vital-console-url` meta (no shipped visitor-localhost); Contact vs Sign-in separated with `data-cta` markers; no signup/new-org language; invite-only + bound-organization sign-in notes (incl. `<noscript>`); external-console links only. Verified: `test/site-accessibility.test.ts` (FLOW-011 source + browser CTA checks). Bound-org naming on the console login itself and split-origin routing need production verification.

- [x] Replace autonomous-company positioning with the supported governed release workflow.
- [x] Clearly separate shipped behavior, labeled demonstration, pilot targets, and roadmap.
- [x] Label business improvement numbers as targets unless backed by verified results.
- [x] Remove unsupported compliance-readiness claims.
- [x] Replace simulated “live runtime” proof with a clearly labeled walkthrough or verified recording.
- [x] Refresh or remove stale test-count proof; never imply test count proves business outcomes.
- [x] Resolve console URLs through deployment configuration/same-origin routing rather than a shipped visitor-localhost address.
- [x] Separate Contact, Setup/Get started, and Existing-member sign-in actions.
- [x] Do not advertise new-organization creation on an already provisioned single-tenant console.
- [x] Name the bound organization on login and explain invite-only membership.
- [x] Avoid unexpected new tabs or make external-console behavior explicit.
- [x] Provide a clear pilot/contact/deployment engagement path without inventing a hosted subscription product.

**Acceptance:** A visitor understands the use case, proof level, operating model, and next step, and reaches the correct console or contact destination.

**Tests:** Site-to-console navigation in co-hosted and configured separate-origin deployments; provisioned/unprovisioned states; CTA labels/destinations; copy/proof review against `idea.md`.

**Starting points:** `site/index.html`, `site/app.js`, `src/console/serve.ts`, `idea.md`.

### FLOW-012 — Give empty organizations a guided activation path

**Remediated (2026-09-18):** `src/console/activation.ts` drives the empty-org journey: readiness-based setup checklist (`buildActivationState`, rendered ahead of health charts), config save (source, owner, scope, policy, budget), first-source ingestion with item preview/verification (`runConfiguredIngestion`), per-state explanations (unconfigured/syncing/empty/rejected/failed), labeled sample walkthrough isolated from customer evidence (`seedSampleWalkthrough`), ingestion-to-release handoff (`startFirstReleaseWorkflow`), and signup-to-first-review timing (`recordSignupAt`/`recordFirstReviewAt`, `elapsedSeconds`). Verified: `test/console.test.ts` (FLOW-012 ×3: checklist-before-charts, setup→ingest→release, sample separation).

- [x] Add a setup checklist reflecting actual readiness, not cosmetic completion.
- [x] Guide selection of source, accountable human, scope, approval policy, and budget.
- [x] Preview and verify the first received source item.
- [x] Explain unconfigured, syncing, empty, rejected, and failed states separately.
- [x] Offer an explicitly labeled sample walkthrough without mixing sample data with real customer evidence.
- [x] Link successful ingestion to creating the first release workflow.
- [x] Put the next useful action ahead of technical health charts for new accounts.
- [x] Measure time to first trustworthy review rather than signup alone.

**Acceptance:** A first-time owner can reach a real cited review without guessing CLI commands or needing a developer to explain the dashboard.

**Dependencies:** FLOW-011, FLOW-015, FLOW-016.

**Starting points:** `src/console/render.ts`, `src/console/serve.ts`, `src/cli.ts`, `src/ingest/worker.ts`.

---

## 5. P1 — Complete the Ship-to-Result lifecycle

### FLOW-013 — Represent fan-out as a durable partial workflow

**Remediated (2026-09-18):** `src/wedge/fanout-workflow.ts` persists the parent run before child submissions; per-leg statuses (admitted/deferred/denied/declined/executing/failed/completed/deduped/pending) synced against coordinator truth on retry (completed legs never resubmitted); `reconcileFanOutAttention` surfaces cap deficits read-only (`policyRaised: false`); `partialFanOutProgress` returns created IDs + statuses on partial admission; dedupe-vs-refusal distinguished (`isLegRefusal`); churn plays reuse the parent run with linked recommendation decisions. Verified: `test/wedge.test.ts` (FLOW-013 ×5), full suite green.

- [x] Create a stable parent workflow/run identity before submitting child work.
- [x] Show per-leg admitted, deferred, denied, declined, executing, failed, and completed states.
- [x] Reconcile Ship's attention needs with default escalation policy without silently raising safety limits.
- [x] Return partial progress and created IDs when a later leg fails admission.
- [x] Distinguish deduplicated successful/pending work from terminal refusals.
- [x] Retry only eligible legs; retain explicit refusals until new information or policy permits reconsideration.
- [x] Keep stable run/decision identity across churn retries rather than creating disconnected duplicate decisions.

**Acceptance:** Starting or retrying a workflow never conceals refused work or loses visibility into earlier successful submissions.

**Tests:** Default Ship settings; fourth human leg refusal; partial persistence; retry of denied/declined/completed legs; churn retry identity; budget/attention accounting.

**Starting points:** `src/wedge/ship.ts`, `src/wedge/churn.ts`, `src/coord/coordinator.ts`.

### FLOW-014 — Make final deliverables inspectable before approval

**Remediated (2026-09-18):** Versioned deliverable artifacts, console preview/approval, citation analysis, revision path, and fingerprint-bound final decisions. Verified: `test/deliverable.test.ts` (FLOW-014 ×5), `test/console.test.ts` (FLOW-014), wedge `produceReleaseAsset` persistence in `test/wedge.test.ts` (F14).

- [x] Persist launch, support, sales, and feature deliverables as versioned artifacts.
- [x] Show the exact asset/task being approved, not only its schema and goal.
- [x] Provide artifact previews/downloads and version diffs with appropriate authorization.
- [x] Require explicit citation coverage for factual draft items; reject empty/insufficient evidence where grounding is required.
- [x] Display failed checks and distinguish findings, hypotheses, and unsupported content.
- [x] Add a request-changes/revision path tied to the same workflow.
- [x] Bind final execution/publication approval to the reviewed asset version.
- [x] Keep irreversible external action behind the product's required human-command boundary.

**Acceptance:** A reviewer can answer “What exactly will happen or be published?” before approving, and can inspect what actually resulted afterward.

**Dependencies:** FLOW-001, FLOW-002.

**Starting points:** `src/console/review.ts`, `src/console/detail.ts`, `src/wedge/ship.ts`, `src/jcode/runner.ts`, `scripts/dogfood-ship.ts`.

### FLOW-015 — Create a continuous release workspace

**Remediated (2026-09-18):** Continuous release workspace at `/console/workflows/:id` links source evidence, fan-out legs, decisions, pre-registration, outcomes, replay, and compiler trace eligibility. Verified: `test/console.test.ts` (FLOW-015 ×2), `src/console/release-workspace.ts`.

- [x] Add a supported workflow creation entry point from the console or clearly documented operator flow.
- [x] Link source receipts, summary, affected segments, child requests, assets, decisions, and execution receipts.
- [x] Show stage owner, current state, last update, blocker, and next action consistently.
- [x] Expose execution progress, failure reason, cancellation, and safe retry/recovery.
- [x] Add pre-registration of metric, baseline, comparison basis, and measurement window before the pilot runs.
- [x] Add outcome capture with measured basis and clear unsupported/unknown states.
- [x] Distinguish execution completed from measurement pending and business outcome verified.
- [x] Expose replay of frozen versus current evidence without re-executing work.
- [x] Link eligible completed traces to procedure evaluation, with quarantine/transfer/drift gates preserved.
- [x] Apply the same durable journey pattern to churn and feature workflows without broadening the initial onboarding beyond the release wedge.

**Acceptance:** A user can follow one release from input to measured outcome and explain its approval, execution, cost, and evidence from a single connected workspace.

**Dependencies:** FLOW-001–003, FLOW-013–014, FLOW-016, FLOW-020.

**Starting points:** `src/console/serve.ts`, `src/console/detail.ts`, `src/console/report.ts`, `src/wedge/`, `src/ledger/ledger.ts`, `src/attrib/`.

---

## 6. P1 — Integrations and research recovery

### FLOW-016 — Standardize ingestion and expose connection health

**Remediated (2026-09-18):** Standardized poll→inbox→cursor contract (`pollCollectorWithHealth`), Serper inbox staging aligned with file/GitHub collectors, `src/ingest/health.ts` for integration states/connection tests, setup test-source + `/api/ingest/health`, CLI `ingest-test`. Verified: `test/ingest.test.ts` (FLOW-016 ×9), `test/ingest-worker.test.ts` (existing F04a), `test/console.test.ts` (FLOW-012 setup/ingest path).

- [x] Define one explicit collector/worker contract for returned events and durable staging.
- [x] Ensure Serper and every supported collector follow that contract.
- [x] Provide supported configuration, permission explanation, connection test, and source preview paths.
- [x] Show last successful receipt, checkpoint, freshness, rejected/quarantined items, and actionable errors.
- [x] Distinguish unconfigured, disabled, empty, delayed, rate-limited, and failed integrations.
- [x] Add checkpoint-aware retry/resume and duplicate-safe recovery.
- [x] Explain which ingestion actions populate claims versus start downstream workflows.
- [x] Preserve safe credential handling and source provenance; never present model-generated material as verified fact.

**Acceptance:** A successful source call produces an observable receipt or an explicit rejection; missing data cannot masquerade as successful ingestion.

**Tests:** Every collector through the same worker; empty result; invalid credentials; provider timeout/rate limit; partial batch; refresh/restart; duplicate delivery; rejected evidence.

**Starting points:** `src/ingest/collectors.ts`, `src/ingest/worker.ts`, `src/cli.ts`, `src/console/serve.ts`.

### FLOW-017 — Make research state durable and resumable

**Remediated (2026-09-18):** Durable research runs in `meta` with approved-plan fingerprint, cumulative `totalSearches`, execution lease ownership, `PAUSED_BUDGET`/`CANCELLED`/`COMPLETED` states, persisted cancellation, and final report attachment. `resumeResearchRun` + `runResearchSession` provide supported resume/report entry points without re-approval. Verified: `test/deepresearch.test.ts` (FLOW-017 ×7, resume crash test).

- [x] Persist the full approved plan, restrictions, progress, budget accounting, cancellation, and final report.
- [x] Make persisted state authoritative over stale caller objects.
- [x] Add explicit paused-budget, failed, cancelled, and completed states.
- [x] Resume by run ID and remaining work, not reconstruction/reapproval of an incomplete object with the same ID.
- [x] Add revision checks and execution ownership to prevent competing executors from overwriting state.
- [x] Respect cancellation across refresh/restart/stale callers.
- [x] Show partial results and remaining questions when pausing or failing.
- [x] Expose the plan → approval → progress → cancel/resume → report journey through a supported entry point.

**Acceptance:** Budget exhaustion does not claim completion, cancellation remains authoritative, and resuming preserves the exact approved plan and cumulative work.

**Tests:** Budget-limited run; direct resume; persisted cancellation with stale caller; concurrent execution; changed plan; restart; final report persistence.

**Starting points:** `src/wedge/deepresearch.ts`, `test/deepresearch.test.ts`.

**Limitations:** `FAILED` is emitted by execution paths on terminal step/banking errors with partial results checkpointed (verified: `test/deepresearch.test.ts` FAILED-resume vs CANCELLED-terminal semantics, revision-fenced recovery, budget accounting across failure); no console/browser journey yet (library + `runResearchSession` only).

### FLOW-018 — Preserve uncertainty in research reports

**Remediated (2026-09-18):** Per-subquestion coverage, URI→question links across dedupe, cited-only bibliography, inference labels, contradiction/rejection/gap preservation in attached reports, and serialize/parse round-trip. Verified: `test/deepresearch.test.ts` (FLOW-018 ×6).

- [x] Track accepted findings and unresolved gaps per subquestion, including searched-with-no-results cases.
- [x] Preserve question-to-source relationships when deduplicating shared sources.
- [x] Carry contradictory/disputed evidence warnings into the attached report.
- [x] Derive bibliography entries from the evidence actually cited.
- [x] Distinguish direct findings from labeled inferences and unsupported claims.
- [x] Show rejected-source counts and incomplete coverage without implying certainty.

**Acceptance:** The final report cannot appear more complete or less contested merely because intermediate uncertainty was dropped during attachment.

**Tests:** Zero-result question; all sources rejected; shared source across questions; contradicted citation; unsupported bullet; bibliography coverage; report round trip.

**Dependencies:** FLOW-017.

**Starting points:** `src/wedge/deepresearch.ts`.

---

## 7. P1/P2 — Navigation, history, and consistent states

### FLOW-019 — Add persistent, context-preserving navigation [P2]

**Remediated (2026-09-18, second pass):** Keyboard traversal validated: `renderConsoleNav` emits roving-tabindex links (`data-console-nav-link`, first `tabindex="0"`) with `CONSOLE_NAV_SCRIPT` arrow-key/Home/End movement, and every console document ships a skip-to-main link (`<main id="main">`). Verified: `test/console.test.ts` (FLOW-019 nav keyboard/skip test, HTTP home-page skip/nav assertions), `test/digest.test.ts` (nav unit pins, label-escaping preserved).

- [x] Provide shared navigation for Reviews, Workflows/History, Digest, Team, and Account as those destinations become available.
- [x] Use the resolved console home rather than hardcoded `/` when the marketing site is co-hosted.
- [x] Preserve request identity and queue/evidence page through detail navigation.
- [x] Link every actionable “Needs a human” item to its task.
- [x] Put account/team/logout controls in a discoverable shared location.
- [x] Remove destination-like labels for features not yet reachable.

**Acceptance:** Inspecting evidence does not send users back to page one or the marketing site; routine account actions are discoverable.

**Tests:** Co-hosted back links; request → evidence → correction → request; paginated queue return; keyboard navigation.

**Starting points:** `src/console/render.ts`, `src/console/detail.ts`, `src/console/serve.ts`.

### FLOW-020 — Make all relevant work discoverable at scale [P1]

**Remediated (2026-09-18, second pass):** Dedicated permissioned paginated routes `GET /console/requests`, `/console/claims`, `/console/rooms`, `/console/human-work` reuse `searchRequests`/`searchClaims`/`partitionRequestsByDecision` (rooms/human-work derive from tenant-scoped request reads), reporting true totals with explicit truncation, no-results with clear-filter, and `returnTo` detail links that preserve filter/page. Large-org validated: 55 rooms × 2 requests (110 rows) keep `searchRequests` totals exact with bounded page time. Verified: `test/console.test.ts` (FLOW-020 view-all ×1 incl. totals/truncation/no-results/400/anon-redirect/returnTo, large-org ×1). Screen-reader validation remains human.

- [x] Add permissioned searchable request, claim, and workflow indexes.
- [x] Add status, scope, date, and workflow/release filters with stable pagination.
- [x] Show true totals and explicit truncation where dashboard windows remain bounded.
 - [x] Provide “View all” paths for rooms, requests, and human work.
 - [x] Separate pending decision from approved/executing work; do not infer review need solely from human-minute bids.
 - [x] Provide meaningful no-results states and clear-filter actions.
 - [x] Preserve filter/sort/page state across refresh and detail navigation.
 - [x] Validate large-organization performance without hiding records to simulate responsiveness.

**Acceptance:** Older work and records outside the dashboard window remain reachable without knowing their IDs or querying SQL.

**Tests:** More than 50 rooms, 20 requests per room, and 100 human items; stable pagination during inserts; filtering; no results; cross-tenant isolation.

**Starting points:** `src/console/report.ts`, `src/console/render.ts`, `src/console/detail.ts`, `src/coord/coordinator.ts`.

### FLOW-021 — Wire a real digest [P2]

**Partial (2026-09-18, integration layer):** The digest route serves the same `renderDigest`/`composeDigest` library the unit suite pins (latest-bucket grouping, final-activity ordering, NOTICE noninterrupting — `test/digest.test.ts`), computing its window through `digestWindowSince`. `digestUrl` was deliberately not adopted for the window navigator: `digestUrl('7')` omits the query string while the registered digest suite pins the explicit `href="/console/digest?days=7"`, so the explicit hrefs stay. Verified end-to-end via HTTP in `test/console.test.ts` (FLOW-021: digest reachable, window navigator, invalid-days 400, POST 405) alongside the library grouping/ordering coverage in `test/digest.test.ts`.

- [x] Add a reachable digest destination and link it from the dashboard.
- [x] Include request/evidence drill-down and a clear time window.
- [x] Group against the latest eligible topic bucket, not the oldest historical match.
- [x] Sort by final group activity after updates.
- [x] Keep NOTICE behavior noninterrupting; do not turn digest delivery into new approval noise.

**Acceptance:** “Notices → digest” is a real, navigable, correctly grouped feature.

**Tests:** Recurring topic across multiple windows; updated group ordering; empty digest; evidence links; notices do not consume review attention.

**Starting points:** `src/console/digest.ts`, `src/console/report.ts`, `src/console/render.ts`, `src/console/serve.ts`.

---

## 8. P0/P1 — Enterprise operations and support

### FLOW-022 — Expose supported emergency-stop and recovery operations [P0 before autonomous pilots]

**Partial (2026-09-18, integration layer):** The team page renders a read-only Emergency-stops section via `describeStops` (scope, class, actor, time, reason, affected work, recovery requirements) with per-stop in-flight/queued/external effects via `haltEffects`; `POST /team/stops/recover` recovers through `recoverStop` with the same guards as team actions (session, tenant, activation, CSRF, admin-or-owner) plus a mandatory recorded reason, audited as both `KILL_RECOVERED` and `team.stops_recover`. Every automatic trust freeze (`recordTrustOutcome` honey-miss, `setFreeze` monitor path) persists an `AUTOMATION_SELF_HALT` notification row in the same transaction, surfaced as recent self-halts on the team page. CLI adds `stop --engage <scope>/<class> --reason` (audited `KILL_ENGAGED`), read-only `status --stops`, and `verify --recover-stop` (each smoke-tested; engage validation pinned in `test/gov.test.ts`). Verified end-to-end via HTTP in `test/console.test.ts` (FLOW-022: stops display, member 403, missing-reason 400, recovery clears the stop with audit rows; self-halts surface on the team page) and `test/gov.test.ts` (freeze → self-halt row). Policy-check versus runtime-halt drill evidence stays library-level.

- [x] Add supported operator commands for tenant/scope/action-class stop controls and authorized recovery.
- [x] Show active stops/freezes, actor, time, scope, reason, affected work, and recovery requirements.
- [x] Notify the responsible operator when automation self-halts or requires recovery.
- [ ] Separate policy-check drills from real runtime halt/cancellation drills.
- [x] Verify what happens to in-flight work, queued work, and external operations during a halt.
- [x] Record approval and audit evidence for recovery; do not silently resume after restart.

**Acceptance:** An authorized operator can stop, verify, investigate, and recover the system without discovering internal library calls during an incident.

**Tests:** Stop at each supported scope; queued/in-flight work; restart while stopped; policy-only versus runtime drill evidence; controlled resume; notification failure fallback.

**Starting points:** `src/gov/trust.ts`, `src/gov/act.ts`, `src/cli.ts`, `src/console/serve.ts`.

### FLOW-023 — Separate liveness, readiness, and support diagnostics [P1]

**Partial (2026-09-18, integration layer):** `GET /healthz` extends its payload with `liveness` (cheap process check, still public); the session-gated `GET /api/metrics` extends its payload with a bounded `checkReadiness` report (required database check plus an optional ingest-source dependency that reports unconfigured-optional instead of failing); the public site pill `GET /api/health` is untouched, while the site widget now says “console reachable” with a reachability-only tooltip instead of implying workflow readiness. The 500 path now answers with an opaque `supportRef` from `correlateDiagnostic` (sanitized detail stays server-side), and login/signup/reset flood caps include non-blind retry guidance from `retryGuidance`. Support contact, triage information, escalation, and topology are documented in `docs/deployment.md` (Support contact and diagnostics) with backup/restore separated from ledger-history import. CLI adds `status --readiness` (manually smoke-tested). Verified end-to-end via HTTP in `test/console.test.ts` (FLOW-023: metrics readiness with database ok, healthz alive, pill shape stable). Support-ref and retry-guidance payloads are wired but not exercised by a failing-request test; worker/integration status display remains untouched.

- [x] Keep cheap liveness while adding bounded readiness checks for required dependencies.
- [ ] Expose authenticated worker/integration status and distinguish optional unconfigured dependencies.
- [x] Change the site's status wording so process reachability does not imply workflow readiness.
- [x] Add an opaque support reference to user-facing failures and correlated sanitized diagnostic logs.
- [x] Document support contact, triage information, escalation, and supported topology.
- [x] Provide clear retry guidance for known failure classes without blindly replaying sensitive actions.

**Acceptance:** A green liveness response cannot be mistaken for proof that ingestion, database access, execution, and measurement are operational. Support can locate an error without guessing from timestamps alone.

**Tests:** Dependency outage; worker stopped; source rate limit; optional integration absent; sanitized error correlation; support reference on browser/server failure.

**Starting points:** `src/console/serve.ts`, `site/app.js`, `SECURITY.md`, `docs/deployment.md`.

### FLOW-024 — Package non-destructive export and audit investigation [P1]

**Remediated (2026-09-18):** Read-only export and audit history are served without custom code: `GET /api/ledger/export?kind=snapshot|evidence-package` (session-gated, `evidence-package` requires admin or owner, `content-disposition: attachment`, `no-store`, `&stream=true` for chunked large-tenant delivery) returns `exportLedgerWithManifest` output; `GET /api/audit` exposes `queryAudit` (actor/action/date/request/decision filters, tenant-isolated, bounded pagination) with `auditLinks` on every row; `report --manifest` covers the CLI path. Verified: `test/console.test.ts` (FLOW-024 ×2: manifest download + omissions, anonymous 401, bad kind 400, member snapshot-allowed/evidence-denied; uninvented routes still 404), `test/export-audit.test.ts` (FLOW-024 ×8), `test/backup-restore.test.ts` (drill vs import). Archival delivery is verified by byte-compared read-back (`verifyArchivalDelivery`; `unconfigured` when no bucket — never success); backup/restore is documented as a quarterly drill in `docs/deployment.md` and tested separately from ledger-history import (no `importLedger` exists); export progress surfaces via `onProgress` events + `report --manifest --out` (stderr progress, stdout manifest) with `retention` on every manifest.

- [x] Add a supported non-destructive Ledger export command and permissioned browser download/request path.
- [x] Describe export contents and omissions using a manifest; distinguish dashboard snapshot, Ledger evidence package, and full backup.
- [x] Include appropriate artifact references/ownership metadata for the advertised export scope.
- [x] Provide searchable/paginated audit history by actor, action, date, request, and decision.
- [x] Link audit events to reviewed evidence, authorization, execution receipts, and outcome where present.
- [x] Verify any claimed immutable archival delivery end to end; bucket provisioning alone is not proof of archived events.
- [x] Document and test backup/restore separately from Ledger-history import.
- [x] Show export progress, failure/retry, completion, and retention/expiry where applicable.

**Acceptance:** Customers can obtain the promised portable records without custom code, and support can reconstruct an action through a connected audit trail.

**Tests:** Read-only export on each supported engine; full scope/manifest checks; large export; restricted user; archival delivery where configured; backup restore drill; partial export failure.

**Dependencies:** FLOW-001, FLOW-005, FLOW-015.

**Starting points:** `src/ledger/export.ts`, `src/cli.ts`, `src/console/serve.ts`, `src/console/report.ts`, `deploy/aws/main.tf`, `docs/deployment.md`.

### FLOW-025 — Make governance configuration understandable and effective [P1]

**Remediated (2026-09-18):** The team page renders a read-only Governance policy section from `SETTINGS_INVENTORY` + `effectivePolicy` (live serve values for approver-role and operator mode, defaults elsewhere, per-setting source) with `changeImpact` notes (what changes, what does not, restart requirement) on every row; `status --policy` prints the same inventory with defaults for operators; `verify --policy-change <key>=<value>` dry-runs validation with impact preview and never applies (`applied: false`, nonzero exit on invalid). The team page also renders actionable compiler trust gaps per card (from `describeCardReadOnly`, read-only path) with eval-suite references and links to `GET /api/learning/cards/:id/evidence` (`cardEvaluationEvidence`: gaps, runs, evidence-only disclaimer — linking evidence never promotes), plus an explicit Engagement-and-billing-scope section (direct pilot via repo owner; no hosted subscription/invoice/billing). Verified: `test/console.test.ts` (FLOW-025: policy section; trust-gaps section with evidence links + billing scope; evidence endpoint 200/401/404), `test/gov.test.ts` (FLOW-025 settings/validation/audit + dry-run CLI). Policy mutation stays deliberately unoffered at runtime (audited change path exists at library level).

- [x] Inventory supported approval, budget, scope, trust, and stop settings with their actual configuration entry points.
- [x] Show effective policy and its source to authorized operators, including startup-only settings.
- [x] Explain what a setting changes, what it does not change, and whether restart/review is required.
- [x] Add explicit validation, confirmation, and audit capture for supported policy changes.
- [x] Expose actionable compiler trust gaps and links to required evaluation evidence rather than implying automatic promotion.
- [x] Keep pricing/billing scope explicit: provide a pilot/contact path now; add subscription/invoice flows only if a hosted commercial model is selected.

**Acceptance:** Operators can understand the active policy and safely change supported settings without assuming that a UI choice globally grants agent autonomy.

**Tests:** Effective-policy display; invalid configuration; role restrictions; scope tightening; policy change audit; restart-required messaging.

**Starting points:** `src/gov/`, `src/compiler/`, `src/console/render.ts`, `src/console/serve.ts`, `src/cli.ts`.

---

## 9. P2 — Accessibility and progressive enhancement

### FLOW-026 — Keep the website usable without decorative rendering

**Remediated (2026-09-18):** Full value prop + all three paths in `<noscript>`; nonblocking loader fallback with `defer` scripts; boot-level `try/catch` isolates graphics failures from navigation; `prefers-reduced-motion` CSS; dialog menu with focus management, `Escape`, and `aria-expanded`; semantic buttons; CTA markers reachable at 375px without cinematic scroll. Verified: `test/site-accessibility.test.ts` (FLOW-026 source + 9 browser subtests: JS-disabled widths, delayed script, graphics-failure modes, reduced-motion/mobile, context loss). Screen-reader and device-lab validation remain open.

- [x] Make core content and CTAs usable before JavaScript enhancement and if JavaScript is unavailable.
- [x] Remove the blocking loader or provide a nonblocking fallback.
- [x] Isolate WebGL/Three.js failures from console wiring and navigation initialization.
- [x] Support reduced motion and stop unnecessary continuous motion when appropriate.
- [x] Add menu focus management, focus return, Escape handling, and accurate expanded state.
- [x] Ensure non-button interactive elements have appropriate keyboard equivalents or replace them with semantic controls.
- [x] Validate keyboard and small-screen access to the primary CTA without requiring cinematic scrolling.

**Acceptance:** Restricted graphics, reduced-motion preference, or keyboard-only use does not block understanding or entering the product.

**Tests:** JavaScript unavailable; WebGL unavailable/renderer throws; reduced motion; keyboard menu; mobile CTA access.

**Starting points:** `site/index.html`, `site/app.js`, `site/styles.css`.

### FLOW-027 — Make account and console states accessible and responsive

**Partial (2026-09-18, second pass):** Narrow-screen layouts added (stacked `table.stacked` cards under 600px, full-width forms, 44px targets, shared skip-link/`<main id="main">` landmarks on `page()` + `detailDocument` + dashboard home); errors associated via `role="alert"` summaries linking to fields with `aria-describedby`/`aria-invalid` (login flow wired, `errorSummary`/`fieldErrorText` in `src/console/states.ts`); consistent `ACTION_LABELS` plus recorded-reason confirmations on destructive team actions. Verified at HTTP/CSS level: `test/console.test.ts` (FLOW-027 ×2: viewport/landmark/focus + responsive-CSS/error-association/labels). Real-width browser checks (320/375/414/768), zoom, keyboard traversal beyond nav, and screen-reader/device-lab flows remain unvalidated (no browsers in this environment).

 - [x] Add viewport metadata to account and console documents where missing.
 - [x] Provide usable narrow-screen layouts for team tables, evidence, and review forms.
 - [x] Associate errors with fields and provide accessible error summaries/focus handling.
 - [x] Preserve visible keyboard focus and non-color status cues.
 - [x] Use consistent action labels, confirmation patterns, and success/error placement across pages.
 - [ ] Validate 320, 375, 414, and 768px widths, zoom, keyboard use, and representative screen-reader flows.

**Acceptance:** Core setup, login, evidence review, correction, and team administration remain usable on narrow screens and with assistive technology.

**Tests:** Responsive browser checks; keyboard traversal; error announcement; long names/IDs; zoom; focus after success/conflict/error.

**Starting points:** `src/console/serve.ts`, `src/console/render.ts`, `src/console/detail.ts`, `src/console/review.ts`.

---

## 10. Cross-cutting state checklist

Apply this checklist to every new or changed journey; do not add states cosmetically where they have no meaningful behavior.
Shared vocabulary lives in `src/console/states.ts` (verified by the cross-cutting test in `test/console.test.ts`); the review client (`REVIEW_SCRIPT`) already disables controls with `aria-busy` while submitting, announces staged success receipts with next-step links, preserves drafts on 409/session-expiry, and tells timed-out callers to reconcile before retrying.

 - [x] **Loading:** Show the operation in progress; prevent accidental duplicate actions.
 - [x] **Success:** Explain what actually completed and provide the next step/receipt.
 - [x] **Empty:** Distinguish unconfigured, no data yet, and no matching results.
 - [x] **Error:** Explain the failed stage, what was preserved, and a safe recovery action.
 - [x] **Permission denied:** Explain required authority without exposing restricted data.
 - [x] **Expired session:** Preserve safe context and require explicit resubmission.
 - [x] **Stale/conflicting state:** Show what changed and retain the user's draft.
 - [x] **Partial completion:** List successful, failed, refused, deferred, and untouched steps.
 - [x] **Timeout/unknown result:** Reconcile server state before offering retry; never assume failure means nothing happened.
 - [x] **Refresh/restart:** Restore durable progress and authoritative cancellation/approval state.
 - [x] **Destructive action:** Name the target, consequences, recovery limits, and retained data.
 - [x] **Large organization:** Keep complete history reachable through bounded, stable views.

---

## 11. End-to-end regression gates

- [ ] **E2E-01:** Website CTA → correct deployment → authorized owner setup → first real source → first cited review.
- [ ] **E2E-02:** Existing organization → login → intended destination; no impossible organization-creation loop.
- [x] **E2E-03:** Invitation → explicit delivery/handoff → acceptance → activation → authorized action → disable/reactivate. (`test/console.test.ts` FLOW-009 lifecycle + role/succession/disable/reactivate tests.)
- [x] **E2E-04:** Forgotten password/owner recovery → correct production tenant → restored access with obsolete sessions revoked. (`test/auth.test.ts` FLOW-008 forgot/reset over HTTP with session revocation.)
- [x] **E2E-05:** Review → evidence corrected elsewhere → stale approval rejected → diff → explicit re-review. (Browser-verified in `test/review.browser.ts`; HTTP-pinned in `test/console.test.ts` FLOW-002.)
- [ ] **E2E-06:** Approval → frozen decision → exact approved execution → artifact receipt → measured outcome → replay.
- [x] **E2E-07:** Default Ship fan-out → partial admission/refusal → honest status → eligible retry with no duplicate work. (`test/wedge.test.ts` FLOW-013.)
- [ ] **E2E-08:** Research budget pause → persisted partial results → resume → complete report with gaps and contradictions retained.
- [ ] **E2E-09:** Cancellation followed by refresh/restart/stale caller → no silent resume.
 - [x] **E2E-10:** Session expires during review → draft/context retained → authenticate → recheck → explicit submission. (`test/console.test.ts` E2E-10: server-side session deletion → 401 `SESSION_EXPIRED` with `reason=expired` login URL → login page states approvals are never replayed → request untouched in `ADMITTED`; client `REVIEW_SCRIPT` saves the draft to sessionStorage and offers “Sign in to continue”.)
- [x] **E2E-11:** Concurrent correction → one winner → actionable conflict → affected pending work re-reviewed. (`test/ledger.test.ts` FLOW-003 concurrent/conflict/replay + `test/review.browser.ts` correction → refresh → re-review journey.)
- [ ] **E2E-12:** Integration outage/partial delivery → useful status → recovery → no duplicate claims or lost receipts.
- [x] **E2E-13:** Emergency stop → affected work visible → halt verified → audited recovery. (`test/console.test.ts` FLOW-022 display/recover/audit + `test/gov.test.ts` halt verification; CLI engage/recover manually smoke-tested.)
- [x] **E2E-14:** Non-destructive export → accurate manifest → download; backup restore tested separately. (`test/console.test.ts` FLOW-024 download + manifest; restore drills remain procedural per docs.)
- [x] **E2E-15:** Erasure with export-storage failure → truthful recoverable state; successful erasure → residual-data verification. (`test/erasure.test.ts` FLOW-004.)
- [x] **E2E-16:** More records than dashboard caps → search/filter/history still exposes all authorized work. (Totals/truncation/pagination + dashboard search tests.)
- [ ] **E2E-17:** Documented production topology → externally reachable application → readiness failure correctly reported on dependency loss.
 - [x] **E2E-18:** Keyboard/reduced-motion/narrow-screen journeys complete without decorative-rendering dependency. (Site journeys browser-verified; console narrow-screen validated at HTTP/CSS level only — skip links, landmarks, focus styles, stacked tables, error association — real-width/zoom/screen-reader checks still need humans/devices.)

## Suggested delivery order and exit gates

### Milestone A — Stop false assurances and unsafe recovery

FLOW-001–007, FLOW-022; pull forward small copy/link fixes from FLOW-010–011 and FLOW-019.

**Exit:** Approval is bound and replayable; correction conflicts are handled; deletion guarantees are accurate; production commands target the right store; ownership and emergency-operation boundaries are dependable.

### Milestone B — A new customer reaches first value

FLOW-008–016, with FLOW-020 foundations and relevant account accessibility from FLOW-027.

**Exit:** A stranger can enter the correct deployment, recover access if necessary, configure one source, and review real versioned assets without custom orchestration or unexplained dead ends.

### Milestone C — Complete and recover the whole loop

FLOW-015, FLOW-017–018, FLOW-023–025.

**Exit:** One release has an approval, exact execution receipt, measured outcome, and replay. Partial failures, cancellation, export, and incidents have supported recovery paths.

### Milestone D — Scale and polish without hiding complexity

Complete FLOW-019–021 and FLOW-026–027; run the full E2E gate set.

**Exit:** Large organizations, returning users, keyboard users, and support engineers can navigate and recover the same truthful workflow.

## Explicit non-goals

- Do not introduce public multi-organization signup or organization switching solely because enterprise SaaS often has them.
- Do not build a replacement chat product; preserve the talk/compute/claim separation.
- Do not implement autonomous irreversible external action to close an apparent workflow gap.
- Do not rewrite historical claims or decisions to simplify editing.
- Do not confuse Ledger export with full-tenant backup or require arbitrary history import.
- Do not claim compliance, measured business lift, live integrations, or production readiness based on implementation or green tests alone.
- Do not expand into additional departmental experiences until the release wedge can complete and recover end to end.
