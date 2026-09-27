import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import process from 'node:process';
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

    await prisma.$disconnect();
  } finally {
    await postgres.stop();
  }
});
