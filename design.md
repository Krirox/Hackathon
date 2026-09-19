# Design — Vital Console & Workspace

A locked design system for this app. Every console/workspace redesign reads
this file before emitting code. Do not regenerate per page — extend or amend
this file when the system needs to grow.

Hallmark multi-page redesign · 2026-09-19
Genre: modern-minimal (Linear/Stripe school) on dark paper.
Macrostructure family: Workbench for all Console pages (rail + stream +
  inspector). The Workspace/chat is NOT a Console page and is exempt — it
  mirrors upstream Buzz and is locked to Buzz's own look (see "Two surfaces").
Nav: N3 side-rail. Top: N13 inline ⌘K-pill. No footer on app pages.
Enrichment: none on app pages — function carries the page.

## Genre

modern-minimal

## Two surfaces — do not blur them

This codebase renders two visually distinct surfaces, and they are separate on
purpose. Restyling one must never re-skin the other.

1. **Console** — Dashboard, Ledger, Approvals, Workflows, Governance, Activity,
   Requests, Claims, Audit, Rooms, Data, Learning, Compiler, Human work, Team,
   Account, detail pages, setup.
   Shell: `src/console/console-shell.ts` (`renderConsoleShell`, `ws-*` classes).
   Owns the design tokens, Inter, the theme toggle, and dark mode.
2. **Workspace / chat** — the Buzz surface: room roster, per-room thread,
   Issues board.
   Shell: `src/console/workspace-shell.ts` (upstream Buzz classes
   `buzz-window`, `buzz-sidebar`, `buzz-top-nav`, `buzz-content-card`).
   **Locked to upstream Buzz.** Keeps Buzz's own near-white palette and its
   native font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", …`),
   NOT Inter. No tokens, no `data-theme`, no theme toggle, no dark mode.

Why the chat is exempt: it is a faithful mirror of the real Buzz client
(`.upstream/buzz`, see its `VISION.md` — "Stream — Slack-like, fast"). Of the
chat's 47 literal colours, exactly one (`#FFFFFF`) coincides with a light-mode
token value, so tokenising it cannot be a no-op — it would change the chat's
look. That is why the chat is exempted rather than restyled.

### How the split is enforced

- `wrapInWorkspaceShell` in `serve.ts` branches once: `navKey === 'buzz'` → Buzz
  shell; every other nav key → Console shell. Chat is identified by nav key
  because that is the only place the two families differ.
- The chat path returns Buzz's document verbatim and does **not** call
  `themeDocument()`.
- `themeDocument()` (the `res.end` boundary in `serve.ts`) would otherwise
  inject the token block into every `text/html` response, and its `body` rule
  uses `!important` — which would re-font the chat from the system stack to
  Inter. `buzzDocument()` therefore carries `THEME_OPTOUT_MARKER`
  (`data-vital-no-theme`) in a `<head>` comment, and `themeDocument()` returns
  any document carrying it untouched.
- The marker is an HTML comment: it has no visual effect, so the chat's
  rendered output stays byte-identical to upstream aside from it.

### Macrostructure family

- Console pages: Workbench — left rail, center stream, right inspector. Pages
  vary only in stream content and inspector panels.
- Workspace/chat pages: Buzz's own two-column client layout (`buzz-sidebar` +
  `buzz-content-card`), exactly as upstream.
- Auth pages (login, signup, recovery): single centered card, no rail.

## Theme (light default, dark opt-in)

Light paper band (L > 85%), grotesk-sans display (Inter 600/700, roman only),
deep-green accent kept from brand at ≤5% per viewport.

- `--v-bg-0`     #F7F8F6 — app canvas
- `--v-bg-1`     #FFFFFF — raised card
- `--v-bg-2`     #F2F4F1 — hover / inset
- `--v-ink`      #111315 — primary text
- `--v-muted`    #68706D — secondary text
- `--v-faint`    #929995 — timestamps, metadata
- `--v-line`     #E5E8E5 — hairlines
- `--v-accent`   #126B52 — deep green, actions + active states only
- `--v-fact`     #278A59 — verified / healthy
- `--v-hypo`     #D99A32 — pending / provisional
- `--v-risk`     #D95C52 — destructive / halted
- `--v-pred`     #5577B8 — predictions / info
- `--v-focus`    var(--v-accent) — 2px focus ring, instant, never animated
- Dark opt-in mirrors the same names on green-tinted midnight paper.

Token law (Console pages): every color and font-family in rendered output
references a `var(--v-*)` token. A needed value that has no token becomes a new
token first. Hex in comments is documentation, never paint.

