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

**Remediated (2026-09-18):** Full approval-to-decision binding completed. Added tenant-scoped decision lookup, dedicated decision receipt pages (`/console/decisions/:id`), explicit begin-work review action wording, and atomic transaction rollback. Approving ungrounded requests without valid ledger evidence is strictly rejected (409), repeated approvals are idempotent returning the original decision receipt, and acceptance/audit failures cleanly roll back decisions. All 24/24 console tests pass, and full 410-test suite is green.

- [ ] Define the distinction between approval to begin work and approval of a final deliverable.
- [ ] Replace the misleading “records a decision” copy until the full decision contract is implemented.
- [ ] Atomically bind acceptance to a Ledger decision and frozen Context Bundle.
- [ ] Link the request, human identity, reviewed asset/specification version, evidence, scope, and budget to that decision.
- [ ] Return a decision receipt/link from approval.
- [ ] Make duplicate submissions idempotent without creating duplicate decisions.
- [ ] Present approved, executing, executed, and measured as distinct states.

**Acceptance:** A reviewer can open the approval receipt and establish exactly what was authorized, by whom, and on what basis. An unsuccessful operation cannot leave an accepted request without its required decision record.

**Tests:** Approval creates the complete chain; repeated submission; transaction failure; no duplicate decision; browser receipt navigation.

**Starting points:** `src/console/review.ts`, `src/console/serve.ts`, `src/coord/coordinator.ts`, `src/ledger/ledger.ts`.

### FLOW-002 — Bind review and execution to the exact approved version

- [ ] Persist a versioned execution specification rather than accepting unrelated task instructions after approval.
- [ ] Include request identity, task/command, scope, budget, asset version, and evidence versions in the approved specification.
- [ ] Submit expected request/review versions or fingerprints with approval.
- [ ] Revalidate relevant evidence, deadline, and request state at approval and execution boundaries.
- [ ] Define allowed state transitions; prevent stale approval from moving running work back to accepted.
- [ ] Distinguish pre-review drafting from execution that must wait for approval.
- [ ] Execute approved specifications by identity, not by independently supplied replacement instructions.
- [ ] Bind feature-plan citations and execution inputs to the same approved plan.
- [ ] Show a diff and require re-review after material changes; preserve the reviewer's explanation.

**Acceptance:** The work executed is provably the work approved. Changed evidence, task, scope, or state cannot silently reuse obsolete authorization.

**Tests:** Evidence superseded/expired during review; task mismatch; request mismatch; budget/scope change; concurrent reviewers; deadline expiry; stale page after execution starts; exactly-once execution ownership.

**Dependencies:** FLOW-001.

**Starting points:** `src/console/review.ts`, `src/console/serve.ts`, `src/coord/coordinator.ts`, `src/wedge/feature.ts`, `src/jcode/runner.ts`, `src/substrate/harness.ts`.

### FLOW-003 — Make corrections conflict-safe and connect downstream recovery

- [ ] Atomically require the expected current claim version before superseding it.
- [ ] Allow one replacement for a given current version; return an actionable conflict to competing editors.
- [ ] Preserve the losing editor's draft and display the winning replacement/diff.
- [ ] List pending requests/proposals affected by a correction.
- [ ] Provide an explicit evidence-refresh and re-review action for pending work.
- [ ] Keep historical decisions and their frozen evidence immutable.
- [ ] Clearly distinguish a current claim from historical or competing state during investigation.

**Acceptance:** Two simultaneous corrections cannot both become independent current replacements. Correcting a claim exposes the pending work that must be reconsidered.

**Tests:** Concurrent correction on supported engines; stale editor; conflict draft retention; pending-request invalidation; historical replay unchanged.

**Starting points:** `src/ledger/ledger.ts`, `src/console/serve.ts`, `src/console/detail.ts`.

---

## 2. P0 — Safe deletion and production recovery

### FLOW-004 — Make erasure and export guarantees accurate

