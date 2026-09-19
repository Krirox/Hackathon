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
Without it, Buzz stays reachable inside the VPC via Cloud Map only. That name
must be on the ALB certificate — see "Domain and TLS" below.
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
3. Run the `deploy-aws` workflow (see *Deploy — GitHub Actions* below). A local
   `terraform apply` works too, but the images must exist first: `core_image` and
   `executor_image` are validated as non-empty ECR URIs and the busybox fallback
   is gone, so the order is **create the repositories → push → apply**, not
   apply-then-push.

## AWS console walkthrough — entry point, deploy, connect

This is the part the Terraform cannot do for you (or cannot do alone): the AWS
account, the certificate authority, the secrets, and the first login. Work it in
this order — each step consumes something the previous one produced.

1. Account prerequisites and the deploy identity (§1)
2. Domain + certificate (§2)
3. Images and the apply (*Deploy* — GitHub Actions, or from your machine)
4. First login (*Connect — first login*)

### 1. Account prerequisites

Sign in as an account administrator, then **set the region selector (top right)
to `eu-central-1`** before touching anything. Vital is single-region by design
(`var.region`), and an ALB can only present a certificate from its own region — a
certificate requested while the console is pointed somewhere else cannot be
attached, and it presents as a confusing Terraform error rather than a region
mistake.

Create the deploy identity (once per account, not per deploy):

1. **IAM → Identity providers → Add provider → OpenID Connect.** Provider URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
   This is what lets GitHub Actions assume a role with no long-lived AWS keys
   stored in the repository.
2. **IAM → Roles → Create role → Web identity**, select that provider, audience
   `sts.amazonaws.com`, and scope the trust policy to this repository and branch:
   `repo:<org>/<repo>:ref:refs/heads/main`.
3. Name it (`vital-github-deploy` is as good as any), attach a policy, and copy
   the role ARN into the repository secret `AWS_ROLE_TO_ASSUME`.

**On that policy, honestly:** this Terraform creates IAM roles, VPCs, RDS
instances, ECS services, Lambda functions, S3 buckets and Route 53 records, so
the deploying principal must be broad — in practice `AdministratorAccess` for a
pilot. Treat `AWS_ROLE_TO_ASSUME` as an admin credential: anyone able to run the
`deploy-aws` workflow can change production infrastructure. Scope it later by
narrowing what the workflow can do, not by hoping a small policy suffices.

### 2. Domain + certificate by hand in the console

Terraform can do both of these (see the reference section below — that is the
supported path). Do it by hand when the certificate already exists, when the DNS
lives at another provider, or when you want to see the objects before letting
Terraform manage them.

**Request the certificate (ACM).**

1. Console search → **Certificate Manager**. Confirm the region is
   `eu-central-1`.
2. **Request a certificate → Request a public certificate → Next.**
3. Fully qualified domain name: `console.example.com`. Add `www.example.com` in
   *Add another name to this certificate* only if you want it — every name added
   here must live in the zone you own (see the certificate-coverage note below).
4. Validation method: **DNS validation**. Key algorithm: leave the default
   (RSA 2048). **Request.**
5. Open the certificate and use **Domains → Create records in Route 53** — ACM
   writes the validation CNAME(s) itself when the zone is in this account. If the
   zone is elsewhere, copy each CNAME/value pair into your provider and come back
   once they resolve.
6. Wait for **Status: Issued** (minutes, not hours — if it sits at *Pending
   validation*, the CNAME is not resolving yet). Copy the **ARN**.

**Point the name at the ALB (Route 53).**

1. **Route 53 → Hosted zones →** your domain. The **Hosted zone ID** column
   holds the `Z…` value that `hosted_zone_id` wants.
2. **Create record.**
3. Record name `console` (the console appends the zone: `console.example.com`).
   Record type **A**.
4. Turn **Alias** on, then **Route traffic to → Alias to Application and Classic
   Load Balancer →** region `eu-central-1` → select the ALB, named
   `vital-alb` (or `<project>-alb`).
5. **Create records.**

