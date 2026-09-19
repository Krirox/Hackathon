import { T, eq, TEN, NOW, fresh, sor, base, rejects, withHarness, withVmRoot } from './helpers.ts';
import { createHmacSurface, statementHashOf } from '../src/talk/surface.ts';
import { createServer, type Server } from 'node:http';
import { JcodeRunner } from '../src/jcode/runner.ts';
import {
  BUZZ_CHAT_KIND,
  createBuzzSurface,
  formatProgress,
  nostrEventId,
  watchRun,
  type BuzzNostrEvent,
} from '../src/talk/buzz.ts';
import { generateNostrKeypair, verifyNostrEvent } from '../src/talk/nostr.ts';
import { judgeText, approvedCompleteChat, devProfile } from '../src/substrate/models.ts';
import { laneModelFn } from '../src/sense/triage.ts';
import { ApplicationWorker } from '../src/substrate/worker.ts';
import type { HarnessAdapter, HarnessTask, HarnessOutcome } from '../src/substrate/harness.ts';
console.log('\n\x1b[1mTalk surface — the ledger survives a swap\x1b[0m');

T('a claim bound on one surface verifies; the ledger stores only the opaque binding', async () => {
  const { ledger } = await fresh();
  const c = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'FACT',
    statement: 'Pro is $99',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'system',
    provenance: sor(),
  });
  const surface = createHmacSurface('tenant-secret');
  const env = surface.bindClaim({
    claimId: c.id,
    seq: c.seq,
    statementHash: statementHashOf(c.statement),
    scope: c.scope,
    tenant: TEN,
    boundAt: NOW,
  });
  // The ledger carries the envelope as an opaque string — no surface shape leaks in.
  const bound = await ledger.append({
    tenant: TEN,
    subject: 'price',
    kind: 'OBSERVATION',
    statement: 'published to talk surface',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 's',
    scope: 'x',
    authorType: 'agent',
    buzzEventSig: JSON.stringify(env),
    provenance: { ...sor(), sourceTier: 'SINGLE_SOURCE' },
  });
  const back = surface.verifyEnvelope(JSON.parse(String(bound.buzzEventSig)));
  eq(back.claimId, c.id);
  eq(back.seq, c.seq);
});

T('a tampered binding fails loudly, never degrades silently', async () => {
  const surface = createHmacSurface('tenant-secret');
  const env = surface.bindClaim({
    claimId: 'clm_1',
    seq: 7,
    statementHash: statementHashOf('Pro is $99'),
    scope: 'x',
    tenant: TEN,
    boundAt: NOW,
  });
  await rejects(
    async () =>
      surface.verifyEnvelope({ ...env, binding: { ...env.binding, statementHash: statementHashOf('Pro is $9') } }),
    'TAMPERED_ENVELOPE',
  );
  await rejects(async () => createHmacSurface('other-secret').verifyEnvelope(env), 'TAMPERED_ENVELOPE');
  await rejects(async () => surface.verifyEnvelope({ ...env, surface: 'buzz' }), 'WRONG_SURFACE');
  await rejects(async () => createHmacSurface(''), 'NO_SECRET');
});

/**
 * A relay that lives for one assertion block: captures POST /events.
 *
 * It captures the **bare event**, which is what a real Buzz relay expects —
 * the old `{ event }` envelope was answered with `invalid event JSON: missing
 * field \`id\``.
 */
