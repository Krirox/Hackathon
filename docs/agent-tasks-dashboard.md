# Agent Tasks Dashboard — Layout & UX Specification

Status: **specification** (not yet implemented) · Owners: console shell (`src/console/`) ·
Source of truth for tokens/components: [`../src/console/theme.ts`](../src/console/theme.ts) ·
Tone and format conventions: `docs/glossary.md`, `docs/invariants.md` ·
Grounded in the real swarm code — see §1.5 (this spec cites only files that exist)

---

## 1. Purpose & Scope

Jcode coding runs are long-lived: a `CoordinationRequest` is admitted by the
coordinator, claimed by a worker, and executed against the jcode harness
([`src/jcode/runner.ts`](../src/jcode/runner.ts)) over minutes or hours, with
lease heartbeats, budget ceilings, permission round-trips, and swarm
sub-requests. Today an operator can only see the *result* (Ledger claims,
traces, audit log). This spec defines the **Ongoing Tasks** console page —
a single screen that answers, in real time:

1. **What is running right now?** (task list)
2. **Who is doing it?** (primary agent + sub-agent hierarchy, live status)
3. **What are they doing this second?** (tool-step feed, tokens/spend, errors)

Scope: one new read-mostly page at `/console/agent-tasks` with two embedded
controls (cancel request, re-fetch). No write paths beyond the existing
coordinator cancel/kill machinery; the dashboard never bypasses governance.

Non-goals: historical analytics (traces/dashboard), budget configuration
(gov pages), approval queues (existing review surfaces). The dashboard *links*
to those; it does not duplicate them.

---

## 1.5 How the Jcode swarm actually works (grounding)

The dashboard is only correct if it mirrors the real execution model. Verified
against the code, a "long-running Jcode execution" is **not one tree** — it is
three independent mechanisms that the UI must distinguish:

**(A) The single-run lifecycle** — [`src/jcode/runner.ts`](../src/jcode/runner.ts).
A coding need becomes a REQUEST → the coordinator admits it (budget / hop /
grounding rules) → the runner `claimExecution` (compare-and-swap: exactly one
worker owns the paid work; losers get `CLAIM_LOST`) → opens a jcode
session over the NDJSON harness socket ([`src/jcode/client.ts`](../src/jcode/client.ts),
[`protocol.ts`](../src/jcode/protocol.ts): `create_session`/`attach`/`send`,
then streams `text_delta`, `tool_done`, `token_usage`, `permission_request`,
`turn_done`). Every `permission_request` is decided by **our** governed policy
(shell screening + R/A/I matrix + live kill-switch), not a human at a terminal.
A 25s **lease heartbeat** renews the claim (`reclaimStale` reclaims dead
workers); `reportUsage` streams spend mid-run and can `TERMINATED_BUDGET` the
run. The runner emits `ProgressUpdate` (`step` = monotonic tool/token-batch
count) — this is the pulse the feed consumes.

**(B) Decomposition children — the ONLY true parent→child tree.**
`Coordinator.split/decompose` ([`src/coord/coordinator.ts`](../src/coord/coordinator.ts))
parents budgeted child requests on an admitted/in-flight parent via
`requests.parent_request`, sharing the parent's *unspent* budget
("decomposition never prints money"; `BUDGET_SPLIT` refuses overspend). Children
may target the parent's scope or another (`st.targetScope ?? parent.targetScope`).
This is what a nested **agent tree** legitimately represents.

**(C) Cross-room swarm deliberation — LATERAL, not nested.**
[`InterAgentSwarmCoordinator`](../src/talk/swarm.ts) turns an `@agent …`
mention into a **fresh downstream REQUEST** to the target scope via
`coord.submit` — it is **not** parented (`parentRequestId` absent). The chain is
keyed by `chainId` (`swm_…`), carried in `requests.hop_chain`, and linked in the
Ledger via `derives_from` claims; high-risk findings cascade to more rooms
(e.g. finance → exec + growth). The dashboard must render these as a **swarm
chain (siblings/related)**, never as children of a `parent_request` tree.

