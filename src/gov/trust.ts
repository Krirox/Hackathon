import { randomUUID } from 'node:crypto';
import { memo } from '../core/request-cache.ts';
import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter } from '../substrate/harness.ts';
import {
  authorize,
  REVERSIBLE_CLEAN_THRESHOLD,
  type AuthorizeInput,
  type AuthorizeResult,
  type TrustState,
} from './raci.ts';
import { enqueueOutbox } from '../substrate/scheduler.ts';

/**
 * Governance plane, part 2 (TODO §3.3): Trust Ledger, honeytasks, kill switches.
 *
 * `trust_scores` and `honeytasks` tables already exist; this is the code.
 * Demotion is automatic and immediate (a honeytask miss freezes the
 * scope×class on the spot — no human meeting required); promotion is slow
 * (200 clean instances). Kill switches sit above everything: tenant, scope,
 * or action-class level, drilled, with every engagement audited.
 *
 * `guardedAuthorize()` is the single call sites use: kill check → trust
 * load → matrix. The matrix itself stays pure (no AsyncDb inside `raci.ts`).
 */

export class TrustError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[trust:${code}] ${message}`);
  }
}

async function audit(
  db: AsyncDb,
  tenant: string,
  actor: string,
  action: string,
  target: string,
  detail: string,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, actor, action, target, detail, now);
}

/** Read the Trust Ledger into the shape `authorize()` consumes. */
export async function trustFor(db: AsyncDb, tenant: string, scope: string, actionClass: string): Promise<TrustState> {
  const r = (await db
    .prepare(
      'SELECT clean, frozen, granted, override_rate, total FROM trust_scores WHERE tenant = ? AND scope = ? AND action_class = ?',
    )
    .get(tenant, scope, actionClass)) as
    { clean: number; frozen: number; granted?: number; override_rate?: number; total?: number } | undefined;
  return {
    cleanInstances: Number(r?.clean ?? 0),
    frozen: Number(r?.frozen ?? 0) === 1,
    granted: Number(r?.granted ?? 0) === 1,
    overrideRate: r?.override_rate !== undefined && r?.override_rate !== null ? Number(r.override_rate) : 0,
    total: Number(r?.total ?? 0),
  };
}

export interface TrustOutcome {
  /** A clean autonomous/approved execution. */
  clean: boolean;
  /** Human overrode the agent's call. */
  override?: boolean;
  /** A honeytask went undetected — freezes immediately. */
  honeyMiss?: boolean;
  now?: string;
}

/** Record an outcome. Honey misses freeze on the spot; overrides reset the streak. */
export async function recordTrustOutcome(
  db: AsyncDb,
  tenant: string,
  scope: string,
  actionClass: string,
  outcome: TrustOutcome,
): Promise<void> {
  const now = outcome.now ?? new Date().toISOString();
  // Every counter move is ONE UPDATE computed from the row's own values —
  // never read-modify-write. Concurrent outcomes each apply under the row
  // lock, so parallel clean reports all count and parallel overrides cannot
  // resurrect a streak the other just reset.
  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO trust_scores (tenant, scope, action_class, clean, total, overrides, override_rate, honey_misses, granted, frozen, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, scope, action_class) DO NOTHING`,
      )
      .run(tenant, scope, actionClass, 0, 0, 0, 0, 0, 0, 0, now);
    if (outcome.honeyMiss === true) {
      await db
        .prepare(
          `UPDATE trust_scores
             SET honey_misses = honey_misses + 1,
                 frozen = 1,
                 clean = 0,
                 granted = 0,
                 total = total + 1,
                 override_rate = (overrides * 1.0) / (total + 1),
                 updated_at = ?
           WHERE tenant = ? AND scope = ? AND action_class = ?`,
        )
        .run(now, tenant, scope, actionClass);
      await audit(
        db,
        tenant,
        'trust',
        'TRUST_FROZEN',
        `${scope}/${actionClass}`,
        'honeytask miss — automatic freeze',
        now,
      );
      // FLOW-022: the operator is notified of every automation self-halt.
      // The notification persists as an AUTOMATION_SELF_HALT audit row in
      // the same transaction — the audit log is the delivery fallback.
      await recordSelfHalt(db, tenant, scope, actionClass, 'honeytask miss — automatic freeze', 'trust', [], now);
      // Also persist a durable outbox row so the outbox worker can deliver
      // the notification with retries, backoff, and lease-based restart recovery.
      await enqueueOutbox(
        db,
        tenant,
        'automation-self-halt',
        {
          scope,
          actionClass,
          reason: outcome.honeyMiss ? 'honeytask miss — automatic freeze' : 'automation self-halt',
          affected: [],
        },
        { now },
      );
      return;
    }
    if (outcome.override === true || !outcome.clean) {
      await db
        .prepare(
          `UPDATE trust_scores
             SET overrides = overrides + 1,
                 clean = 0,
                 granted = 0,
                 total = total + 1,
                 override_rate = ((overrides + 1) * 1.0) / (total + 1),
                 updated_at = ?
           WHERE tenant = ? AND scope = ? AND action_class = ?`,
        )
        .run(now, tenant, scope, actionClass);
      return;
    }
    // The grant flag derives from the post-increment value inside the same
    // statement: reaching the threshold and counting the instance are one
    // atomic move, never two writers racing past each other.
    await db
      .prepare(
        `UPDATE trust_scores
           SET clean = clean + 1,
               total = total + 1,
               granted = CASE WHEN clean + 1 >= ? AND frozen = 0 THEN 1 ELSE granted END,
               override_rate = (overrides * 1.0) / (total + 1),
               updated_at = ?
         WHERE tenant = ? AND scope = ? AND action_class = ?`,
      )
      .run(REVERSIBLE_CLEAN_THRESHOLD, now, tenant, scope, actionClass);
  });
}

