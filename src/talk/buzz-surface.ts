import type { NostrKeypair } from './nostr.ts';
import {
  nip98AuthHeader,
  signNostrEvent,
  toWireEvent,
  type NostrEventInput,
  type SignedNostrEvent,
  type WireNostrEvent,
} from './nostr.ts';

/**
 * Buzz publishing surface — the real one.
 *
 * Everything here was established against a live Buzz relay, not guessed:
 *
 * - `POST {relay}/events` takes the **bare event object** in the Nostr wire
 *   shape (`created_at`, not `createdAt`). The old implementation sent
 *   `{ event }`, which the relay answers with `invalid event JSON: missing
 *   field \`id\``.
 * - Writes authenticate either with `Authorization: Nostr <base64 kind-27235
 *   event>` (NIP-98, production) or, only when the relay runs with
 *   `BUZZ_REQUIRE_AUTH_TOKEN=false`, with `X-Pubkey: <hex>` (local dev).
 * - The relay binds the community from the request `Host`, so the configured
 *   relay URL must be the community's host (`localhost:3000` locally).
 * - Channel-scoped events must carry `#h` = the **channel UUID** the relay
 *   assigned when the room was created. A slug such as `chan-risk-monitor` is
 *   rejected with `invalid: channel-scoped events must include an h tag`.
 * - Kind 9, 30315 (status), 30023/40100 (canvas) and the approval kinds
 *   46030/46031 are accepted; every other kind answers `restricted: unknown
 *   event kind`. Publishers must stay inside that whitelist.
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
/** Kind Buzz renders as a status beacon — drives the 🟢/🟡/🔴 room indicator. */
export const BUZZ_STATUS_KIND = 30315;
/** Kind Buzz renders as a pinned canvas document. */
export const BUZZ_CANVAS_KIND = 30023;
/** Kind the relay assigns to a room's long-form canvas. */
export const BUZZ_RELAY_CANVAS_KIND = 40100;
/** Relay-side approval kinds (accepted by the kind whitelist). */
export const BUZZ_APPROVAL_GRANT_KIND = 46030;
export const BUZZ_APPROVAL_DENY_KIND = 46031;
/** NIP-29 group creation / group metadata kinds. */
export const BUZZ_CREATE_GROUP_KIND = 9007;
export const BUZZ_GROUP_METADATA_KIND = 39000;

export type BuzzAuthMode = 'nip98' | 'dev-pubkey';

export interface BuzzProgressPost {
  /**
   * Room reference: a scope (`risk`), room id (`risk-monitor`) or channel slug
   * (`chan-risk-monitor`). The surface resolves it to the relay channel UUID —
   * a reference it cannot resolve is refused, never silently published.
   */
  channel: string;
  /** Thread root event id (NIP-10 reply). Omitted when there is no real root. */
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

/** A relay event, in the Nostr wire shape. */
export type BuzzNostrEvent = WireNostrEvent;

export interface BuzzFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  limit?: number;
  since?: number;
  until?: number;
  '#h'?: string[];
  '#e'?: string[];
  '#d'?: string[];
}

export type BuzzFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BuzzSurface {
  readonly name: string;
  readonly relayUrl: string;
  readonly authMode: BuzzAuthMode;
  /** The agent identity every event is signed with. */
  readonly pubkey: string;
  /** Publish a fully-formed event (the primitive all publishers use). */
  publish(evt: { kind: number; tags: string[][]; content: string }): Promise<BuzzNostrEvent>;
  /** Publish run progress into a room thread. */
  post(post: BuzzProgressPost): Promise<BuzzNostrEvent>;
  /** Read events back (messages, beacons, canvases, review cards). */
  query(filters: BuzzFilter[]): Promise<BuzzNostrEvent[]>;
  /** Relay reachability probe for the console and CLI. */
  health(): Promise<BuzzRelayHealth>;
}

export interface BuzzRelayHealth {
  ok: boolean;
  relayUrl: string;
  authMode: BuzzAuthMode;
  /** NIP-11 software/version when the relay answered, else null. */
  software: string | null;
  version: string | null;
  /** Community host the relay resolved from the request Host header. */
  communityHost: string | null;
  error: string | null;
}

export function formatProgress(p: BuzzProgressPost): string {
  const tool = p.toolName ? ` tool=${p.toolName}` : '';
  return `[vital ${p.requestId} step ${p.step}${tool} ${p.tokens} tokens ${p.state}]`;
}

/** NIP-01 event id, re-exported for the talk modules that already import it. */
export { nostrEventId } from './nostr.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Telegram-style UUID check — the relay's channel ids are UUID v4. */
export function isChannelUuid(value: string): boolean {
  return UUID_RE.test(value.toLowerCase());
}

export interface CreateBuzzSurfaceOptions {
  relayUrl: string;
  /** The signing identity. Required: an unsigned surface cannot exist. */
  keypair?: NostrKeypair;
  signer?: { pubkey: string; sign(id: string): string };
  /**
   * `nip98` signs an auth event per request (production). `dev-pubkey` sends
   * `X-Pubkey` and only works against a relay running with
   * `BUZZ_REQUIRE_AUTH_TOKEN=false`.
   */
  authMode?: BuzzAuthMode;
  fetchFn?: BuzzFetch;
  /**
   * Map a room reference (scope/room id/slug) to the relay channel UUID.
   * Returns null when the room has not been provisioned on the relay yet.
   */
  channelIdFor?: (reference: string) => string | null;
  now?: () => number;
}

