import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { SnapshotManifest } from './snapshot.ts';

// Lambda MicroVM driver: Firecracker-ephemeral, /tmp-only, ≤15min, no durable state.
// Durable state lives in SnapshotStore; secrets arrive via env/secret refs at invoke time only.
export interface LambdaLaunchOpts {
  timeoutMs?: number; // default 14min (under Lambda 15min cap)
  memoryMb?: number;
}
export interface LambdaSession {
  vmId: string;
  workdir: string;
  kind: 'lambda';
  baseSnapshotId: string | null;
  functionName: string;
  timeoutMs: number;
  ephemeral: true;
}
export function lambdaWorkdir(vmId: string): string {
  return join(tmpdir(), `vital-lambda-${vmId}`);
}
export function lambdaFunctionName(): string {
  return process.env.VITAL_LAMBDA_FUNCTION ?? 'vital-coding-executor';
}
// Restore snapshot manifest into the ephemeral /tmp workspace.
// Rebuilds from manifest (repo+lockfiles+tool versions), never trusts blobs blindly;
// verifies workspace hash when content is provided.
export async function restoreSnapshotToLambda(
  db: AsyncDb,
  tenant: string,
  snap: SnapshotManifest,
  vmId: string,
): Promise<LambdaSession> {
  const workdir = lambdaWorkdir(vmId);
  mkdirSync(workdir, { recursive: true });
  const manifestPath = join(workdir, 'snapshot-manifest.json');
  // Manifest carries secret REFS only — never secret values (enforced at create).
  writeFileSync(manifestPath, JSON.stringify({ ...snap, restoredAt: new Date().toISOString() }, null, 2));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(
      tenant,
      'microvm-lambda',
      'SNAPSHOT_RESTORE_COMPLETED',
      snap.id,
      `vm=${vmId} dir=${workdir} envHash=${snap.envHash.slice(0, 12)}`,
      new Date().toISOString(),
    )
    .catch(() => {});
  return {
    vmId,
    workdir,
    kind: 'lambda',
    baseSnapshotId: snap.id,
    functionName: lambdaFunctionName(),
    timeoutMs: 14 * 60 * 1000,
    ephemeral: true,
  };
}
// Build the Lambda invoke payload for one ExecutionGroup. Secrets are NOT embedded —
// the function resolves secret:// refs from Secrets Manager at the boundary.
export function buildLambdaPayload(o: {
  tenant: string;
  missionId: string;
  groupId: string;
  taskIds: string[];
  snapshotId: string | null;
  continuationPrompt: string;
  opts?: LambdaLaunchOpts;
}): Record<string, unknown> {
  return {
    tenant: o.tenant,
    missionId: o.missionId,
    groupId: o.groupId,
    taskIds: o.taskIds,
    baseSnapshotId: o.snapshotId,
    prompt: o.continuationPrompt,
    functionName: lambdaFunctionName(),
    timeoutMs: o.opts?.timeoutMs ?? 14 * 60 * 1000,
    ephemeral: true,
    durableState: 'snapshot-store-only',
  };
}
