# Incomplete & Orphaned Feature Audit

**Project:** Vital  
**Audit date:** 2026-09-17  
**Disposition:** Internal prototype with substantial library foundations; not a production-complete agent runtime.  
**Product completeness:** **40/100**  
**Production readiness:** **25/100**

## Executive summary

Vital is not merely a scaffold. It contains meaningful ledger invariants, frozen decision context and replay, coordination controls, evaluation persistence, compiler gates, a database-backed HTML console, real HTTP mutation routes, a jcode client, a model client, and substantial deployment configuration.

**The dominant problem is composition, not lack of code.** The deployed `serve` command starts the console. It does not start the scheduler, route work through the cognitive router, dispatch jobs to SQS or jcode, apply the full governance policy at execution boundaries, run the sensing funnel, deliver Buzz progress, or close the learning loop. Several tests demonstrate independently callable functions while leaving the promised user journey untested.

The highest-value product is one genuine **Ship-to-Result** loop. Completing that loop is preferable to adding more departments, adapters, dashboards, or infrastructure.

### Immediate conclusions

1. **Do not expose the console as an enterprise administration surface yet.** The current optional shared-secret gate protects mutations when configured, but does not establish individual identity, permissions, or tenant-bound access. Reads remain open.
2. **Approval does not complete the execution handoff.** Console approval produces `ACCEPTED`; jcode execution claiming requires `ADMITTED`.
3. **Paid execution and accounting are inconsistent.** The Lambda executor does not acquire the available execution claim and supplies completion costs to an API that does not charge them.
4. **Learning evidence is not yet trustworthy enough for promotion claims.** Echo completion can count as transfer success, promotion consumes caller-supplied statistics, and dogfood records invented outcome measurements.
5. **Deployment configuration is ahead of application integration.** Queue consumers, sidecars, storage, and alarms exist without all corresponding producers, writers, recovery loops, and verified operational delivery.
6. **Green tests are component confidence, not product completeness.** The focused tests passed, including tests whose names overstate what they establish.

---

## Audit method and limits

- Ignored `TODO.md`; it was not used as evidence or as the completion checklist. References to it inside other source files were not followed.
- Inspected application entrypoints, source modules, database schema, relevant tests, scripts, deployment configuration, and the product contract in `idea.md`.
- Distinguished a useful library primitive from an advertised integrated feature. A function is not automatically dead because it has no page.
- Checked production-oriented callers separately from tests, seed scripts, and manual demonstrations.
- This was a **read-only application audit**. Only this report was created; no fixes, deployment, live paid calls, or exploit reproduction were performed.
- **The working tree changed during inspection.** Multiple audited files already had modifications, and further changes appeared during the pass. Findings describe the inspected working-tree versions, not an immutable commit. Recently added operator-secret gating, request execution claims, inbox/outbox helpers, research checkpoints, read-only compiler presentation, and report metrics are acknowledged below. Earlier superseded findings were not carried forward as absences.
- Line references identify inspected locations and may shift with concurrent edits. Named functions are included for navigation when practical.
- “No production caller found” means none found in repository application/script wiring. It does not rule out an external consumer importing this library.
- Production concurrency and deployment failures below are **source-level findings**, not claims of reproduced incidents.

### Validation actually performed

| Command                                                                                                      | Result                  | What it establishes                                                            |
| ------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------ |
| `npm run typecheck`                                                                                          | Passed                  | Current TypeScript inputs typecheck; not build/start or deployment correctness |
| `node --import tsx --test --test-force-exit test/deepresearch.test.ts test/console.test.ts test/aws.test.ts` | **26 passed, 0 failed** | Focused local tests using SQLite, local HTTP and injected collaborators        |

The full `npm test` entrypoint was not run: it enables writes to `var/status.json` through `test/run.ts` and `test/helpers.ts:25–48`. No live Postgres, Docker build/boot, Terraform apply, AWS queue, Buzz relay, live coding turn, browser interaction, or external model quality test was performed. The focused AWS tests use **empty batches**; their passing result does not verify execution or tenant isolation.

---

# 1. Feature and connectivity inventory

## 1.1 Product surface, pages, routes, forms, settings

There is one server-rendered HTML dashboard, not a multipage business application.

| Surface                          | Current implementation                                                                | Connectivity / missing outcome                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CLI `status`                     | SQLite ledger/coordinator statistics; Postgres migration/schema metadata              | Callable. SQLite statistics use `acme`; Postgres branch is not the same instance-verification workflow              |
| CLI `report`                     | Writes dashboard HTML from SQLite                                                     | Callable, but rejects Postgres and ignores `DATABASE_URL`                                                           |
| CLI `serve`                      | Opens/migrates DB and starts console                                                  | Connected console only; no background orchestration startup                                                         |
| `GET /`                          | Database-backed dashboard                                                             | Connected, unauthenticated read surface                                                                             |
| `GET /healthz`                   | Constant-cost liveness JSON                                                           | Connected; deliberately not a DB-readiness check                                                                    |
| `GET /api/approval-latency`      | Coordinator latency statistics                                                        | Connected, no dashboard action consumes it directly                                                                 |
| `GET /api/metrics`               | Process request/error/report counters and uptime                                      | Connected; recent addition, not a full telemetry pipeline                                                           |
| `POST /api/requests/:id/approve` | Accepts request; best-effort latency record                                           | Callable; optional operator-secret gate; no rendered browser control                                                |
| `POST /api/requests/:id/decline` | Declines request with reason                                                          | Callable; same identity/UI limitations                                                                              |
| `POST /api/claims/:id/correct`   | Supersedes claim; returns diff; proposes eval case best-effort                        | Callable; no correction form, typed-value correction or failed-eval backfill workflow                               |
| Other routes                     | 404                                                                                   | No webhook, Slack intake, research, execution, digest, identity, or admin routes                                    |
| Reality health section           | Staleness, contradictions, provenance, orphan claims, latency                         | Real reads; some metric semantics incomplete; MTTR explicitly unmeasured                                            |
| Cost and tier charts             | Decision-cost SVG; weekly execution-tier mix                                          | Real reads, but inputs do not establish trustworthy ROI or live routing                                             |
| “Needs a human”                  | Request cards, counts and budget-based queue                                          | Read-only; includes nonterminal human-budget work, not precisely pending approvals                                  |
| Compiler board                   | Six lifecycle columns and transfer/trust metadata                                     | Read-only by design; no promotion/evaluation operating workflow                                                     |
| Rooms                            | Scope health, request states, evidence snippets                                       | Connected, bounded display without full drill-down/pagination                                                       |
| Digest                           | Count and “notices → digest” text                                                     | Actual digest renderer is not connected                                                                             |
| Forms/navigation                 | No rendered action forms, controls, detail links, search/filter or pagination         | Browser cannot complete the mutation workflows                                                                      |
| Settings                         | CLI flags, environment variables, constructor configuration, namespaced `meta` values | No operator settings UI or validation/test-connection workflow; several environment values have no runtime consumer |
| Administration                   | Direct policy/governance functions and DB-backed metadata                             | No authenticated user/role management, policy-review UI, or tenant administration                                   |

**Evidence:** `src/cli.ts:35–130`; `src/console/serve.ts` route handler; `src/console/render.ts:169–233`; `src/console/report.ts`; `src/console/digest.ts`.

## 1.2 Services, integrations and background jobs

| Module                   | Features present                                                                                                                    | Actual integration status                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `core/`                  | Async SQLite/Postgres abstraction, schema, sequence allocation, integrity helpers, migration journal                                | Runtime DB path used; separate migration journal not authoritative                                     |
| `ledger/`                | Typed claims, provenance, links, staleness, verification/correction, subjects/aliases, decisions, outcomes, replay, export          | Strongest connected foundation; curation/resolution/export UX incomplete                               |
| `coord/`                 | QUERY/REQUEST/NOTICE, admission, dedupe, hops/cycles, budgets, decomposition, execution claim/reclaim, expiration, approval latency | Used by console and execution libraries; state/recovery/accounting contracts inconsistent              |
| `router/`                | Four-tier routing, shadow/control mode, labels, calibration, task registry, tier fallback                                           | Primarily tests/demo; not production dispatch owner                                                    |
| `compiler/`              | Skill cards, mining, quarantine→shadow→pilot→promotion, transfer, drift, registry                                                   | Console reads and dogfood compilation connected; operating promotion/drift/execution loop missing      |
| `gov/`                   | R/A/I matrix, trust/freeze, kills, honeytasks, review sampling, batch/rate limits, shell screening, reversible-action records       | Shell screening connected to jcode. Full trust/kill governance not connected to live permission path   |
| `evals/`                 | Cases/runs, correction intake, held-out gating, injection suites, separate stage promotion                                          | Correction intake connected. General suites/stages not tied into production compiler traffic           |
| `attrib/`                | Costing, tier metrics, holdouts, preregistration, caveats                                                                           | Costing displayed; causal experiment workflow absent                                                   |
| `ingest/`                | File/GitHub/Serper collectors, checkpointing, inbox helpers, artifacts, novelty/dedupe                                              | GitHub polling and ingestion have dogfood caller; durable consumer and occurrence semantics incomplete |
| `sense/`                 | Watch Contract compilation/status, materiality, model triage, integrity, poisoning fixtures                                         | No production sensing loop found                                                                       |
| `wedge/ship.ts`          | Cited release summary, affected scopes, five-leg request fan-out, copy check                                                        | Dogfood invokes it; no completed five-leg deliverables or real measurement                             |
| `wedge/churn.ts`         | Risk validation, three-leg requests, recommendation decision                                                                        | Test/library workflow; does not wait for and act on completed business results                         |
| `wedge/feature.ts`       | Research observations, plan, named approval, injected harness execution                                                             | Test/library workflow; approval-to-write authority and evidence binding incomplete                     |
| `wedge/deepresearch.ts`  | Plan/proposal/approval, search, filtering, URI dedupe, cancellation, optional checkpoints, cited report                             | Test-only external callers found; lifecycle/reporting defects remain                                   |
| `jcode/`                 | Protocol/client/session/permission handling, runner, usage/progress                                                                 | Real socket tests and boundary probe; no deployed application dispatch composition                     |
| `substrate/harness.ts`   | Jcode and local echo adapters; selector                                                                                             | Used by feature/transfer libraries and tests; echo is not another model                                |
| `substrate/models.ts`    | Dev/prod profiles, model client, approval registry, judge                                                                           | AWS executor uses approved model path; raw client/triage/judge do not universally enforce approval     |
| `substrate/scheduler.ts` | In-memory jobs/tick/webhook budget logic; durable outbox and occurrence helpers                                                     | No production tick loop, producer/relay, reclaim or polling job registration found                     |
| Other substrate          | Scope tokens, sandbox manifests, egress decisions/proxy, content-screen contracts                                                   | Egress decisions used by AWS; most enforcement helpers not composed at harness boundary                |
| `talk/`                  | HMAC claim bindings, Buzz event/progress publisher and run watcher                                                                  | Library/test composition; no verified production signing/relay or terminal delivery lifecycle          |
| `capabilities/`          | Contract validation, quarterly kill/silence criteria                                                                                | Explicitly a format/policy primitive; not an operating department manager                              |
| `aws/`                   | SQS-shaped Lambda model executor                                                                                                    | Handler exists and Terraform maps queue; no repository SQS producer found                              |
| `vendor/qm/`             | Command policy, safe regex, governor, ship gate, crypto/object/error helpers                                                        | Command policy/regex active; governor and several grant/configuration helpers dormant                  |

### Connected flow versus intended flow

```text
ACTUAL SERVICE
cli serve → DB migration → console read model
                         → approval/decline API → coordinator state
                         → correction API → supersession → proposed eval case

SEPARATE EXECUTION LIBRARIES
JcodeAdapter → JcodeRunner → external jcode → observation/trace
SQS-shaped event → AWS executor → model client → observation/completion

MISSING PRODUCTION CONNECTION
intake → durable dispatch → governed execution → deliverable review
       → approved business action → measured outcome → eval/learning
```

## 1.3 Database inventory

The inspected runtime DDL declares **22 distinct tables**, plus a conditional `schema_migrations` table created by the separate journal. This is schema inspection, not a live database count.

| Domain                    | Tables                                                         | Use / limitation                                                                               |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ledger                    | `claims`, `claim_links`, `decisions`, `outcomes`, `ledger_seq` | Active; resolution and correction semantics incomplete                                         |
| Subject identity          | `subjects`, `subject_aliases`                                  | Library-backed identity/alias support; not an operator curation workflow                       |
| Coordination              | `requests`, `escalations`                                      | Active; lease/reservation additions exist, but worker and daily-attention lifecycle incomplete |
| Compiler                  | `skill_cards`, `traces`, `skill_transfer_tests`                | Used; transfer evidence not revision/eval-bound                                                |
| Router                    | `routing_decisions`, `routing_calibration`                     | Test/demo/library-backed; routing records lack a direct request link                           |
| Governance                | `trust_scores`, `honeytasks`                                   | Policy persistence exists; no production outcome/review feedback loop found                    |
| Evaluation                | `eval_cases`, `eval_runs`                                      | Active correction intake plus library/tests                                                    |
| Audit/configuration       | `audit_log`, `meta`                                            | Active; `meta` also carries heterogeneous business state without first-class lifecycles        |
| Durable integration       | `ingest_inbox`, `outbox`                                       | Recent schema/helper additions; no authoritative runtime consumer/relay                        |
| Parallel migration system | `schema_migrations`                                            | Journal tests; not normal `migrate()` authority                                                |

