import { connect as netConnect, type Socket } from 'node:net';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { resolveAndDecideEgress, type EgressPolicy } from './egress.ts';

/**
 * Egress forward proxy (TODO V2.1): the enforcement point for
 * `decideEgress`. Plain-HTTP requests are forwarded; HTTPS (and any raw
 * TCP) goes through CONNECT tunneling. Every decision — allow or deny —
 * hits the audit sink. The policy interprets; the proxy only enforces.
 *
 * Denials close before any upstream byte moves: a denied CONNECT never
 * dials, a denied GET never forwards. Metadata and link-local addresses
 * die here even if the policy forgot them, because `decideEgress` never
 * forgets them.
 */

export interface EgressAudit {
  at: string;
  host: string;
  port: number;
  method: string;
  verdict: 'allow' | 'deny';
  reason: string;
}

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
}

function hostPortFrom(authority: string, fallbackPort: number): { host: string; port: number } {
  const clean = authority.replace(/^\[/, '').replace(/\]$/, '');
  const last = clean.lastIndexOf(':');
  if (last > 0 && /^[0-9]+$/.test(clean.slice(last + 1))) {
    return { host: clean.slice(0, last), port: Number(clean.slice(last + 1)) };
  }
  return { host: clean, port: fallbackPort };
}

export function startEgressProxy(
  policy: EgressPolicy,
  opts: { port?: number; audit?: (a: EgressAudit) => void; now?: () => string } = {},
): Promise<EgressProxy> {
  const audit = opts.audit ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const judge = async (host: string, port: number, method: string): Promise<{ ok: boolean; dialHost: string }> => {
    const d = await resolveAndDecideEgress(host, policy);
    audit({ at: now(), host, port, method, verdict: d.verdict, reason: d.reason });
    if (d.verdict !== 'allow') return { ok: false, dialHost: host };
    // Dial the checked address, not the hostname: DNS cannot rebind the
    // connection between this decision and connect(). The Host header and
    // TLS SNI still carry the original name (see call sites).
    return { ok: true, dialHost: d.dialHost ?? host };
  };

  const server: Server = createServer();
  // Track sockets so close() never waits on keep-alive connections.
  const open = new Set<Socket>();
  server.on('connection', (sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
    // Proxy-form: GET http://host:port/path. Origin-form (GET /path) has
    // no authority and is refused — this proxy never guesses destinations.
    const raw = req.url ?? '';
    let target: URL | null;
    try {
      target = new URL(raw);
    } catch {
      target = null;
    }
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      audit({
        at: now(),
        host: raw || '(none)',
        port: 0,
        method: req.method ?? '?',
        verdict: 'deny',
        reason: 'origin-form request has no proxy authority — refused',
      });
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('proxy requires absolute-URI requests');
      return;
    }
    const { host, port } = hostPortFrom(target.host, target.protocol === 'http:' ? 80 : 443);
    const judgement = await judge(host, port, req.method ?? 'GET');
    if (!judgement.ok) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('egress denied by policy');
      return;
    }
    const upstream = httpRequest(
      {
        host: judgement.dialHost,
        port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream unreachable');
    });
    req.pipe(upstream);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream unreachable');
      }
    });
  });

  server.on('connect', (req: IncomingMessage, sock: Socket) => {
    const { host, port } = hostPortFrom(req.url ?? '', 443);
    void judge(host, port, 'CONNECT').then((judgement) => {
      if (!judgement.ok) {
        sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        sock.destroy();
        return;
      }
      const tunnel = netConnect(port, judgement.dialHost, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        sock.pipe(tunnel);
        tunnel.pipe(sock);
      });
      const die = (): void => {
        sock.destroy();
        tunnel.destroy();
      };
      sock.on('error', die);
      tunnel.on('error', die);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('[egress:UNBOUND] proxy did not bind'));
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            for (const sock of open) sock.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
