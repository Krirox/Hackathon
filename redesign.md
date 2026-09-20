# Vital Product Redesign Plan

**Status:** Planning proposal  
**Scope:** Logged-in product surfaces only; the public home page is intentionally out of scope  
**Primary surfaces:** Console and Buzz  
**Implementation style:** Incremental migration over the existing server-rendered TypeScript application  
**Last updated:** 2026-09-20

---

## 1. Executive summary

Vital should evolve from a collection of operational pages and a separate chat experience into one coherent product for governed AI work.

The redesign is **one product with two intentional surfaces**, not one merged shell:

- **Buzz / Talk:** conversation, presence, and visible coordination. Buzz is a projection of work, never the system of record.
- **Console / Feed, Work, Ledger, Systems, Governance:** ranked attention, bounded execution, evidence, decisions, outcomes, cost, and control.

The redesign will not be a cosmetic reskin. It will combine:

1. A clearer information architecture organized around user goals.
2. A calmer, more useful Console shell for operating, reviewing, and governing work.
3. A more contextual Buzz workspace for discussion and coordination.
4. Reusable page primitives so every surface behaves consistently.
5. A relationship model connecting requests, evidence, approvals, workflows, tasks, meetings, and conversations.
6. Progressive disclosure so dense operational data remains approachable.
7. A safe migration strategy that preserves current route contracts, authorization, tenant isolation, security controls, and backend behavior.

The core product promise becomes:

> **Vital turns a bounded request into an attributable result: with evidence, a budget, an owner, a decision, and a measurable outcome.**

The home page remains unchanged. The redesign begins after sign-in. Authentication, invitation, verification, recovery, account security, and erasure-receipt pages are included in the route-compatibility plan, but they keep their dedicated auth/account layouts rather than inheriting the application rail.

---

## 2. Design direction from the reference material

The supplied references point toward a blend of several product patterns rather than one direct visual copy.

### 2.1 Operational clarity

Inspired by issue and project-management products:

- Persistent navigation.
- Clear active state.
- Strong status and ownership cues.
- Board, list, timeline, and detail views.
- Fast filters and saved views.
- Contextual side panels rather than repeated full-page navigation.

### 2.2 Calm dashboard composition

Inspired by analytics and finance products:

- Generous spacing around the most important numbers.
- Metric cards used as entry points, not decoration.
- Charts with clear time ranges and comparison labels.
- Strong grouping of related information.
- A restrained visual hierarchy that makes dense data feel manageable.

### 2.3 Workflow visibility

Inspired by scheduling and workflow products:

- Stages and dependencies are visible.
- Ownership is explicit.
- Work can be moved directly when the user has permission.
- Progress and blockers are visible without opening every record.

### 2.4 Human, not sterile

Inspired by the softer references:

- Warm neutral surfaces in light mode.
- Dark graphite surfaces in dark mode.
- Small amounts of expressive accent color.
- Human avatars and activity context.
- Friendly empty states and clear microcopy.

Vital should not become a generic SaaS dashboard. The visual language must continue to communicate evidence, traceability, risk, and accountability.

---

## 3. Product principles

### 3.1 The three-layer model is visible

The interface must preserve the product's core separation:

| Product layer | User surface | What it contains |
|---|---|---|
| **Talk** | Buzz / Rooms | Conversation, presence, mentions, contextual coordination |
| **Compute** | Console / Work and Systems | Requests, budgets, bounded execution, agent tasks, workflows, handoffs |
| **Claim** | Console / Ledger | Claims, decisions, Context Bundles, provenance, contradictions, outcomes, replay |

A message may point to work, but it cannot become the authoritative work or claim record merely by being posted.

### 3.2 Ledger before activity

The interface should make it easy to understand:

- What happened.
- What was requested.
- What evidence supports the result.
- What remains uncertain.
- Who approved or rejected it.
- What happens next.

### 3.3 One object, one mental model

Requests, claims, decisions, approvals, workflows, agent tasks, and conversations should use consistent patterns for:

- Identity.
- Status.
- Owner.
- Timestamps.
- Risk.
- Related records.
- Activity history.

### 3.4 Progressive disclosure

The first view should answer the user’s immediate question. Details, provenance, raw payloads, and technical diagnostics should be available without overwhelming the default view.

### 3.5 Every important state is actionable

A user should be able to act on:

- A blocked request.
- A pending approval.
- An evidence conflict.
- An unassigned task.
- A stale workflow.
- A conversation requiring a response.

### 3.6 Honest data

The redesign must never use invented metrics, placeholder operational counts, or decorative analytics that do not come from real product data. If data is unavailable, the interface should show a meaningful empty, unavailable, or not-applicable state.

### 3.7 Collaboration is contextual

Buzz should not be a disconnected chat product. Conversations should be attachable to the work users are discussing, and Console records should link back to the relevant discussion.

### 3.8 Preserve trust and security

The redesign must preserve:

- Tenant boundaries.
- Role and capability checks.
- Session behavior.
- CSRF protection.
- Existing authorization semantics.
- Auditability of mutations.
- Existing route behavior during migration.

---

## 4. Proposed information architecture

The logged-in product should be organized around the user's operating loop, not around implementation modules.

```text
Vital
├── Feed       What needs attention now?
├── Rooms      Where do humans and agents coordinate?
├── Work       What is being requested, executed, reviewed, and delivered?
├── Ledger     What is known, decided, proven, disputed, or measured?
├── Systems    How are workflows, skills, learning, and agent runs behaving?
└── Governance What can be audited, stopped, exported, or changed?
```

This is a **navigation model**, not a claim that all six destinations already exist as routes. During migration, labels map onto existing URLs and legacy tabs. New routes are introduced only when a real read model and mutation contract exist.

```text
Work
  Requests · Approvals · Agent tasks · Issues · Meetings · Deliverables
Ledger
  Claims · Decisions · Outcomes · Activity · Provenance · Replay · Export
Systems
  Workflows · Compiler · Learning · Digest · Room health
Governance
  Audit · Data & retention · Setup · Team · Account/security
Rooms
  Buzz rooms and contextual discussion
```

**Feed versus Inbox:** Feed is the product-level attention model: ranked, capped, and digestible. An Inbox/approvals queue may be its first implementation slice, but it must not become an unbounded notification stream or a second system of record.

### 4.1 Primary navigation

#### Feed

The daily starting point. Feed is ranked and capped rather than an infinite event stream. It should answer “what matters today?” and link to the authoritative record.

- Pending human decisions.
- Blocked or refused requests.
- Stale or contradictory claims.
- Failed or halted executions.
- Mentions that require action.
- Recent verified outcomes.
- Cost or attention warnings when backed by real data.

The first implementation may reuse the existing dashboard and human-work read models. Do not create a second notification database just to make Feed look complete.

#### Rooms

The Buzz/Talk surface for human and agent coordination:

- Canonical and custom rooms.
- Room activity and messages.
- Mentions and threads where supported.
- Contextual links to requests, claims, decisions, and deliverables.

#### Work

The active lifecycle of a bounded piece of work:

- Requests.
- Admission, deferral, denial, and refusal.
- Approvals and human handoffs.
- Agent tasks and workflow runs.
- Issues, meetings, deliverables, and release work.

#### Ledger

The authoritative Claim surface:

- Typed claims.
- Decisions and frozen Context Bundles.
- Outcomes with measurement basis.
- Provenance, contradiction, staleness, and replay.
- Activity and export.

#### Systems

The operational view of bounded execution and learning:

- Workflows and stages.
- Compiler and learning review.
- Agent runtime health.
- Digest and room health.
- Budgets, stops, retries, and drift.

#### Governance

The lower-frequency control surface:

- Audit.
- Data and retention.
- Team, roles, and invitations.
- Account and security.
- Setup and integrations.

The labels above are target IA labels. The route manifest and existing route contracts remain the implementation source of truth during migration.

### 4.2 Navigation principles

- The active page must always be visually obvious.
- Navigation labels should use user language rather than internal implementation names.
- Rarely visited administrative pages should not take primary rail space.
- Counts should indicate actionable items only, not total records.
- Navigation should support keyboard access and a command palette.
- Every page should have a stable deep link.
- Existing URLs should remain supported through redirects or compatibility rendering.

### 4.3 Current contract versus target proposal

