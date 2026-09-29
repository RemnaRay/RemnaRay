import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

function settingsStub(values) {
  return { get: (key) => Promise.resolve(values[key]) };
}

test(
  'M2 checkout (F37, ADR-021): the quote, top-ups for a plan and the purchase from the balance',
  { timeout: 240_000 },
  async () => {
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
      const { BalanceProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      const { MockPaymentProvider } = await import('../packages/payments-mock/dist/index.js');
      const { MeService } = await import('../apps/api/dist/modules/me/me.service.js');

      const prisma = createPrismaClient(databaseUrl);
      const infra = { db: prisma };
      const settings = settingsStub({
        'balance.topup_enabled': true,
        'balance.topup_presets_minor': ['10000'],
        'balance.topup_min_minor': '5000',
        'balance.topup_max_minor': '100000',
        'fiscal.item_name_template': 'Пополнение баланса (#{number})',
        'fiscal.mode': 'none',
        'fiscal.fallback_email': '',
        'brand.name': 'Manta',
      });
      const registry = new PaymentProviderRegistry();
      registry.register(new MockPaymentProvider());
      registry.register(new BalanceProvider());
      const payments = new PaymentsService(
        infra,
        new PaymentsRepository(prisma),
        registry,
        settings,
      );
      const me = new MeService(infra, settings, {}, payments, {}, {});
      // AC-061: the provider is offered only after a successful healthcheck.
      await prisma.paymentProvider.upsert({
        where: { code: 'mock' },
        create: {
          code: 'mock',
          enabled: true,
          displayName: { ru: 'Mock', en: 'Mock' },
          lastHealthcheckOk: true,
        },
        update: { enabled: true, lastHealthcheckOk: true },
      });

      const user = await prisma.user.create({
        data: { telegramId: 992100001n, language: 'ru', referralCode: 'M2CHK001' },
      });
      const plan = await prisma.plan.create({
        data: {
          slug: 'm2-checkout',
          name: { ru: 'Месяц', en: 'Month' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });
      const dear = await prisma.plan.create({
        data: {
          slug: 'm2-checkout-dear',
          name: { ru: 'Дорого', en: 'Dear' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 2500000n,
        },
      });
      await prisma.promocode.create({
        data: { code: 'SALE20', type: 'discount_percent', value: 20n, maxUses: 5 },
      });

      // The mock provider names an invoice by the key it was created with;
      // the DTO does not carry that id, the row does.
      const pay = async (view, eventId, amountMinor) => {
        const row = await prisma.invoice.findUniqueOrThrow({ where: { id: view.id } });
        const body = JSON.stringify({
          eventId,
          providerInvoiceId: row.providerInvoiceId,
          type: 'paid',
          paidAmountMinorRub: String(amountMinor),
        });
        await payments.receiveWebhook(
          'mock',
          Buffer.from(body),
          { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex') },
          '127.0.0.1',
        );
      };
      const forPlan = (planId, promocode) => ({
        kind: 'topup',
        provider: 'mock',
        forPlan: { planId, kind: 'purchase', ...(promocode ? { promocode } : {}) },
      });

      // A short balance: the quote offers a top-up of max(short, 5000, 100).
      let quote = await me.checkoutQuote(user.id, { planId: plan.id, kind: 'purchase' });
      assert.equal(quote.missingMinor, 29900);
      assert.equal(quote.availableMinor, 0);
      assert.deepEqual(quote.topups, [{ provider: 'mock', amountMinor: 29900 }]);

      // A top-up above topup_max_minor is still invoiced (answer (а)).
      const big = await me.createInvoice(user.id, forPlan(dear.id), 'co-big');
      assert.equal(big.amount.amountMinor, 2500000);
      assert.equal(big.number, '99-00001');

      // FR-020: the same request again returns the pending top-up.
      const first = await me.createInvoice(user.id, forPlan(plan.id), 'co-1');
      const reused = await me.createInvoice(user.id, forPlan(plan.id), 'co-2');
      assert.equal(reused.id, first.id);
      assert.equal(first.kind, 'topup');
      assert.equal(first.amount.amountMinor, 29900);
      assert.equal(first.number, '99-00002');
      assert.deepEqual(first.target, {
        planId: plan.id,
        planSlug: plan.slug,
        kind: 'purchase',
        promocode: null,
      });
      assert.equal(await prisma.invoice.count({ where: { userId: user.id } }), 2);

      // Paid: the balance covers the plan; a top-up for it is refused.
      await pay(first, 'co-paid', 29900);
      await assert.rejects(
        me.createInvoice(user.id, forPlan(plan.id), 'co-3'),
        (error) => error.code === 'BALANCE_SUFFICIENT' && error.getStatus() === 409,
      );
      quote = await me.checkoutQuote(user.id, { planId: plan.id, kind: 'purchase' });
      assert.equal(quote.missingMinor, 0);
      assert.deepEqual(quote.topups, []);

      // A purchase at a provider is not a request the API accepts.
      await assert.rejects(
        me.createInvoice(user.id, { kind: 'purchase', planId: plan.id, provider: 'mock' }, 'co-p'),
        { name: 'ZodError' },
      );

      // The purchase; then a second one is short and says by how much.
      const bought = await me.createInvoice(
        user.id,
        { kind: 'purchase', planId: plan.id },
        'co-buy',
      );
      assert.equal(bought.status, 'paid');
      assert.equal(bought.provider, 'balance');
      assert.equal(bought.number, null);
      await assert.rejects(
        me.createInvoice(user.id, { kind: 'purchase', planId: plan.id }, 'co-buy-2'),
        (error) =>
          error.code === 'INSUFFICIENT_FUNDS' &&
          error.getStatus() === 409 &&
          error.getResponse().error.details.missingMinor === 29900,
      );

      // The transactions name the top-up by its number.
      const history = await me.transactions(user.id, {});
      const topup = history.items.find((item) => item.type === 'topup');
      assert.equal(topup.invoiceNumber, '99-00002');
      assert.equal(history.items.find((item) => item.type === 'purchase').invoiceNumber, null);

      // A promocode is not reserved by a top-up for a plan: it is remembered,
      // and the amount already carries its discount.
      const promo = await me.createInvoice(user.id, forPlan(plan.id, 'SALE20'), 'co-promo');
      assert.equal(promo.amount.amountMinor, 23920);
      assert.equal(promo.target.promocode, 'SALE20');
      assert.equal(await prisma.promocodeRedemption.count({ where: { userId: user.id } }), 0);

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
