import { deriveNostrKeypair, generateNostrKeypair, type NostrKeypair } from './nostr.ts';

/**
 * Where room agent identities come from.
 *
 * The previous implementation derived a "pubkey" as `sha256("vital:agent:<name>")`
 * and signed with `sha256(pubkey + id)`. Both are public functions of public
 * data, so anyone reading the source could impersonate any room agent, and no
 * Buzz relay would accept the signature anyway.
 *
 * The rules here are deliberately fail-closed:
 *
 * - `BUZZ_AGENT_MASTER_KEY` set (hex, >=16 bytes): every room agent identity is
 *   derived from it with HKDF. One secret to rotate, no keys in source, and
 *   provisioning is idempotent because derivation is deterministic.
 * - `BUZZ_ALLOW_DEV_KEYS=1`: an explicitly-opted-in local/dev identity derived
 *   from a fixed, loudly-labelled development secret. Never valid in
 *   production, and only reachable when the operator asks for it.
 * - Otherwise: `NO_AGENT_KEY`. Callers must degrade to "Buzz not configured"
 *   rather than publishing as a fake agent.
 */

export class AgentKeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[agent-key:${code}] ${message}`);
  }
}

/** A fixed, non-secret development secret. Obvious on purpose. */
const DEV_MASTER_SECRET = 'vital-dev-only-master-secret-not-for-production-00';

export type AgentKeySource = 'master-key' | 'dev-key';

export interface AgentKeyResolution {
  readonly source: AgentKeySource;
  /** Human-readable provenance for the console/CLI. Never includes key material. */
  readonly detail: string;
}

function masterSecret(): string | null {
  const raw = (process.env.BUZZ_AGENT_MASTER_KEY ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0 || raw.length < 32) {
    throw new AgentKeyError('BAD_MASTER_KEY', 'BUZZ_AGENT_MASTER_KEY must be hex and at least 16 bytes (32 hex chars)');
  }
  return raw;
}

const devKeysAllowed = (): boolean => process.env.BUZZ_ALLOW_DEV_KEYS === '1';

/** Which source agent keys resolve from, or null when Buzz cannot sign. */
export function agentKeyResolution(): AgentKeyResolution | null {
  if (masterSecret()) {
    return { source: 'master-key', detail: 'derived from BUZZ_AGENT_MASTER_KEY' };
  }
  if (devKeysAllowed()) {
    return { source: 'dev-key', detail: 'development keys (BUZZ_ALLOW_DEV_KEYS=1) — never production' };
  }
  return null;
}

/**
 * Resolve the Nostr identity an operator has configured for publishing.
 * `label` scopes derivation so keys are never reused across purposes.
 */
export function resolveAgentKey(label: string): { keypair: NostrKeypair; resolution: AgentKeyResolution } {
  const master = masterSecret();
  if (master) {
    return {
      keypair: deriveNostrKeypair(master, label),
      resolution: { source: 'master-key', detail: 'derived from BUZZ_AGENT_MASTER_KEY' },
    };
  }
  if (devKeysAllowed()) {
    return {
      keypair: deriveNostrKeypair(DEV_MASTER_SECRET, label),
      resolution: { source: 'dev-key', detail: 'development keys (BUZZ_ALLOW_DEV_KEYS=1) — never production' },
    };
  }
  throw new AgentKeyError(
    'NO_AGENT_KEY',
    'no Buzz agent key configured: set BUZZ_AGENT_MASTER_KEY (hex, >=16 bytes) or BUZZ_ALLOW_DEV_KEYS=1 for local development',
  );
}

/**
 * The relay operator's key. Distinct from room agent keys: it is the identity
 * that owns the relay/community, and it must not be derived per-room.
 */
export function resolveRelayKey(): NostrKeypair | null {
  const raw = (process.env.BUZZ_RELAY_PRIVATE_KEY ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]+$/.test(raw) || raw.length !== 64) {
    throw new AgentKeyError('BAD_RELAY_KEY', 'BUZZ_RELAY_PRIVATE_KEY must be 32 bytes of hex (64 hex chars)');
  }
  return deriveNostrKeypair(raw, 'relay-owner');
}

/** A freshly generated operator identity, for first-run key generation. */
export function generateAgentKey(): NostrKeypair {
  return generateNostrKeypair();
}
