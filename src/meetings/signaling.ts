import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { upsertParticipant, updateParticipantLeave, getMeetingById, updateMeetingStatus } from './db.ts';

export interface SignalingPeer {
  id: string; // unique socket/session connection id
  userId: string;
  displayName: string;
  meetingId: string;
  tenant: string;
  role: 'host' | 'participant';
  audioMuted: boolean;
  videoMuted: boolean;
  screenSharing: boolean;
  send: (msg: SignalingMessage) => void;
  close: () => void;
  lastSeenAt: number;
}

export type SignalingMessageType =
  | 'join'
  | 'joined'
  | 'peer-joined'
  | 'peer-left'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'media-state'
  | 'recording-state'
  | 'chat-message'
  | 'live-transcript'
  | 'meeting-ended'
  | 'ping'
  | 'pong'
  | 'error';

export interface SignalingMessage {
  type: SignalingMessageType;
  meetingId: string;
  senderId?: string;
  senderName?: string;
  targetId?: string; // specific peer for offer/answer/ice-candidate
  payload?: any;
  timestamp?: number;
}

export class MeetingSignalingHub {
  private rooms = new Map<string, Map<string, SignalingPeer>>(); // meetingId -> (peerId -> SignalingPeer)

  constructor(private readonly db?: AsyncDb) {}

  /**
   * Register a new peer connection in a meeting room.
   */
  async handlePeerJoin(peer: SignalingPeer): Promise<void> {
    const { meetingId, tenant, userId, displayName, role } = peer;
    if (!this.rooms.has(meetingId)) {
      this.rooms.set(meetingId, new Map());
    }
    const room = this.rooms.get(meetingId)!;

    // Check if user already had a stale connection in this room; close it
    for (const [existingId, existingPeer] of room.entries()) {
      if (existingPeer.userId === userId && existingId !== peer.id) {
        existingPeer.close();
        room.delete(existingId);
      }
    }

    room.set(peer.id, peer);

    // Persist participant join in DB if available
    if (this.db) {
      await upsertParticipant(this.db, {
        id: `part_${randomUUID().slice(0, 8)}`,
        tenant,
        meetingId,
        userId,
        displayName,
        role,
        joinedAt: new Date().toISOString(),
        leftAt: null,
        audioMuted: peer.audioMuted,
        videoMuted: peer.videoMuted,
      }).catch((err) => console.error('[meeting-signaling] DB join record error:', err));
    }

    // List existing peers in room
    const existingPeers = Array.from(room.values())
      .filter((p) => p.id !== peer.id)
      .map((p) => ({
        peerId: p.id,
        userId: p.userId,
        displayName: p.displayName,
        role: p.role,
        audioMuted: p.audioMuted,
        videoMuted: p.videoMuted,
        screenSharing: p.screenSharing,
      }));

    // Send 'joined' acknowledgment with list of existing peers
    peer.send({
      type: 'joined',
      meetingId,
      senderId: 'server',
      payload: {
        peerId: peer.id,
        existingPeers,
      },
      timestamp: Date.now(),
    });

    // Broadcast 'peer-joined' to all other peers in room
    this.broadcastToRoom(
      meetingId,
      {
        type: 'peer-joined',
        meetingId,
        senderId: peer.id,
        senderName: peer.displayName,
        payload: {
          peerId: peer.id,
          userId: peer.userId,
          displayName: peer.displayName,
          role: peer.role,
          audioMuted: peer.audioMuted,
          videoMuted: peer.videoMuted,
          screenSharing: peer.screenSharing,
        },
        timestamp: Date.now(),
      },
      peer.id,
    );
  }

  /**
   * Route signaling messages (SDP offer, answer, ICE candidates, media state updates).
   */
  handleMessage(senderPeerId: string, msg: SignalingMessage): void {
    const room = this.rooms.get(msg.meetingId);
    if (!room) return;

    const sender = room.get(senderPeerId);
    if (!sender) return;

    sender.lastSeenAt = Date.now();

    switch (msg.type) {
      case 'ping':
        sender.send({ type: 'pong', meetingId: msg.meetingId, timestamp: Date.now() });
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        // Targeted routing to specific peer
        if (msg.targetId && room.has(msg.targetId)) {
          const target = room.get(msg.targetId)!;
          target.send({
            ...msg,
            senderId: sender.id,
            senderName: sender.displayName,
            timestamp: Date.now(),
          });
        }
        break;

      case 'media-state':
        // Update sender state
        if (msg.payload) {
          if (typeof msg.payload.audioMuted === 'boolean') sender.audioMuted = msg.payload.audioMuted;
          if (typeof msg.payload.videoMuted === 'boolean') sender.videoMuted = msg.payload.videoMuted;
          if (typeof msg.payload.screenSharing === 'boolean') sender.screenSharing = msg.payload.screenSharing;
        }
        // Broadcast to all other peers
        this.broadcastToRoom(
          msg.meetingId,
          {
            ...msg,
            senderId: sender.id,
            senderName: sender.displayName,
            timestamp: Date.now(),
          },
          sender.id,
        );
        break;

      case 'recording-state':
      case 'chat-message':
      case 'live-transcript':
      case 'meeting-ended':
        // Broadcast to entire room including sender or excluding sender
        this.broadcastToRoom(
          msg.meetingId,
          {
            ...msg,
            senderId: sender.id,
            senderName: sender.displayName,
            timestamp: Date.now(),
          },
          msg.type === 'live-transcript' ? sender.id : undefined,
        );
        break;

      default:
        break;
    }
  }

