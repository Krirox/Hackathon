import type {
  Meeting,
  MeetingParticipant,
  MeetingRecording,
  MeetingNotes,
  TranscriptSegment,
} from '../meetings/types.ts';
import { formatTimestamp } from '../meetings/intelligence.ts';
import { stageTokensCss } from './theme.ts';
import { MEETING_ICONS } from './meeting-icons.ts';
import { MEETING_ROOM_CSS } from './meeting-room-css.ts';
import { MEETING_ROOM_JS } from './meeting-room-js.ts';
import { createHash } from 'node:crypto';

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ------------------------------------------------------------ room assets ----
// The room stylesheet and WebRTC client are constant strings served as
// separately cacheable assets. The content hash rides in the URL query, so
// the response itself can be `immutable`: a new deploy changes the hash and
// every client refetches; an unchanged file is never re-downloaded.

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const ROOM_CSS_HASH = sha(MEETING_ROOM_CSS);
const ROOM_JS_HASH = sha(MEETING_ROOM_JS);

/** Served asset body + strong etag for `meetingRoomAsset()`. */
export function meetingRoomAsset(kind: 'css' | 'js'): { body: string; etag: string; type: string } {
  return kind === 'css'
    ? { body: MEETING_ROOM_CSS, etag: `W/"${ROOM_CSS_HASH}"`, type: 'text/css; charset=utf-8' }
    : { body: MEETING_ROOM_JS, etag: `W/"${ROOM_JS_HASH}"`, type: 'text/javascript; charset=utf-8' };
}

const MEETING_ASSET_VERSION = `?v=${ROOM_CSS_HASH}`;
const MEETING_JS_VERSION = `?v=${ROOM_JS_HASH}`;

/**
 * ICE server list for the room's RTCPeerConnections. STUN alone cannot
 * traverse symmetric NATs; set VITAL_TURN_URL (+ VITAL_TURN_USERNAME /
 * VITAL_TURN_CREDENTIAL) to enable relay. The client reads this from the
 * JSON block in the room HTML, so TURN can rotate per-session.
 */
