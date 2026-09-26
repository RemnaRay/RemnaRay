import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api-client.js';
import { createSupportBot } from './support-bot.js';

const catalogs: Record<string, Record<string, string>> = {
  ru: {
    'bot.support.start': 'Поддержка {brand}',
    'bot.support.sent': 'Передали',
    'bot.support.unsupported': 'Нельзя',
    'bot.support.off': 'В основном боте',
    'bot.error.support_unavailable': 'Не удалось',
  },
  en: { 'bot.support.start': '{brand} support', 'bot.support.sent': 'Sent' },
};

function harness(forward = vi.fn().mockResolvedValue({ acknowledge: true })) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = {
    getConfig: () =>
      Promise.resolve({
        defaultLocale: 'ru',
        brandName: 'Manta',
        supportForwardChatId: -100500,
        supportBot: { username: 'manta_help_bot' },
      }),
    forwardSupport: forward,
    routeSupport: vi.fn().mockResolvedValue({ target: { telegramId: '42', language: 'en' } }),
  };
  const { bot } = createSupportBot({
    token: '777:help-token',
    api: api as never,
    i18n: { catalog: (locale) => Promise.resolve(catalogs[locale] ?? {}) },
    botInfo: {
      id: 777,
      is_bot: true,
      first_name: 'Manta help',
      username: 'manta_help_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never,
  });
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload });
    return Promise.resolve({ ok: true, result: { message_id: 1 } } as never);
  });
  let updateId = 0;
  const send = (message: Record<string, unknown>, chat = { id: 42, type: 'private' }) =>
    bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 5,
        date: 0,
        chat,
        from: { id: chat.id === 42 ? 42 : 7, is_bot: false, first_name: 'A', language_code: 'ru' },
        ...message,
      },
    } as never);
  return { calls, api, send };
}

describe('the support bot (owner decision F35)', () => {
  it('greets a customer in their language with the shop’s name', async () => {
    const { calls, send } = harness();
    await send({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: expect.objectContaining({ chat_id: 42, text: 'Поддержка Manta' }) as object,
      },
    ]);
  });

  it('hands the operators every photo, file, voice or text, confirming the first', async () => {
    const forward = vi
      .fn()
      .mockResolvedValueOnce({ acknowledge: true })
      .mockResolvedValue({ acknowledge: false });
    const { calls, send } = harness(forward);
    await send({ photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }] });
    await send({ voice: { file_id: 'v1', file_unique_id: 'u2', duration: 2 } });
    await send({ text: 'It does not connect' });
    expect(forward).toHaveBeenCalledTimes(3);
    expect(forward).toHaveBeenCalledWith(42, 5, { via: 'support' });
    expect(calls.map((call) => call.payload['text'])).toEqual(['Передали']);
  });

  it('says what it cannot pass on, and when support moved back to the shop bot', async () => {
    const { calls, send } = harness(
      vi.fn().mockRejectedValue(new ApiClientError(409, 'SUPPORT_MOVED', {})),
    );
    await send({ location: { latitude: 1, longitude: 2 } });
    await send({ text: 'Hello' });
    expect(calls.map((call) => call.payload['text'])).toEqual(['Нельзя', 'В основном боте']);
  });

  it('copies an operator’s answer in the customer’s topic back as it is', async () => {
    const { calls, api, send } = harness();
    await send(
      { text: 'We are on it', is_topic_message: true, message_thread_id: 71 },
      { id: -100500, type: 'supergroup' },
    );
    expect(api.routeSupport).toHaveBeenCalledWith({ chatId: -100500, threadId: 71 });
    expect(calls).toEqual([
      {
        method: 'copyMessage',
        payload: expect.objectContaining({
          chat_id: 42,
          from_chat_id: -100500,
          message_id: 5,
        }) as object,
      },
    ]);
  });
});