export async function clearFreeze(
  db: AsyncDb,
  tenant: string,
  scope: string,
  actionClass: string,
  by: string,
  now?: string,
): Promise<void> {
  const at = now ?? new Date().toISOString();
  await db
    .prepare(
      'UPDATE trust_scores SET frozen = 0, clean = 0, granted = 0, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
    )
    .run(at, tenant, scope, actionClass);
  await audit(
    db,
    tenant,
    by,
    'TRUST_UNFROZEN',
    `${scope}/${actionClass}`,
    'manual review cleared the freeze; streak restarts at 0',
    at,
  );
}

// --------------------------------------------------------------- honeytasks ----

/** Seed a known-good (isBad=false) or known-bad item into the approval stream. */
export async function injectHoneytask(
  db: AsyncDb,
  tenant: string,
  scope: string,
  isBad: boolean,
  now?: string,
  id?: string,
): Promise<string> {
  const at = now ?? new Date().toISOString();
  const hid = id ?? `hny_${crypto.randomUUID()}`;
  await db
    .prepare(
      'INSERT INTO honeytasks (id, tenant, scope, is_bad, injected, detected, acted_on, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(hid, tenant, scope, isBad ? 1 : 0, 1, null, null, at, null);
  return hid;
}

/** Resolve what the human did with it. A missed bad item freezes trust on the spot. */
export async function resolveHoneytask(
  db: AsyncDb,
  tenant: string,
  id: string,
  outcome: { detected: boolean; actedOn: boolean; actionClass: string; scope: string; now?: string },
): Promise<void> {
  const at = outcome.now ?? new Date().toISOString();
  const row = (await db.prepare('SELECT is_bad FROM honeytasks WHERE id = ? AND tenant = ?').get(id, tenant)) as
    { is_bad: number } | undefined;
  if (!row) throw new TrustError('UNKNOWN_HONEYTASK', `no honeytask ${id}`);
  await db
    .prepare('UPDATE honeytasks SET detected = ?, acted_on = ?, resolved_at = ? WHERE id = ? AND tenant = ?')
    .run(outcome.detected ? 1 : 0, outcome.actedOn ? 1 : 0, at, id, tenant);
  if (Number(row.is_bad) === 1 && !outcome.detected) {
    await recordTrustOutcome(db, tenant, outcome.scope, outcome.actionClass, {
      clean: false,
      honeyMiss: true,
      now: at,
    });
  }
}

export async function honeytaskDetectionRate(
  db: AsyncDb,
  tenant: string,
  scope?: string,
): Promise<{ total: number; detected: number; rate: number }> {
  const sql =
    scope !== undefined
      ? 'SELECT COUNT(*) AS n, SUM(detected) AS d FROM honeytasks WHERE tenant = ? AND scope = ? AND resolved_at IS NOT NULL'
      : 'SELECT COUNT(*) AS n, SUM(detected) AS d FROM honeytasks WHERE tenant = ? AND resolved_at IS NOT NULL';
  const args = scope !== undefined ? [tenant, scope] : [tenant];
  const r = (await db.prepare(sql).get(...args)) as { n: number; d: number | null };
  const total = Number(r.n);
  const detected = Number(r.d ?? 0);
  return { total, detected, rate: total === 0 ? 0 : detected / total };
}

// ------------------------------------------------------------ kill switches ----

export interface KillScope {
  scope: string | '*';
  actionClass: string | '*';
}

const killKey = (tenant: string, scope: string, actionClass: string): string =>
  `kill:${tenant}:${scope}:${actionClass}`;

/** Engage a kill switch at tenant (scope=*, class=*), scope, or action-class level. Audited. */
export async function setKill(
  db: AsyncDb,
  tenant: string,
  kill: KillScope,
  by: string,
  now?: string,
  detail?: StopDetail,
): Promise<void> {
  const at = now ?? new Date().toISOString();
  const payload: StopPayload = { by, at };
  if (detail?.reason !== undefined) payload.reason = detail.reason;
  if (detail?.recoveryRequires !== undefined) payload.recoveryRequires = detail.recoveryRequires;
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(killKey(tenant, kill.scope, kill.actionClass), JSON.stringify(payload));
  await audit(db, tenant, by, 'KILL_ENGAGED', `${kill.scope}/${kill.actionClass}`, JSON.stringify(payload), at);
}

export async function clearKill(db: AsyncDb, tenant: string, kill: KillScope, by: string, now?: string): Promise<void> {
  const at = now ?? new Date().toISOString();
  await db.prepare('DELETE FROM meta WHERE key = ?').run(killKey(tenant, kill.scope, kill.actionClass));
  await audit(db, tenant, by, 'KILL_CLEARED', `${kill.scope}/${kill.actionClass}`, `resumed at ${at}`, at);
}

/** Narrowest match wins the check: exact scope+class, then wildcards. */
export async function checkKill(db: AsyncDb, tenant: string, scope: string, actionClass: string): Promise<boolean> {
  for (const [s, c] of [
    [scope, actionClass],
    [scope, '*'],
    ['*', actionClass],
    ['*', '*'],
  ] as const) {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(killKey(tenant, s, c))) as
      { value: string } | undefined;
    if (r) return true;
  }
  return false;
}

export interface KillDrillOptions {
  now?: string;
  executor?: {
    coord: Coordinator;
    adapter: HarnessAdapter;
    scope?: string;
  };
}