export const DEFAULT_ICE_SERVERS: unknown[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function meetingIceServers(env: NodeJS.ProcessEnv = process.env): unknown[] {
  const servers: unknown[] = [...DEFAULT_ICE_SERVERS];
  if (env.VITAL_TURN_URL) {
    servers.push({
      urls: env.VITAL_TURN_URL,
      username: env.VITAL_TURN_USERNAME ?? '',
      credential: env.VITAL_TURN_CREDENTIAL ?? '',
    });
  }
  return servers;
}

// ------------------------------------------------------------- 1. Live Meeting Room ----

/**
 * The live room is a full standalone document (a video surface, not an app
 * page), but it speaks the console's stage-token language: the tokens are
 * inlined in <head> via stageTokensCss(), the stylesheet and WebRTC client
 * are cached static assets (see meeting-room-css.ts / meeting-room-js.ts),
 * and all state crosses the boundary through data-* attributes — never
 * interpolated JS literals.
 */
export function renderMeetingRoomView(opts: {
  meeting: Meeting;
  currentUserId: string;
  currentUserName: string;
  userRole: string;
  home: string;
  csrf: string;
  iceServers?: unknown[];
}): string {
  const { meeting, currentUserId, currentUserName, userRole, home, csrf } = opts;
  const isHost = meeting.hostUserId === currentUserId;
  const iceServers = opts.iceServers && opts.iceServers.length > 0 ? opts.iceServers : DEFAULT_ICE_SERVERS;
  const iconsJson = esc(JSON.stringify(MEETING_ICONS));
  void userRole;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${esc(meeting.title)} · Vital Meeting</title>
  <meta name="vital-csrf" content="${esc(csrf)}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📹</text></svg>">
  <style>${stageTokensCss()}</style>
  <link rel="stylesheet" href="${esc(home)}console/assets/meeting-room.css${MEETING_ASSET_VERSION}">
</head>
<body>
<div class="meeting-container" id="meeting-room-app"
     data-meeting-id="${esc(meeting.id)}" data-user-id="${esc(currentUserId)}"
     data-user-name="${esc(currentUserName)}" data-is-host="${isHost}"
     data-home="${esc(home)}" data-start-recording="${meeting.recordingEnabled ? 'true' : 'false'}"
     data-icons="${iconsJson}">

  <!-- Floating header over the hero video -->
  <header class="meeting-header">
    <div class="meeting-title-cluster">
      <a href="${esc(home)}console/meetings" class="meeting-back-btn" title="Back to Meetings" aria-label="Back to Meetings"><span data-icon="back"></span></a>
      <div>
        <h1 class="meeting-title">${esc(meeting.title)}</h1>
        <div class="meeting-meta">
          <span class="participant-count-inline"><span data-icon="people"></span><span id="participant-count-badge">1</span> participants</span>
          <span class="badge badge-scope">#${esc(meeting.scope)}</span>
          <span class="meeting-timer" id="meeting-duration-clock">00:00</span>
          <span class="conn-status-pill connected" id="conn-status-indicator">
            <span class="status-dot"></span> <span id="conn-status-text">Connected</span>
          </span>
        </div>
      </div>
    </div>
    <div class="meeting-header-actions">
      <div class="recording-badge ${meeting.recordingEnabled ? 'active' : ''}" id="recording-status-badge">
        <span class="rec-dot"></span> <span id="recording-status-text">${meeting.recordingEnabled ? 'Recording' : 'Not Recording'}</span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-toggle-intel" data-action="toggle-intel">
        <span data-icon="brain"></span> Intelligence
      </button>
    </div>
  </header>

  <!-- Speaker view: hero tile + remote rail -->
  <div class="meeting-main-area">
    <div class="meeting-stage" id="video-stage">
      <div class="stage-hero" id="stage-hero">
        <button type="button" class="hero-pin-btn" id="hero-pin-btn" data-action="pin-hero" title="Unpin: return to active speaker"><span data-icon="pin"></span></button>
      </div>
      <div class="video-rail video-grid" id="video-rail" aria-label="Participants"></div>
    </div>

    <div class="conn-banner" id="conn-banner" role="alert">
      <span data-icon="alert"></span>
      <span class="conn-banner-text"></span>
      <button type="button" data-action="retry-peers">Retry</button>
    </div>

    <!-- Intelligence & Transcript overlay drawer -->
    <aside class="intel-panel" id="intel-panel">
      <div class="intel-tabs">
        <button class="intel-tab active" data-tab="transcript">Live Transcript</button>
        <button class="intel-tab" data-tab="notes">AI Notes</button>
        <button class="intel-tab" data-tab="chat">Chat</button>
      </div>
      <div class="intel-content active" id="tab-transcript">
        <div class="transcript-stream" id="transcript-feed" aria-live="polite">
          <div class="transcript-placeholder" id="transcript-empty-state">
            Transcription active. Spoken conversation will appear here in real time.
          </div>
        </div>
      </div>
      <div class="intel-content" id="tab-notes">
        <div class="intel-notes-scroll">
          <div class="notes-section">
            <h4 class="notes-heading">Topics</h4>
            <ul class="notes-list" id="live-topics-list">
              <li class="notes-muted">Extracting topics as discussion unfolds...</li>
            </ul>
          </div>
          <div class="notes-section">
            <h4 class="notes-heading">Decisions</h4>
            <ul class="notes-list" id="live-decisions-list">
              <li class="notes-muted">No explicit decisions recorded yet.</li>
            </ul>
          </div>
          <div class="notes-section">
            <h4 class="notes-heading">Action Items</h4>
            <ul class="notes-list" id="live-actions-list">
              <li class="notes-muted">No action items assigned yet.</li>
            </ul>
          </div>
        </div>
      </div>
      <div class="intel-content" id="tab-chat">
        <div class="chat-stream" id="chat-feed"></div>
        <form class="chat-input-bar" id="chat-form">
          <input type="text" id="chat-input-text" placeholder="Send a message to everyone..." autocomplete="off">
          <button type="submit" class="btn btn-primary btn-sm chat-send" title="Send"><span data-icon="send"></span></button>
        </form>
      </div>
    </aside>

    <!-- Floating pill toolbar -->
    <footer class="meeting-toolbar">
      <button type="button" class="tool-btn" id="btn-toggle-screen" data-action="toggle-screen" title="Share screen" aria-label="Share screen">
        <span data-icon="screen"></span>
      </button>
      <button type="button" class="tool-btn" id="btn-toggle-audio" data-action="toggle-audio" title="Mute (Ctrl+D)" aria-label="Mute or unmute microphone">
        <span data-icon="mic"></span>
        <span class="btn-label" id="lbl-audio">Mute</span>
      </button>
      <button type="button" class="tool-btn danger" id="btn-leave-meeting" data-action="leave" title="${isHost ? 'End meeting' : 'Leave meeting'}" aria-label="${isHost ? 'End meeting' : 'Leave meeting'}">
        <span data-icon="hangup"></span>
      </button>
      <button type="button" class="tool-btn" id="btn-toggle-video" data-action="toggle-video" title="Stop video (Ctrl+E)" aria-label="Start or stop camera">
        <span data-icon="cam"></span>
        <span class="btn-label" id="lbl-video">Stop Video</span>
      </button>
      <button type="button" class="tool-btn" id="btn-fullscreen" data-action="toggle-fullscreen" title="Fullscreen" aria-label="Toggle fullscreen">
        <span data-icon="expand"></span>
      </button>
      <button type="button" class="tool-btn" id="btn-participants" data-action="toggle-participants" title="View participants" aria-label="View participants">
        <span data-icon="people"></span>
      </button>
      <button type="button" class="tool-btn" id="btn-toggle-rec" data-action="toggle-recording" title="Start / stop recording" aria-label="Toggle recording">
        <span data-icon="rec"></span>
        <span class="btn-label" id="lbl-recording">${meeting.recordingEnabled ? 'Stop Rec' : 'Record'}</span>
      </button>
      <button type="button" class="tool-btn" id="btn-device-settings" data-action="open-device-modal" title="Audio & video settings" aria-label="Device settings">
        <span data-icon="gear"></span>
      </button>
    </footer>
  </div>

  <!-- Device Settings Modal -->
  <div class="meeting-modal" id="device-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>Device Settings</h3>
        <button type="button" class="modal-close" data-close-modal="device-modal" aria-label="Close"><span data-icon="close"></span></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="select-mic">Microphone</label>
          <select id="select-mic" class="form-select"></select>
        </div>
        <div class="form-group">
          <label for="select-cam">Camera</label>
          <select id="select-cam" class="form-select"></select>
        </div>
        <div class="form-group">
          <label for="select-speaker">Speaker / Audio Output</label>
          <select id="select-speaker" class="form-select"></select>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-close-modal="device-modal">Done</button>
      </div>
    </div>
  </div>

  <!-- Participants Modal -->
  <div class="meeting-modal" id="participants-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>Participants (<span id="modal-participant-count">1</span>)</h3>
        <button type="button" class="modal-close" data-close-modal="participants-modal" aria-label="Close"><span data-icon="close"></span></button>
      </div>
      <div class="modal-body">
        <div class="share-link-box">
          <label>Meeting Room Link</label>
          <div class="input-copy-group">
            <input type="text" id="meeting-share-url" readonly value="">
            <button type="button" class="btn btn-secondary btn-sm" data-action="copy-link">Copy</button>
          </div>
          <span class="copied-indicator" id="copied-notice" style="display:none;">Copied to clipboard!</span>
        </div>
        <div class="participants-list-wrap">
          <ul class="participants-list" id="modal-participants-list"></ul>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-close-modal="participants-modal">Close</button>
      </div>
    </div>
  </div>

  <!-- Leave / End Confirmation Modal -->
  <div class="meeting-modal" id="leave-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>${isHost ? 'End meeting?' : 'Leave meeting?'}</h3>
        <button type="button" class="modal-close" data-close-modal="leave-modal" aria-label="Close"><span data-icon="close"></span></button>
      </div>
      <div class="modal-body">
        <p class="modal-copy">${
          isHost
            ? 'This ends the meeting for everyone. The recording stops and the summary begins processing.'
            : 'You can rejoin from the meetings library while the host keeps the meeting open.'
        }</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-action="cancel-leave">Stay</button>
        <button type="button" class="btn btn-danger" data-action="confirm-leave">${isHost ? 'End for all' : 'Leave'}</button>
      </div>
    </div>
  </div>
</div>

<script id="meeting-ice-config" type="application/json">${esc(JSON.stringify(iceServers))}</script>
<script src="${esc(home)}console/assets/meeting-room.js${MEETING_JS_VERSION}" defer></script>
</body>
</html>
`;
}

// ------------------------------------------------------------- 2. Post-Meeting Intelligence Detail ----

export function renderMeetingDetailView(opts: {
  meeting: Meeting;
  notes: MeetingNotes | null;
  transcript: TranscriptSegment[];
  recording: MeetingRecording | null;
  participants: MeetingParticipant[];
  home: string;
  csrf: string;
}): string {
  const { meeting, notes, transcript, recording, participants, home, csrf } = opts;
  const status = meeting.processingStatus;

  return `
<div class="meeting-detail-view">
  <!-- Top Breadcrumb & Metadata Header -->
  <div class="detail-header-card">
    <div class="detail-title-row">
      <div>
        <a href="${esc(home)}console/meetings" class="back-link">← All Meetings</a>
        <h1 class="detail-title">${esc(meeting.title)}</h1>
        <div class="detail-meta">
          <span>📅 ${esc(new Date(meeting.createdAt).toLocaleDateString())}</span>
          <span>⏱️ ${Math.round(meeting.durationSeconds / 60)} minutes</span>
          <span>👥 ${participants.length} participants</span>
          <span class="badge badge-scope">#${esc(meeting.scope)}</span>
        </div>
      </div>
      <div class="detail-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick="exportMeetingSummary()">Export Notes</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteMeetingConfirm()">Delete Meeting</button>
      </div>
    </div>

    <!-- Background Processing Pipeline Bar -->
    <div class="processing-strip">
      <div class="pipeline-step ${status.recording === 'done' ? 'done' : status.recording === 'processing' ? 'active' : ''}">
        ${status.recording === 'done' ? '✓' : '●'} Recording
      </div>
      <div class="pipeline-step ${status.transcript === 'done' ? 'done' : status.transcript === 'processing' ? 'active' : ''}">
        ${status.transcript === 'done' ? '✓' : status.transcript === 'processing' ? '●' : '○'} Transcript
      </div>
      <div class="pipeline-step ${status.summary === 'done' ? 'done' : status.summary === 'processing' ? 'active' : ''}">
        ${status.summary === 'done' ? '✓' : status.summary === 'processing' ? '●' : '○'} Summary & Notes
      </div>
      <div class="pipeline-step ${status.indexing === 'done' ? 'done' : status.indexing === 'processing' ? 'active' : ''}">
        ${status.indexing === 'done' ? '✓' : status.indexing === 'processing' ? '●' : '○'} RAG Indexing
      </div>
    </div>
  </div>

  <!-- Main Grid: Summary/Decisions/Actions Left, Recording/Transcript/RAG Right -->
  <div class="detail-grid">
    <!-- Left Column: Intelligence -->
    <div class="detail-left-col">
      <!-- Executive Summary -->
      <section class="intel-card">
        <h2 class="card-heading">Summary</h2>
        <p class="summary-text">${notes?.summary ? esc(notes.summary) : '<span class="text-muted">Summary is generating...</span>'}</p>
      </section>

      <!-- Topics -->
      <section class="intel-card">
        <h2 class="card-heading">Topics</h2>
        <div class="topic-pills">
          ${(notes?.topics || []).map((t) => `<span class="topic-pill">${esc(t)}</span>`).join('') || '<span class="text-muted">No topics extracted.</span>'}
        </div>
      </section>

      <!-- Decisions -->
      <section class="intel-card">
        <h2 class="card-heading">Decisions</h2>
        <div class="decisions-list">
          ${
            (notes?.decisions || [])
              .map(
                (d) => `
            <div class="decision-item">
              <span class="decision-check">✓</span>
              <div class="decision-body">
                <div class="decision-text">${esc(d.decision)}</div>
                <a href="#ts-${esc(d.sourceTimestamp)}" class="source-timestamp" onclick="seekAudio('${esc(d.sourceTimestamp)}')">⏱️ ${esc(d.sourceTimestamp)}</a>
              </div>
            </div>
          `,
              )
              .join('') || '<span class="text-muted">No explicit decisions recorded in this meeting.</span>'
          }
        </div>
      </section>

      <!-- Action Items -->
      <section class="intel-card">
        <h2 class="card-heading">Action Items</h2>
        <div class="actions-list">
          ${
            (notes?.actionItems || [])
              .map(
                (a) => `
            <div class="action-item">
              <input type="checkbox" class="action-chk" ${a.completed ? 'checked' : ''}>
              <div class="action-body">
                <span class="action-task">${esc(a.task)}</span>
                <div class="action-meta">
                  ${a.owner ? `<span class="owner-pill">👤 ${esc(a.owner)}</span>` : ''}
                  ${a.deadline ? `<span class="deadline-pill">📅 ${esc(a.deadline)}</span>` : ''}
                  <a href="#ts-${esc(a.sourceTimestamp)}" class="source-timestamp" onclick="seekAudio('${esc(a.sourceTimestamp)}')">⏱️ ${esc(a.sourceTimestamp)}</a>
                </div>
              </div>
            </div>
          `,
              )
              .join('') || '<span class="text-muted">No action items assigned.</span>'
          }
        </div>
      </section>

      <!-- Open Questions -->
      ${
        notes?.openQuestions && notes.openQuestions.length > 0
          ? `
      <section class="intel-card">
        <h2 class="card-heading">Open Questions</h2>
        <ul class="questions-list">
          ${notes.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}
        </ul>
      </section>
      `
          : ''
      }
    </div>

    <!-- Right Column: Player + Searchable Transcript + RAG Q&A -->
    <div class="detail-right-col">
      <!-- Media Recording Player -->
      <section class="intel-card media-card">
        <h2 class="card-heading">Meeting Recording</h2>
        ${
          recording
            ? `
          <div class="player-wrapper">
            <audio id="meeting-audio-player" controls style="width:100%;margin-top:8px;">
              <source src="${esc(home)}api/meetings/${esc(meeting.id)}/recording" type="audio/${esc(recording.format)}">
              Your browser does not support audio playback.
            </audio>
            <div class="player-meta">Size: ${(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB · SHA-256: <code>${esc(recording.sha256.slice(0, 12))}...</code></div>
          </div>
        `
            : `<div class="empty-media">No audio recording attached to this meeting.</div>`
        }
      </section>

      <!-- Ask About Meeting (RAG) -->
      <section class="intel-card rag-card">
        <h2 class="card-heading">Ask About This Meeting</h2>
        <div class="rag-conversation" id="rag-chat-history">
          <div class="rag-system-msg">Ask any question. Answers come from lexical retrieval over meeting chunks, with cited timestamps. (Chunks are indexed with hash-based term vectors, not a semantic embedding model; retrieval matches words, not meanings.)</div>
        </div>
        <form class="rag-input-form" onsubmit="submitMeetingQuestion(event)">
          <input type="text" id="rag-query-input" class="rag-input" placeholder="e.g. What did we decide about the launch?" required>
          <button type="submit" class="btn btn-primary btn-sm" id="btn-submit-rag">Ask AI</button>
        </form>
      </section>

      <!-- Searchable Full Transcript -->
      <section class="intel-card transcript-card">
        <div class="transcript-header-row">
          <h2 class="card-heading">Full Transcript</h2>
          <input type="text" id="transcript-filter" class="search-filter-input" placeholder="Filter transcript..." oninput="filterTranscript(this.value)">
        </div>
        <div class="full-transcript-stream" id="full-transcript-container">
          ${
            transcript
              .map(
                (s) => `
            <div class="transcript-segment-row" id="ts-${formatTimestamp(s.startTime)}" data-start="${s.startTime}" onclick="seekAudio('${formatTimestamp(s.startTime)}')">
              <span class="seg-time">${formatTimestamp(s.startTime)}</span>
              <span class="seg-speaker">${esc(s.speakerName)}</span>
              <span class="seg-text">${esc(s.text)}</span>
            </div>
          `,
              )
              .join('') ||
            '<div class="text-muted" style="padding:20px;text-align:center;">No transcript segments available.</div>'
          }
        </div>
      </section>
    </div>
  </div>
</div>

<script>
(() => {
  const meetingId = "${esc(meeting.id)}";
  const home = "${esc(home)}";
  const csrfToken = "${esc(csrf)}";

  window.seekAudio = (ts) => {
    const player = document.getElementById('meeting-audio-player');
    if (!player) return;
    const parts = ts.split(':').map(Number);
    if (parts.length === 2) {
      player.currentTime = parts[0] * 60 + parts[1];
      player.play();
    }
  };

  window.filterTranscript = (query) => {
    const q = query.toLowerCase();
    const rows = document.querySelectorAll('.transcript-segment-row');
    rows.forEach((r) => {
      const match = r.textContent.toLowerCase().includes(q);
      r.style.display = match ? 'flex' : 'none';
    });
  };

  window.submitMeetingQuestion = async (e) => {
    e.preventDefault();
    const input = document.getElementById('rag-query-input');
    const q = input.value.trim();
    if (!q) return;

    input.value = '';
    const history = document.getElementById('rag-chat-history');

    // Add user question
    const userDiv = document.createElement('div');
    userDiv.className = 'rag-msg user-msg';
    userDiv.textContent = q;
    history.appendChild(userDiv);

    // Add pending AI message
    const aiDiv = document.createElement('div');
    aiDiv.className = 'rag-msg ai-msg';
    aiDiv.textContent = 'Searching meeting intelligence...';
    history.appendChild(aiDiv);
    history.scrollTop = history.scrollHeight;

    try {
      const res = await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vital-csrf': csrfToken },
        body: JSON.stringify({ question: q })
      });
      const data = await res.json();
      aiDiv.innerHTML = '<div class="ai-answer-body">' + escapeHtml(data.answer) + '</div>';
      if (data.sources && data.sources.length > 0) {
        const srcDiv = document.createElement('div');
        srcDiv.className = 'ai-sources-cluster';
        srcDiv.innerHTML = '<strong>Sources:</strong> ' + data.sources.map((s) => '<a href="#ts-' + s.timestamp + '" class="source-chip" onclick="seekAudio(\x27' + s.timestamp + '\x27)">⏱️ ' + s.timestamp + '</a>').join(' ');
        aiDiv.appendChild(srcDiv);
      }
    } catch (err) {
      aiDiv.textContent = 'Error querying meeting RAG.';
    }
    history.scrollTop = history.scrollHeight;
  };

  window.deleteMeetingConfirm = async () => {
    if (!confirm('Are you sure you want to delete this meeting and all associated intelligence?')) return;
    await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/delete', { method: 'POST', headers: { 'x-vital-csrf': csrfToken } });
    window.location.href = home + 'console/meetings';
  };

  window.exportMeetingSummary = () => {
    const summary = document.querySelector('.summary-text')?.textContent || '';
    const topics = Array.from(document.querySelectorAll('.topic-pill')).map(p => '- ' + p.textContent.trim()).join('\n');
    const decisions = Array.from(document.querySelectorAll('.decision-text')).map(d => '- ' + d.textContent.trim()).join('\n');
    const actions = Array.from(document.querySelectorAll('.action-item')).map(a => '- ' + a.innerText.replace(/\n+/g, ' ').trim()).join('\n');
    const questions = Array.from(document.querySelectorAll('.questions-list li')).map(q => '- ' + q.textContent.trim()).join('\n');
    const title = document.querySelector('.detail-title')?.textContent || 'Meeting Notes';
    const md = '# ' + title + '\n\n' +
      '## Summary\n' + summary + '\n\n' +
      '## Topics\n' + (topics || 'None') + '\n\n' +
      '## Decisions\n' + (decisions || 'None') + '\n\n' +
      '## Action Items\n' + (actions || 'None') + '\n\n' +
      '## Open Questions\n' + (questions || 'None') + '\n';
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting-notes-' + meetingId + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
</script>

<style>
.meeting-detail-view {
  padding: 24px 32px;
  background: var(--v-stage-ink-strong);
  min-height: 100%;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  color: var(--v-stage-line);
}
.detail-header-card {
  background: var(--v-stage-white);
  border-radius: 12px;
  border: 1px solid var(--v-stage-ink);
  padding: 20px 24px;
  margin-bottom: 24px;
  box-shadow: 0 1px 3px var(--v-stage-shadow-4);
}
.detail-title-row { display: flex; justify-content: space-between; align-items: flex-start; }
.back-link { font-size: 13px; color: var(--v-stage-muted); text-decoration: none; margin-bottom: 6px; display: inline-block; }
.back-link:hover { color: var(--v-stage-accent-dim); }
.detail-title { font-size: 22px; font-weight: 700; color: var(--v-stage-3); margin: 4px 0 8px; }
.detail-meta { display: flex; align-items: center; gap: 14px; font-size: 13px; color: var(--v-stage-muted); }
.processing-strip {
  display: flex;
  gap: 16px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--v-stage-soft);
}
.pipeline-step { font-size: 12px; font-weight: 500; color: var(--v-stage-muted-2); }
.pipeline-step.done { color: var(--v-stage-accent); font-weight: 600; }
.pipeline-step.active { color: var(--v-stage-warn); font-weight: 600; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.intel-card {
  background: var(--v-stage-white);
  border: 1px solid var(--v-stage-ink);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px var(--v-stage-shadow);
}
.card-heading {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--v-stage-muted);
  margin-bottom: 12px;
}
.summary-text { font-size: 14px; line-height: 1.6; color: var(--v-stage-line-strong); }
.topic-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.topic-pill {
  background: var(--v-stage-soft);
  border: 1px solid var(--v-stage-ink);
  color: var(--v-stage-faint);
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}
.decision-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--v-stage-ink-strong);
}
.decision-check { color: var(--v-stage-good-2); font-weight: 700; font-size: 16px; }
.decision-text { font-size: 13.5px; font-weight: 500; color: var(--v-stage-line); }
.source-timestamp { font-size: 11px; color: var(--v-stage-accent-dim); text-decoration: none; margin-top: 2px; display: inline-block; }
.source-timestamp:hover { text-decoration: underline; }

