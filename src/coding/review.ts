import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';

// CodeReview: the human gate between agent output and verified snapshot.
// Baseline (immutable) vs working tree (mutable) — diffs are recomputed live
// from the actual repository on every load; this doc stores only decisions,
// comments, iterations, and verification outcomes. Never file contents.

export type ReviewStatus =
  | 'READY_FOR_REVIEW'
  | 'HUMAN_REVIEW'
  | 'CHANGES_ACCEPTED'
  | 'CHANGES_REQUESTED'
  | 'AGENT_FIX'
  | 'FINAL_VERIFICATION'
  | 'SNAPSHOTTING'
  | 'COMPLETED'
  | 'REJECTED_ALL';

const TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  // CHANGES_REQUESTED directly from READY_FOR_REVIEW: the first
  // send-to-agent on a fresh review must not silently no-op.
  READY_FOR_REVIEW: ['HUMAN_REVIEW', 'CHANGES_REQUESTED'],
  HUMAN_REVIEW: ['CHANGES_ACCEPTED', 'CHANGES_REQUESTED', 'REJECTED_ALL'],
  CHANGES_REQUESTED: ['AGENT_FIX', 'HUMAN_REVIEW'],
  AGENT_FIX: ['READY_FOR_REVIEW'],
  CHANGES_ACCEPTED: ['FINAL_VERIFICATION'],
  FINAL_VERIFICATION: ['SNAPSHOTTING', 'HUMAN_REVIEW'],
  SNAPSHOTTING: ['COMPLETED'],
  COMPLETED: [],
  REJECTED_ALL: [],
};
export interface ReviewComment {
  id: string;
  file: string;
  line: number | null;
  hunkId: string | null;
  author: string;
  body: string;
  createdAt: string;
  status: 'open' | 'sent_to_agent' | 'resolved';
}
export interface ReviewIteration {
  n: number;
  label: string;
  at: string;
  files: number;
  insertions: number;
  deletions: number;
}
export interface HumanEdit {
  id: string;
  file: string;
  at: string;
  author: string;
  note: string;
}
export interface VerificationResult {
  suite: string;
  passed: number;
  failed: number;
  output: string;
  at: string;
  ok: boolean;
}
export interface CodeReviewDoc {
  id: string;
  missionId: string;
  tenant: string;
  status: ReviewStatus;
  baselineRev: string;
  workdir: string;
  snapshotId: string | null;
  hunkDecisions: Record<string, 'accepted' | 'rejected'>;
  fileDecisions: Record<string, 'accepted' | 'rejected'>;
  comments: ReviewComment[];
  iterations: ReviewIteration[];
  humanEdits: HumanEdit[];
  verification: VerificationResult[];
  createdAt: string;
  updatedAt: string;
}
const key = (t: string, m: string) => `review:${t}:${m}`;
async function emit(db: AsyncDb, tenant: string, type: string, ref: string, detail = ''): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
    .run(tenant, 'code-review', type, ref, detail.slice(0, 400), new Date().toISOString())
    .catch(() => {});
}
export async function openReview(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  baselineRev: string,
  workdir: string,
): Promise<CodeReviewDoc> {
  const at = new Date().toISOString();
  const doc: CodeReviewDoc = {
    id: `RVW_${randomUUID().slice(0, 8).toUpperCase()}`,
    missionId,
    tenant,
    status: 'READY_FOR_REVIEW',
    baselineRev,
    workdir,
    snapshotId: null,
    hunkDecisions: {},
    fileDecisions: {},
    comments: [],
    iterations: [],
    humanEdits: [],
    verification: [],
    createdAt: at,
    updatedAt: at,
  };
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key(tenant, missionId), JSON.stringify(doc));
  await emit(db, tenant, 'REVIEW_READY', missionId, `baseline=${baselineRev} dir=${workdir}`);
  return doc;
}
export async function getReview(db: AsyncDb, tenant: string, missionId: string): Promise<CodeReviewDoc | null> {
  const row = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key(tenant, missionId))) as
    { value: string } | undefined;
  return row ? (JSON.parse(String(row.value)) as CodeReviewDoc) : null;
}

/**
 * Every review opened for this tenant, newest first.
 *
 * The review UI was reachable only by typing `/console/review/<missionId>`:
 * the document is keyed by mission, and nothing in the product listed the keys.
 * An index over the same rows is what turns a URL-shaped tool into a page — and
 * it stays honest about the empty case, because a tenant with no reviews has
 * genuinely never opened one.
 */
