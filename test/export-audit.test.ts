import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';
import {
  auditLinks,
  collectArtifactOwnership,
  createExportTracker,
  exportLedger,
  exportLedgerWithManifest,
  EXPORT_RETENTION_POLICY,
  filesystemArchivalProbe,
  streamExportLedger,
  exportLedgerStream,
  queryAudit,
  verifyArchivalDelivery,
  type ExportProgressEvent,
} from '../src/ledger/export.ts';

console.log('\n\x1b[1mLedger export and audit — FLOW-024\x1b[0m');

async function seedLedger() {
  const { db, ledger } = await fresh();
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'launch',
    kind: 'FACT',
    statement: 'shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'system',
    provenance: { ...sor(), retrievedAt: NOW, rawArtifactRef: 'sha256:abc' },
    now: NOW,
  });
  await ledger.append({
    tenant: TEN,
    subject: 'launch',
    kind: 'OBSERVATION',
    statement: 'saw it',
    confidence: 0.5,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'agent',
    provenance: { ...sor('https://x.example/2'), retrievedAt: NOW, rawArtifactRef: 'sha256:abc' },
    now: NOW,
  });
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(
      TEN,
      'human:priya',
      'APPROVE',
      `request:req_1`,
      `approved [claim:${claim.id}] [decision:dec_1] [receipt:rcpt_7]`,
      NOW,
    );
  return { db, ledger, claimId: claim.id };
}

T('FLOW-024: export is read-only and the manifest names contents plus omissions', async () => {
  const { db } = await seedLedger();
  const before = await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN);
  const { export: data, manifest } = await exportLedgerWithManifest(db, TEN, 'evidence-package', NOW);
  const after = await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN);
  eq(before, after);
  eq(data.tenant, TEN);
  eq(manifest.kind, 'evidence-package');
  eq(manifest.exportedAt, NOW);
  eq(manifest.contents.includes('claims'), true);
  eq(
    manifest.omissions.some((line) => line.includes('never exported')),
    true,
  );
  eq(
    manifest.omissions.some((line) => line.includes('bytes are not embedded')),
    true,
  );
  eq(manifest.counts.claims, 2);
  eq(manifest.counts.audit >= 1, true);
  const snapshot = await exportLedgerWithManifest(db, TEN, 'snapshot', NOW);
  eq(snapshot.manifest.kind, 'snapshot');
  eq(snapshot.manifest.note.includes('not a backup'), true);
  const backupRef = await exportLedgerWithManifest(db, TEN, 'backup-reference', NOW);
  eq(backupRef.manifest.contents, ['manifest-only']);
});

T('FLOW-024: artifact ownership metadata marks refs shared across claims', async () => {
  const { db } = await fresh();
  const { manifest } = await exportLedgerWithManifest(db, TEN, 'evidence-package', NOW);
  eq(manifest.artifacts, []);
  await seedLedger();
  const owned = collectArtifactOwnership([
    { id: 'a', raw_ref: 'sha256:abc' },
    { id: 'b', raw_ref: 'sha256:abc' },
    { id: 'c', raw_ref: null },
  ]);
  eq(owned, [{ ref: 'sha256:abc', claimIds: ['a', 'b'], shared: true }]);
});

T('FLOW-024: audit history is searchable, paginated, and tenant-isolated', async () => {
  const { db } = await seedLedger();
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run('other', 'human:x', 'APPROVE', 'request:req_9', 'other tenant row', NOW);
  const byActor = await queryAudit(db, TEN, { actor: 'human:priya', limit: 10 });
  eq(
    byActor.rows.every((row) => String(row.actor) === 'human:priya'),
    true,
  );
  eq(
    byActor.rows.every((row) => String(row.tenant) === TEN),
    true,
  );
  const byRequest = await queryAudit(db, TEN, { requestId: 'req_1' });
  eq(byRequest.total >= 1, true);
  const pageOne = await queryAudit(db, TEN, { limit: 1, offset: 0 });
  const pageTwo = await queryAudit(db, TEN, { limit: 1, offset: 1 });
  eq(pageOne.total, pageTwo.total);
  eq(pageOne.rows.length, 1);
  eq(pageTwo.rows.length, 1);
  eq(pageOne.rows[0]?.seq !== pageTwo.rows[0]?.seq, true);
  const other = await queryAudit(db, 'other', {});
  eq(other.total, 1);
});

T('FLOW-024: audit events link to evidence, authorization, receipt, and outcome', async () => {
  const links = auditLinks({
    target: 'request:req_1',
    detail: 'approved [claim:clm_1] [decision:dec_1] [receipt:rcpt_7] [outcome:out_3]',
    actor: 'human:priya',
  });
  eq(links.evidence.includes('claim:clm_1'), true);
  eq(links.evidence.includes('decision:dec_1'), true);
  eq(links.authorization, 'human:priya');
  eq(links.receipt, 'receipt:rcpt_7');
  eq(links.outcome, 'outcome:out_3');
});

