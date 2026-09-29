import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/** A Valkey-free stand-in: the dashboard only uses the cache opportunistically. */
const noCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK'),
  del: () => Promise.resolve(0),
  publish: () => Promise.resolve(0),
};

test(
  'M4 admin surface: AC-140 search, AC-141 audited actions, AC-142 dashboard aggregates',
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
      const { DashboardService } =
        await import('../apps/api/dist/modules/admin-api/dashboard.service.js');
      const { AdminPaymentsService } =
        await import('../apps/api/dist/modules/admin-api/admin-payments.service.js');
      const { AdminUsersService } =
        await import('../apps/api/dist/modules/admin-api/admin-users.service.js');
      const prisma = createPrismaClient(databaseUrl);
      const infra = { db: prisma, redis: noCache };
      const settings = {
        get: (key) => Promise.resolve(key === 'operator.max_credit_minor' ? '100000' : '100000'),
      };
      const dashboard = new DashboardService(infra);
      const adminPayments = new AdminPaymentsService(infra, {}, settings);
      const users = new AdminUsersService(infra, settings, {});

      const admin = await prisma.admin.create({
        data: { email: 'owner@example.test', passwordHash: 'x', role: 'admin' },
      });
      const plan = await prisma.plan.create({
        data: {
          slug: 'm4-month',
          name: { ru: 'Месяц', en: 'Month' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });

      const created = [];
      for (let index = 0; index < 5; index += 1) {
        const user = await prisma.user.create({
          data: {
            telegramId: BigInt(994000000 + index),
            username: `m4user${String(index)}`,
            language: 'ru',
            referralCode: `M4USER${String(index)}`,
          },
        });
        await prisma.account.create({
          data: {
            kind: 'user',
            userId: user.id,
            currency: 'RUB',
            balanceMinor: BigInt(1000 * index),
          },
        });
        created.push(user);
      }

      // F37 (ADR-021): provider money is only top-ups; purchases spend the balance.
      await prisma.transaction.createMany({
        data: [
          {
            userId: created[0].id,
            type: 'topup',
            status: 'completed',
            amountMinor: 29900n,
            currency: 'RUB',
            provider: 'mock',
          },
          {
            userId: created[1].id,
            type: 'topup',
            status: 'completed',
            amountMinor: 29900n,
            currency: 'RUB',
            provider: 'mock',
          },
          {
            userId: created[2].id,
            type: 'topup',
            status: 'completed',
            amountMinor: 50000n,
            currency: 'RUB',
            provider: 'yookassa',
          },
          ...[0, 1, 2].map((index) => ({
            userId: created[index].id,
            type: 'purchase',
            status: 'completed',
            amountMinor: 29900n,
            currency: 'RUB',
            provider: 'balance',
          })),
          {
            userId: created[0].id,
            type: 'refund',
            status: 'completed',
            amountMinor: 10000n,
            currency: 'RUB',
            provider: 'balance',
          },
          {
            userId: created[3].id,
            type: 'referral_reward',
            status: 'completed',
            amountMinor: 5980n,
            currency: 'RUB',
          },
        ],
      });
      const receivedTopups = 29900n + 29900n + 50000n;
      const purchasedMinor = 3n * 29900n;
      const refundedMinor = 10000n;
      const topup = await prisma.invoice.create({
        data: {
          userId: created[0].id,
          kind: 'topup',
          provider: 'mock',
          status: 'paid',
          amountMinor: 29900n,
          currency: 'RUB',
          expiresAt: new Date(Date.now() + 3_600_000),
          idempotencyKey: 'm4-topup-1',
          number: '99-00001',
        },
      });
      await prisma.invoice.create({
        data: {
          userId: created[0].id,
          kind: 'purchase',
          provider: 'balance',
          status: 'paid',
          amountMinor: 29900n,
          currency: 'RUB',
          expiresAt: new Date(Date.now() + 3_600_000),
          idempotencyKey: 'm4-purchase-1',
        },
      });
      await prisma.subscription.createMany({
        data: [
          {
            userId: created[0].id,
            planId: plan.id,
            source: 'purchase',
            status: 'active',
            startsAt: new Date(),
            expiresAt: new Date(Date.now() + 2 * 86_400_000),
            trafficLimitBytes: 0n,
            trafficResetStrategy: 'NO_RESET',
            deviceLimit: 3,
            squads: [],
          },
          {
            userId: created[1].id,
            planId: plan.id,
            source: 'trial',
            status: 'active',
            startsAt: new Date(),
            expiresAt: new Date(Date.now() + 20 * 86_400_000),
            trafficLimitBytes: 0n,
            trafficResetStrategy: 'NO_RESET',
            deviceLimit: 1,
            squads: [],
          },
          {
            userId: created[4].id,
            planId: plan.id,
            source: 'trial',
            status: 'expired',
            startsAt: new Date(),
            expiresAt: new Date(Date.now() - 86_400_000),
            trafficLimitBytes: 0n,
            trafficResetStrategy: 'NO_RESET',
            deviceLimit: 1,
            squads: [],
          },
        ],
      });

      const from = new Date(Date.now() - 86_400_000);
      const to = new Date(Date.now() + 86_400_000);
      const overview = await dashboard.overview({ from: from.toISOString(), to: to.toISOString() });

      // AC-142: independent SQL control for every aggregate. Receipts are the
      // money providers brought in (F37): top-ups only.
      const [control] = await prisma.$queryRaw`
        SELECT
          (SELECT COALESCE(SUM(amount_minor), 0)
             FROM transactions
            WHERE status = 'completed' AND type = 'topup'
              AND provider IS NOT NULL AND provider <> 'balance'
              AND created_at BETWEEN ${from} AND ${to})::bigint AS receipts,
          (SELECT COUNT(*) FROM transactions
            WHERE status = 'completed' AND type = 'topup'
              AND provider IS NOT NULL AND provider <> 'balance'
              AND created_at BETWEEN ${from} AND ${to})::bigint AS payments,
          (SELECT COUNT(*) FROM users WHERE created_at BETWEEN ${from} AND ${to})::bigint AS new_users,
          (SELECT COUNT(*) FROM subscriptions WHERE source = 'trial'
              AND created_at BETWEEN ${from} AND ${to})::bigint AS trials,
          (SELECT COUNT(*) FROM subscriptions WHERE status = 'active')::bigint AS active,
          (SELECT COALESCE(SUM(balance_minor), 0) FROM accounts WHERE kind = 'user')::bigint AS liability,
          (SELECT COALESCE(SUM(amount_minor), 0) FROM transactions
            WHERE type = 'referral_reward' AND status = 'completed'
              AND created_at BETWEEN ${from} AND ${to})::bigint AS rewards`;

      assert.equal(overview.receipts.amountMinor, Number(receivedTopups));
      assert.equal(overview.payments, Number(control.payments));
      assert.equal(overview.newUsers, Number(control.new_users));
      assert.equal(overview.trialsIssued, Number(control.trials));
      assert.equal(overview.activeSubscriptions, Number(control.active));
      assert.equal(overview.userBalanceLiability.amountMinor, Number(control.liability));
      assert.equal(overview.referralRewards.amountMinor, Number(control.rewards));
      assert.equal(overview.receipts.amountMinor, Number(control.receipts));
      // Sales: purchases from the balance less refunds.
      assert.equal(overview.sales.amountMinor, Number(purchasedMinor - refundedMinor));
      assert.equal('revenue' in overview, false);
      assert.equal('lateInvoicePayments' in (await dashboard.attention()), false);
      assert.equal(overview.payments, 3);
      assert.equal(overview.averagePayment.amountMinor, Math.floor(109800 / 3));
      assert.equal(overview.expiringInThreeDays, 1);
      assert.equal(overview.trialConversionPercent, 50);
      assert.deepEqual(
        overview.topProviders.map((row) => [row.provider, row.total.amountMinor]),
        [
          ['yookassa', 50000],
          ['mock', 59800],
        ].sort((left, right) => right[1] - left[1]),
      );

      const series = await dashboard.series({ from: from.toISOString(), to: to.toISOString() });
      assert.equal(
        series.receipts.reduce((sum, row) => sum + row.amountMinor, 0),
        overview.receipts.amountMinor,
      );
      assert.equal(
        series.registrations.reduce((sum, row) => sum + row.count, 0),
        overview.newUsers,
      );

      const byNumber = await adminPayments.invoices({ number: topup.number });
      assert.deepEqual(
        byNumber.items.map((row) => row.id),
        [topup.id],
      );
      assert.equal(byNumber.items[0].number, topup.number);
      const topups = await adminPayments.invoices({ kind: 'topup' });
      assert.ok(topups.items.length > 0 && topups.items.every((row) => row.kind === 'topup'));

      // AC-140: search reaches a user by Telegram id and by username.
      const byTelegram = await users.list({ q: String(created[2].telegramId) });
      assert.equal(byTelegram.items.length, 1);
      assert.equal(byTelegram.items[0].id, created[2].id);
      const byUsername = await users.list({ q: 'm4user1' });
      assert.equal(byUsername.items[0].id, created[1].id);
      const activeOnly = await users.list({ status: 'active', limit: 100 });
      assert.deepEqual(
        activeOnly.items.map((row) => row.id).sort(),
        [created[0].id, created[1].id].sort(),
      );

      // AC-141: every action records an immutable audit row through the service result.
      const extend = await users.extend(
        created[0].id,
        { days: 7, reason: 'support request' },
        { id: admin.id, role: 'admin' },
      );
      assert.ok(extend.before.expiresAt < extend.after.expiresAt);
      const adjustment = await prisma.transaction.findFirst({
        where: { userId: created[0].id, type: 'adjustment' },
      });
      assert.equal(adjustment.amountMinor, 0n);
      assert.equal(adjustment.reason, 'support request');
      assert.equal(adjustment.actorAdminId, admin.id);

      const credit = await users.adjustBalance(
        created[0].id,
        { amountMinor: 2500, reason: 'goodwill' },
        { id: admin.id, role: 'admin' },
      );
      assert.equal(credit.after.balance.amountMinor, credit.before.balance.amountMinor + 2500);

      // Repair queue R2/R14/R70: a correction is a posting (11.7) —
      // `adjustment → user` to credit, `user → adjustment` to debit — with
      // the amount unsigned, the reason and the acting admin (11.6).
      const adjustmentAccount = await prisma.account.findFirstOrThrow({
        where: { kind: 'adjustment' },
      });
      const userAccount = await prisma.account.findFirstOrThrow({
        where: { kind: 'user', userId: created[0].id },
      });
      const entriesOf = async (accountId) => {
        const entries = await prisma.ledgerEntry.findMany({
          where: { OR: [{ debitAccountId: accountId }, { creditAccountId: accountId }] },
          orderBy: { id: 'asc' },
        });
        return Promise.all(
          entries.map(async (row) => {
            const transaction = await prisma.transaction.findUniqueOrThrow({
              where: { id: row.transactionId },
            });
            return {
              debit: row.debitAccountId,
              credit: row.creditAccountId,
              amountMinor: row.amountMinor,
              type: transaction.type,
              transactionAmountMinor: transaction.amountMinor,
              reason: transaction.reason,
              actorAdminId: transaction.actorAdminId,
            };
          }),
        );
      };
      const creditEntry = {
        debit: adjustmentAccount.id,
        credit: userAccount.id,
        amountMinor: 2500n,
        type: 'adjustment',
        transactionAmountMinor: 2500n,
        reason: 'goodwill',
        actorAdminId: admin.id,
      };
      assert.deepEqual(await entriesOf(userAccount.id), [creditEntry]);
      const debit = await users.adjustBalance(
        created[0].id,
        { amountMinor: -100, reason: 'correction' },
        { id: admin.id, role: 'admin' },
      );
      assert.equal(debit.after.balance.amountMinor, debit.before.balance.amountMinor - 100);
      assert.deepEqual(await entriesOf(userAccount.id), [
        creditEntry,
        {
          debit: userAccount.id,
          credit: adjustmentAccount.id,
          amountMinor: 100n,
          type: 'adjustment',
          transactionAmountMinor: 100n,
          reason: 'correction',
          actorAdminId: admin.id,
        },
      ]);

      // R70: a customer who never paid has no account yet; the first credit
      // opens it.
      const newcomer = await prisma.user.create({
        data: { telegramId: 994000100n, language: 'ru', referralCode: 'M4NEW001' },
      });
      const opened = await users.adjustBalance(
        newcomer.id,
        { amountMinor: 700, reason: 'welcome' },
        { id: admin.id, role: 'admin' },
      );
      assert.deepEqual(opened.after.balance, { amountMinor: 700, currency: 'RUB' });

      const { LedgerRepository } =
        await import('../apps/api/dist/modules/ledger/ledger.repository.js');
      const adjusted = new Set([
        adjustmentAccount.id,
        userAccount.id,
        (await prisma.account.findFirstOrThrow({ where: { kind: 'user', userId: newcomer.id } }))
          .id,
      ]);
      assert.deepEqual(
        (await new LedgerRepository(prisma).audit()).mismatches.filter((row) =>
          adjusted.has(row.accountId),
        ),
        [],
      );

      // Repair queue R15: the operator's daily limit (14.2, 100 000 here)
      // holds against parallel credits to different customers — five of 60 000
      // at once let exactly one through.
      const operator = await prisma.admin.create({
        data: { email: 'operator@example.test', passwordHash: 'x', role: 'operator' },
      });
      const targets = await Promise.all(
        [0, 1, 2, 3, 4].map((index) =>
          prisma.user.create({
            data: {
              telegramId: BigInt(994000200 + index),
              language: 'ru',
              referralCode: `M4LIM00${String(index)}`,
            },
          }),
        ),
      );
      const parallel = await Promise.allSettled(
        targets.map((target) =>
          users.adjustBalance(
            target.id,
            { amountMinor: 60_000, reason: 'compensation' },
            { id: operator.id, role: 'operator' },
          ),
        ),
      );
      assert.equal(parallel.filter((result) => result.status === 'fulfilled').length, 1);
      assert.ok(
        parallel
          .filter((result) => result.status === 'rejected')
          .every((result) => result.reason.getStatus() === 403),
      );
      const credited = await prisma.transaction.aggregate({
        where: { actorAdminId: operator.id, type: 'adjustment' },
        _sum: { amountMinor: true },
      });
      assert.equal(credited._sum.amountMinor, 60_000n);

      await assert.rejects(
        users.adjustBalance(
          created[0].id,
          { amountMinor: -10_000_000, reason: 'oops' },
          { id: admin.id, role: 'admin' },
        ),
        {
          response: {
            error: {
              code: 'INSUFFICIENT_FUNDS',
              message: 'INSUFFICIENT_FUNDS',
              messageKey: 'errors.insufficient_funds',
            },
          },
        },
      );

      const anonymized = await users.anonymize(created[3].id, { reason: 'gdpr request' });
      assert.equal(anonymized.after.username, null);
      const stored = await prisma.user.findUnique({ where: { id: created[3].id } });
      assert.ok(stored.telegramId < 0n);
      assert.ok(stored.anonymizedAt);
      assert.equal(
        await prisma.transaction.count({ where: { userId: created[3].id } }),
        1,
        'financial history survives anonymization',
      );

      // Migrations 0008/0009: a plan may keep no squads only while it cannot
      // be sold; such a plan can still be reordered, and cannot be activated.
      const legacy = await prisma.plan.create({
        data: {
          slug: 'legacy-no-squads',
          name: { ru: 'Старый', en: 'Legacy' },
          durationDays: 30,
          squads: [],
          priceMinor: 1000n,
          isActive: false,
        },
      });
      await prisma.plan.update({ where: { id: legacy.id }, data: { sortOrder: 5 } });
      await assert.rejects(
        prisma.plan.update({ where: { id: legacy.id }, data: { isActive: true } }),
        /plans_squads_nonempty/u,
      );
      await prisma.plan.update({ where: { id: legacy.id }, data: { deletedAt: new Date() } });

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
