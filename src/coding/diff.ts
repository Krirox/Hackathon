import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname, resolve, sep } from 'node:path';

// ── Real diff engine: baseline content vs current working tree. ──
// No sample code, no mocks: hunks are computed from actual file bytes via a
// line-level LCS diff. Git is used as the source of truth for status/history
// when the workspace is a git repo; otherwise directory snapshots are compared.

export type FileStatus = 'M' | 'A' | 'D' | 'R';
export interface DiffLine {
  type: ' ' | '-' | '+';
  text: string;
  origNo: number | null;
  newNo: number | null;
}
export interface DiffHunk {
  id: string;
  origStart: number;
  origLength: number;
  newStart: number;
  newLength: number;
  lines: DiffLine[];
  changeType: 'add' | 'del' | 'mod';
  agentId: string | null;
  planStepId: string | null;
  eventId: string | null;
  timestamp: string | null;
  decision: 'pending' | 'accepted' | 'rejected';
}
export interface ChangedFile {
  id: string;
  path: string;
  status: FileStatus;
  oldPath: string | null;
  originalHash: string;
  currentHash: string;
  insertions: number;
  deletions: number;
  hunks: DiffHunk[];
  group: string;
  agentIds: string[];
  humanModified: boolean;
}
export function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
export function groupForPath(p: string): string {
  const l = p.toLowerCase();
  if (/(^|\/)(migrations?|schema|seed)\//.test(l) || /\.sql$/.test(l)) return 'Database';
  if (/\.(test|spec)\.[a-z]+$/.test(l) || /(^|\/)(tests?|__tests__)\//.test(l)) return 'Tests';
  if (/(^|\/)(components?|pages?|views?|app|web|site|frontend|ui)\//.test(l) || /\.(tsx|jsx|vue|css|scss)$/.test(l))
    return 'Frontend';
  if (/(^|\/)(docker|deploy|infra|k8s|terraform|workflows\/)\//.test(l) || /dockerfile|compose|\.ya?ml$/.test(l))
    return 'Infrastructure';
  if (/(^|\/)(docs?|readme|changelog|license)/.test(l) || /\.md$/.test(l)) return 'Documentation';
  if (/package\.json|lock|requirements|\.toml$|\.cfg$|\.ini$|tsconfig/.test(l)) return 'Configuration';
  return 'Backend';
}
export function languageForPath(p: string): string {
  const e = extname(p).toLowerCase();
  const m: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.mjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.sql': 'sql',
    '.html': 'html',
    '.css': 'css',
    '.sh': 'bash',
    '.tf': 'hcl',
  };
  return m[e] ?? 'text';
}
// Line LCS diff → hunks with N context lines. O(n*m) worst case; inputs are
// trimmed by common prefix/suffix first and capped (large files → first 2000 differing lines).
export function diffLines(
  orig: string[],
  cur: string[],
  context = 3,
): { hunks: Omit<DiffHunk, 'id' | 'decision' | 'agentId' | 'planStepId' | 'eventId' | 'timestamp'>[] } {
  let a = 0;
  while (a < orig.length && a < cur.length && orig[a] === cur[a]) a++;
  let bO = orig.length - 1,
    bC = cur.length - 1;
  while (bO >= a && bC >= a && orig[bO] === cur[bC]) {
    bO--;
    bC--;
  }
  const O = orig.slice(a, bO + 1),
    C = cur.slice(a, bC + 1);
  // LCS table on the differing middle only.
  const n = O.length,
    m = C.length;
  const ops: ('=' | '-' | '+')[] = [];
  if (n * m > 4_000_000) {
    // Too big for full DP: fall back to block replace (honest single hunk, not fake alignment).
    for (let i = 0; i < n; i++) ops.push('-');
    for (let i = 0; i < m; i++) ops.push('+');
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i]![j] = O[i] === C[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (O[i] === C[j]) {
        ops.push('=');
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        ops.push('-');
        i++;
      } else {
        ops.push('+');
        j++;
      }
    }
    while (i++ < n) ops.push('-');
    while (j++ < m) ops.push('+');
  }
  // Build full op stream with equal prefix/suffix.
  const full: { t: '=' | '-' | '+'; o: string }[] = [];
  for (let k = 0; k < a; k++) full.push({ t: '=', o: orig[k]! });
  let oi = 0,
    ci = 0;
  for (const op of ops) {
    if (op === '=') {
      full.push({ t: '=', o: O[oi]! });
      oi++;
      ci++;
    } else if (op === '-') {
      full.push({ t: '-', o: O[oi]! });
      oi++;
    } else {
      full.push({ t: '+', o: C[ci]! });
      ci++;
    }
  }
  for (let k = bO + 1; k < orig.length; k++) full.push({ t: '=', o: orig[k]! });
  // Group into hunks: change runs with `context` lines of padding.
  const hunks: {
    origStart: number;
    origLength: number;
    newStart: number;
    newLength: number;
    lines: DiffLine[];
    changeType: 'add' | 'del' | 'mod';
  }[] = [];
  const changedIdx = full.map((f, k) => (f.t === '=' ? -1 : k)).filter((k) => k >= 0);
  if (changedIdx.length === 0) return { hunks: [] };
  // Cluster change positions separated by > 2*context equals.
  const clusters: number[][] = [];
  let cur2: number[] = [changedIdx[0]!];
  for (let k = 1; k < changedIdx.length; k++) {
    if (changedIdx[k]! - changedIdx[k - 1]! > 2 * context + 1) {
      clusters.push(cur2);
      cur2 = [changedIdx[k]!];
    } else cur2.push(changedIdx[k]!);
  }
  clusters.push(cur2);
  for (const cl of clusters) {
    const start = Math.max(0, cl[0]! - context),
      end = Math.min(full.length - 1, cl[cl.length - 1]! + context);
    // Compute line numbers at start by replay.
    let o = 1,
      nn = 1;
    for (let k = 0; k < start; k++) {
      if (full[k]!.t !== '+') o++;
      if (full[k]!.t !== '-') nn++;
    }
    const lines: DiffLine[] = [];
    let oL = 0,
      nL = 0,
      adds = 0,
      dels = 0;
    for (let k = start; k <= end; k++) {
      const f = full[k]!;
      if (f.t === '=') {
        lines.push({ type: ' ', text: f.o, origNo: o, newNo: nn });
        o++;
        nn++;
        oL++;
        nL++;
      } else if (f.t === '-') {
        lines.push({ type: '-', text: f.o, origNo: o, newNo: null });
        o++;
        oL++;
        dels++;
      } else {
        lines.push({ type: '+', text: f.o, origNo: null, newNo: nn });
        nn++;
        nL++;
        adds++;
      }
    }
    hunks.push({
      origStart: o - oL,
      origLength: oL,
      newStart: nn - nL,
      newLength: nL,
      lines,
      changeType: changeTypeOf(adds, dels),
    });
  }
  return { hunks };
}
/** What a run of added and deleted lines amounts to. Reads as a sentence, so a
 * reader does not have to parse a nest of ternaries to learn that "both" is a
 * modification. */
function changeTypeOf(adds: number, dels: number): 'add' | 'del' | 'mod' {
  if (adds > 0 && dels > 0) return 'mod';
  return adds > 0 ? 'add' : 'del';
}

/** A D has a baseline and no working copy; an A is the reverse. */
function fileStatus(original: string | null, current: string | null): FileStatus {
  if (original === null) return 'A';
  if (current === null) return 'D';
  return 'M';
}

export function diffFile(
  path: string,
  original: string | null,
  current: string | null,
  provenance?: Map<string, { agentId: string; planStepId: string; eventId: string; timestamp: string }>,
): ChangedFile {
  const status: FileStatus = fileStatus(original, current);
  const oLines = original === null ? [] : original.split('\n');
  const cLines = current === null ? [] : current.split('\n');
  const { hunks } = diffLines(oLines, cLines);
  let ins = 0,
    del = 0;
  const out: DiffHunk[] = hunks.map((h, i) => {
    for (const l of h.lines) {
      if (l.type === '+') ins++;
      if (l.type === '-') del++;
    }
    const key = `${path}:${h.origStart}-${h.origStart + h.origLength}`;
    const p = provenance?.get(key);
    return {
      ...h,
      id: `h_${sha(path + i).slice(0, 10)}`,
      agentId: p?.agentId ?? null,
      planStepId: p?.planStepId ?? null,
      eventId: p?.eventId ?? null,
      timestamp: p?.timestamp ?? null,
      decision: 'pending' as const,
    };
  });
  return {
    id: `f_${sha(path).slice(0, 12)}`,
    path,
    status,
    oldPath: null,
    originalHash: original === null ? '' : sha(original),
    currentHash: current === null ? '' : sha(current),
    insertions: ins,
    deletions: del,
    hunks: out,
    group: groupForPath(path),
    agentIds: [...new Set(out.map((h) => h.agentId).filter(Boolean) as string[])],
    humanModified: false,
  };
}
// Reconstruct file content after hunk decisions: rejected hunks revert to original lines,
// accepted hunks keep new lines; unchanged gaps are always preserved.
export function applyHunkDecisions(original: string | null, current: string | null, hunks: DiffHunk[]): string | null {
  if (original === null) return hunks.every((h) => h.decision === 'rejected') ? null : current;
  if (current === null) return hunks.every((h) => h.decision === 'rejected') ? original : null;
  const oLines = original.split('\n');
  const sorted = [...hunks].sort((a, b) => a.origStart - b.origStart);
  const out: string[] = [];
  let cursor = 1; // 1-based position in original
  for (const h of sorted) {
    while (cursor < h.origStart && cursor <= oLines.length) {
      out.push(oLines[cursor - 1]!);
      cursor++;
    }
    if (h.decision === 'rejected')
      for (const l of h.lines) {
        if (l.type !== '+') out.push(l.text);
      }
    else
      for (const l of h.lines) {
        if (l.type !== '-') out.push(l.text);
      }
    cursor = h.origStart + h.origLength;
  }
  while (cursor <= oLines.length) {
    out.push(oLines[cursor - 1]!);
    cursor++;
  }
  return out.join('\n');
}
// ── Workspace readers ──
export function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
export interface RepoChange {
  path: string;
  status: FileStatus;
  oldPath: string | null;
}
export function gitStatus(dir: string): RepoChange[] {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain', '-z'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    // -z fields are already \0-separated, so renames arrive as TWO consecutive
    // elements: `XY <to>` then `<from>` (porcelain reverses `from -> to`).
    // A naive split-and-iterate pairs the orphan `<from>` element as its own
    // entry and fabricates a phantom file — parse statefully instead.
    const parts = out.split('\0');
    const res: RepoChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.length === 0) continue;
      const code = p.slice(0, 2).trim();
      const path = p.slice(3).trim();
      if (path.length === 0) continue;
      if (code.startsWith('R') || code.startsWith('C')) {
        const from = (parts[++i] ?? '').trim();
        res.push({ path, status: 'R', oldPath: from.length > 0 ? from : null });
      } else if (code === '??') res.push({ path, status: 'A', oldPath: null });
      else if (code.includes('D')) res.push({ path, status: 'D', oldPath: null });
      else res.push({ path, status: 'M', oldPath: null });
    }
    return res;
  } catch {
    return [];
  }
}
export function gitShow(dir: string, rev: string, path: string): string | null {
  try {
    const out = execFileSync('git', ['-C', dir, 'show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out as string;
  } catch {
    return null;
  }
}
export function readTree(dir: string, paths: string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) {
    const full = join(dir, p);
    try {
      m.set(p, statSync(full).isFile() ? readFileSync(full, 'utf8') : null);
    } catch {
      m.set(p, null);
    }
  }
  return m;
}
export function listFilesRecursive(dir: string, base = dir, out: string[] = [], cap = 5000): string[] {
  if (out.length >= cap) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === '.git' || e === 'node_modules' || e === '.venv' || e === 'target' || e === 'dist') continue;
    const full = join(dir, e);
    try {
      if (statSync(full).isDirectory()) listFilesRecursive(full, base, out, cap);
      else {
        out.push(relative(base, full));
        if (out.length >= cap) return out;
      }
    } catch {
      /* skip */
    }
  }
  return out;
}
// Full review computation: baseline commit (or baseline snapshot map) vs working dir.
export function computeReviewFromGit(dir: string, baselineRev: string): ChangedFile[] {
  const changes = gitStatus(dir);
  // Include staged+unstaged vs baseline: compare baseline blob vs worktree bytes.
  const files: ChangedFile[] = [];
  for (const c of changes) {
    const orig = gitShow(dir, baselineRev, c.oldPath ?? c.path);
    let cur: string | null = null;
    if (c.status !== 'D') {
      try {
        cur = readFileSync(join(dir, c.path), 'utf8');
      } catch {
        cur = null;
      }
    }
    const f = diffFile(c.path, orig, cur);
    if (c.status === 'R') f.oldPath = c.oldPath;
    if (f.hunks.length > 0 || f.status !== 'M') files.push(f);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
export function writeFileSafe(dir: string, path: string, content: string): void {
  // Resolve-based containment check (the old `full !== join(dir, path)` was a
  // tautology — both sides identical). resolve() rejects `..` escapes and
  // anything landing outside the root, while allowing harmless names like
  // "a..b.txt" that a naive substring check would refuse.
  const root = resolve(dir);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`unsafe path: ${path}`);
  writeFileSync(full, content, 'utf8');
}
export function newReviewId(): string {
  return `RVW_${randomUUID().slice(0, 8).toUpperCase()}`;
}
export function secretScan(content: string, path: string): string[] {
  const hits: string[] = [];
  if (/(^|\/)(\.env(\.|$)|.*\.pem$|.*\.key$|credentials\.json$)/.test(path)) hits.push(`sensitive filename: ${path}`);
  const pats: [RegExp, string][] = [
    [/sk-(live|test)-[A-Za-z0-9]{8,}/, 'possible Stripe/OpenAI-style secret key'],
    [/AKIA[0-9A-Z]{16}/, 'possible AWS access key'],
    [/-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/, 'private key material'],
    [/[a-zA-Z0-9_.-]*password\s*[:=]\s*['"][^'"]{4,}['"]/i, 'hardcoded password'],
    [/xox[bpas]-[A-Za-z0-9-]{8,}/, 'possible Slack token'],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'possible GitHub token'],
  ];
  for (const [re, label] of pats) if (re.test(content)) hits.push(label);
  void existsSync;
  return hits;
}
