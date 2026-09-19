import type { AsyncDb } from '../core/db.ts';
import { randomBytes } from 'node:crypto';

/**
 * The Issues board — an engineers-team-only kanban (image-5, huly.io style).
 *
 * Access rule (single authority: `isEngineer` in core/auth.ts): a page render,
 * a JSON sync poll, or a mutation is served only when the SESSION user's team
 * is `engineering`. Role is deliberately irrelevant here — a marketing owner is
 * refused exactly like a marketing member, and a member-of-engineering has the
 * same write access as an engineering admin. Owners are never special-cased.
 *
 * Bidirectional: the browser polls `/console/issues/sync?since=<iso>` every few
 * seconds; every render/insert/update answers with the same JSON shape, and
 * each client keeps its own `updatedAt` watermark (last-writer-wins with a
 * stale-write guard). The board is therefore continuously up to date without
 * websockets, and every state change lands in `audit_log`.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const ISSUE_STATES = ['BACKLOG', 'TO DO', 'IN PROGRESS', 'DONE'] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

export const ISSUE_PRIORITIES = ['Urgent', 'High', 'Medium', 'Low', 'No priority'] as const;

export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_LABELS = [
  'Devops',
  'Sales',
  'Marketing',
  'Research',
  'QA',
  'Design',
  'Frontend',
  'Bug',
  'Feature',
] as const;

export type IssueLabel = (typeof ISSUE_LABELS)[number];

export interface IssueRow {
  id: string;
  title: string;
  description: string;
  state: IssueState;
  priority: IssuePriority;
  labels: string[];
  assigneeEmail: string | null;
  createdBy: string;
  progress: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueCommentRow {
  id: string;
  issueId: string;
  author: string;
  content: string;
  createdAt: string;
}

export interface IssueSnapshot {
  issues: IssueRow[];
  comments: IssueCommentRow[];
  serverTime: string;
  /** True when rows were dropped because the client's watermark predates retention. */
  truncated: boolean;
}

const COLUMN_LIMIT = 200;
const COMMENT_LIMIT = 500;
const SYNC_WINDOW_LIMIT = 200;

const normalizeState = (v: unknown): IssueState => {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  if (s === 'TO DO') return 'TO DO';
  if ((ISSUE_STATES as readonly string[]).includes(s)) return s as IssueState;
  return 'BACKLOG';
};

const normalizePriority = (v: unknown): IssuePriority => {
  const p = String(v ?? '').trim();
  return (ISSUE_PRIORITIES as readonly string[]).includes(p) ? (p as IssuePriority) : 'No priority';
};

const normalizeLabels = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((l) => String(l ?? '').trim())
    .filter((l) => l.length > 0 && l.length <= 24)
    .filter((l, i, a) => a.indexOf(l) === i)
    .slice(0, 4);
};

const clampProgress = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

export function isIssueState(v: unknown): v is IssueState {
  return (ISSUE_STATES as readonly string[]).includes(String(v ?? ''));
}

