// Agent Tasks — the "Ongoing Tasks" console for long-running Jcode executions.
//
// Three routes, one per surface the design spec (docs/agent-tasks-dashboard.md)
// names:
//   GET /console/agent-tasks          → the live task list (HTML) + `?format=json`
//   GET /console/agent-tasks/:id      → the single-task live view (HTML)
//   GET /console/agent-tasks/:id/feed → the poll payload for that view (JSON)
//
// Why a route table entry and not a serve.ts branch: capability is declared, so
// "does this need a session" is answerable by reading this file. The chrome is
// the server's `shellPage`; the drawing is `../agent-tasks.ts`. This module owns
// neither the tokens nor the layout — only the request handling.
//
// Every state here is a *read* of `coord.list` + `audit_log`. Nothing is written:
// a monitoring page that mutates the pipeline would be a bug, so the handlers
// only ever SELECT.

import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type Capability, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import type { Coordinator } from '../../coord/coordinator.ts';
import type { CoordinationRequest } from '../../core/types.ts';
import { renderListPage, esc } from '../render.ts';
import { clearFilterUrl, decodeListState } from '../report.ts';
import {
  buildTasks,
  renderAgentTaskDetail,
  renderAgentTaskList,
  snapshotTasks,
  taskFor,
  taskTotals,
  type AgentTask,
} from '../agent-tasks.ts';

export interface AgentTasksEnv {
  db: AsyncDb;
  tenant: string;
  home: string;
  coord: Coordinator;
  /** The shelled console page — supplied by the server so this owns no chrome. */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean; drawer?: boolean },
  ): Promise<string>;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE });
  res.end(JSON.stringify(body));
}

/** The return target a detail link carries, so its Back button keeps filters. */
function hereOf(ctx: { path: string; url: URL }): string {
  return ctx.path + (ctx.url.search || '');
}

/**
 * The poll fast-follow script. It re-fetches the JSON snapshot on an interval
 * that tightens while anything is running, nudges an immediate refresh off the
 * shared audit SSE stream, and keeps the KPI tiles + LIVE pill honest without a
 * full page reload. It degrades silently: with JS off the server-rendered page
 * is still a complete, correct snapshot.
 */
function listScript(): string {
  return `<script>(()=>{
  const root=document.querySelector('.v-task-list');if(!root)return;
  const live=document.getElementById('v-agent-live');
  const tiles={};document.querySelectorAll('[data-kpi]').forEach(el=>tiles[el.getAttribute('data-kpi')]=el);
  const refresh=async()=>{try{
    const r=await fetch(location.pathname+'?format=json',{headers:{accept:'application/json'}});if(!r.ok)return;
    const d=await r.json();const t=d.totals||{};
    if(tiles.running)tiles.running.textContent=String(t.running??0);
    if(tiles.waiting)tiles.waiting.textContent=String(t.waiting??0);
    if(tiles.attention)tiles.attention.textContent=String(t.needsAttention??0);
    if(tiles.tokens)tiles.tokens.textContent=(t.tokensToday??0).toLocaleString();
    if(live){live.setAttribute('data-state',t.anyLive?'live':'idle');}
    next=t.anyLive?3000:15000;
  }catch{/* keep polling; a transient error must not stop the loop */}};
  let next=5000;
  (function loop(){setTimeout(async()=>{await refresh();loop();},next);})();
  try{const es=new EventSource('/api/events');es.onmessage=()=>{refresh();};es.onerror=()=>{try{es.close();}catch{}};}catch{}
  refresh();
})();</script>`;
}

/** Feed snapshot + per-node state for one task; used by the detail poll. */
async function readFeed(db: AsyncDb, tenant: string, requestId: string, limit = 40) {
  const rows = (await db
    .prepare(
      'SELECT seq, action, actor, detail, at FROM audit_log WHERE tenant = ? AND target = ? ORDER BY seq DESC LIMIT ?',
    )
    .all(tenant, requestId, Math.min(Math.max(limit, 1), 200))) as unknown as {
    seq: number;
    action: string;
    actor: string;
    detail: string | null;
    at: string;
  }[];
  return rows;
}

