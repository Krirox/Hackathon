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
