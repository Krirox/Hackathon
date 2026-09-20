import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { ClaimKind } from '../core/types.ts';
import { FilesystemArtifactStore } from '../ingest/collectors.ts';
import { checkDraft, type DraftCheck, WedgeError } from './ship.ts';

/**
 * FLOW-014: versioned deliverable artifacts inspectable before final approval.
 *
 * Launch, support, sales, and feature deliverables are persisted as
 * content-addressed blobs with explicit citation coverage, failed-check
 * visibility, and a revision path. Final publication approval binds to the
 * reviewed asset fingerprint — not the begin-work decision alone.
 */

export type DeliverableKind = 'launch' | 'support' | 'sales' | 'feature';

export type DeliverableReviewStatus = 'draft' | 'pending_review' | 'revision_requested' | 'approved' | 'superseded';

export type DeliverableItemClass = 'finding' | 'hypothesis' | 'unsupported';

export interface DeliverableItem {
  text: string;
  claimIds: string[];
  classification: DeliverableItemClass;
  /** Present when citation coverage or grounding check failed for this item. */
  checkFailed?: string;
}

export interface DeliverableVersion {
  id: string;
  deliverableId: string;
  tenant: string;
  requestId: string;
  workflowId: string | null;
  kind: DeliverableKind;
  deliverableSchema: string;
  version: number;
  fingerprint: string;
  artifactRef: string;
  items: DeliverableItem[];
  draftCheck: DraftCheck;
  status: DeliverableReviewStatus;
  preview: string;
  createdAt: string;
  createdBy: string;
  revisionNotes: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionId: string | null;
  priorVersionId: string | null;
  externalPublish: boolean;
}

export interface DeliverableRecord {
  id: string;
  tenant: string;
  requestId: string;
  workflowId: string | null;
  kind: DeliverableKind;
  deliverableSchema: string;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

const CLAIM_TAG = /\[claim:([^\]]+)\]/gi;

const SCHEMA_KIND: Record<string, DeliverableKind> = {
  'launch-pack.v1': 'launch',
  'support-pack.v1': 'support',
  'battlecard.v1': 'sales',
  'save-play.v1': 'support',
  'offer-copy.v1': 'sales',
  'pain-link.v1': 'feature',
  'budget-check.v1': 'feature',
  'launch-copy.v1': 'launch',
  'feature-plan.v1': 'feature',
  'code-change.v1': 'feature',
};

const HYPOTHESIS_KINDS = new Set<ClaimKind>(['BELIEF', 'HYPOTHESIS', 'ASSUMPTION', 'PREDICTION']);

const recordKey = (tenant: string, id: string): string => `wedge:deliverable:${tenant}:${id}`;
const versionKey = (tenant: string, id: string): string => `wedge:deliverable-ver:${tenant}:${id}`;
const requestIndexKey = (tenant: string, requestId: string): string => `wedge:deliverable-req:${tenant}:${requestId}`;

export function deliverableKindFromSchema(schema: string): DeliverableKind {
  return SCHEMA_KIND[schema] ?? 'feature';
}

export function deliverableFingerprint(content: string, claimIds: string[], version: number): string {
  const norm = JSON.stringify({ content, claimIds: [...claimIds].sort(), version });
  return createHash('sha256').update(norm).digest('hex');
}

function stableDeliverableId(tenant: string, requestId: string): string {
  const h = createHash('sha256').update(`${tenant}::${requestId}`).digest('hex').slice(0, 24);
  return `dlv_${h}`;
}

function parseItems(text: string, defaultClaimIds: string[]): { text: string; claimIds: string[] }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [{ text: text.trim(), claimIds: defaultClaimIds }];
  const items: { text: string; claimIds: string[] }[] = [];
  for (const line of lines) {
    const claimIds = new Set<string>();
    let body = line.replace(/^[-*•]\s+/, '');
    for (const m of body.matchAll(CLAIM_TAG)) claimIds.add(m[1]!);
    body = body.replace(CLAIM_TAG, '').trim();
    const ids = claimIds.size > 0 ? [...claimIds] : defaultClaimIds;
    items.push({ text: body, claimIds: ids });
  }
  return items;
}