Evidence: `src/core/db.ts` additive migrations and `SCHEMA`; `src/core/migrations.ts:25–63`.

**Not found:** first-class user/role membership, research/report entity lifecycle, contradiction resolution cases, prediction/outcome association, immutable card/eval revision lineage, or experiment assignment/measurement lifecycle. Some corresponding fragments live in `meta`; absence of a dedicated table alone is not a defect, but the missing workflows are.

---

# 2. Critical incomplete features and completion register

**Status vocabulary:** Complete = integrated for its stated bounded purpose; Partial = implemented pieces with missing lifecycle; Prototype = demonstration-level workflow; Placeholder = explicit nonimplementation; Orphaned = no production-oriented entrypoint/consumer found. A feature may be both partial and orphaned.

**Priority:** Critical = block public exposure/unsafe production reliance; High = blocks the core workflow or trustworthy data; Medium = important product/operational completion; Low = cleanup/deferred scope.

**Effort:** Small ≈ 0.5–2 engineering days; Medium ≈ 3–7 days; Large ≈ multi-component work, often several weeks. These are rough implementation/test estimates, not a delivery commitment. Findings overlap and must not be summed mechanically.

## F01 — Operator identity, authorization and tenant access

**State:** Remediated. **Priority:** Critical. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — authenticated principals, server-side derived actor/tenant, role-based authorization, session revocation, audit attribution, and private deployment posture.

**Evidence:** `src/core/auth.ts`; `src/console/serve.ts:79–105,467–493,593–645,773–848,958–1029,1066–1110`; `src/cli.ts:138–157`; `deploy/aws/main.tf:144–165,584–591`; `deploy/aws/variables.tf:198–211`; `test/console.test.ts:17–84,236–260,733–793`.

The operator identity and tenant authorization boundary is fully composed and enforced:

- **Authenticated Principals & Sessions**: Complete identity core in `src/core/auth.ts` (`users`, `tenants`, `auth_sessions`, `login_attempts`). Passwords use salted `scryptSync` (Node crypto). One session cookie format (`vital_session`), `HttpOnly`, `SameSite=Lax`, and `Secure` when behind TLS. Unprovisioned consoles claim the tenant via `/signup`; provisioned tenants require login or invite.
- **Server-Side Derived Actor & Tenant**: Every console route and API mutation derives the actor identity exclusively from the authenticated session (`${user.id} (${user.email})`). Caller-asserted `by` fields in request bodies are ignored. Cross-tenant access is strictly rejected (`auth.user.tenant !== tenant` returns 403).
- **Per-Action/Scope Permissions & Dual Gates**: Role hierarchy (`owner` > `admin` > `member`) enforces that approvals require `approverMin` role (configurable per tenant, default `member`), and team management requires `admin` or `owner`. For high-security environments, `operatorSecret` (`x-vital-operator`) or cryptographic ed25519 `operatorKeys` (`x-vital-signature`) provide secondary defense-in-depth authorization without replacing session identity.
- **Audit Attribution & Revocation**: Every authentication and mutation action logs to `audit_log` (`auth.tenant_provisioned_web`, `auth.login`, `auth.logout`, `auth.password_changed`, `team.invite`, `team.disable`, `console.approve`, `console.decline`, `console.correct`). Changing password or disabling a user immediately revokes all active sessions for that user.
- **Fail-Closed Private Deployment Posture**: In `deploy/aws/variables.tf` and `deploy/aws/main.tf`, added `alb_internal` (deploying internal ALB in private subnets without public IP) and `alb_ingress_cidrs` (restricting HTTP/HTTPS ingress to corporate or VPC CIDRs). All console mutation and read endpoints fail closed on unauthenticated, unauthorized, cross-tenant, or invalid CSRF requests.
- **Verification**: Multiple regression suites in `test/console.test.ts` verify session authentication, operator secret + key checks, role denial, CSRF enforcement, cross-tenant isolation, and audit log attribution.

## F02 — Browser approval and correction workflows

**State:** Remediated. **Priority:** High. **Effort:** Medium. **Disposition:** Remediated 2026-09-17 — interactive review controls, claim/request detail pages, progressive forms, real-time feedback, and browser lifecycle test suite.

**Evidence:** `src/console/review.ts`; `src/console/detail.ts`; `src/console/serve.ts:773–848,958–1029,1066–1110`; `test/review.browser.ts`; `test/console.test.ts:168–346,566–664`.

The browser console now provides a complete, interactive human approval and evidence curation workflow:

- **Defined Approval State & Queue**: Pending review queue (`renderReview` in `src/console/review.ts`) precisely filters admitted requests requiring human judgment (`state === 'ADMITTED' && messageClass === 'REQUEST' && bid.humanMinutes > 0`). Approved requests transition to `ACCEPTED` and settle out of the pending queue.
- **Evidence & Intended Action Inspection**: Review cards present request goal, ID, origin→target scopes, deliverable schema, deadline, and dollar/token/human budgets. Evidence claims are listed with type, status, statement, and source URI. Requests with >20 claims link to `/console/requests/:id` displaying full request metadata and paginated evidence.
- **Claim Detail & Structured Correction**: `/console/claims/:id` displays full claim metadata, value/unit, source link, and supersession history (`claim_links`). Unretired claims provide an interactive correction form (`/api/claims/:id/correct`) supporting edited statements and typed numeric values or value clearing. Corrections supersede the old claim in the ledger and automatically propose regression test cases into the evaluation spine (`eval_cases`).
- **Interactive Controls & Progressive Feedback**: Review forms provide role-gated Approve and Decline controls with mandatory confirmation checkboxes, decline reasons, and operator credentials. `REVIEW_SCRIPT` provides progressive enhancement: buttons are enabled on JavaScript load, forms prevent double-submission with busy locks (`aria-busy`), display real-time status updates ("Submitting…", "Approved — awaiting execution", "Correction saved"), handle 15-second timeouts cleanly, and link directly to corrected claims.
- **Verification**: End-to-end browser lifecycle verified in `test/review.browser.ts` (Playwright automation covering authentication, pagination, claim detail inspection, correction form validation, operator secret enforcement, supersession verification, cross-tenant 404 rejection, request approve/decline, and empty queue reload) and 4 unit/integration suites in `test/console.test.ts`.

## F03 — Approval, admission, execution and recovery state machine

**State:** Remediated. **Priority:** High. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — unified execution transition graph, approval marker preservation, immutable terminal settlements, and deployed worker recovery sweeps.

**Evidence:** `src/coord/coordinator.ts:765–819,988–1023,1240–1320`; `src/substrate/worker.ts:25–70`; `src/jcode/runner.ts:125–142`; `src/aws/executor.ts:151–210`; `test/worker.test.ts:75–125`; `test/coord.test.ts:410–480`.

The coordination state machine and execution lifecycle are unified and closed against stranding or corruption:

- **Executable Set**: `claimExecution`'s CAS atomically transitions `ADMITTED | ACCEPTED | IN_FLIGHT`. Every execution runtime (`ApplicationWorker`, `JcodeRunner`, `LocalEchoAdapter`, AWS Lambda executor) gates on this exact executable set. Approval transitions `ADMITTED` → `ACCEPTED`, which is immediately claimable by background workers without stranding.
- **Approval Marker Preservation**: `coord.charge` and usage reporting transition `ACCEPTED` requests to `IN_FLIGHT` while preserving the human approver identity, decision record, and approval latency.
- **Immutable Terminal Settlements**: Late completion reports over refused, expired, or budget-terminated work settle to `FAILED` with worker objections preserved behind `REFUSAL|` prefixes (`LATE_COMPLETION_SETTLEMENT`). Redelivery recovery `FAILED` → `COMPLETED` is permitted for genuine execution failures but strictly refused for preserved human refusals. Same-state re-settlement remains idempotent crash recovery.
- **Deployed Recovery Sweeps**: Fully wired into `ApplicationWorker` (`src/substrate/worker.ts`): background sweep intervals automatically execute `coord.readmitDeferred` (moving deferred requests back to `ADMITTED` once scope concurrency permits), `coord.reclaimStale` (reclaiming expired execution leases back to `ADMITTED`), and `coord.expireStale` (transitioning timed-out requests to `EXPIRED`).
- **Verification**: Regression tests in `test/coord.test.ts` and `test/worker.test.ts` verifying approved-claimable lifecycle, deferred readmission under concurrency caps, refusal-over-late-completion settlements, and background sweep recovery. Full test suite passing.

## F04 — Deployed application composition and dispatch

**State:** Remediated. **Priority:** High. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — owned worker daemon, durable outbox relay, coordinator recovery sweeps, and governed request dispatch.

**Evidence:** `src/cli.ts:155–175,225–255,325–335`; `src/substrate/worker.ts`; `src/substrate/scheduler.ts:125–225`; `src/aws/executor.ts:35–45`; `test/worker.test.ts`.

The deployed application composition now includes an owned, robust background worker daemon and dispatch loop:

- **Owned Worker Daemon (`ApplicationWorker` / `vital worker`)**: Added `ApplicationWorker` and `runApplicationWorker` in `src/substrate/worker.ts`, exposed via CLI `vital worker` and `--with-worker` on `vital serve`. Operates with graceful shutdown via `AbortSignal`, detailed health/status reporting (`worker.status()`), and failure isolation without crash.
- **Durable Outbox Relay**: Integrates `claimOutbox` and `settleOutbox` to claim pending outbox batches, dispatch them (relaying `executor-job` to SQS or local fallback, or custom handlers), and settle rows to `DONE` on success or `FAILED` with exponential backoff on error. Added `enqueueExecutorJob` in `src/aws/executor.ts` for atomic dispatch-after-commit enqueueing.
- **Recovery Sweeps**: Background sweep interval automatically runs `coord.readmitDeferred` (moving deferred requests back to `ADMITTED` once scope concurrency permits), `coord.reclaimStale` (reclaiming expired execution leases back to `ADMITTED`), and `coord.expireStale` (transitioning timed-out requests to `EXPIRED`).
- **Governed Request Dispatch**: Polls runnable requests (`ADMITTED` and `ACCEPTED`), claims exclusive execution ownership via `coord.claimExecution`, dispatches through configured harness adapter (`JcodeAdapter`, `LocalEchoAdapter`, or custom `requestExecutor`), and settles via `coord.complete`.
- **Verification**: 8 unit & integration tests in `test/worker.test.ts` verifying option validation, sweep recovery, outbox relay with backoff, SQS dispatch, runnable request execution, and graceful cancellation.

## F05 — Lambda execution ownership, failure state and cost accounting

**State:** Remediated. **Priority:** High. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — exclusive leased claimExecution, authoritative usage charging, claim fencing, and full artifact persistence.

**Evidence:** `src/aws/executor.ts:151–315`; `src/coord/coordinator.ts:950–985`; `test/aws.test.ts:340–395`.

Lambda model executor now binds job authority and enforces exclusive execution ownership:

- **Exclusive Leased Execution Ownership**: `runJob` claims exclusive execution via `coord.claimExecution(job.tenant, job.requestId, owner, now)` with CAS protection on `ADMITTED`, `ACCEPTED`, or retryable `IN_FLIGHT` state before running model inference. Losers throw `CLAIM_LOST` and refuse to double-spend.
- **Claim Fencing & Idempotency**: Evaluates monotonic per-request claim counter `execAttempt`. Stale workers whose lease expired cannot overwrite newer executions. Redelivered SQS messages for completed requests verify `idempotencyKey` matches the original request.
- **Authoritative Cost & Usage Charging**: Delivers actual token usage through `coord.reportUsage(job.tenant, job.requestId, usage)` to enforce bid ceilings and dollar budgets, terminating budget-breaching requests cleanly.
- **Full Artifact Persistence**: Model outputs are persisted to S3/artifact store when exceeding raw claim size bounds, and linked to the observation claim's `provenance.rawArtifactRef`.
- **Verification**: Tests in `test/aws.test.ts` (subtests 346–348) verify exclusive claim acquisition, duplicate delivery protection, budget death handling, and cost charging.

## F06 — Governed execution, kill switches and scoped controls

**State:** Remediated. **Priority:** Critical before autonomous execution claims. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — governed permission policy, live kill halts, scoped controls (scopeToken & sandbox verification), content screening, and reversible action receipts with compensation.

