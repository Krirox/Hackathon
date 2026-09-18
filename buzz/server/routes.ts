// Chat server routes — extracted from src/console/serve.ts
// GET  /console/buzz            → roster (Workspace)
// GET  /console/buzz/:scope     → room thread (chat layout)
// POST /console/buzz/:scope/command → slash command (audit-logged)
// All admin-gated via atLeast(admin), relay optional (local fallback).
// See src/console/serve.ts:2719 for live wiring.

export const BUZZ_ROUTES = [
  "GET /console/buzz",
  "GET /console/buzz/:scope",
  "POST /console/buzz/:scope/command",
  "GET /api/buzz/rooms",
  "POST /api/buzz/rooms/configure",
  "POST /api/buzz/commands",
] as const;
