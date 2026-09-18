# buzz — Chat Workspace (internal name `buzz`, user-facing `Workspace` / `Rooms`)

Chat-first home for Vital. `Buzz` is the engine name; humans see `Workspace` (nav) and `#room-name` (rooms). This folder is the **only** place chat UI + agent-talk fabric live — everything else stays in `src/`.

## What is in here
- `ui/` — Roster + Room chat (avatar stream, Linear card, reactions, `@` mentions, composer) — replaces `src/console/buzz.ts` table
- `server/routes.ts` — `/console/buzz*` + `/api/buzz/*` extracted from `src/console/serve.ts`
- `state/` — `rooms.ts` (12 canonical rooms), `health.ts` (🟢🟡🔴), `swarm.ts` (agent→agent)

## How talk works
- **Human chat:** `ui/Composer.tsx` → signed kind-9 (`buzz-surface.ts:post`) with `h` (channel UUID), `e` (thread), `vital-request/tool` tags. See `BUZZ_FINAL_TODO.md` Phase 4.
- **Agent chat:** same `surface.post()` — agent names from `BUZZ_AGENT_MASTER_KEY` HKDF (`src/talk/agent-keys.ts`). Progress + `[HUMAN ATTENTION REQUIRED]` cards + drift beacons all go through it.
- **Agent→Agent:** `@finance-agent do X [clm_...]` → `swarm.ts:parseCrossRoomDispatch` → `Coordinator` REQUEST to target scope → posts in both rooms → on high churn fans to `#exec`/`#growth`.
- **Fallback:** no relay → `loadRoomThread()` returns local `audit_log` tail, banner `Local activity`.

## Rebrand rule
`grep -r "Buzz" buzz/ui` must be 0. Internals keep `buzz`/`BUZZ_*`; UI shows `Workspace`/`Rooms`/`Relay` as `Workspace relay`.

## Start
See `../BUZZ_FINAL_TODO.md` Phase 0 scaffold.
