/**
 * Live-sibling probe (§0.6 gate): spawn the REAL jcode daemon AND the REAL
 * jcode-harness-api-bridge (both built from the pinned upstream SHA — see
 * docs/upstream.md), fully isolated (JCODE_HOME/JCODE_RUNTIME_DIR, telemetry/
 * update/memory/swarm off), then run OUR client against the real chain:
 *
 *   JcodeClient -> bridge (api socket) -> daemon (legacy socket)
 *
 * Phases:
 *   1. hello_ok from the real bridge; version negotiation against v1.
 *   2. create_session returns a REAL session id minted by the real daemon
 *      (the stub probe could never prove this — it faked the `state` reply).
 *   3. Disconnect assertion: kill the daemon (OUR child, unambiguous), then
 *      assert the client's socket closes (frame:close) and an inflight leg
 *      rejects with [jcode:CLOSED] — a dead sibling surfaces as a rejection,
 *      never a hang. Requests after disconnect fail NOT_CONNECTED.
 *
 * The daemon is started with --provider ollama --model llama3.2 (requires no
 * credentials); session creation is daemon-side bookkeeping and makes no
 * network call, so no Ollama server is needed for this probe to pass.
 *
 * Run:  npm run verify:jcode-live
 * Env:  JCODE_BIN        (default .upstream/jcode-1jehuang/target/debug/jcode(.exe))
 *       JCODE_BRIDGE_BIN (default .upstream/jcode-1jehuang/target/debug/jcode-harness-api-bridge(.exe))
 *       JCODE_ISOLATION_ROOT (default a fresh OS temp dir per run)
 *
 * Exit 0 only if every phase above holds. Any crash or hang exits nonzero.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JcodeClient } from '../src/jcode/client.ts';
import { API_VERSION_MAJOR } from '../src/jcode/protocol.ts';

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

const repoRoot = process.cwd();
const exe = process.platform === 'win32' ? '.exe' : '';
const jcodeBin = process.env.JCODE_BIN ?? join(repoRoot, `.upstream/jcode-1jehuang/target/debug/jcode${exe}`);
const bridgeBin =
  process.env.JCODE_BRIDGE_BIN ??
  join(repoRoot, `.upstream/jcode-1jehuang/target/debug/jcode-harness-api-bridge${exe}`);
// Per-run isolation root: fresh JCODE_HOME/JCODE_RUNTIME_DIR per run, no
// contact with any real ~/.jcode profile, no cross-run socket reuse.
const isoRoot = process.env.JCODE_ISOLATION_ROOT ?? mkdtempSync(join(tmpdir(), 'vital-jcode-live-'));
const home = join(isoRoot, 'home');
const runDir = join(isoRoot, 'run');
const apiSock = join(runDir, 'vital-api.sock');
const legacySock = join(runDir, 'jcode.sock');
const pipe = process.platform === 'win32' ? pipeNameFor(apiSock) : apiSock;

let daemon: ChildProcess | null = null;
let bridge: ChildProcess | null = null;
const fail = (msg: string): never => {
  console.error(`LIVE-JCODE FAIL: ${msg}`);
  for (const p of [daemon, bridge]) {
    try {
      p?.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    if (!process.env.JCODE_ISOLATION_ROOT) rmSync(isoRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.exit(1);
};

console.log(`jcode  : ${jcodeBin}`);
console.log(`bridge : ${bridgeBin}`);
console.log(`iso    : ${isoRoot}`);
console.log(`pipe   : ${pipe}`);
// .upstream/ is gitignored, so a fresh clone has neither binary — fail loud
// with the rebuild path instead of a spawn-ENOENT crash or a 15 s hang.
for (const [name, bin] of [
  ['daemon', jcodeBin],
  ['bridge', bridgeBin],
] as const) {
  if (!existsSync(bin)) {
    console.error(
      `LIVE-JCODE FAIL: ${name} binary not found at ${bin} — clone the pinned jcode ` +
        `(docs/upstream.md) to .upstream/jcode-1jehuang and build both binaries, ` +
        `or set JCODE_BIN / JCODE_BRIDGE_BIN.`,
    );
    process.exit(1);
  }
}

const isolationEnv: NodeJS.ProcessEnv = {
  JCODE_HOME: home,
  JCODE_RUNTIME_DIR: runDir,
  JCODE_NO_TELEMETRY: '1',
  JCODE_CHECK_UPDATES: '0',
  JCODE_NO_MENUBAR: '1',
  JCODE_MEMORY_ENABLED: '0',
  JCODE_SWARM_ENABLED: '0',
  JCODE_AMBIENT_ENABLED: '0',
  JCODE_GATEWAY_ENABLED: '0',
  JCODE_DISABLE_POWER_INHIBIT: '1',
  JCODE_OPENROUTER_MODEL_CATALOG: '0',
};

// Phase 1: the real daemon. --provider ollama requires no credentials and
// create_session is daemon-side bookkeeping (no model call), so the chain
// below exercises the real sibling without any Ollama server or API key.
mkdirSync(home, { recursive: true });
mkdirSync(runDir, { recursive: true });
daemon = spawn(
  jcodeBin,
  ['--no-update', '--no-selfdev', '--socket', legacySock, '--provider', 'ollama', '--model', 'llama3.2', 'serve'],
  { env: { ...process.env, ...isolationEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
);
daemon.stdout?.on('data', (d: Buffer) => process.stdout.write(`[daemon] ${d}`));
daemon.stderr?.on('data', (d: Buffer) => process.stderr.write(`[daemon:err] ${d}`));
daemon.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`[daemon] exited ${code}`);
});

// Phase 2: the real bridge. It dials the daemon socket BEFORE hello_ok
// (harness-api-server lib.rs), so the daemon must already be listening.
bridge = spawn(bridgeBin, [apiSock, legacySock], {
  env: { ...process.env, ...isolationEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stdout?.on('data', (d: Buffer) => process.stdout.write(`[bridge] ${d}`));
bridge.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge:err] ${d}`));
bridge.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`[bridge] exited ${code}`);
});

// Wait for the api socket to appear (bounded — a hang here is a failure).
let up = false;
for (let i = 0; i < 150; i++) {
  if (await pipeExists(pipe)) {
    up = true;
    break;
  }
  await sleep(100);
}
if (!up) fail('bridge never published its api socket');

// Phase 3: hello_ok from the real bridge over the real transport.
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

// Phase 4: a REAL session id minted by the REAL daemon (the stub probe faked
// the attach handshake; this is the assertion it could never make).
let sessionId: string;
try {
  sessionId = await client.createSession();
} catch (e) {
  fail(`create_session against the real daemon failed: ${(e as Error).message}`);
}
if (!sessionId) fail('create_session returned no session id');
console.log(`real daemon minted session: ${sessionId}`);

// Phase 5: disconnect assertion. Kill OUR daemon child — the unambiguous
// "sibling died" event — then assert both closure signals:
//   (a) an inflight leg rejects with [jcode:CLOSED] (never hangs), and
//   (b) the client emits 'close' (runner.ts relies on this to fail runs).
// The probe request must be one the BRIDGE cannot answer locally:
// list_sessions is answered locally from persisted metadata, so it resolves
// even with the daemon gone. A legacy-forwarded request (daemon round trip)
// is the real "dead sibling" signal.
daemon?.kill();
const started = Date.now();
const inflight = client.request(
  'soft_interrupt',
  { session_id: sessionId, content: 'ping', urgent: true },
  { timeoutMs: 30_000 },
);
let closedEvent = false;
client.once('close', () => {
  closedEvent = true;
});
try {
  await inflight;
  fail('UNEXPECTED: inflight request resolved after the daemon was killed');
} catch (e) {
  const msg = (e as Error).message;
  if (!msg.includes('CLOSED')) fail(`inflight leg rejected with the wrong error: ${msg}`);
}
if (Date.now() - started > 10_000) fail('disconnect took too long to surface');
if (!closedEvent) fail('client never emitted close after daemon death');
console.log(`disconnect surfaced in ${Date.now() - started}ms: close event + [jcode:CLOSED] rejection`);

// Phase 6: after disconnect, requests fail fast instead of hanging.
try {
  await client.request('list_sessions', {}, { timeoutMs: 5_000 });
  fail('UNEXPECTED: request after disconnect succeeded');
} catch (e) {
  const msg = (e as Error).message;
  if (!msg.includes('NOT_CONNECTED')) fail(`post-disconnect request failed with the wrong error: ${msg}`);
}

client.close();
try {
  bridge?.kill();
} catch {
  /* already gone */
}
try {
  if (!process.env.JCODE_ISOLATION_ROOT) rmSync(isoRoot, { recursive: true, force: true });
} catch {
  /* best effort */
}
console.log('LIVE-JCODE OK: real daemon + real bridge: hello_ok, real session, clean disconnect');