.action-item { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--v-stage-ink-strong); align-items: flex-start; }
.action-task { font-size: 13.5px; font-weight: 500; color: var(--v-stage-line); }
.action-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 11px; }
.owner-pill { background: var(--v-stage-info-bg); color: var(--v-stage-info); padding: 2px 8px; border-radius: 4px; }
.deadline-pill { background: var(--v-stage-warn-bg); color: var(--v-stage-warn-2); padding: 2px 8px; border-radius: 4px; }

/* RAG Card */
.rag-card { display: flex; flex-direction: column; min-height: 320px; }
.rag-conversation {
  flex: 1;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.rag-system-msg { font-size: 12px; color: var(--v-stage-muted); font-style: italic; }
.rag-msg { padding: 8px 12px; border-radius: 8px; font-size: 13px; max-width: 85%; }
.user-msg { background: var(--v-stage-accent-dim); color: var(--v-stage-white); align-self: flex-end; }
.ai-msg { background: var(--v-stage-soft); color: var(--v-stage-line); align-self: flex-start; border: 1px solid var(--v-stage-ink); }
.ai-sources-cluster { margin-top: 6px; font-size: 11px; color: var(--v-stage-muted); }
.source-chip { background: var(--v-stage-ink); padding: 2px 6px; border-radius: 4px; color: var(--v-stage-accent-dim); text-decoration: none; }
.rag-input-form { display: flex; gap: 8px; }
.rag-input { flex: 1; border: 1px solid var(--v-stage-ink-2); border-radius: 6px; padding: 8px 12px; font-size: 13px; outline: none; }

/* Transcript Card */
.transcript-card { max-height: 480px; display: flex; flex-direction: column; }
.transcript-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.search-filter-input { border: 1px solid var(--v-stage-ink-2); border-radius: 6px; padding: 4px 10px; font-size: 12px; width: 180px; }
.full-transcript-stream { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.transcript-segment-row {
  display: flex;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.transcript-segment-row:hover { background: var(--v-stage-soft); }
.seg-time { font-size: 11px; font-family: monospace; color: var(--v-stage-muted); width: 44px; flex-shrink: 0; }
.seg-speaker { font-weight: 600; color: var(--v-stage-accent-dim); width: 120px; flex-shrink: 0; }
.seg-text { color: var(--v-stage-line-strong); flex: 1; }
</style>
`;
}

// ------------------------------------------------------------- 3. Meeting Library List ----

function formatMeetingTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return '';
  }
}

function formatMeetingDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function formatMeetingDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function renderMeetingLibraryView(opts: { meetings: Meeting[]; home: string; csrf?: string }): string {
  const { meetings, home, csrf } = opts;

  const activeMeetings = meetings.filter((m) => m.status === 'ACTIVE');
  const pastMeetings = meetings.filter((m) => m.status === 'ENDED');

  return `
<div class="meeting-library-view">
  <!-- Top Header with Actions -->
  <div class="library-top-bar">
    <div class="library-header-info">
      <a href="/console/dashboard" class="btn-back-console" title="Return to the Vital Console dashboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18l-6-6 6-6"/></svg>
        <span>Back to console</span>
      </a>
      <div class="library-title-row">
        <h1 class="library-heading">Meeting Intelligence</h1>
        <div class="header-badges">
          ${activeMeetings.length > 0 ? `<span class="stat-pill live"><span class="pulse-dot"></span> ${activeMeetings.length} Live Call${activeMeetings.length === 1 ? '' : 's'}</span>` : ''}
          <span class="stat-pill muted">📚 ${pastMeetings.length} Past Session${pastMeetings.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <p class="library-sub">Real-time WebRTC audio/video sessions, live transcripts, and grounded AI meeting intelligence.</p>
    </div>
    <div class="library-actions">
      <button type="button" class="btn-new-meeting" id="btn-open-new-meeting" onclick="openNewMeetingModal()">
        <span class="btn-sparkle">✨</span>
        <span>+ New Meeting</span>
      </button>
    </div>
  </div>

  <!-- Search & Filter Tab Strip -->
  <div class="library-toolbar-strip">
    <div class="search-input-wrapper">
      <span class="search-icon">🔍</span>
      <input type="text" id="lib-search" class="lib-search-box" placeholder="Search by title, host, or department (#engineering)..." oninput="handleLibrarySearch(this.value)">
    </div>
    <div class="filter-tabs">
      <button type="button" class="filter-tab active" data-filter="all" onclick="filterByTab('all', this)">
        All (${meetings.length})
      </button>
      <button type="button" class="filter-tab" data-filter="active" onclick="filterByTab('active', this)">
        <span class="pulse-dot-small"></span> Live Now (${activeMeetings.length})
      </button>
      <button type="button" class="filter-tab" data-filter="past" onclick="filterByTab('past', this)">
        Past Calls (${pastMeetings.length})
      </button>
    </div>
  </div>

  <!-- Active Meetings Section -->
  <div class="library-section" id="active-calls-section">
    <div class="section-title-row">
      <div class="section-title-cluster">
        <span class="pulse-dot"></span>
        <h2 class="section-heading">Active Calls (Live Now)</h2>
      </div>
      <span class="section-count">${activeMeetings.length} active</span>
    </div>

    ${
      activeMeetings.length === 0
        ? `
      <div class="no-active-card">
        <div class="no-active-content">
          <span class="no-active-icon">🎙️</span>
          <div>
            <h4>No meetings currently in progress</h4>
            <p>Start a new instant video room to connect with peers and capture live AI notes.</p>
          </div>
        </div>
        <button type="button" class="btn-start-quick" onclick="openNewMeetingModal()">Start Call Now →</button>
      </div>
    `
        : `
      <div class="meetings-grid active-grid">
        ${activeMeetings
          .map(
            (m) => `
          <div class="meeting-card card-active" data-status="active" data-title="${esc(m.title)}" data-host="${esc(m.hostName)}" data-scope="${esc(m.scope)}">
            <div class="mcard-top">
              <span class="badge-live-pulse"><span class="pulse-dot"></span> LIVE NOW</span>
              <span class="mcard-scope">#${esc(m.scope)}</span>
            </div>
            <h3 class="mcard-title">${esc(m.title)}</h3>
            <div class="mcard-meta">
              <div class="meta-item">
                <span class="meta-icon">⏰</span>
                <span>Started: <strong>${esc(formatMeetingTime(m.startedAt || m.createdAt))}</strong> (${esc(formatMeetingDate(m.createdAt))})</span>
              </div>
              <div class="meta-item">
                <span class="meta-icon">👤</span>
                <span>Host: <strong>${esc(m.hostName)}</strong></span>
              </div>
            </div>
            <div class="mcard-footer">
              <button type="button" class="btn-copy-card-link" onclick="copyCardMeetingLink('${esc(home)}console/meetings/${esc(m.id)}/room', this)" title="Copy Room Link">
                📋 Copy Link
              </button>
              <a href="${esc(home)}console/meetings/${esc(m.id)}/room" class="btn-join-room">
                Join Call →
              </a>
            </div>
          </div>
        `,
          )
          .join('')}
      </div>
    `
    }
  </div>

  <!-- Past Meetings Section -->
  <div class="library-section" id="past-calls-section">
    <div class="section-title-row">
      <div class="section-title-cluster">
        <span class="past-icon">📚</span>
        <h2 class="section-heading">Past Meetings & Intelligence</h2>
      </div>
      <span class="section-count">${pastMeetings.length} recorded</span>
    </div>

    ${
      pastMeetings.length === 0
        ? `
      <div class="empty-past-card">
        <p>No completed meetings yet. Concluded meetings with summaries and recordings will appear here.</p>
      </div>
    `
        : `
      <div class="meetings-grid past-grid">
        ${pastMeetings
          .map(
            (m) => `
          <div class="meeting-card card-past" data-status="past" data-title="${esc(m.title)}" data-host="${esc(m.hostName)}" data-scope="${esc(m.scope)}">
            <div class="mcard-top">
              <span class="badge-ended">ENDED</span>
              <span class="mcard-scope">#${esc(m.scope)}</span>
            </div>
            <h3 class="mcard-title">${esc(m.title)}</h3>
            <div class="mcard-meta">
              <div class="meta-item">
                <span class="meta-icon">⏰</span>
                <span>${esc(formatMeetingDate(m.createdAt))} · ${esc(formatMeetingTime(m.startedAt || m.createdAt))}</span>
              </div>
              <div class="meta-item">
                <span class="meta-icon">⏱️</span>
                <span>Duration: <strong>${esc(formatMeetingDuration(m.durationSeconds))}</strong></span>
              </div>
              <div class="meta-item">
                <span class="meta-icon">👤</span>
                <span>Host: ${esc(m.hostName)}</span>
              </div>
            </div>
            <div class="mcard-footer">
              <a href="${esc(home)}console/meetings/${esc(m.id)}" class="btn-view-intel">
                View Intelligence →
              </a>
            </div>
          </div>
        `,
          )
          .join('')}
      </div>
    `
    }
  </div>

  <!-- Centered New Meeting Modal -->
  <div class="modal-overlay" id="new-meeting-modal" style="display:none;" onclick="handleModalOverlayClick(event)">
    <div class="modal-card-center" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div class="modal-header-text">
          <div class="modal-badge-row">
            <span class="modal-app-badge">📹 WebRTC Meeting Room</span>
          </div>
          <h3 class="modal-title">Create New Meeting</h3>
          <p class="modal-desc">Launch an instant peer-to-peer room with live transcription and AI intelligence.</p>
        </div>
        <button type="button" class="modal-close-btn" onclick="closeNewMeetingModal()" aria-label="Close modal">✕</button>
      </div>
      <form action="${esc(home)}api/meetings/create" method="POST" id="new-meeting-form">
        ${csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : ''}
        <div class="form-group">
          <label for="meeting-title-input">Meeting Title</label>
          <input type="text" id="meeting-title-input" name="title" class="form-input" placeholder="e.g. Architecture & Launch Review" required autocomplete="off">
        </div>
        <div class="form-group">
          <label for="meeting-scope-input">Room / Department Scope</label>
          <select id="meeting-scope-input" name="scope" class="form-input">
            <option value="general">general</option>
            <option value="engineering" selected>engineering</option>
            <option value="product">product</option>
            <option value="design">design</option>
            <option value="infra">infra</option>
            <option value="finance">finance</option>
            <option value="marketing">marketing</option>
            <option value="exec">exec</option>
          </select>
        </div>
        <div class="form-checkbox-group">
          <label class="checkbox-container">
            <input type="checkbox" id="meeting-rec-input" name="recordingEnabled" value="1" checked>
            <span class="checkmark"></span>
            <div class="checkbox-text">
              <span class="checkbox-title">Enable Audio Recording & Live AI Notes</span>
              <span class="checkbox-sub">Automatically records session and transcribes speech in real time</span>
            </div>
          </label>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="closeNewMeetingModal()">Cancel</button>
          <button type="submit" class="btn-create-submit">
            <span>Launch Meeting Room →</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</div>

<script>
(() => {
  let currentFilter = 'all';
  let searchQuery = '';

  window.openNewMeetingModal = function() {
    const modal = document.getElementById('new-meeting-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(() => {
      document.getElementById('meeting-title-input')?.focus();
    }, 50);
  };

  window.closeNewMeetingModal = function() {
    const modal = document.getElementById('new-meeting-modal');
    if (!modal) return;
    modal.style.display = 'none';
  };

  window.handleModalOverlayClick = function(e) {
    if (e.target.id === 'new-meeting-modal') {
      closeNewMeetingModal();
    }
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeNewMeetingModal();
    }
  });

  window.filterByTab = function(tab, btn) {
    currentFilter = tab;
    document.querySelectorAll('.filter-tab').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyFilters();
  };

  window.handleLibrarySearch = function(query) {
    searchQuery = (query || '').toLowerCase().trim();
    applyFilters();
  };

  function applyFilters() {
    const cards = document.querySelectorAll('.meeting-card');
    cards.forEach((card) => {
      const title = (card.getAttribute('data-title') || '').toLowerCase();
      const host = (card.getAttribute('data-host') || '').toLowerCase();
      const scope = (card.getAttribute('data-scope') || '').toLowerCase();
      const status = card.getAttribute('data-status');

      const matchesSearch = !searchQuery || title.includes(searchQuery) || host.includes(searchQuery) || scope.includes(searchQuery);
      const matchesTab = currentFilter === 'all' || currentFilter === status;

      card.style.display = (matchesSearch && matchesTab) ? 'flex' : 'none';
    });
  }

  window.copyCardMeetingLink = function(url, btn) {
    const fullUrl = window.location.origin + url;
    navigator.clipboard.writeText(fullUrl).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Copied!';
      btn.style.color = 'var(--v-stage-good)';
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.color = '';
      }, 2000);
    }).catch(console.error);
  };
})();
</script>