export async function classifyDeliverableItems(
  ledger: Ledger,
  tenant: string,
  items: { text: string; claimIds: string[] }[],
  now: string,
): Promise<DeliverableItem[]> {
  const out: DeliverableItem[] = [];
  for (const item of items) {
    if (!item.text) {
      out.push({
        text: item.text,
        claimIds: item.claimIds,
        classification: 'unsupported',
        checkFailed: 'empty item',
      });
      continue;
    }
    if (item.claimIds.length === 0) {
      out.push({
        text: item.text,
        claimIds: [],
        classification: 'unsupported',
        checkFailed: 'factual item cites no evidence',
      });
      continue;
    }
    const live = await ledger.contextFor(tenant, item.claimIds, now);
    const liveIds = new Set(live.map((c) => c.id));
    const missing = item.claimIds.filter((id) => !liveIds.has(id));
    if (missing.length > 0) {
      out.push({
        text: item.text,
        claimIds: item.claimIds,
        classification: 'unsupported',
        checkFailed: `citations not live: ${missing.join(', ')}`,
      });
      continue;
    }
    const hypothesisOnly = live.every((c) => HYPOTHESIS_KINDS.has(c.kind));
    out.push({
      text: item.text,
      claimIds: item.claimIds,
      classification: hypothesisOnly ? 'hypothesis' : 'finding',
    });
  }
  return out;
}

export interface PersistDeliverableInput {
  tenant: string;
  requestId: string;
  workflowId?: string | null;
  deliverableSchema: string;
  content: string;
  claimIds: string[];
  createdBy: string;
  now: string;
  artifactDir?: string;
  externalPublish?: boolean;
  revisionNotes?: string | null;
  priorVersionId?: string | null;
}

export async function persistDeliverableVersion(
  db: AsyncDb,
  ledger: Ledger,
  input: PersistDeliverableInput,
): Promise<DeliverableVersion> {
  const artifactDir = input.artifactDir ?? join('data', 'artifacts');
  const kind = deliverableKindFromSchema(input.deliverableSchema);
  const deliverableId = stableDeliverableId(input.tenant, input.requestId);

  let record = await loadDeliverableRecord(db, input.tenant, deliverableId);
  const versionNum = record ? (await listDeliverableVersions(db, input.tenant, deliverableId)).length + 1 : 1;
  const fingerprint = deliverableFingerprint(input.content, input.claimIds, versionNum);

  const store = new FilesystemArtifactStore(artifactDir);
  const artifactRef = store.put(fingerprint, input.content);

  const parsed = parseItems(input.content, input.claimIds);
  const items = await classifyDeliverableItems(ledger, input.tenant, parsed, input.now);
  const draftCheck = await checkDraft(
    ledger,
    input.tenant,
    { text: input.content, claimIds: input.claimIds },
    input.now,
  );
  const hasItemFailures = items.some((i) => i.checkFailed);
  const status: DeliverableReviewStatus = draftCheck.ok && !hasItemFailures ? 'pending_review' : 'revision_requested';

  const versionId = `dlvver_${createHash('sha256').update(`${deliverableId}:${versionNum}`).digest('hex').slice(0, 20)}`;
  const version: DeliverableVersion = {
    id: versionId,
    deliverableId,
    tenant: input.tenant,
    requestId: input.requestId,
    workflowId: input.workflowId ?? null,
    kind,
    deliverableSchema: input.deliverableSchema,
    version: versionNum,
    fingerprint,
    artifactRef,
    items,
    draftCheck,
    status,
    preview: input.content.slice(0, 2000),
    createdAt: input.now,
    createdBy: input.createdBy,
    revisionNotes: input.revisionNotes ?? null,
    approvedBy: null,
    approvedAt: null,
    decisionId: null,
    priorVersionId: input.priorVersionId ?? null,
    externalPublish: input.externalPublish ?? false,
  };

  if (!record) {
    record = {
      id: deliverableId,
      tenant: input.tenant,
      requestId: input.requestId,
      workflowId: input.workflowId ?? null,
      kind,
      deliverableSchema: input.deliverableSchema,
      currentVersionId: versionId,
      createdAt: input.now,
      updatedAt: input.now,
    };
  } else {
    const prior = await loadDeliverableVersion(db, input.tenant, record.currentVersionId);
    if (prior && prior.status !== 'approved' && prior.status !== 'superseded') {
      await saveDeliverableVersion(db, { ...prior, status: 'superseded' });
    }
    record = { ...record, currentVersionId: versionId, updatedAt: input.now };
  }

  await saveDeliverableRecord(db, record);
  await saveDeliverableVersion(db, version);
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(requestIndexKey(input.tenant, input.requestId), deliverableId);
  return version;
}

