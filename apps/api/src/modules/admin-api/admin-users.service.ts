import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '@remnaray/db';
import { limitKeyFor, type AdminRole } from '@remnaray/domain/rbac';

import { Infrastructure } from '../../infra/infra.module';
import { Audited } from '../admin/audit.interceptor';
import { LedgerError } from '../ledger/ledger.errors';
import { postInTransaction } from '../ledger/ledger.repository';
import { ApiError } from '../me/me.errors';
import { RemnawaveService } from '../remnawave/remnawave.service';
import { SettingsService } from '../settings/settings.service';
import { emitWebhook, subscriptionData } from '../webhooks/outgoing';
import { queueDowngradeReset, queuePanelSync } from '../remnawave/panel-jobs';
import {
  balanceSchema,
  extendSchema,
  messageSchema,
  notesSchema,
  reasonSchema,
  setPlanSchema,
  userListQuerySchema,
} from './admin-users.schemas';

export type ActingAdmin = { id: string; role: AdminRole };

function money(amountMinor: bigint, currency = 'RUB') {
  return { amountMinor: Number(amountMinor), currency };
}

/** FR-140 and FR-141. Every mutation returns `Audited` so the interceptor
 * records the state before the change. */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly remnawave: RemnawaveService,
  ) {}

  async list(query: unknown) {
    const input = userListQuerySchema.parse(query ?? {});
    const search = input.q?.trim();
    const panelMatches = search
      ? await this.infra.db.panelUser.findMany({
          where: { panelUsername: { contains: search, mode: 'insensitive' } },
          select: { userId: true },
          take: 200,
        })
      : [];

    const where = {
      ...(input.referrerId ? { referrerId: input.referrerId } : {}),
      ...(input.createdFrom || input.createdTo
        ? {
            createdAt: {
              ...(input.createdFrom ? { gte: new Date(input.createdFrom) } : {}),
              ...(input.createdTo ? { lte: new Date(input.createdTo) } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              ...(/^\d+$/.test(search) ? [{ telegramId: BigInt(search) }] : []),
              { username: { contains: search.replace(/^@/u, ''), mode: 'insensitive' as const } },
              ...(panelMatches.length > 0
                ? [{ id: { in: panelMatches.map((row) => row.userId) } }]
                : []),
            ],
          }
        : {}),
    };

    const rows = await this.infra.db.user.findMany({
      where,
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    const ids = page.map((user) => user.id);
    const [subscriptions, accounts] = await Promise.all([
      this.infra.db.subscription.findMany({
        where: { userId: { in: ids } },
        orderBy: { expiresAt: 'desc' },
      }),
      this.infra.db.account.findMany({
        where: { kind: 'user', currency: 'RUB', userId: { in: ids } },
      }),
    ]);
    const latest = new Map<string, (typeof subscriptions)[number]>();
    for (const subscription of subscriptions)
      if (subscription.userId && !latest.has(subscription.userId))
        latest.set(subscription.userId, subscription);
    const balances = new Map(
      accounts.flatMap((account) =>
        account.userId ? [[account.userId, account.balanceMinor] as const] : [],
      ),
    );

    const filtered =
      input.status === undefined
        ? page
        : page.filter((user) =>
            input.status === 'none'
              ? !latest.has(user.id)
              : latest.get(user.id)?.status === input.status,
          );

    return {
      items: filtered.map((user) => ({
        id: user.id,
        telegramId: Number(user.telegramId),
        username: user.username,
        firstName: user.firstName,
        isBanned: user.isBanned,
        anonymizedAt: user.anonymizedAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        subscriptionStatus: latest.get(user.id)?.status ?? null,
        expiresAt: latest.get(user.id)?.expiresAt.toISOString() ?? null,
        balance: money(balances.get(user.id) ?? 0n),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(id: string) {
    const user = await this.require(id);
    const [subscription, panelUser, account, counts, referrer] = await Promise.all([
      this.infra.db.subscription.findFirst({
        where: { userId: id },
        orderBy: { expiresAt: 'desc' },
      }),
      this.infra.db.panelUser.findUnique({ where: { userId: id } }),
      this.infra.db.account.findFirst({ where: { kind: 'user', userId: id, currency: 'RUB' } }),
      Promise.all([
        this.infra.db.transaction.count({ where: { userId: id } }),
        this.infra.db.invoice.count({ where: { userId: id } }),
        this.infra.db.referralAttribution.count({ where: { referrerId: id } }),
      ]),
      this.infra.db.referralAttribution.findUnique({ where: { refereeId: id } }),
    ]);

    return {
      user: {
        id: user.id,
        telegramId: Number(user.telegramId),
        username: user.username,
        firstName: user.firstName,
        language: user.language,
        email: user.email,
        referralCode: user.referralCode,
        referrerId: referrer?.referrerId ?? null,
        isBanned: user.isBanned,
        botBlockedAt: user.botBlockedAt?.toISOString() ?? null,
        anonymizedAt: user.anonymizedAt?.toISOString() ?? null,
        marketingOptOut: user.marketingOptOut,
        notes: user.notes,
        createdAt: user.createdAt.toISOString(),
      },
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            source: subscription.source,
            planId: subscription.planId,
            startsAt: subscription.startsAt.toISOString(),
            expiresAt: subscription.expiresAt.toISOString(),
          }
        : null,
      panel: panelUser
        ? {
            panelUuid: panelUser.panelUuid,
            panelUsername: panelUser.panelUsername,
            status: panelUser.panelStatus,
            usedTrafficBytes: Number(panelUser.usedTrafficBytes),
            trafficLimitBytes: Number(panelUser.trafficLimitBytes),
            subscriptionUrl: panelUser.subscriptionUrl,
            syncedAt: panelUser.syncedAt?.toISOString() ?? null,
            syncError: panelUser.syncError,
          }
        : null,
      balance: money(account?.balanceMinor ?? 0n),
      counts: { transactions: counts[0], invoices: counts[1], referrals: counts[2] },
    };
  }

  /** FR-141: extension writes a zero-value adjustment plus the audit row. */
  async extend(id: string, body: unknown, admin: ActingAdmin) {
    const input = extendSchema.parse(body);
    return this.infra.db.$transaction(async (tx) => {
      const subscription = await tx.subscription.findFirst({
        where: { userId: id },
        orderBy: { expiresAt: 'desc' },
      });
      if (!subscription) throw new NotFoundException('NOT_FOUND');
      const before = { expiresAt: subscription.expiresAt.toISOString() };
      const base = subscription.expiresAt > new Date() ? subscription.expiresAt : new Date();
      const expiresAt = new Date(base.getTime() + input.days * 86_400_000);
      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt, status: 'active' },
      });
      await emitWebhook(tx, 'subscription.activated', id, subscriptionData(updated));
      await queuePanelSync(tx, id, 'admin:extend');
      await tx.transaction.create({
        data: {
          userId: id,
          type: 'adjustment',
          status: 'completed',
          amountMinor: 0n,
          currency: 'RUB',
          subscriptionId: subscription.id,
          reason: input.reason,
          actorAdminId: admin.id,
        },
      });
      return new Audited(before, { expiresAt: updated.expiresAt.toISOString() });
    });
  }

  async setPlan(id: string, body: unknown, admin: ActingAdmin) {
    const input = setPlanSchema.parse(body);
    return this.infra.db.$transaction(async (tx) => {
      const [subscription, plan] = await Promise.all([
        tx.subscription.findFirst({ where: { userId: id }, orderBy: { expiresAt: 'desc' } }),
        tx.plan.findFirst({ where: { id: input.planId, deletedAt: null } }),
      ]);
      if (!subscription || !plan) throw new NotFoundException('NOT_FOUND');
      const before = {
        planId: subscription.planId,
        expiresAt: subscription.expiresAt.toISOString(),
      };
      const expiresAt = input.keepExpiry
        ? subscription.expiresAt
        : new Date(Date.now() + plan.durationDays * 86_400_000);
      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: plan.id,
          expiresAt,
          trafficLimitBytes: plan.trafficLimitBytes,
          deviceLimit: plan.deviceLimit,
          squads: plan.squads,
        },
      });
      await emitWebhook(tx, 'subscription.activated', id, subscriptionData(updated));
      await queueDowngradeReset(
        tx,
        id,
        plan.trafficLimitBytes,
        `set-plan:${subscription.id}:${Date.now().toString(36)}`,
      );
      await queuePanelSync(tx, id, 'admin:set-plan');
      await tx.transaction.create({
        data: {
          userId: id,
          type: 'adjustment',
          status: 'completed',
          amountMinor: 0n,
          currency: 'RUB',
          subscriptionId: subscription.id,
          planId: plan.id,
          reason: input.reason,
          actorAdminId: admin.id,
        },
      });
      return new Audited(before, {
        planId: updated.planId,
        expiresAt: updated.expiresAt.toISOString(),
      });
    });
  }

  /**
   * Section 14.2: an operator may only credit, never debit, and only up to
   * `settings.operator.max_credit_minor` per day in total.
   *
   * Section 11.7 (repair queue R2, R14, R70): a correction is a posting —
   * `adjustment → user` to credit, `user → adjustment` to debit — so the
   * transaction holds the unsigned amount (`CHECK amount_minor >= 0`), the
   * entry its direction, and a customer who never paid gets an account on the
   * first credit. A debit is refused below the available balance, held
   * referral rewards excluded (15.2).
   */
  async adjustBalance(id: string, body: unknown, admin: ActingAdmin) {
    const input = balanceSchema.parse(body);
    if (input.amountMinor === 0n)
      throw new ApiError('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, 'Amount must not be zero.');
    if (admin.role === 'operator' && input.amountMinor < 0n)
      throw new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN);
    await this.require(id);

    const credit = input.amountMinor > 0n;
    const user = { kind: 'user' as const, userId: id };
    const adjustment = { kind: 'adjustment' as const };
    return this.infra.db.$transaction(async (tx) => {
      // Repair queue R15: the day's sum and this credit are one step per
      // operator. The lock is theirs, not the customer's — parallel credits
      // to different customers (two console tabs, the console and `/credit`)
      // would otherwise each read the same sum and all pass.
      if (admin.role === 'operator') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`operator-credit:${admin.id}`}))`;
        await this.assertOperatorLimit(tx, admin, input.amountMinor, 'users.balance.credit');
      }
      const [before] = await tx.$queryRaw<{ balance_minor: bigint }[]>`
        SELECT balance_minor FROM accounts WHERE kind = 'user'::account_kind AND user_id = ${id}::uuid`;
      try {
        const posted = await postInTransaction(tx, {
          userId: id,
          type: 'adjustment',
          amountMinor: credit ? input.amountMinor : -input.amountMinor,
          currency: 'RUB',
          debit: credit ? adjustment : user,
          credit: credit ? user : adjustment,
          reason: input.reason,
          actorAdminId: admin.id,
        });
        return new Audited(
          { balance: money(before?.balance_minor ?? 0n) },
          { balance: money(posted.balanceMinor) },
        );
      } catch (error) {
        if (error instanceof LedgerError && error.code === 'INSUFFICIENT_FUNDS')
          throw new ApiError('INSUFFICIENT_FUNDS', HttpStatus.CONFLICT);
        throw error;
      }
    });
  }

  async ban(id: string, body: unknown) {
    reasonSchema.parse(body);
    const before = await this.require(id);
    // One transaction: a ban whose sync is lost leaves the panel user enabled.
    const updated = await this.infra.db.$transaction(async (tx) => {
      const banned = await tx.user.update({ where: { id }, data: { isBanned: true } });
      await tx.subscription.updateMany({
        where: { userId: id, status: { in: ['provisioning', 'active', 'grace'] } },
        data: { status: 'revoked' },
      });
      await queuePanelSync(tx, id, 'admin:ban');
      return banned;
    });
    return new Audited({ isBanned: before.isBanned }, { isBanned: updated.isBanned });
  }

  async unban(id: string, body: unknown) {
    reasonSchema.parse(body);
    const before = await this.require(id);
    const updated = await this.infra.db.$transaction(async (tx) => {
      const unbanned = await tx.user.update({ where: { id }, data: { isBanned: false } });
      await queuePanelSync(tx, id, 'admin:unban');
      return unbanned;
    });
    return new Audited({ isBanned: before.isBanned }, { isBanned: updated.isBanned });
  }

  async revokeLink(id: string) {
    const before = await this.infra.db.panelUser.findUnique({ where: { userId: id } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    const result = await this.remnawave.revokeSubscription(id);
    return new Audited(
      { subscriptionUrl: before.subscriptionUrl },
      { subscriptionUrl: result.subscriptionUrl },
    );
  }

  async resetTraffic(id: string) {
    const before = await this.infra.db.panelUser.findUnique({ where: { userId: id } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    const after = await this.infra.db.panelUser.update({
      where: { userId: id },
      data: { usedTrafficBytes: 0n },
    });
    await this.infra.db.outboxJob.create({
      data: {
        queue: 'panel',
        name: 'panel.reset-traffic',
        payload: { userId: id },
        jobId: `panel:traffic:${id}:${Date.now().toString(36)}`,
      },
    });
    return new Audited(
      { usedTrafficBytes: Number(before.usedTrafficBytes) },
      { usedTrafficBytes: Number(after.usedTrafficBytes) },
    );
  }

  async message(id: string, body: unknown) {
    const input = messageSchema.parse(body);
    const user = await this.require(id);
    const dedupKey = `admin.message:${id}:${Date.now().toString(36)}`;
    await this.infra.db.outboxJob.create({
      data: {
        queue: 'notify',
        name: 'notify.send',
        payload: {
          event: 'admin.message',
          userId: id,
          dedupKey,
          params: { text: input.text },
        },
        jobId: `notify:${dedupKey}`,
      },
    });
    return new Audited(
      null,
      { queued: true, language: input.lang ?? user.language },
      {
        queued: true,
      },
    );
  }

  async setNotes(id: string, body: unknown) {
    const input = notesSchema.parse(body);
    const before = await this.require(id);
    const after = await this.infra.db.user.update({
      where: { id },
      data: { notes: input.notes },
    });
    return new Audited({ notes: before.notes }, { notes: after.notes });
  }

  /** Section 19.5 anonymization, performed by an administrator. */
  async anonymize(id: string, body: unknown) {
    reasonSchema.parse(body);
    return this.infra.db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException('NOT_FOUND');
      if (user.anonymizedAt) throw new ApiError('CONFLICT', HttpStatus.CONFLICT);
      const before = {
        username: user.username,
        firstName: user.firstName,
        email: user.email,
        telegramId: Number(user.telegramId),
      };
      const anonymizedTelegramId = -user.telegramId;
      const referralCode = `AN${user.id.replaceAll('-', '').slice(0, 6).toUpperCase()}`;
      const after = await tx.user.update({
        where: { id },
        data: {
          username: null,
          firstName: null,
          email: null,
          telegramId: anonymizedTelegramId,
          referralCode,
          isBanned: true,
          anonymizedAt: new Date(),
        },
      });
      await tx.subscription.updateMany({
        where: { userId: id, status: { in: ['provisioning', 'active', 'grace'] } },
        data: { status: 'revoked' },
      });
      // F36: what the customer wrote to support goes with their name.
      const tickets = await tx.supportTicket.findMany({
        where: { userId: id },
        select: { id: true },
      });
      await tx.supportMessage.updateMany({
        where: { ticketId: { in: tickets.map((ticket) => ticket.id) }, direction: 'customer' },
        data: { text: null, fileId: null, fileUniqueId: null, authorName: null },
      });
      await tx.supportTopic.deleteMany({ where: { userId: id } });
      await tx.outboxJob.create({
        data: {
          queue: 'panel',
          name: 'panel.delete-user',
          payload: { userId: id },
          jobId: `panel:delete:${id}`,
        },
      });
      return new Audited(before, {
        username: null,
        firstName: null,
        email: null,
        telegramId: Number(after.telegramId),
      });
    });
  }

  async transactions(id: string) {
    const rows = await this.infra.db.transaction.findMany({
      where: { userId: id },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        amount: money(row.amountMinor, row.currency),
        provider: row.provider,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async invoices(id: string) {
    const rows = await this.infra.db.invoice.findMany({
      where: { userId: id },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        provider: row.provider,
        amount: money(row.amountMinor, row.currency),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async audit(id: string) {
    const rows = await this.infra.db.auditLog.findMany({
      where: { entity: 'user', entityId: id },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorAdminId: row.actorAdminId,
        reason: row.reason,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async referrals(id: string) {
    const rows = await this.infra.db.referralAttribution.findMany({
      where: { referrerId: id },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        refereeId: row.refereeId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Section 14.2. An operator never debits, so every `adjustment` they made
   * is a credit and the day's sum is theirs to spend against the limit.
   */
  private async assertOperatorLimit(
    tx: Prisma.TransactionClient,
    admin: ActingAdmin,
    amountMinor: bigint,
    permission: 'users.balance.credit' | 'payments.refund',
  ): Promise<void> {
    const key = limitKeyFor(admin.role, permission);
    if (!key) return;
    const limit = BigInt(String(await this.settings.get(key)));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const used = await tx.transaction.aggregate({
      where: {
        actorAdminId: admin.id,
        type: permission === 'payments.refund' ? 'refund' : 'adjustment',
        amountMinor: { gt: 0n },
        createdAt: { gte: since },
      },
      _sum: { amountMinor: true },
    });
    if ((used._sum.amountMinor ?? 0n) + amountMinor > limit)
      throw new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN, 'Operator daily limit exceeded.', {
        limitMinor: Number(limit),
        usedMinor: Number(used._sum.amountMinor ?? 0n),
      });
  }

  private async require(id: string) {
    const user = await this.infra.db.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('NOT_FOUND');
    return user;
  }
}
