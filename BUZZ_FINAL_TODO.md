# BUZZ_FINAL_TODO.md — Chat-First Agent Orchestration & Workspace Shell

> **Vision**: Transform Vital into a **chat-first autonomous agent environment**.
>
> - **Primary Workspace**: Upon login, users land directly in the Buzz chat UI (`/console/buzz/...`).
> - **Team Channels**: `#marketing`, `#engineering`, `#general`, `#finance`, etc. Humans talk, plan, and mention agents (`@marketing-agent`, `@growth-agent`, `@finance-agent`).
> - **Cross-Room Agent Context**: When tagged, agents possess full context across all rooms via the Reality Ledger (cross-room evidence injection + tool search), reply with grounded intelligence, and execute real cross-agent handoffs (`InterAgentSwarmCoordinator.executeHandoff`).
> - **Vital Dashboard Access**: On the bottom left of the sidebar, right above Settings/Account cluster, a prominent link/button opens the **Vital Dashboard** (`/console/dashboard` or `/console?view=dashboard`) containing everything else outside of chat (Compiler pipeline, Why not trusted yet, Metrics, Ledger, Coordination, Router, Governance, Economics, Evals).
> - **Flyout Right Drawer**: Tooling and inspection cards (Compiler, Workflows, Ledger search) are also accessible alongside chat via `?drawer=1` without context switching.

---

