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
// No mock provider import: the pipeline deliberately has no STT default (see
// the note at the top of transcribeAndProcess), so nothing here may name one.
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

    // There is deliberately no provider default. The default used to be
    // `MockSttProvider`, whose canned script ("We launch Friday. / I'll handle
    // deployment.") was transcribed from *zero bytes* of audio and then stored as
    // the record of a real meeting, feeding the intelligence extractor and the
    // RAG index as if authoritative. A missing provider is a configuration
    // failure to report, not a transcript to invent.
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

      // There is a recording and no transcript. Offline transcription is not
      // implemented: the pipeline holds no storage provider, so it cannot reach
      // the audio, and the previous version called `transcribeAudio` with an
      // empty buffer under a mock provider — then marked the stage `done` and
      // carried on to extract decisions from whatever came back.
      //
      // A meeting with audio and no live captions therefore fails loudly. The
      // approved path to a transcript is live caption segments (the browser's
      // speech recognition posts them), which is why this only fires when
      // nothing was captured.
      if (segments.length === 0 && rec) {
        throw new Error(
          '[meeting-pipeline] recording present but no transcript segments: offline transcription is not implemented. Processing refused rather than fabricating a transcript.',
        );
      }

      // No recording at all: an empty transcript is the truth (a notes-only
      // meeting), and the stages below will honestly find no decisions. There is
      // no `skipped` in the status vocabulary, and `done` is accurate here — the
      // dishonest case was the recording above, which now refuses.
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
