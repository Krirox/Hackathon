import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';

/**
 * Wedge: Ship-to-Result, phases 2.1–2.3 minus the rooms (TODO §2).
 *
 * What lives here is the coordination half of the loop: turn release
 * OBSERVATIONs into an evidence-backed change summary, fan work out to four
 * teams as typed REQUESTs through the scheduler, and check human-facing
 * drafts against the Ledger before anyone publishes. Approval surfaces,
 * holdout lanes, and outcome measurement need rooms + pilots + calendar —
 * they are recorded in TODO, not faked here.
 */

export class WedgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[wedge:${code}] ${message}`);
  }
}

export interface ChangeItem {
  text: string;
  /** Every bullet cites its evidence — an uncited sentence is a bug. */
  claimIds: string[];
}

export interface ChangeSummary {
  release: string;
  whatChanged: ChangeItem[];
  affected: string[];
  whyItMatters: string;
  sources: { claimId: string; uri: string; tier: string }[];
  confidence: number;
  summaryFingerprint: string;
}

/**
 * Evidence-backed change summary (2.1). Deterministic assembly, not prose
 * generation: each bullet is built FROM cited claims, and any bullet whose
 * citations do not resolve to live claims is refused rather than softened.
 */
export async function summarizeRelease(
  ledger: Ledger,
  tenant: string,
  release: string,
  items: { text: string; claimIds: string[]; affected: string[] }[],
  now: string,
): Promise<ChangeSummary> {
  if (items.length === 0) throw new WedgeError('EMPTY_RELEASE', 'a release with no cited changes is not a summary');
  const whatChanged: ChangeItem[] = [];
  const affected = new Set<string>();
  const sources: ChangeSummary['sources'] = [];
  let confSum = 0;
  let confN = 0;
  for (const it of items) {
    if (it.claimIds.length === 0) {
      throw new WedgeError('UNCITED_SENTENCE', `change item cites nothing: "${it.text}"`);
    }
    const live = await ledger.contextFor(tenant, it.claimIds, now);
    const liveIds = new Set(live.map((c) => c.id));
    const missing = it.claimIds.filter((id) => !liveIds.has(id));
    if (missing.length > 0) {
      throw new WedgeError(
        'UNVERIFIABLE_CITATION',
        `"${it.text}" cites ${missing.join(', ')} — stale, disputed, provisional, or unknown`,
      );
    }
    whatChanged.push({ text: it.text, claimIds: it.claimIds });
    for (const c of live) {
      sources.push({ claimId: c.id, uri: c.provenance.sourceUri, tier: c.provenance.sourceTier });
      confSum += c.confidence;
      confN += 1;
      affected.add(c.scope);
    }
    for (const a of it.affected) affected.add(a);
  }
  const fp = `release:${release}:${whatChanged.map((w) => w.text).join('|')}`;
  return {
    release,
    whatChanged,
    affected: [...affected],
    whyItMatters: `${whatChanged.length} verified change(s) across ${affected.size} scope(s)`,
    sources,
    confidence: confN === 0 ? 0 : confSum / confN,
    summaryFingerprint: fp,
  };
}

/** Novelty check vs the Ledger: don't re-summarise a re-deploy. */
export async function isKnownRelease(db: AsyncDb, fingerprint: string): Promise<boolean> {
  const r = (await db.prepare('SELECT value FROM meta WHERE key = ?').get(`wedge:summary:${fingerprint}`)) as
    { value: string } | undefined;
  return !!r;
}

export async function markReleaseKnown(db: AsyncDb, fingerprint: string, summaryId: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`wedge:summary:${fingerprint}`, summaryId);
}

export interface FanOutResult {
  marketing: string;
  customer: string;
  sales: string;
  product: string;
  finance: string;
}

/**
 * Dedupe-hit legs are COMPLETED-with-result, never refusal (why this helper
 * exists: the coordinator answers an identical re-submission with
 * `admitted:false + dedupedTo`, and the old fan-out threw FANOUT_REFUSED on
 * exactly that path — so a retried release died on work that already
 * existed). A dedupe hit reuses the existing leg's id; only genuine denials
 * (budget, capacity, escalation cap — no `dedupedTo`) still refuse.
 */
export function reuseDedupedOrThrow(
  r: { admitted: boolean; state: string; reason: string; request: { id: string }; dedupedTo?: string },
  originScope: string,
  targetScope: string,
): string {
  if (r.admitted) return r.request.id;
  if (r.dedupedTo) return r.dedupedTo;
  throw new WedgeError('FANOUT_REFUSED', `${originScope}→${targetScope} ${r.state}: ${r.reason}`);
}

/**
 * Fan-out (2.2): one release → five typed coordination objects, ALL through
 * the scheduler. No direct channel posts exist as a code path.
 */
export async function fanOut(
  coord: Coordinator,
  tenant: string,
  input: {
    release: string;
    claimIds: string[];
    onBehalfOf: string;
    now: string;
    summary: string;
  },
): Promise<FanOutResult> {
  const req = async (
    originScope: string,
    targetScope: string,
    messageClass: 'REQUEST' | 'QUERY',
    goal: string,
    deliverableSchema: string,
    humanMinutes: number,
  ) => {
    const r = await coord.submit({
      tenant,
      messageClass,
      originScope,
      targetScope,
      goal,
      claimRefs: input.claimIds,
      deliverableSchema,
      bid: { humanMinutes },
      onBehalfOf: input.onBehalfOf,
      now: input.now,
    });
    // A retry re-submits identical legs: the coordinator dedupes them onto
    // the live thread, and that hit is reuse, not refusal (see above).
    return reuseDedupedOrThrow(r, originScope, targetScope);
  };
  const brief = `${input.release}: ${input.summary}`;
  return {
    marketing: await req(
      'product',
      'marketing',
      'REQUEST',
      `launch narrative + blog + in-app copy — ${brief}`,
      'launch-pack.v1',
      15,
    ),
    customer: await req(
      'product',
      'customer',
      'REQUEST',
      `support macro + FAQ + churn-risk segment — ${brief}`,
      'support-pack.v1',
      15,
    ),
    sales: await req('product', 'sales', 'REQUEST', `battlecard + objection handling — ${brief}`, 'battlecard.v1', 10),
    product: await req(
      'engineering',
      'product',
      'QUERY',
      `does this close a known pain pattern? — ${brief}`,
      'pain-link.v1',
      0,
    ),
    finance: await req(
      'product',
      'finance',
      'REQUEST',
      `budget headroom for paid launch — ${brief}`,
      'budget-check.v1',
      10,
    ),
  };
}

/** Regulated-claim denylist: these phrases force human review, always. */
const DENYLIST = [
  /\bguarantee[sd]?\b/i,
  /\b\d+%\s*(returns|profit|uptime|effective|cure)\b/i,
  /\b(fda|sec|hipaa|gdpr)\s*(approved|compliant|certified)\b/i,
  /\brisk-?free\b/i,
  /\bno\s+side\s+effects\b/i,
  /\bbest\s+in\s+(the\s+world|class)\b/i,
];

export interface DraftCheck {
  ok: boolean;
  /** Cited claims that are not VERIFIED/live — each one blocks. */
  unverified: string[];
  /** Denylist hits — each one forces a human. */
  deniedPhrases: string[];
}

/** Claims checker (2.3): drafts ship evidence or they do not ship. */
export async function checkDraft(
  ledger: Ledger,
  tenant: string,
  draft: { text: string; claimIds: string[] },
  now: string,
): Promise<DraftCheck> {
  const live = new Set((await ledger.contextFor(tenant, draft.claimIds, now)).map((c) => c.id));
  const unverified = draft.claimIds.filter((id) => !live.has(id));
  const deniedPhrases = DENYLIST.filter((re) => re.test(draft.text)).map((re) => String(re));
  return { ok: unverified.length === 0 && deniedPhrases.length === 0, unverified, deniedPhrases };
}
