import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
process.env.VITAL_VM_ROOT = mkdtempSync(join(tmpdir(), 'vital-vm-'));
process.env.VITAL_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'vital-snaps-'));
import { T } from './helpers.ts';
import { openDb, migrate } from '../src/core/db.ts';
import { createMission, transitionMission, submitPlan, approveMission, groupTasks } from '../src/coding/mission.ts';
import { createSnapshot, verifySnapshot, checkCompatibility, selectBestSnapshot, saveMemory, getMemory, stripSecrets, pinSnapshot } from '../src/coding/snapshot.ts';
import { createMicroVM } from '../src/coding/microvm.ts';
import { buildLambdaPayload, restoreSnapshotToLambda } from '../src/coding/lambda-runtime.ts';
import { launchFargate } from '../src/coding/fargate-runtime.ts';
import { mergeGroups } from '../src/coding/merge.ts';
import { FsSnapshotStore, persistSnapshotLayers } from '../src/coding/snapshot-store.ts';
import { gitStatus, writeFileSafe, secretScan, sha } from '../src/coding/diff.ts';
import { openReview, getReview } from '../src/coding/review.ts';
import { renderReviewPage, handleReviewAction } from '../src/console/code-review.ts';
import { listSnapshots } from '../src/coding/snapshot.ts';

async function mem() { const db = openDb(':memory:'); await migrate(db); return db; }

T('coding-agent: mission lifecycle — creates, plans, approves, executes to complete', async () => {
  const db = await mem();
  const m = await createMission(db, 't', 'Add OAuth');
  await transitionMission(db, 't', m.id, 'RESEARCHING');
  await transitionMission(db, 't', m.id, 'PLANNING');
  await submitPlan(db, 't', m.id, [{ id: 's1', title: 'api', files: ['a.ts'], deps: [] }]);
  await transitionMission(db, 't', m.id, 'PENDING_APPROVAL');
  await approveMission(db, 't', m.id, 'human');
  await transitionMission(db, 't', m.id, 'EXECUTING');
  await transitionMission(db, 't', m.id, 'VERIFYING');
  await transitionMission(db, 't', m.id, 'SNAPSHOTTING');
  const done = await transitionMission(db, 't', m.id, 'COMPLETE');
  assert.equal(done.status, 'COMPLETE');
  await assert.rejects(() => transitionMission(db, 't', m.id, 'EXECUTING'));
  await db.close();
});

T('coding-agent: grouping engine — groups compatible, splits conflicts, records real split reasons', async () => {
  const base = { repo: 'r', runtime: { node: '22' }, permissions: 'std', trust: 't1', resources: 'low' as const, deps: [] };
  const tasks = [
    { ...base, id: 'a', title: 'a' }, { ...base, id: 'b', title: 'b', deps: ['a'] },
    { ...base, id: 'c', title: 'c', runtime: { node: '18' } },
    { ...base, id: 'd', title: 'd', repo: 'other' },
  ];
  const g = groupTasks('COD-1234', tasks);
  assert.equal(g.length, 3);
  assert.deepEqual(g[0]?.taskIds, ['a', 'b']);
  assert.ok(g[0]?.reason.includes('shared repo=r'), 'multi-task group states its shared base');
  // Each singleton group's reason names the concrete incompatibility that
  // kept it out of the earlier group — not a fabricated description.
  assert.deepEqual(g[1]?.taskIds, ['c']);
  assert.deepEqual(g[2]?.taskIds, ['d']);
  const reasons = g.slice(1).map((x) => x.reason);
  assert.ok(reasons.includes('runtime conflict node'), `c split on runtime: ${reasons.join(' | ')}`);
  assert.ok(reasons.includes('different repo'), `d split on repo: ${reasons.join(' | ')}`);
});