export interface KillDrill {
  mode: 'policy-only' | 'policy-and-executor';
  levels: string[];
  checks: { level: string; halted: boolean; isolated: boolean; released: boolean }[];
  executorHalt?: { halted: boolean; verified: boolean; adapter: string; detail?: string };
  allHalted: boolean;
  elapsedMs: number;
}

export async function verifyExecutorHalt(
  db: AsyncDb,
  coord: Coordinator,
  adapter: HarnessAdapter,
  tenant: string,
  scope = 'drill-executor-scope',
  _actionClass = 'ACT_REVERSIBLE',
  now?: string,
): Promise<{ halted: boolean; verified: boolean; adapter: string; detail?: string }> {
  const at = now ?? new Date().toISOString();
  const originScope = `${scope}-origin`;
  const claimId = `clm_drill_${randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO claims (id, tenant, subject, kind, statement, confidence, source_uri, source_tier, extractor, extractor_ver, retrieved_at, observed_at, valid_from, status, owner, scope, provisional, created_at, seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      claimId,
      tenant,
      'drill',
      'OBSERVATION',
      'kill drill grounding claim',
      1,
      'drill://grounding',
      'PRIMARY_SOURCE',
      'drill',
      '1.0',
      at,
      at,
      at,
      'ACCEPTED',
      'drill:system',
      scope,
      0,
      at,
      1,
    );

  const proposal = await coord.submit({
    tenant,
    messageClass: 'REQUEST',
    originScope,
    targetScope: scope,
    goal: 'verify live executor halt during kill drill',
    deliverableSchema: 'drill.verify',
    claimRefs: [claimId],
    bid: { dollars: 1, tokens: 100, humanMinutes: 5, maxRounds: 1 },
    onBehalfOf: 'drill:system',
  });
  if (!proposal.admitted) {
    return {
      halted: false,
      verified: false,
      adapter: adapter.name,
      detail: `failed to admit drill request: ${proposal.reason}`,
    };
  }
  const requestId = proposal.request.id;
  await setKill(db, tenant, { scope, actionClass: '*' }, 'drill:system', at);
  try {
    const outcome = await adapter.run(tenant, requestId, {
      command: 'verify halt',
      claimRefs: [claimId],
      onBehalfOf: 'drill:system',
      maxDollars: 1,
      maxTokens: 100,
      intent: 'test:kill',
      tier: 'MODEL',
    });
    const halted = outcome.status === 'DENIED' || outcome.status === 'FAILED';
    await audit(
      db,
      tenant,
      'drill:system',
      'EXECUTOR_KILL_DRILL',
      `${scope}/*`,
      JSON.stringify({ adapter: adapter.name, halted, status: outcome.status }),
      at,
    );
    return { halted, verified: true, adapter: adapter.name, detail: `executor halt outcome: ${outcome.status}` };
  } finally {
    await clearKill(db, tenant, { scope, actionClass: '*' }, 'drill:system', at);
  }
}

export async function killDrill(
  db: AsyncDb,
  tenant: string,
  by: string,
  nowOrOpts?: string | KillDrillOptions,
  maybeOpts?: KillDrillOptions,
): Promise<KillDrill> {
  const opts: KillDrillOptions = typeof nowOrOpts === 'object' && nowOrOpts !== null ? nowOrOpts : (maybeOpts ?? {});
  const at = typeof nowOrOpts === 'string' ? nowOrOpts : (opts.now ?? new Date().toISOString());
  const t0 = Date.now();
  const drillTenant = `drill-${randomUUID()}`;
  const levels: KillScope[] = [
    { scope: '*', actionClass: '*' },
    { scope: 'engineering', actionClass: '*' },
    { scope: '*', actionClass: 'ACT_REVERSIBLE' },
    { scope: 'engineering', actionClass: 'ACT_REVERSIBLE' },
  ];
  const probes = [
    { scope: 'engineering', actionClass: 'ACT_REVERSIBLE' },
    { scope: 'engineering', actionClass: 'READ' },
    { scope: 'marketing', actionClass: 'ACT_REVERSIBLE' },
    { scope: 'marketing', actionClass: 'READ' },
  ];
  return db.transaction(async () => {
    const checks: KillDrill['checks'] = [];
    for (const level of levels) {
      const key = killKey(drillTenant, level.scope, level.actionClass);
      await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify({ by, at }));
      let halted = true;
      let isolated = true;
      for (const probe of probes) {
        const expected =
          (level.scope === '*' || level.scope === probe.scope) &&
          (level.actionClass === '*' || level.actionClass === probe.actionClass);
        const actual = await checkKill(db, drillTenant, probe.scope, probe.actionClass);
        if (expected) halted = halted && actual;
        else isolated = isolated && !actual;
      }
      isolated = isolated && !(await checkKill(db, `${drillTenant}-other`, 'engineering', 'ACT_REVERSIBLE'));
      await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      const released = !(await checkKill(db, drillTenant, 'engineering', 'ACT_REVERSIBLE'));
      checks.push({ level: `${level.scope}/${level.actionClass}`, halted, isolated, released });
    }

    let executorHalt: { halted: boolean; verified: boolean; adapter: string; detail?: string } | undefined;
    if (opts.executor) {
      const { coord, adapter, scope } = opts.executor;
      executorHalt = await verifyExecutorHalt(
        db,
        coord,
        adapter,
        drillTenant,
        scope ?? 'drill-executor',
        'ACT_REVERSIBLE',
        at,
      );
    }

    const mode = opts.executor ? 'policy-and-executor' : 'policy-only';
    const allHalted =
      checks.every((check) => check.halted && check.isolated && check.released) &&
      (executorHalt ? executorHalt.halted : true);
    const elapsedMs = Date.now() - t0;
    await audit(
      db,
      tenant,
      by,
      'KILL_DRILL',
      tenant,
      JSON.stringify({ mode, allHalted, elapsedMs, checks, ...(executorHalt ? { executorHalt } : {}) }),
      at,
    );
    return {
      mode,
      levels: checks.map((check) => check.level),
      checks,
      ...(executorHalt ? { executorHalt } : {}),
      allHalted,
      elapsedMs,
    };
  });
}

// ------------------------------------------------------------------ composed ----

export type GuardedInput = AuthorizeInput & { tenant: string };

/** The single call sites use: kill check → trust load → matrix. */
export async function guardedAuthorize(db: AsyncDb, input: GuardedInput): Promise<AuthorizeResult> {
  if (await checkKill(db, input.tenant, input.scope, input.actionClass)) {
    return { verdict: 'denied', reasons: [`kill switch engaged for ${input.scope}/${input.actionClass} — halted`] };
  }
  const trust = input.trust ?? (await trustFor(db, input.tenant, input.scope, input.actionClass));
  return authorize({ ...input, trust });
}

/** Freeze a scope×class from a monitor (detection-rate floor, sampling alarm). Streak restarts at 0. */
export async function setFreeze(
  db: AsyncDb,
  tenant: string,
  scope: string,
  actionClass: string,
  reason: string,
  by: string,
  now?: string,
): Promise<void> {
  const at = now ?? new Date().toISOString();
  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO trust_scores (tenant, scope, action_class, clean, total, overrides, override_rate, honey_misses, granted, frozen, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, scope, action_class) DO NOTHING`,
      )
      .run(tenant, scope, actionClass, 0, 0, 0, 0, 0, 0, 0, at);
    await db
      .prepare(
        'UPDATE trust_scores SET frozen = 1, clean = 0, granted = 0, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
      )
      .run(at, tenant, scope, actionClass);
    await audit(db, tenant, by, 'TRUST_FROZEN', `${scope}/${actionClass}`, reason, at);
    await recordSelfHalt(db, tenant, scope, actionClass, reason, by, [], at);
  });
}

/**
 * Autonomy freeze (TODO §3.3): when human bad-item detection drops below
 * threshold, autonomy freezes until a human clears it. Returns whether the
 * freeze engaged — callers feed it the honeytask/sampling detection rate.
 */
export async function evaluateFreeze(
  db: AsyncDb,
  tenant: string,
  scope: string,
  actionClass: string,
  detectionRate: number,
  threshold: number,
  by: string,
  now?: string,
): Promise<{ frozen: boolean; reason: string }> {
  if (detectionRate >= threshold) {
    return { frozen: false, reason: `detection ${detectionRate} ≥ ${threshold} — oversight is alive` };
  }
  const reason = `human detection ${detectionRate} < ${threshold} — autonomy frozen until review`;
  await setFreeze(db, tenant, scope, actionClass, reason, by, now);
  return { frozen: true, reason };
}

export interface StopDetail {
  reason?: string;
  recoveryRequires?: string;
}

interface StopPayload {
  by: string;
  at: string;
  reason?: string;
  recoveryRequires?: string;
}

export interface StopRecord {
  scope: string;
  actionClass: string;
  by: string;
  at: string;
  reason: string | null;
  recoveryRequires: string | null;
}

export interface StopDisplay extends StopRecord {
  affected: string;
  recovery: string;
}

export interface HaltEffect {
  effect: string;
  detail: string;
}

export interface HaltEffectMatrix {
  scope: string;
  actionClass: string;
  inFlight: HaltEffect;
  queued: HaltEffect;
  external: HaltEffect;
}

export interface SelfHaltNotification {
  kind: 'self-halt';
  tenant: string;
  scope: string;
  actionClass: string;
  reason: string;
  detectedAt: string;
  affected: string[];
  recovery: string;
  fallback: string;
}

export interface HaltEvidence {
  drills: { action: string; actor: string; target: string; detail: string | null; at: string }[];
  real: { action: string; actor: string; target: string; detail: string | null; at: string }[];
}

export interface RuntimeHaltDrill {
  mode: 'runtime-halt';
  scope: string;
  actionClass: string;
  held: boolean;
  released: boolean;
  /**
   * FLOW-022: while the drill stop was held, the real authorization path
   * refused new work (guardedAuthorize → denied). A runtime drill that
   * cannot demonstrate this proves nothing about the halt path.
   */
  authorizationHeld: boolean;
  /** What happens to in-flight, queued, and external work under this stop. */
  effects: HaltEffectMatrix;
  at: string;
}

/**
 * FLOW-022: the two drill modes, in operator words. Policy-only checks
 * kill-switch matching on an isolated drill tenant and never engages a
 * real stop; runtime-halt briefly engages a real stop on the target scope,
 * verifies the halt path, then releases. Audit evidence is labeled by
 * mode (`KILL_DRILL` vs `RUNTIME_HALT_DRILL`) so a passing policy check
 * can never masquerade as a proven halt.
 */
export function describeDrillMode(mode: 'policy-only' | 'runtime-halt'): {
  touchesRuntime: boolean;
  evidence: string;
  summary: string;
} {
  if (mode === 'policy-only') {
    return {
      touchesRuntime: false,
      evidence: 'KILL_DRILL',
      summary:
        'policy-only drill: checks kill-switch matching on an isolated drill tenant; ' +
        'never engages a real stop and never touches queued or in-flight work',
    };
  }
  return {
    touchesRuntime: true,
    evidence: 'RUNTIME_HALT_DRILL',
    summary:
      'runtime halt drill: engages a real stop on the target scope, verifies new ' +
      'authorizations are denied and queued/in-flight effects, then releases immediately ' +
      'with audited evidence',
  };
}

function parseStopRow(tenant: string, key: string, value: string): StopRecord | null {
  const prefix = `kill:${tenant}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length).split(':');
  if (rest.length !== 2 || !rest[0] || !rest[1]) return null;
  let payload: StopPayload;
  try {
    payload = JSON.parse(value) as StopPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.by !== 'string' || typeof payload.at !== 'string') return null;
  return {
    scope: rest[0] as string,
    actionClass: rest[1] as string,
    by: payload.by,
    at: payload.at,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
    recoveryRequires: typeof payload.recoveryRequires === 'string' ? payload.recoveryRequires : null,
  };
}

