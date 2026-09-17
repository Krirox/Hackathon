# The Living Company — Vital

**The grounding and reflex layer for the sovereign agent stack.**

Status: v2 core built and green — typecheck clean, **<!-- vital:testcount -->209/209 tests passing<!-- /vital:testcount -->**
(real sockets, real sqlite; lint/format/provenance/audit gates green).
Supersedes: "Final Idea: The Living Company.md" (v1), the v2 assessment rewrite, and the v3 sovereign-stack revision. This is the single source of truth.

---

## 0. Thesis in five lines

> Companies have information systems, not an intelligence-and-action system.
> The gap is not "AI that can think" — it is AI whose thinking is **grounded, budgeted, attributable, and safely executable**.
> So we build a **ledger of claims**, a **scheduler of attention**, and a **compiler of procedures**, and we enter through one narrow revenue-visible loop.
> We do not claim to run the company. We claim to **close the loop on specific changes faster than humans can alone, and to prove it with a number.**
> The runtime is the end state. The wedge is the entry fee.

**The deepest principle.** A company should get better at deciding *when intelligence is necessary*. So the system's north-star metric is not "tasks completed by agents." It is **`intelligence cost per good decision`**, and its trend over time.

---

## 1. The actual problem

Modern companies are fragmented. GitHub knows the code. The CRM knows customers. Slack knows conversations. Analytics knows behaviour. Accounting knows money. Support knows complaints. Docs know plans.

No system answers: **what is happening to the company right now, why does it matter, and what should the organisation do?**

Humans connect the dots by hand. A feature ships and someone remembers to tell marketing. A competitor launches and someone notices. Customers complain and someone eventually links the pattern to a product decision. Costs rise and engineering learns weeks later.

v1 called this "companies have information systems but not a shared intelligence and action system." That diagnosis was right. What v1 got wrong was the prescription: it proposed an architecture and assumed the market would buy the architecture.

**The corrected diagnosis.** The bottleneck was never "AI can't reason well enough." It is that agentic systems cannot be trusted in production because:

1. they cannot tell what they **know** from what they **inferred**;
2. they generate **unbounded work** with no budget, deadline, or owner;
3. they **repeat intelligence** on problems the organisation already solved;
4. they take **actions nobody can attribute, replay, or reverse**.

Every subsystem in this document exists to fix exactly one of those four.

---

## 2. Market reality (why this is buildable now, and why most attempts die)

