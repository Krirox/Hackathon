# Deployment plan — Vital on AWS, from an empty account to a live pilot

This is the ordered, end-to-end playbook for deploying the full Vital stack to
AWS: account prep, Terraform state, secrets, connecting a **Hostinger** domain,
running the deploy, first login, and verification. The authoritative reference
for *why* each piece exists (and what the stack deliberately does not wire) is
`docs/deployment.md` — read it alongside this plan. Terraform lives in
`deploy/aws/`; production deploys go **only** through
`.github/workflows/deploy-aws.yml` (manual dispatch — infra is never a side
effect of a push). `deploy/compose.yml` is for local smoke tests only.

## What you are deploying

```
internet → ALB (TLS terminator, :80 → :443 when a certificate exists)
   ├── ECS Fargate "vital-core" (2–6 tasks, PORT=3100, VITAL_WITH_WORKER=1)
   │     console + webhooks + background worker; sidecar: jcode harness on a
   │     localhost unix socket (coordinated REQUEST/bid path, no ambient creds)
   ├── ECS Fargate "Buzz relay" (chat surface; private via Cloud Map
   │     buzz.vital.local:3000, optionally public at buzz_hostname on the ALB)
   ├── RDS Postgres 16 ×2 — Ledger and Buzz, private subnets, Multi-AZ, PITR
   ├── ElastiCache Redis 7 (Buzz only)
   ├── EFS /var/vital/sandboxes (rebuildable manifests, never trust-bearing)
   ├── S3 ×3 — artifacts (content-addressed), audit (Object Lock COMPLIANCE
   │     365d), buzz-media
   ├── SQS vital-requests → Lambda executor (Firecracker microVM per
   │     invocation, ≤15 min, reserved-concurrency backstop, DLQ after 3×)
   └── CloudWatch alarms (ALB 5xx, Lambda errors, queue age) → SNS ops topic
```

One region (`eu-central-1` by default), one tenant, invite-only. The console
(`/console`) is where humans read and approve; chat (`/console/buzz`) is where
agents and people talk; both ride the same deployment and database.

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
- `deploy/compose.yml`: vital-core healthcheck quoting fixed;
  `VITAL_BOOTSTRAP_EMAIL/PASSWORD` pass-through added for the local E2E path.
- Deliberately unchanged: `alb_internal` still defaults `false`
  (throwaway HTTP stacks need it); pilot sets `true` + ACM cert +
  operator secret + confirmed alarm mailbox. `buzz.tf` untouched.

## 2. Prerequisites (one-time)

1. **AWS account** with administrative access, and the **region decided up
   front** — everything below is single-region (`eu-central-1` default). An
   ALB can only present a certificate from its own region, so a cert made in
   the wrong region presents as a confusing Terraform error, not a region
   mistake.
2. **A domain at Hostinger** (registered there and/or DNS hosted there).
   §5 covers both ways to connect it.
3. **GitHub repo** with `main` protected by `ci.yml`, plus Docker and the
   AWS CLI available locally if you take the from-your-machine path (§6b).
4. **Model/provider API keys**: Novita (production model plane), Gemini
   (development plane), Serper (search).
5. **Quotas**: Fargate vCPU, RDS, ElastiCache in the target region —
   request increases before the pilot if the account is new.

## 3. AWS account + deploy identity (once per account, ~15 min)

Sign in as an account administrator and set the region selector to the target
region before touching anything.

1. **IAM → Identity providers → Add provider → OpenID Connect**: URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
   This is what lets GitHub Actions assume a role with **no long-lived AWS
   keys** in the repo.
2. **IAM → Roles → Create role → Web identity**, same provider, and scope the
   trust policy to this repo and branch:
   `repo:<org>/<repo>:ref:refs/heads/main`.
3. Name it (`vital-github-deploy`), attach a policy, copy the role ARN into
   the repo secret `AWS_ROLE_TO_ASSUME`.

Honesty about that policy: this Terraform creates IAM roles, VPCs, RDS, ECS,
Lambda, S3 and Route 53 records, so in practice the deploying role needs
`AdministratorAccess` for a pilot. Treat `AWS_ROLE_TO_ASSUME` as an admin
credential — anyone who can run `deploy-aws` can change production.

## 4. Terraform remote state (once, ~10 min)

1. Run `sh deploy/aws/bootstrap-state.sh` with AWS credentials in the
   environment. It creates the versioned + encrypted state bucket
   (`vital-tfstate-<account>`) and the `vital-tfstate-locks` DynamoDB table,
   then prints the exact `terraform init` command.
