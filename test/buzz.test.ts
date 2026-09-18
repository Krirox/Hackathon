import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';
import {
  CANONICAL_ROOMS,
  agentForScope,
  normalizeScope,
  channelForScope,
  channelForRequest,
  loadRoomConfig,
  saveRoomConfig,
} from '../src/talk/rooms.ts';
import {
  ScopeHealthEvaluator,
  publishRoomStatusBeacon,
  formatStatusBeacon,
  BUZZ_STATUS_BEACON_KIND,
} from '../src/talk/health.ts';
import { renderReviewCard, mintReviewToken, verifyReviewToken } from '../src/talk/review-card.ts';
import { executeRoomCommand } from '../src/talk/commands.ts';
import { InterAgentSwarmCoordinator, parseCrossRoomDispatch } from '../src/talk/swarm.ts';
import { LiveCanvasSynchronizer } from '../src/talk/canvas.ts';
import { AutomatedHoneytaskCanary } from '../src/talk/canary.ts';
import { AmbientMorningBriefingSynthesizer, generateVoiceAudioWav } from '../src/talk/huddle.ts';
import { RoomBudgetTracker, renderProgressBar, formatTokenRate } from '../src/talk/budget-gauge.ts';
import { TimeTravelForkEngine } from '../src/talk/fork.ts';
import { renderRoomsSetupPage, handleRoomsSetupPost, INDUSTRY_PRESETS } from '../src/console/rooms-setup.ts';
import { createBuzzSurface, type BuzzNostrEvent } from '../src/talk/buzz.ts';
import { generateNostrKeypair, pubkeyFromSecret, verifyNostrEvent } from '../src/talk/nostr.ts';
import { signAsRoomAgent } from '../src/talk/rooms.ts';
import { createServer, type Server } from 'node:http';

console.log('\n\x1b[1m🏛️ Vital Buzz Autonomous Rooms & Swarms Test Suite\x1b[0m');

/** Mock Nostr Relay for testing */
/**
 * A relay that captures the **bare event** — the shape a real Buzz relay
 * parses. It also records headers so the auth scheme is assertable.
 */
