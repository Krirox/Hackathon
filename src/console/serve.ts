import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { buildReport } from './report.ts';
import { renderHtml } from './render.ts';

/**
 * Console serve mode (TODO V2.1 approval surface, local edition): the
 * read-model report plus working Approve/Decline actions. Every action
 * runs through the coordinator's transitions — the same enforcement as
 * every other path, with the named human recorded. This is the Ledger
 * and approval surface; conversation still belongs to Buzz, so there is
 * no chat here, only state and decisions.
 */

export interface ConsoleServer {
  port: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, code: number, value: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

export function startConsoleServer(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  opts: { port?: number; tenant?: string; now?: () => string } = {},
): Promise<ConsoleServer> {
  const tenant = opts.tenant ?? 'acme';
  const now = opts.now ?? (() => new Date().toISOString());
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://console');
      if (req.method === 'GET' && url.pathname === '/') {
        const html = renderHtml(await buildReport(db, ledger, coord, comp, tenant, now()));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      // Approval-latency distribution (TODO 2.3): the curation-cost clock.
      if (req.method === 'GET' && url.pathname === '/api/approval-latency') {
        json(res, 200, await coord.approvalLatencyStats(tenant));
        return;
      }
      const act = url.pathname.match(/^\/api\/requests\/([^/]+)\/(approve|decline)$/);
      if (req.method === 'POST' && act) {
        let body: { by?: string; reason?: string };
        try {
          body = JSON.parse((await readBody(req)) || '{}') as { by?: string; reason?: string };
        } catch {
          json(res, 400, { ok: false, error: 'malformed JSON body' });
          return;
        }
        if (!body.by) {
          json(res, 400, { ok: false, error: 'approval without a named human is theater — pass { by }' });
          return;
        }
        const id = decodeURIComponent(act[1]!);
        const current = await coord.get(tenant, id);
        if (!current) {
          json(res, 404, { ok: false, error: `unknown request ${id}` });
          return;
        }
        const at = now();
        try {
          const action: 'approve' | 'decline' = act[2] === 'approve' ? 'approve' : 'decline';
          const next =
            action === 'approve'
              ? await coord.accept(tenant, id)
              : await coord.decline(tenant, id, body.reason ?? `declined by ${body.by}`);
          // Latency rides the same decision, but must never turn a landed
          // approval into an error response — degrade to null instead.
          let latencySeconds: number | null = null;
          try {
            latencySeconds = (await coord.recordApprovalLatency(tenant, id, action, body.by, at)).seconds;
          } catch {
            latencySeconds = null;
          }
          json(res, 200, { ok: action === 'approve', id, state: next.state, by: body.by, latencySeconds });
        } catch (e) {
          json(res, 409, { ok: false, error: (e as Error).message });
        }
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })();
  });
  return new Promise((resolve, reject) => {
    // Track sockets so close() never waits on keep-alive connections.
    const open = new Set<Socket>();
    server.on('connection', (sock) => {
      open.add(sock);
      sock.on('close', () => open.delete(sock));
    });
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('[console:UNBOUND] server did not bind'));
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r) => {
            for (const sock of open) sock.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}
