import { createHash } from 'node:crypto';
import type { ProgressUpdate } from '../jcode/runner.ts';

/**
 * Buzz publishing surface (live watch): post run progress as signed channel
 * messages so a human can watch a coding run live in the Buzz room it came
 * from, instead of waiting for turn_done.
 *
 * What this is: a thin publisher over Buzz's narrow HTTP surface
 * (`POST {relay}/events`, NIP-29 kind-9 messages with an `h` channel tag and
 * a NIP-10 `e` thread-root tag). What it is NOT: a Nostr client — relay
 * subscription, key management and signature verification stay with the
 * relay/SDK, exactly like the claim-binding surface (src/talk/surface.ts).
 *
 * Identity: the room agent posts as itself. The signer holds the room
 * agent's key and is injected at the boundary (Secrets Manager / keychain
 * in production, stub in tests) — keys never touch the Ledger, which keeps
 * only claim bindings.
 *
 * Body shape note: `{ event }` at POST /events is the narrow-surface
 * contract assumed here. If the relay expects the raw `["EVENT", ...]`
 * envelope instead, that is a one-line change in post(), covered by the
 * fake-relay tests in test/talk.test.ts.
 */

export class BuzzError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[buzz:${code}] ${message}`);
  }
}

/** NIP-29 group-chat message — the kind Buzz renders as a channel message. */
export const BUZZ_CHAT_KIND = 9;

export interface BuzzProgressPost {
  /** Buzz channel id (the `h` tag). */
  channel: string;
  /** Thread root event id this run reports into (NIP-10 reply). Required so
   *  progress lands in the originating thread, never as channel noise. */
  threadRoot?: string;
  requestId: string;
  step: number;
  toolName?: string;
  tokens: number;
  /** Run state at post time: IN_FLIGHT, COMPLETED, FAILED, TERMINATED_BUDGET. */
  state: string;
  /** Override the rendered line; defaults to formatProgress(). */
  text?: string;
}

export interface BuzzNostrEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
  sig: string;
}

export interface BuzzSigner {
  readonly pubkey: string;
  sign(eventId: string): string | Promise<string>;
}

export type BuzzFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** NIP-01 event id: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export function nostrEventId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([0, pubkey, createdAt, kind, tags, content]), 'utf8')
    .digest('hex');
}

export function formatProgress(p: BuzzProgressPost): string {
  const tool = p.toolName ? ` tool=${p.toolName}` : '';
  return `[vital ${p.requestId} step ${p.step}${tool} ${p.tokens} tokens ${p.state}]`;
}

export interface BuzzSurface {
  readonly name: string;
  post(post: BuzzProgressPost): Promise<BuzzNostrEvent>;
}

export function createBuzzSurface(opts: {
  relayUrl: string;
  signer: BuzzSigner;
  fetchFn: BuzzFetch;
  now?: () => number;
}): BuzzSurface {
  const relay = opts.relayUrl.replace(/\/$/, '');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    name: 'buzz',
    async post(post: BuzzProgressPost): Promise<BuzzNostrEvent> {
      if (!post.channel) throw new BuzzError('NO_CHANNEL', 'a progress post without a channel is noise — pass channel');
      if (!post.requestId)
        throw new BuzzError('NO_REQUEST', 'a progress post without a request id is unbound — pass requestId');
      const tags: string[][] = [['h', post.channel]];
      if (post.threadRoot) tags.push(['e', post.threadRoot, relay, 'reply']);
      tags.push(['vital-request', post.requestId, post.state]);
      if (post.toolName) tags.push(['vital-tool', post.toolName]);
      const content = post.text ?? formatProgress(post);
      const createdAt = now();
      const id = nostrEventId(opts.signer.pubkey, createdAt, BUZZ_CHAT_KIND, tags, content);
      const sig = await opts.signer.sign(id);
      const event: BuzzNostrEvent = {
        kind: BUZZ_CHAT_KIND,
        pubkey: opts.signer.pubkey,
        created_at: createdAt,
        tags,
        content,
        id,
        sig,
      };
      let res: { ok: boolean; status: number; text(): Promise<string> };
      try {
        res = await opts.fetchFn(`${relay}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event }),
        });
      } catch (e) {
        throw new BuzzError('RELAY_UNREACHABLE', `relay POST failed: ${(e as Error).message}`);
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new BuzzError('RELAY_REJECTED', `relay refused the event (${res.status}): ${detail}`);
      }
      return event;
    },
  };
}

/** Wire a runner's live progress into a Buzz thread. Sampling is the
 *  caller's job — pass everyNth or throttle here, the runner emits all. */
export function watchRun(
  subscribe: (fn: (p: ProgressUpdate) => void) => void,
  surface: BuzzSurface,
  opts: { channel: string; threadRoot?: string; requestId: string; everyNth?: number },
): void {
  const every = opts.everyNth ?? 1;
  let seen = 0;
  subscribe((p) => {
    if (p.requestId !== opts.requestId) return;
    seen += 1;
    if (seen % every !== 0) return;
    void surface
      .post({
        channel: opts.channel,
        threadRoot: opts.threadRoot,
        requestId: p.requestId,
        step: p.step,
        toolName: p.toolName,
        tokens: p.tokens,
        state: 'IN_FLIGHT',
      })
      .catch(() => {
        // A dead relay must never kill the run: progress is observability,
        // not control. The turn summary still lands at completion.
      });
  });
}
