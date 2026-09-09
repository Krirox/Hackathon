import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { weakestTier } from '../src/ledger/ledger.ts';
import { exportLedger } from '../src/ledger/export.ts';
import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, rejects } from './helpers.ts';
console.log('\n\x1b[1mReality Ledger — epistemic invariants\x1b[0m');

T('I1: an agent cannot mint a FACT', async () => {
  const { ledger } = await fresh();
  await rejects(
    async () =>
      await ledger.append({
        tenant: TEN,
        subject: 'revenue',
        kind: 'FACT',
        statement: 'ARR is $4M',
        confidence: 0.9,
        provenance: sor(),
        observedAt: NOW,
        validFrom: NOW,
        owner: 'agent:fin',
        scope: 'finance',
        authorType: 'agent',
      }),
    'EPISTEMIC_GUARD',
  );
});

T('I1: a system-of-record writer CAN mint a FACT', async () => {
  const { ledger } = await fresh();
  const c = await ledger.append({
    tenant: TEN,
    subject: 'revenue',
    kind: 'FACT',
    statement: 'ARR is $4M',
    confidence: 1,
    provenance: sor(),
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:linear',
    scope: 'finance',
    authorType: 'system',
  });
  eq(c.status, 'VERIFIED');
});

T('I2: FACT with SELF_SERVED provenance is rejected even from system', async () => {
  const { ledger } = await fresh();
  await rejects(
    async () =>
      await ledger.append({
        tenant: TEN,
        subject: 'acme',
        kind: 'FACT',
        statement: 'Acme is #1',
        confidence: 0.9,
        observedAt: NOW,
        validFrom: NOW,
        owner: 'sync:x',
        scope: 'market',
        authorType: 'system',
        provenance: { ...sor(), sourceTier: 'SELF_SERVED' },
      }),
    'UNGOUNDED_FACT',
  );
});

