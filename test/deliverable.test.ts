import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { T, eq, TEN, NOW, fresh, sor, rejects } from './helpers.ts';
import {
  approveDeliverableVersion,
  deliverableFingerprint,
  diffDeliverableVersions,
  persistDeliverableVersion,
  readDeliverableArtifact,
  requestDeliverableRevision,
  loadDeliverableByRequest,
} from '../src/wedge/deliverable-artifact.ts';

console.log('\n\x1b[1mDeliverable artifacts — FLOW-014\x1b[0m');

T('FLOW-014: persist deliverable as versioned artifact with citation analysis', async () => {
  const { db, ledger } = await fresh();
  const artDir = join(tmpdir(), `vital-dlv-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'release:v2',
    kind: 'FACT',
    statement: 'Widget export ships in v2',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:pm',
    scope: 'product',
    authorType: 'human',
    provenance: sor(),
  });
  const content = `- Launch blog highlights widget export [claim:${claim.id}]`;
  const version = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_launch_1',
    deliverableSchema: 'launch-pack.v1',
    content,
    claimIds: [claim.id],
    createdBy: 'agent:marketing',
    now: NOW,
    artifactDir: artDir,
  });
  eq(version.version, 1);
  eq(version.kind, 'launch');
  eq(version.status, 'pending_review');
  eq(version.draftCheck.ok, true);
  eq(version.items[0]?.classification, 'finding');
  eq(readDeliverableArtifact(version, artDir), content);
  const record = await loadDeliverableByRequest(db, TEN, 'req_launch_1');
  eq(record?.id, version.deliverableId);
});

T('FLOW-014: insufficient citations mark items unsupported and block approval', async () => {
  const { db, ledger } = await fresh();
  const artDir = join(tmpdir(), `vital-dlv-bad-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'release:v2',
    kind: 'FACT',
    statement: 'Widget export ships in v2',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:pm',
    scope: 'product',
    authorType: 'human',
    provenance: sor(),
  });
  const version = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_launch_bad',
    deliverableSchema: 'launch-pack.v1',
    content: '- We guarantee 100% profit on launch',
    claimIds: [claim.id],
    createdBy: 'agent:marketing',
    now: NOW,
    artifactDir: artDir,
  });
  eq(version.status, 'revision_requested');
  eq(version.draftCheck.ok, false);
  await rejects(
    async () =>
      await approveDeliverableVersion(db, ledger, {
        tenant: TEN,
        versionId: version.id,
        fingerprint: version.fingerprint,
        approvedBy: 'human:reviewer',
        now: NOW,
        scope: 'marketing',
        onBehalfOf: 'agent:marketing',
      }),
    'INSUFFICIENT_EVIDENCE',
  );
});

T('FLOW-014: request-changes and revision create a new version with diff', async () => {
  const { db, ledger } = await fresh();
  const artDir = join(tmpdir(), `vital-dlv-rev-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'support:macro',
    kind: 'FACT',
    statement: 'Export FAQ published',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:cs',
    scope: 'customer',
    authorType: 'human',
    provenance: sor(),
  });
  const v1 = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_support_1',
    deliverableSchema: 'support-pack.v1',
    content: `- casual support macro for export [claim:${claim.id}]`,
    claimIds: [claim.id],
    createdBy: 'agent:customer',
    now: NOW,
    artifactDir: artDir,
  });
  const revised = await requestDeliverableRevision(db, TEN, v1.id, 'Tone is too casual', 'human:reviewer', NOW);
  eq(revised.status, 'revision_requested');
  const v2 = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_support_1',
    deliverableSchema: 'support-pack.v1',
    content: `- Professional support macro for export [claim:${claim.id}]`,
    claimIds: [claim.id],
    createdBy: 'agent:customer',
    now: NOW,
    artifactDir: artDir,
    priorVersionId: v1.id,
    revisionNotes: 'Address reviewer tone feedback',
  });
  eq(v2.version, 2);
  const diff = await diffDeliverableVersions(db, TEN, v1.id, v2.id, artDir);
  eq(
    diff.added.some((l) => l.includes('Professional')),
    true,
  );
  eq(
    diff.removed.some((l) => l.includes('casual')),
    true,
  );
});

T('FLOW-014: final approval binds to reviewed asset fingerprint', async () => {
  const { db, ledger } = await fresh();
  const artDir = join(tmpdir(), `vital-dlv-ok-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'sales:card',
    kind: 'FACT',
    statement: 'Battlecard cites verified positioning',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:sales',
    scope: 'sales',
    authorType: 'human',
    provenance: sor(),
  });
  const version = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_sales_1',
    deliverableSchema: 'battlecard.v1',
    content: `- Positioning against competitors [claim:${claim.id}]`,
    claimIds: [claim.id],
    createdBy: 'agent:sales',
    now: NOW,
    artifactDir: artDir,
  });
  const { decisionId } = await approveDeliverableVersion(db, ledger, {
    tenant: TEN,
    versionId: version.id,
    fingerprint: version.fingerprint,
    approvedBy: 'human:reviewer',
    now: NOW,
    scope: 'sales',
    onBehalfOf: 'agent:sales',
  });
  const decision = await ledger.getDecision(TEN, decisionId);
  eq(decision?.actionClass, 'ACT_REVERSIBLE');
  const action = JSON.parse(decision!.action);
  eq(action.approvalStage, 'final-deliverable');
  eq(action.fingerprint, version.fingerprint);
  await rejects(
    async () =>
      await approveDeliverableVersion(db, ledger, {
        tenant: TEN,
        versionId: version.id,
        fingerprint: deliverableFingerprint('tampered', [claim.id], version.version),
        approvedBy: 'human:reviewer',
        now: NOW,
        scope: 'sales',
        onBehalfOf: 'agent:sales',
      }),
    'VERSION_MISMATCH',
  );
});

T('FLOW-014: external publish deliverable records human-command only', async () => {
  const { db, ledger } = await fresh();
  const artDir = join(tmpdir(), `vital-dlv-ext-${Date.now()}`);
  mkdirSync(artDir, { recursive: true });
  const claim = await ledger.append({
    tenant: TEN,
    subject: 'launch:public',
    kind: 'FACT',
    statement: 'Public blog approved internally',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'human:pm',
    scope: 'marketing',
    authorType: 'human',
    provenance: sor(),
  });
  const version = await persistDeliverableVersion(db, ledger, {
    tenant: TEN,
    requestId: 'req_ext_1',
    deliverableSchema: 'launch-pack.v1',
    content: `- Public blog post [claim:${claim.id}]`,
    claimIds: [claim.id],
    createdBy: 'agent:marketing',
    now: NOW,
    artifactDir: artDir,
    externalPublish: true,
  });
  const { decisionId } = await approveDeliverableVersion(db, ledger, {
    tenant: TEN,
    versionId: version.id,
    fingerprint: version.fingerprint,
    approvedBy: 'human:officer',
    now: NOW,
    scope: 'marketing',
    onBehalfOf: 'agent:marketing',
  });
  const decision = await ledger.getDecision(TEN, decisionId);
  eq(decision?.actionClass, 'ACT_IRREVERSIBLE');
  eq(decision?.autonomy, 'human-command');
});
