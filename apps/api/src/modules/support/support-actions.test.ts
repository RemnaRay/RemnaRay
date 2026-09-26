import { HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { Audited } from '../admin/audit.interceptor';
import { ApiError } from '../me/me.errors';
import { SupportActions } from './support-actions';

function actions(admin: { id: string; role: string } | null) {
  const db = {
    admin: { findFirst: vi.fn().mockResolvedValue(admin) },
    panelUser: {
      findUnique: vi.fn().mockResolvedValue({ subscriptionUrl: 'https://sub.example.test/x' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const users = {
    extend: vi
      .fn()
      .mockResolvedValue(
        new Audited(
          { expiresAt: '2026-10-01T00:00:00.000Z' },
          { expiresAt: '2026-10-08T00:00:00.000Z' },
        ),
      ),
    resetTraffic: vi
      .fn()
      .mockResolvedValue(new Audited({ usedTrafficBytes: 5 }, { usedTrafficBytes: 0 })),
    adjustBalance: vi.fn().mockResolvedValue(new Audited({ balance: 0 }, { balance: 150 })),
  };
  return { instance: new SupportActions({ db } as never, users as never), db, users };
}

describe('card actions (F36)', () => {
  it('refuses a group member who is not a console admin', async () => {
    const { instance, users } = actions(null);
    await expect(instance.run({ kind: 'extend', days: 7 }, 'u1', 7, 3)).resolves.toEqual({
      ok: false,
      reason: 'not_admin',
    });
    expect(users.extend).not.toHaveBeenCalled();
  });

  it('extends through the console’s code and writes its audit row with the ticket', async () => {
    const { instance, users, db } = actions({ id: 'a1', role: 'operator' });
    await expect(
      instance.run({ kind: 'extend', days: 7, reason: 'outage' }, 'u1', 7, 3),
    ).resolves.toEqual({
      ok: true,
      kind: 'extend',
      expiresAt: new Date('2026-10-08T00:00:00.000Z'),
    });
    expect(users.extend).toHaveBeenCalledWith(
      'u1',
      { days: 7, reason: 'support #3: outage' },
      { id: 'a1', role: 'operator' },
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorAdminId: 'a1',
        action: 'users.extend',
        entity: 'user',
        entityId: 'u1',
        before: { expiresAt: '2026-10-01T00:00:00.000Z' },
        after: { expiresAt: '2026-10-08T00:00:00.000Z' },
        reason: 'support #3: outage',
      }) as object,
    });
  });

  it('credits in kopecks under the operator’s daily limit, and says when it is reached', async () => {
    const { instance, users, db } = actions({ id: 'a1', role: 'operator' });
    await expect(
      instance.run({ kind: 'credit', amountMinor: 15_050n }, 'u1', 7, 3),
    ).resolves.toEqual({ ok: true, kind: 'credit', amountMinor: 15_050n });
    expect(users.adjustBalance).toHaveBeenCalledWith(
      'u1',
      { amountMinor: '15050', reason: 'support #3' },
      { id: 'a1', role: 'operator' },
    );
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);

    users.adjustBalance.mockRejectedValueOnce(new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN));
    await expect(
      instance.run({ kind: 'credit', amountMinor: 10_000_000n }, 'u1', 7, 3),
    ).resolves.toEqual({ ok: false, reason: 'limit' });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('names a missing subscription or panel record instead of failing', async () => {
    const { instance, users, db } = actions({ id: 'a1', role: 'admin' });
    users.extend.mockRejectedValueOnce(new NotFoundException('NOT_FOUND'));
    await expect(instance.run({ kind: 'extend', days: 7 }, 'u1', 7, 3)).resolves.toEqual({
      ok: false,
      reason: 'no_subscription',
    });
    users.resetTraffic.mockRejectedValueOnce(new NotFoundException('NOT_FOUND'));
    await expect(instance.run({ kind: 'reset' }, 'u1', 7, 3)).resolves.toEqual({
      ok: false,
      reason: 'no_panel',
    });
    db.panelUser.findUnique.mockResolvedValueOnce(null);
    await expect(instance.run({ kind: 'link' }, 'u1', 7, 3)).resolves.toEqual({
      ok: false,
      reason: 'no_panel',
    });
    await expect(instance.run({ kind: 'link' }, 'u1', 7, 3)).resolves.toEqual({
      ok: true,
      kind: 'link',
      url: 'https://sub.example.test/x',
    });
  });
});
