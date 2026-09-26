import type { QueueName } from '@remnaray/queues';

export type CronJob = { queue: QueueName; name: string; jobId: string };

const pad = (value: number) => String(value).padStart(2, '0');

/** `yyyymmddHHMM` in UTC, the minute key of section 7.3. */
export function minuteStamp(at: Date): string {
  return `${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

/**
 * The every-minute and quarter-hour crons of section 7.3, for the minute
 * `at` falls in. The job id names the cron slot rather than the tick, so the
 * slot runs once however many ticks, restarts or workers add it.
 */
export function cronJobs(at: Date): CronJob[] {
  const slot = new Date(at);
  slot.setUTCMinutes(slot.getUTCMinutes() - (slot.getUTCMinutes() % 15), 0, 0);
  return [
    // FR-024: `active` past `expires_at` becomes `grace` or `expired`.
    {
      queue: 'maintenance',
      name: 'maintenance.subscriptions-expire',
      jobId: `maintenance:subscriptions-expire:${minuteStamp(at)}`,
    },
    // Owner decision F36: reminders of untaken tickets and the auto-close.
    {
      queue: 'maintenance',
      name: 'maintenance.support-sweep',
      jobId: `maintenance:support-sweep:${minuteStamp(at)}`,
    },
    // Section 10.5, cron `*/15 * * * *`.
    { queue: 'panel', name: 'panel.reconcile-all', jobId: `reconcile:${minuteStamp(slot)}` },
  ];
}

/** How soon a refused check is asked again. */
export const CHECK_RETRY_MS = 5 * 60_000;
export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

export type CheckState = { recordedAt?: number; queuedAt?: number };

/**
 * The worker's own checks: `maintenance.tls-check` and
 * `maintenance.backup-check` at start and then daily (sections 19.2, 20.3),
 * `maintenance.disk-check` at start and then hourly (20.3 names no cadence; a
 * volume can fill well inside a day). A period counts from the reading the API
 * recorded, not from the one queued: while the wizard runs every internal call
 * is `503 SETUP_NOT_COMPLETED` (section 17.4), and a check refused then would
 * otherwise leave `/admin/system` without a reading for a whole period. A
 * refused one is asked again every `CHECK_RETRY_MS`.
 */
export function checkDue(now: number, state: CheckState, periodMs: number): boolean {
  if (state.recordedAt !== undefined && now - state.recordedAt < periodMs) return false;
  return state.queuedAt === undefined || now - state.queuedAt >= CHECK_RETRY_MS;
}
