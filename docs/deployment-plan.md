# Deployment plan — Vital on AWS (full stack)

Target: the all-AWS topology in `deploy/aws/` (ECS Fargate core + jcode
sidecar, Buzz relay, RDS Postgres ×2, ElastiCache, S3 artifacts + audit,
Lambda executor on SQS, ALB entry). Local smoke: `deploy/compose.yml`.
Production deploys only through `.github/workflows/deploy-aws.yml`
(manual dispatch).

## 0. Ship gates (do not start Phase 1 until all are true)

- [ ] `ci.yml` green on main: typecheck, `npm test`, `test:postgres` lane,
      lint, `format:check`, `docs:check`, provenance, `npm audit`,
      `verify-instance.mjs`, browser test
- [ ] Local Docker E2E green on a clean tree (`deploy/compose.yml` +
      signup → setup → ingest → release → approve → receipt journey)
- [ ] All P0 `flow_TODO.md` items closed with evidence; remaining gaps
      recorded as accepted pilot limitations (MFA, archival-delivery proof,
      restore drill, worker-status display, screen-reader validation)
- [ ] `terraform validate` clean; two consecutive `terraform plan`s with
      zero unexpected diffs

## 1. Pre-deploy fixes (done 2026-09-18 — verify before use)

- `BUZZ_AGENT_MASTER_KEY` + `VITAL_REVIEW_SECRET`: Secrets Manager
  secrets, conditional task-def wiring, `TF_VAR_*` workflow mappings.
  Without them the stack fails closed (no Buzz identity, dead webhook
  approve path) — by design, not by accident.
- Day-0 claiming: `bootstrap_email` (+ `VITAL_BOOTSTRAP_EMAIL` env) and
  `bootstrap_password` / `setup_secret` secrets, all conditional.
  Procedure: set once → claim owner (forced password change) → unset +
  re-apply to rotate. Standing bootstrap credentials are a finding.
- `core_image` / `executor_image` have `validation` blocks: empty fails
  `plan` instead of deploying the old busybox fallback. The deploy
  workflow passes both explicitly.
- `deploy/compose.yml`: vital-core healthcheck quoting fixed (backticks
  under `sh -c` always failed); `VITAL_BOOTSTRAP_EMAIL/PASSWORD`
  pass-through added for the local E2E path.
- Deliberately unchanged: `alb_internal` still defaults `false`
  (throwaway HTTP stacks need it); pilot sets `true` + ACM cert +
  operator secret + confirmed alarm mailbox. `buzz.tf` untouched.

## 2. Prerequisites (one-time, ~1 hour)

1. AWS account, region (`eu-central-1` default). OIDC role for Actions →
   repo secret `AWS_ROLE_TO_ASSUME`; optional `TF_BACKEND_BUCKET` /
   `TF_BACKEND_DYNAMODB_TABLE` (+ vars for key/table overrides).
2. Remote state first: `deploy/aws/bootstrap-state.sh` (bucket +
   lock table, verified consistent with the commented backend block and
   the workflow defaults), uncomment `backend "s3"` in `main.tf`,
   `terraform init -backend-config=...`, then `terraform plan` must show
   no changes.
3. Generate secrets locally, never in git: relay private key (64-char
   hex), agent master key (32+ hex), review secret (16+ chars),
   tenant-hmac/core/webhook secrets, operator secret, Serper/Gemini/
   Novita keys, bootstrap email/password, setup secret → repo secrets
   as `TF_VAR_*` (workflow maps all of them).
4. Domain + ACM certificate for the ALB host and optional
   `buzz_hostname`; decide `nat_per_az` (`false` dev, `true` pilot+).
5. Fill `terraform.tfvars` from the example. Confirm `jcode_image`
   pin (`ghcr.io/1jehuang/jcode:v0.84.0`).
6. Quotas: Fargate vCPU, ElastiCache, RDS.

## 3. Build & push (automated)

`deploy-aws.yml` (manual dispatch): typecheck + tests → build
`Dockerfile.vital-core` (compiled `dist`, no tsx) + `Dockerfile.executor`
→ push immutable `:sha` tags to ECR (scan-on-push) → `terraform apply`.
Verify two fresh images with the same tag; triage scan findings.

## 4. Apply and stabilize

1. Review the plan output; apply; confirm ECS services stable.
2. Workflow smoke runs automatically: `curl /healthz` on the ALB DNS,
   Lambda `dryRun` invoke.
3. Core boots and migrates (`VITAL_MIGRATE_ON_BOOT` is unset on core;
   `=0` is correctly scoped to Lambda only).

## 5. Day-0 provisioning (in order)

1. **Owner**: bootstrap-claim the tenant, force-change the password,
   unset bootstrap values + re-apply, verify invite-only (signup → login
   redirect).
2. **Buzz rooms**: `BUZZ_RELAY_URL=<relay> BUZZ_AGENT_MASTER_KEY=<from
Secrets Manager> node --import tsx scripts/seed-buzz-rooms.ts
--tenant acme` — asserts 12 persisted channel UUIDs, exits non-zero
   otherwise. Prefer `buzz_hostname` over Cloud Map exposure.
3. **Console Buzz workspace**: `/console/buzz` roster, health badges,
   relay status green.
4. **Ingestion**: `ingest-files` against an operator-approved source.
5. **First release**: setup → ingest → start-release → approve →
   decision receipt → export/audit (replay the Docker E2E journey
   against the ALB).

## 6. Verification (E2E-17 + acceptance)

1. `node scripts/verify-topology.mjs --base-url https://<alb>
--email … --password … --expect-ready true` (Host routing,
   `X-Forwarded-Proto` with `TRUST_PROXY=1`, reachability-only pill,
   readiness with DB up).
2. Dependency-loss drill: `--expect-ready false` while `/healthz`
   stays alive (liveness ≠ readiness), then restore.
3. Kill drill: engage stop → team page shows scope/actor/reason/effects
   → affected work held → audited recovery → alarms fire to the
   **confirmed** mailbox (unconfirmed SNS = silently firing).
4. RDS: confirm automated backups + PITR window; schedule the quarterly
   restore-to-scratch drill now.
5. Confirm Object Lock (COMPLIANCE 365d) on the audit bucket and
   public-access blocks on both buckets.

## 7. Cutover, rollback, day-2

- **Cutover**: private ALB first; public only with ACM + operator
  secret + confirmed alarms.
- **Rollback**: immutable tags → redeploy previous `:sha`; keep every
  applied plan file; datastores are never `terraform destroy` targets
  (append-only ledger + PITR).
- **Runbooks** (extend `docs/deployment.md`): incident stop/recover,
  erasure-with-export, secret rotation (new version + re-apply; DB
  password rotation needs RDS + secret sync), relay re-provisioning,
  Lambda DLQ triage.
- **Cost posture** (`eu-central-1`): 2× RDS (t4g.micro, Multi-AZ
  doubles), ElastiCache t4g.micro, Fargate core (2–6) + relay (2) +
  NAT + ALB + S3/CloudWatch. Single NAT + minimum counts for dev.
- **Non-goals** (same list as `flow_TODO.md`): no public signup, no
  multi-org, no hosted billing, no autonomous irreversible external
  action.

## 8. Sequencing

Week 1: §0 gates → Week 2: §2–§4 to a **private** ALB → Week 3: §5–§6
verification + drills → Week 4: public cutover (§7) + first pilot.
