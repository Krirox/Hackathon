import { createLedger } from './ledger/ledger.ts';
import { createCoordinator } from './coord/coordinator.ts';
import { OrganizationalCompiler, mineCandidates } from './compiler/compiler.ts';
import { buildReport } from './console/report.ts';
import { renderHtml } from './console/render.ts';
import { startConsoleServer } from './console/serve.ts';
import { CognitiveRouter } from './router/router.ts';
import {
  installAuthSchema,
  signupTenant,
  operatorSetPassword,
  tryPasswordReset,
  listUsers,
  requestEmailVerification,
} from './core/auth.ts';
import { collectErasureArtifacts, eraseTenant, ERASURE_DONE_ACTION, verifyErasureReceipt } from './core/erasure.ts';
import {
  assertTenantExists,
  formatTargetHeader,
  migrateDbTarget,
  openDbTarget,
  readSchemaStatus,
  resolveDbTarget,
  resolveTenant,
  verifyInstance,
} from './core/cli-target.ts';
import { writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileDiffCollector } from './ingest/collectors.ts';
import { getIntegrationHealth, testFileDirectory } from './ingest/health.ts';
import {
  changeImpact,
  checkReadiness,
  describeDrillMode,
  describeStops,
  effectivePolicy,
  killDrill,
  recoverStop,
  runtimeHaltDrill,
  setKill,
  SETTINGS_INVENTORY,
  validatePolicyChange,
  workerReadiness,
} from './gov/trust.ts';
import { collectorName, loadActivationConfig } from './console/activation.ts';
import { integrationReadinessState, listKnownCollectors } from './ingest/health.ts';
import {
  exportLedgerWithManifest,
  filesystemArchivalProbe,
  streamExportLedger,
  verifyArchivalDelivery,
} from './ledger/export.ts';
import { runIngestionWorker } from './ingest/worker.ts';
import { runApplicationWorker } from './substrate/worker.ts';
import { workerBuzzSurface } from './talk/buzz-runtime.ts';

/**
 * Minimal dev CLI + instance verifier (TODO §§0.4, V2.1, FLOW-005).
 *
 *   tsx src/cli.ts status [--db path] [--tenant slug]   read-only inspection
 *   tsx src/cli.ts status --stops --tenant slug           list emergency stops (read-only display)
 *   tsx src/cli.ts status --policy [--db path]              governance settings inventory with defaults and entry points
 *   tsx src/cli.ts status --readiness [--db path]         bounded readiness checks for required dependencies
 *   tsx src/cli.ts verify [--db path]                    migrate + smoke probe
 *   tsx src/cli.ts verify --recover-stop <scope>/<class> --reason <text> --tenant slug
 *   tsx src/cli.ts verify --policy-change <key>=<value> [--db <target>]   validate a governed setting without applying it
 *   tsx src/cli.ts verify --erasure-receipt <slug> [--db <target>]        verify a surviving erasure receipt + export file
 *   tsx src/cli.ts verify --archival <export-file> [--bucket b] [--key k] [--archive-dir d]
 *       verify archival delivery by byte-compared read-back (unconfigured bucket is reported, never success)
 *   tsx src/cli.ts stop --engage <scope>/<action-class> --reason <text> --tenant slug [--recovery-requires <text>] [--db <target>]
 *   tsx src/cli.ts report [--db path] [--out report.html] [--tenant slug]
 *   tsx src/cli.ts report --manifest <snapshot|evidence-package|backup-reference> --tenant slug
 *   tsx src/cli.ts serve [--db var/vital.db] [--port 3100] [--tenant acme] [--trust-proxy] [--secure-cookies]
 *   tsx src/cli.ts drill --policy-only [--tenant slug] [--db <target>]
 *   tsx src/cli.ts drill --runtime --scope <scope> --class <action-class> --tenant <slug> [--db <target>]
 *   tsx src/cli.ts ingest-files --tenant acme --scope engineering --source dir --artifacts dir --db path
 *   tsx src/cli.ts ingest-test --source dir [--db path] [--tenant slug]
 *   tsx src/cli.ts signup --tenant acme --email o@a.test --password '...'
 *   tsx src/cli.ts passwd --tenant acme --email o@a.test --password '...'
 *   tsx src/cli.ts learn [--db path] [--tenant slug]     drift check, budget revert, candidate mining
 *   tsx src/cli.ts reset-link --tenant acme --email o@a.test [--base-url http://127.0.0.1:3100]
 *   tsx src/cli.ts erase --tenant acme --actor op@a.test [--export-to dir] [--yes]
 *
 * Database resolution: --db > DATABASE_URL > SQLITE_PATH > var/vital.db
 * (status/report require a persistent target — no silent :memory: default).
 */
