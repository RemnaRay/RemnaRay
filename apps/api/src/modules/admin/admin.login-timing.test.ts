import { describe, expect, it, vi } from 'vitest';

const verify = vi.hoisted(() =>
  vi.fn<(passwordHash: string, password: string) => Promise<boolean>>(() => Promise.resolve(false)),
);
vi.mock('./admin.crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admin.crypto')>()),
  verifyAdminPassword: verify,
}));

import { AdminAuthService } from './admin.auth.service';

describe('sign-in timing (R81)', () => {
  // Without an Argon2 verify, an unknown email was answered in microseconds
  // and a known one in tens of milliseconds, which named the admins.
  it('runs the password check for an email that belongs to nobody', async () => {
    const values = new Map<string, string>();
    const infra = {
      redis: {
        get: (key: string) => Promise.resolve(values.get(key) ?? null),
        set: (key: string, value: string) => {
          values.set(key, value);
          return Promise.resolve('OK');
        },
        del: (key: string) => Promise.resolve(values.delete(key) ? 1 : 0),
        incr: (key: string) => {
          const next = Number(values.get(key) ?? '0') + 1;
          values.set(key, String(next));
          return Promise.resolve(next);
        },
        exists: (key: string) => Promise.resolve(values.has(key) ? 1 : 0),
        expire: () => Promise.resolve(1),
        sadd: () => Promise.resolve(1),
      },
      db: {
        admin: { findUnique: () => Promise.resolve(null) },
        auditLog: { create: () => Promise.resolve() },
      },
    };
    const service = new AdminAuthService(infra as never);

    await expect(
      service.login({ email: 'nobody@example.com', password: 'guess' }, '203.0.113.9'),
    ).rejects.toMatchObject({ code: 'ADMIN_INVALID_CREDENTIALS' });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[1]).toBe('guess');
    expect(verify.mock.calls[0]?.[0]).toMatch(/^\$argon2id\$/u);
  });
});
