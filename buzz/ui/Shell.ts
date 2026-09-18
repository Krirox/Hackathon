// Workspace Shell — chat-centric chrome for every console page
// Left: Rooms sidebar (12 rooms + quick links). Right: page content.
// Keeps <nav aria-label="Console"> for tests, adds sidebar for chat feel.

import { CANONICAL_ROOMS } from "../../src/talk/rooms.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ShellRooms {
  scope: string;
  roomName: string;
  badge: string;
  pending: number;
}

export function renderWorkspaceShell(opts: {
  rooms: ShellRooms[];
  activeScope?: string | null;
  home: string;
  consoleNav: string; // already rendered <nav aria-label="Console">…</nav>
  accountCluster: string;
  innerHtml: string;
}): string {
  const { rooms, activeScope, home, consoleNav, accountCluster, innerHtml } = opts;
  const order = new Map(CANONICAL_ROOMS.map((d, i) => [d.scope, i]));
  const sorted = [...rooms].sort((a, b) => (order.get(a.scope) ?? 99) - (order.get(b.scope) ?? 99));
  const sidebarRooms = sorted
    .map((r) => {
      const active = r.scope === activeScope ? "background:#0F5C57;color:#fff;" : "";
      const pending = r.pending > 0 ? `<span style="background:${r.scope === activeScope ? "#fff" : "#FEF3C7"};color:${r.scope === activeScope ? "#0F5C57" : "#92400E"};font-size:10px;padding:1px 6px;border-radius:10px;margin-left:auto;">${r.pending}</span>` : "";
      return `<a href="${esc(home)}console/buzz/${esc(r.scope)}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;text-decoration:none;font-size:13px;${active || "color:#0A0F14;"}">${esc(r.badge)} #${esc(r.roomName)} ${pending}</a>`;
    })
    .join("\n");
  return `<div style="display:grid;grid-template-columns:250px 1fr;gap:0;min-height:100vh;background:#FAFAF8;">
  <aside style="background:#F4F7F5;border-right:1px solid #E5E7EB;padding:14px 10px;position:sticky;top:0;align-self:start;min-height:100vh;">
    <div style="font-weight:700;font-size:13px;padding:6px 8px;">Workspace</div>
    <div style="font-size:11px;color:#6B7280;padding:0 8px 10px;">12 rooms · chat-first</div>
    <nav aria-label="Rooms" style="display:grid;gap:2px;">${sidebarRooms}</nav>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #E5E7EB;">
      <div style="font-size:11px;letter-spacing:0.06em;color:#6B7280;padding:0 8px 6px;">NAVIGATE</div>
      ${consoleNav}
    </div>
    <div style="margin-top:12px;">${accountCluster}</div>
  </aside>
  <main id="main" style="padding:18px 20px;max-width:1100px;min-width:0;">${innerHtml}</main>
</div>`;
}
