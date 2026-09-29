import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { Prisma } from '@remnaray/db';

import { Infrastructure } from '../../infra/infra.module';
import {
  PLAN_CHANGE_TOPUP_MARGIN_MS,
  amountToPay,
  planChangeCredit,
  topupAmount,
} from '../payments/checkout';
import { PaymentError } from '../payments/payments.errors';
import { PaymentsService } from '../payments/payments.service';
import { PlansService } from '../plans/plans.service';
import { planTexts } from '../plans/plans.schemas';
import { RemnawaveService, RevokeRateLimitError } from '../remnawave/remnawave.service';
import { SettingsService } from '../settings/settings.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ApiError } from './me.errors';
import {
  checkoutQuoteQuerySchema,
  cursorQuerySchema,
  invoiceCreateSchema,
  profilePatchSchema,
  promocodePreviewSchema,
  promocodeSchema,
} from './me.schemas';

type ClientLink = {
  id: string;
  name: string;
  platforms: string[];
  deepLinkTemplate?: string;
  storeUrls?: Record<string, string>;
};

type PromocodeClient = Pick<
  Infrastructure['db'],
  'promocode' | 'promocodeRedemption' | 'transaction' | 'plan'
>;

const TERMINAL_INVOICE_STATUSES = new Set(['paid', 'expired', 'canceled', 'failed']);

function money(amountMinor: bigint, currency = 'RUB') {
  return { amountMinor: Number(amountMinor), currency };
}

/** Section 15.6 normalisation: uppercase and fold the ambiguous glyphs. */
function normalizePromocode(code: string): string[] {
  const upper = code.trim().toUpperCase();
  const folded = upper.replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
  return [...new Set([upper, folded])];
}

/**
 * Every `me/*` operation from section 9.4. The public controller resolves the
 * user from the session cookie and the internal controller from
 * `X-Acting-User`, but both run exactly this code (section 9.5).
 */
