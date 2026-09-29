import { InlineKeyboard } from 'grammy';

import type { RrContext } from '../types.js';

export function button(ctx: RrContext, key: string, data: string): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t(key), data);
}

export function backButton(ctx: RrContext, data = 'home'): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('bot.btn.back'), data);
}

export async function show(ctx: RrContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery?.message) {
    try {
      const message = await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      if (message !== true && 'message_id' in message)
        ctx.session.menuMessageId = message.message_id;
      return;
    } catch (error) {
      // The screen already shows this: nothing to change, nothing to send.
      if (error instanceof Error && error.message.includes('message is not modified')) return;
      if (!(error instanceof Error) || !error.message.includes("can't be edited")) throw error;
    }
  }
  const message = await ctx.reply(text, {
    parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  ctx.session.menuMessageId = message.message_id;
}

export function formatMinor(amountMinor: string | number, currency = 'RUB'): string {
  const amount = Number(amountMinor) / 100;
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(amount);
}

let displayTimeZone: string | undefined;

/** `settings.locale.timezone`, set whenever the bot reads its configuration. */
export function setDisplayTimeZone(timeZone: string | undefined): void {
  displayTimeZone = timeZone;
}

/**
 * A date as the customer reads it: in the shop's time zone (an unknown zone
 * falls back to UTC) and in the customer's language.
 */
export function formatDate(value: string, locale = 'ru'): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' };
  const tag = locale === 'en' ? 'en-GB' : 'ru-RU';
  try {
    return new Intl.DateTimeFormat(tag, { ...options, timeZone: displayTimeZone }).format(
      new Date(value),
    );
  } catch {
    return new Intl.DateTimeFormat(tag, { ...options, timeZone: 'UTC' }).format(new Date(value));
  }
}

/** The time of day in the shop's zone, to the second (a check's stamp). */
export function formatTime(value: Date, locale = 'ru'): string {
  const options: Intl.DateTimeFormatOptions = { timeStyle: 'medium' };
  const tag = locale === 'en' ? 'en-GB' : 'ru-RU';
  try {
    return new Intl.DateTimeFormat(tag, { ...options, timeZone: displayTimeZone }).format(value);
  } catch {
    return new Intl.DateTimeFormat(tag, { ...options, timeZone: 'UTC' }).format(value);
  }
}