- [ ] Decide and document whether retaining an export is optional or mandatory for each supported erasure flow.
- [ ] If required/requested, durably save and verify the export before destructive completion.
- [ ] Handle export creation, permission, storage, and verification failures without falsely reporting a preserved record.
- [ ] Make the destructive target, scope, consequences, and export-retention choice explicit before confirmation.
- [ ] Inventory tenant-owned tables, tenant-keyed `meta` entries, raw artifacts, and any configured external storage.
- [ ] Implement ownership/reference-aware artifact cleanup where content is shared.
- [ ] Apply explicit retention rules to audit evidence, backups, and retained export files; do not promise deletion beyond verified scope.
- [ ] Remove stale kill, cursor, dedupe, and identity metadata when in scope.
- [ ] Issue a receipt listing deleted, retained, failed, and deferred categories.
- [ ] Ensure tenant-slug reuse cannot inherit prior operational state.
- [ ] Correct documentation that implies an in-memory export and a later file write are one atomic transaction.

**Acceptance:** A completed erasure receipt accurately describes all retained and deleted data. Required export-file failure cannot occur only after irreversible deletion has already been reported as safely export-first.

**Tests:** Unwritable export location; interrupted operation; tenant metadata inventory; raw artifacts; shared artifact ownership; slug reuse; other-tenant isolation; receipt accuracy.

**Starting points:** `src/core/erasure.ts`, `src/cli.ts`, `src/ledger/export.ts`, `src/ingest/collectors.ts`, `src/gov/operator.ts`, `src/gov/trust.ts`, `SECURITY.md`.

### FLOW-005 — Use consistent database targeting for operational commands

- [ ] Share database resolution across serve, signup, password recovery, erasure, ingestion, report, and status where supported.
- [ ] Honor explicit flags and deployment environment consistently, including PostgreSQL URLs.
- [ ] Display the resolved engine and tenant without exposing connection secrets.
- [ ] Confirm the intended tenant exists before sensitive operations.
- [ ] Remove silent empty/in-memory or default-tenant behavior from commands meant to inspect a deployed organization.
- [ ] Separate schema migration from read-only status inspection.
- [ ] Make engine-specific command limitations explicit and provide a supported alternative.
- [ ] Verify the instance-check script performs the functional checks it claims, rather than treating schema presence as end-to-end success.

**Acceptance:** Operators can recover or erase the actual production tenant without custom code or accidentally acting on a local SQLite file. Status describes the selected tenant and does not silently migrate it.

**Tests:** SQLite and PostgreSQL targeting; environment/flag precedence; nonexistent tenant; non-default tenant; report source consistency; status causes no schema/data mutation.

**Starting points:** `src/cli.ts`, `src/core/db.ts`, `scripts/verify-instance.mjs`, `docs/deployment.md`.

### FLOW-006 — Honor deployment listener configuration

- [ ] Honor the explicitly configured bind host while keeping loopback as the local default.
- [ ] Report the actual listening address.
- [ ] Validate the documented load-balancer-to-task path, not only a loopback health probe.
- [ ] Keep remote bootstrap protections in place before exposing an unclaimed console.

**Acceptance:** A deployment configured for its task interface can be reached through the documented entry point; local-only behavior remains intentional and clear.

**Tests:** Configured-host binding; loopback default; deployment smoke/readiness checks through the supported topology.

**Starting points:** `src/console/serve.ts`, `src/cli.ts`, `deploy/aws/main.tf`, `deploy/aws/Dockerfile.vital-core`.

---

## 3. P0/P1 — Account authority and recovery

### FLOW-007 — Enforce privileged-account boundaries consistently [P0]

- [ ] Define role-grant rules explicitly; restrict ownership grants/transfers to authorized owners.
- [ ] Apply the same grant policy in forms and core authorization.
- [ ] Centralize account-state authorization so mandatory password change restricts relevant mutations as well as pages.
- [ ] Allow only the required activation/recovery/logout operations before activation is complete.
- [ ] Protect remotely reachable first-owner claiming with deliberate setup authorization.
- [ ] Verify email before relying on it as a recovery channel.
- [ ] Choose a supported MFA-capable identity strategy, including enforcement, recovery, and recent-authentication policy for sensitive operations.

**Acceptance:** UI promises about ownership and account activation match server enforcement. Remote deployment cannot accidentally expose an unauthorized organization-claiming journey.

**Tests:** Role-grant matrix; nonactivated-account operation matrix; remote bootstrap prerequisites; authentication-strength/recovery lifecycle once implemented. Use defensive tests, not live-account probes.