/**
 * Every active stop for the tenant.
 *
 * Memoized per request: this is a tenant-wide list, but it was being read once
 * per room evaluated, so a page that rolls up 13 rooms issued the same scan 13
 * times. The entry dies with the response, and memoization is off for requests
 * that can write, so a stop engaged and then read back in one POST still sees
 * its own write.
 */
export function listStops(db: AsyncDb, tenant: string): Promise<StopRecord[]> {
  return memo(`gov:stops:${tenant}`, async () => {
    const rows = (await db
      .prepare('SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key')
      .all(`kill:${tenant}:%`)) as { key: string; value: string }[];
    const out: StopRecord[] = [];
    for (const row of rows) {
      const parsed = parseStopRow(tenant, String(row.key), String(row.value));
      if (parsed) out.push(parsed);
    }
    return out;
  });
}

export async function describeStops(db: AsyncDb, tenant: string): Promise<StopDisplay[]> {
  const stops = await listStops(db, tenant);
  return stops.map((stop) => ({
    ...stop,
    affected:
      `scope "${stop.scope}" × class "${stop.actionClass}" — new authorizations denied; ` +
      `in-flight work is not force-terminated; queued work is held at admission`,
    recovery:
      stop.recoveryRequires ??
      'authorized recovery with a recorded reason via recoverStop (audited; a restart does not clear this stop)',
  }));
}

