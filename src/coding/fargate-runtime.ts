import type { AsyncDb } from '../core/db.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotManifest } from './snapshot.ts';

// Fargate driver: long-horizon jcode sidecar next to vital-core (deploy/aws/main.tf).
// No 15-min cap; durable workspace mount (EFS); heartbeat + kill switch honored.
export interface FargateSession {
  vmId: string; kind: 'fargate'; workdir: string;
  taskArn: string | null; cluster: string; taskDef: string;
  baseSnapshotId: string | null; heartbeatAt: string;
}
export function fargateConfig(): { cluster: string; taskDef: string; dryRun: boolean } {
  return {
    cluster: process.env.VITAL_FARGATE_CLUSTER ?? 'vital-core',
    taskDef: process.env.VITAL_FARGATE_TASKDEF ?? 'vital-jcode-sidecar',
    dryRun: !process.env.VITAL_FARGATE_CLUSTER, // no cluster configured → local dry-run record
  };
}
async function emit(db: AsyncDb, tenant: string, type: string, ref: string, detail = ''): Promise<void> {
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'microvm-fargate', type, ref, detail.slice(0, 300), new Date().toISOString()).catch(() => {});
}
export async function launchFargate(
  db: AsyncDb, tenant: string, vmId: string, o: { missionId: string; groupId: string; taskIds: string[]; continuationPrompt: string },
  snap: SnapshotManifest | null,
): Promise<FargateSession> {
  const cfg = fargateConfig();
  const workdir = join(tmpdir(), `vital-fargate-${vmId}`);
  mkdirSync(workdir, { recursive: true });
  if (snap) writeFileSync(join(workdir, 'snapshot-manifest.json'), JSON.stringify({ ...snap, restoredAt: new Date().toISOString() }));
  // Dry-run (no AWS): record intent; real deploy uses ECS RunTask with EFS mount + jcode sidecar.
  const taskArn = cfg.dryRun ? null : `arn:aws:ecs:task/${cfg.cluster}/${vmId}`;
  const sess: FargateSession = { vmId, kind: 'fargate', workdir, taskArn, cluster: cfg.cluster, taskDef: cfg.taskDef, baseSnapshotId: snap?.id ?? null, heartbeatAt: new Date().toISOString() };
  await emit(db, tenant, snap ? 'MICROVM_RESTORED' : 'MICROVM_CREATED', vmId,
    `kind=fargate cluster=${cfg.cluster} taskdef=${cfg.taskDef} dryRun=${cfg.dryRun} tasks=${o.taskIds.join(',')} base=${snap?.id ?? 'none'}`);
  return sess;
}
export async function fargateHeartbeat(db: AsyncDb, tenant: string, vmId: string): Promise<void> {
  await emit(db, tenant, 'FARGATE_HEARTBEAT', vmId, `at=${new Date().toISOString()}`);
}
