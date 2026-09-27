import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import type { ApiClient } from './api-client.js';
import { createBot } from './bot.js';

/** The Valkey commands the rate limiter, the session and the dialogs use. */
function memoryRedis() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    set: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve('OK');
    },
    del: (key: string) => Promise.resolve(values.delete(key) ? 1 : 0),
    incr: (key: string) => {
      const next = Number(values.get(key) ?? '0') + 1;
      values.set(key, String(next));
      return Promise.resolve(next);
    },
    pexpire: () => Promise.resolve(1),
  };
}

/** Every API call is recorded; the configuration names no operators' chat. */
function recordingApi() {
  const calls: string[] = [];
  const api = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push(method);
          if (method === 'getConfig')
            return Promise.resolve({ supportForwardChatId: null, supportBot: null });
          if (method === 'upsertUser')
            return Promise.resolve({ user: { language: 'ru' }, created: false, args });
          return Promise.resolve({});
        },
    },
  );
  return { api: api as ApiClient, calls };
}

function groupUpdate(chatType: 'group' | 'supergroup' | 'channel', text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      chat: { id: -1001, type: chatType, title: 'Some group' },
      from: { id: 42, is_bot: false, first_name: 'Ann', username: 'ann' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }]
        : [],
    },
  } as Update;
}

function callbackInGroup(): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'q1',
      chat_instance: 'c',
      data: 'account',
      from: { id: 42, is_bot: false, first_name: 'Ann' },
      message: {
        message_id: 11,
        date: 1_800_000_000,
        chat: { id: -1001, type: 'supergroup', title: 'Some group' },
      },
    },
  };
}

describe('the shop bot outside private chats (R101)', () => {
  it.each([
    ['/sub in a supergroup', groupUpdate('supergroup', '/sub@shop_bot')],
    ['/start in a group', groupUpdate('group', '/start')],
    ['a button pressed under a message in a group', callbackInGroup()],
  ])('ignores %s: no user, no answer', async (_name, update) => {
    const { api, calls } = recordingApi();
    const { bot } = createBot({ token: '1:test', api, redis: memoryRedis() as never });
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Shop',
      username: 'shop_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never;
    const telegram: string[] = [];
    bot.api.config.use((_prev, method) => {
      telegram.push(method);
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate(update);

    // The operators' chat check reads the configuration; nothing else runs.
    expect(calls.filter((method) => method !== 'getConfig')).toEqual([]);
    expect(telegram.filter((method) => method !== 'answerCallbackQuery')).toEqual([]);
  });

  it('still serves a private chat', async () => {
    const { api, calls } = recordingApi();
    const { bot } = createBot({ token: '1:test', api, redis: memoryRedis() as never });
    bot.botInfo = { id: 1, is_bot: true, first_name: 'Shop', username: 'shop_bot' } as never;
    bot.api.config.use(() => Promise.resolve({ ok: true, result: true } as never));
    const update = groupUpdate('supergroup', '/start');
    Object.assign((update.message as { chat: object }).chat, { id: 42, type: 'private' });

    // The recorded API answers no screen with real data; only the upsert matters.
    await bot.handleUpdate(update).catch(() => undefined);

    expect(calls).toContain('upsertUser');
  });
});
