import { createHash, randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { sha256 } from './mission.ts';

// ── EnvironmentSnapshot: immutable, hash-verified, content-deduplicated ──
export type SnapshotStatus = 'VERIFYING' | 'VERIFIED' | 'EXPERIMENTAL' | 'FAILED' | 'QUARANTINED' | 'ARCHIVED';
export type SnapshotType = 'CHECKPOINT' | 'VERIFIED' | 'EXPERIMENTAL' | 'FAILURE';

export interface SnapshotManifest {
  id: string; missionId: string; groupId: string; projectId: string;
  repo: string; branch: string; commit: string; parentId: string | null;
  type: SnapshotType; status: SnapshotStatus;
  runtime: Record<string, string>; docker: { image: string; digest: string }[];
  toolchains: Record<string, string>; secretRefs: string[];
  workspaceHash: string; envHash: string; manifestHash: string;
  pinned: boolean; createdAt: string; createdBy: string;
}
export interface MissionMemory {
  version: number; missionId: string; summary: string;
  decisions: string[]; completedSteps: string[]; knownIssues: string[];
  constraints: string[]; updatedAt: string;
}

export function stripSecrets<T>(obj: T, secretKeys = ['key', 'token', 'secret', 'password', 'credential']): { clean: T; refs: string[] } {
  const refs: string[] = [];
  const clean = JSON.parse(JSON.stringify(obj ?? null), (k, v) => {
    if (secretKeys.some((s) => k.toLowerCase().includes(s)) && typeof v === 'string' && v.length > 0) {
      refs.push(k); return `secret://ref/${k}`;
    }
    return v;
  }) as T;
  return { clean, refs };
}

export async function createSnapshot(
  db: AsyncDb, tenant: string,
  input: Omit<SnapshotManifest, 'id' | 'status' | 'workspaceHash' | 'envHash' | 'manifestHash' | 'createdAt' | 'pinned' | 'secretRefs' | 'createdBy'> & { createdBy?: string; secretRefs?: string[]; workspaceContent?: string },
): Promise<SnapshotManifest> {
  const { workspaceContent, ...rest } = input;
  const workspaceHash = sha256(workspaceContent ?? `${rest.repo}@${rest.commit}`);
  const envHash = sha256(JSON.stringify({ runtime: rest.runtime, toolchains: rest.toolchains, docker: rest.docker }));
  const manifestHash = createHash('sha256').update(workspaceHash + envHash + (rest.parentId ?? '')).digest('hex');
  const s: SnapshotManifest = {
    ...rest, createdBy: rest.createdBy ?? tenant, secretRefs: rest.secretRefs ?? [],
    id: `snap_${randomUUID().slice(0, 8).toUpperCase()}`,
    status: input.type === 'VERIFIED' ? 'VERIFYING' : 'EXPERIMENTAL',
    workspaceHash, envHash, manifestHash, pinned: false, createdAt: new Date().toISOString(),
  };
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`snapshot:${tenant}:${s.id}`, JSON.stringify(s));
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'coding-agent', 'SNAPSHOT_CREATED', s.id, `${s.type} parent=${s.parentId ?? 'none'} hash=${manifestHash.slice(0, 12)}`, s.createdAt).catch(() => {});
  return s;
}
export async function getSnapshot(db: AsyncDb, tenant: string, id: string): Promise<SnapshotManifest | null> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`snapshot:${tenant}:${id}`)) as { value: string } | undefined;
  return row ? (JSON.parse(String(row.value)) as SnapshotManifest) : null;
}
export async function setSnapshotStatus(db: AsyncDb, tenant: string, id: string, status: SnapshotStatus): Promise<SnapshotManifest> {
  const s = await getSnapshot(db, tenant, id);
  if (!s) throw new Error('snapshot not found');
  if (s.status === 'ARCHIVED' && status !== 'ARCHIVED') throw new Error('archived snapshots are immutable');
  s.status = status;
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`snapshot:${tenant}:${id}`, JSON.stringify(s));
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'coding-agent', status === 'VERIFIED' ? 'SNAPSHOT_VERIFIED' : 'SNAPSHOT_STATUS', id, status, new Date().toISOString()).catch(() => {});
  return s;
}
export async function verifySnapshot(db: AsyncDb, tenant: string, id: string, workspaceContent: string): Promise<boolean> {
  const s = await getSnapshot(db, tenant, id);
  if (!s) return false;
  const ok = sha256(workspaceContent) === s.workspaceHash;
  await setSnapshotStatus(db, tenant, id, ok ? 'VERIFIED' : 'QUARANTINED');
  return ok;
}
export function checkCompatibility(snap: SnapshotManifest, req: { repo: string; runtime: Record<string, string> }): { ok: boolean; reason: string } {
  if (snap.repo !== req.repo) return { ok: false, reason: `repo mismatch ${snap.repo} vs ${req.repo}` };
  for (const [k, v] of Object.entries(req.runtime)) {
    if (snap.runtime[k] && snap.runtime[k] !== v) return { ok: false, reason: `runtime ${k}: ${snap.runtime[k]} vs ${v}` };
  }
  if (snap.status === 'FAILED' || snap.status === 'QUARANTINED') return { ok: false, reason: `status ${snap.status}` };
  return { ok: true, reason: 'compatible' };
}
export async function listSnapshots(db: AsyncDb, tenant: string): Promise<SnapshotManifest[]> {
  const rows = (await db.prepare("SELECT value FROM meta WHERE key LIKE ?").all(`snapshot:${tenant}:%`)) as { value: string }[];
  return rows.map((r) => JSON.parse(String(r.value)) as SnapshotManifest).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export async function pinSnapshot(db: AsyncDb, tenant: string, id: string, pinned: boolean): Promise<SnapshotManifest> {
  const s = await getSnapshot(db, tenant, id);
  if (!s) throw new Error('snapshot not found');
  s.pinned = pinned;
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`snapshot:${tenant}:${id}`, JSON.stringify(s));
  return s;
}
export async function selectBestSnapshot(db: AsyncDb, tenant: string, req: { repo: string; runtime: Record<string, string> }): Promise<SnapshotManifest | null> {
  const snaps = await listSnapshots(db, tenant);
  // VERIFIED first, then EXPERIMENTAL, then everything else (drafts, rejected).
  const rank = (s: SnapshotManifest): number => {
    if (s.status === 'VERIFIED') return 0;
    if (s.status === 'EXPERIMENTAL') return 1;
    return 2;
  };
  const compat = snaps.filter((s) => checkCompatibility(s, req).ok).sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));
  return compat[0] ?? null;
}
// ── MissionMemory: working context, never a FACT source ──
export async function saveMemory(db: AsyncDb, tenant: string, mem: Omit<MissionMemory, 'version' | 'updatedAt'> & { version?: number }): Promise<MissionMemory> {
  const prev = await getMemory(db, tenant, mem.missionId);
  const full: MissionMemory = { ...mem, version: (prev?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`memory:${tenant}:${mem.missionId}`, JSON.stringify(full));
  return full;
}
export async function getMemory(db: AsyncDb, tenant: string, missionId: string): Promise<MissionMemory | null> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`memory:${tenant}:${missionId}`)) as { value: string } | undefined;
  return row ? (JSON.parse(String(row.value)) as MissionMemory) : null;
}
export function continuationPrompt(project: string, snap: SnapshotManifest, mem: MissionMemory | null): string {
  return [`PROJECT: ${project}`, `SNAPSHOT: ${snap.id} (${snap.status})`, `BRANCH: ${snap.branch} COMMIT: ${snap.commit}`,
    mem ? `COMPLETED: ${mem.completedSteps.join('; ') || 'none'}` : 'COMPLETED: none',
    mem ? `DECISIONS: ${mem.decisions.join('; ') || 'none'}` : '',
    mem ? `KNOWN ISSUES: ${mem.knownIssues.join('; ') || 'none'}` : '',
    mem ? `DO NOT: ${mem.constraints.join('; ') || 'none'}` : '',
  ].filter(Boolean).join('\n');
}
