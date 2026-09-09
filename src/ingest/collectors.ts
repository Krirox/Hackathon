import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { SourceTier } from '../core/types.ts';

/**
 * Phase 1 ingestion (TODO §1.2): read-only collectors, deterministic (L0).
 *
 *   poll() → RawEvent[]   idempotent, checkpointed (cursors in `meta`)
 *   ingestEvents()        maps events → OBSERVATION claims, never FACT
 *
 * No collector may write FACT directly — promotion from OBSERVATION is a
 * separate governed step (curation). Raw payloads land content-addressed in
 * `data/artifacts/<sha256>` so every `rawArtifactRef` resolves.
 */

export interface RawEvent {
  /** Stable source name, e.g. `github:1jehuang/jcode:releases`. */
  source: string;
  /** Canonical URI of the underlying occurrence. */
  uri: string;
  /** Content fingerprint — the idempotency key. */
  fingerprint: string;
  occurredAt: string;
  summary: string;
  payload: unknown;
}

export interface Collector {
  readonly name: string;
  /** Observation tier for this source. Ground tiers are refused at ingest. */
  readonly sourceTier: SourceTier;
  readonly extractor: string;
  readonly extractorVersion: string;
  /** Sync collectors return events; network collectors return a promise. */
  poll(db: AsyncDb, now: string): RawEvent[] | Promise<RawEvent[]>;
}

const GROUND_TIERS: readonly SourceTier[] = ['SYSTEM_OF_RECORD', 'MEASURED'];

const fingerprintOf = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function metaGet(db: AsyncDb, key: string): Promise<string | null> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(key)) as { value: string } | undefined;
  return r ? String(r.value) : null;
}

