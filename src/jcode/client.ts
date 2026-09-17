import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  API_VERSION_MAJOR,
  socketPathFrom,
  type ClientFrame,
  type PermissionDecision,
  type ServerFrame,
} from './protocol.ts';

/**
 * Minimal NDJSON client for the jcode harness API.
 *
 * Deliberately NOT the published @1jehuang/jcode-sdk: we speak the wire
 * directly so Vital has no npm dependency on a runtime that also ships
 * platform binaries, and so the permission round-trip is ours to govern.
 *
 * Transport note: on macOS/Linux this is a Unix socket; Windows uses a named
 * pipe. node:net handles both when given the right path string, but Windows
 * has no live upstream e2e coverage, so we treat it as untested (README says
 * the same) and keep the transport injectable for that reason.
 */
export interface JcodeClientOptions {
  socketPath?: string;
  clientLabel?: string;
  connectFn?: (path: string) => Socket;
  /**
   * Bound on each handshake leg (transport connect, then hello). A live
   * sibling that accepts and never answers (e.g. the bridge waiting on an
   * absent daemon) must surface as a rejection, never a hang — found live
   * 2026-09-09.
   */
  helloTimeoutMs?: number;
  /**
   * Bound on request() legs that expect a correlated reply (hello, create,
   * attach, cancel, permission_response). Defaults to 15_000ms so an unresponsive
   * daemon/bridge fails cleanly instead of hanging forever. Set to 0 for unbounded.
   * send() never waits for a reply (see below), so it is unaffected by this setting.
   */
  requestTimeoutMs?: number;
}