| Area | Current contract to preserve | Target redesign direction |
|---|---|---|
| Console shell | `renderConsoleShell`, `vc-*` chrome, server-rendered pages, existing theme tokens | Grouped Feed/Work/Ledger/Systems/Governance navigation and consistent Workbench page bodies |
| Buzz shell | `renderWorkspaceShell`, `buzz-*` chrome, room/message behavior, `data-vital-no-theme` boundary | Better room discovery and record context without importing Console chrome |
| Approvals | `/console/human-work` and existing approval mutation paths, CSRF, optimistic/concurrency checks, audit writes | Feed entry plus evidence-first review inspector |
| Requests and claims | `/console/requests`, `/console/claims`, query/filter/return parameters | Shared table/filter/detail patterns and Ledger naming |
| Agent tasks | `/console/agent-tasks`, detail and feed polling endpoints | Systems view of bounded runs, handoffs, stops, and cost |
| Governance | Owner-gated audit/data/export/erasure behavior | Clearer control surface; no relaxed permissions |
| Auth/account/setup | Existing login, signup, invite, verification, recovery, password, team, setup, and receipt flows | Improve hierarchy and copy while retaining dedicated layouts and security semantics |

Anything in the target column that is not backed by an existing route, stored state, or tested mutation is a proposal, not an assumed capability. Each proposal needs a data contract and an explicit route-table entry before implementation.

### 4.4 Route and surface coverage

The redesign is a presentation and information-architecture migration. It must cover every existing user-facing family, including surfaces that are not pinned in the primary rail:

| Current route family / surface | Target destination | Migration rule |
|---|---|---|
| Login, signup, invite acceptance, email verification, password reset/change, logout | Auth / account entry | Keep dedicated auth layout, safe return paths, activation and security semantics |
| `/account`, `/team`, `/setup`, `/setup/rooms` | Governance | Keep account, membership, invitations, activation, source, room, and autonomy flows intact |
| `/console/dashboard` and legacy `?tab=` views | Feed / Ledger / Systems / Governance | Preserve the route and query mappings; migrate one tab/read model at a time |
| `/console/human-work` | Feed → Approvals / Work | Preserve existing review renderer and approval mutation contract |
| `/console/requests`, request detail, deliverables, versions | Work | Preserve filters, return URLs, version review, and request-to-deliverable links |
| `/console/claims`, claim detail, decisions, outcomes, replay/export | Ledger | Make typed claims and Context Bundles visible; never replace the Ledger with chat state |
| `/console/agent-tasks`, live detail, feed polling | Work / Systems | Preserve polling, read-only monitoring, and session/tenant gates |
| `/console/workflows`, workflow detail/runs/retry/cancel/outcome | Work / Systems | Keep budget, preregistration, retry, cancellation, and outcome semantics explicit |
| `/console/compiler`, `/console/learning`, compile/transfer-test flows | Systems | Separate read-only explanation from owner-gated promotion actions |
| `/console/review`, per-mission review | Work → Review | Preserve mission-scoped review, evidence references, and review decisions |
| `/console/issues`, GitHub sync and issue mutations | Work | Keep engineering-team gating, sync policy, and mutation authorization |
| `/console/meetings`, meeting library/detail/live room | Work / Rooms | Link meeting-derived decisions/tasks without pretending it is a generic calendar |
| `/console/rooms`, `/console/buzz/:scope`, room commands/messages/replies/reactions | Rooms / Buzz | Keep the room model and Buzz shell; add Console links only through explicit contracts |
| `/console/audit`, `/console/data`, export, erasure, erasure receipt | Governance | Preserve owner gates, CSRF, confirmation, audit, export, and receipt behavior |

This matrix is a coverage checklist, not a promise that all families receive new routes in the first release. Before implementation, Phase 0 must generate the authoritative route manifest from the route table **and** inventory legacy dispatcher branches that are not yet declared there.

---

## 5. Two shells, shared product foundations

Buzz and Console must feel like one product, but they must not be rendered as one shell. This is an explicit architectural boundary in `design.md`, `console-shell.ts`, `workspace-shell.ts`, and `serve.ts`.

### 5.1 Console shell anatomy

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Vital / tenant | page context | search | Chat bridge | approvals | account  │
├───────────────┬───────────────────────────────────────────────┬─────────────┤
│ Console rail  │ Console page body                            │ Inspector   │
│ Feed          │ list / board / review / ledger                │ optional    │
│ Work          │                                               │             │
│ Ledger        │                                               │             │
│ Systems       │                                               │             │
│ Governance    │                                               │             │
└───────────────┴───────────────────────────────────────────────┴─────────────┘
```

The target Console shell extends the existing `vc-*` dark-glass Workbench system: `renderConsoleShell`, `var(--v-*)` tokens, inline SVG icons, theme toggle, compact rail, server-rendered main content, and a one-click Buzz bridge. A new global workspace switcher is conditional on actual multi-workspace support; it must not be a non-functional control.

### 5.2 Buzz shell anatomy

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Buzz identity | message search | room actions | unread / profile            │
├──────────────┬───────────────────────────────────────────────┬──────────────┤
│ Room roster   │ Conversation / thread                         │ Work context │
│               │                                               │ optional     │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
```

The target Buzz shell extends the existing `buzz-*` room and message composition. It remains its own palette, font stack, spacing, theme behavior, and interaction rhythm. Do not import Console chrome into Buzz or make Buzz inherit `var(--v-*)` tokens. The exact Buzz theme behavior is governed by the current implementation plus `design.md`; do not describe a light/dark toggle as a requirement unless that product decision is made and tested.

### 5.3 Shared foundations, not shared chrome

The two shells may share contracts and small neutral utilities for:

- Authentication and tenant context.
- Record IDs and deep-link conventions.
- Search result schemas.
- Notification/read-state semantics.
- Accessibility rules.
- Cross-product record chips.
- Analytics and telemetry definitions.

They must not share:

- Shell markup.
- CSS class namespaces.
- Theme variables.
- Page-level layout assumptions.
- A duplicated source of truth for messages, claims, or approvals.

### 5.4 Console header and rail

The Console header should contain the page context, search/command entry point, Buzz bridge, approvals/attention entry point, help/setup, theme control, and account menu. The rail should support expanded desktop, compact desktop, and mobile drawer/bottom navigation states, while grouping target IA labels over existing route keys.

### 5.5 Inspector

The inspector is a contextual right-side panel used when the page benefits from keeping the list or board visible.

Best use cases:

- Request detail.
- Approval detail.
- Claim or decision detail.
- Agent task detail.
- Issue detail.
- Conversation context.

The inspector should support:

- Open as a drawer on medium screens.
- Expand to a full page.
- Close without losing list position or filters.
- Copy deep link.
- Open in Buzz.
- View activity and related records.

### 5.6 Responsive behavior

#### Desktop

- Persistent rail.
- Wide main content.
- Optional inspector.
- Keyboard shortcuts.

#### Tablet

- Collapsible rail.
- Inspector becomes a drawer.
- Dense tables switch to cards where necessary.

#### Mobile

- Bottom navigation for primary destinations.
- Full-screen detail views.
- Horizontal filter sheets.
- No three-column layouts.
- Boards become horizontally scrollable or list-based.

---

## 6. Visual design system

The redesign should extend the existing `var(--v-*)` token system instead of introducing scattered page-specific colors.

### 6.1 Console color scheme: Graphite, Signal, and Ledger

The redesigned Console uses a restrained three-layer palette. This is a semantic system, not a collection of page colors. The values below are the target roles; implementation must map them to the existing `--v-*` tokens in `theme.ts` and `design.md` rather than hardcoding them in page renderers.

| Token role | Dark target | Light target | Use |
|---|---|---|---|
| Canvas | `#111111` | `#F7F8F6` | Body background and outer breathing room |
| Surface | `rgba(22,22,22,.82)` | `#FFFFFF` | Main shell and primary content surface |
| Raised surface | `rgba(255,255,255,.05)` | `#F0F2EF` | Hover, selected rows, nested panels |
| Elevated surface | `rgba(255,255,255,.09)` | `#E8ECE8` | Inspector, menus, dialogs |
| Primary ink | `#F3F3F3` | `#17201D` | Headings and essential content |
| Secondary ink | `#C8CCC8` | `#44514B` | Supporting content and labels |
| Muted ink | `#9A9A9A` | `#6B7770` | Metadata and helper text |
| Hairline | `rgba(255,255,255,.10)` | `#D9DED9` | Dividers and control borders |
| Vital accent | `#D9FFA8` | `#126B52` | Primary actions, active navigation, focus |
| Verified / healthy | `#9BE08C` | `#0F7A3D` | Verified facts, completed, healthy |
| Pending / provisional | `#E8C07A` | `#B45309` | Waiting, provisional, aging |
| Risk / halted | `#E87A70` | `#B91C1C` | Blocked, rejected, failed, stopped |
| Prediction / info | `#8AA4D8` | `#4338CA` | Prediction, running, informational |