async function metaSet(db: AsyncDb, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Content-addressed raw-artifact store. `dir` defaults to `data/artifacts`. */
export function storeArtifact(db: AsyncDb, event: RawEvent, dir = join('data', 'artifacts')): string {
  mkdirSync(dir, { recursive: true });
  const ref = join(dir, event.fingerprint);
  try {
    statSync(ref);
  } catch {
    writeFileSync(ref, JSON.stringify({ uri: event.uri, occurredAt: event.occurredAt, payload: event.payload }));
  }
  void db;
  return event.fingerprint;
}

/**
 * Map raw events to OBSERVATION claims. Idempotent per fingerprint; ground
 * tiers refused; every claim carries its artifact ref.
 */
export async function ingestEvents(
  db: AsyncDb,
  ledger: Ledger,
  tenant: string,
  collector: Collector,
  events: RawEvent[],
  opts: { owner: string; scope: string; now: string; artifactDir?: string },
): Promise<string[]> {
  if ((GROUND_TIERS as readonly string[]).includes(collector.sourceTier)) {
    throw new Error(
      `[ingest:INGEST_TIER] collector "${collector.name}" declares ground tier ${collector.sourceTier} — collectors write OBSERVATION, promotion is governed`,
    );
  }
  const ids: string[] = [];
  for (const e of events) {
    if (await metaGet(db, `ingest:seen:${e.fingerprint}`)) continue;
    const ref = storeArtifact(db, e, opts.artifactDir);
    const c = await ledger.append({
      tenant,
      subject: e.source,
      kind: 'OBSERVATION',
      statement: e.summary,
      value: e.payload === undefined ? undefined : (e.payload as Record<string, unknown>),
      confidence: 1,
      owner: opts.owner,
      scope: opts.scope,
      authorType: 'system',
      observedAt: e.occurredAt,
      validFrom: e.occurredAt,
      now: opts.now,
      provenance: {
        sourceUri: e.uri,
        sourceTier: collector.sourceTier,
        extractor: collector.extractor,
        extractorVersion: collector.extractorVersion,
        retrievedAt: opts.now,
        rawArtifactRef: ref,
      },
    });
    await metaSet(db, `ingest:seen:${e.fingerprint}`, c.id);
    ids.push(c.id);
  }
  return ids;
}

/** Watches files for new/changed content. Checkpoint: path → hash in `meta`. */
export function fileDiffCollector(name: string, dir: string, sourceTier: SourceTier = 'SINGLE_SOURCE'): Collector {
  return {
    name,
    sourceTier,
    extractor: 'file-diff',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string): Promise<RawEvent[]> {
      let prev: Record<string, string>;
      try {
        prev = JSON.parse((await metaGet(db, `ingest:cursor:${name}`)) ?? '{}') as Record<string, string>;
      } catch {
        prev = {};
      }
      const next: Record<string, string> = {};
      const out: RawEvent[] = [];
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (!statSync(p).isFile()) continue;
        const body = readFileSync(p, 'utf8');
        const fp = fingerprintOf(body);
        next[p] = fp;
        if (prev[p] !== fp) {
          out.push({
            source: `${name}:${f}`,
            uri: `file://${p}`,
            fingerprint: fp,
            occurredAt: now,
            summary: `${f} ${prev[p] === undefined ? 'appeared' : 'changed'}`,
            payload: { bytes: body.length },
          });
        }
      }
      await metaSet(db, `ingest:cursor:${name}`, JSON.stringify(next));
      return out;
    },
  };
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  body: string | null;
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** GitHub releases + tags. `fetchFn` is injected so tests never hit network. */
export function gitHubReleasesCollector(
  owner: string,
  repo: string,
  fetchFn: FetchFn,
  sourceTier: SourceTier = 'PRIMARY',
): Collector {
  const name = `github:${owner}/${repo}:releases`;
  return {
    name,
    sourceTier,
    extractor: 'github-releases',
    extractorVersion: '1.0.0',
    async poll(db: AsyncDb, now: string): Promise<RawEvent[]> {
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`);
      if (!res.ok) throw new Error(`[ingest:GITHUB_FETCH] ${owner}/${repo} → ${res.status}`);
      const releases = (await res.json()) as GitHubRelease[];
      const cursor = Number((await metaGet(db, `ingest:cursor:${name}`)) ?? 0);
      let high = cursor;
      const out: RawEvent[] = [];
      for (const r of [...releases].reverse()) {
        if (r.id > cursor) {
          high = Math.max(high, r.id);
          const summary = `${owner}/${repo} ${r.tag_name}: ${r.name ?? 'untitled'}`;
          out.push({
            source: name,
            uri: r.html_url,
            fingerprint: fingerprintOf(`${r.id}:${r.tag_name}:${r.published_at ?? ''}`),
            occurredAt: r.published_at ?? now,
            summary,
            payload: { tag: r.tag_name, name: r.name, notes: (r.body ?? '').slice(0, 2000) },
          });
        }
      }
      await metaSet(db, `ingest:cursor:${name}`, String(high));
      return out;
    },
  };
}

/**
 * L1 novelty-vs-Ledger: a signal is novel only if no live claim already
 * says the same thing about the same subject. Retired, stale, and
 * superseded rows do not count — history is not news.
 */
export async function isNovel(ledger: Ledger, tenant: string, subject: string, statement: string): Promise<boolean> {
  return !(await ledger.bySubject(tenant, subject)).some((c) => c.statement === statement);
}

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
}

type SerperFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Serper.dev web search (TODO §6.2 L0). The API key is read at the runtime
 * boundary and travels in the request header only — it is never stored,
 * never logged, never written to the Ledger. `fetchFn` injected: tests
 * stub the network, production passes global fetch.
 */
export function serperSearchCollector(
  query: string,
  opts: { apiKey: string; fetchFn: SerperFetch; num?: number; sourceTier?: SourceTier },
): Collector {
  const name = `serper:${fingerprintOf(query).slice(0, 12)}`;
  return {
    name,
    sourceTier: opts.sourceTier ?? 'SINGLE_SOURCE',
    extractor: 'serper-search',
    extractorVersion: '1.0.0',
    async poll(_db: AsyncDb, now: string): Promise<RawEvent[]> {
      if (!opts.apiKey)
        throw new Error('[ingest:SERPER_KEY] Serper API key missing — set SERPER_API_KEY, never hardcode it');
      const res = await opts.fetchFn('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: opts.num ?? 10 }),
      });
      if (!res.ok) throw new Error(`[ingest:SERPER_FETCH] "${query}" → ${res.status}`);
      const body = (await res.json()) as { organic?: SerperResult[] };
      return (body.organic ?? []).map((r) => ({
        source: name,
        uri: r.link,
        fingerprint: fingerprintOf(`${r.link}:${r.title}`),
        occurredAt: now,
        summary: `${r.title} — ${(r.snippet ?? '').slice(0, 300)}`,
        payload: { title: r.title, snippet: r.snippet ?? '', date: r.date ?? null, query },
      }));
    },
  };
}