export class JcodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[jcode:${code}] ${message}`);
  }
}

/** Cap on the NDJSON reassembly buffer: garbage without newlines dies here. */
const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

export class JcodeClient extends EventEmitter {
  private sock: Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (f: ServerFrame) => void; reject: (e: Error) => void }>();
  private helloOk: ServerFrame | null = null;

  constructor(private readonly opts: JcodeClientOptions = {}) {
    super();
  }

  get isOpen(): boolean {
    return this.sock !== null;
  }

  get socketPath(): string {
    return this.opts.socketPath ?? socketPathFrom();
  }

  get requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs !== undefined ? this.opts.requestTimeoutMs : 15_000;
  }

  async connect(): Promise<void> {
    if (this.sock) throw new JcodeError('ALREADY_OPEN', 'call close() first');
    const path = this.opts.socketPath ?? socketPathFrom();
    const opener = this.opts.connectFn ?? ((p: string) => connect({ path: p }));
    const budget = this.opts.helloTimeoutMs ?? 15_000;
    const timeout = (ms: number, what: string): Promise<never> =>
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new JcodeError('HELLO_TIMEOUT', `${what} exceeded ${ms}ms`)), ms);
        t.unref?.();
      });
    this.sock = opener(path);
    await Promise.race([
      new Promise<void>((res, rej) => {
        this.sock!.once('connect', res);
        this.sock!.once('error', (e) => rej(new JcodeError('CONNECT', `${path}: ${e.message}`)));
      }),
      timeout(budget, `connect ${path}`),
    ]).catch((e) => {
      this.close();
      throw e;
    });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.onData(chunk));
    this.sock.on('close', () => {
      this.sock = null;
      // Remote disconnect settles inflight legs the same as close(): a dead
      // sibling must surface as rejections, never silent hangs. (Explicit
      // close() shares this path via settleClosed below.)
      this.settleClosed();
      this.emit('close');
    });

    // hello must be first
    const f = await Promise.race([
      this.request('hello', {
        min_version: API_VERSION_MAJOR,
        max_version: API_VERSION_MAJOR,
        client: this.opts.clientLabel ?? 'vital/0.0.1',
      }),
      timeout(budget, `hello ${path}`),
    ]).catch((e) => {
      this.close();
      throw e;
    });
    if (f.ev !== 'hello_ok') {
      throw new JcodeError('HANDSHAKE', `expected hello_ok, got "${f.ev}"`);
    }
    if (typeof f.v === 'number' && f.v !== API_VERSION_MAJOR) {
      throw new JcodeError('VERSION', `server speaks v${f.v}, Vital speaks v${API_VERSION_MAJOR}`);
    }
    this.helloOk = f;
  }

  get serverInfo(): ServerFrame | null {
    return this.helloOk;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    // A peer streaming garbage without newlines would grow the buffer
    // without bound (the bridge itself closes on oversized frames). Cap it:
    // fail the connection loudly rather than exhausting task memory.
    if (this.buf.length > MAX_FRAME_BUFFER) {
      this.buf = '';
      this.settleClosed(new JcodeError('FRAME_OVERFLOW', `frame buffer exceeded ${MAX_FRAME_BUFFER} bytes`));
      this.sock?.destroy();
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(line) as ServerFrame;
      } catch {
        continue;
      } // unknown/garbage frame: skip, never crash the loop
      if (typeof frame.reply_to === 'number') {
        const w = this.pending.get(frame.reply_to);
        if (w) {
          this.pending.delete(frame.reply_to);
          // An `error` reply is a rejection, never a resolution. Resolving it
          // would let callers treat a denial as success; and emitting it as a
          // bare 'error' event would kill the process (ERR_UNHANDLED_ERROR).
          if (frame.ev === 'error') {
            w.reject(new JcodeError(String(frame.code ?? 'API'), String(frame.message ?? 'rejected')));
          } else {
            w.resolve(frame);
          }
        }
      }
      this.emit('event', frame);
      // Namespaced so Node never sees a bare 'error' event name. Listeners
      // subscribe to `frame:<ev>` (e.g. `frame:turn_done`).
      if (frame.ev) this.emit(`frame:${frame.ev}`, frame);
    }
  }

  request(req: string, fields: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<ServerFrame> {
    if (!this.sock) return Promise.reject(new JcodeError('NOT_CONNECTED', 'connect() first'));
    const id = this.nextId++;
    const frame: ClientFrame = { v: API_VERSION_MAJOR, id, req, ...fields };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void): void => {
        if (timer) clearTimeout(timer);
        fn();
      };
      this.pending.set(id, {
        resolve: (f) => settle(() => resolve(f)),
        reject: (e) => settle(() => reject(e)),
      });
      const budget = opts.timeoutMs ?? (this.opts.requestTimeoutMs !== undefined ? this.opts.requestTimeoutMs : 15_000);
      if (budget > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new JcodeError('REQUEST_TIMEOUT', `${req} got no reply within ${budget}ms`));
          }
        }, budget);
        timer.unref?.();
      }
      this.sock!.write(JSON.stringify(frame) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          settle(() => reject(new JcodeError('WRITE', err.message)));
        }
      });
    });
  }

  /** Throws on an `error` event so callers cannot silently ignore a failure. */
  async requestOk(req: string, fields?: Record<string, unknown>): Promise<ServerFrame> {
    const f = await this.request(req, fields);
    if (f.ev === 'error') throw new JcodeError(String(f.code ?? 'API'), String(f.message ?? 'rejected'));
    return f;
  }

  /** Reply to create_session / attach_session is `attached { session }`. */
  private sessionIdFrom(f: ServerFrame, what: string): string {
    if (f.ev !== 'attached') {
      throw new JcodeError('UNEXPECTED_REPLY', `${what} replied "${f.ev}", expected "attached"`);
    }
    const s = (f.session ?? {}) as { session_id?: string };
    if (!s.session_id) throw new JcodeError('NO_SESSION', `${what} returned no session_id`);
    return String(s.session_id);
  }

  async createSession(workingDir?: string): Promise<string> {
    const f = await this.requestOk('create_session', workingDir ? { working_dir: workingDir } : {});
    return this.sessionIdFrom(f, 'create_session');
  }

  async attach(sessionId: string): Promise<void> {
    const f = await this.requestOk('attach_session', { session_id: sessionId });
    if (f.ev !== 'attached' && f.ev !== 'ok') {
      throw new JcodeError('UNEXPECTED_REPLY', `attach_session replied "${f.ev}"`);
    }
  }

  /**
   * Fire-and-forget send. The bridge answers send_message with NO correlated
   * reply — the daemon ack arrives as a bare MessageAccepted event and done
   * as TurnDone — so awaiting reply_to here hangs forever against the real
   * bridge (FakeHarness's correlated message_accepted masked this). This
   * resolves once the frame is flushed to the socket; turn progress and
   * failures surface as session-filtered events (turn_done, bare error),
   * which is the runner's job to observe. Per-call errors cannot be
   * reported here by construction.
   */
  async send(sessionId: string, content: string, opts: { noReply?: boolean } = {}): Promise<void> {
    if (!this.sock) throw new JcodeError('NOT_CONNECTED', 'connect() first');
    const id = this.nextId++;
    const frame: ClientFrame = {
      v: API_VERSION_MAJOR,
      id,
      req: 'send_message',
      session_id: sessionId,
      content,
      images: [],
      no_reply: opts.noReply ?? false,
    };
    await new Promise<void>((resolve, reject) => {
      this.sock!.write(JSON.stringify(frame) + '\n', (err) => {
        if (err) reject(new JcodeError('WRITE', err.message));
        else resolve();
      });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request('cancel', { session_id: sessionId });
  }

  async softInterrupt(sessionId: string, content: string, urgent = false): Promise<void> {
    await this.request('soft_interrupt', { session_id: sessionId, content, images: [], urgent });
  }

  /** The governance round-trip: answer a PermissionRequest. */
  async respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request('permission_response', {
      session_id: sessionId,
      request_id: requestId,
      decision,
    });
  }

  close(): void {
    // A destroyed socket never answers: settle every inflight request so a
    // harness disconnect surfaces as a rejection, never a silent hang.
    // (runner.ts relies on this — waitForTurn must see disconnects.)
    this.settleClosed();
    this.sock?.destroy();
    this.sock = null;
  }

  /** Reject every inflight leg: connection gone, locally or remotely. */
  private settleClosed(err?: JcodeError): void {
    if (this.pending.size > 0) {
      const pendings = [...this.pending.values()];
      this.pending.clear();
      const e = err ?? new JcodeError('CLOSED', 'connection closed with request inflight');
      for (const w of pendings) w.reject(e);
    }
  }
}
