import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ApprovalLatencyStats, Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler, SkillState } from '../compiler/compiler.ts';
import { MESSAGE_CLASSES, REQUEST_STATES } from '../core/types.ts';
import { CognitiveRouter } from '../router/router.ts';
import { describeCardReadOnly } from '../compiler/registry.ts';
import { costsOfDecisions, getRates } from '../attrib/attribution.ts';

/**
 * Output budgets: the dashboard is a bounded window, never history-sized.
 * COST_CURVE_BUDGET caps chart points (downsampled, endpoints preserved);
 * MAX_ROOMS caps room sections and ROOM_REQUESTS caps requests per room —
 * both sliced BEFORE evidence hydration so a large tenant never pays for
 * rows it will not display. MAX_NEEDS_HUMAN and MAX_CARDS_PER_STATE bound
 * the queue and compiler columns the same way.
 */
export const COST_CURVE_BUDGET = 120;
export const MAX_ROOMS = 50;
export const ROOM_REQUESTS = 20;
export const MAX_NEEDS_HUMAN = 100;
export const MAX_CARDS_PER_STATE = 100;

/**
 * Even-stride downsampling to a fixed point budget. Indices spread evenly
 * across the input with the first and last points always kept, so spikes
 * at the edges survive instead of being sliced off by a head/tail cut.
 */
export function downsampleIndices(n: number, budget: number): number[] {
  if (n <= budget || budget <= 0) return Array.from({ length: n }, (_, i) => i);
  if (budget === 1) return [n - 1];
  const out = new Set<number>();
  const step = (n - 1) / (budget - 1);
  for (let i = 0; i < budget; i++) out.add(Math.round(i * step));
  out.add(0);
  out.add(n - 1);
  return [...out].sort((a, b) => a - b);
}

/**
 * Vital Console, read model (the Ledger is our only bespoke surface).
 *
 * Everything on the three boards — Reality health, Compiler, Room — is a
 * pure function of the database. No chat lives here (Buzz exists); what
 * lives here is what chat cannot be: the numbers, the evidence, and the
 * approval queue, all replayable. `renderHtml` turns this model into a
 * zero-backend static report; the live room surface arrives in V2.1.
 */

export interface HealthReport {
  staleFactRate: number;
  staleFactGate: number;
  provenanceComplete: number;
  orphanClaims: number;
  contradictions: { open: number; oldestOpenHours: number | null; mttrHours: number | null; slaHours: number };
  spendToday: { dollars: number };
  escalations: { open: number; cap: number };
  humanMinutes: { spentToday: number; budget: number };
  refusalRate: number;
}

export interface CostPoint {
  at: string;
  label: string;
  costPerGoodDecision: number | null;
}

export interface TierBucket {
  label: string;
  REFLEX: number;
  WORKFLOW: number;
  MODEL: number;
  HUMAN: number;
}

export interface HumanItem {
  requestId: string;
  goal: string;
  scope: string;
  deadline: string;
  state: string;
}

export interface CompilerColumn {
  state: string;
  cards: {
    id: string;
    intent: string;
    version: number;
    scopeRoles: string[];
    trustTier: string;
    trustGaps: string[];
    transfersPassed: number;
    transfersTotal: number;
  }[];
}

export interface RoomView {
  scope: string;
  health: 'healthy' | 'degraded' | 'idle';
  requests: {
    id: string;
    goal: string;
    state: string;
    messageClass: string;
    originScope: string;
    targetScope: string;
    updatedAt: string;
    evidence: { id: string; kind: string; tier: string; statement: string; status: string; provisional: boolean }[];
  }[];
}

export interface ConsoleReport {
  tenant: string;
  at: string;
  health: HealthReport;
  costCurve: CostPoint[];
  costTarget: number;
  tierMix: TierBucket[];
  needsHuman: HumanItem[];
  digestCount: number;
  compiler: CompilerColumn[];
  rooms: RoomView[];
  /** Approval latency (TODO 2.3): submission → human decision, from APPROVAL_LATENCY audit rows. */
  approvalLatency: ApprovalLatencyStats;
  /** Cost-per-signal (TODO 4.1): the expensive tier's share of routed arrivals vs the <1% gate. */
  costPerSignal: Awaited<ReturnType<CognitiveRouter['costPerSignal']>>;
  /** F26: rows beyond each bounded window — 0 means the window held everything. */
  omitted: { needsHuman: number; rooms: number; decisions: number; cards: number };
}

