import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { API_VERSION_MAJOR, type ClientFrame } from '../src/jcode/protocol.ts';

/**
 * A scripted jcode harness over a real Unix-domain socket, so the NDJSON
 * framing, the hello-first rule, the reply_to correlation and the permission
 * round-trip are all exercised for real. Nothing here knows about Vital; it
 * only speaks the protocol, which is the point.
 */
export class FakeHarness {
  private server: Server;
  private frames: ClientFrame[] = [];
  private sockets = new Set<Socket>();
  readonly path: string;
  /** Tool the harness will ask permission for. */
  permissionTool = 'write_file';
  /** Emit a token_usage event above the caller's ceiling. */
  overspendTokens = 0;
  /** Emit no turn_done, to exercise the timeout path. */
  hang = false;

  constructor(label = 'fake') {
    // Node supports Unix sockets on Windows only as named pipes; a filesystem
    // path yields EACCES. This is the exact gap behind jcode's own "Windows has
    // no live end-to-end coverage" caveat.
    const name = `vital-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    this.path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    this.server = createServer((sock) => this.onConn(sock));
  }

  get received(): ClientFrame[] {
    return this.frames;
  }
  requestsOf(req: string): ClientFrame[] {
    return this.frames.filter((f) => f.req === req);
  }

  private onConn(sock: Socket): void {
    this.sockets.add(sock);
    let buf = '';
    // send() owns the version field, so callers pass bare event objects.
    const send = (ev: Record<string, unknown>) => {
      if (!sock.destroyed) sock.write(JSON.stringify({ v: API_VERSION_MAJOR, ...ev }) + '\n');
    };
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let f: ClientFrame;
        try {
          f = JSON.parse(line) as ClientFrame;
        } catch {
          continue;
        }
        this.frames.push(f);
        this.reply(f, send);
      }
    });
    sock.on('error', () => {
      /* client aborted */
    });
    sock.on('close', () => this.sockets.delete(sock));
  }

  private reply(f: ClientFrame, send: (ev: Record<string, unknown>) => void): void {
    const base = { reply_to: f.id };
    const sid = 'sess_1';
    switch (f.req) {
      case 'hello':
        send({
          ...base,
          ev: 'hello_ok',
          version: API_VERSION_MAJOR,
          server: 'jcode/0.84.0-fake',
          capabilities: ['permissions'],
        });
        break;
      case 'create_session':
        send({
          ...base,
          ev: 'attached',
          session: { session_id: sid, status: 'active', working_dir: f.working_dir ?? null },
        });
        break;
      case 'list_sessions':
        send({ ...base, ev: 'sessions', sessions: [{ session_id: sid, status: 'active' }] });
        break;
      case 'attach_session':
        send({ ...base, ev: 'ok' });
        break;
      case 'send_message':
        send({ ...base, ev: 'message_accepted', session_id: sid });
        setTimeout(() => {
          send({ ev: 'text_delta', session_id: sid, text: 'Examining the repo. ' });
          send({ ev: 'tool_start', session_id: sid, call_id: 'c1', name: 'read_file' });
          send({ ev: 'tool_done', session_id: sid, call_id: 'c1', name: 'read_file', output: 'ok', error: null });
          // the permission round-trip we actually care about
          send({
            ev: 'permission_request',
            session_id: sid,
            request_id: 'perm_1',
            tool_name: this.permissionTool,
            description: 'write src/index.ts',
          });
          send({ ev: 'tool_start', session_id: sid, call_id: 'c2', name: this.permissionTool });
          send({
            ev: 'tool_done',
            session_id: sid,
            call_id: 'c2',
            name: this.permissionTool,
            output: 'done',
            error: null,
          });
          if (this.overspendTokens)
            send({ ev: 'token_usage', session_id: sid, input: this.overspendTokens, output: 0 });
          else send({ ev: 'token_usage', session_id: sid, input: 1200, output: 300 });
          send({ ev: 'text_delta', session_id: sid, text: 'Done: patch applied.' });
          if (!this.hang) send({ ev: 'turn_done', session_id: sid });
        }, 10);
        break;
      case 'permission_response':
        send({ ...base, ev: 'ok' });
        break;
      case 'cancel':
        send({ ...base, ev: 'ok' });
        break;
      default:
        send({ ...base, ev: 'error', code: 'unknown_request', message: f.req });
    }
  }

  async listen(): Promise<void> {
    // Named pipes have no filesystem entry to unlink.
    if (process.platform !== 'win32' && existsSync(this.path)) unlinkSync(this.path);
    await new Promise<void>((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.path, () => {
        this.server.removeListener('error', rej);
        res();
      });
    });
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.server.close(() => res()));
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.path);
      } catch {
        /* already gone */
      }
    }
  }
}
