import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { T, eq, throws, fresh } from './helpers.ts';
import {
  TENANT_TABLES,
  assertTenantScoped,
  forTenant,
  sqlIsTenantScoped,
  tenantTableInSql,
  TenantScopeError,
} from '../src/core/tenant.ts';

console.log('\n\x1b[1mTenant scope — the structural half of multi-tenancy\x1b[0m');

// ---------------------------------------------------------------- unit: policy

T('a tenant-table statement without a tenant predicate is refused', () => {
  // The predicate IS the guarantee: without it the query returns someone else's
  // rows silently, so this must throw rather than warn.
  throws(
    () => assertTenantScoped('SELECT id FROM requests WHERE state = ?'),
    'UNSCOPED',
  );
  throws(
    () => assertTenantScoped('UPDATE issues SET state = ? WHERE id = ?'),
    'UNSCOPED',
  );
  // With the predicate it passes, in either spelling.
  assertTenantScoped('SELECT id FROM requests WHERE tenant = ? AND state = ?');
  assertTenantScoped('SELECT id FROM requests WHERE state = ? AND tenant = ?');
});

T('non-tenant tables are not flagged, so the guard stays trustworthy', () => {
  // Global bookkeeping: no tenant column exists to filter on.
  assertTenantScoped('SELECT value FROM meta WHERE key = ?');
  assertTenantScoped('SELECT name FROM schema_migrations');
  assertTenantScoped('SELECT slug FROM tenants WHERE slug = ?');
  // Identity is addressed by token/email at the boundary, then checked against
  // the session's tenant — requiring the column here would flag real code.
  assertTenantScoped('SELECT * FROM auth_sessions WHERE token = ?');
  assertTenantScoped('SELECT * FROM users WHERE email = ?');
});

T('cross-tenant aggregates are explicit at the call site, never implicit', () => {
  // An admin count across all tenants must SAY so; a silently-permitted version
  // would be indistinguishable from a leak.
  assertTenantScoped('SELECT COUNT(*) FROM requests', { allowGlobal: true });
  throws(() => assertTenantScoped('SELECT COUNT(*) FROM requests'), 'UNSCOPED');
});

T('the facade binds the predicate check to the connection', async () => {
  const { db } = await fresh();
  const scope = forTenant(db, 'acme');
  eq(scope.tenant, 'acme');
  // Scoped SQL works…
  eq(Array.isArray(await scope.all('SELECT id FROM requests WHERE tenant = ?', 'acme')), true);
  // …and unscoped SQL cannot even be prepared.
  let caught: unknown = null;
  try {
    scope.statement('SELECT id FROM requests');
  } catch (e) {
    caught = e;
  }
  eq(caught instanceof TenantScopeError, true, 'unscoped statement rejected:');
  eq((caught as Error).message.includes('UNSCOPED'), true);
  throws(() => forTenant(db, ''), 'EMPTY');
  await db.close();
});

T('table detection matches real statement shapes', () => {
  eq(tenantTableInSql('SELECT 1 FROM requests WHERE tenant = ?'), 'requests');
  eq(tenantTableInSql('INSERT INTO audit_log (tenant) VALUES (?)'), 'audit_log');
  eq(tenantTableInSql('UPDATE watch_contracts SET state = ?'), 'watch_contracts');
  eq(tenantTableInSql('SELECT 1 FROM meta'), null);
  eq(tenantTableInSql('SELECT 1 FROM schema_migrations'), null);
  eq(sqlIsTenantScoped('SELECT 1 FROM requests WHERE tenant = ?'), true);
  eq(sqlIsTenantScoped('SELECT 1 FROM requests'), false);
  eq(TENANT_TABLES.includes('requests'), true);
});

// ------------------------------------------------- source ratchet (the point)
//
// A guard that only exists at runtime cannot be applied to 586 existing call
// sites at once. So this scanner measures them, and the test below holds the
// number: it may fall, and it may not rise. That is what makes the guard
// enforceable today instead of aspirational — and the allowlist is the burn-down
// list, not a hiding place.

interface Violation {
  file: string;
  line: number;
  table: string;
  sql: string;
}