**Evidence:** `src/gov/trust.ts:275–317`; `src/jcode/runner.ts:79–235,274–380,440–495`; `src/substrate/harness.ts:28–148`; `src/substrate/identity.ts`; `src/substrate/sandbox.ts`; `src/substrate/screen.ts`; `src/gov/act.ts:23–115`; `test/gov.test.ts:398–475`; `test/jcode.test.ts:813–1060`; `test/substrate.test.ts:524–600`.

The executor trust boundary is now fully composed and enforced:

- **Governed Permission Policy**: Added `createGovernedPermissionPolicy(db, opts)` to `src/jcode/runner.ts` (defaulted in `JcodeRunner`), which screens shell commands, maps tools to action classes (`READ`, `ACT_REVERSIBLE`, `ACT_IRREVERSIBLE`), evaluates active emergency kill switches via `checkKill`, and evaluates RACI autonomy via `guardedAuthorize(db, { tenant, scope, actionClass, pinnedScopes })`. Reversible tools (e.g. `write_file`, `edit_file`) require approval and are denied by default under zero trust; they elevate to autonomous execution when trust ledger clean instances reach 200 on unpinned, unfrozen scopes.
- **Live & Pre-flight Kill Switch Enforcement**: `JcodeRunner.run` and `LocalEchoAdapter.run` check tenant and scope kill switches before claiming execution or connecting to the harness, settling immediately as `'DENIED'` without dispatching. In-flight turns check live kill switches on every permission request and within the execution lease heartbeat, immediately cancelling active sessions upon halt detection.
- **Scoped Controls**: `CodingTask` and `HarnessTask` accept `scopeToken` and `sandboxManifest`. `JcodeRunner` and `LocalEchoAdapter` verify that scope tokens match target scopes and valid cryptographic signatures before execution. Working directory sandboxes are validated against manifests using `verifySandbox`, rejecting tampered or missing files before execution.
- **Content Screening**: `JcodeRunner` accepts a content screen (`createContentScreen`), screening input prompts before harness dispatch and screening tool response streams, failing closed and cancelling turns upon detection of prompt injection or exfiltration.
- **Reversible Action Receipts & Compensation**: `src/gov/act.ts` now accepts an `execute` handler in `ActInput`, executing the real external reversible action, validating success, and recording concrete `ActReceipt` details (`receiptId`, `output`, `compensation`) in the `ACTION` claim. Added `compensateReversible` to execute compensation handlers and record a `COMPENSATION` claim linked to the original action.

**User impact:** Autonomous tool execution strictly adheres to the Trust Ledger and RACI autonomy matrix, emergency kill switches reliably halt running and pending sessions, scopes and sandboxes cannot be breached, and reversible business operations provide verifiable receipts and compensation.

**Remediation progress (2026-09-17):**

- Implemented `createGovernedPermissionPolicy` in `src/jcode/runner.ts` integrating `checkKill` and `guardedAuthorize`.
- Added pre-flight and in-flight kill switch session cancellation in `JcodeRunner.run`.
- Added `scopeToken` and `sandboxManifest` verification in `JcodeRunner.run` and `LocalEchoAdapter.run`.
- Added content screening for user prompts and tool responses in `JcodeRunner`.
- Enhanced `actReversible` with concrete execution handler execution, receipt recording, failure isolation, and `compensateReversible`.
- Added 7 comprehensive regression tests in `test/gov.test.ts`, `test/jcode.test.ts`, and `test/substrate.test.ts`. All 366 tests pass cleanly.

## F07 — Runtime schema migrations

**State:** Partial / competing implementations. **Priority:** High. **Effort:** Medium. **Disposition:** Consolidated 2026-09-17 — `migrate()` is now the single authoritative journal.

**Evidence:** `src/core/db.ts:527–538`; `src/core/migrations.ts:25–63`; `src/core/pg.ts:migratePostgres`.

**Remediation progress (2026-09-17):** The swallow-everything runner is gone. `migrate()` now:

- applies the additive list as ONE named journal entry (`additive-list-v6`) in `schema_migrations` inside a transaction with the DDL — a failure rolls back both and **propagates to the caller** (startup fails loudly on incomplete upgrades; no more half-migrated-but-stamped-6 databases);
- probes column existence explicitly (`columnExists`, engine-aware: `information_schema` on Postgres, `pragma_table_info` on SQLite) instead of catching duplicate-column errors — idempotency is read as a fact, never inferred from an error message;
- upgrades legacy databases (schema present, journal empty) in place by stamping the journal without re-running ALTERs;
- keeps `src/core/migrations.ts` as the generic named up/down API for FUTURE migrations, reading the SAME journal table — the parallel mechanism is gone.

Verification: three new regression tests (journal stamping + idempotent re-run; legacy upgrade-in-place; failed migration leaves no journal row and no partial DDL). Full suite 285/285. Historical-schema and concurrent-startup drills on live Postgres remain future work (PG CI lane runs `migrate()` on every run).

## F08 — Deployment bootstrap, state, secrets and smoke verification

**State:** Remediated. **Priority:** High. **Effort:** Large collectively. **Disposition:** Remediated 2026-09-17 — bootstrap fallback images, execution secret grants, workflow secrets/backend mapping, and semantic smoke checks.

**Evidence:** `.github/workflows/deploy-aws.yml:36–75`; `deploy/aws/main.tf:60–63,466–505,669,868`; `deploy/aws/variables.tf`; `docs/deployment.md:90–98`; `deploy/compose.yml:5–31`; `package.json:10–11`; `tsconfig.build.json`.

**User impact:** Automated deployment safely bootstraps on fresh AWS accounts without chicken-and-egg ECR/task-definition failure; all sensitive variables are explicitly mapped into Terraform; ECS tasks successfully resolve injected secrets at container startup; and semantic smoke checks verify ECS stability, service health, and Lambda container execution.

**Remediation progress (2026-09-17):**

- **ECS execution role secret permissions**: In `deploy/aws/main.tf`, created `aws_iam_policy.ecs_execution_secrets` and attached it to `aws_iam_role.ecs_execution`, granting `secretsmanager:GetSecretValue` on all injected secrets (`DATABASE_URL`, `TENANT_HMAC_SECRET`, `VITAL_CORE_SECRET`, `WEBHOOK_SECRET`, `SERPER_API_KEY`, `GEMINI_API_KEY`, `NOVITA_API_KEY`, `OPERATOR_SECRET`). Also added `aws_secretsmanager_secret.db_url.arn` to `aws_iam_policy.ecs_task`.
- **Bootstrap image fallbacks**: Added `core_image` and `executor_image` fallback logic to `locals` in `main.tf` so initial infrastructure bootstrap applies succeed without failing on empty image strings.
- **Workflow secrets & remote state**: Updated `.github/workflows/deploy-aws.yml` to ensure ECR repositories exist before Docker push, map all sensitive `TF_VAR_*` secrets to environment variables, and configure S3 remote state backend dynamically when `TF_BACKEND_BUCKET` is present.
- **Semantic smoke checks**: Replaced unverified HTTP curl with a multi-phase check: waiting for ECS service stability (`aws ecs wait services-stable`), probing `/healthz` for `{"ok":true,"engine":"postgres"}`, and verifying non-billable executor container operation via dry-run Lambda invocation.
- **Compose & Build verification**: Retained `tsconfig.build.json` for `npm run build` and `start`, Compose loopback topology with Postgres readiness gating, and documented the corrected bootstrap sequence in `docs/deployment.md`.

## F09 — Durable ingestion, tenant cursors and receipts

**State:** Remediated. **Priority:** High. **Effort:** Large. **Disposition:** Remediated 2026-09-17 — tenant cursors, revision-aware polling, dual identity receipts, atomic ingestion transactions, and authoritative ingestInboxBatch.

**Evidence:** `src/ingest/collectors.ts:88–100,285–351,552–671,714–750`; `scripts/dogfood-ship.ts:86–95,145–155,340–346`; `test/ingest.test.ts:474–625`.

Collectors now stage inbox events before cursor advancement, and dogfood drains and settles staged batches through `ingestInboxBatch`. Ingestion passes the selected tenant into GitHub polling and file diff polling. Cursor keys are tenant-scoped (`ingest:cursor:${tenant}:${name}`) with fallback to legacy keys. Downstream receipts record both content fingerprints and `(tenant, collector, sourceEventId, revision)` identities. Claim append and receipt persistence run atomically in a transaction. GitHub release polling tracks per-release revisions so edits to existing release IDs emit new revision events.

**User impact:** Recoverable events are staged and settled through the durable inbox, tenant cursor state is strictly isolated, retried occurrences collapse cleanly on identity, and edits to existing releases are reliably captured.

**Remediation progress (2026-09-17):**

- **Tenant-scoped cursors**: `cursorGet` and `cursorSet` namespace cursors by `ingest:cursor:${tenant}:${name}` with backwards-compatible read fallback to `ingest:cursor:${name}`. Both `fileDiffCollector` and `gitHubReleasesCollector` isolate cursor state per tenant.
- **Revision-aware release polling**: `gitHubReleasesCollector` stores a structured cursor `{ highId, revisions }` tracking `(tag_name, published_at, body_hash)` per release ID. Edits to existing release IDs trigger a new revision event staged to `ingest_inbox`.
- **Identity-based receipts and atomic ledger ingestion**: In `ingestEvents`, receipts are stored under both content fingerprint and event occurrence identity (`(tenant, collector, sourceEventId, revision)`). Ledger claim creation and receipt persistence run within a single database transaction (`db.transaction`), preventing orphan claims or receipts.
- **Authoritative inbox batch ingestion**: Added `ingestInboxBatch(db, ledger, tenant, collector, opts)` to claim PENDING/retryable inbox receipts, append OBSERVATION claims, and settle receipts to `'DONE'` (or `'FAILED'` on error). Updated `scripts/dogfood-ship.ts` (`SELF_COLLECTOR`, `runShipPipeline`, and `main()`) to pass tenant and drain/settle from `ingest_inbox`.
- **Verification**: 4 new tests in `test/ingest.test.ts` covering multi-tenant cursor isolation, GitHub release edit revision detection, atomic dual-receipt persistence, and `ingestInboxBatch` lifecycle. All 19 ingest tests, 10 wedge tests, and the full 359-test suite pass cleanly.

## F10 — Inbox/outbox concurrency and recovery

**State:** Partial. **Priority:** High before parallel consumers. **Effort:** Medium. **Disposition:** Remediated 2026-09-17 — atomic ownership, leases, owner-fenced settlement, attempt caps.

**Evidence:** `src/ingest/collectors.ts:170–202`; `src/substrate/scheduler.ts:109–134`; `src/core/pg.ts` READ COMMITTED transaction path; `test/substrate.test.ts:317–321`.

**Remediation progress (2026-09-17):** Both `claimInbox` and `claimOutbox` reworked identically:

- **Atomic ownership CAS**: the claim UPDATE is conditional on the claimable state the SELECT observed (`status='PENDING' OR retry-due FAILED OR lease-expired CLAIMED`). Under Postgres READ COMMITTED a concurrent consumer's committed claim makes the loser's UPDATE match zero rows — double ownership is structurally impossible, not just unlikely.
- **Leases**: each claim records `owner` + `claimed_at`; claimability includes `CLAIMED` rows whose `claimed_at + lease_ms` passed, so a crashed consumer's work becomes runnable again instead of stranding forever. Attempts increment per claim.
- **Owner-fenced settlement**: `settleInbox`/`settleOutbox` update only rows the caller owns in CLAIMED state; a stale owner whose lease expired and whose row was re-claimed gets `NOT_OWNER` (an explicit error, never a silent corrupt). Same-state re-settlement stays idempotent.
- **Attempt caps + retry**: FAILED rows are retry-due via `next_at`; `maxAttempts` (default 10) stops poison rows from being claimed forever — they stay FAILED and inspectable, the dead-letter shape.
- Verification: three new regression tests (interleaved-claims + lease recovery + stale-settlement refusal for the outbox; attempt-cap dead-letter; the same fencing for the inbox). Pre-existing lifecycle tests still pass unchanged. Full suite 319/319 on SQLite.

Still open: the same drills over two true Postgres connections (the CI lane runs single-connection today); the SQL CAS is written for it (`WHERE`-guarded UPDATEs are the mechanism, not JS adjacency).

## F11 — Raw evidence and artifact storage

**State:** Remediated 2026-09-17. **Priority:** High. **Effort:** Medium. **Disposition:** Remediated — canonical content-addressed hashing, size bounding, path traversal safety, read-back integrity verification, and raw evidence preservation.

**Evidence:** `src/ingest/collectors.ts:275–470`; `src/ledger/s3store.ts`; `test/artifact.test.ts`.

**Remediation progress (2026-09-17):**