export async function listReviews(db: AsyncDb, tenant: string): Promise<CodeReviewDoc[]> {
  const rows = (await db.prepare('SELECT value FROM meta WHERE key LIKE ?').all(`review:${tenant}:%`)) as {
    value: string;
  }[];
  const out: CodeReviewDoc[] = [];
  for (const row of rows) {
    try {
      const doc = JSON.parse(String(row.value)) as CodeReviewDoc;
      if (doc.tenant === tenant) out.push(doc);
    } catch {
      /* a corrupt row must not hide the readable ones */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function save(db: AsyncDb, doc: CodeReviewDoc): Promise<CodeReviewDoc> {
  doc.updatedAt = new Date().toISOString();
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key(doc.tenant, doc.missionId), JSON.stringify(doc));
  return doc;
}
export async function transitionReview(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  next: ReviewStatus,
  actor = 'human',
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  if (!TRANSITIONS[doc.status].includes(next)) throw new Error(`illegal review transition ${doc.status} → ${next}`);
  doc.status = next;
  await save(db, doc);
  await emit(
    db,
    tenant,
    next === 'COMPLETED' ? 'REVIEW_COMPLETED' : 'REVIEW_TRANSITION',
    missionId,
    `${actor} → ${next}`,
  );
  return doc;
}
export async function setHunkDecision(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  hunkId: string,
  d: 'accepted' | 'rejected',
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.hunkDecisions[hunkId] = d;
  await emit(db, tenant, d === 'accepted' ? 'HUNK_ACCEPTED' : 'HUNK_REJECTED', missionId, hunkId);
  return save(db, doc);
}
export async function setFileDecision(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  fileId: string,
  d: 'accepted' | 'rejected',
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.fileDecisions[fileId] = d;
  return save(db, doc);
}
export async function addComment(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  c: Omit<ReviewComment, 'id' | 'createdAt' | 'status'>,
): Promise<ReviewComment> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  const full: ReviewComment = {
    ...c,
    id: `cm_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  doc.comments.push(full);
  await save(db, doc);
  await emit(db, tenant, 'COMMENT_CREATED', missionId, `${c.file}:${c.line ?? '?'} ${c.body.slice(0, 120)}`);
  return full;
}
export async function sendCommentToAgent(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  commentId: string,
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  const c = doc.comments.find((x) => x.id === commentId);
  if (!c) throw new Error('comment not found');
  c.status = 'sent_to_agent';
  await save(db, doc);
  await emit(db, tenant, 'FIX_REQUESTED', missionId, `${c.file}:${c.line ?? '?'} ${c.body.slice(0, 200)}`);
  if (doc.status === 'HUMAN_REVIEW' || doc.status === 'READY_FOR_REVIEW') {
    try {
      await transitionReview(db, tenant, missionId, 'CHANGES_REQUESTED');
    } catch {
      /* already moved */
    }
  }
  return (await getReview(db, tenant, missionId))!;
}
export async function recordHumanEdit(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  file: string,
  author: string,
  note: string,
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.humanEdits.push({ id: `he_${randomUUID().slice(0, 8)}`, file, at: new Date().toISOString(), author, note });
  if (doc.status === 'READY_FOR_REVIEW') doc.status = 'HUMAN_REVIEW';
  await emit(db, tenant, 'HUMAN_EDIT_SAVED', missionId, `${file} by ${author}`);
  return save(db, doc);
}
export async function recordIteration(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  label: string,
  stats: { files: number; insertions: number; deletions: number },
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.iterations.push({ n: doc.iterations.length + 1, label, at: new Date().toISOString(), ...stats });
  return save(db, doc);
}
export async function setSnapshotId(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  snapshotId: string,
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.snapshotId = snapshotId;
  await save(db, doc);
  await emit(db, tenant, 'REVIEW_SNAPSHOT_BOUND', missionId, snapshotId);
  return doc;
}
export async function recordVerification(
  db: AsyncDb,
  tenant: string,
  missionId: string,
  v: Omit<VerificationResult, 'at'>,
): Promise<CodeReviewDoc> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) throw new Error('review not found');
  doc.verification.push({ ...v, at: new Date().toISOString() });
  await emit(
    db,
    tenant,
    v.ok ? 'TEST_PASSED' : 'TEST_FAILED',
    missionId,
    `${v.suite}: ${v.passed}/${v.passed + v.failed}`,
  );
  return save(db, doc);
}
export function reviewSummary(
  files: { insertions: number; deletions: number }[],
  doc: Pick<CodeReviewDoc, 'humanEdits' | 'verification' | 'comments'>,
): {
  files: number;
  insertions: number;
  deletions: number;
  humanEdits: number;
  testsPassed: number;
  testsFailed: number;
  openComments: number;
} {
  let ins = 0,
    del = 0;
  for (const f of files) {
    ins += f.insertions;
    del += f.deletions;
  }
  let tp = 0,
    tf = 0;
  for (const v of doc.verification) {
    tp += v.passed;
    tf += v.failed;
  }
  return {
    files: files.length,
    insertions: ins,
    deletions: del,
    humanEdits: doc.humanEdits.length,
    testsPassed: tp,
    testsFailed: tf,
    openComments: doc.comments.filter((c) => c.status === 'open').length,
  };
}
