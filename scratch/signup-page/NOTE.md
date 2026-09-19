# Public sign-up page — parked, not shipped

Moved out of `site/` because it cannot be honest or reachable as a marketing page:

- `/signup` is a **console route** (`src/console/serve.ts`). In a co-hosted
  deployment (`vital serve --site site`) console routes win over the static
  fallthrough, so `site/signup/index.html` was never served.
- In a standalone static deployment it *was* served — and it reported
  "● account created" while its script only validated fields and toggled a
  success panel. Nothing was created anywhere.
- The product closes sign-up after the first owner claims the tenant: the
  console answers `403 signup is closed — membership is invite-only`, and
  README §"Initial Tenant Claiming & Signup" documents exactly that. The
  pinned gates `FLOW-011` / `FLOW-026` (`test/site-accessibility.test.ts`) assert
  the marketing site carries no sign-up copy and keeps `data-signin-note`.

If a real self-serve funnel is wanted, it has to be built server-side first
(console route + `createUser`/`signupTenant` path, CSRF, rate limit, and the
`FLOW-011` gate updated in the same change) — not as a static page that fakes
the last step.

Restoring the CTA copy that pointed here:
`git apply scratch/site-signup-funnel.patch` (patch captured from the working tree
before the site was put back on its invite-only copy).

Note: `../styles.css`, `../app.js` and `signup.js` paths are relative to
`site/signup/`; adjust them if you preview this page from here.