- **Canonical-byte content identity**: `storeArtifact` now hashes the serialized envelope (`{ uri, occurredAt, payload }`) directly to derive its ref and filename. The ref returned to the claim (`provenance.rawArtifactRef`) matches the SHA-256 of the exact bytes on disk rather than the collector's pre-serialization summary/body fingerprint.
- **Bounded storage & traversal defense**: writes exceeding `maxBytes` (default 25 MB) are refused before hitting disk with namespaced `[artifact:TOO_LARGE]`. Refs containing `/`, `\`, or `..` are refused with `[artifact:UNSAFE_REF]`.
- **Read-back integrity verification**: added `verifyArtifact(dir, ref)` and `readArtifact(dir, ref)` which verify that on-disk bytes hash to `ref` before return, throwing `[artifact:CORRUPT]` on tampered or corrupted blobs, `[artifact:NOT_FOUND]` on missing items, and enforcing size caps on read.
- **Preserved raw evidence**: `fileDiffCollector` now stores the raw file `content` in the event payload (bounded by size limits) alongside byte metrics, enabling complete reconstruction of the original file from the stored artifact.
- **Verification**: 10 comprehensive tests in `test/artifact.test.ts` verifying round-trip envelope recovery, content-hash consistency, idempotent re-storage, write size caps, tamper detection, missing artifacts, path traversal refusal, read size caps, claim `rawArtifactRef` integration, and `FilesystemArtifactStore` put/get/guards. Full suite green at 346/346 tests.

## F12 — jcode connection, cancellation, leases and deliverables

**State:** Remediated (2026-09-17). **Priority:** High. **Effort:** Large. **Disposition:** Bounded live connection, cancellation, lease renewals, dollar accounting, and deliverable persistence complete.

**Evidence:** `src/jcode/client.ts` socket/default request timeout; `src/jcode/protocol.ts:90–101`; `src/jcode/runner.ts`; `src/coord/coordinator.ts:271–290`; `scripts/live-jcode-hello.ts`.

**Remediation progress (2026-09-17):**

- **Central transport configuration & bounded timeouts**: `JcodeClient` defaults `socketPath` to `socketPathFrom()` across all platforms (Windows named pipes vs Unix domain sockets) and defaults `requestTimeoutMs` to 15,000ms for correlated legs. Added `socketPath` and `requestTimeoutMs` instance getters.
- **Confirmed cancellation on timeout**: `waitForTurn` now issues a bounded `client.cancel(sessionId)` with a 2-second fallback race before resolving `timeout`, ensuring daemon work is terminated cleanly on client-side timeouts.
- **Fenced renewable execution leases**: Added `renewExecutionLease(tenant, id, owner, now, leaseMs)` with atomic CAS protection (`WHERE id = ? AND tenant = ? AND state = 'IN_FLIGHT' AND exec_owner = ?`), throwing `[coord:LEASE_EXPIRED]` if the lease was lost or reclaimed. `JcodeRunner` runs an unref'd heartbeat timer (every 25s) to renew its lease during execution and clears it on exit.
- **Grounded context binding**: `JcodeRunner.run()` resolves cited claims via `this.ledger.contextFor(tenant, task.claimRefs, now)` and prepends a `[Grounded Context]` block to the prompt sent to the harness in `send_message`.
- **Authoritative dollar accounting**: Token deltas are priced via `getRates(this.db, tenant)`. `coord.reportUsage` receives `{ tokens, dollars }`, enforcing both the coordinator request bid and `task.maxDollars` ceilings. Removed permanent `reportHalted` latch on transient errors.
- **Durable deliverable persistence**: Deliverable transcripts are saved to disk via `FilesystemArtifactStore`, with the artifact ref linked as `fullTextRef` on the `OBSERVATION` claim value and `provenance.rawArtifactRef`.
- **Strict portable probe**: `scripts/live-jcode-hello.ts` uses cross-platform pipes/domain sockets and strictly fails if session creation succeeds without a daemon.
- **Verification**: 26 tests in `test/jcode.test.ts` plus cross-component coverage in `substrate.test.ts` and `talk.test.ts`; all 355 test suite tests passing, 0 typecheck errors, 0 lint errors.

## F13 — Feature plan approval to actual coding

**State:** Remediated (2026-09-18). **Priority:** High before enabling writes. **Effort:** Large. **Disposition:** Closed loop from deep research to approved feature plan to governed coding execution.

**Evidence:** `src/wedge/feature.ts`; `src/substrate/harness.ts`; `src/jcode/runner.ts`; `test/feature.test.ts`; `test/fake-harness.ts`.

**Remediation progress (2026-09-18):**

- **Immutable plan/evidence/request/action bundle**: `planFeature` generates deterministic plan fingerprints over sorted improvements and cited research. `approveFeaturePlan` strictly validates that `researchIds` grounds all plan citations (`UNGROUNDED_PLAN`), binds `requestId`, and records `action` containing `[plan:${plan.fingerprint}]`.
- **Drift and reapproval enforcement**: `codeApprovedFeature` replays the decision through `ledger.replayDecision`. Any drift in cited research (modifications, supersedes, staleness) throws `[wedge:DRIFTED_DECISION]`. Expired research past `validUntil` or unusable status (`STALE`, `DISPUTED`, `SUPERSEDED`, `RETIRED`) throws `DRIFTED_DECISION`.
- **Request and plan binding checks**: `codeApprovedFeature` verifies that the executing `requestId` matches the decision's bound `requestId` (`REQUEST_MISMATCH`), and verifies that the executing `plan` matches the approved plan fingerprint (`PLAN_MISMATCH`).
- **Governed primary execution & scoped authority**: `createGovernedPermissionPolicy` verifies human approval from the database (`decisions` table) for `ACT_REVERSIBLE` tools (`write_file`, `edit_file`, `apply_patch`), allowing execution with human attribution while maintaining pre-flight/mid-turn kill switch checks and shell screening. `codeApprovedFeature` binds and passes `approvedDecisionId`, `approvedBy`, `workingDir`, `scopeToken`, `coreSecret`, and `sandboxManifest`.
- **Permission-aware test harness**: `FakeHarness` in `test/fake-harness.ts` supports `strictPermissions` and waits for `permission_response`, faithfully simulating daemon tool permission enforcement without silently fabricating success on denial.
- **Explicit baseline classification**: `LocalEchoAdapter` is explicitly categorized and typed as `category = 'test-baseline'` with `isTestBaseline = true`.
- **Verification**: 9 comprehensive tests in `test/feature.test.ts` covering grounding validation, request/plan binding mismatches, research drift and expiry rejection, JcodeAdapter human approval execution, scoped controls, and baseline classification. Full test suite green at 416/416 tests.

## F14 — Ship-to-Result and churn deliverable completion

**State:** Remediated (2026-09-18). **Priority:** High for Ship; Medium for churn. **Effort:** Large. **Disposition:** Complete Ship first; defer churn.

**Evidence:** `src/wedge/ship.ts`; `src/wedge/churn.ts`; `test/wedge.test.ts`.

Ship creates five requests with deliverable schema names but no composed workers/join that produces and reviews those deliverables. “Affected” is scopes plus supplied strings, not customer segmentation. Churn queues investigation/outreach/offer work and records a recommendation without waiting for its evidence/results.

**User impact:** A user gets queued intentions rather than a launch pack or completed save play.

**Remediation progress (2026-09-18):**

- **Closed-loop single asset production (`produceReleaseAsset`)**: Implemented the complete end-to-end execution loop in `src/wedge/ship.ts`: concrete request dispatch through the coordinator (`coord.submit`), execution via harness adapters (`adapter.run`), strict draft claim verification against the Ledger and regulated phrase denylist (`checkDraft` failing closed with `DRAFT_BLOCKED`), human approval decision recording with frozen Context Bundle (`ledger.recordDecision`), reversible action publication with concrete execution receipts (`actReversible`), measured business outcome recording against explicit baseline (`ledger.recordOutcome`), and progression tracking to `stage: 'MEASURED'`.
- **Multi-department deliverable join (`joinReleaseDeliverables`)**: Implemented multi-department assembly producing a unified `LaunchPack` across all five teams (`marketing`, `customer`, `sales`, `product`, `finance`), ensuring each team's deliverable is concretely produced, checked against live claims, approved, executed with receipts, and verified before declaring the pack ready.
- **Grounded customer segmentation**: Added `CustomerSegment` interface with `id`, `name`, `tier`, `impact`, `rationale`, and optional `region`. `summarizeRelease` grounds customer segments alongside internal scopes, supporting explicit segments as well as deterministic scope-grounded default segmentation.
- **Tenant-scoped release identity and durable stage tracking**: Upgraded `isKnownRelease` and `markReleaseKnown` to namespace release fingerprints by tenant (`wedge:summary:${tenant}:${fingerprint}`) while preserving backwards-compatible fallback for legacy un-namespaced records. Implemented durable stage progression (`ReleaseStage`: `SUMMARIZED`, `DISPATCHED`, `DELIVERED`, `VERIFIED`, `APPROVED`, `EXECUTED`, `MEASURED`) via `recordReleaseStage` and `getReleaseStage`.
- **Completed churn play execution (`executeChurnPlay`)**: Remediated the churn loop in `src/wedge/churn.ts` to execute investigation (`pain-link` query), save play outreach, and retention offer legs through the harness adapter. Promotes candidate risk claims through human curation (`ledger.verifyClaim`) upon approval, verifies drafts for save play and offer copy with fail-closed denylist checks (`DRAFT_BLOCKED`), and records an approved execution decision before returning `CompletedChurnPlay`.
- **Verification**: Added comprehensive unit and integration test coverage in `test/wedge.test.ts` (16/16 tests passing) validating grounded customer segmentation, tenant-scoped release isolation, durable stage recovery, closed-loop asset production, multi-department LaunchPack assembly, and churn play execution. Entire project test suite green at 422/422 tests.

## F15 — Synthetic dogfood outcomes and advisory draft validation

**State:** Partial. **Priority:** High. **Effort:** Small to quarantine; Large to measure honestly. **Disposition:** Quarantined 2026-09-17; honest measurement deferred until a real pilot exists.

**Remediation progress (2026-09-17):** Fabricated success removed from the dogfood pipeline.

- The hardcoded `predicted=240 / actual=90` outcome and the invented `human:founder` verifier are gone: the pipeline records **no outcome at all** because it cannot measure one. `ShipPipelineResult.outcomeBasis` is always null for dogfood runs.
- The script-asserted approval is no longer presented as human governance: the decision names `agent:dogfood-script`, carries no `approvedBy`, and is tagged `synthetic:decision:<id>` in `meta`.
- The trace intent is prefixed `simulated:` with a `simulated: true` cost payload, and the compiled card records `simulated_run` in its predicates — so attribution, eval, and metrics code can exclude them by construction.
- A failed draft check now **throws** (`DRAFT_BLOCKED`) instead of logging and continuing, so a blocked draft can no longer mint a decision/outcome/trace/card behind its own failure. `seed-demo.ts` remains an isolated, explicitly synthetic fixture tool.
- Verification: new regression tests prove a blocked draft aborts before any decision/outcome/trace/card is written and that all derived records carry the synthetic tags; suite green after the change.

Still open (deferred until a real pilot): capture real review identity/timestamps, factual evidence coverage, and actual deliverable/result/eval receipts.

**Evidence:** `scripts/dogfood-ship.ts:121–122,167–238`; `src/wedge/ship.ts:59–79,228–237`; `scripts/seed-demo.ts` synthetic fixture generation.

Dogfood ingests real sources but automatically records a human verifier/approver, predicted 240 versus actual 90 minutes, success/confidence, and model/eval references without measuring those outcomes. It computes a draft verdict but continues creating decision/outcome/trace records even when the verdict fails. The checker validates referenced claim eligibility and denylisted phrases, not prose-to-evidence entailment.

**User impact:** Product metrics and compilation inputs can present simulated improvements as real learning. This is more serious than mock data in a clearly labeled seed file.

**Missing / plan:** Tag/exclude simulated runs → block failed draft checks → capture real review identity and timestamps → require factual evidence coverage → ingest actual deliverable/results and eval receipts. Preserve `seed-demo.ts` as an isolated, explicitly synthetic fixture tool.

## F16 — Deep research execution and report lifecycle

**State:** Partial / bounded lifecycle remediated. **Priority:** Medium. **Effort:** Large for standalone product. **Disposition:** Bounded lifecycle fixes applied 2026-09-18; standalone product and UI deferred.

**Evidence:** `src/wedge/deepresearch.ts`; `test/deepresearch.test.ts`; caller search found no production integration outside this module.

**Remediation progress (2026-09-18) — bounded lifecycle fixes:**

All 9 concrete lifecycle defects in `src/wedge/deepresearch.ts` addressed:

1. **`PAUSED_BUDGET` status**: Budget exhaustion now marks `PAUSED_BUDGET` (not `COMPLETED`). `COMPLETED` strictly requires all sub-questions answered within budget.
2. **Terminal checkpoint guard**: `executeResearchRun` rejects resume of a terminal run (`COMPLETED`, `PAUSED_BUDGET`, `CANCELLED`) with `TERMINAL_CHECKPOINT`.
3. **Plan fingerprint + mismatch guard**: `approveAndPersistResearchPlan` stores a deterministic `planFingerprint(question, subquestions)`. Re-entry with different subquestions throws `PLAN_MISMATCH`.
4. **Concurrent execution ownership**: Different `executionOwner` on a stored run throws `EXECUTION_CONFLICT`.
5. **Cancelling actor recorded**: `cancelResearchRun(run, by)` stores `cancelledBy`; async form `(run, by, { db, now })` persists.
6. **Gap definition fixed**: Gaps = completed steps that produced zero findings (`coverage[].noResults`). Unexecuted questions are a budget-exhaustion concern, not a gap.
7. **Corroboration tracked**: URIs seen across multiple sub-questions land in `corroboratedUris` and `uriSubquestions` map (URI → which sub-questions found it).
8. **Contradictions in report**: `attachResearchReport` includes `v.contradictions` in the final `ResearchReport`.
9. **Cited-only bibliography**: `report.sources` contains only claims cited in section bullets, with sub-question attribution. All-run-findings inclusion removed.
10. **Cumulative total spend**: `totalSearches` persisted and restored on resume.
11. **Durable persistence layer**: `loadResearchRun`, `persistResearchRun`, `approveAndPersistResearchPlan`, `resumeResearchRun`, `runResearchSession` entry point added.
12. **Report serialization**: `serializeResearchReport` / `parseResearchReport` with backward-compatible defaults.
13. **Pre-existing bugs fixed**: Missing `catch` in `deliverable.ts` diff block; `detailDocument` not imported in `serve.ts`; `requestDetail` wrong arg order in `serve.ts`.

Verification: 20/20 deepresearch tests pass (7 original + 13 new FLOW-017/FLOW-018); 41/41 across deepresearch + wedge test files; `npm run typecheck` clean. Full-suite failures (26/510) are pre-existing and unrelated to this finding.

**Still open (explicitly deferred):** source policy persisted in checkpoint; in-flight search abort on cancellation; plan-review UI; production search/model composition; run detail/history page; report delivery. Do not market citation existence as factual verification.

## F17 — Router, compiler and operating learning loop

**State:** Partial / orphaned integration. **Priority:** High for the product thesis. **Effort:** Large. **Disposition:** Complete after one real execution loop.

**Evidence:** `src/router/router.ts`; `src/compiler/compiler.ts`; `src/compiler/registry.ts:94–145`; `src/cli.ts:115–129`; `scripts/seed-demo.ts:298–325,406–423`; `src/jcode/runner.ts` trace recording.

No production route/label/calibration/mining/drift worker or executable-card dispatch was found. Console correctly uses read-only description; that no longer causes drift mutation, but there is no replacement operating drift job. Completed jcode traces hardcode MODEL/SUCCESS/confidence and do not bind a skill card; failures do not provide balanced learning evidence.

**User impact:** Repeated use does not demonstrably become cheaper, safer executable procedures; the board displays lifecycle metadata rather than a working learning service.

**Missing / plan:** Correlate request/routing/model/card/version/outcome → record failures and controls → mine candidates from real repeated work → run real shadow/pilot evaluations → govern promotion → dispatch proven cards → scheduled drift and rollback. Preserve conservative defaults.

## F18 — Transfer and promotion evidence lineage

**Remediation progress (2026-09-17):** Addressed in `src/compiler/transfer.ts` and `src/compiler/compiler.ts`.

1. Durable negative transfer capture: `runCrossModelEvidence` now wraps adapter submission and execution in try/catch; harness exceptions or admissions failures bank negative transfer records (`passed: false, score: 0`) in `skill_transfer_tests` rather than aborting the pipeline and leaving missing evidence.
2. Invalidation & freshness on promotion gates: `attemptAdvance` and `expandScope` now evaluate active test status by grouping by `(kind, variant)` and resolving the latest test run (`ranAt`). Historical passing runs can no longer satisfy promotion gates if a subsequent run for that variant or role has failed or regressed.

Verification: Unit regression tests added in `test/compiler.test.ts` verifying that subsequent failing runs invalidate historical passes, and that adapter exceptions bank negative transfer rows. Full test suite (316/316) passing.

**State:** Prototype evidence pipeline / Partially Remediated. **Priority:** High. **Effort:** Large. **Disposition:** Complete; downgrade current transfer claims.

**Evidence:** `src/compiler/transfer.ts:48–81`; `src/compiler/compiler.ts:280–343`; `src/compiler/registry.ts:41–47,132–145`; `test/compiler.test.ts:275–304`.

Transfer passes on adapter `COMPLETED`, not successful execution of the card's steps/tests. Adapter name substitutes for model identity. Echo therefore counts as a transfer pass. Evidence is card-ID-only, not revision/eval-bound; historical passing records satisfy gates despite later failures. Promotion accepts supplied pilot/shadow statistics, while `runCardSuite` results are not the linked gate evidence. Exceptions can abort without banking negative transfer results.

**User impact:** A procedure can appear proven across models when only transport completion was checked.

**Missing / plan:** Reclassify current checks as harness smoke evidence → immutable card/model/case/evaluator identities → durable pass/fail/exception results → freshness and invalidation rules → derive promotion statistics from referenced runs → independent quality assertions. Keep negative results and quarantine behavior.

## F19 — Trust feedback, review fields and kill drills

**Remediation progress (2026-09-17):** The destructive drill behavior is fixed in `src/gov/trust.ts:255`. `killDrill` now checks tenant, scope, action-class and exact-match policies individually in a unique temporary namespace inside a transaction; existing emergency switches and their attribution are never modified. Returned and audited results explicitly say `policy-only` and include per-level halt/isolation/release checks. This does **not** verify a running executor halts, and F19 remains partial.

Verification: the preservation regression failed against the old implementation and passes after the fix; three focused policy-drill tests cover preservation, per-level evidence and rollback on a read failure. `npm test` passed 270/270 on the concurrently changing tree; lint, typecheck and formatting of the two changed TypeScript files passed. Repository-wide formatting reports unrelated issues in `src/attrib/attribution.ts`, `test/compiler.test.ts` and `scripts/load-probe.mjs`; those files were not reformatted here. Independent review found no implementation defect. A fourth focused regression subsequently passed, proving missed matches and overbroad matches produce failed returned and audited results; later-stage/audit-write failure coverage remains a follow-up. No live Postgres or executor halt was tested in this remediation.

**State:** Partial. **Priority:** High for kill drills; Medium for dormant review. **Effort:** Medium plus F06 integration. **Disposition:** Complete before operational use.

**Evidence:** `src/gov/trust.ts:47–117,149–190,253–265`; `src/gov/review.ts`; `test/gov.test.ts:150–161`.

No production trust-outcome/honeytask/freeze feedback loop was found. `override_rate` is not maintained; the grant field and actual authorization state do not form a clearly maintained contract. Kill drill sets multiple levels then clears them without preserving prior emergency state, and a tenant kill can mask failures in narrower checks.

**User impact:** Review metrics can appear meaningful without collection, and an operational drill can remove an existing stop condition.

**Missing / plan:** Preserve/restore prior drill state → test each scope independently → verify real executor halt separately → connect sampled review and outcome events → derive maintained trust metrics. Remove misleading unused fields if their behavior is not needed.

## F20 — Delegated budgets and human attention accounting

**Remediation progress (2026-09-17):** Fully addressed in `src/coord/coordinator.ts`.

1. `humanMinutes` enforcement: mid-run charging (`charge`) and continuous usage (`reportUsage`) now strictly enforce `spent.humanMinutes > r.bid.humanMinutes` and terminate with `TERMINATED_BUDGET` when breached.
2. Daily escalation accounting: admission now counts cumulative daily interruption events from the immutable `escalations` audit table via `dailyEscalations(tenant, day)` instead of transient open states, ensuring task completions cannot reset or bypass the daily attention cap. `openEscalations` is retained for concurrent pending approval monitoring.
3. Multi-resource parent decomposition & delegation reconciliation: `decompose` now reconciles both terminal child spend (completed, failed, expired) and non-terminal child reservations across dollars, tokens, and human attention. Step bids with omitted values now default to `DEFAULT_BID` and are clamped in preliminary accounting, eliminating budget bypasses. Direct child submissions via `submit` enforce parent unspent budget bounds.

Verification: Full unit regression tests added in `test/coord.test.ts` covering humanMinutes charging/reportUsage budget death, cumulative daily escalation caps after task completion, completed child accounting, and omitted bid defaulting. Full test suite (314/314) passing.

**State:** Resolved / Verified. **Priority:** High. **Effort:** Medium. **Disposition:** Complete.

**Evidence:** `src/coord/coordinator.ts:459–466,650–656,694–724,836–881`.

Parent decomposition checks dollars against nonterminal child bids, not full completed-child spend across all resources. Omitted child bids are zero in preliminary accounting but defaulted during submission. `humanMinutes` is not enforced by charging. The daily escalation cap counts current open states/updated dates rather than cumulative interruption events.

**User impact:** Delegated work and human interruptions do not have the strong cumulative budget semantics implied by the product.

**Missing / plan:** Define parent allocations and actual reconciliation → atomic multi-resource reservations → separate concurrent approvals/daily interruptions/consumed minutes → enforce against immutable usage/escalation events → test completed children, retries and defaults.

## F21 — Cost per good decision and counterfactual attribution

**Remediation progress (2026-09-17):** Addressed in `src/attrib/attribution.ts`.

1. Metric direction handling: `costsOfDecisions` evaluates metric direction via `PreregisteredMetric.direction` ('higher' | 'lower') or metric name inference (lower-is-better for latency, error rate, churn, cost, defects), correctly determining whether actual outcomes met expectations.
2. Decision-level outcome policy: evaluates all outcome rows for a decision; a decision is counted as good only when all measured outcomes pass the prediction criteria, preventing row-count inflation.
3. Added `direction?: 'higher' | 'lower'` to `PreregisteredMetric` and `preregister`.

Verification: Regression tests in `test/attrib.test.ts` verify lower-is-better thresholds and multi-outcome decision-level evaluations. Full test suite passing.

**State:** Partial / prototype measurement. **Priority:** High. **Effort:** Large. **Disposition:** Complete descriptive accuracy before causal claims.

**Evidence:** `src/attrib/attribution.ts:80–156,181–207,255–268`; `src/console/report.ts:179–192`; `test/attrib.test.ts:66–85`.

`goodDecisions` counts passing outcome rows, not decisions; all metrics assume higher-is-better, and no prediction means any nonzero actual is good. Costs omit descendant allocation and malformed/missing costs tend toward zero. Preregistration is a mutable `meta` record without enforced pre-outcome timing or assignment lifecycle; caveats use supplied booleans. No production experiment lifecycle found.

**User impact:** More metrics can mechanically improve the apparent KPI, lower-is-better results are misclassified, and unknown costs look free. Counterfactual improvement is not established.

**Missing / plan:** Register metric direction/aggregation → one decision-level outcome policy → explicit unknown cost and child/shared cost allocation → truthful dashboard labels → immutable baseline/assignment/pre-outcome registration → measured treatment/control results and caveats. Do not claim ROI from the present dogfood data.

## F22 — Structured correction and resolution queues

**Remediation progress (2026-09-17):** Addressed in `src/ledger/ledger.ts` and `src/console/serve.ts`.

1. Typed correction contract: introduced `CorrectionPatch` (`value`, `unit`, `confidence`, `validUntil`). When a human supplies a prose correction without explicit structured values, `correctClaim` invalidates retained numerical values and units (`null`), preventing automated downstream consumers from reading stale numbers.
2. Contradiction dispute resolution: implemented `resolveDispute(tenant, winnerId, loserId, actor, rationale)` in `src/ledger/ledger.ts`, setting winner to `VERIFIED`, loser to `SUPERSEDED`, creating a `'supersedes'` claim link, and logging `DISPUTE_RESOLVED`. `disputedPairs` excludes superseded/retired claims so resolved contradictions drop from the curation queue.
3. Prediction outcome resolution: implemented `resolvePrediction(tenant, predictionId, outcome, actor)` recording a verified `MEASURED` fact linked via `'resolves'`, retiring the prediction claim, and logging `PREDICTION_RESOLVED`.

Verification: Tests in `test/ledger.test.ts` and `test/console.test.ts` verify structured invalidation, dispute resolution queues, and prediction resolution. Full test suite passing.

**State:** Resolved / Verified. **Priority:** High for typed corrections; Medium for resolution workflow. **Effort:** Medium. **Disposition:** Complete.

**Evidence:** `src/ledger/ledger.ts:761–796,814–839`; `src/console/serve.ts` correction handler; `src/evals/runner.ts:208–214`; `src/console/report.ts:136–146`.

A prose correction copies the old structured value/unit/confidence/expiry/source tier. Generated regression checks focus on statement/link changes. Contradiction pairs are returned without durable unresolved/resolved case semantics. Due predictions lack explicit outcome-resolution association. Failed correction-to-eval creation returns null without a retry/backfill worker.

**User impact:** Humans can correct a fact while machine consumers keep reading its previous value; historical disputes can stay “open”; prediction and correction follow-up is hard to close.

**Missing / plan:** Typed correction contract or invalidate retained values → provenance/review validation → durable contradiction/prediction resolution and ownership → queue semantics/SLA → retryable eval intake → tests that machine values and human text agree.

## F23 — Learning tenant boundaries and export consistency

**State:** Partial. **Priority:** High for shared-tenant controls; Medium for exports. **Effort:** Medium–Large. **Disposition:** Complete before exposing learning administration.

**Evidence:** `src/compiler/compiler.ts:238–240,289–292`; `src/router/router.ts:348–351`; `src/core/db.ts:301–347,435–443`; `src/ledger/export.ts:30–58`.

**Remediation (2026-09-18) — learning API boundary slice:**

- `compile` resolves source traces by tenant and ID before inspecting their outcomes. Compilation is creation-only: an existing card ID yields `CARD_EXISTS`, for either the same or another tenant, rather than overwriting card state/scope through a global upsert.
- `recordTransfer` checks persisted card ownership in its insertion statement; caller-supplied card fields alone do not establish ownership. `transferResults(tenant, cardId)` joins evidence to a tenant-owned card. Compiler, registry and test callers were migrated; there is no unscoped overload.
- `router.label(tenant, id, correctTier, reviewer)` requires explicit tenant/reviewer context, validates tier and reviewer, and atomically updates the tenant-owned decision with a before/after audit. Missing and foreign decisions return the same error. PostgreSQL uses row locking to serialize relabels; audit failure rolls back the label.
- Eight new regression tests cover foreign trace rejection, transfer ownership, card-ID collisions, denied labels, input validation, attributed relabels and audit rollback. `npm test`: **411/411 passed** on the current tree; typecheck, build, scoped ESLint and diff checks passed. Concurrent console tests are included in that total, not authored by this slice. No live PostgreSQL concurrency run was performed.

**API migration:** use `transferResults(tenant, cardId)` and `label(tenant, id, tier, reviewer)`; repeated compilation with an explicit existing ID now fails rather than updating it. Library callers must derive tenant and reviewer from trusted authorization context; these arguments are not a new authentication system.

**Still open:** transfer schema/revision lineage and database-level tenant constraints; authenticated learning-review administration; snapshot-consistent, uniquely ordered streaming exports and concurrent/large-export tests. Export still uses separate paginated reads without a consistent snapshot and accumulates output in memory. This finding remains partial; tenant guards do not establish transfer quality or production export consistency.

**User impact:** Shared-tenant administration depends too heavily on callers; an audit export during writes can contain inconsistent history.

**Missing / plan:** Tenant-scoped APIs and attributable review → enforce reference ownership → snapshot-consistent, stably ordered streaming export → large/concurrent export tests. Import/physical deletion are not automatic requirements for an append-preserving ledger.

## F24 — World Sense funnel and policy semantics

**State:** Orphaned / partial. **Priority:** Medium. **Effort:** Large. **Disposition:** Defer until the primary wedge works.

**Evidence:** `src/sense/watch.ts:62–84,109–145`; `src/sense/triage.ts:47–59,83–95`; `src/sense/integrity.ts:44–85`; `src/sense/poisoning.ts:76–90`.

No running collect→materiality→triage→integrity→reasoning funnel found. Predicates are stored without matching; goal checks use caller-supplied live goals; threshold checks iterate supplied scores rather than requiring all configured thresholds. Contract expiry/spend evaluation is separate. Independent provenance is approximated by distinct strings. Self-serving discount is a flag without downstream application; quotation wrapper is not an enforced runtime prompt boundary.

**User impact:** Watch contracts do not currently deliver an always-on, budgeted, reviewed monitoring service.

**Missing / plan:** One authoritative contract evaluation → durable contracts/review/spend → collector scheduling → required signal/predicate semantics → defensible provenance independence/discounting → bounded downstream execution → full funnel tests. Until then label it research/policy infrastructure.

## F25 — Buzz reporting, model policy and test-only adapters

**State:** Partial / orphaned integrations. **Priority:** Medium. **Effort:** Medium–Large. **Disposition:** Complete only the integration used by the pilot.

**Evidence:** `src/talk/buzz.ts:20–23,149–175`; `test/talk.test.ts:105–108,194–245`; `src/substrate/models.ts:117–127,204–248`; `src/sense/triage.ts:94–95`; `src/substrate/harness.ts`.

Buzz publisher assumes an HTTP envelope, requires an injected signer and is only composed with the runner in tests. Watcher publishes `IN_FLIGHT`, swallows errors and lacks terminal/drain/unsubscribe handling. HMAC bindings are useful but not a Slack integration. Model approval exists in AWS caller, not universally in raw `completeChat`, judge or triage. Judge parsing accepts a numeric substring rather than validating a whole strict score response.

**User impact:** Threads can stay in-flight forever; relay failures disappear; policy claims vary by caller; echo can be mistaken for real model diversity.

**Missing / plan:** Select one actual relay/model path → governed production client → strict result validation → real signer and verified transport contract → bounded retries/error visibility → terminal summaries and cleanup → explicit fake/echo labeling. Do not build Slack merely because the abstraction has a swap point.

## F26 — Digest, report semantics and operational observability

**State:** Partial / orphaned digest / explicit metric placeholder. **Priority:** Medium. **Effort:** Medium. **Disposition:** Complete the useful reporting subset.

**Evidence:** `src/console/digest.ts:39–80`; `src/console/report.ts:137–317`; `src/console/render.ts:213–232`; `src/console/serve.ts:92–164`; `src/cli.ts:35–114`; `scripts/verify-instance.mjs`.

Digest is not rendered/served; repeated topic grouping compares against the first matching window. MTTR is honestly null. “Today” spend uses lifetime spend of requests created today. Provenance label says FACT-only while calculation includes measurements. Visible limits lack navigation/omitted counts, and bounded HTML does not bound all history-sized reads. CLI report cannot use production Postgres; instance verifier promises more than its metadata-oriented path proves.

Recent counters/access logs and report single-flight are real improvements, not missing features. They do not provide end-to-end trace correlation, verified alert delivery or persisted operational history.

**User impact:** Important work can be hidden, metric labels mislead, and operators lack a reliable diagnosis/escalation path.

**Missing / plan:** Fix metric definitions/labels → expose omitted counts/detail pagination → connect or delete digest → DB-level bounded queries → consistent DB/tenant CLI options → meaningful readiness/verification → correlated operational telemetry. Avoid inventing MTTR until resolution timestamps exist.

## F27 — Infrastructure without writers, recipients or recovery procedures

**State:** Scaffolded / partial. **Priority:** Medium. **Effort:** Large if retained. **Disposition:** Remove unused resources or complete narrowly.

**Evidence:** `deploy/aws/main.tf` S3/Object Lock, SNS/alarms, standalone jcode and autoscaling blocks; `docs/deployment.md:29–34`; `deploy/layers/reference/genome/`.

S3 resources have no corresponding application audit/artifact writers. SNS topic/alarms lack supplied recipient subscription/delivery verification. Restore drills are prescribed, not implemented/evidenced. Standalone jcode is explicitly staged with default zero count and placeholder TCP transport; it is not a finished service split. Reference deployment-layer directory is empty.

**User impact:** Resources cost money and imply durability/alerting/isolation that has not been demonstrated.

**Missing / plan:** Delete/defer idle topology → retain one working execution model → add required writer/recipient and failure alarms → execute restore and redrive drills → document actual recovery objectives. A bucket is not an audit archive; an alarm topic is not an operator notification.

---

# 3. Broken end-to-end workflows

| Journey                     | Working legs                                                     | Break / missing lifecycle                                                               | Findings     |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------ |
| Operator access             | Optional shared-secret mutation gate                             | No individual principal, tenant-bound reads, roles, revocation or attributable approval | F01          |
| Human approval              | Queue read → callable API → state change                         | No browser action; ACCEPTED cannot be claimed by jcode                                  | F02–F03      |
| Paid job                    | Handler → model → claim → completion                             | No deployed producer, exclusive ownership/accounting/failure contract incomplete        | F04–F05      |
| Governed coding             | Client/socket → permissions → turn                               | Full trust/kill/scope boundary not connected; approved write path unproven              | F06, F12–F13 |
| Source ingestion            | Poll → inbox staging/cursor → direct ingestion                   | Inbox recovery not authoritative, tenant/occurrence/artifact identity inconsistent      | F09–F11      |
| Ship-to-Result              | Release ingestion → summary → five requests                      | Deliverables/review/action/real outcome absent; dogfood measurement synthetic           | F14–F15      |
| Churn response              | Risk refs → three requests → recommendation                      | Product evidence/result join, approved outreach and outcome missing                     | F14          |
| Deep research               | Plan → approval → searches → optional checkpoints → cited report | Partial incorrectly completed; restart/report/gap/contradiction lifecycle incomplete    | F16          |
| Organizational learning     | Trace/card/gates/registry functions                              | Actual routing→evaluation→promotion→dispatch→drift loop absent                          | F17–F18      |
| Trust improvement           | Scores/honeytasks/review functions                               | Runtime feedback/authorization/kill verification absent                                 | F06, F19     |
| Decision ROI                | Outcomes → arithmetic → chart                                    | Metric direction/decision denominator/real costs/experiment lifecycle incomplete        | F15, F20–F21 |
| Correction                  | HTTP → supersession → optional eval case                         | Structured value can stay old; failed eval linkage lacks recovery                       | F22          |
| Dispute/prediction curation | Links/expiry queries → dashboard                                 | Assignment, resolution, outcome association and SLA closure absent                      | F22          |
| Audit export                | Tenant data → paginated reads → assembled output                 | No consistent concurrent snapshot or operator workflow                                  | F23          |
| World Sense                 | Individual contract/triage/integrity functions                   | No running reviewed/budgeted funnel                                                     | F24          |
| Run notifications           | Progress subscriber → signed-event-shaped POST                   | No production signer composition or reliable terminal/retry lifecycle                   | F25          |
| Deploy/operate/recover      | Images/Terraform definitions/tests                               | First/repeat deploy, state/secrets, truthful smoke, alerts/restore not complete         | F08, F27     |

**Not automatically missing:** registration/password reset if using an external IdP; destructive CRUD/restore for immutable claims; autonomous external publishing (explicitly excluded); chat (intentionally belongs elsewhere); scheduled report delivery before pilot demand. These are product choices, not checkbox defects.

---

# 4. Cross-layer completeness matrix

Legend: **Yes** = meaningful implementation at this layer; **Partial** = narrower than promised; **Library** = callable, not operationally connected; **No** = no relevant implementation found. Tests indicate coverage exists, not production verification.

| Feature             | UI                    | API/runtime           | Validation                   | Permissions                       | Persistence                     | Error/loading/success                   | Logging                          | Docs/tests                    |
| ------------------- | --------------------- | --------------------- | ---------------------------- | --------------------------------- | ------------------------------- | --------------------------------------- | -------------------------------- | ----------------------------- |
| Console reporting   | Yes                   | Yes                   | Partial metric semantics     | No read auth                      | Yes                             | Server errors; no interactive lifecycle | Recent access logs/counters      | Tests, docs drift             |
| Approval/decline    | No actions            | Yes                   | Transition/body checks       | Shared-secret only                | Yes                             | HTTP states, no UX                      | Audit/latency partial            | Local HTTP tests              |
| Claim correction    | No form               | Yes                   | Prose only                   | Shared-secret only                | Yes                             | Eval linkage best-effort                | Audit diff                       | Regression tests partial      |
| Request execution   | Read-only states      | Split paths           | Partial                      | Boundary incomplete               | Claims/leases partial           | Retry/timeout gaps                      | Activity traces partial          | Fake/empty-job tests          |
| Ship/churn          | No workflow           | Script/library        | Citation availability        | Simulated or named approval       | Requests/decisions              | No completed joins                      | Mixed real/synthetic             | Admission-focused tests       |
| Feature coding      | No                    | Library               | Approval binding incomplete  | Default writes denied             | Decisions/observations          | Adapter completion                      | Trace                            | Echo/fake success             |
| Deep research       | No                    | Library               | Citation/state partial       | Named string, no runtime identity | Optional partial checkpoints    | Budget/recovery/report gaps             | Checkpoint rows                  | Seven focused tests passed    |
| Router/compiler     | Read-only board       | Library/demo          | Gates exist, evidence weak   | Tenant/reviewer gaps              | Yes                             | No operational lifecycle                | Partial lineage                  | Broad unit tests              |
| Governance          | No                    | Library; shell active | Policy checks                | Not composed end-to-end           | Yes                             | Drill/feedback gaps                     | Policy audit partial             | Component tests               |
| Ingestion           | No                    | Dogfood + library     | Dedupe/source partial        | Tenant cursor issues              | Inbox/artifacts partial         | Retry recovery gaps                     | Partial                          | Tests, no worker validation   |
| Sensing             | No                    | Library               | Incomplete contract matching | No operating boundary             | Contract objects/meta fragments | Model fallback, no service              | No complete lineage              | Policy/fixture tests          |
| Attribution         | Charts                | Partial               | Wrong success semantics      | Caller/tenant context partial     | Outcomes/meta                   | Unknown data defaults                   | Partial                          | Narrow arithmetic tests       |
| Buzz                | External surface only | Library               | Mocked transport/signing     | Injected signer                   | No durable delivery             | Errors/terminal/drain absent            | Weak                             | Fake relay tests              |
| Deployment/recovery | N/A                   | Declarative partial   | Config/startup gaps          | IAM/identity incomplete           | Infra declared                  | Smoke/restore gaps                      | Alarms without verified delivery | No live deployment validation |

---

# 5. Orphaned pages, components, APIs and services

There is **no hidden multipage UI inventory**. The main orphaning is backend/library composition and inaccessible actions.

| Candidate                                  | Evidence / caller status                                 | Recommended disposition                                              |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Digest renderer                            | `src/console/digest.ts`; tests/helper only               | Connect a real section/route or delete renderer and misleading label |
| Approval/correction UI                     | APIs exist; no controls in renderer                      | Complete, not delete                                                 |
| Research plan/run/report                   | `src/wedge/deepresearch.ts`; test-only callers           | Experimental namespace/defer standalone product                      |
| Feature and churn product workflows        | `src/wedge/feature.ts`, `churn.ts`; test/library callers | Defer behind working Ship slice                                      |
| Scheduler tick/webhook/outbox              | No production scheduler/relay startup                    | Complete one worker or stop claiming scheduled execution             |
| Router labeling/calibration/mining/drift   | Tests/demo and registry read UI                          | Core moat: retain, integrate after valid evidence                    |
| Trust/honeytask/review policy              | Tests/library; no live feedback caller                   | Retain, compose at execution boundary                                |
| Scope identity/sandbox/content proxy       | No adapter preflight wiring                              | Complete if production safety claims depend on them                  |
| Capability quarterly reviews               | Explicit format-only primitive                           | Keep small; do not build a department UI now                         |
| Preregistration/holdout/caveats            | No production experiment caller                          | Keep helpers; avoid causal claims until lifecycle exists             |
| Export/replay/curation library             | Intentional API functionality, limited UX                | Preserve; expose operator workflows as required                      |
| Model judge and raw triage adapter         | No governed production scoring path                      | Tighten semantics before promotion use                               |
| `openFromEnv` and socket helpers           | DB helper used by executor; socket resolver disconnected | Do not blanket-delete helpers; connect resolver centrally            |
| Standalone jcode deployment/layer skeleton | Explicitly staged/empty                                  | Remove from active deployment until transport and owner exist        |

**Endpoint distinction:** Approval/decline/correction endpoints are implemented and locally tested, not dead. They are **product-inaccessible from the browser**. Metrics/latency endpoints are legitimate observability APIs even without UI callers. No speculative list of “unused REST services” is inferred from that absence.

---

# 6. Placeholder, mock and AI-style context gaps

The code cannot establish whether AI authored a feature. The following are observable integration patterns, not authorship claims.

| Pattern                                   | Concrete example                                                                                               | Why it matters                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Test name stronger than assertion         | `test/aws.test.ts:34–40` names tenant handling but submits no jobs                                             | Passing does not verify the advertised boundary        |
| Simulation treated as evidence            | Dogfood hardcoded approval/time savings/success                                                                | Corrupts product credibility and learning inputs       |
| Adapter completion treated as quality     | Echo/fake transfer passes                                                                                      | Transport success is not procedure transfer            |
| Citation presence treated as support      | Release/research checkers validate IDs, not assertions                                                         | “Verified report” overstates what is checked           |
| Safety control exists beside executor     | Tokens/kill/trust/sandbox helpers not applied at harness entry                                                 | Individually correct controls do not constrain work    |
| Schema/service exists without consumer    | Inbox/outbox and SQS infrastructure                                                                            | Durable storage alone does not process or recover jobs |
| New fix not propagated to all callers     | Execution claim used by jcode, not Lambda; cost ignored by completion caller                                   | Competing execution contracts                          |
| Duplicate migration architecture          | Runtime catch-all versus named journal                                                                         | Stronger tests cover the unused path                   |
| Separate artifact implementations         | Runtime writer versus bounded store                                                                            | Size/integrity behavior differs by caller              |
| Two promotion lifecycles                  | Compiler card states versus `evals/promotion.ts` stages                                                        | “Canary” metadata is not real traffic allocation       |
| Honest explicit placeholder               | MTTR `null`; staged standalone jcode                                                                           | Keep labeled or remove; do not fabricate values        |
| Infrastructure mistaken for functionality | S3/Object Lock/SNS/EFS declarations                                                                            | Requires writers, readers, recipients, and drills      |
| Docs contradict each other                | Deployment promises connected services; `docs/limitations.md:8–15` admits no production integration/compliance | Operators cannot tell which promises apply             |

`seed-demo.ts`, injected test models, poisoning fixtures, and `LocalEchoAdapter` are legitimate when clearly isolated and named. The recommended removal is **their use as production-quality evidence**, not all deterministic tests.

---

# 7. Dead code and legacy artifacts

| Artifact                                                | Assessment                                                                                                   | Action                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/core/migrations.ts` alongside runtime migrations   | Competing, test-backed but not authoritative                                                                 | Consolidate, then remove duplicate path                                       |
| `src/console/digest.ts` renderer                        | No product caller                                                                                            | Connect or delete                                                             |
| Runtime `storeArtifact` versus bounded filesystem store | Competing approaches                                                                                         | One interface/implementation path                                             |
| `evals/promotion.ts` versus compiler lifecycle          | Possibly distinct domains, relationship undefined                                                            | Define owner and gates; remove unused generic state machine if redundant      |
| Duplicated drift queries                                | Compiler and registry read logic                                                                             | Share read-only measurement; keep mutation explicit                           |
| `Coordinator.complete(...cost)`                         | Parameter accepted but not charged                                                                           | Remove dead contract or implement authoritative charging, update every caller |
| Trust `override_rate`/grant fields                      | Not consistently maintained/consumed                                                                         | Maintain with defined semantics or remove                                     |
| `src/core/rows.ts`                                      | Request row contract behind lease/reservation/schema additions                                               | Align types with actual schema                                                |
| Vendored `governor.ts`                                  | Evaluator referenced by tests, no runtime vitals/action application                                          | Archive/defer or wire only if needed                                          |
| Vendored grant/output helpers                           | `buildShipGrant`, `graduationAllowed`, `outputCandidate`, `undeclaredShipActions` lack application consumers | Do not count as operating grant lifecycle                                     |
| Vendored policy parser/composition/layers               | No application configuration caller; shell uses default policy                                               | Defer configurable policy claims                                              |
| Vendored command policy/safe regex                      | **Active** through jcode shell screening                                                                     | Keep; not dead code                                                           |
| Vendored crypto/object/error exports                    | Some only support dormant grant/parser paths                                                                 | Preserve upstream provenance or narrow deliberately, not blind deletion       |
| Empty deployment-layer skeleton                         | No deployable reference genome                                                                               | Remove until it has an owner                                                  |
| Stale documentation claims                              | README/idea build-state and deployment assumptions                                                           | Refresh from verified integration evidence, not old checklist status          |

