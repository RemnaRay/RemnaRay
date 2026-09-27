import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` below is hoisted above this import.
import { WorkerService } from './worker.service';

type Processor = (job: { name: string; data: Record<string, unknown> }) => Promise<unknown>;

// BullMQ stand-in: a job added to `maintenance` is run by the processor the
// worker registered for that queue, as a Worker would pick it up.
const bull = vi.hoisted(() => ({
  processors: new Map<string, Processor>(),
  added: [] as { queue: string; name: string; run: Promise<unknown> }[],
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(queue: string, processor: Processor) {
      bull.processors.set(queue, processor);
    }
    close() {
      return Promise.resolve();
    }
  },
  Queue: class {
    constructor(readonly name: string) {}
    add(name: string, data: Record<string, unknown>) {
      if (this.name === 'maintenance' && name.endsWith('-check')) {
        const run = bull.processors
          .get('maintenance')?.({ name, data })
          .catch(() => undefined);
        bull.added.push({ queue: this.name, name, run: run ?? Promise.resolve() });
      }
      return Promise.resolve({});
    }
    getJobCounts() {
      return Promise.resolve({});
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock('@remnaray/queues', async (original) => ({
  ...(await original<typeof import('@remnaray/queues')>()),
  createRedisConnection: () => ({
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve(),
  }),
}));

describe('the section 19.2 and 20.3 daily checks in the worker', () => {
  const previous = { ...process.env };
  let answers: number[];
  const posted: string[] = [];
  const disk: Record<string, unknown>[] = [];
  const github: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let updatesOn = false;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-25T07:00:00Z'));
    bull.processors.clear();
    bull.added.length = 0;
    posted.length = 0;
    disk.length = 0;
    github.length = 0;
    updates.length = 0;
    updatesOn = false;
    process.env.VALKEY_URL = 'redis://127.0.0.1:6379/0';
    process.env.RR_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'rr-backups-'));
    delete process.env.RR_DOMAIN;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/system/backup-result')) posted.push(url);
        if (url.endsWith('/system/disk-result'))
          disk.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        if (url.endsWith('/system/update-check'))
          return Promise.resolve(new Response(JSON.stringify({ enabled: updatesOn })));
        if (url.startsWith('https://api.github.com/')) {
          github.push(url);
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  tag_name: 'v1.3.0',
                  html_url: 'https://h/v1.3.0',
                  draft: false,
                  prerelease: false,
                },
              ]),
            ),
          );
        }
        if (url.endsWith('/system/update-result'))
          updates.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        const status = answers.shift() ?? 200;
        return Promise.resolve(
          new Response(status === 200 ? '{}' : '{"error":{"code":"SETUP_NOT_COMPLETED"}}', {
            status,
          }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...previous };
  });

  const backupChecks = () => bull.added.filter((job) => job.name === 'maintenance.backup-check');
  const settle = () => Promise.all(bull.added.map((job) => job.run));

  it('asks a check refused while the wizard runs again within minutes, then daily', async () => {
    // The check at start meets 503 SETUP_NOT_COMPLETED (section 17.4).
    answers = [503];
    const worker = new WorkerService();
    await worker.onModuleInit();
    await settle();
    expect(backupChecks()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(backupChecks()).toHaveLength(1);
    // Five minutes on it is asked again, and this time the API records it.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(backupChecks()).toHaveLength(2);
    expect(posted).toHaveLength(2);

    // Recorded: nothing more until a day after the recorded one.
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(backupChecks()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(backupChecks()).toHaveLength(3);
    await worker.onModuleDestroy();
  });

  it('reads the database volume at start and then hourly', async () => {
    answers = [];
    process.env.RR_PGDATA_DIR = process.env.RR_BACKUP_DIR;
    const worker = new WorkerService();
    await worker.onModuleInit();
    await settle();
    const diskChecks = () => bull.added.filter((job) => job.name === 'maintenance.disk-check');
    expect(diskChecks()).toHaveLength(1);
    expect(disk[0]).toMatchObject({ available: true });
    expect((disk[0]?.['totalBytes'] as number) > 0).toBe(true);

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(diskChecks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(diskChecks()).toHaveLength(2);
    await worker.onModuleDestroy();
  });

  it('asks GitHub for releases daily only while admin.check_updates is on (24.6)', async () => {
    answers = [];
    const off = new WorkerService();
    await off.onModuleInit();
    await settle();
    expect(github).toEqual([]);
    expect(updates).toEqual([]);
    await off.onModuleDestroy();

    bull.added.length = 0;
    updatesOn = true;
    const on = new WorkerService();
    await on.onModuleInit();
    await settle();
    expect(github).toEqual([
      'https://api.github.com/repos/RemnaRay/RemnaRay/releases?per_page=100',
    ]);
    expect(updates).toEqual([
      {
        releases: [
          { version: '1.3.0', url: 'https://h/v1.3.0', security: false, publishedAt: null },
        ],
      },
    ]);
    const updateChecks = () => bull.added.filter((job) => job.name === 'maintenance.update-check');
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(updateChecks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(updateChecks()).toHaveLength(2);
    await on.onModuleDestroy();
  });
});
