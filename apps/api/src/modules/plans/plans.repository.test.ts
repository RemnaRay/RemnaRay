import { describe, expect, it, vi } from 'vitest';

import { PlanHasSalesError, PlansRepository } from './plans.repository';

const row = {
  id: 'plan-1',
  slug: 'month',
  name: { ru: 'Месяц' },
  description: {},
  durationDays: 30,
  trafficLimitBytes: 0n,
  trafficResetStrategy: 'NO_RESET',
  deviceLimit: 3,
  squads: ['00000000-0000-4000-8000-000000000001'],
  priceMinor: 29900n,
  currency: 'RUB',
  priceOverrides: {},
  isPublic: true,
  isActive: true,
  sortOrder: 10,
  deletedAt: null,
};

describe('PlansRepository views (section 9.4 PlanPublic)', () => {
  it('gives every plan a name and description in each locale', async () => {
    const prisma = { plan: { findMany: vi.fn().mockResolvedValue([row]) } };
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const repository = new PlansRepository(prisma as never, redis as never);

    const [plan] = await repository.list(false);

    // `plans.description` defaults to `{}`; the site's contract reads both
    // locales and refused the whole list without them.
    expect(plan?.description).toEqual({ ru: '', en: '' });
    expect(plan?.name).toEqual({ ru: 'Месяц', en: 'Месяц' });
  });
});

describe('PlansRepository.remove (P-1)', () => {
  it('refuses a plan with a paid invoice, though no transaction names it', async () => {
    // Payment transactions carry `invoice_id`, not `plan_id`: counting only
    // `transactions.planId` let every plan that was actually sold be deleted.
    const prisma = {
      invoice: { count: vi.fn().mockResolvedValue(1) },
      transaction: { count: vi.fn().mockResolvedValue(0) },
      plan: { update: vi.fn() },
    };
    const redis = { del: vi.fn() };
    const repository = new PlansRepository(prisma as never, redis as never);

    await expect(repository.remove('plan-1')).rejects.toBeInstanceOf(PlanHasSalesError);

    expect(prisma.invoice.count).toHaveBeenCalledWith({
      where: { planId: 'plan-1', status: 'paid' },
    });
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('deletes a plan nobody paid for', async () => {
    const prisma = {
      invoice: { count: vi.fn().mockResolvedValue(0) },
      transaction: { count: vi.fn().mockResolvedValue(0) },
      plan: { update: vi.fn().mockResolvedValue(row) },
    };
    const repository = new PlansRepository(prisma as never, { del: vi.fn() } as never);

    await repository.remove('plan-1');

    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { deletedAt: expect.any(Date) as Date, isActive: false },
    });
  });
});
