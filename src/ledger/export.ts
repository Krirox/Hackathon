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
  const all = async <R>(sql: string, ...args: unknown[]): Promise<R[]> => (await db.prepare(sql).all(...args)) as R[];
  const claimIds = new Set(
    (await all<{ id: string }>('SELECT id FROM claims WHERE tenant = ?', tenant)).map((r) => r.id),
  );
  const links = await all<ClaimLinkRow>(
    `SELECT l.from_id, l.to_id, l.link FROM claim_links l
      WHERE EXISTS (SELECT 1 FROM claims c WHERE c.id = l.from_id AND c.tenant = ?)`,
    tenant,
  );
  return {
    version: 1,
    tenant,
    exportedAt: at,
    claims: await all<ClaimRow>('SELECT * FROM claims WHERE tenant = ? ORDER BY seq', tenant),
    claimLinks: links.filter((l) => claimIds.has(String(l.to_id))),
    decisions: await all<DecisionRow>('SELECT * FROM decisions WHERE tenant = ? ORDER BY signed_at', tenant),
    outcomes: await all<OutcomeRow>('SELECT * FROM outcomes WHERE tenant = ? ORDER BY created_at', tenant),
    audit: await all<AuditLogRow>('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq', tenant),
  };
}