**Starting points:** `src/core/auth.ts`, `src/console/serve.ts`, `SECURITY.md`.

### FLOW-008 — Complete password and organization-access recovery [P1]

- [ ] Add “Forgot password?” or an explicit operator-assisted recovery entry point.
- [ ] Implement verified delivery and reset acceptance, or clearly document the supported manual process and contact.
- [ ] Distinguish missing tenant, account-less tenant, active tenant, and recovery-required tenant.
- [ ] Fix the account-less-tenant signup dead end without reopening established organizations to anonymous claims.
- [ ] Base provisioning readiness on a usable authorized owner, not just the existence of any user row.
- [ ] Make temporary operator-set credentials require appropriate recipient replacement.
- [ ] Explain session revocation and return users to their intended task after recovery.
- [ ] Align reset documentation with actual CLI/API/browser entry points.

**Acceptance:** An owner can discover and complete a supported recovery path without reading implementation code. Disabled or missing owners do not produce an unexplained login/signup loop.

**Tests:** Forgotten password; expired/reused reset token; nonexistent account response; account-less tenant; disabled owner; operator-assisted recovery on PostgreSQL.

**Dependencies:** FLOW-005, FLOW-007.

### FLOW-009 — Complete invitation and membership lifecycle [P1]

- [ ] Until invitations are delivered/accepted, label the current operation “Create account” and explain the out-of-band handoff.
- [ ] Add pending invitation, expiry, acceptance, resend, and revoke states.
- [ ] Let recipients choose their own credentials through a verified acceptance flow.
- [ ] Show invited versus active versus disabled membership accurately.
- [ ] Add authorized role changes and ownership succession.
- [ ] Confirm disabling the named person and explain session/access consequences.
- [ ] Support authorized reactivation without restoring revoked sessions.
- [ ] Surface outstanding owned work and require an appropriate reassignment/handoff decision when disabling an accountable user.
- [ ] Handle duplicate invitations and existing disabled accounts with useful next steps.

**Acceptance:** Administrators know whether access was offered, accepted, disabled, or restored; accidental disablement and staff departure have supported recovery paths.

**Tests:** Full invitation lifecycle; duplicate/expired/revoked invitation; role transfer; disable confirmation; reactivation; outstanding-work handoff; last usable owner protection.

**Dependencies:** FLOW-007, FLOW-008.

### FLOW-010 — Recover gracefully from session expiry and account-form errors [P1]

- [ ] Define and align idle versus absolute session lifetimes between database and browser cookie.
- [ ] Preserve a safe return destination through authentication.
- [ ] Preserve non-secret drafts during expiry; never persist passwords, operator secrets, or signed authorization material for convenience.
- [ ] Offer “Sign in to continue” instead of a raw authentication error and generic refresh advice.
- [ ] Require explicit review/submission after reauthentication; never automatically replay an approval.
- [ ] Handle multiple open login/signup forms without unexplained pre-session invalidation.
- [ ] Return browser-appropriate validation, CSRF-expiry, and rate-limit errors.
- [ ] Retain safe form values and provide retry timing where applicable.
- [ ] Explain password-change success and session revocation; correct “Save and continue” if another sign-in is required.
- [ ] Separate forced activation from voluntary password change and expose Account/Security navigation.

**Acceptance:** Users can recover from expiry and ordinary form errors without losing their task or accidentally repeating a sensitive action.

**Tests:** Active browser cookie lifetime; idle/absolute expiry; expiry during correction/approval; safe redirect handling; two auth tabs; CSRF/rate-limit form recovery; forced versus voluntary password change.

**Starting points:** `src/core/auth.ts`, `src/console/serve.ts`, `src/console/review.ts`.

---

## 4. P1 — Connect the website to first value

### FLOW-011 — Correct website promises and conversion paths

