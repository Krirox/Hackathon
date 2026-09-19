# buzz — Chat Workspace (internal name `buzz`, user-facing `Workspace` / `Rooms`)

Chat-first home for Vital. `Buzz` is the engine name; humans see `Workspace` (nav) and `#room-name` (rooms).

## Where the implementation actually lives

**The real chat UI and API are in `src/console/` and `src/talk/` — there is no parallel implementation here.** The former `ui/` files (Composer, Shell, Message, RoomView, Roster) were comment-only placeholder stubs that were never imported by anything and have been deleted.

- `src/console/buzz.ts` — room rendering, thread view, composer, reactions, review cards (`renderBuzzRoom`)
- `src/console/workspace-shell.ts` — the workspace chrome (sidebar, rail, header metrics) with real telemetry reads
- `src/console/serve.ts` — `/console/buzz*` + `/api/buzz/*` routes
- `src/talk/` — rooms config, health evaluation, gas gauges, commands, surfaces

What remains in this folder (`server/`, `state/`, `docs/`) is design material for a future extraction of routes and state into this directory. Treat it as notes, not as shipped code, until an import path actually reaches it.

## How talk works

- **Human chat:** the console composer in `src/console/buzz.ts` posts to `POST /console/buzz/:scope/command` (CSRF + audit_log). Signed Buzz kind-9 publishing goes through `src/talk/buzz-surface.ts:post` with `h` (channel UUID), `e` (thread), `vital-request/tool` tags.
- **Agent chat:** same `surface.post()` — agent names from `BUZZ_AGENT_MASTER_KEY` HKDF (`src/talk/agent-keys.ts`). Progress + `[HUMAN ATTENTION REQUIRED]` cards + drift beacons all go through it.
- **Agent→Agent:** `@finance-agent do X [clm_...]` → `swarm.ts:parseCrossRoomDispatch` → `Coordinator` REQUEST to target scope → posts in both rooms → on high churn fans to `#exec`/`#growth`.
- **Fallback:** no relay → `loadRoomThread()` returns local `audit_log` tail, banner `Local activity`.

## Rebrand rule

User-visible strings show `Workspace`/`Rooms`/`Relay`, never `Buzz`. Internal identifiers, file names, and comments keep `buzz`/`BUZZ_*`.

## Start

See `../BUZZ_FINAL_TODO.md` for the integration history.
