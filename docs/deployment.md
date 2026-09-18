# Deployment — the one supported topology

Reference (production on AWS): **ECS vital-core + jcode sidecar · ECS Buzz
relay · RDS Postgres (Ledger + Buzz) · ElastiCache Redis · S3 artifacts +
Buzz media · Lambda executor microVMs · ALB entry** (`deploy/aws/` Terraform —
the only supported production path). Local smoke only: `deploy/compose.yml`
(loopback console + Postgres for CI/E2E-17; no Buzz, jcode, or workers).

## Finite file ingestion (F04a)

An explicit `ingest-files` command now composes one bounded observation path;
this is not automatic REQUEST dispatch or a deployed scheduler. Existing topology
descriptions below are not evidence that all producers and workers are connected.

```sh
node dist/cli.js ingest-files --tenant acme --scope engineering --source data/incoming --artifacts var/ingest-artifacts --db var/vital.db --max-receipts 50
```

Build first with `npm run build`. The source directory must already exist and
contain only operator-approved evidence. Use a persistent SQLite file or a
Postgres URL (`DATABASE_URL` is the fallback); `ARTIFACT_DIR` can replace
`--artifacts`. Database access is this administrative command's authority: it
does not authenticate through the browser or provision users. Mount durable
storage for artifacts and keep the database/artifacts outside the input directory.
A bucket environment variable alone does not provide artifact persistence.

- Drain existing inbox → poll once → drain new receipts → JSON summary → close DB.
- Default 50 total receipt attempts per invocation; configurable 1–500. Each
  receipt has a unique run owner, a 60-second claim lease and three attempts.
  A crashed expired receipt is recoverable; exhausted attempts remain FAILED
  for inspection. There is no automatic redrive UI or retry backoff in this slice.
- Claim append, deduplication receipt and DONE settlement share a transaction
  after checking attempt ownership. Artifact bytes are outside the DB transaction;
  rollback may leave an unreferenced content-addressed file.
- Poll caps: 500 directory entries, 1,000,000 bytes per file, 10,000,000 bytes
  total. Oversized polls fail before staging or cursor advancement. Flat regular
  files only; source symlinks are refused. The source must remain operator-controlled:
  this is not a sandbox against concurrent hostile filesystem mutation.
- Exit 0 means the bounded invocation succeeded, **not** that the entire inbox
  is empty. Errors return sanitized codes and exit 1; cancellation exits 130.
  SIGINT/SIGTERM stops new work between receipts; active work finishes. This is
  cooperative cancellation, not a hard wall-clock deadline or query timeout.
- Run again using the same canonical source path to recover pending work. Schedule
  this finite command explicitly only after reviewing its storage/tenant settings.
  No model credentials, jcode socket, source execution, automatic FACT promotion,
  SQS relay or autonomous request recovery are enabled by this command.

SQLite restart/rollback/ownership and real child-process CLI tests are automated
in `test/ingest-worker.test.ts`. Live two-connection Postgres concurrency, deployment,
alerting and restore/redrive drills remain unverified production gates.

## Rules

- One supported topology. Custom-config sales asks are how a product
  company becomes an infra company (risk register, `idea.md` §20).
- Buzz is a surface: the Ledger survives a Buzz→Slack swap (spike proven,
  `src/talk/surface.ts`). Test the swap in Phase 0, not Phase 7.
- jcode is coordinated, not mounted: a REQUEST with a bid goes in, a
  deliverable + claims + cost come back. Zero ambient credentials cross —
  scope tokens (`src/substrate/identity.ts`) are the only credential.
- Egress allow/deny + metadata/IP blocks are decided in exactly one place
  (`src/substrate/egress.ts`); the proxy enforces, it does not interpret.
- Sandboxes rebuild from manifests; persistence is never trust-bearing.
- Kill switches exist at tenant / scope / action-class level and are
  drilled (`killDrill`). An untested kill switch is a UI element.

## Postgres (RDS)

- The schema is derived, never maintained twice: `PG_SCHEMA` is the one
  SCHEMA translated (`AUTOINCREMENT` → `BIGSERIAL`), verified identical in
  CI. Migrations: `migratePostgres` + additive journal; version stamped.
- **PITR is on.** RDS automated backups with a 7-day (min) retention window
  before any pilot data lands (Ledger and Buzz each have their own RDS
  instance in `deploy/aws/`). Verify with a restore drill to a scratch
  instance quarterly — an untested backup is a UI element, like the kill
  switch. Ledger export (`exportLedger`) is the portable second copy, not
  the backup strategy.
- `DATABASE_URL=postgres://…` selects the PG driver at runtime
  (`openFromEnv`); anything else stays sqlite. CI boots a postgres:16
  service and runs `verify-instance` against it on every push.

## Boot check

`npm run typecheck && npm test && npm run lint` green, then
`tsx src/cli.ts verify --db var/vital.db` (migrate + smoke probe) and
`tsx src/cli.ts status --db var/vital.db` (read-only; add `--tenant <slug>`
for tenant stats). A stranger boots the dev
topology from this file plus `README.md` in under 30 minutes (Phase 0
exit gate — not yet timed; time it before claiming it).

