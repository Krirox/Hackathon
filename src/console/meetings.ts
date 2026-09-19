import type {
  Meeting,
  MeetingParticipant,
  MeetingRecording,
  MeetingNotes,
  TranscriptSegment,
} from '../meetings/types.ts';
import { formatTimestamp } from '../meetings/intelligence.ts';

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ------------------------------------------------------------- 1. Live Meeting Room ----

export function renderMeetingRoomView(opts: {
  meeting: Meeting;
  currentUserId: string;
  currentUserName: string;
  userRole: string;
  home: string;
}): string {
  const { meeting, currentUserId, currentUserName, userRole, home } = opts;
  const isHost = meeting.hostUserId === currentUserId;

  return `
<div class="meeting-container" id="meeting-room-app" data-meeting-id="${esc(meeting.id)}" data-user-id="${esc(currentUserId)}" data-user-name="${esc(currentUserName)}" data-is-host="${isHost}">
  <!-- Top Navigation / Status Header -->
  <header class="meeting-header">
    <div class="meeting-title-cluster">
      <a href="${esc(home)}console/meetings" class="meeting-back-btn" title="Back to Meetings">←</a>
      <div>
        <h1 class="meeting-title">${esc(meeting.title)}</h1>
        <div class="meeting-meta">
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
      <button type="button" class="btn btn-secondary btn-sm" id="btn-toggle-intel" onclick="toggleIntelPanel()">
        🧠 Intelligence Panel
      </button>
    </div>
  </header>

  <!-- Main Split Layout: Videos + Intelligence Panel -->
  <div class="meeting-main-area">
    <!-- Video Stage -->
    <div class="meeting-stage" id="video-stage">
      <div class="video-grid" id="participant-video-grid">
        <!-- Local User Video Tile -->
        <div class="video-tile local-tile" id="tile-local">
          <video id="local-video-feed" autoplay playsinline muted class="video-feed mirror"></video>
          <div class="video-avatar-fallback" id="local-avatar-fallback">
            <div class="avatar-circle">${esc(currentUserName.slice(0, 2).toUpperCase())}</div>
            <span class="avatar-name">${esc(currentUserName)} (You)</span>
          </div>
          <div class="tile-bar">
            <span class="tile-name">${esc(currentUserName)} (You)</span>
            <div class="tile-icons">
              <span id="local-mic-icon" class="status-icon">🎤</span>
              <span id="local-cam-icon" class="status-icon">📹</span>
            </div>
          </div>
          <div class="speaking-glow" id="local-speaking-glow"></div>
        </div>
      </div>
    </div>

    <!-- Intelligence & Transcript Side Drawer -->
    <aside class="intel-panel" id="intel-panel">
      <div class="intel-tabs">
        <button class="intel-tab active" onclick="switchIntelTab('transcript')">Live Transcript</button>
        <button class="intel-tab" onclick="switchIntelTab('notes')">AI Notes</button>
        <button class="intel-tab" onclick="switchIntelTab('chat')">Chat</button>
      </div>

      <!-- Transcript Tab Content -->
      <div class="intel-content active" id="tab-transcript">
        <div class="transcript-stream" id="transcript-feed" aria-live="polite">
          <div class="transcript-placeholder" id="transcript-empty-state">
            Transcription active. Spoken conversation will appear here in real time.
          </div>
        </div>
      </div>

      <!-- Live AI Notes Tab Content -->
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

      <!-- Meeting Chat Tab Content -->
      <div class="intel-content" id="tab-chat">
        <div class="chat-stream" id="chat-feed"></div>
        <form class="chat-input-bar" onsubmit="sendChatMessage(event)">
          <input type="text" id="chat-input-text" placeholder="Send a message to everyone..." autocomplete="off">
          <button type="submit" class="btn btn-primary btn-sm">Send</button>
        </form>
      </div>
    </aside>
  </div>

  <!-- Bottom Toolbar Controls -->
  <footer class="meeting-toolbar">
    <div class="toolbar-left">
      <button type="button" class="tool-btn" id="btn-toggle-audio" onclick="toggleAudio()" title="Mute / Unmute (Cmd+D)">
        <span class="btn-icon">🎤</span>
        <span class="btn-label" id="lbl-audio">Mute</span>
      </button>
      <button type="button" class="tool-btn" id="btn-toggle-video" onclick="toggleVideo()" title="Camera On / Off (Cmd+E)">
        <span class="btn-icon">📹</span>
        <span class="btn-label" id="lbl-video">Stop Video</span>
      </button>
      <button type="button" class="tool-btn" id="btn-device-settings" onclick="openDeviceSettingsModal()" title="Audio & Video Settings">
        <span class="btn-icon">⚙️</span>
      </button>
    </div>

    <div class="toolbar-center">
      <button type="button" class="tool-btn" id="btn-share-screen" onclick="toggleScreenShare()" title="Share Screen">
        <span class="btn-icon">🖥️</span>
        <span class="btn-label">Share Screen</span>
      </button>
      <button type="button" class="tool-btn" id="btn-toggle-rec" onclick="toggleRecording()" title="Start / Stop Recording">
        <span class="btn-icon">🔴</span>
        <span class="btn-label" id="lbl-recording">${meeting.recordingEnabled ? 'Stop Rec' : 'Record'}</span>
      </button>
      <button type="button" class="tool-btn" id="btn-participants" onclick="toggleParticipantsModal()" title="View Participants">
        <span class="btn-icon">👥</span>
        <span class="btn-label">Participants (<span id="participant-count-badge">1</span>)</span>
      </button>
    </div>

    <div class="toolbar-right">
      <button type="button" class="btn btn-danger" id="btn-leave-meeting" onclick="confirmLeaveOrEnd()">
        ${isHost ? 'End Meeting' : 'Leave Meeting'}
      </button>
    </div>
  </footer>

  <!-- Device Selection Modal -->
  <div class="meeting-modal" id="device-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>Device Settings</h3>
        <button class="modal-close" onclick="closeDeviceSettingsModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="select-mic">Microphone</label>
          <select id="select-mic" class="form-select" onchange="changeAudioInput(this.value)"></select>
        </div>
        <div class="form-group">
          <label for="select-cam">Camera</label>
          <select id="select-cam" class="form-select" onchange="changeVideoInput(this.value)"></select>
        </div>
        <div class="form-group">
          <label for="select-speaker">Speaker / Audio Output</label>
          <select id="select-speaker" class="form-select" onchange="changeAudioOutput(this.value)"></select>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" onclick="closeDeviceSettingsModal()">Done</button>
      </div>
    </div>
  </div>
</div>

<!-- Embedded WebRTC & Realtime Logic -->
<script>
(() => {
  const meetingId = "${esc(meeting.id)}";
  const userId = "${esc(currentUserId)}";
  const userName = "${esc(currentUserName)}";
  const isHost = ${isHost};
  const home = "${esc(home)}";

  let localStream = null;
  let screenStream = null;
  let ws = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = ${meeting.recordingEnabled ? 'true' : 'false'};
  let audioMuted = false;
  let videoMuted = false;
  let screenSharing = false;
  let meetingStartTime = Date.now();
  const peerConnections = new Map(); // peerId -> RTCPeerConnection
  const remoteStreams = new Map(); // peerId -> MediaStream

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // 1. Initialize User Media
  async function initMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const localVideo = document.getElementById('local-video-feed');
      if (localVideo) {
        localVideo.srcObject = localStream;
      }
      document.getElementById('local-avatar-fallback').style.display = 'none';
      await enumerateDevices();
      initSpeechRecognitionOrSTT();
    } catch (err) {
      console.warn('Camera/mic permission denied or unavailable:', err);
      // Create fallback silence/canvas stream if hardware is absent
      document.getElementById('local-avatar-fallback').style.display = 'grid';
      document.getElementById('local-video-feed').style.display = 'none';
      document.getElementById('lbl-video').textContent = 'Video Off';
      videoMuted = true;
    }
    connectSignaling();
  }

  // 2. Connect WebSocket Signaling
  function connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + home + 'api/meetings/signal?meetingId=' + encodeURIComponent(meetingId) + '&userId=' + encodeURIComponent(userId) + '&name=' + encodeURIComponent(userName) + '&role=' + (isHost ? 'host' : 'participant');
    
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('WebSocket connection failed:', e);
      return;
    }

    ws.onopen = () => {
      document.getElementById('conn-status-indicator').className = 'conn-status-pill connected';
      document.getElementById('conn-status-text').textContent = 'Connected';
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessage(msg);
      } catch (e) {
        console.error('Signaling parse error:', e);
      }
    };

    ws.onclose = () => {
      document.getElementById('conn-status-indicator').className = 'conn-status-pill disconnected';
      document.getElementById('conn-status-text').textContent = 'Reconnecting...';
      setTimeout(connectSignaling, 3000);
    };

    ws.onerror = (err) => {
      console.error('Signaling socket error:', err);
    };
  }

  // 3. Signaling Message Dispatcher
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        for (const peer of (msg.payload.existingPeers || [])) {
          createPeerConnection(peer.peerId, peer.displayName, true);
        }
        updateParticipantCount();
        break;

      case 'peer-joined':
        createPeerConnection(msg.payload.peerId, msg.payload.displayName, false);
        updateParticipantCount();
        addChatMessage('System', msg.payload.displayName + ' joined the meeting.');
        break;

      case 'peer-left':
        removePeerConnection(msg.payload.peerId);
        updateParticipantCount();
        addChatMessage('System', 'A participant left the meeting.');
        break;

      case 'offer':
        await handleOffer(msg.senderId, msg.senderName, msg.payload);
        break;

      case 'answer':
        await handleAnswer(msg.senderId, msg.payload);
        break;

      case 'ice-candidate':
        await handleIceCandidate(msg.senderId, msg.payload);
        break;

      case 'media-state':
        updatePeerMediaState(msg.senderId, msg.payload);
        break;

      case 'recording-state':
        isRecording = Boolean(msg.payload.isRecording);
        updateRecordingUI();
        break;

      case 'chat-message':
        addChatMessage(msg.senderName, msg.payload.text);
        break;

      case 'live-transcript':
        renderTranscriptSegment(msg.payload);
        break;
    }
  }

  // 4. WebRTC Peer Connection Management
  function createPeerConnection(peerId, peerName, isInitiator) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(peerId, pc);

    // Add local media tracks
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice-candidate',
          meetingId,
          targetId: peerId,
          payload: event.candidate
        }));
      }
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      remoteStreams.set(peerId, remoteStream);
      renderRemotePeerTile(peerId, peerName, remoteStream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // ICE restart attempt
        if (isInitiator) {
          pc.createOffer({ iceRestart: true }).then((offer) => pc.setLocalDescription(offer)).then(() => {
            ws.send(JSON.stringify({ type: 'offer', meetingId, targetId: peerId, payload: pc.localDescription }));
          }).catch(console.error);
        }
      }
    };

    if (isInitiator) {
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
        ws.send(JSON.stringify({
          type: 'offer',
          meetingId,
          targetId: peerId,
          payload: pc.localDescription
        }));
      }).catch(console.error);
    }

    return pc;
  }

  async function handleOffer(peerId, peerName, offer) {
    const pc = createPeerConnection(peerId, peerName, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({
      type: 'answer',
      meetingId,
      targetId: peerId,
      payload: pc.localDescription
    }));
  }

  async function handleAnswer(peerId, answer) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async function handleIceCandidate(peerId, candidate) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Error adding ICE candidate:', e);
      }
    }
  }

  function removePeerConnection(peerId) {
    if (peerConnections.has(peerId)) {
      peerConnections.get(peerId).close();
      peerConnections.delete(peerId);
    }
    remoteStreams.delete(peerId);
    const tile = document.getElementById('tile-' + peerId);
    if (tile) tile.remove();
  }

  function renderRemotePeerTile(peerId, peerName, stream) {
    let tile = document.getElementById('tile-' + peerId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + peerId;
      tile.innerHTML = '<video id="video-' + peerId + '" autoplay playsinline class="video-feed"></video>' +
        '<div class="tile-bar"><span class="tile-name">' + (peerName || 'Participant') + '</span>' +
        '<div class="tile-icons"><span id="mic-' + peerId + '">🎤</span><span id="cam-' + peerId + '">📹</span></div></div>';
      document.getElementById('participant-video-grid').appendChild(tile);
    }
    const vid = document.getElementById('video-' + peerId);
    if (vid) vid.srcObject = stream;
  }

  function updatePeerMediaState(peerId, state) {
    const micIcon = document.getElementById('mic-' + peerId);
    const camIcon = document.getElementById('cam-' + peerId);
    if (micIcon && typeof state.audioMuted === 'boolean') {
      micIcon.textContent = state.audioMuted ? '🔇' : '🎤';
      micIcon.style.opacity = state.audioMuted ? '0.5' : '1';
    }
    if (camIcon && typeof state.videoMuted === 'boolean') {
      camIcon.textContent = state.videoMuted ? '🚫' : '📹';
      camIcon.style.opacity = state.videoMuted ? '0.5' : '1';
    }
  }

  // 5. Media Controls (Audio, Video, Screen)
  window.toggleAudio = function() {
    audioMuted = !audioMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => (t.enabled = !audioMuted));
    }
    document.getElementById('lbl-audio').textContent = audioMuted ? 'Unmute' : 'Mute';
    document.getElementById('local-mic-icon').textContent = audioMuted ? '🔇' : '🎤';
    document.getElementById('btn-toggle-audio').classList.toggle('muted', audioMuted);
    broadcastMediaState();
  };

  window.toggleVideo = function() {
    videoMuted = !videoMuted;
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => (t.enabled = !videoMuted));
    }
    document.getElementById('lbl-video').textContent = videoMuted ? 'Start Video' : 'Stop Video';
    document.getElementById('local-cam-icon').textContent = videoMuted ? '🚫' : '📹';
    document.getElementById('local-avatar-fallback').style.display = videoMuted ? 'grid' : 'none';
    document.getElementById('local-video-feed').style.display = videoMuted ? 'none' : 'block';
    broadcastMediaState();
  };

  window.toggleScreenShare = async function() {
    if (!screenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        screenSharing = true;
        document.getElementById('btn-share-screen').classList.add('active');

        // Replace video track in peer connections
        for (const pc of peerConnections.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }

        screenTrack.onended = () => {
          stopScreenShare();
        };
      } catch (err) {
        console.warn('Screen share cancelled/denied:', err);
      }
    } else {
      stopScreenShare();
    }
    broadcastMediaState();
  };

  function stopScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    screenSharing = false;
    document.getElementById('btn-share-screen').classList.remove('active');
    // Restore camera track
    if (localStream) {
      const camTrack = localStream.getVideoTracks()[0];
      for (const pc of peerConnections.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender && camTrack) sender.replaceTrack(camTrack);
      }
    }
    broadcastMediaState();
  }

  function broadcastMediaState() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media-state',
        meetingId,
        payload: { audioMuted, videoMuted, screenSharing }
      }));
    }
  }

  // 6. Recording Controls
  window.toggleRecording = async function() {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  };

  function startRecording() {
    if (!localStream) return;
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    } catch {
      mediaRecorder = new MediaRecorder(localStream);
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      // Upload recording to server
      const formData = new FormData();
      formData.append('recording', blob, 'meeting_' + meetingId + '.webm');
      formData.append('durationSeconds', Math.round((Date.now() - meetingStartTime) / 1000));
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/recording', {
        method: 'POST',
        body: formData
      }).catch(console.error);
    };

    mediaRecorder.start(3000); // 3s time slices
    isRecording = true;
    updateRecordingUI();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'recording-state',
        meetingId,
        payload: { isRecording: true }
      }));
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    updateRecordingUI();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'recording-state',
        meetingId,
        payload: { isRecording: false }
      }));
    }
  }

  function updateRecordingUI() {
    const badge = document.getElementById('recording-status-badge');
    const txt = document.getElementById('recording-status-text');
    const lbl = document.getElementById('lbl-recording');
    badge.className = 'recording-badge ' + (isRecording ? 'active' : '');
    txt.textContent = isRecording ? 'Recording' : 'Not Recording';
    lbl.textContent = isRecording ? 'Stop Rec' : 'Record';
  }

  // 7. Speech-To-Text / Live Transcription
  function initSpeechRecognitionOrSTT() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            const text = event.results[i][0].transcript.trim();
            if (text) {
              const segment = {
                speakerId: userId,
                speakerName: userName,
                startTime: Math.round((Date.now() - meetingStartTime) / 1000),
                endTime: Math.round((Date.now() - meetingStartTime) / 1000) + 3,
                text,
                confidence: event.results[i][0].confidence || 0.95
              };
              // Send live segment to room via signaling
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'live-transcript',
                  meetingId,
                  payload: segment
                }));
              }
              renderTranscriptSegment(segment);
              // Ingest to server DB
              fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/transcript', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(segment)
              }).catch(console.error);
            }
          }
        }
      };

      recognition.onerror = (e) => {
        console.warn('Speech recognition error:', e);
      };

      recognition.onend = () => {
        if (!audioMuted && recognition) {
          try { recognition.start(); } catch {}
        }
      };

      try { recognition.start(); } catch {}
    }
  }

  function renderTranscriptSegment(seg) {
    const emptyState = document.getElementById('transcript-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const feed = document.getElementById('transcript-feed');
    const row = document.createElement('div');
    row.className = 'transcript-entry';
    const m = Math.floor(seg.startTime / 60).toString().padStart(2, '0');
    const s = Math.floor(seg.startTime % 60).toString().padStart(2, '0');
    row.innerHTML = '<div class="transcript-meta"><span class="transcript-speaker">' + esc(seg.speakerName) + '</span><span class="transcript-time">' + m + ':' + s + '</span></div><div class="transcript-body">' + esc(seg.text) + '</div>';
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;

    // Quick heuristic update to live notes preview
    updateLiveNotesFromText(seg.speakerName, seg.text);
  }

  function updateLiveNotesFromText(speaker, text) {
    if (/\blaunch|decided|target\b/i.test(text)) {
      const list = document.getElementById('live-decisions-list');
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    }
    if (/\bwill handle|will deploy|prepare|implement\b/i.test(text)) {
      const list = document.getElementById('live-actions-list');
      const li = document.createElement('li');
      li.textContent = speaker + ' — ' + text;
      list.appendChild(li);
    }
  }

  // 8. In-Meeting Chat
  window.sendChatMessage = function(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input-text');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addChatMessage(userName, text);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chat-message',
        meetingId,
        payload: { text }
      }));
    }
  };

  function addChatMessage(author, text) {
    const feed = document.getElementById('chat-feed');
    const div = document.createElement('div');
    div.className = 'chat-entry';
    div.innerHTML = '<span class="chat-author">' + esc(author) + ':</span> <span class="chat-text">' + esc(text) + '</span>';
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  // 9. Duration Clock
  setInterval(() => {
    const sec = Math.floor((Date.now() - meetingStartTime) / 1000);
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    const el = document.getElementById('meeting-duration-clock');
    if (el) el.textContent = m + ':' + s;
  }, 1000);

  // 10. Device Enumeration
  async function enumerateDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = document.getElementById('select-mic');
    const camSelect = document.getElementById('select-cam');
    const spkSelect = document.getElementById('select-speaker');

    micSelect.innerHTML = '';
    camSelect.innerHTML = '';
    spkSelect.innerHTML = '';

    devices.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || (d.kind + ' (' + d.deviceId.slice(0, 5) + ')');
      if (d.kind === 'audioinput') micSelect.appendChild(opt);
      else if (d.kind === 'videoinput') camSelect.appendChild(opt);
      else if (d.kind === 'audiooutput') spkSelect.appendChild(opt);
    });
  }

  window.openDeviceSettingsModal = () => (document.getElementById('device-modal').style.display = 'grid');
  window.closeDeviceSettingsModal = () => (document.getElementById('device-modal').style.display = 'none');
  window.toggleIntelPanel = () => document.getElementById('intel-panel').classList.toggle('collapsed');

  window.switchIntelTab = (tab) => {
    document.querySelectorAll('.intel-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.intel-content').forEach((c) => c.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  };

  function updateParticipantCount() {
    const count = peerConnections.size + 1;
    document.getElementById('participant-count-badge').textContent = count;
  }

  window.confirmLeaveOrEnd = async () => {
    const action = isHost ? 'End meeting for all participants?' : 'Leave meeting?';
    if (!confirm(action)) return;

    if (isRecording) stopRecording();

    if (isHost) {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/end', { method: 'POST' });
      window.location.href = home + 'console/meetings/detail?id=' + encodeURIComponent(meetingId);
    } else {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/leave', { method: 'POST' });
      window.location.href = home + 'console/meetings';
    }
  };

  // Run on start
  initMedia();
})();
</script>

<style>
/* Modern Vital Meeting Room Styling */
.meeting-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: #0A0F14;
  color: #E2E8F0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
.meeting-header {
  height: 56px;
  background: #0F172A;
  border-bottom: 1px solid #1E293B;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}
.meeting-title-cluster {
  display: flex;
  align-items: center;
  gap: 12px;
}
.meeting-back-btn {
  font-size: 18px;
  color: #94A3B8;
  padding: 4px 8px;
  border-radius: 6px;
  text-decoration: none;
}
.meeting-back-btn:hover { background: #1E293B; color: #fff; }
.meeting-title {
  font-size: 14px;
  font-weight: 600;
  color: #F8FAFC;
  margin: 0;
}
.meeting-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #64748B;
}
.badge-scope {
  background: #0F5C57;
  color: #5EEAD4;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}
.conn-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}
.conn-status-pill.connected .status-dot { width: 6px; height: 6px; background: #10B981; border-radius: 50%; }
.conn-status-pill.disconnected .status-dot { width: 6px; height: 6px; background: #EF4444; border-radius: 50%; }
.recording-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 20px;
  background: #1E293B;
  color: #64748B;
}
.recording-badge.active {
  background: rgba(239, 68, 68, 0.2);
  color: #EF4444;
  font-weight: 600;
}
.recording-badge.active .rec-dot {
  width: 8px;
  height: 8px;
  background: #EF4444;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}
@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }

.meeting-main-area {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}
.meeting-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: #05080C;
  overflow: hidden;
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  width: 100%;
  height: 100%;
  max-width: 1400px;
  max-height: 900px;
  align-content: center;
}
.video-tile {
  background: #111827;
  border-radius: 12px;
  border: 1px solid #1F2937;
  overflow: hidden;
  position: relative;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-feed {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.video-feed.mirror { transform: scaleX(-1); }
.video-avatar-fallback {
  display: grid;
  place-items: center;
  gap: 8px;
}
.avatar-circle {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: #0F5C57;
  color: #5EEAD4;
  font-size: 24px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.avatar-name { font-size: 13px; color: #94A3B8; }
.tile-bar {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(15, 23, 42, 0.75);
  backdrop-filter: blur(4px);
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
}
.speaking-glow {
  position: absolute;
  inset: 0;
  border: 2px solid #10B981;
  border-radius: 12px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}

/* Intelligence Panel */
.intel-panel {
  width: 380px;
  background: #0B111A;
  border-left: 1px solid #1E293B;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: transform 0.2s, width 0.2s;
}
.intel-panel.collapsed { width: 0; overflow: hidden; border: none; }
.intel-tabs {
  display: flex;
  border-bottom: 1px solid #1E293B;
  background: #0E1624;
}
.intel-tab {
  flex: 1;
  background: none;
  border: none;
  color: #94A3B8;
  padding: 10px 0;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.intel-tab.active {
  color: #5EEAD4;
  border-bottom: 2px solid #0F5C57;
  font-weight: 600;
}
.intel-content {
  display: none;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  flex-direction: column;
}
.intel-content.active { display: flex; }
.transcript-stream {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.transcript-placeholder {
  color: #64748B;
  font-size: 12px;
  text-align: center;
  margin-top: 40px;
}
.transcript-entry {
  background: #111B27;
  border: 1px solid #1E2B3C;
  border-radius: 8px;
  padding: 8px 10px;
}
.transcript-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #5EEAD4;
  margin-bottom: 4px;
}
.transcript-body { font-size: 12.5px; color: #F1F5F9; line-height: 1.4; }
.notes-section { padding: 12px; border-bottom: 1px solid #1E293B; }
.notes-heading { font-size: 11px; text-transform: uppercase; color: #64748B; margin-bottom: 6px; }
.notes-list { list-style: disc inside; font-size: 12px; color: #E2E8F0; }
.notes-muted { list-style: none; color: #64748B; font-style: italic; }

.meeting-toolbar {
  height: 64px;
  background: #0F172A;
  border-top: 1px solid #1E293B;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  flex-shrink: 0;
}
.toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 8px; }
.tool-btn {
  background: #1E293B;
  border: 1px solid #334155;
  color: #F8FAFC;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 60px;
}
.tool-btn:hover { background: #334155; }
.tool-btn.muted { background: rgba(239, 68, 68, 0.2); border-color: #EF4444; color: #FCA5A5; }
.tool-btn.active { background: #0F5C57; border-color: #5EEAD4; color: #fff; }
.btn { padding: 8px 16px; border-radius: 6px; font-weight: 500; font-size: 13px; cursor: pointer; border: none; }
.btn-primary { background: #0F5C57; color: #fff; }
.btn-secondary { background: #1E293B; color: #E2E8F0; border: 1px solid #334155; }
.btn-danger { background: #DC2626; color: #fff; }
.meeting-modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  display: grid;
  place-items: center;
  z-index: 999;
}
.modal-card {
  width: 440px;
  background: #0F172A;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 20px;
  color: #F8FAFC;
}
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.modal-close { background: none; border: none; color: #94A3B8; font-size: 16px; cursor: pointer; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; margin-bottom: 4px; color: #94A3B8; }
.form-select { width: 100%; background: #1E293B; border: 1px solid #334155; color: #F8FAFC; padding: 8px; border-radius: 6px; }
</style>
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
}): string {
  const { meeting, notes, transcript, recording, participants, home } = opts;
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
          ${(notes?.decisions || [])
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
            .join('') || '<span class="text-muted">No explicit decisions recorded in this meeting.</span>'}
        </div>
      </section>

      <!-- Action Items -->
      <section class="intel-card">
        <h2 class="card-heading">Action Items</h2>
        <div class="actions-list">
          ${(notes?.actionItems || [])
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
            .join('') || '<span class="text-muted">No action items assigned.</span>'}
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
          <div class="rag-system-msg">Ask any question. Answers are synthesized using semantic RAG over meeting chunks with cited timestamps.</div>
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
          ${transcript
            .map(
              (s) => `
            <div class="transcript-segment-row" id="ts-${formatTimestamp(s.startTime)}" data-start="${s.startTime}" onclick="seekAudio('${formatTimestamp(s.startTime)}')">
              <span class="seg-time">${formatTimestamp(s.startTime)}</span>
              <span class="seg-speaker">${esc(s.speakerName)}</span>
              <span class="seg-text">${esc(s.text)}</span>
            </div>
          `,
            )
            .join('') || '<div class="text-muted" style="padding:20px;text-align:center;">No transcript segments available.</div>'}
        </div>
      </section>
    </div>
  </div>
</div>

<script>
(() => {
  const meetingId = "${esc(meeting.id)}";
  const home = "${esc(home)}";

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
        headers: { 'Content-Type': 'application/json' },
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
    await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/delete', { method: 'POST' });
    window.location.href = home + 'console/meetings';
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
</script>

<style>
.meeting-detail-view {
  padding: 24px 32px;
  background: #F8FAFC;
  min-height: 100%;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  color: #1E293B;
}
.detail-header-card {
  background: #FFFFFF;
  border-radius: 12px;
  border: 1px solid #E2E8F0;
  padding: 20px 24px;
  margin-bottom: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.detail-title-row { display: flex; justify-content: space-between; align-items: flex-start; }
.back-link { font-size: 13px; color: #64748B; text-decoration: none; margin-bottom: 6px; display: inline-block; }
.back-link:hover { color: #0F5C57; }
.detail-title { font-size: 22px; font-weight: 700; color: #0F172A; margin: 4px 0 8px; }
.detail-meta { display: flex; align-items: center; gap: 14px; font-size: 13px; color: #64748B; }
.processing-strip {
  display: flex;
  gap: 16px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #F1F5F9;
}
.pipeline-step { font-size: 12px; font-weight: 500; color: #94A3B8; }
.pipeline-step.done { color: #0F766E; font-weight: 600; }
.pipeline-step.active { color: #D97706; font-weight: 600; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.intel-card {
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
}
.card-heading {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748B;
  margin-bottom: 12px;
}
.summary-text { font-size: 14px; line-height: 1.6; color: #334155; }
.topic-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.topic-pill {
  background: #F1F5F9;
  border: 1px solid #E2E8F0;
  color: #475569;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}
.decision-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #F8FAFC;
}
.decision-check { color: #059669; font-weight: 700; font-size: 16px; }
.decision-text { font-size: 13.5px; font-weight: 500; color: #1E293B; }
.source-timestamp { font-size: 11px; color: #0F5C57; text-decoration: none; margin-top: 2px; display: inline-block; }
.source-timestamp:hover { text-decoration: underline; }

.action-item { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #F8FAFC; align-items: flex-start; }
.action-task { font-size: 13.5px; font-weight: 500; color: #1E293B; }
.action-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 11px; }
.owner-pill { background: #E0F2FE; color: #0369A1; padding: 2px 8px; border-radius: 4px; }
.deadline-pill { background: #FEF3C7; color: #B45309; padding: 2px 8px; border-radius: 4px; }

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
.rag-system-msg { font-size: 12px; color: #64748B; font-style: italic; }
.rag-msg { padding: 8px 12px; border-radius: 8px; font-size: 13px; max-width: 85%; }
.user-msg { background: #0F5C57; color: #fff; align-self: flex-end; }
.ai-msg { background: #F1F5F9; color: #1E293B; align-self: flex-start; border: 1px solid #E2E8F0; }
.ai-sources-cluster { margin-top: 6px; font-size: 11px; color: #64748B; }
.source-chip { background: #E2E8F0; padding: 2px 6px; border-radius: 4px; color: #0F5C57; text-decoration: none; }
.rag-input-form { display: flex; gap: 8px; }
.rag-input { flex: 1; border: 1px solid #CBD5E1; border-radius: 6px; padding: 8px 12px; font-size: 13px; outline: none; }

/* Transcript Card */
.transcript-card { max-height: 480px; display: flex; flex-direction: column; }
.transcript-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.search-filter-input { border: 1px solid #CBD5E1; border-radius: 6px; padding: 4px 10px; font-size: 12px; width: 180px; }
.full-transcript-stream { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.transcript-segment-row {
  display: flex;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.transcript-segment-row:hover { background: #F1F5F9; }
.seg-time { font-size: 11px; font-family: monospace; color: #64748B; width: 44px; flex-shrink: 0; }
.seg-speaker { font-weight: 600; color: #0F5C57; width: 120px; flex-shrink: 0; }
.seg-text { color: #334155; flex: 1; }
</style>
`;
}

