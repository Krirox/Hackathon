# BUZZ_FINAL_TODO — Chat Workspace (user-facing: **Rooms / Workspace**, never "Buzz")

> **Intent:** Take everything Buzz built that *is* chat, put it in `/buzz` in-repo, drop everything that is infra/ops, and ship a chat that looks like **Image 1** (human stream) not Image 2 (ops table). Internal folder stays `buzz/` for imports; user never sees the word Buzz.

Source of truth: `Buzz_TODO.md` + `docs/adr/0002-buzz-live-integration.md` (real BIP-340/NIP-98 verified). `docs/adr/0001-buzz-is-a-surface.md` is deprecated — ignore.
Workspace entry: `GET /console/buzz` (roster) → `GET /console/buzz/:scope` (room thread) — `src/console/buzz.ts`, `src/console/serve.ts:2719`.

---

## 0) What stays in `/buzz`, what is removed

**Keep → move into `/buzz`:**
- Chat fabric: `src/talk/buzz.ts`, `buzz-surface.ts`, `buzz-runtime.ts`, `nostr.ts`, `agent-keys.ts`, `provision.ts`
- Chat UI: `src/console/buzz.ts` (roster + room render), `src/talk/review-card.ts` (approve/decline tokens), `src/talk/rooms.ts` (12 canonical rooms), `src/talk/health.ts` (🟢🟡🔴 badges), `src/talk/budget-gauge.ts`
- Agent↔Agent: `src/talk/swarm.ts` (cross-room handoffs), `src/talk/enforce.ts` (autonomy/budget gates), `src/talk/canvas.ts` (live canvas)
- Chat API: `src/console/serve.ts` `/console/buzz*` + `/api/buzz/*` handlers (extract to `buzz/server/`)
- Tests: `test/buzz*.test.ts`, `test/nostr.test.ts`

**Remove / do not move:**
- Infra: `deploy/aws/buzz.tf`, `deploy/docker-compose.buzz.yml`, S3/Redis/EFS mentions — keep in `deploy/` only, not chat
- Ops-only toys: `src/talk/canary.ts` (no scheduler), `src/talk/huddle.ts` (kind 30024 rejected by relay), `src/talk/fork.ts` (webhook-only, no UI) — keep if needed but hide from chat UI
- Secrets defaults / `VITAL_REVIEW_SECRET=vital-review-secret` — already fixed in 0002, do not reintroduce

**Rebrand map (internal → user-facing):**
`Buzz Workspace → Workspace` | `#risk-monitor (Buzz)` → `#risk` | `Buzz relay` → `Workspace relay` (or hide entirely) | `BUZZ_*` env stays internal, UI shows `Workspace`/`Rooms`

---

## Phase 0 — Scaffold & Freeze (0.5 day) — ✅ done 2026-09-18

- [x] Create `buzz/` with layout below — no logic yet, only moves + renames verified by `npm run typecheck`
```
buzz/
  README.md                 # this doc's short version + rebrand map
  ui/                       # chat interface (from src/console/buzz.ts)
    Roster.tsx              # was renderBuzzRoster — keep table first, then replace with chat list
    RoomView.tsx            # was renderBuzzRoom — thread + command box + canvas
    Message.tsx             # was loadRoomThread item renderer
    Composer.tsx            # was /command input — add @ 📎 😊 Aa bar
    ReactionBar.tsx         # new — was inline ✅ 1 in Image 1
  server/
    routes.ts               # extract /console/buzz* + /api/buzz/* from serve.ts
    surface.ts              # re-export from src/talk/buzz-surface.ts
    runtime.ts              # re-export from src/talk/buzz-runtime.ts
  state/
    rooms.ts                # from src/talk/rooms.ts (12 canonical rooms)
    health.ts               # from src/talk/health.ts
    swarm.ts                # from src/talk/swarm.ts
  docs/
    CHAT.md                 # how humans+agents talk (this file § Chat)
```
- [ ] Verify `npm test` still green — moves only, no behavior change
- [ ] Add `eslint` rule: no `Buzz` string in `buzz/ui/**`

## Phase 1 — Rebrand (1 day, ships immediately) — ✅ done 2026-09-18

- [x] Rename every user-facing `Buzz` → `Workspace` (or `Rooms` per UX pick) in `buzz/ui/**` + nav (`src/console/render.ts:351` `label: 'Buzz' → 'Workspace'`)
- [x] Relay line: `Relay not configured → Workspace is working locally. Relay not connected — messages stay on this workspace.` (hide `BUZZ_RELAY_URL` jargon) — `src/console/buzz.ts:166`
- [x] Keep internal `buzz` folder + `BUZZ_*` env — only UI changes
- [x] Check: `grep -r "Buzz" buzz/ui` → 0 hits (internal only)

## Phase 2 — Chat shell like Image 1 (2–3 days, the visible gap) — ✅ core done 2026-09-18

Goal: Image 2 (table + `□□□□`) → Image 1 (avatar stream + reactions + composer).

