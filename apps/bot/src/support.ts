import type { Context, MiddlewareFn } from 'grammy';

import type { ApiClient, SupportVia } from './api-client.js';
import { isSupportMessage, messageInfo } from './support-inbox.js';

/**
 * FR-124, the operators' side, with the owner's F35 and F36 decisions. In the
 * operators' chat every member's message — an answer in a customer's topic
 * or a reply to their ticket, a note, a command — and every press on a ticket
 * card's button goes to the API, which keeps the ticket and makes the
 * Telegram calls; the bot answers the button press with what the API says.
 * When a support bot is configured the shop bot leaves that chat to it. It
 * runs first, before sessions and dialogs, so an operator is never treated
 * as a customer there. Anything outside that chat passes on.
 */
export function supportRelay<C extends Context>(
  api: Pick<ApiClient, 'getConfig' | 'operatorSupport' | 'supportCallback'>,
  options: { bot: SupportVia } = { bot: 'shop' },
): MiddlewareFn<C> {
  return async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return next();
    const config = await api.getConfig();
    if (config.supportForwardChatId === null || chat.id !== config.supportForwardChatId)
      return next();
    if (options.bot === 'shop' && config.supportBot) return;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
    const callback = ctx.callbackQuery;
    if (callback?.data?.startsWith('st:')) {
      const answer = await api.supportCallback({
        chatId: chat.id,
        from: { id: from.id, name },
        data: callback.data,
        via: options.bot,
      });
      await ctx.answerCallbackQuery({
        text: answer.text,
        ...(answer.alert ? { show_alert: true } : {}),
      });
      return;
    }
    if (callback) {
      await ctx.answerCallbackQuery();
      return;
    }
    const message = ctx.message;
    if (!isSupportMessage(message)) return;
    if (message.text !== undefined && !message.text.trim()) return;
    await api.operatorSupport({
      chatId: chat.id,
      messageId: message.message_id,
      ...(message.is_topic_message && message.message_thread_id !== undefined
        ? { threadId: message.message_thread_id }
        : {}),
      ...(message.reply_to_message
        ? { replyToMessageId: message.reply_to_message.message_id }
        : {}),
      from: { id: from.id, name },
      via: options.bot,
      message: messageInfo(message),
    });
  };
}
