import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

/**
 * Section 10.6 on a real PostgreSQL and the panel mock: the store is the
 * source of truth for expiry, limits and enabled state, so every console
 * change to a subscription queues `panel.sync-user` in its own transaction,
 * and running those syncs brings the panel user in line — the extension, the
 * set plan (with the FR-023 reset ahead of it), the ban (FR-141 disable), the
 * unban and the bulk extension.
 */
test('M4 console changes reach the panel', { timeout: 240_000 }, async () => {
  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start(),
    // The `rr:lock:panel:<userId>` lock of section 10.3.
    new GenericContainer('valkey/valkey:9.1-alpine').withExposedPorts(6379).start(),
  ]);
  let prisma;
  let panel;
  let redis;
  try {
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
      stdio: 'pipe',
    });
    const { createPrismaClient } = await import('../packages/db/dist/index.js');
    const { SubscriptionsRepository } =
      await import('../apps/api/dist/modules/subscriptions/subscriptions.repository.js');
    const { RemnawaveService } =
      await import('../apps/api/dist/modules/remnawave/remnawave.service.js');
    const { AdminUsersService } =
      await import('../apps/api/dist/modules/admin-api/admin-users.service.js');
    const { AdminPaymentsService } =
      await import('../apps/api/dist/modules/admin-api/admin-payments.service.js');
    const { grantInviteeBonus } =
      await import('../apps/api/dist/modules/rewards/referrals.engine.js');
    const { createRemnawaveMock } = await import('../packages/remnawave-mock/dist/index.js');
    const { createRedisConnection } = await import('../packages/queues/dist/index.js');
    redis = createRedisConnection(
      `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`,
    );
    prisma = createPrismaClient(postgres.getConnectionUri());
    panel = createRemnawaveMock();
    const values = {
      'panel.base_url': await panel.listen({ port: 0, host: '127.0.0.1' }),
      'panel.api_token': 'token',
      'panel.extra_headers': {},
      'brand.name': 'Manta',
    };
    const settings = { get: (key) => Promise.resolve(values[key]) };
    const infra = { db: prisma, redis };
    const remnawave = new RemnawaveService(infra, settings);
    const users = new AdminUsersService(infra, settings, remnawave);
    const bulk = new AdminPaymentsService(infra, {}, settings);
    const admin = await prisma.admin.create({
      data: { email: 'owner@example.test', passwordHash: 'x', role: 'admin' },
    });
    const acting = { id: admin.id, role: 'admin' };

    const user = await prisma.user.create({
      data: { telegramId: 996000001n, language: 'ru', referralCode: 'M4SYNC01' },
    });
    await new SubscriptionsRepository(prisma).trial(user.id, {
      trialEnabled: true,
      trialDays: 3,
      trialTrafficGb: 10,
      trialDeviceLimit: 2,
      trialSquads: [],
      graceHours: 0,
    });
    await remnawave.syncUser(user.id, 'trial');
    const panelUser = () => [...panel.users.values()][0];
    // Section 10.3: the plan's slug, or `trial`, in the panel's tag format.
    assert.equal(panelUser().tag, 'TRIAL');
    const expiry = async () =>
      (
        await prisma.subscription.findFirstOrThrow({
          where: { userId: user.id },
          orderBy: { expiresAt: 'desc' },
        })
      ).expiresAt.toISOString();
    const seen = new Set(
      (await prisma.outboxJob.findMany({ select: { id: true } })).map((row) => row.id),
    );
    /** The panel jobs the last action wrote, each of them then performed. */
    const panelJobs = async () => {
      const rows = await prisma.outboxJob.findMany({
        where: { queue: 'panel' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const fresh = rows.filter((row) => !seen.has(row.id));
      for (const job of fresh) {
        seen.add(job.id);
        if (job.name === 'panel.sync-user') await remnawave.syncUser(user.id, job.payload.reason);
        else await remnawave.resetTraffic(user.id, BigInt(job.payload.ifUsedAboveBytes));
      }
      return fresh.map((row) => [row.name, row.payload.reason ?? row.payload.ifUsedAboveBytes]);
    };

    // --- the console's extension ---
    await users.extend(user.id, { days: 10, reason: 'support' }, acting);
    assert.deepEqual(await panelJobs(), [['panel.sync-user', 'admin:extend']]);
    assert.equal(panelUser().expireAt, await expiry());

    // --- set plan: the FR-023 reset ahead of the sync ---
    const plan = await prisma.plan.create({
      data: {
        slug: 'm4-small',
        name: { ru: 'S', en: 'S' },
        durationDays: 30,
        squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
        priceMinor: 9900n,
        trafficLimitBytes: 1024n ** 3n,
      },
    });
    panelUser().userTraffic.usedTrafficBytes = 2 * 1024 ** 3;
    await users.setPlan(user.id, { planId: plan.id, reason: 'support' }, acting);
    assert.deepEqual(await panelJobs(), [
      ['panel.reset-traffic', String(1024n ** 3n)],
      ['panel.sync-user', 'admin:set-plan'],
    ]);
    assert.equal(panelUser().userTraffic.usedTrafficBytes, 0, 'used 2 GB against a 1 GB limit');
    assert.equal(panelUser().trafficLimitBytes, 1024 ** 3);
    assert.equal(panelUser().tag, 'M4_SMALL');
    assert.equal(panelUser().expireAt, await expiry());

    // --- ban disables the panel user (FR-141), unban queues a sync ---
    await users.ban(user.id, { reason: 'abuse' });
    assert.deepEqual(await panelJobs(), [['panel.sync-user', 'admin:ban']]);
    assert.equal(panelUser().status, 'DISABLED');
    await users.unban(user.id, { reason: 'appeal' });
    assert.deepEqual(await panelJobs(), [['panel.sync-user', 'admin:unban']]);

    // --- bulk extension of the revoked subscription makes it live again ---
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { expiresAt: 'desc' },
    });
    await bulk.bulkExtend(
      { subscriptionIds: [subscription.id], days: 5, reason: 'outage' },
      acting,
    );
    assert.deepEqual(await panelJobs(), [['panel.sync-user', 'admin:bulk-extend']]);
    assert.equal(panelUser().expireAt, await expiry());
    assert.equal(panelUser().status, 'ACTIVE', 'the extension made the subscription live again');

    // --- an invitee's bonus days (15.x) create or extend a subscription ---
    const invitee = await prisma.user.create({
      data: { telegramId: 996000002n, language: 'ru', referralCode: 'M4SYNC02' },
    });
    const bonus = {
      enabled: true,
      mode: 'percent_first',
      percent: 10,
      fixedMinor: 0n,
      allMonths: 0,
      inviteeBonus: { type: 'days', value: 3 },
      inviteeBonusTrigger: 'signup',
      holdHours: 0,
      maxRewardsPerDay: 10,
      minSourceAmountMinor: 0n,
    };
    const limits = { days: 3, trafficGb: 10, deviceLimit: 2, squads: [] };
    for (const round of [1, 2]) {
      await prisma.$transaction((tx) => grantInviteeBonus(tx, bonus, invitee.id, limits));
      const rows = await prisma.outboxJob.findMany({
        where: { name: 'panel.sync-user', payload: { path: ['userId'], equals: invitee.id } },
      });
      assert.equal(rows.length, round, `bonus ${String(round)} queued no panel sync`);
      assert.equal(rows.at(-1).payload.reason, 'referral:invitee-bonus');
    }
  } finally {
    await panel?.close();
    redis?.disconnect();
    await prisma?.$disconnect();
    await Promise.all([postgres.stop(), valkey.stop()]);
  }
});
