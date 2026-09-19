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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>${esc(meeting.title)} — Vital Meeting</title>
  <meta name="vital-csrf" content="">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📹</text></svg>">
</head>
<body>
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
        <button class="intel-tab active" onclick="switchIntelTab('transcript', this)">Live Transcript</button>
        <button class="intel-tab" onclick="switchIntelTab('notes', this)">AI Notes</button>
        <button class="intel-tab" onclick="switchIntelTab('chat', this)">Chat</button>
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
        <button type="button" class="modal-close" onclick="closeDeviceSettingsModal()">✕</button>
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

  <!-- Participants Modal -->
  <div class="meeting-modal" id="participants-modal" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>Participants (<span id="modal-participant-count">1</span>)</h3>
        <button type="button" class="modal-close" onclick="toggleParticipantsModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="share-link-box">
          <label>Meeting Room Link</label>
          <div class="input-copy-group">
            <input type="text" id="meeting-share-url" readonly value="">
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyMeetingLink()">Copy</button>
          </div>
          <span class="copied-indicator" id="copied-notice" style="display:none;">Copied to clipboard!</span>
        </div>
        <div class="participants-list-wrap">
          <ul class="participants-list" id="modal-participants-list">
          </ul>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" onclick="toggleParticipantsModal()">Close</button>
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
  const csrfToken = document.querySelector('meta[name="vital-csrf"]')?.getAttribute('content') || '';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

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
  const iceCandidateQueues = new Map(); // peerId -> RTCIceCandidateInit[]
  const peerDisplayNames = new Map(); // peerId -> string

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // 1. Initialize User Media with robust fallback
  async function initMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    } catch (err) {
      console.warn('[webrtc] Audio+video getUserMedia failed, trying audio-only:', err);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        videoMuted = true;
      } catch (err2) {
        console.warn('[webrtc] Audio-only getUserMedia failed, running in listen/avatar mode:', err2);
        localStream = new MediaStream();
        audioMuted = true;
        videoMuted = true;
      }
    }

    const localVideo = document.getElementById('local-video-feed');
    const localAvatar = document.getElementById('local-avatar-fallback');
    const hasLiveVideo = localStream && localStream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

    if (localVideo && hasLiveVideo) {
      localVideo.srcObject = localStream;
      localVideo.style.display = 'block';
      if (localAvatar) localAvatar.style.display = 'none';
    } else {
      if (localVideo) localVideo.style.display = 'none';
      if (localAvatar) localAvatar.style.display = 'grid';
      const lbl = document.getElementById('lbl-video');
      if (lbl) lbl.textContent = 'Start Video';
      const camIcon = document.getElementById('local-cam-icon');
      if (camIcon) camIcon.textContent = '🚫';
    }

    if (localStream && localStream.getAudioTracks().length > 0) {
      setupAudioMeter(localStream, 'local-speaking-glow');
      initSpeechRecognitionOrSTT();
    }

    await enumerateDevices().catch(() => {});
    connectSignaling();
  }

  // 2. Connect WebSocket Signaling
  function connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + home + 'api/meetings/signal?meetingId=' + encodeURIComponent(meetingId) + '&userId=' + encodeURIComponent(userId) + '&name=' + encodeURIComponent(userName) + '&role=' + (isHost ? 'host' : 'participant');

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[webrtc] WebSocket initialization failed:', e);
      return;
    }

    ws.onopen = () => {
      const pill = document.getElementById('conn-status-indicator');
      if (pill) pill.className = 'conn-status-pill connected';
      const txt = document.getElementById('conn-status-text');
      if (txt) txt.textContent = 'Connected';
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleSignalingMessage(msg);
      } catch (e) {
        console.error('[webrtc] Signaling parse error:', e);
      }
    };

    ws.onclose = () => {
      const pill = document.getElementById('conn-status-indicator');
      if (pill) pill.className = 'conn-status-pill disconnected';
      const txt = document.getElementById('conn-status-text');
      if (txt) txt.textContent = 'Reconnecting...';
      setTimeout(connectSignaling, 3000);
    };

    ws.onerror = (err) => {
      console.error('[webrtc] Signaling socket error:', err);
    };
  }

  // 3. Signaling Message Dispatcher
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        for (const peer of (msg.payload.existingPeers || [])) {
          peerDisplayNames.set(peer.peerId, peer.displayName);
          createPeerConnection(peer.peerId, peer.displayName, true);
        }
        updateParticipantCount();
        break;

      case 'peer-joined':
        peerDisplayNames.set(msg.payload.peerId, msg.payload.displayName);
        createPeerConnection(msg.payload.peerId, msg.payload.displayName, false);
        updateParticipantCount();
        addChatMessage('System', msg.payload.displayName + ' joined the meeting.');
        break;

      case 'peer-left':
        const departedName = peerDisplayNames.get(msg.payload.peerId) || msg.senderName || 'A participant';
        removePeerConnection(msg.payload.peerId);
        updateParticipantCount();
        addChatMessage('System', departedName + ' left the meeting.');
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

      case 'meeting-ended':
        if (!isHost) {
          alert('The host has concluded this meeting. Redirecting to summary & review...');
          window.location.href = home + 'console/meetings/detail?id=' + encodeURIComponent(meetingId);
        }
        break;
    }
  }

  // 4. WebRTC Peer Connection Management
  function createPeerConnection(peerId, peerName, isInitiator) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(peerId, pc);
    if (peerName) peerDisplayNames.set(peerId, peerName);

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
      let stream = remoteStreams.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.set(peerId, stream);
      }
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!stream.getTracks().some((t) => t.id === track.id)) {
            stream.addTrack(track);
          }
        });
      } else if (event.track) {
        if (!stream.getTracks().some((t) => t.id === event.track.id)) {
          stream.addTrack(event.track);
        }
      }
      renderRemotePeerTile(peerId, peerDisplayNames.get(peerId) || peerName, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (isInitiator) {
          pc.createOffer({ iceRestart: true, offerToReceiveAudio: true, offerToReceiveVideo: true })
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
              ws.send(JSON.stringify({ type: 'offer', meetingId, targetId: peerId, payload: pc.localDescription }));
            })
            .catch(console.warn);
        }
      }
    };

    if (isInitiator) {
      pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          ws.send(JSON.stringify({
            type: 'offer',
            meetingId,
            targetId: peerId,
            payload: pc.localDescription
          }));
        })
        .catch(console.error);
    }

    return pc;
  }

  async function handleOffer(peerId, peerName, offer) {
    const pc = createPeerConnection(peerId, peerName, false);
    const desc = new RTCSessionDescription({ type: offer.type || 'offer', sdp: offer.sdp || offer });
    await pc.setRemoteDescription(desc);
    await drainIceCandidates(peerId, pc);

    const answer = await pc.createAnswer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
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
      const desc = new RTCSessionDescription({ type: answer.type || 'answer', sdp: answer.sdp || answer });
      await pc.setRemoteDescription(desc);
      await drainIceCandidates(peerId, pc);
    }
  }

  async function handleIceCandidate(peerId, candidate) {
    if (!candidate) return;
    const pc = peerConnections.get(peerId);
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      if (!iceCandidateQueues.has(peerId)) iceCandidateQueues.set(peerId, []);
      iceCandidateQueues.get(peerId).push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e2) {
        console.warn('[webrtc] Error adding ICE candidate:', e2);
      }
    }
  }

  async function drainIceCandidates(peerId, pc) {
    const queue = iceCandidateQueues.get(peerId);
    if (queue && queue.length > 0) {
      iceCandidateQueues.delete(peerId);
      for (const cand of queue) {
        try {
          await pc.addIceCandidate(cand);
        } catch (e) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e2) {
            console.warn('[webrtc] Error applying queued candidate:', e2);
          }
        }
      }
    }
  }

  function removePeerConnection(peerId) {
    if (peerConnections.has(peerId)) {
      peerConnections.get(peerId).close();
      peerConnections.delete(peerId);
    }
    remoteStreams.delete(peerId);
    iceCandidateQueues.delete(peerId);
    peerDisplayNames.delete(peerId);
    const tile = document.getElementById('tile-' + peerId);
    if (tile) tile.remove();
  }

  function renderRemotePeerTile(peerId, peerName, stream) {
    let tile = document.getElementById('tile-' + peerId);
    const displayName = peerName || 'Participant';
    const initials = displayName.slice(0, 2).toUpperCase();

    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + peerId;
      tile.innerHTML =
        '<video id="video-' + peerId + '" autoplay playsinline class="video-feed"></video>' +
        '<div class="video-avatar-fallback" id="avatar-' + peerId + '" style="display:none;">' +
          '<div class="avatar-circle">' + esc(initials) + '</div>' +
          '<span class="avatar-name">' + esc(displayName) + '</span>' +
        '</div>' +
        '<div class="tile-bar">' +
          '<span class="tile-name">' + esc(displayName) + '</span>' +
          '<div class="tile-icons">' +
            '<span id="mic-' + peerId + '" class="status-icon">🎤</span>' +
            '<span id="cam-' + peerId + '" class="status-icon">📹</span>' +
          '</div>' +
        '</div>' +
        '<div class="speaking-glow" id="glow-' + peerId + '"></div>';
      document.getElementById('participant-video-grid').appendChild(tile);
      setupAudioMeter(stream, 'glow-' + peerId);
    }

    const vid = document.getElementById('video-' + peerId);
    if (vid) {
      if (vid.srcObject !== stream) {
        vid.srcObject = stream;
      }
      vid.play().catch(() => {});
    }

    const hasVideo = stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    const avatar = document.getElementById('avatar-' + peerId);
    if (avatar && vid) {
      avatar.style.display = hasVideo ? 'none' : 'grid';
      vid.style.display = hasVideo ? 'block' : 'none';
    }
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
      const vid = document.getElementById('video-' + peerId);
      const avatar = document.getElementById('avatar-' + peerId);
      if (vid && avatar) {
        vid.style.display = state.videoMuted ? 'none' : 'block';
        avatar.style.display = state.videoMuted ? 'grid' : 'none';
      }
    }
  }

  // 5. Audio Meter & Speaking Detection
  function setupAudioMeter(stream, glowElementId) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx || !stream.getAudioTracks().length) return;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const check = () => {
        const el = document.getElementById(glowElementId);
        if (!el) {
          audioCtx.close().catch(() => {});
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        if (avg > 16 && (glowElementId !== 'local-speaking-glow' || !audioMuted)) {
          el.classList.add('speaking');
        } else {
          el.classList.remove('speaking');
        }
        requestAnimationFrame(check);
      };
      check();
    } catch (e) {
      // Audio meter is a visual enhancement; non-fatal
    }
  }

  // 6. Media Controls (Audio, Video, Screen)
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
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        screenSharing = true;
        document.getElementById('btn-share-screen').classList.add('active');

        const localVideo = document.getElementById('local-video-feed');
        if (localVideo) localVideo.srcObject = screenStream;

        for (const pc of peerConnections.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders().find((s) => !s.track);
          if (sender) {
            sender.replaceTrack(screenTrack);
          } else {
            pc.addTrack(screenTrack, screenStream);
          }
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
    const localVideo = document.getElementById('local-video-feed');
    if (localVideo && localStream) {
      localVideo.srcObject = localStream;
      localVideo.style.display = videoMuted ? 'none' : 'block';
    }
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

  // 7. Recording Controls
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
      const durationSec = Math.max(1, Math.round((Date.now() - meetingStartTime) / 1000));
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/recording?durationSeconds=' + durationSec, {
        method: 'POST',
        headers: {
          'Content-Type': 'video/webm',
          'x-vital-csrf': csrfToken,
        },
        body: blob,
      }).catch(console.error);
    };

    mediaRecorder.start(3000);
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
    if (badge) badge.className = 'recording-badge ' + (isRecording ? 'active' : '');
    if (txt) txt.textContent = isRecording ? 'Recording' : 'Not Recording';
    if (lbl) lbl.textContent = isRecording ? 'Stop Rec' : 'Record';
  }

  // 8. Speech-To-Text / Live Transcription
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
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'live-transcript',
                  meetingId,
                  payload: segment
                }));
              }
              renderTranscriptSegment(segment);
              fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/transcript', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-vital-csrf': csrfToken,
                },
                body: JSON.stringify(segment)
              }).catch(console.error);
            }
          }
        }
      };

      recognition.onerror = (e) => {
        console.warn('Speech recognition warning:', e);
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
    if (!feed) return;
    const row = document.createElement('div');
    row.className = 'transcript-entry';
    const m = Math.floor(seg.startTime / 60).toString().padStart(2, '0');
    const s = Math.floor(seg.startTime % 60).toString().padStart(2, '0');
    row.innerHTML = '<div class="transcript-meta"><span class="transcript-speaker">' + esc(seg.speakerName) + '</span><span class="transcript-time">' + m + ':' + s + '</span></div><div class="transcript-body">' + esc(seg.text) + '</div>';
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;

    updateLiveNotesFromText(seg.speakerName, seg.text);
  }

  function updateLiveNotesFromText(speaker, text) {
    if (/\blaunch|decided|target\b/i.test(text)) {
      const list = document.getElementById('live-decisions-list');
      if (list) {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
      }
    }
    if (/\bwill handle|will deploy|prepare|implement\b/i.test(text)) {
      const list = document.getElementById('live-actions-list');
      if (list) {
        const li = document.createElement('li');
        li.textContent = speaker + ' — ' + text;
        list.appendChild(li);
      }
    }
  }

  // 9. In-Meeting Chat
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
    if (!feed) return;
    const div = document.createElement('div');
    div.className = 'chat-entry';
    div.innerHTML = '<span class="chat-author">' + esc(author) + ':</span> <span class="chat-text">' + esc(text) + '</span>';
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  // 10. Duration Clock
  setInterval(() => {
    const sec = Math.floor((Date.now() - meetingStartTime) / 1000);
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    const el = document.getElementById('meeting-duration-clock');
    if (el) el.textContent = m + ':' + s;
  }, 1000);

  // 11. Device Enumeration & Switching
  async function enumerateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = document.getElementById('select-mic');
    const camSelect = document.getElementById('select-cam');
    const spkSelect = document.getElementById('select-speaker');
    if (!micSelect || !camSelect || !spkSelect) return;

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

  window.changeAudioInput = async (deviceId) => {
    if (!deviceId) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (localStream && newTrack) {
        const oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        localStream.addTrack(newTrack);
        newTrack.enabled = !audioMuted;
        for (const pc of peerConnections.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio') || pc.getSenders().find((s) => !s.track);
          if (sender) {
            sender.replaceTrack(newTrack);
          } else {
            pc.addTrack(newTrack, localStream);
          }
        }
      }
    } catch (e) {
      console.warn('Microphone switch failed:', e);
    }
  };

  window.changeVideoInput = async (deviceId) => {
    if (!deviceId) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (localStream && newTrack) {
        const oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        localStream.addTrack(newTrack);
        newTrack.enabled = !videoMuted;
        const localVideo = document.getElementById('local-video-feed');
        if (localVideo) localVideo.srcObject = localStream;
        for (const pc of peerConnections.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders().find((s) => !s.track);
          if (sender && !screenSharing) {
            sender.replaceTrack(newTrack);
          } else if (!screenSharing) {
            pc.addTrack(newTrack, localStream);
          }
        }
      }
    } catch (e) {
      console.warn('Camera switch failed:', e);
    }
  };

  window.changeAudioOutput = async (deviceId) => {
    if (!deviceId) return;
    try {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (typeof v.setSinkId === 'function') {
          await v.setSinkId(deviceId);
        }
      }
    } catch (e) {
      console.warn('Speaker output sink switch failed:', e);
    }
  };

  window.openDeviceSettingsModal = () => (document.getElementById('device-modal').style.display = 'grid');
  window.closeDeviceSettingsModal = () => (document.getElementById('device-modal').style.display = 'none');
  window.toggleIntelPanel = () => document.getElementById('intel-panel').classList.toggle('collapsed');

  window.switchIntelTab = (tab, btn) => {
    document.querySelectorAll('.intel-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.intel-content').forEach((c) => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const content = document.getElementById('tab-' + tab);
    if (content) content.classList.add('active');
  };

  function updateParticipantCount() {
    const count = peerConnections.size + 1;
    const badge = document.getElementById('participant-count-badge');
    if (badge) badge.textContent = count;
    const modalCount = document.getElementById('modal-participant-count');
    if (modalCount) modalCount.textContent = count;
  }

  // 12. Participants Modal & Invite Link
  window.toggleParticipantsModal = () => {
    const modal = document.getElementById('participants-modal');
    if (!modal) return;
    const isHidden = modal.style.display === 'none' || !modal.style.display;
    modal.style.display = isHidden ? 'grid' : 'none';
    if (isHidden) {
      updateParticipantsModalList();
      const shareInput = document.getElementById('meeting-share-url');
      if (shareInput) shareInput.value = window.location.href;
    }
  };

  window.copyMeetingLink = () => {
    const shareInput = document.getElementById('meeting-share-url');
    if (shareInput) {
      navigator.clipboard.writeText(shareInput.value).then(() => {
        const notice = document.getElementById('copied-notice');
        if (notice) {
          notice.style.display = 'inline';
          setTimeout(() => (notice.style.display = 'none'), 2500);
        }
      }).catch(console.error);
    }
  };

  function updateParticipantsModalList() {
    const list = document.getElementById('modal-participants-list');
    if (!list) return;
    list.innerHTML = '';

    // Local user
    const localLi = document.createElement('li');
    localLi.className = 'participant-item';
    localLi.innerHTML =
      '<div class="participant-info">' +
        '<div class="avatar-mini">' + esc(userName.slice(0, 2).toUpperCase()) + '</div>' +
        '<div class="participant-details">' +
          '<span class="participant-name">' + esc(userName) + ' (You)</span>' +
          '<span class="participant-role-pill">' + (isHost ? 'Host' : 'Participant') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="participant-media-status">' +
        '<span class="status-icon">' + (audioMuted ? '🔇' : '🎤') + '</span>' +
        '<span class="status-icon">' + (videoMuted ? '🚫' : '📹') + '</span>' +
      '</div>';
    list.appendChild(localLi);

    // Remote peers
    for (const [peerId] of peerConnections.entries()) {
      const name = peerDisplayNames.get(peerId) || 'Participant';
      const micText = document.getElementById('mic-' + peerId)?.textContent || '🎤';
      const camText = document.getElementById('cam-' + peerId)?.textContent || '📹';

      const li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML =
        '<div class="participant-info">' +
          '<div class="avatar-mini">' + esc(name.slice(0, 2).toUpperCase()) + '</div>' +
          '<div class="participant-details">' +
            '<span class="participant-name">' + esc(name) + '</span>' +
            '<span class="participant-role-pill">Peer</span>' +
          '</div>' +
        '</div>' +
        '<div class="participant-media-status">' +
          '<span class="status-icon">' + micText + '</span>' +
          '<span class="status-icon">' + camText + '</span>' +
        '</div>';
      list.appendChild(li);
    }
  }

  // 13. Keyboard Shortcuts (Cmd/Ctrl + D for Audio, Cmd/Ctrl + E for Video)
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      toggleAudio();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      toggleVideo();
    }
  });

  // 14. Leave / End Flow
  window.confirmLeaveOrEnd = async () => {
    const action = isHost ? 'End meeting for all participants?' : 'Leave meeting?';
    if (!confirm(action)) return;

    if (isRecording) {
      stopRecording();
      await new Promise((r) => setTimeout(r, 400));
    }

    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());

    const headers = { 'x-vital-csrf': csrfToken };

    if (isHost) {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/end', { method: 'POST', headers }).catch(() => {});
      window.location.href = home + 'console/meetings/detail?id=' + encodeURIComponent(meetingId);
    } else {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/leave', { method: 'POST', headers }).catch(() => {});
      window.location.href = home + 'console/meetings';
    }
  };

  // Run on start
  initMedia();
})();
</script>

