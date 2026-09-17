import { createHash } from 'node:crypto';
import type { ProgressUpdate, RunResult } from '../jcode/runner.ts';

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
 *  caller's job — pass everyNth or throttle here, the runner emits all.
 *
 *  Delivery is at-most-once fire-and-forget, not a durable outbox: each
 *  progress post is attempted once and never retried or persisted, so a
 *  dead relay means lost lines, never a stalled run. Relay failures stay
 *  non-fatal to the run but are counted on the returned handle (`failures`
 *  + `lastError`) instead of vanishing — the caller can surface them.
 *
 *  The thread must not stay IN_FLIGHT forever: call `terminal()` with the
 *  RunResult (or use `postTerminal()`) so the final COMPLETED / FAILED /
 *  TERMINATED_BUDGET line lands, then `close()` to drain in-flight posts.
 *  `close()` waits for pending posts up to a bounded cap (default 5s) and
 *  then resolves anyway — a hung relay must not hang shutdown. */
export interface WatchTerminalSummary {
  step: number;
  tokens: number;
  toolName?: string;
  text?: string;
}

export interface WatchHandle {
  /** Relay posts lost so far — progress is observability, never control. */
  failures: number;
  /** Last relay error message, or null when nothing has failed yet. */
  lastError: string | null;
  /** Post the final state line for a finished run (COMPLETED / FAILED /
   *  TERMINATED_BUDGET / DENIED). Resolves null on relay failure (counted,
   *  never thrown) so the caller can finish without a second error path. */
  terminal(state: string, summary: WatchTerminalSummary): Promise<BuzzNostrEvent | null>;
  /** Unsubscribe (when the subscriber supports it) and drain in-flight
   *  posts, bounded by `timeoutMs` (default 5000) — resolves anyway after
   *  the cap so shutdown never hangs on a dead relay. */
  close(timeoutMs?: number): Promise<void>;
}

/** Subscribe shape: returning an unsubscribe (function, or an object with
 *  `unsubscribe`/`close`) lets `close()` detach; a bare void return keeps
 *  the old fire-and-forget wiring and `close()` only drains. */
export type WatchSubscribe = (
  fn: (p: ProgressUpdate) => void,
) => void | (() => void) | { unsubscribe(): void } | { close(): void } | unknown;

export function watchRun(
  subscribe: WatchSubscribe,
  surface: BuzzSurface,
  opts: { channel: string; threadRoot?: string; requestId: string; everyNth?: number },
): WatchHandle {
  const every = opts.everyNth ?? 1;
  let seen = 0;
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  // Assigned below: the progress callback closes over `handle` for failure
  // accounting, so the object must exist before subscribe() runs.
  const handle = {
    failures: 0,
    lastError: null as string | null,
    terminal,
    close,
  } satisfies WatchHandle as WatchHandle;
  const recordFailure = (e: unknown): null => {
    handle.failures += 1;
    handle.lastError = (e as Error)?.message ?? String(e);
    return null;
  };
  const fire = (post: BuzzProgressPost): Promise<BuzzNostrEvent | null> => {
    const p = surface.post(post).then(
      (ev) => ev,
      (e: unknown) => recordFailure(e),
    );
    pending.add(p);
    void p.finally(() => {
      pending.delete(p);
    });
    return p;
  };
  async function terminal(state: string, summary: WatchTerminalSummary): Promise<BuzzNostrEvent | null> {
    return fire({
      channel: opts.channel,
      threadRoot: opts.threadRoot,
      requestId: opts.requestId,
      step: summary.step,
      toolName: summary.toolName,
      tokens: summary.tokens,
      state,
      text: summary.text,
    });
  }
  async function close(timeoutMs = 5000): Promise<void> {
    closed = true;
    try {
      if (typeof subResult === 'function') (subResult as () => void)();
      else if (subResult && typeof (subResult as { unsubscribe?: unknown }).unsubscribe === 'function')
        (subResult as { unsubscribe(): void }).unsubscribe();
      else if (subResult && typeof (subResult as { close?: unknown }).close === 'function')
        (subResult as { close(): void }).close();
    } catch {
      // Detach is best-effort: a throwing unsubscribe must not fail drain.
    }
    if (pending.size === 0) return;
    // Bounded drain: a hung relay resolves anyway after the cap instead of
    // wedging shutdown behind observability traffic.
    await Promise.race([Promise.allSettled([...pending]), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }
  const subResult: unknown = (subscribe as (fn: (p: ProgressUpdate) => void) => unknown)((p) => {
    if (closed) return;
    if (p.requestId !== opts.requestId) return;
    seen += 1;
    if (seen % every !== 0) return;
    void fire({
      channel: opts.channel,
      threadRoot: opts.threadRoot,
      requestId: p.requestId,
      step: p.step,
      toolName: p.toolName,
      tokens: p.tokens,
      state: 'IN_FLIGHT',
    });
  });
  return handle;
}

/** Post the terminal line for a finished RunResult through a watch handle.
 *  Step defaults to the tool-call count, tokens to input+output spend, and
 *  the state to the result status — override `step`/`text` when the caller
 *  tracked finer progress. Relay failure resolves null (counted on the
 *  handle), never throws. */
export function postTerminal(
  handle: WatchHandle,
  result: RunResult,
  opts: { step?: number; text?: string } = {},
): Promise<BuzzNostrEvent | null> {
  const tokens = result.usage.input + result.usage.output;
  const step = opts.step ?? result.toolCalls.length;
  return handle.terminal(result.status, { step, tokens, text: opts.text });
}
