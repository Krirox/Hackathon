import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { type BuzzSurface } from './buzz.ts';
import { roomForScope, normalizeScope, agentForScope, CANONICAL_ROOMS, resolveRoomByToken } from './rooms.ts';

export interface CrossRoomDispatch {
  targetAgent: string;
  targetScope: string;
  targetRoom: string;
  action: string;
  claimRefs: string[];
}

export interface SwarmDeliberationEvent {
  step: number;
  originScope: string;
  targetScope: string;
  agent: string;
  message: string;
  claimId?: string;
  linkedClaims?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  timestamp: string;
}

export interface SwarmChain {
  chainId: string;
  initialDispatch: CrossRoomDispatch;
  originScope: string;
  events: SwarmDeliberationEvent[];
  settled: boolean;
}

/** Resolve an @token against canonical rooms + stored aliases + custom rooms. */
export async function resolveDispatchTarget(
  db: import('../core/db.ts').AsyncDb,
  tenant: string,
  token: string,
): Promise<{ agentName: string; targetScope: string; targetRoom: string } | null> {
  const t = token.trim().toLowerCase();
  if (
    t === 'eng' ||
    t === 'eng-agent' ||
    t === 'engineering' ||
    t === 'coding' ||
    t === 'coding-agent' ||
    t === 'coder'
  ) {
    const infra = CANONICAL_ROOMS.find((r) => r.scope === 'infra')!;
    return { agentName: 'ops-agent', targetScope: infra.scope, targetRoom: infra.name };
  }
  return resolveRoomByToken(db, tenant, t);
}

/** Parses cross-room dispatches like "@finance-agent assess churn impact of [clm_market_42]" */
export function parseCrossRoomDispatch(text: string): CrossRoomDispatch | null {
  const match = /@([a-zA-Z0-9_-]+)\s+(.+)/i.exec(text.trim());
  if (!match) return null;
  const targetToken = match[1]!.toLowerCase();
  const rest = match[2]!.trim();

  // Find target room/agent
  const targetRoomDef = CANONICAL_ROOMS.find(
    (r) =>
      r.agentName.toLowerCase() === targetToken ||
      r.id.toLowerCase() === targetToken ||
      r.scope.toLowerCase() === targetToken ||
      r.name.toLowerCase() === targetToken ||
      ((targetToken === 'marketing' || targetToken === 'marketing-agent' || targetToken === 'business-agent') &&
        r.scope === 'business') ||
      ((targetToken === 'eng' ||
        targetToken === 'eng-agent' ||
        targetToken === 'engineering' ||
        targetToken === 'coding' ||
        targetToken === 'coding-agent' ||
        targetToken === 'coder') &&
        r.scope === 'infra'),
  );
  if (!targetRoomDef) return null;

  // Extract claim refs: [clm_...] or clm_...
  const claimRefs: string[] = [];
  const claimRegex = /\[?(clm_[a-zA-Z0-9_-]+)\]?/g;
  let cm: RegExpExecArray | null;
  while ((cm = claimRegex.exec(rest)) !== null) {
    if (cm[1]) claimRefs.push(cm[1]);
  }

  return {
    targetAgent: targetRoomDef.agentName,
    targetScope: targetRoomDef.scope,
    targetRoom: targetRoomDef.name,
    action: rest,
    claimRefs,
  };
}

export interface SwarmCoordinatorOptions {
  db: AsyncDb;
  ledger: Ledger;
  coord: Coordinator;
  surface?: BuzzSurface;
  now?: () => string;
}

export class InterAgentSwarmCoordinator {
  private readonly db: AsyncDb;
  private readonly ledger: Ledger;
  private readonly coord: Coordinator;
  private readonly surface?: BuzzSurface;
  private readonly now: () => string;

