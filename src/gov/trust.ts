import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import {
  authorize,
  REVERSIBLE_CLEAN_THRESHOLD,
  type AuthorizeInput,
  type AuthorizeResult,
  type TrustState,
} from './raci.ts';

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
    .prepare('SELECT clean, frozen FROM trust_scores WHERE tenant = ? AND scope = ? AND action_class = ?')
    .get(tenant, scope, actionClass)) as { clean: number; frozen: number } | undefined;
  return { cleanInstances: Number(r?.clean ?? 0), frozen: Number(r?.frozen ?? 0) === 1 };
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
        `INSERT INTO trust_scores (tenant, scope, action_class, clean, total, override_rate, honey_misses, granted, frozen, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, scope, action_class) DO NOTHING`,
      )
      .run(tenant, scope, actionClass, 0, 0, 0, 0, 0, 0, now);
    if (outcome.honeyMiss === true) {
      await db
        .prepare(
          'UPDATE trust_scores SET honey_misses = honey_misses + 1, frozen = 1, clean = 0, total = total + 1, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
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
      return;
    }
    if (outcome.override === true || !outcome.clean) {
      await db
        .prepare(
          'UPDATE trust_scores SET clean = 0, total = total + 1, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
        )
        .run(now, tenant, scope, actionClass);
      return;
    }
    // The grant flag derives from the post-increment value inside the same
    // statement: reaching the threshold and counting the instance are one
    // atomic move, never two writers racing past each other.
    await db
      .prepare(
        'UPDATE trust_scores SET clean = clean + 1, total = total + 1, granted = CASE WHEN clean + 1 >= ? THEN 1 ELSE granted END, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
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
      'UPDATE trust_scores SET frozen = 0, clean = 0, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
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
export async function setKill(db: AsyncDb, tenant: string, kill: KillScope, by: string, now?: string): Promise<void> {
  const at = now ?? new Date().toISOString();
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(killKey(tenant, kill.scope, kill.actionClass), JSON.stringify({ by, at }));
  await audit(db, tenant, by, 'KILL_ENGAGED', `${kill.scope}/${kill.actionClass}`, `halted at ${at}`, at);
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

export interface KillDrill {
  mode: 'policy-only';
  levels: string[];
  checks: { level: string; halted: boolean; isolated: boolean; released: boolean }[];
  allHalted: boolean;
  elapsedMs: number;
}

export async function killDrill(db: AsyncDb, tenant: string, by: string, now?: string): Promise<KillDrill> {
  const at = now ?? new Date().toISOString();
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
    const allHalted = checks.every((check) => check.halted && check.isolated && check.released);
    const elapsedMs = Date.now() - t0;
    await audit(
      db,
      tenant,
      by,
      'KILL_DRILL',
      tenant,
      JSON.stringify({ mode: 'policy-only', allHalted, elapsedMs, checks }),
      at,
    );
    return { mode: 'policy-only', levels: checks.map((check) => check.level), checks, allHalted, elapsedMs };
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
        `INSERT INTO trust_scores (tenant, scope, action_class, clean, total, override_rate, honey_misses, granted, frozen, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, scope, action_class) DO NOTHING`,
      )
      .run(tenant, scope, actionClass, 0, 0, 0, 0, 0, 0, at);
    await db
      .prepare(
        'UPDATE trust_scores SET frozen = 1, clean = 0, updated_at = ? WHERE tenant = ? AND scope = ? AND action_class = ?',
      )
      .run(at, tenant, scope, actionClass);
    await audit(db, tenant, by, 'TRUST_FROZEN', `${scope}/${actionClass}`, reason, at);
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
