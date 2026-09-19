/**
 * Meeting room inline SVG icons.
 *
 * The live room used to render emoji (🎤 📹 ️ …) as its control glyphs. Emoji
 * paint differently on every OS, cannot express a "muted" state except by
 * stacking a second emoji, and are read verbosely by screen readers. These are
 * 24×24 stroke icons on currentColor, in the same spirit as buzz-icons.ts, so
 * state is a glyph swap (mic vs. mic-off) and color comes from the tile/button.
 *
 * The room ships its client as a static asset, so icon markup lives here (a
 * plain data module) and is injected by meeting-room-js on load; the server
 * HTML only emits `<span data-icon="name">` placeholders.
 */

const svg = (body: string, filled = false): string =>
  `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const MEETING_ICONS: Record<string, string> = {
  mic: svg('<path d="M12 3a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="17.5" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/>'),
  micOff: svg('<line x1="3.5" y1="3.5" x2="20.5" y2="20.5"/><path d="M9 5.5A3 3 0 0 1 15 6v4"/><path d="M18.4 13.5A6.5 6.5 0 0 0 18.5 11"/><path d="M5.5 11a6.5 6.5 0 0 0 9.9 5.55"/><line x1="12" y1="17.5" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/>'),
  cam: svg('<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 11l5-3v8l-5-3z"/>'),
  camOff: svg('<line x1="3.5" y1="3.5" x2="20.5" y2="20.5"/><path d="M5.5 6.5h7.5a2.5 2.5 0 0 1 2.5 2.5v1.6"/><path d="M14 17.5H5.5A2.5 2.5 0 0 1 3 15V9"/><path d="M20.5 8v8l-5-3"/>'),
  screen: svg('<rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  rec: svg('<circle cx="12" cy="12" r="6"/>', true),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.7"/><path d="M17 13.6a5.5 5.5 0 0 1 3.5 5.4"/>'),
  brain: svg('<path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 12 19a3 3 0 0 0 4.5-5.4A3 3 0 0 0 15 8a3 3 0 0 0-3-3z"/><line x1="12" y1="5" x2="12" y2="19"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>'),
  expand: svg('<polyline points="9 4.5 4.5 4.5 4.5 9"/><polyline points="15 19.5 19.5 19.5 19.5 15"/><polyline points="15 4.5 19.5 4.5 19.5 9"/><polyline points="9 19.5 4.5 19.5 4.5 15"/>'),
  collapse: svg('<polyline points="4.5 9 9 9 9 4.5"/><polyline points="15 19.5 15 15 19.5 15"/><polyline points="19.5 9 15 9 15 4.5"/><polyline points="9 19.5 9 15 4.5 15"/>'),
  hangup: svg('<path d="M3.2 11.5c4-4.5 13.6-4.5 17.6 0l-2 2.4-3.8-1v-2.4c-2.7-.8-5.3-.8-8 0v2.4l-3.8 1z"/>', true),
  pin: svg('<path d="M12 3.5v7"/><path d="M8 6.5l4-3 4 3"/><path d="M12 10.5l-4.5 4v2h9v-2l-4.5-4z"/><line x1="12" y1="16.5" x2="12" y2="21"/>'),
  back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/>'),
  close: svg('<line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/>'),
  send: svg('<line x1="3.5" y1="12" x2="20.5" y2="12"/><polyline points="14.5 6 20.5 12 14.5 18"/>'),
  alert: svg('<path d="M12 4.5 21 19.5H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="16.8" r="0.4" fill="currentColor"/>'),
};

export function meetingIcon(name: keyof typeof MEETING_ICONS | string): string {
  return MEETING_ICONS[name] ?? '';
}
