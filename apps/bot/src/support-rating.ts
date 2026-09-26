import { InlineKeyboard, type Context } from 'grammy';

import type { ApiClient } from './api-client.js';

/** ★1…★5 under a closed ticket: `rate:<ticket id>:<n>` (owner decision F36). */
export function ratingKeyboard(ticketId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const rating of [1, 2, 3, 4, 5])
    keyboard.text(`${String(rating)}★`, `rate:${ticketId}:${String(rating)}`);
  return keyboard;
}

export const RATING_DATA = /^rate:([0-9a-f-]{36}):([1-5])$/u;

/**
 * A press on ★n: the API takes the first rating of the customer's own closed
 * ticket; the stars are removed either way, so the question is not asked twice.
 */
export function rateTicket(api: Pick<ApiClient, 'rateSupport'>) {
  return async (ctx: Context & { t: (key: string) => string }): Promise<void> => {
    const match = RATING_DATA.exec(ctx.callbackQuery?.data ?? '');
    if (!ctx.from || !match) return;
    const [, ticketId, rating] = match as unknown as [string, string, string];
    const { accepted } = await api.rateSupport(ctx.from.id, ticketId, Number(rating));
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await ctx.reply(ctx.t(accepted ? 'bot.support.rate.thanks' : 'bot.support.rate.already'));
  };
}
