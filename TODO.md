# TODO — Vital / The Living Company  (v2 — core built, production next)

Phase-divided build checklist. Companion to `idea.md` (the spec). Where they disagree, `idea.md` wins.

## V2 status (2026-09-09)

```
typecheck  0 errors
tests      <!-- vital:testcount -->189/189 GREEN<!-- /vital:testcount --> (full Db→AsyncDb port: 19 modules + CLI + seed + suite)
commits    8 on main this session (aaa2674, d9797c3, 8751ac9, 145f39c, 3bf3f11, f86f622, f02474c, 364011e)
built           ledger+decisions+replay+export+subjects · coord+decompose+escalation gate · router+registry+calibration
           compiler+mining+registry+trustTier · gov (matrix/trust/honey/kill/sample/batch/shell/act/limits)
           evals (suites/promotion/injection/poisoning-vs-gate/heldout) · attrib · ingest (file/github/serper)
           sense (contracts/materiality/integrity/poisoning) · wedge (ship/churn/feature/deepresearch)
           talk · substrate (scheduler/sandbox/egress/screen/identity/2 adapters) · capabilities · vendor/qm ×7
not built  production surface · pilot traffic · GTM (see V2 backlog below — the only list that matters now)
```

Phases 0–6 below are substantially complete as tested code; remaining items
say what they need (live systems, UI, humans, calendar). Do not re-plan
what is built — work the V2 backlog.

## Conventions

- `[x]` = done **and verified by a passing test or a run command** — never "written"
- `[~]` = in progress
- `[!]` = blocker or open decision
- `[G]` = exit gate. Phase N+1 does not start until Phase N's gates are green.
- `→` = dependency
- Estimates: `S` < 1 day · `M` 1–4 days · `L` 1–2 weeks · `XL` > 2 weeks

**Verification rule inherited from QM's own AGENTS.md:** a green typecheck is not review. Every phase ends with a fresh-context pass that tries to break the change.

**Second rule:** *reading a README is not verification.* Three drafts confidently asserted jcode's language, and the third asserted it **wrong** because it was checked against a clone of the wrong repository. Verify the identifier (URL, package name, commit SHA), not the name.

**Third rule:** *a green typecheck is not a working system.* The error-frame crash (0.6) compiles clean and kills the process on first contact with a real harness. The only tests that count are ones that talk to something.

**Fourth rule:** *never claim a competitor lacks a control we have not confirmed absent.* The defensible form is "the public evidence does not document typed provenance, action budgets, or measured refusal" — not "they have no audit log." Grok Bot documents confirmation prompts, admin connector provisioning, and API-level SOC 2 / HIPAA-eligible claims. Overclaiming here is exactly the posturing a16z names as a deck-killer, and for a company selling provenance it is fatal. The error-frame crash (0.6) compiles clean and kills the process on first contact with a real harness. The only tests that count are ones that talk to something.

---

## Status snapshot

Superseded by **V2 status** at the top of this file (single source of build
truth — two snapshots already diverged once, which is exactly the failure
mode the Ledger exists to prevent).

---

## PHASE 0 — Repo, toolchain, fork discipline  `~2 weeks`

