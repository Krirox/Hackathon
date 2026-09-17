# Security — threat model and current controls

## Threat model (what can actually hurt us)

1. **The agent acts as a person, with their credentials, and reads the open
   web.** A poisoned result is a persistent foothold — especially with
   durable sandboxes where installed tools stay installed.
2. **Two different injection problems.** (a) A harness signed into tools can
   be *prompt-injected* into mis-acting. (b) A world model feeding strategy
   can be *poisoned to steer the company* (fake pricing page, seeded repo,
   astroturfed thread). Only (b) has a competitor deliberately attacking it.
   Keep the defences scoped accordingly.
3. **Durable state as a foothold.** Anything persisted (sandbox files,
   memory graphs, ledger rows) outlives the turn that wrote it.
4. **Rubber-stamp oversight.** A human approving 200 items a day is a
   bottleneck with a signature, not a control.
5. **Silent degradation.** Compiled procedures rot across teams; routing
   drifts; facts go stale without anyone feeling it.

## Current controls (mapped to code, not wishes)

- **Epistemic guard** (`src/ledger/ledger.ts`, I1/I2): model output can
  never mint FACT/MEASUREMENT/OUTCOME; adversarially tested across all 11
  kinds. External text enters as quoted data with a provenance tier, never
  as ground truth.
- **Deterministic refusal gates** (`src/jcode/runner.ts`,
  `src/gov/raci.ts`): writes need human approval, which agents cannot
  self-give; denials are Ledger events. `ACT_IRREVERSIBLE` is human-command,
  always — no autonomy path exists in the matrix.
- **Blast-radius caps** (`src/coord/coordinator.ts`): hop limit 3, cycle
  detection, idempotency dedupe, per-request and daily budgets with loud
  budget death, 3/day human-escalation cap that BLOCKS.
- **Harness crash isolation** (`src/jcode/client.ts`): error frames reject,
  never kill the process; permission/cancel round-trips are drained before
  the socket closes.
- **Quarantine and demotion** (`src/compiler/compiler.ts`,
  `src/vendor/qm/governor.ts`): imported packs enter at QUARANTINE,
  transfer tests gate promotion, drift auto-demotes, loops quarantine on
  consecutive failures or undeclared ship actions.
- **Talk binding integrity** (`src/talk/surface.ts`): claim ↔ envelope
  binding is tamper-evident; tampering fails loudly.

## Explicitly not yet built (do not claim these)

Scoped sandbox with rebuild-from-manifest, egress proxy (capability
tokens, SSRF/metadata-IP blocklist — design copied, not yet implemented),
content screen (`securityScreen` shape), Integrity Gate poisoning suite,
prompt-injection CI suite, honeytasks, kill switches and their quarterly
drills, tenant isolation at storage/index level, PII classification and
erasure, SOC 2 path. See `TODO.md` §§0.5, 3.3, 6.3, 7, 8.

## Reporting

Security issues: contact the repo owner directly (no public issue). Include
the claim/decision/request IDs if the report concerns ledger integrity —
replayability cuts both ways.