const TERMINAL = ['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED'];

export async function buildReport(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  tenant: string,
  now: string,
  opts: { escalationCap?: number; humanMinutesBudget?: number; costTarget?: number } = {},
): Promise<ConsoleReport> {
  const stats = await ledger.stats(tenant, now);
  const facts = (stats.byKind['FACT'] ?? 0) + (stats.byKind['MEASUREMENT'] ?? 0);
  const pairs = await ledger.disputedPairs(tenant);

  // Oldest open contradiction, from the CONTRADICTION_OPEN audit trail.
  // F26: the oldest-contradiction read is bounded in SQL — only rows whose
  // target matches an OPEN contradiction pair are fetched (the audit trail
  // itself is history-sized and must never be pulled whole per dashboard GET).
  const openKeys = new Set(pairs.flatMap((p) => [`${p.a.id}<>${p.b.id}`, `${p.b.id}<>${p.a.id}`]));
  let oldestOpenHours: number | null = null;
  if (openKeys.size > 0) {
    const targetList = [...openKeys].map(() => '?').join(',');
    const rows = (await db
      .prepare(
        `SELECT MIN(at) AS earliest FROM audit_log WHERE tenant = ? AND action = 'CONTRADICTION_OPEN' AND target IN (${targetList})`,
      )
      .get(tenant, ...openKeys)) as { earliest: unknown } | undefined;
    const earliest = rows?.earliest === null || rows?.earliest === undefined ? null : String(rows.earliest);
    if (earliest) oldestOpenHours = (Date.parse(now) - Date.parse(earliest)) / 3_600_000;
  }

  const requests = await coord.list(tenant);
  const today = now.slice(0, 10);
  const todays = requests.filter((r) => r.createdAt.slice(0, 10) === today);
  const humanSpent = todays.reduce((s, r) => s + r.spent.humanMinutes, 0);
  const dollarsToday = todays.reduce((s, r) => s + r.spent.dollars, 0);
  const openHuman = requests.filter(
    (r) => r.messageClass === 'REQUEST' && !TERMINAL.includes(r.state) && r.bid.humanMinutes > 0,
  );

  // Cost curve: one point per decision with a measured outcome, in time order.
  const decisions = (await db
    .prepare('SELECT id, signed_at FROM decisions WHERE tenant = ? ORDER BY signed_at')
    .all(tenant)) as {
    id: string;
    signed_at: string;
  }[];
  const costCurve: CostPoint[] = [];
  // Downsample BEFORE costing: only the visible window pays for bulk
  // roll-ups, so a 500-decision tenant costs ~120 decisions, not history.
  const visibleIdx = downsampleIndices(decisions.length, COST_CURVE_BUDGET);
  const visibleDecisions = visibleIdx.map((i) => decisions[i]!);
  // One bulk roll-up for all decisions: per-decision costing here used to be
  // ~4 sequential queries each, making every dashboard GET history-sized.
  // Rates resolve per tenant (versioned in meta) — never code constants that
  // silently reprice history when they move.
  const rates = await getRates(db, tenant);
  const bulk = await costsOfDecisions(
    db,
    coord,
    ledger,
    tenant,
    visibleDecisions.map((d) => String(d.id)),
    rates,
  );
  for (const [vi, d] of visibleDecisions.entries()) {
    const origI = visibleIdx[vi]!;
    costCurve.push({
      at: String(d.signed_at),
      label: `D${origI + 1}`,
      costPerGoodDecision: bulk.get(String(d.id))?.costPerGoodDecision ?? null,
    });
  }

  // Tier mix: traces bucketed into 7-day windows from the earliest trace.
  const traces = (await db
    .prepare('SELECT tier, created_at FROM traces WHERE tenant = ? ORDER BY created_at')
    .all(tenant)) as {
    tier: string;
    created_at: string;
  }[];
  const tierMix: TierBucket[] = [];
  if (traces.length > 0) {
    const t0 = Date.parse(String(traces[0]!.created_at));
    const buckets: Record<string, number>[] = [];
    for (const t of traces) {
      const w = Math.floor((Date.parse(String(t.created_at)) - t0) / (7 * 86_400_000));
      const bucket = (buckets[w] ??= { REFLEX: 0, WORKFLOW: 0, MODEL: 0, HUMAN: 0 });
      const tier = String(t.tier);
      if (tier in bucket) bucket[tier] = (bucket[tier] ?? 0) + 1;
    }
    buckets.forEach((b, i) => {
      tierMix.push({
        label: `W${i + 1}`,
        REFLEX: b['REFLEX'] ?? 0,
        WORKFLOW: b['WORKFLOW'] ?? 0,
        MODEL: b['MODEL'] ?? 0,
        HUMAN: b['HUMAN'] ?? 0,
      });
    });
  }

  const needsHuman: HumanItem[] = openHuman.slice(0, MAX_NEEDS_HUMAN).map((r) => ({
    requestId: r.id,
    goal: r.goal,
    scope: r.targetScope,
    deadline: r.bid.deadline,
    state: r.state,
  }));

  const digestCount = requests.filter((r) => r.messageClass === 'NOTICE').length;

  // F26: omitted counts — the dashboard is a bounded window, so every capped
  // section also reports how many rows exist beyond it. A reader must be able
  // to tell "the queue is clear" from "the queue is longer than the window",
  // and the View-all pages are the recovery path for the omitted rows.
  const roomScopes = [...new Set(requests.flatMap((r) => [r.originScope, r.targetScope]))];
  const omitted = {
    needsHuman: Math.max(0, openHuman.length - MAX_NEEDS_HUMAN),
    rooms: Math.max(0, roomScopes.length - MAX_ROOMS),
    decisions: Math.max(0, decisions.length - COST_CURVE_BUDGET),
    cards: 0 as number,
  };

  const states: SkillState[] = ['CANDIDATE', 'QUARANTINE', 'SHADOW', 'BOUNDED_PILOT', 'PROMOTED', 'DEMOTED'];
  const compiler: CompilerColumn[] = [];
  for (const state of states) {
    const cards: CompilerColumn['cards'] = [];
    // Presentation read: drift signals are shown, never acted on — a
    // dashboard GET must not demote cards or append audit rows.
    for (const c of (await comp.list(tenant, { state })).slice(0, MAX_CARDS_PER_STATE)) {
      const desc = await describeCardReadOnly(db, comp, tenant, c.id);
      cards.push({
        id: c.id,
        intent: c.intent,
        version: c.version,
        scopeRoles: c.scopeRoles,
        trustTier: c.trustTier,
        trustGaps: desc.trustGaps,
        transfersPassed: desc.transfers.filter((t) => t.passed).length,
        transfersTotal: desc.transfers.length,
      });
    }
    compiler.push({ state, cards });
  }
  // F26: cards beyond each column's display window. comp.list returns ALL
  // cards in the state (the dashboard slices its own view), so the full list
  // length is the true total — a large tenant can see how many cards the
  // column is hiding.
  for (const state of states) {
    omitted.cards += Math.max(0, (await comp.list(tenant, { state })).length - MAX_CARDS_PER_STATE);
  }

  const scopes = [...new Set(requests.flatMap((r) => [r.originScope, r.targetScope]))];
  const rooms: RoomView[] = [];
  // Slice the room list BEFORE hydrating evidence: only the visible window
  // pays for ledger.get calls, so room count never drives evidence I/O.
  for (const scope of scopes.slice(0, MAX_ROOMS)) {
    const mine = requests.filter((r) => r.originScope === scope || r.targetScope === scope);
    const open = mine.filter((r) => !TERMINAL.includes(r.state)).length;
    const failed = mine.filter((r) => r.state === 'FAILED' || r.state === 'TERMINATED_BUDGET').length;
    let health: RoomView['health'] = 'healthy';
    if (open === 0 && mine.length > 0) health = 'idle';
    else if (failed > 0 || open > 3) health = 'degraded';
    const roomRequests: RoomView['requests'] = [];
    for (const r of mine.slice(-ROOM_REQUESTS)) {
      const evidence: RoomView['requests'][number]['evidence'] = [];
      for (const id of r.claimRefs) {
        const c = await ledger.get(tenant, id);
        if (c)
          evidence.push({
            id: c.id,
            kind: c.kind,
            tier: c.provenance.sourceTier,
            statement: c.statement,
            status: c.status,
            provisional: c.provisional,
          });
      }
      roomRequests.push({
        id: r.id,
        goal: r.goal,
        state: r.state,
        messageClass: r.messageClass,
        originScope: r.originScope,
        targetScope: r.targetScope,
        updatedAt: r.updatedAt,
        evidence,
      });
    }
    rooms.push({ scope, health, requests: roomRequests });
  }

  return {
    tenant,
    at: now,
    health: {
      staleFactRate: stats.staleFactRate,
      staleFactGate: 0.02,
      provenanceComplete: facts === 0 ? 1 : 1 - stats.factsWithoutGroundProvenance / facts,
      orphanClaims: stats.orphanClaims,
      contradictions: { open: pairs.length, oldestOpenHours, mttrHours: null, slaHours: 48 },
      spendToday: { dollars: dollarsToday },
      escalations: { open: openHuman.length, cap: opts.escalationCap ?? 3 },
      humanMinutes: { spentToday: humanSpent, budget: opts.humanMinutesBudget ?? 60 },
      refusalRate: (await coord.refusalStats(tenant)).rate,
    },
    costCurve,
    costTarget: opts.costTarget ?? 3.0,
    tierMix,
    needsHuman,
    digestCount,
    compiler,
    rooms,
    approvalLatency: await coord.approvalLatencyStats(tenant),
    // Cost-per-signal (TODO 4.1): the router is a passive read-model over
    // routing_decisions — no timers, no writes — so building a throwaway one
    // here is free and keeps every caller's report shape identical.
    costPerSignal: await new CognitiveRouter(db).costPerSignal(tenant),
    omitted,
  };
}

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
export const WORKFLOW_SCAN_CAP = 5000;

