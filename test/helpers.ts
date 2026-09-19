import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator, DEFAULT_LIMITS, type SchedulerLimits } from '../src/coord/coordinator.ts';
import { CognitiveRouter, DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../src/router/router.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { FakeHarness } from './fake-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The single machine-readable source of truth for the suite's size.
 * `scripts/refresh-docs.mjs` reads this to keep README/idea.md/TODO.md's
 * marked test-count claims honest; `docs:check` fails CI when they drift.
 * The PG lane (`TEST_PG_URL`) is a separate runner and must not clobber it.
 */
/**
 * Written only when the FULL suite runs (`run.ts` calls this). A single test
 * file, or the PG lane, must never rewrite it with a partial count.
 */
let statusWrites = false;
export function enableStatusWrites(): void {
  statusWrites = true;
}

export function writeStatusFile(passed: number, failed: number): void {
  if (!statusWrites) return;
  let head: string | null;
  try {
    head = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    head = null;
  }
  try {
    mkdirSync(join(ROOT, 'var'), { recursive: true });
    writeFileSync(
      join(ROOT, 'var', 'status.json'),
      JSON.stringify({ version: 1, tests: { passed, failed }, at: new Date().toISOString(), head }, null, 2) + '\n',
    );
  } catch {
    /* status is a side artifact: never fail the suite over it */
  }
}

/**
 * Shared test harness. Each `*.test.ts` file registers tests through `T()`
 * as a side effect of being imported; `test/run.ts` imports every file and
 * `node --test` runs them (see the `test` script). Convention: no assertions
 * outside `T()` blocks, no cross-file state — every test builds its world
 * with `fresh()`.
 */

let pass = 0;
let fail = 0;

/**
 * node:test-backed registration. Every test is bounded by a timeout: a hang
 * (the failure mode that already bit the jcode handshake) now fails the suite
 * instead of wedging CI forever. `node --test` supplies the reporter and the
 * exit code, so there is no hand-rolled pass/fail plumbing left.
 *
 * `opts.timeout` overrides the default 15s for legitimately slow tests
 * (browser journeys). Register through T rather than node:test directly so
 * var/status.json's test count covers every suite test — that count is the
 * machine-readable truth `docs:check` pins.
 */
export const T = (name: string, fn: () => void | Promise<void>, opts: { timeout?: number } = {}): void => {
  test(name, { timeout: opts.timeout ?? 15_000 }, async () => {
    try {
      await fn();
      pass += 1;
    } catch (e) {
      fail += 1;
      throw e;
    }
  });
};

// One status file per full run, never per test file.
after(() => writeStatusFile(pass, fail));

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

export async function fresh(limits?: Partial<SchedulerLimits>, routerOver?: Partial<RouterConfig>) {
  const db = openDb(':memory:');
  await migrate(db);
  const effectiveLimits = limits ? { ...DEFAULT_LIMITS, ...limits } : DEFAULT_LIMITS;
  return {
    db,
    ledger: createLedger(db),
    coord: createCoordinator(db, effectiveLimits),
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

/**
 * Team-VM root that lives for one assertion block. Worker dispatch with a
 * non-baseline adapter provisions real workspace directories; without this
 * they land in the production default (/var/vital/sandboxes, or a drive-root
 * `\var\` on Windows). Restores the previous value (possibly unset) after.
 */
export async function withVmRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'vital-vm-'));
  const prev = process.env.VITAL_VM_ROOT;
  process.env.VITAL_VM_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) delete process.env.VITAL_VM_ROOT;
    else process.env.VITAL_VM_ROOT = prev;
  }
}

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
