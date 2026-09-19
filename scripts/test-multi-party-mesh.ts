import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/core/db.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import { getMeetingById } from '../src/meetings/db.ts';
import type { SignalingMessage } from '../src/meetings/signaling.ts';

const TEN = 'acme';
const NOW = new Date().toISOString();

interface ConnectedPeer {
  name: string;
  userId: string;
  role: 'host' | 'participant';
  ws: WebSocket;
  peerId: string;
  messages: SignalingMessage[];
  waitForMessage: (predicate: (msg: SignalingMessage) => boolean, timeoutMs?: number) => Promise<SignalingMessage>;
}

async function runMultiPartyMeshTest() {
  console.log('\n===============================================================');
  console.log(' Starting WebRTC Multi-Party Full Mesh Live Integration Test');
  console.log('===============================================================\n');

  // 1. Setup DB & Tenant
  console.log('[Step 1] Initializing isolated database and tenant credentials...');
  const db = openDb(':memory:');
  await migrate(db);
  await installAuthSchema(db, NOW);
  const { owner } = await signupTenant(
    db,
    {
      slug: TEN,
      name: 'Acme Corp',
      email: 'owner@acme.test',
      password: 'mesh-secret-pass',
      ownerName: 'Krishiv',
    },
    NOW,
  );
  console.log('  ✔ Database and owner account ready.');

  // 2. Start Console Server with Signaling Upgrade
  console.log('[Step 2] Launching server on ephemeral port with native WebSocket upgrade...');
  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  const comp = new OrganizationalCompiler(db);
  const server = await startConsoleServer(db, ledger, coord, comp, {
    tenant: TEN,
    host: '127.0.0.1',
    port: 0,
  });
  const port = server.port;
  const base_ = `http://127.0.0.1:${port}`;
  console.log(`  ✔ Console Server listening at ${base_}`);

  // 3. Authenticate Host
  console.log('[Step 3] Authenticating session over HTTP...');
  const pre = await fetch(`${base_}/login`, { redirect: 'manual' });
  const preCsrf = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
  const loginRes = await fetch(`${base_}/login`, {
    method: 'POST',
    headers: { cookie: preCsrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${preToken}&email=${encodeURIComponent('owner@acme.test')}&password=${encodeURIComponent('mesh-secret-pass')}`,
    redirect: 'manual',
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const homeHtml = await (await fetch(`${base_}/`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrf = homeHtml.match(/name="vital-csrf" content="([0-9a-f]+)"/)![1]!;
  const authHeaders = { cookie, 'x-vital-csrf': csrf, 'content-type': 'application/json' };
  console.log('  ✔ Authenticated successfully.');

  // 4. Create Meeting
  console.log('[Step 4] Creating multi-party WebRTC meeting...');
  const createRes = await fetch(`${base_}/api/meetings`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Global Engineering All-Hands',
      scope: 'engineering',
      recordingEnabled: true,
    }),
  });
  assert.equal(createRes.status, 200);
  const { meeting } = (await createRes.json()) as any;
  const meetingId = meeting.id;
  console.log(`  ✔ Meeting created: ${meeting.title} (${meetingId})`);

  // Verify room HTML has client logic without syntax bugs
  const roomRes = await fetch(`${base_}/console/meetings/${meetingId}/room`, { headers: { cookie } });
  const roomHtml = await roomRes.text();
  assert.ok(roomHtml.includes('function esc(s)'), 'Room HTML must include esc helper');
  assert.ok(roomHtml.includes('participants-modal'), 'Room HTML must include participants modal');
  assert.ok(roomHtml.includes('speaking-glow.speaking'), 'Room HTML must include speaking glow styling');
  console.log('  ✔ Room HTML verified: client esc helper, modals, and speaker glow all present.');

  // Helper to connect a peer
  async function connectPeer(name: string, userId: string, role: 'host' | 'participant'): Promise<ConnectedPeer> {
    const wsUrl = `ws://127.0.0.1:${port}/api/meetings/signal?meetingId=${encodeURIComponent(meetingId)}&tenant=${TEN}&userId=${encodeURIComponent(userId)}&name=${encodeURIComponent(name)}&role=${role}`;
    const ws = new WebSocket(wsUrl);
    const messages: SignalingMessage[] = [];
    const waiters: Array<{ predicate: (m: SignalingMessage) => boolean; resolve: (m: SignalingMessage) => void; reject: (err: Error) => void; timer: any }> = [];

    ws.onmessage = (event) => {
      try {
        const msg: SignalingMessage = JSON.parse(event.data.toString());
        messages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.predicate(msg)) {
            clearTimeout(w.timer);
            waiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      } catch (err) {
        console.error(`[${name}] Failed to parse socket message:`, err);
      }
    };

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout connecting ${name}`)), 4000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = (e) => {
        clearTimeout(t);
        reject(e);
      };
    });

    function waitForMessage(predicate: (m: SignalingMessage) => boolean, timeoutMs = 4000): Promise<SignalingMessage> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<SignalingMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`[${name}] Timed out waiting for message matching predicate. Received: ${JSON.stringify(messages.map((m) => m.type))}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    }

    // Wait for initial 'joined' message
    const joinedMsg = await waitForMessage((m) => m.type === 'joined');
    const peerId = joinedMsg.payload.peerId;
    return { name, userId, role, ws, peerId, messages, waitForMessage };
  }

  // 5. Connect Host (Krishiv)
  console.log('[Step 5] Connecting Peer 1 (Host: Krishiv)...');
  const host = await connectPeer('Krishiv', 'usr_krishiv', 'host');
  const hostJoined = host.messages.find((m) => m.type === 'joined')!;
  assert.equal(hostJoined.payload.existingPeers.length, 0, 'Host should see 0 existing peers');
  console.log(`  ✔ Host joined with peerId=${host.peerId}, existingPeers=0`);

  // 6. Connect Peer 2 (Alice)
  console.log('[Step 6] Connecting Peer 2 (Alice) and establishing Peer-to-Peer link with Host...');
  const alice = await connectPeer('Alice', 'usr_alice', 'participant');
  const aliceJoined = alice.messages.find((m) => m.type === 'joined')!;
  assert.equal(aliceJoined.payload.existingPeers.length, 1, 'Alice should see 1 existing peer (Host)');
  assert.equal(aliceJoined.payload.existingPeers[0].peerId, host.peerId);

  // Host should receive peer-joined for Alice
  const hostSawAlice = await host.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === alice.peerId);
  assert.equal(hostSawAlice.payload.displayName, 'Alice');
  console.log('  ✔ Host received peer-joined notification for Alice.');

  // Alice sends SDP offer to Host
  alice.ws.send(JSON.stringify({
    type: 'offer',
    meetingId,
    targetId: host.peerId,
    payload: { type: 'offer', sdp: 'v=0\r\no=alice_offer_to_host\r\ns=webrtc' },
  }));

  // Host receives offer from Alice
  const hostGotAliceOffer = await host.waitForMessage((m) => m.type === 'offer' && m.senderId === alice.peerId);
  assert.equal(hostGotAliceOffer.payload.type, 'offer');

  // Host answers Alice
  host.ws.send(JSON.stringify({
    type: 'answer',
    meetingId,
    targetId: alice.peerId,
    payload: { type: 'answer', sdp: 'v=0\r\no=host_answer_to_alice\r\ns=webrtc' },
  }));

  // Alice receives answer from Host
  const aliceGotHostAnswer = await alice.waitForMessage((m) => m.type === 'answer' && m.senderId === host.peerId);
  assert.equal(aliceGotHostAnswer.payload.type, 'answer');

  // Alice & Host exchange ICE candidates
  alice.ws.send(JSON.stringify({
    type: 'ice-candidate',
    meetingId,
    targetId: host.peerId,
    payload: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  }));
  const hostGotIce = await host.waitForMessage((m) => m.type === 'ice-candidate' && m.senderId === alice.peerId);
  assert.ok(hostGotIce.payload.candidate.includes('192.168.1.100'));

  console.log('  ✔ 2-Peer mesh (Host <-> Alice) fully established with offer/answer/ICE exchange.');

  // 7. Connect Peer 3 (Bob)
  console.log('[Step 7] Connecting Peer 3 (Bob) and establishing 3-Way Mesh (Bob <-> Host, Bob <-> Alice)...');
  const bob = await connectPeer('Bob', 'usr_bob', 'participant');
  const bobJoined = bob.messages.find((m) => m.type === 'joined')!;
  assert.equal(bobJoined.payload.existingPeers.length, 2, 'Bob should see 2 existing peers (Host, Alice)');

  // Both Host and Alice should receive peer-joined for Bob
  await host.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === bob.peerId);
  await alice.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === bob.peerId);
  console.log('  ✔ Host and Alice both received peer-joined notifications for Bob.');

  // Bob sends offer to Host
  bob.ws.send(JSON.stringify({
    type: 'offer',
    meetingId,
    targetId: host.peerId,
    payload: { type: 'offer', sdp: 'v=0\r\no=bob_offer_to_host' },
  }));
  await host.waitForMessage((m) => m.type === 'offer' && m.senderId === bob.peerId);
  host.ws.send(JSON.stringify({
    type: 'answer',
    meetingId,
    targetId: bob.peerId,
    payload: { type: 'answer', sdp: 'v=0\r\no=host_answer_to_bob' },
  }));
  await bob.waitForMessage((m) => m.type === 'answer' && m.senderId === host.peerId);

  // Bob sends offer to Alice
  bob.ws.send(JSON.stringify({
    type: 'offer',
    meetingId,
    targetId: alice.peerId,
    payload: { type: 'offer', sdp: 'v=0\r\no=bob_offer_to_alice' },
  }));
  await alice.waitForMessage((m) => m.type === 'offer' && m.senderId === bob.peerId);
  alice.ws.send(JSON.stringify({
    type: 'answer',
    meetingId,
    targetId: bob.peerId,
    payload: { type: 'answer', sdp: 'v=0\r\no=alice_answer_to_bob' },
  }));
  await bob.waitForMessage((m) => m.type === 'answer' && m.senderId === alice.peerId);

  console.log('  ✔ 3-Way mesh (Host <-> Alice <-> Bob) fully interconnected.');

  // 8. Connect Peer 4 (Charlie)
  console.log('[Step 8] Connecting Peer 4 (Charlie) and establishing 4-Way Mesh...');
  const charlie = await connectPeer('Charlie', 'usr_charlie', 'participant');
  const charlieJoined = charlie.messages.find((m) => m.type === 'joined')!;
  assert.equal(charlieJoined.payload.existingPeers.length, 3, 'Charlie should see 3 existing peers (Host, Alice, Bob)');

  // All 3 existing peers receive peer-joined for Charlie
  await Promise.all([
    host.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === charlie.peerId),
    alice.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === charlie.peerId),
    bob.waitForMessage((m) => m.type === 'peer-joined' && m.payload?.peerId === charlie.peerId),
  ]);
  console.log('  ✔ Host, Alice, and Bob all received peer-joined notifications for Charlie.');

  // Charlie initiates offers to all 3 existing peers
  for (const peer of [host, alice, bob]) {
    charlie.ws.send(JSON.stringify({
      type: 'offer',
      meetingId,
      targetId: peer.peerId,
      payload: { type: 'offer', sdp: `v=0\r\no=charlie_to_${peer.name.toLowerCase()}` },
    }));
    await peer.waitForMessage((m) => m.type === 'offer' && m.senderId === charlie.peerId);
    peer.ws.send(JSON.stringify({
      type: 'answer',
      meetingId,
      targetId: charlie.peerId,
      payload: { type: 'answer', sdp: `v=0\r\no=${peer.name.toLowerCase()}_to_charlie` },
    }));
    await charlie.waitForMessage((m) => m.type === 'answer' && m.senderId === peer.peerId);
  }
  console.log('  ✔ 4-Way full mesh (6 bidirectional peer connections) successfully negotiated.');

  // 9. In-room Chat Broadcast Test
  console.log('[Step 9] Testing multi-peer chat broadcast...');
  charlie.ws.send(JSON.stringify({
    type: 'chat-message',
    meetingId,
    payload: { text: 'Hello team, audio and video are working great!' },
  }));

  const [hostChat, aliceChat, bobChat] = await Promise.all([
    host.waitForMessage((m) => m.type === 'chat-message' && m.payload?.text?.includes('audio and video')),
    alice.waitForMessage((m) => m.type === 'chat-message' && m.payload?.text?.includes('audio and video')),
    bob.waitForMessage((m) => m.type === 'chat-message' && m.payload?.text?.includes('audio and video')),
  ]);
  assert.equal(hostChat.senderName, 'Charlie');
  assert.equal(aliceChat.senderName, 'Charlie');
  assert.equal(bobChat.senderName, 'Charlie');
  console.log('  ✔ Chat broadcast delivered in real time to all room participants.');

  // 10. Media State Updates (Mute/Unmute/Camera)
  console.log('[Step 10] Testing media state updates propagation across the mesh...');
  // Alice mutes her microphone
  alice.ws.send(JSON.stringify({
    type: 'media-state',
    meetingId,
    payload: { audioMuted: true, videoMuted: false, screenSharing: false },
  }));

  await Promise.all([
    host.waitForMessage((m) => m.type === 'media-state' && m.senderId === alice.peerId && m.payload?.audioMuted === true),
    bob.waitForMessage((m) => m.type === 'media-state' && m.senderId === alice.peerId && m.payload?.audioMuted === true),
    charlie.waitForMessage((m) => m.type === 'media-state' && m.senderId === alice.peerId && m.payload?.audioMuted === true),
  ]);
  console.log('  ✔ Alice mic mute propagated to Host, Bob, and Charlie.');

  // Bob disables camera
  bob.ws.send(JSON.stringify({
    type: 'media-state',
    meetingId,
    payload: { audioMuted: false, videoMuted: true, screenSharing: false },
  }));

  await Promise.all([
    host.waitForMessage((m) => m.type === 'media-state' && m.senderId === bob.peerId && m.payload?.videoMuted === true),
    alice.waitForMessage((m) => m.type === 'media-state' && m.senderId === bob.peerId && m.payload?.videoMuted === true),
    charlie.waitForMessage((m) => m.type === 'media-state' && m.senderId === bob.peerId && m.payload?.videoMuted === true),
  ]);
  console.log('  ✔ Bob camera disable propagated to Host, Alice, and Charlie.');

  // 11. Live Speech Transcription Broadcast
  console.log('[Step 11] Testing live transcript broadcast...');
  const transcriptSeg = {
    speakerId: 'usr_krishiv',
    speakerName: 'Krishiv',
    startTime: 12,
    endTime: 16,
    text: 'We decided to ship the production release on October 15th.',
    confidence: 0.98,
  };
  host.ws.send(JSON.stringify({
    type: 'live-transcript',
    meetingId,
    payload: transcriptSeg,
  }));

  await Promise.all([
    alice.waitForMessage((m) => m.type === 'live-transcript' && m.payload?.text?.includes('October 15th')),
    bob.waitForMessage((m) => m.type === 'live-transcript' && m.payload?.text?.includes('October 15th')),
    charlie.waitForMessage((m) => m.type === 'live-transcript' && m.payload?.text?.includes('October 15th')),
  ]);
  console.log('  ✔ Live transcript broadcast successfully received by all active peers.');

  // 12. Graceful Departure of Peers
  console.log('[Step 12] Testing graceful departure (Charlie and Bob leave)...');
  charlie.ws.close();

  await Promise.all([
    host.waitForMessage((m) => m.type === 'peer-left' && m.payload?.peerId === charlie.peerId),
    alice.waitForMessage((m) => m.type === 'peer-left' && m.payload?.peerId === charlie.peerId),
    bob.waitForMessage((m) => m.type === 'peer-left' && m.payload?.peerId === charlie.peerId),
  ]);
  console.log('  ✔ Charlie departure cleanly notified to remaining peers.');

  bob.ws.close();
  await Promise.all([
    host.waitForMessage((m) => m.type === 'peer-left' && m.payload?.peerId === bob.peerId),
    alice.waitForMessage((m) => m.type === 'peer-left' && m.payload?.peerId === bob.peerId),
  ]);
  console.log('  ✔ Bob departure cleanly notified. Host and Alice remain connected.');

  // Verify Host and Alice can still communicate
  alice.ws.send(JSON.stringify({
    type: 'chat-message',
    meetingId,
    payload: { text: 'Still here with you Krishiv!' },
  }));
  const hostReceivedFinal = await host.waitForMessage((m) => m.type === 'chat-message' && m.payload?.text?.includes('Still here'));
  assert.equal(hostReceivedFinal.senderName, 'Alice');
  console.log('  ✔ Remaining mesh peers (Host & Alice) continue communicating without interruption.');

  // 13. Host Ends Meeting
  console.log('[Step 13] Host concludes meeting via API...');
  const endRes = await fetch(`${base_}/api/meetings/${meetingId}/end`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(endRes.status, 200);

  // Alice receives 'meeting-ended' broadcast
  const aliceGotEnded = await alice.waitForMessage((m) => m.type === 'meeting-ended');
  assert.equal(aliceGotEnded.meetingId, meetingId);
  console.log('  ✔ Alice received "meeting-ended" notification.');

  const dbMeeting = await getMeetingById(db, TEN, meetingId);
  assert.equal(dbMeeting?.status, 'ENDED');
  console.log('  ✔ Database meeting status updated to ENDED.');

  // 14. Cleanup
  host.ws.close();
  alice.ws.close();
  await server.close();
  await db.close();
  console.log('\n===============================================================');
  console.log(' All 14 Multi-Party WebRTC Full Mesh Steps Passed (100% OK)');
  console.log('===============================================================\n');
}

runMultiPartyMeshTest().catch((err) => {
  console.error('\n❌ Multi-party mesh test failed:', err);
  process.exit(1);
});