#### Console color rules

- The accent is reserved for actions and current location; it must not become a decorative chart color.
- Semantic colors always appear with a text label, icon, or shape. Never communicate state through hue alone.
- Verified/healthy green is reserved for Ledger semantics and operational health; it is not a general-purpose success decoration.
- Risk is a tint or outline by default, not a large filled red panel.
- Charts use neutral graphite/gray series first. Semantic colors appear only when the series itself represents that semantic state.
- Empty, unavailable, and not-applicable states use muted ink and a dash/label, never a fake zero.
- No gradient, neon glow, or saturated accent is allowed in dense operational surfaces.

### 6.2 Buzz color boundary: Sage and Slate

Buzz remains visually distinct. This is a **target direction**, not permission to rewrite the existing Buzz palette during the Console migration. Its target palette is an independent `--buzz-*` system and must not consume Console tokens:

| Token role | Buzz target | Use |
|---|---|---|
| Canvas | `#E8EAE6` | Room roster and outer shell |
| Message surface | `#FFFFFF` | Conversation background |
| Sunken surface | `#DADED7` | Composer wells, selected room states |
| Primary ink | `#1C1E21` | Author names and message text |
| Secondary ink | `#334155` | Descriptions and metadata |
| Muted ink | `#64748B` | Timestamps and helper text |
| Buzz accent | `#0F5C57` | Links, active room, contextual record chips |
| Buzz risk | `#E01E5A` | Failed/blocked work indicator only |
| Buzz warning | `#ECB22E` | Pending activity only |

If the shipped Buzz runtime exposes a dark mode, its dark values remain Buzz-owned and must be documented in `design.md`; Console redesign work must not silently change that behavior.

### 6.3 Typography

Console follows the current rendered shell convention: Outfit for display/body and JetBrains Mono for technical metadata. Buzz keeps its own runtime font stack. Before implementation, reconcile the conflicting font notes in `design.md` (its typography section names Outfit while its export/“pages must share” text names Inter). The implementation source of truth must be the actual `theme.ts` tokens plus rendered screenshot/tests; do not change fonts as a side effect of the redesign.

The hierarchy is:

- Page title: 24px desktop / 20px mobile, weight 600, tight line-height.
- Section title: 15–18px, weight 600.
- Body: 13–15px, comfortable 1.45–1.6 line-height.
- Metadata: 11–12px, muted, never the only source of meaning.
- Technical identifiers, hashes, budgets, timestamps, and route states: mono 10–12px.

Avoid excessive all-caps labels. Use an eyebrow only for scope, state, or a useful grouping label, at 10–11px with restrained tracking.

### 6.4 Shape and elevation

- Console card radius: 12–16px; controls: 8–10px; pills: 999px.
- Buzz controls follow the existing Buzz radius scale; do not normalize them to Console.
- Console dark mode uses surface contrast and a subtle shadow; light mode uses borders first and shadows second.
- Selected navigation is a tinted pill/row, not a large glowing block.
- Use a card only when it groups a coherent decision or data set. Tables and timelines should not be wrapped in nested cards by default.
- Modals and inspectors are the highest layer; they must have an explicit scrim and focus trap.

### 6.5 Spacing and placement grid

Use a 4px base grid. The following measurements are the default placement contract for Console pages:

```text
Shell outer inset       14px desktop / 8px mobile
Shell column gap        14px desktop / 10px tablet
Console rail            252px expanded / 64px compact target
Top bar height          58px desktop / 54px mobile
Main surface padding    32px desktop / 26px at <=1440 / 16px mobile
Page header bottom      24px
Section gap             24px
Card internal padding   16px
Control height          34–38px
Table row height        48–56px
Inspector width         360–440px desktop
Mobile touch target     minimum 44px
```

Desktop placement is always: **rail → top bar → page header → controls → primary content → secondary content**. The optional inspector occupies the right edge of the content region; it never pushes the rail or overlaps the top bar.

### 6.6 Status colors

Status colors must have both color and text/icon meaning. Never rely on color alone.

```text
Success     completed, healthy, approved
Warning     waiting, aging, needs attention
Risk        blocked, rejected, failed, conflicting
Info        active, running, informational
Neutral     draft, archived, not started
```

### 6.7 Iconography

Continue using the existing inline SVG icon set. Use one icon per action or status, aligned to a 16px grid. Do not introduce emoji or multiple icon libraries. Icons support labels; they do not replace labels for destructive, approval, export, or security actions.

### 6.8 Component appearance and placement contract

This section defines the visual target for shared components. A page should assemble these pieces; it should not invent a new version of each one.

#### A. Application frame

**Placement:** full viewport; 14px outer inset on desktop, 8px on mobile.

```text
[Console rail 252px]  [14px gap]  [top bar 58px]
                                     [14px gap]
                                     [main surface: page content]
```

- The rail is a rounded glass panel with brand lockup at the top, search beneath it, grouped navigation in the scroll region, and telemetry/profile at the bottom.
- The top bar is a separate rounded glass panel. It contains page context on the left and search, Buzz bridge, attention, help, theme, and account controls on the right.
- The main surface is the only region that scrolls on Console pages. The rail and top bar remain fixed.
- Buzz is never placed inside this Console frame. The Buzz shell owns its own full-height frame.

#### B. Console rail and navigation item

**Placement:** left edge, 252px wide expanded; 64px compact target; drawer below tablet breakpoint.

- Brand lockup: `VITAL` wordmark, tenant name below in mono, 16px horizontal inset.
- Search: 36px pill directly below the Console eyebrow.
- Groups: `Feed`, `Rooms`, `Work`, `Ledger`, `Systems`, `Governance`; administrative items appear within Governance, not as a competing primary group.
- Item height: 34–38px; icon 16px; label 13px; count badge at the far right.
- Active item: accent-tinted background, accent text, `aria-current="page"`; never a large glowing block.
- Counts: actionable/pending counts only. Zero is omitted. Unknown is shown as `n/a`, never `0`.
- Hover: raised surface and primary ink. Focus: 2px accent ring. Disabled/restricted: muted and either omitted or replaced by the existing permission explanation.

#### C. Top bar and global actions

**Placement:** top of the content column; 58px high desktop, 54px mobile.

- Page title/context is left aligned and vertically centered.
- Search is a 260px field on wide screens and moves to a full-screen/modal interaction on mobile.
- The Buzz bridge is a labeled pill (`Chat`/`Buzz`) on desktop and icon-only with an accessible label on narrow screens.
- Approval/attention is an icon button with a semantic dot only when a real actionable count exists.
- Help/setup, theme, and account remain secondary controls.
- Do not add a second page title in the top bar when the body already owns the document heading.

#### D. Page header

**Placement:** first block inside the main scroll surface; 32px horizontal inset desktop, 16px mobile.

```text
[eyebrow: section / state]
Page title                         [primary action]
One-sentence purpose / scope       [secondary action]

[optional tabs] [optional filter summary]
```

- One clear `h1` per page.
- Primary action is right aligned on desktop and moves below the title on mobile.
- Header actions are verbs: `Approve`, `Create request`, `Export`, `Open in Buzz`.
- Destructive actions are never the visual equal of the primary action; place them in an overflow menu or risk-colored secondary control.

#### E. Filter bar and view controls

**Placement:** directly below the page header, before the primary table/board; 12px bottom margin.

- Search field left, filters in the middle, view/sort/saved-view controls right.
- Controls are 34–38px high with 8–10px radius.
- Active filters appear as removable chips below the bar; each chip names its value.
- On mobile, show `Filters (n)` and `Sort` buttons that open a bottom sheet; do not wrap a row of tiny controls across the viewport.
- Loading state disables only the affected control and shows a busy label; errors remain inline and recoverable.

#### F. Metric card / operating pulse

**Placement:** only in Feed/Overview or a clearly metric-oriented Systems section; a maximum of four cards in one row.

```text
[label]                         [source/time range]
value
short interpretation             [open filtered view →]
```

- Height: 104–132px; internal padding 16px.
- Value is 20–28px, tabular numerals; label is 11–12px; interpretation is 12–13px.
- No metric appears without source, time range, and empty/unavailable behavior.
- Trend arrows require a real comparison period. Otherwise show no arrow and no percentage.
- A metric card is a link to records, not a decorative dashboard tile.

