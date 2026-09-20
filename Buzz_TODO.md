# Buzz_TODO.md — Autonomous Agent Rooms & Human Guidance System

> **Status (2026-09-18)**: The relay integration is now **real and verified live** — real BIP-340
> identities, NIP-98 auth, kind whitelist conformance, and provisioning verified against a running
> Buzz relay (see `docs/adr/0002-buzz-live-integration.md`). The previous version of this document
> marked all phases `[x]` when the integration was mock-grade; that was false and is corrected below.
> Items marked ✅ are verified in code and tests; items marked 🟡 work but have known limits; ❌ are not built.

## 0. What "live" means now

A deployment is Buzz-live when it sets:

```
BUZZ_RELAY_URL=https://<relay-host>        # the relay binds the community by Host
BUZZ_AGENT_MASTER_KEY=<32+ hex chars>      # derives all 12 room agent identities
VITAL_REVIEW_SECRET=<random 16+ chars>     # signs review-card approve/decline tokens
```

Then `node --import tsx scripts/seed-buzz-rooms.ts --tenant <slug> --db <vital.db>` provisions the
12 canonical rooms on the relay (real signed kind-9007 events) and persists each room's channel UUID.
Run progress, terminal summaries and status beacons then stream into room threads automatically from
`vital worker` / `vital console --with-worker`, and the console's **Buzz** nav shows the live roster.

---

## 1. System Architecture: Scoped Autonomous Rooms

