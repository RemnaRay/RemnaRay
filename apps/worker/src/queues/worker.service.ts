import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { queueJobs, recordTlsExpiry } from '@remnaray/metrics';
import {
  backoffStrategy,
  createRedisConnection,
  QUEUE_PREFIX,
  toJobId,
  type QueueName,
} from '@remnaray/queues';
import { Queue, Worker, type Job } from 'bullmq';

import { backupStatus } from './backup-check';
import { checkDue, cronJobs, DAY_MS, HOUR_MS, type CheckState } from './schedule';
import { diskStatus } from './disk-check';
import { publishedReleases, UPDATE_REPOSITORY } from './update-check';
import { certificateStatus } from './tls-check';
import { workerValkeyUrl } from './worker-config';

type InternalCall = { path: string; body?: unknown };
type Check =
  | 'maintenance.tls-check'
  | 'maintenance.backup-check'
  | 'maintenance.disk-check'
  | 'maintenance.update-check';

/** How often each of the worker's own checks runs once recorded. */
const CHECK_PERIODS: Record<Check, number> = {
  'maintenance.tls-check': DAY_MS,
  'maintenance.backup-check': DAY_MS,
  'maintenance.disk-check': HOUR_MS,
  // Section 24.6: once a day.
  'maintenance.update-check': DAY_MS,
};

/** Section 7.3; `webhooks` (9.8) is not in its table. */
export const CONCURRENCY: Record<QueueName, number> = {
  panel: 2,
  payments: 4,
  notify: 5,
  broadcast: 1,
  maintenance: 1,
  webhooks: 5,
};

