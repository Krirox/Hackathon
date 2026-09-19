import { openDb } from '../src/core/db.ts';
import { generateSilentWav } from '../src/meetings/service.ts';
import {
  insertMeeting,
  upsertParticipant,
  insertRecording,
  insertTranscriptSegment,
  upsertMeetingNotes,
  deleteMeetingCascading,
} from '../src/meetings/db.ts';
import { chunkAndIndexMeeting } from '../src/meetings/rag.ts';
import type { MeetingNotes } from '../src/meetings/types.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

async function seed() {
  const db = openDb('var/dev.db');
  const tenant = 'acme';

  console.log('[1/5] Cleaning up old fake meetings...');
  const allMeetings = await db.prepare('SELECT id, title FROM meetings WHERE tenant = ?').all(tenant) as { id: string; title: string }[];
  for (const m of allMeetings) {
    if (m.id !== 'meet_93b3e4b8') {
      console.log(`  Deleting fake meeting: ${m.id} (${m.title})`);
      await deleteMeetingCascading(db, tenant, m.id);
    }
  }

  const meetingId = 'meet_93b3e4b8';
  const meetingTitle = 'E2E Model Testing 1';
  console.log(`[2/5] Setting up single past meeting "${meetingTitle}" (${meetingId})...`);

  const now = new Date().toISOString();
  const startedAt = '2026-09-19T16:47:59.866Z';
  const endedAt = '2026-09-19T16:52:29.866Z';
  const durationSeconds = 270;

  const existing = await db.prepare('SELECT id FROM meetings WHERE tenant = ? AND id = ?').get(tenant, meetingId);
  if (existing) {
    await db.prepare(`
      UPDATE meetings SET
        title = ?,
        status = 'ENDED',
        scope = 'product',
        started_at = ?,
        ended_at = ?,
        duration_seconds = ?,
        recording_enabled = 1,
        recording_url = ?,
        processing_status_json = ?,
        updated_at = ?
      WHERE tenant = ? AND id = ?
    `).run(
      meetingTitle,
      startedAt,
      endedAt,
      durationSeconds,
      `/api/meetings/${meetingId}/recording`,
      JSON.stringify({
        recording: 'done',
        transcript: 'done',
        summary: 'done',
        decisions: 'done',
        actionItems: 'done',
        indexing: 'done',
        error: null,
      }),
      now,
      tenant,
      meetingId,
    );
  } else {
    await insertMeeting(db, {
      id: meetingId,
      tenant,
      title: meetingTitle,
      scope: 'product',
      hostUserId: 'usr_owner',
      hostName: 'Krishiv',
      status: 'ENDED',
      recordingEnabled: true,
      recordingUrl: `/api/meetings/${meetingId}/recording`,
      durationSeconds,
      scheduledAt: null,
      startedAt,
      endedAt,
      processingStatus: {
        recording: 'done',
        transcript: 'done',
        summary: 'done',
        decisions: 'done',
        actionItems: 'done',
        indexing: 'done',
        error: null,
      },
      createdAt: startedAt,
      updatedAt: endedAt,
    });
  }

  // Participants
  console.log('[3/5] Seeding participants...');
  await db.prepare('DELETE FROM meeting_participants WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
  const participants = [
    { id: 'part_krishiv', userId: 'usr_owner', name: 'Krishiv', role: 'host' as const },
    { id: 'part_alice', userId: 'usr_alice', name: 'Alice Chen', role: 'participant' as const },
    { id: 'part_bob', userId: 'usr_bob', name: 'Bob Martinez', role: 'participant' as const },
  ];
  for (const p of participants) {
    await upsertParticipant(db, {
      id: p.id,
      tenant,
      meetingId,
      userId: p.userId,
      displayName: p.name,
      role: p.role,
      joinedAt: startedAt,
      leftAt: endedAt,
      audioMuted: false,
      videoMuted: false,
    });
  }

  // Audio Recording
  console.log('[4/5] Generating and saving audio recording file...');
  await db.prepare('DELETE FROM meeting_recordings WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
  const audioBytes = generateSilentWav(10);
  const sha256 = createHash('sha256').update(audioBytes).digest('hex');
  const storageRef = `recordings/${tenant}/${meetingId}/${sha256}.wav`;
  const diskPath = join(process.cwd(), 'var', 'storage', storageRef);
  await mkdir(join(process.cwd(), 'var', 'storage', 'recordings', tenant, meetingId), { recursive: true });
  await writeFile(diskPath, audioBytes);

  await insertRecording(db, {
    id: `rec_${randomUUID().slice(0, 8)}`,
    tenant,
    meetingId,
    storageRef,
    format: 'wav',
    sizeBytes: audioBytes.length,
    durationSeconds,
    sha256,
    createdAt: startedAt,
  });

  // Transcripts
  console.log('[5/5] Seeding transcripts, notes, and RAG knowledge...');
  await db.prepare('DELETE FROM meeting_transcript_segments WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
  const transcriptSegments = [
    {
      speakerId: 'usr_owner',
      speakerName: 'Krishiv',
      startTime: 5,
      endTime: 35,
      text: 'Welcome everyone to the E2E Model Testing session. Today we are validating our WebRTC meeting intelligence pipeline, live audio capture, deterministic and Whisper transcription, and grounded RAG knowledge synthesis.',
    },
    {
      speakerId: 'usr_alice',
      speakerName: 'Alice Chen',
      startTime: 36,
      endTime: 72,
      text: 'Thanks Krishiv. I tested the multi-peer signaling hub. All 14 mesh steps passed with zero dropped packets. The peer-to-peer WebSockets maintain under 15ms latency across all peer legs.',
    },
    {
      speakerId: 'usr_bob',
      speakerName: 'Bob Martinez',
      startTime: 73,
      endTime: 110,
      text: 'On the storage side, we have verified that recordings are checksummed with SHA-256 and stored with bi-temporal reality ledger anchors. Once the host ends the call, pipeline orchestration triggers automatic transcription and embedding indexing.',
    },
    {
      speakerId: 'usr_owner',
      speakerName: 'Krishiv',
      startTime: 111,
      endTime: 145,
      text: 'Let us formalize our decisions. Decision one: We will use the RFC 6455 native WebSocket upgrade without external runtime dependencies to keep the binary lightweight and secure.',
    },
    {
      speakerId: 'usr_alice',
      speakerName: 'Alice Chen',
      startTime: 146,
      endTime: 180,
      text: 'Agreed. Decision two: All meeting decisions will be written as cryptographic claims to the Vital Reality Ledger with verified participant signatures.',
    },
    {
      speakerId: 'usr_bob',
      speakerName: 'Bob Martinez',
      startTime: 181,
      endTime: 220,
      text: 'For action items, I will finalize the automated vector embedding retention policy by Wednesday. Alice, can you review the WebRTC screen share canvas downscaling for mobile clients by Friday?',
    },
    {
      speakerId: 'usr_alice',
      speakerName: 'Alice Chen',
      startTime: 221,
      endTime: 245,
      text: 'Yes, I will have the screen share optimizations reviewed and merged by Friday afternoon.',
    },
    {
      speakerId: 'usr_owner',
      speakerName: 'Krishiv',
      startTime: 246,
      endTime: 270,
      text: 'Excellent. We will also monitor indexing latency for large transcripts. Meeting adjourned!',
    },
  ];

  for (let i = 0; i < transcriptSegments.length; i++) {
    const s = transcriptSegments[i]!;
    await insertTranscriptSegment(db, tenant, {
      id: `seg_${randomUUID().slice(0, 8)}`,
      meetingId,
      speakerId: s.speakerId,
      speakerName: s.speakerName,
      startTime: s.startTime,
      endTime: s.endTime,
      text: s.text,
      confidence: 0.98,
      sequence: i + 1,
      createdAt: new Date(Date.parse(startedAt) + s.startTime * 1000).toISOString(),
    });
  }

  // Meeting Notes
  const notes: MeetingNotes = {
    id: `notes_${randomUUID().slice(0, 8)}`,
    tenant,
    meetingId,
    summary:
      'Comprehensive E2E validation of the Vital Meeting Intelligence system. The team verified WebRTC multi-party signaling mesh, RFC 6455 native WebSocket handler, real-time transcription, and reality ledger claim anchoring. All key architectural decisions were approved, and follow-up tasks were assigned for vector retention policies and mobile screen share optimizations.',
    topics: [
      'WebRTC Mesh Verification',
      'RFC 6455 WebSocket Upgrade',
      'Live STT & Transcription',
      'Reality Ledger Decision Anchoring',
      'Grounded RAG Semantic Retrieval',
    ],
    decisions: [
      {
        id: `dec_${randomUUID().slice(0, 8)}`,
        decision: 'Adopt native RFC 6455 WebSocket upgrade without external dependencies for zero-overhead signaling.',
        sourceTimestamp: '01:51',
      },
      {
        id: `dec_${randomUUID().slice(0, 8)}`,
        decision: 'Anchor all synthesized meeting decisions directly into the Vital Reality Ledger.',
        sourceTimestamp: '02:26',
      },
    ],
    actionItems: [
      {
        id: `act_${randomUUID().slice(0, 8)}`,
        task: 'Finalize automated vector embedding retention policy',
        owner: 'Bob Martinez',
        deadline: 'Wednesday',
        sourceTimestamp: '03:01',
        completed: false,
      },
      {
        id: `act_${randomUUID().slice(0, 8)}`,
        task: 'Review WebRTC screen share canvas downscaling for mobile viewports',
        owner: 'Alice Chen',
        deadline: 'Friday',
        sourceTimestamp: '03:41',
        completed: false,
      },
    ],
    openQuestions: [
      'What is the optimal chunk overlap percentage for long-duration transcripts exceeding 2 hours?',
    ],
    keyPoints: [
      'Multi-peer signaling mesh verified with 14/14 automated test steps',
      'RFC 6455 native upgrade handler maintains zero-overhead peer connectivity',
      'Reality ledger integration securely anchors decisions as verifiable claims',
    ],
    createdAt: endedAt,
  };
  await upsertMeetingNotes(db, notes);

  // RAG Indexing via chunkAndIndexMeeting
  await db.prepare('DELETE FROM meeting_embeddings WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
  await db.prepare('DELETE FROM meeting_chunks WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);

  const indexResult = await chunkAndIndexMeeting(db, tenant, meetingId);
  console.log(`  Indexed ${indexResult.chunkCount} chunks into vector knowledge base.`);

  console.log('✔ Successfully seeded single past meeting "E2E Model Testing 1" with full intelligence, recording, transcript, decisions, and RAG chunks!');
}

seed().catch(console.error);
