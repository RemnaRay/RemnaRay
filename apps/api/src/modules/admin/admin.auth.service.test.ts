import { describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';

import { createTotp, encryptTotpSecret, hashAdminPassword } from './admin.crypto';
import { AdminAuthController } from './admin.controller';
import { AdminAuthService } from './admin.auth.service';

type MockRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  exists(key: string): Promise<number>;
};

function createFixture() {
  const values = new Map<string, string>();
  const admin = {
    id: 'admin-1',
    email: 'owner@example.com',
    passwordHash: '',
    role: 'admin' as const,
    isActive: true,
    deletedAt: null,
    totpEnabled: false,
    totpSecretEnc: null as string | null,
    failedLogins: 0,
    lockedUntil: null as Date | null,
    telegramId: null,
  };
  const redis: MockRedis = {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value, ...args) => {
      if (args.includes('NX') && values.has(key)) return Promise.resolve(null);
      values.set(key, value);
      return Promise.resolve('OK');
    },
    del: (key) => Promise.resolve(values.delete(key) ? 1 : 0),
    incr: (key) => {
      const next = Number(values.get(key) ?? '0') + 1;
      values.set(key, String(next));
      return Promise.resolve(next);
    },
    exists: (key) => Promise.resolve(values.has(key) ? 1 : 0),
    // The session index (R78) is covered by admin-sessions.test.ts.
    sadd: () => Promise.resolve(1),
    srem: () => Promise.resolve(1),
    smembers: () => Promise.resolve([]),
    expire: () => Promise.resolve(1),
  };
  const infra = {
    redis,
    db: {
      admin: {
        findUnique: ({ where }: { where: { id?: string; email?: string } }) =>
          Promise.resolve(where.id === admin.id || where.email === admin.email ? admin : null),
        findUniqueOrThrow: () => Promise.resolve(admin),
        update: ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && 'increment' in value) {
              const current = admin[key as 'failedLogins'];
              admin[key as 'failedLogins'] = current + (value as { increment: number }).increment;
            } else {
              Object.assign(admin, { [key]: value });
            }
          }
          return Promise.resolve(admin);
        },
      },
      auditLog: { create: vi.fn(() => Promise.resolve()) },
    },
  };
  return { admin, infra, values, service: new AdminAuthService(infra as never) };
}

describe('admin authentication', () => {
  it('locks the address on the fifth wrong password, not the admin (R81)', async () => {
    const fixture = createFixture();
    fixture.admin.passwordHash = await hashAdminPassword('correct');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = fixture.service.login(
        { email: fixture.admin.email, password: 'wrong' },
        '203.0.113.9',
      );
      await expect(result).rejects.toMatchObject({
        code: attempt === 5 ? 'ADMIN_LOCKED' : 'ADMIN_INVALID_CREDENTIALS',
      });
    }
    // Locked from that address, even with the right password…
    await expect(
      fixture.service.login({ email: fixture.admin.email, password: 'correct' }, '203.0.113.9'),
    ).rejects.toMatchObject({ code: 'ADMIN_LOCKED', status: 423 });
    // …while the admin, elsewhere, still signs in: an anonymous guesser
    // cannot lock them out.
    await expect(
      fixture.service.login({ email: fixture.admin.email, password: 'correct' }, '198.51.100.4'),
    ).resolves.toMatchObject({ requiresTotp: true });
    expect(fixture.admin.lockedUntil).toBeNull();
  }, 30_000);

  it('answers an unknown email exactly like a known one (R81)', async () => {
    const fixture = createFixture();
    for (let attempt = 1; attempt <= 5; attempt += 1)
      await expect(
        fixture.service.login({ email: 'nobody@example.com', password: 'wrong' }, '203.0.113.9'),
      ).rejects.toMatchObject({
        code: attempt === 5 ? 'ADMIN_LOCKED' : 'ADMIN_INVALID_CREDENTIALS',
      });
  }, 30_000);

  it('provisions TOTP and creates a 12-hour admin session after confirmation', async () => {
    const previousKey = process.env.RR_APP_KEY;
    process.env.RR_APP_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const fixture = createFixture();
      fixture.admin.passwordHash = await hashAdminPassword('correct');
      const login = await fixture.service.login(
        { email: fixture.admin.email, password: 'correct' },
        '192.0.2.1',
      );
      const setup = await fixture.service.setup({ challengeId: login.challengeId });
      const totp = OTPAuth.URI.parse(setup.otpauthUrl);
      const confirmed = await fixture.service.confirm({
        challengeId: login.challengeId,
        code: totp.generate(),
      });

      expect(confirmed.admin.role).toBe('admin');
      expect(confirmed.csrfToken).toHaveLength(43);
      expect(confirmed.sessionId).toHaveLength(43);
      expect(fixture.admin.totpEnabled).toBe(true);
      expect(fixture.infra.db.auditLog.create).toHaveBeenCalled();
      expect(fixture.admin.totpSecretEnc).not.toBeNull();
      expect(fixture.admin.totpSecretEnc).not.toContain(totp.secret.base32);
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }, 30_000);

  it('never writes the pending TOTP secret to Valkey in plaintext', async () => {
    const previousKey = process.env.RR_APP_KEY;
    process.env.RR_APP_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const fixture = createFixture();
      fixture.admin.passwordHash = await hashAdminPassword('correct');
      const login = await fixture.service.login(
        { email: fixture.admin.email, password: 'correct' },
        '192.0.2.1',
      );
      const setup = await fixture.service.setup({ challengeId: login.challengeId });
      const secret = OTPAuth.URI.parse(setup.otpauthUrl).secret.base32;
      const stored = [...fixture.values.values()].join('|');

      expect(stored).not.toContain(secret);
      expect(stored).toContain('pendingSecretEnc');
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }, 30_000);

  it('consumes the challenge so a replayed confirmation cannot mint a second session', async () => {
    const previousKey = process.env.RR_APP_KEY;
    process.env.RR_APP_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const fixture = createFixture();
      fixture.admin.passwordHash = await hashAdminPassword('correct');
      const login = await fixture.service.login(
        { email: fixture.admin.email, password: 'correct' },
        '192.0.2.1',
      );
      const setup = await fixture.service.setup({ challengeId: login.challengeId });
      const totp = OTPAuth.URI.parse(setup.otpauthUrl);
      await fixture.service.confirm({ challengeId: login.challengeId, code: totp.generate() });

      await expect(
        fixture.service.confirm({ challengeId: login.challengeId, code: totp.generate() }),
      ).rejects.toMatchObject({ code: 'ADMIN_INVALID_CREDENTIALS' });
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }, 30_000);
});

