import { openDb, migrate } from '../src/core/db.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { MeetingService } from '../src/meetings/service.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  mkdirSync(join(process.cwd(), 'var'), { recursive: true });
  const dbPath = join(process.cwd(), 'var', 'dev.db');
  const db = openDb(dbPath);
  await migrate(db);

  const tenant = 'acme';
  const now = new Date().toISOString();
  await installAuthSchema(db, now);

  try {
    await signupTenant(
      db,
      {
        slug: tenant,
        name: 'Acme Corp',
        email: 'owner@acme.test',
        password: 'the-console-password',
        ownerName: 'Krishiv',
      },
      now,
    );
    console.log('Provisioned tenant "acme" and owner "owner@acme.test".');
  } catch {
    // Tenant already signed up
  }

  const meetingService = new MeetingService(db);
  let meeting;
  try {
    const existingActive = await meetingService.listMeetings(tenant, { status: 'ACTIVE' });
    if (existingActive.length > 0) {
      meeting = existingActive[0];
    }
  } catch (err) {
    console.log('Meeting lookup notice:', err);
  }

  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  const comp = new OrganizationalCompiler(db);

  const port = Number(process.env.PORT ?? 3300);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    port,
    host: '127.0.0.1',
    tenant,
  });

  const probe = await server.ready();
  console.log(`\n======================================================`);
  console.log(` Vital Console & WebRTC Meeting Server Ready!`);
  console.log(` Status: ${probe.status}`);
  console.log(` Port: ${server.port}`);
  console.log(` URL: http://127.0.0.1:${server.port}`);
  console.log(` Credentials: owner@acme.test / the-console-password`);
  console.log(` Meetings Library: http://127.0.0.1:${server.port}/console/meetings`);
  if (meeting) {
    console.log(` Live Video Call Room: http://127.0.0.1:${server.port}/console/meetings/${meeting.id}/room`);
  }
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error('Failed to start meeting server:', err);
  process.exit(1);
});
