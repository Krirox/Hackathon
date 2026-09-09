/**
 * Substrate, part 1 (TODO §0.5): the scheduler we stopped inheriting.
 *
 * Crons, watches, and inbound webhooks with rate budgets. Deliberately
 * small (no Slack coupling): a registry with per-job daily caps plus a
 * webhook intake with per-source rate limits and shared-secret auth. Time
 * is injected so tests never sleep.
 */

export class SchedulerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[scheduler:${code}] ${message}`);
  }
}

export interface CronJob {
  name: string;
  scope: string;
  intervalMs: number;
  maxFiresPerDay: number;
  handler: () => void | Promise<void>;
}

export interface WebhookDelivery {
  source: string;
  receivedAt: number;
  payload: unknown;
}

interface CronState extends CronJob {
  lastFire: number | null;
  firesByDay: Record<string, number>;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class Scheduler {
  private crons = new Map<string, CronState>();
  private deliveries: WebhookDelivery[] = [];
  private hits: { source: string; minute: number }[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly webhookSecret: string | null = null,
    private readonly maxWebhooksPerSourcePerMinute = 60,
  ) {}

  register(job: CronJob): void {
    if (this.crons.has(job.name)) throw new SchedulerError('DUP_CRON', `cron "${job.name}" already registered`);
    if (job.intervalMs <= 0) throw new SchedulerError('BAD_INTERVAL', 'interval must be positive');
    this.crons.set(job.name, { ...job, lastFire: null, firesByDay: {} });
  }

  unregister(name: string): void {
    this.crons.delete(name);
  }

  /** Fire every due job whose daily cap is unspent. Returns fired names. */
  async tick(): Promise<string[]> {
    const t = this.now();
    const day = dayOf(t);
    const fired: string[] = [];
    for (const job of this.crons.values()) {
      const spent = job.firesByDay[day] ?? 0;
      if (spent >= job.maxFiresPerDay) continue;
      if (job.lastFire !== null && t - job.lastFire < job.intervalMs) continue;
      job.lastFire = t;
      job.firesByDay[day] = spent + 1;
      await job.handler();
      fired.push(job.name);
    }
    return fired;
  }

  /** Inbound webhook: authenticate, rate-limit, record. Delivery effects belong to the handler layer. */
  webhook(source: string, token: string | null, payload: unknown): { accepted: boolean; reason: string } {
    if (this.webhookSecret !== null && token !== this.webhookSecret) {
      return { accepted: false, reason: 'bad webhook secret' };
    }
    const t = this.now();
    const minute = Math.floor(t / 60_000);
    this.hits = this.hits.filter((h) => h.minute === minute);
    const hits = this.hits.filter((h) => h.source === source).length;
    if (hits >= this.maxWebhooksPerSourcePerMinute) {
      return { accepted: false, reason: `rate budget exceeded for ${source}` };
    }
    this.hits.push({ source, minute });
    this.deliveries.push({ source, receivedAt: t, payload });
    return { accepted: true, reason: 'recorded' };
  }

  deliveriesFrom(source: string): WebhookDelivery[] {
    return this.deliveries.filter((d) => d.source === source);
  }
}