## Worker and Dispatch Architecture

Vital provides an authoritative background worker and dispatch subsystem (`src/substrate/worker.ts`):

- **`vital worker`**: Standalone background daemon executing recovery sweeps (`readmitDeferred`, `reclaimStale`, `expireStale`), relaying durable outbox batches (`claimOutbox`/`settleOutbox`), and dispatching runnable requests (`ADMITTED` and `ACCEPTED`) to execution runtimes (`jcode`, `LocalEchoAdapter`, or model executors).
- **`vital serve --with-worker`**: Runs the HTTP console and the background worker within the same process, suitable for single-node deployments and Docker Compose (`deploy/compose.yml`).

## AWS (production)

All-AWS, Terraform in `deploy/aws/` (`main.tf` · `variables.tf` ·
`outputs.tf`; example values in `terraform.tfvars.example` — never commit
real secrets, CI supplies every `TF_VAR_*`).

```
internet → ALB ──→ ECS Fargate vital-core (HOST=0.0.0.0, PORT=3100, VITAL_WITH_WORKER=1)
   webhooks, console, Slack-HMAC fallback all ride the ALB     │
         ┌─────────────────────────────────────────────────────┘
         │  sidecar: jcode harness API on /run/jcode-api.sock (localhost —
         │  the same coordinated REQUEST/bid path as src/jcode/runner.ts)
         ├── Cloud Map buzz.vital.local:3000 ← BUZZ_RELAY_URL (deploy/aws/buzz.tf)
         ├── RDS Postgres 16 Ledger (Multi-AZ, PITR 7d, private subnets)
         ├── RDS Postgres 16 Buzz relay DB + ElastiCache Redis 7 (Buzz only)
         ├── EFS /var/vital/sandboxes (rebuildable manifests, never trust-bearing)
         ├── S3 artifacts (content-addressed) + S3 audit (Object Lock 365d,
         │   separate from the Ledger — idea.md §12) + S3 buzz-media
         └── SQS vital-requests ──→ Lambda executor (container image,
             Firecracker microVM per invocation, 512 MB ephemeral, ≤15 min,
             reserved concurrency = infra budget-death backstop, DLQ after 3×)

Optional: ALB host rule buzz.example.com → Buzz relay (var.buzz_hostname).
Without it, Buzz stays reachable inside the VPC via Cloud Map only.
```

Why this shape, per Vital's own rules:

- **Lambda = microVMs, honestly.** Lambda already runs each invocation in a
  Firecracker microVM — that _is_ the "coding agent lambda microvm" idea,
  without operating Firecracker on bare metal. `src/aws/executor.ts` is the
  handler: SQS job → accept admitted REQUEST → approved-model check
  (`assertApproved`) → code-level egress gate (`decideEgress`) → model call
  → OBSERVATION append (I1: never FACT) → `coord.complete`. Failures
  terminal-fail the request; 3 strikes go to the DLQ, never silently.
- **Long jcode runs stay on Fargate.** Swarms, overnight runs, graph memory
  exceed Lambda's 15-min cap — the jcode sidecar next to core owns them.
  Short REFLEX/WORKFLOW/MODEL tasks fan out to Lambda. Same Ledger, same
  R/A/I answers, two runtimes split by duration, not by privilege.
- **Egress decided once, in code.** `decideEgress` (core + Lambda) is the
  policy; SGs/NAT/WAF are the backstop. Metadata hosts + 169.254/16 + EC2
  IPv6 metadata are never destinations; `ALLOWED_EGRESS_HOSTS` allowlists
  only Novita/Gemini/Serper by default.
- **Kill switches stay drills, now alarmed.** Tenant/scope/action-class
  kills (`killDrill`) plus CloudWatch alarms (ALB 5xx, Lambda errors, SQS
  oldest-message age) → SNS ops topic.
- **Ledger export is the portable second copy, not the backup.** PITR +
  quarterly restore drill remain the backup strategy (unchanged rule above).

Deploy: `deploy-aws` workflow (manual dispatch — infra is never a side
effect of a test push). It typechecks + tests, ensures ECR repos exist, builds
both images, pushes to ECR (immutable tags, scan-on-push, keep-last-20), runs
`terraform apply` with sensitive `TF_VAR_*` secrets mapped and fresh image URIs,
then executes semantic smoke checks (ECS stability wait, `/healthz` probing, and
non-billable executor dry-run invocation).

First-time bootstrap:

1. Initialize remote state: configure an S3 bucket and DynamoDB lock table for Terraform state (`TF_BACKEND_BUCKET`).
2. Set repository secrets for OIDC role and sensitive variables (`TF_VAR_TENANT_HMAC_SECRET`, `TF_VAR_VITAL_CORE_SECRET`, `TF_VAR_WEBHOOK_SECRET`, `TF_VAR_SERPER_API_KEY`, `TF_VAR_GEMINI_API_KEY`, `TF_VAR_NOVITA_API_KEY`, `TF_VAR_OPERATOR_SECRET`, `TF_VAR_BUZZ_RELAY_PRIVATE_KEY`).
3. Run the `deploy-aws` workflow or run `terraform apply` directly (safe local image fallbacks allow initial infrastructure bootstrap without chicken-and-egg failure).

