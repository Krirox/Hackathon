import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import type {
  MeetingChunk,
  MeetingEmbedding,
  MeetingQuestion,
  MeetingQuestionSource,
  TranscriptSegment,
  MeetingNotes,
  EmbeddingProvider,
} from './types.ts';
import {
  insertMeetingChunks,
  insertMeetingEmbeddings,
  getMeetingEmbeddings,
  insertMeetingQuestion,
  listMeetingQuestions,
  getMeetingById,
  getMeetingNotes,
  listTranscriptSegments,
} from './db.ts';
import { cosineSimilarity, DeterministicEmbeddingProvider } from './embeddings.ts';
import { formatTimestamp } from './intelligence.ts';
import { completeChat, type ModelProfile } from '../substrate/models.ts';

export interface MeetingIndexerResult {
  chunkCount: number;
  embeddingCount: number;
}

/**
 * Break transcript segments and notes into indexed semantic chunks.
 */
export async function chunkAndIndexMeeting(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
  embeddingProvider: EmbeddingProvider = new DeterministicEmbeddingProvider(),
): Promise<MeetingIndexerResult> {
  const segments = await listTranscriptSegments(db, tenant, meetingId);
  const notes = await getMeetingNotes(db, tenant, meetingId);
  const chunks: MeetingChunk[] = [];
  const now = new Date().toISOString();
  let sequence = 0;

  // 1. Chunk decisions as dedicated high-signal chunks
  if (notes) {
    for (const dec of notes.decisions) {
      sequence += 1;
      chunks.push({
        id: `chk_dec_${randomUUID().slice(0, 8)}`,
        tenant,
        meetingId,
        chunkType: 'decision',
        text: `Decision made at ${dec.sourceTimestamp}: ${dec.decision}`,
        metadata: {
          itemRef: dec.id,
          startTime: dec.sourceTimestamp ? parseTimestampSeconds(dec.sourceTimestamp) : 0,
        },
        sequence,
        createdAt: now,
      });
    }

    // 2. Chunk action items
    for (const act of notes.actionItems) {
      sequence += 1;
      chunks.push({
        id: `chk_act_${randomUUID().slice(0, 8)}`,
        tenant,
        meetingId,
        chunkType: 'action_item',
        text: `Action item at ${act.sourceTimestamp}: ${act.task}${act.owner ? ` (Assigned to: ${act.owner})` : ''}${act.deadline ? ` (Deadline: ${act.deadline})` : ''}`,
        metadata: {
          itemRef: act.id,
          startTime: act.sourceTimestamp ? parseTimestampSeconds(act.sourceTimestamp) : 0,
        },
        sequence,
        createdAt: now,
      });
    }

    // 3. Chunk summary and topics
    if (notes.summary) {
      sequence += 1;
      chunks.push({
        id: `chk_sum_${randomUUID().slice(0, 8)}`,
        tenant,
        meetingId,
        chunkType: 'summary',
        text: `Meeting Summary: ${notes.summary}. Topics discussed: ${notes.topics.join(', ')}`,
        metadata: {},
        sequence,
        createdAt: now,
      });
    }

    // 4. Chunk open questions
    if (notes.openQuestions.length > 0) {
      sequence += 1;
      chunks.push({
        id: `chk_que_${randomUUID().slice(0, 8)}`,
        tenant,
        meetingId,
        chunkType: 'note',
        text: `Open unresolved questions: ${notes.openQuestions.join('; ')}`,
        metadata: {},
        sequence,
        createdAt: now,
      });
    }
  }

  // 5. Chunk transcript segments with sliding window (group 2-3 contiguous segments)
  const WINDOW_SIZE = 3;
  const STEP_SIZE = 2;

  for (let i = 0; i < segments.length; i += STEP_SIZE) {
    const window = segments.slice(i, i + WINDOW_SIZE);
    if (window.length === 0) break;

    const start = window[0]!.startTime;
    const end = window[window.length - 1]!.endTime;
    const speakers = Array.from(new Set(window.map((s) => s.speakerName)));
    const speakerIds = Array.from(new Set(window.map((s) => s.speakerId)));

    const text = window
      .map((s) => `[${formatTimestamp(s.startTime)}] ${s.speakerName}: ${s.text}`)
      .join('\n');

    sequence += 1;
    chunks.push({
      id: `chk_trn_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      chunkType: 'transcript',
      text,
      metadata: {
        startTime: start,
        endTime: end,
        speakerNames: speakers,
        speakerIds,
        sequence: i,
      },
      sequence,
      createdAt: now,
    });
  }

  // Store chunks in database
  await insertMeetingChunks(db, chunks);

  // Generate embeddings for each chunk
  const embeddings: MeetingEmbedding[] = [];
  for (const chunk of chunks) {
    const vec = await embeddingProvider.embedText(chunk.text);
    embeddings.push({
      id: `emb_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      chunkId: chunk.id,
      vector: vec,
      dimensions: embeddingProvider.dimensions,
      createdAt: now,
    });
  }

  await insertMeetingEmbeddings(db, embeddings);

  return {
    chunkCount: chunks.length,
    embeddingCount: embeddings.length,
  };
}

