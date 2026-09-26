import type { Message } from 'grammy/types';
import type { MiddlewareFn } from 'grammy';

import { ApiClientError, type ApiClient } from './api-client.js';
import type { RrContext } from './types.js';

/** What a customer can send to the operators; copied as it is (F35). */
const SUPPORTED: Array<keyof Message> = [
  'text',
  'photo',
  'document',
  'voice',
  'video',
  'audio',
  'animation',
  'video_note',
  'sticker',
];

export function isSupportMessage(message: Message | undefined): message is Message {
  return message !== undefined && SUPPORTED.some((field) => message[field] !== undefined);
}

/**
 * FR-124 in the shop's bot, the customer's side. It runs after every
 * command, button and dialog, so it sees only what nothing else took: while
 * the customer's conversation is open («Поддержка», or an operator's answer,
 * until «Завершить») the message goes to the operators, and the first one is
 * confirmed. Outside a conversation it is left alone, as before.
 */
export function supportInbox(api: Pick<ApiClient, 'forwardSupport'>): MiddlewareFn<RrContext> {
  return async (ctx, next) => {
    const message = ctx.message;
    if (ctx.chat?.type !== 'private' || !ctx.from || !isSupportMessage(message)) return next();
    if (message.text?.startsWith('/')) return next();
    try {
      const { acknowledge } = await api.forwardSupport(ctx.from.id, message.message_id, {
        requireOpen: true,
      });
      if (acknowledge) await ctx.reply(ctx.t('bot.screen.support.sent'));
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'SUPPORT_CLOSED') return next();
      if (!(error instanceof ApiClientError)) throw error;
      // FR-124: a message that did not reach the operators is not reported as sent.
      await ctx.reply(ctx.t('bot.error.support_unavailable'));
    }
  };
}