#### G. Table and list row

**Placement:** primary content region for Requests, Claims, Agent Tasks, Audit, Team, and similar structured collections.

- Table header: 11px muted/mono label, 44–48px high.
- Row: 48–56px high, hairline divider, 12–16px horizontal padding.
- First column owns the human-readable title; technical ID is secondary mono text.
- Status, owner, age, and next action occupy predictable columns.
- Row hover uses raised surface; selected row uses accent-dim surface and a 2px inset indicator.
- Long values truncate visually but remain available through title text, detail view, or accessible expansion.
- Empty table: explain why it is empty and give one next action. No bare “No data”.
- Mobile: convert to stacked records with title/status first, then metadata; never force a 10-column horizontal table.

#### H. Status chip, risk badge, and owner

**Placement:** inline with the record title or in the dedicated status/owner column; never floating alone without a label.

- Status chip: 11–12px text, 6–8px horizontal padding, pill or compact rounded rectangle.
- Risk badge: icon + `Low`, `Needs review`, `Blocked`, or the actual domain label; color is supporting information.
- Owner: avatar/initials plus name on detail surfaces; avatar-only is allowed in dense lists only with an accessible label and tooltip.
- Status vocabulary must come from the domain state. Do not rewrite `ADMITTED`, `DEFERRED`, `DENIED`, `REFUSED`, `COMPLETED`, or `STALE` into vague labels that hide the lifecycle.

#### I. Inspector and detail drawer

**Placement:** right edge of the main content surface, 360–440px wide desktop; full-screen sheet on mobile.

```text
[close] Record title                    [open full page]
state · owner · updated
-----------------------------------------
Summary / next action
Evidence or Ledger context
Related work
Activity
-----------------------------------------
[primary action] [more]
```

- The list/board remains visible behind it on desktop.
- The inspector has its own scroll region, explicit close button, deep-linkable selection, and focus restoration.
- The top section answers “what is this and what can I do?” before raw technical data.
- Fixed action footer is used only when actions are available and must remain reachable while scrolling.
- Closing restores the originating query, filters, pagination, and scroll position.

#### J. Activity timeline

**Placement:** below the primary state/context on detail pages; secondary column on Feed or inspectors.

- Vertical 1px rule with 24px event markers.
- Each event: actor/system label, human-readable verb, timestamp, affected record, optional expandable technical detail.
- User actions, system actions, and agent actions use distinct labels/icons, not only colors.
- Newest-first by default; replay/audit views may offer chronological order.
- An empty timeline says why no activity is available and does not imply that nothing happened unless that is authoritative.

#### K. Review / approval panel

**Placement:** queue left, review context center/right; on mobile, queue and context become sequential full-screen states.

```text
Queue item
  goal · requester · budget · age · risk

Review context
  1. decision required
  2. recommendation
  3. evidence and Context Bundle
  4. uncertainty / conflicts
  5. downstream effect
  6. action receipt
```

- Primary controls: `Approve`, `Decline`, `Request changes`, `Escalate`.
- Each action states its consequence. Irreversible actions remain human-command-only according to the domain policy.
- Confirmations, explanations, CSRF, optimistic locking, operator signatures, and audit receipts remain backend contracts; redesign must not replace them with a visual-only confirmation.
- After mutation, show a durable receipt/state change in the same context; never rely on a toast alone.

#### L. Board and workflow stage map

**Placement:** Issues and workflow surfaces only where status/stage data is real.

- Board header contains filters and count; columns have stable names, count, and horizontal overflow on tablet.
- Card anatomy: title, status/risk, owner, linked request/claim, updated time.
- Dragging is available only for authorized, supported state transitions; keyboard and menu alternatives are mandatory.
- Workflow stage map uses a horizontal sequence on desktop and vertical sequence on mobile:

```text
Trigger → Admit → Execute → Human review → Deliver → Measure → Ledger outcome
```

- A stage shows state, owner, input/output records, budget/stop state, and failure/retry affordance where supported.
- Never imply `Deliver` or `Measure` is complete until a real deliverable/outcome record exists.

#### M. Empty, error, loading, and restricted states

Every shared component has four explicit non-default states:

- **Empty:** what is absent, why, and one next action.
- **Loading:** preserve layout shape, use a busy label, do not show fake values.
- **Error:** explain whether retry is safe, provide retry/back, and keep the original context.
- **Restricted:** explain the required capability without leaking protected record data.

These states use the same placement and typography as the successful state; they are not generic red banners.

#### N. Buzz room rail

**Placement:** Buzz-owned left sidebar; never nested inside Console’s rail.

- Room roster uses the current room grouping/data model first. Favorites, direct messages, saved, and recently visited are future sections unless supported.
- Room row: avatar/glyph, room name, unread/activity signal, optional real health state.
- Active room uses Buzz accent and surface-active background; unread uses a dot or count with accessible text.
- Search belongs at the top of the roster; room provisioning/settings stay linked to their existing setup contract.

#### O. Buzz conversation and composer

**Placement:** conversation center column; composer fixed/sticky at the bottom only when the current Buzz layout supports it.

- Conversation header: room name, description/participants when real, room actions, Console context action.
- Message grouping: avatar/author once per group, timestamp at the group boundary, whitespace between authors; avoid card-per-message.
- Record links render as compact Buzz-native chips with human title, state, and safe deep link. They never copy the full Console card into a message.
- Composer: message field, mention/command affordance where supported, send action, clear focus state, submit/error status.
- New messages must not steal focus. Drafts and attachments are requirements only if supported by the existing runtime.

#### P. Buzz context panel / Console bridge

**Placement:** optional right-side panel in Buzz; sheet on mobile.

- Header identifies the linked record and provides `Open in Console`.
- Show only authorized, current summary: state, owner, pending decision, related records, and recent activity.
- Do not duplicate the full Ledger or approval form in Buzz. The panel is for orientation and discussion; authoritative decisions happen through the Console contract or the explicitly supported approval room flow.
- Every link preserves source record ID and return context. Missing/deleted/restricted records render a safe unavailable state.

#### Q. Auth, account, setup, and governance surfaces

These pages do not use the application rail unless the existing flow explicitly does so.

- Auth: centered single-column form, 360–480px max width, clear step/status copy, no operational telemetry.
- Account/security: sectioned settings page with identity, password, MFA/recovery, sessions, and sign-out controls; sensitive actions use recent-auth requirements already enforced by the server.
- Team: member table first, invitation/action drawer second; role and disabled state are explicit.
- Setup: milestone/activation sequence with source configuration, room provisioning, readiness, and safe test actions; never display a “ready” badge without the real readiness state.
- Governance: dense audit/data pages with filters and warnings; destructive erasure remains visually isolated, typed-confirmation based, and owner-gated.

---

## 7. Console redesign

The Console is the control center for bounded work, the Reality Ledger, review, systems, and governance. It is not a generic analytics dashboard and it is not a replacement for Buzz.

Its personality should be:

- Precise.
- Calm.
- Dense where useful.
- Clear about risk.
- Action-oriented.
- Trustworthy rather than flashy.

## 7.1 Console homepage / Feed

The existing `/console/dashboard` route and its legacy `?tab=` contract should be preserved functionally. The redesign should focus on the surrounding logged-in experience and shared components first. The target user-facing name is Feed, but no new Feed route should be introduced until its read model is defined.

If the Feed/Overview is later updated, it should prioritize:

1. Work requiring attention.
2. Current operating health.
3. Evidence and decision quality.
4. Workflow activity.
5. Recent team activity.

Recommended layout:

```text
Page header: workspace name / current attention window / date range

Attention required
[approval count] [blocked work] [Ledger conflicts] [failed tasks]

Operational pulse
[requests over time] [completion rate] [human review time]

Active work                         Recent activity
[work list or stages]               [timeline]

Ledger health                      Team / room activity
[claims and conflicts]              [linked Buzz activity]
```

Do not turn the Overview into a decorative analytics wall. Each card should link to a useful filtered view.

## 7.2 Feed / Inbox

The first attention-management implementation may be called Inbox, but its product role is Feed: a ranked, capped view of what matters now. It is the highest-value new Console surface.

### Purpose

Give each user one place to see work that requires attention.

### Layout

