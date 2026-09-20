# ADR 0003 — The Ledger is the only claim store

Status: accepted · 2026-09-09

## Context

Agent memory (QM's per-scope stores, jcode's graph memory) is where agents
_work_. If it is also where the company _knows_, onboarding guesses become
operational truth and no one can replay why a decision was made.

## Decision

Memory is scratch; the Ledger is record. Agent/harness memories never become
claims implicitly — if imported at all, they enter as `OBSERVATION`, never
`FACT` (I1). Every `DECISION` freezes a Context Bundle (claim IDs + versions

- hashes) so "why did we do this" is a query (`replayDecision`), not
  archaeology. Outcomes require a measurement basis (`recordOutcome`), never
  narrative.

## Consequences

- `src/ledger/ledger.ts` is the only module that writes `claims`,
  `decisions`, `outcomes`. Everything else reads through it.
- Exportability is a sales asset against the black-box objection — and a
  hard requirement, not a feature.