<style>
/* Reset and Viewport containment: Prevents buttons from sliding under screen fold */
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  height: 100dvh;
  overflow: hidden;
  background: #080C10;
  color: #E2E8F0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after {
  box-sizing: border-box;
}

.meeting-container {
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  background: #080C10;
  color: #E2E8F0;
  overflow: hidden;
}
.meeting-header {
  height: 54px;
  min-height: 54px;
  background: #0F172A;
  border-bottom: 1px solid #1E293B;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
  z-index: 30;
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
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  position: relative;
  overflow: hidden;
}
.meeting-stage {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #05080C;
  overflow: hidden;
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  width: 100%;
  height: 100%;
  max-width: 1400px;
  max-height: 100%;
  align-content: center;
  justify-content: center;
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

.speaking-glow.speaking {
  opacity: 1;
  box-shadow: 0 0 16px rgba(16, 185, 129, 0.7);
}
.share-link-box {
  margin-bottom: 16px;
  background: #0B111A;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #1E293B;
}
.share-link-box label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748B;
  display: block;
  margin-bottom: 6px;
}
.input-copy-group {
  display: flex;
  gap: 8px;
}
.input-copy-group input {
  flex: 1;
  background: #1E293B;
  border: 1px solid #334155;
  color: #F8FAFC;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.copied-indicator {
  display: inline-block;
  font-size: 11px;
  color: #10B981;
  margin-top: 6px;
  font-weight: 500;
}
.participants-list-wrap {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid #1E293B;
  border-radius: 8px;
  background: #0B111A;
}
.participants-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.participant-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #141E2C;
}
.participant-item:last-child {
  border-bottom: none;
}
.participant-info {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar-mini {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #0F5C57;
  color: #5EEAD4;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
}
.participant-details {
  display: flex;
  flex-direction: column;
}
.participant-name {
  font-size: 13px;
  font-weight: 500;
  color: #F8FAFC;
}
.participant-role-pill {
  font-size: 10px;
  color: #94A3B8;
}
.participant-media-status {
  display: flex;
  gap: 6px;
  font-size: 14px;
}
.chat-stream {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-entry {
  font-size: 12.5px;
  line-height: 1.4;
  word-break: break-word;
  background: #111B27;
  border: 1px solid #1E2B3C;
  border-radius: 8px;
  padding: 8px 10px;
}
.chat-author {
  font-weight: 600;
  color: #5EEAD4;
  margin-right: 6px;
}
.chat-text {
  color: #E2E8F0;
}
.chat-input-bar {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #1E293B;
  background: #0E1624;
}
.chat-input-bar input {
  flex: 1;
  background: #1E293B;
  border: 1px solid #334155;
  color: #F8FAFC;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.chat-input-bar input:focus {
  border-color: #5EEAD4;
}
.modal-footer {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

@media (max-width: 900px) {
  .intel-panel {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 40;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
  }
}
@media (max-width: 768px) {
  .meeting-toolbar {
    padding: 0 8px;
    height: 60px;
    min-height: 60px;
  }
  .toolbar-left, .toolbar-center, .toolbar-right {
    gap: 4px;
  }
  .tool-btn {
    padding: 6px 8px;
    min-width: 44px;
    font-size: 10px;
  }
  .tool-btn .btn-icon {
    font-size: 15px;
  }
  .meeting-header {
    height: 48px;
    padding: 0 8px;
  }
  .meeting-title {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .video-grid {
    gap: 8px;
  }
}

@media (max-width: 540px) {
  .meeting-toolbar {
    height: 56px;
    min-height: 56px;
    padding: 0 4px;
  }
  .tool-btn {
    min-width: 36px;
    padding: 6px 4px;
    gap: 1px;
  }
  .tool-btn .btn-label {
    display: none;
  }
  .toolbar-left, .toolbar-center, .toolbar-right {
    gap: 3px;
  }
  .btn-danger {
    padding: 6px 8px;
    font-size: 11px;
  }
}

@media (max-height: 560px) {
  .meeting-header {
    height: 40px;
    min-height: 40px;
  }
  .meeting-toolbar {
    height: 50px;
    min-height: 50px;
  }
  .tool-btn {
    padding: 4px 6px;
  }
  .tool-btn .btn-label {
    display: none;
  }
}
</style>
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

export function renderMeetingLibraryView(opts: {
  meetings: Meeting[];
  home: string;
  csrf?: string;
}): string {
  const { meetings, home, csrf } = opts;

  const activeMeetings = meetings.filter((m) => m.status === 'ACTIVE');
  const pastMeetings = meetings.filter((m) => m.status === 'ENDED');

  return `
<div class="meeting-library-view">
  <!-- Top Header with Actions -->
  <div class="library-top-bar">
    <div class="library-header-info">
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

    ${activeMeetings.length === 0 ? `
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
    ` : `
      <div class="meetings-grid active-grid">
        ${activeMeetings.map((m) => `
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
        `).join('')}
      </div>
    `}
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

    ${pastMeetings.length === 0 ? `
      <div class="empty-past-card">
        <p>No completed meetings yet. Concluded meetings with summaries and recordings will appear here.</p>
      </div>
    ` : `
      <div class="meetings-grid past-grid">
        ${pastMeetings.map((m) => `
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
        `).join('')}
      </div>
    `}
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
      btn.style.color = '#10B981';
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.color = '';
      }, 2000);
    }).catch(console.error);
  };
})();
</script>

<style>
/* Modern Meeting Intelligence Library Styling */
.meeting-library-view {
  padding: 28px 36px;
  background: #F8FAFC;
  min-height: 100%;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  color: #1E293B;
  box-sizing: border-box;
}

.library-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}
.library-title-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 6px;
}
.library-heading {
  font-size: 26px;
  font-weight: 700;
  color: #0F172A;
  margin: 0;
  letter-spacing: -0.5px;
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
  border-radius: 20px;
  background: #E2E8F0;
  color: #475569;
}
.stat-pill.live {
  background: rgba(16, 185, 129, 0.15);
  color: #059669;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.pulse-dot {
  width: 8px;
  height: 8px;
  background: #10B981;
  border-radius: 50%;
  animation: pulseDot 1.5s infinite;
}
.pulse-dot-small {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: #10B981;
  border-radius: 50%;
  margin-right: 4px;
}
@keyframes pulseDot {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); transform: scale(0.95); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); transform: scale(1.1); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); transform: scale(0.95); }
}

.library-sub {
  font-size: 13.5px;
  color: #64748B;
  margin: 0;
}

/* New Meeting Action Button */
.btn-new-meeting {
  background: linear-gradient(135deg, #0F766E 0%, #0D9488 100%);
  color: #FFFFFF;
  border: none;
  padding: 11px 22px;
  border-radius: 10px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 14px rgba(13, 148, 136, 0.35);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn-new-meeting:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(13, 148, 136, 0.45);
  background: linear-gradient(135deg, #115E59 0%, #0F766E 100%);
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
  border: 1px solid #CBD5E1;
  border-radius: 10px;
  font-size: 13.5px;
  outline: none;
  background: #FFFFFF;
  color: #1E293B;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}
.lib-search-box:focus {
  border-color: #0F766E;
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.15);
}

.filter-tabs {
  display: flex;
  gap: 6px;
  background: #E2E8F0;
  padding: 4px;
  border-radius: 10px;
}
.filter-tab {
  background: transparent;
  border: none;
  padding: 7px 14px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 500;
  color: #64748B;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: all 0.15s ease;
}
.filter-tab:hover { color: #1E293B; }
.filter-tab.active {
  background: #FFFFFF;
  color: #0F172A;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
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
  border-bottom: 1px solid #E2E8F0;
}
.section-title-cluster {
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-heading {
  font-size: 16px;
  font-weight: 700;
  color: #0F172A;
  margin: 0;
}
.section-count {
  font-size: 12px;
  font-weight: 500;
  color: #64748B;
}

/* Meeting Cards */
.meetings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}
.meeting-card {
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.03);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
  position: relative;
}
.meeting-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
}
.meeting-card.card-active {
  border: 1.5px solid rgba(16, 185, 129, 0.4);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.08);
  background: linear-gradient(180deg, #FFFFFF 0%, #F0FDF4 100%);
}

.mcard-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.badge-live-pulse {
  background: rgba(16, 185, 129, 0.15);
  color: #059669;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.badge-ended {
  background: #F1F5F9;
  color: #64748B;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
}
.mcard-scope {
  font-size: 12px;
  font-weight: 600;
  color: #0F5C57;
  background: rgba(15, 92, 87, 0.08);
  padding: 2px 8px;
  border-radius: 6px;
}
.mcard-title {
  font-size: 16.5px;
  font-weight: 700;
  color: #0F172A;
  margin: 0 0 12px 0;
  line-height: 1.35;
}
.mcard-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: #475569;
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
  border-top: 1px solid #F1F5F9;
}
.btn-join-room {
  background: linear-gradient(135deg, #0F766E 0%, #0D9488 100%);
  color: #FFFFFF;
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  padding: 7px 16px;
  border-radius: 8px;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
}
.btn-join-room:hover {
  background: linear-gradient(135deg, #115E59 0%, #0F766E 100%);
  transform: translateY(-1px);
}
.btn-copy-card-link {
  background: #F1F5F9;
  border: 1px solid #CBD5E1;
  color: #475569;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.15s ease;
}
.btn-copy-card-link:hover {
  background: #E2E8F0;
  color: #1E293B;
}
.btn-view-intel {
  background: #F8FAFC;
  border: 1px solid #CBD5E1;
  color: #0F172A;
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  padding: 7px 16px;
  border-radius: 8px;
  transition: all 0.15s ease;
}
.btn-view-intel:hover {
  background: #0F5C57;
  color: #FFFFFF;
  border-color: #0F5C57;
}

/* Empty State Banners */
.no-active-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #FFFFFF;
  border: 1px dashed #CBD5E1;
  border-radius: 12px;
  padding: 18px 24px;
}
.no-active-content {
  display: flex;
  align-items: center;
  gap: 14px;
}
.no-active-icon { font-size: 24px; }
.no-active-content h4 { margin: 0 0 2px 0; font-size: 14px; font-weight: 600; color: #0F172A; }
.no-active-content p { margin: 0; font-size: 12.5px; color: #64748B; }
.btn-start-quick {
  background: #0F766E;
  color: #FFFFFF;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.empty-past-card {
  background: #FFFFFF;
  border: 1px dashed #CBD5E1;
  border-radius: 12px;
  padding: 24px;
  text-align: center;
  color: #64748B;
  font-size: 13px;
}

/* Centered Pop-up Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.75);
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
  background: #0F172A;
  border: 1px solid #334155;
  border-radius: 16px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
  padding: 24px 28px;
  color: #F8FAFC;
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
  color: #5EEAD4;
  background: rgba(94, 234, 212, 0.1);
  padding: 2px 8px;
  border-radius: 12px;
  display: inline-block;
  margin-bottom: 6px;
}
.modal-title {
  font-size: 18px;
  font-weight: 700;
  color: #F8FAFC;
  margin: 0 0 4px 0;
}
.modal-desc {
  font-size: 12.5px;
  color: #94A3B8;
  margin: 0;
}
.modal-close-btn {
  background: transparent;
  border: none;
  color: #94A3B8;
  font-size: 18px;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}
.modal-close-btn:hover { color: #FFFFFF; background: #1E293B; }

.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #94A3B8;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.form-input {
  width: 100%;
  background: #1E293B;
  border: 1px solid #334155;
  color: #F8FAFC;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13.5px;
  outline: none;
  box-sizing: border-box;
}
.form-input:focus {
  border-color: #5EEAD4;
  box-shadow: 0 0 0 2px rgba(94, 234, 212, 0.2);
}

.form-checkbox-group {
  margin-bottom: 20px;
  background: #131E2E;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #1E293B;
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
  accent-color: #0F766E;
  cursor: pointer;
}
.checkbox-text {
  display: flex;
  flex-direction: column;
}
.checkbox-title {
  font-size: 13px;
  font-weight: 600;
  color: #F1F5F9;
}
.checkbox-sub {
  font-size: 11.5px;
  color: #94A3B8;
  margin-top: 2px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #1E293B;
}
.btn {
  padding: 9px 18px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
}
.btn-secondary {
  background: #1E293B;
  border: 1px solid #334155;
  color: #E2E8F0;
}
.btn-secondary:hover { background: #334155; color: #FFFFFF; }
.btn-create-submit {
  background: linear-gradient(135deg, #0F766E 0%, #0D9488 100%);
  color: #FFFFFF;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 4px 14px rgba(13, 148, 136, 0.4);
}
.btn-create-submit:hover {
  background: linear-gradient(135deg, #115E59 0%, #0F766E 100%);
}
</style>
`;
}

