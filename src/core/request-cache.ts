// Request-scoped memoization.
//
// *Within one request*, the same read must not run twice. A console page renders
// KPIs, a rail, an activity feed and a shell header from overlapping queries, and
// without this one page view costs several identical round trips — the worst of
// them being `ScopeHealthEvaluator.evaluateAll()`, which evaluates every room in
// turn (that is ~14 room evaluations, each several queries) and was being asked
// for twice per shelled page.
//
// Request-scoped means no invalidation problem exists: the cache dies with the
// response, so there is nothing to stale. That claim is only true for a request
// that cannot write, which is why memoization is switched off for mutating
// methods — see `withRequestCache`.
//
// ---------------------------------------------------------------------------
// Why there is no conditional GET / ETag here
//
// There was: `sendConditional()` + `auditVersion()`, intended for the audit
// page. It was deleted rather than wired, because it could not be made both
// correct and cheap for the surface that wanted it:
//
//  * A validator ETag is only safe if its version is a function of the rendered
//    bytes. A shelled page renders page content *and* chrome (rail room status
//    from evaluateAll, shell metrics from requests/escalations, per-room recency
//    from buzz messages, nav counts). So the version has to cover the chrome.
//  * Covering it by computing it means paying for evaluateAll + shell metrics
//    (including a bounded 2000-row scan) + 14 recency queries — nearly all of
//    what a 304 would save. The saving shrinks to the HTML assembly.
//  * Covering it with a cheap fingerprint (MAX(seq), MAX(at), COUNT(*)) is not
//    provably complete: room config lives in `meta` with no monotonic column, so
//    a config change would serve a stale rail. A wrong 304 shows the user frozen
//    data with no error anywhere — strictly worse than a redundant 200.
//  * `cache-control: private, no-cache` means every navigation still revalidates,
//    so the only win was bytes, on pages that gzip to a few KB.
//
// The lesson is not "ETags are bad" — it is that this one had no surface where
// its version key is *provably* the content. If a JSON endpoint appears whose
// body is a pure function of one monotonic column (a tenant's audit sequence is
// the textbook case), conditional GET is correct there and cheap: the version
// costs one indexed lookup and nothing else renders from it. Re-add it with that
// consumer, not speculatively.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestStore {
  entries: Map<string, Promise<unknown>>;
  stats: RequestStats;
}

/**
 * Per-request counters. Owned by the caller that starts the scope (the console
 * server), so it can read them when the response is done — by which point the
 * async context that held them has ended and `requestCacheStats()` would
 * answer null.
 */
export interface RequestStats {
  /** Statements prepared while this request was in flight. */
  sql: number;
  /** Reads served from the request cache instead of the database. */
  memoHits: number;
  memoMisses: number;
  /** False for a request that may write — see the note on read-write-read. */
  memoized: boolean;
}

const store = new AsyncLocalStorage<RequestStore>();

/** A fresh counter set. Pass it to `withRequestCache` to read it afterwards. */
export function createRequestStats(): RequestStats {
  return { sql: 0, memoHits: 0, memoMisses: 0, memoized: true };
}

/**
 * Record one statement for the request in flight. Called by the database
 * decorator (`withStatementCount` in core/db.ts); a no-op outside a request, so
 * the CLI and the test suite pay one property read and nothing else.
 */
export function noteStatement(): void {
  const s = store.getStore();
  if (s) s.stats.sql += 1;
}

export interface RequestCacheOptions {
  /**
   * Set false on any request whose method can write.
   *
   * A read → write → read sequence in one request would otherwise serve the
   * stale first read to the second consumer: an approve handler that re-renders
   * the queue it just changed would show the pre-approval state. Reads-only
   * requests keep the guarantee, and no handler has to remember the rule.
   */
  memoize?: boolean;
  /**
   * Counter set to fill for this request. Omit it outside a server (tests, CLI)
   * and the counters are internal and discarded.
   */
  stats?: RequestStats;
}

/**
 * Run `fn` with a fresh per-request cache. Everything awaited inside shares it,
 * including code that never received the request object.
 */
export function withRequestCache<T>(fn: () => Promise<T>, opts: RequestCacheOptions = {}): Promise<T> {
  const stats = opts.stats ?? createRequestStats();
  stats.sql = 0;
  stats.memoHits = 0;
  stats.memoMisses = 0;
  stats.memoized = opts.memoize !== false;
  return store.run({ entries: new Map(), stats }, fn);
}

/** True when a memoizing request context is active (tests may call helpers directly). */
export function inRequestContext(): boolean {
  return store.getStore()?.stats.memoized === true;
}

/**
 * Deduplicate a read within the current request. The promise is cached, not the
 * value, so two concurrent callers share one query instead of racing.
 * Outside a memoizing request context this degrades to a plain call — never to
 * a stale read, and never to a leak.
 */
export async function memo<T>(key: string, produce: () => Promise<T> | T): Promise<T> {
  const s = store.getStore();
  if (!s || !s.stats.memoized) return produce();
  const hit = s.entries.get(key);
  if (hit) {
    s.stats.memoHits += 1;
    return hit as Promise<T>;
  }
  s.stats.memoMisses += 1;
  const p = Promise.resolve(produce());
  s.entries.set(key, p);
  // A failed read must not be remembered as the answer.
  p.catch(() => s.entries.delete(key));
  return p;
}

/** Counters for the request in flight (test hook; null outside one). */
export function requestCacheStats(): RequestStats | null {
  return store.getStore()?.stats ?? null;
}
