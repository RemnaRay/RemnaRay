import { formatMessage, SUPPORTED_LOCALES, type Locale } from '@remnaray/i18n-core';
import { GrammyError, InlineKeyboard, type Context, type MiddlewareFn } from 'grammy';

import type { ApiClient } from './api-client.js';
import type { BotI18n } from './i18n.js';
import { isSupportMessage } from './support-inbox.js';

/**
 * FR-124, the operators' side: a message in the operators' chat that answers
 * a customer — written in the customer's forum topic, or a reply to their
 * forwarded message — is sent to that customer: text under «Ответ поддержки»
 * in their language, a photo, file or voice message copied as it is (F35),
 * with «Завершить» for the conversation the answer keeps open. In the
 * support bot (`bot: 'support'`, F35) every answer is copied as it is: that
 * chat is the conversation. When a support bot is configured the shop bot
 * leaves the operators' chat to it. It runs before sessions and dialogs, so
 * an operator is never treated as a customer there. Anything else in that
 * chat is ignored.
 */
export function supportRelay<C extends Context>(
  api: Pick<ApiClient, 'getConfig' | 'routeSupport'>,
  i18n: Pick<BotI18n, 'catalog'>,
  options: { bot: 'shop' | 'support' } = { bot: 'shop' },
): MiddlewareFn<C> {
  return async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return next();
    const config = await api.getConfig();
    if (config.supportForwardChatId === null || chat.id !== config.supportForwardChatId)
      return next();
    if (options.bot === 'shop' && config.supportBot) return;
    const message = ctx.message;
    if (!isSupportMessage(message) || message.from.is_bot) return;
    const text = message.text?.trim();
    if (message.text !== undefined && !text) return;
    const { target } = await api.routeSupport({
      chatId: chat.id,
      ...(message.is_topic_message && message.message_thread_id !== undefined
        ? { threadId: message.message_thread_id }
        : {}),
      ...(message.reply_to_message
        ? { replyToMessageId: message.reply_to_message.message_id }
        : {}),
    });
    if (!target) return;
    const language = (SUPPORTED_LOCALES as readonly string[]).includes(target.language)
      ? (target.language as Locale)
      : config.defaultLocale;
    const catalog = await i18n.catalog(language);
    const keyboard = new InlineKeyboard().text(
      formatMessage(language, catalog, 'bot.btn.supportEnd'),
      'support:end',
    );
    try {
      if (options.bot === 'support')
        await ctx.api.copyMessage(Number(target.telegramId), chat.id, message.message_id);
      else if (text)
        // `formatMessage` escapes the values for HTML, so the message is sent
        // as HTML: an operator's "<" or "'" reaches the customer as typed.
        await ctx.api.sendMessage(
          Number(target.telegramId),
          formatMessage(language, catalog, 'bot.screen.support.reply', { text }),
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      else
        await ctx.api.copyMessage(Number(target.telegramId), chat.id, message.message_id, {
          reply_markup: keyboard,
        });
    } catch (error) {
      if (!(error instanceof GrammyError)) throw error;
      const operators = await i18n.catalog(config.defaultLocale);
      await ctx.reply(
        formatMessage(config.defaultLocale, operators, 'bot.screen.support.undelivered', {
          reason: error.description,
        }),
        {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
          ...(message.is_topic_message && message.message_thread_id !== undefined
            ? { message_thread_id: message.message_thread_id }
            : {}),
        },
      );
    }
  };
}
