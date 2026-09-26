import { Bot, BotError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotIngress, supportChannel } from './ingress.js';
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

function harness() {
  const bot = new Bot<RrContext>('123:token', { botInfo: botInfo as never });
  const redis = {
    duplicate: () => ({ disconnect: vi.fn() }),
    xack: vi.fn().mockResolvedValue(1),
  };
  const ingress = new BotIngress(bot, redis as never, 'test-consumer');
  const deliver = () =>
    (
      ingress as unknown as { processMessage(id: string, fields: string[]): Promise<void> }
    ).processMessage('1-0', ['payload', JSON.stringify(update)]);
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
