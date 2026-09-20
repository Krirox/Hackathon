# ADR 0006 — Retrieval stays relational; embeddings are a sidecar, never the claim store

Status: accepted · 2026-09-19

## Context

The ledger's promise is "a memory that doesn't lie" (idea.md §0/§23). Lying is
prevented by the typed-claim invariants (ADR 0005): provenance gates, human
curation, bi-temporal staleness, append-only supersede. None of that needs
vectors.

Retrieval today is exact-match only: `LIKE` queries over `subject`/`statement`
(`ledger.ts:566`), fingerprint dedupe in ingest (byte-equality), and alias
lookups over `subjects.aliases_json`. That is sound but has a recall gap: a
paraphrased duplicate of an existing claim passes `isNovel`, and a human
searching "pricing change" will not find "we updated our rate card" unless the
tokens overlap.

Vector stores (TencentDB Agent Memory, pgvector, sqlite-vec, a hosted RAG API)
solve that recall problem — but they are _similarity_ stores. Nothing about a
cosine score is a truth statement. The TDAM assessment (idea.md §29.1) shows the
failure mode precisely: memory layers conflate "similar" with "true", and their
own roadmap admits extracted memories go stale with only view-or-delete as a
correctness tool.

## Decision

1. **The Reality Ledger remains the only claim store** (ADR 0003 unchanged).
   Claims are never stored in, derived from, or "remembered" by a vector index.
2. **Embeddings may exist only as a derived sidecar index over the ledger**:
   - keyed by `claim_id` + `seq` (an embedding for a superseded claim version
     is dead weight, never truth);
   - rebuildable at any time from the append-only source of truth — losing the
     index loses nothing;
   - similarity results are **search candidates**, not answers: a hit surfaces
     the claim through the normal read path, where provenance, status (CANDIDATE
     vs VERIFIED vs STALE) and validity windows are shown from the ledger.
3. **Novelty/dedupe upgrade path**: a semantic near-duplicate detector may
   _demote_ an incoming signal to CANDIDATE with a `similar-to: <claim>` link
   for human review. It may never auto-merge claims or suppress ingestion on
   its own score — recall heuristics inform, ledger state decides.
4. **External vector stores (TencentDB etc.) are pluggable** behind the sidecar
   interface if a tenant wants hosted ANN, with the same two rules above. The
   default stays in-process/embedded so the sovereign-stack deployment claim
   ("your boxes") does not grow a hard third-party dependency.

## Consequences

- Recall improves without weakening any invariant: no path exists from a
  similarity score to a FACT, to autonomous action, or to claim deletion.
- The audit trail stays complete: what a person _saw_ is a claim read; what an
  index _guessed_ is not recorded as truth anywhere.
- If a vector store is compromised or drifts, the worst outcome is bad search
  results — never corrupted company reality. Rebuild from `claims` and the
  index is honest again.
- Cost discipline holds: embeddings are per-claim at write (or batch-built),
  not per-query model calls; the L0/L1/L2 funnel economics are unchanged.
