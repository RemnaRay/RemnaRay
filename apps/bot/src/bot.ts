import { autoRetry } from '@grammyjs/auto-retry';
import { limit } from '@grammyjs/ratelimiter';
import { RedisAdapter } from '@grammyjs/storage-redis';
import { sequentialize } from '@grammyjs/runner';
import { Bot, session } from 'grammy';
import { GrammyError, HttpError, type BotError, type Transformer } from 'grammy';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

import { ApiClient, ApiClientError } from './api-client.js';
import { BotI18n } from './i18n.js';
import { registerScreens } from './screens/index.js';
import { isPaymentUpdate, registerStars } from './screens/stars.js';
import { installConversations } from './conversations.js';
import { supportRelay } from './support.js';
import { supportInbox } from './support-inbox.js';
import type { BotConfig, BotSession, RrContext } from './types.js';

export type BotRuntime = {
  bot: Bot<RrContext>;
  api: ApiClient;
  redis: Redis;
  i18n: BotI18n;
};

const THROTTLED_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'sendPhoto',
  'sendInvoice',
  'copyMessage',
]);

export function outgoingThrottle(): Transformer {
  let chain = Promise.resolve();
  let globalReadyAt = 0;
  const chatReadyAt = new Map<string, number>();
  return (prev, method, payload, signal) => {
    if (!THROTTLED_METHODS.has(method)) return prev(method, payload, signal);
    const value = payload as Record<string, unknown>;
    const chatId =
      typeof value.chat_id === 'number' || typeof value.chat_id === 'string'
        ? String(value.chat_id)
        : undefined;
    const task = chain.then(async () => {
      const now = Date.now();
      const chatAt = chatId ? (chatReadyAt.get(chatId) ?? 0) : 0;
      const wait = Math.max(globalReadyAt - now, chatAt - now);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      const sentAt = Date.now();
      globalReadyAt = sentAt + 34;
      if (chatId) chatReadyAt.set(chatId, sentAt + 1000);
      return prev(method, payload, signal);
    });
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

export function incidentId(): string {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

const initialSession = (): BotSession => ({ lang: 'ru' });

/**
 * FR-127: an unhandled handler error is logged with its full context — never a
 * token or the update's text — and answered with `error.generic` carrying the
 * same incident id, so a customer's report can be found in the log. Telegram
 * 403 is EX-04 (the user blocked the bot); 429 is left to auto-retry.
 */
export function botErrorHandler(
  api: Pick<ApiClient, 'markBlocked'>,
): (error: BotError<RrContext>) => Promise<void> {
  return async (error) => {
    const ctx = error.ctx;
    const cause = error.error;
    const telegram =
      cause instanceof GrammyError
        ? { code: cause.error_code, description: cause.description, method: cause.method }
        : cause instanceof HttpError
          ? { description: 'http_error' }
          : cause instanceof ApiClientError
            ? { description: 'api_error', status: cause.status, apiCode: cause.code }
            : {
                description: 'handler_error',
                error: cause instanceof Error ? cause.name : typeof cause,
                message: cause instanceof Error ? cause.message : undefined,
                stack: cause instanceof Error ? cause.stack : undefined,
              };
    const id = incidentId();
    console.error('Telegram update failed', {
      incidentId: id,
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id,
      updateType: Object.keys(ctx.update).find((key) => key !== 'update_id'),
      callbackData: ctx.callbackQuery?.data,
      ...telegram,
    });
    if (cause instanceof GrammyError && cause.error_code === 403 && ctx.from) {
      await api.markBlocked(ctx.from.id).catch(() => undefined);
      return;
    }
    if (cause instanceof GrammyError && cause.error_code === 429) return;
    if (ctx.from)
      await ctx.reply(ctx.t('bot.error.generic', { incidentId: id })).catch(() => undefined);
  };
}

export function createBot(options: {
  token: string;
  api?: ApiClient;
  redis?: Redis;
  apiRoot?: string;
}): BotRuntime {
  const api = options.api ?? new ApiClient();
  const redis =
    options.redis ??
    new Redis(process.env.VALKEY_URL ?? 'redis://valkey:6379/0', {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
  const bot = new Bot<RrContext>(
    options.token,
    options.apiRoot ? { client: { apiRoot: options.apiRoot } } : {},
  );
  const i18n = new BotI18n(api);

  bot.api.config.use(autoRetry({ maxDelaySeconds: 60, maxRetryAttempts: 5 }));
  bot.api.config.use(outgoingThrottle());
  // FR-124: operators answer in their chat and press the ticket cards'
  // buttons (F36), which the relay answers itself; they are not customers there.
  bot.use(supportRelay(api));
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    if (ctx.from) await next();
  });
  bot.use(sequentialize((ctx) => ctx.from?.id.toString()));
  bot.use(
    limit({
      timeFrame: 10_000,
      limit: 20,
      storageClient: redis,
      keyPrefix: 'rr:tg:limit:',
      // Stars payment updates are never limited (section 11.3.6).
      keyGenerator: (ctx) => (isPaymentUpdate(ctx) ? undefined : ctx.from?.id.toString()),
    }),
  );
  bot.use(
    session({
      initial: initialSession,
      getSessionKey: (ctx) => ctx.from?.id.toString(),
      prefix: 'tg:sess:',
      storage: new RedisAdapter<BotSession>({ instance: redis, ttl: 30 * 24 * 60 * 60 }),
    }),
  );
  bot.use(i18n.middleware());
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const isStart = /^\/start(?:@\w+)?(?:\s|$)/u.test(ctx.message?.text ?? '');
    if (!ctx.session.userInitialized || isStart) {
      const payload = isStart ? ctx.message?.text?.split(/\s+/u).slice(1).join(' ') : undefined;
      const result = await api.upsertUser({
        telegramId: ctx.from.id,
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        firstName: ctx.from.first_name,
        ...(ctx.from.language_code ? { languageCode: ctx.from.language_code } : {}),
        ...(payload ? { startPayload: payload } : {}),
      });
      ctx.session.lang = result.user.language;
      ctx.session.userInitialized = true;
      await i18n.bind(ctx, result.user.language);
    }
    await next();
  });
  // Before conversations: an open dialog must not swallow `successful_payment`.
  registerStars(bot, api);
  installConversations(bot, redis, api);
  bot.catch(botErrorHandler(api));
  registerScreens(bot, api);
  // Last: only what no command, button or dialog took reaches the operators.
  bot.on('message', supportInbox(api));
  return { bot, api, redis, i18n };
}

export async function registerCommands(bot: Bot<RrContext>, config: BotConfig): Promise<void> {
  for (const locale of config.locales) {
    await bot.api.setMyCommands(config.commands[locale], { language_code: locale });
  }
  const adminCommands = [...config.adminCommands.ru];
  for (const telegramId of config.admins) {
    await bot.api.setMyCommands(adminCommands, {
      scope: { type: 'chat', chat_id: Number(telegramId) },
    });
  }
}
