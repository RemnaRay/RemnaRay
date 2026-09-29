import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
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
  'M4 rewards: AC-152 single first-top-up reward, AC-153 reversal, AC-155 promo race',
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
      const values = {
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
      };
      const settings = settingsStub(values);
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
      const cheap = await prisma.plan.create({
        data: {
          slug: 'm4-cheap',
          name: { ru: 'Дёшево', en: 'Cheap' },
          durationDays: 1,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 5000n,
        },
      });
      // F37 (ADR-021): money comes in only as a top-up at a provider, and a
      // plan is bought from the balance.
      const { BalanceProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      registry.register(new BalanceProvider());
      const topUp = async (userId, amountMinor, idempotencyKey) => {
        const invoice = await payments.createInvoice({
          userId,
          kind: 'topup',
          provider: 'mock',
          amountMinor,
          idempotencyKey,
        });
        await payInvoice(payments, invoice, Number(amountMinor));
        return invoice;
      };
      const transactionOf = (invoice) =>
        prisma.transaction.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      const rewardOf = async (invoice) =>
        prisma.referralReward.findUniqueOrThrow({
          where: { sourceTransactionId: (await transactionOf(invoice)).id },
        });
      const rewardCount = async (refereeId) =>
        prisma.referralReward.count({
          where: {
            attributionId: (
              await prisma.referralAttribution.findUniqueOrThrow({ where: { refereeId } })
            ).id,
          },
        });

      // AC-152, F37: the first top-up is the first paid event — percent_first
      // pays 20 % of it.
      const topup = await payments.createInvoice({
        userId: referee.id,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 29900n,
        idempotencyKey: 'f37-first-topup',
        target: { planId: plan.id, kind: 'purchase' },
      });
      await payInvoice(payments, topup, 29900);
      const topupTransaction = await transactionOf(topup);
      assert.equal(topupTransaction.type, 'topup');
      const reward = await rewardOf(topup);
      assert.equal(reward.amountMinor, 5980n);
      assert.equal(reward.status, 'held');
      assert.equal(
        (await prisma.referralAttribution.findUnique({ where: { refereeId: referee.id } })).status,
        'converted',
      );

      // A second top-up is no longer the first: nothing more.
      await topUp(referee.id, 29900n, 'ref-second');
      // R135: the purchase from that balance is not a second source — so it
      // does not wait for `referral_expense`, the one row every reward moves,
      // which another transaction holds meanwhile.
      let holdExpense = () => undefined;
      const expenseHeld = new Promise((resolve) => {
        holdExpense = resolve;
      });
      let expenseLocked = () => undefined;
      const locked = new Promise((resolve) => {
        expenseLocked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM accounts WHERE kind = 'referral_expense' FOR UPDATE`;
          expenseLocked();
          await expenseHeld;
        },
        { timeout: 30_000 },
      );
      await locked;
      let bought;
      try {
        bought = await Promise.race([
          payments.createInvoice({
            userId: referee.id,
            kind: 'purchase',
            planId: plan.id,
            provider: 'balance',
            idempotencyKey: 'f37-buy',
          }),
          delay(10_000, 'waited'),
        ]);
      } finally {
        holdExpense();
        await holder;
      }
      assert.notEqual(
        bought,
        'waited',
        'the purchase from the balance waited for referral_expense',
      );
      assert.equal(bought.status, 'paid');
      assert.equal(await rewardCount(referee.id), 1, 'only the first top-up accrues');
      assert.equal(await prisma.referralReward.count(), 1);

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

      // AC-153 under F37: the reward's source is the top-up, which is never
      // refunded (FR-066 refunds purchases), and refunding the purchase from
      // the balance leaves the reward alone — it was never its source. The
      // console's reversal (15.4) takes the reward and the balance back.
      await payments.refund((await transactionOf(bought)).id, 29900n, 'customer request');
      assert.equal((await rewardOf(topup)).status, 'held');
      await assert.rejects(payments.refund(topupTransaction.id, 29900n, 'customer request'), {
        name: 'PaymentError',
        code: 'REFUND_NOT_PURCHASE',
      });
      assert.deepEqual(await rewards.reverseReward(reward.id), { reversedMinor: 5980 });
      assert.equal((await rewardOf(topup)).status, 'reversed');
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
      // `reversed`. Under F37 a top-up is never refunded, so the path stays
      // live only for a reward written before F37 on a purchase.
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
      // The money is an adjustment, not a top-up, so nothing accrues before
      // the purchase.
      await ledger.post({
        userId: partialReferee.id,
        type: 'adjustment',
        amountMinor: 29900n,
        currency: 'RUB',
        debit: { kind: 'adjustment' },
        credit: { kind: 'user', userId: partialReferee.id },
        reason: 'test balance',
      });
      const partialSource = await transactionOf(
        await payments.createInvoice({
          userId: partialReferee.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'balance',
          idempotencyKey: 'ref-partial',
        }),
      );
      assert.equal(partialSource.type, 'purchase');
      assert.equal(await rewardCount(partialReferee.id), 0);
      // Fabricates a reward written before F37 on that purchase: the engine
      // now takes only a top-up, so the source is passed as one. It posts
      // through the engine, so the ledger stays consistent for the audit.
      const { accrueReferralReward } =
        await import('../apps/api/dist/modules/rewards/referrals.engine.js');
      await prisma.$transaction(async (tx) =>
        accrueReferralReward(
          tx,
          await rewards.config(),
          { ...partialSource, type: 'topup' },
          await rewards.trialLimits(),
        ),
      );
      assert.equal(
        (
          await prisma.referralReward.findUniqueOrThrow({
            where: { sourceTransactionId: partialSource.id },
          })
        ).amountMinor,
        5980n,
      );
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

      // Repair queue R17: a manual reversal (15.4) racing another reversal
      // of the same reward waits for it and then finds nothing left, instead
      // of reversing the reward twice. Transaction A reverses and holds its
      // commit; B, the console's reversal, starts meanwhile.
      const raceReferrer = await prisma.user.create({
        data: { telegramId: 995000021n, language: 'ru', referralCode: 'RACEREF1' },
      });
      const raceReferee = await prisma.user.create({
        data: { telegramId: 995000022n, language: 'ru', referralCode: 'RACEREE1' },
      });
      await prisma.referralAttribution.create({
        data: {
          refereeId: raceReferee.id,
          referrerId: raceReferrer.id,
          source: 'telegram',
          code: 'RACEREF1',
          status: 'pending',
        },
      });
      const raceInvoice = await topUp(raceReferee.id, 29900n, 'ref-race');
      const raceSource = await transactionOf(raceInvoice);
      const raceReward = await rewardOf(raceInvoice);
      const { reverseReferralReward } =
        await import('../apps/api/dist/modules/rewards/referrals.engine.js');
      let commitA = () => undefined;
      const gate = new Promise((resolve) => {
        commitA = resolve;
      });
      const reversalA = prisma.$transaction(
        async (tx) => {
          const amount = await reverseReferralReward(
            tx,
            raceSource.id,
            raceSource.amountMinor,
            raceSource.amountMinor,
          );
          await gate;
          return amount;
        },
        { timeout: 30_000 },
      );
      await delay(1000);
      const reversalB = rewards.reverseReward(raceReward.id);
      await delay(1000);
      commitA();
      const [firstAmount, consoleResult] = await Promise.all([reversalA, reversalB]);
      assert.equal(firstAmount, 5980n);
      assert.deepEqual(consoleResult, { reversedMinor: 0 });
      assert.deepEqual(
        (
          await prisma.transaction.findMany({
            where: { userId: raceReferrer.id, type: 'referral_reversal' },
          })
        ).map((row) => row.amountMinor),
        [5980n],
      );

      // F37 percent_all: every top-up is a source, and a purchase from the
      // balance still is not.
      const allReferrer = await prisma.user.create({
        data: { telegramId: 995000031n, language: 'ru', referralCode: 'ALLREF01' },
      });
      const allReferee = await prisma.user.create({
        data: { telegramId: 995000032n, language: 'ru', referralCode: 'ALLREE01' },
      });
      await prisma.referralAttribution.create({
        data: {
          refereeId: allReferee.id,
          referrerId: allReferrer.id,
          source: 'telegram',
          code: 'ALLREF01',
          status: 'pending',
        },
      });
      values['referral.mode'] = 'percent_all';
      const allFirst = await topUp(allReferee.id, 10000n, 'all-first');
      const allSecond = await topUp(allReferee.id, 10000n, 'all-second');
      assert.equal((await rewardOf(allFirst)).amountMinor, 2000n);
      assert.equal((await rewardOf(allSecond)).amountMinor, 2000n);
      const allBought = await payments.createInvoice({
        userId: allReferee.id,
        kind: 'purchase',
        planId: cheap.id,
        provider: 'balance',
        idempotencyKey: 'all-buy',
      });
      assert.equal(allBought.status, 'paid');
      assert.equal(await rewardCount(allReferee.id), 2);
      assert.equal(
        (await prisma.account.findFirstOrThrow({ where: { kind: 'user', userId: allReferrer.id } }))
          .balanceMinor,
        4000n,
      );

      // F37 first_paid: the invitee's bonus comes with the first top-up, once.
      const bonusReferrer = await prisma.user.create({
        data: { telegramId: 995000041n, language: 'ru', referralCode: 'BONREF01' },
      });
      const bonusReferee = await prisma.user.create({
        data: { telegramId: 995000042n, language: 'ru', referralCode: 'BONREE01' },
      });
      await prisma.referralAttribution.create({
        data: {
          refereeId: bonusReferee.id,
          referrerId: bonusReferrer.id,
          source: 'telegram',
          code: 'BONREF01',
          status: 'pending',
        },
      });
      values['referral.mode'] = 'percent_first';
      values['referral.invitee_bonus'] = { type: 'balance', value: 5000 };
      const bonuses = () =>
        prisma.transaction.findMany({ where: { userId: bonusReferee.id, type: 'promo_bonus' } });
      await topUp(bonusReferee.id, 10000n, 'bonus-topup');
      assert.deepEqual(
        (await bonuses()).map((row) => row.amountMinor),
        [5000n],
      );
      await payments.createInvoice({
        userId: bonusReferee.id,
        kind: 'purchase',
        planId: cheap.id,
        provider: 'balance',
        idempotencyKey: 'bonus-buy',
      });
      assert.equal((await bonuses()).length, 1);
      assert.equal(
        (
          await prisma.account.findFirstOrThrow({
            where: { kind: 'user', userId: bonusReferee.id },
          })
        ).balanceMinor,
        10000n + 5000n - 5000n,
      );
      values['referral.invitee_bonus'] = { type: 'none', value: 0 };

      // AC-155: a promocode with max_uses = 1 sells exactly one slot. F37:
      // the buyers top up first and buy from the balance, where the slot is
      // taken and applied in the one request.
      const me = new MeService(infra, settings, {}, payments, {}, {});
      const promocode = await prisma.promocode.create({
        data: { code: 'ONLYONE1', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const buyers = [];
      for (let index = 0; index < 2; index += 1) {
        const buyer = await prisma.user.create({
          data: {
            telegramId: BigInt(995100000 + index),
            language: 'ru',
            referralCode: `PROMOB${String(index)}`,
          },
        });
        await topUp(buyer.id, 100000n, `promo-topup-${String(index)}`);
        buyers.push(buyer);
      }
      const attempts = await Promise.allSettled(
        buyers.map((buyer, index) =>
          me.createInvoice(
            buyer.id,
            { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'ONLYONE1' },
            `promo-${String(index)}`,
          ),
        ),
      );
      const accepted = attempts.filter((item) => item.status === 'fulfilled');
      const rejected = attempts.filter((item) => item.status === 'rejected');
      assert.equal(accepted.length, 1, 'exactly one buyer gets the slot');
      assert.equal(
        rejected[0].reason.response.error.code,
        'PROMO_EXHAUSTED',
        'the loser is rejected with PROMO_EXHAUSTED',
      );
      const taken = await prisma.promocodeRedemption.findMany({
        where: { promocodeId: promocode.id, status: { not: 'released' } },
      });
      assert.equal(taken.length, 1, 'one redemption holds the slot');

      // A third attempt always fails once the slot is taken.
      const third = await prisma.user.create({
        data: { telegramId: 995100099n, language: 'ru', referralCode: 'PROMOB99' },
      });
      await topUp(third.id, 100000n, 'promo-topup-third');
      await assert.rejects(
        me.createInvoice(
          third.id,
          { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'ONLYONE1' },
          'promo-third',
        ),
        (error) => error.response.error.code === 'PROMO_EXHAUSTED',
      );

      // Settlement applied the reservation and bumped used_count.
      assert.equal(taken[0].status, 'applied');
      assert.equal(taken[0].invoiceId, accepted[0].value.id);
      assert.equal(
        (await prisma.promocode.findUnique({ where: { id: promocode.id } })).usedCount,
        1,
      );

      // Section 11.4: an invoice that expires gives its promocode slot back.
      // Expiry only changed the status, so the one use stayed reserved for
      // ever and every later buyer was told PROMO_EXHAUSTED. F37: only a
      // provider purchase written before F37 can still hold a reservation
      // past its request; the trigger of 0014 refuses such a new row, so it
      // is off for the one insert.
      const expiring = await prisma.promocode.create({
        data: { code: 'EXPIRES1', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE invoices DISABLE TRIGGER invoices_provider_topup',
      );
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO invoices (id, user_id, kind, plan_id, provider, status, amount_minor, discount_minor, promocode_id, currency, idempotency_key, expires_at, provider_invoice_id)
           VALUES (uuidv7(), $1::uuid, 'purchase', $2::uuid, 'mock', 'pending', 26910, 2990, $3::uuid, 'RUB', 'promo-abandoned', now() + interval '10 minutes', 'legacy-promo')`,
          buyers[0].id,
          plan.id,
          expiring.id,
        );
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE invoices ENABLE TRIGGER invoices_provider_topup',
        );
      }
      const abandoned = await prisma.invoice.findUniqueOrThrow({
        where: { idempotencyKey: 'promo-abandoned' },
      });
      await prisma.promocodeRedemption.create({
        data: {
          promocodeId: expiring.id,
          userId: buyers[0].id,
          invoiceId: abandoned.id,
          appliedValueMinor: 2990n,
          status: 'reserved',
        },
      });
      await repository.expire(new Date(Date.now() + 31 * 60_000));
      assert.equal(
        (await prisma.promocodeRedemption.findFirst({ where: { invoiceId: abandoned.id } })).status,
        'released',
      );
      const retaken = await me.createInvoice(
        buyers[1].id,
        { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'EXPIRES1' },
        'promo-retaken',
      );
      assert.equal(retaken.status, 'paid');

      // Section 9.2 Idempotency-Key: the same request replays the invoice
      // without reserving the promocode again; another user presenting the
      // key is refused rather than handed that invoice.
      const replayCode = await prisma.promocode.create({
        data: { code: 'REPLAY01', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const body = {
        kind: 'purchase',
        planId: plan.id,
        provider: 'balance',
        promocode: 'REPLAY01',
      };
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

      // A purchase whose debit fails gives its slot back: the invoice never
      // came to be, so no reservation may outlive the request (F37: a top-up
      // never reserves one, so this is the only way a slot is left behind).
      const linkedCode = await prisma.promocode.create({
        data: { code: 'LINKED01', type: 'discount_percent', value: 10n, maxUses: 1 },
      });
      const short = await prisma.user.create({
        data: { telegramId: 995100300n, language: 'ru', referralCode: 'PROMOS01' },
      });
      await assert.rejects(
        me.createInvoice(
          short.id,
          { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'LINKED01' },
          'promo-linked',
        ),
        (error) => error.response.error.code === 'INSUFFICIENT_FUNDS',
      );
      const linked = await prisma.promocodeRedemption.findFirst({
        where: { promocodeId: linkedCode.id },
      });
      assert.equal(linked.invoiceId, null);
      assert.equal(linked.status, 'released');
      const linkedAgain = await me.createInvoice(
        buyers[1].id,
        { kind: 'purchase', planId: plan.id, provider: 'balance', promocode: 'LINKED01' },
        'promo-linked-again',
      );
      assert.equal(linkedAgain.status, 'paid');

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
