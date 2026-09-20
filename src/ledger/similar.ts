// ADR 0006 — retrieval sidecar, not a claim store.
//
// This module is the *similarity* half of the ledger's recall story. It finds
// near-duplicates of an incoming statement among existing claims and — when
// the score clears the threshold — asks the ledger for a `similar_to` link and
// a provisional demotion of the cited claim. It never asserts truth: a
// similarity score is a search candidate, the ledger's status/provenance model
// is the truth. Losing or rebuilding this index loses nothing.
//
// Why shingles, not embeddings: zero dependencies (sovereign stack stays
// dependency-light), deterministic (same inputs → same verdict, replayable),
// and good enough for the near-duplicate problem (same event re-phrased by a
// feed). A future embedding-backed implementation can slot behind the same
// `findNearDuplicate` contract when a tenant wants hosted ANN.

import type { AsyncDb } from '../core/db.ts';

/** ADR 0006 threshold: ≥0.6 Jaccard over character 4-grams = near-duplicate. */
export const SIMILARITY_THRESHOLD = 0.6;
/** Compare against the most recent claims only — bounded cost per ingest. */
const CANDIDATE_WINDOW = 200;
const SHINGLE_SIZE = 4;
const MIN_TOKENS = 8;

export function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(text: string): Set<string> {
  const norm = normalizeForSimilarity(text);
  if (norm.length < SHINGLE_SIZE) return new Set();
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - SHINGLE_SIZE; i++) {
    out.add(norm.slice(i, i + SHINGLE_SIZE));
  }
  return out;
}

/** Jaccard similarity over character shingles, 0..1. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface NearDuplicateHit {
  claimId: string;
  statement: string;
  score: number;
}

export interface NearDuplicateVerdict {
  /** The best match above the threshold, or null when the statement is novel. */
  hit: NearDuplicateHit | null;
  /** Absolute statements (very short inputs) are never demoted. */
  skipped: 'too-short' | null;
}

/**
 * Compare a new statement against the most recent claims of the tenant.
 * Only the similarity computation lives here; callers decide what to do with
 * a hit (ADR 0006: demote the cited claim to provisional + link, never merge
 * or suppress).
 */
export async function findNearDuplicate(
  db: AsyncDb,
  tenant: string,
  statement: string,
  opts: { excludeIds?: string[]; threshold?: number } = {},
): Promise<NearDuplicateVerdict> {
  const norm = normalizeForSimilarity(statement);
  if (norm.split(' ').length < MIN_TOKENS) {
    return { hit: null, skipped: 'too-short' };
  }
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const rows = (await db
    .prepare(
      `SELECT id, statement FROM claims
       WHERE tenant = ? AND statement <> ?
       ORDER BY seq DESC LIMIT ${CANDIDATE_WINDOW}`,
    )
    .all(tenant, statement)) as { id: string; statement: string }[];
  const exclude = new Set(opts.excludeIds ?? []);
  let best: NearDuplicateHit | null = null;
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    const score = similarity(statement, r.statement);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { claimId: r.id, statement: r.statement, score };
    }
  }
  return { hit: best, skipped: null };
}