async function fakeRelay(handler?: (body: unknown) => { status: number; json: unknown }): Promise<{
  url: string;
  received: { path: string; body: BuzzNostrEvent; headers: Record<string, string> }[];
  close(): Promise<void>;
}> {
  const received: { path: string; body: BuzzNostrEvent; headers: Record<string, string> }[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(data) as BuzzNostrEvent;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      received.push({ path: req.url ?? '', body, headers });
      const out = handler ? handler(body) : { status: 200, json: { ok: true } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * A real agent identity plus the room's relay channel UUID. Both are load
 * bearing now: the relay verifies the Schnorr signature, and channel-scoped
 * events must carry a real channel UUID in `#h`.
 */
const testAgent = generateNostrKeypair();
const TEST_CHANNEL = '9f1c1d3e-6a2b-4c3d-8e4f-5a6b7c8d9e0f';
const TEST_THREAD_ROOT = 'a'.repeat(64);
const testSurface = (relayUrl: string) =>
  createBuzzSurface({
    relayUrl,
    keypair: testAgent,
    authMode: 'dev-pubkey',
    fetchFn: stubFetch,
    channelIdFor: (ref) => (ref === 'engineering' || ref === 'risk' ? TEST_CHANNEL : null),
  });

const stubFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

T('progress posts are signed kind-9 messages bound to channel, thread and request', async () => {
  const relay = await fakeRelay();
  try {
    const buzz = testSurface(relay.url);
    const ev = await buzz.post({
      channel: 'engineering',
      threadRoot: TEST_THREAD_ROOT,
      requestId: 'req_1',
      step: 3,
      toolName: 'write_file',
      tokens: 1500,
      state: 'IN_FLIGHT',
    });
    eq(relay.received.length, 1);
    eq(relay.received[0]!.path, '/events');
    // The wire body is the bare event: a real relay parses it as one.
    eq(relay.received[0]!.body.id, ev.id, 'the posted body is the event itself:');
    eq(relay.received[0]!.headers['content-type'], 'application/json');
    eq(relay.received[0]!.headers['x-pubkey'], testAgent.pubkey, 'dev auth names the agent:');
    eq(ev.kind, BUZZ_CHAT_KIND, 'NIP-29 group-chat message:');
    eq(ev.pubkey, testAgent.pubkey, 'the room agent posts as itself:');
    eq(
      ev.tags,
      [
        ['h', TEST_CHANNEL],
        ['e', TEST_THREAD_ROOT, relay.url, 'reply'],
        ['vital-request', 'req_1', 'IN_FLIGHT'],
        ['vital-tool', 'write_file'],
      ],
      'channel + thread root + request binding ride tags, not prose:',
    );
    eq(ev.content.includes('req_1') && ev.content.includes('1500'), true, 'humans can read it too:');
    eq(
      ev.id,
      nostrEventId(ev.pubkey, { kind: ev.kind, tags: ev.tags, content: ev.content, createdAt: ev.created_at }),
      'id recomputes (NIP-01):',
    );
    eq(ev.sig.length, 128, 'a real 64-byte BIP-340 signature is attached:');
    eq(
      verifyNostrEvent({
        pubkey: ev.pubkey,
        id: ev.id,
        sig: ev.sig,
        kind: ev.kind,
        tags: ev.tags,
        content: ev.content,
        createdAt: ev.created_at,
      }),
      true,
      'the relay would accept this signature:',
    );
  } finally {
    await relay.close();
  }
});

T('relay failures fail loud; unbound posts never reach the network', async () => {
  const dead = createBuzzSurface({
    relayUrl: 'http://127.0.0.1:1',
    keypair: testAgent,
    authMode: 'dev-pubkey',
    fetchFn: stubFetch,
    channelIdFor: () => TEST_CHANNEL,
  });
  await rejects(
    async () => dead.post({ channel: 'engineering', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
    'RELAY_UNREACHABLE',
  );
  const refusing = await fakeRelay(() => ({ status: 403, json: { error: 'not a member' } }));
  try {
    const buzz = testSurface(refusing.url);
    await rejects(
      async () => buzz.post({ channel: 'engineering', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'RELAY_REJECTED',
    );
  } finally {
    await refusing.close();
  }
  const relay = await fakeRelay();
  try {
    const buzz = testSurface(relay.url);
    await rejects(
      async () => buzz.post({ channel: '', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'NO_CHANNEL',
    );
    await rejects(
      async () => buzz.post({ channel: 'engineering', requestId: '', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'NO_REQUEST',
    );
    // A room that was never provisioned has no relay channel UUID: publishing
    // must refuse rather than guess at a channel name.
    await rejects(
      async () => buzz.post({ channel: 'ops', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'CHANNEL_NOT_PROVISIONED',
    );
    eq(relay.received.length, 0, 'nothing unbound touches the wire:');
  } finally {
    await relay.close();
  }
});

T('formatProgress names request, step, tool, spend and state', async () => {
  eq(
    formatProgress({ channel: 'c', requestId: 'req_9', step: 7, toolName: 'bash', tokens: 4242, state: 'IN_FLIGHT' }),
    '[vital req_9 step 7 tool=bash 4242 tokens IN_FLIGHT]',
  );
});

T('a live run streams progress into the originating thread', async () => {
  const relay = await fakeRelay();
  try {
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
        base({ id: 'live1', claimRefs: [clm.id], bid: { dollars: 5, tokens: 100_000 } }),
      );
      const buzz = createBuzzSurface({
        relayUrl: relay.url,
        keypair: testAgent,
        authMode: 'dev-pubkey',
        fetchFn: stubFetch,
        channelIdFor: () => TEST_CHANNEL,
      });
      const r = new JcodeRunner(db, ledger, coord);
      watchRun(
        (fn) => {
          r.on('progress', fn);
        },
        buzz,
        // A bogus thread root is dropped rather than published: the surface
        // only emits an `e` reply tag for a real 64-hex event id.
        { channel: 'eng', threadRoot: 'root-1', requestId: request.id },
      );
      const out = await r.run(
        TEN,
        request.id,
        { command: 'do it', claimRefs: [clm.id], onBehalfOf: 'human:priya', maxDollars: 5, maxTokens: 100_000 },
        { socketPath: h.path },
      );
      eq(out.status, 'COMPLETED');
      // Posts are fire-and-forget (a dead relay must never stall a run), so
      // wait for the thread to catch up — bounded, a hang here is a failure.
      let posts = 0;
      for (let i = 0; i < 100 && posts < 2; i++) {
        await new Promise((r2) => setTimeout(r2, 20));
        posts = relay.received.length;
      }
      eq(posts >= 2, true, `progress reached the thread (got ${posts}):`);
      for (const { body } of relay.received) {
        const ev = body;
        eq(
          ev.tags.some((t) => t[0] === 'vital-request' && t[1] === request.id),
          true,
          'every post names its request:',
        );
        eq(ev.tags[0], ['h', TEST_CHANNEL], 'posts land in the relay channel UUID:');
        eq(
          ev.tags.some((t) => t[0] === 'e'),
          false,
          'a non-event thread root emits no reply tag:',
        );
      }
      eq((await coord.get(TEN, request.id))!.spent.tokens, 1500, 'the mid-run flow persisted the spend:');
    });
  } finally {
    await relay.close();
  }
});

// ---------------------------------------------------- F25 tests ----

T('F25: judgeText strict score: whole-number-only responses score correctly', async () => {
  const stubFetch = async (_url: string, _init: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '0.2' }] } }], usageMetadata: {} }),
  });
  const result = await judgeText({ profile: devProfile(), apiKey: 'k', fetchFn: stubFetch as never }, 'benign text');
  eq(result.score, 0.2);
  eq(result.flags.length, 0, 'score below 0.5 has no flags:');
});

T('F25: judgeText strict score: substring responses are unparseable — no prefix extraction', async () => {
  // "10 out of 10" used to extract "1" from the regex prefix match.
  // "0.7 is my score" used to extract "0" (prefix of 0.7).
  // Both must now fail closed to score=1 / judge_unparseable.
  for (const badResponse of ['10 out of 10', '0.7 is my score', 'sure, 0.3', '  1.5 ', '2', 'benign']) {
    const stubFetch = async (_url: string, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: badResponse }] } }], usageMetadata: {} }),
    });
    const result = await judgeText({ profile: devProfile(), apiKey: 'k', fetchFn: stubFetch as never }, 'some text');
    eq(result.score, 1, `bad response "${badResponse}" should fail closed:`);
    eq(result.flags.includes('judge_unparseable') || result.flags.includes('model_judge'), true);
  }
});

