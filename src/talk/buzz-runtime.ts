import type { AsyncDb } from '../core/db.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { createBuzzSurface, type BuzzSurface, type BuzzAuthMode } from './buzz.ts';
import { agentKeyResolution } from './agent-keys.ts';
import { loadChannelBindings } from './provision.ts';

/**
 * Runtime surface construction from the environment.
 *
 * This is the single place that decides whether Buzz is live for a process:
 * - No `BUZZ_RELAY_URL`, or no key material configured → `null`. Callers must
 *   degrade to local telemetry, never to a fake publisher.
 * - Both set → a real signed surface with the tenant's persisted channel
 *   bindings, so publishes land in the right relay channel UUIDs.
 */

export interface BuzzRuntimeStatus {
  configured: boolean;
  relayUrl: string | null;
  authMode: BuzzAuthMode | null;
  agentPubkey: string | null;
  keySource: 'master-key' | 'dev-key' | null;
  missing: string[];
}

/** Why Buzz is or is not live — for the console roster and CLI diagnostics. */
export function buzzRuntimeStatus(): BuzzRuntimeStatus {
  const relayUrl = (process.env.BUZZ_RELAY_URL ?? '').trim() || null;
  const resolution = agentKeyResolution();
  const missing: string[] = [];
  if (!relayUrl) missing.push('BUZZ_RELAY_URL');
  if (!resolution) missing.push('BUZZ_AGENT_MASTER_KEY (or BUZZ_ALLOW_DEV_KEYS=1 for local dev)');
  return {
    configured: missing.length === 0,
    relayUrl,
    authMode: relayUrl ? 'nip98' : null,
    agentPubkey: null,
    keySource: resolution?.source ?? null,
    missing,
  };
}

/**
 * Build a live surface for a tenant, or null when Buzz is not configured.
 *
 * Channel bindings come from the room config the provisioning wizard writes;
 * without a binding for a room, publishes into it fail loudly with
 * `CHANNEL_NOT_PROVISIONED` instead of vanishing into a wrong channel.
 */
export async function maybeBuzzSurface(db: AsyncDb, tenant: string): Promise<BuzzSurface | null> {
  const status = buzzRuntimeStatus();
  if (!status.configured || !status.relayUrl) return null;
  const { resolveAgentKey } = await import('./agent-keys.ts');
  const { keypair } = resolveAgentKey('workspace-agent');
  const bindings = await loadChannelBindings(db, tenant);
  return createBuzzSurface({
    relayUrl: status.relayUrl,
    keypair,
    authMode: 'nip98',
    fetchFn: (url, init) =>
      // GET/HEAD must not carry a body (the fetch spec forbids it); the surface
      // only sends a body on POST /events and POST /query.
      init.method === 'GET' || init.method === 'HEAD'
        ? fetch(url, { method: init.method, headers: init.headers })
        : fetch(url, init),
    channelIdFor: (reference) => bindings.get(`${tenant}:${reference}`) ?? null,
  });
}

/**
 * The Buzz option for `ApplicationWorkerOptions`: a live surface plus the
 * request→room router the dispatch loop calls after each run. Returns null
 * when Buzz is not configured — the worker then runs exactly as before.
 */
export async function workerBuzzSurface(
  db: AsyncDb,
  tenant: string,
): Promise<{
  surface: BuzzSurface;
  channelFor(requestId: string, request?: CoordinationRequest): { channel: string; threadRoot?: string } | null;
} | null> {
  const surface = await maybeBuzzSurface(db, tenant);
  if (!surface) return null;
  return {
    surface,
    channelFor: (_requestId, request) => {
      const scope = request?.targetScope ?? request?.originScope;
      if (!scope) return null;
      // Returning the scope lets the surface resolve the channel UUID (and
      // refuse loudly when the room was never provisioned).
      return { channel: scope };
    },
  };
}
