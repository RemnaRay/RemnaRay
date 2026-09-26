import { describe, expect, it, vi } from 'vitest';

import { AdminUsersService } from './admin-users.service';
import { Audited } from '../admin/audit.interceptor';

const user = {
  id: 'user-1',
  telegramId: 123n,
  username: 'manta',
  firstName: 'Manta',
  language: 'ru',
  email: 'a@example.test',
  referralCode: 'AB12CD34',
  isBanned: false,
  botBlockedAt: null,
  anonymizedAt: null,
  marketingOptOut: false,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function service(overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const state = { balanceMinor: 10_000n, expiresAt: new Date('2099-02-01T00:00:00.000Z') };
  const transactions: Record<string, unknown>[] = [];
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      findMany: vi.fn().mockResolvedValue([user]),
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...user, ...data }),
        ),
    },
    subscription: {
      findFirst: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: 'sub-1',
          userId: 'user-1',
          planId: null,
          status: 'active',
          source: 'purchase',
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: state.expiresAt,
        }),
      ),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ data }: { data: { expiresAt: Date } }) => {
        state.expiresAt = data.expiresAt;
        return Promise.resolve({
          id: 'sub-1',
          userId: 'user-1',
          planId: null,
          status: 'active',
          source: 'purchase',
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: data.expiresAt,
        });
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    account: {
      findFirst: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: 'acc-1', userId: 'user-1', balanceMinor: state.balanceMinor }),
        ),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ data }: { data: { balanceMinor: bigint } }) => {
        state.balanceMinor = data.balanceMinor;
        return Promise.resolve({ balanceMinor: state.balanceMinor });
      }),
    },
    transaction: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        transactions.push(data);
        return Promise.resolve(data);
      }),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 0n } }),
    },
    plan: { findFirst: vi.fn().mockResolvedValue(null) },
    panelUser: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    invoice: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    referralAttribution: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    outboxJob: { create: vi.fn().mockResolvedValue({}) },
    supportTicket: { findMany: vi.fn().mockResolvedValue([{ id: 'ticket-1' }]) },
    supportMessage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    supportTopic: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi
      .fn()
      .mockImplementation(() => Promise.resolve([{ balance_minor: state.balanceMinor }])),
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    ...overrides,
  };
  const values: Record<string, unknown> = {
    'operator.max_credit_minor': '100000',
    'operator.max_refund_minor': '100000',
    ...settings,
  };
  return {
    db,
    state,
    transactions,
    instance: new AdminUsersService(
      { db } as never,
      { get: (key: string) => Promise.resolve(values[key]) } as never,
      {} as never,
    ),
  };
}

describe('AdminUsersService (FR-140, FR-141)', () => {
  it('extends a subscription and writes a zero-value adjustment', async () => {
    const test = service();
    const result = await test.instance.extend(
      'user-1',
      { days: 10, reason: 'support request' },
      { id: 'admin-1', role: 'admin' },
    );

    expect(result).toBeInstanceOf(Audited);
    expect(result.before).toEqual({ expiresAt: '2099-02-01T00:00:00.000Z' });
    expect((result.after as { expiresAt: string }).expiresAt).toBe('2099-02-11T00:00:00.000Z');
    expect(test.transactions[0]).toMatchObject({
      type: 'adjustment',
      amountMinor: 0n,
      reason: 'support request',
      actorAdminId: 'admin-1',
    });
    // Section 9.8, written in the same transaction.
    const [emitted] = test.db.outboxJob.create.mock.calls[0] as [
      { data: { name: string; payload: { type: string; data: Record<string, unknown> } } },
    ];
    expect(emitted.data.name).toBe('webhooks.dispatch');
    expect(emitted.data.payload.type).toBe('subscription.activated');
    expect(emitted.data.payload.data).toMatchObject({
      subscriptionId: 'sub-1',
      expiresAt: '2099-02-11T00:00:00.000Z',
    });
  });

  it('extends an expired subscription from now, not from the old date', async () => {
    const test = service();
    test.state.expiresAt = new Date('2020-01-01T00:00:00.000Z');
    const result = await test.instance.extend(
      'user-1',
      { days: 1, reason: 'support request' },
      { id: 'admin-1', role: 'admin' },
    );
    const after = new Date((result.after as { expiresAt: string }).expiresAt).getTime();

    expect(after).toBeGreaterThan(Date.now());
    expect(after).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5000);
  });

  it('requires a reason on every user action', async () => {
    const test = service();
    await expect(
      test.instance.extend('user-1', { days: 10 }, { id: 'admin-1', role: 'admin' }),
    ).rejects.toThrow();
    await expect(test.instance.ban('user-1', {})).rejects.toThrow();
  });

  it('credits and debits a balance for an admin', async () => {
    const test = service();
    await test.instance.adjustBalance(
      'user-1',
      { amountMinor: 5000, reason: 'goodwill' },
      { id: 'admin-1', role: 'admin' },
    );
    expect(test.state.balanceMinor).toBe(15_000n);

    await test.instance.adjustBalance(
      'user-1',
      { amountMinor: -5000, reason: 'correction' },
      { id: 'admin-1', role: 'admin' },
    );
    expect(test.state.balanceMinor).toBe(10_000n);
  });

  it('never lets an operator debit a balance', async () => {
    const test = service();
    await expect(
      test.instance.adjustBalance(
        'user-1',
        { amountMinor: -100, reason: 'correction' },
        { id: 'operator-1', role: 'operator' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('caps the operator daily credit at settings.operator.max_credit_minor', async () => {
    const test = service({
      transaction: {
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 90_000n } }),
      },
    });

    await expect(
      test.instance.adjustBalance(
        'user-1',
        { amountMinor: 20_000, reason: 'goodwill' },
        { id: 'operator-1', role: 'operator' },
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      test.instance.adjustBalance(
        'user-1',
        { amountMinor: 5000, reason: 'goodwill' },
        { id: 'operator-1', role: 'operator' },
      ),
    ).resolves.toBeInstanceOf(Audited);
  });

  it('refuses to drive a balance below zero', async () => {
    const test = service();
    await expect(
      test.instance.adjustBalance(
        'user-1',
        { amountMinor: -20_000, reason: 'correction' },
        { id: 'admin-1', role: 'admin' },
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'INSUFFICIENT_FUNDS' } } });
  });

  it('revokes the subscription and queues a panel sync when banning', async () => {
    const test = service();
    const result = await test.instance.ban('user-1', { reason: 'abuse' });

    expect(result.before).toEqual({ isBanned: false });
    expect(result.after).toEqual({ isBanned: true });
    expect(test.db.subscription.updateMany).toHaveBeenCalled();
    expect(test.db.outboxJob.create).toHaveBeenCalled();
  });

  it('anonymizes a user without destroying the financial history', async () => {
    const test = service();
    const result = await test.instance.anonymize('user-1', { reason: 'gdpr request' });

    expect(result.before).toMatchObject({ username: 'manta', email: 'a@example.test' });
    expect(result.after).toMatchObject({ username: null, email: null, telegramId: -123 });
    expect(test.db.transaction.create).not.toHaveBeenCalled();
    // F36: what they wrote to support goes with their name.
    expect(test.db.supportMessage.updateMany).toHaveBeenCalledWith({
      where: { ticketId: { in: ['ticket-1'] }, direction: 'customer' },
      data: { text: null, fileId: null, fileUniqueId: null, authorName: null },
    });
    expect(test.db.supportTopic.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