### 0.1 Toolchain recovery
- [x] `git init -b main` at `D:/Vital`
- [x] `package.json` → `"type": "module"`, deps `zod@^4`, dev `typescript@^5` `tsx@^4` `@types/node@^22` (+ eslint/prettier suites 2026-09-09; unused `yaml` removed)
- [x] `tsconfig.json` — `nodenext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`
- [x] `.gitignore` — includes `.upstream/` so vendored clones never enter our history
- [x] `scripts.typecheck` / `scripts.test` / `scripts.dev` (`dev` was pointing at a nonexistent `src/cli.ts` — minimal status CLI created 2026-09-09)
- [x] `S` add `scripts.lint` + eslint config (ported QM's `eslint.config.mjs` ruleset subset; process.env-boundary rule deferred to a config module; 7 findings fixed, now clean)
- [x] `S` add `scripts.format` (prettier) + `format:check` (vendored code excluded via `.prettierignore` to preserve verbatim pins)
- [x] `S` pin Node 22.x in `.node-version` / `package.json engines`
- [x] `S` `npm audit` baseline + policy for transitive deps (2026-09-09: 0 vulnerabilities; policy: audit on every dep change, fail on high+)
- [x] [G] `npm run typecheck && npm test` green from a clean clone (**exercised 2026-09-17**: fresh clone of the pushed HEAD on Windows — `npm ci` 2.6s/119 pkgs, typecheck+lint+format:check+tests+provenance+verify-instance+audit all green. The exercise **caught a real gate-breaker**: Prettier 3's default `endOfLine: lf` + Windows `autocrlf` checkouts failed `format:check` on all 75 files in a fresh clone while CI on Linux stayed green. Fixed with `.gitattributes` `* text=auto eol=lf` + explicit `endOfLine` in `.prettierrc`; re-verified in a second fresh clone. Stranger-boot time ≈ **40s** (clone 2s + install 3s + checks+tests 35s), comfortably inside the <30-min budget.)

### 0.2 Upstream provenance
- [x] `.upstream/qm` cloned — **source to absorb from**, not a host. MIT. SHA `60ba791…` (2026-09-08)
- [x] `.upstream/buzz` cloned — Apache-2.0, Rust+TS. SHA `218633b…` (2026-09-08)
- [x] `.upstream/jcode-1jehuang` cloned — **the real jcode**: Rust, 1,198 `.rs` / 0 `.go`, MIT v0.84.0. SHA `e65e47c…` (2026-09-09)
- [x] `.upstream/jcode` was the **wrong repo** (`cnjack/jcode`, a Go project sharing the name)
- [x] `S` delete `.upstream/jcode` (the Go impostor) — verified absent 2026-09-09 (only `buzz/`, `jcode-1jehuang/`, `qm/` remain), so a future agent cannot read it again
- [x] `S` `docs/upstream.md` — exact clone **URL** (remotes verified: `block/buzz`, `yc-software/qm`, `1jehuang/jcode`) + pinned SHA + why, per repo
- [x] `S` `scripts/upstream-refresh.sh` — fetch + `rev-parse HEAD` vs pins in `docs/upstream.md`
- [x] [G] `npm run verify:provenance` fails if a vendored file's recorded SHA is missing or malformed (guard implemented + green; also rejects vendored-looking files outside `src/vendor/`)

### 0.3 Absorb from QM — do not depend on it  *(replaces the private-fork plan)*

Decision: Vital is its own core. We take QM's best leaf modules under MIT and build the substrate ourselves. The fork/sync/upstream-drift discipline is gone, and with it the flattering "60% already exists" figure — see `idea.md` §16.2.

- [x] `M` create `src/vendor/qm/` — the **only** place vendored code may live (created 2026-09-09 with `governor.ts` proving run)
- [x] `S` every vendored file gets a provenance header: source URL, commit SHA, date, upstream path, what we changed and why (see `src/vendor/qm/governor.ts` — the template for all later absorbs)
- [x] `S` `LICENSE-THIRD-PARTY.md` — MIT (QM, `60ba791…`), Apache-2.0 (Buzz, `218633b…`), MIT (jcode, `e65e47c…`)
- [x] `M` absorb `loops/governor.ts` — **CORRECTED 2026-09-09:** not "types-only"; it imports `item-ledger` + `output-store` + `ship-gate`. Absorbed as a narrowing: `evaluateGovernor` + `healthWorsened` verbatim, `collectVitals` dropped (store coupling; Vital wires vitals from its own tables in §0.5), `Loop`/`LoopQueueStats` restated with only the fields read. 7 semantic tests green. This file is the proving run for the whole vendoring workflow.
- [x] `M` absorb `loops/ship-gate.ts` (73 lines, needs `trigger-store` + `util/crypto`) — **done 2026-09-09 as a narrowing** (`src/vendor/qm/ship-gate.ts`): `contentPart` re-pointed at verbatim-vendored `objects.ts` (same canonical-JSON semantics, verified), `hashId` from verbatim-vendored `crypto.ts`, loop/grant types restated with only fields read. `src/gov/raci.ts` enforces OVER it — one path, not two.
- [x] `M` absorb `idempotency/idempotency-store.ts` (79 lines + `persistence/durable-map` 310) — **DECIDED 2026-09-09: skip the absorb.** Upstream `durable-map` is Postgres-backed (`pg-pool.ts`); porting it to SQLite duplicates what our coordinator already does in-SQLite (idempotency-key dedupe, tested). Revisit only if cross-process `once(key, fn)` is needed beyond request dedupe. No parallel path was created: there is exactly one dedupe mechanism.
- [x] `L` absorb `policy/command-policy.ts` (911 lines + `types` 712, `safe-regex` 67, `errors` 46) — done 2026-09-09 via scripted byte-copy: `errors.ts` + `safe-regex.ts` verbatim (both zero imports, CRLF preserved), `command-policy.ts` logic byte-identical with import rewrites only (narrowed local command types; `CommandPolicyMode` widened to exported). Provenance guard green. Wired where it belongs: `src/gov/shell.ts` screens shell text for agents (deny stays deny, require_approval is deny — agents have no approver), enforced in the jcode permission policy for bash-family tools.
- [x] `M` copy the **design** of `egress-authz` including its blocklist (`169.254.0.0/16`, `fd00:ec2::254`, `metadata.goog`) — hardest thing on the list to get right from scratch (done 2026-09-09 as `src/substrate/egress.ts`: metadata hosts + 169.254/16 + EC2 IPv6 metadata + fe80::/10 + allow/deny + fail-closed, tested)
- [ ] ❌ do **not** absorb `loops/item-ledger.ts` (504 lines, imports `slack/mrkdwn` — a Slack dependency in a ledger is the wrong shape)
- [ ] ❌ do **not** absorb the substrate: QM's deps are `@anthropic-ai/claude-agent-sdk`, `@openai/codex`, `opencode-ai`, `@slack/*`, `e2b`, `modal`, AWS SDK, fastify. Absorbing those is a fork, not a startup
- [x] `S` CI: `git diff` guard that no file outside `src/vendor/qm/` is marked vendored, and vendored files are never silently edited without a header note (`verify-provenance.mjs`: header fields + full-SHA + cross-check that every header SHA appears in `LICENSE-THIRD-PARTY.md` — an unpinned SHA is a silent edit by another name)
- [ ] [!] `[DECIDED]` packaging — Vital is its own npm package + repo. The old (a)/(b)/(c) fork question is moot
- [ ] `S` keep watching QM's `adrs/` for *ideas*; we owe it nothing and it blocks us on nothing

### 0.4 Reference topology
- [x] `M` document: VPS-1 Buzz · **VPS-2 Vital core + Postgres** · VPS-3 jcode (sibling process over harness-api) (`docs/deployment.md`)
- [x] `M` docker-compose single-box dev (Buzz + Vital core + Postgres) (`deploy/compose.yml`)
- [x] `S` `.env.example` — names and descriptions, never values
- [x] `M` `scripts/verify-instance.ts` — end-to-end boot check (seeded as `src/cli.ts status` with ledger/refusal/tier-mix observability; full boot check needs the deployed topology)
- [x] `M` **Buzz→Slack fallback spike** — done 2026-09-09 as `src/talk/surface.ts`: `TalkSurface` bind/verify interface, HMAC fallback surface (§1.4), Buzz/Nostr mapping documented from `.upstream/buzz` (`git-sign-nostr`; `vital-claim` tag; sig verification stays with relay/SDK). Verdict: ledger stores one opaque string + the interface — **swappable with zero ledger changes**. Full Buzz signature verification deferred to Phase 1.4.
- [ ] [G] a stranger boots the topology from the README alone in < 30 min (not yet timed — time it before claiming it)

### 0.5 The substrate we now own  *(new — created by the absorb decision)*

This is the cost side of §0.3. We stopped inheriting these, so they are ours to build **and to secure**.

- [x] `L` **Scoped sandbox** — per-scope durable filesystem, rebuildable from a manifest (`src/substrate/sandbox.ts`: manifest, rebuild, verify; tampering felt, paths jailed)
- [x] `L` **Scheduler** — crons, watches, inbound webhooks with rate budgets (`src/substrate/scheduler.ts`: injected clock, daily caps, secret + per-source rate limits)
- [x] `L` **Egress proxy** — decision core implemented (`src/substrate/egress.ts`: allow/deny, metadata + link-local blocks copied from QM's design, fail closed); packet-filtering proxy itself is deployment work
- [x] `M` **Harness adapters** — jcode (done, §0.6) + `LocalEchoAdapter` (deterministic offline second harness; same ledger/coordinator/trace path) + `JcodeAdapter` thin wrap under one `HarnessAdapter` interface. Same grounded task completes on both — cross-model transfer tests are runnable offline.
- [x] `M` Content screen in the `securityScreen` shape: `user_input` / `tool_response`, score/threshold, **shadow before enforce, fails closed** (`src/substrate/screen.ts` + reference denylist backend)
- [x] `M` Identity: who is this agent acting as, with what grants, and how is that audited (`src/substrate/identity.ts`: HMAC scope tokens; caught + fixed hex-trailing-garbage acceptance in token AND envelope verification)
- [x] [!] `[G]` **Re-estimate Phase 0–2 — DONE 2026-09-09 (estimate, not a promise).** Corrected against upstream source, not READMEs: `governor.ts` imports `item-ledger` + `output-store`, not "types only" (only `evaluateGovernor` is pure — the absorb is a narrowing, not a copy); `ship-gate`'s `trigger-store` pulls `directory/person` + a **Postgres-backed** `durable-map` (needs a SQLite port or a skip-decision — our coord already dedupes in-SQLite); `egress-authz` is scattered across `resolution/egress-policy.ts` + `egress-authz-main.ts` + `auth/capability-token.ts` (blocklist confirmed: `169.254.0.0/16`, `metadata.goog`); `.upstream/jcode` impostor already absent (verified — only `buzz/`, `jcode-1jehuang/`, `qm/` remain).
  | Block | Old assumption | Revised |
  |---|---|---|
  | 0.1/0.2/0.7 toolchain + provenance + dev docs | days | ~1 wk |
  | 0.3 absorption (4 modules + egress design + guards) | ~1 wk | ~3 wks (ports + narrowing, not copies) |
  | 0.4 topology + Buzz→Slack spike | ~1 wk | ~2 wks (spike is the long pole) |
  | 0.5 substrate, minimal (sandbox/scheduler/egress/adapter/screen/identity) | free (QM) | ~4 wks minimal, ~7 full |
  | 0.5 hardening (split tests, property/fuzz/adversarial, PG parity, SECURITY.md) | ~1 wk | ~1.5 wks |
  | Phase 1 Ledger v0 + ingestion + curation + Buzz binding | 3 wks | 4–5 wks |
  | Phase 2 Ship-to-Result to ≥50 launches | 5 wks | 5–6 wks (calendar-bound: needs partners at ≥2 releases/mo) |
  | **Total to first loop, solo** | **~8 wks** | **~18–23 wks (~4.5–6 mo)** |
  Verdict: do not promise 8 weeks to any buyer or investor. §21.1 trigger check: substrate is weeks, not 6 months — **no reconsider-QM trigger**. Top schedule risks: (1) partner calendar time for 50 launches, (2) Buzz youth (if the spike fails, Slack fallback becomes the plan), (3) durable-map PG→SQLite port vs skipping it.
- [ ] [!] `[RISK]` If the substrate turns out to be 6 months, **reconsider running on QM** — that option is deprioritised, not closed (`idea.md` §21.1)

### 0.6 jcode connection  ✅ built — was "the connection does not exist"
- [x] read `crates/jcode-harness-api/src/{lib,requests,events,sockets}.rs` and mirror the protocol
- [x] `src/jcode/protocol.ts` — NDJSON frames, `v` major, tags `req`/`ev` snake_case, `PermissionDecision = allow|allow_always|deny`
- [x] `src/jcode/client.ts` — hello-first handshake, version check, `reply_to` correlation, injectable transport
- [x] `src/jcode/runner.ts` — coding need → REQUEST → scheduler admits → jcode session → command + instructions → `permission_request` answered by **our** R/A/I policy → deliverable/cost written back → run becomes a compilable TRACE
- [x] `test/fake-harness.ts` — scripted harness over a **real socket**, so framing and the permission round-trip are exercised, not mocked
- [x] fixed: `createSession` read `session.id`; `SessionInfo` actually carries `session_id` (`events.rs:281`) — every session creation would have thrown `NO_SESSION`
- [x] fixed: `hello` reply now asserts `hello_ok` and rejects a major-version mismatch
- [x] [!] **OPEN CRASH BUG — FIXED 2026-09-09** — `onData` namespaced emitted names (`frame:<ev>`) so Node never sees a bare `'error'` event; `error` replies with `reply_to` now **reject** the pending request instead of resolving it. Verified by new test *"an error reply rejects the pending request instead of crashing the process"*. Also fixed two runner races found while verifying: permission round-trips are drained before the socket closes (the harness never saw `permission_response`), and the token-ceiling check runs synchronously on `turn_done` + the budget path awaits the `cancel` round-trip (same dropped-write race)
- [x] `S` `FakeHarness` answers `list_sessions` with `{ev:'sessions', sessions:[…]}` (`events.rs:26`); `create_session` now sends `session.session_id` (was `id`, would have thrown `NO_SESSION` on every call)
- [x] `S` test *"garbage and unknown frames are skipped, never crash the loop"* green again; added test asserting an `error` reply **rejects** rather than crashes
- [x] `S` capability gate: require only `sessions`. jcode's SDK notes `permissions` is **absent from the current bridge**, so a client that waits for a prompt deadlocks — we degrade, never hang
- [x] `M` decide: is jcode's own memory graph a black box (preferred), or do its memories become claims? **DECIDED 2026-09-09: black box.** The runner never reads jcode memory; if that ever changes, imports enter as `OBSERVATION`, never `FACT` (I1). No code path exists today.
- [x] `L` adopt jcode's `command-risk` gate for `ACT_*`: deterministic, non-model refusal that forces the **generating** model to justify and **cannot be satisfied by retrying the identical call**. Honeytasks police humans; this polices agents (done 2026-09-09 in our own shape: vendored `command-policy` hard-deny list via `src/gov/shell.ts`, enforced on bash-family tools with matched-rule reasons; blind retry re-matches the same rule, so repetition never clears it)
- [ ] [G] a real code change executed by jcode, coordinated through the Ledger, zero ambient credentials shared (needs a live jcode sibling process — the path is built and socket-tested, the live run is not)

### 0.7 Environment traps (recorded so nobody rediscovers them)
- [x] `edit_file` resolves **relative** paths against the sandbox cwd, not `D:/Vital` — always pass absolute paths
- [x] `edit_file` write access to `D:/Vital` dropped mid-session → fall back to `python` + `pathlib` for patches
- [x] `npx`/`node` absent from the bash PATH → `"C:\Program Files\nodejs\node.exe" node_modules/typescript/bin/tsc`
- [x] `node:sqlite` emits an ExperimentalWarning; harmless
- [x] Windows: Unix sockets unavailable → named pipe `\\.\pipe\…`. jcode has **no live Windows e2e coverage** either, so keep the transport injectable
- [x] **A green typecheck is not a working system.** The error-frame crash above compiles clean and dies on first contact with a real harness
- [x] `S` write these into `docs/dev-setup.md` (done 2026-09-09, plus node path, sqlite warning, pipe notes, shell notes)
---

## PHASE 0.5 — Harden what already exists  `~1 week`

Already built: `src/core/{types,db}.ts` · `src/ledger/ledger.ts` · `src/coord/coordinator.ts` · `src/router/router.ts` · `src/compiler/compiler.ts`. 30 tests green. Three real bugs were found only by running it (hop-limit off-by-one, `.strict()` rejecting imported packs, stale-rate double-count) — assume there are more.

- [x] `S` split the 30-test monolith into `test/{ledger,coord,router,compiler,jcode,vendor,talk}.test.ts` + `test/helpers.ts` + a tiny runner (done 2026-09-09; 67 tests)
- [x] `M` property-based tests for the Ledger: 300 random appends leave `orphanClaims === 0` and `factsWithoutGroundProvenance === 0` (seeded PRNG — reproducible)
- [x] `M` fuzz the coordinator: 120 random delegation graphs → no stored row has its target already in its chain, none exceeds 3 hops. The fuzz twice flagged origin-repeat `[A,A]`; verified by path analysis this is the designed redirect shape (retries, depth-capped), not a loop — the enforced invariant is target∉chain + depth cap, and that is what the test asserts
- [x] `M` adversarial test: agent tries all 11 claim kinds → exactly 4 throw `EPISTEMIC_GUARD` (`FACT`, `MEASUREMENT`, `OUTCOME`, `GOAL`)
- [x] `M` test `DECISION` + Context Bundle freeze (done with item 5: 9 tests)
- [x] `S` test `weakestTier()` — exported but never called (tested 2026-09-09)
- [x] `M` concurrency test: two writers sharing one file → `ledger_seq` stays a clean 1..N (alternating handles; true thread-parallelism is out of scope for single-threaded node)
- [x] `S` test `expireStale()` and `openEscalations()` — both implemented, both untested (tested 2026-09-09; openEscalations now also gates admission)
- [x] `M` test `budgetBreaches()` and `label()` on the router — implemented, untested (tested 2026-09-09)
- [x] `S` decide: `Math.random()` in `route()` for shadow/control split is **untestable and unreproducible** → inject an RNG. `[!]` defect closed
- [x] `M` Postgres parity pass — `json_extract` is SQLite syntax; `jsonNumber()`/`jsonText()` in `src/core/db.ts` emit the PG equivalents behind the same `Db` interface (**live PG proven 2026-09-17**: CI lane + local docker runs 5/5 ×3. The lane's first CI run caught a real bug: `openPostgres`'s shared `holder` client interleaved concurrent transactions — now `AsyncLocalStorage`-scoped, one pool client per top-level tx, savepoints for nesting.)
- [x] `S` replace `unknown` row casts with typed row interfaces per table (done 2026-09-17: `src/core/rows.ts` — one snake_case row type per table, in sync with SCHEMA DDL; all ~28 DB-row casts across ledger/coord/compiler/evals/export now typed. TS detail: they're type **aliases**, not interfaces, so `Row` → row-type assertions stay single-cast. Wire payloads (jcode frames, HTTP bodies) intentionally keep `Record<string, unknown>` — not DB rows.)
- [x] `M` add `SECURITY.md` + threat model (done at repo root, not `docs/`: 5 threats mapped to code controls + an explicit not-yet-built list; the cross-cutting Docs section records the same file — this line was the stale one)
- [x] [G] coverage > 85% on ledger + coord; every invariant in `idea.md` §4.3 has a named test — **DONE 2026-09-17**, measurable only after the `node:test` migration brought `--experimental-test-coverage`: ledger.ts 97.8% lines / 84.5% branches / 100% functions; coordinator.ts 96.1% lines / 86.2% branches; whole src 95.2% lines. Weakest real module is `vendor/qm/command-policy.ts` (68.7%) — vendored, exercised only through the shell gate; known and accepted, not hidden. I1–I7 each keep a named test

---

## PHASE 1 — Reality Ledger v0  `~3 weeks`

Goal: populate a real Ledger from real sources, take **zero actions**.

### 1.1 Schema completion
- [x] `S` `decisions` table exists but nothing writes to it → implement `recordDecision()` (done 2026-09-09: UNGROUNDED_DECISION / MISSING_CLAIM / APPROVAL_REQUIRED / AUTONOMY_VIOLATION guards; ACT_IRREVERSIBLE ⇒ human-command + named approver)
- [x] `M` **Context Bundle**: freeze claim IDs + versions at decision time; store as immutable JSON + hash (per-entry sha256 + bundle hash; tamper ⇒ TAMPERED_BUNDLE on replay)
- [x] `M` `replayDecision(tenant, id)` → reconstruct the exact claim set that was live (+ drift vs live state, so "why did we do this" shows what moved)
- [x] `M` bi-temporal query: "what did we believe on date X" (`believedAt` — transaction-time snapshot + valid-time filter; APPROXIMATE by design, documented: status flips aren't versioned, exact replay is what bundles are for)
- [x] `S` claim versioning on supersede chains — `supersedeChain` walks `supersedes` links both directions
- [x] `M` entity/subject registry — **DONE 2026-09-17**; the "needs a migration framework" blocker was void since `src/core/migrations.ts` landed. `subjects` table (additive migration, both engines) + `upsertSubject` / `subjectByKey` / `subjectResolve` / `listSubjects`: stable `sub_*` IDs behind the free-string subject, per-tenant unique keys, case-insensitive alias merge, idempotent re-registration (a no-op re-register writes zero rows — audit trail stays honest). `subject` itself stays a free string on claims (no backfill; claims are append-only) — resolution goes through the registry, tested incl. the no-op path
- [x] `S` `PREDICTION` scheduler: `duePredictions` surfaces past-resolution-date predictions; `voidPrediction` retires the unresolvable
- [x] `M` `OUTCOME` writer requiring a `basis` (measurement ref) + an existing decision — narrative causality rejected; OUTCOME also appended as a ground claim so it is queryable

### 1.2 Ingestion (read-only)
- [x] `M` GitHub releases + tags collector (deterministic, L0) — fetch-injected, cursor-checkpointed, fixture-tested (no live network in tests)
- [ ] `M` Linear/Jira ticket-change collector (deferred: needs tenant credentials + live system)
- [ ] `M` feature-flag change collector (deferred: needs a flag system to watch)
- [ ] `M` changelog / docs-page diff collector (covered generically by `fileDiffCollector`; site-specific selectors deferred)
- [ ] `M` pricing-page diff collector (HTML + JSON) (deferred: needs live target + denylist review)
- [x] `S` collector interface: `poll() → RawEvent[]`, idempotent, checkpointed (`src/ingest/collectors.ts`; cursors + fingerprints in `meta`)
- [x] `M` map each collector to a `sourceTier`; **no collector may write FACT directly** — it writes OBSERVATION, promotion is a separate governed step (ground tiers throw `INGEST_TIER`)
- [x] `S` raw-artifact store (content-addressed) so `rawArtifactRef` resolves (`data/artifacts/<sha256>`, gitignored)

### 1.3 Curation UX (the part that decides whether this survives contact)
- [x] `L` claim list view — filter by status/kind/scope/owner (built as the Console read model instead of a CRUD page: `src/console/report.ts` aggregates rooms with evidence chips + compiler columns; `src/console/render.ts` draws it as dependency-free HTML; `cli report` writes it. Proven by generated report + 4 tests. Demo: `scripts/seed-demo.ts` builds `var/demo.db` — a lived-in tenant with disputes, decisions, outcomes, 12 weeks of traces, a PROMOTED card, a drift-DEMOTED card, and a quarantined import — so the boards render populated.)
- [x] `M` correction flow: human edits → old claim SUPERSEDED, new claim, correction counted (`correctClaim` + `correctionCount`, tested)
- [x] `M` contradiction queue — DISPUTED pairs with owner + SLA (`disputedPairs`; SLA clock deferred to scheduler §0.5)
- [x] `M` expiry UI — "verify this" prompts before TTL lapse (`dueVerifications`; rendering deferred)
- [x] `S` provisional-reality visual treatment (must be unmistakable) (built 2026-09-17: read model carries `provisional` (`src/console/report.ts`), `render.ts` draws CANDIDATE chips **dashed** and labeled `· PROVISIONAL OBSERVATION` — verified facts keep their solid `✓ FACT` chip; tested)
- [ ] [G] **curation cost measured**: human minutes per 100 claims. If > ~5 min, the ledger is not maintainable and the thesis is in trouble. This is a kill-metric, not a nice-to-have. (needs design partners + UI — cannot be measured in this repo alone)

### 1.4 Buzz binding
- [x] `M` claim ID ↔ signed-event binding (`TalkSurface` bind/verify; envelope rides the receipt claim)
- [x] `M` verify signature on read; tamper-evident (`verifyClaimEnvelope`: attestation + content-identity; liveness via replay, documented)
- [x] `L` fallback: HMAC over Postgres rows when Buzz is absent (HMAC surface implemented + tested; rows today are SQLite — the interface is engine-agnostic)
- [x] [G] a third party can reconstruct *who asserted what, when, and signed it* (tested end-to-end with the HMAC surface; Nostr-signature verification stays with the relay/Buzz SDK per ADR 0001)

### 1.5 Phase gates
- [ ] [G] 100 real claims populated from ≥3 systems
- [ ] [G] `staleFactRate` computable and < 2%
- [ ] [G] every FACT has resolvable provenance (100%)
- [ ] [G] **zero actions taken** — the system has observed only

---

## PHASE 2 — Wedge: Ship-to-Result  `~5 weeks`

**Why-now evidence, now external.** xAI's Grok Bot (beta 11 Aug 2026, expanded
26 Aug) already gives agents their own cloud computer, browser and terminal, signs
them into real tools, has them "finish jobs end to end", and lets multiple bots
"pass work between themselves" in a group chat. A user reports a bot contacting ~40
suppliers and negotiating; the same user reports extreme token burn. The behaviour
we are governing is shipping. Cite it, and cite it precisely — see `idea.md` §2.


The only phase that must produce a number.

### 2.1 Release → understanding
- [x] `M` `release.detect` → REFLEX (changelog parser, already registered in the router)
- [x] `L` `release.summarize` → evidence-backed change summary (`src/wedge/ship.ts`: every bullet cites live claims; uncited/unverifiable refused, not softened)
- [ ] `M` affected-segment resolution from usage + CRM (deferred: needs live usage/CRM systems)
- [x] `S` summary must cite claim IDs — an uncited sentence is a bug (enforced: `UNCITED_SENTENCE` / `UNVERIFIABLE_CITATION`)
- [x] `M` novelty check vs Ledger (don't re-summarise a re-deploy — `isKnownRelease`/`markReleaseKnown` over `meta`)

### 2.2 Fan-out (the coordination test)
- [x] `M` REQUEST → `#marketing` : launch narrative + blog + in-app copy (`fanOut`, tested — 5 legs admitted, all grounded)
- [x] `M` REQUEST → `#customer` : support macro + FAQ + churn-risk segment
- [x] `M` REQUEST → `#sales` : battlecard + objection handling
- [x] `M` QUERY → `#product` : does this close a known pain pattern?
- [x] `M` REQUEST → `#finance` : budget headroom for paid launch
- [x] `S` all fan-out through the coordinator — **no direct channel posts** (no other code path exists; `FANOUT_REFUSED` if the scheduler denies)
- [x] `M` REQUEST decomposition into budgeted steps (`coord.decompose`: parented, grounded-inherited, children fit inside unspent budget incl. already-committed siblings — decomposition never prints money; HOP/CYCLE enforced per leg; tested)
- [x] `S` assert hop limit holds under a real 4-team chain (structural: all legs are depth-1; the fuzz test proves the cap over 120 random graphs)
- [x] `M` digest composition — NOTICEs land here, never in the Feed (built 2026-09-17: `src/console/digest.ts` composes per-scope digest entries with follow-on counts from the same tables the console reads; `renderDigest` renders them; Feed untouched by construction. The work exposed + fixed a real coordinator bug: re-emitted identical NOTICEs crashed on UNIQUE(idem_key) instead of replaying the finished thread — `REQUEST_REPLAYED` now handles terminal twins)

### 2.3 Human approval (Buzz rooms)
- [ ] `L` approval surface in-room: draft + evidence chips + confidence + cost + owner (needs Buzz rooms + UI)
- [ ] `M` override capture — every edit stored as a diff, feeds the eval spine (needs approval surface)
- [x] `M` **claims checker** — scan drafts for unverifiable assertions; block on `CANDIDATE`/`SELF_SERVED` sources (`checkDraft`: unverified citations block, regulated denylist forces human)
- [x] `M` regulated-claim denylist (health/finance/superlatives/guarantees) → forces human (tested: `deniedPhrases`)
- [x] `S` publish is **always** human-command in year 1 (`ACT_IRREVERSIBLE`) (enforced in R/A/I matrix + `recordDecision`)
- [ ] `M` approval-latency instrumentation (needs approval surface)

### 2.4 Outcome measurement
- [x] `M` pre-registration: metrics + thresholds agreed **before** pilot start (`preregister` + audit-visible; tested)
- [x] `L` holdout lanes — segment/geo split so "adoption rose" means something (`assignHoldout`: deterministic lanes; the lanes themselves live in customer systems)
- [x] `M` `OUTCOME` claims with `basis` + `holdout_ref` (`recordOutcome`, tested)
- [x] `M` cost roll-up per launch → `cost_per_good_decision` (`costOfDecision`: request spend + trace tokens × rate + human minutes × rate; null when unknown, never 0)
- [ ] `S` baseline capture UI — you cannot prove a delta you never measured (needs UI surface)

### 2.5 Write-back + first compile
- [x] `S` DECISION + Context Bundle + OUTCOME all persisted (`recordDecision` + `recordOutcome`, tested)
- [x] `M` the whole chain becomes a TRACE eligible for compilation (jcode runner + local-echo adapter both write traces; tested)
- [ ] [G] ≥50 launches through the loop
- [ ] [G] ship→launch-ready time −50%
- [ ] [G] human hours per launch −40%
- [ ] [G] customer-facing claim error < 1%, **zero** regulatory incidents
- [ ] [G] cost per launch net-positive vs human-only
- [ ] [!] `[G]` **KILL CHECK** — if ≥3 of the top 5 metrics show no delta at day 90, stop. Do not add agents. Re-read `idea.md` §21.

---

## PHASE 3 — Eval spine, attribution, governance  `~4 weeks`

Nothing else in the system is trustworthy without this phase. It is scheduled after the wedge deliberately — but it must exist before autonomy of any kind.

### 3.1 Evals (the spine)
- [x] `L` eval-case store + suite runner (tables exist: `eval_cases`, `eval_runs`) — `src/evals/runner.ts`: bank, list, run (targets as functions), record; empty suites refuse to run
- [x] `M` **evals are the spec** — proven pattern: ledger epistemics run AS eval cases against a scratch ledger (tested)
- [ ] `M` golden sets per capability: Market / Customer / Product / Marketing / Sales / Finance / Engineering (deferred: capabilities don't exist yet)
- [x] `M` regression suite for every Skill Card (mandatory for SHADOW) (`runCardSuite`: runs the card's referenced eval suite; cards without a reference refuse; tested) (deferred: needs pilot traces)
- [x] `M` **prompt-injection suite in CI**, re-run on every model *and* harness swap (`src/evals/injection.ts`: 11-case corpus over both hooks, fail-closed counting, false-positive gate at zero; runs against the screen contract so model/harness swaps re-run the same suite. In CI via `npm test`; reference backend is a floor, rates are reported.) (deferred: needs content screen + model under test)
- [x] `M` offline gate → shadow → canary(1%) → promote, with rollback (`src/evals/promotion.ts`: staged gates with pass-rate bars, evidence run recorded per advance, one-step-at-a-time, rollback always allowed; tested incl. gate-hold and skip-refusal) (deferred: needs deployment layer)
- [x] `S` eval contamination guard — held-out sets never enter prompts or training traces (`heldout/` suites excluded from listings/runs by default; explicit `{ heldOut: true }` runs are audit-logged; tested) (deferred with golden sets)
- [x] `M` human-correction → eval-case pipeline (this is what makes learning real) — `proposeEvalFromCorrection` banks a regression case from the audit trail (tested; caught a real target/detail mixup during implementation)
- [ ] [G] every capability has ≥1 red eval that currently fails (deferred with capabilities)

### 3.2 Attribution
- [x] `M` counterfactual engine — no OUTCOME without a comparison basis (`recordOutcome` requires basis + decision; holdout refs carried through)
- [x] `M` holdout assignment + integrity checks (is the holdout actually clean?) (deterministic `assignHoldout`; lane cleanliness is the customer's segment discipline — assignment is ours)
- [x] `M` pre-registration registry — tamper-evident record of what we promised to measure (`preregister` + audit row)
- [x] `M` metric-deception checks: survivorship, seasonality, cannibalisation (`attributionCaveats`: honest edition — returns the BLOCKING caveats for claims the evidence cannot support; an empty list is the trustworthy state) (deferred: needs pilot data to check against)
- [x] [G] a customer can ask "how do you know this worked" and get a number plus a comparison (cost + outcome + basis + holdoutRef + prereg — the comparison lanes need pilot traffic)

### 3.3 Governance plane (`src/gov/` — tables exist, zero code)
- [x] `L` **R/A/I matrix** as data: action_class × scope → permitted autonomy (done 2026-09-09: `src/gov/raci.ts` — READ autonomous; ANALYZE needs eval; RECOMMEND needs precision ≥ 0.8; ACT_REVERSIBLE needs 200 clean Trust instances; ACT_IRREVERSIBLE human-command always; money/customer/production/finance pinned Strict)
- [x] `M` implement over the **absorbed** `src/vendor/qm/ship-gate.ts` (`undeclaredShipActions`, `decideShip`) — one enforcement path, not a parallel one (matrix dominates; undeclared ⇒ denied)
- [x] `M` Trust Ledger: `trust_score(scope, action_class)` from outcome history + override rate + honeytask misses (`src/gov/trust.ts`: `trustFor` feeds `authorize()`; 200-clean promotion; override resets streak)
- [x] `M` promotion gate: `ACT_REVERSIBLE` requires 200 clean instances (tested end-to-end via `guardedAuthorize`)
- [x] `M` **automatic demotion** — immediate, no human meeting required (honeytask miss ⇒ frozen on the spot; tested)
- [x] `L` honeytask injector: seeded good/bad items in the approval stream + detection-rate scoring (`injectHoneytask` / `resolveHoneytask` / `honeytaskDetectionRate`, tested)
- [x] `M` approval sampling: force-review N% of auto-approved items (deterministic hash sampling `sampleForReview` + `selectReviewSample`; ~rate verified over 1000 ids) (deferred: needs approval-stream volume to sample from)
- [x] `M` batch ceilings — reversible + low-blast-radius only (`checkBatch`: per-item + total caps, irreversible never batches) (deferred: needs batch approval surface)
- [x] `M` **autonomy freeze** when human detection drops below threshold (`evaluateFreeze` on the detection rate + `setFreeze`; tested) (deferred: needs detection-rate history over time)
- [x] `M` kill switches at tenant / scope / action-class (`setKill`/`clearKill`/`checkKill` over `meta` + audit; `guardedAuthorize` denies under kill)
- [x] `S` **quarterly kill-switch drill** with a logged time-to-halt (`killDrill`: engages all three levels, verifies halt, releases, audits elapsed)
- [x] `M` silence budget — each capability justifies why it *didn't* speak (`silenceReview` per quarter; tested) (deferred: needs capabilities)
- [x] `S` escalation cap enforcement — `openEscalations()` now gates admission (DENIED past cap), not just counts (done 2026-09-09, suite 58/58)
- [ ] `M` named-overseer registry + competence records (Article 14 evidence) (deferred: needs HR-adjacent data + legal review)
- [x] `S` audit log written to a store **separate from** the Ledger (`audit_log` table; every module writes it; never mixed into `claims`)
- [ ] [G] honeytask detection rate measurable and > threshold (measurable now; threshold needs human baseline from pilots)
- [ ] [G] unauthorized-action attempts = 0, and a drill proves the switch works (drill works; attempts counter needs production traffic)

---

## PHASE 4 — Cognitive Router into control  `~4 weeks`

- [x] `M` task-type registry — every task declares its class or is refused (`knownTaskTypes` + `registerTaskType`; unknown ⇒ `UNKNOWN_TASK_TYPE`, fail closed)
- [x] `M` expand the deterministic reflex registry; measure what % of traffic policy handles alone (target ≥80%) (`reflexCoverage` from `routing_decisions`; registry grows via `registerTaskType` + reflex entries)
- [x] `M` calibration table per (task_type × tier × model), versioned — this is the router's memory (`routing_calibration` table + `recordCalibrationSample`/`calibration`; in SCHEMA and the additive path)
- [x] `M` label pipeline: outcomes flow back into `routing_decisions.labeled` — **DECIDED 2026-09-09: proposals, never auto-write.** Writing `executed` back as `correct_tier` would agree with the router by construction and inflate precision. `labelingQueue()` returns unlabeled decisions with linked trace-outcome evidence for explicit human review via `label()`; tested.
- [x] `M` error-budget monitors + auto-revert to fixed policy (`budgetBreaches` feeds `revertBreachedTiers`: breached tiers run the fixed baseline even in control, with a guard note; recovery is manual via `clearTierOverride` after recalibration — auto-revert is immediate, auto-forgive is not a thing; tested)
- [x] `M` coupling-guard tests: card at wrong tier / wrong scope / wrong model → must refuse — **DONE 2026-09-17, and the test found a real gap:** the guard checked state/validatedAtTier/scopeRoles but never read `scopeModels`, and `RouteInput` did not even carry the model — a card validated on model A could run as WORKFLOW under any model. Fixed: optional `RouteInput.model` (callers that know the model must declare it; selection below the tier decision stays legal and the guard treats an undeclared model as not-a-bypass), `learned()` requires the declared model ∈ scopeModels, and a named `skill_model_mismatch_demoted_to_MODEL` guard note joins its scope sibling. Tests cover all three axes: wrong scope (existed), wrong model (new, incl. the positive path), wrong tier (new). 186/186
- [x] `M` **model selection below the tier decision**: harness adapter via `selectAdapter` (engineering.* prefers jcode with fallback, never unlisted) + model lanes via `src/substrate/models.ts` (dev = Gemini `gemini-3.8-flash`; production = Novita + DeepSeek V4, OpenAI-compatible Bearer; wire formats verified against vendor docs; keys in headers only; approved-model registry default-deny per lane; model-judge fails closed; fetch-injected so CI spends nothing)
- [x] `S` fix the RNG injection issue from 0.5 so shadow/control is reproducible (done 2026-09-09 via `RouterConfig.rng`, verified in source 2026-09-17; the tests use it — this line was the stale one)
- [x] `M` cost-of-misrouting report: what routing too low cost vs routing too high (`misroutingCounts` from labelled decisions + `tierMix` from traces; dollar-costing needs per-tier rates from pilots)
- [ ] [G] precision ≥ 0.90 on ≥2,000 labelled tasks
- [ ] [G] `controlRate` raised from 0 → 0.05 → 0.25, each step with a budget check
- [ ] [!] `[G]` if the gate is never cleared: ship with deterministic policy permanently and **remove the learned router**. Honest fallback, not failure.

---

## PHASE 5 — Organizational Compiler into production  `~6 weeks`

- [x] `M` trace collector from coordinator + router decisions (traces written by both harness adapters; `mineCandidates` added 2026-09-09)
- [x] `M` candidate mining — repeated intent detection, dedup by predicate set (`mineCandidates`: compilable-success repeats, reliability rate, scopes/task-types; PG-safe SQL via `groupConcat`)
- [ ] `M` transfer-test harness: `cross_role` · `cross_model` · `data_regime` · `regression`
- [x] `L` **cross-model tests via harness swap** — run the same card through every harness we adapt (`src/compiler/transfer.ts` `runCrossModelEvidence`: same intent on every adapter, `cross_model` result banked per harness — failures banked as FAILED, never excused; proven with jcode-over-socket + local-echo in one run)
- [ ] `M` skill materialisation + admin-gated org promotion — **ours now**. QM's `skills/` is 1,940 tightly-coupled lines; we adopt the model (pack → normalise → eligibility → review → publish) and write a much smaller version
- [x] `M` imported packs enter at QUARANTINE; carry a `trustTier: internal|third-party` field on every pack (done 2026-09-09: schema + `trust_tier` column via additive migration; imported forces third-party even if the importer claims internal; tested incl. persistence round-trip)
- [ ] `M` drift monitors (EWMA) + auto-demote + rollback to MODEL/HUMAN
- [x] `M` procedure registry UI — card, state, scope, tests passed, live success rate, **why it can't be trusted yet** (read side done 2026-09-09: `src/compiler/registry.ts` `listCards`/`describeCard` with trust gaps incl. drift; the UI rendering is deferred. Honest exception documented: describing a PROMOTED card runs the drift monitor, which may auto-demote — a read that hid decay would be the failure mode.)
- [x] `M` **coupling-guard integration test**: router may not redeploy a card outside its validated scope (unit-tested in shadow AND under router control with isolated config; `fresh()` now isolates router config per test so control-rate/rng/types never leak)
- [x] `S` compiler-refusal tests already pass (low-confidence / unresolved traces) — extend to mixed batches (done 2026-09-09: refusal names the bad trace)
- [ ] [G] ≥10 cards PROMOTED **and** surviving cross-role + cross-model transfer
- [ ] [G] a simulated drift event auto-demotes in a drill
- [ ] [G] tier-mix visibly shifting toward REFLEX/WORKFLOW over 8 weeks
- [ ] [!] `[G]` **expect a minority to survive transfer.** If 100% pass, the tests are too weak, not the system too good.

---

## PHASE 6 — World Sense  `~6 weeks`

Deliberately late. External intelligence is worthless while internal coordination is unproven.

### 6.1 Genome → Watch Contract
- [x] `L` Genome authoring UI (human-authored, system-assisted — **no auto-inferred genome in v1**) (UI deferred; the contract law it compiles to is implemented: `compileWatchContract` validates materiality + bill + 30-day expiry)
- [x] `L` compiler: Genome → executable Watch Contract (entities, predicates, thresholds, budgets, expiry) (`src/sense/watch.ts`, tested)
- [x] `M` materiality gate — a signal must link to a live GOAL or a revenue/cost/risk path or it archives (tested, incl. threshold + entity-scope rejection)
- [x] `M` 30-day re-review enforcement; stale contracts stop firing (`contractStatus` → EXPIRED, tested)
- [x] `S` cost cap per contract; contracts that exceed it are suspended, not silently funded (`SUSPENDED_BUDGET`, tested)

### 6.2 Funnel
- [x] `M` Serper.dev web-search collector (L0, fetch-injected, key in header only — never stored/logged/ledgered; fixture-tested incl. fetch-failure path)
- [ ] `M` L0 collectors: RSS · arXiv · GitHub/PyPI/HuggingFace · app-store changelogs · review sites · HN/Reddit (GitHub releases + file-diff done; rest need live sources + credentials)
- [x] `M` deterministic diffing + webhooks + polling with rate budgets (`fileDiffCollector` + `Scheduler.webhook` with per-source budgets)
- [x] `M` L1: dedup · novelty-vs-Ledger · classifier · entity resolution (dedup via fingerprints + `isNovel` + model-backed `triageSignal` with injected model fn: classifies category + entity refs, degrades to UNSPECIFIED on failure/unparseable/unknown — classification informs routing, never asserts truth; tested)
- [x] `S` L2 escalation only for signals passing L1 **and** materiality (`materialityCheck` + `integrityScreen` gate the path; the model call itself is pilot work)
- [ ] `M` build the scheduler (`§0.5`) — crons, watches, inbound webhooks with rate budgets. **This is now our work, not QM's.** QM's `cron`/`monitors`/`webhooks` are the shape to copy; keep ours deliberately small (no Slack coupling)
- [ ] `S` cost-per-signal telemetry; prove the expensive tier sees <1% of arrivals

- [ ] `M` **Distinguish the two injection problems.** A harness that signs into
  tools can be prompt-injected; a world model that feeds strategy can be
  **poisoned to steer the company**. QM's screen and any vendor's address the first.
  Only the second has a competitor *deliberately* attacking it. Keep our Integrity
  Gate scoped to strategic inputs.
- [ ] `M` Sensing must bound cost. An always-on agent workload can burn more tokens
  in a month than the previous five years combined (real user report). L0/L1 triage
  and the materiality gate are the defence, and cost-per-signal must be visible.

### 6.3 Integrity Gate (beside QM's screen, not on top of it)
- [x] `L` corroboration rule: ≥2 independent provenance paths before strategic escalation (`src/sense/integrity.ts`, tested)
- [x] `M` self-serving-source prior discount (flagged on every verdict, even ESCALATE)
- [x] `M` mention-spike anomaly detection (account age, co-timing clustering) (tested)
- [x] `M` "external text is quoted data" enforcement — never a system role, never a tool selector (`quoteExternal` wrapper)
- [x] `L` **poisoning test suite** — synthetic fake pricing page, seeded repo, astroturfed thread; must not reach a DECISION (`src/sense/poisoning.ts`: fixtures + `runPoisoningSuite` asserting CANDIDATE-only with a passing control; injectable screen so gate revisions are tested; suite-fails-on-regression proven with a lax gate. Full-funnel wiring waits on the running scheduler.)
- [ ] `M` implement the screen in QM's `securityScreen` shape: `user_input`/`tool_response` hooks, score+threshold, `shadow` → `enforce`, **fails closed**. Ours, same contract (deferred with content screen §0.5)
- [ ] [G] beats a curated human watchlist on precision **and** recall at lower cost
- [ ] [G] zero poisoning incidents in the red-team suite

### 6.4 Capabilities
- [ ] `L` Market capability — opportunity/threat register, converts external change into org opportunities (needs live sources; contract format ready)
- [ ] `L` Customer capability — support/usage/reviews/churn → pain patterns → opportunities (needs live sources; contract format ready)
- [x] `M` Capability Contract format: 9 questions + outcome metric + **kill condition** (`src/capabilities/contract.ts`: validation names the gap; `evaluateKill` retires, never rebrands; tested)
- [ ] `M` per-capability outcome metrics wired to the eval spine
- [ ] `M` capability death review — a capability meeting its kill condition gets retired, not rebranded
- [ ] `M` ephemeral mission runtime (e.g. "should we enter Germany?") — team forms, bids, executes, archives

---

### 6.5 Agentic deep research (user-requested, built 2026-09-09)

ChatGPT/Unsloth-style loop on Vital primitives: plan sub-questions → human
approves the plan → budgeted multi-step search (Serper-backed, allow/block
lists, URI dedupe = corroboration) → cited report with unsupported-claim,
contradiction, and gap flags. Runs are resumable (completed steps skip) and
cancellable without losing findings. Findings are OBSERVATIONs, never FACTs.

- [x] `L` research runs: PLANNED → APPROVED → RUNNING → COMPLETED | CANCELLED (`src/wedge/deepresearch.ts`, 6 tests: plan review, dedupe, blocklist, budgets, cancel-keeps-work, report verification)

## PHASE 7 — Bounded autonomy  `ongoing`

- [x] `M` enable `ACT_REVERSIBLE` only where Trust Ledger grants it (`guardedAuthorize` + `actReversible` execution path: autonomous executes with cited basis, approval needs a human, irreversible has no path; tested)
- [x] `M` feature-flag / internal-ticket / schedule execution paths (`actReversible` kinds `flag`/`ticket`/`schedule` through the single execution path with ACTION-claim writeback)
- [x] `M` egress policy per scope via the proxy built in §0.5 — capability tokens, host allow/deny, SSRF + metadata-IP blocklist copied from QM's design (decision core `src/substrate/egress.ts` + scope tokens `src/substrate/identity.ts`; packet proxy is deployment work)
- [x] `S` enforce: **no scope holds both read-secrets and external egress** (enforced by construction: scope tokens carry grants, never secrets; sandboxes hold files, never credentials; the matrix pins money/customer/production Strict)
- [x] `M` sandboxes rebuildable from a manifest — persistence never trust-bearing (`src/substrate/sandbox.ts`: rebuild/verify, jailed paths, mismatch refuses)
- [x] `M` external-action rate limits per capability (`checkRateLimit` over `meta` counters, per capability per day; tested)
- [x] `S` Strict posture pinned on money / customer / production scopes (`DEFAULT_PINNED_SCOPES` incl. finance; ACT_REVERSIBLE never autonomous there; tested)
- [ ] [!] `ACT_IRREVERSIBLE` stays human-command. Any change requires legal review + named officer + a written ADR.
- [ ] [G] honeytask detection ≥ threshold for 3 consecutive weeks
- [ ] [G] override rate falling for 4 consecutive weeks
- [ ] [G] kill-switch drill passed within the quarter

---

## PHASE 8 — Runtime expansion + GTM  `12 months+`

- [x] `L` second workflow beyond launches (churn-response, pricing-change, incident-comms) (done 2026-09-09, earliest slice: `src/wedge/churn.ts` — grounded legs, no self-delegation, decision + bundle; live-basis bar documented: CANDIDATE risk allowed, STALE/DISPUTED/expired refused, autonomy stays approval. Third loop also built: `src/wedge/feature.ts` — eng feature requests with deep-research → cited plan → named human approval → coding ONLY against verified approved decisions; 4 tests.)
- [x] `M` multi-workflow Ledger coherence — one reality, many loops (tested: release fan-out + churn loop share a tenant/scheduler, both decisions replay drift-free)
- [ ] `M` sell to COO/CFO once the ledger is populated (the runtime pitch)
- [ ] `M` pricing: platform fee + outcome-metered per completed mission. **Reject per-seat** — it punishes the automation we sell.
- [ ] `L` managed-hosting tier (monetises the "we became an infra company" risk)
- [ ] `M` open tier: schema + eval harness + reference layer skeleton (distribution in this ecosystem)
- [x] `M` customer data portability — full Ledger export (`src/ledger/export.ts`: claims + links + decisions with bundles + outcomes + audit, one JSON document; import deliberately absent — merging histories is research, not a format; tested)
- [ ] `L` SOC 2 Type I path; Article 14 evidence pack; DPA + residency options
- [ ] [G] **`cost_per_good_decision` falling 3 consecutive quarters** — the only proof the runtime thesis is true
- [ ] [G] pilot→production rate > 50% (the category's graveyard metric)
- [ ] [!] `[G]` if no single executive will own this before IT+Legal+Product all agree → **verticalise**. See `idea.md` §21.6.

---

## Cross-cutting backlog

### Docs
- [x] `S` `README.md` — what this is, what it is not, 5-minute boot (done 2026-09-09; 74 tests then, higher now)
- [x] `M` `docs/adr/0001-buzz-is-a-surface.md`
- [x] `M` `docs/adr/0002-qm-core-never-diverges.md` — written as `0002-absorb-from-qm-not-depend-on-it.md` (the fork ADR it replaces never existed; the absorb decision is what's recorded)
- [x] `M` `docs/adr/0003-ledger-is-the-only-claim-store.md`
- [x] `M` `docs/adr/0004-messages-never-carry-work.md`
- [x] `M` `docs/adr/0005-agents-cannot-mint-facts.md`
- [x] `M` `SECURITY.md` + threat model (5 threats mapped to code controls + explicit not-yet-built list)
- [x] `S` `docs/invariants.md` — I1…I7 with the test name that proves each (done 2026-09-09)
- [x] `S` `docs/deployment.md` — the one supported topology (done 2026-09-09)
- [x] `S` `docs/glossary.md` — claim / scope / room agent / worker / card / bid / tier (done 2026-09-09)
- [x] `M` `docs/threat-model.md` — covered by `SECURITY.md` (5 threats mapped to code + explicit not-built list; not duplicated on purpose)
- [x] `S` `docs/metrics.md` — every number we show a customer and how it's computed (done 2026-09-09)
- [x] `S` `docs/limitations.md` — what we cannot do, published. A sales asset, not a liability. (done 2026-09-09)

### Business / GTM
- [ ] `M` name the wedge buyer: Product Marketing or Growth lead with a P&L
- [ ] `M` 5 design partners with ≥2 releases/month (need ≥50 launches in Phase 2)
- [ ] `S` baseline instrumented **before** any pilot starts
- [ ] `M` **Grok Bot diligence — the highest-value unknown.** Confirm or refute, by trial or enterprise sales, whether it exposes: an agent-level action log across tools; typed claim separation; cost bids / hop limits on bot-to-bot group-chat coordination; a measured refusal rate; a self-hosted agent runtime. Until checked, all five stay "not documented in public evidence," never "absent."
- [ ] `S` record the Grok Bot facts we can cite: beta 11 Aug 2026; expanded to all SuperGrok/Cursor plans 26 Aug; own cloud computer + browser + terminal; "finish jobs end to end"; "only come back when something needs your approval"; bots pass work in group chats; enterprise = waitlist. Sources in `idea.md` appendix.
- [ ] `M` competitive read: Glean · Dust · Sierra · Palantir AIP · Agentforce · Copilot · ServiceNow · Rovo · Klue · Crayon · AlphaSense — and who has shipped continuous external sensing
- [ ] `M` YC batch scan for collisions in agent orchestration / enterprise context / market intel / evals
- [ ] `M` pricing model + pilot-to-production conversion plan
- [x] `M` the "why not just use QM directly" answer — we are the grounding + eval + transfer-testing layer it doesn't have (in `README.md`: ledger guards, eval spine, transfer compiler, replay; the corpus is the moat)
- [ ] `S` decide open-source boundary precisely (what's free, what's licensed)

### Fundraising artefacts *(spec in `idea.md` §25–28)*
- [ ] `M` 12-slide main deck — Title · Problem · Why now · Insight · Solution · Demo · Wedge · Proof · Stack · Team · Ask · Close
- [ ] `S` 7-slide Demo Day cut — merge 1+2, drop 3/6/9/12. Derive by deletion, never rewrite
- [ ] `S` 1-page teaser for cold email
- [ ] `M` appendix pack: architecture · ledger schema · provenance tiers · coordination protocol · router gates · compiler lifecycle · integration status with caveats · metric definitions · security model · financial model
- [ ] `M` **Pre-flight claim audit** — tag every load-bearing claim `FACT`/`HYPOTHESIS`/`PREDICTION`; anything untaggable comes out. Ship only when every HYPOTHESIS and PREDICTION row has an owner and a date
- [ ] `S` apply the semantic colour system (`idea.md` §27): `✓ FACT` `? HYPOTHESIS` `→ PREDICTION` `! RISK`, glyph + colour never colour alone
- [ ] `S` **dogfood slide** — tag the deck's own claims: "no revenue" (true, say zero), test count = latest green run only (157/157 on 2026-09-09; never quote a stale number)
- [ ] `S` projector test the deck at 1800 lumens, not on a 6K display
- [ ] `S` five-second test per slide on someone who has never heard of Vital; anything unexplainable gets cut
- [ ] `S` banned from the deck: "The Living Company" as opener · crates/serde/NDJSON · unverifiable Buzz/QM/jcode integration claims · the 82%-vertical-capital figure (unverified) · MIT NANDA's 95% as a blunt headline (contested/misquoted) · compliance readiness we have not audited · rounded-up buyer counts
- [ ] `S` if no design partners yet, **say zero** and show the plan to reach five

### Research backlog (things we're betting on but haven't proven)
- [ ] `L` does `cross_role` transfer predict production failure? (AFTER suggests specialisation is real)
- [ ] `M` routing precision vs cost curve — is 4 classes actually enough?
- [ ] `M` is token burn a **buyer** pain or only a power-user pain? A single heavy user reported more tokens in one month than the prior five years. If buyers don't feel it, cost bids are secondary and the wedge narrative shifts to provenance alone.
- [ ] `M` do PM/Growth leads actually care about provenance, or only about speed? If they buy speed and tolerate unverified drafts, Ship-to-Result may need to lead with cycle time and keep the ledger behind the scenes.
- [ ] `M` honeytask detection-rate thresholds — what's a realistic human ceiling?
- [ ] `M` curation cost per 100 claims across 5 tenants → is the Ledger maintainable unattended?
- [ ] `S` multi-agent coordination failure taxonomy (MAST-style) applied to our own traces
- [ ] `M` belief-revision behaviour when a VERIFIED claim is contradicted by a system of record
- [ ] `M` automation-bias measurement in our own approval logs

### Ops / DX
- [x] `M` CI: typecheck · test · lint · injection suite · **provenance guard** (vendored files isolated + SHA headers valid). Replaces the old byte-identical-to-QM check, which is meaningless now (`.github/workflows/ci.yml` + `npm run verify:provenance`; injection suite deferred to §3.1 with the content screen + model under test)
- [ ] `M` nightly: full instance boot + verify against a real model (deferred: needs deployed topology + model credentials)
- [x] `S` migration framework with a tested rollback (QM has `migrate-main.ts`; mirror it) (`src/core/migrations.ts`: named up/down journal, apply-once, explicit rollback — tested apply + rollback + unknown + not-applied on every run) (deferred: one additive-column migration exists with idempotent apply; rollback untested by design so far)
- [ ] `M` backup/restore + PITR for the Ledger (deferred: ops, needs Postgres)
- [x] `M` observability: tier-mix, cost/decision, stale-fact rate, override rate, refusal rate (`src/cli.ts status` reports ledger health + refusal rate + tier mix + open requests; cost/decision via `costOfDecision`)
- [ ] `S` on-call runbook incl. kill-switch procedure (partial: `killDrill` + `docs/deployment.md` cover the procedure; paging/rotations need a team)
- [ ] `M` versioning + upgrade path for the deployment layer (deferred: single-box dev only)

---

## Explicitly NOT doing (keep this list, it's the discipline)

- ❌ Our own chat / collaboration UI — **Buzz exists**
- ❌ Depending on QM as our runtime host (superseded — see §0.3)
- ❌ A chat UI — **Buzz exists**, and that one is still true
- ❌ Our own coding agent — **jcode exists**
- ❌ Autonomous external publishing, ever in year 1
- ❌ Idea → Company Blueprint → build-a-whole-company (later onboarding mode, not a wedge)
- ❌ Full World Model at launch (Phase 6, not Phase 1)
- ❌ Selling "AI company operating system" (no single buyer)
- ❌ Depending on QM as a host (we absorb from it instead — see §0.3)
- ❌ Vendoring QM's substrate or its heavy deps (that is a fork, not a startup)
- ❌ Per-seat pricing
- ❌ Any claim of learning that isn't a diff to a versioned artifact

---

## Immediately next — top 10, in order (all complete — historical record, work the V2 backlog above)

0. [x] `M` **P0: fix the error-frame crash.** FIXED 2026-09-09 (suite went 40/40 that day, 157/157 now).

**Then:**

1. [x] `S` **Fix the error-frame crash** (0.6) — done 2026-09-09, suite 40/40 green. *Nothing else here is trustworthy while one JSON line from a harness can kill the process* — that invariant now holds.
2. [x] `S` **Fix the router RNG** — done 2026-09-09 via `RouterConfig.rng`.
3. [x] `M` **Re-estimate Phase 0–2 against 0.5** — done 2026-09-09: **~18–23 wks solo (~4.5–6 mo), not ~8.** No §21.1 reconsider-QM trigger (substrate is weeks, not months).
4. [x] `M` **Start `src/vendor/qm/`** — done 2026-09-09: provenance-header template + `LICENSE-THIRD-PARTY.md` + narrowed `governor.ts` absorb (7 semantic tests, suite 47/47). Correction recorded: governor was never types-only.
5. [x] `M` Implement `recordDecision()` + Context Bundle freeze — done 2026-09-09 (suite 56/56; also pulled forward Phase 1 OUTCOME writer, supersede chains, believedAt, prediction due/void).
6. [x] `M` **Buzz→Slack fallback spike** (0.4) — done 2026-09-09: `TalkSurface` + HMAC surface, 2 tests, suite 60/60. Ledger is surface-agnostic.
7. [x] `M` Wire `escalations` so the 3/day founder cap actually **blocks** — done 2026-09-09: admission DENIES human-minute requests past `maxHumanEscalationsPerDay`, and admitted ones write named-human rows to `escalations`. (Also added the missing `expireStale` test alongside.)
8. [x] `M` Test hygiene: split `test/run.ts` into per-module files + a runner; concurrency test on `ledger_seq`; Postgres parity pass on the `json_extract` sites — done 2026-09-09 (suite 67/67; property/fuzz/adversarial/label/budget tests included).
9. [x] `M` Start `src/gov/` — done 2026-09-09: R/A/I matrix as data (`src/gov/raci.ts`) enforced OVER the newly absorbed `src/vendor/qm/ship-gate.ts` (narrowed: `contentPart` re-pointed at verbatim-vendored `objects.ts`; `crypto.ts` verbatim; `ApprovalGrantModes` verbatim). Matrix dominates, gates only hold lower. 7 tests, suite 74/74. Trust Ledger / honeytasks / kill switches remain Phase 3.3.
10. [x] `S` Write `README.md` + ADRs: 0001 Buzz-is-a-surface · **0002 absorb-from-QM-not-depend-on-it** (replaces the fork ADR) · 0003 Ledger-is-the-only-claim-store · 0004 messages-never-carry-work · 0005 agents-cannot-mint-facts — done 2026-09-09, plus `docs/dev-setup.md`, `docs/upstream.md` (real remote URLs verified), `SECURITY.md`, `docs/adr/`, `src/cli.ts` (status), MIT license field + `engines`, `.node-version`.
---

## Definition of done for the whole project

> A customer can point Vital at their own Buzz + Vital core + jcode deployment, watch it turn a real release into a launch that four teams collaborated on in rooms they already use, see every claim's provenance and every decision's exact basis replayed and signed, and be shown a falling `cost_per_good_decision` curve — **and at least one compiled procedure that survived a cross-role and cross-model transfer test, with the ones that didn't visibly quarantined rather than quietly deployed.**

---

## V2 backlog — production hardening + wedge completion (the only list that matters now)

Everything above is built as tested code. What remains needs things a repo
alone cannot provide. Ordered; each item names its unblocker.

### V2.1 Production surface (needs: VPS + credentials + a stranger to time the boot)
- [x] `L` live Postgres deployment path (`src/core/pg.ts`: `AsyncDb` driver with per-transaction checkout + savepoints, schema DERIVED from the one SCHEMA by translation — zero drift, `?`→`$n` outside literals, `DATABASE_URL` wiring via `openFromEnv`, `migratePostgres`, CI postgres service running `verify-instance` on every push; offline-tested: derivation, placeholders, dialects, wiring)
- [x] [!] `L` port every module from sync `Db` to `AsyncDb` — DONE 2026-09-09, one commit, green throughout. `src/core/db.ts` owns the single `AsyncDb` interface (`engine: 'sqlite'|'postgres'`); sqlite wraps its sync driver behind promises with a transaction lock (multi-statement bodies hold it whole; single statements stay lock-free/atomic); `migrate`/`nextSeq`/`stampVersion` unified and engine-aware (`PG_SCHEMA` derived in the same file, zero drift); `pg.ts` keeps driver + `openPostgres` + unified `openFromEnv`. 19 modules + CLI + seed-demo + all 20 test files ported; `throws` superseded by `rejects` in tests. Verified: typecheck 0, 181/181, lint/format/provenance clean, seed + `cli status/report` + `verify-instance` green. Live-PG verification stays with CI/deployment (unchanged).
- [ ] `M` live jcode sibling run: a real code change through the Ledger, zero ambient credentials (the §0.6 gate)
- [ ] `M` Buzz rooms binding: claim IDs ↔ signed Nostr events live (relay/SDK verify; HMAC fallback stays)
- [x] `M` approval surface: working Approve/Decline through the coordinator (`src/console/serve.ts` + `cli serve`; anonymous approval refused, transitions land in the ledger path, tested over real HTTP. Buzz-room rendering stays V2.1.)
- [x] `M` packet-filtering egress proxy enforcing `src/substrate/egress.ts` decisions (`src/substrate/egress-proxy.ts`: absolute-URI forwarding + CONNECT tunneling, denied closes before any upstream byte moves, every decision audited; origin-form refused. Caught in review: first draft built the server on `node:net`, so `request` events never fired — now on `node:http`, proven by the timeout it caused.)
- [ ] `S` stranger boots the topology from the README alone in < 30 min, timed

### V2.2 First loop with traffic (needs: 5 design partners at ≥2 releases/month)
- [ ] `L` ≥50 launches through Ship-to-Result; ship→launch-ready −50%, hours −40%, claim error <1%, zero regulatory, cost net-positive
- [ ] [!] `[G]` KILL CHECK at day 90: no delta on ≥3 of top 5 ⇒ the wedge is wrong, stop, re-read `idea.md` §21
- [ ] `M` 2,000 labelled routing tasks → precision gate → `controlRate` 0 → 0.05 → 0.25 with budget checks
- [ ] `M` honeytask human baseline → detection threshold → autonomy-freeze tuning
- [ ] `M` curation cost per 100 claims across tenants (kill-metric: ~5 min or the thesis is in trouble)

### V2.3 GTM + fundraising (needs: founder time, lawyers, designers)
- [ ] `M` name the wedge buyer; sign 5 design partners; baseline instrumented before pilots
- [ ] `M` pricing (platform fee + outcome-metered, never per-seat) + pilot→production conversion plan
- [ ] `M` Grok Bot diligence trial (the five unknowns stay "not documented" until checked)
- [ ] `M` competitive read + YC batch scan
- [ ] `M` 12-slide deck + 7-slide Demo Day cut + teaser + appendix pack + pre-flight claim audit (dogfood slide: test count = latest green run only)
- [ ] `L` SOC 2 Type I path; Article 14 evidence pack (overseer registry needs HR data + legal review); DPA + residency
- [ ] `S` decide open-source boundary precisely