**(D) Intra-scope session multiplexing.** The team microVM runs
*"one isolated workspace per scope, many jcode sessions multiplexed inside"*
([`src/substrate/worker.ts`](../src/substrate/worker.ts)). So one room-agent can
hold several concurrent jcode **sessions** — the parallelism *under* a single
task. Sessions are runtime state (session_id on the socket + `attached`/
`session_status` frames), persisted only via artifacts/traces, not a table —
so the UI shows them best-effort from the run's live event stream.

**Implication for the design:** the detail view's hierarchy has three levels —
task → (B) decomposition children → (D) concurrent jcode sessions — plus a
separate (C) swarm-chain rail for lateral delegations. "Sub-agent" in §2 means
(B) specifically. Long runs are exactly the case the AWS executor excludes
("swarms, overnight" run as the Fargate jcode sidecar, not in the 15-min Lambda),
which is why this needs a dedicated long-lived monitor.

---

## 2. Vocabulary (connects to existing terms)

| Term | Meaning here | Grounding in code |
|---|---|---|
| **Task** | A `CoordinationRequest` of message class `REQUEST` currently in a non-terminal state, executed via the jcode runner. | `requests` table, `REQUEST_STATES` (`src/core/types.ts`) |
| **Primary agent** | The `target_scope` of the task's request — the room/microVM whose worker holds the `claimExecution` lease (`exec_owner`). One workspace per scope, many jcode sessions (`src/substrate/worker.ts`). | `requests.target_scope`, `exec_owner`, `on_behalf_of` |
| **Sub-agent** | Mechanism (B) only: a **decomposition child** — a `requests` row whose `parent_request` points at the task, recursively, sharing its budget. | `requests.parent_request`, `Coordinator.split` |
| **Swarm chain** | Mechanism (C): lateral cross-room delegations from an `@agent` mention — related requests keyed by `chainId` (`swm_…`) and `hop_chain`, **not** parented. | `src/talk/swarm.ts`, `requests.hop_chain` |
| **Session** | Mechanism (D): one concurrent jcode harness session inside a scope's workspace. | `runner.ts` session, `attached`/`session_status` frames |
| **Live** | The SSE event stream is attached and current (`evt.source.readyState === EventSource.OPEN`). | `GET /api/events` (`src/console/events.ts`) |
| **Step** | One monotonic progress unit from the runner: a tool completion or a token batch. | `ProgressUpdate.step` (`runner.ts`) |
| **Guards** | Runtime invariants shown on the detail panel: execution-lease heartbeat, budget ceiling, kill switch, content screen. | `leaseHeartbeat`, `reportUsage`, `checkKill`, `contentScreen` |

---

## 3. Where it lives

- **Route:** `/console/agent-tasks` (alias `/console/tasks`). Declared as a
  `RouteDef` object (`capability: 'session'`, `surface: 'html'`,
  `activation: 'required'`) in a new `src/console/routes/agent-tasks.ts`,
  registered via `src/console/routes/registry.ts` — the same pattern as
  `routes/lists.ts`. (The `serve.ts` legacy if-chain remains for unmigrated
  routes, but a new page should not join it.) Per `docs/invariants.md` a route
  must be reachable from the shell, never URL-only.
- **Navigation:** add a `RailItem` to the *Operations* group in
  `src/console/console-shell.ts` — and critically add its `navKey` to both
  `RAIL_KEYS` and `titleFor`, or the rail silently highlights Dashboard
  (existing gotcha).
- **Producer file:** new `src/console/agent-tasks.ts` exporting the body
  fragment, rendered through `ctx.env.shellPage(...)` + `renderListPage`
  (the `/console/requests` idiom in `routes/lists.ts`), wrapped at the
  response boundary by `themeDocument()`.
- **On-page anchor:** the detail expansion uses in-page `#task-…` fragments
  only. Per-task full-page detail stays where it already lives —
  `requestDetailUrl(id)` → `console/detail.ts` — and the dashboard links to it
  rather than replacing it. No new full-document routes are introduced.

---

## 4. Page Layout

Macrostructure stays Workbench (rail + top bar + page + inspector), identical
to every console page. The page itself is a **single-column stream with
in-place disclosure** — the list frame (`renderListPage` + `.v-filterbar` +
rows) that `/console/requests` already ships, extended with expandable rows,
so operators learn one pattern.

