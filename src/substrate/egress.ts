/**
 * Substrate, part 3 (TODO §0.5): egress policy core.
 *
 * This is the design copied from QM (`resolution/egress-policy.ts` +
 * `egress-authz-main.ts` + `auth/capability-token.ts`), implemented in ours:
 * capability-scoped allow/deny, SSRF + cloud-metadata blocking, and an
 * audit trail. The packet-filtering proxy itself is deployment work; THIS
 * is the decision function it (and every harness adapter) calls, so the
 * blocklist is enforced in exactly one place.
 *
 * Hard rules, copied including the values: 169.254.0.0/16 is never a
 * destination; metadata.goog / metadata.google.internal are never
 * destinations; denied hosts always win; an empty allowlist denies
 * everything (fail closed).
 */

export interface EgressPolicy {
  allowedHosts: string[];
  deniedHosts: string[];
}

export type EgressVerdict = 'allow' | 'deny';

export interface EgressDecision {
  verdict: EgressVerdict;
  reason: string;
}

const METADATA_HOSTS = new Set(['metadata.goog', 'metadata.google.internal', 'metadata.google.com']);

/** AWS EC2 IPv6 metadata endpoint. Never a destination. */
const EC2_METADATA_IPV6 = 'fd00:ec2::254';

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === EC2_METADATA_IPV6) return true;
  // fe80::/10 link-local (covers fe80–febf).
  const first = h.split(':')[0] ?? '';
  return /^fe[89ab][0-9a-f]*$/.test(first);
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function in169254(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return a === 169 && b === 254;
}

/** Exact match or `*.suffix` wildcard, case-insensitive. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p.startsWith('*.')) return h !== p.slice(2) && h.endsWith(p.slice(1));
  return h === p;
}

export function decideEgress(host: string, policy: EgressPolicy): EgressDecision {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(h)) {
    return { verdict: 'deny', reason: `cloud metadata host "${host}" is never a destination` };
  }
  if (isIpv4(h) && in169254(h)) {
    return { verdict: 'deny', reason: `link-local ${host} (169.254.0.0/16) is never a destination` };
  }
  if (h.includes(':') && isBlockedIpv6(h)) {
    return { verdict: 'deny', reason: `link-local/metadata IPv6 ${host} is never a destination` };
  }
  for (const d of policy.deniedHosts) {
    if (hostMatches(h, d)) return { verdict: 'deny', reason: `"${host}" matches denied host "${d}"` };
  }
  for (const a of policy.allowedHosts) {
    if (hostMatches(h, a)) return { verdict: 'allow', reason: `"${host}" matches allowed host "${a}"` };
  }
  return { verdict: 'deny', reason: `"${host}" matches no allowed host — fail closed` };
}
