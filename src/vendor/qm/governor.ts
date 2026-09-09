/**
 * PROVENANCE — vendored, not written.
 *   source:        https://github.com/yc-software/qm
 *   commit:        60ba79195dc84aa85a23f238749656e11c88696c (2026-09-08)
 *   upstream path: src/loops/governor.ts (149 lines)
 *   license:       MIT — see LICENSE-THIRD-PARTY.md
 *
 * WHAT WAS CHANGED AND WHY
 *   The upstream file couples a pure evaluator (`evaluateGovernor`) with a
 *   store-bound collector (`collectVitals`, needs `item-ledger.ts` — a file we
 *   explicitly reject for its Slack coupling — plus `output-store.ts` and
 *   `ship-gate.ts`). TODO.md §0.3 claimed this file "imports only types";
 *   that is wrong, verified 2026-09-09. So this vendoring is a NARROWING:
 *   - kept verbatim: `evaluateGovernor`, `healthWorsened`, `GovernorVerdict`,
 *     `LoopVitals`, defaults, severity order, and every threshold semantic.
 *   - dropped: `collectVitals` (store coupling). Vital wires vitals from its
 *     own tables when the scheduler exists (§0.5); that wiring lives outside
 *     this directory.
 *   - narrowed: `Loop` / `LoopQueueStats` / `LoopCaps` / `LoopGovernorConfig`
 *     are restated here with ONLY the fields `evaluateGovernor` reads, copied
 *     field-for-field from upstream `src/types.ts` (same commit) and
 *     `src/loops/item-ledger.ts` (`LoopQueueStats`). Nothing was renamed,
 *     retyped, or given new defaults.
 *
 * EDIT RULE: do not "improve" this file. If upstream fixes the evaluator,
 * re-vendor it and note the new SHA above. Vital-side adaptations go in
 * non-vendored code that calls this module.
 */

export type LoopHealth = 'healthy' | 'degraded' | 'failing' | 'quarantined';

export interface LoopGovernorConfig {
  maxConsecutiveFailedFires?: number;
  maxQueueDepth?: number;
  maxQueueAgeMs?: number;
  maxReturnRate?: number;
  returnRateMinDecisions?: number;
  staleFireMs?: number;
}

export interface LoopCaps {
  maxItemsPerFire?: number;
  maxOpenOutputs?: number;
  maxItemAttempts?: number;
}

export interface LoopQueueStats {
  queued: number;
  inProgress: number;
  ready: number;
  failed: number;
  oldestQueuedAgeMs?: number;
}

/** Narrowed upstream `Loop`: only the fields `evaluateGovernor` reads. */
export interface GovernorLoop {
  governor?: LoopGovernorConfig;
  caps?: LoopCaps;
  health: LoopHealth;
  consecutiveFailedFires?: number;
  lastFiredAt?: number;
  createdAt: number;
}

export interface LoopVitals {
  queue: LoopQueueStats;
  openOutputs: number;
  decidedOutputs: number;
  returnedOutputs: number;
  undeclaredShipActions?: string[];
}

type GovernorActionType = 'quarantine' | 'throttle' | 'ping';

interface GovernorAction {
  type: GovernorActionType;
  reason: string;
  recommendation?: string;
}

export interface GovernorVerdict {
  health: LoopHealth;
  reason?: string;
  actions: GovernorAction[];
  throttle: boolean;
  escalate: boolean;
}

const DEFAULTS: Required<
  Pick<LoopGovernorConfig, 'maxConsecutiveFailedFires' | 'maxReturnRate' | 'returnRateMinDecisions'>
> = {
  maxConsecutiveFailedFires: 3,
  maxReturnRate: 0.5,
  returnRateMinDecisions: 4,
};

const SEVERITY: Record<LoopHealth, number> = { healthy: 0, degraded: 1, failing: 2, quarantined: 3 };

export function healthWorsened(previous: LoopHealth, next: LoopHealth): boolean {
  return SEVERITY[next] > SEVERITY[previous];
}

function returnRate(vitals: LoopVitals): number {
  return vitals.decidedOutputs === 0 ? 0 : vitals.returnedOutputs / vitals.decidedOutputs;
}

export function evaluateGovernor(loop: GovernorLoop, vitals: LoopVitals, now: number): GovernorVerdict {
  const config = { ...DEFAULTS, ...loop.governor };
  const caps = loop.caps;
  const actions: GovernorAction[] = [];
  let health: LoopHealth = 'healthy';
  let reason: string | undefined;

  const raise = (next: LoopHealth, why: string) => {
    if (SEVERITY[next] > SEVERITY[health]) {
      health = next;
      reason = why;
    }
  };

  const undeclared = vitals.undeclaredShipActions ?? [];
  if (undeclared.length > 0) {
    const why = `undeclared ship action: ${undeclared.join(', ')}`;
    actions.push({
      type: 'quarantine',
      reason: why,
      recommendation: 'declare the action in the playbook or narrow the loop',
    });
    raise('quarantined', why);
  }

  const failedFires = loop.consecutiveFailedFires ?? 0;
  if (failedFires >= config.maxConsecutiveFailedFires) {
    const why = `${failedFires} consecutive failed fires`;
    actions.push({ type: 'quarantine', reason: why, recommendation: 'inspect the latest run before resuming' });
    raise('quarantined', why);
  } else if (failedFires >= 2) {
    raise('failing', `${failedFires} consecutive failed fires`);
  }

  const rate = returnRate(vitals);
  if (vitals.decidedOutputs >= config.returnRateMinDecisions && rate > config.maxReturnRate) {
    const why = `${Math.round(rate * 100)}% of reviewed outputs were returned`;
    actions.push({
      type: 'throttle',
      reason: why,
      recommendation: "the playbook is producing work people don't want — revise it",
    });
    raise('failing', why);
  }

  if (config.maxQueueDepth !== undefined && vitals.queue.queued > config.maxQueueDepth) {
    const why = `${vitals.queue.queued} items queued`;
    actions.push({ type: 'throttle', reason: why, recommendation: 'intake is outrunning the work stage' });
    raise('degraded', why);
  }

  if (config.maxQueueAgeMs !== undefined && (vitals.queue.oldestQueuedAgeMs ?? 0) > config.maxQueueAgeMs) {
    const why = `oldest queued item is ${Math.round((vitals.queue.oldestQueuedAgeMs ?? 0) / 60_000)} minutes old`;
    actions.push({ type: 'ping', reason: why, recommendation: 'work is not draining' });
    raise('degraded', why);
  }

  if (config.staleFireMs !== undefined && now - (loop.lastFiredAt ?? loop.createdAt) > config.staleFireMs) {
    const why = `no fire in ${Math.round((now - (loop.lastFiredAt ?? loop.createdAt)) / 60_000)} minutes`;
    actions.push({ type: 'ping', reason: why, recommendation: 'the trigger looks dead' });
    raise('degraded', why);
  }

  if (caps?.maxOpenOutputs !== undefined && vitals.openOutputs >= caps.maxOpenOutputs) {
    const why = `${vitals.openOutputs} outputs waiting for review`;
    actions.push({
      type: 'ping',
      reason: why,
      recommendation: 'reviewer saturation — throttle intake?',
    });
    raise('degraded', why);
  }

  return {
    health,
    ...(reason !== undefined ? { reason } : {}),
    actions,
    throttle: actions.some((action) => action.type === 'throttle'),
    escalate: healthWorsened(loop.health, health),
  };
}
