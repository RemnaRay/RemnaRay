import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api-client.js';
import { createSupportBot } from './support-bot.js';

const catalogs: Record<string, Record<string, string>> = {
  ru: {
    'bot.support.start': 'Поддержка {brand}',
    'bot.support.ticket.created': 'Обращение #{number}',
    'bot.support.ticket.closedByCustomer': 'Закрыто #{number}',
    'bot.support.rate.ask': 'Оцените',
    'bot.btn.supportClose': 'Закрыть обращение',
    'bot.support.unsupported': 'Нельзя',
    'bot.support.off': 'В основном боте',
    'bot.error.support_unavailable': 'Не удалось',
  },
  en: { 'bot.support.start': '{brand} support' },
};

function harness(
  forward = vi.fn().mockResolvedValue({ ticket: { id: 't1', number: 3, created: true } }),
) {
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
    upsertUser: vi.fn().mockResolvedValue({ user: { language: 'ru' } }),
    closeSupport: vi.fn().mockResolvedValue({ ticket: { id: 't1', number: 3 } }),
    operatorSupport: vi.fn().mockResolvedValue({ handled: true }),
    supportCallback: vi.fn().mockResolvedValue({ text: 'Yours #3' }),
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
  return { calls, api, send, bot };
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

  it('hands the operators every photo, file, voice or text, confirming a new ticket', async () => {
    const forward = vi
      .fn()
      .mockResolvedValueOnce({ ticket: { id: 't1', number: 3, created: true } })
      .mockResolvedValue({ ticket: { id: 't1', number: 3, created: false } });
    const { calls, send, api } = harness(forward);
    await send({ photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }] });
    await send({ voice: { file_id: 'v1', file_unique_id: 'u2', duration: 2 } });
    await send({ text: 'It does not connect' });
    expect(forward).toHaveBeenCalledTimes(3);
    expect(forward).toHaveBeenCalledWith(42, 5, {
      via: 'support',
      message: { kind: 'photo', fileId: 'p1', fileUniqueId: 'u1' },
    });
    expect(calls.map((call) => call.payload['text'])).toEqual(['Обращение #3']);
    expect(calls[0]?.payload['reply_markup']).toEqual({
      inline_keyboard: [[{ text: 'Закрыть обращение', callback_data: 'support:end' }]],
    });
    // Someone who writes here first becomes a shop user, once.
    expect(api.upsertUser).toHaveBeenCalledTimes(1);
    expect(api.upsertUser).toHaveBeenCalledWith({
      telegramId: 42,
      firstName: 'A',
      languageCode: 'ru',
    });
  });

  it('closes the customer’s ticket on «Закрыть обращение»', async () => {
    const { calls, api, bot } = harness();
    await bot.handleUpdate({
      update_id: 99,
      callback_query: {
        id: 'q1',
        chat_instance: 'c',
        data: 'support:end',
        from: { id: 42, is_bot: false, first_name: 'A', language_code: 'ru' },
        message: { message_id: 8, date: 0, chat: { id: 42, type: 'private' } },
      },
    } as never);
    expect(api.closeSupport).toHaveBeenCalledWith(42, 'support');
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(calls[1]?.payload['text']).toBe('Закрыто #3\n\nОцените');
    expect(calls[1]?.payload['reply_markup']).toMatchObject({
      inline_keyboard: [
        [{ callback_data: 'rate:t1:1' }, {}, {}, {}, { callback_data: 'rate:t1:5' }],
      ],
    });
  });

  it('says what it cannot pass on, and when support moved back to the shop bot', async () => {
    const { calls, send } = harness(
      vi.fn().mockRejectedValue(new ApiClientError(409, 'SUPPORT_MOVED', {})),
    );
    await send({ location: { latitude: 1, longitude: 2 } });
    await send({ text: 'Hello' });
    expect(calls.map((call) => call.payload['text'])).toEqual(['Нельзя', 'В основном боте']);
  });

  it('hands an operator’s message and a card’s button to the API (F36)', async () => {
    const { calls, api, bot, send } = harness();
    await send(
      { text: 'We are on it', is_topic_message: true, message_thread_id: 71 },
      { id: -100500, type: 'supergroup' },
    );
    expect(api.operatorSupport).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: -100500, threadId: 71, via: 'support' }),
    );
    await bot.handleUpdate({
      update_id: 100,
      callback_query: {
        id: 'q2',
        chat_instance: 'c',
        data: 'st:take:t1',
        from: { id: 7, is_bot: false, first_name: 'Olga' },
        message: { message_id: 8, date: 0, chat: { id: -100500, type: 'supergroup' } },
      },
    } as never);
    expect(api.supportCallback).toHaveBeenCalledWith({
      chatId: -100500,
      from: { id: 7, name: 'Olga' },
      data: 'st:take:t1',
      via: 'support',
    });
    // Answered once, with the API's text.
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({ text: 'Yours #3' }) as object,
      },
    ]);
  });
});