export async function loadDeliverableRecord(
  db: AsyncDb,
  tenant: string,
  id: string,
): Promise<DeliverableRecord | null> {
  try {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(recordKey(tenant, id))) as
      { value: string } | undefined;
    if (!r) return null;
    return JSON.parse(String(r.value)) as DeliverableRecord;
  } catch {
    return null;
  }
}

export async function loadDeliverableByRequest(
  db: AsyncDb,
  tenant: string,
  requestId: string,
): Promise<DeliverableRecord | null> {
  const idx = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(requestIndexKey(tenant, requestId))) as
    { value: string } | undefined;
  if (!idx) return null;
  return loadDeliverableRecord(db, tenant, String(idx.value));
}

export async function loadDeliverableVersion(
  db: AsyncDb,
  tenant: string,
  versionId: string,
): Promise<DeliverableVersion | null> {
  try {
    const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(versionKey(tenant, versionId))) as
      { value: string } | undefined;
    if (!r) return null;
    return JSON.parse(String(r.value)) as DeliverableVersion;
  } catch {
    return null;
  }
}

export async function listDeliverableVersions(
  db: AsyncDb,
  tenant: string,
  deliverableId: string,
): Promise<DeliverableVersion[]> {
  const rows = (await db
    .prepare('SELECT value FROM meta WHERE key LIKE ?')
    .all(`wedge:deliverable-ver:${tenant}:%`)) as { value: string }[];
  const versions: DeliverableVersion[] = [];
  for (const row of rows) {
    try {
      const v = JSON.parse(String(row.value)) as DeliverableVersion;
      if (v.deliverableId === deliverableId) versions.push(v);
    } catch {
      /* skip corrupt */
    }
  }
  return versions.sort((a, b) => a.version - b.version);
}

async function saveDeliverableRecord(db: AsyncDb, record: DeliverableRecord): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(recordKey(record.tenant, record.id), JSON.stringify(record));
}

async function saveDeliverableVersion(db: AsyncDb, version: DeliverableVersion): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(versionKey(version.tenant, version.id), JSON.stringify(version));
}