- [ ] Replace autonomous-company positioning with the supported governed release workflow.
- [ ] Clearly separate shipped behavior, labeled demonstration, pilot targets, and roadmap.
- [ ] Label business improvement numbers as targets unless backed by verified results.
- [ ] Remove unsupported compliance-readiness claims.
- [ ] Replace simulated “live runtime” proof with a clearly labeled walkthrough or verified recording.
- [ ] Refresh or remove stale test-count proof; never imply test count proves business outcomes.
- [ ] Resolve console URLs through deployment configuration/same-origin routing rather than a shipped visitor-localhost address.
- [ ] Separate Contact, Setup/Get started, and Existing-member sign-in actions.
- [ ] Do not advertise new-organization creation on an already provisioned single-tenant console.
- [ ] Name the bound organization on login and explain invite-only membership.
- [ ] Avoid unexpected new tabs or make external-console behavior explicit.
- [ ] Provide a clear pilot/contact/deployment engagement path without inventing a hosted subscription product.

**Acceptance:** A visitor understands the use case, proof level, operating model, and next step, and reaches the correct console or contact destination.

**Tests:** Site-to-console navigation in co-hosted and configured separate-origin deployments; provisioned/unprovisioned states; CTA labels/destinations; copy/proof review against `idea.md`.

**Starting points:** `site/index.html`, `site/app.js`, `src/console/serve.ts`, `idea.md`.

### FLOW-012 — Give empty organizations a guided activation path

- [ ] Add a setup checklist reflecting actual readiness, not cosmetic completion.
- [ ] Guide selection of source, accountable human, scope, approval policy, and budget.
- [ ] Preview and verify the first received source item.
- [ ] Explain unconfigured, syncing, empty, rejected, and failed states separately.
- [ ] Offer an explicitly labeled sample walkthrough without mixing sample data with real customer evidence.
- [ ] Link successful ingestion to creating the first release workflow.
- [ ] Put the next useful action ahead of technical health charts for new accounts.
- [ ] Measure time to first trustworthy review rather than signup alone.

**Acceptance:** A first-time owner can reach a real cited review without guessing CLI commands or needing a developer to explain the dashboard.

**Dependencies:** FLOW-011, FLOW-015, FLOW-016.

**Starting points:** `src/console/render.ts`, `src/console/serve.ts`, `src/cli.ts`, `src/ingest/worker.ts`.

---

## 5. P1 — Complete the Ship-to-Result lifecycle

### FLOW-013 — Represent fan-out as a durable partial workflow

- [ ] Create a stable parent workflow/run identity before submitting child work.
- [ ] Show per-leg admitted, deferred, denied, declined, executing, failed, and completed states.
- [ ] Reconcile Ship's attention needs with default escalation policy without silently raising safety limits.
- [ ] Return partial progress and created IDs when a later leg fails admission.
- [ ] Distinguish deduplicated successful/pending work from terminal refusals.
- [ ] Retry only eligible legs; retain explicit refusals until new information or policy permits reconsideration.
- [ ] Keep stable run/decision identity across churn retries rather than creating disconnected duplicate decisions.

**Acceptance:** Starting or retrying a workflow never conceals refused work or loses visibility into earlier successful submissions.

**Tests:** Default Ship settings; fourth human leg refusal; partial persistence; retry of denied/declined/completed legs; churn retry identity; budget/attention accounting.

**Starting points:** `src/wedge/ship.ts`, `src/wedge/churn.ts`, `src/coord/coordinator.ts`.

### FLOW-014 — Make final deliverables inspectable before approval

- [ ] Persist launch, support, sales, and feature deliverables as versioned artifacts.
- [ ] Show the exact asset/task being approved, not only its schema and goal.
- [ ] Provide artifact previews/downloads and version diffs with appropriate authorization.
- [ ] Require explicit citation coverage for factual draft items; reject empty/insufficient evidence where grounding is required.
- [ ] Display failed checks and distinguish findings, hypotheses, and unsupported content.
- [ ] Add a request-changes/revision path tied to the same workflow.
- [ ] Bind final execution/publication approval to the reviewed asset version.
- [ ] Keep irreversible external action behind the product's required human-command boundary.

**Acceptance:** A reviewer can answer “What exactly will happen or be published?” before approving, and can inspect what actually resulted afterward.

**Dependencies:** FLOW-001, FLOW-002.

**Starting points:** `src/console/review.ts`, `src/console/detail.ts`, `src/wedge/ship.ts`, `src/jcode/runner.ts`, `scripts/dogfood-ship.ts`.

### FLOW-015 — Create a continuous release workspace

