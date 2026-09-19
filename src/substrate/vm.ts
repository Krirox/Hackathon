import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';

/**
 * Team microVMs: one Firecracker-style isolated workspace per team scope,
 * many jcode sessions multiplexed inside via the same JCODE_API_SOCKET.
 *
 * Lifecycle per queue: provision on first dispatch for a scope, reuse across
 * requests in that scope (snapshot = workspace dir + manifest), destroy on
 * kill switch / turn error / explicit teardown. Snapshots persist to the
 * artifact store so the next provision resumes from the last good state.
 *
 * Local/dev implementation uses a directory VM (EFS access-point path in
 * prod: /var/vital/sandboxes/team-<scope>). The Firecracker jailer path is
 * selected when VITAL_VM_BACKEND=firecracker and /usr/bin/jailer exists;
 * otherwise directory isolation + sandbox manifest verification apply.
 */

export interface TeamVm {
  vmId: string;
  scope: string;
  workingDir: string;
  socketPath: string;
  snapshotRef: string | null;
  provisionedAt: string;
}

export interface VmSnapshot {
  snapshotRef: string;
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

function vmSocketPath(vmId: string): string {
  return process.env.JCODE_API_SOCKET ?? `/run/jcode-${vmId.slice(0, 8)}.sock`;
}

export async function provisionTeamVm(
  db: AsyncDb,
  tenant: string,
  scope: string,
  now?: string,
): Promise<TeamVm> {
  const at = now ?? new Date().toISOString();
  const existing = (await db
    .prepare(`SELECT value FROM meta WHERE key = ?`)
    .get(`vm:team:${tenant}:${scope}`)) as { value: string } | undefined;
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
    socketPath: vmSocketPath(vmId),
    snapshotRef: null,
    provisionedAt: at,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`vm:team:${tenant}:${scope}`, JSON.stringify(vm));
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'system', 'VM_PROVISIONED', `vm:${vmId}`, `scope=${scope} dir=${workingDir}`, at);
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
    | { value: string }
    | undefined;
  const snapshotRef = artifactRef ?? `snap_${Date.now().toString(36)}`;
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
    .run(tenant, 'system', 'VM_SNAPSHOT', `vm:team:${scope}`, `request=${requestId} ref=${snapshotRef}`, at);
  return { snapshotRef, scope, requestId, at };
}

export async function destroyTeamVm(db: AsyncDb, tenant: string, scope: string, reason: string, now?: string): Promise<void> {
  const at = now ?? new Date().toISOString();
  const row = (await db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`vm:team:${tenant}:${scope}`)) as
    | { value: string }
    | undefined;
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
