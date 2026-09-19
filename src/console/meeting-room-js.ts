/**
 * Live meeting room client, served as a cached static asset.
 *
 * Extracted from the inline <script> blob that used to be embedded in every
 * renderMeetingRoomView() response (~950 lines of template-string JS with no
 * linting and no caching). It now reads all server state from data-*
 * attributes and <meta> tags on the room document — never from interpolated
 * JS literals — so the file is constant and can be cached immutably.
 *
 * Feature notes:
 * - Speaker view: one hero tile + a rail of remote tiles. Clicking a rail
 *   tile pins it to the hero; dominant-speaker auto-raise runs when nothing
 *   is pinned.
 * - Simulcast: the outgoing video track is sent as two RID layers ('h'/'q');
 *   the hero prefers 'h', rail tiles prefer 'q' so upstream bandwidth does
 *   not scale with viewer size. Browsers without simulcast fall back to a
 *   single layer via try/catch.
 * - Resilience: WS keepalive pings, ICE-failure banner with retry, styled
 *   toasts instead of alert()/confirm().
 *
 * The module is a raw string (String.raw) and must therefore contain no
 * backticks and no dollar-brace interpolations — plain concatenation only.
 */
export const MEETING_ROOM_JS = String.raw`(() => {
  'use strict';

  var app = document.getElementById('meeting-room-app');
  if (!app) return;

  var meetingId = app.getAttribute('data-meeting-id');
  var userId = app.getAttribute('data-user-id');
  var userName = app.getAttribute('data-user-name');
  var isHost = app.getAttribute('data-is-host') === 'true';
  var home = app.getAttribute('data-home') || '/';
  var startRecordingFlag = app.getAttribute('data-start-recording') === 'true';

  var csrfMeta = document.querySelector('meta[name="vital-csrf"]');
  var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') || '' : '';
  var iceServers = [];
  try {
    iceServers = JSON.parse(document.getElementById('meeting-ice-config').textContent);
  } catch (e) {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  var ICONS = {};
  try {
    ICONS = JSON.parse(app.getAttribute('data-icons') || '{}');
  } catch (e) { ICONS = {}; }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function iconSvg(name, cls) {
    return '<span class="status-icon ' + (cls || '') + '">' + (ICONS[name] || '') + '</span>';
  }

  // ------------------------------------------------------------- state ----
  var localStream = null;
  var screenStream = null;
  var ws = null;
  var wsKeepalive = null;
  var mediaRecorder = null;
  var recordedChunks = [];
  var isRecording = startRecordingFlag;
  var audioMuted = false;
  var videoMuted = false;
  var screenSharing = false;
  var meetingStartTime = Date.now();
  var pinnedPeerId = null;   // null | peerId | 'local'
  var lastErrorNoticeAt = 0;

  var peerConnections = new Map(); // peerId -> RTCPeerConnection
  var remoteStreams = new Map();   // peerId -> MediaStream
  var iceCandidateQueues = new Map();
  var selfPeerId = null;           // our server-assigned peer id (from 'joined')
  // peerId -> { name, audioMuted, videoMuted, initiator, connectedOnce, lastSpoke }
  var peers = new Map();
  var localLastSpoke = 0;

  // ------------------------------------------------------- bootstrap ----
  fillStaticIcons();
  initMedia();

  function fillStaticIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = ICONS[el.getAttribute('data-icon')] || '';
    });
  }

  // ------------------------------------------------------ 1. local media ----
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

    applyLocalPreview();
    if (audioMuted) refreshAudioBtn();
    if (localStream && localStream.getAudioTracks().length > 0) {
      setupAudioMeter(localStream, function () { localLastSpoke = Date.now(); }, 'local-speaking-glow');
      initSpeechRecognitionOrSTT();
    }
    await enumerateDevices().catch(() => {});
    connectSignaling();
  }

  function applyLocalPreview() {
    var localVideo = document.getElementById('local-video-feed');
    var localAvatar = document.getElementById('local-avatar-fallback');
    var hasLiveVideo = localStream && localStream.getVideoTracks().some(function (t) {
      return t.enabled && t.readyState === 'live';
    });
    if (localVideo && hasLiveVideo) {
      localVideo.srcObject = localStream;
      localVideo.style.display = 'block';
      if (localAvatar) localAvatar.style.display = 'none';
    } else {
      if (localVideo) localVideo.style.display = 'none';
      if (localAvatar) localAvatar.style.display = 'grid';
      refreshCamBtn();
    }
    var micIcon = document.getElementById('local-mic-icon');
    if (micIcon) {
      micIcon.innerHTML = ICONS[audioMuted ? 'micOff' : 'mic'] || '';
      micIcon.classList.toggle('off', audioMuted);
    }
  }

  // ------------------------------------------------ 2. signaling socket ----
  function connectSignaling() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + home + 'api/meetings/signal?meetingId='
      + encodeURIComponent(meetingId) + '&name=' + encodeURIComponent(userName);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[webrtc] WebSocket initialization failed:', e);
      return;
    }

    ws.onopen = function () {
      setConnPill('connected', 'Connected');
      wsKeepalive = setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', meetingId: meetingId }));
        }
      }, 25000);
    };

    ws.onmessage = function (event) {
      handleSignalingMessage(event.data);
    };

    ws.onclose = function () {
      if (wsKeepalive) { clearInterval(wsKeepalive); wsKeepalive = null; }
      setConnPill('disconnected', 'Reconnecting...');
      setTimeout(connectSignaling, 3000);
    };

    ws.onerror = null;
    ws.addEventListener('error', function () {
      // onclose follows every error; nothing extra to do but log.
      console.warn('[webrtc] Signaling socket error');
    });
  }

  function setConnPill(cls, text) {
    var pill = document.getElementById('conn-status-indicator');
    if (pill) pill.className = 'conn-status-pill ' + cls;
    var txt = document.getElementById('conn-status-text');
    if (txt) txt.textContent = text;
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // --------------------------------------------- 3. signaling dispatch ----
  async function handleSignalingMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) {
      console.error('[webrtc] Signaling parse error:', e);
      return;
    }
    switch (msg.type) {
      case 'pong':
        break;
      case 'joined':
        selfPeerId = msg.payload.peerId || null;
        (msg.payload.existingPeers || []).forEach(function (peer) {
          registerPeer(peer.peerId, peer.displayName, peer.audioMuted, peer.videoMuted);
          createPeerConnection(peer.peerId, true);
        });
        updateParticipantCount();
        break;
      case 'peer-joined':
        registerPeer(msg.payload.peerId, msg.payload.displayName, msg.payload.audioMuted, msg.payload.videoMuted);
        createPeerConnection(msg.payload.peerId, false);
        updateParticipantCount();
        addChatMessage('System', msg.payload.displayName + ' joined the meeting.', true);
        break;
      case 'peer-left':
        var departed = peers.get(msg.payload.peerId);
        var departedName = departed ? departed.name : (msg.senderName || 'A participant');
        removePeerConnection(msg.payload.peerId);
        updateParticipantCount();
        addChatMessage('System', departedName + ' left the meeting.', true);
        break;
      case 'offer':
        await handleOffer(msg.senderId, msg.payload);
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
        if (msg.senderId !== selfPeerId) addChatMessage(msg.senderName, msg.payload.text);
        break;
      case 'live-transcript':
        renderTranscriptSegment(msg.payload);
        break;
      case 'meeting-ended':
        if (!isHost) {
          toast('The host has concluded this meeting. Opening summary...');
          setTimeout(function () {
            window.location.href = home + 'console/meetings/detail?id=' + encodeURIComponent(meetingId);
          }, 1600);
        }
        break;
      default:
        break;
    }
  }

  function registerPeer(peerId, name, audioMutedState, videoMutedState) {
    peers.set(peerId, {
      name: name || 'Participant',
      audioMuted: Boolean(audioMutedState),
      videoMuted: Boolean(videoMutedState),
      initiator: false,
      connectedOnce: false,
      lastSpoke: 0
    });
  }

  // ------------------------------------- 4. WebRTC peer connections ----
  function createPeerConnection(peerId, isInitiator) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);
    if (!peers.has(peerId)) registerPeer(peerId, peerId);
    peers.get(peerId).initiator = isInitiator;

    var pc = new RTCPeerConnection({ iceServers: iceServers });
    peerConnections.set(peerId, pc);

    if (localStream) {
      localStream.getTracks().forEach(function (track) { pc.addTrack(track, localStream); });
    }
    applySimulcast(pc);

    pc.onicecandidate = function (event) {
      if (event.candidate) wsSend({ type: 'ice-candidate', meetingId: meetingId, targetId: peerId, payload: event.candidate });
    };

    pc.ontrack = function (event) {
      var stream = remoteStreams.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.set(peerId, stream);
      }
      var incoming = event.streams && event.streams[0] ? event.streams[0] : null;
      if (incoming) {
        incoming.getTracks().forEach(function (track) {
          if (!stream.getTracks().some(function (t) { return t.id === track.id; })) stream.addTrack(track);
        });
      } else if (event.track) {
        if (!stream.getTracks().some(function (t) { return t.id === event.track.id; })) stream.addTrack(event.track);
      }
      renderPeerTile(peerId, stream);
      preferVideoLayer(pc, peerId);
      if (!stream._metered && stream.getAudioTracks().length > 0) {
        stream._metered = true;
        setupAudioMeter(stream, function () {
          var st = peers.get(peerId);
          if (st) st.lastSpoke = Date.now();
        }, 'glow-' + peerId);
      }
    };

    pc.onconnectionstatechange = function () {
      var st = peers.get(peerId);
      if (!st) return;
      if (pc.connectionState === 'connected') {
        st.connectedOnce = true;
        hideConnBanner(peerId);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (st.initiator && st.connectedOnce) {
          // Auto-recover once via ICE restart.
          st.initiator = 'restarting';
          iceRestart(peerId, pc);
        } else if (pc.connectionState === 'failed') {
          showConnBanner(peerId, st.name);
        }
      }
    };

    if (isInitiator) makeOffer(pc, peerId);
    return pc;
  }

  function makeOffer(pc, peerId, iceRestartFlag) {
    var opts = iceRestartFlag ? { iceRestart: true } : {};
    pc.createOffer(opts)
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () {
        wsSend({ type: 'offer', meetingId: meetingId, targetId: peerId, payload: pc.localDescription });
      })
      .catch(function (e) { console.warn('[webrtc] createOffer failed:', e); });
  }

  function iceRestart(peerId, pc) {
    try {
      pc.createOffer({ iceRestart: true })
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () {
          wsSend({ type: 'offer', meetingId: meetingId, targetId: peerId, payload: pc.localDescription });
        })
        .catch(function () {
          var st = peers.get(peerId);
          if (st) { st.initiator = true; showConnBanner(peerId, st.name); }
        });
    } catch (e) {
      var st2 = peers.get(peerId);
      if (st2) showConnBanner(peerId, st2.name);
    }
  }

  // Two RID layers: 'h' (full) for whoever is in the hero, 'q' (quarter) for
  // rail thumbnails. Falls back silently to a single layer where unsupported.
  function applySimulcast(pc) {
    try {
      var sender = pc.getSenders().find(function (s) {
        return s.track && s.track.kind === 'video';
      });
      if (!sender) return;
      var params = sender.getParameters();
      if (!params || !params.encodings || params.encodings.length === 0) return;
      params.encodings = [
        { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 900000 },
        { rid: 'q', scaleResolutionDownBy: 2, maxBitrate: 150000 }
      ];
      sender.setParameters(params).catch(function () { /* unsupported */ });
    } catch (e) { /* unsupported */ }
  }

  function preferVideoLayer(pc, peerId) {
    try {
      var heroIsThisPeer = currentHeroPeerId() === peerId;
      // Simulcast layer selection is only honoured by some receivers; the
      // portable lever is contentHint ('detail' wants the sharpest layer).
      var vid = document.getElementById('video-' + peerId);
      if (vid && vid.srcObject && vid.srcObject.getVideoTracks) {
        vid.srcObject.getVideoTracks().forEach(function (t) {
          t.contentHint = heroIsThisPeer ? 'detail' : 'motion';
        });
      }
    } catch (e) { /* non-fatal */ }
  }

  async function handleOffer(peerId, offer) {
    var pc = createPeerConnection(peerId, false);
    var desc = new RTCSessionDescription({ type: offer.type || 'offer', sdp: offer.sdp || offer });
    await pc.setRemoteDescription(desc);
    await drainIceCandidates(peerId, pc);
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'answer', meetingId: meetingId, targetId: peerId, payload: pc.localDescription });
  }

  async function handleAnswer(peerId, answer) {
    var pc = peerConnections.get(peerId);
    if (!pc) return;
    var desc = new RTCSessionDescription({ type: answer.type || 'answer', sdp: answer.sdp || answer });
    await pc.setRemoteDescription(desc);
    await drainIceCandidates(peerId, pc);
    var st = peers.get(peerId);
    if (st && st.initiator === 'restarting') st.initiator = false;
  }

  async function handleIceCandidate(peerId, candidate) {
    if (!candidate) return;
    var pc = peerConnections.get(peerId);
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      if (!iceCandidateQueues.has(peerId)) iceCandidateQueues.set(peerId, []);
      iceCandidateQueues.get(peerId).push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e2) { console.warn('[webrtc] Error adding ICE candidate:', e2); }
    }
  }

  async function drainIceCandidates(peerId, pc) {
    var queue = iceCandidateQueues.get(peerId);
    if (queue && queue.length > 0) {
      iceCandidateQueues.delete(peerId);
      for (const cand of queue) {
        try { await pc.addIceCandidate(cand); }
        catch (e) {
          try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
          catch (e2) { console.warn('[webrtc] Error applying queued candidate:', e2); }
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
    peers.delete(peerId);
    var tile = document.getElementById('tile-' + peerId);
    if (tile) tile.remove();
    if (pinnedPeerId === peerId) { pinnedPeerId = null; raiseLocalToHero(); }
  }

  // ------------------------------------------- 5. tiles: hero + rail ----
  function tileHtml(peerId, name, isLocal) {
    var initials = name.slice(0, 2).toUpperCase();
    var micState = isLocal ? audioMuted : (peers.get(peerId) ? peers.get(peerId).audioMuted : false);
    var camState = isLocal ? videoMuted : (peers.get(peerId) ? peers.get(peerId).videoMuted : false);
    var html = '';
    if (isLocal) {
      html =
        '<video id="local-video-feed" autoplay playsinline muted class="video-feed mirror"></video>' +
        '<div class="video-avatar-fallback" id="local-avatar-fallback" style="display:none;">' +
          '<div class="avatar-circle">' + esc(initials) + '</div>' +
          '<span class="avatar-name">' + esc(name) + ' (You)</span>' +
        '</div>';
    } else {
      html =
        '<video id="video-' + peerId + '" autoplay playsinline class="video-feed"></video>' +
        '<div class="video-avatar-fallback" id="avatar-' + peerId + '" style="display:none;">' +
          '<div class="avatar-circle">' + esc(initials) + '</div>' +
          '<span class="avatar-name">' + esc(name) + '</span>' +
        '</div>';
    }
    html +=
      '<div class="tile-bar">' +
        '<span class="tile-name">' + esc(name) + (isLocal ? ' (You)' : '') + '</span>' +
        '<div class="tile-icons">' +
          '<span id="' + (isLocal ? 'local-mic-icon' : 'mic-' + peerId) + '" class="status-icon' + (micState ? ' off' : '') + '"></span>' +
          '<span id="' + (isLocal ? 'local-cam-icon' : 'cam-' + peerId) + '" class="status-icon' + (camState ? ' off' : '') + '"></span>' +
        '</div>' +
      '</div>' +
      '<div class="speaking-glow" id="' + (isLocal ? 'local-speaking-glow' : 'glow-' + peerId) + '"></div>';
    return html;
  }

  function ensureLocalTile() {
    var tile = document.getElementById('tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile local-tile';
      tile.id = 'tile-local';
      tile.setAttribute('data-peer', 'local');
      tile.innerHTML = tileHtml('local', userName, true);
      document.getElementById('video-rail').appendChild(tile);
    }
    return tile;
  }

  function renderPeerTile(peerId, stream) {
    var st = peers.get(peerId);
    var name = st ? st.name : 'Participant';
    var tile = document.getElementById('tile-' + peerId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + peerId;
      tile.setAttribute('data-peer', peerId);
      tile.innerHTML = tileHtml(peerId, name, false);
      tile.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.tile-bar')) return;
        pinPeer(peerId);
      });
      document.getElementById('video-rail').appendChild(tile);
    }
    // Icon states (innerHTML because SVG markup comes from the icon bundle).
    var micEl = document.getElementById('mic-' + peerId);
    if (micEl) {
      micEl.innerHTML = ICONS[st && st.audioMuted ? 'micOff' : 'mic'] || '';
      micEl.classList.toggle('off', Boolean(st && st.audioMuted));
    }
    var camEl = document.getElementById('cam-' + peerId);
    if (camEl) {
      camEl.innerHTML = ICONS[st && st.videoMuted ? 'camOff' : 'cam'] || '';
      camEl.classList.toggle('off', Boolean(st && st.videoMuted));
    }
    var localMic = document.getElementById('local-mic-icon');
    if (localMic) localMic.innerHTML = ICONS[audioMuted ? 'micOff' : 'mic'] || '';
    var localCam = document.getElementById('local-cam-icon');
    if (localCam) localCam.innerHTML = ICONS[videoMuted ? 'camOff' : 'cam'] || '';

    var vid = document.getElementById('video-' + peerId);
    if (vid) {
      if (vid.srcObject !== stream) vid.srcObject = stream;
      vid.play().catch(() => {});
    }
    var hasVideo = stream && stream.getVideoTracks().some(function (t) { return t.enabled && t.readyState === 'live'; });
    var avatar = document.getElementById('avatar-' + peerId);
    if (avatar && vid) {
      var showAvatar = !hasVideo || (st && st.videoMuted);
      avatar.style.display = showAvatar ? 'grid' : 'none';
      vid.style.display = showAvatar ? 'none' : 'block';
    }
  }

  function currentHeroPeerId() {
    var hero = document.querySelector('#stage-hero .video-tile');
    return hero ? hero.getAttribute('data-peer') : null;
  }

  function setHero(peerId) {
    var tile = peerId === 'local' ? document.getElementById('tile-local') : document.getElementById('tile-' + peerId);
    if (!tile) return;
    var hero = document.getElementById('stage-hero');
    var current = hero.querySelector('.video-tile');
    if (current === tile) return;
    var rail = document.getElementById('video-rail');
    if (current) rail.appendChild(current);
    hero.appendChild(tile);
    var pinBtn = document.getElementById('hero-pin-btn');
    if (pinBtn) pinBtn.classList.toggle('pinned', pinnedPeerId !== null);
    // Re-evaluate preferred layers after the swap.
    peerConnections.forEach(function (pc, id) { preferVideoLayer(pc, id); });
  }

  function pinPeer(peerId) {
    if (pinnedPeerId === peerId) {
      pinnedPeerId = null; // unpin returns control to auto-raise
      toast('Unpinned — back to active speaker');
    } else {
      pinnedPeerId = peerId;
      setHero(peerId);
    }
    var pinBtn = document.getElementById('hero-pin-btn');
    if (pinBtn) pinBtn.classList.toggle('pinned', pinnedPeerId !== null);
  }

  function raiseLocalToHero() { setHero('local'); }

  // Dominant-speaker auto-raise: only when nobody is pinned.
  setInterval(function () {
    if (pinnedPeerId !== null) return;
    var now = Date.now();
    var best = null;
    var bestAt = 0;
    peers.forEach(function (st, id) {
      if (!st.audioMuted && st.lastSpoke > bestAt && now - st.lastSpoke < 4000) {
        bestAt = st.lastSpoke;
        best = id;
      }
    });
    if (!audioMuted && localLastSpoke > bestAt && now - localLastSpoke < 4000) best = 'local';
    if (best && currentHeroPeerId() !== best) setHero(best);
  }, 2500);

  function updatePeerMediaState(peerId, state) {
    var st = peers.get(peerId);
    if (!st) return;
    if (typeof state.audioMuted === 'boolean') st.audioMuted = state.audioMuted;
    if (typeof state.videoMuted === 'boolean') st.videoMuted = state.videoMuted;
    renderPeerTile(peerId, remoteStreams.get(peerId));
  }

  // ------------------------------------------- 6. audio meter / glow ----
  function setupAudioMeter(stream, onSpeak, glowElementId) {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx || !stream.getAudioTracks().length) return;
      var audioCtx = new AudioCtx();
      var source = audioCtx.createMediaStreamSource(stream);
      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      var dataArray = new Uint8Array(analyser.frequencyBinCount);

      var check = function () {
        var el = document.getElementById(glowElementId);
        if (!el) {
          audioCtx.close().catch(() => {});
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        var sum = 0;
        for (var i = 0; i < dataArray.length; i++) sum += dataArray[i];
        var avg = sum / dataArray.length;
        var speaking = avg > 16 && (glowElementId !== 'local-speaking-glow' || !audioMuted);
        el.classList.toggle('speaking', speaking);
        if (speaking) onSpeak();
        requestAnimationFrame(check);
      };
      check();
    } catch (e) {
      // Audio meter is a visual enhancement; non-fatal
    }
  }

  // --------------------------------------------- 7. media controls ----
  function toggleAudio() {
    audioMuted = !audioMuted;
    if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !audioMuted; });
    refreshAudioBtn();
    broadcastMediaState();
  }

  function refreshAudioBtn() {
    var btn = document.getElementById('btn-toggle-audio');
    if (!btn) return;
    btn.classList.toggle('muted', audioMuted);
    btn.setAttribute('title', audioMuted ? 'Unmute (Ctrl+D)' : 'Mute (Ctrl+D)');
    var iconWrap = btn.querySelector('[data-icon]');
    if (iconWrap) iconWrap.innerHTML = ICONS[audioMuted ? 'micOff' : 'mic'] || '';
    var micIcon = document.getElementById('local-mic-icon');
    if (micIcon) {
      micIcon.innerHTML = ICONS[audioMuted ? 'micOff' : 'mic'] || '';
      micIcon.classList.toggle('off', audioMuted);
    }
  }

  function toggleVideo() {
    videoMuted = !videoMuted;
    if (localStream) localStream.getVideoTracks().forEach(function (t) { t.enabled = !videoMuted; });
    var localVideo = document.getElementById('local-video-feed');
    var localAvatar = document.getElementById('local-avatar-fallback');
    if (localVideo) localVideo.style.display = videoMuted ? 'none' : 'block';
    if (localAvatar) localAvatar.style.display = videoMuted ? 'grid' : 'none';
    refreshCamBtn();
    broadcastMediaState();
  }

  function refreshCamBtn() {
    var btn = document.getElementById('btn-toggle-video');
    if (!btn) return;
    btn.classList.toggle('muted', videoMuted);
    btn.setAttribute('title', videoMuted ? 'Start video (Ctrl+E)' : 'Stop video (Ctrl+E)');
    var iconWrap = btn.querySelector('[data-icon]');
    if (iconWrap) iconWrap.innerHTML = ICONS[videoMuted ? 'camOff' : 'cam'] || '';
    var camIcon = document.getElementById('local-cam-icon');
    if (camIcon) {
      camIcon.innerHTML = ICONS[videoMuted ? 'camOff' : 'cam'] || '';
      camIcon.classList.toggle('off', videoMuted);
    }
  }

  async function toggleScreenShare() {
    if (!screenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        var screenTrack = screenStream.getVideoTracks()[0];
        screenSharing = true;
        var shareBtn = document.getElementById('btn-share-screen');
        if (shareBtn) shareBtn.classList.add('active');

        var localVideo = document.getElementById('local-video-feed');
        if (localVideo) localVideo.srcObject = screenStream;

        for (const pc of peerConnections.values()) {
          var sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; })
            || pc.getSenders().find(function (s) { return !s.track; });
          if (sender) sender.replaceTrack(screenTrack);
          else pc.addTrack(screenTrack, screenStream);
        }
        screenTrack.onended = function () { stopScreenShare(); };
        toast('You are presenting. The main view shows your screen.');
      } catch (err) {
        console.warn('Screen share cancelled/denied:', err);
      }
    } else {
      stopScreenShare();
    }
    broadcastMediaState();
  }

  function stopScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      screenStream = null;
    }
    screenSharing = false;
    var shareBtn = document.getElementById('btn-share-screen');
    if (shareBtn) shareBtn.classList.remove('active');
    var localVideo = document.getElementById('local-video-feed');
    if (localVideo && localStream) {
      localVideo.srcObject = localStream;
      localVideo.style.display = videoMuted ? 'none' : 'block';
    }
    if (localStream) {
      var camTrack = localStream.getVideoTracks()[0];
      for (const pc of peerConnections.values()) {
        var sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
        if (sender && camTrack) sender.replaceTrack(camTrack);
      }
    }
    broadcastMediaState();
  }

  function broadcastMediaState() {
    wsSend({ type: 'media-state', meetingId: meetingId, payload: { audioMuted: audioMuted, videoMuted: videoMuted, screenSharing: screenSharing } });
  }

  // ----------------------------------------------- 8. recording ----
  function toggleRecording() {
    if (!isHost) { toast('Only the host can control recording.'); return; }
    if (!isRecording) startRecording();
    else stopRecording();
  }

  function startRecording() {
    if (!localStream) return;
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    } catch (e) {
      mediaRecorder = new MediaRecorder(localStream);
    }
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async function () {
      var blob = new Blob(recordedChunks, { type: 'video/webm' });
      var durationSec = Math.max(1, Math.round((Date.now() - meetingStartTime) / 1000));
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/recording?durationSeconds=' + durationSec, {
        method: 'POST',
        headers: { 'Content-Type': 'video/webm', 'x-vital-csrf': csrfToken },
        body: blob
      }).catch(console.error);
    };
    mediaRecorder.start(3000);
    isRecording = true;
    updateRecordingUI();
    wsSend({ type: 'recording-state', meetingId: meetingId, payload: { isRecording: true } });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    isRecording = false;
    updateRecordingUI();
    wsSend({ type: 'recording-state', meetingId: meetingId, payload: { isRecording: false } });
  }

  function updateRecordingUI() {
    var badge = document.getElementById('recording-status-badge');
    var txt = document.getElementById('recording-status-text');
    var lbl = document.getElementById('lbl-recording');
    if (badge) badge.className = 'recording-badge ' + (isRecording ? 'active' : '');
    if (txt) txt.textContent = isRecording ? 'Recording' : 'Not Recording';
    if (lbl) lbl.textContent = isRecording ? 'Stop Rec' : 'Record';
    var btn = document.getElementById('btn-toggle-rec');
    if (btn) btn.classList.toggle('active', isRecording);
  }

  // ------------------------------------- 9. STT / live transcription ----
  function initSpeechRecognitionOrSTT() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    var recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = function (event) {
      for (var i = event.resultIndex; i < event.results.length; ++i) {
        if (!event.results[i].isFinal) continue;
        var text = event.results[i][0].transcript.trim();
        if (!text) continue;
        var nowSec = Math.round((Date.now() - meetingStartTime) / 1000);
        var segment = {
          speakerId: userId,
          speakerName: userName,
          startTime: nowSec,
          endTime: nowSec + 3,
          text: text,
          confidence: event.results[i][0].confidence || 0.95
        };
        wsSend({ type: 'live-transcript', meetingId: meetingId, payload: segment });
        renderTranscriptSegment(segment);
        fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-vital-csrf': csrfToken },
          body: JSON.stringify(segment)
        }).catch(console.error);
      }
    };
    recognition.onerror = function (e) { console.warn('Speech recognition warning:', e); };
    recognition.onend = function () {
      if (!audioMuted && recognition) { try { recognition.start(); } catch (e) {} }
    };
    try { recognition.start(); } catch (e) {}
  }

  function renderTranscriptSegment(seg) {
    var emptyState = document.getElementById('transcript-empty-state');
    if (emptyState) emptyState.style.display = 'none';
    var feed = document.getElementById('transcript-feed');
    if (!feed) return;
    var row = document.createElement('div');
    row.className = 'transcript-entry';
    var m = Math.floor(seg.startTime / 60).toString().padStart(2, '0');
    var s = Math.floor(seg.startTime % 60).toString().padStart(2, '0');
    row.innerHTML = '<div class="transcript-meta"><span class="transcript-speaker">' + esc(seg.speakerName)
      + '</span><span class="transcript-time">' + m + ':' + s + '</span></div><div class="transcript-body">'
      + esc(seg.text) + '</div>';
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
    updateLiveNotesFromText(seg.speakerName, seg.text);
  }

  function updateLiveNotesFromText(speaker, text) {
    if (/\blaunch|decided|target\b/i.test(text)) {
      var decisions = document.getElementById('live-decisions-list');
      if (decisions) {
        var muted = decisions.querySelector('.notes-muted');
        if (muted) muted.remove();
        var li = document.createElement('li');
        li.textContent = text;
        decisions.appendChild(li);
      }
    }
    if (/\bwill handle|will deploy|prepare|implement\b/i.test(text)) {
      var actions = document.getElementById('live-actions-list');
      if (actions) {
        var muted2 = actions.querySelector('.notes-muted');
        if (muted2) muted2.remove();
        var li2 = document.createElement('li');
        li2.textContent = speaker + ' — ' + text;
        actions.appendChild(li2);
      }
    }
  }

  // ---------------------------------------------------- 10. chat ----
  function sendChatMessage(e) {
    e.preventDefault();
    var input = document.getElementById('chat-input-text');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    addChatMessage(userName, text); // local echo; remote peers get it via ws
    wsSend({ type: 'chat-message', meetingId: meetingId, payload: { text: text } });
  }

  function addChatMessage(author, text, isSystem) {
    var feed = document.getElementById('chat-feed');
    if (!feed) return;
    var div = document.createElement('div');
    div.className = 'chat-entry' + (isSystem ? ' system' : '');
    var t = new Date();
    var hh = t.getHours().toString().padStart(2, '0');
    var mm = t.getMinutes().toString().padStart(2, '0');
    if (isSystem) {
      div.innerHTML = '<span class="chat-text">' + esc(text) + '</span>';
    } else {
      div.innerHTML = '<span class="chat-time">' + hh + ':' + mm + '</span>'
        + '<span class="chat-author">' + esc(author) + ':</span> <span class="chat-text">' + esc(text) + '</span>';
    }
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  // ------------------------------------------ 11. duration clock ----
  var clockTimer = setInterval(tickClock, 1000);
  function tickClock() {
    var sec = Math.floor((Date.now() - meetingStartTime) / 1000);
    var m = Math.floor(sec / 60).toString().padStart(2, '0');
    var s = (sec % 60).toString().padStart(2, '0');
    var el = document.getElementById('meeting-duration-clock');
    if (el) el.textContent = m + ':' + s;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(clockTimer);
    } else {
      tickClock();
      clockTimer = setInterval(tickClock, 1000);
    }
  });

  // ------------------------------- 12. device enumeration & switching ----
  async function enumerateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    var devices = await navigator.mediaDevices.enumerateDevices();
    var micSelect = document.getElementById('select-mic');
    var camSelect = document.getElementById('select-cam');
    var spkSelect = document.getElementById('select-speaker');
    if (!micSelect || !camSelect || !spkSelect) return;
    micSelect.innerHTML = '';
    camSelect.innerHTML = '';
    spkSelect.innerHTML = '';
    devices.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || (d.kind + ' (' + d.deviceId.slice(0, 5) + ')');
      if (d.kind === 'audioinput') micSelect.appendChild(opt);
      else if (d.kind === 'videoinput') camSelect.appendChild(opt);
      else if (d.kind === 'audiooutput') spkSelect.appendChild(opt);
    });
  }

  async function changeAudioInput(deviceId) {
    if (!deviceId) return;
    try {
      var newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      var newTrack = newStream.getAudioTracks()[0];
      if (localStream && newTrack) {
        var oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
        localStream.addTrack(newTrack);
        newTrack.enabled = !audioMuted;
        for (const pc of peerConnections.values()) {
          var sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'audio'; })
            || pc.getSenders().find(function (s) { return !s.track; });
          if (sender) sender.replaceTrack(newTrack);
          else pc.addTrack(newTrack, localStream);
        }
      }
    } catch (e) { console.warn('Microphone switch failed:', e); }
  }

  async function changeVideoInput(deviceId) {
    if (!deviceId) return;
    try {
      var newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      var newTrack = newStream.getVideoTracks()[0];
      if (localStream && newTrack) {
        var oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
        localStream.addTrack(newTrack);
        newTrack.enabled = !videoMuted;
        var localVideo = document.getElementById('local-video-feed');
        if (localVideo && !screenSharing) localVideo.srcObject = localStream;
        for (const pc of peerConnections.values()) {
          var sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; })
            || pc.getSenders().find(function (s) { return !s.track; });
          if (sender && !screenSharing) sender.replaceTrack(newTrack);
          else if (!screenSharing) pc.addTrack(newTrack, localStream);
        }
      }
    } catch (e) { console.warn('Camera switch failed:', e); }
  }

  async function changeAudioOutput(deviceId) {
    if (!deviceId) return;
    try {
      var videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (typeof v.setSinkId === 'function') await v.setSinkId(deviceId);
      }
    } catch (e) { console.warn('Speaker output sink switch failed:', e); }
  }

  // --------------------------------------- 13. modals & panels ----
  function openModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'grid';
  }
  function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  }
  function toggleParticipantsModal() {
    var modal = document.getElementById('participants-modal');
    if (!modal) return;
    var isHidden = modal.style.display === 'none' || !modal.style.display;
    if (isHidden) {
      updateParticipantsModalList();
      var shareInput = document.getElementById('meeting-share-url');
      if (shareInput) shareInput.value = window.location.href;
    }
    modal.style.display = isHidden ? 'grid' : 'none';
  }
  function copyMeetingLink() {
    var shareInput = document.getElementById('meeting-share-url');
    if (!shareInput) return;
    navigator.clipboard.writeText(shareInput.value).then(function () {
      var notice = document.getElementById('copied-notice');
      if (notice) {
        notice.style.display = 'inline';
        setTimeout(function () { notice.style.display = 'none'; }, 2500);
      }
    }).catch(console.error);
  }
  function updateParticipantsModalList() {
    var list = document.getElementById('modal-participants-list');
    if (!list) return;
    list.innerHTML = '';
    var localLi = document.createElement('li');
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
        iconSvg(audioMuted ? 'micOff' : 'mic') +
        iconSvg(videoMuted ? 'camOff' : 'cam') +
      '</div>';
    list.appendChild(localLi);
    peers.forEach(function (st, peerId) {
      var li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML =
        '<div class="participant-info">' +
          '<div class="avatar-mini">' + esc(st.name.slice(0, 2).toUpperCase()) + '</div>' +
          '<div class="participant-details">' +
            '<span class="participant-name">' + esc(st.name) + '</span>' +
            '<span class="participant-role-pill">Peer</span>' +
          '</div>' +
        '</div>' +
        '<div class="participant-media-status">' +
          iconSvg(st.audioMuted ? 'micOff' : 'mic') +
          iconSvg(st.videoMuted ? 'camOff' : 'cam') +
        '</div>';
      list.appendChild(li);
    });
  }
  function toggleIntelPanel(force) {
    var panel = document.getElementById('intel-panel');
    if (!panel) return;
    if (typeof force === 'boolean') panel.classList.toggle('open', force);
    else panel.classList.toggle('open');
    var btn = document.getElementById('btn-toggle-intel');
    if (btn) btn.classList.toggle('active', panel.classList.contains('open'));
  }
  function openDeviceSettingsModal() {
    openModal('device-modal');
    enumerateDevices().catch(function () {});
  }
  function switchIntelTab(tab, btn) {
    document.querySelectorAll('.intel-tab').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.intel-content').forEach(function (c) { c.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    var content = document.getElementById('tab-' + tab);
    if (content) content.classList.add('active');
  }

  // ------------------------------------------- 14. fullscreen ----
  function toggleFullscreen() {
    var container = document.getElementById('meeting-room-app');
    if (!document.fullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(function () { toast('Fullscreen was blocked by the browser.'); });
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  }
  document.addEventListener('fullscreenchange', function () {
    var btn = document.getElementById('btn-fullscreen');
    if (!btn) return;
    var wrap = btn.querySelector('[data-icon]');
    if (wrap) wrap.innerHTML = ICONS[document.fullscreenElement ? 'collapse' : 'expand'] || '';
  });

  // --------------------------------------- 15. toasts & banner ----
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('meeting-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'meeting-toast';
      el.className = 'meeting-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  var failedPeers = new Set();
  function showConnBanner(peerId, name) {
    failedPeers.add(peerId);
    renderConnBanner();
  }
  function hideConnBanner(peerId) {
    if (!failedPeers.delete(peerId)) return;
    renderConnBanner();
  }
  function renderConnBanner() {
    var banner = document.getElementById('conn-banner');
    if (!banner) return;
    if (failedPeers.size === 0) {
      banner.classList.remove('show');
      return;
    }
    var hasTurn = iceServers.some(function (s) { return String(s.urls).indexOf('turn') === 0; });
    var names = Array.from(failedPeers).map(function (id) {
      var st = peers.get(id);
      return st ? st.name : 'a participant';
    });
    var msg = 'Media connection failed with ' + names.join(', ') + '. '
      + (hasTurn ? 'Retrying via relay...' : 'Your network may block peer-to-peer (no TURN relay configured).');
    banner.querySelector('.conn-banner-text').textContent = msg;
    banner.classList.add('show');
  }
  function retryFailedPeers() {
    failedPeers.forEach(function (peerId) {
      var pc = peerConnections.get(peerId);
      var st = peers.get(peerId);
      if (pc && st) {
        st.initiator = true;
        iceRestart(peerId, pc);
      }
    });
  }

  // ---------------------------------- 16. leave / end (styled modal) ----
  function confirmLeaveOrEnd() {
    openModal('leave-modal');
  }
  async function doLeave() {
    closeModal('leave-modal');
    if (isRecording) {
      stopRecording();
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    var headers = { 'x-vital-csrf': csrfToken };
    if (isHost) {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/end', { method: 'POST', headers: headers }).catch(function () {});
      window.location.href = home + 'console/meetings/detail?id=' + encodeURIComponent(meetingId);
    } else {
      await fetch(home + 'api/meetings/' + encodeURIComponent(meetingId) + '/leave', { method: 'POST', headers: headers }).catch(function () {});
      window.location.href = home + 'console/meetings';
    }
  }

  // ------------------------------------- 17. keyboard shortcuts ----
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      toggleAudio();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      toggleVideo();
    }
  });

  // --------------------------------- 18. event delegation wiring ----
  document.addEventListener('click', function (e) {
    var tabBtn = e.target.closest ? e.target.closest('.intel-tab') : null;
    if (tabBtn) {
      switchIntelTab(tabBtn.getAttribute('data-tab'), tabBtn);
      return;
    }
    var modalClose = e.target.closest ? e.target.closest('[data-close-modal]') : null;
    if (modalClose) {
      closeModal(modalClose.getAttribute('data-close-modal'));
      return;
    }
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    switch (btn.getAttribute('data-action')) {
      case 'toggle-audio': toggleAudio(); break;
      case 'toggle-video': toggleVideo(); break;
      case 'toggle-screen': toggleScreenShare(); break;
      case 'toggle-recording': toggleRecording(); break;
      case 'toggle-participants': toggleParticipantsModal(); break;
      case 'copy-link': copyMeetingLink(); break;
      case 'toggle-intel': toggleIntelPanel(); break;
      case 'open-device-modal': openDeviceSettingsModal(); break;
      case 'toggle-fullscreen': toggleFullscreen(); break;
      case 'pin-hero': pinPeer(currentHeroPeerId()); break;
      case 'retry-peers': retryFailedPeers(); break;
      case 'leave': confirmLeaveOrEnd(); break;
      case 'confirm-leave': doLeave(); break;
      case 'cancel-leave': closeModal('leave-modal'); break;
      default: break;
    }
  });

  var chatForm = document.getElementById('chat-form');
  if (chatForm) chatForm.addEventListener('submit', sendChatMessage);
  var micSel = document.getElementById('select-mic');
  if (micSel) micSel.addEventListener('change', function () { changeAudioInput(micSel.value); });
  var camSel = document.getElementById('select-cam');
  if (camSel) camSel.addEventListener('change', function () { changeVideoInput(camSel.value); });
  var spkSel = document.getElementById('select-speaker');
  if (spkSel) spkSel.addEventListener('change', function () { changeAudioOutput(spkSel.value); });

  // Hero tile click unpins (returns to auto-raise).
  var hero = document.getElementById('stage-hero');
  if (hero) {
    hero.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tile-bar')) return;
      if (pinnedPeerId !== null) pinPeer(pinnedPeerId);
    });
  }

  // Self tile exists from the start; keep the local user last in the rail.
  ensureLocalTile();
  raiseLocalToHero();
  refreshAudioBtn();
  refreshCamBtn();
})();`;
