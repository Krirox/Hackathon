# Vital — grounding and reflex layer for production AI agents

> Model output can never mint a FACT.

Vital is a **ledger of claims**, a **scheduler of attention**, and a
**compiler of procedures** for companies that run agents in production.
The spec is `idea.md` (single source of truth). The build checklist is
`TODO.md` (where they disagree, `idea.md` wins).

**What this is:** the runtime that makes agent work grounded (typed claims
with provenance), budgeted (bids, hop limits, escalation caps), attributable
(Context Bundles, replay, signed talk bindings), and safely executable
(R/A/I matrix, quarantine, refusal as a metric).

**What this is not:** a chat app (Buzz exists), a coding agent (jcode
exists), a company operating system pitch, or autonomous external publishing
(never in year 1).

## Why not just use QM directly?

QM is the best-shaped harness we found, and we absorb its best leaf modules
under MIT (see `src/vendor/qm/` + `LICENSE-THIRD-PARTY.md`). But QM has no
typed claim ledger with epistemic guards, no eval-and-attribution spine, no
transfer-testing compiler, and no Decision + Context Bundle replay. We are
the grounding + eval + transfer-testing layer it doesn't have — running
above any harness, including QM's. That is the whole answer, and the only
part of the stack we claim as a moat: the accumulated corpus of claims,
decisions, outcomes, and proven-safe procedures.

## 5-minute boot

Requires Node 22.

```sh
npm install
npm run typecheck   # tsc --noEmit, must be 0 errors
npm test            # tsx test/run.ts — <!-- vital:testcount -->422 tests, real sockets, real sqlite<!-- /vital:testcount -->

# The console is authenticated. Boot it, then claim the tenant in the browser:
tsx src/cli.ts serve --db var/vital.db --tenant acme --port 3100
# → http://127.0.0.1:3100 redirects to /signup while the tenant has no owner.
#   Claiming makes you the owner and signs you straight in; afterwards the
#   console is login-only and membership is invite-only — admins manage the
#   team at /team (invite/disable; invited users must change their password at
#   first login). Raise the approval bar with --approver-role admin|owner, and
#   serve the marketing site from the same process with --site site (the site
#   owns /, the console moves to /console). The site links into this console
#   via <meta name="vital-console-url"> and shows a live pill from GET
#   /api/health.
#
# Headless alternative (CI, scripts): pre-provision from the environment or CLI.
VITAL_BOOTSTRAP_EMAIL=you@acme.test VITAL_BOOTSTRAP_PASSWORD='a-long-password' \
  tsx src/cli.ts serve --db var/vital.db --tenant acme
#   … or: tsx src/cli.ts signup --db var/vital.db --tenant acme \
#          --email you@acme.test --password 'a-long-password'
```

No Postgres, no Buzz, no jcode needed for the suite: tests run against
`node:sqlite` (`:memory:` + temp files) and a scripted harness over real
sockets (`test/fake-harness.ts`).

Browser review regression (separate from `npm test`):

```sh
npx playwright install chromium
npm run test:browser
```

This runs a local in-memory console through login, paginated evidence review,
claim correction/history, approval, decline, and queue refresh. No external
services or customer data are used; browser installation requires a download.

## Finite observation ingestion

`serve` does not automatically run ingestion. To ingest an operator-controlled,
flat directory into the same persistent database:

```sh
npm run dev -- ingest-files --tenant acme --scope engineering --source data/incoming --artifacts var/ingest-artifacts --db var/vital.db --max-receipts 50
```

Create `data/incoming` and place only intended evidence there. Database and artifact
paths must be outside that source directory. This command drains staged receipts,
polls once, and exits with a JSON summary. It makes no model calls, executes no
source content, and writes OBSERVATIONs, never verified facts. Repeat the command
to recover pending work; see [deployment limits and operation](docs/deployment.md#finite-file-ingestion-f04a).

## Layout

```
src/
  core/       types + sqlite driver + dialect helpers + auth (tenants, users, sessions)
  ledger/     Reality Ledger: typed claims, decisions + Context Bundles, outcomes, replay
  coord/      QUERY/REQUEST/NOTICE + scheduler (budget, hops, cycles, escalation cap)
  router/     4-class Cognitive Router (shadow-first, injectable RNG)
  compiler/   Skill Cards: quarantine → shadow → pilot → promoted, transfer tests, drift
  gov/        R/A/I matrix over the vendored ship-gate primitive
  jcode/      harness-API client/protocol/runner (sibling process, our R/A/I answers)
  talk/       TalkSurface bind/verify — the Buzz→Slack swap point
  vendor/qm/  absorbed QM leaf modules, provenance-pinned (governor, ship-gate, crypto, objects)
test/         per-module files + helpers + tiny runner (see test/helpers.ts)
docs/adr/     architecture decisions (0001–0005)
```

## Current state (2026-09-17)

Typecheck clean, suite <!-- vital:testcount -->422/422 green<!-- /vital:testcount -->.
Typecheck clean, suite <!-- vital:testcount -->422/422 green<!-- /vital:testcount -->.
Built: ledger (+decisions/outcomes), coordination (+escalation gate),
router, compiler, gov matrix (trust, honeytasks, kills), eval spine,
attribution, ingest, sensing (Watch Contracts + Integrity Gate), the wedge
loops, jcode connection, talk surface, session-authenticated console
(signup-claim/login/CSRF/lockout/team invite+disable with role
gates/approver-role floor/override capture with session identity/approval
latency/health endpoint — `SECURITY.md`), per-tenant GDPR erasure
(export-first, audited, `vital erase`), a static site wired to the console,
and the four vendored QM modules. Not built: live
Buzz/jcode/production traffic, the remaining auth items in `TODO.md`
V2.1.1 (service tokens, owner-field resolution), GTM. See `TODO.md` "V2
status" — this file's older state lines have rotted before; TODO.md is the
build truth.

## Rules for working here

1. `[x]` means done **and verified by a passing test or run** — never "written".
2. Reading a README is not verification. Verify the identifier (URL, package, SHA), not the name.
3. A green typecheck is not a working system. The only tests that count are ones that talk to something.
4. Never claim a competitor lacks a control we have not confirmed absent.
