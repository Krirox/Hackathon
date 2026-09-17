# Security — threat model and current controls

## Threat model (what can actually hurt us)

1. **The agent acts as a person, with their credentials, and reads the open
   web.** A poisoned result is a persistent foothold — especially with
   durable sandboxes where installed tools stay installed.
2. **Two different injection problems.** (a) A harness signed into tools can
   be *prompt-injected* into mis-acting. (b) A world model feeding strategy
   can be *poisoned to steer the company* (fake pricing page, seeded repo,
   astroturfed thread). Only (b) has a competitor deliberately attacking it.
   Keep the defences scoped accordingly.
3. **Durable state as a foothold.** Anything persisted (sandbox files,
   memory graphs, ledger rows) outlives the turn that wrote it.
4. **Rubber-stamp oversight.** A human approving 200 items a day is a
   bottleneck with a signature, not a control.
5. **Silent degradation.** Compiled procedures rot across teams; routing
   drifts; facts go stale without anyone feeling it.

## Current controls (mapped to code, not wishes)

- **Epistemic guard** (`src/ledger/ledger.ts`, I1/I2): model output can
  never mint FACT/MEASUREMENT/OUTCOME; adversarially tested across all 11
  kinds. External text enters as quoted data with a provenance tier, never
  as ground truth.
- **Deterministic refusal gates** (`src/jcode/runner.ts`,
  `src/gov/raci.ts`): writes need human approval, which agents cannot
  self-give; denials are Ledger events. `ACT_IRREVERSIBLE` is human-command,
  always — no autonomy path exists in the matrix.
- **Blast-radius caps** (`src/coord/coordinator.ts`): hop limit 3, cycle
  detection, idempotency dedupe, per-request and daily budgets with loud
  budget death, 3/day human-escalation cap that BLOCKS.
- **Harness crash isolation** (`src/jcode/client.ts`): error frames reject,
  never kill the process; permission/cancel round-trips are drained before
  the socket closes.
- **Quarantine and demotion** (`src/compiler/compiler.ts`,
  `src/vendor/qm/governor.ts`): imported packs enter at QUARANTINE,
  transfer tests gate promotion, drift auto-demotes, loops quarantine on
  consecutive failures or undeclared ship actions.
- **Talk binding integrity** (`src/talk/surface.ts`): claim ↔ envelope
  binding is tamper-evident; tampering fails loudly.
- **Human-surface authentication** (`src/core/auth.ts`,
  `src/console/serve.ts`): the console is session-gated — no session, no
  page, no approval. Passwords are salted scrypt with a 12-char floor;
  sessions are DB-backed, rolling, revocable, swept, and carried only in
  HttpOnly SameSite cookies; every state-changing POST is CSRF-checked
  (session tokens in-session, double-submit cookies on login/signup);
  approvals are named by the session identity, never a request body; login
  locks after 5 failures per (tenant, ip, email) and is rate-limited per
  source; signup/login/logout/reset land in `audit_log`. Tenant scoping is
  fixed at login and re-checked per request. Provisioning: a fresh console
  is unprovisioned — /signup claims its ONE bound tenant (env credentials
  can pre-provision headlessly), signup closes permanently once an owner
  exists, and membership is invite-only thereafter. Team management is
  role-gated: /team invite and disable require admin+, an admin cannot
  disable an owner or themselves, disabled users' sessions die instantly,
  and invited users are forced to change their password at first login.
  Approvals additionally honor a configurable minimum role
  (`--approver-role`, default `member`). Per-tenant GDPR erasure
  (`src/core/erasure.ts`) is export-first — the portable record and the
  deletion commit or roll back together — complete by store introspection
  (a future tenant-scoped table that skips erasure fails the test suite),
  kills live sessions with the deleted users, and leaves a receipt under
  `erased:<tenant>` naming the operator and the row counts. No seeded default
  credential exists anywhere.

## Explicitly not yet built (do not claim these)

TLS termination and hardened deployment (the console binds loopback; put a
reverse proxy in front for HTTPS — `Secure` cookies are wired via
`secureCookies`), outbound email (password-reset tokens are issued through
the CLI/API — there is no mailer), rate limiting beyond the per-source
login/signup/health caps (per-instance in-process buckets — no shared-store
limiting across replicas, and no trusted-XFF parsing yet), DB-level tenant
separation (tenants are isolated in every query path and tested at the auth
layer; no storage/index-level enforcement yet), PII classification, data
residency, SOC 2 path. See `TODO.md` V2 backlog.

## Reporting

Security issues: contact the repo owner directly (no public issue). Include
the claim/decision/request IDs if the report concerns ledger integrity —
replayability cuts both ways.
