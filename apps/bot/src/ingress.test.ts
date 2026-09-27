import { Bot, BotError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, type ApiClient } from './api-client.js';
import { BotIngress, supportChannel } from './ingress.js';
import { registerStars } from './screens/stars.js';
import type { RrContext } from './types.js';

const botInfo = {
  id: 1,
  is_bot: true as const,
  first_name: 'Shop',
  username: 'shop_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

const update = {
  update_id: 5,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private' as const, first_name: 'Ann' },
    from: { id: 42, is_bot: false, first_name: 'Ann' },
    text: 'Профиль',
  },
};

const payment = {
  update_id: 6,
  message: {
    message_id: 2,
    date: 0,
    chat: { id: 42, type: 'private' as const, first_name: 'Ann' },
    from: { id: 42, is_bot: false, first_name: 'Ann' },
    successful_payment: {
      currency: 'XTR',
      total_amount: 399,
      invoice_payload: 'inv_0199c7a0-0000-7000-8000-000000000001',
      telegram_payment_charge_id: 'charge-1',
      provider_payment_charge_id: '',
    },
  },
};

type Processing = {
  processMessage(id: string, fields: string[], deliveries?: number): Promise<void>;
};

function harness(delivered: object = update) {
  const bot = new Bot<RrContext>('123:token', { botInfo: botInfo as never });
  const redis = {
    duplicate: () => ({ disconnect: vi.fn() }),
    xack: vi.fn().mockResolvedValue(1),
  };
  const ingress = new BotIngress(bot, redis as never, 'test-consumer');
  const deliver = (deliveries?: number) =>
    (ingress as unknown as Processing).processMessage(
      '1-0',
      ['payload', JSON.stringify(delivered)],
      deliveries,
    );
  return { bot, redis, deliver };
}

describe('BotIngress failed updates (FR-127)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hands a handler error to bot.catch and acknowledges the update', async () => {
    const { bot, redis, deliver } = harness();
    bot.use(() => {
      throw new Error('boom');
    });
    const handled: BotError[] = [];
    bot.catch((error) => {
      handled.push(error);
    });

    await deliver();

    expect(handled).toHaveLength(1);
    expect(handled[0]).toBeInstanceOf(BotError);
    expect(handled[0]?.ctx.update.update_id).toBe(5);
    // Answered and logged: redelivering it every 60 s would repeat the
    // handler's side effects and the error reply.
    expect(redis.xack).toHaveBeenCalledWith('tg:updates', 'bot', '1-0');
  });

  it('logs an error handler that fails itself, without the update, and acknowledges', async () => {
    const { bot, redis, deliver } = harness();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bot.use(() => {
      throw new Error('boom');
    });
    bot.catch(() => {
      throw new Error('handler down');
    });

    await deliver();

    expect(log).toHaveBeenCalledWith('Telegram error handler failed', {
      updateId: 5,
      error: 'Error',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Профиль');
    expect(redis.xack).toHaveBeenCalledWith('tg:updates', 'bot', '1-0');
  });
});

describe('BotIngress Stars payment updates (R1)', () => {
  afterEach(() => vi.restoreAllMocks());

  function paying(recorded: () => Promise<unknown>) {
    const context = harness(payment);
    const api = { starsSuccessfulPayment: vi.fn(recorded) };
    registerStars(context.bot, api as unknown as ApiClient);
    const handled: BotError[] = [];
    context.bot.catch((error) => {
      handled.push(error);
    });
    return { ...context, api, handled };
  }

  it('keeps a successful_payment the shop failed to record pending', async () => {
    // The stars are taken and Telegram never sends the update again: the
    // stream entry is the only copy of the payment.
    const { redis, api, deliver } = paying(() => Promise.reject(new ApiClientError(503)));

    await deliver();

    expect(api.starsSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('keeps it pending when a middleware before the payment handler fails', async () => {
    const context = harness(payment);
    context.bot.use(() => {
      throw new ApiClientError(502);
    });
    const api = { starsSuccessfulPayment: vi.fn() };
    registerStars(context.bot, api as unknown as ApiClient);
    context.bot.catch(() => undefined);

    await context.deliver();

    expect(api.starsSuccessfulPayment).not.toHaveBeenCalled();
    expect(context.redis.xack).not.toHaveBeenCalled();
  });

  it('acknowledges a payment once the shop has recorded it', async () => {
    const { redis, deliver } = paying(() => Promise.resolve({ ok: true }));

    await deliver();

    expect(redis.xack).toHaveBeenCalledWith('tg:updates', 'bot', '1-0');
  });

  it('answers the customer on the first delivery only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handled, deliver } = paying(() => Promise.reject(new ApiClientError(503)));

    await deliver(1);
    await deliver(2);
    await deliver(3);

    // The error handler answers; a redelivery is logged without a reply.
    expect(handled).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('Telegram payment update kept pending', {
      updateId: 6,
      deliveries: 3,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('charge-1');
  });
});

describe('BotIngress for the support bot (F35)', () => {
  it('keeps its updates in a stream of its own and asks Telegram for its own updates', async () => {
    const bot = new Bot<RrContext>('777:token', { botInfo: botInfo as never });
    const telegram: Array<{ method: string; payload: unknown }> = [];
    bot.api.config.use((_prev, method, payload) => {
      telegram.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });
    const redis = {
      duplicate: () => ({ disconnect: vi.fn(), xreadgroup: () => new Promise(() => undefined) }),
      xgroup: vi.fn().mockResolvedValue('OK'),
      xautoclaim: () => new Promise(() => undefined),
      xack: vi.fn().mockResolvedValue(1),
      eval: vi.fn().mockResolvedValue(1),
    };
    const ingress = new BotIngress(bot, redis as never, 'support-test', supportChannel('777'));

    await ingress.start({
      mode: 'webhook',
      webhookUrl: 'https://shop.example.test/tg/webhook/support-path',
      secretToken: 'support-header',
    });
    await ingress.append({ update_id: 9 });
    await (
      ingress as unknown as { processMessage(id: string, fields: string[]): Promise<void> }
    ).processMessage('1-0', ['payload', JSON.stringify({ update_id: 9 })]);

    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      'tg:support-updates:777',
      'support-bot',
      '0-0',
      'MKSTREAM',
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'tg:support-updates:777',
      'tg:support-received:777:9',
      JSON.stringify({ update_id: 9 }),
    );
    expect(redis.xack).toHaveBeenCalledWith('tg:support-updates:777', 'support-bot', '1-0');
    expect(telegram).toContainEqual({
      method: 'setWebhook',
      payload: expect.objectContaining({
        url: 'https://shop.example.test/tg/webhook/support-path',
        secret_token: 'support-header',
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      }) as object,
    });
  });
});
