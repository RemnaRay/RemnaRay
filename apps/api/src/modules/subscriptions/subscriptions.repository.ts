import { Prisma, type PrismaClient } from '@remnaray/db';

import { planChangeCredit } from '../payments/checkout';
import { emitWebhook, subscriptionData } from '../webhooks/outgoing';
import { SubscriptionError } from './subscriptions.errors';

export type SubscriptionConfig = {
  trialEnabled: boolean;
  trialDays: number;
  trialTrafficGb: number;
  trialDeviceLimit: number;
  trialSquads: string[];
  graceHours: number;
};

export type SubscriptionView = {
  id: string;
  userId: string;
  planId: string | null;
  source: string;
  status: string;
  startsAt: string;
  expiresAt: string;
  trafficLimitBytes: string;
  deviceLimit: number;
  squads: string[];
  trafficResetStrategy: string;
};

export type PlanChangeQuote = {
  oldPlanId: string;
  newPlanId: string;
  remainingSeconds: bigint;
  creditMinor: bigint;
  chargeMinor: bigint;
};

export interface SubscriptionsRepositoryPort {
  trial(userId: string, config: SubscriptionConfig): Promise<SubscriptionView>;
  activate(userId: string, planId: string, source: 'purchase' | 'admin'): Promise<SubscriptionView>;
  current(userId: string): Promise<SubscriptionView | null>;
  quotePlanChange(userId: string, planId: string, now?: Date): Promise<PlanChangeQuote>;
  applyPlanChange(userId: string, planId: string, now?: Date): Promise<SubscriptionView>;
  expire(now?: Date, graceHours?: number): Promise<number>;
}