T('coding-agent: snapshot + memory — creates, verifies, compat-checks, selects verified, strips secrets', async () => {
  const db = await mem();
  const s1 = await createSnapshot(db, 't', { missionId: 'M1', groupId: 'G1', projectId: 'p', repo: 'r', branch: 'b', commit: 'c1', parentId: null, type: 'VERIFIED', runtime: { node: '22' }, docker: [], toolchains: {}, workspaceContent: 'hello' });
  assert.equal(s1.status, 'VERIFYING');
  assert.equal(await verifySnapshot(db, 't', s1.id, 'hello'), true);
  assert.equal(await verifySnapshot(db, 't', s1.id, 'tampered'), false); // quarantined
  const s2 = await createSnapshot(db, 't', { missionId: 'M1', groupId: 'G1', projectId: 'p', repo: 'r', branch: 'b', commit: 'c2', parentId: s1.id, type: 'VERIFIED', runtime: { node: '22' }, docker: [], toolchains: {}, workspaceContent: 'world' });
  await verifySnapshot(db, 't', s2.id, 'world');
  const best = await selectBestSnapshot(db, 't', { repo: 'r', runtime: { node: '22' } });
  assert.equal(best?.id, s2.id);
  assert.equal(checkCompatibility(s2, { repo: 'r', runtime: { node: '18' } }).ok, false);
  const { clean, refs } = stripSecrets({ apiToken: 'xyz', name: 'ok' });
  assert.equal((clean as Record<string, string>).apiToken, 'secret://ref/apiToken');
  assert.deepEqual(refs, ['apiToken']);
  await pinSnapshot(db, 't', s2.id, true);
  const mem1 = await saveMemory(db, 't', { missionId: 'M1', summary: 's', decisions: ['d'], completedSteps: ['a'], knownIssues: [], constraints: [] });
  assert.equal(mem1.version, 1);
  assert.equal((await getMemory(db, 't', 'M1'))?.summary, 's');
  const vm = await createMicroVM(db, 't', 'M1', 'G1', s2.id);
  assert.equal(vm.status, 'RUNNING');
  await db.close();
});

T('coding-agent: lambda microvm — builds invoke payload without secrets and restores manifest to /tmp', async () => {
  const db = await mem();
  const s = await createSnapshot(db, 't', { missionId: 'M9', groupId: 'G9', projectId: 'p', repo: 'r', branch: 'b', commit: 'c', parentId: null, type: 'EXPERIMENTAL', runtime: { node: '22' }, docker: [], toolchains: {}, workspaceContent: 'x' });
  const sess = await restoreSnapshotToLambda(db, 't', s, 'testvm123');
  assert.equal(sess.ephemeral, true);
  assert.equal(sess.kind, 'lambda');
  assert.equal(existsSync(sess.workdir + '/snapshot-manifest.json'), true);
  const payload = buildLambdaPayload({ tenant: 't', missionId: 'M9', groupId: 'G9', taskIds: ['a'], snapshotId: s.id, continuationPrompt: 'hi' });
  assert.equal(payload['ephemeral'], true);
  assert.ok(!JSON.stringify(payload).includes('sk-'), 'no secrets in payload');
  process.env.VITAL_VM_BACKEND = 'lambda';
  try {
    const vm = await createMicroVM(db, 't', 'M9', 'G9', s.id);
    assert.equal(vm.kind, 'lambda');
    assert.ok(vm.workingDir.includes('vital-lambda-'), 'ephemeral /tmp dir');
  } finally {
    // Single-process suite: a leaked env var would silently flip every
    // later test's MicroVM path to lambda.
    delete process.env.VITAL_VM_BACKEND;
  }
  await db.close();
});

