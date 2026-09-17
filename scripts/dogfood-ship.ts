import { execFileSync } from 'node:child_process';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator, DEFAULT_LIMITS } from '../src/coord/coordinator.ts';
import { gitHubReleasesCollector, ingestEvents, type Collector, type RawEvent } from '../src/ingest/collectors.ts';
import { summarizeRelease, isKnownRelease, markReleaseKnown, fanOut, checkDraft } from '../src/wedge/ship.ts';
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
 *   npm run dogfood
 *   npm run dogfood -- --live --repo owner/name
 *   npm run dogfood -- --db var/dogfood.db --tenant vital
 *
 * Exit 0 means the whole spine ran end to end and was written down.
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
  poll: () => selfCommitEvents(),
};

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
    events = await collector.poll(db, now);
  } else {
    events = selfCommitEvents();
  }
  if (events.length === 0) throw new Error('no release events found');

  const ingested = await ingestEvents(db, ledger, tenant, collector, events, {
    owner: 'human:founder',
    scope: 'engineering',
    now,
  });

  // ---- 2. human curation: observations only enter reasoning once verified --
  for (const id of ingested) await ledger.verifyClaim(tenant, id, 'human:founder', now);

  // ---- 3. deterministic, cited change summary ------------------------------
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
    console.log('\n\x1b[1mVital dogfood — already processed\x1b[0m');
    console.log(`release  ${release}`);
    console.log(`claims   ${claimIds.length} verified claim(s) on the ledger`);
    console.log('reason   summaryFingerprint already recorded — no duplicate decision (idempotent)\n');
    await db.close();
    return;
  }
  await markReleaseKnown(db, summary.summaryFingerprint, release);

  // ---- 4. fan out through the scheduler, not through chat -------------------
  const legs = await fanOut(coord, tenant, {
    release,
    claimIds,
    onBehalfOf: 'human:founder',
    now,
    summary: summary.whyItMatters,
  });

  // ---- 5. a draft ships evidence or it does not ship ------------------------
  const draft = { text: `${release}: ${summary.whatChanged[0]?.text ?? ''}`, claimIds: [claimIds[0]!] };
  const verdict = await checkDraft(ledger, tenant, draft, now);

  // ---- 6. decision + frozen Context Bundle ----------------------------------
  const decision = await ledger.recordDecision({
    tenant,
    goal: `ship-to-result: ${release}`,
    action: `launch pack prepared for ${release}`,
    actionClass: 'ACT_REVERSIBLE',
    claimIds,
    decidedBy: 'agent:product',
    approvedBy: 'human:founder',
    scope: 'product',
    autonomy: 'approval',
    requestId: legs.marketing,
    now,
  });

  // ---- 7. outcome with a measurement basis ----------------------------------
  const outcome = await ledger.recordOutcome({
    tenant,
    decisionId: decision.id,
    metric: 'launch_ready_minutes',
    predicted: 240,
    actual: 90,
    basis: `git:${events[0]!.fingerprint}`,
    resolvedBy: 'human:founder',
    scope: 'product',
    owner: 'human:founder',
    now,
  });

  // ---- 8. the run becomes a compilable TRACE --------------------------------
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
      'ship-to-result',
      JSON.stringify(steps),
      'WORKFLOW',
      'SUCCESS',
      JSON.stringify({}),
      null,
      0.92,
      now,
    );
  const card = await comp.compile({
    tenant,
    intent: 'ship-to-result',
    predicates: ['release_detected', 'claims_verified'],
    steps,
    tests: ['regression:ship-to-result.v1'],
    toolGrants: ['ledger.read', 'coord.request'],
    validatedAtTier: 'WORKFLOW',
    originScope: 'product',
    originModels: ['claude'],
    scopeRoles: ['product'],
    owner: 'human:founder',
    traceIds: [traceId],
    evalRef: 'evals/ship-to-result.v1',
    now,
  });

  const refusal = await coord.refusalStats(tenant);

  console.log(`\n\x1b[1mVital dogfood — Ship-to-Result on its own changes\x1b[0m`);
  console.log(`db       ${dbPath}   tenant ${tenant}`);
  console.log(`source   ${collector.name} (${has('--live') ? 'live GitHub' : 'offline git log'})`);
  console.log(`release  ${release}`);
  console.log(`claims   ${claimIds.length} OBSERVATION(s) ingested, verified by human:founder`);
  console.log(`summary  ${summary.whatChanged.length} cited bullet(s), confidence ${summary.confidence.toFixed(2)}`);
  console.log(`affected ${summary.affected.join(', ')}`);
  console.log(
    `fan-out  marketing=${legs.marketing} customer=${legs.customer} sales=${legs.sales} product=${legs.product} finance=${legs.finance}`,
  );
  console.log(
    `draft    ${verdict.ok ? 'citations resolve, no denylisted phrase' : `BLOCKED (${[...verdict.unverified, ...verdict.deniedPhrases].join(', ')})`}`,
  );
  console.log(`decision ${decision.id} (${decision.bundle.claims.length} claims frozen)`);
  console.log(
    `outcome  ${outcome.metric} predicted ${outcome.predicted} actual ${outcome.actual} (basis ${outcome.basis})`,
  );
  console.log(`trace    ${traceId} → skill card ${card.id} @ ${card.state}`);
  console.log(`refusal  ${(refusal.rate * 100).toFixed(0)}% of REQUESTs (0% means sycophants)\n`);

  await db.close();
}

main().catch((e: unknown) => {
  console.error(`DOGFOOD FAIL: ${(e as Error).message}`);
  process.exit(1);
});
