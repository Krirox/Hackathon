# ADR 0002: Buzz live integration — real Nostr identity, kind whitelist, fail-closed configuration

Date: 2026-09-18
Status: Accepted
Supersedes the "Buzz is a surface" framing of ADR 0001 with respect to the relay integration.

## Context

The original Buzz integration (ADR 0001) was mock-grade despite tests passing:

- Agent identities were `sha256("vital:agent:<name>")` with signatures of the
  form `sha256(pubkey + id)` — forgeable by anyone and rejected by any relay,
  which verifies BIP-340 Schnorr over secp256k1 on every event.
- The publisher posted `{ event }` to `POST /events`; the relay expects the
  bare event in the Nostr wire shape (`created_at`, not `createdAt`).
- Room "channels" were slugs (`chan-risk-monitor`); the relay only accepts the
  channel UUID it assigns at NIP-29 group creation (kind 9007), exposed via the
  `d` tag of kind-39000 metadata.
- `BUZZ_RELAY_URL` was read only by a seed script that opened an in-memory DB
  and swallowed relay errors as success. Nothing in production constructed a
  surface, so `buzzRelayFailures` was structurally always zero.
- Every `/api/buzz/*` HTTP route was unauthenticated: an anonymous caller could
  read ledger content, rewrite room policy, engage kill switches, and approve
  pending human-approval requests. Review tokens were HMAC'd under the literal
  secret `vital-review-secret` committed in source.

These were verified against a live relay (Buzz 0.2.1, `BUZZ_REQUIRE_AUTH_TOKEN=false`)
and its source (`crates/buzz-relay/src/handlers/ingest.rs`,
`crates/buzz-auth/src/nip98.rs`, `crates/buzz-core/src/verification.rs`).

## Decision

1. **Real crypto, one dependency.** `@noble/curves` provides secp256k1/BIP-340.
   `node:crypto` has no secp256k1-Schnorr (see `src/gov/operator.ts`), and
   hand-rolling elliptic-curve crypto in-repo was rejected. The primitives are
   pinned by the official BIP-340 test vectors in `test/nostr.test.ts`.

2. **Agent identities are derived, never stored or hard-coded.** One master
   secret (`BUZZ_AGENT_MASTER_KEY`, hex ≥16 bytes) derives per-agent keys via
   HKDF with stable labels; provisioning is idempotent without 12 committed
   keys. With no key material, there is **no identity** — `agentForScope`
   returns null and every signing path fails closed. `BUZZ_ALLOW_DEV_KEYS=1`
   opts into labelled dev identities for local testing.

3. **The wire contract lives in one place** (`src/talk/buzz-surface.ts`):
   bare-event body in the Nostr wire shape, NIP-98 auth per request (or
   dev `X-Pubkey` against a dev relay), and centralized resolution of any
   channel reference (scope / room id / slug) to the relay's channel UUID.
   A room without a binding fails loudly (`CHANNEL_NOT_PROVISIONED`) rather
   than publishing into a guessed channel.

4. **Kind whitelist.** The relay accepts only specific kinds. Vital publishes:
   kind 9 (chat/progress), 30315 (status beacons), 30023 (canvases). It does
   not attempt kind 30024 (huddle) — the relay rejects it.

5. **Room config is enforced, not decorative.** `src/talk/enforce.ts` gates the
   worker dispatch loop: inactive rooms refuse dispatch; budget ceilings refuse
   at 100%; `supervised` requires a human for every dispatch; `guarded` gates at
   85% of the dollar ceiling. Refusals surface as `[worker:ROOM_GATE]` errors.

6. **Buzz HTTP surface is authenticated.** All `/api/buzz/*` routes require an
   admin session (+ CSRF for mutations) or a review token minted under
   `VITAL_REVIEW_SECRET` (no default; unset ⇒ tokens cannot verify). The
   tokenless approve path is gone, and GET `/api/buzz/webhook` renders a
   confirmation form instead of mutating.

7. **Buzz workspace ships in the console** (`/console/buzz`): the room roster
   with live health, relay status and provisioning state, plus per-room threads
   read back from the relay (local audit activity as fallback), command box
   (halt/recover/status/cost/policy, audit-logged), and live canvas.

## Consequences

- Proven live end-to-end against the relay: 12 rooms provisioned with persisted
  channel UUIDs; progress, terminal and beacon events published under NIP-98 and
  read back from the room thread.
- Production needs exactly two secrets: `BUZZ_RELAY_URL` and
  `BUZZ_AGENT_MASTER_KEY` (plus `VITAL_REVIEW_SECRET` for review tokens).
- The relay's NIP-98 replay guard (120s seen-set per auth event id) requires a
  `nonce` tag on every auth event; same-second identical requests would
  otherwise be rejected as replays.
- Publishing requires the publishing identity to be a member of the channel
  (the room's channel creator is its owner; other agents need to be added).
