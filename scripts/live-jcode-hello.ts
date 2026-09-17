import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, createServer, type Socket, type Server } from 'node:net';
import { JcodeClient, JcodeError } from '../src/jcode/client.ts';
import { API_VERSION_MAJOR } from '../src/jcode/protocol.ts';

/**
 * Live-sibling probe (§0.6 gate, partial): spawn the REAL
 * `jcode-harness-api-bridge` binary (built from the pinned upstream SHA —
 * see docs/upstream.md) on an isolated socket pair and run OUR client
 * against it over the real transport.
 *
 * What this proves: the wire contract holds against the actual sibling
 * (framing, hello handshake, version check, error replies), not just the
 * scripted FakeHarness. What it does NOT prove: session/turn work with a
 * real model behind the daemon (needs a provider key — TODO V2.1).
 *
 * The bridge dials the legacy daemon socket BEFORE sending hello_ok
 * (harness-api-server lib.rs: "Do not claim a usable connection before the
 * native daemon is reachable" — proven live 2026-09-17: hello with no
 * daemon is dropped with os error 232). So the probe stands a minimal
 * scripted daemon on the legacy socket — enough to accept the dial and
 * answer the first `state` frame — and hello_ok then comes from the real
 * bridge. The daemon here is OUR scripted stub, not jcode's daemon.
 *
 * Run:  tsx scripts/live-jcode-hello.ts
 * Env:  JCODE_BRIDGE_BIN (default: .upstream/jcode-1jehuang/target/debug/...)
 *       JCODE_API_SOCKET (default: a temp path under the OS temp dir)
 *
 * Exit 0: hello_ok from the live bridge + create_session fails CLEANLY
 * (rejection, no crash) once the stub daemon stops answering. Any crash or
 * hang exits nonzero.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Mirror of jcode-transport path_to_pipe_name (Windows). */
function pipeNameFor(sockPath: string): string {
  const base = sockPath.split(/[/\\]/).pop() ?? 'jcode';
  const stem =
    (base.split('.').slice(0, -1).join('.') || 'jcode')
      .split('')
      .filter((ch) => /[A-Za-z0-9_-]/.test(ch))
      .slice(0, 32)
      .join('') || 'jcode';
  const normalized = sockPath.replace(/\\/g, '/').toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\${stem}-${hash}`;
}

function pipeExists(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ path: pipe });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

const bridgeBin = process.env.JCODE_BRIDGE_BIN ?? '.upstream/jcode-1jehuang/target/debug/jcode-harness-api-bridge.exe';
const apiSock = process.env.JCODE_API_SOCKET ?? `${process.env.TEMP ?? '/tmp'}/vital-live-jcode-api.sock`;
const legacySock = `${process.env.TEMP ?? '/tmp'}/vital-live-jcode-legacy.sock`;
const pipe = process.platform === 'win32' ? pipeNameFor(apiSock) : apiSock;
const legacyPipe = process.platform === 'win32' ? pipeNameFor(legacySock) : legacySock;

let bridge: ChildProcess | null = null;
let legacyServer: Server | null = null;
const fail = (msg: string): never => {
  console.error(`LIVE-JCODE FAIL: ${msg}`);
  try {
    bridge?.kill();
  } catch {
    /* already gone */
  }
  try {
    legacyServer?.close();
  } catch {
    /* already gone */
  }
  process.exit(1);
};

console.log(`bridge : ${bridgeBin}`);
console.log(`socket : ${apiSock}`);
console.log(`pipe   : ${pipe}`);
// .upstream/ is gitignored, so a fresh clone has no bridge binary — fail
// loud with the rebuild path instead of a spawn-ENOENT crash or a 15 s
// hang waiting on a pipe that will never appear.
if (!existsSync(bridgeBin)) {
  console.error(
    `LIVE-JCODE FAIL: bridge binary not found at ${bridgeBin} — clone the pinned jcode (` +
      `docs/upstream.md) to .upstream/jcode-1jehuang and build the harness-api bridge first, ` +
      `or set JCODE_BRIDGE_BIN to a built binary.`,
  );
  process.exit(1);
}
// The bridge dials the legacy daemon socket before hello_ok, so a scripted
// stub daemon must be listening first. It answers only the first `state`
// frame (the attach handshake) with a stable fake session; anything else is
// ignored — this stub exists so the bridge's hello gate opens, nothing more.
legacyServer = createServer((sock: Socket) => {
  console.log('[stub-daemon] bridge dialed the legacy socket');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: { type?: string; id?: number } | null = null;
      try {
        req = JSON.parse(line) as { type?: string; id?: number };
      } catch {
        continue;
      }
      if (req?.type === 'state' && typeof req.id === 'number') {
        sock.write(JSON.stringify({ type: 'state', id: req.id, session_id: 'stub-session-1', status: 'idle' }) + '\n');
        console.log('[stub-daemon] answered state frame');
      }
    }
  });
  sock.on('error', (e) => console.error(`[stub-daemon] connection error: ${e.message}`));
});
legacyServer.on('error', (e) => fail(`stub daemon could not listen on ${legacyPipe}: ${e.message}`));
await new Promise<void>((res) => legacyServer!.listen(legacyPipe, res));
console.log(`stub daemon listening on ${legacyPipe}`);

bridge = spawn(bridgeBin, [apiSock, legacySock], { stdio: ['ignore', 'pipe', 'pipe'] });
bridge.stdout?.on('data', (d: Buffer) => process.stdout.write(`[bridge] ${d}`));
bridge.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge:err] ${d}`));
bridge.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`[bridge] exited ${code}`);
});

// Wait for the named pipe to appear (bounded — a hang here is a failure).
let up = false;
for (let i = 0; i < 150; i++) {
  if (await pipeExists(pipe)) {
    up = true;
    break;
  }
  await sleep(100);
}
if (!up) fail(`bridge never published ${pipe}`);

const client = new JcodeClient({ socketPath: pipe, clientLabel: 'vital-live-probe/0.0.1' });
try {
  await client.connect();
} catch (e) {
  fail(`hello against live bridge failed: ${(e as Error).message}`);
}
const info = client.serverInfo;
console.log(`hello_ok from live bridge: ${JSON.stringify(info)}`);
if (typeof info?.v === 'number' && info.v !== API_VERSION_MAJOR) {
  fail(`bridge speaks v${info.v}, Vital speaks v${API_VERSION_MAJOR}`);
}

// Boundary probe: the stub daemon answers only the attach handshake, and we
// now close it — session work must then fail. The question is HOW: a
// rejection is a governed boundary; a crash or hang is a bug in us or them.
legacyServer.close(() => console.log('[stub-daemon] closed — the daemon boundary is now real'));
await sleep(200);
try {
  const sid = await client.createSession({ timeoutMs: 5_000 });
  fail(`UNEXPECTED: live bridge created session ${sid} with no daemon behind it`);
} catch (e) {
  console.log(`create_session without daemon fails cleanly: ${(e as Error).message}`);
}

client.close();
await sleep(200);
bridge.kill();
legacyServer.close();
console.log('LIVE-JCODE OK: hello_ok from the real sibling; daemon boundary fails clean, no crash');
