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
npm test            # tsx test/run.ts — <!-- vital:testcount -->193 tests, real sockets, real sqlite<!-- /vital:testcount -->
```

No Postgres, no Buzz, no jcode needed for the suite: tests run against
`node:sqlite` (`:memory:` + temp files) and a scripted harness over real
sockets (`test/fake-harness.ts`).

## Layout

```
src/
  core/       types + sqlite driver + engine-dialect JSON helpers
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

## Current state (2026-09-11)

Typecheck clean, suite <!-- vital:testcount -->193/193 green<!-- /vital:testcount -->.
Built (per `TODO.md` "V2 status"): ledger+decisions+replay+export · coord+
decompose+escalation gate · router+registry+calibration · compiler+mining+
registry+trustTier · gov (matrix/trust/honey/kill/sample/batch/shell/act/
limits) · evals · attrib · ingest (file/github/serper) · sense (contracts/
materiality/integrity/poisoning) · wedge (ship/churn/feature/deepresearch)
· talk · substrate (scheduler/sandbox/egress/screen/identity/2 adapters) ·
capabilities · vendor/qm ×7. Not built: production surface (live
Buzz/jcode/Postgres, approval rooms), pilot traffic, GTM — the V2 backlog
in `TODO.md` is the only list that matters now.
Re-estimate recorded in `TODO.md` §0.5: ~18–23 weeks solo to the first
instrumented loop, not ~8.

## Rules for working here

1. `[x]` means done **and verified by a passing test or run** — never "written".
2. Reading a README is not verification. Verify the identifier (URL, package, SHA), not the name.
3. A green typecheck is not a working system. The only tests that count are ones that talk to something.
4. Never claim a competitor lacks a control we have not confirmed absent.