export async function recoveryRequired(db: AsyncDb, tenant: string): Promise<StopRecord[]> {
  return listStops(db, tenant);
}

export async function recoverStop(
  db: AsyncDb,
  tenant: string,
  kill: KillScope,
  by: string,
  evidence: { reason: string; approvedBy?: string; now?: string },
): Promise<StopRecord> {
  if (!evidence.reason) throw new TrustError('RECOVERY_REASON_REQUIRED', 'recovery needs a recorded reason');
  const stops = await listStops(db, tenant);
  const active = stops.find((stop) => stop.scope === kill.scope && stop.actionClass === kill.actionClass);
  if (!active) throw new TrustError('NO_ACTIVE_STOP', `no active stop for ${kill.scope}/${kill.actionClass}`);
  const at = evidence.now ?? new Date().toISOString();
  await db.prepare('DELETE FROM meta WHERE key = ?').run(killKey(tenant, kill.scope, kill.actionClass));
  await audit(
    db,
    tenant,
    by,
    'KILL_RECOVERED',
    `${kill.scope}/${kill.actionClass}`,
    JSON.stringify({ reason: evidence.reason, approvedBy: evidence.approvedBy ?? null, recoveredAt: at }),
    at,
  );
  return active;
}

export function haltEffects(scope: string, actionClass: string): HaltEffectMatrix {
  return {
    scope,
    actionClass,
    inFlight: {
      effect: 'not-force-terminated',
      detail:
        'the stop flag is enforced at authorization boundaries; work already executing is not killed by the flag and must be investigated before recovery',
    },
    queued: {
      effect: 'held-at-admission',
      detail: 'queued work stays queued; new admission and authorization are denied while the stop is active',
    },
    external: {
      effect: 'human-command-only',
      detail:
        'external irreversible operations never start autonomously; reversible external work started before the halt needs explicit compensation review',
    },
  };
}

export function buildSelfHaltNotification(input: {
  tenant: string;
  scope: string;
  actionClass: string;
  reason: string;
  detectedAt: string;
  affected?: string[];
  recovery?: string;
}): SelfHaltNotification {
  return {
    kind: 'self-halt',
    tenant: input.tenant,
    scope: input.scope,
    actionClass: input.actionClass,
    reason: input.reason,
    detectedAt: input.detectedAt,
    affected: input.affected ?? [],
    recovery: input.recovery ?? 'authorized recovery with a recorded reason via recoverStop',
    fallback:
      'audit-log AUTOMATION_SELF_HALT row — the notification payload is always persisted even if delivery fails',
  };
}

export async function recordSelfHalt(
  db: AsyncDb,
  tenant: string,
  scope: string,
  actionClass: string,
  reason: string,
  by: string,
  affected: string[],
  now?: string,
): Promise<SelfHaltNotification> {
  const at = now ?? new Date().toISOString();
  const notification = buildSelfHaltNotification({ tenant, scope, actionClass, reason, detectedAt: at, affected });
  await audit(
    db,
    tenant,
    by,
    'AUTOMATION_SELF_HALT',
    `${scope}/${actionClass}`,
    JSON.stringify({ reason, affected, detectedAt: at }),
    at,
  );
  // Persist a durable outbox row so the outbox worker can deliver
  // the notification with retries, backoff, and lease-based restart recovery.
  await enqueueOutbox(
    db,
    tenant,
    'automation-self-halt',
    {
      scope,
      actionClass,
      reason,
      detectedAt: at,
      affected,
    },
    { now: at },
  );
  return notification;
}

