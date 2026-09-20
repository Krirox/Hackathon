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
 *
 * Hardened beyond the QM copy: IP literals in decimal/octal/hex are
 * normalized before matching (so `2852039166` cannot dodge the 169.254
 * block); loopback, RFC1918 and unspecified addresses are denied; DNS
 * resolution is checked by `resolveAndDecideEgress` so an allowlisted
 * hostname that resolves (or rebinds) to an internal address is refused.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

export interface EgressPolicy {
  allowedHosts: string[];
  deniedHosts: string[];
}

export type EgressVerdict = 'allow' | 'deny';

export interface EgressDecision {
  verdict: EgressVerdict;
  reason: string;
  /**
   * TOCTOU-safe dial target: the literal itself, or the first resolved
   * address for a hostname. Dial THIS, not the hostname, so a rebinding
   * between check and dial cannot redirect the connection. Absent on deny.
   */
  dialHost?: string;
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

/**
 * IPv6 addresses that are never dialable, no matter the allowlist:
 * loopback, link-local, unique-local, IPv4-mapped (checked against the
 * embedded v4 address separately), and the EC2 metadata endpoint.
 */
function isAbsoluteDenyIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '::1' || h === '::') return true;
  if (h === EC2_METADATA_IPV6) return true;
  const first = h.split(':')[0] ?? '';
  // fe80::/10 link-local; fc00::/7 unique-local.
  if (/^fe[89ab][0-9a-f]*$/.test(first)) return true;
  if (/^f[c-d][0-9a-f]{2}$/.test(first)) return true;
  return false;
}

/** Split an embedded IPv4 tail (e.g. `::ffff:1.2.3.4`) for v4 range checks. */
function embeddedIpv4(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return m ? m[1]! : null;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Normalize an IPv4 literal to dotted decimal, defeating the classic
 * bypasses: decimal uint32 (`2852039166`), octal (`0251.0376.0524.0376`)
 * and hex (`0xa9.0xfe.0xa9.0xfe`) forms. Returns null when the input is
 * not an IP literal at all, or when a part overflows its base.
 */
export function normalizeIpv4Literal(host: string): string | null {
  const h = host.trim();
  if (/^\d+$/.test(h)) {
    // Bare decimal uint32.
    let n: number;
    try {
      n = Number(h);
    } catch {
      return null;
    }
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [24, 16, 8, 0].map((s) => String((Math.floor(n / 2 ** s) % 256 + 256) % 256)).join('.');
  }
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0[xX][0-9a-fA-F]+|0[0-7]*|[0-9]+)$/.test(p)) return null;
    let radix = 10;
    if (p.startsWith('0x') || p.startsWith('0X')) radix = 16;
    else if (p.startsWith('0') && p.length > 1) radix = 8;
    const v = parseInt(p, radix);
    if (!Number.isSafeInteger(v) || v < 0 || v > 255 || Number.isNaN(v)) return null;
    out.push(v);
  }
  return out.join('.');
}

function octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/**
 * IPv4 ranges that are never dialable without an explicit allowlist entry:
 * loopback (127/8), private use (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16) and unspecified (0/8). Metadata-adjacent link-local is
 * absolute-deny elsewhere; here it shares the overridable bucket because a
 * test double occasionally needs it — the override still requires an exact
 * allowlist entry, never a wildcard.
 */
function isPrivateIpv4(ip: string): boolean {
  const o = octets(ip);
  if (!o) return false;
  const [a, b] = o;
  return (
    a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
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

/** Exact (non-wildcard) allowlist match — the only override a private address accepts. */
function explicitlyAllowlisted(host: string, policy: EgressPolicy): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return policy.allowedHosts.some((a) => {
    const p = a.toLowerCase().replace(/\.$/, '');
    return !p.startsWith('*.') && !p.includes('*') && p === h;
  });
}

function deniedByList(host: string, policy: EgressPolicy): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const d of policy.deniedHosts) {
    if (hostMatches(h, d)) return d;
  }
  return null;
}