T('coding-agent: fargate + merge — dry-run intent, clean merge, overlap conflict, unverified block', async () => {
  const db = await mem();
  const sess = await launchFargate(db, 't', 'vm-fg-1', { missionId: 'M', groupId: 'G', taskIds: ['a'], continuationPrompt: 'go' }, null);
  assert.equal(sess.kind, 'fargate');
  const ok = await mergeGroups(db, 't', 'M', { baseSnapshotId: 's0', branches: [
    { groupId: 'A', branch: 'a', files: ['x.ts'], snapshotId: 's1', verified: true },
    { groupId: 'B', branch: 'b', files: ['y.ts'], snapshotId: 's2', verified: true },
  ]});
  assert.equal(ok.status, 'MERGED');
  const cf = await mergeGroups(db, 't', 'M', { baseSnapshotId: 's0', branches: [
    { groupId: 'A', branch: 'a', files: ['src/auth/svc.ts'], snapshotId: 's1', verified: true },
    { groupId: 'B', branch: 'b', files: ['src/auth/svc.ts'], snapshotId: 's2', verified: true },
  ]});
  assert.equal(cf.status, 'CONFLICT');
  assert.ok(cf.reason.includes('human review'));
  const bl = await mergeGroups(db, 't', 'M', { baseSnapshotId: 's0', branches: [
    { groupId: 'A', branch: 'a', files: ['x.ts'], snapshotId: 's1', verified: false },
  ]});
  assert.equal(bl.status, 'BLOCKED');
  await db.close();
});

T('coding-agent: snapshot store — dedupes identical layers, docker digest refs, get(hash) roundtrips', async () => {
  const db = await mem();
  const store = new FsSnapshotStore(db, 't');
  const a = await store.put('workspace', 'same-bytes');
  const b = await store.put('workspace', 'same-bytes');
  assert.equal(a.hash, b.hash);
  assert.equal(b.deduped, true);
  const layers = await persistSnapshotLayers(store, { workspace: 'code', dependencies: 'lock', dockerDigests: ['sha256:abc', 'sha256:abc'] });
  assert.equal(layers.dockerRefs[0], layers.dockerRefs[1], 'same digest stored once');
  // get(hash) resolves the ref via the db index and returns the exact bytes.
  assert.equal((await store.get(a.hash))?.toString(), 'same-bytes');
  assert.equal(await store.get('0'.repeat(64)), null, 'unknown hash → null, not throw');
  // The first-stored ref is the dedupe target; both puts resolve to one file.
  assert.ok(existsSync(join(process.env.VITAL_SNAPSHOT_DIR!, a.ref)), 'blob exists under isolated dir');
  await db.close();
});

// Real git repo sandbox for the review pipeline (rename detection, safe writes,
// secret-scan rendering). Proves the fixed porcelain parsing on real git output.
T('coding-agent: review diff — rename parsed dest←old, writeFileSafe containment, secretScan rendered', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'vital-review-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@vital.test');
  g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'old-name.ts'), 'export const a = 1;\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  const baseline = g('rev-parse', 'HEAD').trim();
  // Rename old-name.ts → new-name.ts, plus a file carrying a fake secret.
  g('mv', 'old-name.ts', 'new-name.ts');
  writeFileSync(join(repo, 'secret.ts'), "const stripe = 'sk-test-abcdefgh1234';\n");
  g('add', '-A');

  const changes = gitStatus(repo);
  const ren = changes.find((c) => c.status === 'R');
  assert.ok(ren, 'rename detected via real git porcelain');
  // The fix: porcelain `XY <new>\0<old>` → path is the DESTINATION.
  assert.equal(ren?.path, 'new-name.ts', 'rename path is the new name, not the old');
  assert.equal(ren?.oldPath, 'old-name.ts', 'rename oldPath is the original');

  // writeFileSafe: `..` escapes and outside-root absolutes are refused;
  // a file literally named "a..b.txt" is legal and must not be refused.
  assert.throws(() => writeFileSafe(repo, '../escape.ts', 'x'), /unsafe path/);
  assert.throws(() => writeFileSafe(repo, 'a/../../escape.ts', 'x'), /unsafe path/);
  writeFileSafe(repo, 'a..b.txt', 'legal dots');

  // secretScan unit: patterns hit, clean code does not.
  assert.ok(secretScan("const k = 'sk-test-abcdefgh1234';", 'a.ts').length > 0);
  assert.equal(secretScan('export const clean = 1;', 'a.ts').length, 0);

  // Renderer wiring: openReview + renderReviewPage surfaces the hit.
  const db = await mem();
  await openReview(db, 't', 'M-SEC', baseline, repo);
  const html = await renderReviewPage(db, 't', 'M-SEC', {}, 'csrf-token', 'human');
  assert.ok(html.includes('secrets in 1 file(s)'), 'meter surfaces aggregate secret findings');
  assert.ok(html.includes('secret.ts'), 'offending file named in sidebar');
  // Selecting the offending file shows its per-file findings box.
  const secretId = `f_${sha('secret.ts').slice(0, 12)}`;
  const htmlSel = await renderReviewPage(db, 't', 'M-SEC', { file: secretId }, 'csrf-token', 'human');
  assert.ok(htmlSel.includes('SECRET SCAN'), 'per-file scan findings surfaced on selected file');
  assert.ok(htmlSel.includes('possible Stripe'), 'finding label rendered');
  await db.close();
});