function renderFeedItems(feed: { action: string; actor: string; detail: string | null; at: string }[]): {
  action: string;
  actor: string;
  detail: string;
  at: string;
}[] {
  return feed.map((e) => ({ action: e.action, actor: e.actor, detail: e.detail ?? '', at: e.at }));
}

export function agentTasksRoutes(): RouteDef<AgentTasksEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/agent-tasks',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Live monitor for in-flight Jcode agent executions and their sub-agent trees. Session-only: it names goals, scopes and spend.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { tenant } = ctx.env;
        const now = ctx.at;
        const state = decodeListState(ctx.url.search);
        const here = hereOf(ctx);
        try {
          const all = (await ctx.env.coord.list(tenant)) as CoordinationRequest[];
          let tasks = buildTasks(all, now);
          const q = (state.q ?? '').trim().toLowerCase();
          if (q) {
            tasks = tasks.filter((t) =>
              `${t.request.goal} ${t.request.id} ${t.request.originScope} ${t.request.targetScope}`
                .toLowerCase()
                .includes(q),
            );
          }
          // JSON snapshot for the poll fast-follow — same authority as the page.
          if (ctx.url.searchParams.get('format') === 'json') {
            sendJson(ctx.res, 200, snapshotTasks(tasks));
            return;
          }
          const total = tasks.length;
          const limit = state.limit && state.limit > 0 ? Math.min(state.limit, 100) : 25;
          const offset = state.offset && state.offset >= 0 ? state.offset : 0;
          const page = tasks.slice(offset, offset + limit);
          const totals = taskTotals(page.length ? page : tasks);
          let empty = '';
          if (!page.length && q) {
            empty = `<p class="v-meta">No matching tasks. <a href="${esc(clearFilterUrl('/console/agent-tasks'))}">Clear search</a></p>`;
          }
          const body = `${renderAgentTaskList(page, totals, now, here)}${empty}` + listScript();
          const prev = offset > 0 ? `/console/agent-tasks?offset=${Math.max(0, offset - limit)}${q ? `&q=${encodeURIComponent(state.q ?? '')}` : ''}` : null;
          const next = offset + page.length < total ? `/console/agent-tasks?offset=${offset + page.length}${q ? `&q=${encodeURIComponent(state.q ?? '')}` : ''}` : null;
          sendHtml(
            ctx.res,
            await ctx.env.shellPage(auth, {
              title: 'Agent Tasks',
              navKey: 'agentTasks',
              hideHeader: true,
              drawer: ctx.url.searchParams.get('drawer') === '1',
              body: renderListPage({
                title: 'Agent Tasks',
                heading: 'Ongoing Tasks',
                searchAction: '/console/agent-tasks',
                query: state.q ?? '',
                total,
                truncated: offset + page.length < total,
                shown: page.length,
                prevUrl: prev,
                nextUrl: next,
                clearUrl: clearFilterUrl('/console/agent-tasks'),
                body,
              }),
            }),
          );
        } catch (e) {
          sendJson(ctx.res, 400, { ok: false, error: (e as Error).message });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/console/agent-tasks/:id',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Single-task live view: guard strip, sub-agent tree, swarm chain and the audit feed. Session-only.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const { db, tenant } = ctx.env;
        const now = ctx.at;
        let requestId: string;
        try {
          requestId = decodeURIComponent(ctx.params.id ?? '');
        } catch {
          sendJson(ctx.res, 400, { ok: false, error: 'malformed request id' });
          return;
        }
        const all = (await ctx.env.coord.list(tenant)) as CoordinationRequest[];
        const task: AgentTask | null = taskFor(all, requestId, now);
        if (!task) {
          sendHtml(
            ctx.res,
            await ctx.env.shellPage(auth, {
              title: 'Agent Tasks',
              navKey: 'agentTasks',
              hideHeader: true,
              body: `<div class="v-empty"><h3>Task not found</h3><p>No request <span class="v-mono">${esc(requestId)}</span> exists for this workspace, or it has aged out.</p><p><a class="v-btn v-btn-secondary v-btn-sm" href="/console/agent-tasks">← All ongoing tasks</a></p></div>`,
            }),
          );
          return;
        }
        const feedRows = await readFeed(db, tenant, requestId);
        const here = hereOf(ctx);
        const startLive = task.status.runtime === 'processing';
        const body =
          renderAgentTaskDetail(task, renderFeedItems(feedRows), now, here) +
          `<script>(()=>{
  const feed=document.getElementById('v-agent-feed');if(!feed)return;
  const id=feed.getAttribute('data-request');const live=document.getElementById('v-agent-live');
  const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const draw=(rows)=>{feed.innerHTML=rows.length?rows.map(e=>'<div class="v-feed-item"><div class="v-feed-icon">'+esc((e.action||'')[0])+'</div><div class="v-feed-body"><div class="v-feed-title">'+esc(e.action)+'</div>'+(e.detail?'<div class="v-feed-meta">'+esc(e.detail)+'</div>':'')+'</div></div>').join(''):'<p class="v-meta">No activity recorded yet.</p>';};
  let timer;
  const pull=async()=>{try{
    const r=await fetch('/console/agent-tasks/'+encodeURIComponent(id)+'/feed',{headers:{accept:'application/json'}});if(!r.ok)return;
    const d=await r.json();draw(d.feed||[]);
    if(live)live.setAttribute('data-state',d.runtime==='processing'?'live':'idle');
    schedule(d.runtime==='processing');
  }catch{/* transient */}};
  const schedule=(running)=>{clearTimeout(timer);timer=setTimeout(pull,running?3000:8000);};
  schedule(${startLive ? 'true' : 'false'});
  try{const es=new EventSource('/api/events');es.onmessage=()=>pull();es.onerror=()=>{try{es.close();}catch{}};}catch{}
})();</script>`;
        sendHtml(
          ctx.res,
          await ctx.env.shellPage(auth, {
            title: 'Agent Task',
            navKey: 'agentTasks',
            hideHeader: true,
            body,
          }),
        );
      },
    },
    {
      method: 'GET',
      pattern: '/console/agent-tasks/:id/feed',
      capability: 'session',
      surface: 'api',
      // The feed carries the same goal/scope/spend detail as the page above it,
      // so it cannot be readable by an account that the page refuses.
      activation: 'required',
      note: 'Poll payload for the single-task view: current status + latest audit rows. Session-only JSON.',
      async handler(ctx) {
        let requestId: string;
        try {
          requestId = decodeURIComponent(ctx.params.id ?? '');
        } catch {
          sendJson(ctx.res, 400, { ok: false, error: 'malformed request id' });
          return;
        }
        const all = (await ctx.env.coord.list(ctx.env.tenant)) as CoordinationRequest[];
        const task = taskFor(all, requestId, ctx.at);
        if (!task) {
          sendJson(ctx.res, 404, { ok: false, error: 'not found' });
          return;
        }
        const feedRows = await readFeed(ctx.env.db, ctx.env.tenant, requestId);
        sendJson(ctx.res, 200, {
          ok: true,
          id: requestId,
          state: task.status.label,
          tone: task.status.tone,
          runtime: task.status.runtime,
          tokens: task.totalTokens,
          subAgents: task.subAgentCount,
          updatedAt: task.request.updatedAt,
          feed: renderFeedItems(feedRows),
        });
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const AGENT_TASKS_CAPABILITIES: Record<
  string,
  { capability: Capability; surface: 'api' | 'html' }
> = {
  'GET /console/agent-tasks': { capability: 'session', surface: 'html' },
  'GET /console/agent-tasks/:id': { capability: 'session', surface: 'html' },
  'GET /console/agent-tasks/:id/feed': { capability: 'session', surface: 'api' },
};
