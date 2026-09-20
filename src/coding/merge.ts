import type { AsyncDb } from '../core/db.ts';

// MergeManager: fan-in for parallel ExecutionGroups. Never auto-resolves high-risk
// conflicts with an LLM — overlapping files / schema / auth changes require human review.
export interface BranchResult { groupId: string; branch: string; files: string[]; snapshotId: string; verified: boolean; }
export interface MergePlan { baseSnapshotId: string; branches: BranchResult[]; }
export interface MergeOutcome {
  status: 'MERGED' | 'CONFLICT' | 'BLOCKED';
  mergedFiles: string[]; conflicts: { file: string; groups: string[] }[];
  reason: string;
}
const HIGH_RISK = [/migrate/i, /schema/i, /auth/i, /ledger/i, /gov\//i];
function isHighRisk(f: string): boolean { return HIGH_RISK.some((r) => r.test(f)); }

async function emit(db: AsyncDb, tenant: string, type: string, ref: string, detail = ''): Promise<void> {
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'merge-manager', type, ref, detail.slice(0, 400), new Date().toISOString()).catch(() => {});
}
export async function mergeGroups(db: AsyncDb, tenant: string, missionId: string, plan: MergePlan): Promise<MergeOutcome> {
  await emit(db, tenant, 'MERGE_STARTED', missionId, `branches=${plan.branches.map((b) => b.groupId).join(',')} base=${plan.baseSnapshotId}`);
  const unverified = plan.branches.filter((b) => !b.verified);
  if (unverified.length > 0) {
    const reason = `blocked: unverified branches ${unverified.map((b) => b.groupId).join(',')}`;
    await emit(db, tenant, 'MERGE_BLOCKED', missionId, reason);
    return { status: 'BLOCKED', mergedFiles: [], conflicts: [], reason };
  }
  // Detect overlapping files across branches.
  const owners = new Map<string, string[]>();
  for (const b of plan.branches) for (const f of b.files) owners.set(f, [...(owners.get(f) ?? []), b.groupId]);
  const conflicts = [...owners.entries()].filter(([, g]) => g.length > 1)
    .map(([file, groups]) => ({ file, groups }));
  if (conflicts.length > 0) {
    const risky = conflicts.filter((c) => isHighRisk(c.file));
    const reason = risky.length > 0
      ? `high-risk overlap requires human review: ${risky.map((c) => c.file).join(',')}`
      : `overlap requires review: ${conflicts.map((c) => c.file).join(',')}`;
    await emit(db, tenant, 'MERGE_CONFLICT', missionId, reason);
    return { status: 'CONFLICT', mergedFiles: [], conflicts, reason };
  }
  const mergedFiles = plan.branches.flatMap((b) => b.files);
  await emit(db, tenant, 'MERGE_COMPLETED', missionId, `files=${mergedFiles.length} from ${plan.branches.length} branches`);
  return { status: 'MERGED', mergedFiles, conflicts: [], reason: `clean merge of ${plan.branches.length} branches` };
}