- [x] Layout: sidebar (room list with 🟢🟡🔴 dot + unread) | center (scrollable message list) | composer at bottom — roster `src/console/buzz.ts:renderBuzzRoster` now sidebar + cards, room `renderBuzzRoom` now avatar stream
- [x] `Message.tsx`: avatar + `Name 6:12 PM` + markdown + `Linear · issue BUZ-519` card + reaction bar (`✅ 1` `🚀 2`) + `@Alex Rivera` mention pill — `buzz.ts:avatarColor/initials/linkify` + `buzz/ui/Message.ts`
- [x] `Composer.tsx`: `Message #engineering` placeholder + `@ 📎 😊 Aa` bar + `↑` send — replaces solo `/command` input, still posts to `POST /console/buzz/:scope/command` — `buzz/ui/Composer.ts` + `buzz.ts` composer block
- [ ] Keep command input as `/` autocomplete inside composer (follow-up: slash-command palette)
- [x] Fix mojibake gauges: `renderProgressBar` `■/□` renders correctly with web-font (verified on Docker)
- [x] Acceptance: room view no longer a table — verified `has-new-layout` + `has-composer` on Postgres live

## Phase 3 — Real chat transport (1 day)

- [ ] Keep `buzz-surface.ts` contract: `POST /events` bare bare event, NIP-98 per request, `BUZZ_CHAT_KIND=9`, `tags: [h, channelId]` resolved via `channelIdFor`
- [ ] Provisioning stays: `scripts/seed-buzz-rooms.ts` → channel UUID from kind-39000 `d` tag, persisted per room
- [ ] Fallback: `loadRoomThread` stays — relay → `200` with messages, else `localRoomActivity` audit tail with `Local activity` note (already works on current Docker)
- [ ] Whitelist: only kinds `9`, `30315`, `30023` — do not retry `30024` (huddle) — relay rejects it

## Phase 4 — How agents talk (keep, do not reimplement)

This is the "from buzz we use chat interface, and how agent talk to each etc" answer — document and keep as-is:

**Human → Human:** `Composer.tsx` → `POST /api/buzz` (future) or current `POST /console/buzz/:scope/command` (CSRF + `audit_log`) → kind-9 via surface → thread. No relay → local tail.

**Human → Agent:** Review card `renderReviewCard()` (`src/talk/review-card.ts:89`) → `VITAL_REVIEW_SECRET` HMAC token → `GET /api/buzz/webhook` shows confirm form → `POST` mints decision + `audit_log`. `👍` reaction does nothing — must Approve.

**Agent → Human:** `agent posting`: `surface.post({ channel, threadRoot, requestId, step, tokens, state, text })` (`buzz-surface.ts:244`) → kind-9 with `vital-request` + `vital-tool` tags + NIP-10 `e` thread. Seen in Fig. at `Buzz_TODO §3` — 🟡 `HUMAN ATTENTION REQUIRED` + evidence chips + `[Approve][Decline][Steer]`.

**Agent → Agent (Swarm):** `InterAgentSwarmCoordinator.executeHandoff()` (`src/talk/swarm.ts:100`) — parses `@finance-agent assess churn [clm_...]` → `coord.submit(REQUEST, targetScope)` → ledger `derived_from` link → posts deliberation in both rooms. On high-risk churn ≥10%, `handleAssessmentOutcome()` auto-fans to `#exec` + `#growth` with new `swarm.*` requests. All `🟡` — not triggered from live traffic yet (`not triggered from live room traffic` in Buzz_TODO §7). To enable, wire worker dispatch → swarm, not UI.

**Agent ↔ Ledger:** `TalkSurface.bindClaim/verifyEnvelope` (`src/talk/surface.ts:47`) — HMAC `slack-hmac` fallback when Buzz absent, tamper-evident, Ledger stores `buzzEventSig` + verifies on read.

- [ ] No new agent-messaging code in this phase — only docs + keep existing `swarm.ts:37 parseCrossRoomDispatch` regex

## Phase 5 — Slash commands & enforcements (0.5 day)

- [ ] Keep: `/halt`, `/recover`, `/status`, `/cost`, `/policy set …` (`src/talk/commands.ts` + `gov/trust.ts` + `gov/act.ts`) — already audit-logged
- [ ] Move command help into `Composer.tsx` placeholder: `Commands: /halt …` → lookup
- [ ] Keep `enforce.ts` autonomy tiers: `autonomous` / `guarded` (85% gate) / `supervised` — no UI bypass

## Phase 6 — Cleanup & announce (0.5 day)

- [ ] Delete from chat view: `canary`/`huddle`/`fork` cards (keep modules but hide)
- [ ] Remove `deploy/docker-compose.buzz.yml` from docs (already deprecated) — single reference stays in `buzz/docs/CHAT.md` as "AWS-only"
- [ ] `docs/deployment-plan.md` add one line: `Workspace (ex-Buzz) lives in /buzz/ui, relay optional`
- [ ] Screenshot new `Workspace` roster + `#engineering` thread (should match Image 1 structure) and replace Image 2 in PR

---

## Acceptance (chat interface only)

- [ ] New user path: login → `Workspace` nav (not `Buzz`) → room list → pick `#engineering` → sees avatar stream + reaction bar + composer (like Image 1) — no table
- [ ] With no relay, room shows `Local activity` + audit messages, not 500 — proved on Docker (`buzz-probe.mjs` 200)
- [ ] With relay + `BUZZ_AGENT_MASTER_KEY`, same UI shows `Live from the relay.`
- [ ] `grep -R "Buzz Workspace" buzz/ui` → 0
- [ ] `npm run typecheck && npm test` green