export async function listHaltEvidence(db: AsyncDb, tenant: string): Promise<HaltEvidence> {
  const rows = (await db
    .prepare(
      `SELECT action, actor, target, detail, at FROM audit_log
        WHERE tenant = ? AND action IN
          ('KILL_DRILL','RUNTIME_HALT_DRILL','KILL_ENGAGED','KILL_CLEARED','KILL_RECOVERED','AUTOMATION_SELF_HALT','TRUST_FROZEN')
        ORDER BY seq`,
    )
    .all(tenant)) as { action: string; actor: string; target: string; detail: string | null; at: string }[];
  const drills: HaltEvidence['drills'] = [];
  const real: HaltEvidence['real'] = [];
  for (const row of rows) {
    const entry = {
      action: String(row.action),
      actor: String(row.actor),
      target: String(row.target),
      detail: row.detail == null ? null : String(row.detail),
      at: String(row.at),
    };
    if (entry.action === 'KILL_DRILL' || entry.action === 'RUNTIME_HALT_DRILL') drills.push(entry);
    else real.push(entry);
  }
  return { drills, real };
}

export async function runtimeHaltDrill(
  db: AsyncDb,
  tenant: string,
  kill: KillScope,
  by: string,
  now?: string,
): Promise<RuntimeHaltDrill> {
  const at = now ?? new Date().toISOString();
  const key = killKey(tenant, kill.scope, kill.actionClass);
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify({ by, at, reason: 'runtime halt drill — real engagement, released immediately' }));
  const probeScope = kill.scope === '*' ? 'drill-probe' : kill.scope;
  const probeClass = kill.actionClass === '*' ? 'READ' : kill.actionClass;
  const effects = haltEffects(kill.scope, kill.actionClass);
  let held: boolean;
  let authorizationHeld: boolean;
  try {
    held = await checkKill(db, tenant, probeScope, probeClass);
    // Exercise the real halt path while the stop is held: the same
    // guardedAuthorize call sites use must refuse new work.
    const verdict = await guardedAuthorize(db, { tenant, scope: probeScope, actionClass: probeClass });
    authorizationHeld = verdict.verdict === 'denied';
  } finally {
    await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }
  const released = !(await checkKill(db, tenant, probeScope, probeClass));
  await audit(
    db,
    tenant,
    by,
    'RUNTIME_HALT_DRILL',
    `${kill.scope}/${kill.actionClass}`,
    JSON.stringify({ mode: 'runtime-halt', held, released, authorizationHeld, effects }),
    at,
  );
  return {
    mode: 'runtime-halt',
    scope: kill.scope,
    actionClass: kill.actionClass,
    held,
    released,
    authorizationHeld,
    effects,
    at,
  };
}

export function liveness(now?: string): { alive: true; at: string } {
  return { alive: true, at: now ?? new Date().toISOString() };
}

// ------------------------------------------------------- worker heartbeat ----
// FLOW-023: the application worker owns a durable heartbeat (`substrate/
// worker.ts` records it on every tick, best-effort). Readiness treats the
// three heartbeat states differently on purpose:
//   never recorded → unconfigured-optional (no worker deployed yet; dev and
//     fresh installs stay green rather than crying wolf);
//   fresh          → ok;
//   stale          → failing (a deployed worker that went silent is an
//     outage, not an unconfigured optional).

/** A recorded heartbeat older than this makes readiness fail. */
export const WORKER_HEARTBEAT_STALE_MS = 60_000;

const workerHeartbeatKey = (tenant: string): string => `worker:heartbeat:${tenant}`;

export async function recordWorkerHeartbeat(
  db: AsyncDb,
  tenant: string,
  input: { workerId: string; now?: string },
): Promise<void> {
  const at = input.now ?? new Date().toISOString();
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(workerHeartbeatKey(tenant), JSON.stringify({ workerId: input.workerId, at }));
}

export async function readWorkerHeartbeat(
  db: AsyncDb,
  tenant: string,
): Promise<{ workerId: string; at: string } | null> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(workerHeartbeatKey(tenant))) as
    { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value)) as { workerId?: unknown; at?: unknown };
    if (typeof parsed.workerId !== 'string' || typeof parsed.at !== 'string') return null;
    return { workerId: parsed.workerId, at: parsed.at };
  } catch {
    return null;
  }
}

/** Readiness projection of the worker heartbeat — shaped for DependencyCheck. */
export async function workerReadiness(
  db: AsyncDb,
  tenant: string,
  opts: { staleMs?: number; now?: string } = {},
): Promise<{ ok: boolean; detail?: string; unconfigured?: boolean }> {
  const staleMs = opts.staleMs ?? WORKER_HEARTBEAT_STALE_MS;
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const beat = await readWorkerHeartbeat(db, tenant);
  if (!beat) {
    return {
      ok: false,
      unconfigured: true,
      detail: 'no worker heartbeat recorded — run `vital worker` or `vital serve --with-worker`',
    };
  }
  const ageMs = nowMs - Date.parse(beat.at);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { ok: false, detail: `worker heartbeat timestamp unreadable (${beat.workerId})` };
  }
  if (ageMs > staleMs) {
    return { ok: false, detail: `worker ${beat.workerId} heartbeat stale (${Math.round(ageMs / 1000)}s old)` };
  }
  return { ok: true, detail: `worker ${beat.workerId} heartbeat ${Math.round(ageMs / 1000)}s old` };
}

export interface DependencyCheck {
  name: string;
  optional?: boolean;
  check: () => Promise<{ ok: boolean; detail?: string; unconfigured?: boolean }>;
}

export interface ReadinessCheckResult {
  name: string;
  status: 'ok' | 'failing' | 'timeout' | 'unconfigured-optional' | 'unconfigured-required';
  detail?: string;
}

export interface ReadinessReport {
  ready: boolean;
  at: string;
  elapsedMs: number;
  checks: ReadinessCheckResult[];
}