const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
};

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

if (cmd === 'status') {
  try {
    const target = resolveDbTarget({ flag: flag('--db'), requirePersistent: true });
    const tenant = resolveTenant({ flag: flag('--tenant'), required: false });
    const db = openDbTarget(target);
    try {
      const schema = await readSchemaStatus(db);
      const header = {
        vital: '0.0.1',
        ...formatTargetHeader(target, tenant),
        ready: schema.ready,
        schema_version: schema.schemaVersion,
        migration_count: schema.migrationCount,
      };
      if (!schema.ready) {
        console.log(
          JSON.stringify({ ...header, hint: 'run `tsx src/cli.ts verify --db <same-target>` to migrate' }, null, 2),
        );
        process.exitCode = 1;
      } else if (args.includes('--readiness')) {
        // FLOW-023: same vocabulary as GET /api/metrics — database is
        // required; worker/integration status joins in when a tenant is
        // selected (worker silent = failing, source never configured =
        // unconfigured-optional, configured-but-broken = failing).
        const at = new Date().toISOString();
        const checks: Parameters<typeof checkReadiness>[0] = [
          {
            name: 'database',
            check: async () => {
              await db.prepare('SELECT 1 AS ok').get();
              return { ok: true as const, detail: `${target.engine} reachable` };
            },
          },
        ];
        if (tenant) {
          await assertTenantExists(db, tenant);
          // optional: true maps never-deployed → unconfigured-optional;
          // a stale heartbeat still returns { ok: false } → failing.
          checks.push({ name: 'worker', optional: true, check: async () => workerReadiness(db, tenant, { now: at }) });
          checks.push({
            name: 'integrations',
            optional: true,
            check: async () => {
              const config = await loadActivationConfig(db, tenant);
              const collectors = new Set(await listKnownCollectors(db, tenant));
              if (config) collectors.add(collectorName(config.sourcePath));
              if (collectors.size === 0) return { ok: false, unconfigured: true, detail: 'no source configured' };
              const parts: string[] = [];
              let failing = false;
              for (const collector of collectors) {
                const health = await getIntegrationHealth(db, tenant, collector, { configured: true, now: at });
                const projected = integrationReadinessState(health);
                parts.push(projected.detail);
                if (!projected.ok && projected.unconfigured !== true) failing = true;
              }
              if (failing) return { ok: false, detail: parts.join(' | ') };
              return { ok: true as const, detail: parts.join(' | ') };
            },
          });
        }
        const readiness = await checkReadiness(checks, { now: at });
        console.log(JSON.stringify({ ...header, ...readiness }, null, 2));
        if (!readiness.ready) process.exitCode = 1;
      } else if (args.includes('--stops')) {
        if (!tenant) throw new Error('usage: vital status --stops --tenant <slug> [--db <target>]');
        await assertTenantExists(db, tenant);
        const stops = await describeStops(db, tenant);
        console.log(JSON.stringify({ ...header, stops }, null, 2));
      } else if (args.includes('--policy')) {
        // Effective values are fixed at serve startup (flags win); the CLI
        // shows the inventory, defaults, and per-setting impact so an
        // operator can see what a change would do before making it.
        const { policy, sources } = effectivePolicy();
        console.log(
          JSON.stringify(
            {
              ...header,
              policy,
              sources,
              inventory: SETTINGS_INVENTORY,
              impact: Object.fromEntries(SETTINGS_INVENTORY.map((e) => [e.key, changeImpact(e.key)])),
              note: 'effective values are fixed at serve startup; startup-only settings require a restart',
            },
            null,
            2,
          ),
        );
      } else if (!tenant) {
        console.log(JSON.stringify(header, null, 2));
      } else {
        await assertTenantExists(db, tenant);
        const ledger = createLedger(db);
        const coord = createCoordinator(db);
        const now = new Date().toISOString();
        const stats = await ledger.stats(tenant, now);
        const refusal = await coord.refusalStats(tenant);
        const tierMix = (await db
          .prepare(`SELECT tier AS tier, COUNT(*) AS n FROM traces WHERE tenant = ? GROUP BY tier`)
          .all(tenant)) as { tier: string; n: number }[];
        console.log(
          JSON.stringify(
            {
              ...header,
              ledger: {
                total: stats.total,
                verified: stats.verified,
                staleFactRate: stats.staleFactRate,
                orphanClaims: stats.orphanClaims,
                factsWithoutGroundProvenance: stats.factsWithoutGroundProvenance,
              },
              refusalRate: refusal.rate,
              tierMix: Object.fromEntries(tierMix.map((t) => [String(t.tier), Number(t.n)])),
              costPerSignal: await new CognitiveRouter(db).costPerSignal(tenant),
              openRequests: (await coord.list(tenant)).filter(
                (r) => !['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED'].includes(r.state),
              ).length,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'verify') {
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const db = openDbTarget(target);
    try {
      const result = await verifyInstance(db);
      const recoverArg = flag('--recover-stop');
      const changeArg = flag('--policy-change');
      const receiptArg = flag('--erasure-receipt');
      const archivalArg = flag('--archival');
      if (changeArg) {
        // Dry-run only: most governed settings are startup-only or code
        // entry points, so the CLI validates and explains instead of
        // pretending to mutate live policy. Runtime changes (kill
        // switches, roles) keep their own audited commands.
        const eqAt = changeArg.indexOf('=');
        if (eqAt < 0) throw new Error('usage: vital verify --policy-change <key>=<value> [--db <target>]');
        const key = changeArg.slice(0, eqAt).trim();
        const value = changeArg.slice(eqAt + 1).trim();
        if (!key) throw new Error('usage: vital verify --policy-change <key>=<value> [--db <target>]');
        const checked = validatePolicyChange(key, value);
        let impact: { changes: string; notChanges: string; requires: string } | null = null;
        try {
          impact = changeImpact(key);
        } catch {
          impact = null;
        }
        const { sources } = effectivePolicy();
        const current = sources.find((s) => s.setting === key);
        console.log(
          JSON.stringify(
            {
              vital: '0.0.1',
              ok: checked.ok,
              ...formatTargetHeader(target),
              ...result,
              key,
              value,
              valid: checked.ok,
              reasons: checked.reasons,
              impact,
              current,
              applied: false,
            },
            null,
            2,
          ),
        );
        if (!checked.ok) process.exitCode = 1;
      } else if (receiptArg) {
        // Operator receipt verification (FLOW-004): the surviving
        // erased:<slug> receipt plus the durability of its export file.
        const slug = receiptArg.trim().toLowerCase();
        if (!slug) throw new Error('usage: vital verify --erasure-receipt <slug> [--db <target>]');
        const verification = await verifyErasureReceipt(db, slug);
        console.log(
          JSON.stringify(
            { vital: '0.0.1', ok: verification.found, ...formatTargetHeader(target), ...verification },
            null,
            2,
          ),
        );
        if (
          !verification.found ||
          verification.exportFile?.status === 'mismatch' ||
          verification.exportFile?.status === 'unreadable'
        ) {
          process.exitCode = 1;
        }
      } else if (archivalArg) {
        // Archival-delivery verification (FLOW-024): byte-compared
        // read-back against the configured archive. An unconfigured bucket
        // is reported explicitly — never claimed as delivered.
        const bucket = flag('--bucket') ?? process.env.VITAL_ARCHIVE_BUCKET ?? '';
        const key = flag('--key') ?? process.env.VITAL_ARCHIVE_KEY ?? undefined;
        const archiveDir = flag('--archive-dir') ?? process.env.VITAL_ARCHIVE_DIR ?? undefined;
        const report = await verifyArchivalDelivery(archivalArg, {
          bucket: bucket || undefined,
          key,
          probe: archiveDir ? filesystemArchivalProbe(archiveDir) : undefined,
        });
        console.log(
          JSON.stringify(
            {
              vital: '0.0.1',
              ok: report.status === 'verified' || report.status === 'unconfigured',
              ...formatTargetHeader(target),
              archival: report,
            },
            null,
            2,
          ),
        );
        if (report.status !== 'verified' && report.status !== 'unconfigured') process.exitCode = 1;
      } else if (recoverArg) {
        const tenant = resolveTenant({ flag: flag('--tenant'), required: true })!;
        const reason = flag('--reason');
        if (!reason?.trim())
          throw new Error(
            'usage: vital verify --recover-stop <scope>/<action-class> --reason <text> --tenant <slug> [--db <target>]',
          );
        const slash = recoverArg.indexOf('/');
        if (slash < 0) throw new Error('--recover-stop must look like <scope>/<action-class>');
        const scope = recoverArg.slice(0, slash).trim();
        const actionClass = recoverArg.slice(slash + 1).trim();
        if (!scope || !actionClass) throw new Error('--recover-stop must look like <scope>/<action-class>');
        await assertTenantExists(db, tenant, { strict: true });
        const recovered = await recoverStop(db, tenant, { scope, actionClass }, 'cli:recover-stop', {
          reason: reason.trim(),
          now: new Date().toISOString(),
        });
        console.log(
          JSON.stringify(
            { vital: '0.0.1', ok: true, ...formatTargetHeader(target, tenant), ...result, recovered },
            null,
            2,
          ),
        );
      } else {
        console.log(JSON.stringify({ vital: '0.0.1', ok: true, ...formatTargetHeader(target), ...result }, null, 2));
      }
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'learn') {
  try {
    const target = resolveDbTarget({ flag: flag('--db'), requirePersistent: true });
    const db = openDbTarget(target);
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true })!;
    try {
      await migrateDbTarget(db);
      await assertTenantExists(db, tenant);
      const comp = new OrganizationalCompiler(db);
      const router = new CognitiveRouter(db);

      const promotedCards = (await db
        .prepare("SELECT id, intent FROM skill_cards WHERE tenant = ? AND state = 'PROMOTED'")
        .all(tenant)) as { id: string; intent: string }[];
      const driftResults: { cardId: string; intent: string; drifting: boolean; demoted: boolean; ewma: number }[] = [];
      for (const c of promotedCards) {
        const d = await comp.checkDrift(tenant, c.id);
        driftResults.push({ cardId: c.id, intent: c.intent, drifting: d.drifting, demoted: d.demoted, ewma: d.ewma });
      }

      const revertedTiers = await router.revertBreachedTiers(tenant);
      const candidates = await mineCandidates(db, tenant);

      console.log(
        JSON.stringify(
          {
            vital: '0.0.1',
            ok: true,
            ...formatTargetHeader(target, tenant),
            drift: {
              checked: driftResults.length,
              demoted: driftResults.filter((r) => r.demoted).length,
              details: driftResults,
            },
            router: {
              revertedTiers,
            },
            candidates: {
              mined: candidates.length,
              details: candidates,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'report') {
  try {
    const target = resolveDbTarget({ flag: flag('--db'), requirePersistent: true });
    // F26: the read model is engine-agnostic (every query goes through the
    // AsyncDb dialect helpers), so Postgres targets are supported — verified
    // against a live engine in the PG lane. No sqlite-only refusal.
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true })!;
    const out = flag('--out') ?? 'vital-report.html';
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await assertTenantExists(db, tenant);
      const manifestKind = flag('--manifest');
      if (manifestKind) {
        const kind = manifestKind.trim();
        if (kind !== 'snapshot' && kind !== 'evidence-package' && kind !== 'backup-reference')
          throw new Error('--manifest must be snapshot | evidence-package | backup-reference');
        const outFile = flag('--out');
        if (outFile && kind !== 'backup-reference') {
          // Streaming file export with operator-visible progress
          // (FLOW-024): per-section start/batch/complete on stderr, then
          // the manifest (with retention policy) on stdout.
          const { createWriteStream } = await import('node:fs');
          const sink = createWriteStream(outFile, { mode: 0o600 });
          try {
            const { manifest } = await streamExportLedger(
              db,
              tenant,
              (chunk) =>
                new Promise<void>((resolve, reject) => {
                  sink.write(chunk, (err) => (err ? reject(err) : resolve()));
                }),
              {
                now: new Date().toISOString(),
                kind,
                onProgress: (event) => {
                  if (event.phase === 'complete' || event.section === 'export') {
                    console.error(`export [${event.section}]: ${event.phase} (${event.completed} rows)`);
                  }
                },
              },
            );
            await new Promise<void>((resolve, reject) => {
              sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
            });
            console.error(`export complete: ${outFile} (retention: operator-managed, no automatic expiry)`);
            console.log(JSON.stringify(manifest, null, 2));
          } finally {
            sink.destroy();
          }
        } else {
          const { manifest } = await exportLedgerWithManifest(db, tenant, kind, new Date().toISOString());
          console.log(JSON.stringify(manifest, null, 2));
        }
      } else {
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
        console.log(
          `wrote ${out} (${report.rooms.length} rooms, ${report.needsHuman.length} open approvals) [${target.display}, tenant ${tenant}]`,
        );
      }
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'serve') {
  const tenant = resolveTenant({ flag: flag('--tenant'), defaultTenant: 'acme' })!;
  const port = Number(flag('--port') ?? process.env.PORT ?? '3100');
  const host = flag('--host') ?? process.env.HOST ?? '127.0.0.1';
  const target = resolveDbTarget({ flag: flag('--db') });
  const db = openDbTarget(target);
  await migrateDbTarget(db);
  const site = flag('--site');
  const approverRole = flag('--approver-role') as 'member' | 'admin' | 'owner' | undefined;
  if (approverRole && !['member', 'admin', 'owner'].includes(approverRole))
    throw new Error('--approver-role must be member | admin | owner');
  const parseOperatorKeys = (raw: string | undefined): string[] | undefined => {
    if (!raw || raw.trim().length === 0) return undefined;
    const text = raw.replace(/\\n/g, '\n');
    const blocks = text.match(/-----BEGIN [^-]*PUBLIC KEY-----[\s\S]*?-----END [^-]*PUBLIC KEY-----/g);
    const keys = (blocks ?? [text]).map((s) => s.trim()).filter((s) => s.length > 0);
    return keys.length > 0 ? keys : undefined;
  };
  // FLOW-006: behind the ALB the task must trust proxy headers for client
  // IP and scheme; direct/loopback serving leaves them ignored.
  const trustProxy = args.includes('--trust-proxy') || process.env.TRUST_PROXY === '1';
  // Behind the ALB the cookie must carry `Secure`: without it the browser will
  // also send the session over a plaintext http:// downgrade, and SameSite=Lax
  // alone does not cover that. Deliberately a separate flag rather than implied
  // by --trust-proxy — trusting proxy headers and requiring TLS are independent,
  // and a loopback/TLS-terminating dev setup wants the first without the second.
  const secureCookies = args.includes('--secure-cookies') || process.env.SECURE_COOKIES === '1';
  const server = await startConsoleServer(db, createLedger(db), createCoordinator(db), new OrganizationalCompiler(db), {
    port,
    host,
    tenant,
    siteDir: site,
    approverRole,
    operatorSecret: process.env.VITAL_OPERATOR_SECRET,
    operatorKeys: parseOperatorKeys(process.env.VITAL_OPERATOR_KEYS),
    trustProxy,
    secureCookies,
  });
  const localUrl =
    server.host === '0.0.0.0' || server.host === '::'
      ? `http://127.0.0.1:${server.port}`
      : `http://${server.host}:${server.port}`;
  // FLOW-013 / activation-ready: surface a *usable* result, not just a bound
  // address. A server that bound but never answers is not "running" from the
  // user's perspective. Classify into ready / blocked / failed with a
  // recoverable next step.
  const probe = await server.ready();
  if (probe.status === 'ready') {
    console.log(
      `vital console ready — ${localUrl} (${probe.detail}; ${JSON.stringify(formatTargetHeader(target, tenant))}${site ? ', site ./site' : ''})`,
    );
  } else if (probe.status === 'blocked') {
    console.log(
      `vital console bound on ${server.address} but not ready (${probe.detail}). ` +
        `This can mean the tenant is awaiting setup or a dependency is unhealthy. ` +
        `Open ${localUrl} and finish setup, or run \`vital serve --readiness --tenant ${tenant}\` to diagnose.`,
    );
  } else {
    console.log(
      `vital console bound on ${server.address} but the readiness probe could not confirm it (${probe.detail}). ` +
        `The server may still be starting or a port is misconfigured. Retry, or run \`vital status --readiness --tenant ${tenant}\`.`,
    );
  }
  const withWorker = args.includes('--with-worker') || process.env.VITAL_WITH_WORKER === '1';
  if (withWorker) {
    const workerController = new AbortController();
    const stopWorker = () => workerController.abort();
    process.once('SIGINT', stopWorker);
    process.once('SIGTERM', stopWorker);
    const buzz = await workerBuzzSurface(db, tenant);
    const workerPromise = runApplicationWorker(db, createLedger(db), createCoordinator(db), {
      tenant,
      jcodeSocketPath: process.env.JCODE_API_SOCKET,
      signal: workerController.signal,
      ...(buzz ? { buzz } : {}),
    });
    workerPromise.catch((err) => console.error('[worker-error]', err));
    console.log(`vital worker active in-process for tenant "${tenant}"${buzz ? ' (Buzz live)' : ''}`);
  }
} else if (cmd === 'ingest-files') {
  const tenant = flag('--tenant');
  const scope = flag('--scope');
  const source = flag('--source');
  const artifactPath = flag('--artifacts') ?? process.env.ARTIFACT_DIR;
  const target = resolveDbTarget({ flag: flag('--db'), requirePersistent: true });
  const maxReceipts = Number(flag('--max-receipts') ?? '50');
  if (!tenant?.trim() || !scope?.trim() || !source || !artifactPath)
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
  const canonicalLocation = (path: string): string =>
    existsSync(path) ? realpathSync(path) : join(canonicalLocation(dirname(path)), basename(path));
  if (
    insideSource(artifactDir) ||
    (target.engine === 'sqlite' && insideSource(canonicalLocation(resolve(target.connection))))
  )
    throw new Error('database and artifacts must be outside the source directory');
  const db = openDbTarget(target);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await migrateDbTarget(db);
    const result = await runIngestionWorker(
      db,
      createLedger(db),
      fileDiffCollector(`files:${sourceDir}`, sourceDir, 'SINGLE_SOURCE', {
        maxEntries: 500,
        maxFileBytes: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
      { tenant: tenant.trim().toLowerCase(), scope, artifactDir, maxReceipts, signal: controller.signal },
    );
    console.log(JSON.stringify({ ...formatTargetHeader(target, tenant.trim().toLowerCase()), ...result }));
    if (result.errors.length > 0) process.exitCode = 1;
    else if (result.stopped) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await db.close();
  }
} else if (cmd === 'ingest-test') {
  const source = flag('--source');
  const tenant = resolveTenant({ flag: flag('--tenant'), defaultTenant: 'default' })!;
  const target = resolveDbTarget({ flag: flag('--db') });
  if (!source?.trim()) throw new Error('usage: vital ingest-test --source <dir> [--db path] [--tenant slug]');
  const test = testFileDirectory(realpathSync(source));
  const db = openDbTarget(target);
  try {
    await migrateDbTarget(db);
    const collector = `files:${realpathSync(source)}`;
    const health = await getIntegrationHealth(db, tenant, collector, {
      configured: true,
      now: new Date().toISOString(),
    });
    console.log(JSON.stringify({ ...formatTargetHeader(target, tenant), test, health }));
    if (!test.ok) process.exitCode = 1;
  } finally {
    await db.close();
  }
} else if (cmd === 'worker') {
  const tenant = resolveTenant({ flag: flag('--tenant'), defaultTenant: 'acme' })!;
  const target = resolveDbTarget({ flag: flag('--db') });
  const jcodeSocket = flag('--jcode-socket') ?? process.env.JCODE_API_SOCKET;
  const pollIntervalMs = Number(flag('--interval-ms') ?? '1000');
  // Where MODEL-tier work runs. `cloud` writes a durable executor-job row for
  // the outbox relay instead of running the work in this process — the lane the
  // Lambda handler, its Terraform and the deployment doc already assume exists.
  // Opt-in, because it changes which executor holds the lease.
  const executorLane: 'local' | 'cloud' =
    args.includes('--cloud-executor') || process.env.VITAL_EXECUTOR_LANE === 'cloud' ? 'cloud' : 'local';
  const db = openDbTarget(target);
  await migrateDbTarget(db);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(
    `vital worker started for tenant "${tenant}" (${JSON.stringify(formatTargetHeader(target, tenant))})` +
      (executorLane === 'cloud'
        ? ' — MODEL-tier work is queued for the cloud executor lane (durable executor-job rows)'
        : ''),
  );
  const buzz = await workerBuzzSurface(db, tenant);
  if (buzz) console.log('vital worker: Buzz surface live (run progress streams to room threads)');
  try {
    const result = await runApplicationWorker(db, createLedger(db), createCoordinator(db), {
      tenant,
      jcodeSocketPath: jcodeSocket,
      pollIntervalMs,
      executorLane,
      signal: controller.signal,
      ...(buzz ? { buzz } : {}),
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
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = flag('--tenant');
    const email = flag('--email');
    const password = flag('--password');
    const name = flag('--name') ?? 'Owner';
    if (!tenant || !email || !password)
      throw new Error('usage: vital signup --tenant <slug> --email <email> --password <password> [--name "Owner"]');
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await installAuthSchema(db);
      await signupTenant(
        db,
        { slug: tenant, name: tenant, email, password, ownerName: name },
        new Date().toISOString(),
      );
      console.log(
        `tenant "${tenant}" created; owner ${email} can sign in at the console (${JSON.stringify(formatTargetHeader(target, tenant))})`,
      );
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'passwd') {
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true });
    const email = flag('--email');
    const password = flag('--password');
    if (!email || !password)
      throw new Error('usage: vital passwd --tenant <slug> --email <email> --password <new-password>');
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await installAuthSchema(db);
      await assertTenantExists(db, tenant!, { strict: true });
      const user = (await db
        .prepare('SELECT id FROM users WHERE tenant = ? AND email = ?')
        .get(tenant, email.trim().toLowerCase())) as { id: string } | undefined;
      if (!user) throw new Error(`no user ${email} in tenant ${tenant}`);
      await operatorSetPassword(db, tenant!, user.id, password, new Date().toISOString());
      console.log(
        `temporary password set for ${email}; sessions revoked; they must change it at next sign-in (${JSON.stringify(formatTargetHeader(target, tenant))})`,
      );
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'reset-link') {
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true });
    const email = flag('--email');
    const baseUrl = (flag('--base-url') ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
    if (!email) throw new Error('usage: vital reset-link --tenant <slug> --email <email> [--base-url <url>]');
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await installAuthSchema(db);
      await assertTenantExists(db, tenant!, { strict: true });
      const token = await tryPasswordReset(db, tenant!, email, new Date().toISOString());
      if (!token) throw new Error(`no user ${email} in tenant ${tenant}`);
      console.log(`${baseUrl}/reset-password?token=${encodeURIComponent(token)}`);
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'verify-link') {
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true });
    const email = flag('--email');
    const baseUrl = (flag('--base-url') ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
    if (!email) throw new Error('usage: vital verify-link --tenant <slug> --email <email> [--base-url <url>]');
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await installAuthSchema(db);
      await assertTenantExists(db, tenant!, { strict: true });
      const users = await listUsers(db, tenant!);
      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user) throw new Error(`no user ${email} in tenant ${tenant}`);
      const token = await requestEmailVerification(db, tenant!, user.id, new Date().toISOString());
      console.log(`${baseUrl}/verify-email?token=${encodeURIComponent(token)}`);
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'erase') {
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true });
    const actor = flag('--actor') ?? 'cli:erase';
    const exportDir = flag('--export-to');
    const confirmed = args.includes('--yes');
    if (!confirmed) {
      console.error(`About to permanently erase tenant "${tenant}".`);
      console.error(
        'Scope: ledger claims, decisions, coordination, users, sessions, tenant meta, and unshared raw artifacts.',
      );
      console.error(
        exportDir
          ? `Export: durable JSON at ${exportDir} (written and verified before deletion commits).`
          : 'Export: in-memory only (use --export-to <dir> for a verified on-disk copy).',
      );
      console.error(
        `Retained: erasure receipt under erased:${tenant}; shared artifacts referenced by other tenants; backups/external stores.`,
      );
      console.error('Pass --yes to proceed.');
      process.exit(1);
    }
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      await installAuthSchema(db);
      await assertTenantExists(db, tenant!, { strict: true });
      const result = await eraseTenant(db, tenant!, actor, undefined, { exportTo: exportDir ?? undefined });
      // Post-commit collector: runs AFTER the transaction commits so a
      // rollback can never restore refs to already-deleted blobs.
      const deferredRefs = (result.receipt.deferred.find((d) => d.category === 'artifacts')?.items ?? [])
        .slice()
        .sort();
      let collected: {
        deleted: string[];
        retainedShared: string[];
        missing: string[];
        failed: { ref: string; reason: string }[];
      } | null = null;
      if (deferredRefs.length > 0) {
        collected = await collectErasureArtifacts(db, tenant!, deferredRefs, { actor });
        console.log(
          `artifacts collected post-commit: ${collected.deleted.length} deleted, ${collected.retainedShared.length} retained-shared, ${collected.missing.length} already-gone, ${collected.failed.length} failed`,
        );
        for (const f of collected.failed) console.error(`collect failed [${f.ref}]: ${f.reason}`);
      }
      if (result.receipt.exportFile) console.log(`export written: ${result.receipt.exportFile}`);
      const rows = Object.entries(result.receipt.deleted)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join(' ');
      console.log(
        `tenant "${tenant}" erased at ${result.erasedAt} (receipt: ${ERASURE_DONE_ACTION} under erased:${tenant})`,
      );
      console.log(`rows deleted: ${rows || 'none'} (${JSON.stringify(formatTargetHeader(target, tenant))})`);
      if (result.receipt.metaKeysDeleted.length > 0) {
        console.log(`meta keys deleted: ${result.receipt.metaKeysDeleted.length}`);
      }
      if (result.receipt.artifactsDeleted.length > 0) {
        console.log(`artifacts deleted: ${result.receipt.artifactsDeleted.length}`);
      }
      const retained = result.receipt.retained.filter((r) => r.items.length > 0).map((r) => r.category);
      if (retained.length > 0) console.log(`retained: ${retained.join(', ')}`);
      const deferred = result.receipt.deferred.filter((r) => r.items.length > 0 || r.reason.length > 0);
      for (const d of deferred) {
        console.log(`deferred [${d.category}]: ${d.items.length > 0 ? d.items.join(', ') : d.reason}`);
      }
      for (const f of result.receipt.failed) {
        console.error(`failed [${f.category}]: ${f.items.join(', ')} (${f.reason})`);
      }
      if (result.receipt.failed.length > 0 || (collected && collected.failed.length > 0)) process.exitCode = 1;
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'stop') {
  try {
    const engageArg = flag('--engage');
    if (!engageArg)
      throw new Error(
        'usage: vital stop --engage <scope>/<action-class> --reason <text> --tenant <slug> [--recovery-requires <text>] [--db <target>]',
      );
    const tenant = resolveTenant({ flag: flag('--tenant'), required: true })!;
    const reason = flag('--reason');
    if (!reason?.trim())
      throw new Error(
        'usage: vital stop --engage <scope>/<action-class> --reason <text> --tenant <slug> [--recovery-requires <text>] [--db <target>]',
      );
    const slash = engageArg.indexOf('/');
    if (slash < 0) throw new Error('--engage must look like <scope>/<action-class>');
    const scope = engageArg.slice(0, slash).trim();
    const actionClass = engageArg.slice(slash + 1).trim();
    if (!scope || !actionClass) throw new Error('--engage must look like <scope>/<action-class>');
    const target = resolveDbTarget({ flag: flag('--db') });
    const db = openDbTarget(target);
    try {
      await assertTenantExists(db, tenant, { strict: true });
      const now = new Date().toISOString();
      const recoveryRequires = flag('--recovery-requires')?.trim() || undefined;
      await setKill(db, tenant, { scope, actionClass }, 'cli:stop', now, {
        reason: reason.trim(),
        ...(recoveryRequires ? { recoveryRequires } : {}),
      });
      const stops = await describeStops(db, tenant);
      console.log(
        JSON.stringify(
          {
            vital: '0.0.1',
            ok: true,
            ...formatTargetHeader(target, tenant),
            engaged: `${scope}/${actionClass}`,
            stops,
          },
          null,
          2,
        ),
      );
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'drill') {
  // FLOW-022: the two drill modes are separate commands with separate
  // audit evidence. --policy-only (KILL_DRILL) never engages a real stop;
  // --runtime (RUNTIME_HALT_DRILL) briefly engages a real stop on the
  // given scope/class, verifies the halt path, then releases. Neither
  // mode proves production readiness — see `vital status --readiness`.
  try {
    const target = resolveDbTarget({ flag: flag('--db') });
    const tenant = resolveTenant({ flag: flag('--tenant'), defaultTenant: 'acme' })!;
    const db = openDbTarget(target);
    try {
      await migrateDbTarget(db);
      const now = new Date().toISOString();
      if (args.includes('--policy-only')) {
        await assertTenantExists(db, tenant);
        const mode = describeDrillMode('policy-only');
        const result = await killDrill(db, tenant, 'cli:drill', now);
        console.log(
          JSON.stringify(
            {
              vital: '0.0.1',
              ok: result.allHalted,
              ...formatTargetHeader(target, tenant),
              mode: result.mode,
              ...mode,
              result,
            },
            null,
            2,
          ),
        );
        if (!result.allHalted) process.exitCode = 1;
      } else if (args.includes('--runtime')) {
        const scope = flag('--scope')?.trim();
        const actionClass = (flag('--class') ?? flag('--action-class'))?.trim();
        if (!scope || !actionClass)
          throw new Error(
            'usage: vital drill --runtime --scope <scope> --class <action-class> --tenant <slug> [--db <target>]',
          );
        await assertTenantExists(db, tenant, { strict: true });
        const mode = describeDrillMode('runtime-halt');
        const result = await runtimeHaltDrill(db, tenant, { scope, actionClass }, 'cli:drill', now);
        console.log(
          JSON.stringify(
            {
              vital: '0.0.1',
              ok: result.held && result.released && result.authorizationHeld,
              ...formatTargetHeader(target, tenant),
              ...mode,
              result,
            },
            null,
            2,
          ),
        );
        if (!result.held || !result.released || !result.authorizationHeld) process.exitCode = 1;
      } else {
        throw new Error(
          'usage: vital drill (--policy-only | --runtime --scope <s> --class <c>) --tenant <slug> [--db <target>]',
        );
      }
    } finally {
      await db.close();
    }
  } catch (e) {
    fail(e);
  }
} else {
  console.error(
    `unknown command "${cmd}" (try: status | verify | report | serve | worker | ingest-files | ingest-test | signup | passwd | reset-link | verify-link | erase | stop | drill)`,
  );
  process.exit(1);
}