  /**
   * Handle peer disconnection.
   */
  async handlePeerLeave(meetingId: string, peerId: string): Promise<void> {
    const room = this.rooms.get(meetingId);
    if (!room) return;

    const peer = room.get(peerId);
    if (!peer) return;

    room.delete(peerId);
    if (room.size === 0) {
      this.rooms.delete(meetingId);
      // When all peers have left the room, transition meeting to ENDED in DB
      if (this.db) {
        try {
          const meeting = await getMeetingById(this.db, peer.tenant, meetingId);
          if (meeting && meeting.status === 'ACTIVE') {
            const endedAt = new Date().toISOString();
            const startMs = new Date(meeting.startedAt || meeting.createdAt).getTime();
            const endMs = new Date(endedAt).getTime();
            const durationSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));
            await updateMeetingStatus(this.db, peer.tenant, meetingId, 'ENDED', {
              endedAt,
              durationSeconds,
            });
          }
        } catch (err) {
          console.error('[meeting-signaling] Auto-end meeting error on last peer leave:', err);
        }
      }
    }

    // Persist leave in DB if available
    if (this.db) {
      await updateParticipantLeave(this.db, peer.tenant, meetingId, peer.userId).catch(() => {});
    }

    // Notify room of departure
    this.broadcastToRoom(meetingId, {
      type: 'peer-left',
      meetingId,
      senderId: peer.id,
      senderName: peer.displayName,
      payload: { peerId: peer.id, userId: peer.userId },
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast a message to peers in a meeting room.
   */
  broadcastToRoom(meetingId: string, msg: SignalingMessage, excludePeerId?: string): void {
    const room = this.rooms.get(meetingId);
    if (!room) return;

    for (const [id, peer] of room.entries()) {
      if (excludePeerId && id === excludePeerId) continue;
      try {
        peer.send(msg);
      } catch (err) {
        console.error(`[meeting-signaling] Failed to send to peer ${id}:`, err);
      }
    }
  }

  getRoomPeers(meetingId: string): SignalingPeer[] {
    const room = this.rooms.get(meetingId);
    return room ? Array.from(room.values()) : [];
  }

  getRoomCount(meetingId: string): number {
    return this.rooms.get(meetingId)?.size ?? 0;
  }
}

// ------------------------------------------------ WebSocket Frame Protocol ----
// Standard RFC 6455 WebSocket framing implementation using node:crypto without external dependencies

/** Server-resolved identity for a signaling socket. */
export interface SignalingIdentity {
  userId: string;
  displayName: string;
  tenant: string;
  role: 'host' | 'participant';
}

export interface WebSocketUpgradeOptions {
  /**
   * Resolve the joining peer's identity from the request — session cookie,
   * meeting membership, host role. Return null to refuse the upgrade.
   *
   * Identity used to come from the query string (userId / role params),
   * which let anyone join any meeting as host. With no resolver installed
   * the socket is now refused outright (fail closed) rather than trusting
   * the client's self-declaration.
   */
  resolveIdentity?: (req: IncomingMessage) => Promise<SignalingIdentity | null>;
  /** Max accepted WS payload bytes; oversized frames drop the socket. */
  maxFrameBytes?: number;
  /** Peers silent longer than this are reaped (client pings every 25s). */
  idleTimeoutMs?: number;
}

const MAX_FRAME_BYTES_DEFAULT = 256 * 1024;
const IDLE_TIMEOUT_MS_DEFAULT = 75_000;

export function createWebSocketUpgradeHandler(hub: MeetingSignalingHub, options: WebSocketUpgradeOptions = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES_DEFAULT;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS_DEFAULT;

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // Resolve identity BEFORE writing the handshake or touching the socket:
    // Node pauses an upgraded connection's buffered bytes until the socket is
    // resumed (which happens when the first 'data' listener attaches), so
    // deferring openSocket to a later tick would stall pending frames.
    // Resolution itself never writes to the socket, so it is safe to run
    // while paused.
    void (async () => {
      let identity: SignalingIdentity | null;
      try {
        identity = options.resolveIdentity ? await options.resolveIdentity(req) : null;
      } catch (err) {
        console.error('[meeting-signaling] identity resolution failed:', err);
        identity = null;
      }
      if (!identity) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      openSocket(identity);
    })();

    function openSocket(identity: SignalingIdentity): void {
      const acceptKey = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n',
      ];

      socket.write(headers.join('\r\n'));

      const url = new URL(req.url ?? '/', 'http://console');
      const meetingId = url.searchParams.get('meetingId') ?? '';

      const peerId = `peer_${randomUUID().slice(0, 8)}`;

      const sendFrame = (data: Buffer) => {
        if (socket.destroyed) return;
        const length = data.length;
        let header: Buffer;
        if (length <= 125) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + text opcode
          header[1] = length;
        } else if (length <= 65535) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(length), 2);
        }
        socket.write(Buffer.concat([header, data]));
      };

      const peer: SignalingPeer = {
        id: peerId,
        userId: identity.userId,
        displayName: identity.displayName,
        meetingId,
        tenant: identity.tenant,
        role: identity.role,
        audioMuted: false,
        videoMuted: false,
        screenSharing: false,
        send: (msg) => {
          sendFrame(Buffer.from(JSON.stringify(msg)));
        },
        close: () => {
          socket.destroy();
        },
        lastSeenAt: Date.now(),
      };

      // Reap sockets that stop answering keepalive pings: an identity is
      // registered in the room (and blocks the meeting from auto-ending)
      // until this fires or the socket errors.
      const reaper = setInterval(() => {
        for (const p of hub.getRoomPeers(meetingId)) {
          if (Date.now() - p.lastSeenAt > idleTimeoutMs) {
            void hub.handlePeerLeave(meetingId, p.id);
            p.close();
          }
        }
      }, idleTimeoutMs);
      reaper.unref?.();

      // Frame parser buffer
      let buffer = Buffer.alloc(0);
      if (head && head.length > 0) {
        buffer = Buffer.concat([buffer, head]);
      }

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > maxFrameBytes) {
          // A frame this large cannot be completed under the cap; the peer
          // is either hostile or broken. Drop it with the partial buffer.
          socket.destroy();
          return;
        }
        while (buffer.length >= 2) {
          const firstByte = buffer[0]!;
          const secondByte = buffer[1]!;
          const opcode = firstByte & 0x0f;
          const masked = Boolean(secondByte & 0x80);
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) return;
            payloadLen = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) return;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          if (payloadLen > maxFrameBytes) {
            socket.destroy();
            return;
          }

          let maskKey: Buffer | null = null;
          if (masked) {
            if (buffer.length < offset + 4) return;
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
          }

          if (buffer.length < offset + payloadLen) return;

          const payload = buffer.subarray(offset, offset + payloadLen);
          buffer = buffer.subarray(offset + payloadLen);

          if (opcode === 0x08) {
            // Close frame
            socket.end();
            return;
          }

          if (opcode === 0x09) {
            // Ping frame -> Pong frame
            const pong = Buffer.alloc(2);
            pong[0] = 0x8a;
            pong[1] = 0;
            socket.write(pong);
            continue;
          }

          if (masked && maskKey) {
            for (let i = 0; i < payload.length; i++) {
              const b = payload[i] ?? 0;
              const k = maskKey[i % 4] ?? 0;
              payload[i] = b ^ k;
            }
          }

          if (opcode === 0x01) {
            // Text frame
            try {
              const text = payload.toString('utf8');
              const msg = JSON.parse(text) as SignalingMessage;
              hub.handleMessage(peerId, msg);
            } catch (err) {
              console.error('[meeting-signaling] JSON decode error:', err);
            }
          }
        }
      });

      socket.on('close', () => {
        clearInterval(reaper);
        void hub.handlePeerLeave(meetingId, peerId);
      });

      socket.on('error', () => {
        clearInterval(reaper);
        void hub.handlePeerLeave(meetingId, peerId);
        socket.destroy();
      });

      // Register peer in room (after handlers are attached so a fast
      // disconnect is still reaped correctly).
      void hub.handlePeerJoin(peer);
    };
  };
}