- [ ] Add a supported workflow creation entry point from the console or clearly documented operator flow.
- [ ] Link source receipts, summary, affected segments, child requests, assets, decisions, and execution receipts.
- [ ] Show stage owner, current state, last update, blocker, and next action consistently.
- [ ] Expose execution progress, failure reason, cancellation, and safe retry/recovery.
- [ ] Add pre-registration of metric, baseline, comparison basis, and measurement window before the pilot runs.
- [ ] Add outcome capture with measured basis and clear unsupported/unknown states.
- [ ] Distinguish execution completed from measurement pending and business outcome verified.
- [ ] Expose replay of frozen versus current evidence without re-executing work.
- [ ] Link eligible completed traces to procedure evaluation, with quarantine/transfer/drift gates preserved.
- [ ] Apply the same durable journey pattern to churn and feature workflows without broadening the initial onboarding beyond the release wedge.

**Acceptance:** A user can follow one release from input to measured outcome and explain its approval, execution, cost, and evidence from a single connected workspace.

**Dependencies:** FLOW-001–003, FLOW-013–014, FLOW-016, FLOW-020.

**Starting points:** `src/console/serve.ts`, `src/console/detail.ts`, `src/console/report.ts`, `src/wedge/`, `src/ledger/ledger.ts`, `src/attrib/`.

---

## 6. P1 — Integrations and research recovery

### FLOW-016 — Standardize ingestion and expose connection health

- [ ] Define one explicit collector/worker contract for returned events and durable staging.
- [ ] Ensure Serper and every supported collector follow that contract.
- [ ] Provide supported configuration, permission explanation, connection test, and source preview paths.
- [ ] Show last successful receipt, checkpoint, freshness, rejected/quarantined items, and actionable errors.
- [ ] Distinguish unconfigured, disabled, empty, delayed, rate-limited, and failed integrations.
- [ ] Add checkpoint-aware retry/resume and duplicate-safe recovery.
- [ ] Explain which ingestion actions populate claims versus start downstream workflows.
- [ ] Preserve safe credential handling and source provenance; never present model-generated material as verified fact.

**Acceptance:** A successful source call produces an observable receipt or an explicit rejection; missing data cannot masquerade as successful ingestion.

**Tests:** Every collector through the same worker; empty result; invalid credentials; provider timeout/rate limit; partial batch; refresh/restart; duplicate delivery; rejected evidence.

**Starting points:** `src/ingest/collectors.ts`, `src/ingest/worker.ts`, `src/cli.ts`, `src/console/serve.ts`.

### FLOW-017 — Make research state durable and resumable

- [ ] Persist the full approved plan, restrictions, progress, budget accounting, cancellation, and final report.
- [ ] Make persisted state authoritative over stale caller objects.
- [ ] Add explicit paused-budget, failed, cancelled, and completed states.
- [ ] Resume by run ID and remaining work, not reconstruction/reapproval of an incomplete object with the same ID.
- [ ] Add revision checks and execution ownership to prevent competing executors from overwriting state.
- [ ] Respect cancellation across refresh/restart/stale callers.
- [ ] Show partial results and remaining questions when pausing or failing.
- [ ] Expose the plan → approval → progress → cancel/resume → report journey through a supported entry point.

**Acceptance:** Budget exhaustion does not claim completion, cancellation remains authoritative, and resuming preserves the exact approved plan and cumulative work.

**Tests:** Budget-limited run; direct resume; persisted cancellation with stale caller; concurrent execution; changed plan; restart; final report persistence.

**Starting points:** `src/wedge/deepresearch.ts`, `test/deepresearch.test.ts`.

### FLOW-018 — Preserve uncertainty in research reports

- [ ] Track accepted findings and unresolved gaps per subquestion, including searched-with-no-results cases.
- [ ] Preserve question-to-source relationships when deduplicating shared sources.
- [ ] Carry contradictory/disputed evidence warnings into the attached report.
- [ ] Derive bibliography entries from the evidence actually cited.
- [ ] Distinguish direct findings from labeled inferences and unsupported claims.
- [ ] Show rejected-source counts and incomplete coverage without implying certainty.

**Acceptance:** The final report cannot appear more complete or less contested merely because intermediate uncertainty was dropped during attachment.

