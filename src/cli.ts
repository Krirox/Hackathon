import { openDb, migrate } from './core/db.ts';
import { createLedger } from './ledger/ledger.ts';
import { createCoordinator } from './coord/coordinator.ts';
import { OrganizationalCompiler } from './compiler/compiler.ts';
import { migratePostgres, openPostgres } from './core/pg.ts';
import { buildReport } from './console/report.ts';
import { renderHtml } from './console/render.ts';
import { startConsoleServer } from './console/serve.ts';
import { CognitiveRouter } from './router/router.ts';
import { installAuthSchema, signupTenant, changePassword } from './core/auth.ts';
import { eraseTenant, ERASURE_DONE_ACTION } from './core/erasure.ts';
import { writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileDiffCollector } from './ingest/collectors.ts';
import { runIngestionWorker } from './ingest/worker.ts';
import { runApplicationWorker } from './substrate/worker.ts';

/**
 * Minimal dev CLI + instance verifier (TODO §§0.4, V2.1).
 *
 *   tsx src/cli.ts status [--db path]              sqlite file, :memory:, or postgres:// URL
 *   tsx src/cli.ts report [--db path] [--out report.html] [--tenant acme]
 *   tsx src/cli.ts serve [--db var/vital.db] [--port 3100] [--tenant acme]
 *                       [--site site] [--approver-role member|admin|owner]
 *   tsx src/cli.ts ingest-files --tenant acme --scope engineering --source dir --artifacts dir --db path
 *   tsx src/cli.ts signup --tenant acme --email o@a.test --password '...'
 *   tsx src/cli.ts passwd --tenant acme --email o@a.test --password '...'
 *   tsx src/cli.ts erase --tenant acme --actor op@a.test [--export-to dir] [--yes]
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
  const site = flag('--site');
  const approverRole = flag('--approver-role') as 'member' | 'admin' | 'owner' | undefined;
  if (approverRole && !['member', 'admin', 'owner'].includes(approverRole))
    throw new Error('--approver-role must be member | admin | owner');
  // Preserve PEM blocks when keys are supplied through single-line environment files.
  const parseOperatorKeys = (raw: string | undefined): string[] | undefined => {
    if (!raw || raw.trim().length === 0) return undefined;
    const text = raw.replace(/\\n/g, '\n');
    const blocks = text.match(/-----BEGIN [^-]*PUBLIC KEY-----[\s\S]*?-----END [^-]*PUBLIC KEY-----/g);
    const keys = (blocks ?? [text]).map((s) => s.trim()).filter((s) => s.length > 0);
    return keys.length > 0 ? keys : undefined;
  };
  const server = await startConsoleServer(db, createLedger(db), createCoordinator(db), new OrganizationalCompiler(db), {
    port,
    host,
    tenant,
    siteDir: site,
    approverRole,
    operatorSecret: process.env.VITAL_OPERATOR_SECRET,
    operatorKeys: parseOperatorKeys(process.env.VITAL_OPERATOR_KEYS),
  });
  console.log(
    `vital console on http://${host}:${server.port} (db ${usePostgres ? 'postgres' : dbUrl}, tenant ${tenant}, auth on${site ? ', site ./site' : ''})`,
  );
  const withWorker = args.includes('--with-worker') || process.env.VITAL_WITH_WORKER === '1';
  if (withWorker) {
    const workerController = new AbortController();
    const stopWorker = () => workerController.abort();
    process.once('SIGINT', stopWorker);
    process.once('SIGTERM', stopWorker);
    const workerPromise = runApplicationWorker(db, createLedger(db), createCoordinator(db), {
      tenant,
      jcodeSocketPath: process.env.JCODE_API_SOCKET,
      signal: workerController.signal,
    });
    workerPromise.catch((err) => console.error('[worker-error]', err));
    console.log(`vital worker active in-process for tenant "${tenant}"`);
  }
} else if (cmd === 'ingest-files') {
  // Explicit finite invocation: console startup must never grant worker authority.
  const tenant = flag('--tenant');
  const scope = flag('--scope');
  const source = flag('--source');
  const artifactPath = flag('--artifacts') ?? process.env.ARTIFACT_DIR;
  const dbUrl = flag('--db') ?? process.env.DATABASE_URL;
  const maxReceipts = Number(flag('--max-receipts') ?? '50');
  if (!tenant?.trim() || !scope?.trim() || !source || !artifactPath || !dbUrl || dbUrl === ':memory:')
    throw new Error(
      'usage: vital ingest-files --tenant <slug> --scope <scope> --source <dir> --artifacts <dir> --db <persistent path or URL> [--max-receipts 1–500]',
    );
  if (!Number.isInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 500)
    throw new Error('--max-receipts must be an integer from 1 to 500');
  const sourceDir = realpathSync(source);
  mkdirSync(artifactPath, { recursive: true });
  const artifactDir = realpathSync(artifactPath);
  const insideSource = (path: string): boolean => {
    const rel = relative(sourceDir, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const usePostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
  const canonicalLocation = (path: string): string =>
    existsSync(path) ? realpathSync(path) : join(canonicalLocation(dirname(path)), basename(path));
  if (insideSource(artifactDir) || (!usePostgres && insideSource(canonicalLocation(resolve(dbUrl)))))
    throw new Error('database and artifacts must be outside the source directory');
  const db = usePostgres ? openPostgres(dbUrl) : openDb(dbUrl);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (usePostgres) await migratePostgres(db);
    else await migrate(db);
    const result = await runIngestionWorker(
      db,
      createLedger(db),
      fileDiffCollector(`files:${sourceDir}`, sourceDir, 'SINGLE_SOURCE', {
        maxEntries: 500,
        maxFileBytes: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
      { tenant, scope, artifactDir, maxReceipts, signal: controller.signal },
    );
    console.log(JSON.stringify(result));
    if (result.errors.length > 0) process.exitCode = 1;
    else if (result.stopped) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await db.close();
  }
} else if (cmd === 'worker') {
  const tenant = flag('--tenant') ?? process.env.VITAL_TENANT ?? 'acme';
  const dbUrl = flag('--db') ?? process.env.DATABASE_URL ?? 'var/vital.db';
  const jcodeSocket = flag('--jcode-socket') ?? process.env.JCODE_API_SOCKET;
  const pollIntervalMs = Number(flag('--interval-ms') ?? '1000');
  const usePostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
  const db = usePostgres ? openPostgres(dbUrl) : openDb(dbUrl);
  if (usePostgres) await migratePostgres(db);
  else await migrate(db);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(`vital worker started for tenant "${tenant}" (db: ${usePostgres ? 'postgres' : dbUrl})`);
  try {
    const result = await runApplicationWorker(db, createLedger(db), createCoordinator(db), {
      tenant,
      jcodeSocketPath: jcodeSocket,
      pollIntervalMs,
      signal: controller.signal,
    });
    console.log(JSON.stringify(result));
    if (result.errors.length > 0) process.exitCode = 1;
    else if (result.stopped) process.exitCode = 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await db.close();
  }
} else if (cmd === 'signup') {
  // Creates the tenant, its first owner, and the auth tables. The owner's
  // password is not forced to change (the founder chose it interactively);
  // invited users, by contrast, always get a forced change.
  const path = flag('--db') ?? 'var/vital.db';
  const tenant = flag('--tenant');
  const email = flag('--email');
  const password = flag('--password');
  const name = flag('--name') ?? 'Owner';
  if (!tenant || !email || !password)
    throw new Error('usage: vital signup --tenant <slug> --email <email> --password <password> [--name "Owner"]');
  const db = openDb(path);
  await migrate(db);
  await installAuthSchema(db);
  await signupTenant(db, { slug: tenant, name: tenant, email, password, ownerName: name }, new Date().toISOString());
  console.log(`tenant "${tenant}" created; owner ${email} can sign in at the console`);
  await db.close();
} else if (cmd === 'passwd') {
  // Operator password reset: sets a user's password and revokes their sessions.
  // For lost passwords and incident response; the user is not required to be logged in.
  const path = flag('--db') ?? 'var/vital.db';
  const tenant = flag('--tenant');
  const email = flag('--email');
  const password = flag('--password');
  if (!tenant || !email || !password)
    throw new Error('usage: vital passwd --tenant <slug> --email <email> --password <new-password>');
  const db = openDb(path);
  await migrate(db);
  await installAuthSchema(db);
  const user = (await db
    .prepare('SELECT id FROM users WHERE tenant = ? AND email = ?')
    .get(tenant, email.trim().toLowerCase())) as { id: string } | undefined;
  if (!user) throw new Error(`no user ${email} in tenant ${tenant}`);
  await changePassword(db, tenant, user.id, password, new Date().toISOString());
  console.log(`password changed for ${email}; all their sessions were revoked`);
  await db.close();
} else if (cmd === 'erase') {
  // GDPR Article 17 per-tenant erasure. Export is mandatory by design and
  // runs INSIDE the erasure transaction (see src/core/erasure.ts): the
  // portable record and the deletion commit or roll back together.
  const path = flag('--db') ?? 'var/vital.db';
  const tenant = flag('--tenant');
  const actor = flag('--actor') ?? 'cli:erase';
  const exportDir = flag('--export-to');
  const confirmed = args.includes('--yes');
  if (!tenant) throw new Error('usage: vital erase --tenant <slug> --actor <who> [--export-to <dir>] [--yes]');
  if (!confirmed) {
    console.error(
      `refusing to erase tenant "${tenant}" without --yes (this deletes ALL of its data and cannot be undone)`,
    );
    process.exit(1);
  }
  const db = openDb(path);
  await migrate(db);
  await installAuthSchema(db);
  const result = await eraseTenant(db, tenant, actor);
  if (exportDir) {
    mkdirSync(exportDir, { recursive: true });
    const file = `${exportDir}/${tenant}-erasure-export-${result.erasedAt.replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(result.export, null, 2));
    console.log(`export written: ${file}`);
  }
  const rows = Object.entries(result.deleted)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}=${n}`)
    .join(' ');
  console.log(
    `tenant "${tenant}" erased at ${result.erasedAt} (receipt: ${ERASURE_DONE_ACTION} under erased:${tenant})`,
  );
  console.log(`rows deleted: ${rows || 'none'}`);
  await db.close();
} else {
  console.error(
    `unknown command "${cmd}" (try: status | report | serve | worker | ingest-files | signup | passwd | erase)`,
  );
  process.exit(1);
}