2. Uncomment the `backend "s3"` block in `deploy/aws/main.tf`, run the
   printed `terraform init -backend-config=…` command.
3. `terraform plan` must then show **no changes**. State import of any
   pre-existing resources is a separate, deliberate step — never let init
   create seconds.
4. Record the bucket name for the workflow: repo **secret**
   `TF_BACKEND_BUCKET`, plus repo **variables** `AWS_REGION`,
   `TF_BACKEND_KEY` (default `vital/terraform.tfstate`) and
   `TF_BACKEND_DYNAMODB_TABLE` (default `vital-tfstate-locks`).

## 5. Connect the Hostinger domain (the big manual step)

The domain stays **registered** at Hostinger (registrar and DNS are separate
things). You have two routes; pick one.

### Route A — delegate DNS to Route 53 (recommended; full automation)

Terraform's `dns.tf` only works with a Route 53 hosted zone: with
`domain_name` set it requests the ACM certificate, writes the DNS-validation
CNAMEs itself, waits for issuance, and creates an alias A record to the ALB.
The zone is looked up, never created, so an apply cannot seize a domain's DNS
behind your back.

1. **Route 53 → Hosted zones → Create zone**: public, domain =
   `example.com`. Note the **Hosted zone ID** (`Z…` — that value, not the
   domain name) and the **4 name servers** Route 53 assigns.
2. **Before switching**, recreate in Route 53 any records you actively use on
   Hostinger's DNS — mail `MX` + `SPF`/`DKIM` `TXT` records especially. Once
   nameservers change, Hostinger's DNS panel stops answering and anything
   only configured there disappears.
3. **Hostinger → hPanel → Domains → select domain → Nameservers →
   Change nameservers** → replace `ns1/ns2.hostinger.com` with the four
   Route 53 targets. Delegation typically propagates within minutes to a few
   hours; confirm with `dig NS example.com +short` (or `nslookup`).
4. Set in `terraform.tfvars`:

   ```hcl
   domain_name     = "console.example.com"
   hosted_zone_id  = "Z0123456789ABCDEFGHI"
   # subject_alternative_names = ["www.example.com"]  # each name must live
   #                                                    in that same zone
   ```

5. On apply, Terraform handles certificate issuance and validation
   end-to-end (§7). Nothing else to do in either panel.

If you also want the public Buzz relay (`buzz_hostname =
"buzz.example.com"`), that name **must be on the certificate** — add it to
`subject_alternative_names` (it will validate because it is in the same zone),
or set both to the same zone and let Route A write the records.

### Route B — keep DNS at Hostinger (manual cert, manual records)

Use this when mail/other services must stay on Hostinger DNS. Leave
`domain_name` **empty** so Terraform never writes DNS it does not own
(the supported "domain managed elsewhere" posture), and:

1. **ACM → Request a public certificate** in the *stack's region*, for
   `console.example.com` (+ `buzz.example.com` if used). Choose DNS
   validation and copy the two `_…._acm-challenge` CNAME records into
   Hostinger's DNS zone editor (or use email validation instead).