async function runBoundedCheck(dep: DependencyCheck, timeoutMs: number): Promise<ReadinessCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      dep.check(),
      new Promise<{ ok: boolean; detail?: string; unconfigured?: boolean }>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
      }),
    ]);
    if (outcome.ok) return { name: dep.name, status: 'ok', detail: outcome.detail };
    if (outcome.unconfigured === true || /not configured|unconfigured|missing/i.test(outcome.detail ?? '')) {
      if (dep.optional === true) return { name: dep.name, status: 'unconfigured-optional', detail: outcome.detail };
      return { name: dep.name, status: 'unconfigured-required', detail: outcome.detail };
    }
    return { name: dep.name, status: 'failing', detail: outcome.detail };
  } catch (err) {
    if ((err as Error).message === 'READINESS_TIMEOUT') return { name: dep.name, status: 'timeout' };
    const detail = (err as Error).message;
    if (dep.optional === true && /not configured|unconfigured|missing/i.test(detail)) {
      return { name: dep.name, status: 'unconfigured-optional', detail };
    }
    return { name: dep.name, status: 'failing', detail };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function checkReadiness(
  deps: DependencyCheck[],
  opts: { timeoutMs?: number; now?: string } = {},
): Promise<ReadinessReport> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const t0 = Date.now();
  const checks: ReadinessCheckResult[] = [];
  for (const dep of deps) {
    checks.push(await runBoundedCheck(dep, timeoutMs));
  }
  const ready = checks.every((check) => check.status === 'ok' || check.status === 'unconfigured-optional');
  return { ready, at: opts.now ?? new Date().toISOString(), elapsedMs: Date.now() - t0, checks };
}