export function diffDeliverableText(a: string, b: string): { added: string[]; removed: string[] } {
  const al = new Set(
    a
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const bl = new Set(
    b
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const added = [...bl].filter((l) => !al.has(l));
  const removed = [...al].filter((l) => !bl.has(l));
  return { added, removed };
}

export async function diffDeliverableVersions(
  db: AsyncDb,
  tenant: string,
  fromVersionId: string,
  toVersionId: string,
  artifactDir?: string,
): Promise<{ from: number; to: number; added: string[]; removed: string[] }> {
  const from = await loadDeliverableVersion(db, tenant, fromVersionId);
  const to = await loadDeliverableVersion(db, tenant, toVersionId);
  if (!from || !to) throw new WedgeError('VERSION_NOT_FOUND', 'one or both deliverable versions are missing');
  const dir = artifactDir ?? join('data', 'artifacts');
  const store = new FilesystemArtifactStore(dir);
  const a = store.get(from.artifactRef).toString('utf8');
  const b = store.get(to.artifactRef).toString('utf8');
  const diff = diffDeliverableText(a, b);
  return { from: from.version, to: to.version, ...diff };
}

export async function requestDeliverableRevision(
  db: AsyncDb,
  tenant: string,
  versionId: string,
  notes: string,
  by: string,
  now: string,
): Promise<DeliverableVersion> {
  const version = await loadDeliverableVersion(db, tenant, versionId);
  if (!version) throw new WedgeError('VERSION_NOT_FOUND', `deliverable version ${versionId} not found`);
  if (version.status === 'approved') {
    throw new WedgeError('ALREADY_APPROVED', 'approved deliverables cannot be sent back for revision');
  }
  const next: DeliverableVersion = {
    ...version,
    status: 'revision_requested',
    revisionNotes: `${by} @ ${now}: ${notes.trim()}`,
  };
  await saveDeliverableVersion(db, next);
  const record = await loadDeliverableRecord(db, tenant, version.deliverableId);
  if (record) await saveDeliverableRecord(db, { ...record, updatedAt: now });
  return next;
}

export interface ApproveDeliverableInput {
  tenant: string;
  versionId: string;
  fingerprint: string;
  approvedBy: string;
  now: string;
  scope: string;
  onBehalfOf: string;
  goal?: string;
}

/**
 * Final-deliverable approval: binds a Ledger decision to the exact reviewed
 * asset version. Irreversible external publish stays on human-command.
 */
export async function approveDeliverableVersion(
  db: AsyncDb,
  ledger: Ledger,
  input: ApproveDeliverableInput,
): Promise<{ version: DeliverableVersion; decisionId: string }> {
  const version = await loadDeliverableVersion(db, input.tenant, input.versionId);
  if (!version) throw new WedgeError('VERSION_NOT_FOUND', `deliverable version ${input.versionId} not found`);
  if (version.fingerprint !== input.fingerprint) {
    throw new WedgeError(
      'VERSION_MISMATCH',
      'asset fingerprint does not match the reviewed version: refresh and re-review',
    );
  }
  if (version.status === 'approved') {
    if (version.decisionId) return { version, decisionId: version.decisionId };
    throw new WedgeError('ALREADY_APPROVED', 'deliverable already approved without a decision receipt');
  }
  if (!version.draftCheck.ok || version.items.some((i) => i.checkFailed)) {
    const reasons = [
      ...version.draftCheck.unverified,
      ...version.draftCheck.deniedPhrases,
      ...version.items.filter((i) => i.checkFailed).map((i) => i.checkFailed!),
    ];
    throw new WedgeError('INSUFFICIENT_EVIDENCE', `deliverable failed grounding checks: ${reasons.join('; ')}`);
  }

  const actionClass = version.externalPublish ? 'ACT_IRREVERSIBLE' : 'ACT_REVERSIBLE';
  const autonomy = version.externalPublish ? 'human-command' : 'approval';
  const decisionId = `dec_deliverable_${createHash('sha256')
    .update(JSON.stringify([input.tenant, version.id, version.fingerprint]))
    .digest('hex')
    .slice(0, 24)}`;

  const existing = await ledger.getDecision(input.tenant, decisionId);
  if (existing) {
    const approved: DeliverableVersion = {
      ...version,
      status: 'approved',
      approvedBy: input.approvedBy,
      approvedAt: input.now,
      decisionId: existing.id,
    };
    await saveDeliverableVersion(db, approved);
    return { version: approved, decisionId: existing.id };
  }

  const decision = await ledger.recordDecision({
    id: decisionId,
    tenant: input.tenant,
    goal: input.goal ?? `approve ${version.kind} deliverable for ${version.requestId}`,
    action: JSON.stringify({
      approvalStage: 'final-deliverable',
      deliverableId: version.deliverableId,
      versionId: version.id,
      version: version.version,
      fingerprint: version.fingerprint,
      artifactRef: version.artifactRef,
      deliverableSchema: version.deliverableSchema,
      requestId: version.requestId,
      externalPublish: version.externalPublish,
    }),
    actionClass,
    claimIds: version.items.flatMap((i) => i.claimIds).filter((id, idx, arr) => arr.indexOf(id) === idx),
    decidedBy: input.onBehalfOf,
    approvedBy: input.approvedBy,
    scope: input.scope,
    autonomy,
    requestId: version.requestId,
    now: input.now,
  });

  const approved: DeliverableVersion = {
    ...version,
    status: 'approved',
    approvedBy: input.approvedBy,
    approvedAt: input.now,
    decisionId: decision.id,
  };
  await saveDeliverableVersion(db, approved);
  const record = await loadDeliverableRecord(db, input.tenant, version.deliverableId);
  if (record) await saveDeliverableRecord(db, { ...record, updatedAt: input.now });
  return { version: approved, decisionId: decision.id };
}

export function readDeliverableArtifact(version: DeliverableVersion, artifactDir?: string): string {
  const store = new FilesystemArtifactStore(artifactDir ?? join('data', 'artifacts'));
  return store.get(version.artifactRef).toString('utf8');
}