T('agent BELIEF from single source lands as CANDIDATE, not VERIFIED', async () => {
  const { ledger } = await fresh();
  const c = await ledger.append({
    tenant: TEN,
    subject: 'acme',
    kind: 'BELIEF',
    statement: 'they may be repricing',
    confidence: 0.4,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:mkt',
    scope: 'market',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  eq(c.status, 'CANDIDATE');
});

T('I5: staleness sweep marks expired facts STALE', async () => {
  const { ledger } = await fresh();
  await ledger.append({
    tenant: TEN,
    subject: 'pricing',
    kind: 'FACT',
    statement: 'Pro is $99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: DAY_LATER,
    owner: 'sync:stripe',
    scope: 'finance',
    authorType: 'system',
    provenance: sor(),
  });
  eq((await ledger.stats(TEN, NOW)).staleFactRate, 0, 'not stale yet:');
  const ids = await ledger.markStale(TEN, DAY_LATER);
  eq(ids.length, 1);
  eq((await ledger.stats(TEN, DAY_LATER)).staleFactRate, 1);
});

T('I6: contextFor excludes stale, provisional and unverified claims', async () => {
  const { ledger } = await fresh();
  const good = await ledger.append({
    tenant: TEN,
    subject: 'a',
    kind: 'FACT',
    statement: 'solid',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const prov = await ledger.append({
    tenant: TEN,
    subject: 'b',
    kind: 'FACT',
    statement: 'inferred at onboarding',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provisional: true,
    provenance: sor(),
  });
  const expiring = await ledger.append({
    tenant: TEN,
    subject: 'c',
    kind: 'FACT',
    statement: 'about to expire',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const belief = await ledger.append({
    tenant: TEN,
    subject: 'd',
    kind: 'BELIEF',
    statement: 'guess',
    confidence: 0.3,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:q',
    scope: 'x',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  const ctx = (await ledger.contextFor(TEN, [good.id, prov.id, expiring.id, belief.id], DAY_LATER)).map((c) => c.id);
  eq(ctx, [good.id]);
});

T('I4: contradiction flips both claims to DISPUTED', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'churn',
    kind: 'FACT',
    statement: 'churn 2%',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const b = await ledger.append({
    tenant: TEN,
    subject: 'churn',
    kind: 'FACT',
    statement: 'churn 9%',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, a.id, b.id, 'contradicts');
  eq((await ledger.get(TEN, a.id))!.status, 'DISPUTED');
  eq((await ledger.get(TEN, b.id))!.status, 'DISPUTED');
  eq((await ledger.contradictions(TEN, a.id)).length, 1);
});

T('append-only: supersede marks old claim SUPERSEDED, history kept', async () => {
  const { ledger } = await fresh();
  const old = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: '$99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const neu = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: '$79',
    confidence: 1,
    observedAt: DAY_LATER,
    validFrom: DAY_LATER,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, neu.id, old.id, 'supersedes');
  eq((await ledger.get(TEN, old.id))!.status, 'SUPERSEDED');
  eq((await ledger.bySubject(TEN, 'price')).length, 1, 'live view:');
  eq((await ledger.bySubject(TEN, 'price', { includeStale: true })).length, 2, 'history view:');
});

console.log('\n\x1b[1mDecision records — replayable basis\x1b[0m');

const decIn = (claimIds: string[], over: Record<string, unknown> = {}) => ({
  tenant: TEN,
  goal: 'ship the EU flag',
  action: 'enable flag eu_streaming',
  actionClass: 'ACT_REVERSIBLE' as const,
  claimIds,
  decidedBy: 'human:priya',
  scope: 'engineering',
  autonomy: 'approval' as const,
  now: NOW,
  ...over,
});

T('recordDecision freezes the exact claim versions + replay verifies', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'flag',
    kind: 'FACT',
    statement: 'flag exists',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const d = await ledger.recordDecision(decIn([a.id]));
  eq(d.bundle.claims.length, 1);
  eq(d.bundle.claims[0]!.seq, a.seq);
  const r = await ledger.replayDecision(TEN, d.id);
  eq(r.record.id, d.id);
  eq(r.drift[0]!.drifted, false);
});

T('replay shows drift when the basis is superseded later', async () => {
  const { ledger } = await fresh();
  const old = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: '$99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const d = await ledger.recordDecision(decIn([old.id]));
  const neu = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: '$79',
    confidence: 1,
    observedAt: DAY_LATER,
    validFrom: DAY_LATER,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, neu.id, old.id, 'supersedes');
  const r = await ledger.replayDecision(TEN, d.id);
  eq(r.drift[0]!.drifted, true, 'basis moved since the decision:');
  eq(r.drift[0]!.frozenStatus, 'VERIFIED');
  eq(r.drift[0]!.currentStatus, 'SUPERSEDED');
});

T('a decision with no basis is refused', async () => {
  const { ledger } = await fresh();
  await rejects(async () => await ledger.recordDecision(decIn([])), 'UNGROUNDED_DECISION');
});

T('a decision citing an unknown claim is refused', async () => {
  const { ledger } = await fresh();
  await rejects(async () => await ledger.recordDecision(decIn(['clm_nope'])), 'MISSING_CLAIM');
});

T('ACT_IRREVERSIBLE without a named approver is refused', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'x',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await rejects(
    async () =>
      await ledger.recordDecision(decIn([a.id], { actionClass: 'ACT_IRREVERSIBLE', autonomy: 'human-command' })),
    'APPROVAL_REQUIRED',
  );
  await rejects(
    async () =>
      await ledger.recordDecision(
        decIn([a.id], { actionClass: 'ACT_IRREVERSIBLE', autonomy: 'autonomous', approvedBy: 'human:ceo' }),
      ),
    'AUTONOMY_VIOLATION',
  );
  const d = await ledger.recordDecision(
    decIn([a.id], { actionClass: 'ACT_IRREVERSIBLE', autonomy: 'human-command', approvedBy: 'human:ceo' }),
  );
  eq(d.approvedBy, 'human:ceo');
});

T('a tampered bundle fails replay instead of lying', async () => {
  const { db, ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'x',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const d = await ledger.recordDecision(decIn([a.id]));
  await db
    .prepare('UPDATE decisions SET context_bundle = ? WHERE id = ?')
    .run(JSON.stringify({ ...d.bundle, claims: [{ ...d.bundle.claims[0], statement: 'edited' }] }), d.id);
  await rejects(async () => await ledger.replayDecision(TEN, d.id), 'TAMPERED_BUNDLE');
});

T('recordOutcome needs a decision + a measurement basis', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'x',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const d = await ledger.recordDecision(decIn([a.id]));
  await rejects(
    async () =>
      await ledger.recordOutcome({
        tenant: TEN,
        decisionId: 'dec_nope',
        metric: 'adopt',
        actual: 1,
        basis: 'm',
        resolvedBy: 'h',
        scope: 'x',
        owner: 'h',
        now: NOW,
      }),
    'MISSING_DECISION',
  );
  const o = await ledger.recordOutcome({
    tenant: TEN,
    decisionId: d.id,
    metric: 'adopt',
    predicted: 0.2,
    actual: 0.31,
    basis: 'warehouse:adopt_q3',
    resolvedBy: 'human:priya',
    scope: 'x',
    owner: 'human:priya',
    now: NOW,
  });
  eq(o.actual, 0.31);
  const outs = (await ledger.bySubject(TEN, `decision:${d.id}`)).filter((c) => c.kind === 'OUTCOME');
  eq(outs.length, 1, 'outcome is a queryable claim:');
});

T('supersedeChain walks history; believedAt snapshots the past', async () => {
  const { ledger } = await fresh();
  const v1 = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'v1',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    now: NOW,
    provenance: sor(),
  });
  const v2 = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'v2',
    confidence: 1,
    observedAt: DAY_LATER,
    validFrom: DAY_LATER,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    now: DAY_LATER,
    provenance: sor(),
  });
  await ledger.link(TEN, v2.id, v1.id, 'supersedes');
  const ch = await ledger.supersedeChain(TEN, v1.id);
  eq(ch.history.length, 2);
  eq(ch.current!.id, v2.id);
  eq(
    (await ledger.believedAt(TEN, 'p', NOW)).map((c) => c.id),
    [v1.id],
  );
});