```text
┌─ v-page ────────────────────────────────────────────────────────┐
│ L1  Header zone                                                  │
│     breadcrumb · H1 + LIVE pill · lede · [theme][user]           │
│ L2  In-flight KPI strip        [ 4 tiles · .v-kpi-card ]         │
│     Running · Waiting on approval · Sub-agents active · Spend 1h │
│ L3  Filter bar               [ .v-filterbar + results count ]    │
│     search · scope select · state segmented · freshness · More   │
│ L4  Task list                  [ .v-card-flush > .v-task-list ]  │
│     row · row · row …  (each row is a <summary>, expandable)     │
│ L5  Pagination / "no more tasks" rule                            │
└──────────────────────────────────────────────────────────────────┘
```

- L2 uses `.v-grid` (auto-fit, min 230px). L3–L5 sit in one `.v-stack`.
- Detail content is **inline**: clicking a row expands its `.v-task-detail`
  panel directly beneath the row (`.v-task-row[open]` styling). Only one
  task open at a time (`<details name="v-tasks">` exclusivity).
- On viewport ≥ 1400px with a task open, the page offers an optional
  "pin to inspector" toggle that mirrors the open task's agent tree into the
  Workbench `.v-inspector` column. This is progressive enhancement only.

### 4.1 Detail zone (within an expanded row)

```text
┌─ .v-task-detail ────────────────────────────────────────────────┐
│ head: eyebrow "TASK · <id>" · title (goal) · state badge        │
│       · elapsed · cost · step counter · [Cancel] [Refresh]      │
│ grid-wide:                                   [ inspector card ] │
│  ┌ main stream ──────────────┐  ┌ agent tree ─────────────────┐ │
│  │ Guard strip               │  │ ● primary  ai/scope-alpha   │ │
│  │ ● lease ● budget ● kill   │  │ ├ ● child  worker-1  45%    │ │
│  │ Feed (live tool steps)    │  │ └ ○ child  worker-2  done   │ │
│  │ ▼ event log (collapsible) │  │ verification card           │ │
│  └───────────────────────────┘  └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Left = what's happening (feed). Right = who's doing it (agent tree) plus
provenance (claims, session id, artifact links). Collapses to one column
below 1100px via the existing `.v-grid-wide` breakpoint.

---

## 5. Component Hierarchy

`v-` prefix, flat hyphenated names — exactly the convention `theme.ts`
already uses (`.v-card-head`, `.v-feed-item`; `--xxx` as state modifier,
`.is-xxx` reserved for JS-set state). No new raw colors anywhere; every new
rule references `var(--v-*)` tokens only.

```text
agentTasksDashboard()
└─ .v-page
   ├─ .v-breadcrumb                     (existing)
   ├─ .v-page-head                      (existing)
   │  ├─ h1.v-page-title + .v-live[data-state]
   │  └─ .v-lede
   ├─ .v-grid  (KPI strip)
   │  └─ .v-card.v-kpi-card × 4         (existing; right slot = .v-delta or
   │                                     .v-spinner for live tiles)
   ├─ .v-filterbar                      (existing)
   │  ├─ .v-search  select.v-input  .v-segmented
   │  └─ <details.v-disclose> → .v-fields (agent, tier, sort)
   └─ details.v-task-row (per task)     [.v-task-row--<state>]
      ├─ summary.v-task-row-head
      │  ├─ .v-task-status  (banner: <summary> + .v-progress + elapsed)
      │  ├─ .v-task-main    (title link → /console/requests/<id>, badges)
      │  └─ .v-task-side    (cost, tokens, sub-count)
      └─ .v-task-detail
         ├─ .v-task-detail-head
         ├─ .v-guardstrip  .v-guard×3   [.v-guard data-state=ok|warn|risk]
         ├─ .v-agent-tree  (aside)      mechanism (B): decomposition subtree
         │  └─ .v-agent-tree-row×N      [ --depth-N · .is-active ]
         │     ├─ .v-agent-dot[data-state]   processing|waiting|idle|done|risk
         │     ├─ .v-mono  role + scope name (v-truncate)
         │     └─ .v-progress  (children only, when admitted/running)
         ├─ .v-session-chips  (aside)   mechanism (D): concurrent jcode sessions
         ├─ .v-swarm-chain              mechanism (C): lateral delegations
         │  └─ .v-swarm-hop×N  (chip: target room → state → chainId)
         ├─ .v-step-counter  ("step 47 · 2 tool calls/min")
         ├─ .v-feed  .v-feed-item×N     (existing feed classes)
         │  └─ .v-feed-icon--tool|permission|error|state
         └─ .v-task-links  (ledger claims · trace · artifact · raw session)
