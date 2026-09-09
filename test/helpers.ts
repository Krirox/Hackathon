import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator, type SchedulerLimits } from '../src/coord/coordinator.ts';
import { CognitiveRouter, DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../src/router/router.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { FakeHarness } from './fake-harness.ts';

/**
 * Shared test harness. Each `*.test.ts` file registers tests through `T()`
 * as a side effect of being imported; `test/run.ts` imports the files and
 * then awaits `finish()`. Convention: no assertions outside `T()` blocks,
 * no cross-file state — every test builds its world with `fresh()`.
 */

let pass = 0;
let fail = 0;
const queue: Promise<unknown>[] = [];

export const T = (name: string, fn: () => void | Promise<void>) => {
  const go = () => {
    try {
      const maybe = fn();
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        return (maybe as Promise<void>).then(
          () => {
            console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
            pass++;
          },
          (e: unknown) => {
            console.log(`  \x1b[31m\u2717\x1b[0m ${name}\n      ${(e as Error).message}`);
            fail++;
          },
        );
      }
      console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
      pass++;
    } catch (e) {
      console.log(`  \x1b[31m\u2717\x1b[0m ${name}\n      ${(e as Error).message}`);
      fail++;
    }
    return Promise.resolve();
  };
  queue.push(go());
};

export const eq = (a: unknown, b: unknown, m = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

export const throws = (fn: () => void, code: string, m = '') => {
  try {
    fn();
  } catch (e) {
    if ((e as Error).message.includes(code)) return;
    throw new Error(`${m} expected ${code}, got ${(e as Error).message}`, { cause: e });
  }
  throw new Error(`${m} expected throw ${code}, nothing thrown`);
};

/**
 * Async twin of `throws`: the port made every fallible module function
 * async, so refusals now arrive as rejections. Awaiting a non-promise is
 * harmless, so this also covers the few guards that stayed synchronous.
 */
export const rejects = async (fn: () => Promise<unknown> | unknown, code: string, m = '') => {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message.includes(code)) return;
    throw new Error(`${m} expected ${code}, got ${(e as Error).message}`, { cause: e });
  }
  throw new Error(`${m} expected rejection ${code}, nothing thrown`);
};

export const TEN = 'acme';
export const NOW = '2026-09-09T12:00:00.000Z';
export const DAY_LATER = '2026-09-10T12:00:00.000Z';

export async function fresh(limits?: SchedulerLimits, routerOver?: Partial<RouterConfig>) {
  const db = openDb(':memory:');
  await migrate(db);
  return {
    db,
    ledger: createLedger(db),
    coord: createCoordinator(db, limits),
    // Isolated config per test: setControlRate/rng/registerTaskType must
    // never leak across tests through the shared default object.
    router: new CognitiveRouter(db, {
      ...DEFAULT_ROUTER_CONFIG,
      modelFloor: new Set(DEFAULT_ROUTER_CONFIG.modelFloor),
      humanOnly: new Set(DEFAULT_ROUTER_CONFIG.humanOnly),
      reflexRegistry: { ...DEFAULT_ROUTER_CONFIG.reflexRegistry },
      knownTaskTypes: new Set(DEFAULT_ROUTER_CONFIG.knownTaskTypes ?? []),
      tierBaselineOnly: { ...DEFAULT_ROUTER_CONFIG.tierBaselineOnly },
      ...routerOver,
    }),
    comp: new OrganizationalCompiler(db),
  };
}

export const sor = (uri = 'https://linear.net/bug/1') => ({
  sourceUri: uri,
  sourceTier: 'SYSTEM_OF_RECORD' as const,
  extractor: 'linear-sync',
  extractorVersion: '1.0.0',
  retrievedAt: NOW,
});

export const base = (over: Record<string, unknown> = {}) => ({
  tenant: TEN,
  messageClass: 'REQUEST' as const,
  originScope: 'marketing',
  targetScope: 'engineering',
  goal: 'can we match this claim?',
  claimRefs: ['clm_1'],
  deliverableSchema: 'feasibility.v1',
  onBehalfOf: 'human:priya',
  now: NOW,
  ...over,
});

export const rIn = (over: Record<string, unknown> = {}) => ({
  tenant: TEN,
  taskType: 'launch.copy.draft',
  scope: 'marketing',
  actionClass: 'ANALYZE' as const,
  importance: 0.4,
  reversible: true,
  now: NOW,
  ...over,
});

export async function seedTrace(
  comp: OrganizationalCompiler,
  db: ReturnType<typeof openDb>,
  id: string,
  outcome = 'SUCCESS',
  conf = 0.9,
) {
  await db
    .prepare(
      'INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      TEN,
      null,
      'marketing',
      'launch.copy.draft',
      'draft-launch-copy',
      '[]',
      'MODEL',
      outcome,
      '{}',
      null,
      conf,
      NOW,
    );
}

export const cardInput = (traceIds: string[]) => ({
  tenant: TEN,
  intent: 'draft-launch-copy',
  predicates: ['has_release_notes'],
  steps: ['read notes', 'draft'],
  tests: ['regression:copy.v1'],
  toolGrants: ['docs.read'],
  validatedAtTier: 'WORKFLOW' as const,
  originScope: 'marketing',
  originModels: ['claude'],
  scopeRoles: ['marketing'],
  owner: 'human:priya',
  traceIds,
  now: NOW,
});

export type GovLoop = import('../src/vendor/qm/governor.ts').GovernorLoop;
export type Vitals = import('../src/vendor/qm/governor.ts').LoopVitals;

export const govLoop = (over: Partial<GovLoop> = {}): GovLoop => ({
  health: 'healthy',
  createdAt: Date.parse(NOW) - 3_600_000,
  ...over,
});

export const vitals = (over: Partial<Vitals> = {}): Vitals => ({
  queue: { queued: 0, inProgress: 0, ready: 0, failed: 0 },
  openOutputs: 0,
  decidedOutputs: 0,
  returnedOutputs: 0,
  ...over,
});

/** A harness that lives for one assertion block. */
export async function withHarness<T>(fn: (h: FakeHarness) => Promise<T>): Promise<T> {
  const h = new FakeHarness();
  await h.listen();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

export async function finish(): Promise<never> {
  await Promise.all(queue);
  console.log('\n════════════════════════════════');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
}