T('due predictions surface; voided ones retire', async () => {
  const { ledger } = await fresh();
  const p = await ledger.append({
    tenant: TEN,
    subject: 'churn',
    kind: 'PREDICTION',
    statement: 'churn falls',
    confidence: 0.6,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 'agent:m',
    scope: 'x',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  eq(
    (await ledger.duePredictions(TEN, DAY_LATER)).map((c) => c.id),
    [p.id],
  );
  await ledger.voidPrediction(TEN, p.id, DAY_LATER);
  eq((await ledger.get(TEN, p.id))!.status, 'RETIRED');
  eq((await ledger.duePredictions(TEN, DAY_LATER)).length, 0);
});

T('two writers sharing one file never corrupt ledger_seq', async () => {
  const path = join(tmpdir(), `vital-seq-${process.pid}.db`);
  const dbs: ReturnType<typeof openDb>[] = [];
  try {
    const mk = async () => {
      const db = openDb(path);
      await migrate(db);
      dbs.push(db);
      return createLedger(db);
    };
    const la = await mk();
    const lb = await mk();
    const put = async (l: ReturnType<typeof createLedger>, i: number) =>
      (
        await l.append({
          tenant: TEN,
          subject: 's',
          kind: 'OBSERVATION',
          statement: `w${i}`,
          confidence: 1,
          observedAt: NOW,
          validFrom: NOW,
          owner: 's',
          scope: 'x',
          authorType: 'agent',
          provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
        })
      ).seq;
    const seqs: number[] = [];
    for (let i = 0; i < 25; i++) {
      seqs.push(await put(la, i));
      seqs.push(await put(lb, 100 + i));
    }
    eq(
      [...seqs].sort((a, b) => a - b),
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  } finally {
    for (const db of dbs) await db.close();
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
});

T('weakestTier: a set is only as trustworthy as its worst tier', async () => {
  const { ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'a',
    kind: 'FACT',
    statement: 'solid',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const b = await ledger.append({
    tenant: TEN,
    subject: 'b',
    kind: 'BELIEF',
    statement: 'hunch',
    confidence: 0.3,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'agent:q',
    scope: 'x',
    authorType: 'agent',
    provenance: { ...sor(), sourceTier: 'SELF_SERVED' },
  });
  eq(weakestTier([a, b]), 'SELF_SERVED');
  eq(weakestTier([]), 'SINGLE_SOURCE');
});

T('adversarial: an agent trying all 11 kinds mints facts nowhere', async () => {
  const { ledger } = await fresh();
  const kinds = [
    'OBSERVATION',
    'MEASUREMENT',
    'FACT',
    'BELIEF',
    'ASSUMPTION',
    'HYPOTHESIS',
    'PREDICTION',
    'GOAL',
    'DECISION',
    'ACTION',
    'OUTCOME',
  ] as const;
  const threw: string[] = [];
  for (const kind of kinds) {
    try {
      await ledger.append({
        tenant: TEN,
        subject: 'adv',
        kind,
        statement: 'agent says so',
        confidence: 0.9,
        observedAt: NOW,
        validFrom: NOW,
        owner: 'agent:x',
        scope: 'x',
        authorType: 'agent',
        provenance: sor(),
      });
    } catch (e) {
      if ((e as Error).message.includes('EPISTEMIC_GUARD')) threw.push(kind);
      else throw e;
    }
  }
  eq(threw.sort(), ['FACT', 'GOAL', 'MEASUREMENT', 'OUTCOME']);
});

T('property: 300 random appends never orphan a claim or ground a fake fact', async () => {
  const { ledger } = await fresh();
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const kinds = [
    'OBSERVATION',
    'MEASUREMENT',
    'FACT',
    'BELIEF',
    'ASSUMPTION',
    'HYPOTHESIS',
    'PREDICTION',
    'GOAL',
    'DECISION',
    'ACTION',
    'OUTCOME',
  ] as const;
  const tiers = ['SYSTEM_OF_RECORD', 'MEASURED', 'PRIMARY', 'CORROBORATED', 'SINGLE_SOURCE', 'SELF_SERVED'] as const;
  const authors = ['agent', 'human', 'system'] as const;
  for (let i = 0; i < 300; i++) {
    try {
      await ledger.append({
        tenant: TEN,
        subject: `s${Math.floor(rnd() * 5)}`,
        kind: kinds[Math.floor(rnd() * kinds.length)]!,
        statement: `st${i}`,
        confidence: rnd(),
        observedAt: NOW,
        validFrom: NOW,
        owner: `o${Math.floor(rnd() * 3)}`,
        scope: 'x',
        authorType: authors[Math.floor(rnd() * authors.length)]!,
        provenance: { ...sor(), sourceTier: tiers[Math.floor(rnd() * tiers.length)]! },
      });
    } catch {
      /* guards are supposed to throw; the invariants below are what matter */
    }
  }
  const st = await ledger.stats(TEN, NOW);
  eq(st.orphanClaims, 0);
  eq(st.factsWithoutGroundProvenance, 0);
});

T('full ledger export carries claims, links, decisions, outcomes, audit', async () => {
  const { db, ledger } = await fresh();
  const a = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'x',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const b = await ledger.append({
    tenant: TEN,
    subject: 'p',
    kind: 'FACT',
    statement: 'y',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  await ledger.link(TEN, a.id, b.id, 'contradicts');
  const dec = await ledger.recordDecision({
    tenant: TEN,
    goal: 'g',
    action: 'a',
    actionClass: 'READ',
    claimIds: [a.id],
    decidedBy: 'h',
    scope: 'x',
    autonomy: 'autonomous',
    now: NOW,
  });
  await ledger.recordOutcome({
    tenant: TEN,
    decisionId: dec.id,
    metric: 'm',
    actual: 1,
    basis: 'warehouse:m',
    resolvedBy: 'h',
    scope: 'x',
    owner: 'h',
    now: NOW,
  });
  const dump = await exportLedger(db, TEN, NOW);
  eq(dump.version, 1);
  eq(dump.tenant, TEN);
  eq(dump.claims.length, 3, '2 FACTs + the OUTCOME claim recordOutcome appended:');
  eq(dump.claimLinks.length, 1);
  eq(dump.decisions.length, 1);
  eq(
    (dump.decisions[0] as { context_bundle: string }).context_bundle.includes(a.id),
    true,
    'bundles travel with decisions:',
  );
  eq(dump.outcomes.length, 1);
  eq(dump.audit.length > 0, true);
});
