/**
 * Scratch (not shipped): add NOTICE traffic to an existing demo database.
 *
 * The Digest renders only NOTICEs, and `dev-seed.ts` originally created none,
 * so the page had nothing to show. Re-running the full seed would throw away
 * whatever the reviewer had already clicked through, so this appends through
 * the same `coord.submit` API instead of rebuilding.
 *
 *   tsx scratch/dev-notices.ts [--db var/dev-console.db]
 */
import { openDb } from '../src/core/db.ts';
import { createCoordinator, DEFAULT_LIMITS } from '../src/coord/coordinator.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};

const DB = flag('--db', 'var/dev-console.db');
const TENANT = 'acme';
const day = new Date().toISOString().slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`;

const db = openDb(DB);
const coord = createCoordinator(db, {
  ...DEFAULT_LIMITS,
  maxConcurrentPerScope: 20,
  maxDailyDollars: 500,
  maxDailyTokens: 50_000_000,
  maxHumanEscalationsPerDay: 50,
});

// Resolve the latency claim so the follow-on NOTICE cites real evidence rather
// than a hardcoded id that only exists in a particular database.
const latencyClaim = (await db
  .prepare('SELECT id FROM claims WHERE tenant = ? AND statement = ?')
  .get(TENANT, 'p95 latency is 240ms')) as { id: string } | undefined;

let n = 0;
// A NOTICE is still a proposal, so origin and target must differ — the
// coordinator rejects self-delegation. The target is merely who is being told.
async function notice(
  goal: string,
  originScope: string,
  targetScope: string,
  atTime: string,
  claimRefs: string[] = [],
): Promise<void> {
  const id = `rq_notice_${(n += 1).toString().padStart(2, '0')}`;
  const existing = await coord.get(TENANT, id);
  if (existing) {
    console.log(`  skip ${id} (already present)`);
    return;
  }
  const res = await coord.submit({
    tenant: TENANT,
    id,
    messageClass: 'NOTICE',
    originScope,
    targetScope,
    goal,
    claimRefs,
    deliverableSchema: 'feasibility.v1',
    onBehalfOf: 'human:owner',
    bid: { dollars: 0, humanMinutes: 0 },
    now: atTime,
  });
  console.log(
    `  ${id} ${res.state} · ${originScope}→${targetScope} · ${goal}${claimRefs.length ? ' (+evidence)' : ''}`,
  );
}

await notice('nightly Atlas sync finished with no drift', 'data', 'business', at('02:05'));
await notice('v24 flag ramped to 25% of traffic', 'infra', 'product', at('09:40'));
await notice('support backlog is clearing ahead of schedule', 'risk', 'product', at('11:20'));
// Same normalized goal and same origin scope, 2h40m apart — inside the 24h
// grouping window, so the Digest renders ONE group with "+1 more". They are not
// deduped by the coordinator because the second one cites evidence, which is
// part of the idempotency key.
await notice('p95 latency is within budget', 'infra', 'product', at('12:30'));
await notice('p95 latency is within budget', 'infra', 'product', at('15:10'), latencyClaim ? [latencyClaim.id] : []);

await db.close();