```text
Inbox
[All] [Approvals] [Mentions] [Assigned] [Blocked] [Following]

Search and filters                         Mark all read

┌─────────────────────────────┬─────────────────────────────┐
│ Attention item list          │ Selected item inspector      │
│                             │                             │
│ Approval request             │ Context                     │
│ Evidence conflict            │ Decision / actions          │
│ Mention in room              │ Related records             │
│ Failed task                  │ Activity                    │
└─────────────────────────────┴─────────────────────────────┘
```

### Inbox item anatomy

Each item should show:

- Type icon.
- Short title.
- Source record.
- Actor or owner.
- Relative time.
- Priority/risk.
- Read/unread state.
- Optional due or aging indicator.

### Feed/Inbox actions

- Open the authoritative record.
- Mark read/unread only when a durable read-state source exists; otherwise show derived activity without pretending it is persisted.
- Snooze only when a real deferral/snooze contract exists; otherwise omit the control.
- Assign where the existing work model permits it.
- Approve/decline/escalate where the existing authorization and mutation path permits it.
- Open the related Buzz conversation.
- Add a follow-up only when it creates a real request/task, never a presentation-only note.

## 7.3 Requests

Requests are the main work queue.

### Request-to-outcome lifecycle

Every request detail surface should make this lifecycle visible without requiring the user to understand the internal architecture:

```text
Request
  ↓ admission
ADMITTED · DEFERRED · DENIED · REFUSED
  ↓ bounded execution
Agent task / workflow run · budget · owner · stop condition
  ↓ human boundary
Approval / clarification / escalation
  ↓ delivery
Deliverable / version / review receipt
  ↓ measurement
OUTCOME with measurement basis
  ↓ learning
TRACE candidate → eval → scoped Skill Card, if it passes
```

Placement rules:

- The current stage and **next allowed action** appear directly below the request title.
- Budget, deadline, owner, message class, and stop condition stay visible in a compact context strip.
- Evidence/claim references appear before generated prose or raw logs.
- Deliverables and versions are separate from approvals: approval to begin work is not final-deliverable approval, and neither is proof of execution or measurement.
- An outcome is shown only when its measurement basis exists; otherwise show `Outcome pending measurement`, not a success percentage.
- Refusal, denial, budget death, cancellation, and expiry are first-class terminal states with reason and audit link.

This lifecycle is the primary cross-page linking contract for Requests, Agent Tasks, Approvals, Deliverables, Workflow Runs, Ledger Decisions, and Outcomes.

### Default view

A table is recommended for the default view because requests contain structured operational metadata.

Columns:

- Request title.
- Status.
- Type.
- Owner.
- Requester.
- Risk.
- Created/updated time.
- Current stage.
- SLA or aging indicator.

### Alternate views

- Table.
- Kanban by status.
- Timeline for planned work.
- Saved views.

### Request inspector

The inspector should contain:

1. Request summary.
2. Current state and next action.
3. Owner and participants.
4. Evidence and claims.
5. Related decisions.
6. Agent task progress.
7. Conversation link.
8. Activity timeline.
9. Raw/technical details behind an expandable section.

### Request actions

- Assign.
- Change status.
- Request clarification.
- Approve or escalate where relevant.
- Open conversation.
- Add evidence.
- Link claim or decision.
- Archive where permitted.

## 7.4 Approvals / Human Work

Approvals should be framed as a review workspace rather than a generic list.

### Review layout

```text
Human work
[Needs my review] [Team queue] [Completed] [Escalated]

Filters: risk | owner | age | type | status

┌────────────────────────┬────────────────────────────────────┐
│ Review queue           │ Review context                     │
│                        │                                    │
│ High-risk decision     │ What is being reviewed             │
│ Evidence conflict      │ Evidence and citations             │
│ Release approval       │ Recommendation                     │
│                        │ Risks and unknowns                 │
│                        │ Approve / reject / request changes │
└────────────────────────┴────────────────────────────────────┘
```

### Review context hierarchy

The reviewer should see, in this order:

1. What decision is required.
2. What the system recommends.
3. Why it recommends it.
4. What evidence supports it.
5. What is uncertain or conflicting.
6. What downstream effect approval has.
7. Available actions.

### Approval actions

Primary actions should be explicit:

- Approve.
- Reject.
- Request changes.
- Escalate.
- Reassign.

Every action should require an explanation when the product’s existing rules require one, and should be reflected in the activity history.

## 7.5 Ledger and evidence

The Reality Ledger is the first-class destination. Evidence is one set of views inside Ledger, alongside decisions, outcomes, provenance, contradictions, staleness, replay, and export. This naming is important: the product's system of record is the Ledger, not a collection of evidence cards.

### Placement

Ledger pages use a reading-oriented layout rather than a KPI wall:

```text
Page header: claim/decision title + state + owner
Context strip: provenance | freshness | contradiction | linked work
Main column (min 2/3): statement, Context Bundle, supporting/contradicting sources
Side column (max 1/3): decision/outcome status, related records, activity
Footer actions: open in Buzz | export/replay where authorized
```

The default view must expose uncertainty and provenance before raw payloads. Raw protocol data belongs in a collapsed technical section.

### Ledger overview

Show:

- Claims created recently.
- Claims needing review.
- Contradictory or disputed claims.
- Unverified or stale sources.
- Decisions relying on weak or provisional context.
- Outcomes and measurement-basis status.
- Recent Ledger activity.

Do not show a synthetic “evidence health score.” Expose the underlying counts and link each one to the records that produce it.

### Claims view

Support:

- Table/list view.
- Confidence and verification state.
- Source count.
- Related requests and decisions.
- Last verified time.
- Owner.

### Claim detail

Use a structured Ledger reader:

```text
Claim title and state

Statement
Confidence / verification

Supporting evidence
[Source cards with excerpts and links]

Contradicting evidence
[Conflict cards]

Used by
[Requests] [Decisions] [Workflows]

Activity
[Timeline]

Open in Buzz
```

### Decisions

Decision detail should explain:

- The question being decided.
- Options considered.
- Selected option.
- Evidence.
- Approvers.
- Rationale.
- Reversal or review conditions.

## 7.6 Activity

Activity should be a useful timeline rather than an undifferentiated audit dump.

Provide filters for:

- Object type.
- Actor.
- Team.
- Event type.
- Date range.
- Risk level.

Each activity item should link to the affected object and show whether it was a user action, system action, or automated process.

The existing full audit log remains under Governance for compliance-oriented usage.

## 7.7 Systems and automation

Systems should give users a clear model of bounded workflows, runs, learning gates, and operational controls. “Automation” is a user-facing grouping, not a promise of unconstrained autonomy.

### Systems overview

Show:

- Active workflows.
- Recent runs.
- Failed runs.
- Average completion time.
- Human handoff rate.
- Most active workflows.

### Workflow list

Columns/cards:

- Workflow name.
- Status.
- Owner.
- Last run.
- Success/failure state.
- Human review rate.
- Recent activity.

### Workflow detail

Use a visual stage map that reflects the actual request lifecycle:

```text
Trigger → Admit → Gather evidence → Execute → Human review → Deliver → Measure → Ledger outcome
```

Each stage should expose:

- Inputs.
- Outputs.
- Owner.
- Status.
- Retry/failure state.
- Related claims and decisions.
- Conversation link.

### Agent tasks

Agent tasks should be presented as runs or work units, not as an isolated technical list.

Show:

- Current stage.
- Live status.
- Assigned agent/system.
- Human handoffs.
- Blockers.
- Logs and technical details in a collapsed section.
- Related request and Buzz room.

## 7.8 Issues

Issues should use the reference-style board pattern while retaining a useful list alternative.

### Board

- Clear status columns.
- Compact cards.
- Priority and risk labels.
- Owner avatars.
- Progress indicator.
- Request/Ledger links.
- Drag-and-drop only where the user has permission.

### List

Use for bulk review and filtering.

### Issue detail

Open in an inspector first, with:

- Summary.
- Status.
- Assignee.
- Linked request.
- Related claims/decisions.
- Comments or Buzz thread.
- Activity.

## 7.9 Meetings

Meetings should be presented as planned coordination around work rather than a separate calendar application.

Show:

- Upcoming meetings.
- Linked requests/workflows.
- Agenda.
- Participants.
- Decisions expected.
- Follow-up tasks.
- Related Buzz room or thread.

A calendar view can be added later if real scheduling data supports it. Do not build a decorative calendar without reliable event data.

## 7.10 Governance

Governance should be visually consistent with the Console but clearly separated from daily work.

### Audit log

- Dense table.
- Strong filters.
- Actor, event, object, timestamp, and tenant context.
- Export action.
- Detail drawer for event metadata.

