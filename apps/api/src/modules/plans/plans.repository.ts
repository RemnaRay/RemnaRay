import type { PrismaClient } from '@remnaray/db';
import type Redis from 'ioredis';

import { jsonNumber, planTexts, type PlanInput, type PlanPatch } from './plans.schemas';

export type PlanView = {
  id: string;
  slug: string;
  name: { ru: string; en: string };
  description: { ru: string; en: string };
  durationDays: number;
  trafficLimitBytes: number;
  trafficResetStrategy: string;
  deviceLimit: number;
  squads: string[];
  price: { amountMinor: number; currency: string };
  priceOverrides: unknown;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
};

export class PlanHasSalesError extends Error {
  readonly code = 'PLAN_HAS_SALES';
  constructor() {
    super('Plan has sales and cannot be deleted');
  }
}

export interface PlansRepositoryPort {
  create(input: PlanInput): Promise<PlanView>;
  list(includeInactive: boolean): Promise<PlanView[]>;
  update(id: string, patch: PlanPatch): Promise<PlanView>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<PlanView[]>;
}

export class PlansRepository implements PlansRepositoryPort {
  private readonly cacheKey = 'rr:plans:public';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  async create(input: PlanInput): Promise<PlanView> {
    const plan = await this.prisma.plan.create({
      data: {
        slug: input.slug,
        name: input.name as never,
        description: input.description as never,
        durationDays: input.durationDays,
        trafficLimitBytes: input.trafficLimitBytes,
        trafficResetStrategy: input.trafficResetStrategy,
        deviceLimit: input.deviceLimit,
        squads: input.squads,
        priceMinor: input.priceMinor,
        currency: input.currency,
        priceOverrides: input.priceOverrides as never,
        isPublic: input.isPublic,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    });
    await this.invalidate();
    return toView(plan);
  }

  async list(includeInactive: boolean): Promise<PlanView[]> {
    if (!includeInactive) {
      try {
        const cached = await this.redis.get(this.cacheKey);
        if (cached) return JSON.parse(cached) as PlanView[];
      } catch {
        // Redis is a cache; the database remains the source of truth.
      }
    }
    const plans = await this.prisma.plan.findMany({
      where: includeInactive
        ? { deletedAt: null }
        : { isPublic: true, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const views = plans.map(toView);
    if (!includeInactive) {
      try {
        await this.redis.set(this.cacheKey, JSON.stringify(views), 'EX', 60);
      } catch {
        // Redis is a cache; a cache outage must not hide public plans.
      }
    }
    return views;
  }

  async update(id: string, patch: PlanPatch): Promise<PlanView> {
    const plan = await this.prisma.plan.update({
      where: { id },
      data: {
        ...(patch.name ? { name: patch.name as never } : {}),
        ...(patch.description ? { description: patch.description as never } : {}),
        ...(patch.durationDays !== undefined ? { durationDays: patch.durationDays } : {}),
        ...(patch.trafficLimitBytes !== undefined
          ? { trafficLimitBytes: patch.trafficLimitBytes }
          : {}),
        ...(patch.trafficResetStrategy ? { trafficResetStrategy: patch.trafficResetStrategy } : {}),
        ...(patch.deviceLimit !== undefined ? { deviceLimit: patch.deviceLimit } : {}),
        ...(patch.squads ? { squads: patch.squads } : {}),
        ...(patch.priceMinor !== undefined ? { priceMinor: patch.priceMinor } : {}),
        ...(patch.currency ? { currency: patch.currency } : {}),
        ...(patch.priceOverrides ? { priceOverrides: patch.priceOverrides as never } : {}),
        ...(patch.isPublic !== undefined ? { isPublic: patch.isPublic } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      },
    });
    await this.invalidate();
    return toView(plan);
  }

  /** Section 14.1: drag-and-drop ordering writes `sort_order` in one transaction. */
  async reorder(ids: string[]): Promise<PlanView[]> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.plan.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } }),
      ),
    );
    await this.invalidate();
    return this.list(true);
  }

  async remove(id: string): Promise<void> {
    // P-1: a payment names its invoice, not the plan, so a sale is a paid
    // invoice for the plan; transactions naming it directly count as well.
    const [invoices, transactions] = await Promise.all([
      this.prisma.invoice.count({ where: { planId: id, status: 'paid' } }),
      this.prisma.transaction.count({ where: { planId: id } }),
    ]);
    if (invoices + transactions > 0) throw new PlanHasSalesError();
    await this.prisma.plan.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.invalidate();
  }

  private async invalidate(): Promise<void> {
    try {
      await this.redis.del(this.cacheKey);
    } catch {
      // A stale cache expires after 60 seconds; mutations remain durable in DB.
    }
  }
}

function toView(plan: {
  id: string;
  slug: string;
  name: unknown;
  description: unknown;
  durationDays: number;
  trafficLimitBytes: bigint;
  trafficResetStrategy: string;
  deviceLimit: number;
  squads: string[];
  priceMinor: bigint;
  currency: string;
  priceOverrides: unknown;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  deletedAt: Date | null;
}): PlanView {
  return {
    id: plan.id,
    slug: plan.slug,
    ...planTexts(plan),
    durationDays: plan.durationDays,
    trafficLimitBytes: jsonNumber(plan.trafficLimitBytes),
    trafficResetStrategy: plan.trafficResetStrategy,
    deviceLimit: plan.deviceLimit,
    squads: plan.squads,
    price: { amountMinor: jsonNumber(plan.priceMinor), currency: plan.currency.trim() },
    priceOverrides: plan.priceOverrides,
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    deletedAt: plan.deletedAt?.toISOString() ?? null,
  };
}