```

Reusable pieces deliberately untouched: badges, progress, feed, avatar,
empty/skeleton/spinner/error states, drawer (mobile fallback), tooltips.

---

## 6. Task List View (L4)

### 6.1 Row anatomy — 48px two-line row (`/console/requests` idiom)

| Zone | Content | Classes |
|---|---|---|
| Status banner (left) | state chip (reuse `statusChip(state)` from `components.ts`) + 4px budget-utilization progress bar + elapsed timer | `.v-task-status`, `.v-badge`/`.v-badge-info`…, `.v-progress` |
| Main (center) | goal as `<a>` to `requestDetailUrl(id)` (the *row click* expands; the *title link* navigates — the same dual-target the requests list uses); underneath: scope `.v-tag`, routing-tier `.v-badge`, sub-agent count chip | `.v-task-main`, `.v-card-title`, `.v-tag` |
| Side (right) | `spent_tokens` with `.v-num`, `$x.xx / $cap`, `↳ n sub-agents` (from `parent_request`), `⇢ m swarm hops` (from `hop_chain`), most-recent tool `.v-meta` | `.v-task-side`, `.v-mono` |

### 6.2 State → badge mapping (complete, covers `REQUEST_STATES`)

| Request state | Badge | Tone class |
|---|---|---|
| `PROPOSED`, `QUEUED` | Queued | default `.v-badge` |
| `ADMITTED`, `ACCEPTED` | Ready | `.v-badge-info` |
| `IN_FLIGHT` | Running ● (pulsing) | `.v-badge-info` + `.v-pulse-dot` |
| `DEFERRED` | Waiting | `.v-badge-warn` |
| `DENIED` | Denied | `.v-badge-risk` |
| `REDIRECTED` | Rerouted | `.v-badge-warn` |
| `COMPLETED` | Done | `.v-badge-good` |
| `FAILED`, `EXPIRED` | Failed / Expired | `.v-badge-risk` |
| `TERMINATED_BUDGET` | Out of budget | `.v-badge-warn` |

Default filter shows the four "ongoing" buckets (`QUEUED`, `ADMITTED`,
`ACCEPTED`, `IN_FLIGHT`); `DEFERRED`/`REDIRECTED` live under "Waiting";
completed/failed appear only when the operator switches the segmented
control to "Recent (24h)" — the list is an *ongoing* view first.

### 6.3 Ordering, grouping, pagination, counts

- **Order:** `IN_FLIGHT` first (sorted by most-recent `updated_at`), then
  `ADMITTED`/`ACCEPTED`, then `QUEUED`, then `DEFERRED`. Stable within tier.
- **Group:** no date grouping (unnecessary for < ~50 live tasks); optional
  group-by-scope toggle in `.v-disclose` renders `.v-list-group` headers.
- **Count:** "`N` in flight · `M` waiting" in `.v-count` above the list.
- **Pagination:** keyset by `(state-rank, updated_at)`, 25 per page,
  `.v-pagination` + `.v-count`. The live poll re-merges new rows at the top
  instead of shifting pages.
- **Empty state:** `.v-empty` — "Nothing is running. The queue is clear."
  with links to the full request queue and the ledger.
- **Error state:** `.v-error` block + "Retry" `.v-btn-secondary`.

---

## 7. Task Detail View (expanded row)

### 7.1 Agent hierarchy (requirement 2) — three mechanisms, three views

- **Primary agent** = task's `target_scope` (the `exec_owner`'s room-agent);
  rendered as the root `.v-agent-tree-row` with an `.v-avatar` (monogram of the
  scope), the scope name in `.v-mono`, role label "Primary", and its state dot.
- **Sub-agents — mechanism (B), the nested tree.** Transitive closure of
  `requests.parent_request`, depth capped at 4 for display (deeper chains
  collapse with "… +n" and a link). Rows indent 16px per depth
  (`.v-agent-tree-row--depth-2`, …). A child's own child count shows inline
  (`↳ 2`) so a decomposition subtree is legible without opening each member.
- **Swarm chain — mechanism (C), a separate rail.** Related requests carrying
  the same `chainId` (`swm_…`) / within `hop_chain`, rendered as a flat
  `.v-swarm-chain` of `.v-swarm-hop` chips (target room → state → chainId),
  **never nested under the tree** — these are lateral cross-room delegations,
  not budget-shared children. Link each hop to its own `requestDetailUrl`.
- **Sessions — mechanism (D), chips under the primary.** Best-effort
  `.v-session-chips` of concurrent jcode sessions inside the scope's workspace
  (from live `attached`/`session_status`/`turn_done` events). A scope with >1
  live session reads as "N parallel runs", which is the real intra-agent
  parallelism.
- **Per-agent realtime state**, derived (never stored redundantly):
  - `processing` — state `IN_FLIGHT` **and** a runner `progress` event within
    the last 30s. Dot pulses; small `.v-spinner` beside the name.
  - `waiting` — `IN_FLIGHT` but silent > 30s (typical: a permission
    round-trip, a human approval, or a long tool), or `DEFERRED`, or
    lease-renewing with `step` unchanged.
  - `idle` — `ADMITTED`/`ACCEPTED`/`QUEUED`, not yet claimed.
  - `done` — `COMPLETED` (`.v-agent-dot--done`, uses `--v-fact`).
  - `risk` — `FAILED`/`DENIED`/`TERMINATED_BUDGET` (`--v-risk`).

### 7.2 Guard strip (how it's alive)

Three `.v-guard` chips, each with `data-state="ok|warn|risk"`:

| Guard | ok | warn | risk |
|---|---|---|---|
| **Lease** | renewed < 60s | 60–120s stale | > 120s or lost |
| **Budget** | spent < 70% cap | 70–95% | ≥ 95% or `TERMINATED_BUDGET` |
| **Governance** | no recent denials | 1+ `PERMISSION_DENY` in run | kill switch active for scope |

### 7.3 Live feed

- Top of the main column: the runner's step stream —
  `PERMISSION_ALLOW/DENY`, `KILL_SWITCH_HALTED`, `CONTENT_SCREEN_DENIED`,
  state transitions, and `progress` steps as they arrive — rendered with the
  existing `.v-feed-item` grammar and tinted `.v-feed-icon-*` variants
  (tool = plain, permission = info, denial/error = risk, completion = good).
- Newest event animates in via `.v-rise` (280ms); feed capped at 200 items
  in DOM, older collapsed behind "show full transcript" linking to the
  artifact `fullTextRef`.
- Step counter line: `step {n} · {tokens} tokens · {$/}` — tabular nums,
  JetBrains Mono, updates in place (never flashes the whole row).
- Below the live window: `<details class="v-disclose">` "Event log" for the
  raw audit rows (replay), and `.v-task-links` to claims
  (`/console/ledger?…`), trace, and the persisted transcript artifact.

---

## 8. Interaction States

| Target | states |
|---|---|
| `.v-task-row-head` | idle · `:hover` (bg `--v-bg-2`) · `:focus-visible` (global outline token) · `[open]` (accent left border + lifted card shadow) |
| Title link inside row | underlines on hover; `click` does **not** toggle expansion (stop-propagation by markup structure: `<summary>` excludes nested `<a>` default via `href` capture) |
| Agent tree row | `:hover` highlights; click scrolls the feed to that agent's partition (future: per-agent filter) |
| Cancel button | `.v-btn-danger` — opens `.v-drawer` confirm (type-to-confirm the request id); disabled + `[data-vtip]` when state is terminal |
| Refresh button | `.v-icon-btn`; shows `.v-spinner` while re-fetching snapshot |
| Live pill | `data-state="live|stalled|offline"`; click = manual reconnect |
| Keyboard | `Enter`/`Space` on summary toggles (native); `Esc` closes expanded detail; `j`/`k` row navigation is a fast-follow, out of MVP |

State transitions of the *page*: skeleton (`.v-skeleton` rows ×6, one-time)
→ populated; empty; error (`500` → `.v-error`); stale (poll or SSE dead >
2 poll intervals → `.v-live` flips to `stalled`, amber, banner
`.v-attention-item.v-attention-warn` "Showing data from {time}").

---

## 9. Motion & Animation

- **Pulse (live indicators):** reuse `@keyframes v-pulse` (2.4s) for
  `.v-pulse-dot`, `.v-agent-dot[data-state="processing"]`, `.v-live` dot. One
  rhythm everywhere = "this is alive", matching the marketing badge pulse.
- **Enter:** feed items and newly merged rows use `.v-rise` (280ms
  `--ease-out`, translate 6px).
- **Progress bars:** the existing `.v-progress>i` 300ms width transition is
  the sanctioned smooth-DOM-update technique — never re-render rows.
- **Stalls:** when a running task has had no step for > 30s, its status
  progress bar gets `.v-progress--hatch`: a 1s linear `background-position`
  stripe animation (CSS-only, `prefers-reduced-motion` already neutralizes
  durations globally).
- No motion conveys meaning alone; every animated state also has text
  ("Running", "Waiting on approval") — see a11y §11.

---

## 10. Data & Realtime Contract

### 10.1 Snapshot (server-rendered)

`GET /console/agent-tasks` — rendered from one SQL pass:

```sql
SELECT id, target_scope, origin_scope, goal, state, on_behalf_of,
       spent_tokens, spent_dollars, (SELECT value FROM bid_json…) AS cap_tokens,
       created_at, updated_at,
       (SELECT COUNT(*) FROM requests c WHERE c.parent_request = p.id) AS children
