import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

test(
  'M4 notifications: AC-160 a repeated cron window never sends twice, the top-up notice, AC-163 alerts dedup hourly',
  { timeout: 300_000 },
  async () => {
    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    const databaseUrl = postgres.getConnectionUri();
    const previousFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(init?.body ?? '{}') });
      return Promise.resolve(new globalThis.Response('{"ok":true}', { status: 200 }));
    };
    const locks = new Map();
    const redis = {
      set: (key, _value, _mode, ttl, flag) => {
        if (flag === 'NX' && locks.has(key)) return Promise.resolve(null);
        locks.set(key, ttl);
        return Promise.resolve('OK');
      },
      get: () => Promise.resolve(null),
      del: () => Promise.resolve(1),
      publish: () => Promise.resolve(0),
    };

    try {
      execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
      const { createPrismaClient } = await import('../packages/db/dist/index.js');
      const { NotifyService } = await import('../apps/api/dist/modules/notify/notify.service.js');
      const { I18nService } = await import('../apps/api/dist/modules/public/i18n.service.js');

      const prisma = createPrismaClient(databaseUrl);
      const infra = { db: prisma, redis };
      const settings = {
        get: (key) =>
          Promise.resolve(
            key === 'bot.token' ? 'test-token' : key === 'admin.language' ? 'ru' : '',
          ),
      };
      const i18n = new I18nService(infra);
      const notify = new NotifyService(infra, settings, i18n);

      const user = await prisma.user.create({
        data: { telegramId: 996000001n, language: 'ru', referralCode: 'NOTIFY01' },
      });
      const subscription = await prisma.subscription.create({
        data: {
          userId: user.id,
          source: 'purchase',
          status: 'active',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 2.5 * 86_400_000),
          trafficLimitBytes: 0n,
          trafficResetStrategy: 'NO_RESET',
          deviceLimit: 3,
          squads: [],
        },
      });

      // AC-160: three cron windows, one delivery.
      assert.deepEqual(await notify.scanExpiring(), { queued: 1 });
      assert.deepEqual(await notify.scanExpiring(), { queued: 0 });
      assert.deepEqual(await notify.scanExpiring(), { queued: 0 });

      const rows = await prisma.notificationLog.findMany({ where: { userId: user.id } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].event, 'sub.expires_in_3d');
      assert.equal(rows[0].dedupKey, `sub.expires_in_3d:${subscription.id}`);
      assert.equal(rows[0].status, 'sent');
      assert.ok(rows[0].sentAt);
      assert.equal(sent.filter((call) => call.url.includes('sendMessage')).length, 1);
      assert.match(sent[0].body.text, /через 3 дня/u);

      // The one-day window is a separate dedup key and does send.
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt: new Date(Date.now() + 0.5 * 86_400_000) },
      });
      assert.deepEqual(await notify.scanExpiring(), { queued: 1 });
      assert.equal(await prisma.notificationLog.count({ where: { userId: user.id } }), 2);

      // A blocked user is never delivered to (section 16.2).
      await prisma.user.update({ where: { id: user.id }, data: { botBlockedAt: new Date() } });
      const blocked = await notify.send({
        event: 'sub.expired',
        userId: user.id,
        dedupKey: `sub.expired:${subscription.id}`,
      });
      assert.deepEqual(blocked, { status: 'skipped_blocked' });
      const blockedRow = await prisma.notificationLog.findFirst({
        where: { userId: user.id, event: 'sub.expired' },
      });
      assert.equal(blockedRow.status, 'skipped_blocked');

      // F37: the top-up notice names the invoice and, for a top-up for a
      // plan still on sale, the plan to buy; an underpayment names both
      // amounts. The params are what `applyEvent` writes.
      const payer = await prisma.user.create({
        data: { telegramId: 996000002n, language: 'ru', referralCode: 'NOTIFY02' },
      });
      const toBalance = async (dedupKey, params) => {
        assert.deepEqual(
          await notify.send({ event: 'payment.to_balance', userId: payer.id, dedupKey, params }),
          { status: 'sent' },
        );
        return sent.filter((call) => call.url.includes('sendMessage')).at(-1).body.text;
      };
      assert.equal(
        await toBalance('payment.to_balance:f37-plan', {
          amount: '299 \u20bd',
          hasNumber: 'yes',
          number: '99-00001',
          underpaid: 'no',
          expected: '',
          hasPlan: 'yes',
          plan: 'Премиум',
          buyInvoice: '0199aaaa-0000-7000-8000-000000000001',
        }),
        'Баланс пополнен на 299 \u20bd (счёт #99-00001).\nТеперь можно купить «Премиум».',
      );
      assert.equal(
        await toBalance('payment.to_balance:f37-short', {
          amount: '150 \u20bd',
          hasNumber: 'yes',
          number: '99-00002',
          underpaid: 'yes',
          expected: '299 \u20bd',
          hasPlan: 'no',
          plan: '',
          buyInvoice: '',
        }),
        'Получено 150 \u20bd из 299 \u20bd по счёту #99-00002 — зачислено на баланс.',
      );
      assert.equal(
        await toBalance('payment.to_balance:f37-stars', {
          amount: '50 \u20bd',
          hasNumber: 'no',
          number: '',
          underpaid: 'no',
          expected: '',
          hasPlan: 'no',
          plan: '',
          buyInvoice: '',
        }),
        'Баланс пополнен на 50 \u20bd.',
      );

      // AC-163: one administrator alert per type per hour.
      await prisma.admin.create({
        data: {
          email: 'alerts@example.test',
          passwordHash: 'x',
          role: 'admin',
          telegramId: 996000999n,
        },
      });
      const firstAlert = await notify.alert({ type: 'panel.down' });
      const secondAlert = await notify.alert({ type: 'panel.down' });
      const otherAlert = await notify.alert({ type: 'queue.failed_high' });
      assert.deepEqual(firstAlert, { delivered: 1, deduplicated: false });
      assert.deepEqual(secondAlert, { delivered: 0, deduplicated: true });
      assert.deepEqual(otherAlert, { delivered: 1, deduplicated: false });

      await prisma.$disconnect();
    } finally {
      globalThis.fetch = previousFetch;
      await postgres.stop();
    }
  },
);
