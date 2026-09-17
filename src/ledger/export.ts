import type { AsyncDb } from '../core/db.ts';
import type { AuditLogRow, ClaimLinkRow, ClaimRow, DecisionRow, OutcomeRow } from '../core/rows.ts';

/**
 * Data portability (TODO §8): the full Ledger export. Lock-in by value,
 * not by hostage-taking — and a sales asset against the black-box
 * objection. One JSON document: claims (with links), decisions (with
 * Context Bundles), outcomes, and the audit trail. Import is
 * intentionally absent: history is append-only, and merging two histories
 * is a research problem, not a file format.
 */

export interface LedgerExport {
  version: 1;
  tenant: string;
  exportedAt: string;
  claims: ClaimRow[];
  claimLinks: ClaimLinkRow[];
  decisions: DecisionRow[];
  outcomes: OutcomeRow[];
  audit: AuditLogRow[];
}

export async function exportLedger(db: AsyncDb, tenant: string, now?: string): Promise<LedgerExport> {
  const at = now ?? new Date().toISOString();
  // Bounded batches: each roundtrip carries at most EXPORT_BATCH rows, so
  // the per-query working set never grows with history. The accumulated
  // output is the export itself (unavoidable); what stays bounded is the
  // database read shape — paginated LIMIT/OFFSET with stable ORDER BY.
  const EXPORT_BATCH = 500;
  const page = async <R>(sql: string, offset: number): Promise<R[]> =>
    (await db.prepare(`${sql} LIMIT ? OFFSET ?`).all(tenant, EXPORT_BATCH, offset)) as R[];
  const pageAll = async <R>(sql: string): Promise<R[]> => {
    const out: R[] = [];
    for (let offset = 0; ; offset += EXPORT_BATCH) {
      const rows = await page<R>(sql, offset);
      out.push(...rows);
      if (rows.length < EXPORT_BATCH) break;
    }
    return out;
  };
  const claimIds = new Set(
    (await pageAll<{ id: string }>('SELECT id FROM claims WHERE tenant = ? ORDER BY seq')).map((r) => String(r.id)),
  );
  const links = await pageAll<ClaimLinkRow>(
    `SELECT l.from_id, l.to_id, l.link FROM claim_links l
      WHERE EXISTS (SELECT 1 FROM claims c WHERE c.id = l.from_id AND c.tenant = ?)
      ORDER BY l.from_id, l.to_id, l.link`,
  );
  return {
    version: 1,
    tenant,
    exportedAt: at,
    claims: await pageAll<ClaimRow>('SELECT * FROM claims WHERE tenant = ? ORDER BY seq'),
    claimLinks: links.filter((l) => claimIds.has(String(l.to_id))),
    decisions: await pageAll<DecisionRow>('SELECT * FROM decisions WHERE tenant = ? ORDER BY signed_at'),
    outcomes: await pageAll<OutcomeRow>('SELECT * FROM outcomes WHERE tenant = ? ORDER BY created_at'),
    audit: await pageAll<AuditLogRow>('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq'),
  };
}