### Data and retention

- Retention posture.
- Export controls.
- Erasure entry point.
- Clear warnings for destructive operations.
- Confirmation flows that explain scope and consequences.

### Governance dashboard additions

Only add metrics that can be computed from real data:

- Approval turnaround.
- Evidence conflict rate.
- Human review volume.
- Failed or blocked work.
- Export/retention status.

## 7.11 Team and workspace

Team should show:

- Members.
- Roles.
- Current workload.
- Pending reviews.
- Availability or recent activity where available.
- Rooms and responsibilities.

Workspace settings should contain:

- Workspace profile.
- Integrations.
- Notifications.
- Appearance.
- Security.
- Billing or plan controls if later introduced.

---

## 8. Buzz redesign

Buzz should remain a distinct collaborative surface, but it should become more connected to the Console and more useful for work context.

Buzz should feel:

- Conversational.
- Fast.
- Human.
- Context-aware.
- Less administrative than Console.
- Comfortable for frequent use.

It should not look like another database table or operations dashboard.

## 8.1 Buzz information architecture

The current supported model is room-centric:

```text
Buzz
  Room roster
  Room thread / messages
  Room activity and commands
```

Potential future groupings such as Home/activity, direct messages, mentions, saved messages, favorites, and recently visited rooms are proposals. They must be introduced only when the underlying Buzz/runtime model supports their read state, permissions, persistence, and deep links. The room model remains the system boundary during this redesign.

## 8.2 Buzz shell

### Desktop layout

