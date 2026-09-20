/**
 * Vital Meeting Intelligence — Core Type Definitions.
 *
 * Epistemic rule:
 * A meeting conversation produces OBSERVATIONS and TRANSCRIPT SEGMENTS.
 * An AI synthesis may extract CANDIDATE DECISIONS and ACTION ITEMS,
 * but cannot mint a FACT without system-of-record corroboration.
 */

export type MeetingStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED';

export type ParticipantRole = 'host' | 'participant';

export interface MeetingParticipant {
  id: string;
  tenant: string;
  meetingId: string;
  userId: string;
  displayName: string;
  role: ParticipantRole;
  joinedAt: string;
  leftAt: string | null;
  audioMuted: boolean;
  videoMuted: boolean;
}

export interface MeetingRecording {
  id: string;
  tenant: string;
  meetingId: string;
  storageRef: string;
  format: 'webm' | 'wav' | 'mp4' | 'ogg';
  sizeBytes: number;
  durationSeconds: number;
  sha256: string;
  createdAt: string;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  speakerId: string;
  speakerName: string;
  startTime: number; // seconds from meeting start
  endTime: number; // seconds from meeting start
  text: string;
  confidence: number;
  sequence: number;
  createdAt: string;
}

export interface MeetingActionItem {
  id: string;
  task: string;
  owner: string | null;
  deadline: string | null;
  sourceTimestamp: string;
  segmentId?: string;
  completed?: boolean;
}

export interface MeetingDecision {
  id: string;
  decision: string;
  sourceTimestamp: string;
  segmentId?: string;
  rationale?: string;
}

export interface MeetingNotes {
  id: string;
  tenant: string;
  meetingId: string;
  summary: string;
  topics: string[];
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  openQuestions: string[];
  keyPoints: string[];
  rawNotes?: string;
  createdAt: string;
}

export type MeetingChunkType = 'transcript' | 'summary' | 'decision' | 'action_item' | 'note';

export interface MeetingChunk {
  id: string;
  tenant: string;
  meetingId: string;
  chunkType: MeetingChunkType;
  text: string;
  metadata: {
    speakerIds?: string[];
    speakerNames?: string[];
    startTime?: number;
    endTime?: number;
    sequence?: number;
    itemRef?: string;
  };
  sequence: number;
  createdAt: string;
}

export interface MeetingEmbedding {
  id: string;
  tenant: string;
  meetingId: string;
  chunkId: string;
  vector: number[];
  dimensions: number;
  createdAt: string;
}

export interface MeetingQuestionSource {
  title: string;
  timestamp: string;
  chunkId: string;
  snippet: string;
  speaker?: string;
}

export interface MeetingQuestion {
  id: string;
  tenant: string;
  meetingId: string;
  userId: string;
  question: string;
  answer: string;
  sources: MeetingQuestionSource[];
  createdAt: string;
}

export interface MeetingProcessingStatus {
  recording: 'pending' | 'processing' | 'done' | 'failed' | 'skipped';
  transcript: 'pending' | 'processing' | 'done' | 'failed';
  summary: 'pending' | 'processing' | 'done' | 'failed';
  decisions: 'pending' | 'processing' | 'done' | 'failed';
  actionItems: 'pending' | 'processing' | 'done' | 'failed';
  indexing: 'pending' | 'processing' | 'done' | 'failed';
  error?: string | null;
}

export interface Meeting {
  id: string;
  tenant: string;
  title: string;
  scope: string;
  hostUserId: string;
  hostName: string;
  status: MeetingStatus;
  recordingEnabled: boolean;
  recordingUrl?: string | null;
  durationSeconds: number;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  processingStatus: MeetingProcessingStatus;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------- Providers ----

export interface SttTranscriptionResult {
  segments: Array<{
    speakerId: string;
    speakerName: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence: number;
  }>;
  fullText: string;
}

export interface SttProvider {
  name: string;
  transcribeAudio(audioBytes: Buffer | Uint8Array, mimeType?: string): Promise<SttTranscriptionResult>;
  transcribeLiveChunk?(
    chunk: Buffer | Uint8Array,
    context?: { speakerId: string; speakerName: string; offsetSec: number },
  ): Promise<TranscriptSegment | null>;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface LlmProvider {
  name: string;
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface StorageProvider {
  name: string;
  put(key: string, data: Buffer | Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
