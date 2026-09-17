import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Substrate, part 2 (TODO §0.5): scoped sandboxes, rebuildable from a manifest.
 *
 * Persistence must never be trust-bearing: a durable sandbox is a cache, and
 * a cache you cannot rebuild is a foothold. Every scope gets a directory; the
 * manifest (path → sha256) is the ground truth. Verify before trusting;
 * rebuild by writing exactly the manifested files and nothing else.
 */

export class SandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[sandbox:${code}] ${message}`);
  }
}

export interface ManifestEntry {
  path: string;
  sha256: string;
}

export interface Manifest {
  version: 1;
  scope: string;
  files: ManifestEntry[];
}

const hashOf = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function assertSafePath(path: string): void {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new SandboxError('UNSAFE_PATH', `manifest path escapes the scope: "${path}"`);
  }
}

export function scopeDir(root: string, scope: string): string {
  if (!scope || scope.includes('/') || scope.includes('..') || scope.includes('\\')) {
    throw new SandboxError('BAD_SCOPE', `invalid scope "${scope}"`);
  }
  return join(root, scope);
}

export function buildManifest(scope: string, files: Record<string, string>): Manifest {
  const entries = Object.entries(files).map(([path, content]) => {
    assertSafePath(path);
    return { path, sha256: hashOf(content) };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { version: 1, scope, files: entries };
}

/**
 * Total bytes currently occupied by a scope's sandbox.
 *
 * This is the measurement that makes the disk budget real. `maxDiskBytes`
 * on a bid enforces nothing unless someone reports the high-water mark, and
 * disk is the one resource that can take down an always-reachable tenant
 * without spending a single token.
 */
export function scopeBytes(root: string, scope: string): number {
  const dir = scopeDir(root, scope);
  let total = 0;
  for (const rel of walk(dir)) {
    try {
      total += statSync(join(dir, rel)).size;
    } catch {
      continue;
    }
  }
  return total;
}

/** Write exactly the manifested files (and nothing else) into the scope dir. */
export function rebuildSandbox(root: string, manifest: Manifest, contents: Record<string, string>): void {
  const dir = scopeDir(root, manifest.scope);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of manifest.files) {
    const content = contents[entry.path];
    if (content === undefined)
      throw new SandboxError('MISSING_CONTENT', `no content supplied for manifested file "${entry.path}"`);
    if (hashOf(content) !== entry.sha256) {
      throw new SandboxError('MANIFEST_MISMATCH', `supplied content for "${entry.path}" does not match the manifest`);
    }
    const full = join(dir, entry.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export interface VerifyResult {
  ok: boolean;
  tampered: string[];
  missing: string[];
  /** Files on disk that the manifest does not authorize. */
  extra: string[];
  /** Total bytes on disk in the scope, manifest-authorized or not. */
  bytesOnDisk: number;
}

function walk(dir: string, base = ''): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const rel = base ? `${base}/${name}` : name;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

/** Verify a live scope dir against its manifest. Never trust, always check. */
export function verifySandbox(root: string, manifest: Manifest): VerifyResult {
  const dir = scopeDir(root, manifest.scope);
  const tampered: string[] = [];
  const missing: string[] = [];
  const manifested = new Set(manifest.files.map((f) => f.path));
  for (const entry of manifest.files) {
    let body: Buffer;
    try {
      body = readFileSync(join(dir, entry.path));
    } catch {
      missing.push(entry.path);
      continue;
    }
    if (hashOf(body) !== entry.sha256) tampered.push(entry.path);
  }
  // Extra files are the failure mode that actually bites: an agent that writes
  // logs, clones a repo, or drops a payload stays "ok" under a manifest-only
  // check while it fills the disk. The manifest is an allow-list, so anything
  // outside it is unauthorized by definition.
  const extra: string[] = [];
  let bytesOnDisk = 0;
  for (const rel of walk(dir)) {
    let size: number;
    try {
      size = statSync(join(dir, rel)).size;
    } catch {
      continue;
    }
    bytesOnDisk += size;
    if (!manifested.has(rel)) extra.push(rel);
  }
  extra.sort();
  return {
    ok: tampered.length === 0 && missing.length === 0 && extra.length === 0,
    tampered,
    missing,
    extra,
    bytesOnDisk,
  };
}
