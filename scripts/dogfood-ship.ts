import { execFileSync } from 'node:child_process';
import { openDb, migrate, type AsyncDb } from '../src/core/db.ts';
import { createLedger, type Ledger } from '../src/ledger/ledger.ts';
import { createCoordinator, DEFAULT_LIMITS, type Coordinator } from '../src/coord/coordinator.ts';
import {
  gitHubReleasesCollector,
  ingestEvents,
  stageToInbox,
  ingestInboxBatch,
  type Collector,
  type RawEvent,
} from '../src/ingest/collectors.ts';
import {
  summarizeRelease,
  isKnownRelease,
  markReleaseKnown,
  fanOutWorkflow,
  checkDraft,
  WedgeError,
} from '../src/wedge/ship.ts';
import { requireCompleteFanOut } from '../src/wedge/fanout-workflow.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';

/**
 * Dogfood: run Vital's own wedge on Vital's own changes.
 *
 * The §15 wedge needs ≥50 launches to prove itself, and we have no design
 * partners. We do have a repo that ships. So Vital becomes its own first
 * tenant: its commits/releases are ingested as OBSERVATIONs from a
 * SYSTEM_OF_RECORD-adjacent source, a named human curates them to VERIFIED,
 * the deterministic change summary fans work out through the scheduler, a
 * draft is checked against the Ledger, a DECISION freezes its Context
 * Bundle, an OUTCOME is measured against a basis, and the whole run becomes
 * a TRACE eligible for compilation.
 *
 * Offline by default: reads `git log` of this checkout. `--live` reads the
 * real GitHub releases API (needs GITHUB_TOKEN in the environment — the key
 * is read at the boundary and never stored, logged, or ledgered).
 *
 *   npm run dogfood -- --db var/dogfood.db --tenant vital
 *
 * F15 remediation: this pipeline exercises the ship spine but CANNOT measure
 * real business outcomes — there is no human review and no customer system
 * here. Every derived record (decision, trace, skill card) is tagged
 * synthetic via `meta` keys (`synthetic:*`), the trace intent is prefixed
 * `simulated:`, and NO outcome is recorded at all — the old hardcoded
 * predicted=240/actual=90 was fabricated evidence counted as real learning.
 *
 * Exit 0 means the whole spine ran end to end and was written down honestly:
 * simulated runs are excluded from product metrics and learning claims.
 */

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const has = (name: string): boolean => process.argv.includes(name);

const dbPath = arg('--db', 'var/dogfood.db');
const tenant = arg('--tenant', 'vital');
const now = new Date().toISOString();

function originRepo(): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (m) return m[1]!;
  } catch {
    /* no remote: this is a local checkout */
  }
  return 'vital/self';
}

/** This checkout's own history, newest first — the offline release source. */
function selfCommitEvents(): RawEvent[] {
  const log = execFileSync('git', ['log', '-n', '8', '--pretty=format:%H%x1f%s%x1f%cI'], { encoding: 'utf8' });
  return log
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [sha, subject, date] = line.split('\x1f');
      return {
        source: 'github:vital/self:commits',
        uri: `https://github.com/vital/self/commit/${sha}`,
        fingerprint: sha!,
        occurredAt: date ?? now,
        summary: `vital ${sha!.slice(0, 7)}: ${subject}`,
        payload: { sha, subject, source: 'git-log' },
      };
    });
}

const SELF_COLLECTOR: Collector = {
  name: 'github:vital/self:commits',
  sourceTier: 'PRIMARY',
  extractor: 'self-git-log',
  extractorVersion: '1.0.0',
  poll: async (db: AsyncDb, now: string, tenant = 'vital') => {
    const events = selfCommitEvents();
    await stageToInbox(db, tenant, 'github:vital/self:commits', events, now);
    return events;
  },
};