<style>
/* Meeting Intelligence library: styled on the Console design system (--v-*
   tokens) so it reads as a native console page in BOTH themes. It previously
   shipped a fixed light palette (--v-stage-white / ink-strong backgrounds with
   dark stage text), which painted a bright island inside the dark Console
   shell. Every rule below now speaks in theme-adaptive console tokens. */

/* Back to Console: small pill above the library title. Uses shell tokens so
   it flips with light/dark and matches the topbar/rail. */
.btn-back-console {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px 5px 8px;
  margin: 0 0 10px;
  border-radius: var(--radius-pill);
  background: var(--v-bg-2);
  color: var(--v-ink-2);
  border: 1px solid var(--v-line);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .005em;
  text-decoration: none;
  width: fit-content;
  transition: background .15s var(--ease-out), color .15s var(--ease-out), border-color .15s var(--ease-out);
}
.btn-back-console:hover {
  background: var(--v-accent-dim);
  color: var(--v-accent);
  border-color: transparent;
  text-decoration: none;
}
.btn-back-console:focus-visible { outline: 2px solid var(--v-focus); outline-offset: 2px; }
.btn-back-console svg { flex-shrink: 0; }

.meeting-library-view {
  padding: 22px 26px;
  background: transparent;
  min-height: 100%;
  overflow-y: auto;
  font-family: var(--font-body);
  color: var(--v-ink);
  box-sizing: border-box;
}

