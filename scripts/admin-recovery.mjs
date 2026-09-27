import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { createPrismaClient } = require('/app/dist/packages/db/dist/index.js');
const { hashAdminPassword } = require('/app/dist/apps/api/modules/admin/admin.crypto.js');
const { endAdminSessions } = require('/app/dist/apps/api/modules/admin/admin-sessions.js');
const { clearPasswordFailures } = require('/app/dist/apps/api/modules/admin/admin.auth.service.js');
// ioredis is the API's dependency, resolved from its own package (the real
// path: `dist/apps/api` is a symlink into the deployed packages).
const Redis = createRequire(realpathSync('/app/dist/apps/api/main.js'))('ioredis');

const action = process.env.RR_RECOVERY_ACTION;
const email = process.env.RR_RECOVERY_EMAIL;
const password = process.env.RR_RECOVERY_PASSWORD;

function requireEmail() {
  if (!email) throw new Error('RR_RECOVERY_EMAIL is required');
  return email;
}

function requirePassword() {
  if (!password) throw new Error('RR_RECOVERY_PASSWORD is required');
  if (
    password.length < 12 ||
    !/[a-z]/u.test(password) ||
    !/[A-Z]/u.test(password) ||
    !/\d/u.test(password)
  )
    throw new Error('Password must have 12+ characters, lowercase, uppercase and digit');
  return password;
}

const db = createPrismaClient();
const redis = new Redis(process.env.VALKEY_URL ?? 'redis://valkey:6379/0', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

try {
  if (action === 'list') {
    const admins = await db.admin.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        totpEnabled: true,
        failedLogins: true,
        lockedUntil: true,
      },
      orderBy: { email: 'asc' },
    });
    process.stdout.write(
      `${JSON.stringify(admins, (_, value) => (value instanceof Date ? value.toISOString() : value), 2)}\n`,
    );
  } else if (action === 'reset-password') {
    const target = await db.admin.findUnique({ where: { email: requireEmail() } });
    if (!target || target.deletedAt) throw new Error(`Admin not found: ${email}`);
    const passwordHash = await hashAdminPassword(requirePassword());

    await db.$transaction(async (tx) => {
      await tx.admin.update({
        where: { id: target.id },
        data: { passwordHash, failedLogins: 0, lockedUntil: null },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          action: 'admins.recovery.reset-password',
          entity: 'admin',
          entityId: target.id,
          reason: 'SSH recovery',
          before: {
            id: target.id,
            failedLogins: target.failedLogins,
            lockedUntil: target.lockedUntil?.toISOString() ?? null,
          },
          after: { id: target.id, passwordReset: true, failedLogins: 0, lockedUntil: null },
        },
      });
    });
    // R78 and R81: the admin's sessions end, and what wrong passwords locked
    // is lifted, exactly as a reset from the console does.
    await endAdminSessions(redis, target.id);
    await clearPasswordFailures(redis, target.email);
    process.stdout.write(`Password reset completed for ${email}\n`);
  } else if (action === 'reset-totp') {
    const target = await db.admin.findUnique({ where: { email: requireEmail() } });
    if (!target || target.deletedAt) throw new Error(`Admin not found: ${email}`);

    await db.$transaction(async (tx) => {
      await tx.admin.update({
        where: { id: target.id },
        data: { totpEnabled: false, totpSecretEnc: null },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          action: 'admins.recovery.reset-totp',
          entity: 'admin',
          entityId: target.id,
          reason: 'SSH recovery',
          before: { id: target.id, totpEnabled: target.totpEnabled },
          after: { id: target.id, totpEnabled: false },
        },
      });
    });
    await endAdminSessions(redis, target.id);
    process.stdout.write(`TOTP reset completed for ${email}\n`);
  } else {
    throw new Error('RR_RECOVERY_ACTION must be list, reset-password or reset-totp');
  }
} finally {
  await db.$disconnect();
  redis.disconnect();
}
