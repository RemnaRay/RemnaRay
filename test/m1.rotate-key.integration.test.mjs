import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * R29, section 17.1 p. 4: `pnpm rr:rotate-key --old --new` re-encrypts every
 * `is_secret` setting and `*_enc` column. It did not exist, so a leaked
 * `RR_APP_KEY` could not be replaced. Run as the deployment runs it — the
 * built tool against a migrated database — with the keys in its environment
 * (what `./scripts/rr rotate-key` does) and in the specification's flags.
 */
test('M1 rotate-key re-encrypts the stored secrets in one go', { timeout: 240_000 }, async () => {
  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('remnaray')
    .withUsername('remnaray')
    .withPassword('remnaray')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  let prisma;
  try {
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    const { createPrismaClient } = await import('../packages/db/dist/index.js');
    const { decryptSetting, encryptSetting } =
      await import('../apps/api/dist/modules/settings/settings.crypto.js');
    prisma = createPrismaClient(databaseUrl);
    const first = randomBytes(32).toString('base64');
    const second = randomBytes(32).toString('base64');
    const third = randomBytes(32).toString('base64');

    await prisma.setting.create({
      data: { key: 'bot.token', value: encryptSetting('123:abc', first), isSecret: true },
    });
    await prisma.setting.create({ data: { key: 'shop.name', value: 'Shop', isSecret: false } });
    await prisma.paymentProvider.upsert({
      where: { code: 'yookassa' },
      create: {
        code: 'yookassa',
        enabled: false,
        sortOrder: 10,
        displayName: { ru: 'ЮKassa', en: 'YooKassa' },
        configEnc: encryptSetting({ secretKey: 'live' }, first).enc,
      },
      update: { configEnc: encryptSetting({ secretKey: 'live' }, first).enc },
    });
    const admin = await prisma.admin.create({
      data: {
        email: 'owner@example.test',
        passwordHash: 'x',
        role: 'admin',
        totpSecretEnc: encryptSetting('JBSWY3DP', first).enc,
        totpEnabled: true,
      },
    });

    const rotate = (args, keys = {}) =>
      spawnSync('node', ['apps/api/dist/tools/rotate-key.js', ...args], {
        env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, ...keys },
        encoding: 'utf8',
      });
    const stored = async () => ({
      token: (await prisma.setting.findUnique({ where: { key: 'bot.token' } })).value,
      config: (await prisma.paymentProvider.findUnique({ where: { code: 'yookassa' } })).configEnc,
      totp: (await prisma.admin.findUnique({ where: { id: admin.id } })).totpSecretEnc,
    });

    // The keys from the environment, as `./scripts/rr rotate-key` passes them.
    const rotated = rotate([], { RR_OLD_APP_KEY: first, RR_NEW_APP_KEY: second });
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.match(rotated.stdout, /1 settings, 1 providers, 1 admins/u);
    const after = await stored();
    assert.equal(decryptSetting(after.token, second), '123:abc');
    assert.deepEqual(decryptSetting({ enc: after.config }, second), { secretKey: 'live' });
    assert.equal(decryptSetting({ enc: after.totp }, second), 'JBSWY3DP');
    assert.equal((await prisma.setting.findUnique({ where: { key: 'shop.name' } })).value, 'Shop');
    assert.doesNotMatch(rotated.stdout + rotated.stderr, new RegExp(second.slice(0, 12), 'u'));

    // Run again with the key that is no longer in use: refused, nothing moves.
    const again = rotate([], { RR_OLD_APP_KEY: first, RR_NEW_APP_KEY: third });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /does not decrypt/u);
    assert.deepEqual(await stored(), after);

    // The specification's flags.
    const flags = rotate(['--old', second, '--new', third]);
    assert.equal(flags.status, 0, flags.stderr);
    assert.equal(decryptSetting((await stored()).token, third), '123:abc');
  } finally {
    await prisma?.$disconnect();
    await postgres.stop();
  }
});