Rather than segregating work into disconnected dashboards and chat threads, Vital projects its Reality Ledger, Coordinator, and Execution Engine into dedicated **Buzz Rooms**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             BUZZ WORKSPACE                                  │
├───────────────────────┬─────────────────────────────────────────────────────┤
│ SCOPED ROOMS          │ ACTIVE ROOM VIEW (e.g. #risk-monitor)               │
│                       │                                                     │
│ 🟢 reality-core       │ [09:14] 🤖 risk-agent: Analyzing counterparty drift │
│    scope:core         │ [09:14] 🤖 risk-agent: Exposure variance +14.2%     │
│ 🟢 fact-check         │ ─────────────────────────────────────────────────── │
│    scope:facts        │ 🟡 [HUMAN ATTENTION REQUIRED]                       │
│ 🟢 market-intel       │ Drift EWMA 0.068 exceeds threshold (0.050).         │
│    scope:research     │ Action Class: REBALANCE · Est. Spend: $420          │
│ 🟡 risk-monitor       │ Evidence: [clm_8f21] Contradiction with Q3 filings  │
│    scope:risk         │ [ 👍 Approve ]  [ 👎 Decline ]  [ 💬 Steer ]        │
│ 🟢 user-feedback      │ ─────────────────────────────────────────────────── │
│    scope:product      │ [09:16] 👤 risk-lead: Rebalance approved for 50%.   │
│ 🟢 compliance         │ [09:16] 🤖 risk-agent: Applying partial hedge...    │
│    scope:legal        │ [09:17] 🟢 Status restored to healthy               │
│ 🟢 finance            │                                                     │
│    scope:finance      │                                                     │
│ 🟡 ops                │                                                     │
│    scope:infra        │                                                     │
│ 🟢 growth             │                                                     │
│    scope:business     │                                                     │
│ 🟢 data-pipeline      │                                                     │
│    scope:data         │                                                     │
│ 🟢 exec               │                                                     │
│    scope:exec         │                                                     │
│ ⚪ sandbox            │                                                     │
│    scope:experimental │                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. Room Roster & Scope Matrix

Every room operates under strict boundaries defined by Vital's capability matrix, authority policies, and Ledger scopes:

| Room Name | Vital Scope | Autonomous Agent Duties | Human Guidance & Steering Triggers | Baseline Health Metric |
| :--- | :--- | :--- | :--- | :--- |
| **`reality-core`** | `scope:core` | Ingests canonical truth; maintains epistemic consistency; deduplicates claims. | Resolving unsolvable logical contradictions; model schema upgrades. | Epistemic contradiction rate < 0.1% |
| **`fact-check`** | `scope:facts` | Real-time assertion verification against system-of-record (SoR); cross-source triangulation. | Disputed assertions with confidence scores < 0.70; stale ground truth. | Unverified claim queue depth ≤ 5 |
| **`market-intel`** | `scope:research` | Deep web crawl; competitor pricing & positioning updates; sentiment mining. | Approving external research budgets; query redirection. | Research task turnaround time < 45m |
| **`risk-monitor`** | `scope:risk` | Continuous exposure tracking; procedure card drift monitoring; counterparty checks. | Drift demotion alerts (`checkDrift`); variance spikes > 10%. | Procedure EWMA drift score < 0.05 |
| **`user-feedback`**| `scope:product` | Feedback clustering; feature request synthesis; bug sentiment categorization. | Prioritization steering; sensitive user complaints. | Unprocessed feedback backlog < 2h |
| **`compliance`**   | `scope:legal` | Regulatory watch; policy diffing; audit trail verification; EU AI Act compliance checks. | High-risk AI categorization; policy changes; export approvals. | Zero unreviewed high-risk classifications |
| **`finance`**      | `scope:finance`| Churn metric aggregation; Stripe/QuickBooks sync; cost-per-signal accounting. | Spend requests exceeding scope limit (>$500); ledger reconciliation. | Cost-per-signal within budget gate |
| **`ops`**          | `scope:infra` | Cluster health; rate limit monitoring; worker thread pool sweeps; relay connectivity. | Infrastructure failovers; DLQ exhaustion; cluster scaling. | Worker sweep interval < 1000ms |
| **`growth`**       | `scope:business`| Launch copy generation; conversion attribution; SEO & distribution experiments. | Brand tone overrides; public launch sign-off. | Experiment velocity ≥ 3/week |
| **`data-pipeline`**| `scope:data` | ETL batches; artifact content-addressing; database indexing & partition management. | Pipeline backpressure; failed partition migrations. | Receipt processing lag < 30s |
| **`exec`**         | `scope:exec` | Cross-scope KPI rollups; executive digest generation; company priority tracking. | Strategic pivots; OKR adjustments; resource reallocation. | Daily executive digest punctuality |
| **`sandbox`**      | `scope:experimental`| Canary testing; unvalidated skill cards; adversarial red-teaming. | Promoting card from `QUARANTINE` to `BOUNDED_PILOT`. | Zero production spillover |

## 3. Traffic-Light Health Protocol (Green / Yellow / Red / Idle)

Implemented in `ScopeHealthEvaluator` (`src/talk/health.ts`) and enforced in dispatch via
`src/talk/enforce.ts`. Badges render in the console Buzz roster; beacons publish to rooms as kind 30315.

### 🟢 Green — Nominal & Healthy ✅
* Agent execution within budget; zero active stops; no drifting procedure cards; kill switch disengaged.
* **Agent Behavior**: dispatch proceeds (subject to room autonomy + budget enforcement).

### 🟡 Yellow — Attention & Review Required ✅
* Pending human approvals, drift alerts, or spend ≥85% of a guarded room's dollar ceiling.
* **Human Action**: approve/decline under Reviews, or `/recover`, or raise the ceiling.

### 🔴 Red — Halted / Emergency Stop ✅
* Kill switch engaged (`setKill`) → dispatch into the scope refuses until `recoverStop`.
* Budget ceiling exceeded → dispatch refuses with a named, operator-actionable reason.

### ⚪ Idle ⚪-as-designed, 🟡 in relay
* Sandbox with no jobs shows idle in the roster. ❌ No dedicated relay "idle beacon" kind exists
  (the relay rejects non-whitelisted kinds); idle state is expressed by beacon content instead.

## 4. In-Room Interaction Patterns

### 4.1 In-Room Progress Streaming (`watchRun`) ✅
Run progress and terminal summaries publish as kind-9 messages with `vital-request`/`vital-tool` tags,
threaded via NIP-10 `e` tags when a real thread root exists. Verified live: progress lines published
under NIP-98 and read back from the room thread. **Limit 🟡**: only the terminal summary streams from
the worker's dispatch loop today; mid-run step streaming requires a runner subscription, which the
wiring supports but the worker does not yet attach.

### 4.2 In-Room Human Steering ✅ (approve/decline) · ❌ (threaded mentions)
* **Inline Approval**: review cards mint approve/decline tokens under `VITAL_REVIEW_SECRET`; the
  webhook confirms with a human-facing confirmation step (never a mutating GET) and records the
  decision + audit entry. ❌ Reacting with 👍 does not settle anything.
* **Steering Instructions**: ❌ not built — replies in a room do not re-admit tasks with guidance.
* **Emergency Halt**: ✅ `/halt <scope> reason="…"` engages the real trust kill switch
  (`gov/trust.ts`), which blocks mutations via `gov/act.ts` until `/recover`. ✅ also available
  from the console room page (audit-logged).

## 5. Room Selection & Customization Flow ✅ (config) · ✅ (enforcement)

* `/setup/rooms` wizard: industry presets, per-room mission, autonomy tier, budget ceilings, SoR list.
* **Autonomy tiers are enforced** in the dispatch path, not just displayed:
  - `autonomous` — dispatches freely within budget ceilings.
  - `guarded` (default) — gates at 85% of the dollar ceiling, then waits for a human.
  - `supervised` — every dispatch waits for a human.
  - Inactive rooms never dispatch; ceilings bind at 100% for all tiers.
* Every change is audit-logged (`POLICY_MUTATE`).
* 🟡 "Save & Deploy" now provisions on the relay via the seed script's provisioning path, but the
  wizard itself does not yet trigger relay provisioning inline (run the seed script to bind channels).

## 6. Implementation Roadmap (truth-corrected)

### Phase 1: Room Topology & Provisioning — ✅ verified live
- [x] Provision the 12 canonical rooms with real signed NIP-29 group-creation events (`provisionAllRooms`).
- [x] Real secp256k1/BIP-340 agent identities, derived from `BUZZ_AGENT_MASTER_KEY` (HKDF, stable labels).
- [x] Relay-assigned channel UUID read back from kind-39000 metadata and persisted per room.

### Phase 2: Dynamic Health Telemetry Engine — ✅ evaluated + published
- [x] `ScopeHealthEvaluator` computes healthy/degraded/halted/idle per scope (stops, drift, approvals, budget).
- [x] Kind-30315 status beacons publish through the signed surface.
- [x] Health badges render in the console Buzz roster.

### Phase 3: Scope-Aware Application Worker Dispatch — ✅ wired
- [x] `ApplicationWorkerOptions['buzz']` constructed from env (`workerBuzzSurface`) in both CLI entrypoints.
- [x] Terminal summaries stream into the room thread; relay failures are non-fatal and counted (`buzzRelayFailures`).
- [x] **Room-config enforcement** (`evaluateDispatch`): autonomy tiers + budget ceilings bind dispatch.
- [ ] Mid-run step streaming from the runner subscription (plumbing exists, worker not attached).

### Phase 4: In-Room Review & Approval Interface — ✅ with confirmation step
- [x] Review-card renderer (`renderReviewCard`) with evidence chips, confidence, cost.
- [x] Webhook receiver: admin-session+CSRF or signed-token auth only; **no tokenless path**; GET is a
      confirmation form, never a mutation; secrets come from `VITAL_REVIEW_SECRET` (no default).
- [x] Approved decisions recorded with audit entries.
- [ ] Publish review cards into rooms automatically when `requiresHumanApproval` fires (the card
      renderer + token minting exist; the trigger is not wired into the approval path yet).

### Phase 5: In-Room Slash Commands & Emergency Controls — ✅
- [x] `/halt`, `/recover`, `/status`, `/cost`, `/policy set …` (audit-logged; `/halt`/`/recover`
      connect to the real trust kill switch).
- [x] Available from the console room page with CSRF; relay-authenticated execution path exists.
- [x] Kill switch enforcement is real (`gov/act.ts` refuses mutations during a stop).

### Phase 6: Room Selection & Onboarding Setup Wizard — ✅
- [x] Wizard at `/setup/rooms` (presets, mission, autonomy, budgets, SoRs) with audit trail.
- [x] Room configuration schema in `src/talk/rooms.ts` including the relay channel binding.
- [x] Console Buzz workspace (roster + room views) consuming it all.

## 7. Standout Capabilities — corrected status

1. **Cross-Room Agent Handoffs (`swarm.ts`)** — 🟡 logic + deliberation records exist and are tested;
   not triggered from live room traffic.
2. **Live Epistemic Canvases (`canvas.ts`)** — ✅ canvas generation + kind-30023 publishing through
   the signed surface; ❌ relay-side pinning of a single addressable document not verified.
3. **Honeytask Canaries (`canary.ts`)** — 🟡 engine + tests; no scheduler triggers it in production.
4. **Ambient Morning Voice Briefing (`huddle.ts`)** — 🟡 WAV synthesis works and is served at
   `/api/buzz/huddle/audio` (admin-gated); ❌ kind-30024 events are **rejected by the relay**
   (kind whitelist), so huddle events cannot be posted to rooms.
5. **Budget Gas Gauges (`budget-gauge.ts`)** — ✅ rendered in the roster/room views; ceilings now
   actually enforced.
6. **Time-Travel Forking (`fork.ts`)** — 🟡 engine + diffing tested; accessible via webhook only
   (admin-authenticated), no UI.