export function createBuzzSurface(opts: CreateBuzzSurfaceOptions): BuzzSurface {
  const relay = opts.relayUrl.replace(/\/+$/, '');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  // Never invent an identity: a random keypair would publish as an agent no
  // one holds, and every event would be unverifiable against the configured
  // agent. Missing key material must be a hard error.
  if (!opts.keypair?.secretKey?.length) {
    throw new BuzzError('NO_IDENTITY', 'a Buzz surface requires an agent keypair to sign events');
  }
  const keypair = opts.keypair;
  const authMode = opts.authMode ?? 'nip98';
  const fetchFn = opts.fetchFn ?? ((url: string, init: any) => (globalThis as any).fetch(url, init));

  async function call(path: string, body: string): Promise<unknown> {
    const url = `${relay}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authMode === 'nip98') {
      headers.authorization = nip98AuthHeader(keypair, url, 'POST', body, now());
    } else {
      headers['x-pubkey'] = keypair.pubkey;
    }
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await fetchFn(url, { method: 'POST', headers, body });
    } catch (e) {
      throw new BuzzError('RELAY_UNREACHABLE', `relay POST ${path} failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new BuzzError('RELAY_REJECTED', `relay refused ${path} (${res.status}): ${text.slice(0, 300)}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new BuzzError('RELAY_BAD_RESPONSE', `relay returned non-JSON for ${path}: ${text.slice(0, 200)}`);
    }
  }

  function resolveChannel(reference: string): string {
    if (!reference) throw new BuzzError('NO_CHANNEL', 'a progress post without a channel is noise: pass channel');
    if (isChannelUuid(reference)) return reference;
    const resolved = opts.channelIdFor?.(reference);
    if (!resolved) {
      throw new BuzzError(
        'CHANNEL_NOT_PROVISIONED',
        `no relay channel for "${reference}": provision the room before publishing (channel ids are UUIDs)`,
      );
    }
    if (!isChannelUuid(resolved)) {
      throw new BuzzError('BAD_CHANNEL', `resolved channel "${resolved}" is not a UUID`);
    }
    return resolved;
  }

  /**
   * Channel references are resolved here, once, for every publisher.
   *
   * A room slug left in `#h` is the single most likely way to publish into the
   * void: the relay answers a non-UUID `h` tag with `invalid: channel-scoped
   * events must include an h tag`, which reads like a malformed-event bug
   * rather than "this room was never provisioned".
   */
  function normalizeTags(tags: string[][]): string[][] {
    if (!tags.some((t) => t[0] === 'h')) return tags;
    return tags.map((t) => (t[0] === 'h' && t[1] ? ['h', resolveChannel(t[1])] : t));
  }

  async function publish(evt: { kind: number; tags: string[][]; content: string }): Promise<BuzzNostrEvent> {
    const signed = signNostrEvent(keypair, {
      kind: evt.kind,
      tags: normalizeTags(evt.tags),
      content: evt.content,
      createdAt: now(),
    });
    const wire = toWireEvent(signed);
    await call('/events', JSON.stringify(wire));
    return wire;
  }

  return {
    name: 'buzz',
    relayUrl: relay,
    authMode,
    pubkey: keypair.pubkey,
    publish,
    async post(post: BuzzProgressPost): Promise<BuzzNostrEvent> {
      if (!post.requestId) {
        throw new BuzzError('NO_REQUEST', 'a progress post without a request id is unbound: pass requestId');
      }
      const channel = resolveChannel(post.channel);
      const tags: string[][] = [['h', channel]];
      // A thread root must be a real event id; a bogus one is rejected by the
      // relay, and a fabricated one would silently scatter the thread.
      if (post.threadRoot && /^[0-9a-f]{64}$/.test(post.threadRoot)) {
        tags.push(['e', post.threadRoot, relay, 'reply']);
      }
      tags.push(['vital-request', post.requestId, post.state]);
      if (post.toolName) tags.push(['vital-tool', post.toolName]);
      return publish({ kind: BUZZ_CHAT_KIND, tags, content: post.text ?? formatProgress(post) });
    },
    async query(filters: BuzzFilter[]): Promise<BuzzNostrEvent[]> {
      const body = JSON.stringify(filters);
      const result = await call('/query', body);
      if (!Array.isArray(result)) {
        throw new BuzzError('RELAY_BAD_RESPONSE', 'relay /query did not return an event array');
      }
      return result.filter((e): e is BuzzNostrEvent => {
        return !!e && typeof e === 'object' && typeof (e as BuzzNostrEvent).id === 'string';
      });
    },
    async health(): Promise<BuzzRelayHealth> {
      const base: BuzzRelayHealth = {
        ok: false,
        relayUrl: relay,
        authMode,
        software: null,
        version: null,
        communityHost: null,
        error: null,
      };
      try {
        // NIP-11 document also proves the Host→community binding resolved.
        const res = await fetchFn(relay, {
          method: 'GET',
          headers: { accept: 'application/nostr+json' },
          body: '',
        });
        const text = await res.text();
        if (!res.ok) return { ...base, error: `relay answered ${res.status}` };
        const doc = JSON.parse(text) as { software?: string; version?: string };
        return {
          ...base,
          ok: true,
          software: doc.software ?? null,
          version: doc.version ?? null,
          communityHost: new URL(relay).host,
        };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    },
  };
}

/** Sign an arbitrary event with a keypair — used by provisioning and publishers. */
export function signBuzzEvent(
  keypair: NostrKeypair,
  evt: Omit<NostrEventInput, 'createdAt'> & { createdAt?: number },
): SignedNostrEvent {
  return signNostrEvent(keypair, { ...evt, createdAt: evt.createdAt ?? Math.floor(Date.now() / 1000) });
}