.library-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.library-title-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 6px;
}
.library-heading {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--v-ink);
  margin: 0;
}
.header-badges {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: var(--v-bg-2);
  color: var(--v-muted);
  border: 1px solid var(--v-line);
}
.stat-pill.live {
  background: var(--v-tint-good-bg);
  color: var(--v-tint-good-ink);
  border-color: transparent;
}
.pulse-dot {
  width: 8px;
  height: 8px;
  background: var(--v-fact);
  border-radius: 50%;
  animation: pulseDot 1.5s infinite;
}
.pulse-dot-small {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--v-fact);
  border-radius: 50%;
  margin-right: 4px;
}
@keyframes pulseDot {
  0% { box-shadow: 0 0 0 0 var(--v-glow-accent); transform: scale(0.95); }
  70% { box-shadow: 0 0 0 6px transparent; transform: scale(1.1); }
  100% { box-shadow: 0 0 0 0 transparent; transform: scale(0.95); }
}

.library-sub {
  font-size: 13.5px;
  color: var(--v-muted);
  margin: 0;
}

/* New Meeting Action Button */
.btn-new-meeting {
  background: var(--v-accent);
  color: var(--v-accent-ink);
  border: none;
  padding: 11px 22px;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: var(--v-card-shadow);
  transition: filter 0.15s ease, transform 0.1s ease;
}
.btn-new-meeting:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
}
.btn-sparkle { font-size: 14px; }