/**
 * Section 7.3 queue consumers. The worker owns no domain logic: it calls the
 * internal API, which holds the transactional boundaries.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private workers: { close(): Promise<void> }[] = [];
  private queues: Queue[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private redis?: ReturnType<typeof createRedisConnection>;

  async onModuleInit(): Promise<void> {
    this.redis = createRedisConnection(workerValkeyUrl());
    await this.redis.ping();
    const connection = this.redis;
    // The prefix the outbox relay publishes under. Without it the workers wait
    // on `bull:*` while every relayed job sits in `rr:q:*` for ever.
    const options = { connection, prefix: QUEUE_PREFIX };

    // Section 7.3 concurrency: payments 4, notify 5, broadcast 1, panel 2,
    // maintenance 1. Payments lock the invoice and event rows, notifications
    // are deduplicated by `notification_log`, and a panel write holds the
    // user's `rr:lock:panel:<userId>`.
    this.workers.push(
      new Worker(
        'payments',
        async (job: Job<{ eventId?: string }>) => skipWhileSetup(() => this.call(paymentCall(job))),
        { ...options, concurrency: CONCURRENCY.payments },
      ),
    );
    this.workers.push(
      new Worker(
        'notify',
        async (job: Job<Record<string, unknown>>) =>
          skipWhileSetup(() => this.call(notifyCall(job))),
        { ...options, concurrency: CONCURRENCY.notify },
      ),
    );
    this.workers.push(
      new Worker(
        'broadcast',
        async (job: Job<Record<string, unknown>>) =>
          skipWhileSetup(() =>
            this.call({ path: '/api/internal/v1/broadcasts/chunk', body: job.data }),
          ),
        { ...options, concurrency: CONCURRENCY.broadcast },
      ),
    );
    this.workers.push(
      new Worker(
        'panel',
        async (job: Job<Record<string, unknown>>) =>
          skipWhileSetup(() => this.call(panelCall(job))),
        {
          ...options,
          concurrency: CONCURRENCY.panel,
        },
      ),
    );
    // Section 9.8. Up to ten seconds a delivery on a recipient's answer, so
    // several at once; the retry schedule is the queue package's.
    this.workers.push(
      new Worker(
        'webhooks',
        async (job: Job<Record<string, unknown>>) =>
          skipWhileSetup(() =>
            this.call({
              path:
                job.name === 'webhooks.deliver'
                  ? '/api/internal/v1/webhooks/deliver'
                  : '/api/internal/v1/webhooks/dispatch',
              body: job.data,
            }),
          ),
        { ...options, concurrency: CONCURRENCY.webhooks, settings: { backoffStrategy } },
      ),
    );
    this.workers.push(
      new Worker(
        'maintenance',
        async (job: Job<Record<string, unknown>>) =>
          skipWhileSetup(() =>
            job.name === 'maintenance.tls-check'
              ? this.tlsCheck()
              : job.name === 'maintenance.backup-check'
                ? this.backupCheck()
                : job.name === 'maintenance.disk-check'
                  ? this.diskCheck()
                  : job.name === 'maintenance.update-check'
                    ? this.updateCheck()
                    : this.call(maintenanceCall(job)),
          ),
        { ...options, concurrency: CONCURRENCY.maintenance },
      ),
    );

    const payments = new Queue('payments', options);
    const notify = new Queue('notify', options);
    const maintenance = new Queue('maintenance', options);
    const panel = new Queue('panel', options);
    // Counted, not consumed from here: section 9.9 wants every queue's depth,
    // and a queue the worker only reads counts is cheap to hold open.
    const counted = [
      payments,
      notify,
      maintenance,
      new Queue('broadcast', options),
      panel,
      new Queue('webhooks', options),
    ];
    this.queues.push(...counted);

    // Section 9.9 `rr_queue_jobs{queue,state}`. A gauge, sampled: BullMQ keeps
    // the counts in Valkey and asking on every scrape would make the scrape
    // the load.
    const sampleQueues = () => {
      for (const queue of counted)
        void queue
          .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
          .then((counts) => {
            for (const [state, value] of Object.entries(counts))
              queueJobs.set({ queue: queue.name, state }, value);
          })
          .catch(() => undefined);
    };
    sampleQueues();
    this.timers.push(setInterval(sampleQueues, 15_000));

    let tick = 0;
    this.timers.push(
      setInterval(() => {
        tick += 1;
        const stamp = String(Date.now());
        void payments.add(
          'payments.poll-pending',
          {},
          { jobId: toJobId(`payments:poll-pending:${stamp}`) },
        );
        if (tick % 2 === 0)
          void payments.add('payments.expire', {}, { jobId: toJobId(`payments:expire:${stamp}`) });
      }, 30_000),
    );
    // Section 16.1: a ten-minute window is precise enough, and
    // `notification_log` keeps a repeated scan from sending twice.
    this.timers.push(
      setInterval(() => {
        const stamp = String(Date.now());
        void notify.add(
          'notify.scan-expiring',
          {},
          { jobId: toJobId(`notify:scan-expiring:${stamp}`) },
        );
        void maintenance.add(
          'maintenance.referral-release',
          {},
          { jobId: toJobId(`maintenance:referral-release:${stamp}`) },
        );
      }, 10 * 60_000),
    );
    // Section 7.3 minute and quarter-hour crons. A finished job is kept past
    // its fifteen-minute slot: BullMQ ignores an id only while the job
    // exists, and the kept id is what makes the slot run once.
    const byName: Partial<Record<QueueName, Queue>> = { maintenance, panel };
    const queueCron = () => {
      for (const job of cronJobs(new Date()))
        void byName[job.queue]
          ?.add(
            job.name,
            {},
            {
              jobId: toJobId(job.jobId),
              removeOnComplete: { age: 24 * 60 * 60 },
              removeOnFail: { age: 7 * 24 * 60 * 60 },
            },
          )
          .catch((error: unknown) => {
            this.logger.warn(`${job.name} was not queued: ${String(error)}`);
          });
    };
    queueCron();
    this.timers.push(setInterval(queueCron, 60_000));
    // Section 19.2: the certificate is checked at start and once a day.
    // Section 20.3: the same daily cadence for the backup status, and the
    // database volume hourly. A check the API refused, as it refuses
    // everything while the wizard runs, is asked again within minutes.
    const queueChecks = () => {
      const now = Date.now();
      for (const [name, state] of Object.entries(this.checks) as [Check, CheckState][]) {
        if (!checkDue(now, state, CHECK_PERIODS[name])) continue;
        state.queuedAt = now;
        void maintenance
          .add(name, {}, { jobId: toJobId(`${name.replace('.', ':')}:${String(now)}`) })
          .catch((error: unknown) => {
            this.logger.warn(`${name} was not queued: ${String(error)}`);
          });
      }
    };
    queueChecks();
    this.timers.push(setInterval(queueChecks, 60_000));
  }

  /** When each check was last queued and last recorded by the API. */
  private readonly checks: Record<Check, CheckState> = {
    'maintenance.tls-check': {},
    'maintenance.backup-check': {},
    'maintenance.disk-check': {},
    'maintenance.update-check': {},
  };

  /**
   * The only maintenance job the worker performs itself: section 19.2 wants the
   * TLS handshake made from outside the API, and the result is reported back so
   * the alert and the `/admin/system` reading stay in one place.
   */
  private async tlsCheck(): Promise<unknown> {
    const domain = process.env.RR_DOMAIN ?? '';
    if (!domain) {
      this.recorded('maintenance.tls-check');
      return { skipped: 'RR_DOMAIN is not set' };
    }
    const [host, port] = domain.split(':');
    const status = await certificateStatus(host ?? domain, port ? Number(port) : 443);
    recordTlsExpiry(status.expiresAt);
    const result = await this.call({ path: '/api/internal/v1/system/tls-result', body: status });
    this.recorded('maintenance.tls-check');
    return result;
  }

  /** Section 20.3: `.last-status` is written by the `backup` container. */
  private async backupCheck(): Promise<unknown> {
    const result = await this.call({
      path: '/api/internal/v1/system/backup-result',
      body: backupStatus(process.env.RR_BACKUP_DIR ?? '/backups'),
    });
    this.recorded('maintenance.backup-check');
    return result;
  }

  /** Section 20.3: the database volume, mounted read-only at `RR_PGDATA_DIR`. */
  private async diskCheck(): Promise<unknown> {
    const result = await this.call({
      path: '/api/internal/v1/system/disk-result',
      body: diskStatus(process.env.RR_PGDATA_DIR ?? '/pgdata'),
    });
    this.recorded('maintenance.disk-check');
    return result;
  }

  /**
   * Section 24.6: which releases GitHub has, unless `admin.check_updates` is
   * off — then GitHub is not asked at all. A failed lookup is reported, so
   * `/admin/system` says so, and left unrecorded to be tried again.
   */
  private async updateCheck(): Promise<unknown> {
    const { enabled } = (await this.call({ path: '/api/internal/v1/system/update-check' })) as {
      enabled?: unknown;
    };
    if (enabled !== true) {
      this.recorded('maintenance.update-check');
      return { skipped: 'admin.check_updates is off' };
    }
    try {
      const releases = await publishedReleases(
        process.env.RR_UPDATE_REPOSITORY || UPDATE_REPOSITORY,
      );
      const result = await this.call({
        path: '/api/internal/v1/system/update-result',
        body: { releases },
      });
      this.recorded('maintenance.update-check');
      return result;
    } catch (error) {
      await this.call({
        path: '/api/internal/v1/system/update-result',
        body: { releases: [], error: String(error).slice(0, 200) },
      }).catch(() => undefined);
      throw error;
    }
  }

  private recorded(name: Check): void {
    this.checks[name].recordedAt = Date.now();
  }

  async onModuleDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all(this.queues.map((queue) => queue.close()));
    if (this.redis) await this.redis.quit();
  }

  private async call({ path, body }: InternalCall): Promise<unknown> {
    const base = process.env.RR_API_URL ?? 'http://api:3000';
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'X-Internal-Token': process.env.RR_INTERNAL_TOKEN ?? '',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text();
      if (setupPending(response.status, text)) throw new SetupPendingError(path);
      this.logger.warn(`${path} failed with ${String(response.status)}`);
      throw new Error(`job failed: ${String(response.status)} ${text.slice(0, 200)}`);
    }
    // An endpoint that returns nothing answers with an empty body; parsing it
    // failed the job after the API had done the work (R49).
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }
}

