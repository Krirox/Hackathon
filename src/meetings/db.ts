import type { AsyncDb, Row } from '../core/db.ts';
import type {
  Meeting,
  MeetingParticipant,
  MeetingRecording,
  TranscriptSegment,
  MeetingNotes,
  MeetingChunk,
  MeetingEmbedding,
  MeetingQuestion,
  MeetingStatus,
  MeetingProcessingStatus,
} from './types.ts';

export const MEETING_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    title TEXT NOT NULL,
    scope TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    host_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    recording_enabled INTEGER NOT NULL DEFAULT 0,
    recording_url TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    scheduled_at TEXT,
    started_at TEXT,
    ended_at TEXT,
    processing_status_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meetings_tenant_status ON meetings(tenant, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_meetings_tenant_scope ON meetings(tenant, scope)`,

  `CREATE TABLE IF NOT EXISTS meeting_participants (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    audio_muted INTEGER NOT NULL DEFAULT 0,
    video_muted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tenant, meeting_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_participants_meeting ON meeting_participants(tenant, meeting_id)`,

  `CREATE TABLE IF NOT EXISTS meeting_recordings (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    storage_ref TEXT NOT NULL,
    format TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant, meeting_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_recordings_meeting ON meeting_recordings(tenant, meeting_id)`,

  `CREATE TABLE IF NOT EXISTS meeting_transcript_segments (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    speaker_name TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_transcript_meeting_seq ON meeting_transcript_segments(tenant, meeting_id, sequence ASC)`,

  `CREATE TABLE IF NOT EXISTS meeting_chunks (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_chunks_meeting ON meeting_chunks(tenant, meeting_id, sequence ASC)`,

  `CREATE TABLE IF NOT EXISTS meeting_notes (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    topics_json TEXT NOT NULL,
    decisions_json TEXT NOT NULL,
    action_items_json TEXT NOT NULL,
    open_questions_json TEXT NOT NULL,
    key_points_json TEXT NOT NULL,
    raw_notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (tenant, meeting_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_notes_meeting ON meeting_notes(tenant, meeting_id)`,

  `CREATE TABLE IF NOT EXISTS meeting_embeddings (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant, chunk_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_embeddings_meeting ON meeting_embeddings(tenant, meeting_id)`,

  `CREATE TABLE IF NOT EXISTS meeting_questions (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_meeting_questions_meeting ON meeting_questions(tenant, meeting_id, created_at DESC)`,
];

export async function ensureMeetingTables(db: AsyncDb): Promise<void> {
  for (const sql of MEETING_TABLES_SQL) {
    await db.exec(sql);
  }
}

// ------------------------------------------------------------- Meeting Repository ----

export function defaultProcessingStatus(): MeetingProcessingStatus {
  return {
    recording: 'pending',
    transcript: 'pending',
    summary: 'pending',
    decisions: 'pending',
    actionItems: 'pending',
    indexing: 'pending',
    error: null,
  };
}

export function parseMeetingRow(r: Row): Meeting {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    title: String(r.title),
    scope: String(r.scope),
    hostUserId: String(r.host_user_id),
    hostName: String(r.host_name),
    status: String(r.status) as MeetingStatus,
    recordingEnabled: Boolean(r.recording_enabled),
    recordingUrl: r.recording_url ? String(r.recording_url) : null,
    durationSeconds: Number(r.duration_seconds ?? 0),
    scheduledAt: r.scheduled_at ? String(r.scheduled_at) : null,
    startedAt: r.started_at ? String(r.started_at) : null,
    endedAt: r.ended_at ? String(r.ended_at) : null,
    processingStatus: r.processing_status_json
      ? (JSON.parse(String(r.processing_status_json)) as MeetingProcessingStatus)
      : defaultProcessingStatus(),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function insertMeeting(db: AsyncDb, meeting: Meeting): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meetings (
        id, tenant, title, scope, host_user_id, host_name, status,
        recording_enabled, recording_url, duration_seconds, scheduled_at,
        started_at, ended_at, processing_status_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meeting.id,
      meeting.tenant,
      meeting.title,
      meeting.scope,
      meeting.hostUserId,
      meeting.hostName,
      meeting.status,
      meeting.recordingEnabled ? 1 : 0,
      meeting.recordingUrl ?? null,
      meeting.durationSeconds,
      meeting.scheduledAt ?? null,
      meeting.startedAt ?? null,
      meeting.endedAt ?? null,
      JSON.stringify(meeting.processingStatus),
      meeting.createdAt,
      meeting.updatedAt,
    );
}

export async function getMeetingById(db: AsyncDb, tenant: string, id: string): Promise<Meeting | null> {
  const row = await db.prepare('SELECT * FROM meetings WHERE tenant = ? AND id = ?').get(tenant, id);
  if (!row) return null;
  return parseMeetingRow(row);
}

export async function listMeetings(
  db: AsyncDb,
  tenant: string,
  opts: {
    scope?: string;
    status?: MeetingStatus;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Meeting[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let query = 'SELECT * FROM meetings WHERE tenant = ?';
  const params: unknown[] = [tenant];

  if (opts.scope) {
    query += ' AND scope = ?';
    params.push(opts.scope);
  }
  if (opts.status) {
    query += ' AND status = ?';
    params.push(opts.status);
  }
  if (opts.search && opts.search.trim()) {
    query += ' AND (title LIKE ? OR host_name LIKE ?)';
    const term = `%${opts.search.trim()}%`;
    params.push(term, term);
  }

  query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const rows = await db.prepare(query).all(...params);
  return rows.map(parseMeetingRow);
}

export async function updateMeetingStatus(
  db: AsyncDb,
  tenant: string,
  id: string,
  status: MeetingStatus,
  extra: Partial<{
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
    processingStatus: MeetingProcessingStatus;
    recordingUrl: string | null;
  }> = {},
): Promise<void> {
  const meeting = await getMeetingById(db, tenant, id);
  if (!meeting) return;

  const startedAt = extra.startedAt !== undefined ? extra.startedAt : meeting.startedAt;
  const endedAt = extra.endedAt !== undefined ? extra.endedAt : meeting.endedAt;
  const durationSeconds = extra.durationSeconds !== undefined ? extra.durationSeconds : meeting.durationSeconds;
  const processingStatus = extra.processingStatus ?? meeting.processingStatus;
  const recordingUrl = extra.recordingUrl !== undefined ? extra.recordingUrl : meeting.recordingUrl;
  const updatedAt = new Date().toISOString();

  await db
    .prepare(
      `UPDATE meetings SET
        status = ?, started_at = ?, ended_at = ?, duration_seconds = ?,
        processing_status_json = ?, recording_url = ?, updated_at = ?
      WHERE tenant = ? AND id = ?`,
    )
    .run(
      status,
      startedAt,
      endedAt,
      durationSeconds,
      JSON.stringify(processingStatus),
      recordingUrl,
      updatedAt,
      tenant,
      id,
    );
}

export async function updateMeetingProcessingStatus(
  db: AsyncDb,
  tenant: string,
  id: string,
  patch: Partial<MeetingProcessingStatus>,
): Promise<MeetingProcessingStatus | null> {
  const meeting = await getMeetingById(db, tenant, id);
  if (!meeting) return null;

  const updated: MeetingProcessingStatus = {
    ...meeting.processingStatus,
    ...patch,
  };

  await db
    .prepare('UPDATE meetings SET processing_status_json = ?, updated_at = ? WHERE tenant = ? AND id = ?')
    .run(JSON.stringify(updated), new Date().toISOString(), tenant, id);

  return updated;
}

// ------------------------------------------------------------- Participants ----

export async function upsertParticipant(db: AsyncDb, participant: MeetingParticipant): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_participants (
        id, tenant, meeting_id, user_id, display_name, role, joined_at, left_at, audio_muted, video_muted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, meeting_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        role = excluded.role,
        audio_muted = excluded.audio_muted,
        video_muted = excluded.video_muted,
        left_at = excluded.left_at`,
    )
    .run(
      participant.id,
      participant.tenant,
      participant.meetingId,
      participant.userId,
      participant.displayName,
      participant.role,
      participant.joinedAt,
      participant.leftAt,
      participant.audioMuted ? 1 : 0,
      participant.videoMuted ? 1 : 0,
    );
}

export async function updateParticipantLeave(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
  userId: string,
  leftAt: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare('UPDATE meeting_participants SET left_at = ? WHERE tenant = ? AND meeting_id = ? AND user_id = ?')
    .run(leftAt, tenant, meetingId, userId);
}

export async function listParticipants(db: AsyncDb, tenant: string, meetingId: string): Promise<MeetingParticipant[]> {
  const rows = await db
    .prepare('SELECT * FROM meeting_participants WHERE tenant = ? AND meeting_id = ? ORDER BY joined_at ASC')
    .all(tenant, meetingId);

  return rows.map((r) => ({
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    userId: String(r.user_id),
    displayName: String(r.display_name),
    role: String(r.role) as MeetingParticipant['role'],
    joinedAt: String(r.joined_at),
    leftAt: r.left_at ? String(r.left_at) : null,
    audioMuted: Boolean(r.audio_muted),
    videoMuted: Boolean(r.video_muted),
  }));
}

// ------------------------------------------------------------- Recordings ----

export async function insertRecording(db: AsyncDb, recording: MeetingRecording): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_recordings (
        id, tenant, meeting_id, storage_ref, format, size_bytes, duration_seconds, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, meeting_id) DO UPDATE SET
        storage_ref = excluded.storage_ref,
        format = excluded.format,
        size_bytes = excluded.size_bytes,
        duration_seconds = excluded.duration_seconds,
        sha256 = excluded.sha256`,
    )
    .run(
      recording.id,
      recording.tenant,
      recording.meetingId,
      recording.storageRef,
      recording.format,
      recording.sizeBytes,
      recording.durationSeconds,
      recording.sha256,
      recording.createdAt,
    );
}

export async function getRecordingByMeetingId(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
): Promise<MeetingRecording | null> {
  const r = await db
    .prepare('SELECT * FROM meeting_recordings WHERE tenant = ? AND meeting_id = ?')
    .get(tenant, meetingId);
  if (!r) return null;
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    storageRef: String(r.storage_ref),
    format: String(r.format) as MeetingRecording['format'],
    sizeBytes: Number(r.size_bytes),
    durationSeconds: Number(r.duration_seconds),
    sha256: String(r.sha256),
    createdAt: String(r.created_at),
  };
}

// ------------------------------------------------------------- Transcripts ----

export async function insertTranscriptSegment(db: AsyncDb, tenant: string, segment: TranscriptSegment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_transcript_segments (
        id, tenant, meeting_id, speaker_id, speaker_name, start_time, end_time, text, confidence, sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      segment.id,
      tenant,
      segment.meetingId,
      segment.speakerId,
      segment.speakerName,
      segment.startTime,
      segment.endTime,
      segment.text,
      segment.confidence,
      segment.sequence,
      segment.createdAt,
    );
}

export async function listTranscriptSegments(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
): Promise<TranscriptSegment[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM meeting_transcript_segments WHERE tenant = ? AND meeting_id = ? ORDER BY sequence ASC, start_time ASC',
    )
    .all(tenant, meetingId);

  return rows.map((r) => ({
    id: String(r.id),
    meetingId: String(r.meeting_id),
    speakerId: String(r.speaker_id),
    speakerName: String(r.speaker_name),
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    text: String(r.text),
    confidence: Number(r.confidence),
    sequence: Number(r.sequence),
    createdAt: String(r.created_at),
  }));
}

// ------------------------------------------------------------- Notes & Intelligence ----

export async function upsertMeetingNotes(db: AsyncDb, notes: MeetingNotes): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_notes (
        id, tenant, meeting_id, summary, topics_json, decisions_json,
        action_items_json, open_questions_json, key_points_json, raw_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, meeting_id) DO UPDATE SET
        summary = excluded.summary,
        topics_json = excluded.topics_json,
        decisions_json = excluded.decisions_json,
        action_items_json = excluded.action_items_json,
        open_questions_json = excluded.open_questions_json,
        key_points_json = excluded.key_points_json,
        raw_notes = excluded.raw_notes`,
    )
    .run(
      notes.id,
      notes.tenant,
      notes.meetingId,
      notes.summary,
      JSON.stringify(notes.topics),
      JSON.stringify(notes.decisions),
      JSON.stringify(notes.actionItems),
      JSON.stringify(notes.openQuestions),
      JSON.stringify(notes.keyPoints),
      notes.rawNotes ?? null,
      notes.createdAt,
    );
}

export async function getMeetingNotes(db: AsyncDb, tenant: string, meetingId: string): Promise<MeetingNotes | null> {
  const r = await db.prepare('SELECT * FROM meeting_notes WHERE tenant = ? AND meeting_id = ?').get(tenant, meetingId);
  if (!r) return null;
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    summary: String(r.summary),
    topics: JSON.parse(String(r.topics_json)),
    decisions: JSON.parse(String(r.decisions_json)),
    actionItems: JSON.parse(String(r.action_items_json)),
    openQuestions: JSON.parse(String(r.open_questions_json)),
    keyPoints: JSON.parse(String(r.key_points_json)),
    rawNotes: r.raw_notes ? String(r.raw_notes) : undefined,
    createdAt: String(r.created_at),
  };
}

// ------------------------------------------------------------- Chunks & Embeddings ----

export async function insertMeetingChunks(db: AsyncDb, chunks: MeetingChunk[]): Promise<void> {
  for (const c of chunks) {
    await db
      .prepare(
        `INSERT INTO meeting_chunks (
          id, tenant, meeting_id, chunk_type, text, metadata_json, sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.tenant, c.meetingId, c.chunkType, c.text, JSON.stringify(c.metadata), c.sequence, c.createdAt);
  }
}

export async function listMeetingChunks(db: AsyncDb, tenant: string, meetingId: string): Promise<MeetingChunk[]> {
  const rows = await db
    .prepare('SELECT * FROM meeting_chunks WHERE tenant = ? AND meeting_id = ? ORDER BY sequence ASC')
    .all(tenant, meetingId);

  return rows.map((r) => ({
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    chunkType: String(r.chunk_type) as MeetingChunk['chunkType'],
    text: String(r.text),
    metadata: JSON.parse(String(r.metadata_json)),
    sequence: Number(r.sequence),
    createdAt: String(r.created_at),
  }));
}

export async function insertMeetingEmbeddings(db: AsyncDb, embeddings: MeetingEmbedding[]): Promise<void> {
  for (const e of embeddings) {
    await db
      .prepare(
        `INSERT INTO meeting_embeddings (
          id, tenant, meeting_id, chunk_id, vector_json, dimensions, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant, chunk_id) DO UPDATE SET
          vector_json = excluded.vector_json,
          dimensions = excluded.dimensions`,
      )
      .run(e.id, e.tenant, e.meetingId, e.chunkId, JSON.stringify(e.vector), e.dimensions, e.createdAt);
  }
}

export async function getMeetingEmbeddings(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
): Promise<Array<MeetingEmbedding & { text: string; chunkType: string; metadata: MeetingChunk['metadata'] }>> {
  const rows = await db
    .prepare(
      `SELECT e.id, e.tenant, e.meeting_id, e.chunk_id, e.vector_json, e.dimensions, e.created_at,
              c.text, c.chunk_type, c.metadata_json
       FROM meeting_embeddings e
       JOIN meeting_chunks c ON e.chunk_id = c.id AND e.tenant = c.tenant
       WHERE e.tenant = ? AND e.meeting_id = ?`,
    )
    .all(tenant, meetingId);

  return rows.map((r) => ({
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    chunkId: String(r.chunk_id),
    vector: JSON.parse(String(r.vector_json)) as number[],
    dimensions: Number(r.dimensions),
    createdAt: String(r.created_at),
    text: String(r.text),
    chunkType: String(r.chunk_type),
    metadata: JSON.parse(String(r.metadata_json)),
  }));
}

// ------------------------------------------------------------- Questions & RAG ----

export async function insertMeetingQuestion(db: AsyncDb, q: MeetingQuestion): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meeting_questions (
        id, tenant, meeting_id, user_id, question, answer, sources_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(q.id, q.tenant, q.meetingId, q.userId, q.question, q.answer, JSON.stringify(q.sources), q.createdAt);
}

export async function listMeetingQuestions(db: AsyncDb, tenant: string, meetingId: string): Promise<MeetingQuestion[]> {
  const rows = await db
    .prepare('SELECT * FROM meeting_questions WHERE tenant = ? AND meeting_id = ? ORDER BY created_at ASC')
    .all(tenant, meetingId);

  return rows.map((r) => ({
    id: String(r.id),
    tenant: String(r.tenant),
    meetingId: String(r.meeting_id),
    userId: String(r.user_id),
    question: String(r.question),
    answer: String(r.answer),
    sources: JSON.parse(String(r.sources_json)),
    createdAt: String(r.created_at),
  }));
}

// ------------------------------------------------------------- Cascading Deletion ----

export async function deleteMeetingCascading(
  db: AsyncDb,
  tenant: string,
  meetingId: string,
): Promise<{ deleted: boolean; recordingRef: string | null }> {
  // 1. Get recording ref if any
  const recording = await getRecordingByMeetingId(db, tenant, meetingId);
  const recordingRef = recording ? recording.storageRef : null;

  // 2. Cascade delete all associated entities
  await db.transaction(async () => {
    await db.prepare('DELETE FROM meeting_questions WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db.prepare('DELETE FROM meeting_embeddings WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db.prepare('DELETE FROM meeting_chunks WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db.prepare('DELETE FROM meeting_notes WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db
      .prepare('DELETE FROM meeting_transcript_segments WHERE tenant = ? AND meeting_id = ?')
      .run(tenant, meetingId);
    await db.prepare('DELETE FROM meeting_recordings WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db.prepare('DELETE FROM meeting_participants WHERE tenant = ? AND meeting_id = ?').run(tenant, meetingId);
    await db.prepare('DELETE FROM meetings WHERE tenant = ? AND id = ?').run(tenant, meetingId);
  });

  return { deleted: true, recordingRef };
}
