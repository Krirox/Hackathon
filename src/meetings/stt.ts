import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type { SttProvider, SttTranscriptionResult, TranscriptSegment } from './types.ts';
import { insertTranscriptSegment, listTranscriptSegments } from './db.ts';

/**
 * Deterministic Mock STT provider for CI tests and local verification.
 * Does not call external APIs. Accepts predefined transcript scripts or
 * deterministic audio-to-text mapping.
 */
export class MockSttProvider implements SttProvider {
  name = 'mock-stt';

  private scriptQueue: Array<{
    speakerId: string;
    speakerName: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence: number;
  }> = [];

  constructor(
    initialScript: Array<{
      speakerId: string;
      speakerName: string;
      startTime: number;
      endTime: number;
      text: string;
      confidence?: number;
    }> = [],
  ) {
    this.scriptQueue = initialScript.map((s) => ({
      ...s,
      confidence: s.confidence ?? 0.98,
    }));
  }

  setScript(
    script: Array<{
      speakerId: string;
      speakerName: string;
      startTime: number;
      endTime: number;
      text: string;
      confidence?: number;
    }>,
  ): void {
    this.scriptQueue = script.map((s) => ({
      ...s,
      confidence: s.confidence ?? 0.98,
    }));
  }

  addScriptSegment(segment: {
    speakerId: string;
    speakerName: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence?: number;
  }): void {
    this.scriptQueue.push({
      ...segment,
      confidence: segment.confidence ?? 0.98,
    });
  }

  async transcribeAudio(audioBytes: Buffer | Uint8Array, _mimeType = 'audio/webm'): Promise<SttTranscriptionResult> {
    // If a script queue is provided, return that
    if (this.scriptQueue.length > 0) {
      const fullText = this.scriptQueue.map((s) => `${s.speakerName}: ${s.text}`).join('\n');
      return {
        segments: [...this.scriptQueue],
        fullText,
      };
    }

    // Default fallback: parse any readable ASCII in the audioBytes or return default audio snippet
    const rawStr = Buffer.from(audioBytes).toString('utf-8');
    const lines = rawStr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('\0'));

    if (lines.length > 0) {
      const segments = lines.map((text, idx) => ({
        speakerId: `speaker_${(idx % 2) + 1}`,
        speakerName: idx % 2 === 0 ? 'Speaker A' : 'Speaker B',
        startTime: idx * 5,
        endTime: (idx + 1) * 5,
        text,
        confidence: 0.95,
      }));
      return {
        segments,
        fullText: segments.map((s) => `${s.speakerName}: ${s.text}`).join('\n'),
      };
    }

    return {
      segments: [
        {
          speakerId: 'spk_1',
          speakerName: 'Speaker A',
          startTime: 0,
          endTime: 4.5,
          text: 'We launch Friday.',
          confidence: 0.99,
        },
        {
          speakerId: 'spk_2',
          speakerName: 'Speaker B',
          startTime: 5.0,
          endTime: 9.2,
          text: "I'll handle deployment.",
          confidence: 0.98,
        },
      ],
      fullText: "Speaker A: We launch Friday.\nSpeaker B: I'll handle deployment.",
    };
  }

  // A scripted mock reads the queue, not the bytes: the arguments exist because
  // the SttProvider interface is what the live path calls, and a mock that
  // changed the interface would stop proving the caller's contract.
  async transcribeLiveChunk(
    _chunk: Buffer | Uint8Array,
    _context?: { speakerId: string; speakerName: string; offsetSec: number },
  ): Promise<TranscriptSegment | null> {
    if (this.scriptQueue.length > 0) {
      const next = this.scriptQueue.shift()!;
      return {
        id: `seg_${randomUUID().slice(0, 8)}`,
        meetingId: 'live',
        speakerId: next.speakerId,
        speakerName: next.speakerName,
        startTime: next.startTime,
        endTime: next.endTime,
        text: next.text,
        confidence: next.confidence,
        sequence: 0,
        createdAt: new Date().toISOString(),
      };
    }
    return null;
  }
}

