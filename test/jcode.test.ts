import { T, eq, TEN, NOW, fresh, sor, base, withHarness, rejects } from './helpers.ts';
import { createServer } from 'node:net';
import { JcodeClient } from '../src/jcode/client.ts';
import { JcodeRunner, defaultPermissionPolicy } from '../src/jcode/runner.ts';
console.log('\n\x1b[1mjcode connection — the wire contract\x1b[0m');

T('a sibling that accepts but never answers surfaces as a timeout, never a hang', async () => {
  // Found live: the real bridge holds hello open while waiting on an absent
  // daemon. The handshake must be bounded or first contact hangs forever.
  const name = `vital-silent-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `${name}.sock`;
  const server = createServer(() => {
    /* accept, never reply */
  });
  await new Promise<void>((res) => server.listen(path, res));
  try {
    await rejects(
      async () => await new JcodeClient({ socketPath: path, helloTimeoutMs: 50 }).connect(),
      'HELLO_TIMEOUT',
    );
  } finally {
    server.close();
  }
});

T('hello is the first frame and carries the protocol major version', async () => {
  await withHarness(async (h) => {
    const c = new JcodeClient({ socketPath: h.path });
    await c.connect();
    eq(h.received[0]!.req, 'hello');
    eq(h.received[0]!.v, 1);
    eq((c.serverInfo as { server?: string })?.server, 'jcode/0.84.0-fake');
    c.close();
  });
});

T('create_session -> send_message -> turn_done completes and collects the transcript', async () => {
  await withHarness(async (h) => {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'release',
      kind: 'OBSERVATION',
      statement: 'v2.14 shipped',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'sync:gh',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(
      base({
        id: 'j1',
        goal: 'implement the EU streaming flag',
        claimRefs: [clm.id],
        deliverableSchema: 'code-change.v1',
      }),
    );
    const r = new JcodeRunner(db, ledger, coord);
    const out = await r.run(
      TEN,
      request.id,
      {
        command: 'Add EU region streaming behind a flag; run tests.',
        claimRefs: [clm.id],
        onBehalfOf: 'human:priya',
        maxDollars: 1,
        maxTokens: 100_000,
      },
      { socketPath: h.path },
    );
    eq(out.status, 'COMPLETED');
    eq(out.transcript.includes('patch applied'), true);
    eq(out.toolCalls.length, 2);
    eq((await coord.get(TEN, request.id))!.state, 'COMPLETED');
    eq(out.usage.input + out.usage.output, 1500);
  });
});

T('PermissionRequest round-trips through OUR policy, not a human at a terminal', async () => {
  await withHarness(async (h) => {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'release',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'j2', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    const out = await r.run(
      TEN,
      request.id,
      { command: 'do it', claimRefs: [clm.id], onBehalfOf: 'human:priya', maxDollars: 1, maxTokens: 10_000 },
      { socketPath: h.path },
    );
    const perm = h.requestsOf('permission_response')[0]!;
    eq(perm.decision, 'deny', 'write_file needs human approval; agents may not self-approve:');
    eq(out.permissions[0]!.decision, 'deny');
    eq(out.permissions[0]!.actionClass, 'ACT_IRREVERSIBLE');
  });
});

T('allowlisted tools are allowed; unknown tools deny by default', async () => {
  await withHarness(async (h) => {
    h.permissionTool = 'curl';
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'j3', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    const out = await r.run(
      TEN,
      request.id,
      { command: 'x', claimRefs: [clm.id], onBehalfOf: 'h', maxDollars: 1, maxTokens: 10_000 },
      { socketPath: h.path },
    );
    eq(out.permissions[0]!.decision, 'deny');
    eq(out.permissions[0]!.reason.includes('unrecognised'), true);
    const pol = defaultPermissionPolicy(new Set(['curl']), new Set());
    eq(
      pol({
        toolName: 'curl',
        description: '',
        task: { command: '', claimRefs: [], onBehalfOf: '', maxDollars: 1, maxTokens: 1 },
      }).decision,
      'allow',
    );
  });
});

T('every permission decision is a Ledger event — a quiet self-block is still visible', async () => {
  await withHarness(async (h) => {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'j4', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    await r.run(
      TEN,
      request.id,
      { command: 'x', claimRefs: [clm.id], onBehalfOf: 'h', maxDollars: 1, maxTokens: 10_000 },
      { socketPath: h.path },
    );
    const acts = (await ledger.bySubject(TEN, 'jcode:engineering')).filter((c) => c.kind === 'ACTION');
    eq(acts.length >= 1, true, 'permission decision recorded:');
    eq(acts[0]!.provenance.sourceTier, 'MEASURED', 'harness output is measured, never asserted:');
  });
});

T('token ceiling terminates the run and the request dies on budget, not silently', async () => {
  await withHarness(async (h) => {
    h.overspendTokens = 999_999;
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'j5', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    const out = await r.run(
      TEN,
      request.id,
      { command: 'x', claimRefs: [clm.id], onBehalfOf: 'h', maxDollars: 1, maxTokens: 500 },
      { socketPath: h.path },
    );
    eq(out.status, 'TERMINATED_BUDGET');
    eq(h.requestsOf('cancel').length, 1, 'harness was cancelled:');
  });
});

T('a completed run becomes a TRACE eligible for compilation', async () => {
  await withHarness(async (h) => {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'j6', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    await r.run(
      TEN,
      request.id,
      { command: 'x', claimRefs: [clm.id], onBehalfOf: 'h', maxDollars: 1, maxTokens: 10_000 },
      { socketPath: h.path },
    );
    const tr = (await db.prepare('SELECT * FROM traces WHERE request_id = ?').get(request.id)) as Record<
      string,
      unknown
    >;
    eq(tr.outcome, 'SUCCESS');
    eq(tr.tier, 'MODEL');
    eq(Number(tr.router_confidence) >= 0.5, true, 'compilable: the compiler refuses low-confidence traces');
  });
});

T('an unadmitted request cannot reach the harness at all', async () => {
  await withHarness(async (h) => {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const a = await coord.submit(base({ id: 'j7', claimRefs: [clm.id] }));
    await coord.decline(TEN, a.request.id, 'no');
    const r = new JcodeRunner(db, ledger, coord);
    let threw = '';
    try {
      await r.run(TEN, a.request.id, {
        command: 'x',
        claimRefs: [clm.id],
        onBehalfOf: 'h',
        maxDollars: 1,
        maxTokens: 100,
      });
    } catch (e) {
      threw = (e as Error).message;
    }
    eq(threw.includes('not admitted'), true);
    eq(h.requestsOf('send_message').length, 0, 'harness never saw the work:');
  });
});

T('garbage and unknown frames are skipped, never crash the loop', async () => {
  await withHarness(async (h) => {
    const c = new JcodeClient({ socketPath: h.path });
    await c.connect();
    const p = c.request('list_sessions');
    const f = await p;
    eq(f.ev, 'sessions');
    c.close();
  });
});

T('an error reply rejects the pending request instead of crashing the process', async () => {
  await withHarness(async (h) => {
    const c = new JcodeClient({ socketPath: h.path });
    await c.connect();
    let sawFrameError = false;
    c.on('frame:error', async () => {
      sawFrameError = true;
    });
    let code = '';
    try {
      await c.request('nope_unknown_xyz');
    } catch (e) {
      code = (e as Error).message;
    }
    eq(code.includes('unknown_request'), true, 'error reply rejects with harness code:');
    eq(sawFrameError, true, 'namespaced frame:error observed without crash:');
    c.close();
  });
});

T('close() rejects inflight requests instead of hanging them', async () => {
  // A harness disconnect mid-run must surface as a rejection: the runner's
  // waitForTurn can only report disconnects if close() settles pendings.
  const name = `vital-quiet-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `${name}.sock`;
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (ch: Buffer) => {
      buf += ch.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line) as { id?: number; req?: string };
        // Answer hello so connect() lands; everything else: silence.
        if (f.req === 'hello') sock.write(`${JSON.stringify({ v: 1, reply_to: f.id, ev: 'hello_ok' })}\n`);
      }
    });
  });
  await new Promise<void>((res) => server.listen(path, res));
  const c = new JcodeClient({ socketPath: path });
  try {
    await c.connect();
    const p = c.request('list_sessions');
    c.close();
    await rejects(async () => await p, 'CLOSED');
  } finally {
    server.close();
  }
});

