import { createHash, randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';

// ── Mission lifecycle: REQUEST→RESEARCH→PLAN→APPROVAL→GROUP→EXECUTE→VERIFY→SNAPSHOT→DONE ──
export type MissionStatus =
  | 'CREATED' | 'RESEARCHING' | 'PLANNING' | 'PENDING_APPROVAL'
  | 'APPROVED' | 'EXECUTING' | 'VERIFYING' | 'SNAPSHOTTING'
  | 'COMPLETE' | 'FAILED' | 'CANCELLED';

export interface Mission {
  id: string; tenant: string; request: string; status: MissionStatus;
  plan: PlanStep[] | null; approvedBy: string | null;
  createdAt: string; updatedAt: string;
}
export interface PlanStep { id: string; title: string; files: string[]; deps: string[]; }
export interface TaskSpec {
  id: string; title: string; repo: string; runtime: Record<string, string>;
  permissions: string; trust: string; resources: 'low' | 'high'; deps: string[];
}

const TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  CREATED: ['RESEARCHING', 'CANCELLED'], RESEARCHING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['PENDING_APPROVAL', 'FAILED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'PLANNING', 'CANCELLED'],
  APPROVED: ['EXECUTING', 'CANCELLED'], EXECUTING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['SNAPSHOTTING', 'FAILED'], SNAPSHOTTING: ['COMPLETE', 'FAILED'],
  COMPLETE: [], FAILED: ['PLANNING', 'CANCELLED'], CANCELLED: [],
};

function mid(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}
async function emit(db: AsyncDb, tenant: string, type: string, ref: string, detail = ''): Promise<void> {
  const at = new Date().toISOString();
  await db.prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'coding-agent', type, ref, detail.slice(0, 500), at).catch(() => {});
}

export async function createMission(db: AsyncDb, tenant: string, request: string): Promise<Mission> {
  const at = new Date().toISOString();
  const m: Mission = { id: mid('COD'), tenant, request, status: 'CREATED', plan: null, approvedBy: null, createdAt: at, updatedAt: at };
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`mission:${tenant}:${m.id}`, JSON.stringify(m));
  await emit(db, tenant, 'MISSION_CREATED', m.id, request);
  return m;
}
export async function getMission(db: AsyncDb, tenant: string, id: string): Promise<Mission | null> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`mission:${tenant}:${id}`)) as { value: string } | undefined;
  return row ? (JSON.parse(String(row.value)) as Mission) : null;
}
export async function transitionMission(db: AsyncDb, tenant: string, id: string, next: MissionStatus, actor = 'system'): Promise<Mission> {
  const m = await getMission(db, tenant, id);
  if (!m) throw new Error(`mission not found: ${id}`);
  if (!TRANSITIONS[m.status].includes(next)) throw new Error(`illegal transition ${m.status} → ${next}`);
  m.status = next; m.updatedAt = new Date().toISOString();
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`mission:${tenant}:${id}`, JSON.stringify(m));
  await emit(db, tenant, next === 'APPROVED' ? 'MISSION_APPROVED' : 'MISSION_TRANSITION', id, `${actor} → ${next}`);
  return m;
}
export async function submitPlan(db: AsyncDb, tenant: string, id: string, plan: PlanStep[]): Promise<Mission> {
  const m = await getMission(db, tenant, id);
  if (!m) throw new Error('mission not found');
  m.plan = plan; m.updatedAt = new Date().toISOString();
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`mission:${tenant}:${id}`, JSON.stringify(m));
  await emit(db, tenant, 'PLAN_SUBMITTED', id, `${plan.length} steps`);
  return m;
}
export async function approveMission(db: AsyncDb, tenant: string, id: string, approver: string): Promise<Mission> {
  const m = await getMission(db, tenant, id);
  if (!m) throw new Error('mission not found');
  if (m.status !== 'PENDING_APPROVAL') throw new Error('mission not awaiting approval');
  m.approvedBy = approver;
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`mission:${tenant}:${id}`, JSON.stringify(m));
  return transitionMission(db, tenant, id, 'APPROVED', approver);
}

// ── Task grouping engine: one MicroVM per compatible ExecutionGroup ──
export interface ExecutionGroup { id: string; missionId: string; taskIds: string[]; reason: string; }

function compatible(a: TaskSpec, b: TaskSpec): string | null {
  if (a.repo !== b.repo) return 'different repo';
  if (a.permissions !== b.permissions || a.trust !== b.trust) return 'security boundary';
  for (const [k, v] of Object.entries(a.runtime)) if (b.runtime[k] && b.runtime[k] !== v) return `runtime conflict ${k}`;
  if (a.resources === 'high' && b.resources === 'high' && a.id !== b.id) return 'high-resource isolation';
  return null;
}

export function groupTasks(missionId: string, tasks: TaskSpec[]): ExecutionGroup[] {
  const groups: { tasks: TaskSpec[]; reason: string }[] = [];
  const ordered = [...tasks].sort((x, y) => x.deps.length - y.deps.length);
  for (const t of ordered) {
    let placed = false;
    for (const g of groups) {
      const bad = g.tasks.map((u) => compatible(t, u)).find(Boolean);
      if (!bad) { g.tasks.push(t); placed = true; break; }
    }
    if (placed) continue;
    // Unplaced: record the first concrete reason it could not share a VM.
    // Empty group list → it is the seed of a new group, nothing conflicted.
    let why = `seed ${t.id}`;
    for (const g of groups) {
      const bad = g.tasks.map((u) => compatible(t, u)).find(Boolean);
      if (bad) { why = bad; break; }
    }
    groups.push({ tasks: [t], reason: why });
  }
  return groups.map((g, i) => {
    const first = g.tasks[0];
    return {
      id: `EG-${missionId.slice(-4)}-${String(i + 1).padStart(3, '0')}`,
      missionId, taskIds: g.tasks.map((t) => t.id),
      reason: first && g.tasks.length > 1
        ? `shared repo=${first.repo} perm=${first.permissions} (${g.tasks.length} tasks)`
        : g.reason,
    };
  });
}

export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }
