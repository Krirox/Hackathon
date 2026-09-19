import { T, eq } from './helpers.ts';
import { fresh } from './helpers.ts';
import { withStatementCount } from '../src/core/db.ts';
import {
  createRequestStats,
  inRequestContext,
  memo,
  requestCacheStats,
  withRequestCache,
} from '../src/core/request-cache.ts';

console.log('\n\x1b[1mRequest cache — dedupe reads, never guess\x1b[0m');

T('the same read resolves once inside one request', async () => {
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { n: calls };
  };
  await withRequestCache(async () => {
    // Sequential.
    const a = await memo('k', produce);
    const b = await memo('k', produce);
    // Concurrent: two callers racing must share one read, not two.
    const [c, d] = await Promise.all([memo('k', produce), memo('k', produce)]);
    eq(calls, 1, 'producer ran once:');
    eq(a, b);
    eq(c, d);
    // Four asks for one key: the first is the miss, the other three are hits.
    eq(requestCacheStats()?.memoHits, 3, 'hits counted:');
    eq(requestCacheStats()?.memoMisses, 1, 'misses counted:');
    // Different key = different read: the cache keys, it does not blanket-cache.
    await memo('other', produce);
    eq(calls, 2, 'a distinct key is a distinct read:');
  });
});

T('a failed read is not remembered as the answer', async () => {
  let calls = 0;
  await withRequestCache(async () => {
    const bad = () =>
      new Promise((_res, rej) => {
        calls += 1;
        rej(new Error('boom'));
      });
    await memo('k', bad).catch(() => 'swallowed');
    // The rejection is dropped from the cache, so the next reader retries
    // instead of inheriting a failure it never caused.
    await memo('k', async () => {
      calls += 1;
      return 'ok';
    });
    eq(calls, 2, 'second attempt actually ran:');
  });
});

T('outside a request, memo degrades to a plain call', async () => {
  let calls = 0;
  eq(inRequestContext(), false, 'no context here:');
  await memo('k', async () => (calls += 1));
  await memo('k', async () => (calls += 1));
  eq(calls, 2, 'nothing is cached across requests:');
  eq(requestCacheStats(), null);
});

T('a request that can write does not memoize reads', async () => {
  // The read-write-read sequence is the one place a request cache can serve a
  // stale answer (an approve handler re-rendering what it just changed), so
  // mutating methods run with the cache inert rather than remembering the
  // pre-write read.
  let calls = 0;
  await withRequestCache(
    async () => {
      eq(inRequestContext(), false, 'context exists but memoization is off:');
      await memo('k', async () => (calls += 1));
      await memo('k', async () => (calls += 1));
      eq(requestCacheStats()?.memoized, false, 'flag visible to a caller:');
    },
    { memoize: false },
  );
  eq(calls, 2, 'both reads ran:');
});

T('statements are counted per request, and only inside one', async () => {
  // The meter is what makes render cost visible in production: `sql` on the
  // server's request log line. It must count real queries (through the db
  // decorator), must be scoped to one request, and must keep counting when
  // memoization is off — a mutating request still issues statements.
  const { db } = await fresh();
  const counted = withStatementCount(db);

  // Outside any request: still executes, nothing is counted (CLI, tests).
  await counted.prepare('SELECT 1 AS one').get();
  eq(requestCacheStats(), null, 'no request, no counters:');

  const stats = createRequestStats();
  await withRequestCache(
    async () => {
      await counted.prepare('SELECT 1 AS one').get();
      await counted.prepare('SELECT 1 AS one').get();
      await memo('unrelated', async () => 1);
      await memo('unrelated', async () => 1);
      eq(requestCacheStats()?.sql, 2, 'both statements counted:');
    },
    { stats },
  );
  // Readable after the request context has ended — which is the whole reason
  // the caller owns the object instead of asking the store at log time.
  eq(stats.sql, 2, 'counters survive the response:');
  eq(stats.memoHits, 1, 'memo hits ride along:');

  // A mutating request does not memoize, but it is still measured.
  const writeStats = createRequestStats();
  await withRequestCache(
    async () => {
      await counted.prepare('SELECT 1 AS one').get();
      await memo('k', async () => 1);
      await memo('k', async () => 1);
    },
    { memoize: false, stats: writeStats },
  );
  eq(writeStats.sql, 1, 'statements counted without memoization:');
  eq(writeStats.memoHits, 0, 'and nothing served from the cache:');
  await db.close();
});

T('the context does not leak into the next request', async () => {
  let calls = 0;
  await withRequestCache(async () => {
    await memo('k', async () => (calls += 1));
  });
  await withRequestCache(async () => {
    // A fresh entry map per request is what makes "no invalidation problem"
    // true rather than hopeful.
    eq(requestCacheStats()?.memoHits, 0, 'second request starts empty:');
    await memo('k', async () => (calls += 1));
  });
  eq(calls, 2, 'each request did its own read:');
});