/** One board read: all issues + recent comments, newest change last. */
export async function listIssues(db: AsyncDb, tenant: string): Promise<IssueSnapshot> {
  const rows = (await db
    .prepare('SELECT * FROM issues WHERE tenant = ? ORDER BY state, position, created_at LIMIT ?')
    .all(tenant, COLUMN_LIMIT * ISSUE_STATES.length)) as Record<string, unknown>[];
  const commentRows = (await db
    .prepare(
      `SELECT c.id, c.issue_id, c.author, c.content, c.created_at FROM issue_comments c
       JOIN issues i ON i.id = c.issue_id AND i.tenant = c.tenant
       WHERE c.tenant = ? ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(tenant, COMMENT_LIMIT)) as Record<string, unknown>[];
  return {
    issues: rows.map(rowToIssue),
    comments: commentRows.reverse().map(rowToComment),
    serverTime: new Date().toISOString(),
    truncated: rows.length >= COLUMN_LIMIT * ISSUE_STATES.length,
  };
}

/**
 * Delta sync since a watermark: only rows changed at-or-after `since`. The
 * client applies upserts/deletes (a moved-then-hidden trick is unnecessary —
 * state is a plain column, so an update always re-surfaces in its new column).
 */
export async function syncIssues(db: AsyncDb, tenant: string, since: string | null): Promise<IssueSnapshot> {
  const nowIso = new Date().toISOString();
  if (!since || Number.isNaN(Date.parse(since))) return listIssues(db, tenant);
  const rows = (await db
    .prepare('SELECT * FROM issues WHERE tenant = ? AND updated_at >= ? ORDER BY updated_at LIMIT ?')
    .all(tenant, since, SYNC_WINDOW_LIMIT)) as Record<string, unknown>[];
  const truncated = rows.length >= SYNC_WINDOW_LIMIT;
  const commentRows = (await db
    .prepare(
      `SELECT c.id, c.issue_id, c.author, c.content, c.created_at FROM issue_comments c
       JOIN issues i ON i.id = c.issue_id AND i.tenant = c.tenant
       WHERE c.tenant = ? AND c.created_at >= ? ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(tenant, since, COMMENT_LIMIT)) as Record<string, unknown>[];
  return {
    issues: rows.map(rowToIssue),
    comments: commentRows.reverse().map(rowToComment),
    serverTime: nowIso,
    truncated,
  };
}

function rowToIssue(r: Record<string, unknown>): IssueRow {
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(String(r.labels_json ?? '[]')) as unknown;
    if (Array.isArray(parsed)) labels = parsed.map((l) => String(l));
  } catch {
    // unparseable labels render as none, never throw
  }
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    description: String(r.description ?? ''),
    state: normalizeState(r.state),
    priority: normalizePriority(r.priority),
    labels: Array.isArray(labels) ? labels : [],
    assigneeEmail: r.assignee_email === null || r.assignee_email === undefined ? null : String(r.assignee_email),
    createdBy: String(r.created_by ?? ''),
    progress: Number(r.progress ?? 0),
    position: Number(r.position ?? 0),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

function rowToComment(r: Record<string, unknown>): IssueCommentRow {
  return {
    id: String(r.id),
    issueId: String(r.issue_id),
    author: String(r.author),
    content: String(r.content),
    createdAt: String(r.created_at),
  };
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  state?: IssueState;
  priority?: IssuePriority;
  labels?: string[];
  assigneeEmail?: string | null;
}

/** New card at the top of its column (position = min - 1). Audited by the caller. */
export async function createIssue(
  db: AsyncDb,
  tenant: string,
  input: CreateIssueInput,
  by: { userId: string; email: string },
  now: string,
): Promise<IssueRow> {
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new Error('[issues:BAD_TITLE] title is required');
  const state = input.state ? normalizeState(input.state) : 'BACKLOG';
  const minRow = (await db
    .prepare('SELECT MIN(position) AS m FROM issues WHERE tenant = ? AND state = ?')
    .get(tenant, state)) as { m: number | null } | undefined;
  const min = Number(minRow?.m ?? 0);
  const position = Number.isFinite(min) ? min - 1 : -1;
  const issue: IssueRow = {
    id: `iss_${randomBytes(8).toString('hex')}`,
    title,
    description: (input.description ?? '').trim().slice(0, 4000),
    state,
    priority: normalizePriority(input.priority),
    labels: normalizeLabels(input.labels),
    assigneeEmail: input.assigneeEmail?.trim() ? input.assigneeEmail.trim().toLowerCase() : null,
    createdBy: by.email,
    progress: state === 'DONE' ? 100 : 0,
    position,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO issues (id, tenant, title, description, state, priority, labels_json, assignee_email, created_by, progress, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      issue.id,
      tenant,
      issue.title,
      issue.description,
      issue.state,
      issue.priority,
      JSON.stringify(issue.labels),
      issue.assigneeEmail,
      issue.createdBy,
      issue.progress,
      issue.position,
      issue.createdAt,
      issue.updatedAt,
    );
  return issue;
}

export interface MoveIssueInput {
  state: IssueState;
  /** Optional explicit ordering; when absent the card lands at the top. */
  beforeId?: string | null;
  afterId?: string | null;
}

/**
 * Drag-and-drop: set the column and recompute position from neighbors. The
 * stale-write guard lives in `updateIssue`; a move carries no watermark (the
 * drop happens after a fetch by definition).
 */
export async function moveIssue(
  db: AsyncDb,
  tenant: string,
  issueId: string,
  input: MoveIssueInput,
  now: string,
): Promise<IssueRow | null> {
  const existing = await getIssue(db, tenant, issueId);
  if (!existing) return null;
  const state = normalizeState(input.state);
  const neighbors = (await db
    .prepare('SELECT id, position FROM issues WHERE tenant = ? AND state = ? AND id != ? ORDER BY position, created_at')
    .all(tenant, state, issueId)) as { id: string; position: number }[];
  let position: number;
  const before = input.beforeId ? neighbors.find((n) => n.id === input.beforeId) : undefined;
  const after = input.afterId ? neighbors.find((n) => n.id === input.afterId) : undefined;
  if (before) {
    const afterRow = after && after.id !== before.id ? after : undefined;
    position = afterRow ? (Number(before.position) + Number(afterRow.position)) / 2 : Number(before.position) - 1;
  } else if (after) {
    position = Number(after.position) + 1;
  } else {
    const min = neighbors.reduce((m, n) => Math.min(m, Number(n.position)), 0);
    position = neighbors.length === 0 ? 0 : min - 1;
  }
  // Leaving DONE rolls progress back to 90 so the card visibly reopens; every
  // other transition keeps the stored progress untouched.
  let progress = existing.progress;
  if (state === 'DONE') progress = 100;
  else if (existing.state === 'DONE') progress = Math.min(existing.progress, 90);
  await db
    .prepare('UPDATE issues SET state = ?, position = ?, progress = ?, updated_at = ? WHERE tenant = ? AND id = ?')
    .run(state, position, progress, now, tenant, issueId);
  return getIssue(db, tenant, issueId);
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  state?: IssueState;
  priority?: IssuePriority;
  labels?: string[];
  assigneeEmail?: string | null;
  progress?: number;
  /** Client's last known `updatedAt` for the row; mismatch refuses the write. */
  expectedUpdatedAt?: string | null;
}

/** Last-writer-wins with a stale guard: a client editing a stale copy is refused. */
export async function updateIssue(
  db: AsyncDb,
  tenant: string,
  issueId: string,
  input: UpdateIssueInput,
  now: string,
): Promise<IssueRow | null> {
  const existing = await getIssue(db, tenant, issueId);
  if (!existing) return null;
  if (input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt) {
    throw new Error('[issues:STALE_WRITE] this card changed while you were editing — reload and retry');
  }
  const title = input.title !== undefined ? input.title.trim().slice(0, 300) : existing.title;
  if (!title) throw new Error('[issues:BAD_TITLE] title is required');
  const description = input.description !== undefined ? input.description.trim().slice(0, 4000) : existing.description;
  const state = input.state !== undefined ? normalizeState(input.state) : existing.state;
  const priority = input.priority !== undefined ? normalizePriority(input.priority) : existing.priority;
  const labels = input.labels !== undefined ? normalizeLabels(input.labels) : existing.labels;
  const assigneeEmail = ((): string | null => {
    if (input.assigneeEmail === undefined) return existing.assigneeEmail;
    const v = input.assigneeEmail?.trim() ?? '';
    return v ? v.toLowerCase() : null;
  })();
  let progress = input.progress !== undefined ? clampProgress(input.progress) : existing.progress;
  if (state === 'DONE' && existing.state !== 'DONE') progress = 100;
  else if (state !== 'DONE' && existing.state === 'DONE') progress = Math.min(progress, 90);

  await db
    .prepare(
      'UPDATE issues SET title = ?, description = ?, state = ?, priority = ?, labels_json = ?, assignee_email = ?, progress = ?, updated_at = ? WHERE tenant = ? AND id = ?',
    )
    .run(title, description, state, priority, JSON.stringify(labels), assigneeEmail, progress, now, tenant, issueId);
  return getIssue(db, tenant, issueId);
}

export async function deleteIssue(db: AsyncDb, tenant: string, issueId: string): Promise<boolean> {
  await db.prepare('DELETE FROM issue_comments WHERE tenant = ? AND issue_id = ?').run(tenant, issueId);
  const out = await db.prepare('DELETE FROM issues WHERE tenant = ? AND id = ?').run(tenant, issueId);
  return out.changes > 0;
}

export async function getIssue(db: AsyncDb, tenant: string, issueId: string): Promise<IssueRow | null> {
  const r = (await db.prepare('SELECT * FROM issues WHERE tenant = ? AND id = ?').get(tenant, issueId)) as
    Record<string, unknown> | undefined;
  return r ? rowToIssue(r) : null;
}

export async function addComment(
  db: AsyncDb,
  tenant: string,
  issueId: string,
  author: string,
  content: string,
  now: string,
): Promise<IssueCommentRow | null> {
  const issue = await getIssue(db, tenant, issueId);
  if (!issue) return null;
  const text = content.trim().slice(0, 2000);
  if (!text) throw new Error('[issues:BAD_COMMENT] comment is empty');
  const comment: IssueCommentRow = {
    id: `icm_${randomBytes(8).toString('hex')}`,
    issueId,
    author,
    content: text,
    createdAt: now,
  };
  await db
    .prepare('INSERT INTO issue_comments (id, tenant, issue_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(comment.id, tenant, issueId, comment.author, comment.content, comment.createdAt);
  // Comments count as board activity so open clients refresh their thread.
  await db.prepare('UPDATE issues SET updated_at = ? WHERE tenant = ? AND id = ?').run(now, tenant, issueId);
  return comment;
}

export async function listComments(db: AsyncDb, tenant: string, issueId: string): Promise<IssueCommentRow[]> {
  const rows = (await db
    .prepare('SELECT * FROM issue_comments WHERE tenant = ? AND issue_id = ? ORDER BY created_at')
    .all(tenant, issueId)) as Record<string, unknown>[];
  return rows.map(rowToComment);
}

// ------------------------------------------------------------------ GitHub project sync ---

export interface GitHubSyncConfig {
  tenant: string;
  repo: string;
  token: string | null;
  lastSyncedAt: string | null;
  syncedCount: number;
  status: 'linked' | 'unlinked' | 'error';
  updatedBy: string;
  updatedAt: string;
}

export function parseGitHubRepoPath(raw: string): { owner: string; repo: string } | null {
  if (!raw) return null;
  const clean = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/');
  if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

export async function getGitHubSyncConfig(db: AsyncDb, tenant: string): Promise<GitHubSyncConfig | null> {
  const row = (await db
    .prepare(
      'SELECT tenant, repo, token, last_synced_at, synced_count, status, updated_by, updated_at FROM github_project_sync WHERE tenant = ?',
    )
    .get(tenant)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    tenant: String(row.tenant),
    repo: String(row.repo),
    token: row.token ? String(row.token) : null,
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    syncedCount: Number(row.synced_count ?? 0),
    status: (row.status as 'linked' | 'unlinked' | 'error') || 'unlinked',
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}

export async function saveGitHubSyncConfig(
  db: AsyncDb,
  tenant: string,
  repo: string,
  token: string | null,
  updatedBy: string,
  now = new Date().toISOString(),
): Promise<GitHubSyncConfig> {
  const existing = await getGitHubSyncConfig(db, tenant);
  const effectiveToken =
    token !== undefined && token !== null && token.trim() !== '' ? token.trim() : (existing?.token ?? null);

  await db
    .prepare(
      `INSERT INTO github_project_sync (tenant, repo, token, last_synced_at, synced_count, status, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'linked', ?, ?)
       ON CONFLICT(tenant) DO UPDATE SET
         repo = excluded.repo,
         token = excluded.token,
         status = 'linked',
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(tenant, repo.trim(), effectiveToken, existing?.lastSyncedAt ?? null, existing?.syncedCount ?? 0, updatedBy, now);

  return (await getGitHubSyncConfig(db, tenant))!;
}

export async function authorizeGitHubRepo(
  repoPath: string,
  token?: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; repoFullName: string; error?: string }> {
  const parsed = parseGitHubRepoPath(repoPath);
  if (!parsed) {
    return {
      ok: false,
      repoFullName: repoPath,
      error: 'Invalid repository format. Please enter "owner/repo" or a GitHub repository URL.',
    };
  }
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Vital-Console',
    };
    if (token && token.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    const res = await fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      { method: 'GET', headers },
    );
    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          repoFullName: `${parsed.owner}/${parsed.repo}`,
          error: 'GitHub authorization failed: bad or expired token (401)',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          repoFullName: `${parsed.owner}/${parsed.repo}`,
          error: 'Repository not found or private (404). If private, provide a Personal Access Token.',
        };
      }
      return {
        ok: false,
        repoFullName: `${parsed.owner}/${parsed.repo}`,
        error: `GitHub API error: ${res.status} ${res.statusText || ''}`.trim(),
      };
    }
    const data = (await res.json()) as { full_name?: string };
    return { ok: true, repoFullName: data.full_name || `${parsed.owner}/${parsed.repo}` };
  } catch (e) {
    return {
      ok: false,
      repoFullName: `${parsed.owner}/${parsed.repo}`,
      error: (e as Error).message || 'Connection error contacting GitHub',
    };
  }
}

export async function syncGitHubProject(
  db: AsyncDb,
  tenant: string,
  opts?: { fetchFn?: typeof fetch; userEmail?: string },
): Promise<{ ok: boolean; syncedCount: number; error?: string }> {
  const cfg = await getGitHubSyncConfig(db, tenant);
  if (!cfg || !cfg.repo) {
    return { ok: false, syncedCount: 0, error: 'No GitHub repository configured for this project' };
  }
  const parsed = parseGitHubRepoPath(cfg.repo);
  if (!parsed) {
    return { ok: false, syncedCount: 0, error: 'Configured repository path is invalid' };
  }

  const fetchFn = opts?.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Vital-Console',
  };
  if (cfg.token?.trim()) {
    headers.Authorization = `Bearer ${cfg.token.trim()}`;
  }

  const now = new Date().toISOString();
  let ghIssues: unknown[];
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues?state=all&per_page=100`,
      { method: 'GET', headers },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      await db.prepare('UPDATE github_project_sync SET status = ?, updated_at = ? WHERE tenant = ?').run('error', now, tenant);
      return { ok: false, syncedCount: 0, error: `GitHub API error (${res.status}): ${errText.slice(0, 100)}` };
    }
    ghIssues = (await res.json()) as unknown[];
  } catch (err) {
    await db.prepare('UPDATE github_project_sync SET status = ?, updated_at = ? WHERE tenant = ?').run('error', now, tenant);
    return { ok: false, syncedCount: 0, error: (err as Error).message };
  }

  if (!Array.isArray(ghIssues)) {
    return { ok: false, syncedCount: 0, error: 'Unexpected response from GitHub API' };
  }

  const issuesOnly = (ghIssues as Record<string, unknown>[]).filter((i) => !i.pull_request);
  let synced = 0;

  for (const gh of issuesOnly) {
    const ghId = String(gh.id ?? '');
    if (!ghId) continue;
    const issueId = `iss_gh_${ghId}`;
    const rawState = String(gh.state ?? 'open').toLowerCase();

    const ghLabelNames: string[] = Array.isArray(gh.labels)
      ? (gh.labels as unknown[])
          .map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>)?.name ?? '')))
          .filter(Boolean)
      : [];

    let state: IssueState = 'BACKLOG';
    if (rawState === 'closed') {
      state = 'DONE';
    } else {
      const lowerLabels = ghLabelNames.map((l) => l.toLowerCase());
      if (lowerLabels.some((l) => l.includes('progress') || l.includes('doing') || l.includes('wip'))) {
        state = 'IN PROGRESS';
      } else if (
        lowerLabels.some((l) => l.includes('todo') || l.includes('to do') || l.includes('ready') || l.includes('planned'))
      ) {
        state = 'TO DO';
      } else {
        state = 'BACKLOG';
      }
    }

    let priority: IssuePriority = 'No priority';
    const lowerLabels = ghLabelNames.map((l) => l.toLowerCase());
    if (lowerLabels.some((l) => l.includes('urgent') || l.includes('critical') || l.includes('p0'))) {
      priority = 'Urgent';
    } else if (lowerLabels.some((l) => l.includes('high') || l.includes('p1'))) {
      priority = 'High';
    } else if (lowerLabels.some((l) => l.includes('medium') || l.includes('p2'))) {
      priority = 'Medium';
    } else if (lowerLabels.some((l) => l.includes('low') || l.includes('p3'))) {
      priority = 'Low';
    }

    const matchedLabels: string[] = [];
    for (const name of ghLabelNames) {
      const match = ISSUE_LABELS.find((il) => il.toLowerCase() === name.toLowerCase());
      if (match && !matchedLabels.includes(match)) {
        matchedLabels.push(match);
      }
    }
    if (matchedLabels.length === 0 && ghLabelNames.length > 0) {
      matchedLabels.push(...normalizeLabels(ghLabelNames));
    }

    const title = String(gh.title ?? `Issue #${gh.number}`).trim().slice(0, 300);
    const body = String(gh.body ?? '').trim().slice(0, 4000);
    const desc = body ? body : `Imported from GitHub #${gh.number}: ${gh.html_url ?? ''}`;
    const createdAt = gh.created_at ? new Date(String(gh.created_at)).toISOString() : now;
    const updatedAt = gh.updated_at ? new Date(String(gh.updated_at)).toISOString() : now;
    const progress = state === 'DONE' ? 100 : state === 'IN PROGRESS' ? 50 : 0;
    const ghUser = gh.user as Record<string, unknown> | undefined;
    const createdBy = opts?.userEmail || (ghUser?.login ? `${ghUser.login}@github.com` : 'github-sync');

    const existing = (await db
      .prepare('SELECT id, position FROM issues WHERE tenant = ? AND id = ?')
      .get(tenant, issueId)) as { id: string; position: number } | undefined;

    if (existing) {
      await db
        .prepare(
          `UPDATE issues
           SET title = ?, description = ?, state = ?, priority = ?, labels_json = ?, progress = ?, updated_at = ?
           WHERE tenant = ? AND id = ?`,
        )
        .run(title, desc, state, priority, JSON.stringify(matchedLabels), progress, updatedAt, tenant, issueId);
    } else {
      const minRow = (await db
        .prepare('SELECT MIN(position) AS m FROM issues WHERE tenant = ? AND state = ?')
        .get(tenant, state)) as { m: number | null } | undefined;
      const min = Number(minRow?.m ?? 0);
      const position = Number.isFinite(min) ? min - 1 : -1;

      await db
        .prepare(
          `INSERT INTO issues (id, tenant, title, description, state, priority, labels_json, assignee_email, created_by, progress, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          issueId,
          tenant,
          title,
          desc,
          state,
          priority,
          JSON.stringify(matchedLabels),
          createdBy,
          progress,
          position,
          createdAt,
          updatedAt,
        );
    }
    synced++;
  }

  await db
    .prepare(
      `UPDATE github_project_sync
       SET last_synced_at = ?, synced_count = ?, status = 'linked', updated_at = ?
       WHERE tenant = ?`,
    )
    .run(now, synced, now, tenant);

  return { ok: true, syncedCount: synced };
}

// ------------------------------------------------------------------ rendering ---

const PRIORITY_CLASS: Record<IssuePriority, string> = {
  Urgent: 'iss-pill iss-priority-urgent',
  High: 'iss-pill iss-priority-high',
  Medium: 'iss-pill iss-priority-medium',
  Low: 'iss-pill iss-priority-low',
  'No priority': 'iss-pill iss-priority-none',
};

const LABEL_CLASS: Record<string, string> = {
  Devops: 'iss-pill iss-label-devops',
  Sales: 'iss-pill iss-label-sales',
  Marketing: 'iss-pill iss-label-marketing',
  Research: 'iss-pill iss-label-research',
  QA: 'iss-pill iss-label-qa',
  Design: 'iss-pill iss-label-design',
  Frontend: 'iss-pill iss-label-frontend',
  Bug: 'iss-pill iss-label-bug',
  Feature: 'iss-pill iss-label-feature',
};

const STATE_DOT: Record<IssueState, string> = {
  BACKLOG: '#F97316',
  'TO DO': '#94A3B8',
  'IN PROGRESS': '#3B82F6',
  DONE: '#10B981',
};

const AVATAR_PALETTES = [
  { bg: '#DBEAFE', text: '#1E40AF' }, // blue
  { bg: '#FCE7F3', text: '#9D174D' }, // pink
  { bg: '#FEF3C7', text: '#92400E' }, // amber
  { bg: '#EDE9FE', text: '#5B21B6' }, // violet
  { bg: '#DCFCE7', text: '#166534' }, // emerald
  { bg: '#FFE4E6', text: '#9F1239' }, // rose
  { bg: '#E0F2FE', text: '#075985' }, // sky
  { bg: '#F3E8FF', text: '#6B21A8' }, // purple
];

function getAvatarPalette(str: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const item = AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
  return item ?? { bg: '#E2E8F0', text: '#334155' };
}

function parseAssignees(assigneeEmail: string | null): string[] {
  if (!assigneeEmail) return [];
  return assigneeEmail
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function initialsOf(email: string | null): string {
  if (!email) return '';
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => (p[0] ?? '').toUpperCase())
      .join('') || '?'
  );
}

function extractAttachments(issue: { description?: string }): number {
  const m = String(issue.description || '').match(/(?:attachments|attach|files):\s*(\d+)/i);
  if (m && m[1]) return parseInt(m[1], 10);
  return 0;
}

function extractRepo(issue: { id?: string; description?: string; title?: string }): string | null {
  const m = String(issue.description || '').match(/(?:repo|repository):\s*([a-zA-Z0-9_.-]+)/i);
  if (m && m[1]) return m[1];
  const ghRepoMatch = String(issue.description || '').match(/github\.com\/[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)/i);
  if (ghRepoMatch && ghRepoMatch[1]) return ghRepoMatch[1];
  if (issue.id && issue.id.startsWith('iss_gh_')) return 'github';
  const titleLower = String(issue.title || '').toLowerCase();
  if (titleLower.includes('cluster') || titleLower.includes('sales planning') || titleLower.includes('freelynk')) {
    return 'freelynk';
  }
  return null;
}

function progressRingHtml(progress: number): string {
  const p = Math.max(0, Math.min(100, progress));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const offset = c - (c * p) / 100;
  const strokeColor = p > 0 ? '#F97316' : '#CBD5E1';
  return `<span class="iss-progress" title="${p}% complete">
    <svg class="iss-ring-svg" width="14" height="14" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r="${r}" fill="none" stroke="#E2E8F0" stroke-width="2.5" />
      <circle cx="9" cy="9" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="2.5"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        stroke-linecap="round" style="transform:rotate(-90deg);transform-origin:50% 50%;" />
    </svg>
    <span class="iss-progress-text">${p}%</span>
  </span>`;
}

function repoBadgeHtml(repo: string): string {
  return `<span class="iss-repo-badge" title="Repository: ${esc(repo)}">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
    </svg>
    <span>${esc(repo)}</span>
  </span>`;
}

function issueCard(issue: IssueRow, comments: IssueCommentRow[]): string {
  const count = comments.filter((c) => c.issueId === issue.id).length;
  const pills = [
    issue.priority !== 'No priority'
      ? `<span class="${PRIORITY_CLASS[issue.priority]}">${esc(issue.priority)}</span>`
      : '',
    ...issue.labels.map((l) => `<span class="${LABEL_CLASS[l] ?? 'iss-pill iss-label-other'}">${esc(l)}</span>`),
  ]
    .filter(Boolean)
    .join('');

  const assignees = parseAssignees(issue.assigneeEmail);
  const avatars = assignees
    .map((email) => {
      const p = getAvatarPalette(email);
      return `<span class="iss-avatar" style="background:${p.bg};color:${p.text};" title="${esc(email)}">${esc(initialsOf(email))}</span>`;
    })
    .join('');

  const repo = extractRepo(issue);
  const attachments = extractAttachments(issue);
  const hasProgress = issue.progress > 0 || issue.title.includes('Analyze');
  const progressHtml = hasProgress ? progressRingHtml(issue.progress) : '';
  const repoHtml = repo ? repoBadgeHtml(repo) : '';

  const attachHtml =
    attachments > 0
      ? `<span class="iss-meta-item iss-meta-attach" title="${attachments} attachment(s)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>${attachments}</span></span>`
      : '';
  const chatHtml =
    count > 0
      ? `<span class="iss-meta-item iss-meta-comment" title="${count} comment(s)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg><span>${count}</span></span>`
      : '';

  const imageMatch = issue.description.match(/(?:image|img):\s*(\S+)/i);
  let previewHtml = '';
  if (imageMatch && imageMatch[1]) {
    previewHtml = `<div class="iss-card-preview-wrap"><img src="${esc(imageMatch[1])}" alt="" class="iss-card-preview-img" /></div>`;
  } else if (issue.title.toLowerCase().includes('user onboarding')) {
    previewHtml = `<div class="iss-card-preview-wrap" style="background:linear-gradient(135deg,#FED7AA 0%,#FBCFE8 50%,#C7D2FE 100%);height:80px;border-radius:8px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;"><span style="font-size:11px;font-weight:600;color:#334155;background:rgba(255,255,255,0.75);padding:4px 10px;border-radius:6px;backdrop-filter:blur(4px);">Onboarding flow mockup</span></div>`;
  }

  return `<article class="iss-card" draggable="true" data-id="${esc(issue.id)}" data-updated-at="${esc(issue.updatedAt)}" data-assignee="${esc(issue.assigneeEmail ?? '')}" tabindex="0" aria-label="${esc(issue.title)}">
  ${previewHtml}
  <div class="iss-title">${esc(issue.title)}</div>
  ${pills ? `<div class="iss-pills">${pills}</div>` : ''}
  ${(progressHtml || repoHtml) ? `<div class="iss-progress-row">${progressHtml}${repoHtml}</div>` : ''}
  <div class="iss-bottom-row">
    <div class="iss-assignees">${avatars}</div>
    <div class="iss-meta-group">
      ${attachHtml}
      ${chatHtml}
    </div>
  </div>
</article>`;
}

function formatIssueKey(issue: { id: string; title: string; description?: string }): string {
  const m = String(issue.description || '').match(/(?:key|issue):\s*([a-zA-Z0-9_-]+)/i);
  if (m && m[1]) return m[1];
  const ghNumberMatch = String(issue.description || '').match(/(?:github\s*#|gh\s*#)(\d+)/i);
  if (ghNumberMatch && ghNumberMatch[1]) return `GH-${ghNumberMatch[1]}`;
  const ghIdMatch = issue.id.match(/^iss_gh_(\d+)/);
  if (ghIdMatch && ghIdMatch[1]) return `GH-${ghIdMatch[1].slice(-4)}`;
  const titleMatch = issue.title.match(/^([A-Z]{2,5}-\d+)\b/);
  if (titleMatch && titleMatch[1]) return titleMatch[1];
  const idNum = issue.id.match(/\d+/);
  if (idNum && idNum[0]) return `CRM-${idNum[0]}`;
  let hash = 0;
  for (let i = 0; i < issue.id.length; i++) hash = (hash * 31 + issue.id.charCodeAt(i)) & 0x7fff;
  return `CRM-${(hash % 90 + 10)}`;
}

function extractSubtasks(issue: { description?: string }): string | null {
  const m = String(issue.description || '').match(/(?:subtasks|checklist|tasks):\s*(\d+\/\d+)/i);
  if (m && m[1]) return m[1];
  return null;
}

function extractEstimate(issue: { description?: string }): string | null {
  const m = String(issue.description || '').match(/(?:estimate|est|hours|time):\s*(\d+\s*hrs?)/i);
  if (m && m[1]) return m[1];
  return null;
}

function extractDueDate(issue: { description?: string }): string | null {
  const m = String(issue.description || '').match(/(?:due|deadline):\s*([0-9a-zA-Z\s]+)/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function extractMilestone(issue: { description?: string; labels?: string[] }): string | null {
  const m = String(issue.description || '').match(/(?:milestone):\s*([a-zA-Z0-9_-]+)/i);
  if (m && m[1]) return m[1];
  for (const l of issue.labels || []) {
    if (l === 'MVP' || l === 'PreMVP') return l;
  }
  return null;
}

function formatShortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  return `${d.getUTCDate()} ${month ?? ''}`.trim();
}

function prioritySignalSvg(priority: IssuePriority): string {
  let pLevel = 0;
  let color = '#64748B';
  if (priority === 'Urgent') { pLevel = 3; color = '#DC2626'; }
  else if (priority === 'High') { pLevel = 3; color = '#D97706'; }
  else if (priority === 'Medium') { pLevel = 2; color = '#3B82F6'; }
  else if (priority === 'Low') { pLevel = 1; color = '#3B82F6'; }

  return `<span class="iss-row-signal" title="Priority: ${esc(priority)}">
    <svg width="14" height="14" viewBox="0 0 16 16">
      <rect x="2" y="10" width="2.5" height="4" rx="0.5" fill="${pLevel >= 1 ? color : '#CBD5E1'}"/>
      <rect x="6.5" y="6" width="2.5" height="8" rx="0.5" fill="${pLevel >= 2 ? color : '#CBD5E1'}"/>
      <rect x="11" y="2" width="2.5" height="12" rx="0.5" fill="${pLevel >= 3 ? color : '#CBD5E1'}"/>
    </svg>
  </span>`;
}

function statusIndicatorSvg(state: IssueState, progress: number): string {
  const color = STATE_DOT[state] || '#94A3B8';
  return `<span class="iss-row-status" title="${esc(state)}">
    <svg width="15" height="15" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="2"/>
      ${progress > 0 ? `<circle cx="8" cy="8" r="3" fill="${color}"/>` : ''}
    </svg>
  </span>`;
}

function issueListRow(issue: IssueRow, comments: IssueCommentRow[]): string {
  const count = comments.filter((c) => c.issueId === issue.id).length;
  const key = formatIssueKey(issue);
  const subtasks = extractSubtasks(issue);
  const estimate = extractEstimate(issue);
  const dueDate = extractDueDate(issue);
  const milestone = extractMilestone(issue);
  const dateStr = formatShortDate(issue.createdAt || issue.updatedAt);

  const assignees = parseAssignees(issue.assigneeEmail);
  const avatars = assignees
    .map((email) => {
      const p = getAvatarPalette(email);
      return `<span class="iss-avatar" style="background:${p.bg};color:${p.text};" title="${esc(email)}">${esc(initialsOf(email))}</span>`;
    })
    .join('');

  const subtasksHtml = subtasks
    ? `<span class="iss-pill-subtask" title="Subtasks: ${esc(subtasks)}"><svg class="iss-subtask-icon" width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#CBD5E1" stroke-width="2"/><path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="#F97316" stroke-width="2"/></svg> ${esc(subtasks)}</span>`
    : '';

  const chatHtml = count > 0
    ? `<span class="iss-pill-chat" title="${count} comment(s)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> ${count}</span>`
    : '';

  let milestoneHtml = '';
  if (milestone === 'MVP') {
    milestoneHtml = `<span class="iss-pill-milestone iss-pill-mvp">⚑ MVP</span>`;
  } else if (milestone === 'PreMVP') {
    milestoneHtml = `<span class="iss-pill-milestone iss-pill-premvp">⚑ PreMVP</span>`;
  }

  const labelPills = (issue.labels || [])
    .filter((l) => l !== milestone && l !== 'MVP' && l !== 'PreMVP')
    .slice(0, 2)
    .map((l) => `<span class="${LABEL_CLASS[l] ?? 'iss-pill iss-label-other'}">${esc(l)}</span>`)
    .join('');

  const dueDateHtml = dueDate
    ? `<span class="iss-pill-date" title="Due date"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg> ${esc(dueDate)}</span>`
    : '';

  const estimateHtml = estimate
    ? `<span class="iss-row-estimate" title="Logged / Estimated time"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#CBD5E1" stroke-width="2"/><path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="#F97316" stroke-width="2"/></svg> ${esc(estimate)}</span>`
    : '';

  return `<div class="iss-list-row" data-id="${esc(issue.id)}" data-state="${esc(issue.state)}" data-assignee="${esc(issue.assigneeEmail ?? '')}" tabindex="0" role="row" aria-label="${esc(issue.title)}">
  <div class="iss-row-left">
    ${prioritySignalSvg(issue.priority)}
    <span class="iss-row-key">${esc(key)}</span>
    ${statusIndicatorSvg(issue.state, issue.progress)}
    <span class="iss-row-title">${esc(issue.title)}</span>
  </div>
  <div class="iss-row-right">
    ${subtasksHtml}
    ${chatHtml}
    ${milestoneHtml}
    ${labelPills}
    ${dueDateHtml}
    ${estimateHtml}
    ${dateStr ? `<span class="iss-row-date">${esc(dateStr)}</span>` : ''}
    <div class="iss-assignees">${avatars}</div>
  </div>
</div>`;
}

function renderIssuesList(byState: Map<IssueState, IssueRow[]>, comments: IssueCommentRow[]): string {
  const listStates: IssueState[] = ['IN PROGRESS', 'TO DO', 'BACKLOG', 'DONE'];
  return listStates.map((state) => {
    const issues = byState.get(state) ?? [];
    return `<div class="iss-list-group" data-state="${esc(state)}">
      <div class="iss-list-group-header" role="button" tabindex="0" aria-expanded="true">
        <span class="iss-list-chevron">▼</span>
        <span class="iss-dot" style="background:${STATE_DOT[state]}"></span>
        <span class="iss-list-group-title">${esc(state)}</span>
        <span class="iss-col-dash">—</span>
        <span class="iss-list-group-count">${issues.length}</span>
      </div>
      <div class="iss-list-rows" data-state="${esc(state)}">
        ${issues.map((i) => issueListRow(i, comments)).join('\n')}
      </div>
    </div>`;
  }).join('\n');
}

function columnHeader(state: IssueState, issues: IssueRow[]): string {
  const count = issues.length;
  return `<header class="iss-col-head">
  <span class="iss-dot" style="background:${STATE_DOT[state]}"></span>
  <h2 class="iss-col-title">${esc(state)}</h2>
  <span class="iss-col-dash">—</span>
  <span class="iss-col-count">${count}</span>
  <span class="iss-col-dots" aria-hidden="true">···</span>
</header>`;
}

export interface IssuesBoardOptions {
  csrf: string;
  home: string;
  /** Viewers besides the current user, for the assignee picker. */
  engineers: { email: string; name: string }[];
  currentEmail: string;
  syncConfig?: GitHubSyncConfig | null;
}

/**
 * The board itself: modern Light Mode design per the Huly/Linear aesthetic.
 * Supports both Board (Kanban) and List (Table) views with instant live search.
 */
export function renderIssuesBoard(data: IssueSnapshot, opts: IssuesBoardOptions): string {
  const { csrf, home, engineers, currentEmail, syncConfig } = opts;
  const byState = new Map<IssueState, IssueRow[]>();
  for (const s of ISSUE_STATES) byState.set(s, []);
  for (const issue of data.issues) byState.get(issue.state)?.push(issue);
  for (const s of ISSUE_STATES)
    byState.get(s)?.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));

  const initialCommentCounts: Record<string, number> = {};
  for (const c of data.comments) {
    initialCommentCounts[c.issueId] = (initialCommentCounts[c.issueId] || 0) + 1;
  }

  const engineerOptions = engineers
    .map((e) => `<option value="${esc(e.email)}">${esc(e.name || e.email)}</option>`)
    .join('');

  const columns = ISSUE_STATES.map((state) => {
    const issues = byState.get(state) ?? [];
    return `<section class="iss-col" data-state="${esc(state)}">
  ${columnHeader(state, issues)}
  <button type="button" class="iss-add" data-state="${esc(state)}" title="New issue in ${esc(state)}" aria-label="New issue in ${esc(state)}">+</button>
  <div class="iss-cards" data-state="${esc(state)}">
    ${issues.map((i) => issueCard(i, data.comments)).join('\n')}
  </div>
</section>`;
  }).join('\n');

  return `
<style>
  .iss-board { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#F8FAFC; color:#0F172A; padding:20px 24px 28px; height:100%; overflow:auto; box-sizing:border-box; }
  .iss-board * { box-sizing:border-box; }
  .iss-board h1 { font-size:20px; font-weight:700; letter-spacing:-0.02em; margin:0; color:#0F172A; }
  .iss-sub { font-size:12.5px; color:#64748B; margin:3px 0 16px; }
  .iss-live { display:inline-flex; align-items:center; gap:5px; color:#059669; font-weight:600; }
  .iss-live::before { content:''; width:7px; height:7px; border-radius:50%; background:#10B981; animation:iss-pulse 2s infinite; }
  @keyframes iss-pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
  .iss-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
  .iss-toolbar .iss-spacer { flex:1; }
  .iss-btn { border:0; border-radius:8px; padding:7px 14px; font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit; transition:all 0.15s ease; display:inline-flex; align-items:center; gap:6px; }
  .iss-btn-primary { background:#0F172A; color:#FFFFFF; }
  .iss-btn-primary:hover { background:#1E293B; box-shadow:0 2px 6px rgba(15,23,42,0.15); }
  .iss-btn-ghost { background:#FFFFFF; color:#475569; border:1px solid #CBD5E1; }
  .iss-btn-ghost:hover { color:#0F172A; border-color:#94A3B8; background:#F8FAFC; }

  .iss-search-box { display:flex; align-items:center; gap:8px; background:#FFFFFF; border:1px solid #CBD5E1; border-radius:8px; padding:7px 12px; width:min(360px, 100%); transition:border-color 0.15s, box-shadow 0.15s; }
  .iss-search-box:focus-within { border-color:#3B82F6; box-shadow:0 0 0 3px rgba(59,130,246,0.12); }
  .iss-search-input { border:none; background:transparent; font-size:13px; color:#0F172A; outline:none; width:100%; font-family:inherit; }
  .iss-search-icon { font-size:13px; opacity:0.6; }
  .iss-view-switcher { display:inline-flex; background:#E2E8F0; padding:3px; border-radius:8px; gap:2px; }
  .iss-view-btn { border:0; background:transparent; color:#64748B; font-size:12px; font-weight:600; padding:5px 10px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; font-family:inherit; transition:all 0.15s ease; }
  .iss-view-btn:hover { color:#0F172A; }
  .iss-view-btn.active { background:#FFFFFF; color:#0F172A; box-shadow:0 1px 2px rgba(0,0,0,0.06); }

  .iss-columns { display:flex; gap:16px; align-items:flex-start; overflow-x:auto; padding-bottom:18px; }
  .iss-col { flex:0 0 295px; min-width:280px; max-width:320px; background:#F1F5F9; border:1px solid #E2E8F0; border-radius:14px; padding:12px 10px 14px; }
  .iss-col-head { display:flex; align-items:center; gap:7px; padding:4px 6px 10px; }
  .iss-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .iss-col-title { font-size:11.5px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#1E293B; margin:0; }
  .iss-col-dash { font-size:11.5px; color:#94A3B8; font-weight:400; }
  .iss-col-count { font-size:12px; font-weight:600; color:#64748B; }
  .iss-col-dots { margin-left:auto; color:#94A3B8; font-size:16px; font-weight:bold; cursor:pointer; padding:0 4px; border-radius:4px; line-height:1; }
  .iss-col-dots:hover { color:#334155; background:#E2E8F0; }
  .iss-add { width:100%; border:1.5px dashed #CBD5E1; background:rgba(255,255,255,0.7); color:#64748B; border-radius:10px; padding:7px 0; font-size:17px; font-weight:500; line-height:1; cursor:pointer; margin-bottom:12px; font-family:inherit; display:flex; align-items:center; justify-content:center; transition:all 0.15s ease; }
  .iss-add:hover { background:#FFFFFF; border-color:#94A3B8; color:#0F172A; box-shadow:0 2px 5px rgba(0,0,0,0.04); }
  .iss-cards { display:flex; flex-direction:column; gap:10px; min-height:60px; }
  .iss-cards.iss-dragover { background:#E2E8F0; outline:2px dashed #3B82F6; outline-offset:-2px; border-radius:10px; }
  .iss-card { background:#FFFFFF; border:1px solid #E2E8F0; border-radius:12px; padding:13px 13px 11px; cursor:grab; box-shadow:0 1px 3px rgba(0,0,0,0.03),0 1px 2px rgba(0,0,0,0.02); transition:border-color 0.15s ease,box-shadow 0.15s ease,transform 0.12s ease; }
  .iss-card:hover { border-color:#CBD5E1; box-shadow:0 4px 12px -2px rgba(15,23,42,0.08); transform:translateY(-1px); }
  .iss-card.iss-dragging { opacity:0.55; cursor:grabbing; transform:scale(0.98); }
  .iss-card:focus-visible { outline:2px solid #3B82F6; outline-offset:1px; }
  .iss-title { font-size:13.5px; font-weight:600; line-height:1.4; color:#1E293B; margin-bottom:9px; overflow-wrap:anywhere; }
  .iss-pills { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px; }
  .iss-pill { font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:999px; line-height:1.35; }
  .iss-priority-urgent { background:#FEE2E2; color:#DC2626; border:1px solid #FECACA; }
  .iss-priority-high { background:#FEF3C7; color:#D97706; border:1px solid #FDE68A; }
  .iss-priority-medium { background:#E0E7FF; color:#4338CA; border:1px solid #C7D2FE; }
  .iss-priority-low { background:#EFF6FF; color:#2563EB; border:1px solid #BFDBFE; }
  .iss-priority-none { background:#F1F5F9; color:#64748B; border:1px solid #E2E8F0; }
  .iss-label-devops { background:#FFEDD5; color:#C2410C; border:1px solid #FED7AA; }
  .iss-label-sales { background:#FFEDD5; color:#EA580C; border:1px solid #FED7AA; }
  .iss-label-marketing { background:#FEF3C7; color:#B45309; border:1px solid #FDE68A; }
  .iss-label-research { background:#F3E8FF; color:#7E22CE; border:1px solid #E9D5FF; }
  .iss-label-qa { background:#FFEDD5; color:#C2410C; border:1px solid #FED7AA; }
  .iss-label-design { background:#FCE7F3; color:#BE185D; border:1px solid #FBCFE8; }
  .iss-label-frontend { background:#EEF2FF; color:#4F46E5; border:1px solid #E0E7FF; }
  .iss-label-bug { background:#FEE2E2; color:#DC2626; border:1px solid #FECACA; }
  .iss-label-feature { background:#DCFCE7; color:#15803D; border:1px solid #BBF7D0; }
  .iss-label-other { background:#F1F5F9; color:#475569; border:1px solid #CBD5E1; }
  .iss-progress-row { display:flex; align-items:center; gap:12px; margin-bottom:11px; }
  .iss-progress { display:inline-flex; align-items:center; gap:5px; }
  .iss-progress-text { font-size:11px; font-weight:600; color:#64748B; }
  .iss-repo-badge { display:inline-flex; align-items:center; gap:4.5px; font-size:11px; font-weight:500; color:#64748B; }
  .iss-bottom-row { display:flex; align-items:center; justify-content:space-between; min-height:24px; padding-top:2px; }
  .iss-assignees { display:inline-flex; align-items:center; }
  .iss-avatar { width:22px; height:22px; border-radius:50%; border:2px solid #FFFFFF; font-size:9.5px; font-weight:700; display:inline-grid; place-items:center; box-shadow:0 1px 2px rgba(0,0,0,0.08); margin-left:-6px; position:relative; }
  .iss-avatar:first-child { margin-left:0; }
  .iss-meta-group { display:inline-flex; align-items:center; gap:10px; margin-left:auto; }
  .iss-meta-item { display:inline-flex; align-items:center; gap:3.5px; font-size:11.5px; font-weight:500; color:#64748B; }

  /* List / Table View Styling */
  .iss-list-container { background:#FFFFFF; border:1px solid #E2E8F0; border-radius:14px; box-shadow:0 1px 3px rgba(0,0,0,0.03); overflow:hidden; margin-bottom:20px; }
  .iss-list-group { border-bottom:1px solid #F1F5F9; }
  .iss-list-group:last-child { border-bottom:none; }
  .iss-list-group-header { display:flex; align-items:center; gap:8px; padding:10px 16px; background:#F8FAFC; border-bottom:1px solid #E2E8F0; cursor:pointer; user-select:none; font-size:12px; font-weight:700; color:#475569; letter-spacing:0.04em; }
  .iss-list-group-header:hover { background:#F1F5F9; color:#0F172A; }
  .iss-list-chevron { font-size:9px; color:#94A3B8; transition:transform 0.15s ease; width:12px; display:inline-block; }
  .iss-list-group.collapsed .iss-list-chevron { transform:rotate(-90deg); }
  .iss-list-group.collapsed .iss-list-rows { display:none; }
  .iss-list-group-title { text-transform:uppercase; }
  .iss-list-group-count { font-size:11.5px; font-weight:600; color:#64748B; }
  
  .iss-list-row { display:flex; align-items:center; justify-content:space-between; padding:9px 16px; border-bottom:1px solid #F8FAFC; transition:background 0.12s ease; cursor:pointer; gap:12px; }
  .iss-list-row:last-child { border-bottom:none; }
  .iss-list-row:hover { background:#F8FAFC; }
  .iss-list-row:focus-visible { outline:2px solid #3B82F6; outline-offset:-2px; }
  .iss-row-left { display:flex; align-items:center; gap:10px; min-width:0; flex:1; }
  .iss-row-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .iss-row-signal { display:inline-grid; place-items:center; flex-shrink:0; }
  .iss-row-key { font-size:12px; font-weight:600; color:#64748B; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; min-width:65px; flex-shrink:0; }
  .iss-row-status { display:inline-grid; place-items:center; flex-shrink:0; }
  .iss-row-title { font-size:13.5px; font-weight:500; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .iss-list-row:hover .iss-row-title { color:#2563EB; }
  
  .iss-pill-subtask { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600; color:#475569; background:#F1F5F9; border-radius:999px; padding:2px 8px; }
  .iss-subtask-icon { font-size:9px; opacity:0.75; }
  .iss-pill-chat { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:500; color:#64748B; background:#F1F5F9; border-radius:999px; padding:2px 7px; }
  .iss-pill-milestone { font-size:11px; font-weight:700; border-radius:6px; padding:2px 7px; line-height:1.2; }
  .iss-pill-mvp { background:#E0F2FE; color:#0284C7; border:1px solid #BAE6FD; }
  .iss-pill-premvp { background:#F3E8FF; color:#7E22CE; border:1px solid #E9D5FF; }
  .iss-pill-date { display:inline-flex; align-items:center; gap:4.5px; font-size:11px; font-weight:600; color:#C2410C; background:#FFEDD5; border:1px solid #FED7AA; border-radius:6px; padding:2px 8px; }
  .iss-row-estimate { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:500; color:#64748B; min-width:55px; }
  .iss-row-date { font-size:11.5px; font-weight:500; color:#94A3B8; min-width:48px; text-align:right; }

  .iss-dialog-backdrop { position:fixed; inset:0; background:rgba(15,23,42,0.45); backdrop-filter:blur(4px); display:none; align-items:flex-start; justify-content:center; padding:3vh 16px 20px; z-index:9999 !important; overflow-y:auto; }
  .iss-dialog-backdrop.iss-open { display:flex !important; }
  .iss-dialog { background:#FFFFFF; border:1px solid #E2E8F0; border-radius:14px; width:min(520px, 94vw) !important; max-width:520px !important; padding:22px; box-shadow:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04); max-height:calc(100vh - 40px); overflow-y:auto; margin:auto 0; }
  .iss-dialog h3 { margin:0 0 14px; font-size:16px; font-weight:700; color:#0F172A; }
  .iss-field { display:grid; gap:5px; margin-bottom:12px; }
  .iss-field label { font-size:11.5px; font-weight:600; color:#475569; text-transform:uppercase; letter-spacing:0.04em; }
  .iss-field input, .iss-field textarea, .iss-field select { background:#F8FAFC; border:1px solid #CBD5E1; color:#0F172A; border-radius:8px; padding:9px 12px; font-size:13.5px; font-family:inherit; transition:border-color 0.15s, box-shadow 0.15s; }
  .iss-field textarea { min-height:80px; resize:vertical; }
  .iss-field input:focus, .iss-field textarea:focus, .iss-field select:focus { outline:none; border-color:#3B82F6; box-shadow:0 0 0 3px rgba(59,130,246,0.12); background:#FFFFFF; }
  .iss-dialog-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:8px; }
  .iss-detail { position:fixed; top:0; right:0; height:100%; width:min(450px, 95vw); background:#FFFFFF; border-left:1px solid #E2E8F0; box-shadow:-10px 0 30px rgba(0,0,0,0.08); z-index:950; display:none; flex-direction:column; padding:22px; overflow-y:auto; }
  .iss-detail.iss-open { display:flex; }
  .iss-detail h3 { font-size:16px; font-weight:700; color:#0F172A; margin:0 0 6px; overflow-wrap:anywhere; }
  .iss-detail .iss-desc { font-size:13px; color:#334155; line-height:1.6; white-space:pre-wrap; margin:10px 0 14px; }
  .iss-comment { border-top:1px solid #F1F5F9; padding:10px 0 2px; margin-top:10px; }
  .iss-comment-author { font-size:12px; font-weight:600; color:#0F172A; }
  .iss-comment-at { font-size:11px; color:#94A3B8; margin-left:8px; }
  .iss-comment-body { font-size:13px; color:#334155; margin-top:4px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .iss-flash { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#0F172A; color:#FFFFFF; font-size:12.5px; font-weight:500; padding:9px 16px; border-radius:8px; z-index:1000; box-shadow:0 10px 25px rgba(0,0,0,0.15); display:none; }
  .iss-flash.iss-open { display:block; }
  .iss-flash.iss-error { background:#DC2626; color:#FFFFFF; }
  .iss-hidden { display:none !important; }
</style>
<div class="iss-board" id="iss-board" data-csrf="${esc(csrf)}" data-home="${esc(home)}" data-server-time="${esc(data.serverTime)}">
  <div class="iss-toolbar">
    <div class="iss-search-box">
      <span class="iss-search-icon">🔍</span>
      <input type="text" id="iss-search-input" class="iss-search-input" placeholder="Search issues, keys, labels..." aria-label="Search issues">
    </div>
    <span class="iss-spacer"></span>
    <div class="iss-view-switcher" role="radiogroup" aria-label="View mode">
      <button type="button" class="iss-view-btn active" id="iss-view-board" data-view="board" title="Board View">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v11A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-11zM9 2.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v6A1.5 1.5 0 0 1 13.5 10h-3A1.5 1.5 0 0 1 9 8.5v-6z"/></svg>
        Board
      </button>
      <button type="button" class="iss-view-btn" id="iss-view-list" data-view="list" title="List View">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 3a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3.5-.5a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 6 2.5zm-3.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3.5-.5a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 6 8zm-3.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3.5-.5a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75z"/></svg>
        List
      </button>
    </div>
    <select id="iss-filter-assignee" class="iss-btn-ghost iss-btn" aria-label="Filter by assignee">
      <option value="">All assignees</option>
      ${engineerOptions}
    </select>
    <button type="button" id="iss-gh-sync-btn" class="iss-btn iss-btn-ghost" title="${syncConfig?.repo ? `GitHub Sync: ${esc(syncConfig.repo)}` : 'Sync GitHub Project'}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;margin-right:2px;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Sync GitHub${syncConfig?.status === 'linked' ? ' ✓' : ''}
    </button>
    <button type="button" id="iss-new" class="iss-btn iss-btn-primary">+ New issue</button>
  </div>

  <!-- Board View (Kanban) -->
  <div class="iss-columns" id="iss-columns">
    ${columns}
  </div>

  <!-- List View (Table / Grouped by State) -->
  <div class="iss-list-container" id="iss-list-container" style="display:none;">
    ${renderIssuesList(byState, data.comments)}
  </div>

  <!-- New-issue dialog -->
  <div class="iss-dialog-backdrop" id="iss-dialog">
    <form class="iss-dialog" id="iss-create-form" method="post" action="${esc(home)}console/issues/create">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <h3>New issue</h3>
      <div class="iss-field">
        <label for="iss-f-title">Title</label>
        <input id="iss-f-title" name="title" required maxlength="300" placeholder="What needs doing?">
      </div>
      <div class="iss-field">
        <label for="iss-f-desc">Description</label>
        <textarea id="iss-f-desc" name="description" maxlength="4000" placeholder="Context, links, acceptance criteria… (e.g. key: CRM-51, subtasks: 2/3, due: 5 jun 2024, estimate: 24 hrs)"></textarea>
      </div>
      <div class="iss-field">
        <label for="iss-f-state">Column</label>
        <select id="iss-f-state" name="state">
          ${ISSUE_STATES.map((s) => `<option value="${esc(s)}"${s === 'BACKLOG' ? ' selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </div>
      <div class="iss-field">
        <label for="iss-f-priority">Priority</label>
        <select id="iss-f-priority" name="priority">
          ${ISSUE_PRIORITIES.map((p) => `<option value="${esc(p)}"${p === 'Medium' ? ' selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </div>
      <div class="iss-field">
        <label for="iss-f-labels">Labels</label>
        <select id="iss-f-labels" name="labels" multiple size="4">
          ${ISSUE_LABELS.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
        </select>
      </div>
      <div class="iss-field">
        <label for="iss-f-assignee">Assignee</label>
        <select id="iss-f-assignee" name="assigneeEmail">
          <option value="">Unassigned</option>
          ${engineerOptions}
        </select>
      </div>
      <div class="iss-dialog-actions">
        <button type="button" class="iss-btn iss-btn-ghost" id="iss-cancel">Cancel</button>
        <button type="submit" class="iss-btn iss-btn-primary">Create issue</button>
      </div>
    </form>
  </div>

  <!-- GitHub Sync dialog -->
  <div class="iss-dialog-backdrop" id="iss-gh-dialog">
    <form class="iss-dialog" id="iss-gh-form">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" style="color:#0f172a;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        <h3 style="margin:0;font-size:16px;">Sync GitHub Project</h3>
      </div>
      <p style="font-size:12.5px;color:#64748b;margin:4px 0 14px;line-height:1.4;">
        Connect your GitHub repository to synchronize issues with this board. Authorize with your repository name and personal access or OAuth token.
      </p>
      <div id="iss-gh-connected-box" style="${syncConfig?.repo ? '' : 'display:none;'}background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#334155;">
        <div style="font-weight:600;display:flex;align-items:center;gap:6px;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;"></span>
          Linked: <span id="iss-gh-linked-repo">${esc(syncConfig?.repo ?? '')}</span>
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:3px;" id="iss-gh-sync-meta">
          ${syncConfig?.lastSyncedAt ? `Last synced: ${esc(syncConfig.lastSyncedAt.slice(0, 16).replace('T', ' '))} (${syncConfig.syncedCount} issues)` : ''}
        </div>
      </div>
      <div class="iss-field">
        <label for="iss-gh-repo">Repository Path or URL</label>
        <input id="iss-gh-repo" name="repo" required value="${esc(syncConfig?.repo ?? '')}" placeholder="octocat/Hello-World or https://github.com/owner/repo">
      </div>
      <div class="iss-field">
        <label for="iss-gh-token">Personal Access Token <span style="font-weight:normal;color:#64748b;">(optional for public, required for private)</span></label>
        <input type="password" id="iss-gh-token" name="token" placeholder="${syncConfig?.token ? '•••••••••••••••• (leave blank to keep current)' : 'ghp_... or github_pat_...'}">
      </div>
      <div id="iss-gh-error" style="display:none;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;font-size:12px;margin-top:6px;"></div>
      <div class="iss-dialog-actions" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">
        <button type="button" class="iss-btn iss-btn-ghost" id="iss-gh-cancel">Cancel</button>
        <div style="display:flex;gap:8px;">
          <button type="button" class="iss-btn iss-btn-ghost" id="iss-gh-quick-sync" style="${syncConfig?.repo ? '' : 'display:none;'}">Sync Now ⟳</button>
          <button type="submit" class="iss-btn iss-btn-primary" id="iss-gh-submit">Authorize &amp; Sync</button>
        </div>
      </div>
    </form>
  </div>

  <!-- Detail drawer -->
  <aside class="iss-detail" id="iss-detail" aria-hidden="true"></aside>
  <div class="iss-flash" id="iss-flash" role="status"></div>
</div>

<script>
(function () {
  var board = document.getElementById('iss-board');
  if (!board) return;
  var home = board.dataset.home || '';
  var csrf = board.dataset.csrf || '';
  var watermark = board.dataset.serverTime || new Date().toISOString();
  var currentEmail = ${JSON.stringify(currentEmail)};

  function flash(msg, isError) {
    var el = document.getElementById('iss-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = 'iss-flash iss-open' + (isError ? ' iss-error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'iss-flash' + (isError ? ' iss-error' : ''); }, 3500);
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var PRIORITY_CLASS = ${JSON.stringify(PRIORITY_CLASS)};
  var LABEL_CLASS = ${JSON.stringify(LABEL_CLASS)};
  var PRIORITIES = ${JSON.stringify(ISSUE_PRIORITIES)};
  var STATES = ${JSON.stringify(ISSUE_STATES)};
  var STATE_DOT = ${JSON.stringify(STATE_DOT)};
  window.__issCommentCounts = ${JSON.stringify(initialCommentCounts)};

  function updateCommentCountBadges(issueId, newCount) {
    var card = findCard(issueId);
    var row = findListRow(issueId);
    if (card) {
      var metaComment = card.querySelector('.iss-meta-comment');
      if (metaComment) {
        var span = metaComment.querySelector('span');
        if (span) span.textContent = newCount;
      } else if (newCount > 0) {
        var metaGroup = card.querySelector('.iss-meta-group');
        if (metaGroup) {
          var item = document.createElement('span');
          item.className = 'iss-meta-item iss-meta-comment';
          item.title = newCount + ' comment(s)';
          item.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg><span>' + newCount + '</span>';
          metaGroup.appendChild(item);
        }
      }
    }
    if (row) {
      var chatPill = row.querySelector('.iss-pill-chat');
      if (chatPill) {
        chatPill.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> ' + newCount;
      } else if (newCount > 0) {
        var rowRight = row.querySelector('.iss-row-right');
        if (rowRight) {
          var pill = document.createElement('span');
          pill.className = 'iss-pill-chat';
          pill.title = newCount + ' comment(s)';
          pill.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> ' + newCount;
          rowRight.insertBefore(pill, rowRight.firstChild);
        }
      }
    }
  }

  var AVATAR_PALETTES = [
    { bg: '#DBEAFE', text: '#1E40AF' },
    { bg: '#FCE7F3', text: '#9D174D' },
    { bg: '#FEF3C7', text: '#92400E' },
    { bg: '#EDE9FE', text: '#5B21B6' },
    { bg: '#DCFCE7', text: '#166534' },
    { bg: '#FFE4E6', text: '#9F1239' },
    { bg: '#E0F2FE', text: '#075985' },
    { bg: '#F3E8FF', text: '#6B21A8' }
  ];

  function getAvatarPaletteClient(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
  }

  function initialsOf(email) {
    if (!email) return '';
    var local = email.split('@')[0] || email;
    var parts = local.split(/[._-]+/).filter(Boolean);
    return parts.slice(0, 2).map(function (p) { return (p[0] || '').toUpperCase(); }).join('') || '?';
  }

  function formatIssueKeyClient(issue) {
    var desc = String(issue.description || '');
    var m = desc.match(/(?:key|issue):[ \t]*([a-zA-Z0-9_-]+)/i);
    if (m && m[1]) return m[1];
    var ghNumberMatch = desc.match(/(?:github\s*#|gh\s*#)(\d+)/i);
    if (ghNumberMatch && ghNumberMatch[1]) return 'GH-' + ghNumberMatch[1];
    var idStr = String(issue.id || '');
    var ghIdMatch = idStr.match(/^iss_gh_(\d+)/);
    if (ghIdMatch && ghIdMatch[1]) return 'GH-' + ghIdMatch[1].slice(-4);
    var title = String(issue.title || '');
    var titleMatch = title.match(/^([A-Z]{2,5}-[0-9]+)/);
    if (titleMatch && titleMatch[1]) return titleMatch[1];
    var idNum = idStr.match(/[0-9]+/);
    if (idNum && idNum[0]) return 'CRM-' + idNum[0];
    var hash = 0;
    for (var i = 0; i < idStr.length; i++) hash = (hash * 31 + idStr.charCodeAt(i)) & 0x7fff;
    return 'CRM-' + ((hash % 90) + 10);
  }

  function extractSubtasksClient(issue) {
    var m = String(issue.description || '').match(/(?:subtasks|checklist|tasks):[ \t]*([0-9]+[/][0-9]+)/i);
    return (m && m[1]) ? m[1] : null;
  }

  function extractEstimateClient(issue) {
    var m = String(issue.description || '').match(/(?:estimate|est|hours|time):[ \t]*([0-9]+[ \t]*hrs?)/i);
    return (m && m[1]) ? m[1] : null;
  }

  function extractDueDateClient(issue) {
    var m = String(issue.description || '').match(/(?:due|deadline):[ \t]*([0-9a-zA-Z \t]+)/i);
    return (m && m[1]) ? m[1].trim() : null;
  }

  function extractMilestoneClient(issue) {
    var m = String(issue.description || '').match(/(?:milestone):[ \t]*([a-zA-Z0-9_-]+)/i);
    if (m && m[1]) return m[1];
    var labels = issue.labels || [];
    for (var i = 0; i < labels.length; i++) {
      if (labels[i] === 'MVP' || labels[i] === 'PreMVP') return labels[i];
    }
    return null;
  }

  function formatShortDateClient(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getUTCDate() + ' ' + (months[d.getUTCMonth()] || '');
  }

  function prioritySignalSvgClient(priority) {
    var pLevel = 0;
    var color = '#64748B';
    if (priority === 'Urgent') { pLevel = 3; color = '#DC2626'; }
    else if (priority === 'High') { pLevel = 3; color = '#D97706'; }
    else if (priority === 'Medium') { pLevel = 2; color = '#3B82F6'; }
    else if (priority === 'Low') { pLevel = 1; color = '#3B82F6'; }

    return '<span class="iss-row-signal" title="Priority: ' + escHtml(priority) + '">' +
      '<svg width="14" height="14" viewBox="0 0 16 16">' +
        '<rect x="2" y="11" width="2" height="3" rx="0.5" fill="' + (pLevel >= 1 ? color : '#E2E8F0') + '" />' +
        '<rect x="6" y="8" width="2" height="6" rx="0.5" fill="' + (pLevel >= 2 ? color : '#E2E8F0') + '" />' +
        '<rect x="10" y="5" width="2" height="9" rx="0.5" fill="' + (pLevel >= 3 ? color : '#E2E8F0') + '" />' +
      '</svg>' +
    '</span>';
  }

  function statusIndicatorSvgClient(state, progress) {
    var color = STATE_DOT[state] || '#94A3B8';
    return '<span class="iss-row-status" title="' + escHtml(state) + '">' +
      '<svg width="15" height="15" viewBox="0 0 16 16">' +
        '<circle cx="8" cy="8" r="6" fill="none" stroke="' + color + '" stroke-width="2"/>' +
        (progress > 0 ? '<circle cx="8" cy="8" r="3" fill="' + color + '"/>' : '') +
      '</svg>' +
    '</span>';
  }

  function renderListRow(issue) {
    var key = formatIssueKeyClient(issue);
    var subtasks = extractSubtasksClient(issue);
    var estimate = extractEstimateClient(issue);
    var dueDate = extractDueDateClient(issue);
    var milestone = extractMilestoneClient(issue);
    var signalSvg = prioritySignalSvgClient(issue.priority);

    var assignees = (issue.assigneeEmail || '').split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var avatars = assignees.map(function (email) {
      var p = getAvatarPaletteClient(email);
      return '<span class="iss-avatar" style="background:' + p.bg + ';color:' + p.text + ';" title="' + escHtml(email) + '">' + escHtml(initialsOf(email)) + '</span>';
    }).join('');

    var labels = (issue.labels || []).map(function (l) {
      return '<span class="' + (LABEL_CLASS[l] || 'iss-pill iss-label-other') + '">' + escHtml(l) + '</span>';
    }).join('');

    var metaBadges = '';
    if (subtasks) metaBadges += '<span class="iss-row-meta-badge iss-subtasks-badge" title="Subtasks: ' + escHtml(subtasks) + '"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h12zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z"/><path d="M10.97 4.97a.75.75 0 0 1 1.071 1.05l-3.992 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.235.235 0 0 1 .02-.022z"/></svg>' + escHtml(subtasks) + '</span>';
    if (estimate) metaBadges += '<span class="iss-row-meta-badge iss-estimate-badge" title="Estimate: ' + escHtml(estimate) + '"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/></svg>' + escHtml(estimate) + '</span>';
    if (dueDate) metaBadges += '<span class="iss-row-meta-badge iss-due-badge" title="Due: ' + escHtml(dueDate) + '"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z"/></svg>' + escHtml(dueDate) + '</span>';
    if (milestone) metaBadges += '<span class="iss-row-meta-badge iss-milestone-badge" title="Milestone: ' + escHtml(milestone) + '"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8.2 1.3c-.4-.4-1-.4-1.4 0L1.3 6.8c-.4.4-.4 1 0 1.4l5.5 5.5c.4.4 1 .4 1.4 0l5.5-5.5c.4-.4.4-1 0-1.4L8.2 1.3zM7.5 2.7l4.8 4.8-4.8 4.8L2.7 7.5l4.8-4.8z"/></svg>' + escHtml(milestone) + '</span>';

    return '<div class="iss-list-row" data-id="' + escHtml(issue.id) + '" data-assignee="' + escHtml(issue.assigneeEmail || '') + '" tabindex="0" role="row">' +
      '<div class="iss-row-col iss-row-key">' + signalSvg + '<span class="iss-key-badge">' + escHtml(key) + '</span></div>' +
      '<div class="iss-row-col iss-row-title">' + escHtml(issue.title) + metaBadges + '</div>' +
      '<div class="iss-row-col iss-row-labels">' + labels + '</div>' +
      '<div class="iss-row-col iss-row-assignee">' + avatars + '</div>' +
      '<div class="iss-row-col iss-row-created">' + escHtml(formatShortDateClient(issue.createdAt)) + '</div>' +
    '</div>';
  }

  function extractAttachmentsClient(issue) {
    var m = String(issue.description || '').match(/(?:attachments|attach|files):[ \t]*([0-9]+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  function extractRepoClient(issue) {
    var m = String(issue.description || '').match(/(?:repo|repository):[ \t]*([a-zA-Z0-9_.-]+)/i);
    if (m) return m[1];
    var ghRepoMatch = String(issue.description || '').match(/github\.com\/[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)/i);
    if (ghRepoMatch && ghRepoMatch[1]) return ghRepoMatch[1];
    if (issue.id && String(issue.id).indexOf('iss_gh_') === 0) return 'github';
    var titleLower = String(issue.title || '').toLowerCase();
    if (titleLower.indexOf('cluster') !== -1 || titleLower.indexOf('sales planning') !== -1 || titleLower.indexOf('freelynk') !== -1) {
      return 'freelynk';
    }
    return null;
  }

  function progressRingHtmlClient(progress) {
    var p = Math.max(0, Math.min(100, Number(progress || 0)));
    var r = 6.5;
    var c = 2 * Math.PI * r;
    var offset = c - (c * p) / 100;
    var strokeColor = p > 0 ? '#F97316' : '#CBD5E1';
    return '<span class="iss-progress" title="' + p + '% complete">' +
      '<svg class="iss-ring-svg" width="14" height="14" viewBox="0 0 18 18">' +
        '<circle cx="9" cy="9" r="' + r + '" fill="none" stroke="#E2E8F0" stroke-width="2.5" />' +
        '<circle cx="9" cy="9" r="' + r + '" fill="none" stroke="' + strokeColor + '" stroke-width="2.5" ' +
          'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '" ' +
          'stroke-linecap="round" style="transform:rotate(-90deg);transform-origin:50% 50%;" />' +
      '</svg>' +
      '<span class="iss-progress-text">' + p + '%</span>' +
    '</span>';
  }

  function repoBadgeHtmlClient(repo) {
    return '<span class="iss-repo-badge" title="Repository: ' + escHtml(repo) + '">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>' +
      '</svg>' +
      '<span>' + escHtml(repo) + '</span>' +
    '</span>';
  }

  function cardHtml(issue, commentCount) {
    var pills = '';
    if (issue.priority && issue.priority !== 'No priority') {
      pills += '<span class="' + (PRIORITY_CLASS[issue.priority] || 'iss-pill iss-priority-none') + '">' + escHtml(issue.priority) + '</span>';
    }
    (issue.labels || []).forEach(function (l) {
      pills += '<span class="' + (LABEL_CLASS[l] || 'iss-pill iss-label-other') + '">' + escHtml(l) + '</span>';
    });

    var assignees = (issue.assigneeEmail || '').split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var avatars = assignees.map(function (email) {
      var p = getAvatarPaletteClient(email);
      return '<span class="iss-avatar" style="background:' + p.bg + ';color:' + p.text + ';" title="' + escHtml(email) + '">' + escHtml(initialsOf(email)) + '</span>';
    }).join('');

    var repo = extractRepoClient(issue);
    var attachments = extractAttachmentsClient(issue);
    var hasProgress = (issue.progress > 0) || (issue.title && issue.title.indexOf('Analyze') !== -1);
    var progressHtml = hasProgress ? progressRingHtmlClient(issue.progress || 0) : '';
    var repoHtml = repo ? repoBadgeHtmlClient(repo) : '';

    var attachHtml = attachments > 0
      ? '<span class="iss-meta-item iss-meta-attach" title="' + attachments + ' attachment(s)">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
        '<span>' + attachments + '</span></span>'
      : '';

    var chatHtml = commentCount > 0
      ? '<span class="iss-meta-item iss-meta-comment" title="' + commentCount + ' comment(s)">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>' +
        '<span>' + commentCount + '</span></span>'
      : '';

    var previewHtml = '';
    var imgMatch = new RegExp('(?:image|img):\\\\s*(\\\\S+)', 'i').exec(issue.description || '');
    if (imgMatch) {
      previewHtml = '<div class="iss-card-preview-wrap"><img src="' + escHtml(imgMatch[1]) + '" alt="" class="iss-card-preview-img" /></div>';
    } else if (issue.title && issue.title.toLowerCase().indexOf('user onboarding') !== -1) {
      previewHtml = '<div class="iss-card-preview-wrap" style="background:linear-gradient(135deg,#FED7AA 0%,#FBCFE8 50%,#C7D2FE 100%);height:80px;border-radius:8px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;"><span style="font-size:11px;font-weight:600;color:#334155;background:rgba(255,255,255,0.75);padding:4px 10px;border-radius:6px;backdrop-filter:blur(4px);">Onboarding flow mockup</span></div>';
    }

    return '<article class="iss-card" draggable="true" data-id="' + escHtml(issue.id) + '" data-updated-at="' + escHtml(issue.updatedAt) + '" data-assignee="' + escHtml(issue.assigneeEmail || '') + '" tabindex="0" aria-label="' + escHtml(issue.title) + '">' +
      previewHtml +
      '<div class="iss-title">' + escHtml(issue.title) + '</div>' +
      (pills ? '<div class="iss-pills">' + pills + '</div>' : '') +
      ((progressHtml || repoHtml) ? '<div class="iss-progress-row">' + progressHtml + repoHtml + '</div>' : '') +
      '<div class="iss-bottom-row">' +
        '<div class="iss-assignees">' + avatars + '</div>' +
        '<div class="iss-meta-group">' + attachHtml + chatHtml + '</div>' +
      '</div></article>';
  }

  function listRowHtml(issue, commentCount) {
    var key = formatIssueKeyClient(issue);
    var subtasks = extractSubtasksClient(issue);
    var estimate = extractEstimateClient(issue);
    var dueDate = extractDueDateClient(issue);
    var milestone = extractMilestoneClient(issue);
    var dateStr = formatShortDateClient(issue.createdAt || issue.updatedAt);

    var assignees = (issue.assigneeEmail || '').split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var avatars = assignees.map(function (email) {
      var p = getAvatarPaletteClient(email);
      return '<span class="iss-avatar" style="background:' + p.bg + ';color:' + p.text + ';" title="' + escHtml(email) + '">' + escHtml(initialsOf(email)) + '</span>';
    }).join('');

    var subtasksHtml = subtasks
      ? '<span class="iss-pill-subtask" title="Subtasks: ' + escHtml(subtasks) + '"><svg class="iss-subtask-icon" width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#CBD5E1" stroke-width="2"/><path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="#F97316" stroke-width="2"/></svg> ' + escHtml(subtasks) + '</span>'
      : '';

    var chatHtml = commentCount > 0
      ? '<span class="iss-pill-chat" title="' + commentCount + ' comment(s)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> ' + commentCount + '</span>'
      : '';

    var milestoneHtml = '';
    if (milestone === 'MVP') milestoneHtml = '<span class="iss-pill-milestone iss-pill-mvp">⚑ MVP</span>';
    else if (milestone === 'PreMVP') milestoneHtml = '<span class="iss-pill-milestone iss-pill-premvp">⚑ PreMVP</span>';

    var labelPills = (issue.labels || [])
      .filter(function (l) { return l !== milestone && l !== 'MVP' && l !== 'PreMVP'; })
      .slice(0, 2)
      .map(function (l) { return '<span class="' + (LABEL_CLASS[l] || 'iss-pill iss-label-other') + '">' + escHtml(l) + '</span>'; })
      .join('');

    var dueDateHtml = dueDate
      ? '<span class="iss-pill-date" title="Due date"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg> ' + escHtml(dueDate) + '</span>'
      : '';

    var estimateHtml = estimate
      ? '<span class="iss-row-estimate" title="Logged / Estimated time"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#CBD5E1" stroke-width="2"/><path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="#F97316" stroke-width="2"/></svg> ' + escHtml(estimate) + '</span>'
      : '';

    return '<div class="iss-list-row" data-id="' + escHtml(issue.id) + '" data-state="' + escHtml(issue.state) + '" data-assignee="' + escHtml(issue.assigneeEmail || '') + '" tabindex="0" role="row" aria-label="' + escHtml(issue.title) + '">' +
      '<div class="iss-row-left">' +
        prioritySignalSvgClient(issue.priority) +
        '<span class="iss-row-key">' + escHtml(key) + '</span>' +
        statusIndicatorSvgClient(issue.state, issue.progress || 0) +
        '<span class="iss-row-title">' + escHtml(issue.title) + '</span>' +
      '</div>' +
      '<div class="iss-row-right">' +
        subtasksHtml +
        chatHtml +
        milestoneHtml +
        labelPills +
        dueDateHtml +
        estimateHtml +
        (dateStr ? '<span class="iss-row-date">' + escHtml(dateStr) + '</span>' : '') +
        '<div class="iss-assignees">' + avatars + '</div>' +
      '</div>' +
    '</div>';
  }

  function updateColumnCounts() {
    Array.prototype.forEach.call(board.querySelectorAll('.iss-col'), function (col) {
      var countEl = col.querySelector('.iss-col-count');
      var cards = col.querySelectorAll('.iss-card:not(.iss-hidden)');
      if (countEl) countEl.textContent = cards.length;
    });
    Array.prototype.forEach.call(board.querySelectorAll('.iss-list-group'), function (group) {
      var countEl = group.querySelector('.iss-list-group-count');
      var rows = group.querySelectorAll('.iss-list-row:not(.iss-hidden)');
      if (countEl) countEl.textContent = rows.length;
    });
  }

  function findCard(id) {
    return board.querySelector('.iss-card[data-id="' + (window.CSS && window.CSS.escape ? CSS.escape(id) : id) + '"]');
  }

  function findListRow(id) {
    return board.querySelector('.iss-list-row[data-id="' + (window.CSS && window.CSS.escape ? CSS.escape(id) : id) + '"]');
  }

  function upsertCard(issue) {
    var commentsCount = (window.__issCommentCounts && window.__issCommentCounts[issue.id]) || 0;
    // Board view card
    var col = board.querySelector('.iss-cards[data-state="' + issue.state + '"]');
    if (col) {
      var existing = findCard(issue.id);
      if (existing) existing.remove();
      var temp = document.createElement('template');
      temp.innerHTML = cardHtml(issue, commentsCount);
      var node = temp.content.firstElementChild;
      if (node) {
        col.insertBefore(node, col.firstChild);
        bindCard(node);
      }
    }
    // List view row
    var listGroup = board.querySelector('.iss-list-rows[data-state="' + issue.state + '"]');
    if (listGroup) {
      var existingRow = findListRow(issue.id);
      if (existingRow) existingRow.remove();
      var tempRow = document.createElement('template');
      tempRow.innerHTML = listRowHtml(issue, commentsCount);
      var rowNode = tempRow.content.firstElementChild;
      if (rowNode) {
        listGroup.insertBefore(rowNode, listGroup.firstChild);
        bindListRow(rowNode);
      }
    }
    applyFilters();
  }

  // ---- bidirectional sync: poll, apply deltas, advance watermark ----
  function tick() {
    fetch(home + 'console/issues/sync?since=' + encodeURIComponent(watermark), { headers: { 'accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !data.snapshot) return;
        watermark = data.snapshot.serverTime || watermark;
        (data.snapshot.issues || []).forEach(function (issue) {
          if (window.__issCommentCounts) window.__issCommentCounts[issue.id] = window.__issCommentCounts[issue.id] || 0;
          upsertCard(issue);
        });
        (data.snapshot.comments || []).forEach(function (c) {
          window.__issCommentCounts = window.__issCommentCounts || {};
          var before = window.__issCommentCounts[c.issueId] || 0;
          var seen = window.__issSeenComments || (window.__issSeenComments = {});
          var key = c.id;
          if (seen[key]) return;
          seen[key] = true;
          window.__issCommentCounts[c.issueId] = before + 1;
          var newCount = window.__issCommentCounts[c.issueId];
          updateCommentCountBadges(c.issueId, newCount);
        });
      })
      .catch(function () { /* offline tick: next poll retries */ });
  }
  setInterval(tick, 4000);
  tick();

  // ---- drag & drop (Board View) ----
  var dragged = null;
  function bindCard(card) {
    if (card._issBound) return;
    card._issBound = true;
    card.addEventListener('dragstart', function (e) {
      dragged = card;
      card.classList.add('iss-dragging');
      try { e.dataTransfer.setData('text/plain', card.dataset.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
    });
    card.addEventListener('dragend', function () {
      card.classList.remove('iss-dragging');
    });
    card.addEventListener('click', function () { openDetail(card.dataset.id); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') openDetail(card.dataset.id);
    });
  }
  Array.prototype.forEach.call(board.querySelectorAll('.iss-card'), bindCard);

  function bindListRow(row) {
    if (row._issBound) return;
    row._issBound = true;
    row.addEventListener('click', function () { openDetail(row.dataset.id); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') openDetail(row.dataset.id);
    });
  }
  Array.prototype.forEach.call(board.querySelectorAll('.iss-list-row'), bindListRow);

  // Collapsible List Groups
  Array.prototype.forEach.call(board.querySelectorAll('.iss-list-group-header'), function (header) {
    header.addEventListener('click', function () {
      var group = header.closest('.iss-list-group');
      if (group) {
        group.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', !group.classList.contains('collapsed'));
      }
    });
  });

  // View Switcher (Board vs List)
  var btnBoard = document.getElementById('iss-view-board');
  var btnList = document.getElementById('iss-view-list');
  var boardView = document.getElementById('iss-columns');
  var listView = document.getElementById('iss-list-container');

  function setView(view) {
    if (view === 'list') {
      if (btnList) btnList.classList.add('active');
      if (btnBoard) btnBoard.classList.remove('active');
      if (listView) listView.style.display = 'block';
      if (boardView) boardView.style.display = 'none';
      try { localStorage.setItem('vital_issues_view', 'list'); } catch (e) {}
    } else {
      if (btnBoard) btnBoard.classList.add('active');
      if (btnList) btnList.classList.remove('active');
      if (boardView) boardView.style.display = 'flex';
      if (listView) listView.style.display = 'none';
      try { localStorage.setItem('vital_issues_view', 'board'); } catch (e) {}
    }
  }

  if (btnBoard) btnBoard.addEventListener('click', function () { setView('board'); });
  if (btnList) btnList.addEventListener('click', function () { setView('list'); });

  var urlParams = new URLSearchParams(window.location.search);
  var initialView = urlParams.get('view') || (function () {
    try { return localStorage.getItem('vital_issues_view'); } catch (e) { return 'board'; }
  })() || 'board';
  if (initialView === 'list') setView('list');

  Array.prototype.forEach.call(board.querySelectorAll('.iss-cards'), function (col) {
    col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('iss-dragover'); });
    col.addEventListener('dragleave', function () { col.classList.remove('iss-dragover'); });
    col.addEventListener('drop', function (e) {
      e.preventDefault();
      col.classList.remove('iss-dragover');
      if (!dragged) return;
      var id = dragged.dataset.id;
      var state = col.dataset.state;
      var card = dragged;
      dragged = null;
      col.insertBefore(card, col.firstChild);

      // Bi-directional sync: move the corresponding row in List View immediately
      var listGroup = board.querySelector('.iss-list-rows[data-state="' + state + '"]');
      var existingRow = findListRow(id);
      if (listGroup && existingRow) {
        existingRow.dataset.state = state;
        listGroup.insertBefore(existingRow, listGroup.firstChild);
      }
      updateColumnCounts();

      var body = new URLSearchParams();
      body.set('csrf', csrf);
      body.set('issueId', id);
      body.set('state', state);
      fetch(home + 'console/issues/move', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'move failed');
          if (data.issue) upsertCard(data.issue);
        })
        .catch(function (err) { flash(err.message || 'Could not move the card', true); });
    });
  });

  // ---- Unified Search & Filters ----
  var searchInput = document.getElementById('iss-search-input');
  var filter = document.getElementById('iss-filter-assignee');

  function applyFilters() {
    var searchVal = (searchInput ? searchInput.value : '').toLowerCase().trim();
    var assigneeVal = filter ? filter.value : '';

    // Filter board cards
    Array.prototype.forEach.call(board.querySelectorAll('.iss-card'), function (card) {
      var text = (card.textContent || '').toLowerCase();
      var assignee = card.dataset.assignee || '';
      var matchSearch = !searchVal || text.indexOf(searchVal) !== -1;
      var matchAssignee = !assigneeVal || assignee.indexOf(assigneeVal) !== -1;
      var show = matchSearch && matchAssignee;
      card.className = show ? card.className.replace(' iss-hidden', '') : card.className + ' iss-hidden';
    });

    // Filter list rows
    Array.prototype.forEach.call(board.querySelectorAll('.iss-list-row'), function (row) {
      var text = (row.textContent || '').toLowerCase();
      var assignee = row.dataset.assignee || '';
      var matchSearch = !searchVal || text.indexOf(searchVal) !== -1;
      var matchAssignee = !assigneeVal || assignee.indexOf(assigneeVal) !== -1;
      var show = matchSearch && matchAssignee;
      row.className = show ? row.className.replace(' iss-hidden', '') : row.className + ' iss-hidden';
    });

    updateColumnCounts();
  }

  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (filter) filter.addEventListener('change', applyFilters);

  // ---- new issue dialog ----
  var dialog = document.getElementById('iss-dialog');
  var newBtn = document.getElementById('iss-new');
  var cancelBtn = document.getElementById('iss-cancel');
  function openDialog(state) {
    if (!dialog) return;
    var form = document.getElementById('iss-create-form');
    if (form) form.reset();
    var stateSelect = document.getElementById('iss-f-state');
    if (stateSelect) stateSelect.value = state || 'BACKLOG';
    dialog.classList.add('iss-open');
    var t = document.getElementById('iss-f-title');
    if (t) {
      setTimeout(function () { t.focus(); }, 50);
    }
  }
  if (newBtn) newBtn.addEventListener('click', function (e) { e.preventDefault(); openDialog(); });
  if (cancelBtn) cancelBtn.addEventListener('click', function (e) { e.preventDefault(); dialog.classList.remove('iss-open'); });
  if (dialog) dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.classList.remove('iss-open'); });
  Array.prototype.forEach.call(board.querySelectorAll('.iss-add'), function (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); openDialog(btn.dataset.state); });
  });

  var createForm = document.getElementById('iss-create-form');
  if (createForm) {
    createForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(createForm);
      var labels = fd.getAll('labels');
      var body = new URLSearchParams();
      ['csrf', 'title', 'description', 'state', 'priority', 'assigneeEmail'].forEach(function (k) { body.set(k, fd.get(k) || ''); });
      if (labels.length > 0) {
        body.set('labels', labels.join(','));
        labels.forEach(function (l) { body.append('labels', String(l)); });
      }
      var submitBtn = createForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating...';
      }
      fetch(home + 'console/issues/create', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'create failed');
          dialog.classList.remove('iss-open');
          createForm.reset();
          if (data.issue) {
            upsertCard(data.issue);
            updateColumnCounts();
          }
          flash('Issue created');
        })
        .catch(function (err) { flash(err.message || 'Could not create the issue', true); })
        .finally(function () {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create issue';
          }
        });
    });
  }

  // ---- GitHub sync dialog ----
  var ghDialog = document.getElementById('iss-gh-dialog');
  var ghBtn = document.getElementById('iss-gh-sync-btn');
  var ghCancel = document.getElementById('iss-gh-cancel');
  var ghForm = document.getElementById('iss-gh-form');
  var ghSubmit = document.getElementById('iss-gh-submit');
  var ghQuickSync = document.getElementById('iss-gh-quick-sync');
  var ghError = document.getElementById('iss-gh-error');
  var ghConnectedBox = document.getElementById('iss-gh-connected-box');
  var ghLinkedRepo = document.getElementById('iss-gh-linked-repo');
  var ghSyncMeta = document.getElementById('iss-gh-sync-meta');
  var ghRepoInput = document.getElementById('iss-gh-repo');

  function openGitHubDialog() {
    if (!ghDialog) return;
    if (ghError) ghError.style.display = 'none';
    ghDialog.classList.add('iss-open');
    fetch(home + 'console/issues/github/config', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.config && data.config.repo) {
          if (ghConnectedBox) ghConnectedBox.style.display = 'block';
          if (ghLinkedRepo) ghLinkedRepo.textContent = data.config.repo;
          if (ghRepoInput && !ghRepoInput.value) ghRepoInput.value = data.config.repo;
          var metaText = 'Status: ' + data.config.status;
          if (data.config.lastSyncedAt) {
            metaText += ' • Last synced: ' + String(data.config.lastSyncedAt).slice(0, 16).replace('T', ' ') + ' (' + (data.config.syncedCount || 0) + ' issues)';
          }
          if (ghSyncMeta) ghSyncMeta.textContent = metaText;
          if (ghQuickSync) ghQuickSync.style.display = 'inline-block';
        }
      })
      .catch(function () {});
  }

  function closeGitHubDialog() {
    if (ghDialog) ghDialog.classList.remove('iss-open');
  }

  if (ghBtn) ghBtn.addEventListener('click', function (e) { e.preventDefault(); openGitHubDialog(); });
  if (ghCancel) ghCancel.addEventListener('click', function (e) { e.preventDefault(); closeGitHubDialog(); });
  if (ghDialog) ghDialog.addEventListener('click', function (e) {
    if (e.target === ghDialog) closeGitHubDialog();
  });

  if (ghForm) {
    ghForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (ghError) ghError.style.display = 'none';
      var repo = (ghRepoInput && ghRepoInput.value || '').trim();
      var tokenInput = document.getElementById('iss-gh-token');
      var token = (tokenInput && tokenInput.value || '').trim();
      if (!repo) {
        if (ghError) {
          ghError.textContent = 'Repository name is required.';
          ghError.style.display = 'block';
        }
        return;
      }
      if (ghSubmit) {
        ghSubmit.disabled = true;
        ghSubmit.textContent = 'Authorizing & Syncing...';
      }
      var body = new URLSearchParams();
      body.set('csrf', csrf);
      body.set('repo', repo);
      if (token) body.set('token', token);

      fetch(home + 'console/issues/github/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) throw new Error((data && data.error) || 'Authorization failed');
          closeGitHubDialog();
          flash('Synced ' + (data.syncedCount || 0) + ' issues from GitHub (' + data.repo + ')');
          watermark = '';
          tick();
        })
        .catch(function (err) {
          if (ghError) {
            ghError.textContent = err.message || 'Authorization failed';
            ghError.style.display = 'block';
          }
        })
        .finally(function () {
          if (ghSubmit) {
            ghSubmit.disabled = false;
            ghSubmit.textContent = 'Authorize & Sync';
          }
        });
    });
  }

  if (ghQuickSync) {
    ghQuickSync.addEventListener('click', function () {
      ghQuickSync.disabled = true;
      ghQuickSync.textContent = 'Syncing...';
      if (ghError) ghError.style.display = 'none';
      var body = new URLSearchParams();
      body.set('csrf', csrf);
      fetch(home + 'console/issues/github/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) throw new Error((data && data.error) || 'Sync failed');
          closeGitHubDialog();
          flash('Synced ' + (data.syncedCount || 0) + ' issues from GitHub');
          watermark = '';
          tick();
        })
        .catch(function (err) {
          if (ghError) {
            ghError.textContent = err.message || 'Sync failed';
            ghError.style.display = 'block';
          }
        })
        .finally(function () {
          ghQuickSync.disabled = false;
          ghQuickSync.textContent = 'Sync Now ⟳';
        });
    });
  }

  // ---- detail drawer ----
  var detail = document.getElementById('iss-detail');
  function openDetail(id) {
    if (!id) return;
    detail.dataset.issueId = id;
    detail.innerHTML = '<p style="color:#64748B;font-size:12.5px;">Loading…</p>';
    detail.classList.add('iss-open');
    detail.setAttribute('aria-hidden', 'false');
    fetch(home + 'console/issues/detail?id=' + encodeURIComponent(id), { headers: { 'accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'not found');
        renderDetail(data.issue, data.comments || []);
      })
      .catch(function (err) {
        detail.innerHTML = '<p style="color:#DC2626;font-size:12.5px;">' + escHtml(err.message) + '</p>';
      });
  }
  function closeDetail() {
    detail.classList.remove('iss-open');
    detail.setAttribute('aria-hidden', 'true');
    detail.dataset.issueId = '';
  }
  detail.addEventListener('click', function (e) {
    if (e.target === detail) closeDetail();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeDetail();
      if (dialog) dialog.classList.remove('iss-open');
      if (ghDialog) ghDialog.classList.remove('iss-open');
    }
    if ((e.key === 'c' || e.key === 'C') && dialog && !dialog.classList.contains('iss-open') && detail && !detail.classList.contains('iss-open')) {
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        openDialog();
      }
    }
  });

  function renderDetail(issue, comments) {
    var counts = window.__issCommentCounts || (window.__issCommentCounts = {});
    counts[issue.id] = comments.length;
    var labels = (issue.labels || []).map(function (l) {
      return '<span class="' + (LABEL_CLASS[l] || 'iss-pill iss-label-other') + '">' + escHtml(l) + '</span>';
    }).join('');
    var commentHtml = comments.map(function (c) {
      var at = escHtml(String(c.createdAt || '').slice(0, 16).replace('T', ' '));
      return '<div class="iss-comment"><span class="iss-comment-author">' + escHtml(c.author) + '</span>' +
        '<span class="iss-comment-at">' + at + '</span>' +
        '<div class="iss-comment-body">' + escHtml(c.content) + '</div></div>';
    }).join('');

    function optionList(values, selected) {
      return values.map(function (v) {
        return '<option value="' + escHtml(v) + '"' + (v === selected ? ' selected' : '') + '>' + escHtml(v) + '</option>';
      }).join('');
    }

    detail.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">' +
      '<h3>' + escHtml(issue.title) + '</h3>' +
      '<button type="button" id="iss-detail-close" class="iss-btn iss-btn-ghost" style="padding:4px 8px;" aria-label="Close">✕</button></div>' +
      '<div class="iss-pills" style="margin-top:8px;">' +
      '<span class="' + (PRIORITY_CLASS[issue.priority] || 'iss-pill iss-priority-none') + '">' + escHtml(issue.priority) + '</span>' + labels + '</div>' +
      '<div class="iss-desc">' + (issue.description ? escHtml(issue.description) : '<em style="color:#94A3B8;">No description</em>') + '</div>' +
      '<form id="iss-edit-form">' +
      '<input type="hidden" name="csrf" value="' + escHtml(csrf) + '">' +
      '<input type="hidden" name="issueId" value="' + escHtml(issue.id) + '">' +
      '<input type="hidden" name="expectedUpdatedAt" value="' + escHtml(issue.updatedAt) + '">' +
      '<div class="iss-field"><label for="iss-e-title">Title</label><input id="iss-e-title" name="title" maxlength="300" value="' + escHtml(issue.title) + '"></div>' +
      '<div class="iss-field"><label for="iss-e-desc">Description</label><textarea id="iss-e-desc" name="description">' + escHtml(issue.description) + '</textarea></div>' +
      '<div class="iss-field"><label for="iss-e-state">Column / State</label><select id="iss-e-state" name="state">' +
      optionList(STATES, issue.state) +
      '</select></div>' +
      '<div class="iss-field"><label for="iss-e-priority">Priority</label><select id="iss-e-priority" name="priority">' +
      optionList(PRIORITIES, issue.priority) +
      '</select></div>' +
      '<div class="iss-field"><label for="iss-e-progress">Progress %</label><input id="iss-e-progress" name="progress" type="number" min="0" max="100" value="' + Number(issue.progress || 0) + '"></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;"><button type="submit" class="iss-btn iss-btn-primary">Save changes</button>' +
      '<button type="button" id="iss-delete" class="iss-btn iss-btn-ghost" style="color:#DC2626;border-color:#FCA5A5;">Delete</button></div>' +
      '</form>' +
      '<div style="margin-top:20px;"><strong style="font-size:13px;color:#0F172A;">Comments (' + comments.length + ')</strong>' + (commentHtml || '<p style="color:#94A3B8;font-size:12px;margin:8px 0;">No comments yet.</p>') + '</div>' +
      '<form id="iss-comment-form" style="margin-top:12px;">' +
      '<input type="hidden" name="csrf" value="' + escHtml(csrf) + '">' +
      '<input type="hidden" name="issueId" value="' + escHtml(issue.id) + '">' +
      '<div class="iss-field"><label for="iss-c-content">Add comment</label><textarea id="iss-c-content" name="content" required maxlength="2000" placeholder="Leave a note for the engineering team…"></textarea></div>' +
      '<button type="submit" class="iss-btn iss-btn-primary">Post comment</button>' +
      '</form>';

    document.getElementById('iss-detail-close').addEventListener('click', closeDetail);
    document.getElementById('iss-edit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var body = new URLSearchParams();
      ['csrf', 'issueId', 'expectedUpdatedAt', 'title', 'description', 'state', 'priority', 'progress'].forEach(function (k) { body.set(k, fd.get(k) || ''); });
      fetch(home + 'console/issues/update', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'update failed');
          if (data.issue) { upsertCard(data.issue); renderDetail(data.issue, comments); }
          flash('Saved');
        })
        .catch(function (err) { flash(err.message || 'Could not save', true); });
    });
    document.getElementById('iss-delete').addEventListener('click', function () {
      if (!window.confirm('Delete this issue?')) return;
      var body = new URLSearchParams();
      body.set('csrf', csrf);
      body.set('issueId', issue.id);
      fetch(home + 'console/issues/delete', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'delete failed');
          var card = findCard(issue.id);
          if (card) card.remove();
          var row = findListRow(issue.id);
          if (row) row.remove();
          updateColumnCounts();
          closeDetail();
          flash('Issue deleted');
        })
        .catch(function (err) { flash(err.message || 'Could not delete', true); });
    });
    document.getElementById('iss-comment-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var body = new URLSearchParams();
      ['csrf', 'issueId', 'content'].forEach(function (k) { body.set(k, fd.get(k) || ''); });
      fetch(home + 'console/issues/comment', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'comment failed');
          comments.push(data.comment);
          var seen = window.__issSeenComments || (window.__issSeenComments = {});
          seen[data.comment.id] = true;
          window.__issCommentCounts = window.__issCommentCounts || {};
          window.__issCommentCounts[issue.id] = comments.length;
          updateCommentCountBadges(issue.id, comments.length);
          renderDetail(issue, comments);
          flash('Comment added');
        })
        .catch(function (err) { flash(err.message || 'Could not comment', true); });
    });
  }
})();
</script>`;
}

/** Standalone document for drawer fetches — same chrome, no workspace shell. */
export function issuesDocument(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Issues</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head><body style="margin:0;height:100%;overflow:hidden;">${inner}</body></html>`;
}