T('F25: judgeText strict score: score=1.0 exact string scores 1 with model_judge flag', async () => {
  const stubFetch = async (_url: string, _init: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '1.0' }] } }], usageMetadata: {} }),
  });
  const result = await judgeText({ profile: devProfile(), apiKey: 'k', fetchFn: stubFetch as never }, 'injected text');
  eq(result.score, 1);
  eq(result.flags.includes('model_judge'), true);
});

T('F25: approvedCompleteChat enforces model approval before network — unapproved model throws', async () => {
  let networkHit = false;
  const stubFetch = async () => {
    networkHit = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const unapprovedProfile = { ...devProfile(), model: 'rogue-model-xyz' };
  await rejects(
    async () =>
      approvedCompleteChat('dev', unapprovedProfile, 'k', [{ role: 'user', text: 'hi' }], stubFetch as never, {
        APPROVED_DEV_MODELS: 'gemini-3.8-flash',
      }),
    'UNAPPROVED_MODEL',
  );
  eq(networkHit, false, 'unapproved model must not touch the wire:');
});

T('F25: approvedCompleteChat allows approved model through', async () => {
  let networkHit = false;
  const stubFetch = async () => {
    networkHit = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    };
  };
  const approvedProfile = { ...devProfile(), model: 'gemini-3.8-flash' };
  const result = await approvedCompleteChat(
    'dev',
    approvedProfile,
    'k',
    [{ role: 'user', text: 'hi' }],
    stubFetch as never,
    { APPROVED_DEV_MODELS: 'gemini-3.8-flash' },
  );
  eq(networkHit, true, 'approved model reaches the wire:');
  eq(result.text, 'ok');
});