export interface ShipPipelineResult {
  release: string;
  claimIds: string[];
  alreadyKnown: boolean;
  /**
   * F15: the dogfood pipeline cannot measure real business outcomes (no
   * human review, no customer system) — so when it exercises the full spine
   * it says so. `simulated: true` marks every derived record as synthetic
   * so attribution/eval/metrics code can exclude them instead of counting
   * fabricated success. Real measured runs set `simulated: false`.
   */
  simulated: boolean;
  summary: Awaited<ReturnType<typeof summarizeRelease>>;
  legs: Record<'marketing' | 'customer' | 'sales' | 'product' | 'finance', string> | null;
  fanOutRunId: string | null;
  fanOutStatus: string | null;
  verdict: Awaited<ReturnType<typeof checkDraft>> | null;
  decisionId: string | null;
  /** null unless this run measured a real outcome — simulated runs never do. */
  outcomeBasis: string | null;
  traceId: string | null;
  cardId: string | null;
  refusalRate: number | null;
}

/**
 * A failed draft check ends the run (F15 remediation): an unverifiable or
 * denylisted draft must not continue on to a decision, an outcome, a trace
 * and a compilable card — that is exactly how fabricated learning evidence
 * was being minted. The throw leaves the release unmarked so a corrected
 * retry re-runs the pipeline instead of skipping it.
 */
function assertDraftShips(verdict: { ok: boolean; unverified: string[]; deniedPhrases: string[] }): void {
  if (verdict.ok) return;
  const reasons = [...verdict.unverified, ...verdict.deniedPhrases].join(', ');
  throw new WedgeError('DRAFT_BLOCKED', `draft failed the claims checker: ${reasons}`);
}

/**
 * Steps 2–8 of the dogfood run, extracted for testability. The release is
 * marked known ONLY after every stage completes (why at the end: marking
 * before fan-out told retried runs "already processed" over unfinished
 * work — a crash mid-pipeline must retry the pipeline, not skip it). The
 * mark itself stays idempotent (meta upsert). Any stage failure throws
 * without marking, so the next run resumes instead of no-op-ing.
 */
