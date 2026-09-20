// The two learning acts that had no product path: compiling a mined candidate
// into a skill card, and asking for the cross-model transfer evidence that
// promotion depends on.
//
// Why this matters more than it looks. `OrganizationalCompiler.executableFor`
// reads PROMOTED cards, the worker consults it before every dispatch, and the
// whole WORKFLOW-tier branch hangs off it — but `compile()` was reachable only
// from tests, so `skill_cards` stayed empty in every deployment and that branch
// never fired. Mining and labeling worked; nothing could be *born*.
//
// The rule that shapes this module: the evidence decides, the operator writes
// prose. Fields that describe what happened (which traces, which scopes, which
// models actually ran them, which tier they were routed at) are read from the
// database and are NOT form inputs. Fields that say what the procedure *is*
// (predicates, steps, tests) are the operator's, because only a human can state
// a procedure. A compiler that lets a form invent its own provenance is a
// compiler that mints fiction.

import type { AsyncDb } from '../core/db.ts';
import { mineCandidates, type OrganizationalCompiler, type SkillCard } from '../compiler/compiler.ts';
import type { RoutingClass } from '../core/types.ts';
import { enqueueOutbox } from '../substrate/scheduler.ts';

/** Repeated successes required before an intent may be compiled. */
export const COMPILE_MIN_SUCCESSES = 3;

/** Outbox kind the worker relays into `runCrossModelEvidence`. */
export const TRANSFER_TEST_KIND = 'transfer-test';

/** The tier vocabulary a card may declare, cheapest first. */
const TIER_ORDER: readonly RoutingClass[] = ['REFLEX', 'WORKFLOW', 'MODEL', 'HUMAN'];

/** Traces routed at a cache hit are compiled as the cheapest tier that exists. */
const TIER_ALIASES: Record<string, RoutingClass> = { CACHE: 'REFLEX', REFLEX: 'REFLEX' };

export interface CompileCandidate {
  intent: string;
  repeats: number;
  successRate: number;
  /** Scopes the successful traces ran in. */
  scopes: string[];
  taskTypes: string[];
  /** The traces the compiler would cite — successes the router did not doubt. */
  traceIds: string[];
  /** Models that actually produced those traces, from the executor that ran them. */
  originModels: string[];
  /** Tiers those traces were routed at. */
  tiers: RoutingClass[];
  /** Why this candidate cannot be compiled yet, or null when it can. */
  blocked: string | null;
}

interface EvidenceRow {
  id: string;
  request_id: string | null;
  scope: string;
  task_type: string;
  tier: string;
  outcome: string;
  router_confidence: number;
  exec_owner: string | null;
}

/**
 * Read one intent's compileable evidence straight from `traces`.
 *
 * `exec_owner` is joined rather than guessed: the harness claims execution as
 * `<adapter.name>:worker`, so its prefix is the only durable record of *which*
 * model produced a trace. When it is absent the candidate is reported blocked
 * instead of compiled with an invented origin model — `originModels` is what
 * decides whether a promoted card may run on a model without a transfer test,
 * so a guess here would quietly widen a card's authority.
 */
async function evidenceFor(db: AsyncDb, tenant: string, intent: string): Promise<EvidenceRow[]> {
  return (await db
    .prepare(
      `SELECT t.id, t.request_id, t.scope, t.task_type, t.tier, t.outcome, t.router_confidence,
              r.exec_owner
         FROM traces t
         LEFT JOIN requests r ON r.id = t.request_id AND r.tenant = t.tenant
        WHERE t.tenant = ? AND t.intent = ?
        ORDER BY t.created_at ASC`,
    )
    .all(tenant, intent)) as unknown as EvidenceRow[];
}

/** `jcode:worker` → `jcode`. An executor name with no colon is used as-is. */
function modelOfExecOwner(owner: string | null): string | null {
  if (!owner) return null;
  const name = owner.split(':')[0]?.trim();
  return name ? name : null;
}

export async function listCompileCandidates(
  db: AsyncDb,
  tenant: string,
  minRepeats = COMPILE_MIN_SUCCESSES,
): Promise<CompileCandidate[]> {
  const mined = await mineCandidates(db, tenant, minRepeats);
  const out: CompileCandidate[] = [];
  for (const candidate of mined) {
    const rows = await evidenceFor(db, tenant, candidate.intent);
    const usable = rows.filter(
      (r) => r.outcome !== 'UNRESOLVED' && Number(r.router_confidence) >= 0.5,
    );
    const scopes = [...new Set(usable.map((r) => String(r.scope)))].sort();
    const tiers = [
      ...new Set(
        usable
          .map((r) => TIER_ALIASES[String(r.tier).toUpperCase()] ?? (String(r.tier).toUpperCase() as RoutingClass))
          .filter((t) => TIER_ORDER.includes(t)),
      ),
    ].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
    const originModels = [
      ...new Set(usable.map((r) => modelOfExecOwner(r.exec_owner)).filter((m): m is string => Boolean(m))),
    ].sort();
    let blocked: string | null = null;
    if (usable.length < minRepeats) {
      blocked = `${usable.length} of ${minRepeats} required resolved successes`;
    } else if (originModels.length === 0) {
      blocked = 'no executor provenance on these traces: the compiler will not guess which models the procedure came from';
    } else if (tiers.length === 0) {
      blocked = 'no routing tier recorded for these traces';
    }
    out.push({
      intent: candidate.intent,
      repeats: candidate.repeats,
      successRate: candidate.successRate,
      scopes,
      taskTypes: candidate.taskTypes,
      traceIds: usable.map((r) => String(r.id)),
      originModels,
      tiers,
      blocked,
    });
  }
  return out.sort((a, b) => b.repeats - a.repeats || a.intent.localeCompare(b.intent));
}