export const PENDING_DECISION_STATES = ['ADMITTED'] as const;
export const APPROVED_EXECUTING_STATES = ['ACCEPTED', 'IN_FLIGHT'] as const;

export interface RequestSummary {
  id: string;
  goal: string;
  state: string;
  messageClass: string;
  originScope: string;
  targetScope: string;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimSummary {
  id: string;
  subject: string;
  kind: string;
  status: string;
  scope: string;
  statement: string;
  createdAt: string;
}

export interface WorkflowSummary {
  id: string;
  kind: string;
  subject: string;
  summary: string | null;
  lifecycle: string;
  owner: string;
  updatedAt: string;
  url: string;
}

export interface SearchPage<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  hasMore: boolean;
}

export interface RequestSearchOptions {
  q?: string;
  states?: string[];
  scope?: string;
  messageClass?: string;
  workflowId?: string;
  since?: string;
  until?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface ClaimSearchOptions {
  q?: string;
  kinds?: string[];
  statuses?: string[];
  scope?: string;
  since?: string;
  until?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface WorkflowSearchOptions {
  q?: string;
  kinds?: string[];
  lifecycles?: string[];
  since?: string;
  until?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export interface ListState {
  q?: string;
  states?: string[];
  scopes?: string[];
  kinds?: string[];
  statuses?: string[];
  messageClass?: string;
  workflowId?: string;
  since?: string;
  until?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface NoResultsModel {
  title: string;
  body: string;
  clearUrl: string;
}

export interface ViewAllPaths {
  requests: string;
  claims: string;
  rooms: string;
  humanWork: string;
  workflows: string;
  digest: string;
}

const KNOWN_REQUEST_STATES = new Set<string>([...REQUEST_STATES]);
const KNOWN_MESSAGE_CLASSES = new Set<string>([...MESSAGE_CLASSES]);
const REQUEST_SORTS = new Set(['created_at', 'updated_at', 'goal', 'state']);
const CLAIM_SORTS = new Set(['created_at', 'subject', 'kind', 'status', 'scope']);

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (limit > SEARCH_MAX_LIMIT) {
    return SEARCH_MAX_LIMIT;
  }
  return limit;
}

function clampOffset(offset?: number): number {
  if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0) {
    return 0;
  }
  return offset;
}

function searchOrder(order?: string): 'ASC' | 'DESC' {
  if (order === undefined || order === 'asc') {
    return 'ASC';
  }
  if (order === 'desc') {
    return 'DESC';
  }
  throw new Error(`[search:ORDER] order must be asc or desc, got ${order}`);
}

function requestSortColumn(sort?: string): string {
  if (sort === undefined || sort === 'created_at') {
    return 'created_at';
  }
  if (REQUEST_SORTS.has(sort)) {
    return sort;
  }
  throw new Error(`[search:SORT] unknown request sort ${sort}`);
}

function claimSortColumn(sort?: string): string {
  if (sort === undefined || sort === 'created_at') {
    return 'created_at';
  }
  if (CLAIM_SORTS.has(sort)) {
    return sort;
  }
  throw new Error(`[search:SORT] unknown claim sort ${sort}`);
}

function parseCursor(cursor: string): { at: string; id: string } {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) {
    throw new Error('[search:CURSOR] malformed cursor');
  }
  const at = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  if (!at || !id) {
    throw new Error('[search:CURSOR] malformed cursor');
  }
  return { at, id };
}

function toRequestSummary(r: {
  id: unknown;
  goal: unknown;
  state: unknown;
  message_class: unknown;
  origin_scope: unknown;
  target_scope: unknown;
  parent_request: unknown;
  created_at: unknown;
  updated_at: unknown;
}): RequestSummary {
  return {
    id: String(r.id),
    goal: String(r.goal),
    state: String(r.state),
    messageClass: String(r.message_class),
    originScope: String(r.origin_scope),
    targetScope: String(r.target_scope),
    workflowId: r.parent_request === null || r.parent_request === undefined ? null : String(r.parent_request),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toClaimSummary(r: {
  id: unknown;
  subject: unknown;
  kind: unknown;
  status: unknown;
  scope: unknown;
  statement: unknown;
  created_at: unknown;
}): ClaimSummary {
  return {
    id: String(r.id),
    subject: String(r.subject),
    kind: String(r.kind),
    status: String(r.status),
    scope: String(r.scope),
    statement: String(r.statement),
    createdAt: String(r.created_at),
  };
}

export function isPendingDecision(state: string): boolean {
  return (PENDING_DECISION_STATES as readonly string[]).includes(state);
}

export function isApprovedOrExecuting(state: string): boolean {
  return (APPROVED_EXECUTING_STATES as readonly string[]).includes(state);
}

export function partitionRequestsByDecision<T extends { state: string }>(
  rows: T[],
): {
  pending: T[];
  active: T[];
  other: T[];
} {
  const pending: T[] = [];
  const active: T[] = [];
  const other: T[] = [];
  for (const row of rows) {
    if (isPendingDecision(row.state)) {
      pending.push(row);
    } else if (isApprovedOrExecuting(row.state)) {
      active.push(row);
    } else {
      other.push(row);
    }
  }
  return { pending, active, other };
}

export function viewAllPaths(): ViewAllPaths {
  return {
    requests: '/console/requests',
    claims: '/console/claims',
    rooms: '/console/rooms',
    humanWork: '/console/human-work',
    workflows: '/console/workflows',
    digest: '/console/digest',
  };
}

export async function searchRequests(
  db: AsyncDb,
  tenant: string,
  opts: RequestSearchOptions = {},
): Promise<SearchPage<RequestSummary>> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const dir = searchOrder(opts.order);
  const where: string[] = ['tenant = ?'];
  const args: unknown[] = [tenant];
  if (opts.q) {
    const like = `%${escapeLike(opts.q)}%`;
    where.push("(goal LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (opts.states && opts.states.length > 0) {
    for (const s of opts.states) {
      if (!KNOWN_REQUEST_STATES.has(s)) {
        throw new Error(`[search:STATE] unknown request state ${s}`);
      }
    }
    where.push(`state IN (${opts.states.map(() => '?').join(',')})`);
    args.push(...opts.states);
  }
  if (opts.scope) {
    where.push('(origin_scope = ? OR target_scope = ?)');
    args.push(opts.scope, opts.scope);
  }
  if (opts.messageClass) {
    if (!KNOWN_MESSAGE_CLASSES.has(opts.messageClass)) {
      throw new Error(`[search:CLASS] unknown message class ${opts.messageClass}`);
    }
    where.push('message_class = ?');
    args.push(opts.messageClass);
  }
  if (opts.workflowId) {
    where.push('parent_request = ?');
    args.push(opts.workflowId);
  }
  if (opts.since) {
    where.push('created_at >= ?');
    args.push(opts.since);
  }
  if (opts.until) {
    where.push('created_at <= ?');
    args.push(opts.until);
  }
  let orderClause: string;
  if (opts.cursor) {
    if (opts.sort && opts.sort !== 'created_at') {
      throw new Error('[search:CURSOR] cursor paginates the default created_at order');
    }
    const cursor = parseCursor(opts.cursor);
    if (dir === 'ASC') {
      where.push('(created_at > ? OR (created_at = ? AND id > ?))');
    } else {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    }
    args.push(cursor.at, cursor.at, cursor.id);
    orderClause = `created_at ${dir}, id ${dir}`;
  } else {
    orderClause = `${requestSortColumn(opts.sort)} ${dir}, id ${dir}`;
  }
  const filter = where.join(' AND ');
  const totalRow = (await db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${filter}`).get(...args)) as
    { n: unknown } | undefined;
  const total = Number(totalRow?.n ?? 0);
  const fetched = (await db
    .prepare(
      `SELECT id, goal, state, message_class, origin_scope, target_scope, parent_request, created_at, updated_at FROM requests WHERE ${filter} ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(...args, limit + 1, offset)) as {
    id: unknown;
    goal: unknown;
    state: unknown;
    message_class: unknown;
    origin_scope: unknown;
    target_scope: unknown;
    parent_request: unknown;
    created_at: unknown;
    updated_at: unknown;
  }[];
  const hasMore = fetched.length > limit;
  const rows = fetched.slice(0, limit).map(toRequestSummary);
  return { rows, total, limit, offset, truncated: hasMore || offset + rows.length < total, hasMore };
}

export async function searchClaims(
  db: AsyncDb,
  tenant: string,
  opts: ClaimSearchOptions = {},
): Promise<SearchPage<ClaimSummary>> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const dir = searchOrder(opts.order);
  const where: string[] = ['tenant = ?'];
  const args: unknown[] = [tenant];
  if (opts.q) {
    const like = `%${escapeLike(opts.q)}%`;
    where.push("(subject LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    args.push(...opts.kinds);
  }
  if (opts.statuses && opts.statuses.length > 0) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
    args.push(...opts.statuses);
  }
  if (opts.scope) {
    where.push('scope = ?');
    args.push(opts.scope);
  }
  if (opts.since) {
    where.push('created_at >= ?');
    args.push(opts.since);
  }
  if (opts.until) {
    where.push('created_at <= ?');
    args.push(opts.until);
  }
  let orderClause: string;
  if (opts.cursor) {
    if (opts.sort && opts.sort !== 'created_at') {
      throw new Error('[search:CURSOR] cursor paginates the default created_at order');
    }
    const cursor = parseCursor(opts.cursor);
    if (dir === 'ASC') {
      where.push('(created_at > ? OR (created_at = ? AND id > ?))');
    } else {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    }
    args.push(cursor.at, cursor.at, cursor.id);
    orderClause = `created_at ${dir}, id ${dir}`;
  } else {
    orderClause = `${claimSortColumn(opts.sort)} ${dir}, id ${dir}`;
  }
  const filter = where.join(' AND ');
  const totalRow = (await db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE ${filter}`).get(...args)) as
    { n: unknown } | undefined;
  const total = Number(totalRow?.n ?? 0);
  const fetched = (await db
    .prepare(
      `SELECT id, subject, kind, status, scope, statement, created_at FROM claims WHERE ${filter} ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(...args, limit + 1, offset)) as {
    id: unknown;
    subject: unknown;
    kind: unknown;
    status: unknown;
    scope: unknown;
    statement: unknown;
    created_at: unknown;
  }[];
  const hasMore = fetched.length > limit;
  const rows = fetched.slice(0, limit).map(toClaimSummary);
  return { rows, total, limit, offset, truncated: hasMore || offset + rows.length < total, hasMore };
}

export async function searchWorkflows(
  db: AsyncDb,
  tenant: string,
  opts: WorkflowSearchOptions = {},
): Promise<SearchPage<WorkflowSummary>> {
  let dir: 'asc' | 'desc' = 'asc';
  if (opts.order === 'desc') {
    dir = 'desc';
  } else if (opts.order !== undefined && opts.order !== 'asc') {
    throw new Error(`[search:ORDER] order must be asc or desc, got ${opts.order}`);
  }
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const pattern = `wedge:fanout:${escapeLike(tenant)}:%`;
  const rows = (await db.prepare("SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\'").all(pattern)) as {
    value: unknown;
  }[];
  const scanned: WorkflowSummary[] = [];
  let capped = false;
  for (const row of rows) {
    if (scanned.length >= WORKFLOW_SCAN_CAP) {
      capped = true;
      break;
    }
    let run: {
      id: unknown;
      tenant: unknown;
      kind: unknown;
      subject: unknown;
      summary: unknown;
      status: unknown;
      onBehalfOf: unknown;
      updatedAt: unknown;
    };
    try {
      run = JSON.parse(String(row.value)) as {
        id: unknown;
        tenant: unknown;
        kind: unknown;
        subject: unknown;
        summary: unknown;
        status: unknown;
        onBehalfOf: unknown;
        updatedAt: unknown;
      };
    } catch {
      continue;
    }
    if (run.tenant !== tenant || typeof run.id !== 'string' || !Array.isArray((run as { legs?: unknown }).legs)) {
      continue;
    }
    scanned.push({
      id: run.id,
      kind: typeof run.kind === 'string' ? run.kind : 'ship',
      subject: typeof run.subject === 'string' ? run.subject : run.id,
      summary: typeof run.summary === 'string' ? run.summary : null,
      lifecycle: typeof run.status === 'string' ? run.status : 'IN_PROGRESS',
      owner: typeof run.onBehalfOf === 'string' ? run.onBehalfOf : '',
      updatedAt: typeof run.updatedAt === 'string' ? run.updatedAt : '',
      url: `/console/workflows/${encodeURIComponent(run.id)}`,
    });
  }
  const q = opts.q ? opts.q.toLowerCase() : null;
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const lifecycles = opts.lifecycles ? new Set(opts.lifecycles) : null;
  const filtered = scanned.filter((w) => {
    if (kinds && !kinds.has(w.kind)) {
      return false;
    }
    if (lifecycles && !lifecycles.has(w.lifecycle)) {
      return false;
    }
    if (opts.since && w.updatedAt < opts.since) {
      return false;
    }
    if (opts.until && w.updatedAt > opts.until) {
      return false;
    }
    if (q && !`${w.subject} ${w.summary ?? ''} ${w.id}`.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) => {
    if (dir === 'asc') {
      return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
    }
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  return { rows: page, total, limit, offset, truncated: capped || hasMore, hasMore };
}

export async function listPendingDecisions(
  db: AsyncDb,
  tenant: string,
  opts: { scope?: string; limit?: number } = {},
): Promise<RequestSummary[]> {
  const limit = clampLimit(opts.limit);
  const where = ['tenant = ?', "message_class = 'REQUEST'", 'state = ?'];
  const args: unknown[] = [tenant, PENDING_DECISION_STATES[0]];
  if (opts.scope) {
    where.push('(origin_scope = ? OR target_scope = ?)');
    args.push(opts.scope, opts.scope);
  }
  const fetched = (await db
    .prepare(
      `SELECT id, goal, state, message_class, origin_scope, target_scope, parent_request, created_at, updated_at FROM requests WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(...args, limit)) as {
    id: unknown;
    goal: unknown;
    state: unknown;
    message_class: unknown;
    origin_scope: unknown;
    target_scope: unknown;
    parent_request: unknown;
    created_at: unknown;
    updated_at: unknown;
  }[];
  return fetched.map(toRequestSummary);
}

export async function listApprovedExecuting(
  db: AsyncDb,
  tenant: string,
  opts: { scope?: string; limit?: number } = {},
): Promise<RequestSummary[]> {
  const limit = clampLimit(opts.limit);
  const where = ['tenant = ?', "message_class = 'REQUEST'", 'state IN (?, ?)'];
  const args: unknown[] = [tenant, ...APPROVED_EXECUTING_STATES];
  if (opts.scope) {
    where.push('(origin_scope = ? OR target_scope = ?)');
    args.push(opts.scope, opts.scope);
  }
  const fetched = (await db
    .prepare(
      `SELECT id, goal, state, message_class, origin_scope, target_scope, parent_request, created_at, updated_at FROM requests WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(...args, limit)) as {
    id: unknown;
    goal: unknown;
    state: unknown;
    message_class: unknown;
    origin_scope: unknown;
    target_scope: unknown;
    parent_request: unknown;
    created_at: unknown;
    updated_at: unknown;
  }[];
  return fetched.map(toRequestSummary);
}

export function encodeListState(state: ListState): string {
  const params = new URLSearchParams();
  if (state.q) {
    params.set('q', state.q);
  }
  for (const s of state.states ?? []) {
    params.append('state', s);
  }
  for (const s of state.scopes ?? []) {
    params.append('scope', s);
  }
  for (const s of state.kinds ?? []) {
    params.append('kind', s);
  }
  for (const s of state.statuses ?? []) {
    params.append('status', s);
  }
  if (state.messageClass) {
    params.set('class', state.messageClass);
  }
  if (state.workflowId) {
    params.set('workflow', state.workflowId);
  }
  if (state.since) {
    params.set('since', state.since);
  }
  if (state.until) {
    params.set('until', state.until);
  }
  if (state.sort) {
    params.set('sort', state.sort);
  }
  if (state.order) {
    params.set('order', state.order);
  }
  if (state.limit !== undefined) {
    params.set('limit', String(state.limit));
  }
  if (state.offset !== undefined) {
    params.set('offset', String(state.offset));
  }
  if (state.cursor) {
    params.set('cursor', state.cursor);
  }
  return params.toString();
}

function decodeInt(value: string | null): number | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    return undefined;
  }
  return n;
}

export function decodeListState(search: string): ListState {
  const params = new URLSearchParams(search);
  const out: ListState = {};
  const q = params.get('q');
  if (q) {
    out.q = q;
  }
  const states = params.getAll('state');
  if (states.length > 0) {
    out.states = states;
  }
  const scopes = params.getAll('scope');
  if (scopes.length > 0) {
    out.scopes = scopes;
  }
  const kinds = params.getAll('kind');
  if (kinds.length > 0) {
    out.kinds = kinds;
  }
  const statuses = params.getAll('status');
  if (statuses.length > 0) {
    out.statuses = statuses;
  }
  const messageClass = params.get('class');
  if (messageClass) {
    out.messageClass = messageClass;
  }
  const workflow = params.get('workflow');
  if (workflow) {
    out.workflowId = workflow;
  }
  const since = params.get('since');
  if (since) {
    out.since = since;
  }
  const until = params.get('until');
  if (until) {
    out.until = until;
  }
  const sort = params.get('sort');
  if (sort) {
    out.sort = sort;
  }
  const order = params.get('order');
  if (order === 'asc' || order === 'desc') {
    out.order = order;
  }
  const limit = decodeInt(params.get('limit'));
  if (limit !== undefined) {
    out.limit = limit;
  }
  const offset = decodeInt(params.get('offset'));
  if (offset !== undefined) {
    out.offset = offset;
  }
  const cursor = params.get('cursor');
  if (cursor) {
    out.cursor = cursor;
  }
  return out;
}

export function listStateUrl(base: string, state: ListState): string {
  const query = encodeListState(state);
  if (query) {
    return `${base}?${query}`;
  }
  return base;
}

export function clearFilterUrl(base: string, keep?: { sort?: string; order?: string; limit?: number }): string {
  const state: ListState = {};
  if (keep?.sort) {
    state.sort = keep.sort;
  }
  if (keep?.order) {
    state.order = keep.order;
  }
  if (keep?.limit !== undefined) {
    state.limit = keep.limit;
  }
  return listStateUrl(base, state);
}

export function noResultsModel(base: string, state: ListState): NoResultsModel {
  const active: string[] = [];
  if (state.q) {
    active.push(`search "${state.q}"`);
  }
  for (const s of state.states ?? []) {
    active.push(`status ${s}`);
  }
  for (const s of state.scopes ?? []) {
    active.push(`scope ${s}`);
  }
  for (const s of state.kinds ?? []) {
    active.push(`kind ${s}`);
  }
  for (const s of state.statuses ?? []) {
    active.push(`status ${s}`);
  }
  if (state.messageClass) {
    active.push(`type ${state.messageClass}`);
  }
  if (state.workflowId) {
    active.push(`workflow ${state.workflowId}`);
  }
  if (state.since) {
    active.push(`since ${state.since}`);
  }
  if (state.until) {
    active.push(`until ${state.until}`);
  }
  let body = 'No matching work found.';
  if (active.length > 0) {
    body = `No matching work for ${active.join(', ')}.`;
  }
  return {
    title: 'No results',
    body,
    clearUrl: clearFilterUrl(base, { sort: state.sort, order: state.order, limit: state.limit }),
  };
}
