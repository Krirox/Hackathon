# ADR 0004 — Messages never carry work

Status: accepted · 2026-09-09

## Context

The naive multi-agent design — an agent hopping into another channel and
asking another agent in free text — resurrects unbounded work, no budgets,
no refusal, and chat as the system of record.

## Decision

Three message classes, never collapsed: QUERY (read-only, token-budgeted),
REQUEST (real work with a full bid: owner, deadline, $, rounds, stop
condition — refusable, and refusal is a logged outcome), NOTICE (digest
only, never interrupts). What crosses a scope boundary is a **typed REQUEST
object through the scheduler** (`src/coord/coordinator.ts`), which ADMITS /
DEFERS / DENIES. It *renders* as a thread; it is *invoked* as an object.

## Consequences

- Hop limit 3, cycle detection, idempotency dedupe, budget death, and the
  3/day human-escalation cap are structural — enforced in admission, not
  documented as policy. The cap BLOCKS (DENIED), because approval after the
  cap is theater.
- Refusal rate is a first-class health metric. 0% refusal means
  people-pleasers, and we show the customer that number.
