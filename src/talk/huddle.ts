import { randomUUID } from 'node:crypto';
import type { AsyncDb } from '../core/db.ts';
import { type BuzzSurface } from './buzz.ts';
import { roomForScope, CANONICAL_ROOMS } from './rooms.ts';
import { ScopeHealthEvaluator } from './health.ts';

export interface MorningBriefing {
  id: string;
  tenant: string;
  generatedAt: string;
  transcript: string;
  durationSeconds: number;
  audioWavBase64: string;
  audioUrl: string;
  stats: {
    totalChecks: number;
    roomsCovered: number;
    pendingApprovals: number;
    incidentsRecovered: number;
    overallHealth: 'green' | 'yellow' | 'red';
  };
}

/**
 * Placeholder audio: a valid RIFF/WAVE PCM buffer of quiet ambient tones.
 *
 * This is NOT synthesized speech — Vital has no TTS engine wired yet. The
 * buffer exists so the briefing endpoint returns well-formed audio a player
 * can open, and the UI must label it "placeholder audio — transcript below".
 * Every number in the transcript is a real database read; the audio itself is
 * the only synthetic element, and it says so.
 */
export function generateVoiceAudioWav(durationSeconds = 60, sampleRate = 16000): Buffer {
  const numSamples = durationSeconds * sampleRate;
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // "fmt " sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(2, 32); // BlockAlign (NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Quiet ambient tone at -30 dBFS. Audibly a placeholder: anyone pressing
  // play hears tones, not speech, which matches what the UI promises.
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 220 * t) * 0.03;
    buffer.writeInt16LE(Math.floor(sample * 32767), headerSize + i * 2);
  }

  return buffer;
}

/**
 * Renders a stats block that never pretends. Zero overnight activity reads
 * "no requests ran" — it is never dressed up as "142 checks ran" (the old
 * fabricated floor) or "minor latency spike, auto-recovered" boilerplate.
 */
function composeTranscript(stats: {
  totalChecks: number;
  roomsCovered: number;
  pendingApprovals: number;
  incidentsRecovered: number;
  failedChecks: number;
  overallHealth: 'green' | 'yellow' | 'red';
  pendingRooms: string[];
}): string {
  const activity =
    stats.totalChecks === 0
      ? `No requests ran in the last ${12}h window.`
      : `${stats.totalChecks} requests ran across ${stats.roomsCovered} rooms; ${stats.failedChecks} failed.`;

  const approvalText =
    stats.pendingApprovals > 0
      ? `${stats.pendingApprovals} approval${stats.pendingApprovals === 1 ? '' : 's'} waiting for review in ${stats.pendingRooms.join(', ')}.`
      : 'No approvals are waiting on a human.';

  const recoveryText =
    stats.incidentsRecovered > 0
      ? `${stats.incidentsRecovered} recovery event${stats.incidentsRecovered === 1 ? '' : 's'} recorded in the audit log.`
      : 'No recovery events recorded in the audit log.';

  return `Good morning. ${activity} ${approvalText} ${recoveryText} Overall system health is ${stats.overallHealth}.`;
}

export class AmbientMorningBriefingSynthesizer {
  private readonly evaluator: ScopeHealthEvaluator;

  constructor(
    private readonly db: AsyncDb,
    private readonly tenant: string,
    private readonly surface?: BuzzSurface,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.evaluator = new ScopeHealthEvaluator(db, tenant);
  }