export function decideEgress(host: string, policy: EgressPolicy): EgressDecision {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(h)) {
    return { verdict: 'deny', reason: `cloud metadata host "${host}" is never a destination` };
  }
  // IPv6 literals: absolute deny, no allowlist override.
  if (h.includes(':')) {
    const embedded = embeddedIpv4(h);
    if (embedded && isPrivateIpv4(embedded)) {
      return { verdict: 'deny', reason: `IPv4-mapped private address ${host} is never a destination` };
    }
    if (isAbsoluteDenyIpv6(h) || isBlockedIpv6(h)) {
      return { verdict: 'deny', reason: `link-local/metadata IPv6 ${host} is never a destination` };
    }
  }
  // IPv4 literals in any notation: normalize first, then range-check.
  const literal = normalizeIpv4Literal(h) ?? (isIpv4(h) ? h : null);
  if (literal) {
    if (in169254(literal)) {
      return { verdict: 'deny', reason: `link-local ${host} (169.254.0.0/16) is never a destination` };
    }
    if (isPrivateIpv4(literal)) {
      // Loopback and RFC1918 are denied by default, but an EXACT allowlist
      // entry re-opens them (local test doubles, sidecars). Wildcards never
      // open them, denied entries still win, and link-local/metadata above
      // never reach this branch.
      const denied = deniedByList(h, policy);
      if (denied) return { verdict: 'deny', reason: `"${host}" matches denied host "${denied}"` };
      if (explicitlyAllowlisted(h, policy)) {
        return {
          verdict: 'allow',
          reason: `"${host}" is an explicitly allowlisted private address`,
          dialHost: literal,
        };
      }
      return { verdict: 'deny', reason: `private address ${host} is not explicitly allowlisted` };
    }
  }
  const denied = deniedByList(h, policy);
  if (denied) return { verdict: 'deny', reason: `"${host}" matches denied host "${denied}"` };
  for (const a of policy.allowedHosts) {
    if (hostMatches(h, a)) {
      const decision: EgressDecision = { verdict: 'allow', reason: `"${host}" matches allowed host "${a}"` };
      const literal = normalizeIpv4Literal(h) ?? (isIpv4(h) ? h : null);
      if (literal) decision.dialHost = literal;
      else if (h.includes(':')) decision.dialHost = h;
      return decision;
    }
  }
  return { verdict: 'deny', reason: `"${host}" matches no allowed host: fail closed` };
}

export type DnsLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookup = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/**
 * DNS-aware egress decision. Hostnames are resolved and EVERY resolved
 * address is range-checked, closing the rebinding hole where an allowlisted
 * hostname flips to an internal IP after the check. Resolution failure
 * denies (fail closed). IP literals skip DNS and use decideEgress directly.
 */
export async function resolveAndDecideEgress(
  host: string,
  policy: EgressPolicy,
  lookup: DnsLookup = defaultLookup,
): Promise<EgressDecision> {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(h) || normalizeIpv4Literal(h) !== null || isIpv4(h) || h.includes(':')) {
    return decideEgress(host, policy);
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(h);
  } catch {
    return { verdict: 'deny', reason: `DNS resolution failed for "${host}": fail closed` };
  }
  if (addrs.length === 0) {
    return { verdict: 'deny', reason: `DNS returned no addresses for "${host}": fail closed` };
  }
  // Classify every resolved address first: a MIXED set (some public, some
  // private) is DNS rebinding in progress and always denies, no matter the
  // allowlist. An all-private set is a local name and needs an exact
  // allowlist entry; an all-public set follows the normal hostname decision.
  let privateCount = 0;
  let publicCount = 0;
  for (const addr of addrs) {
    const ip = addr.address.toLowerCase();
    // Absolute-deny ranges can never be reached through a hostname.
    if (ip.includes(':')) {
      const embedded = embeddedIpv4(ip);
      if ((embedded && isPrivateIpv4(embedded)) || isAbsoluteDenyIpv6(ip) || isBlockedIpv6(ip)) {
        return { verdict: 'deny', reason: `"${host}" resolves to blocked IPv6 ${addr.address}` };
      }
      publicCount += 1;
      continue;
    }
    const normalized = normalizeIpv4Literal(ip) ?? (isIpv4(ip) ? ip : null);
    if (!normalized || in169254(normalized)) {
      return { verdict: 'deny', reason: `"${host}" resolves to unroutable ${addr.address}` };
    }
    if (isPrivateIpv4(normalized)) privateCount += 1;
    else publicCount += 1;
  }
  if (privateCount > 0 && publicCount > 0) {
    return { verdict: 'deny', reason: `"${host}" resolves to mixed public/private addresses (DNS rebinding): refused` };
  }
  if (privateCount > 0) {
    const denied = deniedByList(h, policy);
    if (denied) return { verdict: 'deny', reason: `"${host}" matches denied host "${denied}"` };
    if (!explicitlyAllowlisted(h, policy)) {
      return { verdict: 'deny', reason: `"${host}" resolves private without an exact allowlist entry` };
    }
  }
  const decision = decideEgress(host, policy);
  if (decision.verdict === 'allow' && !decision.dialHost) {
    // Pin the dial to the resolved address: a rebind between check and
    // connect cannot redirect the connection elsewhere.
    decision.dialHost = addrs[0]!.address;
  }
  return decision;
}