## Status: liveness vs readiness

Process reachability is not workflow readiness. A cheap liveness answer
("the process responds") must never be worded as proof that ingestion,
database access, execution, and measurement are operational.

- `liveness()` in `src/gov/trust.ts` is the cheap check: no I/O, no
  dependencies. Serve wiring: answer the liveness probe from this only.
- `checkReadiness(deps, { timeoutMs })` in `src/gov/trust.ts` is the bounded
  check: each dependency gets its own timeout, required failures fail the
  report, and optional-but-unconfigured integrations report
  `unconfigured-optional` without failing it. Serve wiring: pass one entry
  per required dependency (database, worker, execution runtime) plus one
  `optional: true` entry per optional integration, and word the status page
  from the report — per-check status, never a bare green.
- Retry guidance (`retryGuidance` / `actRetryGuidance`) is per failure
  class: rate limits back off, unknown results reconcile before retry, and
  sensitive actions (approvals, spends, external effects) are
  explicit-resubmission-only — never blindly replayed.

## Support contact and diagnostics

Support contact is direct: report to the repo owner (see `SECURITY.md`
Reporting), the same channel as security issues. Include the support
reference from the failure surface.

- `mintSupportRef()` issues the opaque user-facing reference;
  `correlateDiagnostic({ detail, tenant, action })` pairs it with a
  sanitized log excerpt. Sanitization (`sanitizeDiagnostic`) redacts bearer
  tokens, passwords, secrets, API keys, private-key blocks, and database
  URLs before the excerpt is stored or shown.
- Triage information to include: the support reference, the tenant slug,
  the action being attempted, and the readiness report at the time of the
  failure. Escalation is the repo owner directly; there is no hosted
  support tier. Supported topology is the one in this file only.

## Backup/restore vs ledger-history import

These are separate operations with separate tests. Do not confuse them.

- Backup/restore: RDS automated backups (7-day minimum PITR window) plus a
  quarterly restore drill to a scratch instance. The restore drill is the
  proof; bucket or snapshot provisioning alone is not delivery proof.
  Drill procedure (record date, operator, and row counts each quarter):
  1. Restore the automated backup to a scratch instance (never over
     production).
  2. Open the scratch instance read-only and compare tenant row counts
     (claims, decisions, outcomes, audit) against production.
  3. Append one canary OBSERVATION on scratch and confirm history grows
     append-only (no rewritten rows, no recycled identities).
  4. Destroy the scratch instance; file the drill record with the quarter's
     ops notes. The SQLite equivalent of this drill — file copy, reopen,
     count, append — is automated in `test/backup-restore.test.ts`.
- Ledger export: `exportLedgerWithManifest(db, tenant, kind)` in
  `src/ledger/export.ts` is read-only (SELECT only, verified by test) and
  ships a manifest per kind — `snapshot` (point-in-time view, not a
  backup), `evidence-package` (full portable record with artifact ownership
  refs), `backup-reference` (manifest describing what backup covers versus
  what export covers). Download over HTTP at `GET /api/ledger/export?kind=`
  (session-gated; `evidence-package` requires admin or owner; add
  `&stream=true` for chunked delivery of large tenants) and audit history
  at `GET /api/audit` (actor/action/date/request/decision filters,
  tenant-isolated, paginated). Omissions are listed in the manifest: users,
  sessions, credentials, raw artifact bytes, external stores, other
  tenants. Every manifest also carries `retention`: operator-managed, no
  automatic expiry — see `SECURITY.md` (Export retention policy).
- Export progress, failure, and retry: `streamExportLedger` accepts
  `onProgress` (start/batch/complete per section plus a terminal export
  event; totals arrive with `complete` because reads are paged). The CLI
  surfaces this via `report --manifest <kind> --out <file>` (progress on
  stderr, manifest on stdout). Partial-failure tracking across sections is
  available through `createExportTracker` (in-progress / partial-failure /
  failed / completed / expired).
- Archival delivery: only a byte-compared read-back counts as delivered.
  `verifyArchivalDelivery` in `src/ledger/export.ts` (CLI:
  `verify --archival <file>`) reports `verified` / `missing` /
  `mismatch` / `error`, and `unconfigured` when no bucket is set — never
  success without a hash match.
- Ledger-history import is unsupported: history is append-only and merging
  two histories is not offered (no `importLedger` entry point exists).
  Audit investigation uses `queryAudit` (actor, action, date, request,
  decision; tenant-isolated, paginated) and `auditLinks` (evidence /
  authorization / receipt / outcome) in the same module.
- Erasure receipts: `vital verify --erasure-receipt <slug>` (operator) and
  `GET /api/erasure/receipt?slug=` (browser, admin or owner) re-check the
  surviving receipt and its durable export file on demand.

## Pilot and contact path

Engagement is a direct pilot scoped to the Ship-to-Result wedge in
`idea.md` §15, with pre-registered metrics and kill criteria agreed before
the pilot starts. Contact is the repo owner directly. There is no hosted
subscription, invoice, or billing flow — do not present the pilot as one.