@Injectable()
export class MeService {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly plans: PlansService,
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly remnawave: RemnawaveService,
  ) {}

  async userIdForTelegram(actingUser: string | undefined): Promise<string> {
    if (!actingUser || !/^\d+$/.test(actingUser))
      throw new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN);
    const user = await this.infra.db.user.findUnique({
      where: { telegramId: BigInt(actingUser) },
      select: { id: true },
    });
    if (!user) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
    return user.id;
  }

  async profile(userId: string) {
    const user = await this.require(userId);
    const [wallet, subscription, purchases, botUsername, domain] = await Promise.all([
      this.balance(userId),
      this.infra.db.subscription.findFirst({
        where: { userId, status: { in: ['provisioning', 'active', 'grace'] } },
        orderBy: { expiresAt: 'desc' },
      }),
      this.infra.db.transaction.count({
        where: { userId, type: 'purchase', amountMinor: { gt: 0n } },
      }),
      this.settings.get('bot.username'),
      this.settings.get('domain.main'),
    ]);
    const trialEnabled = Boolean(await this.settings.get('trial.enabled'));

    return {
      id: user.id,
      telegramId: Number(user.telegramId),
      username: user.username,
      firstName: user.firstName,
      language: user.language,
      email: user.email,
      balance: money(wallet.available),
      balanceHeld: money(wallet.held),
      referralCode: user.referralCode,
      referralLink: `https://${String(domain)}/r/${user.referralCode}`,
      botReferralLink: `https://t.me/${String(botUsername)}?start=ref_${user.referralCode}`,
      marketingOptOut: user.marketingOptOut,
      trialAvailable: trialEnabled && !user.trialUsedAt && purchases === 0 && !subscription,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async patchProfile(userId: string, body: unknown) {
    const input = profilePatchSchema.parse(body);
    await this.infra.db.user.update({
      where: { id: userId },
      data: {
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.marketingOptOut === undefined ? {} : { marketingOptOut: input.marketingOptOut }),
      },
    });
    return this.profile(userId);
  }

  async subscription(userId: string) {
    const [subscription, panelUser, clients] = await Promise.all([
      this.infra.db.subscription.findFirst({ where: { userId }, orderBy: { expiresAt: 'desc' } }),
      this.infra.db.panelUser.findUnique({ where: { userId } }),
      this.settings.get('clients.items') as Promise<ClientLink[]>,
    ]);
    const plan = subscription?.planId
      ? await this.infra.db.plan.findUnique({ where: { id: subscription.planId } })
      : null;
    const canRevoke = Boolean(panelUser);
    const url = panelUser?.subscriptionUrl ?? '';

    return {
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            source: subscription.source,
            plan: plan ? this.publicPlan(plan) : null,
            startsAt: subscription.startsAt.toISOString(),
            expiresAt: subscription.expiresAt.toISOString(),
            daysLeft: Math.max(
              0,
              Math.ceil((subscription.expiresAt.getTime() - Date.now()) / 86_400_000),
            ),
            canChangePlan: subscription.status === 'active',
            canRevoke,
          }
        : null,
      panel: panelUser
        ? {
            status: panelUser.panelStatus,
            usedTrafficBytes: Number(panelUser.usedTrafficBytes),
            trafficLimitBytes: Number(panelUser.trafficLimitBytes),
            expireAt: panelUser.expireAtPanel?.toISOString() ?? null,
            deviceLimit: panelUser.hwidDeviceLimit,
            subscriptionUrl: panelUser.subscriptionUrl,
          }
        : null,
      clients: clients.map((client) => ({
        id: client.id,
        name: client.name,
        platforms: client.platforms,
        deepLink: client.deepLinkTemplate
          ? client.deepLinkTemplate.replaceAll('{url}', encodeURIComponent(url))
          : null,
        storeUrls: client.storeUrls ?? {},
      })),
    };
  }

  /** 512×512 PNG of the subscription link (section 9.4). */
  async subscriptionQr(userId: string): Promise<Buffer> {
    const panelUser = await this.infra.db.panelUser.findUnique({ where: { userId } });
    if (!panelUser) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
    return QRCode.toBuffer(panelUser.subscriptionUrl, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }

  async revoke(userId: string) {
    try {
      return await this.remnawave.revokeSubscription(userId);
    } catch (error) {
      if (error instanceof RevokeRateLimitError)
        throw new ApiError('REVOKE_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
      throw new ApiError('PANEL_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async devices(userId: string) {
    const items = await this.remnawave.devices(userId);
    const allowed = Boolean(await this.settings.get('subscription.user_can_remove_devices'));
    return { items, canRemove: allowed };
  }

  async removeDevice(userId: string, hwid: string): Promise<void> {
    if (!(await this.settings.get('subscription.user_can_remove_devices')))
      throw new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN);
    await this.remnawave.removeDevice(userId, hwid);
  }

  async trial(userId: string) {
    const subscription = await this.subscriptions.trial(userId);
    return { subscription, status: subscription.status };
  }

  /**
   * Section 15.2: held referral rewards are shown as pending and cannot be
   * spent, so what the customer sees as the balance, and what a balance
   * payment is offered against, is `balance_minor − SUM(held rewards)` — the
   * sum `settleBalance` checks. Read without a lock: it is only displayed.
   */
  private async balance(userId: string): Promise<{ available: bigint; held: bigint }> {
    const [account, rows] = await Promise.all([
      this.infra.db.account.findFirst({ where: { kind: 'user', userId, currency: 'RUB' } }),
      this.infra.db.$queryRaw<Array<{ held: bigint }>>(Prisma.sql`
        SELECT COALESCE(SUM(rr.amount_minor), 0)::bigint AS held
        FROM referral_rewards rr
        JOIN transactions t ON t.id = rr.transaction_id
        WHERE t.user_id = ${userId}::uuid AND rr.status = 'held'
      `),
    ]);
    const held = rows[0]?.held ?? 0n;
    return { available: (account?.balanceMinor ?? 0n) - held, held };
  }

  /** AC-061: a provider without a successful healthcheck is never offered. */
  async paymentMethods(userId: string) {
    const [providers, wallet, topupEnabled] = await Promise.all([
      this.infra.db.paymentProvider.findMany({
        where: { enabled: true },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, displayName: true, lastHealthcheckOk: true },
      }),
      this.balance(userId),
      this.settings.get('balance.topup_enabled'),
    ]);

    return {
      items: [
        {
          code: 'balance',
          displayName: { ru: 'Баланс', en: 'Balance' },
          kind: 'balance' as const,
          available: Boolean(topupEnabled),
          balance: money(wallet.available),
        },
        // AC-061: a provider is offered only after a successful healthcheck.
        // The balance is listed once, above; a row an earlier wizard wrote for
        // it is not a second payment method.
        ...providers
          .filter((provider) => provider.code !== 'balance')
          .map((provider) => ({
            code: provider.code,
            displayName: provider.displayName,
            kind: provider.code === 'stars' ? ('stars' as const) : ('redirect' as const),
            available: provider.lastHealthcheckOk === true,
            ...(provider.lastHealthcheckOk === true
              ? {}
              : { unavailableReason: 'PROVIDER_UNAVAILABLE' }),
          })),
      ],
    };
  }

  async topupConfig() {
    return {
      presetsMinor: ((await this.settings.get('balance.topup_presets_minor')) as string[]).map(
        Number,
      ),
      minMinor: Number(await this.settings.get('balance.topup_min_minor')),
      maxMinor: Number(await this.settings.get('balance.topup_max_minor')),
    };
  }

  /** F37: what buying `planId` from the balance costs now, and the top-up each provider would need. */
  async checkoutQuote(userId: string, query: unknown) {
    const input = checkoutQuoteQuerySchema.parse(query);
    const quote = await this.quote(userId, input);
    const methods = await this.paymentMethods(userId);
    const minMinor = BigInt(String(await this.settings.get('balance.topup_min_minor')));
    const topups =
      quote.missingMinor === 0n
        ? []
        : methods.items
            .filter((item) => item.available && item.kind !== 'balance')
            .flatMap((item) => {
              const providerMin = this.providerMinimum(item.code);
              return providerMin === null
                ? []
                : [
                    {
                      provider: item.code,
                      amountMinor: Number(
                        topupAmount({
                          shortMinor: quote.topupBaseMinor,
                          topupMinMinor: minMinor,
                          providerMinMinor: providerMin,
                        }),
                      ),
                    },
                  ];
            });
    return {
      planId: input.planId,
      kind: input.kind,
      priceMinor: Number(quote.priceMinor),
      discountMinor: Number(quote.discountMinor),
      creditMinor: Number(quote.creditMinor),
      toPayMinor: Number(quote.toPayMinor),
      availableMinor: Number(quote.availableMinor),
      missingMinor: Number(quote.missingMinor),
      topups,
      promocode: quote.promocode,
    };
  }

  /**
   * A provider's smallest invoice, or `null` for an enabled row the registry
   * has no implementation for (a `mock` row with the mock off): such a row is
   * never offered, and must not take the whole quote down with it.
   */
  private providerMinimum(code: string): bigint | null {
    try {
      return this.payments.minimumMinor(code);
    } catch (error) {
      if (error instanceof PaymentError && error.code === 'PAYMENT_PROVIDER_NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * F37 §3: today's purchase arithmetic from the balance, read without a
   * lock — the purchase itself re-checks everything under its locks. A
   * refused promocode is answered, not thrown: the quote stays usable.
   */
  private async quote(
    userId: string,
    input: { planId: string; kind: 'purchase' | 'plan_change'; promocode?: string | undefined },
  ) {
    const now = new Date();
    const plan = await this.infra.db.plan.findFirst({
      where: { id: input.planId, isActive: true, deletedAt: null },
    });
    if (!plan) throw new ApiError('PLAN_UNAVAILABLE', HttpStatus.CONFLICT);
    let credit = 0n;
    let creditLater = 0n;
    if (input.kind === 'plan_change') {
      const current = await this.infra.db.subscription.findFirst({
        where: { userId, status: 'active' },
      });
      const oldPlan = current?.planId
        ? await this.infra.db.plan.findUnique({ where: { id: current.planId } })
        : null;
      if (!current || !oldPlan || current.expiresAt <= now || oldPlan.id === plan.id)
        throw new ApiError('PLAN_CHANGE_NOT_ALLOWED', HttpStatus.CONFLICT);
      credit = planChangeCredit(oldPlan, current.expiresAt, now);
      creditLater = planChangeCredit(
        oldPlan,
        current.expiresAt,
        new Date(now.getTime() + PLAN_CHANGE_TOPUP_MARGIN_MS),
      );
    }
    let discount = 0n;
    let promocode: { code: string; applied: boolean; error?: string } | null = null;
    if (input.promocode) {
      try {
        const found = await this.resolvePromocode(userId, input.promocode, plan.id);
        discount = this.discountFor(found, plan.priceMinor);
        promocode = { code: input.promocode, applied: true };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        promocode = { code: input.promocode, applied: false, error: error.code };
      }
    }
    const toPay = amountToPay({
      priceMinor: plan.priceMinor,
      creditMinor: credit,
      discountMinor: discount,
    });
    const toPayLater = amountToPay({
      priceMinor: plan.priceMinor,
      creditMinor: creditLater,
      discountMinor: discount,
    });
    const { available } = await this.balance(userId);
    const missing = toPay > available ? toPay - available : 0n;
    return {
      priceMinor: plan.priceMinor,
      discountMinor: discount,
      creditMinor: credit,
      toPayMinor: toPay,
      availableMinor: available,
      missingMinor: missing,
      // A plan change's remainder melts: the top-up covers a day of it.
      topupBaseMinor:
        missing === 0n ? 0n : toPayLater > available ? toPayLater - available : missing,
      promocode,
    };
  }

  async createInvoice(userId: string, body: unknown, idempotencyKey: string | undefined) {
    const input = invoiceCreateSchema.parse(body);
    const key = idempotencyKey || randomUUID();
    if (input.kind === 'topup' && input.forPlan)
      return this.createTopupForPlan(userId, input.provider, input.forPlan, key);
    if (input.kind === 'topup') {
      const config = await this.topupConfig();
      const amount = Number(input.amountMinor ?? 0);
      if (!Number.isInteger(amount) || amount < config.minMinor || amount > config.maxMinor)
        throw new ApiError('TOPUP_AMOUNT_OUT_OF_RANGE', HttpStatus.BAD_REQUEST, undefined, config);
    }
    const request = {
      userId,
      kind: input.kind,
      provider: input.provider,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.amountMinor === undefined ? {} : { amountMinor: BigInt(input.amountMinor) }),
      idempotencyKey: key,
    };
    // A repeated request is answered before a promocode slot is reserved for
    // it: the first request already holds the slot.
    try {
      const replayed = await this.payments.replay(request);
      if (replayed) return await this.invoiceView(replayed);
    } catch (error) {
      throw this.paymentFailure(error);
    }
    // Section 15.5: the slot is reserved under a row lock before the invoice
    // exists, so two concurrent buyers can never oversell `max_uses`.
    const reservation = input.promocode
      ? await this.reservePromocodeSlot(userId, input.promocode, input.planId)
      : null;

    try {
      const invoice = await this.payments.createInvoice({
        ...request,
        ...(reservation
          ? {
              discountMinor: reservation.discountMinor,
              promocodeId: reservation.promocodeId,
              promocodeRedemptionId: reservation.redemptionId,
            }
          : {}),
      });
      if (!invoice) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
      // The reservation was linked when the invoice was created. A concurrent
      // request with the same key created the invoice instead; this
      // reservation then names no invoice and is given back.
      if (reservation)
        await this.infra.db.promocodeRedemption.updateMany({
          where: { id: reservation.redemptionId, invoiceId: null, status: 'reserved' },
          data: { status: 'released' },
        });
      return await this.invoiceView(invoice);
    } catch (error) {
      // Only a reservation no invoice took is given back. One the invoice
      // already names stays with it: the invoice carries the discount, and
      // its payment or expiry applies or releases it.
      if (reservation)
        await this.infra.db.promocodeRedemption
          .updateMany({
            where: { id: reservation.redemptionId, invoiceId: null, status: 'reserved' },
            data: { status: 'released' },
          })
          .catch(() => undefined);
      // F37: a short balance says by how much, for the top-up the client offers.
      if (
        error instanceof PaymentError &&
        error.code === 'INSUFFICIENT_FUNDS' &&
        input.kind !== 'topup' &&
        input.planId
      ) {
        // A purchase the quote refuses (the plan or the subscription changed
        // meanwhile) is answered with that refusal; a quote that fails
        // otherwise leaves the shortage without an amount, never a wrong one.
        let missing: bigint;
        try {
          const quote = await this.quote(userId, {
            planId: input.planId,
            kind: input.kind,
            ...(input.promocode ? { promocode: input.promocode } : {}),
          });
          missing = quote.missingMinor;
        } catch (quoteError) {
          if (quoteError instanceof ApiError) throw quoteError;
          throw new ApiError('INSUFFICIENT_FUNDS', HttpStatus.CONFLICT);
        }
        throw new ApiError('INSUFFICIENT_FUNDS', HttpStatus.CONFLICT, undefined, {
          missingMinor: Number(missing),
        });
      }
      throw this.paymentFailure(error);
    }
  }

  /**
   * F37: a top-up «for a plan». The server computes its amount (answer (а),
   * the plan-change margin); the promocode is only remembered — the purchase
   * from the balance applies it. FR-020: a pending top-up for the same purpose
   * at the same provider that still covers the amount is returned instead.
   */
  private async createTopupForPlan(
    userId: string,
    provider: string,
    requested: { planId: string; kind: 'purchase' | 'plan_change'; promocode?: string | undefined },
    key: string,
  ) {
    // `sale20` and `SALE20` are one purpose: the replay, the FR-020 reuse and
    // the stored `target_promocode` all see the trimmed upper-case code.
    const promocode = requested.promocode?.trim().toUpperCase() || undefined;
    const purpose = { planId: requested.planId, kind: requested.kind, promocode };
    const target = {
      planId: purpose.planId,
      kind: purpose.kind,
      ...(promocode ? { promocode } : {}),
    };
    const request = { userId, kind: 'topup' as const, provider, idempotencyKey: key, target };
    try {
      const replayed = await this.payments.replay(request);
      if (replayed) return await this.invoiceView(replayed);
    } catch (error) {
      throw this.paymentFailure(error);
    }
    const quote = await this.quote(userId, purpose);
    if (quote.missingMinor === 0n) throw new ApiError('BALANCE_SUFFICIENT', HttpStatus.CONFLICT);
    try {
      const amount = topupAmount({
        shortMinor: quote.topupBaseMinor,
        topupMinMinor: BigInt(String(await this.settings.get('balance.topup_min_minor'))),
        providerMinMinor: this.payments.minimumMinor(provider),
      });
      const pending = await this.infra.db.invoice.findFirst({
        where: {
          userId,
          kind: 'topup',
          provider,
          status: 'pending',
          expiresAt: { gt: new Date() },
          targetPlanId: purpose.planId,
          targetKind: purpose.kind,
          targetPromocode: purpose.promocode ?? null,
          amountMinor: { gte: amount },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (pending) return await this.invoiceView(pending);
      const invoice = await this.payments.createInvoice({ ...request, amountMinor: amount });
      if (!invoice) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
      return await this.invoiceView(invoice);
    } catch (error) {
      throw this.paymentFailure(error);
    }
  }

  async invoice(userId: string, id: string) {
    return this.invoiceView(await this.requireInvoice(userId, id));
  }

  async checkInvoice(userId: string, id: string) {
    await this.requireInvoice(userId, id);
    const invoice = await this.payments.recheck(id).catch((error: unknown) => {
      throw this.paymentFailure(error);
    });
    if (!invoice) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
    return this.invoiceView(invoice);
  }

  async cancelInvoice(userId: string, id: string) {
    const invoice = await this.requireInvoice(userId, id);
    if (invoice.status !== 'pending')
      throw new ApiError('INVOICE_NOT_PENDING', HttpStatus.CONFLICT);
    // The status is checked again by the update itself: a payment applied
    // since the read above holds the row and leaves it `paid`, and an invoice
    // already paid must never be marked canceled.
    const canceled = await this.infra.db.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'canceled' },
      });
      if (count === 0) return null;
      await tx.promocodeRedemption.updateMany({
        where: { invoiceId: id, status: 'reserved' },
        data: { status: 'released' },
      });
      return tx.invoice.findUniqueOrThrow({ where: { id } });
    });
    if (!canceled) throw new ApiError('INVOICE_NOT_PENDING', HttpStatus.CONFLICT);
    return this.invoiceView(canceled);
  }

  async transactions(userId: string, query: unknown) {
    const { limit, cursor } = cursorQuerySchema.parse(query);
    const rows = await this.infra.db.transaction.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    // F37: a top-up is shown with the number its receipt and provider carry.
    const numbers = new Map(
      (
        await this.infra.db.invoice.findMany({
          where: { id: { in: items.flatMap((item) => (item.invoiceId ? [item.invoiceId] : [])) } },
          select: { id: true, number: true },
        })
      ).map((row) => [row.id, row.number]),
    );
    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        amount: money(item.amountMinor, item.currency),
        provider: item.provider,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
        description: item.reason,
        invoiceNumber: item.invoiceId ? (numbers.get(item.invoiceId) ?? null) : null,
      })),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async referrals(userId: string) {
    const user = await this.require(userId);
    const attributions = await this.infra.db.referralAttribution.findMany({
      where: { referrerId: userId },
      select: { id: true, status: true },
    });
    const [rewards, botUsername, domain, mode, percent, fixedMinor, inviteeBonus] =
      await Promise.all([
        this.infra.db.referralReward.aggregate({
          where: { attributionId: { in: attributions.map((item) => item.id) }, status: 'paid' },
          _sum: { amountMinor: true },
        }),
        this.settings.get('bot.username'),
        this.settings.get('domain.main'),
        this.settings.get('referral.mode'),
        this.settings.get('referral.percent'),
        this.settings.get('referral.fixed_minor'),
        this.settings.get('referral.invitee_bonus'),
      ]);

    return {
      code: user.referralCode,
      link: `https://${String(domain)}/r/${user.referralCode}`,
      botLink: `https://t.me/${String(botUsername)}?start=ref_${user.referralCode}`,
      invited: attributions.length,
      converted: attributions.filter((item) => item.status === 'converted').length,
      earned: money(rewards._sum.amountMinor ?? 0n),
      program: {
        mode,
        percent: Number(percent),
        fixedMinor: Number(fixedMinor),
        inviteeBonus: inviteeBonus as { type: 'none' | 'days' | 'balance'; value: number },
      },
    };
  }

  async referralList(userId: string, query: unknown) {
    const { limit, cursor } = cursorQuerySchema.parse(query);
    const rows = await this.infra.db.referralAttribution.findMany({
      where: { referrerId: userId },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    const referees = await this.infra.db.user.findMany({
      where: { id: { in: items.map((item) => item.refereeId) } },
      select: { id: true, firstName: true, username: true },
    });
    const rewards = await this.infra.db.referralReward.groupBy({
      by: ['attributionId'],
      where: { attributionId: { in: items.map((item) => item.id) } },
      _sum: { amountMinor: true },
    });
    const names = new Map(referees.map((item) => [item.id, item.firstName ?? item.username ?? '']));
    const earned = new Map(
      rewards.map((item) => [item.attributionId, item._sum.amountMinor ?? 0n]),
    );

    return {
      items: items.map((item) => ({
        maskedName: maskName(names.get(item.refereeId) ?? ''),
        joinedAt: item.createdAt.toISOString(),
        status: item.status,
        rewardMinor: Number(earned.get(item.id) ?? 0n),
      })),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Section 19.5: a self-request does not anonymize anything by itself. It
   * records the request in the immutable `audit_log`, from where the admin
   * surface picks it up and an administrator performs the anonymization.
   */
  async requestAnonymization(userId: string) {
    const user = await this.require(userId);
    const existing = await this.infra.db.auditLog.findFirst({
      where: { action: 'users.anonymize.requested', entity: 'user', entityId: userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) {
      await this.infra.db.auditLog.create({
        data: {
          actorType: 'system',
          action: 'users.anonymize.requested',
          entity: 'user',
          entityId: userId,
          after: { telegramId: user.telegramId.toString() },
          reason: 'self-service',
        },
      });
    }
    return { requested: true, requestedAt: (existing?.createdAt ?? new Date()).toISOString() };
  }

  async previewPromocode(userId: string, body: unknown) {
    const input = promocodePreviewSchema.parse(body);
    const promocode = await this.resolvePromocode(userId, input.code, input.planId);
    const plan = await this.infra.db.plan.findFirst({
      where: { id: input.planId, isActive: true, deletedAt: null },
    });
    if (!plan) throw new ApiError('PLAN_UNAVAILABLE', HttpStatus.CONFLICT);
    const discount = this.discountFor(promocode, plan.priceMinor);
    return {
      discountMinor: Number(discount),
      finalMinor: Number(plan.priceMinor - discount),
    };
  }

  async redeemPromocode(userId: string, body: unknown) {
    const input = promocodeSchema.parse(body);
    const promocode = await this.resolvePromocode(userId, input.code);
    if (promocode.type === 'discount_percent' || promocode.type === 'discount_fixed') {
      await this.infra.db.user.update({
        where: { id: userId },
        data: { pendingPromocodeId: promocode.id },
      });
      return { type: promocode.type, applied: { reservedForNextPurchase: true } };
    }
    throw new ApiError('PROMO_NOT_APPLICABLE', HttpStatus.CONFLICT);
  }

  private discountFor(
    promocode: { type: string; value: bigint; minAmountMinor: bigint },
    priceMinor: bigint,
  ): bigint {
    if (priceMinor < promocode.minAmountMinor)
      throw new ApiError('PROMO_MIN_AMOUNT', HttpStatus.CONFLICT);
    if (promocode.type === 'discount_percent') return (priceMinor * promocode.value) / 100n;
    if (promocode.type === 'discount_fixed')
      return promocode.value < priceMinor ? promocode.value : priceMinor;
    return 0n;
  }

  /** Section 15.5 validation, shared by preview, redeem and invoice creation. */
  private async resolvePromocode(userId: string, code: string, planId?: string) {
    const found = await this.infra.db.promocode.findFirst({
      where: { code: { in: normalizePromocode(code) }, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new ApiError('PROMO_NOT_FOUND', HttpStatus.NOT_FOUND);
    return this.validatePromocode(this.infra.db, found.id, userId, planId);
  }

  private async validatePromocode(
    tx: PromocodeClient,
    promocodeId: string,
    userId: string,
    planId?: string,
  ) {
    const promocode = await tx.promocode.findFirst({
      where: { id: promocodeId, deletedAt: null },
    });
    if (!promocode?.isActive) throw new ApiError('PROMO_NOT_FOUND', HttpStatus.NOT_FOUND);
    const now = new Date();
    if (
      (promocode.validFrom && promocode.validFrom > now) ||
      (promocode.validUntil && promocode.validUntil < now)
    )
      throw new ApiError('PROMO_EXPIRED', HttpStatus.CONFLICT);

    const [reserved, usedByUser, purchases] = await Promise.all([
      tx.promocodeRedemption.count({
        where: { promocodeId: promocode.id, status: 'reserved' },
      }),
      tx.promocodeRedemption.count({
        where: { promocodeId: promocode.id, userId, status: { in: ['applied', 'reserved'] } },
      }),
      promocode.firstPurchaseOnly
        ? tx.transaction.count({ where: { userId, type: 'purchase' } })
        : Promise.resolve(0),
    ]);
    if (promocode.maxUses !== null && promocode.usedCount + reserved >= promocode.maxUses)
      throw new ApiError('PROMO_EXHAUSTED', HttpStatus.CONFLICT);
    if (usedByUser >= promocode.maxUsesPerUser)
      throw new ApiError('PROMO_ALREADY_USED', HttpStatus.CONFLICT);
    if (promocode.firstPurchaseOnly && purchases > 0)
      throw new ApiError('PROMO_FIRST_PURCHASE_ONLY', HttpStatus.CONFLICT);
    if (planId && promocode.planIds.length > 0 && !promocode.planIds.includes(planId))
      throw new ApiError('PROMO_NOT_APPLICABLE', HttpStatus.CONFLICT);
    return promocode;
  }

  /**
   * Locks the promo code row, re-validates it under the lock and inserts the
   * reservation. Returns the discount so the invoice can be created with it.
   */
  private async reservePromocodeSlot(
    userId: string,
    code: string,
    planId: string | undefined,
  ): Promise<{ redemptionId: string; promocodeId: string; discountMinor: bigint }> {
    return this.infra.db.$transaction(async (tx) => {
      const candidates = normalizePromocode(code);
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM promocodes
        WHERE code = ANY(${candidates}::text[]) AND deleted_at IS NULL
        FOR UPDATE`;
      if (!locked) throw new ApiError('PROMO_NOT_FOUND', HttpStatus.NOT_FOUND);
      const promocode = await this.validatePromocode(tx, locked.id, userId, planId);
      const discount =
        planId && (promocode.type === 'discount_percent' || promocode.type === 'discount_fixed')
          ? this.discountFor(promocode, await this.planPrice(tx, planId))
          : 0n;
      const redemption = await tx.promocodeRedemption.create({
        data: { promocodeId: promocode.id, userId, status: 'reserved' },
      });
      return { redemptionId: redemption.id, promocodeId: promocode.id, discountMinor: discount };
    });
  }

  private async planPrice(tx: PromocodeClient, planId: string): Promise<bigint> {
    const plan = await tx.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });
    if (!plan) throw new ApiError('PLAN_UNAVAILABLE', HttpStatus.CONFLICT);
    return plan.priceMinor;
  }

  private async requireInvoice(userId: string, id: string) {
    const invoice = await this.infra.db.invoice.findUnique({ where: { id } });
    if (!invoice || invoice.userId !== userId)
      throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
    return invoice;
  }

  private async require(userId: string) {
    const user = await this.infra.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError('NOT_FOUND', HttpStatus.NOT_FOUND);
    return user;
  }

  private publicPlan(plan: {
    id: string;
    slug: string;
    name: unknown;
    description: unknown;
    durationDays: number;
    trafficLimitBytes: bigint;
    deviceLimit: number;
    priceMinor: bigint;
    currency: string;
    sortOrder: number;
  }) {
    return {
      id: plan.id,
      slug: plan.slug,
      ...planTexts(plan),
      durationDays: plan.durationDays,
      trafficLimitBytes: Number(plan.trafficLimitBytes),
      deviceLimit: plan.deviceLimit,
      price: money(plan.priceMinor, plan.currency),
      sortOrder: plan.sortOrder,
    };
  }

  private async invoiceView(invoice: {
    id: string;
    kind: string;
    status: string;
    planId: string | null;
    provider: string;
    amountMinor: bigint;
    currency: string;
    discountMinor: bigint;
    providerAmount: { toString: () => string } | null;
    providerCurrency: string | null;
    paymentUrl: string | null;
    number: string | null;
    targetPlanId: string | null;
    targetKind: string | null;
    targetPromocode: string | null;
    expiresAt: Date;
    createdAt: Date;
  }) {
    const [plan, target] = await Promise.all([
      invoice.planId ? this.infra.db.plan.findUnique({ where: { id: invoice.planId } }) : null,
      invoice.targetPlanId
        ? this.infra.db.plan.findUnique({ where: { id: invoice.targetPlanId } })
        : null,
    ]);
    const isStars = invoice.provider === 'stars';
    return {
      id: invoice.id,
      kind: invoice.kind,
      status: invoice.status,
      terminal: TERMINAL_INVOICE_STATUSES.has(invoice.status),
      plan: plan ? this.publicPlan(plan) : null,
      provider: invoice.provider,
      amount: money(invoice.amountMinor, invoice.currency),
      discount: money(invoice.discountMinor, invoice.currency),
      ...(invoice.providerAmount && invoice.providerCurrency
        ? {
            providerAmount: {
              amount: invoice.providerAmount.toString(),
              currency: invoice.providerCurrency,
            },
          }
        : {}),
      ...(invoice.paymentUrl && !isStars ? { paymentUrl: invoice.paymentUrl } : {}),
      ...(invoice.paymentUrl && isStars ? { starsInvoiceLink: invoice.paymentUrl } : {}),
      number: invoice.number,
      target: invoice.targetPlanId
        ? {
            planId: invoice.targetPlanId,
            planSlug: target?.slug ?? '',
            kind: invoice.targetKind as 'purchase' | 'plan_change',
            promocode: invoice.targetPromocode,
          }
        : null,
      expiresAt: invoice.expiresAt.toISOString(),
      createdAt: invoice.createdAt.toISOString(),
    };
  }

  private paymentFailure(error: unknown): unknown {
    if (error instanceof ApiError) return error;
    // A provider without an implementation is, to the customer, unavailable.
    if (error instanceof PaymentError && error.code === 'PAYMENT_PROVIDER_NOT_FOUND')
      return new ApiError('PROVIDER_UNAVAILABLE', HttpStatus.CONFLICT);
    if (error instanceof PaymentError) {
      // F37: a purchase at a provider (`BALANCE_ONLY`) is a request never accepted, 422.
      const status =
        error.message === 'IDEMPOTENCY_REQUIRED'
          ? HttpStatus.BAD_REQUEST
          : error.message === 'IDEMPOTENCY_KEY_REUSED' || error.message === 'BALANCE_ONLY'
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : error.message === 'RATE_LIMITED'
              ? HttpStatus.TOO_MANY_REQUESTS
              : HttpStatus.CONFLICT;
      return new ApiError(error.message, status);
    }
    return error;
  }
}

/** Referral lists show masked names only (section 13.4). */
function maskName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '•••';
  return `${trimmed.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, trimmed.length - 1)))}`;
}