T('F25: laneModelFn rejects unapproved model before any network call', async () => {
  let networkHit = false;
  const stubFetch = async () => {
    networkHit = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const modelFn = laneModelFn('dev', stubFetch as never);
  const unapproved = { ...devProfile(), model: 'forbidden-model' };
  await rejects(() => modelFn(unapproved, 'key', [{ role: 'user', text: 'test' }]), 'UNAPPROVED_MODEL');
  eq(networkHit, false, 'forbidden model never reaches the wire:');
});

T('F25: worker posts terminal Buzz event after adapter dispatch; relay failures are non-fatal', async () => {
  const relay = await fakeRelay();
  // Non-baseline adapter: dispatch provisions a real team-VM workspace.
  // Keep it inside a temp root, never the production default.
  await withVmRoot(async () => {
    try {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'task',
      kind: 'OBSERVATION',
      statement: 'do work',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'agent:w',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    const { request } = await coord.submit(
      base({ id: 'buzz1', claimRefs: [clm.id], bid: { dollars: 1, tokens: 10_000 }, now: new Date().toISOString() }),
    );

    // Inject a non-baseline adapter that completes the request without a real harness
    const fakeAdapter: HarnessAdapter = {
      name: 'fake-model',
      category: 'model',
      isTestBaseline: false,
      async run(_tenant: string, reqId: string, _task: HarnessTask): Promise<HarnessOutcome> {
        await coord.claimExecution(TEN, reqId, 'fake-model:worker', new Date().toISOString());
        await coord.complete(TEN, reqId, { claims: [clm.id], cost: { tokens: 42 } });
        return {
          adapter: 'fake-model',
          requestId: reqId,
          status: 'COMPLETED',
          transcript: 'done',
          tools: ['write_file'],
          usage: { input: 10, output: 5 },
          permissions: [],
          isTestBaseline: false,
        };
      },
    };

    const buzzSurface = createBuzzSurface({
      relayUrl: relay.url,
      keypair: testAgent,
      authMode: 'dev-pubkey',
      fetchFn: async (url, init) => {
        const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
        return { ok: res.ok, status: res.status, text: () => res.text() };
      },
      channelIdFor: () => TEST_CHANNEL,
    });

    const worker = new ApplicationWorker(db, ledger, coord, {
      tenant: TEN,
      adapter: fakeAdapter,
      dispatchRequests: true,
      relayOutbox: false,
      enableLearningLoop: false,
      sweepIntervalMs: 99_999,
      buzz: {
        surface: buzzSurface,
        channelFor: () => ({ channel: 'engineering' }),
      },
    });

    await worker.tick();

    // Wait for async Buzz fire-and-forget posts to drain
    for (let i = 0; i < 50 && relay.received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    eq(
      relay.received.length >= 1,
      true,
      `at least one terminal Buzz event must be posted (got ${relay.received.length}):`,
    );
    const last = relay.received[relay.received.length - 1]!;
    eq(
      last.body.tags.some((t) => t[0] === 'vital-request' && t[1] === request.id),
      true,
      'terminal event names the request:',
    );
    eq(
      last.body.tags.some((t) => t[0] === 'vital-request' && (t[2] === 'COMPLETED' || t[2] === 'FAILED')),
      true,
      'terminal event carries terminal state:',
    );
    eq(worker.status().counters.buzzRelayFailures, 0, 'no relay failures on success:');
    } finally {
      await relay.close();
    }
  });
});

T('F25: worker skips Buzz posting for test-baseline adapters', async () => {
  const relay = await fakeRelay();
  try {
    const { db, ledger, coord } = await fresh();
    const clm = await ledger.append({
      tenant: TEN,
      subject: 'task',
      kind: 'OBSERVATION',
      statement: 'baseline task',
      confidence: 1,
      observedAt: NOW,
      validFrom: NOW,
      owner: 'agent:w',
      scope: 'engineering',
      authorType: 'system',
      provenance: sor(),
    });
    await coord.submit(
      base({ id: 'buzz2', claimRefs: [clm.id], bid: { dollars: 1, tokens: 10_000 }, now: new Date().toISOString() }),
    );

    const buzzSurface = createBuzzSurface({
      relayUrl: relay.url,
      keypair: testAgent,
      authMode: 'dev-pubkey',
      fetchFn: async (url, init) => {
        const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
        return { ok: res.ok, status: res.status, text: () => res.text() };
      },
      channelIdFor: () => TEST_CHANNEL,
    });

    // LocalEchoAdapter is a test-baseline; Buzz should be silenced for it
    const worker = new ApplicationWorker(db, ledger, coord, {
      tenant: TEN,
      dispatchRequests: true,
      relayOutbox: false,
      enableLearningLoop: false,
      sweepIntervalMs: 99_999,
      buzz: {
        surface: buzzSurface,
        channelFor: () => ({ channel: 'chan-engineering' }),
      },
    });

    await worker.tick();
    await new Promise((r) => setTimeout(r, 80));

    eq(relay.received.length, 0, 'test-baseline adapter must not post to Buzz relay:');
  } finally {
    await relay.close();
  }
});
