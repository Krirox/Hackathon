/**
 * Live meeting room stylesheet, served as a cached static asset.
 *
 * Moved out of the inline <style> in renderMeetingRoomView() so the room HTML
 * is a small cached-friendly document. All colors come from the stage token
 * family inlined into the room <head> via stageTokensCss() — never a raw hex
 * in here. Layout is speaker-view: a full-bleed hero video, a vertical rail
 * of remote tiles (the container keeps the legacy `video-grid` class name),
 * a floating pill toolbar, and an intelligence drawer that overlays the stage
 * instead of shrinking it.
 */
export const MEETING_ROOM_CSS = String.raw`
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  height: 100dvh;
  overflow: hidden;
  background: var(--v-stage-canvas);
  color: var(--v-stage-ink);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }

.meeting-container {
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  background: var(--v-stage-void);
  color: var(--v-stage-ink);
  overflow: hidden;
}

/* ---- Floating header: title cluster over the hero video ---- */
.meeting-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  min-height: 56px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 18px;
  z-index: 30;
  pointer-events: none;
  background: linear-gradient(to bottom, var(--v-stage-shadow-60), transparent);
}
.meeting-header > * { pointer-events: auto; }
.meeting-title-cluster { display: flex; align-items: center; gap: 10px; }
.meeting-back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: var(--v-stage-white);
  background: var(--v-stage-scrim);
  backdrop-filter: blur(6px);
  border-radius: 50%;
  text-decoration: none;
}
.meeting-back-btn:hover { background: var(--v-stage-line-strong); }
.meeting-title {
  font-size: 16px;
  font-weight: 650;
  color: var(--v-stage-white);
  margin: 0;
  text-shadow: 0 1px 8px var(--v-stage-shadow-60);
}
.meeting-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--v-stage-white-5);
  text-shadow: 0 1px 6px var(--v-stage-shadow-60);
}
.meeting-meta > span, .meeting-meta > .badge { color: var(--v-stage-ink-2); }
.participant-count-inline { display: inline-flex; align-items: center; gap: 5px; }
.participant-count-inline svg { width: 14px; height: 14px; }
.badge-scope {
  background: var(--v-stage-accent-dim);
  color: var(--v-stage-accent-bright);
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}
.conn-status-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.conn-status-pill.connected .status-dot { width: 6px; height: 6px; background: var(--v-stage-good); border-radius: 50%; }
.conn-status-pill.disconnected .status-dot { width: 6px; height: 6px; background: var(--v-stage-risk); border-radius: 50%; }
.meeting-header-actions { display: flex; align-items: center; gap: 8px; }
.meeting-header-actions [data-icon] { display: inline-flex; vertical-align: -2px; }
.meeting-header-actions [data-icon] svg { width: 14px; height: 14px; }
.recording-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--v-stage-scrim);
  color: var(--v-stage-muted-2);
}
.recording-badge.active { background: var(--v-stage-risk-dim); color: var(--v-stage-risk-ink); font-weight: 600; }
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--v-stage-muted); }
.recording-badge.active .rec-dot { background: var(--v-stage-risk); animation: pulse 1.5s infinite; }
@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }

/* ---- Stage: hero + rail (speaker view) ---- */
.meeting-main-area {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.meeting-stage {
  position: absolute;
  inset: 0;
  padding: 10px;
  display: flex;
}
.stage-hero {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  border-radius: 18px;
  overflow: hidden;
  background: var(--v-stage-1);
}
.stage-hero .video-tile {
  position: absolute;
  inset: 0;
  border-radius: 18px;
  border: none;
  aspect-ratio: auto;
}
.stage-hero .video-tile video { object-fit: contain; }
.hero-pin-btn {
  position: absolute;
  top: 66px;
  right: 12px;
  z-index: 5;
  width: 32px;
  height: 32px;
  display: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--v-stage-scrim);
  color: var(--v-stage-white);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.stage-hero:hover .hero-pin-btn { opacity: 1; }
.hero-pin-btn.pinned { display: inline-flex; opacity: 1; background: var(--v-stage-accent-dim); }

.video-rail {
  position: absolute;
  top: 64px;
  right: 16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: clamp(140px, 18vw, 210px);
  max-height: calc(100% - 160px);
  overflow-y: auto;
  scrollbar-width: none;
  padding: 2px;
}
.video-rail::-webkit-scrollbar { display: none; }
.video-rail .video-tile {
  flex-shrink: 0;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  cursor: pointer;
}
.video-rail .video-tile:hover { border-color: var(--v-stage-accent-bright); }
.video-rail .tile-bar { font-size: 10.5px; padding: 3px 6px; bottom: 5px; left: 5px; right: 5px; }
.video-rail .tile-bar .status-icon svg { width: 12px; height: 12px; }

.video-tile {
  background: var(--v-stage-4);
  border-radius: 12px;
  border: 1px solid var(--v-stage-line-3);
  overflow: hidden;
  position: relative;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-feed { width: 100%; height: 100%; object-fit: cover; }
.video-feed.mirror { transform: scaleX(-1); }
.video-avatar-fallback { display: grid; place-items: center; gap: 8px; }
.avatar-circle {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--v-stage-accent-dim);
  color: var(--v-stage-accent-bright);
  font-size: 24px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.stage-hero .avatar-circle { width: 96px; height: 96px; font-size: 36px; }
.avatar-name { font-size: 13px; color: var(--v-stage-muted-2); }
.tile-bar {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--v-stage-scrim);
  backdrop-filter: blur(4px);
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--v-stage-ink);
}
.tile-icons { display: inline-flex; gap: 6px; }
.status-icon { display: inline-flex; align-items: center; color: inherit; }
.status-icon svg { width: 14px; height: 14px; }
.status-icon.off { color: var(--v-stage-risk-ink); }
.speaking-glow {
  position: absolute;
  inset: 0;
  border: 2px solid var(--v-stage-good);
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.speaking-glow.speaking { opacity: 1; box-shadow: 0 0 16px var(--v-stage-good-70); }

/* ---- Floating pill toolbar ---- */
.meeting-toolbar {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-pill);
  background: var(--v-stage-scrim);
  border: 1px solid var(--v-stage-line);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px var(--v-stage-shadow-60);
  max-width: calc(100vw - 24px);
}
.toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 10px; }
.tool-btn {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--v-stage-line);
  border: 1px solid var(--v-stage-line-strong);
  color: var(--v-stage-ink-strong);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}
.tool-btn svg { width: 20px; height: 20px; }
.tool-btn:hover { background: var(--v-stage-line-strong); }
.tool-btn.muted { background: var(--v-stage-risk-dim); border-color: var(--v-stage-risk); color: var(--v-stage-risk-ink); }
.tool-btn.active { background: var(--v-stage-accent-dim); border-color: var(--v-stage-accent-bright); color: var(--v-stage-white); }
.tool-btn.danger {
  background: var(--v-stage-risk-2);
  border-color: var(--v-stage-risk);
  color: var(--v-stage-white);
  width: 54px;
  height: 54px;
}
.tool-btn.danger:hover { background: var(--v-stage-risk); }
.tool-btn.danger svg { width: 24px; height: 24px; }
.btn-label { position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-size: 10px; color: var(--v-stage-muted-2); white-space: nowrap; display: none; }
.tool-btn { position: relative; }
.tool-btn:hover .btn-label { display: block; }

/* ---- Buttons / modals ---- */
.btn { padding: 8px 16px; border-radius: 6px; font-weight: 500; font-size: 13px; cursor: pointer; border: none; }
.btn-primary { background: var(--v-stage-accent-dim); color: var(--v-stage-white); }
.btn-primary:hover { background: var(--v-stage-accent-2); }
.btn-secondary { background: var(--v-stage-line); color: var(--v-stage-ink); border: 1px solid var(--v-stage-line-strong); }
.btn-danger { background: var(--v-stage-risk-2); color: var(--v-stage-white); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.meeting-modal {
  position: fixed;
  inset: 0;
  background: var(--v-stage-shadow-70);
  display: grid;
  place-items: center;
  z-index: 999;
}
.modal-card {
  width: 440px;
  max-width: calc(100vw - 32px);
  background: var(--v-stage-3);
  border: 1px solid var(--v-stage-line-strong);
  border-radius: 12px;
  padding: 20px;
  color: var(--v-stage-ink-strong);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.modal-header h3 { margin: 0; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--v-stage-muted-2); font-size: 16px; cursor: pointer; display: inline-flex; }
.modal-close svg { width: 16px; height: 16px; }
.modal-footer { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.modal-copy { margin: 0; font-size: 13px; line-height: 1.5; color: var(--v-stage-ink-2); }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--v-stage-muted-2); }
.form-select { width: 100%; background: var(--v-stage-line); border: 1px solid var(--v-stage-line-strong); color: var(--v-stage-ink-strong); padding: 8px; border-radius: 6px; }

/* ---- Intelligence drawer (overlay) ---- */
.intel-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: min(380px, 92vw);
  background: var(--v-stage-1);
  border-left: 1px solid var(--v-stage-line);
  display: flex;
  flex-direction: column;
  z-index: 45;
  transform: translateX(100%);
  transition: transform 0.22s var(--ease-out);
  box-shadow: -12px 0 32px var(--v-stage-shadow-50);
}
.intel-panel.open { transform: translateX(0); }
.intel-tabs { display: flex; border-bottom: 1px solid var(--v-stage-line); background: var(--v-stage-2); }
.intel-tab {
  flex: 1;
  background: none;
  border: none;
  color: var(--v-stage-muted-2);
  padding: 10px 0;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.intel-tab.active { color: var(--v-stage-accent-bright); border-bottom: 2px solid var(--v-stage-accent-dim); font-weight: 600; }
.intel-content { display: none; flex: 1; overflow-y: auto; min-height: 0; flex-direction: column; }
.intel-content.active { display: flex; }
.transcript-stream { flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.transcript-placeholder { color: var(--v-stage-muted); font-size: 12px; text-align: center; margin-top: 40px; }
.transcript-entry { background: var(--v-stage-5); border: 1px solid var(--v-stage-line-2); border-radius: 8px; padding: 8px 10px; }
.transcript-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--v-stage-accent-bright); margin-bottom: 4px; }
.transcript-body { font-size: 12.5px; color: var(--v-stage-soft); line-height: 1.4; }
.notes-section { padding: 12px; border-bottom: 1px solid var(--v-stage-line); }
.notes-heading { font-size: 11px; text-transform: uppercase; color: var(--v-stage-muted); margin-bottom: 6px; }
.notes-list { list-style: disc inside; font-size: 12px; color: var(--v-stage-ink); }
.notes-muted { list-style: none; color: var(--v-stage-muted); font-style: italic; }

/* ---- Chat ---- */
.chat-stream { flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.chat-entry { font-size: 12.5px; line-height: 1.4; word-break: break-word; background: var(--v-stage-5); border: 1px solid var(--v-stage-line-2); border-radius: 8px; padding: 8px 10px; }
.chat-entry.system { background: none; border: none; color: var(--v-stage-muted); font-size: 11.5px; padding: 2px 10px; }
.chat-author { font-weight: 600; color: var(--v-stage-accent-bright); margin-right: 6px; }
.chat-time { float: right; font-size: 10px; color: var(--v-stage-faint); margin-left: 8px; }
.chat-text { color: var(--v-stage-ink); }
.chat-input-bar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--v-stage-line); background: var(--v-stage-2); }
.chat-input-bar input {
  flex: 1;
  background: var(--v-stage-line);
  border: 1px solid var(--v-stage-line-strong);
  color: var(--v-stage-ink-strong);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.chat-input-bar input:focus { border-color: var(--v-stage-accent-bright); }
.chat-send { display: inline-flex; align-items: center; }
.chat-send svg { width: 15px; height: 15px; }

/* ---- Participants list / share link ---- */
.share-link-box { margin-bottom: 16px; background: var(--v-stage-1); padding: 10px 12px; border-radius: 8px; border: 1px solid var(--v-stage-line); }
.share-link-box label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--v-stage-muted); display: block; margin-bottom: 6px; }
.input-copy-group { display: flex; gap: 8px; }
.input-copy-group input {
  flex: 1;
  background: var(--v-stage-line);
  border: 1px solid var(--v-stage-line-strong);
  color: var(--v-stage-ink-strong);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.copied-indicator { display: inline-block; font-size: 11px; color: var(--v-stage-good); margin-top: 6px; font-weight: 500; }
.participants-list-wrap { max-height: 240px; overflow-y: auto; border: 1px solid var(--v-stage-line); border-radius: 8px; background: var(--v-stage-1); }
.participants-list { list-style: none; margin: 0; padding: 0; }
.participant-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--v-stage-7); }
.participant-item:last-child { border-bottom: none; }
.participant-info { display: flex; align-items: center; gap: 10px; }
.avatar-mini {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--v-stage-accent-dim);
  color: var(--v-stage-accent-bright);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
}
.participant-details { display: flex; flex-direction: column; }
.participant-name { font-size: 13px; font-weight: 500; color: var(--v-stage-ink-strong); }
.participant-role-pill { font-size: 10px; color: var(--v-stage-muted-2); }
.participant-media-status { display: flex; gap: 6px; }
.participant-media-status .status-icon svg { width: 14px; height: 14px; }

/* ---- Toast + connection banner ---- */
.meeting-toast {
  position: fixed;
  bottom: 92px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--v-stage-scrim);
  color: var(--v-stage-white);
  border: 1px solid var(--v-stage-line-strong);
  padding: 8px 16px;
  border-radius: var(--radius-pill);
  font-size: 12.5px;
  z-index: 300;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
  backdrop-filter: blur(8px);
}
.meeting-toast.show { opacity: 1; }
.conn-banner {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: none;
  align-items: center;
  gap: 8px;
  background: var(--v-stage-risk-dim);
  border: 1px solid var(--v-stage-risk);
  color: var(--v-stage-risk-ink);
  font-size: 12.5px;
  padding: 8px 14px;
  border-radius: 10px;
  max-width: min(560px, 92vw);
}
.conn-banner.show { display: inline-flex; }
.conn-banner svg { width: 16px; height: 16px; flex-shrink: 0; }
.conn-banner button { background: none; border: none; color: var(--v-stage-accent-bright); cursor: pointer; font-size: 12px; text-decoration: underline; padding: 0; }

/* ---- Responsive ---- */
@media (max-width: 768px) {
  .meeting-header { padding: 10px 12px; }
  .meeting-title { font-size: 14px; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .video-rail { top: 56px; right: 10px; width: clamp(110px, 30vw, 150px); gap: 8px; }
  .meeting-toolbar { gap: 8px; padding: 6px 10px; bottom: 14px; }
  .tool-btn { width: 42px; height: 42px; }
  .tool-btn.danger { width: 48px; height: 48px; }
  .stage-hero { border-radius: 14px; }
}
@media (max-width: 540px) {
  .video-rail { max-height: 46%; }
  .tool-btn svg { width: 18px; height: 18px; }
}
@media (max-height: 560px) {
  .meeting-toolbar { bottom: 8px; padding: 5px 10px; }
  .video-rail { max-height: 60%; }
}
`;