T('coding-agent: review actions — full gate journey from open to verified snapshot', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'vital-actions-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@vital.test');
  g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'svc.ts'), 'export const v = 1;\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  const baseline = g('rev-parse', 'HEAD').trim();
  // The agent's change: modify svc.ts, add feature.ts.
  writeFileSync(join(repo, 'svc.ts'), 'export const v = 2;\n');
  writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
  const db = await mem();
  const act = (fields: Record<string, string>) => handleReviewAction(db, 't', 'M-ACT', fields, 'human');

  // Open through the action (not the helper) — including its validations.
  await assert.rejects(() => act({ action: 'open', workdir: join(repo, 'nope') }), /not found/);
  await act({ action: 'open', workdir: repo, baseline });
  await assert.rejects(() => act({ action: 'open', workdir: repo }), /already open/);

  // Comment, then send it to the agent → review flips to CHANGES_REQUESTED.
  await act({ action: 'comment', filePath: 'svc.ts', line: '1', body: 'bump looks fine but explain' });
  const doc1 = (await getReview(db, 't', 'M-ACT'))!;
  assert.equal(doc1.comments.length, 1);
  await act({ action: 'send-to-agent', comment: doc1.comments[0]!.id });
  assert.equal((await getReview(db, 't', 'M-ACT'))!.status, 'CHANGES_REQUESTED');

  // Human edit lands in the working tree and is recorded.
  await act({ action: 'save-edit', file: 'feature.ts', content: 'export const feature = true; // human-approved\n' });
  assert.ok((await getReview(db, 't', 'M-ACT'))!.humanEdits.length === 1);

  // Accept all hunks/files.
  await act({ action: 'accept-all' });
  const docAcc = (await getReview(db, 't', 'M-ACT'))!;
  assert.ok(Object.values(docAcc.hunkDecisions).every((d) => d === 'accepted'));

  // Snapshot is refused before tests ran, and run-tests would fail on this
  // non-project dir — record a verification directly, then snapshot.
  await assert.rejects(() => act({ action: 'create-snapshot' }), /run tests before/);
  const { recordVerification } = await import('../src/coding/review.ts');
  await recordVerification(db, 't', 'M-ACT', { suite: 'simulated', passed: 5, failed: 0, output: 'ok', ok: true });
  await act({ action: 'create-snapshot' });
  const docSnap = (await getReview(db, 't', 'M-ACT'))!;
  assert.ok(docSnap.snapshotId, 'snapshot bound to review');
  const snaps = await listSnapshots(db, 't');
  assert.ok(snaps.some((x) => x.id === docSnap.snapshotId && x.type === 'VERIFIED'));

  // reject-all: rewind both files to baseline content (added file removed).
  await act({ action: 'reject-all', confirm: '1' });
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(repo, 'svc.ts'), 'utf8'), 'export const v = 1;\n', 'modified file reverted');
  assert.equal(existsSync(join(repo, 'feature.ts')), false, 'added file removed');
  await db.close();
});