2. Wait for **Status: Issued** (minutes; stuck at *Pending validation* =
   the CNAMEs aren't resolving yet). Copy the **ARN**.
3. In Hostinger DNS, point the subdomain at the load balancer: record type
   **CNAME**, name `console`, value = `terraform -chdir=deploy/aws output
   -raw alb_dns` (run after the first apply). Do **not** CNAME the apex —
   it collides with MX/TXT records; use a subdomain. No AAAA record: the ALB
   is IPv4-only.
4. Set `acm_certificate_arn = "arn:aws:acm:eu-central-1:…"` in
   `terraform.tfvars`. An explicit ARN wins over a created certificate, so
   this composes cleanly with later Route A changes.

Known wart on this route: with `domain_name` empty, the `console_url`
terraform output stays `http://<alb-dns>`, and once a certificate is attached
port 80 301-redirects to `https://<alb-dns>` — a name no certificate covers —
so the workflow's smoke-check curl can go red on a *healthy* deploy. Verify
the journey through your real hostname in a browser instead, or migrate to
Route A so the stack knows the name it serves.

### Either route — afterwards

- `:80` becomes a 301 to `:443` and tasks start with `SECURE_COOKIES=1`;
  both come from the same flag, so cookie policy cannot drift from the
  listener. `TRUST_PROXY=1` is unconditional (tasks are always behind the ALB).
- Update registered callback URLs at GitHub, Slack and Stripe to the new
  hostname — the ALB fronts webhooks, not just the console.

## 6. Secrets and variables (generate locally, never commit)

Generate strong values for every `TF_VAR_*` below (the relay key is a
secp256k1 private key: 64 hex chars; the agent master key 32+ hex chars; the
review secret 16+ random chars; the rest: long random strings). Then set them
as **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `AWS_ROLE_TO_ASSUME` | OIDC role from §3 (not a `TF_VAR_*`) |
| `TF_VAR_TENANT_HMAC_SECRET` | signs the talk surface — required, no placeholder passes |
| `TF_VAR_VITAL_CORE_SECRET` | mints scope tokens — required |
| `TF_VAR_WEBHOOK_SECRET` | authenticates webhook intake — required |
| `TF_VAR_SERPER_API_KEY` / `TF_VAR_GEMINI_API_KEY` / `TF_VAR_NOVITA_API_KEY` | search + model planes — required |
| `TF_VAR_OPERATOR_SECRET` | gates console mutations; empty = ungated (dev only) |
| `TF_VAR_BUZZ_RELAY_PRIVATE_KEY` | relay identity (64 hex) |
| `TF_VAR_BUZZ_AGENT_MASTER_KEY` | 32+ hex; empty = no publishing identity |
| `TF_VAR_VITAL_REVIEW_SECRET` | 16+ chars; empty = dead webhook-approve path |
| `TF_VAR_BOOTSTRAP_EMAIL` / `TF_VAR_BOOTSTRAP_PASSWORD` | day-0 owner (§8) |
| `TF_VAR_SETUP_SECRET` | web-claim authorization on a public bind |
| `TF_BACKEND_BUCKET` | state bucket from §4; empty = local state |

The six "required" values fail `terraform validate` when empty or left as the
literal placeholder (`CHANGEME`), so a half-configured deploy stops at plan
instead of shipping a known HMAC secret or a dead model plane.

Copy `deploy/aws/terraform.tfvars.example` → `terraform.tfvars` and fill in
the non-secret values: instance sizes, capacity, `nat_per_az` (`false` dev,
`true` pilot+), `ops_alarm_email` (a mailbox you actually read — see §9),
`alb_internal = true` for the private-first posture, and the `jcode_image`
pin (`ghcr.io/1jehuang/jcode:v0.84.0`).

## 7. Build, push, apply

### 7a. Via GitHub Actions (the supported path)

**Actions → deploy-aws → Run workflow →** branch `main` (optional
`image_tag`). The job runs, in order:

1. typecheck → `npm test` → `test:postgres` against a live postgres:16
   service (the engine being deployed, not just sqlite);
2. assumes the OIDC role, creates/reuses ECR repos `vital-core` /
   `vital-executor` (immutable tags, scan-on-push);
3. builds `Dockerfile.vital-core` (compiled `dist`, no tsx) +
   `Dockerfile.executor` and pushes `:<sha>` tags;
4. `terraform init` (remote backend) + `apply -auto-approve` with fresh
   image URIs and every `TF_VAR_*` mapped; with Route A configured in §5,
   this is where the certificate is requested, validated in the zone, and
   the alias record is written;
5. waits for ECS stability, probes `/healthz` at `console_url`, and invokes
   the Lambda executor with `{"dryRun":true}` (non-billable).

Green means: infra applied, service stable, ALB routes to a live task,
Lambda answered. It does **not** mean mail works or model jobs succeed.

### 7b. From your machine (first pilot or throwaway stack)

Order matters — both image variables are validated non-empty and the busybox
fallback is gone, so: **create repos → push → apply**, never apply-then-push.

```sh
cd deploy/aws
sh bootstrap-state.sh                     # if §4 not done yet
# terraform init -backend-config=…       # the exact command it prints

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-central-1
for r in vital-core vital-executor; do
  aws ecr describe-repositories --repository-names "$r" >/dev/null 2>&1 || \
    aws ecr create-repository --repository-name "$r" \
      --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true
done
docker build -f Dockerfile.vital-core -t "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot" ../..
docker push   "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot"
docker build -f Dockerfile.executor  -t "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot" ../..
docker push   "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot"

# pass secrets as TF_VAR_* env vars (not flags) so they stay out of history
terraform plan  -var "core_image=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-core:boot" \
                -var "executor_image=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/vital-executor:boot"
terraform apply -var "core_image=…" -var "executor_image=…"
terraform output        # console_url, alb_dns, alb_zone_id, cluster_name, …
```

### 7c. If the smoke check goes red

| Symptom | Likely cause / fix |
| --- | --- |
| TLS verification failed on `/healthz` | cert added by hand but the stack doesn't know the hostname — see Route A vs Route B in §5 |
| `services-stable` times out | ECS → Clusters → `vital` → Services → `vital-core` → **Events** shows the stopped-task reason |
| `/healthz` 503 after stability | task up but not answering on 3100 — check `/vital/core` in CloudWatch Logs |
| `core_image must be a real ECR URI` | images weren't pushed before apply — see §7b order |
| Cert stuck `PENDING_VALIDATION` | §5 validation records not in the *delegated* zone (dig them to confirm) |

## 8. Day-0 provisioning (in order, once `console_url` is live)

1. **Liveness**: `curl -sS <console_url>/healthz` → `{"ok":true}` —
   reachability only; readiness is a different question (§9).
2. **Owner**: sign in at `<console_url>/login` with the bootstrap
   email/password (they seed the first owner **at boot** — no claim URL),
   accept the forced password change, then **delete**
   `TF_VAR_BOOTSTRAP_EMAIL`/`TF_VAR_BOOTSTRAP_PASSWORD` and re-run the
   deploy: leaving them live means every empty database reseeds the same
   known owner. Verify invite-only still holds (signup redirects to login).
   Alternative: skip bootstrap creds entirely and use `setup_secret` as the
   web-claim authorization at signup.
3. **Activate the tenant**: the rail's **Setup** page (`/setup`) walks the
   accountable scope, evidence source, policy, and budget.
4. **Buzz rooms**:

   ```sh
   BUZZ_RELAY_URL=<relay> BUZZ_AGENT_MASTER_KEY=<from Secrets Manager> \
     node --import tsx scripts/seed-buzz-rooms.ts --tenant acme
   ```

   Asserts 12 persisted channel UUIDs, exits non-zero otherwise. Then check
   `/console/buzz`: roster, health badges, relay status green.
5. **Ingestion**: `ingest-files` against an operator-approved source
   (bounded, explicit — see `docs/deployment.md` F04a).
6. **First release**: replay the Docker E2E journey against the real
   deployment — setup → ingest → start-release → approve → decision receipt
   → export/audit.

## 9. Verification and drills (before announcing the pilot)

1. `node scripts/verify-topology.mjs --base-url <console_url> --email …
   --password … --expect-ready true` — Host routing,
   `X-Forwarded-Proto` with `TRUST_PROXY=1`, reachability-only pill,
   readiness with DB up.
2. **Dependency-loss drill**: `--expect-ready false` while `/healthz` stays
   alive (liveness ≠ readiness), then restore.
3. **Kill drill**: engage stop → team page shows scope/actor/reason/effects
   → affected work held → audited recovery → alarms actually arrive at the
   **confirmed** mailbox (AWS sends an SNS confirmation email on apply;
   unconfirmed = formally firing, factually silent).
4. **RDS**: automated backups + 7-day PITR window confirmed; schedule the
   quarterly restore-to-scratch drill *now* (procedure in
   `docs/deployment.md`).
5. **S3**: Object Lock (COMPLIANCE 365d) on the audit bucket and
   public-access blocks on all buckets.

## 10. Cutover, rollback, day-2

- **Cutover**: private ALB first (`alb_internal = true`); go public only
  with ACM cert + operator secret + confirmed alarm mailbox in place.
- **Rollback**: immutable `:sha` tags → redeploy the previous one; keep every
  applied plan file. Datastores are **never** `terraform destroy` targets
  (append-only ledger + PITR).
- **Runbooks** (extend `docs/deployment.md`): incident stop/recover,
  erasure-with-export, secret rotation (new secret version + re-apply; DB
  password rotation needs RDS + secret sync), relay re-provisioning,
  Lambda DLQ triage.
- **Cost posture** (`eu-central-1`): 2× RDS t4g.micro (Multi-AZ doubles it),
  ElastiCache t4g.micro, Fargate core (2–6) + relay (2) + NAT + ALB +
  S3/CloudWatch. Single NAT + minimum counts for dev.
- **Non-goals** (same list as `flow_TODO.md`): no public signup, no
  multi-org, no hosted billing, no autonomous irreversible external action.

## 11. Sequencing

Week 1: §0 gates → Week 2: §3–§7 to a **private** ALB → Week 3: §8–§9
provisioning, verification, drills → Week 4: public cutover (§10) + first
pilot.
