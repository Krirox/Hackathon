# Metrics — every number we show a customer and how it's computed

North star: **intelligence cost per good decision**, falling.

| Metric | Definition | Computed by |
|---|---|---|
| cost per good decision | Σ(inference $ + tool $ + human min × rate) ÷ decisions whose OUTCOME meets prediction | `costOfDecision` (`src/attrib/attribution.ts`); null (unknown), never 0, when nothing good exists yet |
| % work at REFLEX/WORKFLOW | traces by tier over the window | `traces.tier` counts |
| human minutes reclaimed vs consumed | bid humanMinutes on completed work minus escalation + approval minutes | coordinator `spent_json` + `escalations` rows |
| stale-fact rate | stale facts ÷ all facts | `ledger.stats().staleFactRate` (target < 2%) |
| contradiction MTTR | open DISPUTED → resolved; target < 48h | `disputedPairs` + audit trail (MTTR clock needs the scheduler — pending) |
| refusal rate | refused ÷ total REQUESTs | `coord.refusalStats()` — 0% means sycophants, and we say so |
| routing precision | correct tier on labelled shadow decisions | `router.precision()` (gate: ≥0.90 on ≥2,000) |
| transfer survival | promoted cards passing cross-role/model tests | `skill_transfer_tests` (expect a minority — 100% pass means weak tests) |
| honeytask detection | detected ÷ resolved honeytasks | `honeytaskDetectionRate()` (threshold needs a human baseline) |
| outcome writeback rate | launches with a measured OUTCOME | `outcomes` ÷ launch decisions (target ≥ 0.80) |

Pre-registration (`preregister`) is what makes "adoption rose" mean
something: metrics + thresholds agreed before the pilot, visible in audit.
Holdout lanes (`assignHoldout`) are deterministic; the lanes themselves live
in the customer's segment/geo systems.