T('FLOW-024: export tracker reports progress, partial failure, retry, completion, and expiry', async () => {
  const tracker = createExportTracker(['claims', 'decisions', 'audit']);
  eq(tracker.summary().state, 'in-progress');
  tracker.update('claims', 'completed');
  tracker.update('decisions', 'failed', 'timeout');
  eq(tracker.summary().state, 'partial-failure');
  tracker.retry('decisions');
  tracker.update('decisions', 'completed');
  tracker.update('audit', 'completed');
  eq(tracker.summary().state, 'completed');
  const failed = createExportTracker(['a', 'b']);
  failed.update('a', 'failed');
  failed.update('b', 'failed');
  eq(failed.summary().state, 'failed');
  const expiring = createExportTracker(['a']);
  expiring.update('a', 'completed');
  expiring.expire();
  eq(expiring.summary().state, 'expired');
});

T('F23: export is snapshot-consistent and bounds reads to snapshot inception point', async () => {
  const { db, ledger } = await seedLedger();
  // Read snapshot at NOW
  const exp = await exportLedger(db, TEN, NOW);
  eq(exp.claims.length, 2);

  // Concurrently insert newer claims and decisions with timestamps after NOW
  const LATER = '2026-09-18T15:00:00.000Z';
  await ledger.append({
    tenant: TEN,
    subject: 'launch',
    kind: 'FACT',
    statement: 'shipped later',
    confidence: 1,
    observedAt: LATER,
    validFrom: LATER,
    owner: 'human:priya',
    scope: 'marketing',
    authorType: 'system',
    provenance: { ...sor(), retrievedAt: LATER },
    now: LATER,
  });

  // Re-export pinned at snapshot time NOW: must exclude later items
  const pinned = await exportLedger(db, TEN, NOW);
  eq(pinned.claims.length, 2);
  eq(
    pinned.claims.every((c) => c.observed_at <= NOW),
    true,
  );

  // Export at LATER includes the new claim
  const laterExp = await exportLedger(db, TEN, LATER);
  eq(laterExp.claims.length, 3);
});

