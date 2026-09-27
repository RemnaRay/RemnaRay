import { describe, expect, it } from 'vitest';

import { AdminsService } from './admins.service';
import { Audited } from './audit.interceptor';

type Row = {
  id: string;
  email: string;
  role: 'admin' | 'operator';
  telegramId: bigint | null;
  isActive: boolean;
  totpEnabled: boolean;
  totpSecretEnc: string | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  passwordHash: string;
};

function row(id: string, role: 'admin' | 'operator', isActive = true): Row {
  return {
    id,
    email: `${id}@example.com`,
    role,
    telegramId: null,
    isActive,
    totpEnabled: true,
    totpSecretEnc: 'enc',
    lastLoginAt: null,
    lockedUntil: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    passwordHash: 'hash',
  };
}

function fixture(rows: Row[]) {
  const db = {
    admin: {
      findMany: () => Promise.resolve(rows.filter((item) => !item.deletedAt)),
      findUnique: ({ where }: { where: { email?: string; id?: string } }) =>
        Promise.resolve(
          rows.find((item) => item.email === where.email || item.id === where.id) ?? null,
        ),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((item) => item.id === where.id && !item.deletedAt) ?? null),
      create: ({ data }: { data: Partial<Row> }) => {
        const created: Row = { ...row('created', data.role ?? 'operator'), ...data };
        rows.push(created);
        return Promise.resolve(created);
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const target = rows.find((item) => item.id === where.id);
        if (!target) throw new Error('not found');
        Object.assign(target, data);
        return Promise.resolve(target);
      },
    },
    $queryRaw: (strings: TemplateStringsArray, id: string) =>
      Promise.resolve(
        rows
          .filter(
            (item) => item.role === 'admin' && item.isActive && !item.deletedAt && item.id !== id,
          )
          .map((item) => ({ id: item.id })),
      ),
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  // Ending the sessions (R78) is covered by admin-sessions.test.ts.
  const redis = { smembers: () => Promise.resolve([]), del: () => Promise.resolve(0) };
  return { rows, service: new AdminsService({ db, redis } as never) };
}

describe('admins management (FR-143)', () => {
  it('rejects deactivating the last active admin with LAST_ADMIN', async () => {
    const test = fixture([row('a1', 'admin'), row('o1', 'operator')]);

    await expect(test.service.deactivate('a1', { reason: 'leaving' })).rejects.toMatchObject({
      response: { error: { code: 'LAST_ADMIN' } },
      status: 409,
    });
    expect(test.rows[0]?.isActive).toBe(true);
  });

  it('rejects demoting the last active admin', async () => {
    const test = fixture([row('a1', 'admin')]);

    await expect(
      test.service.update('a1', { role: 'operator', reason: 'handover' }),
    ).rejects.toMatchObject({ response: { error: { code: 'LAST_ADMIN' } } });
  });

  it('allows deactivating an admin while another active admin remains', async () => {
    const test = fixture([row('a1', 'admin'), row('a2', 'admin')]);
    const result = await test.service.deactivate('a1', { reason: 'leaving' });

    expect(result).toBeInstanceOf(Audited);
    expect((result.before as { isActive: boolean }).isActive).toBe(true);
    expect((result.after as { isActive: boolean }).isActive).toBe(false);
    expect(test.rows[0]?.isActive).toBe(false);
  });

  it('ignores inactive and deleted admins when counting survivors', async () => {
    const inactive = row('a2', 'admin', false);
    const deleted = row('a3', 'admin');
    deleted.deletedAt = new Date();
    const test = fixture([row('a1', 'admin'), inactive, deleted]);

    await expect(test.service.deactivate('a1', { reason: 'leaving' })).rejects.toMatchObject({
      response: { error: { code: 'LAST_ADMIN' } },
    });
  });

  it('clears TOTP enrolment so the next login runs first-login setup', async () => {
    const test = fixture([row('a1', 'admin')]);
    const result = await test.service.resetTotp('a1');

    expect((result.after as { totpEnabled: boolean }).totpEnabled).toBe(false);
    expect(test.rows[0]?.totpSecretEnc).toBeNull();
  });

  it('requires a strong password when creating an administrator', async () => {
    const test = fixture([row('a1', 'admin')]);

    await expect(
      test.service.create({ email: 'new@example.com', password: 'short', role: 'operator' }),
    ).rejects.toThrow();
  });

  it('never returns a password hash in the audited state', async () => {
    const test = fixture([row('a1', 'admin')]);
    const result = await test.service.create({
      email: 'new@example.com',
      password: 'Sufficient1Password',
      role: 'operator',
    });

    expect(result.before).toBeNull();
    expect(JSON.stringify(result.after)).not.toContain('hash');
  }, 30_000);
});
