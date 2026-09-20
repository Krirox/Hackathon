import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/core/db.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { MeetingService } from '../src/meetings/service.ts';
import type { SignalingMessage } from '../src/meetings/signaling.ts';

const TEN = 'acme';
const NOW = new Date().toISOString();

async function runLiveVideoCallTest() {
  console.log('\n======================================================');
  console.log(' Starting Live WebRTC Video Call Integration Test');
  console.log('======================================================\n');

  // 1. Initialize DB and Seed Tenant
  console.log('[Step 1] Initializing database and auth schema...');
  const db = openDb(':memory:');
  await migrate(db);
  await installAuthSchema(db, NOW);
  const { owner } = await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme Corp',
      email: 'owner@acme.test',
      password: 'the-console-password',
      ownerName: 'Krishiv',
    },
    NOW,
  );
  console.log('  ✔ Tenant and owner account provisioned.');

  // 2. Start Console Server with Meeting Routes and Signaling Hub
  console.log('[Step 2] Starting Console Server with RFC 6455 WebSocket Upgrade...');
  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  const comp = new OrganizationalCompiler(db);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    host: '127.0.0.1',
    port: 0, // ephemeral port
  });
  const port = server.port;
  console.log(`  ✔ Console Server listening on http://127.0.0.1:${port}`);

  // 3. Authenticate as Owner
  console.log('[Step 3] Logging in over HTTP to obtain session cookie & CSRF...');
  const base_ = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
  const preCsrf = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${base_}/login`, {
    method: 'POST',
    headers: { cookie: preCsrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${preToken}&email=${encodeURIComponent('owner@acme.test')}&password=${encodeURIComponent('the-console-password')}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const home = await (await fetch(`${base_}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = home.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  const authHeaders = { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' };
  console.log('  ✔ Authenticated successfully.');

  // 4. Create Video Call Meeting
  console.log('[Step 4] Creating video call room via API...');
  const createRes = await fetch(`${base_}/api/meetings`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Quarterly Architecture & Launch Sync',
      scope: 'engineering',
      recordingEnabled: true,
    }),
  });
  assert.ok(createRes.status === 200 || createRes.status === 201);
  const { meeting } = (await createRes.json()) as any;
  const meetingId = meeting.id;
  console.log(`  ✔ Meeting created: "${meeting.title}" (ID: ${meetingId})`);

  // Verify meeting room UI page renders
  const roomPageRes = await fetch(`${base_}/console/meetings/${meetingId}/room`, {
    headers: { cookie },
  });
  assert.equal(roomPageRes.status, 200);
  const roomHtml = await roomPageRes.text();
  assert.ok(roomHtml.includes('video-grid'));
  assert.ok(roomHtml.includes('RTCPeerConnection'));
  console.log('  ✔ Live Meeting Room HTML and WebRTC Client verified.');

  // 5. Connect Peer 1 (Host: Krishiv) via Native WebSocket
  console.log('[Step 5] Connecting Peer 1 (Host: Krishiv) to WebSocket Signaling...');
  const peer1Msgs: SignalingMessage[] = [];
  const ws1Url = `ws://127.0.0.1:${port}/api/meetings/signal?meetingId=${meetingId}&tenant=${TEN}&userId=usr_krishiv&name=Krishiv&role=host`;
  const ws1 = new WebSocket(ws1Url);

  await new Promise<void>((resolve, reject) => {
    ws1.onopen = () => resolve();
    ws1.onerror = (e) => reject(e);
  });
  ws1.onmessage = (event) => {
    const msg = JSON.parse(event.data.toString()) as SignalingMessage;
    peer1Msgs.push(msg);
  };

  // Wait for initial 'joined' message
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(peer1Msgs.length >= 1, 'Peer 1 should have received joined message');
  const p1JoinMsg = peer1Msgs[0]!;
  assert.equal(p1JoinMsg.type, 'joined');
  const peer1Id = p1JoinMsg.payload.peerId;
  console.log(`  ✔ Peer 1 connected (PeerID: ${peer1Id}). Room size: 1`);

  // 6. Connect Peer 2 (Participant: Siddharth) via Native WebSocket
  console.log('[Step 6] Connecting Peer 2 (Participant: Siddharth) to WebSocket Signaling...');
  const peer2Msgs: SignalingMessage[] = [];
  const ws2Url = `ws://127.0.0.1:${port}/api/meetings/signal?meetingId=${meetingId}&tenant=${TEN}&userId=usr_sid&name=Siddharth&role=participant`;
  const ws2 = new WebSocket(ws2Url);

  await new Promise<void>((resolve, reject) => {
    ws2.onopen = () => resolve();
    ws2.onerror = (e) => reject(e);
  });
  ws2.onmessage = (event) => {
    const msg = JSON.parse(event.data.toString()) as SignalingMessage;
    peer2Msgs.push(msg);
  };

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(peer2Msgs.length >= 1, 'Peer 2 should have received joined message');
  const p2JoinMsg = peer2Msgs[0]!;
  assert.equal(p2JoinMsg.type, 'joined');
  const peer2Id = p2JoinMsg.payload.peerId;
  assert.equal(p2JoinMsg.payload.existingPeers.length, 1);
  assert.equal(p2JoinMsg.payload.existingPeers[0].userId, 'usr_krishiv');
  console.log(`  ✔ Peer 2 connected (PeerID: ${peer2Id}). Found existing peer Krishiv.`);

  // Verify Peer 1 received 'peer-joined' notification for Peer 2
  const p1Notification = peer1Msgs.find((m) => m.type === 'peer-joined');
  assert.ok(p1Notification, 'Peer 1 must receive peer-joined event');
  assert.equal(p1Notification?.payload.userId, 'usr_sid');
  console.log('  ✔ Peer 1 received "peer-joined" event for Siddharth.');

  // 7. WebRTC Offer / Answer SDP Exchange
  console.log('[Step 7] Exchanging WebRTC SDP Offer and Answer...');
  const fakeSdpOffer = 'v=0\r\no=- 424242 2 IN IP4 127.0.0.1\r\ns=LiveVideoCall\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
  ws1.send(
    JSON.stringify({
      type: 'offer',
      meetingId,
      targetId: peer2Id,
      payload: { sdp: fakeSdpOffer },
    }),
  );

  await new Promise((r) => setTimeout(r, 100));
  const p2Offer = peer2Msgs.find((m) => m.type === 'offer');
  assert.ok(p2Offer, 'Peer 2 must receive the SDP offer from Peer 1');
  assert.equal(p2Offer?.payload.sdp, fakeSdpOffer);
  console.log('  ✔ Peer 2 received SDP Offer from Peer 1.');

  const fakeSdpAnswer =
    'v=0\r\no=- 424243 2 IN IP4 127.0.0.1\r\ns=LiveVideoCallAnswer\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
  ws2.send(
    JSON.stringify({
      type: 'answer',
      meetingId,
      targetId: peer1Id,
      payload: { sdp: fakeSdpAnswer },
    }),
  );

  await new Promise((r) => setTimeout(r, 100));
  const p1Answer = peer1Msgs.find((m) => m.type === 'answer');
  assert.ok(p1Answer, 'Peer 1 must receive the SDP answer from Peer 2');
  assert.equal(p1Answer?.payload.sdp, fakeSdpAnswer);
  console.log('  ✔ Peer 1 received SDP Answer from Peer 2.');

  // 8. ICE Candidate Exchange & Media State Updates
  console.log('[Step 8] Exchanging ICE candidates and media mute states...');
  const fakeCandidate = {
    candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
  ws1.send(
    JSON.stringify({
      type: 'ice-candidate',
      meetingId,
      targetId: peer2Id,
      payload: fakeCandidate,
    }),
  );

  await new Promise((r) => setTimeout(r, 100));
  const p2Candidate = peer2Msgs.find((m) => m.type === 'ice-candidate');
  assert.ok(p2Candidate, 'Peer 2 must receive ICE candidate');
  assert.deepEqual(p2Candidate?.payload, fakeCandidate);
  console.log('  ✔ ICE candidate exchanged successfully.');

  // Mute camera toggle
  ws2.send(
    JSON.stringify({
      type: 'media-state',
      meetingId,
      payload: { audioMuted: false, videoMuted: true },
    }),
  );
  await new Promise((r) => setTimeout(r, 100));
  const p1Mute = peer1Msgs.find((m) => m.type === 'media-state');
  assert.ok(p1Mute, 'Peer 1 must receive media state update');
  assert.equal(p1Mute?.payload.videoMuted, true);
  console.log('  ✔ Media mute status propagated across peers.');

  // 9. Live Transcription Ingestion
  console.log('[Step 9] Streaming spoken conversation audio & transcript segments...');
  const segments = [
    { speakerId: 'usr_krishiv', speakerName: 'Krishiv', startTime: 0, endTime: 4, text: 'We launch Friday.' },
    {
      speakerId: 'usr_sid',
      speakerName: 'Siddharth',
      startTime: 5,
      endTime: 9,
      text: 'Krishiv will handle deployment by Friday 2pm.',
    },
    {
      speakerId: 'usr_krishiv',
      speakerName: 'Krishiv',
      startTime: 10,
      endTime: 14,
      text: 'We still need to decide the production domain.',
    },
  ];

  for (const seg of segments) {
    const res = await fetch(`${base_}/api/meetings/${meetingId}/transcript`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(seg),
    });
    assert.ok(res.status === 200 || res.status === 201);
  }
  console.log(`  ✔ Ingested ${segments.length} real-time transcript segments.`);

  // 10. Upload Audio/Video Recording
  console.log('[Step 10] Uploading audio/video recording blob...');
  const fakeAudioBlob = Buffer.from('RIFF_REAL_WEBRTC_MEDIA_STREAM_CAPTURE_BYTES_TEST');
  const uploadRes = await fetch(`${base_}/api/meetings/${meetingId}/recording?durationSeconds=14`, {
    method: 'POST',
    headers: {
      cookie,
      'x-vital-csrf': csrf,
      'content-type': 'audio/webm',
    },
    body: fakeAudioBlob,
  });
  assert.ok(uploadRes.status === 200 || uploadRes.status === 201);
  const uploadJson = (await uploadRes.json()) as any;
  const rec = uploadJson.recording ?? uploadJson;
  assert.ok(rec.sha256);
  assert.equal(rec.sizeBytes, fakeAudioBlob.length);
  console.log(`  ✔ Recording saved (SHA-256: ${rec.sha256.slice(0, 16)}..., Size: ${rec.sizeBytes} bytes).`);

  // 11. End Meeting
  console.log('[Step 11] Ending video call...');
  const endRes = await fetch(`${base_}/api/meetings/${meetingId}/end`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(endRes.status, 200);
  console.log('  ✔ Meeting ended successfully.');

  // Close WebSockets cleanly
  ws1.close();
  ws2.close();

  // 12. Trigger Post-Meeting Pipeline (Intelligence + Grounded RAG Indexing)
  console.log('[Step 12] Triggering post-meeting AI synthesis and vector indexing...');
  const pipeRes = await fetch(`${base_}/api/meetings/${meetingId}/process`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(pipeRes.status, 200);
  const pipeJson = (await pipeRes.json()) as any;
  assert.equal(pipeJson.status.recording, 'done');
  assert.equal(pipeJson.status.transcript, 'done');
  assert.equal(pipeJson.status.summary, 'done');
  assert.equal(pipeJson.status.indexing, 'done');
  console.log('  ✔ Background processing pipeline completed successfully.');

  // 13. Verify Synthesized Notes in Post-Meeting View
  console.log('[Step 13] Verifying Post-Meeting Detail View & Extracted Intelligence...');
  const detailRes = await fetch(`${base_}/console/meetings/${meetingId}`, {
    headers: { cookie },
  });
  assert.equal(detailRes.status, 200);
  const detailHtml = await detailRes.text();
  assert.ok(detailHtml.includes('Launch Friday'), 'Post-meeting view must show decision');
  assert.ok(detailHtml.includes('deployment'), 'Post-meeting view must show action item');
  assert.ok(detailHtml.includes('production domain'), 'Post-meeting view must show unresolved question');
  console.log('  ✔ Post-meeting view rendered executive summary, decisions, and action items.');

  // 14. Test Grounded RAG Q&A
  console.log('[Step 14] Testing Grounded RAG Question Answering on Video Call Knowledge...');
  // Q1: Grounded question
  const ask1Res = await fetch(`${base_}/api/meetings/${meetingId}/ask`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ question: 'When are we launching?' }),
  });
  assert.equal(ask1Res.status, 200);
  const ask1Json = (await ask1Res.json()) as any;
  assert.equal(ask1Json.found, true);
  assert.ok(ask1Json.answer.toLowerCase().includes('friday'), `Expected Friday, got: ${ask1Json.answer}`);
  assert.ok(ask1Json.sources.length > 0, 'Must provide source citations');
  console.log(`  ✔ Grounded Q: "When are we launching?"`);
  console.log(`    Answer: "${ask1Json.answer.split('\n')[0]}"`);
  console.log(`    Source: ${ask1Json.sources[0].title} [${ask1Json.sources[0].timestamp}]`);

  // Q2: Ungrounded question
  const ask2Res = await fetch(`${base_}/api/meetings/${meetingId}/ask`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ question: 'What database did we choose?' }),
  });
  assert.equal(ask2Res.status, 200);
  const ask2Json = (await ask2Res.json()) as any;
  assert.equal(ask2Json.found, false);
  assert.equal(ask2Json.answer, "I couldn't find that information in this meeting.");
  assert.equal(ask2Json.sources.length, 0);
  console.log(`  ✔ Ungrounded Q: "What database did we choose?"`);
  console.log(`    Refusal: "${ask2Json.answer}" (0 hallucinations)`);

  // Clean up server
  await server.close();
  await db.close();

  console.log('\n======================================================');
  console.log(' ALL 14 VIDEO CALL INTEGRATION STEPS PASSED (100%)');
  console.log('======================================================\n');
}

runLiveVideoCallTest().catch((err) => {
  console.error('\n❌ Video call test failed:', err);
  process.exit(1);
});