**Tests:** Zero-result question; all sources rejected; shared source across questions; contradicted citation; unsupported bullet; bibliography coverage; report round trip.

**Dependencies:** FLOW-017.

**Starting points:** `src/wedge/deepresearch.ts`.

---

## 7. P1/P2 — Navigation, history, and consistent states

### FLOW-019 — Add persistent, context-preserving navigation [P2]

- [ ] Provide shared navigation for Reviews, Workflows/History, Digest, Team, and Account as those destinations become available.
- [ ] Use the resolved console home rather than hardcoded `/` when the marketing site is co-hosted.
- [ ] Preserve request identity and queue/evidence page through detail navigation.
- [ ] Link every actionable “Needs a human” item to its task.
- [ ] Put account/team/logout controls in a discoverable shared location.
- [ ] Remove destination-like labels for features not yet reachable.

**Acceptance:** Inspecting evidence does not send users back to page one or the marketing site; routine account actions are discoverable.

**Tests:** Co-hosted back links; request → evidence → correction → request; paginated queue return; keyboard navigation.

**Starting points:** `src/console/render.ts`, `src/console/detail.ts`, `src/console/serve.ts`.

### FLOW-020 — Make all relevant work discoverable at scale [P1]

- [ ] Add permissioned searchable request, claim, and workflow indexes.
- [ ] Add status, scope, date, and workflow/release filters with stable pagination.
- [ ] Show true totals and explicit truncation where dashboard windows remain bounded.
- [ ] Provide “View all” paths for rooms, requests, and human work.
- [ ] Separate pending decision from approved/executing work; do not infer review need solely from human-minute bids.
- [ ] Provide meaningful no-results states and clear-filter actions.
- [ ] Preserve filter/sort/page state across refresh and detail navigation.
- [ ] Validate large-organization performance without hiding records to simulate responsiveness.

**Acceptance:** Older work and records outside the dashboard window remain reachable without knowing their IDs or querying SQL.

**Tests:** More than 50 rooms, 20 requests per room, and 100 human items; stable pagination during inserts; filtering; no results; cross-tenant isolation.

**Starting points:** `src/console/report.ts`, `src/console/render.ts`, `src/console/detail.ts`, `src/coord/coordinator.ts`.

### FLOW-021 — Wire a real digest [P2]

- [ ] Add a reachable digest destination and link it from the dashboard.
- [ ] Include request/evidence drill-down and a clear time window.
- [ ] Group against the latest eligible topic bucket, not the oldest historical match.
- [ ] Sort by final group activity after updates.
- [ ] Keep NOTICE behavior noninterrupting; do not turn digest delivery into new approval noise.

**Acceptance:** “Notices → digest” is a real, navigable, correctly grouped feature.

**Tests:** Recurring topic across multiple windows; updated group ordering; empty digest; evidence links; notices do not consume review attention.

**Starting points:** `src/console/digest.ts`, `src/console/report.ts`, `src/console/render.ts`, `src/console/serve.ts`.

---

## 8. P0/P1 — Enterprise operations and support

### FLOW-022 — Expose supported emergency-stop and recovery operations [P0 before autonomous pilots]

- [ ] Add supported operator commands for tenant/scope/action-class stop controls and authorized recovery.
- [ ] Show active stops/freezes, actor, time, scope, reason, affected work, and recovery requirements.
- [ ] Notify the responsible operator when automation self-halts or requires recovery.
- [ ] Separate policy-check drills from real runtime halt/cancellation drills.
- [ ] Verify what happens to in-flight work, queued work, and external operations during a halt.
- [ ] Record approval and audit evidence for recovery; do not silently resume after restart.

**Acceptance:** An authorized operator can stop, verify, investigate, and recover the system without discovering internal library calls during an incident.

**Tests:** Stop at each supported scope; queued/in-flight work; restart while stopped; policy-only versus runtime drill evidence; controlled resume; notification failure fallback.

**Starting points:** `src/gov/trust.ts`, `src/gov/act.ts`, `src/cli.ts`, `src/console/serve.ts`.

### FLOW-023 — Separate liveness, readiness, and support diagnostics [P1]