  constructor(opts: SwarmCoordinatorOptions) {
    this.db = opts.db;
    this.ledger = opts.ledger;
    this.coord = opts.coord;
    this.surface = opts.surface;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /**
   * Executes a cross-room handoff:
   * e.g. market-agent posts: "@finance-agent assess churn impact of [clm_market_42]"
   * 1. Submits downstream request to Coordinator for targetScope
   * 2. Links claims via Ledger (derives_from)
   * 3. Posts deliberation thread in origin room and target room
   */
  async executeHandoff(input: {
    tenant: string;
    originScope: string;
    originAgent?: string;
    /** Who spoke the mention: 'human' (console author) or 'agent' (room agent). */
    originKind?: 'human' | 'agent';
    dispatchText: string;
    threadRoot?: string;
  }): Promise<{ chainId: string; downstreamRequestId: string; targetScope: string; events: SwarmDeliberationEvent[] }> {
    const at = this.now();
    const chainId = `swm_${randomUUID().slice(0, 10)}`;
    const originScope = normalizeScope(input.originScope);
    // An unconfigured agent identity must not stop a deliberation: the room
    // name still identifies the speaker in the log.
    const originAgent = input.originAgent ?? agentForScope(originScope)?.name ?? roomForScope(originScope).agentName;

    const parsed = parseCrossRoomDispatch(input.dispatchText);
    if (!parsed) {
      throw new Error(`[swarm] unable to parse cross-room dispatch from "${input.dispatchText}"`);
    }
    const token = /^@([a-zA-Z0-9_-]+)/i.exec(input.dispatchText.trim())?.[1] ?? '';
    const resolved = await resolveDispatchTarget(this.db, input.tenant, token);
    const dispatch = resolved
      ? {
          targetAgent: resolved.agentName,
          targetScope: resolved.targetScope,
          targetRoom: resolved.targetRoom,
          action: parsed.action,
          claimRefs: parsed.claimRefs,
        }
      : parsed;

    // Loop prevention is structural (§6.3): a mention that resolves to the
    // origin room's own agent would self-delegate. Refuse loudly BEFORE any
    // submit — the coordinator would refuse it downstream, but the caller
    // needs to know WHY (and a silent no-op reads as "handled" in chat).
    if (normalizeScope(dispatch.targetScope) === originScope) {
      throw new Error(
        `[swarm] self-delegation refused: @${dispatch.targetAgent} is ${originScope}'s own agent — speak in the target room instead`,
      );
    }

    const events: SwarmDeliberationEvent[] = [];

    // Step 1: Record origin dispatch
    events.push({
      step: 1,
      originScope,
      targetScope: dispatch.targetScope,
      agent: originAgent,
      message: `Cross-room dispatch to @${dispatch.targetAgent} in #${dispatch.targetRoom}: "${dispatch.action}"`,
      linkedClaims: dispatch.claimRefs,
      timestamp: at,
    });

    const claimRefs = [...dispatch.claimRefs];
    if (claimRefs.length === 0) {
      try {
        const grounding = await this.ledger.append({
          tenant: input.tenant,
          subject: `chat:${originScope}:dispatch`,
          kind: 'OBSERVATION',
          statement: dispatch.action.slice(0, 200),
          confidence: 1.0,
          observedAt: at,
          validFrom: at,
          owner: originAgent,
          scope: originScope,
          authorType: 'agent',
          provenance: {
            sourceUri: `buzz://chat/${originScope}`,
            sourceTier: 'PRIMARY',
            extractor: 'buzz:mention',
            extractorVersion: '1.0.0',
            retrievedAt: at,
          },
        });
        claimRefs.push(grounding.id);
      } catch {
        // If append fails, proceed
      }
    }

    // Step 2: Submit Coordination Proposal to targetScope
    const proposal = await this.coord.submit({
      tenant: input.tenant,
      messageClass: 'REQUEST',
      originScope,
      targetScope: dispatch.targetScope,
      goal: dispatch.action,
      claimRefs,
      deliverableSchema: 'swarm.deliberation',
      bid: {
        dollars: 50,
        tokens: 25_000,
        humanMinutes: 0,
        maxRounds: 2,
      },
      onBehalfOf: `${input.originKind === 'human' ? 'human' : 'agent'}:${originAgent}`,
      now: at,
    });

    if (!proposal.admitted) {
      throw new Error(`[swarm] coordination proposal refused: ${proposal.reason}`);
    }

    const downstreamRequestId = proposal.request.id;

    // Step 3: Target agent picks up request in target room
    events.push({
      step: 2,
      originScope,
      targetScope: dispatch.targetScope,
      agent: dispatch.targetAgent,
      message: `Accepted request \`${downstreamRequestId}\` in #${dispatch.targetRoom}: modeling churn impact on claims [${dispatch.claimRefs.join(', ')}]`,
      linkedClaims: dispatch.claimRefs,
      timestamp: at,
    });

    // Step 4: Post to Buzz surface if available
    if (this.surface) {
      const originRoom = roomForScope(originScope);
      const targetRoom = roomForScope(dispatch.targetScope);

      // Post in origin room thread
      try {
        await this.surface.post({
          channel: originRoom.channel,
          threadRoot: input.threadRoot,
          requestId: downstreamRequestId,
          step: 1,
          tokens: 500,
          state: 'IN_FLIGHT',
          text: `🤖 **${originAgent}**: Dispatched cross-room deliberation to @${dispatch.targetAgent} in #${targetRoom.name}: "${dispatch.action}"`,
        });
      } catch {
        /* non-fatal */
      }

      // Post in target room thread
      try {
        await this.surface.post({
          channel: targetRoom.channel,
          requestId: downstreamRequestId,
          step: 2,
          tokens: 1200,
          state: 'IN_FLIGHT',
          text: `🤖 **${dispatch.targetAgent}**: Received cross-room task from #${originRoom.name} (\`${originAgent}\`):\n> "${dispatch.action}"\nReferencing claims: ${dispatch.claimRefs.map((c) => `\`[${c}]\``).join(', ')}. Initializing churn impact model...`,
        });
      } catch {
        /* non-fatal */
      }
    }

    return {
      chainId,
      downstreamRequestId,
      targetScope: dispatch.targetScope,
      events,
    };
  }

  /**
   * Completes target assessment and evaluates high-risk deliberation cascade:
   * e.g. finance-agent completes assessment: churn variance +18.4% (high risk)
   * -> Automatically flags #exec and #growth to draft counter-promotional procedures
   * -> Links claims via derives_from in Reality Ledger
   */
  async handleAssessmentOutcome(input: {
    tenant: string;
    downstreamRequestId: string;
    targetScope: string;
    originScope: string;
    originClaimIds: string[];
    churnProbability: number;
    statement: string;
    threadRoot?: string;
  }): Promise<{
    findingClaimId: string;
    escalated: boolean;
    downstreamRooms: string[];
    events: SwarmDeliberationEvent[];
  }> {
    const at = this.now();
    const isHighRisk = input.churnProbability >= 0.1; // >10% churn is high risk
    const targetScope = normalizeScope(input.targetScope);
    const targetDef = roomForScope(targetScope);
    const events: SwarmDeliberationEvent[] = [];

    // 1. Ingest finding claim into target scope
    const finding = await this.ledger.append({
      tenant: input.tenant,
      subject: 'churn_risk',
      kind: 'PREDICTION',
      statement: input.statement,
      confidence: 0.92,
      observedAt: at,
      validFrom: at,
      owner: `agent:${targetDef.agentName}`,
      scope: targetScope,
      authorType: 'agent',
      provenance: {
        sourceUri: `swarm://deliberation/${input.downstreamRequestId}`,
        sourceTier: 'SINGLE_SOURCE',
        extractor: 'churn_model',
        extractorVersion: '2.0',
        retrievedAt: at,
      },
    });

    // 2. Link finding to origin claims via derived_from
    for (const origId of input.originClaimIds) {
      try {
        await this.ledger.link(input.tenant, finding.id, origId, 'derived_from');
      } catch {
        // best effort link
      }
    }

    events.push({
      step: 3,
      originScope: input.originScope,
      targetScope,
      agent: targetDef.agentName,
      message: `Assessment completed: churn probability ${(input.churnProbability * 100).toFixed(1)}%. Created finding [${finding.id}] linked (derived_from) to [${input.originClaimIds.join(', ')}]`,
      claimId: finding.id,
      linkedClaims: input.originClaimIds,
      riskLevel: isHighRisk ? 'high' : 'low',
      timestamp: at,
    });

    const downstreamRooms: string[] = [];

    // 3. If high risk, cascade handoffs to #exec and #growth
    if (isHighRisk) {
      downstreamRooms.push('exec', 'growth');

      // Create downstream request for growth: counter-promotional campaign
      await this.coord.submit({
        tenant: input.tenant,
        messageClass: 'REQUEST',
        originScope: targetScope,
        targetScope: 'business',
        goal: `Draft counter-promotional procedure to mitigate ${(input.churnProbability * 100).toFixed(1)}% churn risk from [${finding.id}]`,
        claimRefs: [finding.id],
        deliverableSchema: 'growth.counter_promo',
        bid: { dollars: 200, tokens: 50_000, humanMinutes: 5 },
        onBehalfOf: `agent:${targetDef.agentName}`,
        now: at,
      });

      // Create downstream request for exec: strategic alert & review
      await this.coord.submit({
        tenant: input.tenant,
        messageClass: 'REQUEST',
        originScope: targetScope,
        targetScope: 'exec',
        goal: `Strategic review: competitor price reduction triggering ${(input.churnProbability * 100).toFixed(1)}% churn vulnerability [${finding.id}]`,
        claimRefs: [finding.id],
        deliverableSchema: 'exec.strategic_notice',
        bid: { dollars: 10, tokens: 5_000, humanMinutes: 10 },
        onBehalfOf: `agent:${targetDef.agentName}`,
        now: at,
      });

      events.push({
        step: 4,
        originScope: targetScope,
        targetScope: 'exec',
        agent: targetDef.agentName,
        message: `High risk threshold breached (${(input.churnProbability * 100).toFixed(1)}%). Flagged #exec and #growth to draft counter-promotional procedure [${finding.id}].`,
        claimId: finding.id,
        riskLevel: 'high',
        timestamp: at,
      });

      // Post updates to Buzz surface
      if (this.surface) {
        const financeRoom = roomForScope('finance');
        const execRoom = roomForScope('exec');
        const growthRoom = roomForScope('growth');

        try {
          await this.surface.post({
            channel: financeRoom.channel,
            threadRoot: input.threadRoot,
            requestId: input.downstreamRequestId,
            step: 3,
            tokens: 2500,
            state: 'COMPLETED',
            text: `🤖 **${targetDef.agentName}**: Model finished: Churn probability is **${(input.churnProbability * 100).toFixed(1)}%** (HIGH RISK 🔴).\nLinked claim: \`[${finding.id}]\` derives from ${input.originClaimIds.map((c) => `\`[${c}]\``).join(', ')}.\n🚨 Auto-flagged **#exec** and **#growth** to formulate counter-promotional response.`,
          });
        } catch {
          /* non-fatal */
        }

        try {
          await this.surface.post({
            channel: growthRoom.channel,
            requestId: `growth_${finding.id}`,
            step: 1,
            tokens: 1000,
            state: 'IN_FLIGHT',
            text: `🤖 **growth-agent**: Received high-risk churn alert from #finance (\`[${finding.id}]\`). Drafting enterprise retention campaign and counter-promotional discounts...`,
          });
        } catch {
          /* non-fatal */
        }

        try {
          await this.surface.post({
            channel: execRoom.channel,
            requestId: `exec_${finding.id}`,
            step: 1,
            tokens: 800,
            state: 'IN_FLIGHT',
            text: `🤖 **exec-agent**: Strategic notice logged from #finance: Churn vulnerability ${(input.churnProbability * 100).toFixed(1)}% flagged. Review queued for morning executive briefing.`,
          });
        } catch {
          /* non-fatal */
        }
      }
    }

    return {
      findingClaimId: finding.id,
      escalated: isHighRisk,
      downstreamRooms,
      events,
    };
  }
}
