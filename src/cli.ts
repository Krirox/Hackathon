import { openDb, migrate } from './core/db.ts';
import { createLedger } from './ledger/ledger.ts';
import { createCoordinator } from './coord/coordinator.ts';
import { OrganizationalCompiler } from './compiler/compiler.ts';
import { migratePostgres, openPostgres } from './core/pg.ts';
import { buildReport } from './console/report.ts';
import { renderHtml } from './console/render.ts';
import { startConsoleServer } from './console/serve.ts';
import { CognitiveRouter } from './router/router.ts';
import { writeFileSync } from 'node:fs';

/**
 * Minimal dev CLI + instance verifier (TODO §§0.4, V2.1).
 *
 *   tsx src/cli.ts status [--db path]              sqlite file, :memory:, or postgres:// URL
 *   tsx src/cli.ts report [--db path] [--out report.html] [--tenant acme]
 *   tsx src/cli.ts serve [--db var/vital.db] [--port 3100] [--tenant acme]
 */

/**
 * Minimal dev CLI + instance verifier (TODO §§0.4, V2.1).
 *
 *   tsx src/cli.ts status [--db path]   sqlite file, :memory:, or postgres:// URL
 *
 * The postgres path runs the derived schema + a smoke write/read, which is
 * what CI executes against the postgres service on every push.
 */
const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
};

if (cmd === 'status') {
  const path = flag('--db') ?? process.env.DATABASE_URL ?? ':memory:';
  if (path.startsWith('postgres://') || path.startsWith('postgresql://')) {
    const db = openPostgres(path);
    await migratePostgres(db);
    const version = await db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const tables = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%'",
      )
      .get();
    console.log(
      JSON.stringify(
        {
          vital: '0.0.1',
          engine: 'postgres',
          schema_version: (version as { value: string }).value,
          tables: (tables as { n: string }).n,
        },
        null,
        2,
      ),
    );
    await db.close();
  } else {
    const db = openDb(path);
    await migrate(db);
    const ledger = createLedger(db);
    const coord = createCoordinator(db);
    const now = new Date().toISOString();
    const stats = await ledger.stats('acme', now);
    const refusal = await coord.refusalStats('acme');
    const tierMix = (await db
      .prepare(`SELECT tier AS tier, COUNT(*) AS n FROM traces WHERE tenant = 'acme' GROUP BY tier`)
      .all()) as { tier: string; n: number }[];
    console.log(
      JSON.stringify(
        {
          vital: '0.0.1',
          engine: 'sqlite',
          db: path,
          ledger: {
            total: stats.total,
            verified: stats.verified,
            staleFactRate: stats.staleFactRate,
            orphanClaims: stats.orphanClaims,
            factsWithoutGroundProvenance: stats.factsWithoutGroundProvenance,
          },
          refusalRate: refusal.rate,
          tierMix: Object.fromEntries(tierMix.map((t) => [String(t.tier), Number(t.n)])),
          costPerSignal: await new CognitiveRouter(db).costPerSignal('acme'),
          openRequests: (await coord.list('acme')).filter(
            (r) => !['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED'].includes(r.state),
          ).length,
        },
        null,
        2,
      ),
    );
    await db.close();
  }
} else if (cmd === 'report') {
  const path = flag('--db') ?? ':memory:';
  if (path.startsWith('postgres'))
    throw new Error('report renders from a local sqlite file in v2 (postgres read-model needs live-PG wiring)');
  const tenant = flag('--tenant') ?? 'acme';
  const out = flag('--out') ?? 'vital-report.html';
  const db = openDb(path);
  await migrate(db);
  const now = new Date().toISOString();
  const report = await buildReport(
    db,
    createLedger(db),
    createCoordinator(db),
    new OrganizationalCompiler(db),
    tenant,
    now,
  );
  writeFileSync(out, renderHtml(report));
  console.log(`wrote ${out} (${report.rooms.length} rooms, ${report.needsHuman.length} open approvals)`);
  await db.close();
} else if (cmd === 'serve') {
  const tenant = flag('--tenant') ?? process.env.VITAL_TENANT ?? 'acme';
  const port = Number(flag('--port') ?? process.env.PORT ?? '3100');
  const host = flag('--host') ?? process.env.HOST ?? '127.0.0.1';
  const dbUrl = flag('--db') ?? process.env.DATABASE_URL ?? 'var/vital.db';
  const usePostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
  const db = usePostgres ? openPostgres(dbUrl) : openDb(dbUrl);
  if (usePostgres) await migratePostgres(db);
  else await migrate(db);
  const server = await startConsoleServer(db, createLedger(db), createCoordinator(db), new OrganizationalCompiler(db), {
    port,
    host,
    tenant,
  });
  console.log(`vital console on http://${host}:${server.port} (db ${usePostgres ? 'postgres' : dbUrl})`);
} else {
  console.error(`unknown command "${cmd}" (try: status | report | serve)`);
  process.exit(1);
}