T('F23: unique tie-breaker ordering keeps identical timestamps stably sorted across pagination batches', async () => {
  const { db } = await fresh();
  const SAME_TIME = '2026-09-18T10:00:00.000Z';

  // Insert 6 decisions sharing identical signed_at but different IDs
  for (let i = 0; i < 6; i++) {
    await db
      .prepare(
        `INSERT INTO decisions (id, tenant, goal, action, action_class, context_bundle, decided_by, scope, autonomy, signed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`dec_${5 - i}`, TEN, 'goal', 'run', 'READ', '{}', 'human:priya', 'marketing', 'autonomous', SAME_TIME);
  }

  // Use streamExportLedger with batchSize = 2 to force crossing page boundaries multiple times
  let jsonText = '';
  const { counts } = await streamExportLedger(
    db,
    TEN,
    (chunk) => {
      jsonText += chunk;
    },
    { batchSize: 2, now: SAME_TIME },
  );

  eq(counts.decisions, 6);
  const parsed = JSON.parse(jsonText) as { decisions: { id: string; signed_at: string }[] };
  eq(parsed.decisions.length, 6);
  const ids = parsed.decisions.map((d) => d.id);
  // Must be strictly ordered by signed_at ASC, id ASC: dec_0, dec_1, dec_2, dec_3, dec_4, dec_5
  eq(ids, ['dec_0', 'dec_1', 'dec_2', 'dec_3', 'dec_4', 'dec_5']);
});

T('F23: streamExportLedger and exportLedgerStream emit chunked valid JSON with manifest', async () => {
  const { db } = await seedLedger();
  let fullOutput = '';
  const { manifest, counts } = await streamExportLedger(
    db,
    TEN,
    (chunk) => {
      fullOutput += chunk;
    },
    { batchSize: 1, now: NOW, kind: 'evidence-package' },
  );

  eq(manifest.kind, 'evidence-package');
  eq(counts.claims, 2);
  eq(counts.audit >= 1, true);

  const parsed = JSON.parse(fullOutput) as { version: number; tenant: string; claims: unknown[]; decisions: unknown[] };
  eq(parsed.version, 1);
  eq(parsed.tenant, TEN);
  eq(parsed.claims.length, 2);

  // Test async generator exportLedgerStream
  const streamChunks: string[] = [];
  const generator = exportLedgerStream(db, TEN, { batchSize: 1, now: NOW });
  for await (const chunk of generator) {
    streamChunks.push(chunk);
  }
  const generatorText = streamChunks.join('');
  const generatorParsed = JSON.parse(generatorText) as { tenant: string; claims: unknown[] };
  eq(generatorParsed.tenant, TEN);
  eq(generatorParsed.claims.length, 2);
});

T('F23: concurrent exports run in parallel without mutual blocking or data corruption', async () => {
  const { db } = await seedLedger();
  const runs = await Promise.all([
    exportLedgerWithManifest(db, TEN, 'snapshot', NOW),
    exportLedgerWithManifest(db, TEN, 'evidence-package', NOW),
    (async () => {
      let buf = '';
      const meta = await streamExportLedger(
        db,
        TEN,
        (c) => {
          buf += c;
        },
        { batchSize: 1, now: NOW },
      );
      return { export: JSON.parse(buf), manifest: meta.manifest };
    })(),
  ]);

  eq(runs.length, 3);
  eq(runs[0]?.manifest.counts.claims, 2);
  eq(runs[1]?.manifest.counts.claims, 2);
  eq(runs[2]?.manifest.counts.claims, 2);
  eq(runs[0]?.export.claims.length, 2);
  eq(runs[1]?.export.claims.length, 2);
  eq(runs[2]?.export.claims.length, 2);
});

T('FLOW-024: manifests carry the retention/expiry policy — no silent expiry', async () => {
  const { db } = await seedLedger();
  for (const kind of ['snapshot', 'evidence-package', 'backup-reference'] as const) {
    const { manifest } = await exportLedgerWithManifest(db, TEN, kind, NOW);
    eq(manifest.retention, EXPORT_RETENTION_POLICY);
    eq(manifest.retention.includes('no automatic expiry'), true, `${kind} states its retention:`);
  }
});

T('FLOW-024: large exports emit start/batch/complete progress per section', async () => {
  const { db, ledger } = await fresh();
  for (let i = 0; i < 7; i++) {
    await ledger.append({
      tenant: TEN,
      subject: 'launch',
      kind: 'FACT',
      statement: `shipped ${i}`,
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human:priya',
      scope: 'marketing',
      authorType: 'system',
      provenance: { ...sor(), retrievedAt: NOW },
      now: NOW,
    });
  }
  const events: ExportProgressEvent[] = [];
  let jsonText = '';
  const { counts, manifest } = await streamExportLedger(
    db,
    TEN,
    (chunk) => {
      jsonText += chunk;
    },
    {
      batchSize: 2,
      now: NOW,
      onProgress: (event) => events.push(event),
    },
  );
  eq(counts.claims, 7);
  const sections = ['claims', 'claimLinks', 'decisions', 'outcomes', 'audit'] as const;
  for (const section of sections) {
    const scoped = events.filter((e) => e.section === section);
    eq(scoped.length > 0, true, `${section} emits progress:`);
    eq(scoped[0]!.phase, 'start');
    eq(scoped[scoped.length - 1]!.phase, 'complete');
  }
  const claimBatches = events.filter((e) => e.section === 'claims' && e.phase === 'batch');
  eq(claimBatches.length >= 3, true, 'paged reads surface as multiple batch events:');
  const final = events.filter((e) => e.section === 'export' && e.phase === 'complete');
  eq(final.length, 1, 'one terminal completion event:');
  eq(final[0]!.completed, counts.claims + counts.claimLinks + counts.decisions + counts.outcomes + counts.audit);
  eq(JSON.parse(jsonText).claims.length, 7, 'progress never corrupts the byte stream:');
  eq(manifest.retention.includes('no automatic expiry'), true);
});

T('FLOW-024: archival delivery is verified by read-back — never claimed when unconfigured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vital-archive-'));
  const file = join(dir, 'ledger-export.json');
  writeFileSync(file, JSON.stringify({ tenant: TEN, claims: [1, 2, 3] }));
  const archiveDir = mkdtempSync(join(tmpdir(), 'vital-archive-shelf-'));
  const key = basename(file);
  // No bucket configured: explicit unconfigured state, never success.
  delete process.env.VITAL_ARCHIVE_BUCKET;
  const unconfigured = await verifyArchivalDelivery(file, { probe: filesystemArchivalProbe(archiveDir) });
  eq(unconfigured.status, 'unconfigured');
  eq(unconfigured.detail.includes('not claimed'), true);
  // Bucket configured but object absent: missing, not verified.
  const missing = await verifyArchivalDelivery(file, {
    bucket: 'audit-vault',
    key,
    probe: filesystemArchivalProbe(archiveDir),
  });
  eq(missing.status, 'missing');
  // Deliver the bytes, then verify: byte-compared read-back passes.
  writeFileSync(join(archiveDir, key), JSON.stringify({ tenant: TEN, claims: [1, 2, 3] }));
  const verified = await verifyArchivalDelivery(file, {
    bucket: 'audit-vault',
    key,
    probe: filesystemArchivalProbe(archiveDir),
  });
  eq(verified.status, 'verified');
  eq(verified.expectedSha256 !== undefined, true, 'report names the compared hash:');
  // Tampered or crossed object: mismatch, never success.
  writeFileSync(join(archiveDir, key), JSON.stringify({ tenant: TEN, claims: [9] }));
  const mismatch = await verifyArchivalDelivery(file, {
    bucket: 'audit-vault',
    key,
    probe: filesystemArchivalProbe(archiveDir),
  });
  eq(mismatch.status, 'mismatch');
});