/* Toolbar Strip: Search & Tabs */
.library-toolbar-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 28px;
  flex-wrap: wrap;
}
.search-input-wrapper {
  position: relative;
  flex: 1;
  max-width: 440px;
  min-width: 260px;
}
.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  opacity: 0.6;
  pointer-events: none;
}
.lib-search-box {
  width: 100%;
  padding: 10px 14px 10px 36px;
  border: 1px solid var(--v-line-strong);
  border-radius: var(--radius-input);
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  background: var(--v-input-bg);
  color: var(--v-ink);
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
.lib-search-box::placeholder { color: var(--v-faint); }
.lib-search-box:focus {
  border-color: var(--v-accent);
  box-shadow: 0 0 0 3px var(--v-accent-dim);
}

.filter-tabs {
  display: flex;
  gap: 4px;
  background: var(--v-bg-2);
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--v-line);
}
.filter-tab {
  background: transparent;
  border: none;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  color: var(--v-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: color 0.15s ease, background 0.15s ease;
}
.filter-tab:hover { color: var(--v-ink); }
.filter-tab.active {
  background: var(--v-accent);
  color: var(--v-accent-ink);
  font-weight: 600;
}

/* Sections */
.library-section {
  margin-bottom: 36px;
}
.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--v-line);
}
.section-title-cluster {
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-heading {
  font-size: 16px;
  font-weight: 650;
  color: var(--v-ink);
  margin: 0;
}
.section-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--v-muted);
}