export class SubscriptionsRepository implements SubscriptionsRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async trial(userId: string, config: SubscriptionConfig): Promise<SubscriptionView> {
    if (!config.trialEnabled) throw new SubscriptionError('TRIAL_DISABLED');
    if (config.trialDays < 1 || config.trialDays > 30)
      throw new SubscriptionError('TRIAL_DISABLED');
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: userId } });
      if (!user || user.trialUsedAt) throw new SubscriptionError('TRIAL_ALREADY_USED');
      const purchases = await transaction.transaction.count({
        where: { userId, type: 'purchase', amountMinor: { gt: 0n } },
      });
      if (purchases > 0) throw new SubscriptionError('TRIAL_NOT_ELIGIBLE');
      const live = await this.live(transaction, userId);
      if (live) throw new SubscriptionError('TRIAL_NOT_ELIGIBLE');
      const startsAt = new Date();
      const expiresAt = new Date(startsAt.getTime() + config.trialDays * 86_400_000);
      const subscription = await transaction.subscription.create({
        data: {
          userId,
          planId: null,
          source: 'trial',
          // FR-010, EX-01: the trial is live once the panel has the user;
          // `panel.sync-user` makes it `active`.
          status: 'provisioning',
          startsAt,
          expiresAt,
          trafficLimitBytes: BigInt(config.trialTrafficGb) * 1024n * 1024n * 1024n,
          deviceLimit: config.trialDeviceLimit,
          squads: config.trialSquads,
          trafficResetStrategy: 'NO_RESET',
        },
      });
      await transaction.user.update({ where: { id: userId }, data: { trialUsedAt: startsAt } });
      // `subscription.activated` (9.8) and the customer's message go out when
      // the sync activates it, as section 10.3 has it.
      await transaction.outboxJob.create({
        data: {
          queue: 'panel',
          name: 'panel.sync-user',
          payload: { userId, reason: 'trial' },
          jobId: `sync:${userId}`,
        },
      });
      return view(subscription);
    });
  }

  async activate(
    userId: string,
    planId: string,
    source: 'purchase' | 'admin',
  ): Promise<SubscriptionView> {
    return this.prisma.$transaction(async (transaction) => {
      const plan = await transaction.plan.findFirst({
        where: { id: planId, isActive: true, deletedAt: null },
      });
      if (!plan) throw new SubscriptionError('PLAN_UNAVAILABLE');
      const now = new Date();
      const live = await this.live(transaction, userId);
      const startsAt =
        live && live.status === 'active' && live.expiresAt > now ? live.startsAt : now;
      const base = live && live.status === 'active' && live.expiresAt > now ? live.expiresAt : now;
      const expiresAt = new Date(base.getTime() + plan.durationDays * 86_400_000);
      const data = {
        planId,
        source,
        status: 'active' as const,
        startsAt,
        expiresAt,
        trafficLimitBytes: plan.trafficLimitBytes,
        deviceLimit: plan.deviceLimit,
        squads: plan.squads,
        trafficResetStrategy: plan.trafficResetStrategy,
        revokedReason: null,
      };
      const subscription = live
        ? await transaction.subscription.update({ where: { id: live.id }, data })
        : await transaction.subscription.create({ data: { userId, ...data } });
      await emitWebhook(
        transaction,
        'subscription.activated',
        userId,
        subscriptionData(subscription),
      );
      return view(subscription);
    });
  }

  async current(userId: string): Promise<SubscriptionView | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['provisioning', 'active', 'grace'] } },
      orderBy: { expiresAt: 'desc' },
    });
    return subscription ? view(subscription) : null;
  }

  async quotePlanChange(
    userId: string,
    planId: string,
    now = new Date(),
  ): Promise<PlanChangeQuote> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: 'active' },
    });
    if (!subscription || !subscription.planId || subscription.expiresAt <= now) {
      throw new SubscriptionError('PLAN_CHANGE_NOT_ALLOWED');
    }
    const [oldPlan, newPlan] = await Promise.all([
      this.prisma.plan.findUnique({ where: { id: subscription.planId } }),
      this.prisma.plan.findFirst({ where: { id: planId, isActive: true, deletedAt: null } }),
    ]);
    if (!oldPlan || !newPlan) throw new SubscriptionError('PLAN_UNAVAILABLE');
    const remainingSeconds = BigInt(
      Math.max(0, Math.floor((subscription.expiresAt.getTime() - now.getTime()) / 1000)),
    );
    const creditMinor = planChangeCredit(oldPlan, subscription.expiresAt, now);
    return {
      oldPlanId: oldPlan.id,
      newPlanId: newPlan.id,
      remainingSeconds,
      creditMinor,
      chargeMinor: newPlan.priceMinor > creditMinor ? newPlan.priceMinor - creditMinor : 0n,
    };
  }

  async applyPlanChange(
    userId: string,
    planId: string,
    now = new Date(),
  ): Promise<SubscriptionView> {
    return this.prisma.$transaction(async (transaction) => {
      const subscription = await transaction.subscription.findFirst({
        where: { userId, status: 'active' },
      });
      if (!subscription || subscription.expiresAt <= now)
        throw new SubscriptionError('PLAN_CHANGE_NOT_ALLOWED');
      const plan = await transaction.plan.findFirst({
        where: { id: planId, isActive: true, deletedAt: null },
      });
      if (!plan) throw new SubscriptionError('PLAN_UNAVAILABLE');
      const updated = await transaction.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: plan.id,
          startsAt: now,
          expiresAt: new Date(now.getTime() + plan.durationDays * 86_400_000),
          trafficLimitBytes: plan.trafficLimitBytes,
          deviceLimit: plan.deviceLimit,
          squads: plan.squads,
          trafficResetStrategy: plan.trafficResetStrategy,
        },
      });
      await emitWebhook(transaction, 'subscription.activated', userId, subscriptionData(updated));
      return view(updated);
    });
  }

  async expire(now = new Date(), graceHours = 0): Promise<number> {
    const candidates = await this.prisma.subscription.findMany({
      where: { status: { in: ['active', 'grace'] }, expiresAt: { lte: now } },
    });
    let changed = 0;
    for (const subscription of candidates) {
      const nextStatus =
        subscription.status === 'active' &&
        graceHours > 0 &&
        subscription.expiresAt.getTime() + graceHours * 3_600_000 > now.getTime()
          ? 'grace'
          : 'expired';
      if (nextStatus === subscription.status) continue;
      // Conditional on the row read: a renewal applied since then keeps the
      // subscription, and no `subscription.expired` (section 9.8) goes out.
      const moved = await this.prisma.$transaction(async (transaction) => {
        const { count } = await transaction.subscription.updateMany({
          where: {
            id: subscription.id,
            status: subscription.status,
            expiresAt: subscription.expiresAt,
          },
          data: { status: nextStatus },
        });
        if (count === 1 && nextStatus === 'expired')
          await emitWebhook(
            transaction,
            'subscription.expired',
            subscription.userId,
            subscriptionData({ ...subscription, status: nextStatus }),
          );
        return count;
      });
      changed += moved;
    }
    return changed;
  }

  private async live(transaction: Prisma.TransactionClient, userId: string) {
    return transaction.subscription.findFirst({
      where: { userId, status: { in: ['provisioning', 'active', 'grace'] } },
      orderBy: { expiresAt: 'desc' },
    });
  }
}

function view(subscription: {
  id: string;
  userId: string;
  planId: string | null;
  source: string;
  status: string;
  startsAt: Date;
  expiresAt: Date;
  trafficLimitBytes: bigint;
  deviceLimit: number;
  squads: string[];
  trafficResetStrategy: string;
}): SubscriptionView {
  return {
    id: subscription.id,
    userId: subscription.userId,
    planId: subscription.planId,
    source: subscription.source,
    status: subscription.status,
    startsAt: subscription.startsAt.toISOString(),
    expiresAt: subscription.expiresAt.toISOString(),
    trafficLimitBytes: subscription.trafficLimitBytes.toString(),
    deviceLimit: subscription.deviceLimit,
    squads: subscription.squads,
    trafficResetStrategy: subscription.trafficResetStrategy,
  };
}