## Architecture & Visual Hierarchy

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ VITAL WORKSPACE (Chat-First)                                                           │
├───────────────┬──────────────────────────────────────────┬─────────────────────────────┤
│ SIDEBAR       │ CHAT ROOM VIEW (e.g. #marketing)         │ RIGHT DRAWER (?drawer=1)    │
│               │                                          │ (Compiler / Workflows /     │
│ 🌐 general    │ [10:14] 👤 Sarah: We need a Q4 campaign. │  Ledger / Why Not Trusted)  │
│ 📈 marketing  │ [10:15] 👤 Sarah: @marketing-agent plan  │ ┌─────────────────────────┐ │
│    (business) │   and tag @finance-agent for budget.     │ │ COMPILER PIPELINE       │ │
│ ⚙️ engineering │ ──────────────────────────────────────── │ │ [TRACE] [CANDIDATE]     │ │
│ 💰 finance     │ [10:15] 🤖 marketing-agent:              │ │ [QUARANTINE] [SHADOW]   │ │
│ ⚖️ legal       │   "Drafted launch plan. Cross-room       │ │ [PILOT] [PROMOTED]      │ │
│ 🔬 research   │    evidence [clm_8f21].                  │ ├─────────────────────────┤ │
│ 👥 hr         │    @finance-agent: please model spend."  │ │ WHY NOT TRUSTED YET     │ │
│ 🛠️ ops        │ [10:16] 🤖 finance-agent:                │ │ ○ Cross-model: 20%      │ │
│ 🎨 design     │   "Received task from #marketing.        │ │ ○ Regression:  30%      │ │
│ ...           │    Evaluating runway impact..."          │ │ [ Promote Card ]        │ │
│ ───────────── │ ──────────────────────────────────────── │ └─────────────────────────┘ │
│ 📊 Vital      │ Message #marketing                       │                             │
│    Dashboard  │ [@ ]  [📎]  [😊]  [Aa]   [Fizz: Working] │                             │
│ ───────────── │                                          │                             │
│ ⚙️ Settings / │                                          │                             │
│    Account    │                                          │                             │
└───────────────┴──────────────────────────────────────────┴─────────────────────────────┘
```

---

## Phase Roadmap

### Phase 0 — Keep buzz/ as chat home, add alias (0.5d)

- [x] Add `marketing` → `business` alias in `src/talk/rooms.ts:303` (`if (clean === 'marketing' || clean === 'marketing-agent') return 'business';`).
- [x] Broaden mention regex in `src/console/buzz.ts:389` to `/@([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)/` to match hyphenated agent names (`@marketing-agent`, `@growth-agent`, `@finance-agent`) and multi-word names.
- [x] Extend autocomplete datalist `#buzz-users` in `src/console/buzz.ts:340` to include human users (`listUsers`) + all room agents (`CANONICAL_ROOMS.map(r => r.agentName)` + aliases).
- [x] Add `general` canonical room (`scope:general`, `agentName: 'general-agent'`, `chan-general`) to `CANONICAL_ROOMS` in `src/talk/rooms.ts:225` as the 13th room to power the company-wide global chat.

### Phase 1 — Make chat the default entry & add Dashboard entry (0.5d)

- [x] In `src/console/serve.ts`:
  - `1871` (GET `/login` when `sessionOf()`): redirect to `${home}console/buzz/${defaultRoomForUser(user)}`.
  - `1986` (POST `/login` success): redirect to `next ?? ${home}console/buzz/${defaultRoomForUser(user)}`.
  - `2076` (POST `/login/mfa`): redirect to `next ?? ${home}console/buzz/${defaultRoomForUser(user)}`.
  - `3625` (GET home after auth): redirect to `${home}console/buzz/${defaultRoomForUser(user)}` (preserves `/console/dashboard` or `/console?view=dashboard` for full dashboard).
- [x] Implement `defaultRoomForUser(db, tenant, user)` reading `meta` key `user:defaultRoom:${tenant}:${userId}` with fallback to `business` (marketing) for users whose email or role matches marketing, otherwise `general`.
- [x] In `src/console/workspace-shell.ts`:
  - Pass `activeScope` so the current room is highlighted (`#0F5C57` dark teal).
  - Add a dedicated **Vital Dashboard** launcher button on the bottom left directly above Settings/Account cluster (`<a href="${esc(home)}console/dashboard" id="vital-dashboard-btn" ...>📊 Vital Dashboard</a>`) so users can access Compiler, Feed, Ledger, Coordination, Router, Governance, Economics, and Evals.

### Phase 2 — One more chat that connects to all (`#general`) (0.5d)

- [x] In `src/console/buzz.ts`: when viewing `#general` (`scope:general`), display cross-cutting pending approvals across all scopes (`pendingForRoom` aggregates all admitted human-minute requests across all rooms).
- [x] Swarm treats `#general` as broadcast/fan-out when an open request is submitted.
- [x] Dynamic composer placeholder: `Message #${esc(def.name)}` (e.g. `Message #general`, `Message #growth`).

### Phase 3 — Give `@marketing-agent` context about other things (1d)

- [x] Extend `Ledger` in `src/ledger/ledger.ts:135` (and implementations) with `search(tenant, { q, scopes[], kinds, status, limit })` reusing the LIKE query pattern from `src/console/report.ts:718`.
- [x] In `src/jcode/runner.ts:392`, expand prompt assembly:
  - Inject `[Grounded Context]` from direct claim refs.
  - Inject `[Cross-Room Evidence]` block from `ledger.search` for top-8 cross-room claims relevant to the task/command.
  - Expose `ledgerSearch` tool so agents can search claims during execution.
- [x] Inject pending approvals from all rooms and recent cross-room claims into in-room agent responses.

### Phase 4 — Wire `@` in chat to real handoffs (1d)

- [x] In `src/console/serve.ts:2838` (`/command` when not a room command) and `2888` (`/reply` + unified chat message POST):
  - Parse text for `@` mentions: `text.matchAll(/@([a-zA-Z0-9_-]+)/g)`.
  - Resolve target agent via `CANONICAL_ROOMS` + aliases (`marketing-agent` → `growth-agent` / `scope:business`, `finance-agent` → `finance` / `scope:finance`).
  - If a cross-room agent is tagged, instantiate `InterAgentSwarmCoordinator` with `{ db, ledger, coord, surface }`.
  - Call `InterAgentSwarmCoordinator.executeHandoff({ tenant, originScope: scope, dispatchText: content, threadRoot: parentId })`.
  - Deduplicate and audit as `buzz.dispatch`.
  - Swarm posts deliberation messages to both the origin room and target room.

### Phase 5 — Make other UIs (Image 3 Compiler etc.) around chat (0.5d each)

- [x] In `src/console/serve.ts`, support `?drawer=1` query parameter on routes (`/console/workflows`, `/console/requests`, `/console/claims`, `/console/compiler`, `/console/dashboard`):
  - When `?drawer=1` is passed, return only the inner HTML fragment suitable for embedding in a slide-out right drawer.
- [x] Chat slash commands:
  - `/compiler [state|id]` -> ephemeral bot reply & open Compiler drawer.
  - `/ledger <query>` -> search claims & open Ledger drawer.
  - `/requests` -> open Requests review drawer.
- [x] Provide drawer view for "Why not trusted yet" readiness cards and Compiler pipeline alongside the chat stream.

---

## Verification Plan

- [x] **Typecheck**: `npm run typecheck` exits 0.
- [x] **Buzz Workspace Tests**: `node --import tsx --test test/buzz-workspace.test.ts` passes (5/5).
- [x] **Auth Redirect**: Authenticated GET `/` or GET `/login` redirects to `/console/buzz/general` (or user's default room).
- [x] **Vital Dashboard Link**: Sidebar contains "📊 Vital Dashboard" above Settings, loading `/console/dashboard`.
- [x] **Cross-Room Handoff**: Tagging `@finance-agent` in `#marketing` initiates a downstream request in `scope:finance` and logs `buzz.dispatch`.
- [x] **Ledger Cross-Room Search**: `ledger.search` returns relevant claims across multiple scopes.
- [x] **Drawer Route**: GET `/console/requests?drawer=1` returns HTML without outer body/head wrapper.
