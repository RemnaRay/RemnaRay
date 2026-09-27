import * as OTPAuth from 'otpauth';
import { describe, expect, it, vi } from 'vitest';

import { AdminAuthService } from './admin.auth.service';
import { hashAdminPassword } from './admin.crypto';
import { AdminsService } from './admins.service';

const APP_KEY = Buffer.alloc(32, 7).toString('base64');

/** Enough of Valkey for the admin sessions: strings and sets. */
function memoryValkey() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    strings,
    get: (key: string) => Promise.resolve(strings.get(key) ?? null),
    set: (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && strings.has(key)) return Promise.resolve(null);
      strings.set(key, value);
      return Promise.resolve('OK' as const);
    },
    del: (...keys: string[]) =>
      Promise.resolve(keys.filter((key) => strings.delete(key) || sets.delete(key)).length),
    sadd: (key: string, ...members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      const before = set.size;
      for (const member of members) set.add(member);
      return Promise.resolve(set.size - before);
    },
    srem: (key: string, ...members: string[]) =>
      Promise.resolve(members.filter((member) => sets.get(key)?.delete(member)).length),
    smembers: (key: string) => Promise.resolve([...(sets.get(key) ?? [])]),
    expire: () => Promise.resolve(1),
  };
}

async function signedIn() {
  const admin = {
    id: 'a1',
    email: 'owner@example.com',
    passwordHash: await hashAdminPassword('Correct1Password'),
    role: 'admin' as const,
    isActive: true,
    deletedAt: null as Date | null,
    totpEnabled: false,
    totpSecretEnc: null as string | null,
    failedLogins: 0,
    lockedUntil: null as Date | null,
    telegramId: null,
    lastLoginAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const second = { ...admin, id: 'a2', email: 'second@example.com' };
  const rows = [admin, second];
  const redis = memoryValkey();
  const db = {
    admin: {
      findUnique: ({ where }: { where: { id?: string; email?: string } }) =>
        Promise.resolve(
          rows.find((row) => row.id === where.id || row.email === where.email) ?? null,
        ),
      findUniqueOrThrow: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id)),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id && !row.deletedAt) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('not found');
        for (const [key, value] of Object.entries(data))
          if (value && typeof value === 'object' && 'increment' in value)
            Object.assign(row, { [key]: row.failedLogins + 1 });
          else Object.assign(row, { [key]: value });
        return Promise.resolve(row);
      },
    },
    auditLog: { create: vi.fn(() => Promise.resolve()) },
    $queryRaw: () => Promise.resolve([{ id: 'a2' }]),
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  const infra = { redis, db } as never;
  const auth = new AdminAuthService(infra);
  const admins = new AdminsService(infra);

  const login = await auth.login({ email: admin.email, password: 'Correct1Password' });
  const setup = await auth.setup({ challengeId: login.challengeId });
  const totp = OTPAuth.URI.parse(setup.otpauthUrl);
  const { sessionId } = await auth.confirm({
    challengeId: login.challengeId,
    code: totp.generate(),
  });
  return { admin, auth, admins, sessionId, totp };
}

describe('an admin`s sessions end with the credentials (R78)', () => {
  const previousKey = process.env.RR_APP_KEY;

  async function withKey(run: () => Promise<void>) {
    process.env.RR_APP_KEY = APP_KEY;
    try {
      await run();
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }

  it(
    'when the password is reset',
    () =>
      withKey(async () => {
        const { auth, admins, sessionId } = await signedIn();
        expect(await auth.session(sessionId)).toMatchObject({ adminId: 'a1' });

        await admins.resetPassword('a1', { password: 'Another1Password', reason: 'leaked' });

        expect(await auth.session(sessionId)).toBeUndefined();
      }),
    60_000,
  );

  it(
    'when TOTP is reset, even after the admin enrols again',
    () =>
      withKey(async () => {
        const { admin, auth, admins, sessionId } = await signedIn();

        await admins.resetTotp('a1');
        // Enrolling again used to make the stolen session valid once more.
        const login = await auth.login({ email: admin.email, password: 'Correct1Password' });
        const setup = await auth.setup({ challengeId: login.challengeId });
        const fresh = await auth.confirm({
          challengeId: login.challengeId,
          code: OTPAuth.URI.parse(setup.otpauthUrl).generate(),
        });

        expect(await auth.session(sessionId)).toBeUndefined();
        expect(await auth.session(fresh.sessionId)).toMatchObject({ adminId: 'a1' });
      }),
    60_000,
  );

  it(
    'when the admin is deactivated',
    () =>
      withKey(async () => {
        const { auth, admins, sessionId } = await signedIn();

        await admins.deactivate('a1', { reason: 'leaving' });

        expect(await auth.session(sessionId)).toBeUndefined();
      }),
    60_000,
  );
});
