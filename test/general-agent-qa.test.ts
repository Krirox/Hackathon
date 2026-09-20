import { T, eq, TEN, NOW, fresh } from './helpers.ts';
import { handleGeneralAgentQuery, answerGeneralQuestion } from '../src/talk/rag-analyst.ts';

T('general-agent: broad status query returns 4-section executive briefing', async () => {
  const { db } = await fresh();
  try {
    const res = await handleGeneralAgentQuery(db, TEN, 'What is going on currently in the business?', NOW);
    eq(res.isBriefing, true, 'is identified as executive briefing');
    eq(res.text.includes('Vital Business Intelligence Briefing'), true, 'contains briefing header');
    eq(res.text.includes('1. Departmental Health & Autonomy'), true, 'contains section 1');
    eq(res.text.includes('2. Spend & Attention Telemetry'), true, 'contains section 2');
    eq(res.text.includes('3. Reality Ledger Ingested Evidence'), true, 'contains section 3');
    eq(res.text.includes('4. Executive Next Steps'), true, 'contains section 4');
  } finally {
    await db.close();
  }
});

T('general-agent: specific question answered directly using Reality Ledger claims', async () => {
  const { db, ledger } = await fresh();
  try {
    // Ingest a verified claim
    await ledger.append({
      tenant: TEN,
      subject: 'data_retention_policy',
      kind: 'OBSERVATION',
      statement: 'Customer event logs are retained for exactly 90 days before immutable archive purge.',
      confidence: 0.98,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'agent:compliance-agent',
      scope: 'legal',
      authorType: 'agent',
      provenance: {
        sourceUri: 'file:///docs/policies/retention.md',
        sourceTier: 'SYSTEM_OF_RECORD',
        extractor: 'doc_indexer',
        extractorVersion: '1.0',
        retrievedAt: NOW,
      },
    });

    const res = await handleGeneralAgentQuery(
      db,
      TEN,
      '@general-agent what is our data retention policy for customer logs?',
      NOW,
    );

    eq(res.isBriefing, false, 'is direct Q&A, not broad status briefing');
    eq(res.text.includes('Customer event logs are retained for exactly 90 days'), true, 'answers with exact fact');
    eq(res.text.includes('[legal]'), true, 'cites scope');
    eq(res.text.includes('file:///docs/policies/retention.md'), true, 'cites source URI');
  } finally {
    await db.close();
  }
});

T('general-agent: unknown specialized finance question delegates to @finance-agent', async () => {
  const { db } = await fresh();
  try {
    const res = await answerGeneralQuestion(
      db,
      TEN,
      '@general-agent how do we reconcile stripe invoice billing discrepancies?',
      NOW,
    );

    eq(res.matchedClaimsCount, 0, 'no claims in ledger yet');
    eq(res.specialist !== null, true, 'identified finance specialist');
    eq(res.specialist?.agentName, 'finance-agent', 'specialist is finance-agent');
    eq(res.specialist?.roomName, 'finance', 'specialist room is #finance');
    eq(res.text.includes('@finance-agent'), true, 'mentions @finance-agent');
    eq(res.text.includes('#finance'), true, 'mentions #finance');
  } finally {
    await db.close();
  }
});

T('general-agent: unknown infra question delegates to @ops-agent in #ops', async () => {
  const { db } = await fresh();
  try {
    const res = await answerGeneralQuestion(
      db,
      TEN,
      '@general-agent how do I deploy the latest microvm server pipeline?',
      NOW,
    );

    eq(res.matchedClaimsCount, 0, 'no claims in ledger yet');
    eq(res.specialist?.agentName, 'ops-agent', 'specialist is ops-agent');
    eq(res.specialist?.roomName, 'ops', 'specialist room is #ops');
    eq(res.text.includes('@ops-agent'), true, 'mentions @ops-agent');
  } finally {
    await db.close();
  }
});

T('general-agent: unknown compliance question delegates to @compliance-agent in #compliance', async () => {
  const { db } = await fresh();
  try {
    const res = await answerGeneralQuestion(
      db,
      TEN,
      '@general-agent what are our GDPR regulatory audit requirements under EU AI Act?',
      NOW,
    );

    eq(res.matchedClaimsCount, 0, 'no claims in ledger yet');
    eq(res.specialist?.agentName, 'compliance-agent', 'specialist is compliance-agent');
    eq(res.specialist?.roomName, 'compliance', 'specialist room is #compliance');
    eq(res.text.includes('@compliance-agent'), true, 'mentions @compliance-agent');
  } finally {
    await db.close();
  }
});

T('general-agent: generic question with no claims points user to /setup', async () => {
  const { db } = await fresh();
  try {
    const res = await answerGeneralQuestion(db, TEN, '@general-agent who is the contact for project zephyr?', NOW);

    eq(res.matchedClaimsCount, 0, 'no claims found');
    eq(res.specialist, null, 'no domain specialist matched');
    eq(res.text.includes('/setup'), true, 'points user to /setup');
  } finally {
    await db.close();
  }
});