**Tailwind.** Gartner expects up to **40% of enterprise applications to feature task-specific agents by 2026, up from under 5% in 2025** ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025)). McKinsey attributes **$2.6–4.4T** of potential annual value to agent use ([roundup](https://joget.com/ai-agent-adoption-in-2026-what-the-analysts-data-shows/)).

**Headwind, and it is severe.**

- MIT NANDA: **~95% of enterprise GenAI pilots showed no measurable P&L return** on $30–40B invested; only ~5% accelerated revenue ([Fortune](https://fortune.com/2025/08/18/mit-report-95-percent-generative-ai-pilots-at-companies-failing-cfo/)). The Forbes read: generic tools hit 83% adoption on trivial tasks and **stall the moment workflows demand context and customisation** ([Forbes](https://www.forbes.com/sites/jasonsnyder/2025/08/26/mit-finds-95-of-genai-pilots-fail-because-companies-avoid-friction/)).
- Gartner (secondary): **>40% of agentic AI projects expected to be cancelled by end-2027**, cause cited as unclear value, cost, inadequate risk controls ([stats](https://unicoconnect.com/blogs/agentic-ai-statistics-2026)).
- Funding is concentrating in **vertical** agents: 22 of 39 pure-play rounds, **82.6% of disclosed capital** ([funding analysis](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis)).

**The behaviour is already shipping.** On **11 Aug 2026** xAI launched **Grok Bot**
— "your team of always-on agents" that "have their own computer, work inside tools
and apps like you do, and keep working 24/7", "sign into the tools you already use",
"finish jobs end to end", and "only come back when something needs your approval"
([xAI](https://x.ai/news/introducing-grok-bot)). On **26 Aug 2026** it expanded to all
SuperGrok and Cursor plans, with browser + terminal access and multiple bots able to
"pass work between themselves" in a group chat ([xAI](https://x.ai/news/grok-bot-more-plans)).
Enterprise access is waitlist-only.

That kills the weakest version of our pitch ("agents are coming") and replaces it with
a stronger one ("agents are already acting, and nobody can audit it"). It also supplies
the two pains a governance layer needs:

- **Cost.** A Hacker News user reporting a month of heavy use: *"I've used less tokens
  in the last 5 years prior to this month than I have this month"* ([HN](https://news.ycombinator.com/item?id=49261514)).
  Always-on bots burn tokens; budgeted coordination is a buyer pain, not a theory.
- **Irreversible external action.** The same user had a bot contact ~40 fabric
  suppliers, negotiate prices, lock one in, and order samples. Nobody should be able
  to answer "was that approved, on what basis, at what budget?" only from a chat log.

**Honest limits on this evidence.** It is one HN thread plus vendor marketing; the
fetched r/grok workplace thread returned no readable text. Do **not** claim mass
adoption, and do **not** claim Grok Bot lacks audit or approval — its docs mention
confirmation prompts for sensitive Slack operations ([Grok for Slack](https://slack.hooks.x.ai/)),
admin connector provisioning, and API-level SOC 2 / HIPAA-eligible claims
([connectors](https://docs.x.ai/grok/connectors), [API](https://x.ai/api)). The defensible
claim is narrower and precise: **the public evidence does not document typed
FACT/BELIEF separation, cross-tool action provenance, cost bids and hop limits,
measured refusal rates, or self-hosted agent governance.**

**The strategic conclusion.** Do not sell a company operating system. Sell one measurable loop, and let the accumulated corpus justify the runtime later. The three numbers above — 95% pilot failure, 40% cancellation, 82% capital to vertical — are the reason this document has a wedge, a pre-registered metrics table, and kill criteria.

**Unverified, do not cite:** the "Carnegie Mellon / Wharton agent-washing study" referenced in earlier drafts. No primary source was located. The *concept* (labelling ordinary automation as agents) is real and worth defending against; the *citation* is not established.

---

## 3. The core insight: three layers, and never confuse them

Everything in this system follows from one discipline:

| Layer | Job | Implementation | Rule |
|---|---|---|---|
| **Talk** | humans + agents coordinate visibly | **Buzz** (Nostr, signed identities) or Slack | a channel is a *projection*, never a store |
| **Compute** | agents execute with scoped tools | **our own** scope sandbox + scheduler, with **jcode** and other harnesses driven over their APIs | an agent acts as its scope, with its grants, audited |
| **Claim** | what is true, what is believed, what was decided | **the Reality Ledger** | the *only* place claims live |

**The single most common failure mode this prevents:** letting chat be the system of record. v1's own document complained that "customer information should not die inside support tickets" — and then designed a system where agents ask each other questions *in chat*, which is precisely how information dies inside threads. The fix is structural, not cultural.

**The second most common failure mode:** letting a message carry work. See §6.

---

## 4. The Reality Ledger

Append-only, bi-temporal, typed claims. This replaces v1's "Company Reality Model," which was directionally correct but assumed the model could simply be *maintained*. It can't, unless the schema makes lying impossible.

### 4.1 Claim kinds

`OBSERVATION · MEASUREMENT · FACT · BELIEF · ASSUMPTION · HYPOTHESIS · PREDICTION · GOAL · DECISION · ACTION · OUTCOME`

### 4.2 Provenance tiers (weakest link wins)

`SYSTEM_OF_RECORD > MEASURED > PRIMARY > CORROBORATED > SINGLE_SOURCE > SELF_SERVED`

### 4.3 Hard invariants — enforced in code, not documented as policy

| | Invariant | Why it exists |
|---|---|---|
| **I1** | **No generated facts.** An agent may create BELIEF, ASSUMPTION, HYPOTHESIS, PREDICTION, OBSERVATION, DECISION, ACTION. It may **never** create FACT, MEASUREMENT, or OUTCOME. | This is the whole ballgame. It is the difference between an organisation that knows things and one that agrees with its own hallucinations. |
| **I2** | FACT and MEASUREMENT require `SYSTEM_OF_RECORD` or `MEASURED` provenance — **regardless of author**. | A confident, well-sourced-sounding vendor blog is still self-serving. |
| **I3** | Every claim has a named human owner. No orphans. | Accountability must survive agent autonomy. |
| **I4** | A `contradicts` link flips both claims to DISPUTED and opens a resolution ticket. | Contradiction must be an event, never silence. Silent contradiction is how two teams ship two different truths. |
| **I5** | `valid_until` expiry ⇒ STALE, computed on a sweep. | Staleness must be *felt by the system* before it is noticed by a customer. |
| **I6** | High-tier reasoning context includes **only** VERIFIED, unexpired, **non-provisional** claims. | Onboarding-inferred reality must never trigger autonomous action. |
| **I7** | Append-only. Supersede by writing a new row + link; never rewrite history. | Replay and blame are not optional. |

### 4.4 Decision records

Every `DECISION` freezes a **Context Bundle**: the exact claim IDs and versions that were live when it was made. Decisions become replayable, which is what makes "why did we do this" a queryable question instead of an archaeology project.

### 4.5 Ledger health metrics

Stale-fact rate (<2%) · contradiction MTTR (<48h) · human correction rate (falling) · provenance completeness (100% for FACT) · orphan claims (0) · preemption rate — decisions made on stale or disputed context (<1%).

---

## 5. World Sense

v1's biggest idea and its vaguest mechanism. "Monitor what's relevant" is not a mechanism.

### 5.1 Genome → Watch Contract

The Company Genome is authored *with* a human, then **compiled into an executable contract**: entities, predicates, a **materiality gate** (a signal must link to a live GOAL or a revenue/cost/risk path), sources with trust tiers and rate budgets, thresholds, cost caps, and a 30-day re-review date.

Attention stops being a vibe. It becomes a query plan with a bill attached.

### 5.2 Three-stage funnel

```
L0 COLLECT   deterministic: RSS, webhooks, polling, HTML/JSON diff,
             GitHub/PyPI/HF/arXiv feeds, changelogs.   cost ≈ 0, no reasoning
     ↓
L1 TRIAGE    dedup → novelty vs ledger → classifier → entity resolution.
             embeddings / small models only.
     ↓  materiality gate
L2 REASON    frontier model, only for signals that pass L1 AND link to a Goal.
```

This is what makes always-on sensing affordable: the expensive tier sees a fraction of a percent of what arrives.

### 5.3 Integrity Gate — the attack surface v1 never mentioned

A world model that feeds strategy is an **adversarial target**. A competitor can publish a fake pricing page, seed a plausible repo, or farm Reddit mentions to steer your roadmap. Defences:

- corroboration ≥ 2 independent provenance paths before any strategic escalation, else the signal stays CANDIDATE;
- self-serving-source prior discount (vendor blogs, competitor changelogs, review-site astroturf);
- mention-spike anomaly check (account age, co-timing clustering);
- **external text is quoted data, never a system role, never a tool selector.**

QM already screens *tool results* through a provenance-labelled classifier and exposes a `securityScreen` proxy contract (`user_input` / `tool_response` hooks, score/threshold, shadow or enforce, **fails closed**). Our Integrity Gate is the sibling that covers *world-model inputs*, which is a different trust problem: QM asks "is this content trying to hijack the agent?" We ask "is this content trying to hijack the company's strategy?"

---

## 6. Coordination — channels are presentation, not protocol

The user-facing model is exactly what it should look like: **each team has a channel, each channel has a room agent, humans talk to their own agent, and cross-team work happens visibly in the open.**

What must *not* happen is the naive version: an agent hopping into another channel and asking another agent a question in free text. That single design choice resurrects three of the four problems v1 itself listed as unsolved.

### 6.1 Three message classes — collapsing them is the bug

| | What it is | Budget | Refusable? | Interrupts a human? |
|---|---|---|---|---|
| **QUERY** | read-only question | tokens only | yes | **never** |
| **REQUEST** | real work with a deliverable | full bid: owner, deadline, $, rounds, stop condition | **yes — refusal is a logged outcome** | only in the *origin* channel |
| **NOTICE** | FYI | none | n/a | **never — digest only** |

### 6.2 What actually crosses a channel boundary

```
Marketing room agent
  → writes a typed REQUEST to the queue  {goal, claimRefs, deliverableSchema,
     bid{dollars,tokens,humanMinutes,deadline,maxRounds,maxHops},
     onBehalfOf, hopChain, idempotencyKey, stopCondition}
  → scheduler ADMITS / DEFERS / DENIES        ← budget is enforced HERE
  → it *renders* as a thread in #engineering, signed, with evidence chips
Engineering room agent
  → invoked by the OBJECT, not by reading chat
  → ACCEPT | DECLINE(reason) | REDIRECT(scope) | ESCALATE(to its own human)
  → deliverable = typed artifact + claims written to the Ledger
  → origin gets a completion event; hop chain closed; cost reconciled
```

**The human experience is identical.** The mechanics are metered, bounded, replayable and refusable.

### 6.3 Loop prevention — structural, not policy

Hop limit (3) · cycle detection via inherited hop chain · idempotency dedupe ("already in flight, here's the thread") · **right to refuse** · budget death (terminate loudly, never continue silently) · no self-delegation · injection firewall (external text may not propagate as anything but quoted data).

### 6.4 Room agent vs worker — the cost discipline

- **Room agent = a scope.** Durable. Owns memory, files, keychain, permissions, crons, sandbox. Cheap to have many, because it is a *configuration*, not a running process.
- **Workers = ephemeral processes.** Spawned by a request or cron, die on completion. These are what must not accumulate.

This is how v1's promise — "prevents a company accumulating 200 permanent agents" — actually holds. Agent count becomes a governed metric with a kill condition, not a vanity number.

### 6.5 The sycophancy metric

If the measured refusal rate across all agents is 0%, the agents are people-pleasers and the organisation is quietly over-committing. **Refusal rate is a first-class health metric**, exposed to the customer.

---

## 7. Cognitive Router

Four execution classes, not v1's seven tiers. Fewer classes = fewer misroute surfaces.

`REFLEX` (deterministic/cached/rule) · `WORKFLOW` (a PROMOTED Skill Card, in its validated scope) · `MODEL` (one reasoning pass on a chosen harness) · `HUMAN` (human decides, agent supplies evidence)

**R1 Deterministic first.** A registry of task types → rules handles the bulk of traffic with zero learned inference. The model-based layer only sees ambiguous input.

**R2 Shadow until proven.** `controlRate` starts at **0**: the router logs what it *would* have chosen while a fixed safe policy executes. Control is granted only after routing precision clears its gate (≥2,000 labelled samples at ≥0.90).

**R3 Asymmetric loss.** For irreversible actions, misrouting *down* is catastrophic. The router therefore **fails up**. A pricing change or external publish never executes on a confident-but-wrong low tier.

**R4 Error budgets per tier.** Exceed budget → auto-revert that tier to the fixed policy.

**R5 Coupling guard.** A Skill Card may only run at the tier it was validated at, in a scope it was validated for. This is what stops §7 and §8 from compounding each other's errors.

*Note: QM already ships `src/harness/harness-router.ts` — approved-harness lists, per-scope runtime selection, model/thinking-level/fast-mode resolution. Our router sits **above** that: it decides whether a task should be a rule, a compiled workflow, a model call, or a human. QM's decides which harness and model to use once we've said "MODEL." Different layer, no overlap.*

---

## 8. Organizational Compiler

The strongest original idea in v1, and the one with real research behind it. The AFTER benchmark finds procedural memory yields genuine gains (single refinement round +3.7–6.7 points; skills evolved from diverse multi-model traces hit 73.1% cross-model accuracy) **but that skills specialize to their origin role and lose effectiveness under transfer** ([arXiv 2606.23127](https://arxiv.org/abs/2606.23127)).

That finding *is* the product spec. A compiler that ignores it manufactures brittle procedures and deploys them too broadly.

### 8.1 Lifecycle

```
TRACE → CANDIDATE → QUARANTINE → SHADOW → BOUNDED_PILOT → PROMOTED(scoped)
                                                              ↓ drift
                                                         DEMOTED → MODEL/HUMAN
```

Advance **one step at a time**, each step through an explicit gate. Demotion is always allowed — that is the point.

### 8.2 Skill Card

`intent · applicability predicates · steps · executable success tests · tool grants · validatedAtTier · originScope · originModels · scopeRoles · provenance(traceIds) · evalRef · state · version`

### 8.3 The gates

- **Compilation refuses bad teachers.** No trace with `UNRESOLVED` outcome; no trace the router flagged below 0.5 confidence. A compiler that learns from traces the router doubted manufactures bad procedures.
- **→ SHADOW** requires passing regression tests and an eval-suite reference. *The eval is written before the fix.*
- **→ BOUNDED_PILOT** requires cross-model transfer + ≥20 shadow runs at ≥0.90.
- **→ PROMOTED** requires regression + cross-model + data-regime, and ≥50 pilot runs at ≥0.95.
- **Scope expansion is a separate act from promotion.** A card promoted in Marketing may not serve Sales until a `cross_role` transfer test passes **for Sales specifically**.

A skill that only works where it was born stays there forever. That is honest, not a failure.

### 8.4 Imported packs

QM's skill registry imports `SKILL.md` packs from git with a `trustTier: internal | third-party`. An imported pack is a **foreign procedure with unknown transfer properties**. It always enters at `QUARANTINE`, never higher. This is not hypothetical: TDAM, QM packs and any future skill marketplace are all exactly such foreign procedures (§29.4).

### 8.5 Decay

EWMA over a rolling window of live outcomes vs. the validated baseline. Breach ⇒ auto-demote + drift ticket. Silent degradation is the failure mode that kills compiled systems, and it is the one nobody demos.

> **Moat scope, corrected 2026-09-15 (§29.4).** The compiler's *plumbing* is now commoditised twice — QM's skill registry and TencentDB Agent Memory's Skills both ship versions, trigger boundaries, validation rules and review-gated sharing. What remains ours is only the **evidence layer**: transfer testing, quarantine, and drift-triggered auto-demote. Never claim the compiler as a differentiator wholesale; claim the gate.

---

## 9. Autonomy and governance

v1 proposed a seven-rung ladder: read → observe → analyze → propose → draft → execute-with-approval → autonomous. **Ladders are wrong**, because they imply *global* promotion per agent. Autonomy must be granted per **action class × scope**.

### 9.1 R/A/I matrix

| Action class | Example | Default | Promotion requires |
|---|---|---|---|
| `READ` | query systems | autonomous | — |
| `ANALYZE` | summarise, model | autonomous | eval pass |
| `RECOMMEND` | propose to a human | autonomous | precision ≥ threshold |
| `ACT_REVERSIBLE` | draft, schedule, internal ticket, feature flag | approval → autonomous | Trust Ledger + 200 clean instances |
| `ACT_IRREVERSIBLE` | publish, price change, refund, contract, prod deploy, spend | **human command, always** | legal review + named officer; **not offered in year 1** |

QM's org-wide **Strict / Auto / Dangerous** postures are the *substrate*; the matrix is the *policy* layered on it. Money-touching, customer-facing and production scopes are pinned to Strict in the deployment config so no agent can loosen it — QM's rule is that narrower scopes may only tighten, which is exactly the direction we want.

### 9.2 Anti-approval-fatigue machinery

A human who approves 200 items a day is not providing oversight; they are a bottleneck with a signature.

- **Honeytasks** — seeded known-good/known-bad items in the approval stream, measuring whether humans are actually reading.
- **Approval sampling** — a random percentage of *auto-approved* items forced into deep human review, detecting silent drift.
- **Batch ceilings** — batching allowed only for reversible, low-blast-radius actions.
- **Automatic autonomy freeze** when human bad-item detection drops below threshold.
- **Silence budget** — each capability must justify why it *didn't* speak. Reported quarterly.

### 9.3 Kill switches

Three levels: tenant · scope · action class. **Drilled quarterly.** An untested kill switch is a UI element.

### 9.4 EU AI Act Article 14

High-risk systems must be designed for effective human oversight — understanding limitations, guarding against automation bias, interpreting outputs, **overriding or reversing**, intervening or stopping ([Art.14](https://artificialintelligenceact.eu/article/14/); [Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-14)). Annex III systems from 2 Dec 2027.

Our honeytasks, Context Bundles, signed Buzz identities, named owners and stop controls are built to that shape — partly because it's required in the EU, mostly because it's the correct product design everywhere.

**Two things this does NOT solve, and we must never claim it does:** (a) whether a given deployment is "high-risk" is a legal classification question; (b) Article 14 does not resolve corporate liability for agent-driven commercial decisions.

---

## 10. Learning spine — no fake learning

```
feedback / failure → failure pattern (clustered) → EVAL CASE added FIRST
  → proposed change (prompt | policy | retrieval | SkillCard | router calibration)
  → offline eval gate → shadow eval on live traffic → canary (1%) → promote with version + rollback
```

**Learning is defined as a diff to a versioned artifact.** Prompt, policy, index, router calibration, Skill Card, or eval set. If nothing versioned changed, **nothing was learned**, and the system is prohibited from saying otherwise. This is v1's "Problem 4: fake learning," made mechanical.

### 10.1 Attribution — results must be counterfactual

Narrative causality ("the campaign worked") is not an OUTCOME. An OUTCOME requires a measurement basis: holdout lanes, segment/geo splits, pre-registered metrics, and a comparison against a baseline that was agreed *before* the pilot started. The pre-registration step is the anti-self-deception control, and it is the direct answer to the 95% pilot-failure finding.

---

## 11. Economics of intelligence

Finance is not a reporting module; it is the instrument panel for the entire thesis.

```
decision_id → Σ(inference $ + tool $ + human_minutes × loaded rate + retry cost)
            → outcome value → cost per good decision
```

**Three numbers shown to the customer monthly:**

1. **Intelligence cost per good decision** — should fall over time.
2. **% of work at REFLEX/WORKFLOW tier** — should rise.
3. **Human minutes reclaimed vs. consumed by oversight** — net, honestly.

This is what makes v1's "the longer the organisation operates, the less intelligence it needs for routine work" a *falsifiable curve* instead of a rhetorical flourish. And cost is a leading cited cause of agentic project cancellation, so this panel is a retention feature, not a demo.

---

## 12. Security plane

Absent from v1 entirely. Non-optional here, because QM's model is "the agent acts as the person it works for, with their credentials," and its `execute` tool runs in a durable sandbox where **installed tools stay installed**. A poisoned result is a persistent foothold.

- **Untrusted-content quarantine** — external text is sanitised and rendered as quoted data with source chrome; never in a system role.
- **No scope holds both read-secrets and external egress.** Enforced via QM's capability-token egress proxy (`egress-authz`), which already implements host allow/deny policy, SSRF/IP-blocklist protection including cloud metadata endpoints, and an egress audit sink. We configure it; we do not rebuild it.
- **Prompt-injection red-team suite in CI**, re-run on every model *and* every harness swap.
- **Rebuildable sandboxes from a manifest** — persistence must never be trust-bearing.
- **Immutable audit log separate from the Ledger**, so a compromised runtime cannot erase its own trail.
- **Tenant isolation** at storage and index level; no cross-tenant embedding leakage. Data residency, PII classification, erasure path.
- **The Ledger is exportable.** Lock-in by value, not by hostage-taking — and this is a *sales asset* against the black-box objection.

---

## 13. Capabilities (departments)

Nine questions per capability (observe / state / triggers / understands / influences / executes / measures / escalates / stays silent), plus **two mandatory additions**: an outcome metric and a **kill condition**.

| Capability | Core state | Outcome metric | Dies when |
|---|---|---|---|
| **Market** | opportunity/threat register | qualified opportunities adopted; threats acted on in time | opportunity→decision conversion < baseline 2 quarters running |
| **Customer** | pain/need patterns | % of churn/CSAT variance explained | patterns never confirmed by Product |
| **Product** | problems, hypotheses, experiments | validated-value rate; prediction accuracy | roadmap inputs ignored by humans |
| **Marketing** | brand/positioning/campaign model | pipeline & activation lift per launch | drafts need >X% human rewrite |
| **Sales** | win/loss learning register | win-rate delta; loss-reason coverage | loss reasons stay "unknown" |
| **Engineering** | system/quality state | change-failure rate, MTTR, cost/deploys | releases don't trigger downstream action |
| **Finance** | runway/forecast/cost model | forecast error; **cost per good decision** | attribution untrusted |

**Missions are ephemeral by default.** "Should we enter Germany?" spawns a temporary team, executes under a bid, is mined for knowledge, is recorded as a DECISION + Context Bundle, and archives.

---

## 14. Human surface

Three products, not one chat box:

| Surface | Job | Anti-pattern avoided |
|---|---|---|
| **Feed** | "3 things matter today" — ranked, capped, digestible | notification overload |
| **Room** | humans + agents collaborate: conversation **+ live state + evidence + decision + owner** | black-box agents |
| **Ledger** | replay: why did we do this, who approved, what happened, what did it cost | unaccountable automation |

Feed and Room are **Buzz**. We do not build chat — that is career-ending in 2026. The Ledger is our only bespoke surface, and it is a read-model over Postgres.

**UI validation is a program, not an assumption.** A/B three variants over identical agents: chat-only / evidence-summary / full live-state board. Measure **decision accuracy, time-to-decision, missed-risk rate, override rate**. Not satisfaction. Transparency does not automatically produce trust; too much state overwhelms and too little produces rubber-stamping.

---

## 15. The wedge: Ship-to-Result

> A product change is detected → the system produces a **verified change summary** → identifies affected segments → drafts launch, support and sales assets → routes them for **human approval in the room they're already in** → executes approved steps → measures the outcome → writes DECISION + OUTCOME + Context Bundle to the Ledger → the whole chain becomes a TRACE for a candidate Skill Card.

**Why this wedge survives the market's failure pattern.** Recurring (every release), cross-functional by construction, close to revenue, executive-visible, measurable in 30 days, exercises every core subsystem at low blast radius — and on this stack it is nearly free, because Buzz *has* repos (release detection is a native event), Buzz *has* rooms (the approval surface exists day one), QM *has* crons/watches/webhooks (the trigger machinery exists), and jcode *already does* the engineering half.

**Pre-registered success metrics** (agreed before pilot start): ship→launch-ready time −50% · human hours per launch −40% · customer-facing claim error <1% and zero regulatory · support-ticket delta vs holdout · feature-adoption lift vs holdout · cost per launch net-positive · stale facts caught by system before human >0 · override rate falling.

**Kill criterion:** no measurable delta on ≥3 of the top 5 after 90 days ⇒ the wedge is wrong. Adding agents will not fix it. That is a finding, not a failure.

---

## 16. The sovereign stack

| | What it is | Our relationship to it |
|---|---|---|
| **[Buzz](https://buzz.xyz)** | Block/Jack Dorsey, launched 21 Jul 2026. Rust + TS, **Apache 2.0**, built on **Nostr** over a relay you own. Channels, threads, DMs, voice, **git repos**, workflows. Every agent gets its **own cryptographic identity**. Model-agnostic, self-hosted, self-sovereign. | **The talk layer.** We render into it and bind claim IDs to signed events. We never store claims in it. |
| **[QM](https://github.com/yc-software/qm)** | "Multiplayer agent harness for work." MIT. Each person and each room has its own scoped memory, files, keychain view, permissions, crons, web apps, durable sandbox. Harness-agnostic (Pi, OpenCode, Codex, Claude Code) over one core + Postgres. Strict/Auto/Dangerous postures. Git-imported skill packs with trust tiers and admin-gated org promotion. | **A source we absorb from, not a host we run on.** We vendor its leaf modules (§16.2) and build our own substrate. Its *design* is the best free thing it gives us. |
| **[jcode](https://github.com/1jehuang/jcode)** | **Rust** (1,198 `.rs`, **0** `.go`), MIT, v0.84.0, YC-launched, `jcode.sh`. Cargo workspace of ~40 crates: fast TUI, multi-model, swarm coordination, 30+ tools, local-embedding + graph memory (async, non-blocking), MCP, background/overnight runs. Ships a **TypeScript SDK**, per-platform npm binaries, and `jcode-harness-api` (client/events/requests/sockets). | **The hands** — but see §16.3: it is **not** a QM harness, so it is driven as a sibling process, not mounted inside QM. |

### 16.1 What QM already has — the design to copy, the code to weigh

Reading actual source rather than a README changed the plan twice. First it showed how much exists; then it showed we cannot simply run on top of it.

| QM module | What it does | Consequence for us |
|---|---|---|
| `harness/harness-router.ts` | approved-harness lists, per-scope runtime selection, model/thinking/fast-mode resolution | Our router sits **above** it (which tier), not beside it |
| `loops/governor.ts` | loop health: quarantine/throttle/ping, consecutive-failure and return-rate thresholds | **148 lines, imports only `../types.ts` — the single cleanest absorb candidate.** Same semantics as our budget-death + auto-demote |
| `loops/ship-gate.ts` | `undeclaredShipActions` — actions a loop took that it never declared | **Exactly our R/A/I enforcement primitive.** 73 lines; needs `trigger-store` + `util/crypto` |
| `idempotency/` | durable `once(key, fn)` with retention | 79 lines + `persistence/durable-map` (310). Our REQUEST dedupe delegates here |
| `egress-authz` + `auth/capability-token.ts` | capability tokens, host allow/deny, SSRF + cloud-metadata IP blocking, egress audit sink | **Copy the design, including its blocklist** (`169.254.0.0/16`, `fd00:ec2::254`, `metadata.goog`). This is the hardest thing on the list to rebuild correctly |
| `securityScreen` proxy contract | `user_input`/`tool_response` hooks, score/threshold, shadow/enforce, **fails closed** | Our Integrity Gate adopts the same shape. Ours covers world-model *inputs*; theirs covers tool results |
| `skills/` + `skill-registry.md` | git pack import, normalizer, eligibility, `trustTier`, admin-gated publish, sync engine | 1,940 lines and tightly coupled. **Adopt the model, do not vendor it** |
| `memory/strategies/` | per-turn, agent-only, consolidation, scratch-promote; provider router to external stores | Confirms our separation: memory is where agents work, the Ledger is where claims live |
| `cron` / `monitors` / `webhooks` / `wake` | schedulers, pollers, verifiers, background wake | **Substrate, not absorbable** — entangled with Slack/E2B/Modal/Fly/AWS. We build our own, smaller |
| `policy/command-policy.ts` | predeclared approvals + hard denials, applied in **every** posture including Dangerous | 911 lines, needs `types` + `safe-regex` + `errors`. **Absorb**: the hard-deny list is battle-tested thinking |

### 16.2 Why absorbing beats depending (and what it costs)

The earlier version of this section was titled "Why composition beats construction." The argument still holds, but the mechanism changed, and so did one of its claims:

1. **Scope shrinks, but not as far as claimed.** Absorbing removes the fork/sync/upstream-drift discipline — a real saving — and gives us total control of the substrate. It does **not** give us the substrate for free. Sandbox, scheduler, egress proxy and sensing plane are ours to build and operate.
2. **COGS stays low** — VPS + open harnesses + aggressive L0/L1 triage. No per-seat margin anxiety. (Unchanged by the switch: we were never paying per-seat for QM.)
3. **Sovereignty is a live 2026 buying reason** — for EU, fintech, health, and residency-constrained buyers, "your runtime, your boxes, your models" beats any hosted agent platform.
4. **Harness-agnosticism is a hedge** — we sit above the frontier-model race, so model churn doesn't invalidate us.
5. **Audit is partly free** — Buzz's signed identities are genuinely free. QM's "everything is audited" posture is now a *pattern we re-implement*, not something we inherit. The audit log, the separate immutable store, and the egress sink are ours.
6. **The moat moves to the right place** — not "our architecture," but the accumulated corpus: claim schemas, watch contracts, transfer-tested skill cards, eval suites, routing calibration, Context Bundles. Portable across harnesses. Compounding per tenant.

### 16.3 The integration correction (found by reading source, not READMEs)

Two claims that survived three drafts of confident writing were false:

1. **jcode is Rust, not Go.** The project is `1jehuang/jcode` — 1,198 `.rs` files, **0** `.go`, Cargo workspace v0.84.0, MIT, YC-launched. The Go project is `cnjack/jcode`, an entirely different codebase that happens to share the name. We cloned the wrong one, then *rewrote our own correct documentation to match the wrong clone* — which is the exact failure mode the Reality Ledger exists to prevent: a confident, well-sourced-sounding assertion that was wrong because its provenance was a mistake.
2. **QM cannot drive jcode as a harness.** QM's approved-harness set is `pi | opencode | codex | claude` (`src/model/pi-models.ts`), and the string "jcode" appears **zero** times across QM's `src/`, `plugins/` and `docs/`. So "Engineering scope → harness = jcode" was never implementable as drawn.

**The real integration.** jcode ships `crates/jcode-harness-api` (client · events · requests · sockets) plus a **TypeScript SDK** with per-platform npm binaries. So Vital drives jcode as a **sibling process over that API** — the same coordination path as everything else: a REQUEST with a bid, a deliverable, claims written back — rather than QM mounting it. Engineering scope keeps a *QM* harness for in-sandbox work; jcode is used where its strengths are real: swarms, long background/overnight runs, RAM efficiency, and its own memory graph.

**A pattern worth stealing.** jcode's `crates/jcode-command-risk/src/gate.rs` is a deterministic, explicitly **non-model** refusal gate. Its stated reasoning is our problem statement: an LLM judge is expensive, adds latency to every borderline call, and *"can be talked around by the same reasoning that produced the command."* So instead it refuses once and returns a structured prompt forcing the **generating** model to supply a `justification` naming what the user actually asked for — and *"the refusal is not satisfiable by repetition: a blind retry of the identical call fails again."*

That is a better mechanism than ours for the same failure mode. Our honeytasks measure whether **humans** are rubber-stamping; jcode's gate makes **agent** rubber-stamping structurally impossible at the point of action, with no extra model in the loop. Adopt it for `ACT_*` escalation: a refusal clearable only by new information, never by retry.

**Net — and this number moved twice.** The first read of QM's source suggested ~60% of the build already existed. That was measured against *running on* QM. Once the plan became *absorb from* QM, the figure fell, because most of what we were counting is substrate we now own: scoped sandboxes, the scheduler, crons/monitors/webhooks, the egress proxy, the skill registry, the web UI and the Slack plugin. QM's own dependency list is the tell — `@anthropic-ai/claude-agent-sdk`, `@openai/codex`, `opencode-ai`, `@slack/*`, `e2b`, `modal`, AWS SDK, fastify. Absorbing all of that is not a startup, it is a fork.

**What we actually take** is leaf modules with light coupling, MIT-licensed, vendored with pinned provenance headers and a `LICENSE-THIRD-PARTY.md`:

| Module | Lines | Needs |
|---|---|
| `loops/governor.ts` | 148 | `types` only |
| `idempotency/idempotency-store.ts` | 79 | `durable-map` (310) |
| `loops/ship-gate.ts` | 73 | `trigger-store`, `util/crypto` |
| `policy/command-policy.ts` | 911 | `types` (712), `safe-regex` (67), `errors` (46) |

**What we explicitly do not take:** `loops/item-ledger.ts` (504 lines, imports `slack/mrkdwn` — a Slack dependency in a ledger is the wrong shape), and any of the substrate above.

**So the honest scope statement is:** we are building a runtime with a *head start in design and a few hundred lines of proven policy code*, not assembling a platform out of other people's services. Genuinely-new work: the **typed claim ledger**, the **eval spine**, the **attribution layer**, the **R/A/I matrix + Trust Ledger + honeytasks**, the **Watch Contract compiler**, the **transfer-testing gates**, and now **our own sandbox/scheduler/egress substrate**.

That is a bigger build than §16 claimed an hour ago. It is still smaller than v2's greenfield platform, and the research-adjacent parts are still the parts nobody has solved.

---

## 17. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ VPS-1  BUZZ   (Rust/TS, Nostr, Apache-2.0)                             │
│  humans + agents as signed identities · channels · threads · voice ·    │
│  repos · workflows        →  THE PUBLIC, NON-REPUDIABLE RECORD          │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ claim IDs ↔ event signatures
┌──────────────▼─────────────────────────────────────────────────────────┐
│ VPS-2  VITAL CORE  (headless TS/Node + Postgres)  ← our substrate      │
│  API · identity · policy · scheduler · agent loop · queue · memory      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  ★ src/  =  VITAL  (MIT, our code)                                │  │
│  │   ledger/     claims · decisions + Context Bundles · outcomes ·     │  │
│  │               replay · export · curation queues                     │  │
│  │   coord/      QUERY/REQUEST/NOTICE · decompose · hop limit ·        │  │
│  │               dedupe · budgets · escalation cap that blocks         │  │
│  │   router/     4-class policy router · shadow · task registry ·      │  │
│  │               calibration · labeling queue · reflex coverage        │  │
│  │   compiler/   Skill Cards · quarantine · transfer tests · decay ·   │  │
│  │               mining · registry reads · trustTier                   │  │
│  │   gov/        R/A/I matrix · Trust Ledger · honeytasks · kills ·    │  │
│  │               sampling · batches · shell gate · act path            │  │
│  │   evals/      ★ the spine — suites · promotion gates · injection ·  │  │
│  │               poisoning-vs-gate · held-out guard                    │  │
│  │   attrib/     cost roll-up · holdouts · pre-registration · caveats  │  │
│  │   ingest/     file/GitHub/Serper collectors · checkpoints · dedupe  │  │
│  │   sense/      Watch Contracts · materiality · Integrity Gate ·      │  │
│  │               poisoning suite (beside QM's screen, not on it)       │  │
│  │   wedge/      Ship-to-Result · churn-response · feature-request ·   │  │
│  │               agentic deep research (plan→approve→run→report)       │  │
│  │   talk/       TalkSurface bind/verify — the Buzz→Slack swap point   │  │
│  │   substrate/  scheduler · sandbox · egress · screen · identity ·    │  │
│  │               harness adapters (jcode + offline second)             │  │
│  │   capabilities/ contracts (9 Qs + outcome + kill) · silence budget  │  │
│  │   core/       sqlite driver · dialect helpers · migration journal   │  │
│  │   vendor/qm/  absorbed leaf modules, provenance-pinned             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  per-scope durable sandboxes                                            │
│   ├ Market ├ Customer ├ Product ├ Marketing ├ Sales ├ Finance           │
│   └ Engineering → jcode harness API (sibling process)                   │
└──────────────┬─────────────────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────────────────┐
│ VPS-3  jcode (Rust, MIT) — TUI/SDK, swarms, graph memory, MCP, 30+ tools│
│         driven via jcode-harness-api / TS SDK ← NOT a QM harness:       │
│         a sibling process, coordinated rather than mounted              │
└────────────────────────────────────────────────────────────────────────┘

 SENSING   our scheduler: crons + watches + webhooks → L0 collect → L1 triage
           → materiality gate → L2 reason
 SECURITY  Buzz signatures · our R/A/I + vendored command-policy +
           capability-token egress · injection suite in CI · rebuildable
           sandboxes · separate audit log
```

**Three structural rules.** (1) Buzz is a surface, not a store — the Ledger survives a Buzz→Slack swap. (2) **Vendored code is fenced**: it lives under `src/vendor/qm/`, every file carries an upstream-SHA provenance header, and nothing outside that directory may be edited to look like upstream. We absorb, we do not pretend. (3) The Ledger is the only place claims live.

---

## 18. Roadmap with exit gates

| Phase | Time | Build | **Gate to proceed** |
|---|---|---|---|
| **0 Substrate + vendoring** | 3w | Vital core skeleton; `src/vendor/qm/` with provenance headers + `LICENSE-THIRD-PARTY.md`; jcode driven over harness-api; Buzz instance; one reference topology; end-to-end verify in CI | vendored files isolated and pinned; a jcode session runs end-to-end; a stranger boots the topology from the README |
| **1 Ledger v0** | 3w | claim schema; signature binding; read-only release ingestion | 100 claims populated; stale-fact rate measurable; **zero actions taken** |
| **2 Ship-to-Result** | 5w | change summary + asset drafting + Buzz approval + outcome capture | ≥50 launches; time/hours delta proven; claim error <1% |
| **3 Eval spine** | 4w | evals per capability; honeytasks; attribution holdouts | every capability has a **failing** eval before it gets a new feature |
| **4 Router shadow** | 4w | 4-class router in shadow; calibration; error budgets | precision ≥ gate on 2,000 labelled tasks |
| **5 Compiler** | 6w | Skill Cards, quarantine→promote, transfer tests, drift | ≥10 cards promoted **and** surviving transfer; auto-demote proven in a drill |
| **6 Sense** | 6w | Watch Contracts, materiality, Integrity Gate, Market+Customer scopes | beats a curated human watchlist on precision/recall at lower cost; zero poisoning incidents |
| **7 Act** | ongoing | `ACT_REVERSIBLE` autonomy via Trust Ledger | honeytask detection ≥ threshold; kill-switch drills pass; legal review |
| **8 Runtime** | 12mo+ | expand beyond launches; sell to COO/CFO | `cost_per_good_decision` falling **3 consecutive quarters** — the only proof the thesis is true |

**v2 progress (2026-09-09, <!-- vital:testcount -->209/209 tests green<!-- /vital:testcount -->).** Phase 0 substrate exists
as tested code (scheduler, sandbox, egress core, screen, identity, two
harness adapters) — deployment, not design, is what's left. Ledger v0 is
built past its gate shape (decisions, bundles, replay, outcomes, curation
queues, export). The wedge runs as coordination (summaries, fan-out,
claims checker, three loops) without rooms or pilots. Eval spine, R/A/I +
Trust + honeytasks + kills, router registry + calibration, compiler +
transfer gates, Watch Contracts + Integrity Gate all exist as tested code.
What remains is production surface (live Buzz/jcode/Postgres, approval
rooms, packet proxy), pilot traffic (50 launches, label volume, honeytask
baselines, quarterly cost curve), and the GTM half (partners, pricing,
decks, SOC 2). See TODO.md "V2 backlog".

**Note the ordering.** Sensing is Phase 6, not Phase 1. v1 led with the World Model; that was backwards — external intelligence is worthless if internal coordination is unproven.

---

## 19. KPI tree

```
North star: intelligence cost per good decision (falling)
├─ Value        launch cycle time · hours reclaimed · adoption lift · pipeline influenced
├─ Grounding    stale-fact rate · contradiction MTTR · provenance completeness
├─ Routing      precision · tier-mix drift · retry cost · escalation latency
├─ Compiling    promotion rate · transfer survival · decay incidents · rollback time
├─ Trust        override rate · honeytask detection · auto-approval leakage · stop-drill time
├─ Sensing      signal precision/recall vs human watchlist · poisoning attempts caught
├─ Safety       injection-suite pass rate · unauthorized-action attempts (target 0)
└─ Commercial   pilot→production rate · NRR · $ per completed mission
```

**Pilot→production rate** is the metric the whole category is judged on. The embedded-vs-deployed gap is where companies like this die.

---

## 20. Risk register (top 10)

| Risk | L | I | Mitigation |
|---|---|---|---|
| Buyers won't pay for a runtime, only outcomes | H | H | wedge-first GTM; runtime is roadmap, not pitch |
| **Buzz is ~7 weeks old**; Nostr chat+git unproven as system of record | H | H | Ledger exportable + protocol-independent; Buzz is a surface. **Test the Buzz→Slack swap in Phase 0, not Phase 7** |
| **QM is young; upstream moves fast** | H | M | **Neutralised by absorbing rather than depending** — no fork, no sync, no drift. New cost: the substrate we inherited is now ours to build and secure, especially egress. Upstream still worth tracking for ideas |
| We become an infra/support company | H | **H** | **worse now** — absorbing means we own the substrate. Mitigate: one supported topology, automated verification, paid managed tier, and resist custom-config sales asks |
| Agent holds a person's credentials + reads the open web | H | **H** | no read-secrets+egress in one scope; Strict posture on money/customer/prod; `ACT_IRREVERSIBLE` never autonomous in year 1 |
| Prompt injection with real teeth (durable sandbox = persistent foothold) | H | **H** | our Integrity Gate + QM-shaped content screen; injection suite in CI; **rebuildable sandboxes** so persistence is never trust-bearing. *We now own this defence rather than inheriting it* |
| Router never clears its error budget | M | H | deterministic policy carries the bulk; learned layer optional, not load-bearing |
| Procedures degrade silently across teams | M | H | transfer tests + drift monitors + auto-demote + scoped promotion |
| Humans rubber-stamp; oversight is theater | H | H | honeytasks, sampling, batch ceilings, automatic autonomy freeze |
| Platform incumbents / context-layer vendors absorb the niche | H | M | own the decision+procedure+outcome corpus, not the data layer; stay exportable and integration-friendly |
| **Memory layers commoditise our positioning by proximity** (TDAM ships skills+memory+ACLs free, looks like us lexically) | M | H | sell *provable* not *remembered*; keep the moat claim scoped to transfer-testing/quarantine/drift; publish an **action-correctness** benchmark they cannot answer (§29.5) |
| **Zero-code on-ramp gap** — their integration is one env var, ours is a week | H | H | build a proxy-shaped Vital on-ramp, or shrink `npx vital init` install surface (§29.3) |

---

## 21. Falsifiable bets

Stated so we notice when we're wrong.

1. **Absorbing beats depending, and beats greenfield.** **v2 outcome, 2026-09-09:
HELD.** Seven QM modules absorbed as narrowed, provenance-pinned vendoring
(governor, ship-gate, command-policy, crypto, objects, errors, safe-regex);
idempotency deliberately skipped (our SQLite dedupe already exists — no
parallel path). Substrate took weeks of design-and-test, not 6 months, so
the reconsider-QM trigger never fired. The "~8 weeks to first loop" figure
is still dead (re-estimated ~18–23 weeks solo) — but the cause is pilots
and rooms, not substrate.
2. **Grounding beats reasoning.** If gains come mostly from swapping to a better model rather than from ledger/eval/transfer quality, there is no moat.
3. **Procedures transfer, but only some.** Expect a *minority* of cards to survive cross-role/cross-model testing. Build for quarantine, not magic.
4. **Attention is the binding constraint, not intelligence.** If the customer's bottleneck turns out to be capability rather than coordination, the wedge must move.
5. **Sovereignty is a buying reason, not a niche preference.** If no EU/fintech/health buyer chooses us *because* we run on their boxes, the self-hosted ops burden isn't justified.
6. **One buyer exists.** If no single executive owns this before IT/Legal/Product all agree, verticalise rather than horizontalise.

---

## 22. What was removed from v1, and why

| Removed | Reason |
|---|---|
| "AI-native company operating system" as the pitch | no single buyer; invites incumbent comparison; contradicts the pilot-failure evidence |
| Seven-level autonomy ladder | ladders imply global promotion; replaced by per-action-class R/A/I matrix |
| Seven-tier cognitive router | misroute surface too large; 4 classes, deterministic-first, shadow-gated |
| Community/tech/market monitoring at launch | poisoning risk + no materiality mechanism; deferred to Phase 6 |
| Idea → Company Blueprint → build-a-company | unfalsifiable and far from revenue; kept as a later onboarding mode only |
| "Prevents 200 permanent agents" as a bullet | promoted to a governed metric: agent count, mission count, per-capability kill conditions |
| "becomes progressively more efficient" | now a single measurable curve: `cost_per_good_decision`, with a quarterly trend gate |
| Building our own chat UI | **Buzz exists.** Still true, still the right call |
| Running Vital *inside* QM as a deployment layer | superseded — we absorb from QM and own the substrate. Costs us the sandbox/scheduler/egress we thought we'd got for free, buys us control and no fork-drift discipline |
| The departments/**org-chart metaphor** in the pitch | commoditised as a demo — TDAM ships a one-person company with Scout/Builder/Reviewer squads and memory loadouts, free, with a video (§29.4). Keep the primitives, cut the metaphor |

---

## 23. Elevator versions

**30 seconds (buyer).** Your people and agents already talk in Buzz and code in jcode, on your own servers. What's missing is a memory that doesn't lie. What's missing is a memory that doesn't lie. When you ship something, we turn it into a launch, support readiness and a sales message with evidence attached, get your team's approval in the room you're already in, execute it, and measure what happened. Then we compile the procedure — but only after it passes cross-team and cross-model transfer tests. And every decision's exact basis stays signed and replayable.

**2 minutes (investor).** Agentic AI is large and growing — Gartner expects 40% of enterprise apps embedding task-specific agents by 2026, up from under 5% — but pilots die on unclear ROI and weak risk controls, and capital is concentrating in vertical agents. The market's missing layer isn't more agents; it's **grounded state, budgeted attention, and safely compiled procedures**. The 2026 open stack finally gives us the body: Buzz provides signed human+agent identities, chat and git on a self-sovereign protocol; QM proved the scoped-agent shape and we absorb its best leaf modules under MIT; jcode provides Rust-native coding swarms driven over a versioned harness API. We build the four things none of them have — a typed bi-temporal Reality Ledger, a Watch Contract compiler with an adversarial integrity gate, a Skill Card registry with transfer testing and decay, and an eval-and-attribution spine — delivered as a QM deployment layer rather than a competing platform. We enter through one measurable loop and accumulate the only asset that compounds: a versioned corpus of claims, decisions, outcomes and proven-safe procedures, portable across harnesses and deployable on the customer's own boxes. Our honest risk is that procedural memory doesn't transfer well, which current research confirms — that's precisely why our compiler ships with quarantine and decay instead of pretending the problem is solved.

**One sentence.** Turn what changed into what the company does — with evidence, a budget, an owner, a signature, and a number attached.

---

## 24. Verified build state (v2, 2026-09-09)

**Typecheck: 0 errors. Tests: <!-- vital:testcount -->209/209 green<!-- /vital:testcount -->** (real sockets, real sqlite;
eslint, prettier, provenance-guard, and audit gates green; 20 commits on
main). Every behaviour below is proven by a named test — `[x]` in TODO.md
means verified by a passing test or run, never "written".

> **Correction history, kept visible per this document's own thesis.** This
> section once read "30 passed, 0 failed," then "currently CRASHES" on an
> `ERR_UNHANDLED_ERROR` in the jcode client (`onData` emitting raw
> `frame.ev`; any harness `error` frame killed the process). Fixed 2026-09-09:
> namespaced emits (`frame:<ev>`), error replies reject pending requests,
> permission/cancel round-trips drained before close. The crash, the two
> runner races it hid, and the four defects below were all caught only by
> running the code — every one typechecked clean.

Implemented:

| File | Contents | Verified behaviour |
|---|---|---|
| `src/core/types.ts` | claim kinds, agent-creatable subset, source tiers + rank, action classes, routing classes, message classes, request states, `CostBid` | — |
| `src/core/db.ts` + `migrations.ts` | sqlite driver, savepoint-nested transactions, 17-table schema (v4), tenant `nextSeq`, SQLite/Postgres dialect helpers, named migration journal with tested rollback | migrations run clean |
| `src/ledger/` | Reality Ledger + decisions/outcomes/replay/export/curation | I1 agent-cannot-mint-FACT ✓ (adversarial, all 11 kinds) · I2 ungrounded FACT rejected ✓ · I3 zero orphans (300-append property test) ✓ · I4 contradiction→DISPUTED ✓ · I5 staleness sweep ✓ · I6 context excludes stale/provisional/unverified ✓ · append-only supersede ✓ · Context Bundles + tamper-evident replay ✓ · OUTCOME needs basis ✓ · corrections counted ✓ · full export ✓ |
| `src/coord/` | QUERY/REQUEST/NOTICE + decompose + scheduler | ungrounded work refused ✓ · self-delegation refused ✓ · idempotent dedupe ✓ · NOTICE never interrupts ✓ · paid QUERY rejected ✓ · hop limit ✓ · cycle detection ✓ (fuzz-verified over 120 random graphs) · budget death ✓ · refusal counted ✓ · org daily budget denies ✓ · **escalation cap BLOCKS** ✓ · budgeted decomposition ✓ |
| `src/router/` | 4-class Cognitive Router | controlRate starts 0 ✓ · irreversible fails up ✓ · reflex registry + coverage ✓ · coupling guard (shadow AND control) ✓ · precision gate ✓ · task registry (fail-closed) ✓ · calibration memory ✓ · labeling queue (proposals, never auto-label) ✓ |
| `src/compiler/` + `registry.ts` | Organizational Compiler | imported packs quarantine + forced third-party ✓ · refuses low-confidence/unresolved/mixed-batch traces ✓ · promotion blocked without transfer evidence ✓ · illegal jumps refused ✓ · per-role expansion ✓ · drift auto-demote ✓ · candidate mining ✓ · registry reads with trust gaps ✓ · card eval suites ✓ |
| `src/gov/` | R/A/I matrix · Trust Ledger · honeytasks · kills · sampling · batches · shell gate · act path · rate limits | matrix dominates, ship gates hold lower ✓ · 200-clean promotion, override resets ✓ · honey-miss freezes immediately ✓ · kill drill passes ✓ · deterministic sampling ✓ · batch ceilings ✓ · autonomy freeze ✓ · hard-deny shell screening ✓ · autonomous-only execution ✓ |
| `src/evals/` | spine: suites · promotion · injection · held-out guard | bank/list/run/record ✓ · correction→regression pipeline ✓ · offline→shadow→canary→promote + rollback ✓ · injection corpus over both hooks ✓ · held-out exclusion + audited runs ✓ |
| `src/attrib/` | cost roll-up · holdouts · pre-registration · caveats · tier mix | cost per good decision (null, never 0, when unknown) ✓ · deterministic lanes ✓ · deception caveats ✓ |
| `src/ingest/` | file/GitHub/Serper collectors | checkpointed · fingerprinted dedupe · ground tiers refused ✓ · key in header only ✓ · novelty-vs-ledger ✓ |
| `src/sense/` | Watch Contracts · materiality · Integrity Gate · poisoning suite | 30-day re-review + budget suspend ✓ · ≥2-path corroboration ✓ · self-serving discount ✓ · astroturf detection ✓ · quoted-data enforcement ✓ · poisoning suite with control ✓ |
| `src/wedge/` | Ship-to-Result · churn · feature-request · deep research | cited summaries ✓ · 5-leg fan-out, scheduler-only ✓ · claims checker + denylist ✓ · churn loop + coherence ✓ · research→plan→approve→code ✓ · agentic research (plan review, dedupe, budgets, cancel, verified reports) ✓ |
| `src/talk/` | TalkSurface bind/verify + third-party reconstruction | swap-safe ✓ · tamper-evident ✓ · strict hex validation ✓ |
| `src/substrate/` | scheduler · sandbox · egress · screen · identity · harness adapters | crons + webhook budgets ✓ · manifest rebuild + tamper felt ✓ · metadata/link-local blocks, fail closed ✓ · shadow→enforce, fails closed ✓ · HMAC scope tokens ✓ · jcode + offline second harness ✓ · harness selection ✓ |
| `src/capabilities/` | contracts + silence budget | 9 Qs + metric + kill ✓ · retire-not-rebrand ✓ · silence review ✓ |
| `src/vendor/qm/` | governor · ship-gate · command-policy · crypto · objects · errors · safe-regex, provenance-pinned | narrowed absorbs verified by semantic tests ✓ · idempotency deliberately skipped (SQLite dedupe exists) ✓ |

Bugs found and fixed during verification (all real, all caught only by running the code — every one typechecked clean):
1. **Hop-limit off-by-one** — `chain` holds origin scopes only, so the target hop was never counted and 4-hop chains passed. Fixed by comparing `chain.length > HARD_MAX_HOPS`.
2. **`compile()` rejected every imported pack** — the function accepted a `source` argument that `.strict()` zod parsing then threw on. Fixed by destructuring before parse.
3. **`staleFactRate` double-counted** — a claim past TTL *and* swept to STALE incremented twice, reporting 200%. Fixed to a single disjunction.
4. **Error-frame crash (P0)** — any harness `error` frame killed the process via `ERR_UNHANDLED_ERROR`. Fixed by namespacing emits and rejecting pending requests.
5. **Dropped permission/cancel writes** — fire-and-forget round-trips lost to socket close. Fixed by draining in-flight round-trips and awaiting cancel.
6. **Hex-tamper acceptance** — `Buffer.from(x, 'hex')` silently drops invalid trailing characters, accepting appended garbage in scope tokens and envelopes. Fixed with strict hex validation in both verifiers.
7. **Decompose budget leak** — repeated decomposes ignored already-committed children. Fixed by subtracting non-terminal children's bids from the splittable budget.
8. **Wall-clock time-bomb** — a test depended on wall clock staying before the fixture date. Fixed with deterministic timestamps (and `fresh()` now isolates router config per test).

Also implemented: `src/jcode/{protocol,client,runner}.ts` — the jcode harness-API connection (NDJSON, `req`/`ev` tags, protocol v1), verified field-by-field against `crates/jcode-harness-api/src/{lib,requests,events}.rs` rather than a README. A coding need becomes a REQUEST, is admitted by the scheduler, opens a jcode session, streams the turn, and answers every `permission_request` through our R/A/I policy — so an agent cannot self-approve what a human would have had to approve. Deliverable, tool calls, token usage and cost are written back to the Ledger and the run becomes a compilable TRACE. Tests drive it over a **real socket** via `test/fake-harness.ts`, so framing, the hello-first rule, `reply_to` correlation and the permission round-trip are exercised for real.

**Two protocol facts found by reading source, not docs:** `SessionInfo` carries `session_id`, not `id` (our client would have thrown `NO_SESSION` on every call); and jcode's own SDK notes the `permissions` capability is **absent from the current bridge**, so a client that *waits* for a permission prompt deadlocks — we require only `sessions` and degrade instead of hanging.

**Three absorb corrections found the same way:** `governor.ts` was never types-only (narrowed; `collectVitals` dropped); `ship-gate.ts` needed its `trigger-store` import re-pointed at vendored `objects.ts`; `idempotency`'s `durable-map` is Postgres-backed, so the absorb was **skipped** — our SQLite dedupe already exists and there is exactly one dedupe mechanism.

Not yet built (v2 remainder — production surface, pilot traffic, GTM): live Buzz rooms + approval surfaces, live jcode runs, live Postgres deployment, packet-filtering egress proxy, L0 source breadth (Linear/Jira/RSS/arXiv/review sites), golden eval sets per capability, 50 launches, label volume, honeytask baselines, quarterly cost curve, design partners, pricing, decks, SOC 2. See TODO.md "V2 backlog".

---

## 25. Positioning, in one line each

**Against Grok Bot specifically.** We are not another teammate. Vital is the
accountability layer *for* teammates like Grok Bot. Frameworks and harnesses make
agents do things; Vital makes what they did attributable, bounded, approved, costed,
and measured. This positioning also dodges the fight we would lose — we will never
out-frontier a frontier lab, and v1's "monitor the whole internet" ambition is
better left to whoever has the compute.

**Against memory layers (TencentDB Agent Memory).** *They make agents remember; we make agents provable.* Remembering a wrong thing confidently is the failure mode memory does not solve — and their own roadmap says so, in writing, in 2026 (§29.2).

**The sentence that must survive a car ride.** *Model output can never mint a FACT.*
It is simple, obvious, memorable, and it is a design commitment enforced in code
(I1), not a marketing claim. It satisfies Hale's legibility rule and it *is* the
product.

**The reframe that makes us fundable pre-revenue.** We are not asking for belief in
revenue. We are asking for belief that one instrumented workflow can be proven in
9–12 months, against numbers committed **before** the pilot starts.

---

## 26. The metric contract (pre-revenue traction substitute)

Vital's own pre-registration discipline, turned outward. These are thresholds we
publish in the deck and can be wrong about publicly:

| Metric | Definition | Series A gate |
|---|---|---|
| FACT-minting violations | model outputs written as FACT without verifier evidence | **0** |
| Routing precision | correct tier on labelled shadow-mode decisions | ≥ 0.90 on ≥2,000 |
| Irreversible-action escalation | risky actions routed to a human | 100% |
| Cost per verified outcome | inference + tool + human minutes ÷ verified results | falling 3 consecutive months |
| Outcome writeback rate | launches with a measured OUTCOME claim | ≥ 0.80 |
| Procedure transfer survival | promoted cards passing cross-role tests | > 0, and honestly low |
| M3 cohort retention | a16z rebases AI retention from M0 to M3 | ≥ 60% |

If the first row is ever non-zero, the thesis is broken, not the pilot.

---

## 27. Semantic colour system

Colour here is load-bearing, not decorative — the deck must demonstrate the ledger.

**Brand:** canvas `#FAFAF8` (never pure white; it blooms on projectors) · ink
`#0A0F14` · accent deep teal `#0F5C57` · muted `#6B7280` · hairline `#E4E4E1`.
Teal, not blue, because blue is every other AI deck and green is already reserved
below to mean *verified*.

**Semantic tags — never used for decoration:**

| Kind | Hex | Glyph |
|---|---|---|
| `FACT` | `#0F7A3D` | `✓` |
| `HYPOTHESIS` | `#B45309` | `?` |
| `PREDICTION` | `#4338CA` | `→` |
| `RISK` | `#B91C1C` | `!` |

**Two hard rules.** (1) Never colour alone — every tag carries its glyph; ~1 in 12
men is colourblind, and a deck whose argument lives in hue collapses. (2) The four
semantic colours are never ornamental; the instant green means "chart bar", the
ledger metaphor is dead. Arbitrary categories use teal tints plus grey. No dark
deck except an optional inverted closing slide; no gradients, shadows, or thin
rules; test on a projector, not a 6K display.

**The dogfood move.** Tag the deck's own claims — `FACT` <!-- vital:testcount -->209 tests green<!-- /vital:testcount -->
(reproducible: `npm run typecheck && npm test`), `HYPOTHESIS` PM/Growth
will pay (untested), `PREDICTION` precision ≥ 0.90 by month 9
(dated, checkable). One slide, four lines. It proves the product by using it and it
is the strongest available answer to a16z's anti-posturing rule. Never quote
a test count older than the latest green run — this paragraph rotted once
already (it said "30 tests" through the crash).

---

## 28. Deck spec (12 slides, pre-revenue)

Built from YC's confirmed design rules (Hale: 5–7 memorable ideas, legible/simple/
obvious, text at top, large type, no visual essays, don't show every competitor) and
a16z's minimum content list (thesis, product vision, competitive landscape, traction,
team, roadmap/use of funds) plus its named deck-killer: posturing.

1. **Title** — Vital / grounding and reflex layer for production AI agents / seed · pre-revenue.
2. **Problem** — agents already do real work with no accountability. Flow + 4 red markers. Include the dated TDAM roadmap quote (§29.2): a competitor conceding that extracted memories go stale and can only be viewed or deleted is the best third-party validation we have.
3. **Why now** — *the hard part is no longer "can it generate", it's "can we trust what it did."*
4. **Insight** — model output can never mint a FACT.
5. **Solution** — Ledger → Coordination → Router → Compiler, as one pipeline.
6. **Demo** — Ship-to-Result trace, six steps, status line at bottom.
7. **Wedge/buyer** — PM·Growth at product-led AI cos; concentric expansion rings.
8. **Proof** — engineering proof + metric contract. Replaces "Traction".
9. **Stack** — Vital sits above frameworks and harnesses. No 2×2.
10. **Team** — solo founder; headline answers the objection in the same breath.
11. **Ask** — $X / 18–24 months / explicit Series A test.
12. **Close** — one sentence.

**Cut from any version:** "The Living Company" as an opener, crates/serde/NDJSON,
unverifiable Buzz/QM/jcode integration claims, the 82%-vertical-capital figure
(unverified in our sources), MIT NANDA's 95% as a blunt headline (contested and
frequently misquoted), compliance readiness we have not audited, any rounded-up
buyer count, the org-chart metaphor (§29.4), and any claim that a competitor *lacks*
a control we have not confirmed absent — say "not documented in public evidence."

**Demo Day cut (7):** merge 1+2, drop 3/6/9/12. Test each slide at five seconds on
someone who has never heard of Vital; anything unexplainable gets cut.

---

## 29. Adjacent open source: TencentDB Agent Memory (read the source, not the badge)

> Assessed 2026-09-15 against a fresh clone. Repo `TencentCloud/TencentDB-Agent-Memory`, HEAD `8f2dc83` committed the same day, MIT (LICENSE text verified, not just the badge), v2.0.1-beta.1, 734 TypeScript files, 81 MB, Node >=22.16, three services (`memory-core` + `memory-hub` + `proxy`). **Conclusion: do not depend on it, do not absorb it, steal one thing from it.**

### 29.1 Why it looks like Vital and is not Vital

It is a **memory** layer; Vital is a **governance** layer. I grepped for our four differentiators and got hits, and every hit is a false friend:

| Term | Their code | Their meaning | Our meaning |
|---|---|---|---|
| `provenance` | 13 files | **which prompt version generated this memory** (sha256 of the prompt) | **what source justifies this as true** |
| `demote` | 5 files | **version head superseded** — v1 demoted when v2 appended; a concurrency/CRUD fix | **empirically degrading -> fail open to reasoning** |
| `decay` | 7 files | **per-hop score decay in graph search** — a retrieval ranking knob | **EWMA drift over live outcomes** |
| `TTL` | 104 files | **file-retention / cache / lock expiry** — when to delete bytes | **claim validity expiry** — when to exclude from context |

And two decisive absences: **`quarantine` — 0 files**; **typed claim kinds (`FACT`/`BELIEF`/`HYPOTHESIS`/`PREDICTION`) — 0 matches.** The overlap is lexical, not functional. Anyone skimming the README would conclude we are redundant. That is a positioning risk, not an architectural one — and it is why this section exists.

### 29.2 Their roadmap concedes our thesis — quote it verbatim

From `ROADMAP.md`, under *Editable memories: L1-L3*:

> "Automatically extracted memories won't stay correct forever — facts expire, decisions get reversed, and extraction itself can be off. The panel currently only allows viewing and deleting."
>
> "The value of memory depends on accuracy. Giving people a way to correct it is more realistic than expecting extraction to be perfect."

Plus, from Contributing: *"Agent Memory doesn't have a settled standard yet."*

This is a well-funded incumbent describing our exact problem space and stating that today's answer is delete-or-nothing. It is the strongest third-party validation available to us — from a competitor's own repo, dated, attributable. **Use it on the problem slide (§28 slide 2), quoted and dated.**

### 29.3 The one thing to steal: the on-ramp, not the code

> "One Proxy, unchanged protocol, zero-code integration — point the Agent's base URL to the Proxy and it's done. **No plugin, hook, or MCP server is required.**"

That is why they will win distribution: adoption cost is near zero, and adoption cost is the entire game for a solo founder. Our story today is *compose with Buzz/QM/jcode, wire a ledger, instrument a router* — roughly a week of engineering per tenant against their **one environment variable**.

This is a real hole in the plan, and it is a **packaging** gap, not a feature gap. In priority order:

1. **Build or find a proxy-shaped on-ramp for Vital.** A thin interception point that observes tool/model calls, emits claims, and enforces budgets. If the first integration can be "point your base URL at us," CAC and cycle time change materially.
2. **Otherwise shrink the wedge's install surface.** `npx vital init` that reads a changelog and emits an evidence-backed summary with nothing wired.
3. **Stop selling "composable with the sovereign stack" as if it were frictionless.** It isn't, and a buyer who has tried both will feel it in an afternoon.

### 29.4 What it commoditises — and the moat that survives

The compiler's **plumbing** is now commoditised twice: QM already had scope-owned skills, sharing by grant, admin-gated promotion and git-imported packs; TDAM independently ships Skills with "versions, resource files, trigger boundaries, execution steps, and validation rules" and private-by-default sharing after review. So the claim *plumbing is 80% solved* got stronger and the claim *the compiler is a differentiator* got weaker.

What remains ours, and only ours: **the evidence layer — transfer testing, quarantine, and drift-triggered auto-demote.** Say it exactly that way or we are selling plumbing. (Also note: their `private`/`team`/`restricted`/`agent` ACLs are *visibility* controls; our R/A/I matrix is *action* controls. Different axis, no conflict.)

Their **org-chart pitch** — a one-person company with Scout / Builder / Reviewer squads, each with a memory loadout — is our departments metaphor, shipped, free, with a demo video. **Cut the org-chart metaphor from the deck; keep the primitives.**

### 29.5 Two commercial reads that favour us

- **It is a funnel to Tencent VectorDB + COS.** Backends are `tcvdb` and COS; MongoDB is "experimental, off by default." Fine motivation — but for the EU/fintech/health buyers we price at a premium, a Tencent-branded, Tencent-storage-shaped dependency is a procurement question, not a neutral pick. Our sovereignty story gets **sharper** against this specific thing. *(Inference from backends and branding, not from any statement they have made.)*
- **Their benchmark is one self-reported number on one benchmark** — PersonaMem 48% -> 76%, no third-party run, no task-accuracy or action-safety measure. Don't compete on their axis; **the standard of proof is the gap.** A public benchmark on *action* correctness — typed claims, quarantine, drift-demote — is the axis they cannot answer today without rebuilding.
- Practical note: 81 MB of TypeScript, three services and a vector DB, landing on the same 32 GB box that already holds the customer's monorepo and Timescale instance. Bundling it would add disk and RAM pressure to the exact constraint the deployment model already carries.

### 29.6 Decision

| Action | Do it? |
|---|---|
| Depend on it / bundle it | **No** — occupies our positioning, does not supply our differentiator, drags Tencent storage |
| Absorb code | **No** — inconsistent with the absorb-QM logic (that was 148-line leaf modules with types-only imports; this is three services and a vector DB) |
| Steal the zero-code proxy on-ramp | **Yes** — highest-value item here; a GTM fix, not a feature |
| Quote their roadmap on the problem slide | **Yes** — dated, attributed, from a competitor's own repo |
| Re-scope the compiler's claimed moat to evidence-only | **Yes** |
| Cut the org-chart metaphor | **Yes** |
| Add typed-claims / quarantine / drift-demote to the benchmark we publish | **Yes** |

**One line:** *They make agents remember. We make agents provable. Remembering a wrong thing confidently is the failure mode memory layers do not solve — and their own roadmap says so.*

### 29.7 Verified vs inferred

**Verified from source:** MIT licence text; v2.0.1-beta.1; HEAD `8f2dc83` dated 2026-09-15; 734 `.ts` files; 81 MB; Node >=22.16; proxy-based zero-code integration; L0-L3 layers; BM25+vector+RRF; the four false-friend semantics (read `graph-search.ts`, `skill-store.ts`, `config.ts`, `memory-generation-log-handlers.ts`); the roadmap and contributing quotes; Tencent VectorDB + COS backends with MongoDB experimental; PersonaMem 48->76.
**Not verified:** the `transfer` hits (10 files) — I did not confirm whether any cross-role transfer testing exists, and grep cannot tell me, so I do not claim absence. Their benchmark methodology (I noted only that it is one self-reported figure). Whether `Tencent/` vs `TencentCloud/` in their install snippet is a real second repo or a typo.

---

## Appendix — sources

**Market:** [Gartner 40% by 2026](https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025) · [MIT NANDA via Fortune](https://fortune.com/2025/08/18/mit-report-95-percent-generative-ai-pilots-at-companies-failing-cfo/) · [Forbes analysis](https://www.forbes.com/sites/jasonsnyder/2025/08/26/mit-finds-95-of-genai-pilots-fail-because-companies-avoid-friction/) · [agentic forecast roundup](https://softwarestrategiesblog.com/2026/02/26/roundup-of-agentic-ai-forecasts-and-market-estimates-2026/) · [cancellation + ROI stats](https://unicoconnect.com/blogs/agentic-ai-statistics-2026) · [vertical funding concentration](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) · [adoption trackers](https://aifundingtracker.com/top-ai-agent-startups/)

**Research:** [AFTER — Managing Procedural Memory in LLM Agents, transfer findings](https://arxiv.org/abs/2606.23127) · [LEGOMem modular procedural memory](https://www.microsoft.com/en-us/research/publication/legomem-modular-procedural-memory-for-multi-agent-llm-systems-for-workflow-automation/) · [Router-R1](https://en.papernotes.org/NeurIPS2025/reinforcement_learning/router-r1_teaching_llms_multi-round_routing_and_aggregation_via_reinforcement_le/) · [CoDyn dynamic routing](https://neurips.cc/virtual/2025/loc/san-diego/131708) · [routing cost/quality benchmarks](https://www.requesty.ai/blog/agentic-routing-benchmarked)

**Stack:** [Buzz](https://buzz.xyz) · [Block announcement](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together) · [Buzz explainer](https://www.eesel.ai/blog/buzz-app) · [QM repo](https://github.com/yc-software/qm) · [jcode (Rust, 1jehuang)](https://github.com/1jehuang/jcode) · [jcode.sh](https://jcode.sh/) · ⚠️ `cnjack/jcode` is a **different, Go** project — name collision, do not confuse

**Grok Bot / xAI (external behaviour proof):** [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) · [Grok Bot, more plans](https://x.ai/news/grok-bot-more-plans) · [x.ai/bot](https://x.ai/bot) · [Grok for Slack](https://slack.hooks.x.ai/) · [Connectors](https://docs.x.ai/grok/connectors) · [SpaceXAI for Business](https://x.ai/grok/business) · [Hacker News thread incl. token-burn and supplier-negotiation reports](https://news.ycombinator.com/item?id=49261514)

**Deck guidance:** [YC — How to Design a Better Pitch Deck (Kevin Hale)](https://blog.ycombinator.com/how-to-design-a-better-pitch-deck/) · [YC Startup Library version](https://www.ycombinator.com/library/4T-how-to-design-a-better-pitch-deck) · [YC seed deck template](https://www.ycombinator.com/library/2u-how-to-build-your-seed-round-pitch-deck) · [a16z data-room minimum content](https://a16z.com/the-insiders-guide-to-data-rooms-what-to-know-before-you-raise/) · [a16z fundraising advice to avoid (posturing)](https://a16z.com/fundraising-advice-to-avoid/) · [a16z AI revenue benchmarks](https://a16z.com/revenue-benchmarks-ai-apps/) · [a16z M3 retention](https://a16z.com/ai-retention-benchmarks/) · [YC Fall 2026 RFS](https://www.ycombinator.com/rfs)

**Adjacent open source (assessed 2026-09-15):** [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) · [ROADMAP.md, stale-memories quote](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/ROADMAP.md) · verified from a fresh clone at HEAD `8f2dc83`; see §29

**Regulatory:** [EU AI Act Article 14](https://artificialintelligenceact.eu/article/14/) · [AI Act Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-14)

**Unverified — do not cite as fact:** the "agent washing" study attributed to Carnegie Mellon / Wharton. No primary source located.
