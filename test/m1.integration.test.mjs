import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

test(
  'M1 ledger and subscriptions work against PostgreSQL 18 and Valkey 9.1',
  { timeout: 240_000 },
  async () => {
    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    // Closed in `finally`: a client left open after a failed assertion keeps
    // reconnecting to the stopped container, and the run never ends.
    let redis;
    let relay;
    try {
      execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
      const { createPrismaClient } = await import('../packages/db/dist/index.js');
      const { LedgerRepository } =
        await import('../apps/api/dist/modules/ledger/ledger.repository.js');
      const { SubscriptionsRepository } =
        await import('../apps/api/dist/modules/subscriptions/subscriptions.repository.js');
      const prisma = createPrismaClient(databaseUrl);
      const ledger = new LedgerRepository(prisma);
      const subscriptions = new SubscriptionsRepository(prisma);
      const user = await prisma.user.create({
        data: { telegramId: 991_000_001n, language: 'ru', referralCode: 'TCM1USER' },
      });
      const subscriptionUser = await prisma.user.create({
        data: { telegramId: 991_000_002n, language: 'ru', referralCode: 'TCM1SUBS' },
      });
      const plan = await prisma.plan.create({
        data: {
          slug: 'tc-m1',
          name: { ru: 'M1', en: 'M1' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });

      await ledger.post({
        userId: user.id,
        type: 'topup',
        amountMinor: 10000n,
        currency: 'RUB',
        debit: { kind: 'revenue' },
        credit: { kind: 'user', userId: user.id },
      });
      const deductions = await Promise.all(
        Array.from({ length: 10 }, () =>
          ledger
            .post({
              userId: user.id,
              type: 'purchase',
              amountMinor: 6000n,
              currency: 'RUB',
              debit: { kind: 'user', userId: user.id },
              credit: { kind: 'revenue' },
            })
            .then(
              () => true,
              () => false,
            ),
        ),
      );
      assert.equal(deductions.filter(Boolean).length, 1);
      assert.equal(await ledger.available(user.id), 4000n);

      // Section 8.1 (repair queue L-20): the append-only tables refuse a
      // DELETE loudly — `payment_events` used to skip the row and report
      // nothing — and refuse TRUNCATE, which row triggers never see.
      await prisma.paymentEvent.create({
        data: {
          provider: 'mock',
          externalId: 'l20-event',
          type: 'paid',
          raw: {},
          headers: {},
          signatureOk: true,
        },
      });
      const immutable = async (sql) => {
        await assert.rejects(prisma.$executeRawUnsafe(sql), (error) => {
          assert.match(String(error.message), /immutable/u, sql);
          return true;
        });
      };
      await immutable(`DELETE FROM payment_events WHERE external_id = 'l20-event'`);
      assert.equal(await prisma.paymentEvent.count({ where: { externalId: 'l20-event' } }), 1);
      for (const table of [
        'payment_events',
        'transactions',
        'ledger_entries',
        'audit_log',
        'notification_log',
      ])
        await immutable(`TRUNCATE ${table} CASCADE`);
      assert.equal(await prisma.paymentEvent.count({ where: { externalId: 'l20-event' } }), 1);

      const trial = await subscriptions.trial(subscriptionUser.id, {
        trialEnabled: true,
        trialDays: 3,
        trialTrafficGb: 10,
        trialDeviceLimit: 1,
        trialSquads: [],
        graceHours: 0,
      });
      assert.equal(trial.source, 'trial');
      assert.equal(trial.status, 'provisioning', 'EX-01: live once the panel has the user');
      const activated = await subscriptions.activate(subscriptionUser.id, plan.id, 'purchase');
      const renewed = await subscriptions.activate(subscriptionUser.id, plan.id, 'purchase');
      assert.equal(renewed.status, 'active');
      assert.ok(Date.parse(renewed.expiresAt) > Date.parse(activated.expiresAt));
      assert.equal(await subscriptions.expire(new Date(Date.now() + 366 * 86_400_000), 0), 1);
      // Section 9.8: each of those wrote its event in its own transaction. The
      // trial is `provisioning` until the panel has the user (EX-01), so its
      // activation event comes from the sync, which this test does not run.
      const events = await prisma.outboxJob.findMany({
        where: { name: { in: ['webhooks.dispatch', 'panel.sync-user'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      assert.deepEqual(
        events.map((row) => row.payload.type ?? row.name),
        [
          'panel.sync-user',
          'subscription.activated',
          'subscription.activated',
          'subscription.expired',
        ],
      );

      // Section 7.3: the outbox has to reach a worker. Two defects made that
      // impossible and neither side complained — BullMQ refuses a custom job
      // id containing its own separator, which every identifier here carries,
      // and the relay published under `rr:q` while the workers waited on
      // `bull`. Both are checked by running one job through for real.
      const { OutboxRelay, OutboxWriter, QUEUE_PREFIX, createRedisConnection } =
        await import('../packages/queues/dist/index.js');
      // Resolved through the worker, which owns the dependency (section 6.1).
      const { Worker } = await import('../apps/worker/node_modules/bullmq/dist/cjs/index.js');
      const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
      redis = createRedisConnection(valkeyUrl);
      relay = new OutboxRelay(prisma, redis);
      await prisma.$transaction(async (transaction) => {
        await new OutboxWriter().enqueue(transaction, {
          queue: 'notify',
          name: 'notify.send',
          payload: { userId: user.id },
          jobId: `notify:sub.activated:${user.id}`,
        });
      });
      const relayed = await relay.runOnce();
      assert.equal(relayed.published, events.length + 1, 'the relay published nothing');
      assert.equal(relayed.remaining, 0);

      const consumed = new Promise((resolve) => {
        const worker = new Worker('notify', (job) => Promise.resolve(job.id), {
          connection: { host: valkey.getHost(), port: valkey.getMappedPort(6379) },
          prefix: QUEUE_PREFIX,
        });
        worker.on('completed', (job) => {
          void worker.close().then(() => {
            resolve(job.id);
          });
        });
      });
      assert.equal(
        await consumed,
        `notify-sub.activated-${user.id}`,
        'the worker never received the relayed job',
      );

      // Section 7.3 `panel.sync-user`: `jobId = sync:<userId>`, re-queueing
      // replaces. The shared id used to be the BullMQ id, so the finished
      // first sync, kept by `removeOnComplete`, swallowed every renewal.
      // The trial's own sync (EX-01) was relayed above; it is another user's.
      const { Queue } = await import('../apps/worker/node_modules/bullmq/dist/cjs/index.js');
      const panelQueue = new Queue('panel', { connection: redis, prefix: QUEUE_PREFIX });
      await panelQueue.drain();
      await panelQueue.close();
      const runs = [];
      let hold;
      let failNext = false;
      let release;
      const panelWorker = new Worker(
        'panel',
        async (job) => {
          runs.push({ id: job.id, attempt: job.attemptsMade, reason: job.data.reason });
          if (failNext) {
            failNext = false;
            throw new Error('panel unavailable');
          }
          if (hold) await hold;
        },
        {
          connection: { host: valkey.getHost(), port: valkey.getMappedPort(6379) },
          prefix: QUEUE_PREFIX,
        },
      );
      try {
        const sync = async (reason) => {
          await prisma.$transaction((transaction) =>
            new OutboxWriter().enqueue(transaction, {
              queue: 'panel',
              name: 'panel.sync-user',
              payload: { userId: user.id, reason },
              jobId: `sync:${user.id}`,
            }),
          );
          await relay.runOnce();
        };
        const until = async (predicate) => {
          for (let waited = 0; waited < 30_000 && !predicate(); waited += 100) await delay(100);
          assert.ok(predicate(), `timed out: ${JSON.stringify(runs)}`);
        };
        await sync('paid');
        await until(() => runs.length === 1);
        await delay(300);
        await sync('renewal');
        await until(() => runs.length === 2);
        assert.equal(runs[1].reason, 'renewal', 'a later sync of the same user was dropped');

        // Requested while one runs: the running sync may have read old state,
        // so exactly one more runs after it, with the latest request.
        hold = new Promise((resolve) => (release = resolve));
        await sync('admin:ban');
        await until(() => runs.length === 3);
        await sync('admin:unban');
        await sync('paid-again');
        hold = undefined;
        release();
        await until(() => runs.length === 4);
        await delay(1_000);
        assert.equal(runs.length, 4, JSON.stringify(runs));
        assert.equal(runs[3].reason, 'paid-again');

        // Ten attempts with backoff: a failure is retried, not dropped.
        failNext = true;
        await sync('retry');
        await until(() => runs.length === 6);
        assert.deepEqual(
          runs.slice(4).map((run) => [run.id, run.attempt]),
          [
            [runs[4].id, 0],
            [runs[4].id, 1],
          ],
        );
      } finally {
        release?.();
        await panelWorker.close(true);
      }

      await prisma.$disconnect();
    } finally {
      redis?.disconnect();
      await relay?.close();
      await valkey.stop();
      await postgres.stop();
    }
  },
);
