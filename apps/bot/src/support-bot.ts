import { autoRetry } from '@grammyjs/auto-retry';
import { limit } from '@grammyjs/ratelimiter';
import { formatMessage, type Locale } from '@remnaray/i18n-core';
import {
  Bot,
  GrammyError,
  InlineKeyboard,
  type BotError,
  type Context,
  type MiddlewareFn,
} from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type Redis from 'ioredis';

import { ApiClientError, type ApiClient } from './api-client.js';
import { incidentId, outgoingThrottle } from './bot.js';
import { normalizeLocale, type BotI18n } from './i18n.js';
import { supportRelay } from './support.js';
import { RATING_DATA, rateTicket, ratingKeyboard } from './support-rating.js';
import { isSupportMessage, messageInfo, movedTo } from './support-inbox.js';

export type SupportContext = Context & {
  t: (key: string, values?: Record<string, unknown>) => string;
};

export type SupportRuntime = { bot: Bot<SupportContext> };

/**
 * The optional support bot (owner decision F35). A customer writes to it, and
 * every message — text, photos, files, voice — is copied to their topic in
 * the operators' chat; the operators' answers there come back from this bot,
 * as they are. It speaks the customer's Telegram language, and runs beside
 * the shop bot in the same process and delivery mode.
 */
export function createSupportBot(options: {
  token: string;
  api: ApiClient;
  i18n: Pick<BotI18n, 'catalog'>;
  redis?: Redis;
  apiRoot?: string;
  /** Known in tests; otherwise `bot.init()` asks Telegram. */
  botInfo?: UserFromGetMe;
}): SupportRuntime {
  const { api, i18n } = options;
  const bot = new Bot<SupportContext>(options.token, {
    ...(options.apiRoot ? { client: { apiRoot: options.apiRoot } } : {}),
    ...(options.botInfo ? { botInfo: options.botInfo } : {}),
  });
  bot.api.config.use(autoRetry({ maxDelaySeconds: 60, maxRetryAttempts: 5 }));
  bot.api.config.use(outgoingThrottle());
  // FR-124, the operators' side: their answers and the ticket cards' buttons
  // (F36), which it answers itself — before any other callback answer.
  bot.use(supportRelay<SupportContext>(api, { bot: 'support' }));
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await next();
  });
  // The customer's language, or the shop's default for an operator.
  bot.use(async (ctx, next) => {
    const config = await api.getConfig();
    const locale: Locale = normalizeLocale(ctx.from?.language_code) ?? config.defaultLocale;
    const messages = await i18n.catalog(locale);
    ctx.t = (key, values = {}) =>
      formatMessage(locale, messages, key, { brand: config.brandName, ...values });
    await next();
  });
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.from) await next();
  });
  // A ticket belongs to a shop user: someone who writes here first is registered.
  const registered = new Set<number>();
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && !registered.has(from.id)) {
      await api.upsertUser({
        telegramId: from.id,
        ...(from.username ? { username: from.username } : {}),
        firstName: from.first_name,
        ...(from.language_code ? { languageCode: from.language_code } : {}),
      });
      if (registered.size > 10_000) registered.clear();
      registered.add(from.id);
    }
    await next();
  });
  bot.use(
    limit({
      timeFrame: 10_000,
      limit: 20,
      ...(options.redis ? { storageClient: options.redis } : {}),
      keyPrefix: 'rr:tg:support-limit:',
      keyGenerator: (ctx) => ctx.from?.id.toString(),
    }),
  );
  bot.command('start', (ctx) => ctx.reply(ctx.t('bot.support.start')));
  bot.callbackQuery('support:end', async (ctx) => {
    const { ticket } = await api.closeSupport(ctx.from.id, 'support');
    if (!ticket) {
      await ctx.reply(ctx.t('bot.support.ticket.none'));
      return;
    }
    await ctx.reply(
      `${ctx.t('bot.support.ticket.closedByCustomer', { number: ticket.number })}\n\n${ctx.t('bot.support.rate.ask')}`,
      { reply_markup: ratingKeyboard(ticket.id) },
    );
  });
  bot.callbackQuery(RATING_DATA, rateTicket(api));
  bot.on('message', supportBotInbox(api));
  bot.catch(supportBotErrorHandler);
  return { bot };
}

/** Every message the customer sends goes into their ticket; a new one is confirmed. */
export function supportBotInbox(
  api: Pick<ApiClient, 'forwardSupport'>,
): MiddlewareFn<SupportContext> {
  return async (ctx) => {
    const message = ctx.message;
    if (!ctx.from || !message) return;
    if (message.text?.startsWith('/')) return;
    if (!isSupportMessage(message)) {
      await ctx.reply(ctx.t('bot.support.unsupported'));
      return;
    }
    try {
      const { ticket } = await api.forwardSupport(ctx.from.id, message.message_id, {
        via: 'support',
        message: messageInfo(message),
      });
      if (ticket.created)
        await ctx.reply(ctx.t('bot.support.ticket.created', { number: ticket.number }), {
          reply_markup: new InlineKeyboard().text(ctx.t('bot.btn.supportClose'), 'support:end'),
        });
    } catch (error) {
      if (!(error instanceof ApiClientError)) throw error;
      // FR-124: a message that did not reach the operators is not reported
      // as sent; support that moved back to the shop bot says where it is.
      await ctx.reply(
        error.code === 'SUPPORT_MOVED' && movedTo(error) === null
          ? ctx.t('bot.support.off')
          : ctx.t('bot.error.support_unavailable'),
      );
    }
  };
}

/** FR-127 for the support bot: logged with an incident id, never the text. */
async function supportBotErrorHandler(error: BotError<SupportContext>): Promise<void> {
  const cause = error.error;
  const id = incidentId();
  console.error('Support bot update failed', {
    incidentId: id,
    updateId: error.ctx.update.update_id,
    chatId: error.ctx.chat?.id,
    ...(cause instanceof GrammyError
      ? { code: cause.error_code, description: cause.description, method: cause.method }
      : cause instanceof ApiClientError
        ? { description: 'api_error', status: cause.status, apiCode: cause.code }
        : { description: 'handler_error', error: cause instanceof Error ? cause.name : 'unknown' }),
  });
  if (cause instanceof GrammyError && (cause.error_code === 403 || cause.error_code === 429))
    return;
  if (error.ctx.chat?.type === 'private' && typeof error.ctx.t === 'function')
    await error.ctx
      .reply(error.ctx.t('bot.error.generic', { incidentId: id }))
      .catch(() => undefined);
}
