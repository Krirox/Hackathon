import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { T, eq, fresh, TEN } from './helpers.ts';
import { MeetingService } from '../src/meetings/service.ts';
import { MeetingSignalingHub, type SignalingPeer, type SignalingMessage } from '../src/meetings/signaling.ts';
import { MockSttProvider } from '../src/meetings/stt.ts';
import { DeterministicEmbeddingProvider, cosineSimilarity } from '../src/meetings/embeddings.ts';
import { extractIntelligenceDeterministic } from '../src/meetings/intelligence.ts';
import { chunkAndIndexMeeting, askMeetingQuestion } from '../src/meetings/rag.ts';
import {
  getMeetingById,
  listMeetings,
  listParticipants,
  listTranscriptSegments,
  getMeetingNotes,
  getRecordingByMeetingId,
  listMeetingChunks,
  getMeetingEmbeddings,
  listMeetingQuestions,
} from '../src/meetings/db.ts';
import type { TranscriptSegment } from '../src/meetings/types.ts';

// ------------------------------------------------------------- 1. Meeting Lifecycle ----

T('meeting lifecycle: create, join, leave, participant states, and end', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  // 1. Create meeting
  const meeting = await service.createMeeting(TEN, {
    title: 'Sprint Planning',
    scope: 'engineering',
    hostUserId: 'usr_alice',
    hostName: 'Alice',
    recordingEnabled: true,
  });

  assert.ok(meeting.id.startsWith('meet_'));
  eq(meeting.title, 'Sprint Planning');
  eq(meeting.scope, 'engineering');
  eq(meeting.status, 'ACTIVE');
  eq(meeting.recordingEnabled, true);

  // Host should be automatically registered as first participant
  const initialParts = await listParticipants(db, TEN, meeting.id);
  eq(initialParts.length, 1);
  eq(initialParts[0]!.userId, 'usr_alice');
  eq(initialParts[0]!.role, 'host');

  // 2. Second user joins
  const bob = await service.joinMeeting(TEN, meeting.id, {
    id: 'usr_bob',
    name: 'Bob',
    role: 'participant',
  });
  eq(bob.userId, 'usr_bob');
  eq(bob.role, 'participant');

  const activeParts = await listParticipants(db, TEN, meeting.id);
  eq(activeParts.length, 2);

  // 3. Bob leaves
  await service.leaveMeeting(TEN, meeting.id, 'usr_bob');
  const afterLeaveParts = await listParticipants(db, TEN, meeting.id);
  const bobRow = afterLeaveParts.find((p) => p.userId === 'usr_bob');
  assert.ok(bobRow?.leftAt !== null);

  // 4. Host ends meeting
  const ended = await service.endMeeting(TEN, meeting.id, 'usr_alice');
  eq(ended.status, 'ENDED');
  assert.ok(ended.endedAt !== null);
  assert.ok(ended.durationSeconds >= 0);
});

// ------------------------------------------------------------- 2. WebRTC Signaling ----

