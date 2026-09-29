import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Section 10.4 and FR-023 on a real PostgreSQL: a paid renewal of the same
 * plan queues a traffic reset, a paid plan change queues one conditional on
 * the new limit, and a first purchase or another plan queues none. Each is a
 * `panel.reset-traffic` of its own, written with the payment and ahead of the
 * sync, since syncs of one user are deduplicated and would lose a reason.
 */
test(
  'M2 paid renewals and plan changes reset the panel traffic',
  { timeout: 240_000 },
  async () => {
    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    let prisma;
    try {
      execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
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
      const { BalanceProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      prisma = createPrismaClient(postgres.getConnectionUri());
      const registry = new PaymentProviderRegistry();
      registry.register(new MockPaymentProvider());
      registry.register(new BalanceProvider());
      const payments = new PaymentsService(
        { db: prisma },
        new PaymentsRepository(prisma),
        registry,
      );
      const user = await prisma.user.create({
        data: { telegramId: 994000001n, language: 'ru', referralCode: 'M2TRAF01' },
      });
      const plan = (slug, limitGb) =>
        prisma.plan.create({
          data: {
            slug,
            name: { ru: slug, en: slug },
            durationDays: 30,
            squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
            priceMinor: 29900n,
            trafficLimitBytes: BigInt(limitGb) * 1024n ** 3n,
          },
        });
      const [monthly, small] = [await plan('traffic-month', 100), await plan('traffic-small', 10)];
      let paid = 0;
      // F37: the price is topped up through the provider, and the plan is
      // bought from the balance.
      const pay = async (kind, planId) => {
        paid += 1;
        const topup = await payments.createInvoice({
          userId: user.id,
          kind: 'topup',
          provider: 'mock',
          amountMinor: 29900n,
          idempotencyKey: `traffic-topup-${String(paid)}`,
          target: { planId, kind },
        });
        const body = JSON.stringify({
          eventId: `traffic-paid-${String(paid)}`,
          providerInvoiceId: topup.providerInvoiceId,
          type: 'paid',
          paidAmountMinorRub: String(topup.amountMinor),
        });
        await payments.receiveWebhook(
          'mock',
          Buffer.from(body),
          { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex') },
          '127.0.0.1',
        );
        const invoice = await payments.createInvoice({
          userId: user.id,
          kind,
          planId,
          provider: 'balance',
          idempotencyKey: `traffic-${String(paid)}`,
        });
        const status = await prisma.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          select: { status: true },
        });
        assert.equal(status.status, 'paid', `payment ${String(paid)} was not applied`);
      };
      const panelJobs = () =>
        prisma.outboxJob.findMany({
          where: { queue: 'panel' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { name: true, payload: true },
        });
      const resets = async () =>
        (await panelJobs())
          .filter((row) => row.name === 'panel.reset-traffic')
          .map((row) => row.payload);

      await pay('purchase', monthly.id);
      assert.deepEqual(await resets(), [], 'a first purchase has no traffic to reset');

      await pay('purchase', monthly.id);
      assert.deepEqual(await resets(), [{ userId: user.id }], 'renewing the same plan resets');
      // Queued ahead of the sync that carries the renewed limits.
      const names = (await panelJobs()).map((row) => row.name);
      assert.deepEqual(names.slice(-2), ['panel.reset-traffic', 'panel.sync-user']);

      await pay('plan_change', small.id);
      assert.deepEqual((await resets()).at(-1), {
        userId: user.id,
        ifUsedAboveBytes: String(10n * 1024n ** 3n),
      });

      // FR-022: a renewal after expiry is still a renewal of that plan.
      await prisma.subscription.updateMany({
        where: { userId: user.id },
        data: { status: 'expired', expiresAt: new Date(Date.now() - 60_000) },
      });
      await pay('purchase', small.id);
      assert.deepEqual((await resets()).at(-1), { userId: user.id });
      assert.equal((await resets()).length, 3);

      await prisma.subscription.updateMany({
        where: { userId: user.id },
        data: { status: 'expired', expiresAt: new Date(Date.now() - 60_000) },
      });
      await pay('purchase', monthly.id);
      assert.equal((await resets()).length, 3, 'buying another plan resets nothing');
    } finally {
      await prisma?.$disconnect();
      await postgres.stop();
    }
  },
);
