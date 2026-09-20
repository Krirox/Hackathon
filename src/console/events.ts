import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AsyncDb } from '../core/db.ts';

export interface LiveEvent {
  seq: number;
  action: string;
  target: string;
  detail: string;
  at: string;
  actor: string;
}

// Replay: bounded read of the audit_log event stream for mission replay / reconnect.
export async function readEvents(db: AsyncDb, tenant: string, since = 0, limit = 200): Promise<LiveEvent[]> {
  const rows = (await db
    .prepare(
      'SELECT seq, action, target, detail, at, actor FROM audit_log WHERE tenant = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    )
    .all(tenant, since, Math.min(Math.max(limit, 1), 1000))) as unknown as LiveEvent[];
  return rows;
}

// SSE handler: GET /api/events?since=<seq>. Polls audit_log (the existing outbox)
// every 2s — the poll doubles as the heartbeat, keeping proxies from idling the
// connection out. Caps at 5 min per connection; client reconnects with
// ?since=lastId. Same session gate as /api/metrics.
export function handleEventStream(req: IncomingMessage, res: ServerResponse, db: AsyncDb, tenant: string): void {
  const url = new URL(req.url ?? '/api/events', 'http://console');
  let since = Number(url.searchParams.get('since') ?? '0');
  if (!Number.isFinite(since) || since < 0) since = 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
  const send = (ev: LiveEvent): void => {
    res.write(
      `id: ${ev.seq}\nevent: ${ev.action}\ndata: ${JSON.stringify({ seq: ev.seq, action: ev.action, target: ev.target, detail: ev.detail ?? '', at: ev.at, actor: ev.actor })}\n\n`,
    );
  };
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const rows = await readEvents(db, tenant, since, 200);
      for (const r of rows) {
        send(r);
        since = r.seq;
      }
    } catch {
      /* next tick retries; stream stays open */
    }
  };
  const timer = setInterval(() => {
    if (closed) return;
    res.write(': heartbeat\n\n');
    void poll();
  }, 2_000);
  // Hard cap: 5 min per connection; client reconnects with ?since=lastId.
  setTimeout(
    () => {
      if (!closed) {
        closed = true;
        clearInterval(timer);
        res.end();
      }
    },
    5 * 60 * 1000,
  ).unref?.();
  res.write(': connected\n\n');
  void poll();
}
