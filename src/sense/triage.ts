import type { ModelProfile } from '../substrate/models.ts';
import { approvedCompleteChat } from '../substrate/models.ts';

/**
 * L1 triage (TODO §6.2): dedup is structural (fingerprints), novelty is a
 * query (`isNovel`) — this is the remaining small-model step: classify the
 * signal and resolve entity references. The model function is injected, so
 * tests stub it and production passes a lane client; a model that fails or
 * answers unparseably degrades to UNSPECIFIED, never to a confident wrong
 * label. Classification informs routing, it never asserts truth.
 */

export class TriageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[triage:${code}] ${message}`);
  }
}

export interface TriageSignal {
  summary: string;
  uri: string;
}

export interface TriageVerdict {
  category: 'pricing' | 'launch' | 'repo' | 'mention' | 'UNSPECIFIED';
  entities: string[];
  confidence: number;
}

export type ModelFn = (
  profile: ModelProfile,
  apiKey: string,
  messages: { role: 'system' | 'user' | 'assistant'; text: string }[],
) => Promise<{ text: string }>;

const TRIAGE_SYSTEM = [
  'Classify the signal for a company watch contract.',
  'Reply with EXACTLY one line of JSON: {"category": "pricing"|"launch"|"repo"|"mention", "entities": [lowercase names], "confidence": 0.0-1.0}.',
  'Entities are company/product names mentioned. No prose, no markdown.',
].join(' ');

const CATEGORIES = ['pricing', 'launch', 'repo', 'mention'] as const;

export async function triageSignal(
  profile: ModelProfile,
  apiKey: string,
  signal: TriageSignal,
  modelFn: ModelFn,
): Promise<TriageVerdict> {
  if (!signal.summary.trim()) throw new TriageError('EMPTY_SIGNAL', 'triage classifies a signal, not silence');
  let raw: string;
  try {
    const out = await modelFn(profile, apiKey, [
      { role: 'system', text: TRIAGE_SYSTEM },
      { role: 'user', text: `${signal.summary}\n${signal.uri}` },
    ]);
    raw = out.text;
  } catch {
    return { category: 'UNSPECIFIED', entities: [], confidence: 0 };
  }
  const match = raw.match(/\{[^{}]*\}/);
  if (!match) return { category: 'UNSPECIFIED', entities: [], confidence: 0 };
  let parsed: { category?: unknown; entities?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { category?: unknown; entities?: unknown; confidence?: unknown };
  } catch {
    return { category: 'UNSPECIFIED', entities: [], confidence: 0 };
  }
  const category = (CATEGORIES as readonly string[]).includes(String(parsed.category))
    ? (parsed.category as TriageVerdict['category'])
    : 'UNSPECIFIED';
  const entities = Array.isArray(parsed.entities)
    ? parsed.entities.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase())
    : [];
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  if (category === 'UNSPECIFIED') return { category, entities: [], confidence: 0 };
  return { category, entities, confidence };
}

/** Default model function: the lane client. Wire once, use everywhere.
 *  Passing `lane` enforces the approved-model registry before any network
 *  call — an unapproved model string can never reach the wire through this
 *  factory regardless of how the profile was constructed. */
export function laneModelFn(
  lane: string,
  fetchFn: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>,
): ModelFn {
  return (profile, apiKey, messages) =>
    approvedCompleteChat(lane, profile, apiKey, messages, fetchFn).then((r) => ({ text: r.text }));
}
