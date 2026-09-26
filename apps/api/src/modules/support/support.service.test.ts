import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardData } from './card-data';
import { parseCommand, SupportService } from './support.service';
import type { MessageInput, Ticket } from './tickets.repository';

vi.mock('./card-data', () => ({
  loadCardData: (_db: unknown, ticket: Ticket): Promise<CardData> =>
    Promise.resolve({
      ticket: {
        number: ticket.number,
        status: ticket.status,
        assigneeName: ticket.assigneeName,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
        closedSilently: ticket.closedSilently,
        rating: ticket.rating,
      },
      user: {
        id: 'u1',
        telegramId: '42',
        firstName: 'Anna',
        username: 'anna',
        language: 'en',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        lastSeenAt: null,
        isBanned: false,
        botBlocked: false,
        trialUsed: false,
        notes: null,
        referrer: null,
      },
      subscription: null,
      money: {
        balanceMinor: 0n,
        lastPurchase: null,
        receivedMinor: 0n,
        payments: 0,
        pendingInvoices: 0,
      },
      support: { tickets: 1, previous: null },
    }),
}));

type Call = { method: string; token: string; body: Record<string, unknown> };

/** An in-memory `TicketsRepository` with the live-ticket rule of the partial index. */
function memoryTickets() {
  const tickets: Ticket[] = [];
  const messages: MessageInput[] = [];
  const topics = new Map<string, number>();
  const find = (id: string) => tickets.find((ticket) => ticket.id === id) ?? null;
  const repo = {
    live: (userId: string) =>
      Promise.resolve(
        tickets.find((ticket) => ticket.userId === userId && ticket.status !== 'closed') ?? null,
      ),
    byId: (id: string) => Promise.resolve(find(id)),
    async openOrLive(userId: string, channel: Ticket['channel'], openedBy: string) {
      const live = await repo.live(userId);
      if (live) return { ticket: live, created: false };
      const ticket = {
        id: `00000000-0000-4000-8000-${String(tickets.length + 1).padStart(12, '0')}`,
        number: BigInt(tickets.length + 1),
        userId,
        channel,
        status: 'open',
        openedBy,
        assigneeTelegramId: null,
        assigneeName: null,
        takenAt: null,
        firstResponseAt: null,
        lastCustomerAt: null,
        lastOperatorAt: null,
        remindedAt: null,
        closedAt: null,
        closedBy: null,
        closedSilently: false,
        rating: null,
        ratedAt: null,
        chatId: null,
        threadId: null,
        cardMessageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Ticket;
      tickets.push(ticket);
      return { ticket: { ...ticket }, created: true };
    },
    update: (id: string, data: Partial<Ticket>) => {
      const ticket = find(id);
      if (!ticket) throw new Error('no ticket');
      Object.assign(ticket, data);
      return Promise.resolve({ ...ticket });
    },
    closeIfLive: (id: string, closedBy: Ticket['closedBy'], closedSilently: boolean) => {
      const ticket = find(id);
      if (!ticket || ticket.status === 'closed') return Promise.resolve(null);
      Object.assign(ticket, { status: 'closed', closedAt: new Date(), closedBy, closedSilently });
      return Promise.resolve({ ...ticket });
    },
    addMessage: (input: MessageInput) => {
      messages.push(input);
      return Promise.resolve();
    },
    byOperatorMessage: (chatId: number, messageId: number) => {
      const message = messages.find(
        (item) => item.operatorChatId === chatId && item.operatorMessageId === messageId,
      );
      return Promise.resolve(message ? find(message.ticketId) : null);
    },
    topic: (chatId: number, userId: string) =>
      Promise.resolve(topics.get(`${String(chatId)}:${userId}`) ?? null),
    setTopic: (chatId: number, userId: string, threadId: number) => {
      topics.set(`${String(chatId)}:${userId}`, threadId);
      return Promise.resolve();
    },
    dropTopic: (chatId: number, userId: string) => {
      topics.delete(`${String(chatId)}:${userId}`);
      return Promise.resolve();
    },
    userByTopic: (chatId: number, threadId: number) => {
      for (const [key, value] of topics)
        if (value === threadId && key.startsWith(`${String(chatId)}:`))
          return Promise.resolve(key.split(':')[1] ?? null);
      return Promise.resolve(null);
    },
  };
  return { repo, tickets, messages, topics };
}

const catalog: Record<string, string> = {
  'bot.support.op.opened': 'Opened #{number} {name} {username}',
  'bot.support.op.denied': 'Denied',
  'bot.support.op.alreadyClosed': 'Already closed #{number}',
  'bot.support.op.taken': 'Yours #{number}',
  'bot.support.op.closed': 'Closed #{number}',
  'bot.support.op.closedBy': 'Closed #{number} by {name}',
  'bot.support.op.closedSilentlyBy': 'Silently closed #{number} by {name}',
  'bot.support.op.customerClosed': 'Customer closed #{number}',
  'bot.support.op.noLiveTicket': 'No live ticket',
  'bot.support.op.unknownCommand': 'Unknown command',
  'bot.support.ticket.taken': 'An operator took #{number}',
  'bot.support.ticket.closed': 'Request #{number} closed',
  'bot.screen.support.reply': 'Support: {text}',
  'bot.screen.support.undelivered': 'Undelivered: {reason}',
  'bot.btn.supportEnd': 'End',
};

function harness(
  options: {
    chatId?: number | null;
    forum?: boolean;
    createTopic?: { ok: boolean; description?: string };
    supportToken?: string;
    failCopy?: { description: string; times?: number };
    failSend?: string;
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
    'brand.name': 'Manta',
    'bot.token': '123:token',
    'bot.support_token': options.supportToken ?? '',
    'bot.support_username': options.supportToken ? 'manta_help_bot' : '',
    'locale.default': 'en',
    'locale.timezone': 'UTC',
    'domain.main': 'shop.example.test',
  };
  const calls: Call[] = [];
  let messageId = 10;
  let threadId = 70;
  let copyFailures = options.failCopy?.times ?? (options.failCopy ? 1 : 0);
  vi.stubEnv('RR_TELEGRAM_API_URL', 'http://telegram.test');
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    const method = url.split('/').pop() ?? '';
    const token = decodeURIComponent(url.split('/bot')[1]?.split('/')[0] ?? '');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, token, body });
    const refuse = (description: string) =>
      Promise.resolve(Response.json({ ok: false, error_code: 400, description }));
    if (method === 'getChat')
      return Promise.resolve(
        Response.json({ ok: true, result: { id: body['chat_id'], is_forum: options.forum } }),
      );
    if (method === 'createForumTopic')
      return options.createTopic && !options.createTopic.ok
        ? refuse(options.createTopic.description ?? 'refused')
        : Promise.resolve(Response.json({ ok: true, result: { message_thread_id: ++threadId } }));
    if (method === 'copyMessage' && body['chat_id'] === -100500 && copyFailures > 0) {
      copyFailures -= 1;
      return refuse(options.failCopy?.description ?? 'refused');
    }
    if (options.failSend && body['chat_id'] === 42) return refuse(options.failSend);
    if (method === 'editMessageText' || method === 'editForumTopic')
      return Promise.resolve(Response.json({ ok: true, result: true }));
    return Promise.resolve(Response.json({ ok: true, result: { message_id: ++messageId } }));
  });
  const notify = { alert: vi.fn().mockResolvedValue({ delivered: 1, deduplicated: false }) };
  const customer = {
    id: 'u1',
    telegramId: 42n,
    firstName: 'Anna',
    username: 'anna',
    language: 'en',
  };
  const db = {
    user: {
      findUnique: vi.fn(({ where }: { where: { id?: string; telegramId?: bigint } }) =>
        Promise.resolve(where.id === 'u1' || where.telegramId === 42n ? customer : null),
      ),
    },
    supportTicket: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const memory = memoryTickets();
  const service = new SupportService(
    { db, redis } as never,
    { get: (key: string) => Promise.resolve(settings[key]) } as never,
    memory.repo as never,
    { messages: () => Promise.resolve(catalog) } as never,
    notify as never,
  );
  const operator = (message: Record<string, unknown>) =>
    service.operatorMessage({
      chatId: -100500,
      messageId: 900,
      from: { id: 7, name: 'Olga' },
      via: options.supportToken ? 'support' : 'shop',
      message: { kind: 'text', text: 'We are on it' },
      ...message,
    });
  const press = (action: string, ticketId: string, chatId = -100500) =>
    service.callback({
      chatId,
      from: { id: 7, name: 'Olga' },
      data: `st:${action}:${ticketId}`,
      via: options.supportToken ? 'support' : 'shop',
    });
  return { service, calls, store, notify, memory, operator, press };
}