FROM requests p
WHERE tenant = ? AND message_class = 'REQUEST'
  AND state IN ('QUEUED','ADMITTED','ACCEPTED','IN_FLIGHT','DEFERRED','REDIRECTED')
ORDER BY … LIMIT 25 OFFSET ?;
```

Children for the open task are fetched on expansion via
`GET /console/agent-tasks/:id/tree` (JSON: `{id, scope, state, spent_tokens,
children[]}`, recursive `parent_request` closure, depth-limited server-side).
The **swarm chain** (mechanism C) is resolved separately by scanning
`hop_chain` / shared `chainId` for the request (a `json_extract`/`@>` lookup,
not `parent_request`), and by the `swm_…` chain ids the runner's deliberation
emits onto the audit stream. `bid_json` supplies the dollar/token caps the
Budget guard divides `spent_*` against. Existing helpers cover most reads:
`searchRequests` / `partitionRequestsByDecision` (`report.ts`) and
`coord.list(tenant)`.

### 10.2 Live updates — layered, degradable

1. **SSE (primary):** existing `GET /api/events?since=<seq>` (2s audit-log
   poll). Rows update by `target` = request id: state transitions,
   `PERMISSION_*`, `KILL_SWITCH_HALTED`, `JCODE_STARTED/COMPLETED` actions.
2. **Snapshot poll (baseline):** `fetch(location.pathname + '?format=json')`
   every 5s while the tab is visible (`document.visibilityState`), merging
   cost/step/elapsed numbers — this alone satisfies "real-time status";
   SSE is the latency optimizer. Both suspend when `stalled` until clicked.
3. **Runner progress (fast-follow):** `JcodeRunner` already emits
   `ProgressUpdate` events; a small extension publishes them onto the
   audit-log outbox (or a dedicated `GET /api/jcode/events`) so tool-step
   granularity reaches the feed without a new transport.

Client rules: all event handling is additive (`insertBefore(list.firstChild,
list.firstChild.nextSibling)`-style prepends, class swaps, width/text updates);
`Exit` of an animation never blocks; on reconnect, `?since=` resume +
one snapshot diff so nothing is missed between streams.

---

## 11. Accessibility

- WCAG 2.1 AA. One `<h1>`; `h2` per section; detail panel is
  `<div role="region" aria-label="Task <id> detail">` inside the `<details>`.
- `<summary>` carries `aria-expanded` (native); the LIVE pill is
  `<button>` with `aria-pressed` semantics mirrored on the data-state.
- Status is never color-only: badge text + dot + `aria-live="polite"` on
  the feed container (role=log) announces "{tool} finished", "Sub-agent
  {scope} failed".
- Dots get visually-hidden text: `<span class="v-sr-only">processing</span>`.
- Progress bars: `role="progressbar"` + `aria-valuenow/min/max` when the
  token cap is known, else `aria-label="elapsed, cap unknown"`.
- Timers use `aria-label` with full timestamps (screen readers don't tick).
- Focus: expanding a row moves focus into `.v-task-detail-head` (the close
  control); collapsing returns it to the summary. `:focus-visible` uses the
  global `--v-focus` outline rule already in `theme.ts`.
- Reduced motion: the global `prefers-reduced-motion` block already caps
  transitions; hatches/pulses must be `animation:none` there too (add the
  two new classes to that block).

---

## 12. Responsive

| Breakpoint | behavior |
|---|---|
| ≥ 1400px | full workbench incl. optional inspector mirror |
| 1100–1400px | `.v-grid-wide` single column; agent tree above feed |
| < 1100px | KPI strip wraps (auto-fit); row side-zone drops cost to a second line under title |
| < 900px | `.v-page` padding 16px; detail disclosure chevron on right; expanded detail may open as `.v-drawer` when the row is tall — reusing the existing `?drawer=1` / `shellPage({drawer})` convention the `/console/*` list pages already ship, no new markup |
| < 700px | filterbar wraps (existing); table-free by construction; agent tree stays nested (never a table); feed item timestamps move under the message (`.v-feed-time` full-width) |

---

## 13. CSS Additions for `theme.ts`

Proposed for a single new section in `themeCss()` (between *progress* and
*breadcrumb*). Token-only, both themes inherit automatically; light mode
gets the subdued glass values for free. **This spec does not patch
`theme.ts` — the block below is the deliverable for implementation.**

```css
/* ------------------------------------------------------- agent tasks */
.v-task-list{display:grid;gap:8px}
.v-task-row{border:1px solid var(--v-line);border-radius:var(--radius-md);background:var(--v-bg-1)}
.v-task-row>.v-task-row-head{display:flex;align-items:center;gap:10px;padding:13px 16px;cursor:pointer;list-style:none;min-width:0}
.v-task-row>.v-task-row-head::-webkit-details-marker{display:none}
.v-task-row>.v-task-row-head:hover{background:var(--v-bg-2)}
.v-task-row[open]{border-color:var(--v-line-strong);box-shadow:var(--v-card-shadow)}
.v-task-row[open]>.v-task-row-head{border-bottom:1px solid var(--v-line)}
.v-task-status{display:flex;align-items:center;gap:8px;min-width:0}
.v-task-main{flex:1;display:grid;gap:3px;min-width:0}
.v-task-side{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--v-muted);white-space:nowrap}
.v-task-detail{display:grid;gap:16px;padding:16px}
.v-task-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.v-agent-tree{border:1px solid var(--v-line);border-radius:var(--radius-md);background:var(--v-bg-2);padding:8px 10px;display:grid;gap:2px}
.v-agent-tree-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:var(--radius-sm);font-size:12.5px;min-width:0}
.v-agent-tree-row--depth-2{margin-left:16px}
.v-agent-tree-row--depth-3{margin-left:32px}
.v-agent-tree-row--depth-4{margin-left:48px}
.v-agent-tree-row.is-active{background:var(--v-bg-1);box-shadow:inset 2px 0 0 var(--v-accent)}
.v-agent-dot{width:8px;height:8px;border-radius:50%;background:var(--v-faint);flex-shrink:0}
.v-agent-dot[data-state="processing"]{background:var(--v-pred);animation:v-pulse 2.4s var(--ease-out) infinite}
.v-agent-dot[data-state="waiting"]{background:var(--v-hypo)}
.v-agent-dot[data-state="done"]{background:var(--v-fact)}
.v-agent-dot[data-state="risk"]{background:var(--v-risk)}
.v-swarm-chain{display:flex;flex-wrap:wrap;gap:6px}
.v-swarm-hop{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 9px;border-radius:var(--radius-pill);border:1px dashed var(--v-line-strong);background:var(--v-bg-2);color:var(--v-ink-2);text-decoration:none}
.v-swarm-hop:hover{border-style:solid;border-color:var(--v-accent);color:var(--v-accent);text-decoration:none}
.v-session-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.v-session-chips .v-tag[data-state="open"]{color:var(--v-ink);border-color:var(--v-line-strong)}
.v-step-counter{font-family:var(--font-mono);font-size:11.5px;color:var(--v-muted);font-variant-numeric:tabular-nums}
.v-guardstrip{display:flex;gap:8px;flex-wrap:wrap}
.v-guard{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:var(--radius-pill);border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2)}
.v-guard::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--v-faint)}
.v-guard[data-state="ok"]::before{background:var(--v-fact)}
.v-guard[data-state="warn"]::before{background:var(--v-hypo)}
.v-guard[data-state="risk"]::before{background:var(--v-risk)}
.v-live{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--v-muted)}
.v-live::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--v-fact);box-shadow:0 0 8px var(--v-glow-accent);animation:v-pulse 2.4s var(--ease-out) infinite}
.v-live[data-state="stalled"]::before{background:var(--v-hypo);animation:none}
.v-live[data-state="offline"]::before{background:var(--v-faint);animation:none}
.v-progress--hatch>i{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.22) 0 6px,transparent 6px 12px),none;animation:v-hatch 1s linear infinite}
@keyframes v-hatch{to{background-position:17px 0}}
@media (prefers-reduced-motion:reduce){.v-agent-dot[data-state="processing"],.v-live::before,.v-progress--hatch>i{animation:none}}
```

(`rgba(255,255,255,.22)` inside the hatch is a translucent texture, not a
palette color — consistent with the existing glass tokens; if reviewers
disagree, alternate: mask-stripes over `var(--v-accent)`.)

---

## 14. Integration Checklist

1. `theme.ts` — add §13 block to `themeCss()` (only place new CSS may live).
2. `src/console/agent-tasks.ts` — body-fragment producer using
   `renderListPage`/`renderTable`/`statusChip` (`render.ts`, `components.ts`);
   the response is wrapped by `themeDocument()` at the boundary (guaranteed by
   the existing wrapper, nothing to remember).
3. `src/console/routes/agent-tasks.ts` — a `RouteDef[]` (pattern
   `/console/agent-tasks`, `capability:'session'`, `surface:'html'`,
   `activation:'required'`) registered through `routes/registry.ts`, exactly
   like `routes/lists.ts`; plus a `?format=json` variant for the poller and a
   tree/swarm endpoint `/console/agent-tasks/:id/tree`. Also add the manifest
   entry (`*_CAPABILITIES`) the route-table test pins. Session-gated
   identically to `/api/events`. Do NOT add a new branch to the `serve.ts`
   legacy if-chain.
4. `console-shell.ts` — add an Operations `RailItem` AND register its `navKey`
   in `RAIL_KEYS` + `titleFor`, else the rail falls back to Dashboard.
5. Client JS — inline `<script>` in the fragment (project convention:
   self-contained per-page scripts, no shared bundle): SSE attach, poll
   merge, row expand, `#task-…` deep-link restore on load, drawer fallback.
