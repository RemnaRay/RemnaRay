import { randomUUID } from 'node:crypto';
import {
  conversations,
  createConversation,
  type ConversationData,
  type ConversationStorage,
  type VersionedState,
} from '@grammyjs/conversations';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type Redis from 'ioredis';
import { formatMessage, type Locale } from '@remnaray/i18n-core';
import type { ApiClient } from './api-client.js';
import { formatMinor } from './screens/common.js';
import { topupProviderKeyboard, topupProviders } from './screens/index.js';
import type { RrContext } from './types.js';

export const conversationTtlSeconds = 600;

export function installConversations(bot: Bot<RrContext>, redis: Redis, api: ApiClient): void {
  bot.use(conversations<RrContext, Context>({ storage: conversationStorage(redis) }));
  // This sits before each createConversation middleware, which consumes updates
  // on replay. Commands therefore exit the dialog and reach normal routing.
  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith('/')) await ctx.conversation.exitAll();
    await next();
  });
  for (const id of ['promoEnter', 'topupCustom', 'emailAsk'] as const) {
    bot.use(
      createConversation<RrContext, Context>(async (conversation, ctx) => {
        if (!ctx.from) return;
        const telegramId = ctx.from.id;
        const locale: Locale = await conversation.external((outside) => outside.session.lang);
        const catalog = await conversation.external(() => api.getMessages(locale));
        const t = (key: string, values?: Record<string, unknown>) =>
          formatMessage(locale, catalog.messages, key, values);
        const prompts = {
          promoEnter: 'bot.screen.promo.ask',
          topupCustom: 'bot.screen.topup.ask',
          emailAsk: 'bot.screen.email.ask',
        };
        await ctx.reply(
          t(prompts[id]),
          id === 'emailAsk'
            ? { reply_markup: new InlineKeyboard().text(t('bot.btn.skip'), 'email:skip') }
            : {},
        );
        const config =
          id === 'topupCustom'
            ? await conversation.external(() => api.getTopupConfig())
            : { minMinor: 0, maxMinor: 0, presetsMinor: [] };
        const started = await conversation.now();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const remaining = 600_000 - ((await conversation.now()) - started);
          if (remaining <= 0) {
            await conversation.halt({ next: true });
            return;
          }
          let reply: Context;
          try {
            reply = await conversation.wait({ maxMilliseconds: remaining });
          } catch {
            await ctx.reply(t('bot.error.conversation_timeout'));
            return;
          }
          if (id === 'emailAsk' && reply.callbackQuery?.data === 'email:skip') return;
          const text = reply.message?.text?.trim();
          if (text?.startsWith('/')) {
            await conversation.halt({ next: true });
            return;
          }
          const amount = text && id === 'topupCustom' ? parseAmount(text) : undefined;
          const valid =
            text !== undefined &&
            (id === 'emailAsk'
              ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) && text.length <= 254
              : id === 'promoEnter'
                ? /^[A-Za-z0-9_-]{3,64}$/u.test(text)
                : amount !== undefined &&
                  BigInt(amount) >= BigInt(config.minMinor) &&
                  BigInt(amount) <= BigInt(config.maxMinor));
          if (!valid) {
            if (attempt < 2) await reply.reply(t('bot.error.invalid_input'));
            continue;
          }
          if (id === 'emailAsk') {
            await conversation.external(() => api.patchMe(telegramId, { email: text }));
            await reply.reply(t('bot.screen.email.saved'));
          } else if (id === 'promoEnter') {
            await conversation.external(() => api.redeemPromo(telegramId, text));
            await reply.reply(t('bot.screen.promo.accepted'));
          } else {
            const providers = topupProviders(
              await conversation.external(() => api.getPaymentMethods(telegramId)),
            );
            const provider = providers[0]?.code;
            if (!provider || amount === undefined) {
              await reply.reply(t('bot.error.provider_unavailable'));
              return;
            }
            if (providers.length > 1) {
              await reply.reply(
                t('bot.screen.topup.provider', { amount: formatMinor(Number(amount)) }),
                { reply_markup: topupProviderKeyboard({ t, locale }, providers, Number(amount)) },
              );
              return;
            }
            const key = await conversation.external(() => randomUUID());
            const invoice = await conversation.external(() =>
              api.createInvoice(
                telegramId,
                { kind: 'topup', provider, amountMinor: Number(amount) },
                key,
              ),
            );
            await reply.reply(invoice.paymentUrl ?? t('bot.screen.pay.ok'));
          }
          return;
        }
        await ctx.reply(t('bot.error.too_many_attempts'));
      }, id),
    );
  }
}

export function parseAmount(value: string): string | undefined {
  if (!/^\d{1,12}([.,]\d{1,2})?$/u.test(value)) return undefined;
  const [whole = '0', decimals = ''] = value.replace(',', '.').split('.');
  return (BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'))).toString();
}

function conversationStorage(redis: Redis): ConversationStorage<RrContext, ConversationData> {
  return {
    type: 'key',
    prefix: 'tg:conv:',
    getStorageKey: (ctx) => ctx.from?.id.toString(),
    adapter: {
      async read(key: string): Promise<VersionedState<ConversationData> | undefined> {
        const value = await redis.get(key);
        return value ? (JSON.parse(value) as VersionedState<ConversationData>) : undefined;
      },
      async write(key, state) {
        await redis.set(key, JSON.stringify(state), 'EX', conversationTtlSeconds);
      },
      async delete(key) {
        await redis.del(key);
      },
    },
  };
}
