# ADR 0005 — Agents cannot mint facts

Status: accepted · 2026-09-09

## Context

The difference between an organisation that knows things and one that agrees
with its own hallucinations is whether model output can become FACT.

## Decision

Enforced in code (`src/ledger/ledger.ts`, invariant I1, adversarially
tested across all 11 claim kinds): an agent may create OBSERVATION, BELIEF,
ASSUMPTION, HYPOTHESIS, PREDICTION, DECISION, ACTION. It may **never** create
FACT, MEASUREMENT, or OUTCOME. FACT/MEASUREMENT additionally require
`SYSTEM_OF_RECORD` or `MEASURED` provenance regardless of author (I2), and
high-tier reasoning context includes only VERIFIED, unexpired,
non-provisional claims (I6).

## Consequences

- This is the sentence that must survive a car ride, and it is a design
  commitment, not marketing: the test suite contains an agent attempting all
  11 kinds and exactly 4 throwing `EPISTEMIC_GUARD`.
- If FACT-minting violations ever read non-zero in production, the thesis is
  broken, not the pilot (metric contract, `idea.md` §26).