T('send() resolves on flush without a correlated reply (real-bridge semantics)', async () => {
  // The real bridge answers send_message with NO reply_to frame — awaiting
  // one hangs forever. The scripted FakeHarness masked this by correlating
  // message_accepted. This server behaves like the bridge: hello only.
  const name = `vital-nosend-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `${name}.sock`;
  const seen: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (ch: Buffer) => {
      buf += ch.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line) as { id?: number; req?: string };
        seen.push(String(f.req));
        if (f.req === 'hello') sock.write(`${JSON.stringify({ v: 1, reply_to: f.id, ev: 'hello_ok' })}\n`);
      }
    });
  });
  await new Promise<void>((res) => server.listen(path, res));
  const c = new JcodeClient({ socketPath: path });
  try {
    await c.connect();
    await c.send('sess_1', 'do the thing');
    // send() resolves on flush by design (real-bridge semantics) — flush does
    // NOT guarantee the sibling's data handler ran yet. Poll for the sync point
    // instead of racing it: blind sleeps flake on both sides.
    for (let i = 0; i < 200 && !seen.includes('send_message'); i++) await new Promise((r) => setTimeout(r, 10));
    eq(seen.includes('send_message'), true, 'frame reached the sibling:');
  } finally {
    c.close();
    server.close();
  }
});

T('a request with no reply fails on its bound instead of hanging', async () => {
  const name = `vital-noreply-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `${name}.sock`;
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (ch: Buffer) => {
      buf += ch.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line) as { id?: number; req?: string };
        if (f.req === 'hello') sock.write(`${JSON.stringify({ v: 1, reply_to: f.id, ev: 'hello_ok' })}\n`);
      }
    });
  });
  await new Promise<void>((res) => server.listen(path, res));
  const c = new JcodeClient({ socketPath: path, requestTimeoutMs: 50 });
  try {
    await c.connect();
    await rejects(async () => await c.request('list_sessions'), 'REQUEST_TIMEOUT');
  } finally {
    c.close();
    server.close();
  }
});

