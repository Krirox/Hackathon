import { integrityScreen, type IntegrityResult, type WorldSignal } from './integrity.ts';

/**
 * Poisoning red-team suite (TODO §6.3): synthetic attacks against the
 * Integrity Gate. A fake pricing page, a seeded repo, an astroturfed
 * thread — none may reach a DECISION, which here means none may screen
 * as ESCALATE. The suite runs against the gate contract, so it guards
 * every future gate implementation, not just today's.
 *
 * Full-funnel wiring (L0 collectors feeding L1 triage feeding this gate)
 * needs the §0.5 scheduler running; these fixtures plug straight into it
 * when it lands.
 */

export interface PoisonCase {
  name: string;
  signal: WorldSignal;
}

export function fakePricingPage(): PoisonCase {
  return {
    name: 'fake-pricing-page',
    signal: {
      uri: 'https://competitor.example/pricing',
      sourceTier: 'SELF_SERVED',
      corroborationPaths: ['competitor.example'],
    },
  };
}

export function seededRepoSignal(): PoisonCase {
  return {
    name: 'seeded-repo',
    signal: {
      uri: 'https://git.example/plausible-lib',
      sourceTier: 'SINGLE_SOURCE',
      corroborationPaths: ['git.example'],
    },
  };
}

export function astroturfedThread(): PoisonCase {
  return {
    name: 'astroturfed-thread',
    signal: {
      uri: 'https://forum.example/hype-thread',
      sourceTier: 'SINGLE_SOURCE',
      corroborationPaths: ['forum.example'],
      mention: { meanAccountAgeDays: 6, clusterSize: 48 },
    },
  };
}

/** A genuinely corroborated signal, so the suite also proves it can pass clean input. */
export function corroboratedFiling(): PoisonCase {
  return {
    name: 'corroborated-filing',
    signal: {
      uri: 'https://regulator.example/filing-88',
      sourceTier: 'CORROBORATED',
      corroborationPaths: ['regulator filing', 'earnings call transcript'],
    },
  };
}

export interface PoisonRun {
  passed: boolean;
  results: { name: string; verdict: IntegrityResult['verdict']; reasons: string[] }[];
}

/**
 * Every attack must screen CANDIDATE; the control must screen ESCALATE
 * (a suite that cannot pass clean input proves nothing). Inject the
 * screen function so gate revisions are tested, not just the current one.
 */
export function runPoisoningSuite(
  screen: (signal: WorldSignal) => IntegrityResult = integrityScreen,
  attacks: PoisonCase[] = [fakePricingPage(), seededRepoSignal(), astroturfedThread()],
  control: PoisonCase = corroboratedFiling(),
): PoisonRun {
  const results = attacks.map((a) => {
    const r = screen(a.signal);
    return { name: a.name, verdict: r.verdict, reasons: r.reasons };
  });
  const c = screen(control.signal);
  results.push({ name: `${control.name} (control)`, verdict: c.verdict, reasons: c.reasons });
  const passed =
    results.filter((r) => !r.name.endsWith('(control)')).every((r) => r.verdict === 'CANDIDATE') &&
    c.verdict === 'ESCALATE';
  return { passed, results };
}