/* Meeting Cards */
.meetings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
.meeting-card {
  background: var(--v-bg-1);
  border: 1px solid var(--v-line);
  border-radius: var(--radius-card);
  padding: 20px;
  box-shadow: var(--v-card-shadow);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out), border-color 0.2s;
  position: relative;
}
.meeting-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--v-card-shadow-hover);
  border-color: var(--v-line-strong);
}
.meeting-card.card-active {
  border-color: var(--v-fact);
}

.mcard-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.badge-live-pulse {
  background: var(--v-tint-good-bg);
  color: var(--v-tint-good-ink);
  font-weight: 700;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.badge-ended {
  background: var(--v-bg-2);
  color: var(--v-muted);
  font-weight: 600;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  border: 1px solid var(--v-line);
}
.mcard-scope {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--v-accent);
  background: var(--v-accent-dim);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.mcard-title {
  font-size: 16px;
  font-weight: 650;
  color: var(--v-ink);
  margin: 0 0 12px 0;
  line-height: 1.35;
}
.mcard-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: var(--v-muted);
  margin-bottom: 18px;
}
.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.meta-icon {
  font-size: 13px;
  opacity: 0.8;
}

.mcard-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--v-line);
}
.btn-join-room {
  background: var(--v-accent);
  color: var(--v-accent-ink);
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  padding: 7px 16px;
  border-radius: var(--radius-md);
  transition: filter 0.15s ease, transform 0.1s ease;
  display: inline-flex;
  align-items: center;
}
.btn-join-room:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
}
.btn-copy-card-link {
  background: var(--v-bg-2);
  border: 1px solid var(--v-line-strong);
  color: var(--v-ink-2);
  font-size: 12px;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}
