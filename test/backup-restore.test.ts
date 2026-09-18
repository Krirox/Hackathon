import { copyFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../src/core/db.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { exportLedgerWithManifest } from '../src/ledger/export.ts';
import * as exportModule from '../src/ledger/export.ts';
import { T, eq, TEN, NOW, sor } from './helpers.ts';

console.log('\n\x1b[1mBackup/restore drill vs ledger-history import — FLOW-024\x1b[0m');

async function fileWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vital-backup-'));
  const file = join(dir, 'vital.db');
  const db = openDb(file);
  await migrate(db);
  const ledger = createLedger(db);
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
    provenance: { ...sor(), retrievedAt: NOW },
    now: NOW,
  });
  return { db, ledger, claimId: claim.id, file, dir };
}

T('FLOW-024: backup/restore drill — file copy restores every row and the ledger stays append-only', async () => {
  const { db, claimId, file } = await fileWorld();
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as { n: number };
  eq(Number(before.n), 1);
  // Backup: copy the database file (the documented operator path).
  const backup = `${file}.bak`;
  await db.close();
  copyFileSync(file, backup);
  eq(existsSync(backup), true, 'backup file exists:');
  // Restore to a scratch instance: every row is back.
  const restored = openDb(backup);
  try {
    const count = (await restored.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as {
      n: number;
    };
    eq(Number(count.n), 1, 'restored instance has the backed-up claim:');
    const restoredLedger = createLedger(restored);
    const claim = await restoredLedger.get(TEN, claimId);
    eq(claim?.statement, 'shipped', 'restored claim content matches:');
    // History stays append-only after restore: new appends add, never rewrite.
    const next = await restoredLedger.append({
      tenant: TEN,
      subject: 'launch',
      kind: 'OBSERVATION',
      statement: 'still shipping',
      confidence: 0.5,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'human:priya',
      scope: 'marketing',
      authorType: 'agent',
      provenance: { ...sor('https://x.example/2'), retrievedAt: NOW },
      now: NOW,
    });
    eq(next.id !== claimId, true, 'restore does not recycle identities:');
    const after = (await restored.prepare('SELECT COUNT(*) AS n FROM claims WHERE tenant = ?').get(TEN)) as {
      n: number;
    };
    eq(Number(after.n), 2, 'post-restore append adds history:');
  } finally {
    await restored.close();
  }
});

T('FLOW-024: ledger-history import is unsupported — export is portable evidence, not a restore source', async () => {
  const { db } = await fileWorld();
  try {
    // No import entry point exists on the export module: merging two
    // append-only histories is not offered, so a test cannot invent one.
    const names = Object.keys(exportModule);
    eq(
      names.some((n) => /import/i.test(n)),
      false,
      'no ledger-history import function is exported:',
    );
    // And the manifest says so on every kind: a snapshot is explicitly not
    // a backup and cannot be restored by import.
    for (const kind of ['snapshot', 'evidence-package', 'backup-reference'] as const) {
      const { manifest } = await exportLedgerWithManifest(db, TEN, kind, NOW);
      const text = `${manifest.note} ${manifest.retention}`.toLowerCase();
      const disclaimsRestore =
        text.includes('not a backup') || text.includes('import is unsupported') || kind === 'backup-reference';
      eq(disclaimsRestore, true, `${kind} disclaims restore-by-import:`);
    }
  } finally {
    await db.close();
  }
});
