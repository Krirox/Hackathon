import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { OrganizationalCompiler } from '../compiler/compiler.ts';
import { buildReport } from './report.ts';
import { renderHtml } from './render.ts';
import { proposeEvalFromCorrection } from '../evals/runner.ts';

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

/** Cap on JSON bodies: the approve/decline/correct payloads are tens of
 *  bytes — anything near a megabyte is a body bomb, not an approval. */
const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let capped = false;
    req.on('data', (c: Buffer) => {
      if (capped) return; // draining after the cap tripped: discard, don't keep
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Reject once, then resume-discard the rest: destroying the socket
        // here poisons the client's keep-alive pool (every later request on
        // the pooled connection dies with socket hang up). Memory — the
        // actual threat — is protected because chunks are discarded, not kept.
        capped = true;
        reject(new Error('[console:BODY_TOO_LARGE] body exceeds 1MB cap'));
        req.resume();
        return;
      }
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

/** Oversized bodies are 413, malformed JSON is 400 — never conflated. */
const bodyError = (res: ServerResponse, e: unknown): void => {
  if ((e as Error).message.includes('BODY_TOO_LARGE')) {
    json(res, 413, { ok: false, error: 'body exceeds 1MB cap' });
    return;
  }
  json(res, 400, { ok: false, error: 'malformed JSON body' });
};

export function startConsoleServer(
  db: AsyncDb,
  ledger: Ledger,
  coord: Coordinator,
  comp: OrganizationalCompiler,
  opts: { port?: number; host?: string; tenant?: string; now?: () => string } = {},
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
        } catch (e) {
          bodyError(res, e);
          return;
        }
        if (!body.by) {
          json(res, 400, { ok: false, error: 'approval without a named human is theater — pass { by }' });
          return;
        }
        let id: string;
        try {
          // decodeURIComponent throws URIError on malformed % sequences —
          // outside a try this escapes the async handler and kills the
          // process (unauthenticated single-request DoS, notable because
          // the ALB exposes this port publicly).
          id = decodeURIComponent(act[1]!);
        } catch {
          json(res, 400, { ok: false, error: 'malformed request id' });
          return;
        }
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
      // Override capture (TODO 2.3): a human edits a claim → correctClaim
      // supersedes the old row and audits the diff; then the eval spine
      // converts the audit row into a regression case, so every override
      // teaches the machine exactly what it got wrong.
      const fix = url.pathname.match(/^\/api\/claims\/([^/]+)\/correct$/);
      if (req.method === 'POST' && fix) {
        let body: { by?: string; statement?: string };
        try {
          body = JSON.parse((await readBody(req)) || '{}') as { by?: string; statement?: string };
        } catch (e) {
          bodyError(res, e);
          return;
        }
        if (!body.by || !body.statement) {
          json(res, 400, {
            ok: false,
            error: 'a correction needs a named human and the corrected statement — pass { by, statement }',
          });
          return;
        }
        let id: string;
        try {
          id = decodeURIComponent(fix[1]!);
        } catch {
          json(res, 400, { ok: false, error: 'malformed claim id' });
          return;
        }
        try {
          const old = await ledger.get(tenant, id);
          if (!old) {
            json(res, 404, { ok: false, error: `unknown claim ${id}` });
            return;
          }
          const neu = await ledger.correctClaim(tenant, id, body.statement, body.by, now());
          // Feed the eval spine. The CLAIM_CORRECTED audit row (target
          // `oldId->newId`) is the spine's intake; a spine failure must not
          // un-correct the claim, so this degrades to evalCaseId: null.
          let evalCaseId: string | null = null;
          try {
            const seqRow = (await db
              .prepare(
                "SELECT seq FROM audit_log WHERE tenant = ? AND action = 'CLAIM_CORRECTED' AND target = ? ORDER BY seq DESC LIMIT 1",
              )
              .get(tenant, `${old.id}->${neu.id}`)) as { seq: number } | undefined;
            if (seqRow) {
              const kase = await proposeEvalFromCorrection(
                db,
                (cid) =>
                  ledger.get(tenant, cid).then((c) => (c ? { subject: c.subject, statement: c.statement } : null)),
                tenant,
                Number(seqRow.seq),
                'overrides',
              );
              evalCaseId = kase.id;
            }
          } catch {
            evalCaseId = null;
          }
          json(res, 200, {
            ok: true,
            supersedes: old.id,
            supersededBy: neu.id,
            diff: { before: old.statement, after: neu.statement },
            evalCaseId,
          });
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
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
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