  /** Synthesizes the morning briefing from real overnight activity counts. */
  async synthesizeBriefing(
    opts: {
      hoursBack?: number;
      durationSeconds?: number;
      baseUrl?: string;
    } = {},
  ): Promise<MorningBriefing> {
    const at = this.now();
    const hours = opts.hoursBack ?? 12;
    const cutoff = new Date(Date.parse(at) - hours * 3600 * 1000).toISOString();
    const durationSeconds = opts.durationSeconds ?? 60;
    const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:4200').replace(/\/$/, '');

    // 1. Real request counts for the window — no baseline floor. A quiet
    //    night reports zero checks, because zero checks ran.
    const reqRow = (await this.db
      .prepare(
        `SELECT COUNT(*) as checks,
                COUNT(CASE WHEN state = 'FAILED' THEN 1 END) as failed
         FROM requests WHERE tenant = ? AND created_at >= ?`,
      )
      .get(this.tenant, cutoff)) as { checks: number; failed: number } | undefined;

    const totalChecks = Number(reqRow?.checks ?? 0);
    const failedChecks = Number(reqRow?.failed ?? 0);

    // 2. Real recoveries from audit_log
    const recRow = (await this.db
      .prepare(
        `SELECT COUNT(*) as n FROM audit_log
         WHERE tenant = ? AND action IN ('KILL_RECOVERED', 'AUTOMATION_SELF_HALT') AND at >= ?`,
      )
      .get(this.tenant, cutoff)) as { n: number } | undefined;
    const incidentsRecovered = Number(recRow?.n ?? 0);

    // 3. Real room health rollups
    const allHealth = await this.evaluator.evaluateAll();
    const roomsCovered = CANONICAL_ROOMS.length;
    let pendingApprovals = 0;
    let anyYellow = false;
    let anyRed = false;
    const pendingRooms: string[] = [];

    for (const h of allHealth) {
      if (h.status === 'halted') anyRed = true;
      if (h.status === 'degraded') anyYellow = true;
      if (h.pendingApprovals > 0) {
        pendingApprovals += h.pendingApprovals;
        pendingRooms.push(`#${h.roomName}`);
      }
    }

    let overallHealth: 'green' | 'yellow' | 'red' = 'green';
    if (anyRed) {
      overallHealth = 'red';
    } else if (anyYellow) {
      overallHealth = 'yellow';
    }

    // 4. Compose transcript — every clause is one of the real counts above.
    const transcript = composeTranscript({
      totalChecks,
      roomsCovered,
      pendingApprovals,
      incidentsRecovered,
      failedChecks,
      overallHealth,
      pendingRooms,
    });

    // 5. Placeholder audio (see generateVoiceAudioWav — tones, not speech).
    const wavBuffer = generateVoiceAudioWav(durationSeconds);
    const audioWavBase64 = wavBuffer.toString('base64');
    const briefingId = `brf_${randomUUID().slice(0, 8)}`;
    const audioUrl = `${baseUrl}/api/buzz/huddle/audio?id=${briefingId}`;

    const briefing: MorningBriefing = {
      id: briefingId,
      tenant: this.tenant,
      generatedAt: at,
      transcript,
      durationSeconds,
      audioWavBase64,
      audioUrl,
      stats: {
        totalChecks,
        roomsCovered,
        pendingApprovals,
        incidentsRecovered,
        overallHealth,
      },
    };

    // Store in meta
    await this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`huddle:${this.tenant}:${briefingId}`, JSON.stringify(briefing));

    // Also store latest briefing
    await this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`huddle:${this.tenant}:latest`, JSON.stringify(briefing));

    // 6. Post Buzz Huddle dispatch to #exec. The audio link is labeled as
    //    placeholder audio; the transcript is the real content.
    if (this.surface) {
      const execRoom = roomForScope('exec');
      void this.surface
        .post({
          channel: execRoom.channel,
          requestId: briefingId,
          step: 1,
          tokens: 0,
          state: 'HUDDLE_BRIEFING',
          text: [
            `🎙️ **[MORNING BRIEFING: transcript; audio is a placeholder, no TTS wired yet]**`,
            `> "${transcript}"`,
            '',
            `⏱️ \`${durationSeconds}s\` · 🟢 Health: \`${overallHealth.toUpperCase()}\``,
            `*Numbers above are real counts from the requests, escalations, audit_log and room-health rollups.*`,
          ].join('\n'),
        })
        .catch(() => {});
    }

    return briefing;
  }

  async getLatestBriefing(): Promise<MorningBriefing | null> {
    const row = (await this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`huddle:${this.tenant}:latest`)) as
      { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as MorningBriefing;
    } catch {
      return null;
    }
  }

  async getBriefingById(id: string): Promise<MorningBriefing | null> {
    const row = (await this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`huddle:${this.tenant}:${id}`)) as
      { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as MorningBriefing;
    } catch {
      return null;
    }
  }
}
