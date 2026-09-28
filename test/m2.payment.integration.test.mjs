import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

test(
  'M2 payment core is idempotent and credits late payments to balance',
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
      const { MockPaymentProvider } = await import('../packages/payments-mock/dist/index.js');
      const { LedgerRepository } =
        await import('../apps/api/dist/modules/ledger/ledger.repository.js');
      const { BalanceProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      const prisma = createPrismaClient(databaseUrl);
      const infra = { db: prisma };
      const registry = new PaymentProviderRegistry();
      registry.register(new MockPaymentProvider());
      registry.register(new BalanceProvider());
      const repository = new PaymentsRepository(prisma);
      const service = new PaymentsService(infra, repository, registry);
      const ledger = new LedgerRepository(prisma);
      const user = await prisma.user.create({
        data: { telegramId: 992000001n, language: 'ru', referralCode: 'M2PAY001' },
      });
      const plan = await prisma.plan.create({
        data: {
          slug: 'm2-core',
          name: { ru: 'M2', en: 'M2' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });
      const invoice = await service.createInvoice({
        userId: user.id,
        kind: 'purchase',
        planId: plan.id,
        provider: 'mock',
        idempotencyKey: 'm2-paid',
      });
      const body = JSON.stringify({
        eventId: 'paid-1',
        providerInvoiceId: invoice.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '29900',
      });
      const signature = createHmac('sha256', 'mock-secret').update(body).digest('hex');
      await service.receiveWebhook(
        'mock',
        Buffer.from(body),
        { 'x-mock-signature': signature },
        '127.0.0.1',
      );
      await service.receiveWebhook(
        'mock',
        Buffer.from(body),
        { 'x-mock-signature': signature },
        '127.0.0.1',
      );
      assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid');
      assert.equal(await prisma.transaction.count({ where: { invoiceId: invoice.id } }), 1);
      assert.equal(
        await prisma.ledgerEntry.count({
          where: {
            transactionId: {
              in: (
                await prisma.transaction.findMany({
                  where: { invoiceId: invoice.id },
                  select: { id: true },
                })
              ).map((row) => row.id),
            },
          },
        }),
        2,
      );
      assert.equal(
        (await prisma.subscription.findFirst({ where: { userId: user.id } })).status,
        'active',
      );

      const topup = await service.createInvoice({
        userId: user.id,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 5000n,
        idempotencyKey: 'm2-topup',
      });
      const topupBody = JSON.stringify({
        eventId: 'paid-topup',
        providerInvoiceId: topup.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '5000',
      });
      await service.receiveWebhook(
        'mock',
        Buffer.from(topupBody),
        { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(topupBody).digest('hex') },
        '127.0.0.1',
      );
      const balancePlan = await prisma.plan.create({
        data: {
          slug: 'm2-balance',
          name: { ru: 'Balance', en: 'Balance' },
          durationDays: 1,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 4000n,
        },
      });
      const balanceInvoice = await service.createInvoice({
        userId: user.id,
        kind: 'purchase',
        planId: balancePlan.id,
        provider: 'balance',
        idempotencyKey: 'm2-balance',
      });
      assert.equal(
        (await prisma.invoice.findUnique({ where: { id: balanceInvoice.id } })).status,
        'paid',
      );
      const balanceTransaction = await prisma.transaction.findFirst({
        where: { invoiceId: balanceInvoice.id },
      });
      assert.equal(
        await prisma.account
          .findFirst({ where: { userId: user.id } })
          .then((row) => row.balanceMinor),
        1000n,
      );
      await repository.refund(balanceTransaction.id, 1000n, 'test refund');
      assert.equal(
        await prisma.account
          .findFirst({ where: { userId: user.id } })
          .then((row) => row.balanceMinor),
        2000n,
      );

      // FR-070, section 11.3.7: a balance invoice is paid when it is created
      // or not created at all. A refused one used to stay `pending`, and
      // `recheck` asked `BalanceProvider.fetchStatus`, which answers `paid`,
      // so the plan was activated for nothing.
      await assert.rejects(
        service.createInvoice({
          userId: user.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'balance',
          idempotencyKey: 'm2-balance-short',
        }),
        { name: 'PaymentError', code: 'INSUFFICIENT_FUNDS' },
      );
      assert.equal(
        await prisma.invoice.count({ where: { idempotencyKey: 'm2-balance-short' } }),
        0,
      );
      // A pending balance invoice an earlier release left behind is not
      // polled: the balance has no status to look up.
      const leftover = await prisma.invoice.create({
        data: {
          userId: user.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'balance',
          status: 'pending',
          amountMinor: 29900n,
          currency: 'RUB',
          idempotencyKey: 'm2-balance-leftover',
          providerInvoiceId: 'm2-balance-leftover',
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      assert.equal((await service.recheck(leftover.id)).status, 'pending');
      assert.equal(await prisma.transaction.count({ where: { invoiceId: leftover.id } }), 0);
      assert.equal(await prisma.paymentEvent.count({ where: { invoiceId: leftover.id } }), 0);
      // Parallel balance purchases lock the account: one is paid, the others
      // are refused, and none of them leaves an invoice behind.
      const buyer = await prisma.user.create({
        data: { telegramId: 992000009n, language: 'ru', referralCode: 'M2PAY009' },
      });
      // The starting balance is a real posting, so the ledger audit below
      // sees every account as the posting paths leave it.
      await ledger.post({
        userId: buyer.id,
        type: 'adjustment',
        amountMinor: 6000n,
        currency: 'RUB',
        debit: { kind: 'adjustment' },
        credit: { kind: 'user', userId: buyer.id },
        reason: 'test balance',
      });
      const attempts = await Promise.allSettled(
        [1, 2, 3, 4, 5].map((n) =>
          service.createInvoice({
            userId: buyer.id,
            kind: 'purchase',
            planId: balancePlan.id,
            provider: 'balance',
            idempotencyKey: `m2-balance-race-${n}`,
          }),
        ),
      );
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of attempts.filter((item) => item.status === 'rejected'))
        assert.equal(result.reason.code, 'INSUFFICIENT_FUNDS');
      assert.deepEqual(
        (await prisma.invoice.findMany({ where: { userId: buyer.id } })).map((row) => row.status),
        ['paid'],
      );
      assert.equal(
        (await prisma.account.findFirst({ where: { userId: buyer.id } })).balanceMinor,
        2000n,
      );

      // FR-066/EX-05: a refund returns revenue of a purchase to the balance.
      // A top-up never reached revenue, so refunding one credited the same
      // money to the balance a second time.
      const topupTransaction = await prisma.transaction.findFirst({
        where: { invoiceId: topup.id },
      });
      const balanceBeforeRefunds = await prisma.account
        .findFirst({ where: { userId: user.id, kind: 'user' } })
        .then((row) => row.balanceMinor);
      await assert.rejects(repository.refund(topupTransaction.id, 5000n, 'not a purchase'), {
        name: 'PaymentError',
        code: 'REFUND_NOT_PURCHASE',
      });
      // AC-066: 100 of 299, then 200 more is refused and nothing moves.
      const purchase = await prisma.transaction.findFirst({ where: { invoiceId: invoice.id } });
      await repository.refund(purchase.id, 10000n, 'partial');
      await assert.rejects(repository.refund(purchase.id, 20000n, 'too much'), {
        name: 'PaymentError',
        code: 'REFUND_EXCEEDS_REMAINING',
      });
      assert.equal(
        (await prisma.transaction.findUnique({ where: { id: purchase.id } })).refundedMinor,
        10000n,
      );
      assert.equal(
        await prisma.account
          .findFirst({ where: { userId: user.id, kind: 'user' } })
          .then((row) => row.balanceMinor),
        balanceBeforeRefunds + 10000n,
      );

      const late = await service.createInvoice({
        userId: user.id,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 5000n,
        idempotencyKey: 'm2-late',
      });
      await repository.expire(new Date(Date.now() + 31 * 60_000));
      const lateBody = JSON.stringify({
        eventId: 'paid-late',
        providerInvoiceId: late.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '5000',
      });
      await service.receiveWebhook(
        'mock',
        Buffer.from(lateBody),
        { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(lateBody).digest('hex') },
        '127.0.0.1',
      );
      assert.equal((await prisma.invoice.findUnique({ where: { id: late.id } })).status, 'paid');
      assert.equal(
        await prisma.transaction.count({ where: { invoiceId: late.id, type: 'topup' } }),
        1,
      );

      // EX-03: a second `paid` event under another id for an invoice already
      // paid is the same payment reported twice (webhook and poll), not money.
      const repeatBody = JSON.stringify({
        eventId: 'paid-1-poll',
        providerInvoiceId: invoice.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '29900',
      });
      await service.receiveWebhook(
        'mock',
        Buffer.from(repeatBody),
        {
          'x-mock-signature': createHmac('sha256', 'mock-secret').update(repeatBody).digest('hex'),
        },
        '127.0.0.1',
      );
      assert.equal(await prisma.transaction.count({ where: { invoiceId: invoice.id } }), 1);

      // Owner decision 2026-09-25: a payment for an invoice the user canceled
      // is handled like EX-02 — to the balance, no activation, an alert.
      const canceled = await service.createInvoice({
        userId: user.id,
        kind: 'purchase',
        planId: plan.id,
        provider: 'mock',
        idempotencyKey: 'm2-canceled',
      });
      await prisma.invoice.update({ where: { id: canceled.id }, data: { status: 'canceled' } });
      const balanceBefore = await prisma.account
        .findFirst({ where: { userId: user.id, kind: 'user' } })
        .then((row) => row.balanceMinor);
      const expiresBefore = (
        await prisma.subscription.findFirst({ where: { userId: user.id, status: 'active' } })
      ).expiresAt;
      const canceledBody = JSON.stringify({
        eventId: 'paid-canceled',
        providerInvoiceId: canceled.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '29900',
      });
      await service.receiveWebhook(
        'mock',
        Buffer.from(canceledBody),
        {
          'x-mock-signature': createHmac('sha256', 'mock-secret')
            .update(canceledBody)
            .digest('hex'),
        },
        '127.0.0.1',
      );
      const canceledTransactions = await prisma.transaction.findMany({
        where: { invoiceId: canceled.id },
      });
      assert.equal(canceledTransactions.length, 1);
      assert.equal(canceledTransactions[0].type, 'topup');
      assert.equal(
        await prisma.account
          .findFirst({ where: { userId: user.id, kind: 'user' } })
          .then((row) => row.balanceMinor),
        balanceBefore + 29900n,
      );
      assert.deepEqual(
        (await prisma.subscription.findFirst({ where: { userId: user.id, status: 'active' } }))
          .expiresAt,
        expiresBefore,
      );
      assert.equal(
        await prisma.outboxJob.count({
          where: { jobId: `alert:payment.after_cancel:${canceled.id}` },
        }),
        1,
      );

      // EX-06/FR-023 through the balance: the unused time is paid out as the
      // plan-change credit, so the new plan starts now. The balance path kept
      // the old expiry as well, handing the same time over twice.
      const upgrade = await prisma.plan.create({
        data: {
          slug: 'm2-upgrade',
          name: { ru: 'Upgrade', en: 'Upgrade' },
          durationDays: 60,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 39900n,
        },
      });
      const beforeChange = Date.now();
      const changed = await service.createInvoice({
        userId: user.id,
        kind: 'plan_change',
        planId: upgrade.id,
        provider: 'balance',
        idempotencyKey: 'm2-plan-change-balance',
      });
      assert.equal((await prisma.invoice.findUnique({ where: { id: changed.id } })).status, 'paid');
      const afterChange = await prisma.subscription.findFirst({
        where: { userId: user.id, status: 'active' },
      });
      assert.equal(afterChange.planId, upgrade.id);
      const days = (afterChange.expiresAt.getTime() - beforeChange) / 86_400_000;
      assert.ok(days >= 59.99 && days <= 60.01, `the new plan runs ${String(days)} days`);

      // Section 7.3 status polling: the first poll sees the invoice unpaid
      // and stores that answer; the later `paid` answer has to be applied,
      // not dropped as a duplicate of it (it used to share `poll:<id>`).
      const { CryptoBotProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      const { encryptSetting } =
        await import('../apps/api/dist/modules/settings/settings.crypto.js');
      const appKey = randomBytes(32).toString('base64');
      const previousKey = process.env.RR_APP_KEY;
      const previousFetch = globalThis.fetch;
      process.env.RR_APP_KEY = appKey;
      registry.register(new CryptoBotProvider());
      // The migration seeds the row disabled; the console enables it like
      // this, and AC-061 offers it after a successful healthcheck.
      await prisma.paymentProvider.update({
        where: { code: 'cryptobot' },
        data: {
          enabled: true,
          lastHealthcheckOk: true,
          configEnc: encryptSetting({ token: 't', baseUrl: 'http://cryptobot.test/api' }, appKey)
            .enc,
        },
      });
      let cryptoStatus = { status: 'active' };
      let cryptoInvoiceId = 7700;
      globalThis.fetch = (url) =>
        Promise.resolve(
          globalThis.Response.json(
            String(url).endsWith('/createInvoice')
              ? {
                  ok: true,
                  result: {
                    invoice_id: ++cryptoInvoiceId,
                    pay_url: 'https://t.me/CryptoBot?start=x',
                  },
                }
              : { ok: true, result: { items: [{ invoice_id: cryptoInvoiceId, ...cryptoStatus }] } },
          ),
        );
      try {
        const polled = await service.createInvoice({
          userId: user.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'cryptobot',
          idempotencyKey: 'm2-poll',
        });
        // A fresh service per poll: `recheck` allows one poll per 10 s.
        const poll = () => new PaymentsService(infra, repository, registry).pollPending();
        await poll();
        assert.equal(
          (await prisma.invoice.findUnique({ where: { id: polled.id } })).status,
          'pending',
        );
        cryptoStatus = { status: 'paid', amount: '299.00', fiat: 'RUB' };
        await poll();
        assert.equal(
          (await prisma.invoice.findUnique({ where: { id: polled.id } })).status,
          'paid',
        );
        const polledTransactions = await prisma.transaction.findMany({
          where: { invoiceId: polled.id },
        });
        assert.equal(polledTransactions.length, 1);
        assert.equal(polledTransactions[0].type, 'purchase');

        // EX-12 through a poll: the rouble amount the provider reports is
        // compared with the invoice instead of being taken as paid in full.
        const short = await service.createInvoice({
          userId: user.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'cryptobot',
          idempotencyKey: 'm2-poll-short',
        });
        cryptoStatus = { status: 'paid', amount: '150.00', fiat: 'RUB' };
        await poll();
        assert.equal(
          (await prisma.invoice.findUnique({ where: { id: short.id } })).status,
          'underpaid',
        );
      } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.RR_APP_KEY;
        else process.env.RR_APP_KEY = previousKey;
      }

      // Section 11.3.4 Robokassa end to end: `InvId` is the invoice's
      // `numeric_id`, `Shp_inv` its id, and a signed ResultURL pays it and is
      // answered `OK<InvId>` — the same answer for a repeated notification.
      const { RobokassaProvider } =
        await import('../apps/api/dist/modules/payments/builtin-providers.js');
      const { encryptSetting: encryptRobokassa } =
        await import('../apps/api/dist/modules/settings/settings.crypto.js');
      const robokassaKey = randomBytes(32).toString('base64');
      const keyBeforeRobokassa = process.env.RR_APP_KEY;
      process.env.RR_APP_KEY = robokassaKey;
      try {
        registry.register(new RobokassaProvider());
        await prisma.paymentProvider.update({
          where: { code: 'robokassa' },
          data: {
            enabled: true,
            lastHealthcheckOk: true,
            configEnc: encryptRobokassa(
              { merchantLogin: 'shop', password1: 'p1', password2: 'p2' },
              robokassaKey,
            ).enc,
          },
        });
        const robokassa = await service.createInvoice({
          userId: user.id,
          kind: 'purchase',
          planId: plan.id,
          provider: 'robokassa',
          idempotencyKey: 'm2-robokassa',
        });
        const row = await prisma.invoice.findUnique({ where: { id: robokassa.id } });
        assert.equal(row.providerInvoiceId, String(row.numericId));
        const link = new URL(row.paymentUrl);
        assert.equal(link.searchParams.get('InvId'), String(row.numericId));
        assert.equal(link.searchParams.get('Shp_inv'), robokassa.id);
        const outSum = '299.000000';
        const signature = createHash('md5')
          .update(`${outSum}:${String(row.numericId)}:p2:Shp_inv=${robokassa.id}`)
          .digest('hex')
          .toUpperCase();
        const result = Buffer.from(
          `OutSum=${outSum}&InvId=${String(row.numericId)}&SignatureValue=${signature}&Shp_inv=${robokassa.id}&Fee=8.37`,
        );
        const first = await service.receiveWebhook('robokassa', result, {}, '127.0.0.1');
        const repeated = await service.receiveWebhook('robokassa', result, {}, '127.0.0.1');
        assert.deepEqual(
          [first.body, repeated.body],
          [`OK${String(row.numericId)}`, `OK${String(row.numericId)}`],
        );
        assert.equal(first.contentType, 'text/plain');
        assert.equal(
          (await prisma.invoice.findUnique({ where: { id: robokassa.id } })).status,
          'paid',
        );
        assert.equal(await prisma.transaction.count({ where: { invoiceId: robokassa.id } }), 1);
      } finally {
        if (keyBeforeRobokassa === undefined) delete process.env.RR_APP_KEY;
        else process.env.RR_APP_KEY = keyBeforeRobokassa;
      }

      // AC-063c keeps a badly signed event for audit, but it must not take
      // the event id: a forged body naming the id of the real notification
      // used to make that notification a "duplicate" that was never applied.
      const target = await service.createInvoice({
        userId: user.id,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 7000n,
        idempotencyKey: 'm2-forged-first',
      });
      const forged = JSON.stringify({
        eventId: 'real-event',
        providerInvoiceId: target.providerInvoiceId,
        type: 'pending',
      });
      await assert.rejects(
        service.receiveWebhook(
          'mock',
          Buffer.from(forged),
          { 'x-mock-signature': 'forged' },
          '203.0.113.9',
        ),
        { code: 'WEBHOOK_INVALID_SIGNATURE' },
      );
      const audit = await prisma.paymentEvent.findFirst({
        where: { provider: 'mock', signatureOk: false, invoiceId: target.id },
      });
      assert.ok(audit, 'the forged event is kept for audit (AC-063c)');
      const genuine = JSON.stringify({
        eventId: 'real-event',
        providerInvoiceId: target.providerInvoiceId,
        type: 'paid',
        paidAmountMinorRub: '7000',
      });
      await service.receiveWebhook(
        'mock',
        Buffer.from(genuine),
        { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(genuine).digest('hex') },
        '127.0.0.1',
      );
      assert.equal((await prisma.invoice.findUnique({ where: { id: target.id } })).status, 'paid');

      // Section 9.7: a body that names no event is refused, not stored. With
      // no guard the insert reached Prisma with a null `type` and the webhook
      // path answered 500 to anything posted at it.
      const events = await prisma.paymentEvent.count();
      await assert.rejects(
        service.receiveWebhook('mock', Buffer.from('{}'), {}, '127.0.0.1'),
        (error) => error.name === 'PaymentError' && error.code === 'WEBHOOK_INVALID_SIGNATURE',
      );
      assert.equal(await prisma.paymentEvent.count(), events);

      // Repair queue P-6: every account the payment paths posted to — the
      // users, `provider_clearing`, `revenue` and `adjustment` — agrees with
      // its entries under the one sign convention.
      assert.deepEqual((await ledger.audit()).mismatches, []);

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