export interface CompileInput {
  intent: string;
  predicates: string[];
  steps: string[];
  tests: string[];
  toolGrants: string[];
  /** The tier the evidence supports; validated against the traces, not trusted. */
  tier: string;
  /** The scope the evidence supports; validated against the traces, not trusted. */
  scope: string;
  owner: string;
  now: string;
}

export async function compileCandidate(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  input: CompileInput,
): Promise<SkillCard> {
  const candidates = await listCompileCandidates(db, tenant);
  const candidate = candidates.find((c) => c.intent === input.intent);
  if (!candidate) {
    throw new Error(
      `no compilable candidate for intent "${input.intent}". The compiler only learns from repeated successful traces`,
    );
  }
  if (candidate.blocked) throw new Error(`candidate "${candidate.intent}" is not compilable: ${candidate.blocked}`);
  if (input.predicates.length === 0) throw new Error('a card without predicates cannot be safely applied');
  if (input.steps.length === 0) throw new Error('a procedure needs at least one step');
  if (input.tests.length === 0) throw new Error('a card without success tests has no spec');
  const tier = input.tier.toUpperCase() as RoutingClass;
  if (!candidate.tiers.includes(tier)) {
    throw new Error(
      `tier ${input.tier} is not supported by this evidence (traced at ${candidate.tiers.join(', ') || 'no tier'})`,
    );
  }
  if (!candidate.scopes.includes(input.scope)) {
    throw new Error(
      `scope ${input.scope} is not supported by this evidence (traced in ${candidate.scopes.join(', ') || 'no scope'})`,
    );
  }
  return comp.compile({
    tenant,
    intent: candidate.intent,
    predicates: input.predicates,
    steps: input.steps,
    tests: input.tests,
    toolGrants: input.toolGrants,
    validatedAtTier: tier,
    originScope: input.scope,
    // Read from the traces, never from the form.
    originModels: candidate.originModels,
    scopeRoles: candidate.scopes,
    owner: input.owner,
    traceIds: candidate.traceIds,
    now: input.now,
    source: 'compiled',
  });
}

export interface TransferTestInput {
  cardId: string;
  targetScope: string;
  command: string;
  claimIds: string[];
  maxDollars: number;
  maxTokens: number;
  onBehalfOf: string;
  now: string;
}

/**
 * Queue a cross-model transfer run for a card.
 *
 * Queued rather than run: the harnesses that can produce transfer evidence are
 * attached to a worker, not to the HTTP process serving this request. The row is
 * durable, so the operator's click survives a restart, and the worker writes the
 * resulting `skill_transfer_tests` rows through `runCrossModelEvidence` — which
 * banks negative results too, so a failed transfer is recorded rather than
 * silently skipped.
 */
export async function enqueueTransferTest(
  db: AsyncDb,
  comp: OrganizationalCompiler,
  tenant: string,
  input: TransferTestInput,
): Promise<string> {
  const card = await comp.get(tenant, input.cardId);
  if (!card) throw new Error(`unknown skill card ${input.cardId}`);
  const targetScope = input.targetScope.trim();
  if (!targetScope) throw new Error('a target scope is required');
  // A transfer where the card runs in its own scope is not a transfer, and the
  // coordinator refuses the self-delegation anyway. Refusing here keeps a bad
  // configuration from banking a FAILED transfer row against the card — that
  // row would be negative *evidence*, and misconfiguration is not evidence.
  if (targetScope === card.originScope) {
    throw new Error(
      `a transfer must leave the card's own scope: ${card.originScope} cannot send work to itself; pick a different target scope`,
    );
  }
  if (!input.command.trim()) throw new Error('a transfer command is required');
  // Grounding, not ceremony: a REQUEST with no cited claims has nothing to
  // transfer the procedure *against*, and the coordinator refuses it anyway —
  // so refusing here turns a queued job that dies in the worker into an error
  // the operator sees immediately.
  if (input.claimIds.length === 0) {
    throw new Error('a transfer run needs at least one cited claim to work from');
  }
  if (!Number.isFinite(input.maxDollars) || input.maxDollars <= 0) {
    throw new Error('a positive dollar ceiling is required for a transfer run');
  }
  if (!Number.isFinite(input.maxTokens) || input.maxTokens <= 0) {
    throw new Error('a positive token ceiling is required for a transfer run');
  }
  return enqueueOutbox(
    db,
    tenant,
    TRANSFER_TEST_KIND,
    {
      tenant,
      cardId: card.id,
      intent: card.intent,
      originScope: card.originScope,
      targetScope,
      command: input.command.trim(),
      claimIds: input.claimIds,
      maxDollars: input.maxDollars,
      maxTokens: input.maxTokens,
      onBehalfOf: input.onBehalfOf,
    },
    { now: input.now },
  );
}