Scope exception — the Workspace/chat is exempt from the token law, not merely
non-compliant. Its literal Buzz hexes (`#1C1E21`, `#E8EAE6`, `#616061`,
`#DDDDDD`, `#2BAC76`, `#E01E5A`, `#ECB22E`, `#CD2553`, `#F8FAFC`, `#E2E8F0`,
`#0F5C57`, …) and its system font stack are the *locked* appearance. Do not
"fix" them into tokens: doing so changes the chat's look, which is the one thing
this system must not do. Changing them requires an explicit product decision to
re-skin the chat away from upstream Buzz.

Sentiment tints (per-theme pairs so pills read on both modes):

- `--v-tint-good-bg` / `--v-tint-good-ink`
- `--v-tint-warn-bg` / `--v-tint-warn-ink`
- `--v-tint-risk-bg` / `--v-tint-risk-ink`
- `--v-tint-info-bg` / `--v-tint-info-ink`
- `--v-tint-prose-bg` — review/approval evidence wash

## Typography

- Display: Inter, 600/700, roman always (italic headers banned globally).
- Body: Inter, 400/500.
- Mono: JetBrains Mono, 400/500 — ids, hashes, budgets, timestamps.
- H1 22px/700 tight; H2 14px/700; eyebrow 11px/600 uppercase tracked.
- Display headers wrap: `overflow-wrap: anywhere; min-width: 0`.

## Spacing

4pt named scale: `--sp-1:4px --sp-2:8px --sp-3:12px --sp-4:16px
--sp-5:20px --sp-6:24px --sp-8:32px`. Radius: card 12, pill 999, input 8.

## Motion (motion-cut project: no motion library)

- Easings: `--ease-out: cubic-bezier(0.16,1,0.3,1)`.
- Reveal: none. Hover: background shift ≤150ms. No layout-property animation.
- `prefers-reduced-motion: reduce` → opacity-only ≤150ms.
- Focus ring appears instantly.

## Microinteractions stance

- Silent success (inline status text, never celebratory toasts).
- Approve/decline: optimistic-disable + Undo-less explicit receipt link.
- Hover tooltips delay 800ms, focus tooltips 0ms.
- Buttons ship 8 states; `:focus-visible` ring ≥3:1, never animated.

## CTA voice

- Primary: filled accent pill, ink-on-accent label, one verb ("Approve",
  "Open queue", "Go to Chat").
- Secondary: hairline outline, muted label.
- Destructive: tint-risk wash + risk label, never filled red.

## Copy honesty (hard law, CI-enforced)

- Missing data renders `—`, never an invented number, name, or persona.
- No hardcoded `$` amounts, `%` telemetry, or UPPERCASE verdict badges in
  `src/console` or `src/talk` (fabrication guard + eslint twin).
- Raw protocol ids (`req_…`, `clm_…`, `usr_…`) never lead a line: humanized
  event cards first, full id in mono behind a link.
- `Signed in as <actor>` stays verbatim (browser-test contract).

## Rooms & categories

- Built-in rooms are fixed (13 canonical scopes). User-made rooms are created
  at `/setup/rooms` (id, name, scope, `*-agent` name, mission, category).
- Category is a closed set — `core`, `product`, `launch` — and picks the
  room's sidebar group in every shell. Roster rows and room headers show it
  as a chip. Unknown scopes 404 instead of rendering the wrong room.

## What pages MUST share

- Wordmark, teal accent ≤5%, Inter + JetBrains Mono.
- Rail + ⌘K-pill + theme toggle chrome.
- Card voice: 12px radius, hairline border, layered raise on hover.
- Review queue voice: count eyebrow, goal-first cards, evidence collapsed.

## What pages MAY differ on

- Stream content and inspector panels per tab.
- Department banners keep distinct hues via tint tokens only.

## Exports

### tokens.css

```css
:root {
  --v-bg-0: oklch(18% 0.02 260);  --v-bg-1: oklch(23% 0.025 260);
  --v-bg-2: oklch(27% 0.03 260);  --v-bg-3: oklch(32% 0.035 260);
  --v-ink: oklch(93% 0.01 260);   --v-ink-2: oklch(75% 0.02 260);
  --v-faint: oklch(60% 0.02 260); --v-line: rgb(255 255 255 / 9%);
  --v-accent: oklch(80% 0.12 180); --v-accent-ink: oklch(20% 0.05 180);
  --v-fact: oklch(72% 0.16 155);  --v-hypo: oklch(78% 0.14 80);
  --v-risk: oklch(70% 0.18 25);   --v-pred: oklch(72% 0.12 280);
  --font-display: "Inter", system-ui, sans-serif;
  --font-body: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --radius-card: 12px; --radius-pill: 999px; --radius-input: 8px;
}
```
