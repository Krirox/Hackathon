import { randomUUID, createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type {
  Meeting,
  MeetingParticipant,
  MeetingRecording,
  MeetingStatus,
  TranscriptSegment,
  MeetingProcessingStatus,
  StorageProvider,
} from './types.ts';
import {
  insertMeeting,
  getMeetingById,
  listMeetings,
  updateMeetingStatus,
  getMeetingNotes,
  listTranscriptSegments,
  getRecordingByMeetingId,
  insertRecording,
  upsertParticipant,
  updateParticipantLeave,
  listParticipants,
  deleteMeetingCascading,
  defaultProcessingStatus,
} from './db.ts';
import { MeetingProcessingPipeline, type MeetingPipelineOptions } from './pipeline.ts';
import { askMeetingQuestion, type AskMeetingResult } from './rag.ts';
import { LiveTranscriptManager } from './stt.ts';

export interface CreateMeetingInput {
  title: string;
  scope?: string;
  hostUserId: string;
  hostName: string;
  recordingEnabled?: boolean;
  scheduledAt?: string;
}

export class MeetingService {
  private pipeline: MeetingProcessingPipeline;

  constructor(
    private readonly db: AsyncDb,
    private readonly pipelineOptions: MeetingPipelineOptions = {},
    private readonly storage?: StorageProvider,
  ) {
    this.pipeline = new MeetingProcessingPipeline(db, pipelineOptions);
  }

  async createMeeting(tenant: string, input: CreateMeetingInput): Promise<Meeting> {
    const meetingId = `meet_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const meeting: Meeting = {
      id: meetingId,
      tenant,
      title: input.title.trim() || 'Untitled Meeting',
      scope: input.scope ?? 'general',
      hostUserId: input.hostUserId,
      hostName: input.hostName,
      status: 'ACTIVE',
      recordingEnabled: Boolean(input.recordingEnabled),
      recordingUrl: null,
      durationSeconds: 0,
      scheduledAt: input.scheduledAt ?? null,
      startedAt: now,
      endedAt: null,
      processingStatus: defaultProcessingStatus(),
      createdAt: now,
      updatedAt: now,
    };

    await insertMeeting(this.db, meeting);

    // Add host as first participant
    await upsertParticipant(this.db, {
      id: `part_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId: input.hostUserId,
      displayName: input.hostName,
      role: 'host',
      joinedAt: now,
      leftAt: null,
      audioMuted: false,
      videoMuted: false,
    });

    return meeting;
  }

  async getMeeting(tenant: string, meetingId: string): Promise<Meeting | null> {
    return getMeetingById(this.db, tenant, meetingId);
  }

  async listMeetings(
    tenant: string,
    opts: { scope?: string; status?: MeetingStatus; search?: string; limit?: number; offset?: number } = {},
  ): Promise<Meeting[]> {
    return listMeetings(this.db, tenant, opts);
  }

  async joinMeeting(
    tenant: string,
    meetingId: string,
    user: { id: string; name: string; role?: 'host' | 'participant' },
  ): Promise<MeetingParticipant> {
    const meeting = await getMeetingById(this.db, tenant, meetingId);
    if (!meeting) {
      throw new Error(`[meeting-service] Meeting ${meetingId} not found`);
    }

    const participant: MeetingParticipant = {
      id: `part_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId: user.id,
      displayName: user.name,
      role: user.role ?? (user.id === meeting.hostUserId ? 'host' : 'participant'),
      joinedAt: new Date().toISOString(),
      leftAt: null,
      audioMuted: false,
      videoMuted: false,
    };

    await upsertParticipant(this.db, participant);
    return participant;
  }

  async leaveMeeting(tenant: string, meetingId: string, userId: string): Promise<void> {
    await updateParticipantLeave(this.db, tenant, meetingId, userId);
  }

  async endMeeting(tenant: string, meetingId: string, endedByUserId: string): Promise<Meeting> {
    const meeting = await getMeetingById(this.db, tenant, meetingId);
    if (!meeting) {
      throw new Error(`[meeting-service] Meeting ${meetingId} not found`);
    }

    const now = new Date().toISOString();
    let durationSeconds = meeting.durationSeconds;
    if (meeting.startedAt) {
      durationSeconds = Math.max(1, Math.round((Date.parse(now) - Date.parse(meeting.startedAt)) / 1000));
    }

    await updateMeetingStatus(this.db, tenant, meetingId, 'ENDED', {
      endedAt: now,
      durationSeconds,
    });

    const updated = await getMeetingById(this.db, tenant, meetingId);

    // Trigger post-meeting background processing asynchronously without blocking response
    setImmediate(() => {
      this.pipeline.processMeeting(tenant, meetingId).catch((err) => {
        console.error(`[meeting-service] Background processing failed for meeting ${meetingId}:`, err);
      });
    });

    return updated!;
  }

  async saveRecording(
    tenant: string,
    meetingId: string,
    recordingBytes: Buffer | Uint8Array,
    format: 'webm' | 'wav' | 'mp4' = 'webm',
    durationSeconds = 0,
  ): Promise<MeetingRecording> {
    const meeting = await getMeetingById(this.db, tenant, meetingId);
    if (!meeting) {
      throw new Error(`[meeting-service] Meeting ${meetingId} not found`);
    }

    const sha256 = createHash('sha256').update(recordingBytes).digest('hex');
    const storageRef = `recordings/${tenant}/${meetingId}/${sha256}.${format}`;

    // Store in storage provider if present
    if (this.storage) {
      await this.storage.put(storageRef, recordingBytes, `audio/${format}`);
    }

    const rec: MeetingRecording = {
      id: `rec_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      storageRef,
      format,
      sizeBytes: recordingBytes.length,
      durationSeconds: durationSeconds > 0 ? durationSeconds : meeting.durationSeconds,
      sha256,
      createdAt: new Date().toISOString(),
    };

    await insertRecording(this.db, rec);
    await updateMeetingStatus(this.db, tenant, meetingId, meeting.status, {
      recordingUrl: `/api/meetings/${meetingId}/recording`,
    });

    return rec;
  }

  async getMeetingDetails(
    tenant: string,
    meetingId: string,
  ): Promise<{
    meeting: Meeting;
    participants: MeetingParticipant[];
    recording: MeetingRecording | null;
    notes: any;
    transcript: TranscriptSegment[];
  } | null> {
    const meeting = await getMeetingById(this.db, tenant, meetingId);
    if (!meeting) return null;

    const participants = await listParticipants(this.db, tenant, meetingId);
    const recording = await getRecordingByMeetingId(this.db, tenant, meetingId);
    const notes = await getMeetingNotes(this.db, tenant, meetingId);
    const transcript = await listTranscriptSegments(this.db, tenant, meetingId);

    return {
      meeting,
      participants,
      recording,
      notes,
      transcript,
    };
  }

  async askQuestion(tenant: string, meetingId: string, userId: string, question: string): Promise<AskMeetingResult> {
    return askMeetingQuestion(this.db, tenant, meetingId, userId, question, {
      modelProfile: this.pipelineOptions.modelProfile,
      apiKey: this.pipelineOptions.apiKey,
      fetchFn: this.pipelineOptions.fetchFn,
      embeddingProvider: this.pipelineOptions.embeddingProvider,
    });
  }

  async deleteMeeting(tenant: string, meetingId: string): Promise<boolean> {
    const { deleted, recordingRef } = await deleteMeetingCascading(this.db, tenant, meetingId);
    if (deleted && recordingRef && this.storage) {
      await this.storage.delete(recordingRef).catch(() => {});
    }
    return deleted;
  }

  getLiveTranscriptManager(tenant: string, meetingId: string): LiveTranscriptManager {
    return new LiveTranscriptManager(this.db, tenant, meetingId, this.pipelineOptions.sttProvider);
  }

  async triggerProcessing(tenant: string, meetingId: string): Promise<MeetingProcessingStatus> {
    return this.pipeline.processMeeting(tenant, meetingId);
  }
}