const methods = (calls: Call[]) => calls.map((call) => call.method);

describe('SupportService tickets (FR-124, F36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses when no operators chat is configured, instead of pretending to deliver', async () => {
    const { service, calls } = harness({ chatId: null });
    await expect(service.forward('42', 5, { via: 'shop' })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_UNAVAILABLE' } },
    });
    await expect(service.open('42')).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_UNAVAILABLE' } },
    });
    expect(calls).toEqual([]);
  });

  it('opens a numbered ticket in the customer’s own topic with the card, then only copies', async () => {
    const { service, calls, memory } = harness({ forum: true });

    await expect(
      service.forward('42', 5, { message: { kind: 'photo', text: 'Look', fileId: 'f1' } }),
    ).resolves.toEqual({ ticket: expect.objectContaining({ number: 1, created: true }) as object });
    expect(methods(calls)).toEqual([
      'getChat',
      'createForumTopic',
      'sendMessage',
      'sendMessage',
      'copyMessage',
    ]);
    expect(calls[1]?.body).toMatchObject({ chat_id: -100500, name: '🟢 Anna · 42' });
    expect(calls[2]?.body).toMatchObject({ message_thread_id: 71, text: 'Opened #1 Anna @anna' });
    expect(calls[3]?.body).toMatchObject({
      message_thread_id: 71,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ callback_data: `st:take:${memory.tickets[0]?.id ?? ''}` }],
          [
            { callback_data: `st:close:${memory.tickets[0]?.id ?? ''}` },
            { callback_data: `st:silent:${memory.tickets[0]?.id ?? ''}` },
          ],
          [
            { callback_data: `st:card:${memory.tickets[0]?.id ?? ''}` },
            { url: 'https://shop.example.test/admin/users/u1' },
          ],
        ],
      },
    });
    expect(calls[4]?.body).toMatchObject({
      chat_id: -100500,
      message_thread_id: 71,
      from_chat_id: 42,
      message_id: 5,
    });
    expect(memory.messages.at(-1)).toMatchObject({
      direction: 'customer',
      kind: 'photo',
      text: 'Look',
      fileId: 'f1',
      customerMessageId: 5,
      operatorMessageId: 13,
    });

    calls.length = 0;
    await expect(service.forward('42', 6)).resolves.toEqual({
      ticket: expect.objectContaining({ number: 1, created: false }) as object,
    });
    expect(methods(calls)).toEqual(['copyMessage']);
  });

  it('keeps tickets under their card in a plain group and routes a reply back as the answer', async () => {
    const { service, calls, memory, operator } = harness();

    await service.forward('42', 5);
    expect(methods(calls)).toEqual(['getChat', 'sendMessage', 'sendMessage', 'copyMessage']);
    expect(calls[3]?.body).toMatchObject({
      reply_parameters: { message_id: 12, allow_sending_without_reply: true },
    });

    calls.length = 0;
    await expect(operator({ replyToMessageId: 13 })).resolves.toEqual({ handled: true });
    // The shop bot puts text under «Ответ поддержки» with «Завершить».
    expect(calls[0]).toMatchObject({
      method: 'sendMessage',
      body: {
        chat_id: 42,
        text: 'Support: We are on it',
        reply_markup: { inline_keyboard: [[{ callback_data: 'support:end' }]] },
      },
    });
    // The first answer takes the ticket for its author and updates the card.
    expect(memory.tickets[0]).toMatchObject({
      status: 'in_progress',
      assigneeName: 'Olga',
      assigneeTelegramId: 7n,
    });
    expect(memory.tickets[0]?.firstResponseAt).toBeInstanceOf(Date);
    expect(methods(calls)).toContain('editMessageText');
    expect(memory.messages.at(-1)).toMatchObject({
      direction: 'operator',
      authorName: 'Olga',
      operatorMessageId: 900,
    });

    // A message that answers nothing of support's is left alone.
    await expect(operator({ replyToMessageId: 999 })).resolves.toEqual({ handled: false });
    await expect(operator({ chatId: -1, replyToMessageId: 13 })).resolves.toEqual({
      handled: false,
    });
  });

  it('copies an operator’s message as it is from the support bot (F35)', async () => {
    const { service, calls, operator } = harness({ supportToken: '777:support', forum: true });
    await service.forward('42', 5, { via: 'support' });
    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'voice', fileId: 'v1' } });
    expect(calls[0]).toMatchObject({
      method: 'copyMessage',
      token: '777:support',
      body: { chat_id: 42, from_chat_id: -100500, message_id: 900 },
    });
  });

  it('moves a ticket whose topic an operator deleted into a new topic, once', async () => {
    const { service, calls, memory } = harness({
      forum: true,
      failCopy: { description: 'Bad Request: message thread not found' },
    });
    await service.forward('42', 5);
    expect(methods(calls)).toEqual([
      'getChat',
      'createForumTopic',
      'sendMessage',
      'sendMessage',
      'copyMessage',
      'createForumTopic',
      'sendMessage',
      'sendMessage',
      'copyMessage',
    ]);
    expect(calls.at(-1)?.body).toMatchObject({ message_thread_id: 72 });
    expect(memory.topics.get('-100500:u1')).toBe(72);
  });

  it('falls back to the general topic and tells the administrators when topics cannot be made', async () => {
    const { service, calls, notify } = harness({
      forum: true,
      createTopic: { ok: false, description: 'Bad Request: not enough rights to create a topic' },
    });
    await service.forward('42', 5);
    expect(methods(calls)).toEqual([
      'getChat',
      'createForumTopic',
      'sendMessage',
      'sendMessage',
      'copyMessage',
    ]);
    expect(calls[4]?.body).not.toHaveProperty('message_thread_id');
    expect(notify.alert).toHaveBeenCalledWith({
      type: 'support.topics',
      details: 'Bad Request: not enough rights to create a topic',
    });
  });

  it('opens a ticket when an operator writes to a customer who has none', async () => {
    const { service, memory, operator, calls } = harness({ forum: true });
    await service.forward('42', 5);
    const [first] = memory.tickets;
    await memory.repo.closeIfLive(first?.id ?? '', 'operator', true);
    calls.length = 0;

    await operator({ threadId: 71 });

    expect(memory.tickets).toHaveLength(2);
    expect(memory.tickets[1]).toMatchObject({ openedBy: 'operator', threadId: 71 });
    expect(methods(calls).slice(0, 3)).toEqual(['editForumTopic', 'sendMessage', 'sendMessage']);
    expect(calls[3]).toMatchObject({ method: 'sendMessage', body: { chat_id: 42 } });
  });

  it('takes, closes and silently closes from the card, telling the customer only when meant', async () => {
    const { service, calls, memory, press } = harness({ forum: true });
    await service.forward('42', 5);
    const id = memory.tickets[0]?.id ?? '';
    calls.length = 0;

    await expect(press('take', id)).resolves.toEqual({ text: 'Yours #1' });
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'sendMessage',
        body: expect.objectContaining({ chat_id: 42, text: 'An operator took #1' }) as object,
      }),
      expect.objectContaining({ method: 'editMessageText' }),
      expect.objectContaining({
        method: 'editForumTopic',
        body: expect.objectContaining({ name: '🟡 Anna · 42' }) as object,
      }),
    ]);

    calls.length = 0;
    await expect(press('close', id)).resolves.toEqual({ text: 'Closed #1' });
    expect(calls.map((call) => [call.method, call.body['chat_id'], call.body['text']])).toEqual([
      ['sendMessage', 42, 'Request #1 closed'],
      ['sendMessage', -100500, 'Closed #1 by Olga'],
      ['editMessageText', -100500, expect.any(String)],
      ['editForumTopic', -100500, undefined],
    ]);
    expect(calls[3]?.body).toMatchObject({ name: '⚪ Anna · 42' });
    await expect(press('close', id)).resolves.toEqual({ text: 'Already closed #1' });
    await expect(press('take', id)).resolves.toEqual({ text: 'Already closed #1' });

    // A silent close tells the customer nothing.
    await service.forward('42', 6);
    const second = memory.tickets[1]?.id ?? '';
    calls.length = 0;
    await press('silent', second);
    expect(calls.some((call) => call.body['chat_id'] === 42)).toBe(false);
    expect(memory.tickets[1]).toMatchObject({ closedSilently: true, closedBy: 'operator' });
  });

  it('refuses buttons pressed outside the operators’ chat', async () => {
    const { service, memory, press, calls } = harness();
    await service.forward('42', 5);
    calls.length = 0;
    await expect(press('close', memory.tickets[0]?.id ?? '', -1)).resolves.toEqual({
      text: 'Denied',
      alert: true,
    });
    expect(memory.tickets[0]?.status).toBe('open');
    expect(calls).toEqual([]);
  });

  it('closes with /close and /silent in the topic, and names the unknown commands', async () => {
    const { service, memory, operator, calls } = harness({ forum: true });
    await service.forward('42', 5);
    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/silent@manta_bot' } });
    expect(memory.tickets[0]).toMatchObject({ status: 'closed', closedSilently: true });
    expect(calls.some((call) => call.body['chat_id'] === 42)).toBe(false);

    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/close' } });
    expect(calls[0]?.body).toMatchObject({ text: 'No live ticket', message_thread_id: 71 });
    await operator({ threadId: 71, message: { kind: 'text', text: '/nope' } });
    expect(calls.at(-1)?.body).toMatchObject({ text: 'Unknown command' });
  });

  it('lets the customer close their ticket and tells the operators', async () => {
    const { service, memory, calls } = harness({ forum: true });
    await service.forward('42', 5);
    calls.length = 0;
    await expect(service.customerClose('42', 'shop')).resolves.toEqual({ number: 1 });
    expect(memory.tickets[0]).toMatchObject({ status: 'closed', closedBy: 'customer' });
    expect(calls[0]?.body).toMatchObject({ chat_id: -100500, text: 'Customer closed #1' });
    await expect(service.customerClose('42', 'shop')).resolves.toBeNull();
  });

  it('says when an answer did not reach the customer', async () => {
    const { service, operator, calls, memory } = harness({
      forum: true,
      failSend: 'Forbidden: bot was blocked by the user',
    });
    await service.forward('42', 5);
    calls.length = 0;
    await operator({ threadId: 71 });
    expect(calls.at(-1)?.body).toMatchObject({
      chat_id: -100500,
      text: 'Undelivered: Forbidden: bot was blocked by the user',
      reply_parameters: { message_id: 900 },
    });
    expect(memory.messages.some((message) => message.direction === 'operator')).toBe(false);
  });

  it('keeps the shop bot’s «Написать оператору» state until the customer closes (F35)', async () => {
    const { service } = harness();
    await expect(service.forward('42', 5, { requireOpen: true })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_CLOSED' } },
    });
    await service.open('42');
    await expect(service.forward('42', 5, { requireOpen: true })).resolves.toBeDefined();
    await service.close('42');
    await expect(service.forward('42', 7, { requireOpen: true })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_CLOSED' } },
    });
  });

  it('runs through the support bot when one is configured, and nowhere else (F35)', async () => {
    const { service, calls } = harness({ supportToken: '777:support' });
    for (const attempt of [service.open('42'), service.forward('42', 5)])
      await expect(attempt).rejects.toMatchObject({
        response: { error: { code: 'SUPPORT_MOVED', details: { username: 'manta_help_bot' } } },
      });
    expect(calls).toEqual([]);
    await service.forward('42', 5, { via: 'support' });
    expect(new Set(calls.map((call) => call.token))).toEqual(new Set(['777:support']));
  });

  it('refuses the support bot’s messages once it is turned off', async () => {
    const { service } = harness();
    await expect(service.forward('42', 5, { via: 'support' })).rejects.toMatchObject({
      response: { error: { code: 'SUPPORT_MOVED', details: { username: null } } },
    });
  });
});

describe('parseCommand', () => {
  it('reads a command with or without the bot’s name and its arguments', () => {
    expect(parseCommand('/close')).toEqual({ name: 'close', args: '' });
    expect(parseCommand('/t@manta_bot  link ')).toEqual({ name: 't', args: 'link' });
    expect(parseCommand('hello /close')).toBeNull();
  });
});