export function mintSupportRef(): string {
  return `sup_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function sanitizeDiagnostic(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-key]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[redacted-url]')
    .replace(/bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'bearer [redacted]')
    .replace(/sk-[A-Za-z0-9\-_]{8,}/g, '[redacted]')
    .replace(/(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

export function correlateDiagnostic(input: {
  detail: string;
  tenant?: string;
  action?: string;
  supportRef?: string;
  now?: string;
}): { supportRef: string; sanitized: string; tenant: string | null; action: string | null; at: string } {
  return {
    supportRef: input.supportRef ?? mintSupportRef(),
    sanitized: sanitizeDiagnostic(input.detail),
    tenant: input.tenant ?? null,
    action: input.action ?? null,
    at: input.now ?? new Date().toISOString(),
  };
}

export type FailureClass =
  'rate-limit' | 'timeout-unknown' | 'dependency-outage' | 'validation' | 'conflict' | 'sensitive' | 'auth' | 'unknown';

export interface RetryGuidance {
  retryable: boolean;
  strategy: string;
  reason: string;
}

const RETRY_GUIDANCE: Record<FailureClass, RetryGuidance> = {
  'rate-limit': {
    retryable: true,
    strategy: 'bounded-retry-with-backoff',
    reason: 'rate limits clear with time; retry with backoff inside the same idempotency key',
  },
  'timeout-unknown': {
    retryable: true,
    strategy: 'reconcile-before-retry',
    reason:
      'an unknown result may have executed; reconcile server state first, never assume failure means nothing happened',
  },
  'dependency-outage': {
    retryable: true,
    strategy: 'wait-for-readiness-then-retry',
    reason: 'retry only after readiness reports the dependency healthy again',
  },
  validation: {
    retryable: false,
    strategy: 'fix-and-resubmit',
    reason: 'validation failures repeat deterministically; retrying identical input helps nothing',
  },
  conflict: {
    retryable: false,
    strategy: 're-read-then-resubmit',
    reason: 'stale or conflicting state needs a fresh read and an explicit new submission',
  },
  sensitive: {
    retryable: false,
    strategy: 'explicit-resubmission-only',
    reason:
      'sensitive actions (approvals, spends, external effects) are never blindly replayed; a human resubmits explicitly',
  },
  auth: {
    retryable: false,
    strategy: 'reauthenticate-then-resubmit',
    reason: 'authentication failures need fresh credentials and explicit resubmission, never silent replay',
  },
  unknown: {
    retryable: false,
    strategy: 'investigate-first',
    reason: 'unknown failures fail closed; investigate before any retry',
  },
};

export function retryGuidance(failureClass: FailureClass): RetryGuidance {
  return RETRY_GUIDANCE[failureClass] ?? RETRY_GUIDANCE.unknown;
}

export interface SettingEntry {
  key: string;
  area: 'approval' | 'budget' | 'scope' | 'trust' | 'stop';
  entryPoint: string;
  startupOnly: boolean;
  description: string;
}

export const SETTINGS_INVENTORY: SettingEntry[] = [
  {
    key: 'approver-role',
    area: 'approval',
    entryPoint: 'serve --approver-role flag (startup)',
    startupOnly: true,
    description: 'minimum membership role that may approve; default member',
  },
  {
    key: 'reversible-clean-threshold',
    area: 'trust',
    entryPoint: 'authorize() cleanThreshold (default 200)',
    startupOnly: false,
    description: 'clean instances before ACT_REVERSIBLE may run autonomous',
  },
  {
    key: 'pinned-scopes',
    area: 'scope',
    entryPoint: 'authorize() pinnedScopes (default money,customer,production,finance)',
    startupOnly: false,
    description: 'scopes where ACT_REVERSIBLE never goes autonomous',
  },
  {
    key: 'request-bid-limits',
    area: 'budget',
    entryPoint: 'coord submit bid dollars/tokens per request',
    startupOnly: false,
    description: 'per-request spend reservation enforced at admission',
  },
  {
    key: 'kill-switch',
    area: 'stop',
    entryPoint: 'setKill/clearKill/recoverStop (runtime, audited)',
    startupOnly: false,
    description: 'tenant/scope/action-class halt and audited recovery',
  },
  {
    key: 'kill-drill-mode',
    area: 'stop',
    entryPoint: 'killDrill (policy-only) vs runtimeHaltDrill (real engage-and-release)',
    startupOnly: false,
    description: 'drill mode selector; drills never imply production readiness',
  },
];

export interface PolicySource {
  setting: string;
  value: string;
  source: 'startup' | 'runtime' | 'default';
}

const POLICY_DEFAULTS: Record<string, string> = {
  'approver-role': 'member',
  'reversible-clean-threshold': '200',
  'pinned-scopes': 'money,customer,production,finance',
  'request-bid-limits': 'per-request',
  'kill-switch': 'none-active',
  'kill-drill-mode': 'policy-only',
};

export function effectivePolicy(input: { values?: Record<string, string>; startupKeys?: string[] } = {}): {
  policy: Record<string, string>;
  sources: PolicySource[];
} {
  const values = input.values ?? {};
  const startup = new Set(input.startupKeys ?? []);
  const policy: Record<string, string> = {};
  const sources: PolicySource[] = [];
  for (const entry of SETTINGS_INVENTORY) {
    const supplied = values[entry.key];
    if (supplied !== undefined) {
      policy[entry.key] = supplied;
      sources.push({
        setting: entry.key,
        value: supplied,
        source: startup.has(entry.key) || entry.startupOnly ? 'startup' : 'runtime',
      });
    } else {
      policy[entry.key] = POLICY_DEFAULTS[entry.key] as string;
      sources.push({ setting: entry.key, value: POLICY_DEFAULTS[entry.key] as string, source: 'default' });
    }
  }
  return { policy, sources };
}

export function changeImpact(key: string): { changes: string; notChanges: string; requires: string } {
  const impacts: Record<string, { changes: string; notChanges: string; requires: string }> = {
    'approver-role': {
      changes: 'who may approve requests from this boot forward',
      notChanges: 'does not retroactively invalidate past approvals or grant agent autonomy',
      requires: 'restart (startup-only); announce to approvers before changing',
    },
    'reversible-clean-threshold': {
      changes: 'how many clean instances precede autonomous reversibles',
      notChanges: 'does not unfreeze frozen trust or clear kill switches',
      requires: 'review; lowering it weakens oversight and must be audited',
    },
    'pinned-scopes': {
      changes: 'which scopes stay approval-only for reversibles',
      notChanges: 'does not affect READ/ANALYZE/RECOMMEND ceilings or irreversible human-command',
      requires: 'review; narrowing it needs an explicit re-review of affected scopes',
    },
    'request-bid-limits': {
      changes: 'per-request spend admitted by the scheduler',
      notChanges: 'does not change already-admitted reservations',
      requires: 'no restart; applies to new submissions',
    },
    'kill-switch': {
      changes: 'immediately halts matching new authorizations',
      notChanges: 'does not force-terminate in-flight work or rewrite history',
      requires: 'audited recovery via recoverStop; restart does not clear',
    },
    'kill-drill-mode': {
      changes: 'whether drills engage real switches or check policy only',
      notChanges: 'a passing drill never proves production readiness',
      requires: 'no restart; drill evidence is labeled by mode',
    },
  };
  const impact = impacts[key];
  if (!impact) throw new TrustError('UNKNOWN_SETTING', `no governed setting "${key}"`);
  return impact;
}

export function validatePolicyChange(key: string, value: string): { ok: boolean; reasons: string[] } {
  if (key === 'approver-role') {
    const ok = ['member', 'admin', 'owner'].includes(value);
    return ok ? { ok: true, reasons: [] } : { ok: false, reasons: [`approver-role must be member, admin, or owner`] };
  }
  if (key === 'reversible-clean-threshold') {
    const n = Number(value);
    const ok = Number.isInteger(n) && n >= 1;
    return ok
      ? { ok: true, reasons: [] }
      : { ok: false, reasons: ['reversible-clean-threshold must be an integer ≥ 1'] };
  }
  if (key === 'pinned-scopes') {
    const ok = value
      .split(',')
      .map((part) => part.trim())
      .some((part) => part.length > 0);
    return ok ? { ok: true, reasons: [] } : { ok: false, reasons: ['pinned-scopes must name at least one scope'] };
  }
  if (key === 'request-bid-limits') {
    return value.length > 0
      ? { ok: true, reasons: [] }
      : { ok: false, reasons: ['request-bid-limits must not be empty'] };
  }
  if (key === 'kill-switch') {
    return { ok: false, reasons: ['kill switches change only through setKill/clearKill/recoverStop, never by value'] };
  }
  if (key === 'kill-drill-mode') {
    const ok = ['policy-only', 'runtime-halt'].includes(value);
    return ok
      ? { ok: true, reasons: [] }
      : { ok: false, reasons: ['kill-drill-mode must be policy-only or runtime-halt'] };
  }
  return { ok: false, reasons: [`no governed setting "${key}"`] };
}

export async function auditPolicyChange(
  db: AsyncDb,
  tenant: string,
  by: string,
  key: string,
  from: string,
  to: string,
  now?: string,
): Promise<void> {
  const checked = validatePolicyChange(key, to);
  if (!checked.ok) throw new TrustError('INVALID_POLICY_CHANGE', checked.reasons.join('; '));
  const at = now ?? new Date().toISOString();
  await audit(db, tenant, by, 'POLICY_CHANGED', key, JSON.stringify({ from, to }), at);
}
