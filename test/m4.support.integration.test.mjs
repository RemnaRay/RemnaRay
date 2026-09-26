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

      await prisma.$disconnect();
    } finally {
      await postgres.stop();
    }
  },
);
