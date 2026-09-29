import { revenueMinorTotal } from '@remnaray/metrics';
import type { PrismaClient } from '@remnaray/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaymentsRepository } from './payments.repository';

type Sql = { strings: readonly string[]; values: readonly unknown[] };
const textOf = (query: Sql) => query.strings.join('?');

/**
 * A transaction client that answers the repository's raw reads by their SQL
 * and records every write, so a money path can be followed without a database.
 */
function fakeTx(rows: { invoice?: Record<string, unknown>; balance?: bigint }) {
  return {
    $queryRaw: vi.fn((query: Sql) => {
      const text = textOf(query);
      if (text.includes('FROM payment_events')) return Promise.resolve([{ processedAt: null }]);
      if (text.includes('FROM invoices')) return Promise.resolve([rows.invoice]);
      if (text.includes('balance_minor AS balance'))
        return Promise.resolve([
          { id: 'acc-user', kind: 'user', balance: rows.balance ?? 0n },
          { id: 'acc-revenue', kind: 'revenue', balance: 0n },
        ]);
      if (text.includes('referral_rewards')) return Promise.resolve([{ held: 0n }]);
      if (text.includes('SELECT id, kind FROM accounts'))
        return Promise.resolve([
          { id: 'acc-clearing', kind: 'provider_clearing' },
          { id: 'acc-user', kind: 'user' },
        ]);
      if (text.includes('SELECT id FROM accounts WHERE kind ='))
        return Promise.resolve([{ id: 'x' }]);
      return Promise.resolve([]);
    }),
    $executeRaw: vi.fn<(query: Sql) => Promise<number>>(() => Promise.resolve(1)),
    invoice: {
      create: vi.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'inv-1', ...args.data }),
      ),
      update: vi.fn(() => Promise.resolve({})),
    },
    transaction: {
      create: vi.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'txn-1', ...args.data }),
      ),
    },
    ledgerEntry: { create: vi.fn(() => Promise.resolve({})) },
    account: { update: vi.fn(() => Promise.resolve({})) },
    outboxJob: { create: vi.fn<(args: unknown) => Promise<object>>(() => Promise.resolve({})) },
    user: { findUnique: vi.fn(() => Promise.resolve({ language: 'ru', telegramId: 42n })) },
    plan: { findUnique: vi.fn(() => Promise.resolve(null)) },
    subscription: { findFirst: vi.fn(() => Promise.resolve(null)) },
  };
}

function repositoryOver(tx: ReturnType<typeof fakeTx>, raw?: Record<string, unknown>) {
  const prisma = {
    paymentEvent: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          id: 'evt-1',
          provider: 'mock',
          type: 'paid',
          invoiceId: 'inv-1',
          signatureOk: true,
          processedAt: null,
          receivedAt: new Date(),
          raw: raw ?? {},
        }),
      ),
    },
    $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return new PaymentsRepository(prisma as unknown as PrismaClient);
}

const providerInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  userId: 'user-1',
  kind: 'topup',
  provider: 'mock',
  status: 'pending',
  amountMinor: 29900n,
  expiresAt: new Date(Date.now() + 60_000),
  planId: null,
  number: '99-00001',
  targetPlanId: null,
  ...overrides,
});

const jobs = (tx: ReturnType<typeof fakeTx>) =>
  tx.outboxJob.create.mock.calls.map(
    ([args]) => (args as { data: { jobId: string; payload: Record<string, unknown> } }).data,
  );

describe('PaymentsRepository.applyEvent, a paid provider invoice (F37, section 11.2)', () => {
  it('credits nothing for a paid event that reports zero, and alerts (EX-12)', async () => {
    const tx = fakeTx({ invoice: providerInvoice() });

    await repositoryOver(tx, { paidAmountMinorRub: '0' }).applyEvent('evt-1');

    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(jobs(tx)).toEqual([
      {
        queue: 'notify',
        name: 'notify.alert',
        payload: { type: 'payment.underpaid', details: 'inv-1' },
        jobId: 'alert:payment.underpaid:evt-1',
      },
    ]);
    const marked = tx.$executeRaw.mock.calls
      .map(([query]) => query)
      .find((query) => textOf(query).includes('UPDATE payment_events'));
    expect(marked?.values).toContain('PAID_ZERO');
  });

  it('still takes an event without an amount as paid in full', async () => {
    const tx = fakeTx({ invoice: providerInvoice() });

    await repositoryOver(tx).applyEvent('evt-1');

    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'topup', amountMinor: 29900n }) as unknown,
    });
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: expect.objectContaining({ status: 'paid' }) as unknown,
    });
  });

  it('names no plan in payment.succeeded for a top-up, even of an invoice written before F37', async () => {
    const tx = fakeTx({
      invoice: providerInvoice({ kind: 'purchase', planId: 'plan-1', number: null }),
    });

    await repositoryOver(tx, { paidAmountMinorRub: '29900' }).applyEvent('evt-1');

    const webhook = jobs(tx).find((job) => job.jobId.startsWith('webhook:'));
    expect(webhook?.payload).toMatchObject({
      type: 'payment.succeeded',
      data: { type: 'topup', invoiceId: 'inv-1', planId: null },
    });
  });
});

describe('PaymentsRepository.createBalanceInvoice revenue metric (section 12.2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts revenue only for a purchase that commits', async () => {
    const inc = vi.spyOn(revenueMinorTotal, 'inc');
    // The plan is off sale by the time the purchase settles: activation
    // throws and the whole purchase rolls back.
    const tx = fakeTx({
      invoice: providerInvoice({ kind: 'purchase', provider: 'balance', planId: 'plan-1' }),
      balance: 50_000n,
    });
    const repository = repositoryOver(tx);
    const input = {
      userId: 'user-1',
      kind: 'purchase' as const,
      planId: 'plan-1',
      provider: 'balance',
      amountMinor: 29900n,
      currency: 'RUB',
      idempotencyKey: 'k1',
      expiresAt: new Date(Date.now() + 60_000),
    };

    await expect(repository.createBalanceInvoice(input)).rejects.toMatchObject({
      code: 'PLAN_UNAVAILABLE',
    });
    expect(inc).not.toHaveBeenCalled();

    tx.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      isActive: true,
      deletedAt: null,
      durationDays: 30,
      trafficLimitBytes: 0n,
      deviceLimit: 0,
      squads: [],
      trafficResetStrategy: 'NO_RESET',
    } as never);
    Object.assign(tx, {
      subscription: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'sub-1', ...args.data }),
        ),
      },
    });
    await repository.createBalanceInvoice(input);
    expect(inc).toHaveBeenCalledWith({ provider: 'balance' }, 29900);
  });
});

describe('PaymentsRepository.nextInvoiceNumber (F37)', () => {
  it('numbers per provider', async () => {
    const $queryRaw = vi.fn(() => Promise.resolve([{ last: 7n }]));
    const repository = new PaymentsRepository({ $queryRaw } as unknown as PrismaClient);
    await expect(repository.nextInvoiceNumber('robokassa')).resolves.toBe('04-00007');
  });

  // A provider without a code would bump a counter for a number that is never issued.
  it('refuses a provider without a number code before touching the counter', async () => {
    const $queryRaw = vi.fn(() => Promise.resolve([{ last: 1n }]));
    const repository = new PaymentsRepository({ $queryRaw } as unknown as PrismaClient);
    for (const provider of ['balance', 'ghost', 'toString'])
      await expect(repository.nextInvoiceNumber(provider)).rejects.toThrow(
        'INVOICE_NUMBER_UNKNOWN_PROVIDER',
      );
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
