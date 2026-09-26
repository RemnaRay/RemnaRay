import { Prisma, type PrismaClient } from '@remnaray/db';

import type { Ticket } from './tickets.repository';

/** What the operators see about the customer on a ticket's card (F36). */
export type CardData = {
  ticket: Pick<
    Ticket,
    'number' | 'status' | 'assigneeName' | 'createdAt' | 'closedAt' | 'closedSilently' | 'rating'
  >;
  user: {
    id: string;
    telegramId: string;
    firstName: string | null;
    username: string | null;
    language: string;
    createdAt: Date;
    lastSeenAt: Date | null;
    isBanned: boolean;
    botBlocked: boolean;
    trialUsed: boolean;
    notes: string | null;
    referrer: string | null;
  };
  subscription: {
    status: string;
    plan: string | null;
    expiresAt: Date;
    usedBytes: bigint | null;
    limitBytes: bigint;
    deviceLimit: number;
    url: string | null;
  } | null;
  money: {
    balanceMinor: bigint;
    lastPurchase: {
      plan: string | null;
      amountMinor: bigint;
      at: Date;
      provider: string | null;
    } | null;
    receivedMinor: bigint;
    payments: number;
    pendingInvoices: number;
  };
  support: {
    tickets: number;
    previous: { number: bigint; at: Date; rating: number | null } | null;
  };
};

type Db = Pick<
  PrismaClient,
  | 'user'
  | 'referralAttribution'
  | 'subscription'
  | 'panelUser'
  | 'plan'
  | 'account'
  | 'transaction'
  | 'invoice'
  | 'supportTicket'
  | 'paymentProvider'
  | '$queryRaw'
>;

/**
 * Reads the card of `ticket`'s customer. "Received" follows the dashboard's
 * rule (F31): purchases and top-ups paid through a provider, not from the
 * balance.
 */
export async function loadCardData(db: Db, ticket: Ticket, locale: string): Promise<CardData> {
  const userId = ticket.userId;
  const [user, attribution, subscription, panelUser, account, lastPurchase, pending, tickets] =
    await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId } }),
      db.referralAttribution.findUnique({ where: { refereeId: userId } }),
      db.subscription.findFirst({ where: { userId }, orderBy: { expiresAt: 'desc' } }),
      db.panelUser.findUnique({ where: { userId } }),
      db.account.findFirst({ where: { kind: 'user', userId, currency: 'RUB' } }),
      db.transaction.findFirst({
        where: { userId, type: 'purchase', status: 'completed' },
        orderBy: { createdAt: 'desc' },
      }),
      db.invoice.count({ where: { userId, status: 'pending' } }),
      db.supportTicket.findMany({
        where: { userId, id: { not: ticket.id }, createdAt: { lt: ticket.createdAt } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { number: true, createdAt: true, rating: true },
      }),
    ]);
  const [received] = await db.$queryRaw<{ total: bigint | null; count: bigint }[]>(Prisma.sql`
    SELECT sum(amount_minor)::bigint AS total, count(*)::bigint AS count FROM transactions
    WHERE user_id = ${userId}::uuid AND status = 'completed' AND type IN ('purchase', 'topup')
      AND provider IS NOT NULL AND provider <> 'balance'`);
  const ticketCount = await db.supportTicket.count({ where: { userId } });
  const referrer = attribution
    ? await db.user.findUnique({
        where: { id: attribution.referrerId },
        select: { username: true, telegramId: true },
      })
    : null;
  const planName = async (planId: string | null) => {
    if (!planId) return null;
    const plan = await db.plan.findUnique({ where: { id: planId }, select: { name: true } });
    return plan ? localized(plan.name, locale) : null;
  };
  const provider = async (code: string | null) => {
    if (!code || code === 'balance') return code;
    const row = await db.paymentProvider.findUnique({
      where: { code },
      select: { displayName: true },
    });
    return (row && localized(row.displayName, locale)) ?? code;
  };
  const previous = tickets[0];
  return {
    ticket: {
      number: ticket.number,
      status: ticket.status,
      assigneeName: ticket.assigneeName,
      createdAt: ticket.createdAt,
      closedAt: ticket.closedAt,
      closedSilently: ticket.closedSilently,
      rating: ticket.rating,
    },
    user: {
      id: user.id,
      telegramId: user.telegramId.toString(),
      firstName: user.firstName,
      username: user.username,
      language: user.language,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      isBanned: user.isBanned,
      botBlocked: user.botBlockedAt !== null,
      trialUsed: user.trialUsedAt !== null,
      notes: user.notes,
      referrer: referrer
        ? referrer.username
          ? `@${referrer.username}`
          : referrer.telegramId.toString()
        : null,
    },
    subscription: subscription
      ? {
          status: subscription.status,
          plan: await planName(subscription.planId),
          expiresAt: subscription.expiresAt,
          usedBytes: panelUser?.usedTrafficBytes ?? null,
          limitBytes: subscription.trafficLimitBytes,
          deviceLimit: subscription.deviceLimit,
          url: panelUser?.subscriptionUrl ?? null,
        }
      : null,
    money: {
      balanceMinor: account?.balanceMinor ?? 0n,
      lastPurchase: lastPurchase
        ? {
            plan: await planName(lastPurchase.planId),
            amountMinor: lastPurchase.amountMinor,
            at: lastPurchase.createdAt,
            provider: await provider(lastPurchase.provider),
          }
        : null,
      receivedMinor: received?.total ?? 0n,
      payments: Number(received?.count ?? 0n),
      pendingInvoices: pending,
    },
    support: {
      tickets: ticketCount,
      previous: previous
        ? { number: previous.number, at: previous.createdAt, rating: previous.rating }
        : null,
    },
  };
}

function localized(value: unknown, locale: string): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = record[locale] ?? record['ru'] ?? record['en'];
  return typeof text === 'string' && text ? text : null;
}
