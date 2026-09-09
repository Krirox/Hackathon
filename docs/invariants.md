# Ledger invariants I1–I7 — each with the test that proves it

Enforced in `src/ledger/ledger.ts`. Tests in `test/ledger.test.ts`
(run with `npm test`).

| | Invariant | Proving test(s) |
|---|---|---|
| I1 | No generated facts: agents may never create FACT / MEASUREMENT / OUTCOME (nor GOAL) | `adversarial: an agent trying all 11 kinds mints facts nowhere` (exactly 4 × `EPISTEMIC_GUARD`); `I1: an agent cannot mint a FACT` |
| I2 | FACT/MEASUREMENT require `SYSTEM_OF_RECORD`/`MEASURED` regardless of author | `I2: FACT with SELF_SERVED provenance is rejected…`; property test asserts `factsWithoutGroundProvenance === 0` over 300 random appends |
| I3 | Every claim has a named human owner; orphan count is 0 | property test asserts `orphanClaims === 0` (schema requires `owner`) |
| I4 | A `contradicts` link flips both claims to DISPUTED + opens a resolution ticket (audit event) | `I4: contradiction flips both claims to DISPUTED` |
| I5 | `valid_until` expiry ⇒ STALE on a sweep | `I5: staleness sweep marks expired facts STALE` |
| I6 | High-tier context = VERIFIED + unexpired + non-provisional only | `I6: contextFor excludes stale, provisional and unverified claims` |
| I7 | Append-only: supersede by new row + link, never rewrite | `append-only: supersede…`, `supersedeChain walks history`, replay-drift test |

Related: decisions freeze Context Bundles (`recordDecision…`, `replay shows
drift…`, `a tampered bundle fails replay…`); outcomes require a basis
(`recordOutcome needs a decision + a measurement basis`).
