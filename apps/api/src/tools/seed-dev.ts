/**
 * The section 22.3 fixture — "the shop after the wizard" — written straight
 * into a running deployment's database. The smoke stand of section 22.7 needs
 * it before it can log an administrator in and change a setting, and a
 * developer stand needs the same rows to have anything to look at.
 *
 * It prints the credentials it generated as JSON on stdout, because a random
 * TOTP secret that nobody can read is a stand nobody can log into.
 */
import process from 'node:process';
import { createPrismaClient } from '@remnaray/db';

import { createTotp, encryptTotpSecret, hashAdminPassword } from '../modules/admin/admin.crypto';
import { LedgerRepository } from '../modules/ledger/ledger.repository';
import { encryptSetting } from '../modules/settings/settings.crypto';

export type SeedFixture = {
  brand: { name: string };
  admin: { id: string; email: string; password: string; totpSecret: string };
  plans: { id: string; slug: string; name: string; priceMinor: string }[];
  user: {
    id: string;
    telegramId: string;
    username: string;
    firstName: string;
    referralCode: string;
  };
  domain: string;
};

/** Section 22.3: two plans, a trial, one administrator and the mock provider. */
export const PLAN_FIXTURES = [
  {
    slug: 'month-100',
    name: { ru: '30 дней / 100 ГБ', en: '30 days / 100 GB' },
    description: { ru: '3 устройства', en: '3 devices' },
    durationDays: 30,
    trafficLimitBytes: 100n * 1024n * 1024n * 1024n,
    deviceLimit: 3,
    priceMinor: 29_900n,
    sortOrder: 10,
  },
  {
    slug: 'month-unlimited',
    name: { ru: '30 дней / безлимит', en: '30 days / unlimited' },
    description: { ru: '5 устройств', en: '5 devices' },
    durationDays: 30,
    trafficLimitBytes: 0n,
    deviceLimit: 5,
    priceMinor: 59_900n,
    sortOrder: 20,
  },
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to seed a stand`);
  return value;
}

export async function seed(): Promise<SeedFixture> {
  const appKey = required('RR_APP_KEY');
  const domain = process.env.RR_DOMAIN ?? 'localhost';
  const brand = process.env.RR_SEED_BRAND ?? 'Manta';
  const email = process.env.RR_SEED_ADMIN_EMAIL ?? 'owner@example.test';
  const password = process.env.RR_SEED_ADMIN_PASSWORD ?? 'SmokePassword123';
  const prisma = createPrismaClient();

  try {
    const completed = await prisma.setting.findUnique({ where: { key: 'setup.completed' } });
    if (completed?.value === true && process.env.RR_SEED_FORCE !== 'true')
      throw new Error('This deployment has already been set up; refusing to seed over it');

    const totp = createTotp(email);
    const admin = await prisma.admin.create({
      data: {
        email,
        passwordHash: await hashAdminPassword(password),
        role: 'admin',
        totpEnabled: true,
        totpSecretEnc: encryptTotpSecret(totp.secret.base32, appKey),
      },
    });

    const plans = [];
    for (const fixture of PLAN_FIXTURES)
      plans.push(
        await prisma.plan.create({
          data: {
            slug: fixture.slug,
            name: fixture.name,
            description: fixture.description,
            durationDays: fixture.durationDays,
            trafficLimitBytes: fixture.trafficLimitBytes,
            deviceLimit: fixture.deviceLimit,
            squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
            priceMinor: fixture.priceMinor,
            isPublic: true,
            isActive: true,
            sortOrder: fixture.sortOrder,
          },
        }),
      );

    await prisma.paymentProvider.upsert({
      where: { code: 'mock' },
      update: { enabled: true },
      create: {
        code: 'mock',
        enabled: true,
        displayName: { ru: 'Тест', en: 'Mock' },
        sortOrder: 10,
        lastHealthcheckAt: new Date(),
        lastHealthcheckOk: true,
      },
    });

    await prisma.setting.createMany({
      data: [
        // Section 17.4: without this every route answers SETUP_NOT_COMPLETED.
        { key: 'setup.completed', value: true, isSecret: false },
        { key: 'brand.name', value: brand, isSecret: false },
        { key: 'bot.username', value: 'manta_smoke_bot', isSecret: false },
        { key: 'bot.token', value: encryptSetting('42:smoke-stand-token', appKey), isSecret: true },
        { key: 'trial.enabled', value: true, isSecret: false },
        { key: 'domain.main', value: domain, isSecret: false },
        { key: 'domain.extra_domains', value: [], isSecret: false },
      ],
      skipDuplicates: true,
    });

    const user = await prisma.user.create({
      data: {
        telegramId: 998_000_001n,
        username: 'smokeuser',
        firstName: 'Smoke',
        language: 'ru',
        referralCode: 'SMOKEUS1',
      },
    });
    // A real `adjustment → user` posting, so the nightly ledger audit (R19)
    // finds the seeded stand in agreement.
    await new LedgerRepository(prisma).post({
      userId: user.id,
      type: 'adjustment',
      amountMinor: 50_000n,
      currency: 'RUB',
      debit: { kind: 'adjustment' },
      credit: { kind: 'user', userId: user.id },
      reason: 'seed balance',
    });

    return {
      brand: { name: brand },
      admin: { id: admin.id, email, password, totpSecret: totp.secret.base32 },
      plans: plans.map((plan) => ({
        id: plan.id,
        slug: plan.slug,
        name: (plan.name as Record<string, string>)['ru'] ?? plan.slug,
        priceMinor: plan.priceMinor.toString(),
      })),
      user: {
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username ?? '',
        firstName: user.firstName ?? '',
        referralCode: user.referralCode,
      },
      domain,
    };
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('seed-dev.js')) {
  seed()
    .then((fixture) => {
      process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