T('webrtc signaling: room joins, peer discovery, and SDP message routing', async () => {
  const { db } = await fresh();
  const hub = new MeetingSignalingHub(db);
  const meetingId = 'meet_signal_test';

  const aliceMsgs: SignalingMessage[] = [];
  const bobMsgs: SignalingMessage[] = [];

  const alice: SignalingPeer = {
    id: 'peer_alice_1',
    userId: 'usr_alice',
    displayName: 'Alice',
    meetingId,
    tenant: TEN,
    role: 'host',
    audioMuted: false,
    videoMuted: false,
    screenSharing: false,
    send: (msg) => aliceMsgs.push(msg),
    close: () => {},
    lastSeenAt: Date.now(),
  };

  const bob: SignalingPeer = {
    id: 'peer_bob_2',
    userId: 'usr_bob',
    displayName: 'Bob',
    meetingId,
    tenant: TEN,
    role: 'participant',
    audioMuted: false,
    videoMuted: false,
    screenSharing: false,
    send: (msg) => bobMsgs.push(msg),
    close: () => {},
    lastSeenAt: Date.now(),
  };

  // Alice joins first
  await hub.handlePeerJoin(alice);
  eq(aliceMsgs.length, 1);
  eq(aliceMsgs[0]!.type, 'joined');
  eq(aliceMsgs[0]!.payload.existingPeers.length, 0);

  // Bob joins second
  await hub.handlePeerJoin(bob);
  // Bob gets 'joined' message listing Alice as existing peer
  eq(bobMsgs.length, 1);
  eq(bobMsgs[0]!.type, 'joined');
  eq(bobMsgs[0]!.payload.existingPeers.length, 1);
  eq(bobMsgs[0]!.payload.existingPeers[0].userId, 'usr_alice');

  // Alice gets 'peer-joined' notification for Bob
  eq(aliceMsgs.length, 2);
  eq(aliceMsgs[1]!.type, 'peer-joined');
  eq(aliceMsgs[1]!.payload.userId, 'usr_bob');

  // SDP Offer from Bob to Alice
  hub.handleMessage('peer_bob_2', {
    type: 'offer',
    meetingId,
    targetId: 'peer_alice_1',
    payload: { sdp: 'v=0\r\no=bob 1234...' },
  });

  eq(aliceMsgs.length, 3);
  eq(aliceMsgs[2]!.type, 'offer');
  eq(aliceMsgs[2]!.senderId, 'peer_bob_2');
  eq(aliceMsgs[2]!.payload.sdp, 'v=0\r\no=bob 1234...');

  // SDP Answer from Alice to Bob
  hub.handleMessage('peer_alice_1', {
    type: 'answer',
    meetingId,
    targetId: 'peer_bob_2',
    payload: { sdp: 'v=0\r\no=alice 5678...' },
  });

  eq(bobMsgs.length, 2);
  eq(bobMsgs[1]!.type, 'answer');
  eq(bobMsgs[1]!.senderId, 'peer_alice_1');

  // Media state broadcast
  hub.handleMessage('peer_alice_1', {
    type: 'media-state',
    meetingId,
    payload: { audioMuted: true, videoMuted: false },
  });

  eq(bobMsgs.length, 3);
  eq(bobMsgs[2]!.type, 'media-state');
  eq(bobMsgs[2]!.payload.audioMuted, true);

  // Bob disconnects / leaves
  await hub.handlePeerLeave(meetingId, 'peer_bob_2');
  eq(aliceMsgs.length, 4);
  eq(aliceMsgs[3]!.type, 'peer-left');
  eq(aliceMsgs[3]!.payload.userId, 'usr_bob');
  eq(hub.getRoomCount(meetingId), 1);
});

// ------------------------------------------------------------- 3. Recording Persistence ----

T('meeting recording: saves audio bytes, associates meeting, and verifies sha256 checksum', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  const meeting = await service.createMeeting(TEN, {
    title: 'Architecture Review',
    hostUserId: 'usr_arch',
    hostName: 'Architect',
    recordingEnabled: true,
  });

  const fakeAudio = Buffer.from('RIFF_FAKE_AUDIO_DATA_FOR_TESTING_1234567890');
  const expectedHash = createHash('sha256').update(fakeAudio).digest('hex');

  const rec = await service.saveRecording(TEN, meeting.id, fakeAudio, 'webm', 120);

  eq(rec.meetingId, meeting.id);
  eq(rec.format, 'webm');
  eq(rec.sizeBytes, fakeAudio.length);
  eq(rec.durationSeconds, 120);
  eq(rec.sha256, expectedHash);

  // Retrieve from DB
  const fetched = await getRecordingByMeetingId(db, TEN, meeting.id);
  assert.ok(fetched !== null);
  eq(fetched?.sha256, expectedHash);
  eq(fetched?.sizeBytes, fakeAudio.length);

  // Meeting row should reflect recordingUrl
  const updatedMeeting = await getMeetingById(db, TEN, meeting.id);
  eq(updatedMeeting?.recordingUrl, `/api/meetings/${meeting.id}/recording`);
});

// ------------------------------------------------------------- 4. Transcription Ordering ----

