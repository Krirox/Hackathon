# ADR 0001 — Buzz is a surface, not a store

Status: accepted · 2026-09-09

## Context

Humans and agents need somewhere to talk. Buzz (Nostr, signed identities,
channels, git) exists and is self-hostable. The temptation is to treat the
channel as the system of record — which is precisely how information dies
inside threads.

## Decision

Buzz (or Slack, via the fallback) is a **projection**: conversation, live
state, evidence chips, approvals render there. The **Reality Ledger** is the
only place claims live. The binding between them is one opaque string per
claim plus the `TalkSurface` bind/verify interface (`src/talk/surface.ts`).

## Consequences

- Swapping Buzz→Slack (or Buzz→anything) touches the talk adapter only;
  proven by the §0.4 spike, which binds and verifies through the interface
  with zero ledger changes.
- We never build chat. Ever.
- Signature verification stays with the relay/Buzz SDK; binding integrity
  (claim ↔ envelope) is ours, enforced with HMAC where Buzz is absent.