/** Longest SQL this scanner will look at; a statement past this is unusual. */
const SQL_WINDOW = 800;

function sqlArgumentAt(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < Math.min(source.length, openParen + SQL_WINDOW); i++) {
    const c = source[i]!;
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1, openParen + SQL_WINDOW);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Tenant-table statements in `src/` that never mention the tenant column.
 * Only `.prepare(<literal>)` is analysed: SQL built in a variable first is a
 * blind spot this scanner admits to rather than guesses about.
 */
export function scanUnscopedStatements(root = 'src'): {
  violations: Violation[];
  scanned: number;
  indirect: number;
} {
  const violations: Violation[] = [];
  let scanned = 0;
  // Statements that interpolate a variable before the SQL text is complete —
  // the dominant idiom here is `WHERE ${filter}`, and `filter` is built two
  // files away WITH the tenant predicate. Flagging these would be crying wolf,
  // and a guard that cries wolf is worse than no guard: the real violation
  // would drown in expected noise. Counted, not flagged, and named as a blind
  // spot rather than pretended away.
  let indirect = 0;
  for (const file of walk(root)) {
    // The guard's own fixtures and the facade are not call sites.
    if (file.endsWith('core/tenant.ts')) continue;
    if (file.includes(`vendor${sep}`) || file.includes('node_modules')) continue;
    const source = readFileSync(file, 'utf8');
    // Both entry points are scanned: the raw driver call AND the facade's own
    // `.statement()`. Scanning only `.prepare(` would make forTenant() a way to
    // leave the guard's field of view, which is exactly backwards.
    const nextCall = (from: number): { at: number; fn: string } | null => {
      const a = source.indexOf('.prepare(', from);
      const b = source.indexOf('.statement(', from);
      if (a === -1 && b === -1) return null;
      if (a === -1) return { at: b, fn: '.statement(' };
      if (b === -1) return { at: a, fn: '.prepare(' };
      return a < b ? { at: a, fn: '.prepare(' } : { at: b, fn: '.statement(' };
    };
    let call = nextCall(0);
    while (call) {
      const args = sqlArgumentAt(source, call.at + call.fn.length);
      const table = tenantTableInSql(args);
      if (table) {
        scanned += 1;
        // An explicit `{ allowGlobal: true }` is the declared cross-tenant
        // opt-out: visible at the call site, and therefore reviewable.
        const declaredGlobal = /allowGlobal\s*:\s*true/.test(args);
        if (sqlIsTenantScoped(args) || declaredGlobal) {
          // Statically scoped, or a declared global read.
        } else if (args.includes('${')) {
          indirect += 1;
        } else {
          violations.push({
            file: relative('.', file).split(sep).join('/'),
            line: source.slice(0, call.at).split('\n').length,
            table,
            sql: args.replace(/\s+/g, ' ').trim().slice(0, 120),
          });
        }
      }
      call = nextCall(call.at + call.fn.length);
    }
  }
  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { violations, scanned, indirect };
}

/**
 * Ratchet baseline: the number of tenant-table statements in `src/` that still
 * lack a tenant predicate. Measured, not estimated — lower it as sites migrate
 * onto forTenant(). Raising it requires editing this constant, which is exactly
 * the conversation that should happen before a new unscoped query ships.
 */
const UNSCOPED_BASELINE = 16;

T('no new unscoped tenant-table statements (ratchet)', () => {
  const { violations, scanned, indirect } = scanUnscopedStatements();
  console.log(
    `    tenant-table statements scanned: ${scanned} · statically scoped: ${scanned - indirect - violations.length} · interpolated (unverifiable): ${indirect} · unscoped: ${violations.length} (baseline ${UNSCOPED_BASELINE})`,
  );
  for (const v of violations.slice(0, 25)) {
    console.log(`      ${v.file}:${v.line}  [${v.table}] ${v.sql}`);
  }
  if (violations.length > 25) console.log(`      … and ${violations.length - 25} more`);
  eq(
    violations.length <= UNSCOPED_BASELINE,
    true,
    `unscoped tenant-table statements must not increase (${violations.length} > ${UNSCOPED_BASELINE})`,
  );
});
