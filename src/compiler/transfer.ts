import type { Coordinator } from '../coord/coordinator.ts';
import type { HarnessAdapter, HarnessOutcome } from '../substrate/harness.ts';
import type { OrganizationalCompiler } from './compiler.ts';

/**
 * Cross-model transfer evidence (TODO §5): run the same intent through
 * every adapted harness and bank a `cross_model` transfer result per
 * adapter. AFTER says transfer is the weak point — so this runs the
 * evidence instead of asserting it. A harness that fails the run banks a
 * FAILED result, not an excuse: negative transfer evidence counts.
 */

export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[transfer:${code}] ${message}`);
  }
}

export interface TransferTask {
  originScope: string;
  targetScope: string;
  command: string;
  claimIds: string[];
  onBehalfOf: string;
  maxDollars: number;
  maxTokens: number;
  deliverableSchema?: string;
  now?: string;
}

export interface AdapterRun {
  adapter: string;
  status: HarnessOutcome['status'];
  recorded: boolean;
}

export async function runCrossModelEvidence(
  coord: Coordinator,
  comp: OrganizationalCompiler,
  tenant: string,
  cardId: string,
  adapters: HarnessAdapter[],
  task: TransferTask,
): Promise<AdapterRun[]> {
  const card = await comp.get(tenant, cardId);
  if (!card) throw new TransferError('MISSING_CARD', `unknown card ${cardId}`);
  if (adapters.length === 0) throw new TransferError('NO_HARNESS', 'transfer across zero harnesses proves nothing');
  const now = task.now ?? new Date().toISOString();
  const out: AdapterRun[] = [];
  for (const adapter of adapters) {
    try {
      const { request } = await coord.submit({
        tenant,
        messageClass: 'REQUEST',
        originScope: task.originScope,
        targetScope: task.targetScope,
        goal: `cross-model transfer: ${card.intent} on ${adapter.name}`,
        claimRefs: task.claimIds,
        deliverableSchema: task.deliverableSchema ?? 'transfer.v1',
        bid: { dollars: task.maxDollars, tokens: task.maxTokens },
        onBehalfOf: task.onBehalfOf,
        now,
      });
      if (!request) {
        await comp.recordTransfer(card, {
          kind: 'cross_model',
          variant: adapter.name,
          passed: false,
          score: 0,
          ranAt: now,
        });
        out.push({ adapter: adapter.name, status: 'DENIED', recorded: true });
        continue;
      }
      const outcome = await adapter.run(tenant, request.id, {
        command: task.command,
        claimRefs: task.claimIds,
        onBehalfOf: task.onBehalfOf,
        maxDollars: task.maxDollars,
        maxTokens: task.maxTokens,
      });
      const passed = outcome.status === 'COMPLETED';
      await comp.recordTransfer(card, {
        kind: 'cross_model',
        variant: adapter.name,
        passed,
        score: passed ? 1 : 0,
        ranAt: now,
      });
      out.push({ adapter: adapter.name, status: outcome.status, recorded: true });
    } catch (_err) {
      // F18: Exceptions bank negative transfer results rather than aborting silently
      await comp.recordTransfer(card, {
        kind: 'cross_model',
        variant: adapter.name,
        passed: false,
        score: 0,
        ranAt: now,
      });
      out.push({ adapter: adapter.name, status: 'FAILED', recorded: true });
    }
  }
  return out;
}