Then hand the ARN to the stack — `acm_certificate_arn = "arn:aws:acm:eu-central-1:..."
in `terraform.tfvars`, or the two-variable Terraform path above — and apply. The
listener changes are automatic: `:80` becomes a `301` to `:443` and the task
starts with `SECURE_COOKIES=1`. Confirm with
`terraform -chdir=deploy/aws output -raw console_url`.

Do **not** add an AAAA record to match. The ALB is IPv4-only, so an AAAA alias
answers with nothing; set `ip_address_type = "dualstack"` on the ALB first if you
genuinely need IPv6.

## Domain and TLS (Route 53 + ACM)

A domain is a DNS record pointing at the ALB — there is no instance to attach it
to. Everything in this section is optional, and it is owned by
`deploy/aws/dns.tf`: with `domain_name` empty, `terraform plan` is identical to a
stack that never had a domain.

**Two routes, and they compose** — pick one:

| Route | Use when |
| --- | --- |
| `domain_name` + `hosted_zone_id` | Terraform should create the certificate, validate it by DNS, and alias the name to the ALB |
| `acm_certificate_arn` | You already hold a validated certificate (another account, another region, hand-validated) |

Set both and the explicit ARN wins for the certificate while the DNS records are
still created: naming the host and holding the certificate are independent
decisions.

Set the inputs in `terraform.tfvars`:

```hcl
domain_name    = "console.example.com"
hosted_zone_id = "Z0123456789ABCDEFGHI"   # the Z… zone id, not the domain name
# subject_alternative_names = ["www.example.com"]   # must live in that same zone
```

`aws route53 list-hosted-zones --query 'HostedZones[].{Id:Id,Name:Name}'` prints
the zone id. Then apply:

1. The certificate is requested in `var.region` (an ALB can only present a
   certificate from its own region — a `us-east-1` cert is only for CloudFront).
2. ACM's validation records are written into the zone and Terraform waits until
   ACM has actually seen them, because an ALB cannot attach a certificate that is
   still `PENDING_VALIDATION`.
3. An alias A record points `domain_name` at the ALB.

The zone is **looked up, never created**, so an apply cannot take over a domain's
DNS and records this stack does not manage are untouched.

Why an alias and not a CNAME: alias records are legal at the apex (`example.com`,
where a CNAME is not), are free to query, and follow the ALB if AWS moves its
addresses. No AAAA record is created — the ALB is IPv4-only, and an AAAA alias to
a single-stack ALB answers with nothing.

Confirm the result with `terraform output console_url`. `terraform output
alb_zone_id` is the ALB's own hosted zone id — what Route 53 needs alongside
`alb_dns` to build the alias target. The record in `dns.tf` reads it directly;
the output exists for DNS managed outside this stack, and for anything else that
aliases the ALB.

### The certificate must cover every name you serve

`var.buzz_hostname` (the public Buzz relay) rides the same ALB, so that name has
to be on the certificate — put it in `subject_alternative_names`, or supply an
`acm_certificate_arn` that already covers it. A hostname in a different zone will
not validate: every validation record is written to the single zone looked up
above.

### Secure cookies follow the listener, not a checklist

Attaching a certificate flips port 80 to an HTTPS redirect *and* runs the task
with `SECURE_COOKIES=1`, so the session cookie carries `Secure` and cannot ride a
plaintext `http://` downgrade. Both come from the same flag that decides whether
the HTTPS listener exists, so the cookie policy cannot drift from the listener it
is protecting. `TRUST_PROXY=1` is set unconditionally — the task is always behind
the ALB.

Outside AWS, the equivalent is `--secure-cookies` (or `SECURE_COOKIES=1`). It is
deliberately separate from `--trust-proxy`: trusting proxy headers and requiring
TLS are independent decisions, and a loopback or TLS-terminating dev setup wants
the first without the second.

### Update every callback URL

The ALB fronts the webhooks, not just the console. After switching domains, update
the registered callback URLs at GitHub, Slack and Stripe, or they keep firing at
the old one.

### If the domain is managed elsewhere