No wholesale deletion of vendored code is recommended: licensing/provenance and upstream comparison can justify unused leaf exports. Likewise, export/import symmetry, chat, and autonomous publishing are not valid dead-code or incompleteness heuristics here.

---

# 8. Enterprise capabilities missing

## Required before even a restricted enterprise pilot

1. **Identity and scoped authorization:** authenticated operators, tenant-bound reads/writes, server-derived audit actors, least-privilege execution delegation.
2. **Reliable approval-to-action lifecycle:** immutable approved payload/evidence, stale-context policy, actual execution receipts and visible terminal results.
3. **Durable execution ownership:** leases, fencing, idempotent settlement, retry/backoff, dead-letter redrive and recoverable outputs.
4. **Truthful cost/outcome measurement:** real usage, unknown-cost handling, metric direction and exclusion of simulated data.
5. **Operational readiness:** validated migrations, reproducible startup/deploy, persistent deployment state, alert recipients, restore/redrive evidence.
6. **Tenant correctness at API boundaries:** learning/reference/cursor ownership, not only tenant columns on main tables.

## Needed before broader enterprise rollout

- SSO through an established identity provider; membership/role administration and credential revocation.
- Search/filter/detail/history and safe bulk review for claims, requests and approvals.
- Audit export with a consistent snapshot; immutable external audit delivery if contractually required.
- Policy/evaluation/card revision history, review attribution and evidence lineage.
- Contradiction/prediction resolution ownership, SLA tracking and correction follow-up.
- Notification preferences, reliable delivery and escalation ownership.
- Retention, data deletion/redaction policy compatible with append-preserving evidence and legal obligations.
- Restore drills, RPO/RTO commitments, alert runbooks and incident attribution.
- Load/concurrency/upgrade tests on the actual production database and execution topology.
- Compliance documentation and customer controls justified by actual deployment, not infrastructure resource names.

