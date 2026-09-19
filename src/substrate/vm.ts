import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';

/**
 * Team workspaces: one directory-isolated workspace per team scope, many
 * jcode sessions multiplexed inside via the same JCODE_API_SOCKET.
 *
 * What this IS: a per-scope durable working directory (`team-<scope>`),
 * rebuildable in spirit from a snapshot artifact, destroyed on kill switch /
 * turn error / explicit teardown. Snapshots persist through the artifact
 * store when the caller supplies a real artifact ref.
 *
 * What this is NOT (stated plainly, AUDIT.md F27 pattern — infrastructure
 * must not imply isolation it does not provide): there is no Firecracker, no
 * jailer, no VM boundary. The old header claimed a "Firecracker-style"
 * backend "selected when VITAL_VM_BACKEND=firecracker" — no such code path
 * exists. This is process-level directory isolation only; hard isolation is
 * deployment work (EFS access points / a real microVM) and is not claimed
 * until it exists.
 *
 * Lifecycle per queue: provision on first dispatch for a scope, reuse across
 * requests in that scope, destroy on kill switch / turn error / teardown.
 */

export interface TeamVm {
  vmId: string;
  scope: string;
  workingDir: string;
  /**
   * Socket path ONLY when JCODE_API_SOCKET is configured. Empty string means
   * "not configured" — sessions resolve their own transport. The old code
   * minted `/run/jcode-<vmid>.sock` for VMs that never listen on it.
   */
  socketPath: string;
  /** Artifact ref of the last good snapshot, or null when none was persisted. */
  snapshotRef: string | null;
  provisionedAt: string;
}

export interface VmSnapshot {
  snapshotRef: string | null;
  scope: string;
  requestId: string;
  at: string;
}

export function vmRootFor(scope: string, env: NodeJS.ProcessEnv = process.env): string {
  // VITAL_VM_ROOT wins everywhere (tests isolate here). Prod default is the
  // EFS access-point path; on Windows there is no /var, so fall back to the
  // OS temp dir instead of spraying drive-root `\var\` junk (found live).
  const base =
    env.VITAL_VM_ROOT ?? (process.platform === 'win32' ? join(tmpdir(), 'vital-sandboxes') : '/var/vital/sandboxes');
  return join(base, `team-${scope}`);
}

function vmRoot(scope: string): string {
  return vmRootFor(scope);
}

export async function provisionTeamVm(db: AsyncDb, tenant: string, scope: string, now?: string): Promise<TeamVm> {
  const at = now ?? new Date().toISOString();
  const existing = (await db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`vm:team:${tenant}:${scope}`)) as
    { value: string } | undefined;
  if (existing) {
    try {
      const parsed = JSON.parse(String(existing.value)) as TeamVm;
      mkdirSync(parsed.workingDir, { recursive: true });
      return parsed;
    } catch {
      // fall through to fresh provision
    }
  }
  const vmId = `vm_${randomUUID().slice(0, 12)}`;
  const workingDir = vmRoot(scope);
  mkdirSync(workingDir, { recursive: true });
  const vm: TeamVm = {
    vmId,
    scope,
    workingDir,
    socketPath: process.env.JCODE_API_SOCKET ?? '',
    snapshotRef: null,
    provisionedAt: at,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`vm:team:${tenant}:${scope}`, JSON.stringify(vm));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'system', 'VM_PROVISIONED', `vm:${vmId}`, `scope=${scope} dir=${workingDir} isolation=directory`, at);
  return vm;
}

export async function snapshotTeamVm(
  db: AsyncDb,
  tenant: string,
  scope: string,
  requestId: string,
  artifactRef: string | null,
  now?: string,
): Promise<VmSnapshot> {
  const at = now ?? new Date().toISOString();
  const row = (await db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`vm:team:${tenant}:${scope}`)) as
    { value: string } | undefined;

  // No artifact ref means NO snapshot was persisted. Recording an invented
  // `snap_<timestamp>` ref (the old behavior) put a durable-looking pointer
  // to nothing into the audit log.
  const snapshotRef = artifactRef ?? null;
  const refDetail = snapshotRef ?? 'none (no artifact store ref returned)';

  if (row) {
    try {
      const vm = JSON.parse(String(row.value)) as TeamVm;
      vm.snapshotRef = snapshotRef;
      await db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(`vm:team:${tenant}:${scope}`, JSON.stringify(vm));
    } catch {
      // keep snapshot record even if VM row is unreadable
    }
  }
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'system', 'VM_SNAPSHOT', `vm:team:${scope}`, `request=${requestId} ref=${refDetail}`, at);
  return { snapshotRef, scope, requestId, at };
}

export async function destroyTeamVm(
  db: AsyncDb,
  tenant: string,
  scope: string,
  reason: string,
  now?: string,
): Promise<void> {
  const at = now ?? new Date().toISOString();
  const row = (await db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`vm:team:${tenant}:${scope}`)) as
    { value: string } | undefined;
  if (row) {
    try {
      const vm = JSON.parse(String(row.value)) as TeamVm;
      rmSync(vm.workingDir, { recursive: true, force: true });
    } catch {
      // best effort teardown
    }
    await db.prepare('DELETE FROM meta WHERE key = ?').run(`vm:team:${tenant}:${scope}`);
  }
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'system', 'VM_DESTROYED', `vm:team:${scope}`, reason.slice(0, 200), at);
}