export async function runShipPipeline(deps: {
  db: AsyncDb;
  ledger: Ledger;
  coord: Coordinator;
  comp: OrganizationalCompiler;
  tenant: string;
  now: string;
  collector: Collector;
  events: RawEvent[];
}): Promise<ShipPipelineResult> {
  const { db, ledger, coord, comp, tenant, now, collector, events } = deps;
  if (events.length === 0) throw new Error('no release events found');

  await stageToInbox(db, tenant, collector.name, events, now);
  const { claimIds: ingested } = await ingestInboxBatch(db, ledger, tenant, collector, {
    owner: 'human:founder',
    scope: 'engineering',
    now,
  });

  // ---- human curation: observations only enter reasoning once verified --
  for (const id of ingested) await ledger.verifyClaim(tenant, id, 'human:founder', now);

  // ---- deterministic, cited change summary ------------------------------
  // Re-runs must be idempotent: when this source already produced claims and
  // nothing new arrived, summarise the existing verified set rather than
  // failing on "a release with no cited changes".
  let claimIds = ingested;
  if (claimIds.length === 0) {
    claimIds = (await ledger.bySubject(tenant, collector.name)).map((c) => c.id);
    if (claimIds.length > 0) {
      console.log('dogfood: no new events; reusing the verified claims already on the ledger');
    }
  }
  const release = `vital-${now.slice(0, 10)}`;
  const items = [];
  for (const id of claimIds) {
    const c = await ledger.get(tenant, id);
    if (c) items.push({ text: c.statement, claimIds: [id], affected: ['engineering'] });
  }
  const summary = await summarizeRelease(ledger, tenant, release, items, now);
  if (await isKnownRelease(db, summary.summaryFingerprint)) {
    return {
      release,
      claimIds,
      alreadyKnown: true,
      simulated: true,
      summary,
      legs: null,
      fanOutRunId: null,
      fanOutStatus: null,
      verdict: null,
      decisionId: null,
      outcomeBasis: null,
      traceId: null,
      cardId: null,
      refusalRate: null,
    };
  }

  // ---- fan out through the scheduler, not through chat -------------------
  const fanOutRun = await fanOutWorkflow(db, coord, tenant, {
    release,
    claimIds,
    onBehalfOf: 'human:founder',
    now,
    summary: summary.whyItMatters,
  });
  requireCompleteFanOut(fanOutRun);
  const legs = {
    marketing: fanOutRun.legs.find((l) => l.key === 'marketing')!.requestId!,
    customer: fanOutRun.legs.find((l) => l.key === 'customer')!.requestId!,
    sales: fanOutRun.legs.find((l) => l.key === 'sales')!.requestId!,
    product: fanOutRun.legs.find((l) => l.key === 'product')!.requestId!,
    finance: fanOutRun.legs.find((l) => l.key === 'finance')!.requestId!,
  };

  // ---- a draft ships evidence or it does not ship ------------------------
  // F15: a failing check previously logged and continued — the run went on
  // to mint a decision, outcome, trace and card as if nothing was wrong.
  const draft = { text: `${release}: ${summary.whatChanged[0]?.text ?? ''}`, claimIds: [claimIds[0]!] };
  const verdict = await checkDraft(ledger, tenant, draft, now);
  assertDraftShips(verdict);

  // ---- decision + frozen Context Bundle ----------------------------------
  // F15: the approval here is script-asserted, not a human review, so the
  // decision is tagged synthetic and names dogfood as the actor. It must
  // never be counted as a human-governed approval in metrics or learning.
  const decision = await ledger.recordDecision({
    tenant,
    goal: `[SIMULATED dogfood run] ship-to-result: ${release}`,
    action: `launch pack prepared for ${release} (synthetic pipeline exercise, no human review)`,
    actionClass: 'ACT_REVERSIBLE',
    claimIds,
    decidedBy: 'agent:dogfood-script',
    approvedBy: undefined,
    scope: 'product',
    autonomy: 'approval',
    requestId: legs.marketing,
    now,
  });
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`synthetic:decision:${decision.id}`, 'dogfood-ship: script-asserted approval, not human-reviewed');

  // ---- outcome -----------------------------------------------------------
  // F15: the old run recorded a hardcoded predicted=240 / actual=90
  // "measurement" with a human verifier nobody verified as. The dogfood
  // pipeline cannot measure launch readiness — no human clock, no customer
  // system — so it records NO outcome at all. Real outcomes require a real
  // measurement basis; a placeholder number was worse than an absent one
  // because product metrics counted it as measured improvement.

  // ---- the run becomes a compilable TRACE --------------------------------
  // F15: outcome=SUCCESS and confidence=0.92 were hardcoded; the confidence
  // below is now the summary's own cited-claim confidence, and the trace's
  // intent is tagged `simulated:` so compilation input and router metrics
  // can exclude synthetic traces from learning evidence.
  const traceId = `trc_${crypto.randomUUID()}`;
  const steps = summary.whatChanged.map((w) => w.text);
  await db
    .prepare(
      `INSERT INTO traces (id, tenant, request_id, scope, task_type, intent, steps, tier, outcome,
         cost_json, skill_card, router_confidence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      traceId,
      tenant,
      legs.marketing,
      'product',
      'release.summarize',
      'simulated:ship-to-result',
      JSON.stringify(steps),
      'WORKFLOW',
      'SUCCESS',
      JSON.stringify({ simulated: true, reason: 'dogfood pipeline exercise, not a real measured run' }),
      null,
      summary.confidence,
      now,
    );
  const card = await comp.compile({
    tenant,
    intent: 'simulated:ship-to-result',
    predicates: ['release_detected', 'claims_verified', 'simulated_run'],
    steps,
    tests: ['regression:ship-to-result.v1'],
    toolGrants: ['ledger.read', 'coord.request'],
    validatedAtTier: 'WORKFLOW',
    originScope: 'product',
    originModels: ['claude'],
    scopeRoles: ['product'],
    owner: 'agent:dogfood-script',
    traceIds: [traceId],
    evalRef: 'evals/ship-to-result.v1',
    now,
  });
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`synthetic:skill_card:${card.id}`, 'dogfood-ship: compiled from simulated traces, not pilot evidence');

  // Known LAST, only on full completion — every stage above succeeded, so a
  // retried run may now safely read "already processed" and skip.
  await markReleaseKnown(db, summary.summaryFingerprint, release);

  const refusal = await coord.refusalStats(tenant);

  return {
    release,
    claimIds,
    alreadyKnown: false,
    simulated: true,
    summary,
    legs,
    fanOutRunId: fanOutRun.id,
    fanOutStatus: fanOutRun.status,
    verdict,
    decisionId: decision.id,
    outcomeBasis: null,
    traceId,
    cardId: card.id,
    refusalRate: refusal.rate,
  };
}

async function main(): Promise<void> {
  const db = openDb(dbPath);
  await migrate(db);
  const ledger = createLedger(db);
  const comp = new OrganizationalCompiler(db);
  const coord = createCoordinator(db, { ...DEFAULT_LIMITS, maxHumanEscalationsPerDay: 20 });

  // ---- 1. L0 collect ------------------------------------------------------
  let collector = SELF_COLLECTOR;
  let events: RawEvent[];
  if (has('--live')) {
    const repo = arg('--repo', originRepo());
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error(`bad --repo "${repo}" (want owner/name)`);
    const token = process.env.GITHUB_TOKEN;
    collector = gitHubReleasesCollector(owner, name, (url) =>
      fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
    events = await collector.poll(db, now, tenant);
  } else {
    events = await collector.poll(db, now, tenant);
  }
  const r = await runShipPipeline({ db, ledger, coord, comp, tenant, now, collector, events });
  if (r.alreadyKnown) {
    console.log('\n\x1b[1mVital dogfood — already processed\x1b[0m');
    console.log(`release  ${r.release}`);
    console.log(`claims   ${r.claimIds.length} verified claim(s) on the ledger`);
    console.log('reason   summaryFingerprint already recorded — no duplicate decision (idempotent)\n');
    await db.close();
    return;
  }
  const summary = r.summary;
  const legs = r.legs!;
  const verdict = r.verdict!;
  const refusalRate = r.refusalRate ?? 0;

  console.log(`\n\x1b[1mVital dogfood — Ship-to-Result on its own changes\x1b[0m`);
  console.log(`db       ${dbPath}   tenant ${tenant}`);
  console.log(`source   ${collector.name} (${has('--live') ? 'live GitHub' : 'offline git log'})`);
  console.log(`release  ${r.release}`);
  console.log(`claims   ${r.claimIds.length} OBSERVATION(s) ingested, verified by human:founder`);
  console.log(`summary  ${summary.whatChanged.length} cited bullet(s), confidence ${summary.confidence.toFixed(2)}`);
  console.log(`affected ${summary.affected.join(', ')}`);
  console.log(
    `fan-out  marketing=${legs.marketing} customer=${legs.customer} sales=${legs.sales} product=${legs.product} finance=${legs.finance}`,
  );
  console.log(
    `draft    ${verdict.ok ? 'citations resolve, no denylisted phrase' : `BLOCKED (${[...verdict.unverified, ...verdict.deniedPhrases].join(', ')})`}`,
  );
  console.log(`decision ${r.decisionId} (frozen Context Bundle, tagged synthetic)`);
  console.log('outcome  none — the dogfood pipeline cannot measure real outcomes (F15)');
  console.log(`trace    ${r.traceId} → skill card ${r.cardId} (both tagged simulated)`);
  console.log(`refusal  ${(refusalRate * 100).toFixed(0)}% of REQUESTs (0% means sycophants)`);
  console.log('note     all derived records are tagged synthetic in `meta` and excluded from learning claims\n');

  await db.close();
}

// Importing this module for `runShipPipeline` (tests) must not run the CLI:
// tsx executes the file body on import, so the run is env-gated. The CLI
// path never sets the flag; tests set VITAL_DOGFOOD_NO_MAIN=1 first.
if (process.env['VITAL_DOGFOOD_NO_MAIN'] !== '1') {
  main().catch((e: unknown) => {
    console.error(`DOGFOOD FAIL: ${(e as Error).message}`);
    process.exit(1);
  });
}
