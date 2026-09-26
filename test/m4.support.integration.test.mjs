import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

test(
  'F36 support tickets: one live ticket per customer, numbering, topics, the card',
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
      const { TicketsRepository } =
        await import('../apps/api/dist/modules/support/tickets.repository.js');
      const { loadCardData } = await import('../apps/api/dist/modules/support/card-data.js');
      const { SupportAdminService } =
        await import('../apps/api/dist/modules/support/support-admin.service.js');
      const { SupportService } =
        await import('../apps/api/dist/modules/support/support.service.js');
      const prisma = createPrismaClient(databaseUrl);
      const tickets = new TicketsRepository({ db: prisma });

      const user = await prisma.user.create({
        data: { telegramId: 42n, firstName: 'Anna', language: 'ru', referralCode: 'SUPPORT1' },
      });

      // Two messages arriving together open one ticket (the partial unique index).
      const racing = await Promise.all(
        Array.from({ length: 5 }, () => tickets.openOrLive(user.id, 'support', 'customer')),
      );
      assert.equal(racing.filter((result) => result.created).length, 1);
      assert.equal(new Set(racing.map((result) => result.ticket.id)).size, 1);
      const first = racing[0].ticket;
      assert.equal(first.number, 1n);
      assert.equal(first.status, 'open');

      await tickets.addMessage({
        ticketId: first.id,
        direction: 'customer',
        kind: 'photo',
        text: 'Screen',
        fileId: 'file-1',
        authorTelegramId: 42,
        operatorChatId: -100500,
        operatorMessageId: 77,
      });
      assert.equal((await tickets.byOperatorMessage(-100500, 77))?.id, first.id);
      assert.equal(await tickets.byOperatorMessage(-100500, 78), null);

      await tickets.setTopic(-100500, user.id, 71);
      assert.equal(await tickets.topic(-100500, user.id), 71);
      assert.equal(await tickets.userByTopic(-100500, 71), user.id);
      await tickets.setTopic(-100500, user.id, 72);
      assert.equal(await tickets.userByTopic(-100500, 71), null);

      // Closing is conditional: the second close finds nothing live.
      assert.equal((await tickets.closeIfLive(first.id, 'operator', true))?.closedSilently, true);
      assert.equal(await tickets.closeIfLive(first.id, 'operator', false), null);
      const second = await tickets.openOrLive(user.id, 'support', 'customer');
      assert.equal(second.created, true);
      assert.equal(second.ticket.number, 2n);

      // The card counts money received through providers only (F31).
      const plan = await prisma.plan.create({
        data: {
          slug: 'support-month',
          name: { ru: 'Месяц', en: 'Month' },
          durationDays: 30,
          squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
          priceMinor: 29900n,
        },
      });
      await prisma.account.create({
        data: { kind: 'user', userId: user.id, currency: 'RUB', balanceMinor: 5000n },
      });
      for (const [type, provider, amountMinor] of [
        ['topup', 'yookassa', 30000n],
        ['purchase', 'balance', 29900n],
        ['purchase', 'yookassa', 29900n],
      ])
        await prisma.transaction.create({
          data: {
            userId: user.id,
            type,
            status: 'completed',
            amountMinor,
            currency: 'RUB',
            provider,
            planId: plan.id,
          },
        });
      const card = await loadCardData(prisma, second.ticket, 'ru');
      assert.equal(card.money.receivedMinor, 59900n);
      assert.equal(card.money.payments, 2);
      assert.equal(card.money.balanceMinor, 5000n);
      assert.equal(card.money.lastPurchase?.plan, 'Месяц');
      assert.equal(card.support.tickets, 2);
      assert.equal(card.support.previous?.number, 1n);
      assert.equal(card.subscription, null);
      assert.equal(card.user.telegramId, '42');

      // Statistics over a period (F36): times in seconds, per operator.
      const now = Date.now();
      const at = (minutesAgo) => new Date(now - minutesAgo * 60_000);
      const other = await prisma.user.create({
        data: { telegramId: 43n, firstName: 'Boris', language: 'en', referralCode: 'SUPPORT2' },
      });
      await prisma.supportTicket.update({
        where: { id: second.ticket.id },
        data: {
          createdAt: at(100),
          firstResponseAt: at(90),
          takenAt: at(90),
          assigneeTelegramId: 7n,
          assigneeName: 'Olga',
          status: 'closed',
          closedAt: at(40),
          closedBy: 'operator',
          rating: 5,
          ratedAt: at(39),
        },
      });
      await prisma.supportTicket.create({
        data: {
          userId: other.id,
          channel: 'shop',
          createdAt: at(50),
          firstResponseAt: at(20),
          takenAt: at(20),
          status: 'in_progress',
          assigneeTelegramId: 8n,
          assigneeName: 'Pavel',
        },
      });
      // The first ticket was created now; move it out of the period.
      await prisma.supportTicket.update({
        where: { id: first.id },
        data: { createdAt: at(60 * 24 * 40), closedAt: at(60 * 24 * 40) },
      });
      const admin = new SupportAdminService({ db: prisma });
      const stats = await admin.stats({});
      assert.equal(stats.opened, 2);
      assert.equal(stats.closed, 1);
      assert.equal(stats.openNow, 1);
      assert.deepEqual(stats.firstResponseSeconds, { average: 1200, median: 1200 });
      assert.equal(stats.resolutionSeconds, 3600);
      assert.deepEqual(stats.rating, { average: 5, count: 1 });
      assert.deepEqual(
        stats.operators.map((row) => [row.name, row.closed, row.openNow, row.firstResponseSeconds]),
        [
          ['Olga', 1, 0, 600],
          ['Pavel', 0, 1, 1800],
        ],
      );

      // The minute sweep's SQL (F36): a ticket the customer left after the
      // operators' answer closes; one where the customer spoke last does not.
      const idle = await prisma.supportTicket.findFirstOrThrow({ where: { userId: other.id } });
      await prisma.supportTicket.update({
        where: { id: idle.id },
        data: { chatId: -100500n, lastCustomerAt: at(60 * 60), lastOperatorAt: at(60 * 49) },
      });
      const settingsValues = {
        'brand.support_forward_chat_id': -100500,
        'brand.name': 'Manta',
        'bot.token': '123:token',
        'bot.support_token': '',
        'bot.support_username': '',
        'locale.default': 'ru',
        'locale.timezone': 'UTC',
        'domain.main': 'shop.example.test',
        'support.remind_after_minutes': 15,
        'support.autoclose_hours': 48,
      };
      const telegram = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        telegram.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
        return globalThis.Response.json({ ok: true, result: { message_id: 1 } });
      };
      try {
        const service = new SupportService(
          {
            db: prisma,
            redis: { get: async () => null, set: async () => 'OK', del: async () => 1 },
          },
          { get: async (key) => settingsValues[key] },
          tickets,
          { messages: async () => ({}) },
        );
        assert.deepEqual(await service.sweep(), { reminded: 0, closed: 1 });
        const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: idle.id } });
        assert.equal(after.status, 'closed');
        assert.equal(after.closedBy, 'auto');
        assert.ok(telegram.some((call) => call.body.chat_id === 43));
        assert.deepEqual(await service.sweep(), { reminded: 0, closed: 0 });
      } finally {
        globalThis.fetch = realFetch;
      }

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
