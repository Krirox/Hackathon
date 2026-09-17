# Deployment — the one supported topology

Reference (production on AWS): **ECS vital-core + jcode sidecar · RDS Postgres ·
Lambda executor microVMs · ALB entry** (`deploy/aws/` Terraform — the only
supported production path). Legacy VPS shape it replaces: VPS-1 Buzz · VPS-2
Vital core + Postgres · VPS-3 jcode (sibling process over the harness API).
Dev approximation: `deploy/compose.yml` (Buzz + core + Postgres on one box).

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

## Postgres (VPS-2)

- The schema is derived, never maintained twice: `PG_SCHEMA` is the one
  SCHEMA translated (`AUTOINCREMENT` → `BIGSERIAL`), verified identical in
  CI. Migrations: `migratePostgres` + additive journal; version stamped.
- **PITR is on.** RDS: automated backups with a 7-day (min) retention
  window before any pilot data lands; Cloud SQL: point-in-time recovery
  enabled at instance creation. Verify with a restore drill to a scratch
  instance quarterly — an untested backup is a UI element, like the kill
  switch. Ledger export (`exportLedger`) is the portable second copy, not
  the backup strategy.
- `DATABASE_URL=postgres://…` selects the PG driver at runtime
  (`openFromEnv`); anything else stays sqlite. CI boots a postgres:16
  service and runs `verify-instance` against it on every push.

## Boot check

`npm run typecheck && npm test && npm run lint` green, then
`tsx src/cli.ts status --db var/vital.db`. A stranger boots the dev
topology from this file plus `README.md` in under 30 minutes (Phase 0
exit gate — not yet timed; time it before claiming it).

## AWS (production)

All-AWS, Terraform in `deploy/aws/` (`main.tf` · `variables.tf` ·
`outputs.tf`; example values in `terraform.tfvars.example` — never commit
real secrets, CI supplies every `TF_VAR_*`).

```
internet → ALB ──→ ECS Fargate vital-core (HOST=0.0.0.0, PORT=3100)
   webhooks, console, Slack-HMAC fallback all ride the ALB     │
         ┌─────────────────────────────────────────────────────┘
         │  sidecar: jcode harness API on /run/jcode-api.sock (localhost —
         │  the same coordinated REQUEST/bid path as src/jcode/runner.ts)
         ├── RDS Postgres 16 (Multi-AZ, PITR 7d, private subnets)
         ├── EFS /var/vital/sandboxes (rebuildable manifests, never trust-bearing)
         ├── S3 artifacts (content-addressed) + S3 audit (Object Lock 365d,
         │   separate from the Ledger — idea.md §12)
         └── SQS vital-requests ──→ Lambda executor (container image,
             Firecracker microVM per invocation, 10 GB ephemeral, ≤15 min,
             reserved concurrency = infra budget-death backstop, DLQ after 3×)
```

Why this shape, per Vital's own rules:

- **Lambda = microVMs, honestly.** Lambda already runs each invocation in a
  Firecracker microVM — that *is* the "coding agent lambda microvm" idea,
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
effect of a test push). It typechecks + tests, builds both images,
pushes to ECR (immutable tags, scan-on-push, keep-last-20), runs
`terraform apply` with the fresh image URIs, then smoke-checks
`http://<alb>/api/approval-latency`. First-time bootstrap: `terraform apply`
once with empty image vars to create the ECR repos, then run the workflow.
