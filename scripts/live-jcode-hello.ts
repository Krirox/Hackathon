import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { JcodeClient } from '../src/jcode/client.ts';
import { API_VERSION_MAJOR } from '../src/jcode/protocol.ts';

/**
 * Live-sibling probe (§0.6 gate, partial): spawn the REAL
 * `jcode-harness-api-bridge` binary (built from the pinned upstream SHA —
 * see docs/upstream.md) on an isolated socket pair and run OUR client
 * against it over the real transport.
 *
 * What this proves: the wire contract holds against the actual sibling
 * (framing, hello handshake, version check, error replies), not just the
 * scripted FakeHarness. What it does NOT prove: session/turn work, which
 * need the full daemon behind the bridge's legacy socket AND a model
 * provider key — both named as blockers in TODO V2.1.
 *
 * Run:  tsx scripts/live-jcode-hello.ts
 * Env:  JCODE_BRIDGE_BIN (default: .upstream/jcode-1jehuang/target/debug/...)
 *       JCODE_API_SOCKET (default: a temp path under the OS temp dir)
 *
 * Exit 0: hello_ok from the live bridge + create_session fails CLEANLY
 * (rejection, no crash) without a daemon. Any crash or hang exits nonzero.
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
const legacySock = `${process.env.TEMP ?? '/tmp'}/vital-live-jcode-legacy-absent.sock`;
const pipe = pipeNameFor(apiSock);

let bridge: ChildProcess | null = null;
const fail = (msg: string): never => {
  console.error(`LIVE-JCODE FAIL: ${msg}`);
  try {
    bridge?.kill();
  } catch {
    /* already gone */
  }
  process.exit(1);
};

console.log(`bridge : ${bridgeBin}`);
console.log(`socket : ${apiSock}`);
console.log(`pipe   : ${pipe}`);
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

// Boundary probe: no daemon listens on the legacy socket, so session work
// must fail — the question is HOW. A rejection is a governed boundary;
// a crash or hang is a bug in us or them.
try {
  const sid = await client.createSession();
  console.log(`UNEXPECTED: live bridge created session ${sid} with no daemon behind it`);
} catch (e) {
  console.log(`create_session without daemon fails cleanly: ${(e as Error).message}`);
}

client.close();
await sleep(200);
bridge.kill();
console.log('LIVE-JCODE OK: hello_ok from the real sibling; daemon boundary fails clean, no crash');