/**
 * Production STT Provider using Whisper or compatible OpenAI/Gemini audio API.
 */
export class WhisperSttProvider implements SttProvider {
  name = 'whisper-stt';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly fetchFn = globalThis.fetch,
  ) {}

  async transcribeAudio(audioBytes: Buffer | Uint8Array, mimeType = 'audio/webm'): Promise<SttTranscriptionResult> {
    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: mimeType });
    formData.append('file', blob, 'meeting_audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const res = await this.fetchFn(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`[whisper-stt] HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      text: string;
      segments?: Array<{
        id: number;
        start: number;
        end: number;
        text: string;
      }>;
    };

    const segments = (data.segments ?? []).map((s, idx) => ({
      speakerId: `spk_${(idx % 2) + 1}`,
      speakerName: `Participant ${(idx % 2) + 1}`,
      startTime: s.start,
      endTime: s.end,
      text: s.text.trim(),
      confidence: 0.95,
    }));

    return {
      segments:
        segments.length > 0
          ? segments
          : [
              {
                speakerId: 'spk_1',
                speakerName: 'Speaker',
                startTime: 0,
                endTime: 5,
                text: data.text.trim(),
                confidence: 0.9,
              },
            ],
      fullText: data.text.trim(),
    };
  }
}

/**
 * Live Transcript Collector and Manager.
 */
export class LiveTranscriptManager {
  private sequence = 0;

  /**
   * `sttProvider` has no default on purpose.
   *
   * It used to default to `MockSttProvider`, which meant a production console
   * could hold a test double on the live path and nothing said so — the same
   * class of bug as the pipeline's mock default, one layer down. A manager with
   * no provider is a *configuration* state: appending already-transcribed
   * segments (what the browser does today) works fine, and asking it to
   * transcribe audio refuses instead of inventing a transcript.
   */
  constructor(
    private readonly db: AsyncDb,
    private readonly tenant: string,
    private readonly meetingId: string,
    private readonly sttProvider?: SttProvider,
  ) {}

  /**
   * Append an already transcribed segment into the meeting transcript.
   */
  async appendSegment(segment: {
    speakerId: string;
    speakerName: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence?: number;
  }): Promise<TranscriptSegment> {
    this.sequence += 1;
    const fullSegment: TranscriptSegment = {
      id: `seg_${randomUUID().slice(0, 8)}`,
      meetingId: this.meetingId,
      speakerId: segment.speakerId,
      speakerName: segment.speakerName,
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text.trim(),
      confidence: segment.confidence ?? 0.98,
      sequence: this.sequence,
      createdAt: new Date().toISOString(),
    };

    await insertTranscriptSegment(this.db, this.tenant, fullSegment);
    return fullSegment;
  }

  /**
   * Process an audio chunk directly through STT and append if recognized.
   *
   * Throws when no provider is configured. The alternative — returning null —
   * looked like "nothing was said", which is indistinguishable from a working
   * recognizer sitting in an empty room, and is how a silent misconfiguration
   * survives a demo.
   */
  async processAudioChunk(
    chunk: Buffer | Uint8Array,
    context?: { speakerId: string; speakerName: string; offsetSec: number },
  ): Promise<TranscriptSegment | null> {
    if (!this.sttProvider) {
      throw new Error(
        '[stt:NO_PROVIDER] no speech-to-text provider is configured for this meeting: live audio cannot be transcribed here',
      );
    }
    if (this.sttProvider.transcribeLiveChunk) {
      const seg = await this.sttProvider.transcribeLiveChunk(chunk, context);
      if (seg && seg.text.trim()) {
        return this.appendSegment({
          speakerId: seg.speakerId,
          speakerName: seg.speakerName,
          startTime: seg.startTime,
          endTime: seg.endTime,
          text: seg.text,
          confidence: seg.confidence,
        });
      }
    }
    return null;
  }

  async getTranscript(): Promise<TranscriptSegment[]> {
    return listTranscriptSegments(this.db, this.tenant, this.meetingId);
  }
}