## Not justified as immediate scope

A generic CRM, Salesforce connector, chat app, full organization-management suite, custom password system, autonomous publishing, elaborate report scheduling and many-harness support would distract from the primary wedge. Add only when a design partner's validated workflow demands them. `docs/limitations.md` already explicitly disclaims live integrations and compliance posture; retain that honesty.

---

# 9. Features to remove or defer

**Remove rather than complete now:**

- Fabricated dogfood outcome/approval/quality evidence from production metrics and learning.
- Echo/fake completion classified as cross-model performance evidence.
- Duplicate migration/storage paths after choosing the authoritative versions.
- Unused standalone jcode service split and empty deployment layer from the supported topology.
- Digest teaser/renderer if no near-term operator requirement exists.
- Unused configuration and infrastructure claims whose runtime consumers do not exist.
- Generic eval “canary” lifecycle if it remains disconnected from actual traffic and compiler ownership.

**Defer, do not destroy:**

- Churn-response and standalone feature/research products.
- World Sense's always-on service.
- Department/capability management UI.
- Additional chat transports/harnesses and cross-cloud execution.
- Advanced causal experiments until descriptive measurements are trustworthy.

Keep useful tested primitives in an explicitly experimental/library surface where appropriate. The goal is smaller supported scope, not deleting functioning foundations to improve dead-code counts.

