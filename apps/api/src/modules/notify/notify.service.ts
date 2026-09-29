import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { formatMessage, SUPPORTED_LOCALES, type Locale } from '@remnaray/i18n-core';
import { notificationsTotal } from '@remnaray/metrics';

import { Infrastructure } from '../../infra/infra.module';
import { I18nService } from '../public/i18n.service';
import { SettingsService } from '../settings/settings.service';

/** Section 16.1 events, with the buttons each one carries. */
export const NOTIFY_EVENTS = {
  'sub.activated': ['subscription', 'clients'],
  'sub.expires_in_3d': ['renew'],
  'sub.expires_in_1d': ['renew'],
  'trial.expires_in_1d': ['buy'],
  'sub.expired': ['renew', 'plans'],
  'sub.traffic_80': ['changePlan'],
  'sub.traffic_limit': ['changePlan', 'renew'],
  'payment.succeeded': ['subscription'],
  'payment.to_balance': ['plans', 'balance'],
  'referral.reward': ['referrals'],
  'referral.invitee_bonus': ['subscription'],
  'promo.applied': ['subscription'],
  'admin.message': [],
} as const;

export type NotifyEvent = keyof typeof NOTIFY_EVENTS;

const BUTTON_CALLBACK: Record<string, string> = {
  subscription: 'sub',
  clients: 'clients',
  renew: 'plans',
  buy: 'plans',
  plans: 'plans',
  changePlan: 'plans',
  balance: 'balance',
  referrals: 'ref',
};

/**
 * The buttons of a notification. F37: a top-up for a plan offers that plan —
 * `tb:<invoiceId>` opens the bot's confirmation card with a fresh quote.
 */
export function notificationButtons(
  event: NotifyEvent,
  params: Record<string, string | number>,
): Array<{ key: string; callback: string }> {
  if (event === 'payment.to_balance' && params.hasPlan === 'yes' && params.buyInvoice)
    return [
      { key: 'buyPlan', callback: `tb:${String(params.buyInvoice)}` },
      { key: 'balance', callback: 'balance' },
    ];
  return NOTIFY_EVENTS[event].map((key) => ({ key, callback: BUTTON_CALLBACK[key] ?? 'home' }));
}

/** Marketing events honour `marketing_opt_out`; service events never do. */
const MARKETING_EVENTS = new Set<string>([]);

