import type { Message } from 'grammy/types';
import { InlineKeyboard, type MiddlewareFn } from 'grammy';

import { ApiClientError, type ApiClient, type SupportMessageInfo } from './api-client.js';
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

/** What the message is and says, kept with the ticket (owner decision F36). */
export function messageInfo(message: Message): SupportMessageInfo {
  const kind = SUPPORTED.find((field) => message[field] !== undefined) ?? 'text';
  const text = message.text ?? message.caption;
  const media =
    message.photo?.at(-1) ??
    message.document ??
    message.voice ??
    message.video ??
    message.audio ??
    message.animation ??
    message.video_note ??
    message.sticker;
  return {
    kind,
    ...(text ? { text: text.slice(0, 4096) } : {}),
    ...(media ? { fileId: media.file_id, fileUniqueId: media.file_unique_id } : {}),
  };
}

/**
 * FR-124 in the shop's bot, the customer's side. It runs after every
 * command, button and dialog, so it sees only what nothing else took: while
 * the customer writes to support («Написать оператору», or an operator's
 * answer, until «Завершить») the message goes into their ticket, and a new
 * ticket is confirmed with its number (F36). Otherwise it is left alone.
 */
export function supportInbox(api: Pick<ApiClient, 'forwardSupport'>): MiddlewareFn<RrContext> {
  return async (ctx, next) => {
    const message = ctx.message;
    if (ctx.chat?.type !== 'private' || !ctx.from || !isSupportMessage(message)) return next();
    if (message.text?.startsWith('/')) return next();
    try {
      const { ticket } = await api.forwardSupport(ctx.from.id, message.message_id, {
        requireOpen: true,
        message: messageInfo(message),
      });
      if (ticket.created)
        await ctx.reply(ctx.t('bot.support.ticket.created', { number: ticket.number }), {
          reply_markup: new InlineKeyboard().text(ctx.t('bot.btn.supportEnd'), 'support:end'),
        });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'SUPPORT_CLOSED') return next();
      if (!(error instanceof ApiClientError)) throw error;
      // Support moved to its own bot (F35) while this conversation was open.
      const username = movedTo(error);
      if (username) {
        await ctx.reply(ctx.t('bot.screen.support.bot', { username }));
        return;
      }
      // FR-124: a message that did not reach the operators is not reported as sent.
      await ctx.reply(ctx.t('bot.error.support_unavailable'));
    }
  };
}

/** The support bot's username a `SUPPORT_MOVED` refusal names, if any. */
export function movedTo(error: ApiClientError): string | null {
  if (error.code !== 'SUPPORT_MOVED') return null;
  const details = (error.details as { error?: { details?: { username?: unknown } } } | undefined)
    ?.error?.details;
  return typeof details?.username === 'string' && details.username ? details.username : null;
}
