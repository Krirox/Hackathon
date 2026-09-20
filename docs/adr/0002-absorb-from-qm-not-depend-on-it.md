# ADR 0002 — Absorb from QM, do not depend on it (replaces the fork plan)

Status: accepted · 2026-09-09 · Supersedes: any private-fork packaging discussion

## Context

QM (`yc-software/qm`, MIT) proved the scoped-agent shape and ships policy
code worth reusing (loop governor, ship gate, idempotency, command policy).
Running Vital _on_ QM would make us a deployment layer with fork/sync/drift
discipline; absorbing its substrate (sandboxes, scheduler, egress proxy,
harnesses, Slack/E2B/Modal/AWS deps) would make us a fork, not a startup.

## Decision

Vital is its own package and repo. We vendor **leaf modules only** under
`src/vendor/qm/`, each with a provenance header (URL, SHA, date, upstream
path, what changed and why), recorded in `LICENSE-THIRD-PARTY.md`. We copy
_designs_ (egress policy, skill-registry shape, security-screen contract)
and build the substrate ourselves.

## Consequences

- No fork, no sync, no upstream drift. Cost: sandbox, scheduler, egress
  proxy, and sensing plane are ours to build **and secure** (re-estimated in
  TODO §0.5: the "~8 weeks" figure is dead; ~18–23 weeks solo).
- Two absorbs already corrected their own spec lines: `governor.ts` was
  never types-only (narrowed, `collectVitals` dropped), and `ship-gate.ts`
  needed its `trigger-store` import re-pointed at vendored `objects.ts`.
  Reading source beats reading the plan — keep doing it.
- We owe QM nothing and it blocks us on nothing; keep watching its `adrs/`
  for ideas.
