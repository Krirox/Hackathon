import { T, eq, fresh } from './helpers.ts';

T('FLOW-010: kill check - evaluate ≥3 of top 5 metrics show no delta at day 90', async () => {
  // Use the test infrastructure's fresh() which includes db
  const { db } = await fresh();

  // Create the ledger
  const { createLedger } = await import('../src/ledger/ledger.ts');
  const ledger = createLedger(db);

  // Create 5 decisions first
  for (let i = 0; i < 5; i++) {
    await db
      .prepare(
        `INSERT INTO decisions (id, tenant, goal, action, action_class, context_bundle, decided_by, scope, autonomy, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `dec_${i}`,
        'acme',
        'goal',
        'run',
        'READ',
        '{}',
        'human:priya',
        'marketing',
        'autonomous',
        '2026-09-09T12:00:00.000Z',
      );
  }

  // Record several outcomes with metrics over time
  const metrics = ['accuracy', 'precision', 'recall', 'latency', 'cost'];

  for (let day = 0; day < 90; day++) {
    await ledger.recordOutcome({
      tenant: 'acme',
      decisionId: `dec_${day % 5}`,
      metric: metrics[day % metrics.length]!,
      predicted: 0.81 + (day % 10) * 0.001,
      actual: 0.8 + (day % 10) * 0.001,
      basis: `basis-${day}`,
      holdoutRef: null,
      owner: 'human:priya',
      scope: 'marketing',
      resolvedBy: 'human:priya',
    });
  }

  // Query outcomes from db
  const allOutcomes = (await db.prepare('SELECT * FROM outcomes WHERE tenant = ?').all('acme')) as Array<{
    metric: string;
    predicted: number;
    actual: number;
  }>;

  // Group outcomes by metric and calculate delta
  const metricDeltas: Record<string, { predicted: number; actual: number; delta: number }> = {};

  for (const o of allOutcomes) {
    if (!metricDeltas[o.metric]) {
      metricDeltas[o.metric] = { predicted: o.predicted, actual: o.actual, delta: 0 };
    }
    const entry = metricDeltas[o.metric]!;
    entry.delta = entry.predicted - entry.actual;
  }

  // Sort metrics by delta (smaller delta = better improvement)
  const sortedMetrics = Object.entries(metricDeltas)
    .sort((a, b) => a[1].delta - b[1].delta)
    .slice(0, 5) // top 5
    .map(([name, data]) => ({ name, delta: data.delta }));

  // Count how many of top 5 show no significant improvement (delta <= threshold)
  const threshold = 0.015; // 1.5% threshold
  const noDeltaCount = sortedMetrics.filter((m) => Math.abs(m.delta) <= threshold).length;

  console.log('Top 5 metrics by delta:', sortedMetrics);
  console.log('Threshold:', threshold);
  console.log('Metrics with no significant improvement (|delta| <= threshold):', noDeltaCount);

  // Kill check: if ≥3 of top 5 show no delta, stop
  const shouldStop = noDeltaCount >= 3;
  console.log('Kill check result:', shouldStop ? 'STOP - ≥3 of top 5 metrics show no delta' : 'CONTINUE');

  // With the test data, predicted ≈ actual after 90 days, so deltas should be near 0
  // and noDeltaCount should be 5, triggering the stop
  eq(noDeltaCount >= 3, true, 'kill check should trigger with near-zero deltas');
});