.btn-copy-card-link:hover {
  background: var(--v-bg-3);
  color: var(--v-ink);
}
.btn-view-intel {
  background: var(--v-accent);
  border: 1px solid var(--v-accent);
  color: var(--v-accent-ink);
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  padding: 7px 16px;
  border-radius: var(--radius-md);
  transition: filter 0.15s ease, transform 0.1s ease;
}
.btn-view-intel:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
}

/* Empty State Banners */
.no-active-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  background: var(--v-bg-1);
  border: 1px dashed var(--v-line-strong);
  border-radius: var(--radius-lg);
  padding: 18px 24px;
}
.no-active-content {
  display: flex;
  align-items: center;
  gap: 14px;
}
.no-active-icon { font-size: 24px; }
.no-active-content h4 { margin: 0 0 2px 0; font-size: 14px; font-weight: 600; color: var(--v-ink); }
.no-active-content p { margin: 0; font-size: 12.5px; color: var(--v-muted); }
.btn-start-quick {
  background: var(--v-accent);
  color: var(--v-accent-ink);
  border: none;
  font-family: inherit;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.empty-past-card {
  background: var(--v-bg-1);
  border: 1px dashed var(--v-line-strong);
  border-radius: var(--radius-lg);
  padding: 24px;
  text-align: center;
  color: var(--v-muted);
  font-size: 13px;
}

/* Centered Pop-up Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--v-stage-scrim);
  backdrop-filter: blur(8px);
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: fadeInModal 0.15s ease-out;
}
.modal-card-center {
  width: 100%;
  max-width: 480px;
  background: var(--v-stage-3);
  border: 1px solid var(--v-stage-line-strong);
  border-radius: 16px;
  box-shadow: 0 25px 50px -12px var(--v-stage-shadow-60), 0 0 0 1px var(--v-stage-white-5);
  padding: 24px 28px;
  color: var(--v-stage-ink-strong);
  box-sizing: border-box;
  animation: scaleModal 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes fadeInModal {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes scaleModal {
  from { transform: scale(0.95); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}
.modal-app-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--v-stage-accent-bright);
  background: var(--v-stage-accent-bright-10);
  padding: 2px 8px;
  border-radius: 12px;
  display: inline-block;
  margin-bottom: 6px;
}
.modal-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--v-stage-ink-strong);
  margin: 0 0 4px 0;
}
.modal-desc {
  font-size: 12.5px;
  color: var(--v-stage-muted-2);
  margin: 0;
}
.modal-close-btn {
  background: transparent;
  border: none;
  color: var(--v-stage-muted-2);
  font-size: 18px;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}
.modal-close-btn:hover { color: var(--v-stage-white); background: var(--v-stage-line); }

.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--v-stage-muted-2);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.form-input {
  width: 100%;
  background: var(--v-stage-line);
  border: 1px solid var(--v-stage-line-strong);
  color: var(--v-stage-ink-strong);
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13.5px;
  outline: none;
  box-sizing: border-box;
}
.form-input:focus {
  border-color: var(--v-stage-accent-bright);
  box-shadow: 0 0 0 2px var(--v-stage-accent-bright-20);
}

.form-checkbox-group {
  margin-bottom: 20px;
  background: var(--v-stage-6);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--v-stage-line);
}
.checkbox-container {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.checkbox-container input {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  accent-color: var(--v-stage-accent);
  cursor: pointer;
}
.checkbox-text {
  display: flex;
  flex-direction: column;
}
.checkbox-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--v-stage-soft);
}
.checkbox-sub {
  font-size: 11.5px;
  color: var(--v-stage-muted-2);
  margin-top: 2px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--v-stage-line);
}
.btn {
  padding: 9px 18px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
}
.btn-secondary {
  background: var(--v-stage-line);
  border: 1px solid var(--v-stage-line-strong);
  color: var(--v-stage-ink);
}
.btn-secondary:hover { background: var(--v-stage-line-strong); color: var(--v-stage-white); }
.btn-create-submit {
  background: linear-gradient(135deg, var(--v-stage-accent) 0%, var(--v-stage-accent-2) 100%);
  color: var(--v-stage-white);
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 4px 14px var(--v-stage-teal-40);
}
.btn-create-submit:hover {
  background: linear-gradient(135deg, var(--v-stage-accent-dim-2) 0%, var(--v-stage-accent) 100%);
}
</style>
`;
}
