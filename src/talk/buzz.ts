import type { ProgressUpdate, RunResult } from '../jcode/runner.ts';
import type { BuzzNostrEvent, BuzzProgressPost, BuzzSurface } from './buzz-surface.ts';

/**
 * Live run progress over Buzz, plus the re-exported surface.
 *
 * The surface itself (relay auth, wire format, channel resolution) lives in
 * `buzz-surface.ts`; this module keeps the `./buzz.ts` import path the other
 * talk modules already use, and owns the "publish a run live" plumbing.
 */

export {
  BUZZ_APPROVAL_DENY_KIND,
  BUZZ_APPROVAL_GRANT_KIND,
  BUZZ_CANVAS_KIND,
  BUZZ_CHAT_KIND,
  BUZZ_CREATE_GROUP_KIND,
  BUZZ_GROUP_METADATA_KIND,
  BUZZ_RELAY_CANVAS_KIND,
  BUZZ_STATUS_KIND,
  BuzzError,
  createBuzzSurface,
  formatProgress,
  isChannelUuid,
  nostrEventId,
  signBuzzEvent,
  type BuzzAuthMode,
  type BuzzFetch,
  type BuzzFilter,
  type BuzzNostrEvent,
  type BuzzProgressPost,
  type BuzzRelayHealth,
  type BuzzSurface,
  type CreateBuzzSurfaceOptions,
} from './buzz-surface.ts';

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
  deliverableId?: string;
  deliverableVersion?: number;
  deliverableFingerprint?: string;
  prUrl?: string;
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
    const tags: string[] = [];
    if (summary.deliverableId) tags.push(`[deliverable:${summary.deliverableId}]`);
    const head = state === 'COMPLETED' && summary.deliverableVersion !== undefined
      ? `Work done — v${summary.deliverableVersion}${summary.prUrl ? ` · ${summary.prUrl}` : ''}`
      : undefined;
    return fire({
      channel: opts.channel,
      threadRoot: opts.threadRoot,
      requestId: opts.requestId,
      step: summary.step,
      toolName: summary.toolName,
      tokens: summary.tokens,
      state,
      text: [head, summary.text, ...tags].filter(Boolean).join('\n'),
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
