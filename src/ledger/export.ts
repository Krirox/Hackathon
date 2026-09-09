import type { AsyncDb } from '../core/db.ts';

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
  claims: Record<string, unknown>[];
  claimLinks: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

export async function exportLedger(db: AsyncDb, tenant: string, now?: string): Promise<LedgerExport> {
  const at = now ?? new Date().toISOString();
  const all = async (sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]> =>
    (await db.prepare(sql).all(...args)) as Record<string, unknown>[];
  const claimIds = new Set((await all('SELECT id FROM claims WHERE tenant = ?', tenant)).map((r) => String(r.id)));
  const links = await all(
    `SELECT l.from_id, l.to_id, l.link FROM claim_links l
      WHERE EXISTS (SELECT 1 FROM claims c WHERE c.id = l.from_id AND c.tenant = ?)`,
    tenant,
  );
  return {
    version: 1,
    tenant,
    exportedAt: at,
    claims: await all('SELECT * FROM claims WHERE tenant = ? ORDER BY seq', tenant),
    claimLinks: links.filter((l) => claimIds.has(String(l.to_id))),
    decisions: await all('SELECT * FROM decisions WHERE tenant = ? ORDER BY signed_at', tenant),
    outcomes: await all('SELECT * FROM outcomes WHERE tenant = ? ORDER BY created_at', tenant),
    audit: await all('SELECT * FROM audit_log WHERE tenant = ? ORDER BY seq', tenant),
  };
}
