# Buzz_TODO.md — Autonomous Agent Rooms & Human Guidance System

> **Vision**: Transform Buzz into the primary mission-control canvas for Vital. Every enterprise domain operates as an autonomous agent room mapped to a Vital **scope**. Agents execute workflows autonomously around the clock; humans monitor ambient health indicators (🟢/🟡/🔴) and step into threads only when guidance, approval, or recovery is needed.

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
└───────────────────────┴─────────────────────────────────────────────────────┘
```

---

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

---

## 3. Traffic-Light Health Protocol (Green / Yellow / Red / Idle)

Each room emits dynamic telemetry reflected in Buzz sidebar indicators:

### 🟢 Green — Nominal & Healthy
* **Condition**:
  * Agent task execution running within latency and token budgets.
  * Zero unhandled `CONTRADICTION_OPEN` claims.
  * Model confidence across decisions > 0.80.
  * No procedure card in `DEMOTED` or `QUARANTINED` drift status.
  * Scope kill switch is disengaged.
* **Agent Behavior**: Full autonomous dispatch (`ADMITTED` → `ACCEPTED` → `DONE`).
* **Human Overhead**: Zero. Passive ambient confidence.

---

### 🟡 Yellow — Attention & Review Required (Degraded)
* **Condition**:
  * **Human Gate**: An agent workflow requires human review before settlement (`requiresHumanApproval` due to high budget, sensitive action class, or low model confidence).
  * **Drift Alert**: Cognitive compiler flags procedure drift (`ewma > threshold`), requiring a procedure review.
  * **Fact Contradiction**: Two verified sources disagree (e.g. churn rate 2% vs 9%), opening a contradiction ticket.
  * **Budget Threshold Warning**: Scope spend reached 80% of daily quota.
  * **Worker Retries**: 2/3 retries consumed on a request attempt.
* **Agent Behavior**: Execution pauses at review gate (`STATE = AWAITING_HUMAN_APPROVAL`). Progress is posted to room thread.
* **Human Action**: Human clicks `[Approve]`, `[Decline]`, or types steering directions in thread.

---

### 🔴 Red — Halted / Emergency Stop / Violation
* **Condition**:
  * **Kill Switch Active**: Emergency stop engaged for this scope (`setKill(scope)` via `gov/trust.ts`).
  * **Budget Breached**: Hard spending ceiling reached (`TERMINATED_BUDGET`).
  * **Egress Violation**: Agent attempted network egress to an unapproved host.
  * **Model Policy Violation**: Unapproved model requested or prompt injection detected.
  * **Critical Pipeline Crash**: 3 consecutive worker strikes routed to Dead Letter Queue (DLQ).
* **Agent Behavior**: All mutations for the scope fail closed immediately.
* **Human Action**: Requires explicit human intervention and formal recovery procedure (`recoverStop`) with an audit reason logged in `audit_log`.

---

### ⚪ Idle / Gray — Dormant
* **Condition**: Sandbox or batch scope with no active jobs or waiting for scheduled triggers.
* **Agent Behavior**: Event listeners active; no compute consuming resources.

---

## 4. In-Room Interaction Patterns

### 4.1 In-Room Progress Streaming (`watchRun`)
When an agent accepts work in a room:
1. It opens a thread under the originating trigger event (`NIP-10` thread root).
2. Live progress events (`NIP-29` Kind 9) publish incremental steps:
   ```
   [vital req_7b29 step 1 tool=web_search 420 tokens IN_FLIGHT]
   [vital req_7b29 step 2 tool=ledger_verify 890 tokens IN_FLIGHT]
   ```
3. Upon completion, a summary card with statement hashes, confidence metrics, and cost is posted.

### 4.2 In-Room Human Steering (Threaded Mentions)
Humans steer agents without leaving Buzz:
* **Inline Approval**: Reacting with `👍` or clicking interactive Buzz review buttons triggers the Coordinator's `coord.settle` via authenticated room webhooks.
* **Steering Instructions**: Replying to the thread:
  > *"@fact-agent refine query to focus on EU subsidiaries only and rerun verification."*
  causes the worker to re-admit the task with human guidance incorporated into the context bundle.
* **Emergency Halt**:
  > `/halt scope:risk reason="Market volatility anomaly"`
  immediately engages the Vital trust kill-switch for that scope.

---

## 5. Implementation Roadmap

### Phase 1: Room Topology & Provisioning
- [ ] Create seed script `scripts/seed-buzz-rooms.ts` to provision the 12 canonical rooms on the local relay.
- [ ] Register cryptographic agent identities for each room (Nostr keypairs for `fact-agent`, `risk-agent`, `ops-agent`, etc.).
- [ ] Bind room identities to Vital scopes (`src/talk/surface.ts`).

### Phase 2: Dynamic Health Telemetry Engine
- [ ] Build `ScopeHealthEvaluator` in `src/gov/trust.ts` to compute composite status (`healthy` | `degraded` | `halted` | `idle`) per scope based on:
  - Active stops (`describeStops`)
  - Drift alerts (`checkDrift`)
  - Pending approval count (`coord.listPendingApprovals`)
  - Budget consumption vs quota
- [ ] Implement Nostr status beacon publisher: periodically post room status events (`Kind 30315` or custom NIP status tags) to render 🟢/🟡/🔴 badges in the Buzz sidebar.

### Phase 3: Scope-Aware Application Worker Dispatch
- [ ] Update `ApplicationWorkerOptions['buzz']` in `src/substrate/worker.ts` with a dynamic `channelFor(requestId)` router that maps `request.scope` to the appropriate room ID.
- [ ] Ensure non-baseline runs stream execution steps live into the room thread via `watchRun`.
- [ ] Verify that failures increment `buzzRelayFailures` gracefully without crashing the worker.

### Phase 4: In-Room Review & Approval Interface
- [ ] Implement NIP-29 review card renderer: format `requiresHumanApproval` requests into structured room cards with evidence chips, confidence score, token cost, and approval action links.
- [ ] Implement Buzz webhook receiver in `src/console/serve.ts` (`POST /api/buzz/webhook`) to handle approvals and declines initiated from Buzz rooms.
- [ ] Bind approved decisions to `buzzEventSig` in the Reality Ledger.

### Phase 5: In-Room Slash Commands & Emergency Controls
- [ ] Implement room command parser for `/halt <scope>`, `/recover <scope>`, `/status <scope>`, and `/cost`.
- [ ] Connect `/halt` and `/recover` directly to `gov/trust.ts` functions (`setKill`, `recoverStop`) with audit logging.
- [ ] Test end-to-end: trigger synthetic procedure drift → observe `#risk-monitor` turn 🟡 → guide agent via thread → observe return to 🟢.
