import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AsyncDb } from '../core/db.ts';
import { provisionTeamVm, destroyTeamVm } from '../substrate/vm.ts';
import { getSnapshot } from './snapshot.ts';
import { lambdaWorkdir, lambdaFunctionName, restoreSnapshotToLambda } from './lambda-runtime.ts';
import { launchFargate } from './fargate-runtime.ts';

// ExecutionRuntime abstraction: local | firecracker | lambda | fargate | container
export type RuntimeKind = 'local' | 'firecracker' | 'lambda' | 'fargate' | 'container' | 'vm';
export interface MicroVM {
  id: string; groupId: string; missionId: string; kind: RuntimeKind;
  baseSnapshotId: string | null; status: 'CREATED' | 'RUNNING' | 'STOPPED' | 'DESTROYED';
  workingDir: string; createdAt: string;
}
export function resolveRuntime(): RuntimeKind {
  const v = (process.env.VITAL_VM_BACKEND ?? 'local').toLowerCase();
  return (['local', 'firecracker', 'lambda', 'fargate', 'container', 'vm'] as RuntimeKind[]).includes(v as RuntimeKind) ? (v as RuntimeKind) : 'local';
}
async function emit(db: AsyncDb, tenant: string, type: string, ref: string, detail = ''): Promise<void> {
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'microvm', type, ref, detail.slice(0, 300), new Date().toISOString()).catch(() => {});
}
export async function createMicroVM(db: AsyncDb, tenant: string, missionId: string, groupId: string, baseSnapshotId: string | null = null): Promise<MicroVM> {
  const kind = resolveRuntime();
  // Lambda path: ephemeral /tmp workspace + manifest restore, no durable team dir.
  if (kind === 'lambda') {
    const id = `vm_${randomUUID().slice(0, 12)}`;
    const workdir = lambdaWorkdir(id);
    mkdirSync(workdir, { recursive: true });
    if (baseSnapshotId) {
      const snap = await getSnapshot(db, tenant, baseSnapshotId);
      if (snap) await restoreSnapshotToLambda(db, tenant, snap, id);
      else await emit(db, tenant, 'SNAPSHOT_RESTORE_FAILED', baseSnapshotId, `vm=${id} reason=not-found; fresh /tmp`);
    }
    const m: MicroVM = { id, groupId, missionId, kind, baseSnapshotId, status: 'RUNNING', workingDir: workdir, createdAt: new Date().toISOString() };
    await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`microvm:${tenant}:${m.id}`, JSON.stringify(m));
    await emit(db, tenant, baseSnapshotId ? 'MICROVM_RESTORED' : 'MICROVM_CREATED', m.id, `kind=lambda fn=${lambdaFunctionName()} group=${groupId} base=${baseSnapshotId ?? 'none'} eph=/tmp`);
    return m;
  }
  if (kind === 'fargate') {
    const id = `vm_${randomUUID().slice(0, 12)}`;
    const snap = baseSnapshotId ? await getSnapshot(db, tenant, baseSnapshotId) : null;
    if (baseSnapshotId && !snap) await emit(db, tenant, 'SNAPSHOT_RESTORE_FAILED', baseSnapshotId, `vm=${id} reason=not-found`);
    const sess = await launchFargate(db, tenant, id, { missionId, groupId, taskIds: [], continuationPrompt: '' }, snap);
    const m: MicroVM = { id, groupId, missionId, kind, baseSnapshotId, status: 'RUNNING', workingDir: sess.workdir, createdAt: new Date().toISOString() };
    await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`microvm:${tenant}:${m.id}`, JSON.stringify(m));
    return m;
  }
  const scope = `${missionId}-${groupId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const vm = await provisionTeamVm(db, tenant, scope);
  const m: MicroVM = { id: vm.vmId, groupId, missionId, kind, baseSnapshotId, status: 'RUNNING', workingDir: vm.workingDir, createdAt: vm.provisionedAt };
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`microvm:${tenant}:${m.id}`, JSON.stringify(m));
  await emit(db, tenant, baseSnapshotId ? 'MICROVM_RESTORED' : 'MICROVM_CREATED', m.id, `kind=${kind} group=${groupId} base=${baseSnapshotId ?? 'none'}`);
  return { ...m, id: m.id };
}
export async function stopMicroVM(db: AsyncDb, tenant: string, groupId: string, missionId: string, id: string): Promise<void> {
  await emit(db, tenant, 'MICROVM_STOPPING', id, `group=${groupId}`);
  await destroyTeamVm(db, tenant, `${missionId}-${groupId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'), 'ephemeral lifecycle: stop/destroy after snapshot');
  await emit(db, tenant, 'MICROVM_DESTROYED', id, 'ephemeral; durable state in snapshot store');
  await db.prepare('DELETE FROM meta WHERE key = ?').run(`microvm:${tenant}:${id}`).catch(() => {});
}
export function renderEnvPanel(o: { vm?: MicroVM; baseSnap?: string; curSnap?: string; branch?: string }): string {
  return `<section class="env"><h2>Environment</h2><p>MicroVM ${o.vm ? `${o.vm.id} (${o.vm.kind}, ${o.vm.status})` : 'n/a'} | Base ${o.baseSnap ?? 'n/a'} | Current ${o.curSnap ?? 'n/a'} | Branch ${o.branch ?? 'n/a'}</p></section>`;
}
export function renderSnapshotList(snaps: { id: string; status: string; missionId: string }[]): string {
  const rows = snaps.map((s) => `<li>${s.id}: ${s.status} (${s.missionId}) [INSPECT] [RESTORE] [BRANCH]</li>`).join('');
  return `<section class="snapshots"><h2>Environment Snapshots</h2><ul>${rows || '<li>none</li>'}</ul></section>`;
}
export function newId(prefix: string): string { return `${prefix}_${randomUUID().slice(0, 8)}`; }