- [ ] Keep cheap liveness while adding bounded readiness checks for required dependencies.
- [ ] Expose authenticated worker/integration status and distinguish optional unconfigured dependencies.
- [ ] Change the site's status wording so process reachability does not imply workflow readiness.
- [ ] Add an opaque support reference to user-facing failures and correlated sanitized diagnostic logs.
- [ ] Document support contact, triage information, escalation, and supported topology.
- [ ] Provide clear retry guidance for known failure classes without blindly replaying sensitive actions.

**Acceptance:** A green liveness response cannot be mistaken for proof that ingestion, database access, execution, and measurement are operational. Support can locate an error without guessing from timestamps alone.

**Tests:** Dependency outage; worker stopped; source rate limit; optional integration absent; sanitized error correlation; support reference on browser/server failure.

**Starting points:** `src/console/serve.ts`, `site/app.js`, `SECURITY.md`, `docs/deployment.md`.

### FLOW-024 — Package non-destructive export and audit investigation [P1]

- [ ] Add a supported non-destructive Ledger export command and permissioned browser download/request path.
- [ ] Describe export contents and omissions using a manifest; distinguish dashboard snapshot, Ledger evidence package, and full backup.
- [ ] Include appropriate artifact references/ownership metadata for the advertised export scope.
- [ ] Provide searchable/paginated audit history by actor, action, date, request, and decision.
- [ ] Link audit events to reviewed evidence, authorization, execution receipts, and outcome where present.
- [ ] Verify any claimed immutable archival delivery end to end; bucket provisioning alone is not proof of archived events.
- [ ] Document and test backup/restore separately from Ledger-history import.
- [ ] Show export progress, failure/retry, completion, and retention/expiry where applicable.

**Acceptance:** Customers can obtain the promised portable records without custom code, and support can reconstruct an action through a connected audit trail.

**Tests:** Read-only export on each supported engine; full scope/manifest checks; large export; restricted user; archival delivery where configured; backup restore drill; partial export failure.

**Dependencies:** FLOW-001, FLOW-005, FLOW-015.

**Starting points:** `src/ledger/export.ts`, `src/cli.ts`, `src/console/serve.ts`, `src/console/report.ts`, `deploy/aws/main.tf`, `docs/deployment.md`.

### FLOW-025 — Make governance configuration understandable and effective [P1]

- [ ] Inventory supported approval, budget, scope, trust, and stop settings with their actual configuration entry points.
- [ ] Show effective policy and its source to authorized operators, including startup-only settings.
- [ ] Explain what a setting changes, what it does not change, and whether restart/review is required.
- [ ] Add explicit validation, confirmation, and audit capture for supported policy changes.
- [ ] Expose actionable compiler trust gaps and links to required evaluation evidence rather than implying automatic promotion.
- [ ] Keep pricing/billing scope explicit: provide a pilot/contact path now; add subscription/invoice flows only if a hosted commercial model is selected.

**Acceptance:** Operators can understand the active policy and safely change supported settings without assuming that a UI choice globally grants agent autonomy.

**Tests:** Effective-policy display; invalid configuration; role restrictions; scope tightening; policy change audit; restart-required messaging.

**Starting points:** `src/gov/`, `src/compiler/`, `src/console/render.ts`, `src/console/serve.ts`, `src/cli.ts`.

---

## 9. P2 — Accessibility and progressive enhancement

### FLOW-026 — Keep the website usable without decorative rendering

- [ ] Make core content and CTAs usable before JavaScript enhancement and if JavaScript is unavailable.
- [ ] Remove the blocking loader or provide a nonblocking fallback.
- [ ] Isolate WebGL/Three.js failures from console wiring and navigation initialization.
- [ ] Support reduced motion and stop unnecessary continuous motion when appropriate.
- [ ] Add menu focus management, focus return, Escape handling, and accurate expanded state.
- [ ] Ensure non-button interactive elements have appropriate keyboard equivalents or replace them with semantic controls.
- [ ] Validate keyboard and small-screen access to the primary CTA without requiring cinematic scrolling.

**Acceptance:** Restricted graphics, reduced-motion preference, or keyboard-only use does not block understanding or entering the product.

**Tests:** JavaScript unavailable; WebGL unavailable/renderer throws; reduced motion; keyboard menu; mobile CTA access.

