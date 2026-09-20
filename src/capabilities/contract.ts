import { z } from 'zod';

/**
 * Capability Contracts, format only (TODO §6.4): nine questions + an outcome
 * metric + a kill condition. Market/Customer/Product capabilities need live
 * systems to read from; the CONTRACT — what a capability promises, how it
 * is measured, and when it dies — needs only honesty, so it lives here.
 *
 * A capability meeting its kill condition gets retired, not rebranded.
 */

export class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[capability:${code}] ${message}`);
  }
}

const contractSchema = z
  .object({
    tenant: z.string().min(1),
    name: z.string().min(1),
    /** Nine questions: observe / state / triggers / understands / influences / executes / measures / escalates / stays silent. */
    answers: z.record(z.string(), z.string().min(1)),
    /** The outcome metric this capability moves. */
    outcomeMetric: z.string().min(1),
    /** The kill condition, with a numeric threshold where one applies. */
    killCondition: z.string().min(1),
    owner: z.string().min(1),
  })
  .strict();

export type ContractInput = z.input<typeof contractSchema>;

export interface CapabilityContract extends ContractInput {
  dead: boolean;
}

const NINE_QUESTIONS = [
  'observe',
  'state',
  'triggers',
  'understands',
  'influences',
  'executes',
  'measures',
  'escalates',
  'staysSilent',
] as const;

export function validateContract(input: ContractInput): CapabilityContract {
  const c = contractSchema.parse(input);
  const missing = NINE_QUESTIONS.filter((q) => !c.answers[q] || c.answers[q]!.trim().length === 0);
  if (missing.length > 0) {
    throw new CapabilityError(
      'INCOMPLETE_CONTRACT',
      `capability "${c.name}" leaves questions unanswered: ${missing.join(', ')}`,
    );
  }
  return { ...c, dead: false };
}

/**
 * Death review: compare measured metrics against the contract. Returns the
 * verdict; retiring the capability is the caller's explicit act, because a
 * kill condition firing should be visible, not silent.
 */
export function evaluateKill(
  contract: CapabilityContract,
  measured: Record<string, number>,
  killMetric: string,
  killBelow: number,
): { dead: boolean; reason: string } {
  const v = measured[killMetric];
  if (v === undefined)
    return { dead: false, reason: `kill metric "${killMetric}" not measured yet: cannot declare death` };
  if (v < killBelow) {
    return {
      dead: true,
      reason: `kill condition met (${contract.killCondition}): ${killMetric}=${v} < ${killBelow}: retire, do not rebrand`,
    };
  }
  return { dead: false, reason: `${killMetric}=${v} ≥ ${killBelow}: survives this review` };
}

export interface SilenceRow {
  quarter: string;
  name: string;
  spoke: boolean;
  justificationDue: boolean;
}

/**
 * Silence budget (TODO §3.3): each capability must justify why it DIDN'T
 * speak each quarter. Pass the contracts and the names that produced
 * visible output; silence without justification is the finding.
 */
export function silenceReview(
  contracts: CapabilityContract[],
  spokeNames: readonly string[],
  quarter: string,
): SilenceRow[] {
  return contracts.map((c) => {
    const spoke = spokeNames.includes(c.name);
    return { quarter, name: c.name, spoke, justificationDue: !spoke };
  });
}