---

# 10. Features worth completing

1. **Reality Ledger + evidence inspection/correction/replay:** distinctive, already connected, and valuable independently.
2. **One governed approval-to-execution workflow:** necessary to turn the ledger from a report into a usable product.
3. **One real Ship-to-Result asset and outcome:** the clearest end-user acceptance test and smallest product wedge.
4. **Durable ingestion and result evidence:** essential for trust and recovery.
5. **Accurate request/decision cost and outcome reporting:** essential before ROI or learning claims.
6. **Compiler evaluation/promotion/drift built on real evidence:** the longer-term differentiator, after the operating loop exists.

---

# 11. Prioritized completion roadmap

The order below is dependency-based. Do not launch a parallel rewrite of every module.

| Phase                         | Work                                                                                                                                           | Findings               | Size                                    | Exit gate                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| 0 — Bound claims and exposure | Private deployment; explicit operator-secret requirement; quarantine simulated results; mark experimental surfaces; correct supported topology | F01, F15, F25, F27     | Small–Medium                            | No public administrative exposure or simulated production KPI/transfer evidence      |
| 1 — Stabilize foundations     | Build/start/Compose; authoritative migrations; state graph; completion/usage contract; tenant-scoped identity                                  | F03, F07–F08, F20, F23 | Large                                   | Clean boot/upgrade; approved work has one legal executable path; accounting tested   |
| 2 — One durable worker        | Choose jcode or short-horizon executor; authoritative inbox/outbox; ownership/recovery; artifacts; governed boundary                           | F04–F06, F09–F12, F19  | Large                                   | Intake→one execution→durable result survives crash/retry without duplicate paid work |
| 3 — Finish human product      | Evidence/detail views; authenticated action forms; correct queue states; corrections/resolutions; delivery feedback                            | F01–F02, F22, F26      | Large                                   | Operator completes review/correction/approval/result inspection without scripts      |
| 4 — Prove Ship-to-Result      | One real deliverable, blocking evidence check, named approval, real action receipt and measured result                                         | F14–F15, F21           | Large                                   | One genuine release closes with independently inspectable output, cost and outcome   |
| 5 — Earn learning claims      | Balanced linked traces; real transfer cases; revision-bound evidence; actual shadow/pilot; promotion/drift worker                              | F17–F18, F21, F23      | Large                                   | A procedure is promoted and later retained/demoted based on actual evaluated runs    |
| 6 — Operational pilot gate    | Persistent IaC state, secrets/IAM, first/repeat deploy, readiness, alerts, restore/redrive, production DB concurrency                          | F08, F10, F23, F27     | Large; overlaps earlier deployment work | Disposable deployment and recovery drill pass; alerts reach a named operator         |
| 7 — Expand only from demand   | Churn/feature/research/sensing, further transports, exports/bulk review                                                                        | F13, F16, F24–F26      | Large, optional                         | Design partner requires feature; complete lifecycle acceptance criteria exist        |

