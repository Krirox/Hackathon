# Deployment — the one supported topology

Reference (production): **VPS-1 Buzz · VPS-2 Vital core + Postgres · VPS-3
jcode** (sibling process over the harness API). Dev approximation:
`deploy/compose.yml` (Buzz + core + Postgres on one box).

## Rules

- One supported topology. Custom-config sales asks are how a product
  company becomes an infra company (risk register, `idea.md` §20).
- Buzz is a surface: the Ledger survives a Buzz→Slack swap (spike proven,
  `src/talk/surface.ts`). Test the swap in Phase 0, not Phase 7.
- jcode is coordinated, not mounted: a REQUEST with a bid goes in, a
  deliverable + claims + cost come back. Zero ambient credentials cross —
  scope tokens (`src/substrate/identity.ts`) are the only credential.
- Egress allow/deny + metadata/IP blocks are decided in exactly one place
  (`src/substrate/egress.ts`); the proxy enforces, it does not interpret.
- Sandboxes rebuild from manifests; persistence is never trust-bearing.
- Kill switches exist at tenant / scope / action-class level and are
  drilled (`killDrill`). An untested kill switch is a UI element.

## Postgres (VPS-2)

- The schema is derived, never maintained twice: `PG_SCHEMA` is the one
  SCHEMA translated (`AUTOINCREMENT` → `BIGSERIAL`), verified identical in
  CI. Migrations: `migratePostgres` + additive journal; version stamped.
- **PITR is on.** RDS: automated backups with a 7-day (min) retention
  window before any pilot data lands; Cloud SQL: point-in-time recovery
  enabled at instance creation. Verify with a restore drill to a scratch
  instance quarterly — an untested backup is a UI element, like the kill
  switch. Ledger export (`exportLedger`) is the portable second copy, not
  the backup strategy.
- `DATABASE_URL=postgres://…` selects the PG driver at runtime
  (`openFromEnv`); anything else stays sqlite. CI boots a postgres:16
  service and runs `verify-instance` against it on every push.

## Boot check

`npm run typecheck && npm test && npm run lint` green, then
`tsx src/cli.ts status --db var/vital.db`. A stranger boots the dev
topology from this file plus `README.md` in under 30 minutes (Phase 0
exit gate — not yet timed; time it before claiming it).
