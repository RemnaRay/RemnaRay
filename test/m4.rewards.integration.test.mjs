import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const noCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK'),
  del: () => Promise.resolve(0),
  publish: () => Promise.resolve(0),
  getex: () => Promise.resolve(null),
};

function settingsStub(values) {
  return { get: (key) => Promise.resolve(values[key]) };
}

async function payInvoice(service, invoice, amountMinor) {
  const body = JSON.stringify({
    eventId: `paid-${invoice.id}`,
    providerInvoiceId: invoice.providerInvoiceId,
    type: 'paid',
    paidAmountMinorRub: String(amountMinor),
  });
  await service.receiveWebhook(
    'mock',
    Buffer.from(body),
    { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex') },
    '127.0.0.1',
  );
}

test(
  'M4 rewards: AC-152 single first-purchase reward, AC-153 reversal, AC-155 promo race',
  { timeout: 300_000 },
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
      const { MockPaymentProvider } = await import('../packages/payments-mock/dist/index.js');
      const { RewardsService } =
        await import('../apps/api/dist/modules/rewards/rewards.service.js');
      const { MeService } = await import('../apps/api/dist/modules/me/me.service.js');

      const prisma = createPrismaClient(databaseUrl);
      const infra = { db: prisma, redis: noCache };
      const settings = settingsStub({
        'referral.enabled': true,
        'referral.mode': 'percent_first',
        'referral.percent': 20,
        'referral.fixed_minor': '0',
        'referral.all_months': 0,
        'referral.invitee_bonus': { type: 'none', value: 0 },
        'referral.invitee_bonus_trigger': 'first_paid',
        'referral.hold_hours': 24,
        'referral.max_rewards_per_day': 20,
        'referral.min_source_amount_minor': '0',
        'referral.count_topups': false,
        'trial.days': 3,
        'trial.traffic_gb': 10,
        'trial.device_limit': 1,
        'trial.squads': [],
        'fiscal.mode': 'none',
        'fiscal.fallback_email': '',
        'balance.topup_enabled': true,
        'balance.topup_presets_minor': ['10000'],
        'balance.topup_min_minor': '1000',
        'balance.topup_max_minor': '1000000',
        'bot.username': 'bot',
        'domain.main': 'shop.test',
        'subscription.user_can_remove_devices': false,
      });
      const rewards = new RewardsService(infra, settings);
      const registry = new PaymentProviderRegistry();
      registry.register(new MockPaymentProvider());
      const repository = new PaymentsRepository(prisma, rewards);
      const payments = new PaymentsService(infra, repository, registry, settings);

      const referrer = await prisma.user.create({
        data: { telegramId: 995000001n, language: 'ru', referralCode: 'REFERRER' },
      });
      const referee = await prisma.user.create({
        data: { telegramId: 995000002n, language: 'ru', referralCode: 'REFEREE1' },
      });
      await prisma.referralAttribution.create({
        data: {
          refereeId: referee.id,
          referrerId: referrer.id,
          source: 'telegram',
          code: 'REFERRER',
          status: 'pending',
        },
      });
      const plan = await prisma.plan.create({
        data: {
          slug: 'm4-ref',
          name: { ru: 'Реф', en: 'Ref' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });

      // AC-152: two purchases, only the first accrues a reward.
      const first = await payments.createInvoice({
        userId: referee.id,
        kind: 'purchase',
        planId: plan.id,
        provider: 'mock',
        idempotencyKey: 'ref-first',
      });
      await payInvoice(payments, first, 29900);
      const second = await payments.createInvoice({
        userId: referee.id,
        kind: 'purchase',
        planId: plan.id,
        provider: 'mock',
        idempotencyKey: 'ref-second',
      });
      await payInvoice(payments, second, 29900);

      const rewardRows = await prisma.referralReward.findMany();
      assert.equal(rewardRows.length, 1, 'only the first purchase accrues');
      assert.equal(rewardRows[0].amountMinor, 5980n);
      assert.equal(rewardRows[0].status, 'held');
      const attribution = await prisma.referralAttribution.findUnique({
        where: { refereeId: referee.id },
      });
      assert.equal(attribution.status, 'converted');

      const referrerAccount = await prisma.account.findFirst({
        where: { kind: 'user', userId: referrer.id },
      });
      assert.equal(referrerAccount.balanceMinor, 5980n);

      // Held rewards are not spendable (section 15.2).
      const { LedgerRepository } =
        await import('../apps/api/dist/modules/ledger/ledger.repository.js');
      const ledger = new LedgerRepository(prisma);
      assert.equal(await ledger.available(referrer.id), 0n);
      // Paying from the balance obeys the same rule: the 59.80 on the account
      // is all held, so a 50.00 plan cannot be bought with it.
      const { BalanceProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      registry.register(new BalanceProvider());
      const cheap = await prisma.plan.create({
        data: {
          slug: 'm4-cheap',
          name: { ru: 'Дёшево', en: 'Cheap' },
          durationDays: 1,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 5000n,
        },
      });
      await assert.rejects(
        payments.createInvoice({
          userId: referrer.id,
          kind: 'purchase',
          planId: cheap.id,
          provider: 'balance',
          idempotencyKey: 'held-balance',
        }),
        { name: 'PaymentError', code: 'INSUFFICIENT_FUNDS' },
      );
      assert.equal(
        (await prisma.account.findFirst({ where: { kind: 'user', userId: referrer.id } }))
          .balanceMinor,
        5980n,
      );
      assert.equal(
        await prisma.transaction.count({ where: { userId: referrer.id, type: 'purchase' } }),
        0,
      );
      // And the customer sees it that way: nothing available, 59.80 pending.
      const account = new MeService({ db: prisma }, settings, {}, payments, {}, {});
      const profile = await account.profile(referrer.id);
      assert.deepEqual(profile.balance, { amountMinor: 0, currency: 'RUB' });
      assert.deepEqual(profile.balanceHeld, { amountMinor: 5980, currency: 'RUB' });
      const methods = await account.paymentMethods(referrer.id);
      assert.deepEqual(methods.items.find((item) => item.code === 'balance').balance, {
        amountMinor: 0,
        currency: 'RUB',
      });

      // AC-153: refunding the source reverses the reward and the balance.
      const sourceTransaction = await prisma.transaction.findFirst({
        where: { userId: referee.id, type: 'purchase' },
        orderBy: { createdAt: 'asc' },
      });
      await payments.refund(sourceTransaction.id, 29900n, 'customer request');
      const reversed = await prisma.referralReward.findUnique({
        where: { sourceTransactionId: sourceTransaction.id },
      });
      assert.equal(reversed.status, 'reversed');
      const reversal = await prisma.transaction.findFirst({
        where: { userId: referrer.id, type: 'referral_reversal' },
      });
      assert.equal(reversal.amountMinor, 5980n);
      const afterReversal = await prisma.account.findFirst({
        where: { kind: 'user', userId: referrer.id },
      });
      assert.equal(afterReversal.balanceMinor, 0n);

      // Held release cron.
      await prisma.referralReward.updateMany({
        where: {},
        data: { status: 'held', holdUntil: new Date(Date.now() - 1000) },
      });
      assert.deepEqual(await rewards.releaseHeld(), { released: 1 });

      // Repair queue R16 (15.2): partial refunds reverse the reward in step —
      // 10 % of the source reverses 10 % of the reward and the reward stays
      // held; refunding the rest reverses the rest, and only then is it
      // `reversed`.
      const partialReferrer = await prisma.user.create({
        data: { telegramId: 995000011n, language: 'ru', referralCode: 'PARTREF1' },
      });
      const partialReferee = await prisma.user.create({
        data: { telegramId: 995000012n, language: 'ru', referralCode: 'PARTREE1' },
      });
      await prisma.referralAttribution.create({
        data: {
          refereeId: partialReferee.id,
          referrerId: partialReferrer.id,
          source: 'telegram',
          code: 'PARTREF1',
          status: 'pending',
        },
      });
      const partialInvoice = await payments.createInvoice({
        userId: partialReferee.id,
        kind: 'purchase',
        planId: plan.id,
        provider: 'mock',
        idempotencyKey: 'ref-partial',
      });
      await payInvoice(payments, partialInvoice, 29900);
      const partialSource = await prisma.transaction.findFirstOrThrow({
        where: { userId: partialReferee.id, type: 'purchase' },
      });
      const reversalsOf = async () =>
        (
          await prisma.transaction.findMany({
            where: { userId: partialReferrer.id, type: 'referral_reversal' },
            orderBy: { id: 'asc' },
          })
        ).map((row) => row.amountMinor);
      await payments.refund(partialSource.id, 2990n, 'partial');
      assert.deepEqual(await reversalsOf(), [598n]);
      assert.equal(
        (
          await prisma.referralReward.findUniqueOrThrow({
            where: { sourceTransactionId: partialSource.id },
          })
        ).status,
        'held',
      );
      await payments.refund(partialSource.id, 26910n, 'the rest');
      assert.deepEqual(await reversalsOf(), [598n, 5382n]);
      const fullyReversed = await prisma.referralReward.findUniqueOrThrow({
        where: { sourceTransactionId: partialSource.id },
      });
      assert.equal(fullyReversed.status, 'reversed');
      assert.equal(
        (
          await prisma.account.findFirstOrThrow({
            where: { kind: 'user', userId: partialReferrer.id },
          })
        ).balanceMinor,
        0n,
      );

      // AC-155: a promocode with max_uses = 1 sells exactly one slot.
      const me = new MeService(infra, settings, {}, payments, {}, {});
      const promocode = await prisma.promocode.create({
        data: { code: 'ONLYONE1', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const buyers = [];
      for (let index = 0; index < 2; index += 1) {
        buyers.push(
          await prisma.user.create({
            data: {
              telegramId: BigInt(995100000 + index),
              language: 'ru',
              referralCode: `PROMOB${String(index)}`,
            },
          }),
        );
      }
      const attempts = await Promise.allSettled(
        buyers.map((buyer, index) =>
          me.createInvoice(
            buyer.id,
            { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'ONLYONE1' },
            `promo-${String(index)}`,
          ),
        ),
      );
      const accepted = attempts.filter((item) => item.status === 'fulfilled');
      const rejected = attempts.filter((item) => item.status === 'rejected');
      assert.equal(accepted.length + rejected.length, 2);
      const reservations = await prisma.promocodeRedemption.count({
        where: { promocodeId: promocode.id, status: 'reserved' },
      });
      assert.ok(reservations <= 1, 'at most one reservation may exist');

      if (accepted.length === 1) {
        assert.equal(
          rejected[0].reason.response.error.code,
          'PROMO_EXHAUSTED',
          'the loser is rejected with PROMO_EXHAUSTED',
        );
      }

      // A third attempt always fails once the slot is taken.
      const third = await prisma.user.create({
        data: { telegramId: 995100099n, language: 'ru', referralCode: 'PROMOB99' },
      });
      await assert.rejects(
        me.createInvoice(
          third.id,
          { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'ONLYONE1' },
          'promo-third',
        ),
        (error) => error.response.error.code === 'PROMO_EXHAUSTED',
      );

      // Settlement moves the reservation to applied and bumps used_count.
      const reserved = await prisma.promocodeRedemption.findFirst({
        where: { promocodeId: promocode.id, status: 'reserved' },
      });
      if (reserved) {
        const invoice = await prisma.invoice.findUnique({ where: { id: reserved.invoiceId } });
        await payInvoice(payments, invoice, Number(invoice.amountMinor));
        const applied = await prisma.promocodeRedemption.findUnique({ where: { id: reserved.id } });
        assert.equal(applied.status, 'applied');
        const used = await prisma.promocode.findUnique({ where: { id: promocode.id } });
        assert.equal(used.usedCount, 1);
      }

      // Section 11.4: an invoice that expires gives its promocode slot back.
      // Expiry only changed the status, so the one use stayed reserved for
      // ever and every later buyer was told PROMO_EXHAUSTED.
      await prisma.promocode.create({
        data: { code: 'EXPIRES1', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const abandoned = await me.createInvoice(
        buyers[0].id,
        { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'EXPIRES1' },
        'promo-abandoned',
      );
      await repository.expire(new Date(Date.now() + 31 * 60_000));
      assert.equal(
        (await prisma.promocodeRedemption.findFirst({ where: { invoiceId: abandoned.id } })).status,
        'released',
      );
      const retaken = await me.createInvoice(
        buyers[1].id,
        { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'EXPIRES1' },
        'promo-retaken',
      );
      assert.ok(retaken.id);

      // Section 9.2 Idempotency-Key: the same request replays the invoice
      // without reserving the promocode again; another user presenting the
      // key is refused rather than handed that invoice.
      const replayCode = await prisma.promocode.create({
        data: { code: 'REPLAY01', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const body = { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'REPLAY01' };
      const original = await me.createInvoice(buyers[0].id, body, 'shared-key');
      const again = await me.createInvoice(buyers[0].id, body, 'shared-key');
      assert.equal(again.id, original.id);
      assert.equal(
        await prisma.promocodeRedemption.count({ where: { promocodeId: replayCode.id } }),
        1,
      );
      await assert.rejects(
        me.createInvoice(buyers[1].id, { ...body, promocode: undefined }, 'shared-key'),
        (error) =>
          error.getStatus() === 422 && error.response.error.code === 'IDEMPOTENCY_KEY_REUSED',
      );

      // Section 15.5 through the balance (FR-070): the invoice is settled while
      // it is created, so the reservation must already name it — linked
      // afterwards, it stayed `reserved` for good, used_count never moved and
      // expiry never released it.
      const balanceCode = await prisma.promocode.create({
        data: { code: 'BALANCE1', type: 'discount_percent', value: 10n, maxUses: 5 },
      });
      const wallet = await prisma.user.create({
        data: { telegramId: 995100200n, language: 'ru', referralCode: 'PROMOW01' },
      });
      await ledger.post({
        userId: wallet.id,
        type: 'adjustment',
        amountMinor: 50000n,
        currency: 'RUB',
        debit: { kind: 'adjustment' },
        credit: { kind: 'user', userId: wallet.id },
        reason: 'test balance',
      });
      const fromBalance = await me.createInvoice(
        wallet.id,
        { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'BALANCE1' },
        'promo-balance',
      );
      assert.equal(fromBalance.status, 'paid');
      const redemption = await prisma.promocodeRedemption.findFirst({
        where: { promocodeId: balanceCode.id },
      });
      assert.equal(redemption.status, 'applied');
      assert.equal(redemption.invoiceId, fromBalance.id);
      assert.equal(redemption.appliedValueMinor, 2990n);
      assert.equal(
        (await prisma.promocode.findUnique({ where: { id: balanceCode.id } })).usedCount,
        1,
      );
      assert.equal(
        (await prisma.account.findFirst({ where: { kind: 'user', userId: wallet.id } }))
          .balanceMinor,
        50000n - 26910n,
      );

      // A failure after the invoice was created (here the poll job's outbox
      // insert) must not release a reservation that already names the
      // invoice: the invoice keeps its discount, and payment applies it.
      const failingDb = new Proxy(prisma, {
        get(target, property) {
          if (property === 'outboxJob')
            return { create: () => Promise.reject(new Error('outbox unavailable')) };
          return Reflect.get(target, property);
        },
      });
      const failingInfra = { ...infra, db: failingDb };
      const failing = new MeService(
        failingInfra,
        settings,
        {},
        new PaymentsService(failingInfra, repository, registry, settings),
        {},
        {},
      );
      const linkedCode = await prisma.promocode.create({
        data: { code: 'LINKED01', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      await assert.rejects(
        failing.createInvoice(
          buyers[1].id,
          { kind: 'purchase', planId: plan.id, provider: 'mock', promocode: 'LINKED01' },
          'promo-linked',
        ),
      );
      const linked = await prisma.promocodeRedemption.findFirst({
        where: { promocodeId: linkedCode.id },
      });
      assert.ok(linked.invoiceId, 'the reservation names the invoice');
      assert.equal(linked.status, 'reserved');

      // Repair queue P-6: rewards, reversals, the invitee bonus and the
      // purchases they came from leave every account in agreement with its
      // entries under the one sign convention.
      assert.deepEqual((await ledger.audit()).mismatches, []);

      // Repair queue R19/R68: a balance that disagrees with its entries is
      // reported and raises one `ledger.mismatch` alert a day (FR-163).
      const tampered = await prisma.account.findFirstOrThrow({
        where: { kind: 'user', userId: wallet.id },
      });
      await prisma.account.update({
        where: { id: tampered.id },
        data: { balanceMinor: tampered.balanceMinor + 1n },
      });
      const found = await ledger.audit();
      assert.deepEqual(found.mismatches, [
        {
          accountId: tampered.id,
          expected: tampered.balanceMinor,
          actual: tampered.balanceMinor + 1n,
        },
      ]);
      await ledger.audit();
      const alerts = await prisma.outboxJob.findMany({
        where: { name: 'notify.alert', jobId: { startsWith: 'alert:ledger.mismatch:' } },
      });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].payload.type, 'ledger.mismatch');
      assert.match(alerts[0].payload.details, new RegExp(tampered.id));

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