6. Publish `ProgressUpdate` onto the event outbox (runner already emits;
   one subscriber in `worker.ts` wiring).
7. Tests (`test/`): snapshot SQL shape; state→badge mapping table; tree
   closure depth cap; **swarm chain never rendered as `parent_request`
   children**; route registered **and** navigable + `navKey` in `RAIL_KEYS`;
   reduced-motion coverage of the new animations.

## 15. Acceptance Criteria

- [ ] All in-flight Jcode tasks visible within 5s of starting, without reload.
- [ ] Clicking a row expands detail in place; URL carries `#task-<id>` and
      survives refresh.
- [ ] Detail names the primary agent and every sub-agent with per-agent live
      status (processing/waiting/idle/done/risk), text-labeled not color-only.
- [ ] Tool steps, permission denials, budget pressure, and completion appear
      in the feed within one poll interval (2s SSE / 5s snapshot).
- [ ] Killing a task via the existing kill switch flips its row to the risk
      state and the Governance guard to red within one heartbeat (≤ 25s).
- [ ] All new visuals use `var(--v-*)` tokens; light and dark both pass a
      contrast spot-check; `grep` finds no new literal hex outside `theme.ts`.
- [ ] Keyboard-only operator can browse, expand, cancel, and escape without
      getting trapped.