T('transcription: deterministic segments preserving speaker names, timestamps, and order', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  const meeting = await service.createMeeting(TEN, {
    title: 'Launch Sync',
    hostUserId: 'usr_1',
    hostName: 'Speaker A',
  });

  const transcriptMgr = service.getLiveTranscriptManager(TEN, meeting.id);

  // Speaker A -> "We launch Friday."
  const seg1 = await transcriptMgr.appendSegment({
    speakerId: 'spk_1',
    speakerName: 'Speaker A',
    startTime: 0,
    endTime: 3.5,
    text: 'We launch Friday.',
    confidence: 0.99,
  });

  // Speaker B -> "I'll handle deployment."
  const seg2 = await transcriptMgr.appendSegment({
    speakerId: 'spk_2',
    speakerName: 'Speaker B',
    startTime: 4.0,
    endTime: 7.2,
    text: "I'll handle deployment.",
    confidence: 0.97,
  });

  eq(seg1.sequence, 1);
  eq(seg2.sequence, 2);

  const segments = await transcriptMgr.getTranscript();
  eq(segments.length, 2);
  eq(segments[0]!.speakerName, 'Speaker A');
  eq(segments[0]!.text, 'We launch Friday.');
  eq(segments[1]!.speakerName, 'Speaker B');
  eq(segments[1]!.text, "I'll handle deployment.");
});

// ------------------------------------------------------------- 5. AI Meeting Intelligence ----

T('ai meeting intelligence: extracts decisions, actions, and open questions without hallucination', async () => {
  const segments: TranscriptSegment[] = [
    {
      id: 'seg_1',
      meetingId: 'meet_test',
      speakerId: 'spk_1',
      speakerName: 'Speaker A',
      startTime: 0,
      endTime: 3,
      text: 'We launch Friday.',
      confidence: 0.99,
      sequence: 1,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'seg_2',
      meetingId: 'meet_test',
      speakerId: 'spk_2',
      speakerName: 'Speaker B',
      startTime: 4,
      endTime: 8,
      text: 'Krishiv will handle deployment.',
      confidence: 0.98,
      sequence: 2,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'seg_3',
      meetingId: 'meet_test',
      speakerId: 'spk_1',
      speakerName: 'Speaker A',
      startTime: 9,
      endTime: 14,
      text: 'We still need to decide the production domain.',
      confidence: 0.95,
      sequence: 3,
      createdAt: new Date().toISOString(),
    },
  ];

  const intel = extractIntelligenceDeterministic(segments);

  // Decision verification
  eq(intel.decisions.length, 1);
  assert.ok(intel.decisions[0]!.decision.toLowerCase().includes('launch friday'));
  eq(intel.decisions[0]!.sourceTimestamp, '00:00');

  // Action item verification
  eq(intel.actionItems.length, 1);
  eq(intel.actionItems[0]!.owner, 'Krishiv');
  assert.ok(intel.actionItems[0]!.task.toLowerCase().includes('deployment'));
  eq(intel.actionItems[0]!.deadline, null); // Invariant: do not invent unstated deadlines

  // Open question verification
  eq(intel.openQuestions.length, 1);
  assert.ok(intel.openQuestions[0]!.toLowerCase().includes('production domain'));
});

// ------------------------------------------------------------- 6. Grounded RAG Q&A ----

T('rag: answers grounded questions with citations and refuses ungrounded questions without hallucinating', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  const meeting = await service.createMeeting(TEN, {
    title: 'Weekly Product Sync',
    hostUserId: 'usr_1',
    hostName: 'Krishiv',
  });

  const transcriptMgr = service.getLiveTranscriptManager(TEN, meeting.id);
  await transcriptMgr.appendSegment({
    speakerId: 'spk_1',
    speakerName: 'Krishiv',
    startTime: 10,
    endTime: 15,
    text: "Let's target Friday for the production release.",
    confidence: 0.99,
  });
  await transcriptMgr.appendSegment({
    speakerId: 'spk_2',
    speakerName: 'Siddharth',
    startTime: 16,
    endTime: 22,
    text: "Agreed. Krishiv will handle deployment by Friday 2pm.",
    confidence: 0.98,
  });

  // Run indexer
  await service.triggerProcessing(TEN, meeting.id);

  // Test 1: Grounded Question
  const q1 = await service.askQuestion(TEN, meeting.id, 'usr_guest', 'When are we launching?');
  assert.ok(q1.found);
  assert.ok(q1.answer.toLowerCase().includes('friday'));
  assert.ok(q1.sources.length > 0);
  eq(q1.sources[0]!.title, 'Weekly Product Sync');

  // Test 2: Ungrounded Question (never mentioned in meeting)
  const q2 = await service.askQuestion(TEN, meeting.id, 'usr_guest', 'What database did we choose?');
  eq(q2.found, false);
  eq(q2.answer, "I couldn't find that information in this meeting.");
  eq(q2.sources.length, 0);
});