/** The API refused the call because the setup wizard has not finished. */
export class SetupPendingError extends Error {
  constructor(path: string) {
    super(`${path}: SETUP_NOT_COMPLETED`);
    this.name = 'SetupPendingError';
  }
}

/** Section 17.4: until the wizard finishes, every internal call is this 503. */
export function setupPending(status: number, body: string): boolean {
  if (status !== 503) return false;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    return (parsed.error?.code ?? parsed.code) === 'SETUP_NOT_COMPLETED';
  } catch {
    return false;
  }
}

/**
 * A job that runs while the shop is still being set up has nothing to act on
 * (there are no users, plans or payments yet): it completes as skipped rather
 * than failing, so the failed queue shows real failures. A daily check skipped
 * this way is not recorded, so it is asked again minutes after setup.
 */
export async function skipWhileSetup<T>(
  task: () => Promise<T>,
): Promise<T | { skipped: 'SETUP_NOT_COMPLETED' }> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof SetupPendingError) return { skipped: 'SETUP_NOT_COMPLETED' };
    throw error;
  }
}

function paymentCall(job: Job<{ eventId?: string }>): InternalCall {
  if (job.name === 'payments.apply-event' && job.data.eventId)
    return { path: `/api/internal/v1/payments/events/${job.data.eventId}/apply` };
  if (job.name === 'payments.poll-pending')
    return { path: '/api/internal/v1/payments/poll-pending' };
  return { path: '/api/internal/v1/payments/expire' };
}

function notifyCall(job: Job<Record<string, unknown>>): InternalCall {
  if (job.name === 'notify.alert') return { path: '/api/internal/v1/notify/alert', body: job.data };
  if (job.name === 'notify.scan-expiring') return { path: '/api/internal/v1/notify/scan-expiring' };
  return { path: '/api/internal/v1/notify/send', body: job.data };
}

export function panelCall(job: Pick<Job<Record<string, unknown>>, 'name' | 'data'>): InternalCall {
  switch (job.name) {
    case 'panel.sync-user':
      return { path: '/api/internal/v1/remnawave/sync-user', body: job.data };
    case 'panel.reset-traffic':
      return { path: '/api/internal/v1/remnawave/reset-traffic', body: job.data };
    case 'panel.delete-user':
      return { path: '/api/internal/v1/remnawave/delete-user', body: job.data };
    case 'panel.reconcile-all':
      return { path: '/api/internal/v1/remnawave/reconcile' };
    default:
      // A job this worker does not know fails rather than running something
      // else: every panel job used to fall through to a full reconciliation.
      throw new Error(`unknown panel job ${job.name}`);
  }
}

export function maintenanceCall(job: Pick<Job<Record<string, unknown>>, 'name'>): InternalCall {
  if (job.name === 'maintenance.support-sweep') return { path: '/api/internal/v1/support/sweep' };
  if (job.name === 'maintenance.referral-release')
    return { path: '/api/internal/v1/rewards/release-held' };
  return { path: '/api/internal/v1/subscriptions/expire' };
}