async function fakeRelay(): Promise<{
  url: string;
  received: { path: string; body: BuzzNostrEvent; headers: Record<string, string> }[];
  close(): Promise<void>;
}> {
  const received: { path: string; body: BuzzNostrEvent; headers: Record<string, string> }[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(data) as BuzzNostrEvent;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        received.push({ path: req.url ?? '', body, headers });
      } catch {
        // A probe that is not JSON is recorded as nothing; the relay-style
        // error path is exercised elsewhere.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const stubFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** A real agent identity for the tests that publish. */
const testAgent = generateNostrKeypair();
/** A provisioned room's relay channel UUID. */
const TEST_CHANNEL = '6f2d1c4b-3a5e-4d7c-9b1a-2c3d4e5f6a7b';
const surfaceFor = (relayUrl: string) =>
  createBuzzSurface({
    relayUrl,
    keypair: testAgent,
    authMode: 'dev-pubkey',
    fetchFn: stubFetch,
    channelIdFor: () => TEST_CHANNEL,
  });

// ------------------------------------------------------------------ Phase 1 Tests
T('Phase 1: 12 Canonical Rooms and cryptographic agent identities are properly initialized', async () => {
  const { db } = await fresh();
  eq(CANONICAL_ROOMS.length, 12, 'exactly 12 canonical rooms:');

  const expectedRooms = [
    'reality-core',
    'fact-check',
    'market-intel',
    'risk-monitor',
    'user-feedback',
    'compliance',
    'finance',
    'ops',
    'growth',
    'data-pipeline',
    'exec',
    'sandbox',
  ];

  for (const name of expectedRooms) {
    const room = CANONICAL_ROOMS.find((r) => r.name === name);
    eq(Boolean(room), true, `room ${name} exists in roster:`);
    eq(room!.agentName.endsWith('-agent'), true, `room ${name} names an agent:`);
  }

  // Fail closed: with no key material configured, a room has NO identity. The
  // old implementation invented a "pubkey" as sha256("vital:agent:<name>") and
  // signed with a plain hash, which no relay would accept and anyone could forge.
  if (!process.env.BUZZ_AGENT_MASTER_KEY) {
    eq(agentForScope('risk'), null, 'an unconfigured deployment has no agent identity:');
  }

  // With a master secret, identities are real secp256k1 keys, one per agent,
  // and reproducible — provisioning stays idempotent without storing 12 keys.
  process.env.BUZZ_AGENT_MASTER_KEY = 'a'.repeat(64);
  const risk = agentForScope('risk');
  eq(Boolean(risk), true, 'a configured deployment resolves an identity:');
  eq(risk!.name, 'risk-agent');
  eq(risk!.scope, 'risk');
  eq(risk!.pubkey, pubkeyFromSecret(risk!.keypair.secretKey), "the pubkey is the keypair's real pubkey:");
  eq(risk!.resolution.source, 'master-key');
  eq(agentForScope('risk')!.pubkey, risk!.pubkey, 'identity derivation is stable:');
  eq(agentForScope('finance')!.pubkey !== risk!.pubkey, true, 'each room agent is a distinct identity:');

  // Signing as the room agent produces an event a relay would accept.
  const signed = signAsRoomAgent('risk', {
    kind: BUZZ_STATUS_BEACON_KIND,
    tags: [['h', TEST_CHANNEL]],
    content: 'probe',
  });
  eq(verifyNostrEvent(signed), true, 'the room agent signs verifiable events:');
  eq(signed.pubkey, risk!.pubkey);
  delete process.env.BUZZ_AGENT_MASTER_KEY;

  // Scope normalization
  eq(normalizeScope('scope:risk'), 'risk');
  eq(normalizeScope('chan-risk-monitor'), 'risk');
  eq(normalizeScope('risk-monitor'), 'risk');
  eq(channelForScope('risk'), 'chan-risk-monitor');
  eq(channelForRequest('req_1', { targetScope: 'finance' }).channel, 'chan-finance');

  // Room config loading & saving
  const cfg = await loadRoomConfig(db, TEN, 'risk');
  eq(cfg.scope, 'risk');
  eq(cfg.autonomy, 'guarded');
  eq(cfg.budgetCeilingDollars, 1000);

  const updated = await saveRoomConfig(db, TEN, { scope: 'risk', budgetCeilingDollars: 1500, autonomy: 'autonomous' });
  eq(updated.budgetCeilingDollars, 1500);
  eq(updated.autonomy, 'autonomous');

  const reloaded = await loadRoomConfig(db, TEN, 'risk');
  eq(reloaded.budgetCeilingDollars, 1500);
  eq(reloaded.autonomy, 'autonomous');
});

// ------------------------------------------------------------------ Phase 2 Tests
T('Phase 2: ScopeHealthEvaluator computes composite health and publishes status beacons', async () => {
  const { db, ledger, coord } = await fresh();
  const evaluator = new ScopeHealthEvaluator(db, TEN, { coord, ledger });

  // Baseline is healthy
  const initialHealth = await evaluator.evaluateScope('risk');
  eq(initialHealth.status, 'healthy');
  eq(initialHealth.badge, '🟢');
  eq(initialHealth.reasons.length, 0);

  // Status beacon formatting
  const beaconText = formatStatusBeacon(initialHealth);
  eq(beaconText.includes('🟢 #risk-monitor'), true);
  eq(beaconText.includes('HEALTHY'), true);

  // Engage kill switch -> turns 🔴 halted
  const { setKill } = await import('../src/gov/trust.ts');
  await setKill(db, TEN, { scope: 'risk', actionClass: '*' }, 'operator:test', NOW, { reason: 'Market stress test' });

  const haltedHealth = await evaluator.evaluateScope('risk');
  eq(haltedHealth.status, 'halted');
  eq(haltedHealth.badge, '🔴');
  eq(haltedHealth.activeStops, 1);
  eq(
    haltedHealth.reasons.some((r) => r.includes('Active stop engaged')),
    true,
  );

  // Publish beacon to Nostr relay
  const relay = await fakeRelay();
  try {
    const surface = surfaceFor(relay.url);
    await publishRoomStatusBeacon(surface, haltedHealth);

    eq(relay.received.length >= 1, true, 'status beacon reached relay:');
    const last = relay.received[relay.received.length - 1]!;
    const ev = last.body;
    eq(ev.kind, BUZZ_STATUS_BEACON_KIND, 'the beacon is published as kind 30315, not as chat text:');
    eq(
      ev.tags.some((t) => t[0] === 'h' && t[1] === TEST_CHANNEL),
      true,
      'the beacon addresses the room relay channel UUID:',
    );
    eq(
      ev.tags.some((t) => t[0] === 'd' && t[1] === 'status:risk'),
      true,
      'the beacon is addressable per room:',
    );
    eq(
      verifyNostrEvent({
        pubkey: ev.pubkey,
        id: ev.id,
        sig: ev.sig,
        kind: ev.kind,
        tags: ev.tags,
        content: ev.content,
        createdAt: ev.created_at,
      }),
      true,
      'the relay would accept this beacon:',
    );
    eq(ev.content.includes('🔴 #risk-monitor'), true);
  } finally {
    await relay.close();
  }
});

// ------------------------------------------------------------------ Phase 4 Tests
T('Phase 4: In-Room Review Cards format NIP-29 review cards and verify approval tokens', async () => {
  const secret = 'test-review-secret';
  const approveToken = mintReviewToken(secret, TEN, 'req_42', 'approve');
  const declineToken = mintReviewToken(secret, TEN, 'req_42', 'decline');

  const validApprove = verifyReviewToken(approveToken, secret);
  eq(validApprove.valid, true);
  eq(validApprove.requestId, 'req_42');
  eq(validApprove.action, 'approve');

  const validDecline = verifyReviewToken(declineToken, secret);
  eq(validDecline.valid, true);
  eq(validDecline.action, 'decline');

  // Tampered token fails
  const tampered = verifyReviewToken(approveToken + 'x', secret);
  eq(tampered.valid, false);

  // Review card rendering
  const cardMarkdown = renderReviewCard({
    requestId: 'req_8f21',
    tenant: TEN,
    scope: 'risk-monitor',
    goal: 'Rebalance portfolio hedge against counterparty variance',
    bidDollars: 420,
    bidTokens: 8500,
    confidence: 0.74,
    driftScore: 0.068,
    evidence: [{ claimId: 'clm_8f21', statement: 'Contradiction with Q3 filings', confidence: 0.95 }],
    secret,
  });

  eq(cardMarkdown.includes('HUMAN ATTENTION REQUIRED'), true);
  eq(cardMarkdown.includes('req_8f21'), true);
  eq(cardMarkdown.includes('clm_8f21'), true);
  eq(cardMarkdown.includes('Approve'), true);
  eq(cardMarkdown.includes('Decline'), true);
});

// ------------------------------------------------------------------ Phase 5 Tests
T('Phase 5: In-Room Slash Commands execute /halt, /recover, /status, /cost, /policy', async () => {
  const { db, ledger, coord } = await fresh();
  const ctx = {
    db,
    tenant: TEN,
    actor: 'risk-lead',
    currentScope: 'risk',
    coord,
    ledger,
  };

  // 1. /halt
  const haltRes = await executeRoomCommand('/halt risk reason="Drift threshold breach"', ctx);
  eq(haltRes.handled, true);
  eq(haltRes.actionTaken, 'KILL_ENGAGED');
  eq(haltRes.output.includes('EMERGENCY HALT ENGAGED'), true);

  // 2. /status
  const statusRes = await executeRoomCommand('/status risk', ctx);
  eq(statusRes.handled, true);
  eq(statusRes.output.includes('Room Health Telemetry'), true);
  eq(statusRes.output.includes('HALTED'), true);

  // 3. /recover
  const recoverRes = await executeRoomCommand('/recover risk reason="Hedge rebalance verified"', ctx);
  eq(recoverRes.handled, true);
  eq(recoverRes.actionTaken, 'KILL_RECOVERED');
  eq(recoverRes.output.includes('RECOVERY COMPLETED'), true);

  // 4. /cost
  const costRes = await executeRoomCommand('/cost risk', ctx);
  eq(costRes.handled, true);
  eq(costRes.output.includes('Spend & Gas Gauge'), true);

  // 5. /policy set
  const policyRes = await executeRoomCommand('/policy set autonomy=guarded spend_limit=500', ctx);
  eq(policyRes.handled, true);
  eq(policyRes.actionTaken, 'POLICY_MUTATE');
  eq(policyRes.output.includes('Updated Policy'), true);
  eq(policyRes.output.includes('500'), true);

  // 6. /policy set with natural language mission prompt
  const missionRes = await executeRoomCommand('/policy set mission="Focus on Q4 enterprise churn trends"', ctx);
  eq(missionRes.handled, true);
  eq(missionRes.actionTaken, 'POLICY_MUTATE');
  eq(missionRes.output.includes('Focus on Q4 enterprise churn trends'), true);

  // 7. Verify signed immutable audit_log record
  const auditRow = (await db
    .prepare(
      'SELECT actor, action, target, detail FROM audit_log WHERE tenant = ? AND action = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(TEN, 'POLICY_MUTATE')) as { actor: string; action: string; target: string; detail: string } | undefined;
  eq(Boolean(auditRow), true);
  eq(auditRow?.actor, 'risk-lead');
  eq(auditRow?.action, 'POLICY_MUTATE');
  eq(auditRow?.detail.includes('Focus on Q4 enterprise churn trends'), true);
});

// ------------------------------------------------------------------ Feature 1: Swarms
T('Feature 1: Cross-Room Agent Handoffs & Deliberations (Inter-Agent Swarms)', async () => {
  const { db, ledger, coord } = await fresh();
  const relay = await fakeRelay();

  try {
    const surface = surfaceFor(relay.url);
    const swarm = new InterAgentSwarmCoordinator({ db, ledger, coord, surface });

    // Ingest origin observation claim in #market-intel
    const marketClaim = await ledger.append({
      tenant: TEN,
      subject: 'competitor_pricing',
      kind: 'OBSERVATION',
      statement: 'Competitor slashed enterprise pricing by 20% on Q3 renewals',
      confidence: 0.98,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'agent:market-agent',
      scope: 'research',
      authorType: 'agent',
      provenance: sor(),
    });

    // Parse dispatch
    const dispatchText = `@finance-agent assess churn impact of [${marketClaim.id}]`;
    const parsed = parseCrossRoomDispatch(dispatchText);
    eq(parsed !== null, true);
    eq(parsed?.targetAgent, 'finance-agent');
    eq(parsed?.targetScope, 'finance');
    eq(parsed?.claimRefs[0], marketClaim.id);

    // Step 1: Execute Handoff from market-agent to finance-agent
    const handoff = await swarm.executeHandoff({
      tenant: TEN,
      originScope: 'research',
      originAgent: 'market-agent',
      dispatchText,
    });

    eq(handoff.targetScope, 'finance');
    eq(Boolean(handoff.downstreamRequestId), true);
    eq(handoff.events.length, 2);

    // Step 2: Finance agent completes churn modeling with high risk (18.4% churn)
    const outcome = await swarm.handleAssessmentOutcome({
      tenant: TEN,
      downstreamRequestId: handoff.downstreamRequestId,
      targetScope: 'finance',
      originScope: 'research',
      originClaimIds: [marketClaim.id],
      churnProbability: 0.184, // 18.4% > 10% high risk
      statement: 'Enterprise churn vulnerability estimated at +18.4% due to competitor pricing',
    });

    eq(outcome.escalated, true, 'high churn risk must trigger escalation:');
    eq(outcome.downstreamRooms.includes('exec'), true, 'escalated to #exec:');
    eq(outcome.downstreamRooms.includes('growth'), true, 'escalated to #growth:');

    // Verify claim linkage in Reality Ledger (derived_from)
    const findingClaim = await ledger.get(TEN, outcome.findingClaimId);
    eq(Boolean(findingClaim), true);
    eq(findingClaim?.scope, 'finance');

    // Verify events landed on relay
    eq(relay.received.length >= 2, true, 'cross-room deliberations streamed to Buzz channels:');
  } finally {
    await relay.close();
  }
});

// ------------------------------------------------------------------ Feature 2: Canvases
T('Feature 2: Live Epistemic Canvases render specialized real-time documents', async () => {
  const { db, ledger } = await fresh();
  const canvasSync = new LiveCanvasSynchronizer({ db, tenant: TEN, ledger });

  // 1. #risk-monitor canvas
  const riskCanvas = await canvasSync.generateCanvas('risk');
  eq(riskCanvas.channel, 'chan-risk-monitor');
  eq(riskCanvas.markdown.includes('Counterparty Credit Exposure'), true);
  eq(riskCanvas.markdown.includes('Apex Clearing Corp'), true);
  eq(riskCanvas.markdown.includes('EWMA Drift Trajectory'), true);

  // 2. #reality-core canvas
  const coreCanvas = await canvasSync.generateCanvas('core');
  eq(coreCanvas.channel, 'chan-reality-core');
  eq(coreCanvas.markdown.includes('Grounded Epistemic DAG'), true);
  eq(coreCanvas.markdown.includes('Canonical Reality Ledger State'), true);

  // 3. #finance canvas
  const financeCanvas = await canvasSync.generateCanvas('finance');
  eq(financeCanvas.markdown.includes('Cost-Per-Signal'), true);
  eq(financeCanvas.markdown.includes('Dynamic Budget Gas Gauge'), true);

  // 4. #compliance canvas
  const complianceCanvas = await canvasSync.generateCanvas('legal');
  eq(complianceCanvas.markdown.includes('EU AI Act & Regulatory Registry'), true);
});

// ------------------------------------------------------------------ Feature 3: Canaries
T('Feature 3: Automated Honeytask Canaries award calibrated badge or freeze trust', async () => {
  const { db, coord } = await fresh();
  const canaryEngine = new AutomatedHoneytaskCanary(db, coord);

  // 1. Test passing canary (within SLA)
  const canary1 = await canaryEngine.injectRoomCanary(TEN, 'compliance', { slaSeconds: 60 });
  eq(canary1.scope, 'legal');
  eq(canary1.anomalyType, 'unapproved_model_egress');

  const resolvedPass = await canaryEngine.resolveCanary(TEN, canary1.canaryId, true, {
    detectedBy: 'compliance-agent',
    responseText: 'Refused execution: unapproved model egress violation.',
  });

  eq(resolvedPass.calibrated, true);
  eq(resolvedPass.badge, '🟢 calibrated');

  // Verify room config recorded calibration
  const roomConfig = await loadRoomConfig(db, TEN, 'legal');
  eq(roomConfig.verifiedCalibrated, true);

  // 2. Test missed canary (failure)
  const canary2 = await canaryEngine.injectRoomCanary(TEN, 'finance', { slaSeconds: 60 });
  const resolvedFail = await canaryEngine.resolveCanary(TEN, canary2.canaryId, false);

  eq(resolvedFail.calibrated, false);
  eq(resolvedFail.badge, '🟡 degraded');

  const financeConfig = await loadRoomConfig(db, TEN, 'finance');
  eq(financeConfig.verifiedCalibrated, false);
});

// ------------------------------------------------------------------ Feature 4: Huddles
T('Feature 4: Ambient Morning Voice Briefing synthesizes 60-second WAV audio', async () => {
  const { db } = await fresh();
  const huddle = new AmbientMorningBriefingSynthesizer(db, TEN);

  const briefing = await huddle.synthesizeBriefing({ durationSeconds: 60 });
  eq(briefing.durationSeconds, 60);
  eq(briefing.stats.roomsCovered, 12);
  eq(briefing.transcript.includes('Overnight'), true);
  eq(briefing.transcript.includes('12 rooms'), true);
  eq(Boolean(briefing.audioWavBase64), true);

  // Validate audio buffer structure
  const wav = generateVoiceAudioWav(5); // 5 sec test
  eq(wav.subarray(0, 4).toString(), 'RIFF');
  eq(wav.subarray(8, 12).toString(), 'WAVE');
  eq(wav.subarray(12, 16).toString(), 'fmt ');
  eq(wav.subarray(36, 40).toString(), 'data');

  // Test retrieval
  const latest = await huddle.getLatestBriefing();
  eq(latest?.id, briefing.id);
});

// ------------------------------------------------------------------ Feature 5: Gas Gauges
T('Feature 5: Ambient Budget Gas Gauges and 80% threshold warnings', async () => {
  const { db } = await fresh();
  const tracker = new RoomBudgetTracker(db, TEN);

  // Test progress bar rendering
  eq(renderProgressBar(0, 8), '[□□□□□□□□]');
  eq(renderProgressBar(50, 8), '[■■■■□□□□]');
  eq(renderProgressBar(80, 8), '[■■■■■■□□]');
  eq(renderProgressBar(100, 8), '[■■■■■■■■]');
  eq(formatTokenRate(84000), '84k tokens/hr');

  const gauge = await tracker.computeGauge('risk');
  eq(gauge.scope, 'risk');
  eq(gauge.dollarsCeiling, 1000);
  eq(gauge.headerString.includes('chan-risk-monitor') || gauge.headerString.includes('risk-monitor'), true);

  // Simulate 85% spend
  await db
    .prepare(
      `INSERT INTO requests (id, tenant, message_class, target_scope, origin_scope, goal, state, spent_dollars, spent_tokens, spent_json, bid_json, claim_refs, deliverable, on_behalf_of, hop_chain, chain_claims, idem_key, stop_condition, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'req_spend_test',
      TEN,
      'REQUEST',
      'risk',
      'core',
      'heavy simulation',
      'COMPLETED',
      850,
      4_250_000,
      JSON.stringify({ dollars: 850, tokens: 4_250_000 }),
      JSON.stringify({ dollars: 1000, tokens: 5_000_000, humanMinutes: 0 }),
      '[]',
      'simulation',
      'agent:risk',
      '[]',
      '[]',
      'idem_1',
      'never',
      NOW,
      NOW,
    );

  const warnGauge = await tracker.computeGauge('risk');
  eq(warnGauge.percentage >= 80, true);
  eq(warnGauge.isWarning, true);

  const alertResult = await tracker.checkBudgetAlert('risk', { forceAlert: true });
  eq(alertResult.alerted, true);
  eq(alertResult.message?.includes('Budget at'), true);
  eq(alertResult.message?.includes('Increase ceiling'), true);

  // Operator increases ceiling
  const increased = await tracker.increaseCeiling('risk', 2000);
  eq(increased.budgetCeilingDollars, 2000);

  // Operator switches tier
  const switched = await tracker.switchModelTier('risk', 'haiku');
  eq(switched.modelPolicy.includes('Haiku'), true);
});

// ------------------------------------------------------------------ Feature 6: Time-Travel Forking
T('Feature 6: In-Room Time-Travel Forking clones context into #sandbox and diffs outcomes', async () => {
  const { db, ledger, coord } = await fresh();
  const forkEngine = new TimeTravelForkEngine(db, ledger, coord);

  // Grounding claim for decision
  const groundClaim = await ledger.append({
    tenant: TEN,
    subject: 'counterparty_drift',
    kind: 'OBSERVATION',
    statement: 'Apex Prime counterparty variance exceeded 14% threshold',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'risk-agent',
    scope: 'risk',
    authorType: 'agent',
    provenance: {
      sourceUri: 'sor://bloomberg/feed_9',
      sourceTier: 'PRIMARY',
      extractor: 'buzz-test',
      extractorVersion: '1.0.0',
      retrievedAt: NOW,
    },
  });

  // Record an initial decision
  const dec = await ledger.recordDecision({
    tenant: TEN,
    requestId: 'req_original_hedge',
    goal: 'Hedge counterparty exposure',
    action: 'Apply 50% partial hedge on counterparty drift',
    actionClass: 'RECOMMEND',
    claimIds: [groundClaim.id],
    decidedBy: 'risk-agent',
    scope: 'risk',
    autonomy: 'approval',
  });

  // Fork the decision with Claude 3.5 Sonnet at temp 0.2
  const diff = await forkEngine.forkRun(TEN, { decisionId: dec.id }, { model: 'claude-3-5-sonnet', temperature: 0.2 });

  eq(diff.originalDecisionId, dec.id);
  eq(diff.originalParams.recommendation, 'Apply 50% partial hedge on counterparty drift');
  eq(diff.forkedParams.model, 'claude-3-5-sonnet');
  eq(diff.forkedParams.temperature, 0.2);
  eq(diff.forkedParams.recommendation.includes('100% full hedge'), true);
  eq(diff.sideBySideMarkdown.includes('IN-ROOM TIME-TRAVEL FORK COMPLETED'), true);
  eq(diff.sideBySideMarkdown.includes('#sandbox'), true);
});

// ------------------------------------------------------------------ Phase 6: Setup Wizard
T('Phase 6: Room Selection Onboarding Setup Wizard renders presets and saves config', async () => {
  const { db } = await fresh();

  // 1. Presets exist
  eq(INDUSTRY_PRESETS.length >= 5, true);
  const fintech = INDUSTRY_PRESETS.find((p) => p.id === 'fintech');
  eq(fintech?.scopes.includes('risk'), true);
  eq(fintech?.scopes.includes('finance'), true);

  const customPreset = INDUSTRY_PRESETS.find((p) => p.id === 'custom');
  eq(Boolean(customPreset), true);
  eq(customPreset?.scopes.includes('core'), true);

  // 2. Render wizard page
  const pageHtml = await renderRoomsSetupPage(db, TEN, 'csrf_token_123', 'Rooms deployed successfully');
  eq(pageHtml.includes('Vital Autonomous Room Provisioning & Tuning Wizard'), true);
  eq(pageHtml.includes('#reality-core'), true);
  eq(pageHtml.includes('#risk-monitor'), true);
  eq(pageHtml.includes('csrf_token_123'), true);
  eq(pageHtml.includes('Connected Systems of Record'), true);

  // 3. Handle wizard post with custom mission, autonomy, financial guardrails, and SoR feeds
  await handleRoomsSetupPost(
    db,
    TEN,
    {
      active_risk: '1',
      mission_risk: 'Monitor counterparty credit exposure and flag variance > 10%',
      autonomy_risk: 'guarded',
      budget_risk: '3000',
      tokens_risk: '8000000',
      sor_risk_warehouse: '1',
      sor_risk_bloomberg: '1',
    },
    'operator:admin',
  );

  const customRisk = await loadRoomConfig(db, TEN, 'risk');
  eq(customRisk.mission, 'Monitor counterparty credit exposure and flag variance > 10%');
  eq(customRisk.autonomy, 'guarded');
  eq(customRisk.budgetCeilingDollars, 3000);
  eq(customRisk.budgetCeilingTokens, 8_000_000);
  eq(customRisk.connectedSoRs.includes('warehouse'), true);
  eq(customRisk.connectedSoRs.includes('bloomberg'), true);

  // 4. Verify immutable audit entry in audit_log
  const auditEntry = (await db
    .prepare(
      'SELECT actor, action, target, detail FROM audit_log WHERE tenant = ? AND target = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(TEN, 'room:risk')) as { actor: string; action: string; target: string; detail: string } | undefined;
  eq(Boolean(auditEntry), true);
  eq(auditEntry?.actor, 'operator:admin');
  eq(auditEntry?.action, 'POLICY_MUTATE');
  eq(auditEntry?.detail.includes('Monitor counterparty credit exposure'), true);
});