The current supported layout is the room roster plus conversation. The context panel is an optional future bridge, not a reason to change the Buzz shell:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Buzz identity | message search | room actions | unread / profile            │
├──────────────┬───────────────────────────────────────────────┬──────────────┤
│ Room roster  │ Conversation / thread                         │ Context      │
│              │                                               │ optional*    │
│ Current rooms│ Header: #room / supported actions             │              │
│              │ Messages and composer                         │              │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
* only after an authorized record-link contract exists
```

### Left room rail

Current default: the existing canonical and custom room grouping. Future sections such as favorites, direct messages, recently visited, and saved items require real persistence and read-state support before being added.

Each room row can show:

- Unread count.
- Mention count.
- Presence indicator where available.
- Room type icon.
- Optional health/status indicator if the room is linked to active work.

The rail should support search and collapsing.

### Conversation header

Show:

- Room name and description.
- Participants or member count.
- Linked work count.
- Search in conversation.
- Room settings.
- Open context panel.

### Message stream

Messages should be visually lighter and more readable than Console records.

Each message should support:

- Avatar or initials.
- Author.
- Time.
- Message body.
- Mentions.
- Attachments or linked records.
- Reactions if supported by the existing model.
- Reply/thread affordance.
- More actions.

Avoid turning every message into a card. Use whitespace and grouping by author/time instead.

### Composer

The composer should support:

- Plain message.
- Mention.
- Room mention.
- Link to a Console record.
- Slash commands already supported by the command router.
- Draft preservation.
- Keyboard-first submission.
- Attachment support only if the backend contract supports it.

Composer shortcuts should be discoverable without taking permanent space.

## 8.3 Buzz home / activity

Buzz home should show the user’s conversation activity:

- Unread mentions.
- Replies to the user.
- Recently active rooms.
- Saved messages.
- Linked Console work requiring discussion.

This is not a second analytics dashboard. It is a lightweight starting point for collaboration.

## 8.4 Context panel

The context panel is the main bridge between Buzz and Console.

When a room or message is linked to work, the panel can show:

- Related request.
- Related claim or decision.
- Workflow or agent task.
- Current status.
- Owner.
- Pending approval.
- Recent activity.
- Open in Console.

The panel should be optional and closable so ordinary chat remains comfortable.

## 8.5 Linking Buzz to Console

Users should be able to:

- Share a Console record into a room.
- Open a room from a request, claim, issue, or approval.
- See which rooms discuss a record.
- Start a contextual thread from a review page.
- Mention a record using a compact link chip.
- Return from a Buzz link to the exact Console inspector state.

A shared record chip should include:

```text
[icon] Request title · status · owner
```

It should not expose raw IDs as the primary label.

## 8.6 Buzz visual language

Buzz should share product-level accessibility expectations, identity/deep-link conventions, and semantic meaning with Console, while remaining visually independent:

- More whitespace around messages.
- Lower border density.
- Fewer metric cards.
- Stronger author and room cues.
- Room-level accents only when they already exist in the data model.
- No automatic adoption of Console typography, `var(--v-*)` tokens, dark-glass canvas, or theme controls.

The existing Buzz-specific theme boundary is a hard migration constraint. Any future Buzz reskin is a separate product decision, with screenshot and regression approval; it is not implied by this Console redesign.

## 8.7 Buzz notifications

If a durable Feed/Inbox model is implemented, work notifications may be consolidated there while Buzz retains local message indicators. Until then, do not duplicate or relabel existing Buzz activity as a global notification system.

Recommended distinction:

- **Feed/Inbox:** work that requires action, once the durable read model exists.
- **Buzz unread:** conversation that has not been read.
- **Mentions:** direct attention from another user/system.

Avoid duplicating the same notification in three separate places without clear state synchronization.

## 8.8 Buzz mobile behavior

Mobile Buzz should prioritize conversation speed:

- Room list as a drawer.
- Full-screen conversation.
- Composer fixed to the bottom with safe-area support.
- Context panel as a sheet.
- Search as a dedicated modal.

Do not force the Console’s dense desktop patterns into Buzz mobile.

---

## 9. Shared cross-product patterns

These are behavioral contracts, not permission to force identical UI into both shells. The same record may be represented by a Console inspector, a Buzz-native chip, or a plain deep link depending on the surface.

### 9.1 Universal search

Search should cover:

- Requests.
- Claims.
- Decisions.
- Issues.
- Workflows.
- Agent tasks.
- Rooms.
- Messages.
- People.

Results should be grouped by type and show useful metadata.

### 9.2 Command palette

The command palette should provide only actions backed by existing routes or an explicitly implemented command contract:

- Navigate to a page.
- Open a record.
- Create a request or issue where the existing mutation exists.
- Search a room or message where the source supports it.
- Change Console theme; do not assume this changes Buzz.
- Mark attention items as read only when read state is durable.
- Jump to a saved view only after saved-view persistence exists.

Suggested shortcut: `Cmd/Ctrl + K`. Every command must retain the same authentication, tenant, role, CSRF, and audit checks as its non-palette equivalent.

### 9.3 Saved views

Saved views should be supported for high-value list surfaces:

- Requests.
- Approvals.
- Claims.
- Issues.
- Agent tasks.

A saved view should store filters and sort order, not duplicate the underlying records.

### 9.4 Activity timeline

All major records should use a consistent activity component:

- Event icon.
- Actor/system label.
- Human-readable event description.
- Timestamp.
- Related object link.
- Expandable technical detail.

### 9.5 Empty states

Every empty state should answer:

1. What is empty?
2. Why might it be empty?
3. What can the user do next?

Avoid generic “No data” messages.

### 9.6 Loading and failure states

Because the current application is server-rendered, loading states should be used for progressive enhancement and navigation transitions where appropriate. Every asynchronous enhancement needs:

- A disabled or busy state.
- A recoverable error message.
- A retry action where possible.
- No silent mutation failure.

### 9.7 Deep links

All inspector states, tabs, filters, and selected records should be addressable. Closing an inspector should return the user to the original list state.

### 9.8 Keyboard access

Initial keyboard support should include:

- Global search.
- Command palette.
- Navigate primary destinations.
- Open/close inspector.
- Move through inbox items.
- Submit composer.
- Escape to close overlays.

All controls must remain accessible without shortcuts.

---

## 10. Component system to build

The redesign should create or standardize the following shared components before migrating every page.

### Shell components

- Console shell (`renderConsoleShell`).
- Buzz shell (`renderWorkspaceShell`).
- Workspace header primitives, only where neutral and compatible with both shells.
- Primary rail.
- Workspace switcher, only when backed by real multi-workspace state.
- `AccountMenu`.
- `GlobalSearch`.
- `CommandPalette`.
- `AttentionButton` / notification entry point.
- `InspectorDrawer`.

### Page components

- `PageHeader`.
- `Breadcrumbs`.
- `ViewSwitcher`.
- `FilterBar`.
- `SavedViewControl`.
- `BulkActionBar`.
- `SectionHeader`.
- `MetricCard`.
- `StatusChip`.
- `RiskBadge`.
- `OwnerAvatarGroup`.
- `DataTable`.
- `Board`.
- `Timeline`.
- `ActivityFeed`.
- `RecordSummary`.
- `RelatedRecords`.
- `EmptyState`.
- `ErrorState`.
- `ConfirmDialog`.

### Buzz components

- `BuzzShell`.
- `RoomRail`.
- `RoomRow`.
- `ConversationHeader`.
- `MessageGroup`.
- `MessageActions`.
- `ThreadPanel`.
- `Composer`.
- `RecordLinkChip`.
- `ContextPanel`.
- `MentionPicker`.
- `UnreadDivider`.

The exact implementation names may differ, but the behavioral contracts should remain stable.

### 10.1 Page composition matrix

| Surface | Primary placement | Secondary placement | Default visual emphasis |
|---|---|---|---|
| Feed / Overview | Attention strip and active work in the main column | Recent activity, Ledger health, room activity | What needs attention now |
| Feed / Inbox | Ranked queue on the left; selected item in inspector | Filters and attention summary | Next action and aging |
| Requests | Table/list in the main surface | Request inspector on selection | Lifecycle stage, owner, budget |
| Approvals | Review queue on the left; evidence-first review context on the right | Durable action receipt and activity | Decision required and uncertainty |
| Ledger claims/decisions | Reading-oriented main column | Provenance, related work, activity in side column | What is known and why |
| Agent tasks | Live run list or detail stream | Logs, feed polling, review link | Current runtime state and blocker |
| Workflows | Stage map across the top | Runs, budget, failures, outcomes below | Where execution stopped |
| Issues | Board columns or dense list | Issue inspector and related Buzz thread | State, priority, owner |
| Meetings | Meeting list/detail | Linked work, decisions, follow-ups | Coordination around work |
| Governance | Dense tables/forms | Detail drawers and warnings | Permission, scope, auditability |
| Buzz room | Room roster left; conversation center | Optional authorized context panel right | Human conversation and presence |

### 10.2 Placement rules that apply everywhere

1. **Orient first:** title, current state, owner, and next action appear before secondary metadata.
2. **Prove before persuade:** claims, provenance, budget, and uncertainty appear before generated summaries or charts.
3. **One primary action:** each screen has one dominant action; secondary actions use outline/text treatments.
4. **Preserve context:** opening detail must not destroy filters, list position, room, or return path.
5. **Do not duplicate authority:** Buzz can discuss a record; Console/Ledger remains authoritative for the structured state.
6. **Data-backed only:** every count, badge, chart, unread state, and health indicator has a named source or renders unavailable.
7. **Responsive collapse:** three columns become two, then one; inspectors become sheets; tables become stacked records; workflow maps become vertical.

---

## 11. Proposed implementation phases

### Phase 0: Baseline and design contract

**Goal:** Establish a safe foundation before changing page layouts.

Tasks:

- Inventory all logged-in routes and page owners.
- Document current route-to-navigation mapping.
- Confirm existing authorization and security tests remain the source of truth.
- Define token additions in `theme.ts`.
- Define shared component contracts.
- Capture screenshots of current Console and Buzz states.
- Identify page-specific inline styles and legacy compatibility classes.

Deliverables:

- Route inventory.
- Component inventory.
- Token specification.
- Screenshot baseline.
- Migration checklist.

Exit criteria:

- No route is accidentally omitted from the redesign map.
- Existing typecheck and relevant tests pass before implementation begins.

### Phase 1: Shared shell and navigation

**Goal:** Introduce the new product structure without changing domain behavior.

Tasks:

- Add grouped primary navigation.
- Add new header layout.
- Add global search trigger.
- Add command palette entry point.
- Add inbox entry point.
- Preserve legacy URLs.
- Keep Buzz on its existing theme boundary.

First migrated surfaces:

- Console shell.
- Account menu.
- Rail groups.
- Workspace switcher only if the multi-workspace contract exists; otherwise omit it.
- Responsive navigation.

Exit criteria:

- All existing logged-in routes still render.
- Active navigation is correct for every route.
- Permission-restricted routes remain restricted.
- Mobile and desktop shell layouts are usable.

### Phase 2: Inbox and approval workflow

**Goal:** Create the primary attention-management experience.

Tasks:

- Build the first Feed/Inbox read model from existing approval, activity, and failure sources.
- Add approval queue tabs only for states backed by real queries.
- Add contextual inspector.
- Add mark read/unread behavior only if a durable notification/read-state source exists; otherwise keep unread derived from existing Buzz/activity signals.
- Add direct links to related Console records and Buzz conversations.
- Migrate existing human-work review UI into the new review layout.

Exit criteria:

- A user can identify all actionable work from one place.
- Approval actions preserve existing mutation and audit behavior.
- Opening and closing detail preserves list position and filters.

### Phase 3: Requests, issues, and agent tasks

**Goal:** Standardize active work views.

Tasks:

- Migrate Requests to table + inspector.
- Migrate Issues to board + list + inspector.
- Migrate Agent Tasks to run-oriented list + detail.
- Add shared status, ownership, risk, and activity components.
- Add bulk action foundations where safe.

Exit criteria:

- The same interaction patterns work across all three surfaces.
- Existing create/update/delete operations remain functional and authorized.
- Deep links work for list, detail, and selected inspector state.

### Phase 4: Ledger and traceability

**Goal:** Make typed claims, decisions, Context Bundles, outcomes, and provenance first-class.

Tasks:

- Create Ledger grouping/navigation while preserving `/console/claims` and legacy ledger tabs.
- Standardize claim list/detail.
- Standardize decision and outcome list/detail.
- Add supporting and contradicting evidence presentation.
- Add Context Bundle and replay entry points where the existing data contract supports them.
- Add related work and Buzz links.
- Improve Ledger activity timeline consistency.

Exit criteria:

- Users can move from a decision to its evidence and related discussion without losing context.
- Missing or conflicting evidence is visually clear.
- No evidence claims are invented by presentation logic.

### Phase 5: Systems and workflow views

**Goal:** Make bounded execution, learning, and workflow state understandable to operators.

Tasks:

- Group workflow, compiler, learning, digest, and agent-task surfaces under Systems.
- Add workflow overview and run states.
- Add stage-based workflow detail.
- Link agent tasks, approvals, Ledger records, and Buzz.
- Add failure, stop, retry, and cancellation presentation.

Exit criteria:

- Operators can understand where a workflow is blocked.
- Human handoffs are visible.
- Technical detail is available without dominating the default view.

### Phase 6: Buzz contextual refresh

**Goal:** Improve discovery and Console links without changing Buzz into a Console page or changing its storage model.

Tasks:

- Refresh the Buzz room rail within the existing `buzz-*` shell.
- Refresh conversation header and message grouping within supported message behavior.
- Improve composer and command affordances only where the command/runtime contract already exists.
- Add a contextual work panel only after record-link storage and authorization are defined.
- Add Console record chips only with stable IDs, permission checks, and safe rendering.
- Add Console-to-Buzz deep links that preserve the exact source record and return state.
- Preserve existing room and message behavior.

Exit criteria:

- Users can discuss a work item and return to it precisely.
- Unread, mentions, and Inbox state are understandable.
- Buzz remains fast and visually distinct from Console.

### Phase 7: Governance, settings, and polish

**Goal:** Finish lower-frequency surfaces and quality work.

Tasks:

- Migrate audit log to shared table/filter patterns.
- Refresh data and retention flows.
- Refresh team/workspace settings.
- Improve setup/help entry points.
- Add accessibility and responsive refinements.
- Remove obsolete page-specific styles after migration.

Exit criteria:

- All logged-in routes use the new shell or an explicitly approved exception.
- No legacy visual fragment remains without an owner or migration note.
- Performance and accessibility checks pass.

---

## 12. Technical migration strategy

### 12.1 Preserve route contracts

The redesign should initially be implemented behind the existing routes. Do not rename every URL as part of the visual redesign.

Where the new IA changes labels, use:

- Existing route compatibility.
- Redirects where appropriate.
- Query parameter compatibility.
- Legacy tab mapping.
- Stable deep links.

### 12.2 Preserve domain and security behavior

Do not modify the following as part of visual migration unless a separate approved task exists:

- Authentication.
- Session handling.
- CSRF checks.
- Role/capability evaluation.
- Tenant scoping.
- Audit writes.
- Data retention and erasure semantics.
- Approval state transitions.
- Workflow execution contracts.

### 12.3 Use shared rendering boundaries

The Console shell should remain the owner of Console chrome. Buzz should remain the owner of Buzz chrome. Shared tokens and primitives may be introduced carefully, but one surface should not import the other’s shell implementation.

### 12.4 Migrate page bodies incrementally

Recommended order for each page:

1. Keep the existing data query and mutation behavior.
2. Replace page-level layout.
3. Replace local styles with shared tokens.
4. Add inspector or view switcher.
5. Add deep-link state.
6. Add responsive behavior.
7. Remove obsolete styles only after verification.

### 12.5 Avoid a client-side rewrite

The current server-rendered architecture is valuable for:

- Security.
- Predictable rendering.
- Simpler deployment.
- Existing route contracts.
- Progressive enhancement.

Use client-side JavaScript for targeted interactions such as:

- Drawers.
- Filters.
- Search.
- Drag-and-drop where already supported.
- Command palette.
- Composer improvements.

Do not replace the application with a new frontend framework merely to achieve the redesign.

---

## 13. Data and analytics requirements

The reference images contain many metrics and charts. Vital should only add visualizations that have reliable underlying data.

### Valid candidates

- Requests by status over time.
- Approval turnaround.
- Human review volume.
- Workflow success/failure.
- Evidence conflict count.
- Agent task completion.
- Unread and actionable work counts.
- Activity volume.

### Metrics to avoid until supported

- Revenue-style metrics unrelated to Vital.
- Synthetic health scores.
- Decorative percentages.
- Unsupported productivity rankings.
- Implied accuracy or confidence not represented in stored data.

Every metric component should have:

- Source definition.
- Time range.
- Comparison basis.
- Empty/unavailable behavior.
- Link to the underlying records.

---

## 14. Accessibility requirements

The redesign should meet the following baseline:

- Keyboard navigation for all primary actions.
- Visible focus states.
- Semantic headings.
- Proper labels for icon buttons.
- Color contrast in light and dark modes.
- Non-color status communication.
- Screen-reader-friendly table and drawer behavior.
- Escape-to-close overlays.
- Focus restoration when drawers close.
- Reduced-motion support.
- Touch targets appropriate for mobile.

Buzz-specific requirements:

- Message author and time must be announced meaningfully.
- New-message indicators must not constantly steal focus.
- Composer errors must be announced.
- Unread dividers must be understandable without color alone.

---

## 15. Performance requirements

The redesign must not make every page expensive by default.

- Avoid loading all dashboard data for every route.
- Keep inspectors lazy where possible.
- Do not render hidden panels with large datasets unnecessarily.
- Keep SVG icons inline and lightweight.
- Avoid introducing large frontend dependencies without a clear need.
- Preserve server-rendered first paint.
- Keep search and filter interactions responsive.
- Measure page output size for the largest operational pages.

---

## 16. Testing and verification plan

### Automated verification

Run after each major migration:

```text
npm run typecheck
npm test
npm run lint
```

Run relevant browser tests for:

- Shell navigation.
- Login/session behavior.
- Console route access.
- Approval actions.
- Issue interactions.
- Buzz room navigation.
- Responsive layouts where browser coverage exists.

### Route verification

Verify:

- Every known route renders.
- Active nav is correct.
- Restricted routes remain restricted.
- Legacy URLs continue working.
- Query-based tabs continue mapping correctly.

### Mutation verification

Verify:

- Approval actions.
- Request updates.
- Issue create/update/delete.
- Workflow actions.
- Audit records.
- Data export and erasure confirmation flows.
- Buzz messages and room actions.

### Visual verification

Capture representative screenshots for:

- Console light mode.
- Console dark mode.
- Overview.
- Inbox with inspector.
- Requests table and detail.
- Approval review.
- Ledger claim/decision detail.
- Workflow detail.
- Buzz room.
- Buzz with context panel.
- Mobile Console.
- Mobile Buzz.

### Usability checks

A user should be able to complete these tasks without instruction:

1. Find work requiring approval.
2. Understand why a result was recommended.
3. Find the evidence behind a decision.
4. Identify a blocked workflow.
5. Open a related Buzz conversation.
6. Return from Buzz to the exact work item.
7. Find a recent activity event.
8. Search across records and messages.
9. Change a request owner.
10. Find audit and retention controls.

---

## 17. Acceptance criteria for the redesign

The redesign is successful when:

### Information architecture

- Users can explain where Work, the Reality Ledger, Systems, Governance, and Rooms belong.
- Primary navigation contains only high-value destinations.
- Administrative pages do not compete with daily work.

### Console

- The Console feels like one product rather than a collection of page-specific layouts.
- Feed/Inbox, Requests, Approvals, Ledger, and Systems use consistent interaction patterns.
- Lists, boards, inspectors, filters, and activity timelines behave predictably.
- Risk, status, ownership, and next actions are visible at a glance.

### Buzz

- Buzz feels comfortable for frequent collaboration.
- Room discovery and unread state are clear.
- Messages are readable and not over-carded.
- Work records can be linked into conversation.
- Users can move between Buzz and Console without losing context.

### Trust

- Ledger claims, provenance, decisions, and outcomes are easy to inspect.
- Uncertainty and conflicts are visible.
- Human decisions are clearly distinguished from automated actions.
- Metrics are honest and traceable.

### Engineering

- Existing security and authorization behavior is preserved.
- Existing routes continue to work.
- The redesign does not require a wholesale frontend rewrite.
- Shared components reduce page-specific CSS and duplication.
- Typecheck, tests, lint, accessibility, and browser verification remain green.

---

## 18. Out of scope for the first redesign release

The following should not be bundled into the first release unless separately approved:

- Rewriting the backend data model.
- Replacing server-rendered pages with a new frontend framework.
- Replacing Buzz’s message storage or room model.
- Reworking authentication or role semantics.
- Changing the public home page.
- Building unsupported analytics.
- Adding a full calendar system without reliable scheduling data.
- Adding new reaction, file-upload, or rich-media semantics to Buzz beyond the behavior already supported by the current runtime.
- Renaming every route at once.
- Removing legacy pages before compatibility behavior is verified.

---

## 19. Recommended first implementation slice

The highest-value and lowest-risk first slice is:

1. New Console shell and grouped navigation.
2. Shared page header, filter bar, status chips, activity timeline, and inspector.
3. Feed/Inbox read model using existing approval/activity sources; no fabricated notification count.
4. New approval review layout.
5. Requests table with contextual inspector.
6. Global search and command palette foundations.
7. Buzz navigation and record-link entry points.
8. Console-to-Buzz links.
9. Preserve the public home page.
10. Preserve the existing Buzz rendering boundary until the shared interaction model is stable.

This slice establishes the new product language and solves the most important daily-use problems without forcing a risky rewrite of every surface.

---

## 20. Open decisions before implementation

These decisions should be confirmed before building the first slice. The color roles, placements, and component contracts above are the default recommendation; these open decisions are the only intended points of product-level variation.

1. Should the target `Feed` initially be rendered from `/console/dashboard` plus `/console/human-work`, or should it receive a new route after a dedicated read model exists?
2. Should the primary accent remain the existing Vital accent and token architecture?
3. Which Buzz appearance is the product contract: the current runtime behavior or the locked `design.md` description? Resolve this before any Buzz visual change; do not infer it from the Console redesign.
4. Should the inspector open by default for Requests and Approvals, or only after selecting an item?
5. Which existing metrics are authoritative enough to appear on Overview and Inbox?
6. Should users be able to create saved views in the first release?
7. Which Console records should support contextual Buzz threads first?
8. Is the workspace switcher needed immediately, or should it remain omitted until multiple workspaces are exposed?
9. Should the current `design.md` typography conflict be resolved in favor of the rendered Outfit convention before adding any new tokens?

The recommended defaults are:

- Reuse existing routes first.
- Keep the existing Vital accent and token architecture.
- Keep Buzz visually unchanged until its current runtime behavior and `design.md` are reconciled; then record the decision in `design.md`.
- Open inspectors after selection, not automatically.
- Use only metrics already backed by real data.
- Add saved views after the base list/filter system is stable.
- Start contextual Buzz links with Requests, Approvals, Claims, Decisions, and Issues.
- Omit workspace switching until the underlying multi-workspace workflow is complete; do not ship a decorative placeholder control.
- Resolve the `design.md` font conflict in favor of the existing rendered Console convention, then update `design.md` once as the locked source of truth.
