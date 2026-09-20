import type { AsyncDb } from '../core/db.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { type BuzzSurface } from './buzz.ts';
import { roomForScope, normalizeScope, loadRoomConfig, type RoomConfig } from './rooms.ts';
import { ScopeHealthEvaluator, type RoomHealthEvaluation } from './health.ts';
import type { CanonicalRoomDefinition } from './rooms.ts';

/** Nostr Kind 30023: Long-form Content / Pinned Room Canvas (NIP-23). */
export const BUZZ_CANVAS_KIND = 30023;

export interface LiveCanvasState {
  scope: string;
  roomName: string;
  channel: string;
  title: string;
  markdown: string;
  updatedAt: string;
  version: number;
}

export interface CanvasSynchronizerOptions {
  db: AsyncDb;
  tenant: string;
  compiler?: OrganizationalCompiler;
  ledger?: Ledger;
  surface?: BuzzSurface;
  now?: () => string;
}

/**
 * Read-only drift signal: the same EWMA the registry's peekDrift uses
 * (window 40, alpha 0.2, threshold 0.9, minimum 10 samples) computed from a
 * SELECT with no writes. Under 10 samples the EWMA is not meaningful and is
 * reported as null rather than dressed up as a number.
 */
async function cardEwma(
  db: AsyncDb,
  tenant: string,
  cardId: string,
  intent: string,
): Promise<{ ewma: number | null; samples: number }> {
  const window = 40;
  const alpha = 0.2;
  const rows = (await db
    .prepare(
      `SELECT outcome FROM traces WHERE tenant = ? AND intent = ? AND tier = 'WORKFLOW'
         AND skill_card = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(tenant, intent, cardId, window)) as { outcome: string }[];
  if (rows.length < 10) return { ewma: null, samples: rows.length };
  let ewma = 1;
  for (const r of [...rows].reverse()) {
    let s = ewma;
    if (r.outcome === 'SUCCESS') s = 1;
    else if (r.outcome === 'FAILURE') s = 0;
    ewma = alpha * s + (1 - alpha) * ewma;
  }
  return { ewma, samples: rows.length };
}

export class LiveCanvasSynchronizer {
  private readonly db: AsyncDb;
  private readonly tenant: string;
  private readonly compiler?: OrganizationalCompiler;
  private readonly ledger?: Ledger;
  private readonly surface?: BuzzSurface;
  private readonly now: () => string;
  private readonly evaluator: ScopeHealthEvaluator;

  constructor(opts: CanvasSynchronizerOptions) {
    this.db = opts.db;
    this.tenant = opts.tenant;
    this.compiler = opts.compiler;
    this.ledger = opts.ledger;
    this.surface = opts.surface;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.evaluator = new ScopeHealthEvaluator(opts.db, opts.tenant, {
      compiler: opts.compiler,
      ledger: opts.ledger,
    });
  }

  /** Generates the live epistemic canvas markdown tailored to the room's mission. */
  async generateCanvas(rawScope: string): Promise<LiveCanvasState> {
    const scope = normalizeScope(rawScope);
    const room = roomForScope(scope);
    const config = await loadRoomConfig(this.db, this.tenant, scope);
    const health = await this.evaluator.evaluateScope(scope);
    const at = this.now();

    let markdown: string;
    if (scope === 'risk') {
      markdown = await this.renderRiskMonitorCanvas(config, health, at);
    } else if (scope === 'core') {
      markdown = await this.renderRealityCoreCanvas(config, health, at);
    } else if (scope === 'finance') {
      markdown = await this.renderFinanceCanvas(config, health);
    } else if (scope === 'legal') {
      markdown = await this.renderComplianceCanvas(config, health);
    } else {
      markdown = await this.renderDefaultRoomCanvas(room, config, health, at);
    }

    return {
      scope,
      roomName: room.name,
      channel: room.channel,
      title: `#${room.name} Live Epistemic Canvas`,
      markdown,
      updatedAt: at,
      version: Math.floor(Date.parse(at) / 1000),
    };
  }

  /**
   * Render #risk-monitor: ledger exposure observations, real procedure
   * cards with their measured drift. Every row is a database read — the
   * canvas shows nothing when the ledger has nothing (the old version
   * rendered an invented counterparty table and a fabricated EWMA chart).
   */
  private async renderRiskMonitorCanvas(config: RoomConfig, health: RoomHealthEvaluation, at: string): Promise<string> {
    // 1. Real exposure observations from the Reality Ledger
    const exposures = (await this.db
      .prepare(
        `SELECT id, subject, statement, status, confidence FROM claims
         WHERE tenant = ? AND scope = ? AND kind = 'OBSERVATION'
         ORDER BY seq DESC LIMIT 8`,
      )
      .all(this.tenant, 'risk')) as {
      id: string;
      subject: string;
      statement: string;
      status: string;
      confidence: number;
    }[];

    // 2. Real procedure cards with measured drift
    let procedureSection: string;
    if (!this.compiler) {
      procedureSection = `_Procedure compiler not connected: no card data._`;
    } else {
      try {
        const cards = await this.compiler.list(this.tenant);
        const scoped = cards.filter((c) => c.originScope === 'risk');
        if (scoped.length === 0) {
          procedureSection = `_No procedure cards compiled for this scope yet._`;
        } else {
          const rows: string[] = [];
          for (const c of scoped) {
            const { ewma, samples } = await cardEwma(this.db, this.tenant, c.id, c.intent);
            const ewmaStr = ewma === null ? `insufficient samples (${samples})` : ewma.toFixed(3);
            let status = `\`${c.state}\``;
            if (c.state === 'PROMOTED') status = '🟢 PROMOTED';
            else if (c.state === 'DEMOTED') status = '🟡 DEMOTED';
            rows.push(`| \`${c.id}\` | \`${c.intent}\` | \`${c.validatedAtTier}\` | ${ewmaStr} | ${status} |`);
          }
          procedureSection = [
            `| Skill Card ID | Intent | Execution Tier | Drift EWMA (α=0.2, win=40) | State |`,
            `| :--- | :--- | :--- | :--- | :--- |`,
            ...rows,
          ].join('\n');
        }
      } catch (e) {
        // Compiler read failed: say so rather than rendering nothing or inventing rows.
        procedureSection = `_Procedure card read failed: ${String((e as Error).message ?? e).slice(0, 120)}_`;
      }
    }

    return [
      `# 📌 Live Epistemic Canvas: #risk-monitor`,
      `> **Room Status**: ${health.badge} \`${health.status.toUpperCase()}\` · **Updated**: \`${at}\` · **Autonomy**: \`${config.autonomy}\``,
      '',
      `## 1. Exposure Observations (Reality Ledger, scope \`risk\`)`,
      ...(exposures.length > 0
        ? [
            `| Claim ID | Subject | Statement | Status | Confidence |`,
            `| :--- | :--- | :--- | :--- | :--- |`,
            ...exposures.map(
              (e) =>
                `| \`[${e.id}]\` | \`${e.subject}\` | ${e.statement} | \`${e.status}\` | \`${(e.confidence ?? 1).toFixed(2)}\` |`,
            ),
          ]
        : [`_No exposure observations recorded in the Reality Ledger for scope \`risk\`._`]),
      '',
      `## 2. Procedure Cards & Measured Drift`,
      procedureSection,
      '',
      `---`,
      `*Every figure above is a live read from the Reality Ledger, traces, and compiler registry. Empty sections are empty: nothing here is simulated.*`,
    ].join('\n');
  }

  /**
   * Render #reality-core: the real claim table and the real derivation
   * graph from claim_links. The old version rendered a hand-drawn DAG of
   * invented claims and a fabricated "99.8% dedupe / 0.42s lag" stats block.
   */
  private async renderRealityCoreCanvas(config: RoomConfig, health: RoomHealthEvaluation, at: string): Promise<string> {
    const claims = (await this.db
      .prepare(
        `SELECT id, subject, statement, status, confidence, created_at FROM claims
         WHERE tenant = ? ORDER BY seq DESC LIMIT 6`,
      )
      .all(this.tenant)) as {
      id: string;
      subject: string;
      statement: string;
      status: string;
      confidence: number;
      created_at: string;
    }[];

    // Real derivation edges from claim_links
    const links = (await this.db
      .prepare(
        `SELECT l.from_id, l.to_id, l.link FROM claim_links l
         JOIN claims c1 ON c1.id = l.from_id AND c1.tenant = ?
         JOIN claims c2 ON c2.id = l.to_id AND c2.tenant = ?
         ORDER BY c1.seq DESC LIMIT 20`,
      )
      .all(this.tenant, this.tenant)) as { from_id: string; to_id: string; link: string }[];

    return [
      `# 📌 Live Epistemic Canvas: #reality-core`,
      `> **Epistemic Root**: ${health.badge} \`${health.status.toUpperCase()}\` · **Unreconciled Contradictions**: \`${health.contradictions}\` · **Updated**: \`${at}\``,
      '',
      `## 1. Derivation Graph (claim_links)`,
      ...(links.length > 0
        ? ['```text', ...links.map((l) => `[${l.from_id}] --${l.link}--> [${l.to_id}]`), '```']
        : [`_No claim links recorded yet: the derivation graph is empty._`]),
      '',
      `## 2. Canonical Reality Ledger State`,
      `| Claim ID | Subject | Statement | Status | Confidence |`,
      `| :--- | :--- | :--- | :--- | :--- |`,
      ...(claims.length > 0
        ? claims.map(
            (c) =>
              `| \`[${c.id}]\` | \`${c.subject}\` | ${c.statement} | \`${c.status}\` | \`${(c.confidence ?? 1).toFixed(2)}\` |`,
          )
        : [`_The Reality Ledger is empty: no claims recorded yet._`]),
      '',
      `---`,
      `*Claim graph served from the ledger by \`@${config.agentName}\`. No derived metric is shown unless it is computed from the rows above.*`,
    ].join('\n');
  }

  /**
   * Render #finance: the real budget gas gauge and spend rollups. The old
   * version displayed an invented "$0.0034 cost-per-signal" and a fake
   * "🟢 RECONCILED" verdict for a reconciliation process that does not exist.
   */
  private async renderFinanceCanvas(config: RoomConfig, health: RoomHealthEvaluation): Promise<string> {
    return [
      `# 📌 Live Epistemic Canvas: #finance`,
      `> **Budget Status**: ${health.badge} \`${health.status.toUpperCase()}\` · **Spend**: \`$${health.spendDollars.toFixed(2)} / $${health.spendCeilingDollars}\` (${health.budgetPercentage}%)`,
      '',
      `## 1. Spend Telemetry (from coordinator requests)`,
      `- **Dollars spent**: \`$${health.spendDollars.toFixed(2)}\` of ceiling \`$${health.spendCeilingDollars}\``,
      `- **Tokens spent**: \`${health.spendTokens.toLocaleString()} / ${health.spendCeilingTokens.toLocaleString()}\``,
      `- **Connected systems of record**: ${config.connectedSoRs.length > 0 ? config.connectedSoRs.map((s) => `\`${s}\``).join(', ') : '_none configured_'}`,
      `- **Cost-per-signal**: _not computed here: see the dashboard; a real figure requires measured routing outcomes, none of which this canvas fabricates._`,
      '',
      `## 2. Dynamic Budget Gas Gauge`,
      `\`\`\`text`,
      `Spend: [${'■'.repeat(Math.min(10, Math.floor(health.budgetPercentage / 10)))}${'□'.repeat(Math.max(0, 10 - Math.floor(health.budgetPercentage / 10)))}] ${health.budgetPercentage}%`,
      `Ceiling Headroom: $${Math.max(0, health.spendCeilingDollars - health.spendDollars).toFixed(2)}`,
      `\`\`\``,
      '',
      `---`,
      `*Financial telemetry maintained by \`@${config.agentName}\` from the requests table.*`,
    ].join('\n');
  }

  /**
   * Render #compliance: real governance state. The old version claimed
   * "Immutable Hash Chain: 🟢 VERIFIED" and "High-Risk Actions Unreviewed: 0"
   * — assertions with no verifier behind them.
   */
  private async renderComplianceCanvas(config: RoomConfig, health: RoomHealthEvaluation): Promise<string> {
    const auditRow = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ?`)
      .get(this.tenant)) as { n: number } | undefined;
    const auditRows = Number(auditRow?.n ?? 0);

    return [
      `# 📌 Live Epistemic Canvas: #compliance`,
      `> **Compliance Status**: ${health.badge} \`${health.status.toUpperCase()}\` · **Pending review gates**: \`${health.pendingApprovals}\` · **Kill-switch stops active**: \`${health.activeStops}\``,
      '',
      `## 1. Policy Posture (configured values, not audited verdicts)`,
      `| System Capability | Risk Category (policy) | Governance Mechanism |`,
      `| :--- | :--- | :--- |`,
      `| Cognitive Procedure Drift | Limited Risk | Trace EWMA monitoring + auto-demote |`,
      `| Autonomous External Action | High Risk | Human oversight: \`ACT_IRREVERSIBLE\` is human-command only |`,
      `| External Egress Collector | Limited Risk | Domain allowlist, fail-closed |`,
      '',
      `## 2. Audit & Calibration State`,
      `- **Audit log rows (append-only)**: \`${auditRows.toLocaleString()}\``,
      `- **Hash-chain verification**: _no automated chain verifier is wired yet: none is claimed here_`,
      `- **Honeytask calibration**: \`${config.verifiedCalibrated ? '🟢 CALIBRATED' : '🟡 UNCALIBRATED'}\``,
      '',
      `---`,
      `*Compliance posture maintained by \`@${config.agentName}\`. This canvas reports configured policy and real counts; it is not a certification.*`,
    ].join('\n');
  }

  /** Render default room canvas */
  private async renderDefaultRoomCanvas(
    room: CanonicalRoomDefinition,
    config: RoomConfig,
    health: RoomHealthEvaluation,
    at: string,
  ): Promise<string> {
    return [
      `# 📌 Live Epistemic Canvas: #${room.name}`,
      `> **Status**: ${health.badge} \`${health.status.toUpperCase()}\` · **Autonomy**: \`${config.autonomy}\` · **Updated**: \`${at}\``,
      '',
      `## 1. Operational Mission`,
      `> "${config.mission}"`,
      '',
      `## 2. Health & Budget Telemetry`,
      `- **Spend**: \`$${health.spendDollars.toFixed(2)} / $${health.spendCeilingDollars}\` (${health.budgetPercentage}% quota)`,
      `- **Pending Review Gates**: \`${health.pendingApprovals}\``,
      `- **Connected Systems of Record**: ${config.connectedSoRs.map((s) => `\`${s}\``).join(', ')}`,
      '',
      `---`,
      `*Maintained autonomously by \`@${config.agentName}\`.*`,
    ].join('\n');
  }

  /** Publishes or updates the live Canvas event on the Buzz Nostr relay in place */
  async publishCanvas(rawScope: string): Promise<LiveCanvasState> {
    const canvas = await this.generateCanvas(rawScope);
    if (!this.surface) return canvas;

    const createdAt = canvas.version;
    // Addressable canvas: `d` is stable per room so re-publishing repins one
    // document instead of piling up copies.
    const tags: string[][] = [
      ['d', `canvas:${canvas.scope}`],
      ['h', canvas.channel],
      ['s', canvas.scope],
      ['title', canvas.title],
      ['published_at', String(createdAt)],
    ];

    // The surface signs with the room agent's real key; a canvas that cannot
    // be signed must surface as a failure, not be silently dropped.
    await this.surface.publish({ kind: BUZZ_CANVAS_KIND, tags, content: canvas.markdown });

    return canvas;
  }
}
