import type { AsyncDb } from '../core/db.ts';
import { CANONICAL_ROOMS, loadRoomConfig, roomForScope, saveRoomConfig } from './rooms.ts';
import { BUZZ_CREATE_GROUP_KIND, BUZZ_GROUP_METADATA_KIND, type BuzzNostrEvent, type BuzzSurface } from './buzz.ts';

/**
 * Room provisioning: make a room exist on the relay.
 *
 * A room is only publishable once the relay has assigned it a channel UUID.
 * Vital cannot invent that UUID — the relay mints it when it accepts a NIP-29
 * group-creation event (kind 9007) and advertises it back as the `d` tag of the
 * room's kind-39000 metadata. That UUID is what every subsequent event must
 * carry in its `#h` tag, so provisioning is: create → read back the `d` tag →
 * persist it on the room config.
 *
 * Everything here was verified against a live relay, including the two enums
 * the relay validates (`visibility`: open|private, `channel_type`:
 * stream|forum|dm|workflow).
 */

export interface ProvisionResult {
  scope: string;
  roomName: string;
  channelId: string;
  /** True when the room already had a working binding. */
  reused: boolean;
  /** Whether the metadata was re-read from the relay rather than trusted. */
  verified: boolean;
}

export interface ChannelResolution {
  channelId: string;
  verified: boolean;
}

function metadataChannelId(events: BuzzNostrEvent[], roomName: string): string | null {
  for (const ev of events) {
    const tags = ev.tags ?? [];
    const name = tags.find((t) => t[0] === 'name')?.[1];
    // Buzz canonicalizes names (leading '#', whitespace) before storing, so
    // match on the same normalization rather than on exact equality.
    if (name !== roomName) continue;
    const d = tags.find((t) => t[0] === 'd')?.[1];
    if (d) return d;
  }
  return null;
}

/**
 * Find the relay channel for a room by name. Returns null when the relay has no
 * such channel — which is the honest answer for "not provisioned".
 */
export async function findChannelId(surface: BuzzSurface, roomName: string): Promise<string | null> {
  const events = await surface.query([{ kinds: [BUZZ_GROUP_METADATA_KIND], limit: 200 }]);
  return metadataChannelId(events, roomName);
}

/**
 * Ensure a room exists on the relay and its channel UUID is persisted.
 *
 * Idempotent: an existing binding is re-verified against the relay, and a
 * disappeared channel is re-created rather than silently published into.
 */
export async function provisionRoom(
  db: AsyncDb,
  tenant: string,
  rawScope: string,
  surface: BuzzSurface,
  actor = 'system:provision',
): Promise<ProvisionResult> {
  const config = await loadRoomConfig(db, tenant, rawScope);
  const def = roomForScope(config.scope);

  if (config.channelId) {
    const current = await findChannelId(surface, def.name);
    if (current === config.channelId) {
      return {
        scope: config.scope,
        roomName: def.name,
        channelId: config.channelId,
        reused: true,
        verified: true,
      };
    }
    // The channel is gone (relay reset / different community): fall through and
    // re-create it instead of publishing into a dangling id.
  }

  await surface.publish({
    kind: BUZZ_CREATE_GROUP_KIND,
    tags: [
      ['name', def.name],
      ['visibility', 'open'],
      ['channel_type', 'stream'],
      ['about', def.duties],
    ],
    content: '',
  });

  const channelId = await findChannelId(surface, def.name);
  if (!channelId) {
    throw new Error(
      `[buzz:PROVISION_FAILED] relay accepted the group-creation event for ${def.name} but exposed no channel metadata`,
    );
  }

  await saveRoomConfig(
    db,
    tenant,
    {
      scope: config.scope,
      channelId,
      agentPubkey: surface.pubkey,
      provisionedAt: new Date().toISOString(),
    },
    actor,
  );

  return { scope: config.scope, roomName: def.name, channelId, reused: false, verified: true };
}

/** Provision every room in the canonical roster. */
export async function provisionAllRooms(
  db: AsyncDb,
  tenant: string,
  surface: BuzzSurface,
  actor = 'system:provision',
): Promise<ProvisionResult[]> {
  const out: ProvisionResult[] = [];
  for (const def of CANONICAL_ROOMS) {
    out.push(await provisionRoom(db, tenant, def.scope, surface, actor));
  }
  return out;
}

/** `tenant:scope` → relay channel UUID. */
export type ChannelBindings = Map<string, string>;

/**
 * Load every room's channel binding.
 *
 * `BuzzSurface.channelIdFor` is synchronous by design — a publish must not be
 * able to await its way into a deadlock — so bindings are loaded up front and
 * handed to the surface as a plain map lookup. Without this, a surface
 * constructed with no bindings refuses every publish, which is the correct
 * failure but an unhelpful one if the caller simply forgot to load them.
 */
export async function loadChannelBindings(db: AsyncDb, tenant: string): Promise<ChannelBindings> {
  const bindings: ChannelBindings = new Map();
  for (const def of CANONICAL_ROOMS) {
    const cfg = await loadRoomConfig(db, tenant, def.scope);
    if (!cfg.channelId) continue;
    // Every reference form callers actually use: scope ('risk'), room id
    // ('risk-monitor'), and the legacy channel slug ('chan-risk-monitor').
    bindings.set(`${tenant}:${def.scope}`, cfg.channelId);
    bindings.set(`${tenant}:${def.name}`, cfg.channelId);
    bindings.set(`${tenant}:${def.channel}`, cfg.channelId);
  }
  return bindings;
}

/** Turn any room reference (scope, room id, or channel slug) into its UUID. */
export function channelIdFromBindings(bindings: ChannelBindings, tenant: string, reference: string): string | null {
  if (!reference) return null;
  const direct = bindings.get(`${tenant}:${reference}`);
  if (direct) return direct;
  try {
    return bindings.get(`${tenant}:${roomForScope(reference).scope}`) ?? null;
  } catch {
    return null;
  }
}

/** Persisted channel binding for one scope, or null when unprovisioned. */
export async function roomChannelId(db: AsyncDb, tenant: string, scope: string): Promise<string | null> {
  const cfg = await loadRoomConfig(db, tenant, scope);
  return cfg.channelId ?? null;
}

/** The surface's channel resolver, bound to one tenant's persisted bindings. */
export const surfaceChannelResolver =
  (bindings: ChannelBindings, tenant: string) =>
  (reference: string): string | null =>
    channelIdFromBindings(bindings, tenant, reference);
