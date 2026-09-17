# Metrics — every number we show a customer and how it's computed

North star: **intelligence cost per good decision**, falling.

| Metric                              | Definition                                                                            | Computed by                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| cost per good decision              | Σ(inference $ + tool $ + human min × rate) ÷ decisions whose OUTCOME meets prediction | `costOfDecision` (`src/attrib/attribution.ts`); null (unknown), never 0, when nothing good exists yet |
| % work at REFLEX/WORKFLOW           | traces by tier over the window                                                        | `traces.tier` counts                                                                                  |
| human minutes reclaimed vs consumed | bid humanMinutes on completed work minus escalation + approval minutes                | coordinator `spent_json` + `escalations` rows                                                         |
| stale-fact rate                     | stale facts ÷ all facts                                                               | `ledger.stats().staleFactRate` (target < 2%)                                                          |
| contradiction MTTR                  | open DISPUTED → resolved; target < 48h                                                | `disputedPairs` + audit trail (MTTR clock needs the scheduler — pending)                              |
| refusal rate                        | refused ÷ total REQUESTs                                                              | `coord.refusalStats()` — 0% means sycophants, and we say so                                           |
| routing precision                   | correct tier on labelled shadow decisions                                             | `router.precision()` (gate: ≥0.90 on ≥2,000)                                                          |
| transfer survival                   | promoted cards passing cross-role/model tests                                         | `skill_transfer_tests` (expect a minority — 100% pass means weak tests)                               |
| honeytask detection                 | detected ÷ resolved honeytasks                                                        | `honeytaskDetectionRate()` (threshold needs a human baseline)                                         |
| outcome writeback rate              | launches with a measured OUTCOME                                                      | `outcomes` ÷ launch decisions (target ≥ 0.80)                                                         |

Pre-registration (`preregister`) is what makes "adoption rose" mean
something: metrics + thresholds agreed before the pilot, visible in audit.
Holdout lanes (`assignHoldout`) are deterministic; the lanes themselves live
in the customer's segment/geo systems.

## Load probe (local sqlite, `node scripts/load-probe.mjs` — 2026-09-17)

Synthetic history, direct-SQL seeding (measures READ shape, not write
invariants). Same box, `:memory:`:

| History                                            | Dashboard build p50/p95 | Admission p50/p95 | approvalLatencyStats |
| -------------------------------------------------- | ----------------------- | ----------------- | -------------------- |
| 10k claims, 200 decisions (sqlite)                 | 57 / 65 ms              | 0 / 4 ms          | 0 ms                 |
| 100k claims, 1k decisions (sqlite)                 | 759 / 839 ms            | 1 / 7 ms          | 0 ms                 |
| 100k claims, 1k decisions (postgres, local docker) | 329 / 337 ms            | 6 / 11 ms         | 1 ms                 |

Postgres reads beat sqlite at 100k despite TCP round trips (planner +
indexes); seeding is slower on PG (41s vs 0.8s — per-row inserts, not the
workload). Run with `LOAD_PG_URL=...` for the postgres column.

Reads scale ~linearly with history (full-table stats/pairs/traces scans);
admission is flat. The 120-point cost-curve budget caps decision _costing_,
not the underlying scans — the next order of magnitude needs the daily
summaries (audit roadmap), not more budget tuning. Re-run before claiming
anything about Postgres or production hardware.