Point a CNAME (or the registrar's ALIAS/ANAME at an apex) at `terraform output
alb_dns`, and validate the certificate however that provider allows. Leave
`domain_name` empty so Terraform never tries to write DNS it does not own.

## Deploy — GitHub Actions (the supported path)

`.github/workflows/deploy-aws.yml` builds both images, pushes them to ECR,
applies Terraform, and smoke-checks the result. It is **manual dispatch only** —
infrastructure is never a side effect of a test push.

### Set the repository secrets once

GitHub → repo → **Settings → Secrets and variables → Actions**.

*Secrets* (New repository secret). Everything except the first is a `TF_VAR_*`:

| Secret | What it is |
| --- | --- |
| `AWS_ROLE_TO_ASSUME` | the OIDC role ARN from §1 — not a `TF_VAR_*` |
| `TF_VAR_TENANT_HMAC_SECRET` | signs the talk surface. Required; no placeholder passes |
| `TF_VAR_VITAL_CORE_SECRET` | mints scope tokens. Required |
| `TF_VAR_WEBHOOK_SECRET` | authenticates webhook intake. Required |
| `TF_VAR_SERPER_API_KEY` | search. Required |
| `TF_VAR_GEMINI_API_KEY` | development-model plane. Required |
| `TF_VAR_NOVITA_API_KEY` | production-model plane. Required |
| `TF_VAR_OPERATOR_SECRET` | gates console mutations; empty = ungated (dev only) |
| `TF_VAR_BUZZ_RELAY_PRIVATE_KEY` | secp256k1 relay key, 64 hex chars |
| `TF_VAR_BUZZ_AGENT_MASTER_KEY` | 32+ hex chars; empty = no publishing identity |
| `TF_VAR_VITAL_REVIEW_SECRET` | 16+ random chars; empty = dead webhook-approve path |
| `TF_VAR_BOOTSTRAP_EMAIL` | day-0 owner address (§ Connect) |
| `TF_VAR_BOOTSTRAP_PASSWORD` | day-0 owner password (§ Connect) |
| `TF_VAR_SETUP_SECRET` | web-claim authorization on a public bind |
| `TF_BACKEND_BUCKET` | state bucket from `bootstrap-state.sh`; empty = local state |

The six "Required" values fail validation when empty or left as the literal
placeholder, so a half-filled deploy stops at `terraform plan` instead of
shipping a known HMAC secret or a model plane that cannot run. Requirements
first, placeholders never.

*Variables* (New repository variable): `AWS_REGION` (`eu-central-1`),
`TF_BACKEND_KEY` (default `vital/terraform.tfstate`),
`TF_BACKEND_DYNAMODB_TABLE` (default `vital-tfstate-locks`).

### Run it

**Actions → deploy-aws → Run workflow →** branch `main` → *optional* `image_tag`
→ **Run workflow**.

In order the job: typechecks → runs the test suite → assumes the OIDC role → logs
in to ECR → creates or reuses the `vital-core` and `vital-executor`
repositories → builds and pushes both images (immutable tags, scan on push) →
`terraform init` + `terraform apply` with the fresh image URIs → waits for ECS
stability, probes `/healthz`, and invokes the executor in dry-run mode.

Green means infrastructure applied, the service is stable, the ALB routes to a
live task, and the Lambda answered. It does **not** mean mail works or model jobs
succeed — keys, DNS and the first login are still yours to confirm.

### When the smoke check goes red

| Symptom | Likely cause |
| --- | --- |
| TLS verification failed on `/healthz` | the probe uses `console_url`; if the certificate was added by hand and covers your hostname, put it in the stack (`domain_name` or `acm_certificate_arn`) so the output names that host |
| `services-stable` times out | ECS → Clusters → `vital` → Services → `vital-core` → **Events** shows the stopped-task reason |
| `/healthz` 503 after stability | task is up but not answering on 3100 — check `/vital/core` in CloudWatch Logs |
| `core_image must be a real ECR URI` | the image variables are validated; see the local path below for the create → push → apply order |

## Deploy — from your machine

Fine for a first pilot or a throwaway stack; remote state is still recommended.

```sh
cd deploy/aws
sh bootstrap-state.sh        # versioned + encrypted state bucket, lock table
# uncomment the backend block in main.tf using the values it prints, then:
terraform init -backend-config=...   # the exact command the script prints
```

Create the repositories before anything references an image — both image
variables are validated as non-empty, so the order is create → push → apply:

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-central-1
for r in vital-core vital-executor; do
  aws ecr describe-repositories --repository-names "$r" >/dev/null 2>&1 || \
    aws ecr create-repository --repository-name "$r" \
      --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true
done
docker build -f Dockerfile.vital-core -t "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot" ../..
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot"
docker build -f Dockerfile.executor  -t "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot" ../..
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot"
```

Then apply, passing the image URIs — and the required secrets, which as
`TF_VAR_*` environment variables rather than flags so they stay out of shell
history:

```sh
terraform plan  -var "core_image=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot" \
                -var "executor_image=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot"
terraform apply -var "core_image=..." -var "executor_image=..."
terraform output          # console_url, alb_dns, alb_zone_id, cluster_name, ...
```

## Connect — first login

1. **Entry point:** `terraform -chdir=deploy/aws output -raw console_url`.
2. **Liveness:** `curl -sS <entry>/healthz` → `{"ok":true}`. This is a
   reachability answer only — see the liveness-vs-readiness rule below.
3. **Sign in** at `<entry>/login` with the `bootstrap_email` /
   `bootstrap_password` you set. Those two seed the tenant's first owner **at
   boot**, so the account exists as soon as the task starts; there is no claim
   URL to visit first, and the first sign-in forces a password change.
4. **Prefer claiming in the browser?** Leave the bootstrap pair unset and set
   `setup_secret`: on a public bind the setup authorization is then required
   before signup is accepted.
5. **Rotate the day-0 credentials.** Remove `TF_VAR_BOOTSTRAP_EMAIL` /
   `TF_VAR_BOOTSTRAP_PASSWORD` and re-apply. Leaving them live means every empty
   database gets seeded with the same known owner again.
6. **Then use it.** The rail's **Setup** page (`/setup`) is the activation flow
   (accountable scope, evidence source, policy, budget). A fresh stack shows an
   empty review queue because nothing has been proposed yet.

Two surfaces, one deployment, one database: the **console** is where humans read
and approve, the **chat** is where agents and people talk. A new stack starts
there, not in either UI's seed data.

## What this stack deliberately does not wire

So you don't hunt for a switch that is not there:

- **The coding-plane drivers are honest dry-runs.** `VITAL_FARGATE_CLUSTER` and
  `VITAL_FARGATE_TASKDEF` are unset on purpose — `fargateConfig()` reads the
  cluster variable as "is AWS wired?", so setting it makes the driver report an
  ECS task ARN it never created (there is no `RunTask` call, and the task role has
  no `ecs:RunTask` to make one). `VITAL_VM_BACKEND` is unset too, resolving to
  `local`: process-level directory isolation, not a microVM boundary.
  `VITAL_LAMBDA_FUNCTION` *is* set, only so audit records name an executor that
  exists rather than the built-in `vital-coding-executor` phantom.
- **Snapshots live on EFS, not S3.** `VITAL_SNAPSHOT_DIR` points at the mounted
  sandbox volume (the default is `data/snapshots` relative to the container's
  working directory, which would be wiped by the next deploy). The store's S3
  backend signs with explicit env credentials while Fargate issues task-role
  credentials through IMDS, so `VITAL_SNAPSHOT_BUCKET` would fail signing rather
  than persist anything.
- **GitHub sync and mail are dormant.** `GITHUB_TOKEN`, `STRIPE_*`, `SMTP_URL`
  and `VITAL_MAILER_ENABLED` are not set, so those integrations stay off until
  you wire them.
- **The jcode split is staged, not live** (`jcode_target = "socket"`): the
  sidecar shares the core task because `JcodeClient` only speaks a socket path.
- **The Buzz relay's public hostname needs a certificate that covers it.**
  `buzz_hostname` without SANs (or a supplied cert) puts the listener rule on the
  HTTPS listener and the browser rejects the name — set both or neither.
- **The workflow assumes `project = "vital"`.** Repository, cluster and smoke
  check names are `vital-core`, `vital-executor`, `vital`. Renaming the project
  means editing `.github/workflows/deploy-aws.yml` as well.

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