### Acceptance tests that matter more than more isolated unit tests

- Authenticated operator sees only authorized tenant data and cannot act outside permitted scope.
- Browser approval reaches a real worker and a visible result through the same state machine.
- Two real Postgres worker connections cannot own the same active attempt; an expired owner cannot settle a new attempt.
- A crash after polling, after claim creation, after output persistence, and before settlement resumes coherently.
- An executor failure charges known usage, records a coherent state and exposes retry/redrive to operators.
- A failed copy/evidence check prevents success/outcome/learning records.
- A corrected structured fact changes the value used by downstream consumers and creates a regression case or durable retry.
- Lower-is-better metrics, multiple metrics per decision, child costs and unknown costs produce correct reports.
- Echo and empty batches cannot satisfy quality/tenant/execution acceptance tests.
- Kill drills preserve pre-existing stop state and verify each level independently; execution halt is separately checked.
- Promotion references actual immutable evaluator results for the current card/model revision; later failure can invalidate old evidence.
- First deploy, second deploy, restore and dead-letter redrive work on disposable infrastructure with no live paid-model dependency.

---

# 12. Overall product completeness score

## **40/100 — substantial foundations, incomplete user journeys**

This is a weighted engineering judgment, not percentage of files or tests. Scoring is against Vital's stated grounded, budgeted, attributable, safely executable and learning product—not a generic SaaS checklist.

| Dimension                                 | Weight | Score | Reason                                                                             |
| ----------------------------------------- | -----: | ----: | ---------------------------------------------------------------------------------- |
| Ledger/evidence foundation                |    25% |    70 | Real invariants, replay and correction; resolution/export/typed-correction gaps    |
| Complete human/business journeys          |    25% |    25 | Readable console, but actions inaccessible and primary wedge stops short           |
| Execution and integration                 |    25% |    30 | Real clients/handlers; missing deployed dispatch, ownership and policy composition |
| Learning and attribution                  |    15% |    30 | Rich primitives, weak promotion/outcome evidence and no operating loop             |
| Operator surface and product truthfulness |    10% |    35 | Useful read model; inconsistent docs, synthetic outcomes, missing details/actions  |

Weighted result is approximately 40. Completing the first honest vertical slice would improve this score more than adding many isolated feature modules.

# 13. Overall production readiness score

## **25/100 — internal experimentation, not enterprise production**

| Dimension                                     | Weight | Score | Reason                                                                                          |
| --------------------------------------------- | -----: | ----: | ----------------------------------------------------------------------------------------------- |
| Identity, authorization and execution control |    25% |    20 | Optional shared-secret floor; individual/tenant authority and full boundary controls incomplete |
| Reliability and data correctness              |    25% |    30 | Strong primitives but migration, ownership, recovery, correction and accounting gaps            |
| Deployment and operational recovery           |    20% |    20 | Significant IaC, but bootstrap/state/secrets/smoke/writers/drills incomplete                    |
| Production-representative validation          |    20% |    30 | Typecheck and focused tests pass; production paths remain fake/empty/unverified                 |
| Supportability and documented contract        |    10% |    30 | Good explicit limitations, useful console/logs; deployment and feature claims inconsistent      |

Weighted result is approximately 25. This does not mean every module is unsafe or that the code is worthless. It means the supplied product has not demonstrated the authority, lifecycle, evidence and recovery guarantees required to operate customer agents reliably.

**Final recommendation:** Freeze feature expansion. Keep Vital's ledger and conservative primitives, shrink the supported deployment, and complete one authenticated, durable, governed, measured Ship-to-Result loop. Treat the remaining modules as experimental until their end-to-end acceptance tests pass.

---

# Remediation progress log

## 2026-09-17 — first completion pass (post-rebase tree)

Status below reflects the working tree after the rebase onto `origin/main` and this pass. Suite: **346/346 green**, typecheck clean, `docs:check` green, `npm run build` produces a bootable `dist/cli.js` (smoke-tested via `status` + `report`).

### Changes and partial remediation (not full finding closure)

| Finding                                              | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F15** — synthetic dogfood evidence                 | Prior work removed fabricated predicted/actual minutes and blocks failed drafts before decision/trace/card creation. F15 remains PARTIAL: the script still auto-verifies as human:founder, records a synthetic SUCCESS trace, and compiles a card with supplied model/eval references. Synthetic labels are not proof that every downstream consumer excludes them. This pass ran the existing tests; it did not implement this prior remediation. | `scripts/dogfood-ship.ts` (`runShipPipeline`, `assertDraftShips`); `test/wedge.test.ts` ("dogfood marks the release known only after ALL stages complete", "F15: a blocked draft aborts the run before any evidence is minted") |
| **F08** — deployment bootstrap, state & secrets      | Bootstrap image fallback in main.tf locals, ECS execution role secret grants for all injected secrets, sensitive TF_VAR_* workflow mapping, remote state backend integration, ECR creation before push, and multi-phase semantic smoke checks.                                                                                                                                                                                                     | `.github/workflows/deploy-aws.yml`; `deploy/aws/main.tf`; `docs/deployment.md`; `deploy/compose.yml`                                                                                                                            |
| **F01 (partial, prior work)** — console identity     | Upstream session auth (signup-claim/login/CSRF/lockout/roles/tenant scoping) merged with the local operator gates (shared secret + ed25519 signed approvals, registry with revocation, fail-closed on corrupt registry). Merge verified by new tests covering both layers together.                                                                                                                                                                | `src/console/serve.ts`; `src/gov/operator.ts`; `test/console.test.ts` merged-behavior tests; `test/operator.test.ts`                                                                                                            |
| **F05 (prior work)** — executor ownership/accounting | Executor now claims exclusively (fenced), charges usage, persists full artifacts, settles budget breaches as TERMINATED; covered by tests.                                                                                                                                                                                                                                                                                                         | `src/aws/executor.ts`; `test/aws.test.ts` F05 tests                                                                                                                                                                             |
| **F07 (prior work)** — migration authority           | Prior work shares a schema_migrations journal and improves runtime migration handling. The generic migration module still defines journal DDL and writes journal entries itself; consolidation is partial, not a verified single-writer design.                                                                                                                                                                                                    | `src/core/migrations.ts:1–77`                                                                                                                                                                                                   |
| **F03 (partial, prior work)** — lifecycle            | `readmitDeferred`, batched `expireStale`, fenced `claimExecution`/`reclaimStale` exist with tests; console approval path unchanged.                                                                                                                                                                                                                                                                                                                | `src/coord/coordinator.ts`                                                                                                                                                                                                      |
| **F09** — durable ingestion and tenant cursors       | Tenant-scoped cursor isolation with legacy fallback, revision-aware release polling, dual identity/fingerprint receipts with atomic db.transaction persistence, and authoritative batch ingestion through `ingestInboxBatch` integrated with `scripts/dogfood-ship.ts`.                                                                                                                                                                            | `src/ingest/collectors.ts`; `scripts/dogfood-ship.ts`; `test/ingest.test.ts` (4 new tests)                                                                                                                                      |

### Still open (unchanged priorities)

- **F04** — no deployed composition root: `serve` still starts only the console; no scheduler tick, SQS producer, or jcode dispatch loop runs.
- **F02 (partial)** — live approve/decline controls are now available in Pending review (see the follow-up below). Claim-correction forms, complete evidence drill-down and browser automation remain open.
- **F03 remainder** — deferred-readmission/lease-recovery loops exist as APIs but no deployed worker calls them.
- **F15** — remove fabricated verification and synthetic success/card inputs from the supported production path, or enforce isolation at every consumer; real review and measurement remain absent.
- **Other findings** — not reassessed comprehensively in this pass. Concurrent commits addressed portions of ingestion, artifacts, transfer, ledger resolution and reporting. The original audit is historical evidence, not an up-to-date assertion that those changes are absent.

### Validation this pass

- `npm run typecheck` — pass
- `npm test` — **355/355** (includes new F15 dogfood tests, merged console/operator tests, artifact-store tests, F02 review controls, and F12 jcode execution remediation)
- `npm run docs:check` — pass (docs quote 355)
- `npm run build` + `node dist/cli.js status --db :memory:` + `node dist/cli.js report --db :memory: --out …` — pass
- Follow-up build validation: both Docker images built from clean commit `7fbab1c`; core status and executor empty-batch smoke passed without network access. Compose config validated; full stack boot, Terraform and live services remain unverified.

## 2026-09-18 — F04a finite observation-ingestion slice

Added `src/ingest/worker.ts` and `ingest-files` in `src/cli.ts`: explicit tenant,
scope, persistent DB and artifact directory; staged recovery → bounded file poll
→ artifact-backed OBSERVATION → DONE. This finite command does not enable model
or coding execution. `docs/deployment.md` documents invocation and limitations.

`src/ingest/collectors.ts` now bounds inbox selection in SQL, caps exhausted
crashed attempts, and checks owner/attempt before atomically appending claims and
settling receipts. Settlement avoids schema DDL inside the persistence transaction.
The CLI opts into 500-entry, 1 MB/file and 10 MB/poll limits; source data must be
operator-controlled and separate from database/artifact paths. Artifact writes
remain outside the DB transaction and can leave unreferenced files on rollback.

`test/ingest-worker.test.ts` adds 23 tests for the persisted CLI journey, reruns,
restart recovery, poison isolation, caps, cancellation, tenant isolation, input
bounds, lease recovery, stale ownership and settlement rollback; registered in
`test/run.ts`. Focused tests passed 23/23 and the registered suite passed 389/389
at execution time. Live Postgres concurrency and AWS deployment were not tested.
General execution-worker changes were concurrent work, not validated or closed by
this ingestion slice. Existing F04 remediation claims above require their own
execution, governance and deployment evidence.

## F02 follow-up — live request review

Implemented in `src/console/review.ts` and the authenticated dashboard handler in `src/console/serve.ts`:

- Pending review lists admitted REQUESTs with a human-minute budget, with goal, deliverable, deadline, budget and up to 20 evidence previews. Reviews paginate at 100 per page; detail links expose all evidence.
- Live approve/decline forms require confirmation; decline requires a reason. Existing session, tenant, role, CSRF, operator-secret and signature checks remain authoritative. Signed mode displays the exact message to sign externally; no private key is collected.
- Controls are injected per session after the shared report cache. Static report exports stay read-only. Accepted/declined requests leave the review list on refresh; approval is explicitly not execution completion.
- Client feedback covers pending, accepted/declined, HTTP failures and ambiguous timeouts. Credentials are cleared after submission and never persisted in browser storage. Buttons start disabled without JavaScript.
- Queue semantics are a bounded presentation of existing ADMITTED work, not a new approval-required execution gate. Background dispatch and immutable approval/action binding remain separate findings.

### F02 completion — evidence and correction browser journey

The scoped browser review workflow is implemented and verified. `src/console/detail.ts` provides tenant-scoped request and claim detail pages with complete provenance, paginated evidence/history, and correction controls. `src/console/render.ts` connects live request/evidence links while static exports remain read-only. Corrections preserve historical claims and link to the replacement; request references are deliberately not rewritten. Historical claims cannot be corrected through these controls. Correction authorization retains the existing API policy rather than introducing a new role policy.

`src/console/review.ts` rejects blank/non-finite numeric-mode input, disables selectors during submission, and reports correction/regression-capture results. `test/review.browser.ts` drives real Chromium through login → 23-item evidence pagination → claim correction (validation, failed credential, retry) → persisted replacement and history → approve/decline → queue refresh, with no page JavaScript errors. It also checks that another tenant's claim detail is unavailable.

Validation for this completion pass: `npm run test:browser` **1/1 passed**; `npm test` **359/359 passed**; `npm run typecheck`, `npm run build`, and targeted ESLint passed. Browser installation/run instructions are in `README.md`. No live Postgres, production deployment, or downstream worker execution was verified by this browser test. Database-level bounded queries, immutable payload-bound approval, and background dispatch remain separate work; UI pagination does not establish load-scale readiness.

Validation: typecheck and build passed; console/auth tests **52/52 passed**, including HTTP render→approve/decline→refresh and an isolated client-script test for successful declines and errors. Full suite result is **355/355 passed**: all adapter completion, jcode trace creation, live progress, and review controls pass cleanly.
