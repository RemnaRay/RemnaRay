import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Repair queue 2026-09-27, package 1, on a real database: money a provider
 * has taken always reaches the customer, whatever happened to the plan or
 * to the first apply.
 */
test('M2 payment recovery: taken money is never lost', { timeout: 300_000 }, async (t) => {
  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('remnaray')
    .withUsername('remnaray')
    .withPassword('remnaray')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  try {
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    const { createPrismaClient } = await import('../packages/db/dist/index.js');
    const { PaymentsRepository } =
      await import('../apps/api/dist/modules/payments/payments.repository.js');
    const { PaymentsService } =
      await import('../apps/api/dist/modules/payments/payments.service.js');
    const { PaymentProviderRegistry } =
      await import('../apps/api/dist/modules/payments/payments.registry.js');
    const { MockPaymentProvider } = await import('../packages/payments-mock/dist/index.js');
    const prisma = createPrismaClient(databaseUrl);
    const registry = new PaymentProviderRegistry();
    registry.register(new MockPaymentProvider());
    const repository = new PaymentsRepository(prisma);
    const service = new PaymentsService({ db: prisma }, repository, registry);
    let serial = 0;
    const customer = () => {
      serial += 1;
      return prisma.user.create({
        data: {
          telegramId: 993000000n + BigInt(serial),
          language: 'ru',
          referralCode: `M2REC${String(serial).padStart(3, '0')}`,
        },
      });
    };
    const plan = (slug, priceMinor) =>
      prisma.plan.create({
        data: {
          slug,
          name: { ru: slug, en: slug },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor,
        },
      });
    const paid = (invoice, eventId, amount) => {
      const body = JSON.stringify({
        eventId,
        providerInvoiceId: invoice.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: amount,
      });
      return service.receiveWebhook(
        'mock',
        Buffer.from(body),
        { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex') },
        '127.0.0.1',
      );
    };
    const balanceOf = async (userId) =>
      (await prisma.account.findFirst({ where: { kind: 'user', userId } }))?.balanceMinor ?? 0n;

    await t.test('P-1: a payment for a plan taken off sale goes to the balance', async () => {
      const user = await customer();
      const offSale = await plan('m2-off-sale', 29900n);
      const invoice = await service.createInvoice({
        userId: user.id,
        kind: 'purchase',
        planId: offSale.id,
        provider: 'mock',
        idempotencyKey: 'm2-rec-off-sale',
      });
      // The administrator takes the plan off sale while the invoice is open.
      await prisma.plan.update({ where: { id: offSale.id }, data: { isActive: false } });

      await paid(invoice, 'off-sale-1', '29900');

      // The whole apply used to roll back on PLAN_UNAVAILABLE, every retry
      // too: the invoice stayed pending and the money reached nobody.
      assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid');
      const rows = await prisma.transaction.findMany({ where: { invoiceId: invoice.id } });
      assert.deepEqual(
        rows.map((row) => [row.type, row.amountMinor]),
        [['topup', 29900n]],
      );
      assert.equal(await balanceOf(user.id), 29900n);
      const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: rows[0].id } });
      const kinds = new Map(
        (await prisma.account.findMany()).map((account) => [account.id, account.kind]),
      );
      assert.deepEqual(
        entries.map((entry) => [kinds.get(entry.debitAccountId), kinds.get(entry.creditAccountId)]),
        [['provider_clearing', 'user']],
      );
      assert.equal(await prisma.subscription.count({ where: { userId: user.id } }), 0);
      assert.equal(
        await prisma.outboxJob.count({
          where: { jobId: `alert:payment.plan_unavailable:${invoice.id}` },
        }),
        1,
      );
      assert.equal(
        await prisma.outboxJob.count({
          where: { jobId: `notify:payment.to_balance:${invoice.id}` },
        }),
        1,
      );
      const event = await prisma.paymentEvent.findFirst({ where: { invoiceId: invoice.id } });
      assert.ok(event.processedAt);
    });

    // R74: two transactions that each wait for a row the other holds is a
    // deadlock PostgreSQL breaks by aborting one (40P01). Transaction B holds
    // `first`, waits until the apply is blocked on a row lock, then locks
    // `second` the way another money path would. Both must finish.
    const lockAccount = (tx, id) =>
      tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}::uuid FOR UPDATE`;
    const applyBlocked = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await prisma.$queryRaw`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row.waiting > 0) return;
        await delay(50);
      }
      throw new Error('the apply never waited for a lock');
    };
    const contend = async (apply, first, second) => {
      let applying;
      const holder = prisma.$transaction(
        async (tx) => {
          await lockAccount(tx, first);
          applying = apply();
          applying.catch(() => undefined);
          await applyBlocked();
          await lockAccount(tx, second);
        },
        { timeout: 30_000 },
      );
      await holder.catch(() => undefined);
      const [held, applied] = await Promise.allSettled([holder, applying]);
      return { held, applied };
    };
    const accountOf = async (userId) => {
      await prisma.$executeRaw`INSERT INTO accounts (kind, user_id, currency) VALUES ('user', ${userId}::uuid, 'RUB') ON CONFLICT DO NOTHING`;
      return (await prisma.account.findFirst({ where: { kind: 'user', userId } })).id;
    };
    const storedPayment = async (repo, userId, provider, kind, planId, amountMinor) => {
      const invoice = await prisma.invoice.create({
        data: {
          userId,
          kind,
          planId,
          provider,
          status: 'pending',
          amountMinor,
          currency: 'RUB',
          idempotencyKey: `m2-rec-${provider}-${userId}`,
          providerInvoiceId: `m2-rec-${provider}-${userId}`,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      const stored = await repo.insertEvent({
        provider,
        externalId: `m2-rec-${invoice.id}`,
        invoiceId: invoice.id,
        event: {
          eventId: `m2-rec-${invoice.id}`,
          providerInvoiceId: invoice.providerInvoiceId,
          type: 'paid',
          paidAmountMinorRub: amountMinor,
        },
        raw: {
          providerInvoiceId: invoice.providerInvoiceId,
          paidAmountMinorRub: String(amountMinor),
        },
        headers: {},
        signatureOk: true,
      });
      return { invoice, eventId: stored.id };
    };

    await t.test(
      'R74: a purchase does not deadlock with a balance purchase on revenue',
      async () => {
        const user = await customer();
        const bought = await plan('m2-lock-revenue', 10000n);
        const payer = await accountOf(user.id);
        const revenue = (await prisma.account.findFirst({ where: { kind: 'revenue' } })).id;
        const { invoice, eventId } = await storedPayment(
          repository,
          user.id,
          'm2-lock-a',
          'purchase',
          bought.id,
          10000n,
        );

        // Old order: the apply held clearing and the payer, then waited for
        // revenue — which B holds while it asks for the payer.
        const { held, applied } = await contend(
          () => repository.applyEvent(eventId),
          revenue,
          payer,
        );

        assert.equal(held.status, 'fulfilled', String(held.reason));
        assert.equal(applied.status, 'fulfilled', String(applied.reason));
        assert.equal(
          (await prisma.invoice.findUnique({ where: { id: invoice.id } })).status,
          'paid',
        );
      },
    );

    await t.test('R74: a top-up does not deadlock on the referrer it rewards', async () => {
      const { RewardsService } =
        await import('../apps/api/dist/modules/rewards/rewards.service.js');
      const values = {
        'referral.enabled': true,
        'referral.mode': 'percent_first',
        'referral.percent': 20,
        'referral.fixed_minor': '0',
        'referral.all_months': 0,
        'referral.invitee_bonus': { type: 'none', value: 0 },
        'referral.invitee_bonus_trigger': 'first_paid',
        'referral.hold_hours': 0,
        'referral.max_rewards_per_day': 20,
        'referral.min_source_amount_minor': '0',
        'referral.count_topups': true,
        'trial.days': 3,
        'trial.traffic_gb': 10,
        'trial.device_limit': 1,
        'trial.squads': [],
      };
      const settings = { get: (key) => Promise.resolve(values[key]) };
      const rewarding = new PaymentsRepository(
        prisma,
        new RewardsService({ db: prisma, redis: null }, settings),
      );
      const referrer = await customer();
      const user = await customer();
      await prisma.referralAttribution.create({
        data: {
          refereeId: user.id,
          referrerId: referrer.id,
          source: 'telegram',
          code: referrer.referralCode,
          status: 'pending',
        },
      });
      // Ids grow with creation: referrer < this provider's clearing < payer.
      const referrerAccount = await accountOf(referrer.id);
      await prisma.$executeRaw`INSERT INTO accounts (kind, provider, currency) VALUES ('provider_clearing', 'm2-lock-b', 'RUB')`;
      const clearing = (
        await prisma.account.findFirst({
          where: { kind: 'provider_clearing', provider: 'm2-lock-b' },
        })
      ).id;
      await accountOf(user.id);
      const { eventId } = await storedPayment(
        rewarding,
        user.id,
        'm2-lock-b',
        'topup',
        null,
        5000n,
      );

      // Old order: the apply held clearing and the payer, then `onPaid`
      // waited for the referrer — whom B holds while it asks for clearing.
      const { held, applied } = await contend(
        () => rewarding.applyEvent(eventId),
        referrerAccount,
        clearing,
      );

      assert.equal(held.status, 'fulfilled', String(held.reason));
      assert.equal(applied.status, 'fulfilled', String(applied.reason));
      assert.equal(await balanceOf(user.id), 5000n);
      assert.equal(await balanceOf(referrer.id), 1000n);
    });

    await t.test('backstop: an event whose apply never finished is applied later', async () => {
      const [index] = await prisma.$queryRaw`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_payment_events_unapplied_p'`;
      assert.match(index.indexdef, /WHERE \(\(processed_at IS NULL\) AND signature_ok\)/);

      const user = await customer();
      const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
      const invoiceFor = (key) =>
        prisma.invoice.create({
          data: {
            userId: user.id,
            kind: 'topup',
            provider: 'mock',
            status: 'pending',
            amountMinor: 3000n,
            currency: 'RUB',
            idempotencyKey: key,
            providerInvoiceId: key,
            expiresAt: new Date(Date.now() + 30 * 60_000),
          },
        });
      // Stored, never applied: the API died between the insert and the
      // apply, or every apply failed and the job gave up.
      const lost = await invoiceFor('m2-rec-lost');
      const lostEvent = await prisma.paymentEvent.create({
        data: {
          provider: 'mock',
          externalId: 'm2-rec-lost',
          invoiceId: lost.id,
          type: 'paid',
          raw: { providerInvoiceId: lost.providerInvoiceId, paidAmountMinorRub: '3000' },
          headers: {},
          signatureOk: true,
          receivedAt: minutesAgo(3),
        },
      });
      // Its apply keeps failing, and it has been failing for twenty minutes.
      const broken = await invoiceFor('m2-rec-broken');
      const brokenEvent = await prisma.paymentEvent.create({
        data: {
          provider: 'mock',
          externalId: 'm2-rec-broken',
          invoiceId: broken.id,
          type: 'paid',
          raw: { providerInvoiceId: broken.providerInvoiceId, paidAmountMinorRub: 'not-a-number' },
          headers: {},
          signatureOk: true,
          receivedAt: minutesAgo(20),
        },
      });
      // Too fresh: the inline apply or its queued job may still be at it.
      const fresh = await invoiceFor('m2-rec-fresh');
      const freshEvent = await prisma.paymentEvent.create({
        data: {
          provider: 'mock',
          externalId: 'm2-rec-fresh',
          invoiceId: fresh.id,
          type: 'paid',
          raw: { providerInvoiceId: fresh.providerInvoiceId, paidAmountMinorRub: '3000' },
          headers: {},
          signatureOk: true,
        },
      });

      const result = await service.reapplyUnapplied();

      assert.deepEqual(result, { reapplied: 1, failed: 1, stuck: 1 });
      assert.equal((await prisma.invoice.findUnique({ where: { id: lost.id } })).status, 'paid');
      assert.ok(
        (await prisma.paymentEvent.findUnique({ where: { id: lostEvent.id } })).processedAt,
      );
      assert.equal(await balanceOf(user.id), 3000n);
      const stillBroken = await prisma.paymentEvent.findUnique({ where: { id: brokenEvent.id } });
      assert.equal(stillBroken.processedAt, null);
      assert.match(stillBroken.processError, /SyntaxError/);
      assert.equal(
        await prisma.outboxJob.count({
          where: { jobId: `alert:payment.unapplied:${brokenEvent.id}` },
        }),
        1,
      );
      assert.equal(
        (await prisma.paymentEvent.findUnique({ where: { id: freshEvent.id } })).processedAt,
        null,
      );

      // The next run alerts no more for the same event.
      await service.reapplyUnapplied();
      assert.equal(
        await prisma.outboxJob.count({
          where: { jobId: `alert:payment.unapplied:${brokenEvent.id}` },
        }),
        1,
      );
    });

    await prisma.$disconnect();
  } finally {
    await postgres.stop();
  }
});