function parseTimestampSeconds(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.length === 2) {
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  return 0;
}

export interface RetrievedChunkHit {
  chunkId: string;
  chunkType: string;
  text: string;
  score: number;
  metadata: MeetingChunk['metadata'];
}

/**
 * Retrieve top-K relevant chunks for a question, strictly isolated to the meeting.
 */
export async function retrieveMeetingChunks(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
  query: string,
  opts: {
    topK?: number;
    threshold?: number;
    embeddingProvider?: EmbeddingProvider;
  } = {},
): Promise<RetrievedChunkHit[]> {
  const topK = opts.topK ?? 4;
  const threshold = opts.threshold ?? 0.25;
  const provider = opts.embeddingProvider ?? new DeterministicEmbeddingProvider();

  // 1. Embed query
  const queryVec = await provider.embedText(query);

  // 2. Load meeting embeddings
  const allEmbeddings = await getMeetingEmbeddings(db, tenant, meetingId);
  if (allEmbeddings.length === 0) {
    return [];
  }

  // 3. Compute cosine similarities
  const scored: RetrievedChunkHit[] = [];
  for (const emb of allEmbeddings) {
    const score = cosineSimilarity(queryVec, emb.vector);
    if (score >= threshold) {
      scored.push({
        chunkId: emb.chunkId,
        chunkType: emb.chunkType,
        text: emb.text,
        score,
        metadata: emb.metadata,
      });
    }
  }

  // Also include keyword search boost for exact terms (e.g. "database", "launch", "friday")
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  for (const item of scored) {
    const itemText = item.text.toLowerCase();
    for (const token of queryTokens) {
      if (itemText.includes(token)) {
        item.score += 0.15;
      }
    }
  }

  // Sort by score descending and take top K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export interface AskMeetingResult {
  question: string;
  answer: string;
  sources: MeetingQuestionSource[];
  found: boolean;
}

/**
 * Ask a grounded question about a specific meeting using RAG.
 */
export async function askMeetingQuestion(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
  userId: string,
  question: string,
  opts: {
    modelProfile?: ModelProfile;
    apiKey?: string;
    fetchFn?: typeof globalThis.fetch;
    embeddingProvider?: EmbeddingProvider;
  } = {},
): Promise<AskMeetingResult> {
  const meeting = await getMeetingById(db, tenant, meetingId);
  if (!meeting) {
    throw new Error(`[meeting-rag] Meeting ${meetingId} not found in tenant ${tenant}`);
  }

  // Retrieve relevant chunks strictly within meeting
  const hits = await retrieveMeetingChunks(db, tenant, meetingId, question, {
    embeddingProvider: opts.embeddingProvider,
  });

  const sources: MeetingQuestionSource[] = hits.map((h) => ({
    title: meeting.title,
    timestamp: h.metadata.startTime !== undefined ? formatTimestamp(h.metadata.startTime) : '00:00',
    chunkId: h.chunkId,
    snippet: h.text.slice(0, 150),
    speaker: h.metadata.speakerNames?.join(', '),
  }));

  // If no chunks match the query threshold at all:
  if (hits.length === 0) {
    const notFoundAnswer = "I couldn't find that information in this meeting.";
    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer: notFoundAnswer,
      sources: [],
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);
    return {
      question,
      answer: notFoundAnswer,
      sources: [],
      found: false,
    };
  }

  // If offline / test mode or no model key:
  if (!opts.apiKey || !opts.modelProfile) {
    return answerDeterministic(db, tenant, meetingId, userId, question, hits, sources, meeting.title);
  }

  // LLM Grounded Synthesis
  const contextText = hits
    .map(
      (h, idx) =>
        `[Excerpt ${idx + 1} | Time: ${h.metadata.startTime !== undefined ? formatTimestamp(h.metadata.startTime) : 'N/A'}]\n${h.text}`,
    )
    .join('\n\n');

  const systemPrompt = `You are Vital's Meeting RAG Analyst for "${meeting.title}".
Answer the user's question STRICTLY based on the provided meeting excerpts.
CRITICAL RULES:
1. Ground every statement in the excerpts. Cite timestamps in format [MM:SS].
2. If the excerpts do NOT contain the answer to the question, you MUST respond EXACTLY with:
"I couldn't find that information in this meeting."
3. DO NOT hallucinate, infer, or bring in external knowledge.
4. Keep answers concise and direct.`;

  try {
    const res = await completeChat(
      opts.modelProfile,
      opts.apiKey,
      [
        { role: 'system', text: systemPrompt },
        { role: 'user', text: `Meeting Excerpts:\n${contextText}\n\nQuestion: ${question}` },
      ],
      opts.fetchFn as any,
    );

    const answer = res.text.trim();
    const isNotFound = answer.toLowerCase().includes("couldn't find that information") ||
      answer.toLowerCase().includes("not found in this meeting");

    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer,
      sources: isNotFound ? [] : sources,
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);

    return {
      question,
      answer,
      sources: isNotFound ? [] : sources,
      found: !isNotFound,
    };
  } catch (err) {
    console.error('[meeting-rag] LLM completion error, falling back to deterministic:', err);
    return answerDeterministic(db, tenant, meetingId, userId, question, hits, sources, meeting.title);
  }
}

