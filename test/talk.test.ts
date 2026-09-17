import { T, eq, TEN, NOW, fresh, sor, base, rejects, withHarness } from './helpers.ts';
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

/** A relay that lives for one assertion block: captures POST /events. */
async function fakeRelay(handler?: (body: unknown) => { status: number; json: unknown }): Promise<{
  url: string;
  received: { path: string; body: { event: BuzzNostrEvent } }[];
  close(): Promise<void>;
}> {
  const received: { path: string; body: { event: BuzzNostrEvent } }[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(data) as { event: BuzzNostrEvent };
      received.push({ path: req.url ?? '', body });
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

const stubSigner = (pubkey: string) => ({
  pubkey,
  sign: (id: string) => `sig:${id.slice(0, 16)}`,
});

const stubFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

T('progress posts are signed kind-9 messages bound to channel, thread and request', async () => {
  const relay = await fakeRelay();
  try {
    const buzz = createBuzzSurface({ relayUrl: relay.url, signer: stubSigner('room-pubkey'), fetchFn: stubFetch });
    const ev = await buzz.post({
      channel: 'chan-engineering',
      threadRoot: 'root-event-id',
      requestId: 'req_1',
      step: 3,
      toolName: 'write_file',
      tokens: 1500,
      state: 'IN_FLIGHT',
    });
    eq(relay.received.length, 1);
    eq(relay.received[0]!.path, '/events');
    eq(ev.kind, BUZZ_CHAT_KIND, 'NIP-29 group-chat message:');
    eq(ev.pubkey, 'room-pubkey', 'the room agent posts as itself:');
    eq(
      ev.tags,
      [
        ['h', 'chan-engineering'],
        ['e', 'root-event-id', relay.url, 'reply'],
        ['vital-request', 'req_1', 'IN_FLIGHT'],
        ['vital-tool', 'write_file'],
      ],
      'channel + thread root + request binding ride tags, not prose:',
    );
    eq(ev.content.includes('req_1') && ev.content.includes('1500'), true, 'humans can read it too:');
    eq(ev.id, nostrEventId(ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content), 'id recomputes (NIP-01):');
    eq(ev.sig, `sig:${ev.id.slice(0, 16)}`, 'signed by the room identity:');
  } finally {
    await relay.close();
  }
});

T('relay failures fail loud; unbound posts never reach the network', async () => {
  const dead = createBuzzSurface({
    relayUrl: 'http://127.0.0.1:1',
    signer: stubSigner('room-pubkey'),
    fetchFn: stubFetch,
  });
  await rejects(
    async () => dead.post({ channel: 'c', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
    'RELAY_UNREACHABLE',
  );
  const refusing = await fakeRelay(() => ({ status: 403, json: { error: 'not a member' } }));
  try {
    const buzz = createBuzzSurface({ relayUrl: refusing.url, signer: stubSigner('room-pubkey'), fetchFn: stubFetch });
    await rejects(
      async () => buzz.post({ channel: 'c', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'RELAY_REJECTED',
    );
  } finally {
    await refusing.close();
  }
  const relay = await fakeRelay();
  try {
    const buzz = createBuzzSurface({ relayUrl: relay.url, signer: stubSigner('room-pubkey'), fetchFn: stubFetch });
    await rejects(
      async () => buzz.post({ channel: '', requestId: 'r', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'NO_CHANNEL',
    );
    await rejects(
      async () => buzz.post({ channel: 'c', requestId: '', step: 1, tokens: 0, state: 'IN_FLIGHT' }),
      'NO_REQUEST',
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
      const buzz = createBuzzSurface({ relayUrl: relay.url, signer: stubSigner('room-pubkey'), fetchFn: stubFetch });
      const r = new JcodeRunner(db, ledger, coord);
      watchRun(
        (fn) => {
          r.on('progress', fn);
        },
        buzz,
        { channel: 'chan-eng', threadRoot: 'root-1', requestId: request.id },
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
        eq(
          body.event.tags.some((t) => t[0] === 'vital-request' && t[1] === request.id),
          true,
          'every post names its request:',
        );
        eq(body.event.tags[0], ['h', 'chan-eng']);
      }
      eq((await coord.get(TEN, request.id))!.spent.tokens, 1500, 'the mid-run flow persisted the spend:');
    });
  } finally {
    await relay.close();
  }
});