describe('wrong TOTP codes (R27)', () => {
  const appKey = Buffer.alloc(32, 7).toString('base64');

  async function enrolled() {
    const fixture = createFixture();
    const totp = createTotp(fixture.admin.email);
    fixture.admin.passwordHash = await hashAdminPassword('correct');
    fixture.admin.totpEnabled = true;
    fixture.admin.totpSecretEnc = encryptTotpSecret(totp.secret.base32, appKey);
    const login = () =>
      fixture.service.login({ email: fixture.admin.email, password: 'correct' }, '192.0.2.1');
    return { ...fixture, totp, login };
  }

  function wrong(code: string): string {
    return code === '000000' ? '111111' : '000000';
  }

  it('lock the admin on the fifth, however the attempts are spread over sign-ins', async () => {
    const previousKey = process.env.RR_APP_KEY;
    process.env.RR_APP_KEY = appKey;
    try {
      const { admin, totp, login, service, values } = await enrolled();
      const first = await login();
      for (let attempt = 1; attempt <= 3; attempt += 1)
        await expect(
          service.totp({ challengeId: first.challengeId, code: wrong(totp.generate()) }),
        ).rejects.toMatchObject({ code: 'ADMIN_TOTP_INVALID' });

      // The correct password used to reset the count.
      const second = await login();
      await expect(
        service.totp({ challengeId: second.challengeId, code: wrong(totp.generate()) }),
      ).rejects.toMatchObject({ code: 'ADMIN_TOTP_INVALID' });
      await expect(
        service.totp({ challengeId: second.challengeId, code: wrong(totp.generate()) }),
      ).rejects.toMatchObject({ code: 'ADMIN_LOCKED', status: 423 });

      expect(admin.lockedUntil).toBeInstanceOf(Date);
      // The challenge is gone, an older one is refused and spent, and neither
      // the password nor the right code opens the account.
      expect(values.has(`rr:admin:challenge:${second.challengeId}`)).toBe(false);
      await expect(
        service.totp({ challengeId: second.challengeId, code: totp.generate() }),
      ).rejects.toMatchObject({ code: 'ADMIN_INVALID_CREDENTIALS' });
      await expect(
        service.totp({ challengeId: first.challengeId, code: totp.generate() }),
      ).rejects.toMatchObject({ code: 'ADMIN_LOCKED' });
      expect(values.has(`rr:admin:challenge:${first.challengeId}`)).toBe(false);
      await expect(login()).rejects.toMatchObject({ code: 'ADMIN_LOCKED' });
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }, 60_000);

  it('are forgiven only by a completed sign-in', async () => {
    const previousKey = process.env.RR_APP_KEY;
    process.env.RR_APP_KEY = appKey;
    try {
      const { admin, totp, login, service } = await enrolled();
      const first = await login();
      await expect(
        service.totp({ challengeId: first.challengeId, code: wrong(totp.generate()) }),
      ).rejects.toMatchObject({ code: 'ADMIN_TOTP_INVALID' });
      expect(admin.failedLogins).toBe(1);

      await service.totp({ challengeId: first.challengeId, code: totp.generate() });
      expect(admin.failedLogins).toBe(0);
    } finally {
      if (previousKey === undefined) delete process.env.RR_APP_KEY;
      else process.env.RR_APP_KEY = previousKey;
    }
  }, 60_000);

  it('are rate limited like the password', () => {
    const handlers = Object.getOwnPropertyDescriptors(AdminAuthController.prototype);
    for (const handler of ['login', 'setup', 'totp', 'confirm'])
      expect(
        Reflect.getMetadata('THROTTLER:LIMITdefault', handlers[handler]?.value as object),
        handler,
      ).toBe(10);
  });
});