T('a bare harness error fails the turn fast with its message', async () => {
  // Real-bridge failure channel: legacy errors arrive as events with no
  // reply_to, never as correlated replies. The turn must fail in
  // milliseconds, not at the 30s ceiling.
  const name = `vital-bareerr-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `${name}.sock`;
  const server = createServer((sock) => {
    let buf = '';
    const send = (ev: Record<string, unknown>) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify({ v: 1, ...ev })}\n`);
    };
    sock.on('data', (ch: Buffer) => {
      buf += ch.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line) as { id?: number; req?: string };
        if (f.req === 'hello') send({ reply_to: f.id, ev: 'hello_ok' });
        else if (f.req === 'create_session') send({ reply_to: f.id, ev: 'attached', session: { session_id: 's1' } });
        else if (f.req === 'attach_session') send({ reply_to: f.id, ev: 'attached', session: { session_id: 's1' } });
        else if (f.req === 'send_message') {
          setTimeout(() => send({ ev: 'error', code: 'daemon_gone', message: 'legacy backend vanished' }), 20);
        }
      }
    });
  });
  await new Promise<void>((res) => server.listen(path, res));
  try {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'r',
      kind: 'OBSERVATION',
      statement: 'x',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 's',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(base({ id: 'jerr', claimRefs: [clm.id] }));
    const r = new JcodeRunner(db, ledger, coord);
    const started = Date.now();
    const out = await r.run(
      TEN,
      request.id,
      {
        command: 'x',
        claimRefs: [clm.id],
        onBehalfOf: 'h',
        maxDollars: 1,
        maxTokens: 10_000,
        turnTimeoutMs: 30_000,
      },
      { socketPath: path },
    );
    eq(out.status, 'FAILED');
    eq(out.refusalReason, 'legacy backend vanished', 'the bare error message lands, not a timeout:');
    eq(Date.now() - started < 10_000, true, 'fast fail, nowhere near the ceiling:');
    eq((await coord.get(TEN, request.id))!.state, 'FAILED');
  } finally {
    server.close();
  }
});