// ------------------------------------------------------------- 3. Meeting Library List ----

export function renderMeetingLibraryView(opts: {
  meetings: Meeting[];
  home: string;
}): string {
  const { meetings, home } = opts;

  return `
<div class="meeting-library-view">
  <div class="library-top-bar">
    <div>
      <h1 class="library-heading">Meeting Intelligence</h1>
      <p class="library-sub">All WebRTC recorded sessions, live transcripts, and grounded meeting knowledge.</p>
    </div>
    <div class="library-actions">
      <button type="button" class="btn btn-primary" onclick="document.getElementById('new-meeting-modal').style.display='grid'">
        + New Meeting
      </button>
    </div>
  </div>

  <div class="library-search-strip">
    <input type="text" id="lib-search" class="lib-search-box" placeholder="Search meetings by title or host..." oninput="filterMeetings(this.value)">
  </div>

  <div class="meetings-grid" id="meetings-list-grid">
    ${
      meetings.length === 0
        ? `
      <div class="empty-state-card">
        <span class="empty-icon">🎙️</span>
        <h3>No meetings yet</h3>
        <p>Start a new WebRTC meeting to record audio/video and capture AI-powered intelligence.</p>
        <button type="button" class="btn btn-primary btn-sm" onclick="document.getElementById('new-meeting-modal').style.display='grid'">Create First Meeting</button>
      </div>
    `
        : meetings
            .map(
              (m) => `
      <div class="meeting-card" data-title="${esc(m.title)}" data-host="${esc(m.hostName)}">
        <div class="mcard-top">
          <span class="badge ${m.status === 'ACTIVE' ? 'badge-live' : 'badge-ended'}">${esc(m.status)}</span>
          <span class="mcard-scope">#${esc(m.scope)}</span>
        </div>
        <h3 class="mcard-title">${esc(m.title)}</h3>
        <div class="mcard-meta">
          <span>👤 ${esc(m.hostName)}</span>
          <span>📅 ${esc(new Date(m.createdAt).toLocaleDateString())}</span>
          <span>⏱️ ${Math.round(m.durationSeconds / 60)}m</span>
        </div>
        <div class="mcard-footer">
          ${
            m.status === 'ACTIVE'
              ? `<a href="${esc(home)}console/meetings/room?id=${esc(m.id)}" class="btn btn-primary btn-sm">Join Room</a>`
              : `<a href="${esc(home)}console/meetings/detail?id=${esc(m.id)}" class="btn btn-secondary btn-sm">View Intelligence</a>`
          }
        </div>
      </div>
    `,
            )
            .join('')
    }
  </div>

  <!-- New Meeting Modal -->
  <div class="meeting-modal" id="new-meeting-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>Create New Meeting</h3>
        <button class="modal-close" onclick="document.getElementById('new-meeting-modal').style.display='none'">✕</button>
      </div>
      <form action="${esc(home)}api/meetings/create" method="POST">
        <div class="form-group">
          <label for="meeting-title-input">Meeting Title</label>
          <input type="text" id="meeting-title-input" name="title" class="form-select" placeholder="e.g. Weekly Product Sync" required>
        </div>
        <div class="form-group">
          <label for="meeting-scope-input">Room / Department Scope</label>
          <select id="meeting-scope-input" name="scope" class="form-select">
            <option value="general">general</option>
            <option value="engineering">engineering</option>
            <option value="product">product</option>
            <option value="infra">infra</option>
            <option value="finance">finance</option>
            <option value="exec">exec</option>
          </select>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="meeting-rec-input" name="recordingEnabled" value="1" checked>
          <label for="meeting-rec-input" style="margin:0;">Enable recording and live transcription</label>
        </div>
        <div class="modal-footer" style="margin-top:20px;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('new-meeting-modal').style.display='none'">Cancel</button>
          <button type="submit" class="btn btn-primary">Start Meeting</button>
        </div>
      </form>
    </div>
  </div>
</div>

<script>
function filterMeetings(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('.meeting-card').forEach((card) => {
    const title = card.getAttribute('data-title').toLowerCase();
    const host = card.getAttribute('data-host').toLowerCase();
    card.style.display = (title.includes(q) || host.includes(q)) ? 'flex' : 'none';
  });
}
</script>

<style>
.meeting-library-view {
  padding: 28px 36px;
  background: #F8FAFC;
  min-height: 100%;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  color: #1E293B;
}
.library-top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.library-heading { font-size: 24px; font-weight: 700; color: #0F172A; }
.library-sub { font-size: 13.5px; color: #64748B; margin-top: 4px; }
.library-search-strip { margin-bottom: 24px; }
.lib-search-box {
  width: 100%;
  max-width: 480px;
  padding: 10px 14px;
  border: 1px solid #CBD5E1;
  border-radius: 8px;
  font-size: 13.5px;
  outline: none;
  background: #FFFFFF;
}
.meetings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}
.meeting-card {
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-radius: 12px;
  padding: 18px 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.mcard-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.badge-live { background: rgba(16, 185, 129, 0.15); color: #059669; font-weight: 600; padding: 2px 8px; border-radius: 12px; font-size: 11px; }
.badge-ended { background: #F1F5F9; color: #64748B; font-weight: 500; padding: 2px 8px; border-radius: 12px; font-size: 11px; }
.mcard-scope { font-size: 11.5px; font-weight: 500; color: #0F5C57; }
.mcard-title { font-size: 16px; font-weight: 600; color: #0F172A; margin: 4px 0 10px; }
.mcard-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: #64748B; margin-bottom: 16px; }
.mcard-footer { display: flex; justify-content: flex-end; }
.empty-state-card {
  grid-column: 1 / -1;
  text-align: center;
  padding: 60px 20px;
  background: #FFFFFF;
  border: 1px dashed #CBD5E1;
  border-radius: 12px;
}
.empty-icon { font-size: 36px; margin-bottom: 12px; display: inline-block; }
</style>
`;
}