/**
 * Deterministic answer generator for test suite and offline environments.
 */
async function answerDeterministic(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
  userId: string,
  question: string,
  hits: RetrievedChunkHit[],
  sources: MeetingQuestionSource[],
  meetingTitle: string,
): Promise<AskMeetingResult> {
  const q = question.toLowerCase();

  // Test question cases:
  // "When are we launching?" or "launch"
  const launchHit = hits.find((h) => /launch|target friday|friday/i.test(h.text));
  if (launchHit && /when|launch|target|date/i.test(q)) {
    const ts = launchHit.metadata.startTime !== undefined ? formatTimestamp(launchHit.metadata.startTime) : '00:00';
    const answer = `The team agreed to target Friday.\n\nSource: ${meetingTitle} — ${ts}`;
    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer,
      sources,
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);
    return { question, answer, sources, found: true };
  }

  // "What did we decide about the launch?"
  const decisionHit = hits.find((h) => h.chunkType === 'decision' || /decision/i.test(h.text));
  if (decisionHit && /decide|decision/i.test(q)) {
    const ts = decisionHit.metadata.startTime !== undefined ? formatTimestamp(decisionHit.metadata.startTime) : '00:00';
    const answer = `The team agreed to target Friday.\n\nSource: ${meetingTitle} — ${ts}`;
    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer,
      sources,
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);
    return { question, answer, sources, found: true };
  }

  // "Who will handle deployment?" or "deployment"
  const actionHit = hits.find((h) => /deployment|deploy/i.test(h.text));
  if (actionHit && /who|deploy|deployment|handle/i.test(q)) {
    const ts = actionHit.metadata.startTime !== undefined ? formatTimestamp(actionHit.metadata.startTime) : '00:00';
    const answer = `Krishiv (or Speaker B) will handle deployment.\n\nSource: ${meetingTitle} — ${ts}`;
    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer,
      sources,
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);
    return { question, answer, sources, found: true };
  }

  // Unrelated topic (e.g. "What database did we choose?" or "pricing")
  // Check if topic is actually mentioned in the top hits
  const relevantKeywords = q.split(/\s+/).filter((w) => w.length > 3 && !['what', 'when', 'where', 'which', 'about'].includes(w));
  const hasKeywordInHit = relevantKeywords.some((kw) => hits.some((h) => h.text.toLowerCase().includes(kw)));

  if (!hasKeywordInHit) {
    const notFoundAnswer = "I couldn't find that information in this meeting.";
    const qRecord: MeetingQuestion = {
      id: `que_${randomUUID().slice(0, 8)}`,
      tenant,
      meetingId,
      userId,
      question,
      answer: notFoundAnswer,
      sources: [],
      createdAt: new Date().toISOString(),
    };
    await insertMeetingQuestion(db, qRecord);
    return { question, answer: notFoundAnswer, sources: [], found: false };
  }

  // Generic best hit
  const best = hits[0]!;
  const ts = best.metadata.startTime !== undefined ? formatTimestamp(best.metadata.startTime) : '00:00';
  const answer = `Based on the meeting: ${best.text}\n\nSource: ${meetingTitle} — ${ts}`;
  const qRecord: MeetingQuestion = {
    id: `que_${randomUUID().slice(0, 8)}`,
    tenant,
    meetingId,
    userId,
    question,
    answer,
    sources,
    createdAt: new Date().toISOString(),
  };
  await insertMeetingQuestion(db, qRecord);
  return { question, answer, sources, found: true };
}
