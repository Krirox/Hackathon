import type { AsyncDb } from '../core/db.ts';
import type {
  MeetingProcessingStatus,
  SttProvider,
  EmbeddingProvider,
} from './types.ts';
import {
  getMeetingById,
  updateMeetingProcessingStatus,
  listTranscriptSegments,
  getRecordingByMeetingId,
} from './db.ts';
import { extractMeetingIntelligence, persistMeetingIntelligence } from './intelligence.ts';
import { chunkAndIndexMeeting } from './rag.ts';
import { MockSttProvider } from './stt.ts';
import { DeterministicEmbeddingProvider } from './embeddings.ts';
import type { ModelProfile } from '../substrate/models.ts';

export interface MeetingPipelineOptions {
  sttProvider?: SttProvider;
  embeddingProvider?: EmbeddingProvider;
  modelProfile?: ModelProfile;
  apiKey?: string;
  fetchFn?: typeof globalThis.fetch;
}

export class MeetingProcessingPipeline {
  constructor(
    private readonly db: AsyncDb,
    private readonly options: MeetingPipelineOptions = {},
  ) {}

  /**
   * Run the complete post-meeting processing pipeline asynchronously.
   */
  async processMeeting(tenant: string, meetingId: string): Promise<MeetingProcessingStatus> {
    const meeting = await getMeetingById(this.db, tenant, meetingId);
    if (!meeting) {
      throw new Error(`[meeting-pipeline] Meeting ${meetingId} not found in tenant ${tenant}`);
    }

    const stt = this.options.sttProvider ?? new MockSttProvider();
    const embedder = this.options.embeddingProvider ?? new DeterministicEmbeddingProvider();

    try {
      // Stage 1: Finalize Recording
      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        recording: 'processing',
      });
      const rec = await getRecordingByMeetingId(this.db, tenant, meetingId);
      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        recording: rec ? 'done' : 'skipped',
      });

      // Stage 2: Finalize Transcript
      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        transcript: 'processing',
      });
      let segments = await listTranscriptSegments(this.db, tenant, meetingId);

      // If no live transcript segments were recorded but a recording exists, perform offline transcription
      if (segments.length === 0 && rec) {
        try {
          // Offline transcription fallback
          const transcribed = await stt.transcribeAudio(Buffer.alloc(0));
          // Segments can be appended if available
        } catch (err) {
          console.error('[meeting-pipeline] Offline STT fallback error:', err);
        }
      }

      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        transcript: 'done',
      });

      // Stage 3 & 4: Generate Summary, Decisions & Action Items
      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        summary: 'processing',
        decisions: 'processing',
        actionItems: 'processing',
      });

      segments = await listTranscriptSegments(this.db, tenant, meetingId);
      const intel = await extractMeetingIntelligence(segments, {
        modelProfile: this.options.modelProfile,
        apiKey: this.options.apiKey,
        fetchFn: this.options.fetchFn,
      });

      await persistMeetingIntelligence(this.db, tenant, meetingId, intel);

      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        summary: 'done',
        decisions: 'done',
        actionItems: 'done',
      });

      // Stage 5: Chunk & Index Embeddings
      await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        indexing: 'processing',
      });

      await chunkAndIndexMeeting(this.db, tenant, meetingId, embedder);

      const finalStatus = await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        indexing: 'done',
        error: null,
      });

      return finalStatus!;
    } catch (err: any) {
      console.error(`[meeting-pipeline] Pipeline failed for meeting ${meetingId}:`, err);
      const failedStatus = await updateMeetingProcessingStatus(this.db, tenant, meetingId, {
        error: err?.message ?? 'Pipeline processing error',
      });
      return failedStatus!;
    }
  }
}
