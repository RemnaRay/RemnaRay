import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Migration 0014 on a real PostgreSQL (F37, ADR-021): the receipt template
 * moves to the numbered top-up line unless the owner edited it, the stored
 * `referral.count_topups` is dropped, and the CHECKs hold for new rows.
 */
test(
  'M1 migration 0014 numbers top-ups, moves the receipt template and guards invoices',
  { timeout: 180_000 },
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
      prisma = createPrismaClient(postgres.getConnectionUri());
      const sql = await readFile(
        'packages/db/prisma/migrations/0014_balance_only_purchases/migration.sql',
        'utf8',
      );
      // Only the data statements can run twice; the DDL ran with the deploy.
      const run = async () => {
        for (const statement of sql
          .replaceAll(/^--.*$/gmu, '')
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part.startsWith('DELETE') || part.startsWith('UPDATE')))
          await prisma.$executeRawUnsafe(statement);
      };
      const template = async () =>
        (await prisma.setting.findUniqueOrThrow({ where: { key: 'fiscal.item_name_template' } }))
          .value;

      // Before 0014 ran again: the old default and a stored count_topups.
      await prisma.setting.upsert({
        where: { key: 'fiscal.item_name_template' },
        create: { key: 'fiscal.item_name_template', value: 'Subscription {plan}' },
        update: { value: 'Subscription {plan}' },
      });
      await prisma.setting.create({ data: { key: 'referral.count_topups', value: true } });
      await run();
      assert.equal(await template(), 'Пополнение баланса (#{number})');
      assert.equal(await prisma.setting.count({ where: { key: 'referral.count_topups' } }), 0);

      // A template the owner edited is left alone.
      await prisma.setting.update({
        where: { key: 'fiscal.item_name_template' },
        data: { value: '{brand}: пополнение (#{number})' },
      });
      await run();
      assert.equal(await template(), '{brand}: пополнение (#{number})');

      // The CHECKs hold for new rows.
      const user = await prisma.user.create({
        data: { telegramId: 991400001n, language: 'ru', referralCode: 'M1F37001' },
      });
      await assert.rejects(
        prisma.$executeRawUnsafe(
          `INSERT INTO invoices (user_id, kind, provider, status, amount_minor, currency, idempotency_key, expires_at)
           VALUES ($1::uuid, 'purchase', 'yookassa', 'pending', 100, 'RUB', 'f37-a', now())`,
          user.id,
        ),
        /ck_invoices_provider_topup/,
      );
      await assert.rejects(
        prisma.$executeRawUnsafe(
          `INSERT INTO invoices (user_id, kind, provider, status, amount_minor, currency, idempotency_key, expires_at, target_kind)
           VALUES ($1::uuid, 'topup', 'yookassa', 'pending', 100, 'RUB', 'f37-b', now(), 'purchase')`,
          user.id,
        ),
        /ck_invoices_target/,
      );
    } finally {
      await prisma?.$disconnect();
      await postgres.stop();
    }
  },
);
