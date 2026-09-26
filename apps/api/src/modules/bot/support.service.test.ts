import { afterEach, describe, expect, it, vi } from 'vitest';

import { SupportService } from './support.service';

type Call = { method: string; token: string; body: Record<string, unknown> };

function harness(
  options: {
    chatId?: number | null;
    forum?: boolean;
    createTopic?: { ok: boolean; description?: string };
    supportToken?: string;
  } = {},
) {
  const store = new Map<string, string>();
  const redis = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    del: (key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    },
  };
  const settings: Record<string, unknown> = {
    'brand.support_forward_chat_id': options.chatId === undefined ? -100500 : options.chatId,
    'bot.token': '123:token',
    'bot.support_token': options.supportToken ?? '',
    'bot.support_username': options.supportToken ? 'manta_help_bot' : '',
  };
  const calls: Call[] = [];
  let messageId = 10;
  let threadId = 70;
  vi.stubEnv('RR_TELEGRAM_API_URL', 'http://telegram.test');
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    const method = url.split('/').pop() ?? '';
    const token = decodeURIComponent(url.split('/bot')[1]?.split('/')[0] ?? '');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, token, body });
    const answer =
      method === 'getChat'
        ? { ok: true, result: { id: body['chat_id'], is_forum: options.forum === true } }
        : method === 'createForumTopic'
          ? options.createTopic && !options.createTopic.ok
            ? { ok: false, error_code: 400, description: options.createTopic.description }
            : { ok: true, result: { message_thread_id: ++threadId, name: body['name'] } }
          : { ok: true, result: { message_id: ++messageId } };
    return Promise.resolve(Response.json(answer));
  });
  const notify = { alert: vi.fn().mockResolvedValue({ delivered: 1, deduplicated: false }) };
  const db = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ firstName: 'Anna', username: 'anna', language: 'en' }),
    },
  };
  const service = new SupportService(
    { db, redis } as never,
    { get: (key: string) => Promise.resolve(settings[key]) } as never,
    notify as never,
  );
  return { service, calls, store, notify };
}

describe('SupportService (FR-124)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses when no operators chat is configured, instead of pretending to deliver', async () => {
    const { service, calls } = harness({ chatId: null });
    await expect(service.forward('42', 5)).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_UNAVAILABLE' } },
    });
    await expect(service.open('42')).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_UNAVAILABLE' } },
    });
    expect(calls).toEqual([]);
  });

  it('copies to a plain group under a card naming the customer, and routes a reply back', async () => {
    const { service, calls } = harness();

    await service.forward('42', 5);

    expect(calls.map((call) => call.method)).toEqual(['getChat', 'sendMessage', 'copyMessage']);
    expect(calls[1]?.body).toMatchObject({
      chat_id: -100500,
      text: '#support 42 @anna\nAnna · en',
    });
    // F35: the customer's own message, photo, file or voice, copied as it is.
    expect(calls[2]?.body).toMatchObject({
      chat_id: -100500,
      from_chat_id: 42,
      message_id: 5,
      reply_parameters: { message_id: 11, allow_sending_without_reply: true },
    });
    for (const replyToMessageId of [11, 12])
      await expect(service.route({ chatId: -100500, replyToMessageId })).resolves.toEqual({
        telegramId: '42',
        language: 'en',
      });
    await expect(service.route({ chatId: -100500, replyToMessageId: 99 })).resolves.toBeNull();
    await expect(service.route({ chatId: -1, replyToMessageId: 11 })).resolves.toBeNull();
  });

  it('gives each customer a topic of their own in a forum and routes the topic back', async () => {
    const { service, calls } = harness({ forum: true });

    await service.forward('42', 5);
    await service.forward('42', 6);

    expect(calls.map((call) => call.method)).toEqual([
      'getChat',
      'createForumTopic',
      'sendMessage',
      'copyMessage',
      'copyMessage',
    ]);
    expect(calls[1]?.body).toMatchObject({ chat_id: -100500, name: 'Anna · 42' });
    expect(calls[2]?.body).toMatchObject({
      message_thread_id: 71,
      text: '#support 42 @anna\nAnna · en',
    });
    expect(calls[4]?.body).toMatchObject({
      chat_id: -100500,
      message_thread_id: 71,
      from_chat_id: 42,
      message_id: 6,
    });
    await expect(service.route({ chatId: -100500, threadId: 71 })).resolves.toEqual({
      telegramId: '42',
      language: 'en',
    });
  });

  it('falls back to the chat and tells the administrators when topics cannot be created', async () => {
    const { service, calls, notify } = harness({
      forum: true,
      createTopic: { ok: false, description: 'Bad Request: not enough rights to create a topic' },
    });

    await service.forward('42', 5);

    expect(calls.map((call) => call.method)).toEqual([
      'getChat',
      'createForumTopic',
      'sendMessage',
      'copyMessage',
    ]);
    expect(calls[3]?.body).not.toHaveProperty('message_thread_id');
    expect(notify.alert).toHaveBeenCalledWith({
      type: 'support.topics',
      details: 'Bad Request: not enough rights to create a topic',
    });
  });

  it('keeps a conversation open from «Поддержка» until «Завершить», and after an answer (F35)', async () => {
    const { service } = harness();

    // Outside a conversation, a message the bot did not ask for stays with it.
    await expect(service.forward('42', 5, { requireOpen: true })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_CLOSED' } },
    });

    await service.open('42');
    await expect(service.forward('42', 5, { requireOpen: true })).resolves.toEqual({
      acknowledge: true,
    });
    // Only the first message after «Поддержка» is confirmed.
    await expect(service.forward('42', 6, { requireOpen: true })).resolves.toEqual({
      acknowledge: false,
    });

    await service.close('42');
    await expect(service.forward('42', 7, { requireOpen: true })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_CLOSED' } },
    });

    // An operator's answer lets the customer reply straight away.
    await expect(service.route({ chatId: -100500, replyToMessageId: 11 })).resolves.not.toBeNull();
    await expect(service.forward('42', 8, { requireOpen: true })).resolves.toEqual({
      acknowledge: false,
    });
  });

  it('runs through the support bot when one is configured, and nowhere else (F35)', async () => {
    const { service, calls } = harness({ supportToken: '777:support' });

    // The shop bot can neither open a conversation nor copy a message now.
    for (const attempt of [service.open('42'), service.forward('42', 5)])
      await expect(attempt).rejects.toMatchObject({
        response: { error: { code: 'SUPPORT_MOVED', details: { username: 'manta_help_bot' } } },
      });
    expect(calls).toEqual([]);

    // In the support bot every message goes, and the first one is confirmed.
    await expect(service.forward('42', 5, { via: 'support' })).resolves.toEqual({
      acknowledge: true,
    });
    await expect(service.forward('42', 6, { via: 'support' })).resolves.toEqual({
      acknowledge: false,
    });
    expect(new Set(calls.map((call) => call.token))).toEqual(new Set(['777:support']));
  });

  it('refuses the support bot’s messages once it is turned off', async () => {
    const { service } = harness();
    await expect(service.forward('42', 5, { via: 'support' })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_MOVED', details: { username: null } } },
    });
  });
});