// ------------------------------------------------------------- 7. Meeting Isolation ----

T('meeting isolation: answers are strictly isolated between Meeting A and Meeting B', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  // Meeting A: Launch is Friday
  const meetingA = await service.createMeeting(TEN, {
    title: 'Meeting A',
    hostUserId: 'usr_1',
    hostName: 'Lead A',
  });
  const trA = service.getLiveTranscriptManager(TEN, meetingA.id);
  await trA.appendSegment({
    speakerId: 'spk_1',
    speakerName: 'Lead A',
    startTime: 0,
    endTime: 5,
    text: 'We launch Friday.',
  });
  await service.triggerProcessing(TEN, meetingA.id);

  // Meeting B: Launch is Monday
  const meetingB = await service.createMeeting(TEN, {
    title: 'Meeting B',
    hostUserId: 'usr_2',
    hostName: 'Lead B',
  });
  const trB = service.getLiveTranscriptManager(TEN, meetingB.id);
  await trB.appendSegment({
    speakerId: 'spk_2',
    speakerName: 'Lead B',
    startTime: 0,
    endTime: 5,
    text: 'We target Monday for our launch date.',
  });
  await service.triggerProcessing(TEN, meetingB.id);

  // Query Meeting A
  const ansA = await service.askQuestion(TEN, meetingA.id, 'usr_1', 'When are we launching?');
  assert.ok(ansA.answer.toLowerCase().includes('friday'), `Expected Friday in Meeting A, got ${ansA.answer}`);
  assert.ok(!ansA.answer.toLowerCase().includes('monday'), 'Meeting A must not leak Monday');

  // Query Meeting B
  const ansB = await service.askQuestion(TEN, meetingB.id, 'usr_2', 'When are we launching?');
  assert.ok(ansB.answer.toLowerCase().includes('monday'), `Expected Monday in Meeting B, got ${ansB.answer}`);
  assert.ok(!ansB.answer.toLowerCase().includes('friday'), 'Meeting B must not leak Friday');
});

// ------------------------------------------------------------- 8. Security & Authorization ----

T('security: tenant isolation blocks cross-tenant meeting queries', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  const meetingTenant1 = await service.createMeeting('tenant_alpha', {
    title: 'Confidential Executive Sync',
    hostUserId: 'usr_alpha',
    hostName: 'Alpha CEO',
  });

  // Querying from tenant_beta should return null / not found
  const crossTenantGet = await service.getMeeting('tenant_beta', meetingTenant1.id);
  eq(crossTenantGet, null);

  const crossTenantList = await service.listMeetings('tenant_beta');
  eq(crossTenantList.length, 0);

  // RAG query from tenant_beta must reject
  await assert.rejects(
    async () => {
      await service.askQuestion('tenant_beta', meetingTenant1.id, 'usr_beta', 'What was discussed?');
    },
    /not found/,
  );
});

// ------------------------------------------------------------- 9. Cascading Deletion ----

