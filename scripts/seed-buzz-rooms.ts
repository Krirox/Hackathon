import { openDb, migrate } from '../src/core/db.ts';
import { loadRoomConfig } from '../src/talk/rooms.ts';
import { buzzRuntimeStatus } from '../src/talk/buzz-runtime.ts';
import { provisionAllRooms } from '../src/talk/provision.ts';
import { ScopeHealthEvaluator, formatStatusBeacon } from '../src/talk/health.ts';
import { createBuzzSurface } from '../src/talk/buzz.ts';

/**
 * Provision the 12 canonical rooms on a real Buzz relay.
 *
 * This script used to open an in-memory database (provisioning evaporated on
 * exit), swallow relay failures as `{"mock":true}` successes, and "sign" with a
 * hash — so it printed green while doing nothing. It now:
 *   1. refuses to run without a relay URL and key material (fail closed),
 *   2. provisions against the relay with real signed events,
 *   3. verifies each room's channel binding by reading relay metadata back,
 *   4. persists the bindings to the real Vital database, and
 *   5. exits non-zero if any room could not be provisioned.
 *
 * Usage:
 *   BUZZ_RELAY_URL=http://localhost:3000 \
 *   BUZZ_AGENT_MASTER_KEY=<64 hex chars> \
 *   VITAL_DB=./vital.db \
 *   node --import tsx scripts/seed-buzz-rooms.ts [--tenant <slug>]
 *
 * Against a relay in dev mode (BUZZ_REQUIRE_AUTH_TOKEN=false), add
 * BUZZ_ALLOW_DEV_KEYS=1 to use development identities instead of a master key.
 */

async function main() {
  const args = process.argv.slice(2);
  const tenantIdx = args.indexOf('--tenant');
  const tenant = tenantIdx >= 0 ? (args[tenantIdx + 1] ?? '') : (process.env.VITAL_TENANT ?? 'vital-corp');
  const dbPath = process.env.VITAL_DB;
  if (!dbPath) {
    console.error(
      '[seed-buzz-rooms] Refusing to run without a database: set VITAL_DB (provisioning must persist, not evaporate)',
    );
    process.exit(1);
  }
  if (!tenant) {
    console.error('[seed-buzz-rooms] No tenant given: pass --tenant <slug> or set VITAL_TENANT');
    process.exit(1);
  }

  const status = buzzRuntimeStatus();
  if (!status.configured) {
    console.error('[seed-buzz-rooms] Buzz is not configured. Missing:');
    for (const m of status.missing) console.error(`  - ${m}`);
    console.error('\nSet BUZZ_RELAY_URL and BUZZ_AGENT_MASTER_KEY (hex, >=16 bytes), then re-run.');
    process.exit(1);
  }

  const relayUrl = status.relayUrl!;
  console.log('\n\x1b[1m🏛️ Vital Buzz Room Provisioning\x1b[0m');
  console.log(`Tenant: \x1b[36m${tenant}\x1b[0m | Relay: \x1b[36m${relayUrl}\x1b[0m | DB: \x1b[36m${dbPath}\x1b[0m\n`);

  const db = openDb(dbPath);
  await migrate(db);

  const { resolveAgentKey } = await import('../src/talk/agent-keys.ts');
  const { keypair, resolution } = resolveAgentKey('workspace-agent');
  if (resolution.source === 'dev-key') {
    console.log('\x1b[33m⚠ Development identities in use (BUZZ_ALLOW_DEV_KEYS=1) — never for production.\x1b[0m\n');
  }

  const surface = createBuzzSurface({
    relayUrl,
    keypair,
    authMode: 'nip98',
    fetchFn: (url, init) =>
      // GET/HEAD must not carry a body (the fetch spec forbids it).
      init.method === 'GET' || init.method === 'HEAD'
        ? fetch(url, { method: init.method, headers: init.headers })
        : fetch(url, init),
  });

  // Fail fast with a readable message if the relay is unreachable.
  const health = await surface.health();
  if (!health.ok) {
    console.error(`[seed-buzz-rooms] Relay unreachable: ${health.error}`);
    console.error(`  Check BUZZ_RELAY_URL (${relayUrl}) and that the relay's community binds this host.`);
    process.exit(1);
  }
  console.log(
    `Relay: ${health.software ?? 'buzz relay'} ${health.version ?? ''} (community ${health.communityHost})\n`,
  );

  const results = await provisionAllRooms(db, tenant, surface, 'seed:provision');

  console.log(`| Room | Scope | Channel UUID | Result |`);
  console.log(`| :--- | :--- | :--- | :--- |`);
  for (const r of results) {
    const cfg = await loadRoomConfig(db, tenant, r.scope);
    const flag = r.reused ? 'reused (verified)' : 'created';
    console.log(
      `| #${r.roomName} | ${r.scope} | ${r.channelId} | ${flag}${cfg.channelId === r.channelId ? '' : ' ⚠ persist mismatch'} |`,
    );
  }

  const evaluator = new ScopeHealthEvaluator(db, tenant, {});
  const roster = await evaluator.evaluateAll();
  console.log('\n\x1b[1mRoom health telemetry:\x1b[0m');
  for (const h of roster) console.log(`  ${formatStatusBeacon(h)}`);

  const failed = results.filter((r) => !r.verified);
  if (failed.length > 0) {
    console.error(`\n\x1b[31m✗ ${failed.length} room(s) could not be verified on the relay.\x1b[0m`);
    process.exit(1);
  }
  console.log(`\n\x1b[32m✔ ${results.length} rooms provisioned and verified against ${relayUrl}.\x1b[0m`);
  console.log('  Run `vital console` to see them under Buzz in the nav.\n');
}

main().catch((err) => {
  console.error('[seed-buzz-rooms] Fatal:', err);
  process.exit(1);
});
