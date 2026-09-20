# Glossary

- **claim** — a typed, provenanced, owned assertion in the Ledger (kinds:
  OBSERVATION … OUTCOME). The only thing the company "knows".
- **scope** — a durable team/agent boundary (marketing, engineering, …)
  with its own memory, grants, and budget. A room agent *is* a scope.
- **room agent** — durable scope configuration (memory, files, keychain
  view, permissions, crons). Cheap to have many; it is config, not process.
- **worker** — an ephemeral process spawned by a request or cron; dies on
  completion. Must not accumulate.
- **card (Skill Card)** — a compiled procedure: intent, applicability
  predicates, steps, success tests, tool grants, validated tier/scope, and
  transfer-test evidence. Quarantined until proven.
- **bid** — the price of a REQUEST: dollars, tokens, human minutes,
  deadline, max rounds/hops, stop condition. Enforced at admission.
- **tier** — router execution class: REFLEX (rule) · WORKFLOW (promoted
  card) · MODEL (one reasoning pass) · HUMAN (human decides).
- **Context Bundle** — the exact claim IDs + versions + hashes live when a
  DECISION was made. Replayable basis.
- **provenance tier** — weakest-link trust of a claim's source:
  SYSTEM_OF_RECORD > MEASURED > PRIMARY > CORROBORATED > SINGLE_SOURCE >
  SELF_SERVED.