T('deletion: removes meeting, recording, transcript, chunks, notes, embeddings, and questions', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  const meeting = await service.createMeeting(TEN, {
    title: 'Temporary Meeting',
    hostUserId: 'usr_del',
    hostName: 'Deleter',
  });

  const tr = service.getLiveTranscriptManager(TEN, meeting.id);
  await tr.appendSegment({
    speakerId: 'spk_1',
    speakerName: 'Deleter',
    startTime: 0,
    endTime: 4,
    text: 'This will be deleted.',
  });

  await service.saveRecording(TEN, meeting.id, Buffer.from('temporary_audio'), 'webm', 4);
  await service.triggerProcessing(TEN, meeting.id);
  await service.askQuestion(TEN, meeting.id, 'usr_del', 'When?');

  // Verify rows exist before deletion
  const chunksBefore = await listMeetingChunks(db, TEN, meeting.id);
  assert.ok(chunksBefore.length > 0);
  const embeddingsBefore = await getMeetingEmbeddings(db, TEN, meeting.id);
  assert.ok(embeddingsBefore.length > 0);

  // Delete meeting
  const deleted = await service.deleteMeeting(TEN, meeting.id);
  eq(deleted, true);

  // Verify all rows cascade-deleted
  eq(await getMeetingById(db, TEN, meeting.id), null);
  eq((await listTranscriptSegments(db, TEN, meeting.id)).length, 0);
  eq((await listMeetingChunks(db, TEN, meeting.id)).length, 0);
  eq((await getMeetingEmbeddings(db, TEN, meeting.id)).length, 0);
  eq(await getMeetingNotes(db, TEN, meeting.id), null);
  eq(await getRecordingByMeetingId(db, TEN, meeting.id), null);
  eq((await listMeetingQuestions(db, TEN, meeting.id)).length, 0);
  eq((await listParticipants(db, TEN, meeting.id)).length, 0);
});

// ------------------------------------------------------------- 10. End-to-End Meeting Pipeline ----

T('end-to-end: create -> join -> audio/transcript -> record -> end -> notes -> rag', async () => {
  const { db } = await fresh();
  const service = new MeetingService(db);

  // 1. Create meeting
  const meeting = await service.createMeeting(TEN, {
    title: 'Weekly Release Deliberation',
    scope: 'engineering',
    hostUserId: 'usr_krishiv',
    hostName: 'Krishiv',
    recordingEnabled: true,
  });

  // 2. Participant joins
  await service.joinMeeting(TEN, meeting.id, {
    id: 'usr_sid',
    name: 'Siddharth',
  });

  // 3. Spoken conversation transcribed in real time
  const tr = service.getLiveTranscriptManager(TEN, meeting.id);
  await tr.appendSegment({
    speakerId: 'usr_krishiv',
    speakerName: 'Krishiv',
    startTime: 0,
    endTime: 4,
    text: "Let's review the release. We launch Friday.",
  });
  await tr.appendSegment({
    speakerId: 'usr_sid',
    speakerName: 'Siddharth',
    startTime: 5,
    endTime: 9,
    text: "Krishiv will handle deployment by Friday 2pm.",
  });
  await tr.appendSegment({
    speakerId: 'usr_krishiv',
    speakerName: 'Krishiv',
    startTime: 10,
    endTime: 14,
    text: 'We still need to decide the production domain.',
  });

  // 4. Save recording
  const fakeWav = Buffer.from('RIFF_REAL_TEST_RECORDING_BYTES');
  await service.saveRecording(TEN, meeting.id, fakeWav, 'webm', 14);

  // 5. End meeting
  const ended = await service.endMeeting(TEN, meeting.id, 'usr_krishiv');
  eq(ended.status, 'ENDED');

  // 6. Run background pipeline to completion
  const status = await service.triggerProcessing(TEN, meeting.id);
  eq(status.recording, 'done');
  eq(status.transcript, 'done');
  eq(status.summary, 'done');
  eq(status.indexing, 'done');

  // 7. Verify Notes and Intelligence in DB
  const notes = await getMeetingNotes(db, TEN, meeting.id);
  assert.ok(notes !== null);
  assert.ok(notes.decisions.some((d) => d.decision.toLowerCase().includes('launch friday')));
  assert.ok(notes.actionItems.some((a) => a.owner === 'Krishiv' && a.task.toLowerCase().includes('deployment')));
  assert.ok(notes.openQuestions.some((q) => q.toLowerCase().includes('production domain')));

  // 8. RAG Question and Answer
  const ragResult = await service.askQuestion(TEN, meeting.id, 'usr_team', 'What did we decide about the launch?');
  assert.ok(ragResult.found);
  assert.ok(ragResult.answer.toLowerCase().includes('friday'));
  assert.ok(ragResult.sources.length > 0);
  eq(ragResult.sources[0]!.title, 'Weekly Release Deliberation');

  // 9. Unrelated question cleanly refused
  const ragNotFound = await service.askQuestion(TEN, meeting.id, 'usr_team', 'What did we budget for marketing?');
  eq(ragNotFound.found, false);
  eq(ragNotFound.answer, "I couldn't find that information in this meeting.");
});