**Starting points:** `site/index.html`, `site/app.js`, `site/styles.css`.

### FLOW-027 — Make account and console states accessible and responsive

- [ ] Add viewport metadata to account and console documents where missing.
- [ ] Provide usable narrow-screen layouts for team tables, evidence, and review forms.
- [ ] Associate errors with fields and provide accessible error summaries/focus handling.
- [ ] Preserve visible keyboard focus and non-color status cues.
- [ ] Use consistent action labels, confirmation patterns, and success/error placement across pages.
- [ ] Validate 320, 375, 414, and 768px widths, zoom, keyboard use, and representative screen-reader flows.

**Acceptance:** Core setup, login, evidence review, correction, and team administration remain usable on narrow screens and with assistive technology.

**Tests:** Responsive browser checks; keyboard traversal; error announcement; long names/IDs; zoom; focus after success/conflict/error.

**Starting points:** `src/console/serve.ts`, `src/console/render.ts`, `src/console/detail.ts`, `src/console/review.ts`.

---

## 10. Cross-cutting state checklist

Apply this checklist to every new or changed journey; do not add states cosmetically where they have no meaningful behavior.

- [ ] **Loading:** Show the operation in progress; prevent accidental duplicate actions.
- [ ] **Success:** Explain what actually completed and provide the next step/receipt.
- [ ] **Empty:** Distinguish unconfigured, no data yet, and no matching results.
- [ ] **Error:** Explain the failed stage, what was preserved, and a safe recovery action.
- [ ] **Permission denied:** Explain required authority without exposing restricted data.
- [ ] **Expired session:** Preserve safe context and require explicit resubmission.
- [ ] **Stale/conflicting state:** Show what changed and retain the user's draft.
- [ ] **Partial completion:** List successful, failed, refused, deferred, and untouched steps.
- [ ] **Timeout/unknown result:** Reconcile server state before offering retry; never assume failure means nothing happened.
- [ ] **Refresh/restart:** Restore durable progress and authoritative cancellation/approval state.
- [ ] **Destructive action:** Name the target, consequences, recovery limits, and retained data.
- [ ] **Large organization:** Keep complete history reachable through bounded, stable views.

---

## 11. End-to-end regression gates

- [ ] **E2E-01:** Website CTA → correct deployment → authorized owner setup → first real source → first cited review.
- [ ] **E2E-02:** Existing organization → login → intended destination; no impossible organization-creation loop.
- [ ] **E2E-03:** Invitation → explicit delivery/handoff → acceptance → activation → authorized action → disable/reactivate.
- [ ] **E2E-04:** Forgotten password/owner recovery → correct production tenant → restored access with obsolete sessions revoked.
- [ ] **E2E-05:** Review → evidence corrected elsewhere → stale approval rejected → diff → explicit re-review.
- [ ] **E2E-06:** Approval → frozen decision → exact approved execution → artifact receipt → measured outcome → replay.
- [ ] **E2E-07:** Default Ship fan-out → partial admission/refusal → honest status → eligible retry with no duplicate work.
- [ ] **E2E-08:** Research budget pause → persisted partial results → resume → complete report with gaps and contradictions retained.
- [ ] **E2E-09:** Cancellation followed by refresh/restart/stale caller → no silent resume.
- [ ] **E2E-10:** Session expires during review → draft/context retained → authenticate → recheck → explicit submission.
- [ ] **E2E-11:** Concurrent correction → one winner → actionable conflict → affected pending work re-reviewed.
- [ ] **E2E-12:** Integration outage/partial delivery → useful status → recovery → no duplicate claims or lost receipts.
- [ ] **E2E-13:** Emergency stop → affected work visible → halt verified → audited recovery.
- [ ] **E2E-14:** Non-destructive export → accurate manifest → download; backup restore tested separately.
- [ ] **E2E-15:** Erasure with export-storage failure → truthful recoverable state; successful erasure → residual-data verification.
- [ ] **E2E-16:** More records than dashboard caps → search/filter/history still exposes all authorized work.
- [ ] **E2E-17:** Documented production topology → externally reachable application → readiness failure correctly reported on dependency loss.
- [ ] **E2E-18:** Keyboard/reduced-motion/narrow-screen journeys complete without decorative-rendering dependency.

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