export const notifySendSchema = z.object({
  event: z.enum(Object.keys(NOTIFY_EVENTS) as [NotifyEvent, ...NotifyEvent[]]),
  userId: z.uuid(),
  subscriptionId: z.uuid().nullable().optional(),
  dedupKey: z.string().min(3).max(200),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

export const alertSchema = z.object({
  type: z.string().min(3).max(64),
  details: z.string().max(500).optional(),
});

export type NotifyResult = {
  status: 'sent' | 'duplicate' | 'skipped_blocked' | 'skipped_opt_out' | 'skipped' | 'failed';
};

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * FR-160: at most one delivery per `(user, dedupKey)`. The unique index does
   * the deduplication, so a repeated cron window never sends twice (AC-160).
   */
  async send(body: unknown): Promise<NotifyResult> {
    const input = notifySendSchema.parse(body);
    const result = await this.sendParsed(input);
    // Section 9.9 `rr_notifications_total{event,status}`: counted once per
    // attempt, whichever way it ended — a skipped notification is as worth
    // seeing on a dashboard as a sent one.
    notificationsTotal.inc({ event: input.event, status: result.status });
    return result;
  }

  private async sendParsed(input: z.infer<typeof notifySendSchema>): Promise<NotifyResult> {
    const user = await this.infra.db.user.findUnique({ where: { id: input.userId } });
    if (!user) return { status: 'skipped' };

    // `notification_log` is immutable, so the row is written once with its final
    // status. A short Valkey lock keeps two workers from delivering the same
    // notification before either row exists; the unique index is the backstop.
    const lockKey = `rr:notify:${input.userId}:${input.dedupKey}`;
    const lock = await this.infra.redis.set(lockKey, '1', 'EX', 60, 'NX').catch(() => 'OK');
    if (lock !== 'OK') return { status: 'duplicate' };

    try {
      const existing = await this.infra.db.notificationLog.findFirst({
        where: { userId: input.userId, dedupKey: input.dedupKey },
        select: { id: true },
      });
      if (existing) return { status: 'duplicate' };

      const skip = user.isBanned
        ? 'skipped'
        : user.botBlockedAt
          ? 'skipped_blocked'
          : MARKETING_EVENTS.has(input.event) && user.marketingOptOut
            ? 'skipped_opt_out'
            : null;
      if (skip) {
        await this.record(input, skip);
        return { status: skip };
      }

      const locale: Locale = SUPPORTED_LOCALES.includes(user.language as Locale)
        ? (user.language as Locale)
        : 'ru';
      const catalog = await this.i18n.messages(locale);
      const text = formatMessage(locale, catalog, `notify.${input.event}`, input.params);
      const buttons = notificationButtons(input.event, input.params).map((button) => ({
        text: formatMessage(locale, catalog, `notify.btn.${button.key}`, input.params),
        callback_data: button.callback,
      }));

      try {
        await this.deliver(user.telegramId, text, buttons);
        await this.record(input, 'sent', new Date());
        return { status: 'sent' };
      } catch (error) {
        const blocked = error instanceof TelegramDeliveryError && error.status === 403;
        if (blocked)
          await this.infra.db.user.update({
            where: { id: input.userId },
            data: { botBlockedAt: new Date() },
          });
        await this.record(input, blocked ? 'skipped_blocked' : 'failed', undefined, String(error));
        return { status: blocked ? 'skipped_blocked' : 'failed' };
      }
    } finally {
      await this.infra.redis.del(lockKey).catch(() => 0);
    }
  }

  /**
   * Cron `notify.scan-expiring` (section 16.1). The window is wide on purpose;
   * `notification_log` keeps a repeated scan from sending twice.
   */
  async scanExpiring(now = new Date()): Promise<{ queued: number }> {
    const horizon = new Date(now.getTime() + 3 * 86_400_000);
    const rows = await this.infra.db.subscription.findMany({
      where: { status: 'active', expiresAt: { gt: now, lte: horizon } },
      select: { id: true, userId: true, source: true, expiresAt: true },
      take: 1000,
    });

    let queued = 0;
    for (const row of rows) {
      const hoursLeft = (row.expiresAt.getTime() - now.getTime()) / 3_600_000;
      const event: NotifyEvent | null =
        hoursLeft <= 24
          ? row.source === 'trial'
            ? 'trial.expires_in_1d'
            : 'sub.expires_in_1d'
          : hoursLeft <= 72
            ? 'sub.expires_in_3d'
            : null;
      if (!event) continue;
      const result = await this.send({
        event,
        userId: row.userId,
        subscriptionId: row.id,
        dedupKey: `${event}:${row.id}`,
        params: { until: row.expiresAt.toISOString().slice(0, 10) },
      });
      if (result.status === 'sent') queued += 1;
    }
    return { queued };
  }

  /** FR-163: one alert per type per hour, to every active admin with a chat. */
  async alert(body: unknown): Promise<{ delivered: number; deduplicated: boolean }> {
    const input = alertSchema.parse(body);
    const acquired = await this.infra.redis
      .set(`rr:alert:${input.type}`, '1', 'EX', 3600, 'NX')
      .catch(() => null);
    if (acquired !== 'OK') return { delivered: 0, deduplicated: true };

    const [admins, language] = await Promise.all([
      this.infra.db.admin.findMany({
        where: { isActive: true, deletedAt: null, role: 'admin', telegramId: { not: null } },
        select: { telegramId: true },
      }),
      this.settings.get('admin.language'),
    ]);
    const locale: Locale = language === 'en' ? 'en' : 'ru';
    const catalog = await this.i18n.messages(locale);
    const title = formatMessage(locale, catalog, 'alerts.title', { type: input.type });
    const body_ = formatMessage(locale, catalog, `alerts.${input.type}`);
    const text = `<b>${title}</b>\n${body_}${input.details ? `\n${input.details}` : ''}`;

    let delivered = 0;
    for (const admin of admins) {
      if (admin.telegramId === null) continue;
      try {
        await this.deliver(admin.telegramId, text, []);
        delivered += 1;
      } catch (error) {
        this.logger.warn(`Alert delivery failed: ${String(error)}`);
      }
    }
    return { delivered, deduplicated: false };
  }

  private async record(
    input: {
      event: NotifyEvent;
      userId: string;
      subscriptionId?: string | null | undefined;
      dedupKey: string;
    },
    status: string,
    sentAt?: Date,
    error?: string,
  ): Promise<void> {
    try {
      await this.infra.db.notificationLog.create({
        data: {
          userId: input.userId,
          event: input.event,
          ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
          dedupKey: input.dedupKey,
          status,
          ...(sentAt ? { sentAt } : {}),
          ...(error ? { error: error.slice(0, 500) } : {}),
        },
      });
    } catch (failure) {
      if (!isUniqueViolation(failure)) throw failure;
    }
  }

  private async deliver(
    telegramId: bigint,
    text: string,
    buttons: { text: string; callback_data: string }[],
  ): Promise<void> {
    const token = String(await this.settings.get('bot.token'));
    if (!token) throw new TelegramDeliveryError(0, 'BOT_TOKEN_MISSING');
    const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
    const response = await fetch(`${base}/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: telegramId.toString(),
        text,
        parse_mode: 'HTML',
        ...(buttons.length > 0
          ? { reply_markup: { inline_keyboard: [buttons.map((button) => button)] } }
          : {}),
      }),
    });
    if (!response.ok) throw new TelegramDeliveryError(response.status, await response.text());
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export class TelegramDeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`telegram ${String(status)}: ${message.slice(0, 200)}`);
    this.name = 'TelegramDeliveryError';
  }
}
