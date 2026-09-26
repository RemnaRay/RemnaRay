import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardData } from './card-data';
import { parseAction, parseCommand, SupportService } from './support.service';
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
  'bot.support.op.noTicket': 'No ticket yet',
  'bot.support.op.templates': 'Templates:',
  'bot.support.op.templateLine': '{code} — {title}',
  'bot.support.op.templatesNone': 'No templates',
  'bot.support.op.templateUnknown': 'No template {code}',
  'bot.support.ticket.taken': 'An operator took #{number}',
  'bot.support.ticket.closed': 'Request #{number} closed',
  'bot.support.rate.ask': 'Rate us',
  'bot.support.op.reminder': 'Waiting #{number} {minutes} min {name}',
  'bot.support.op.autoClosed': 'Auto-closed #{number}',
  'bot.support.btn.open': 'Open',
  'bot.support.act.duplicate': 'Already running',
  'bot.support.act.not_admin': 'Admins only',
  'bot.support.act.usage.credit': 'Usage: /credit',
  'bot.support.act.done.extend': '{name} extended until {until}',
  'bot.support.act.done.credit': '{name} credited {amount}',
  'bot.support.act.done.link': '{name} sent the link',
  'bot.support.ticket.link': 'Your link: {url}',
  'bot.support.ticket.autoClosed': 'Request #{number} auto-closed',
  'bot.support.op.rated': '{stars} #{number}: {rating}',
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
    templates?: Array<{ code: string; title: string; body: Record<string, string> }>;
    remindAfter?: number;
    autocloseHours?: number;
  } = {},
) {
  const store = new Map<string, string>();
  const redis = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && store.has(key)) return Promise.resolve(null);
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
    'support.remind_after_minutes': options.remindAfter ?? 15,
    'support.autoclose_hours': options.autocloseHours ?? 48,
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
  const actions = {
    run: vi.fn((action: { kind: string; amountMinor?: bigint }) =>
      Promise.resolve(
        action.kind === 'extend'
          ? { ok: true, kind: 'extend', expiresAt: new Date('2026-10-08T00:00:00Z') }
          : action.kind === 'link'
            ? { ok: true, kind: 'link', url: 'https://sub.example.test/x' }
            : action.kind === 'credit'
              ? { ok: true, kind: 'credit', amountMinor: action.amountMinor }
              : { ok: true, kind: 'reset' },
      ),
    ),
  };
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
    supportTemplate: {
      findMany: vi.fn().mockResolvedValue(options.templates ?? []),
      findUnique: vi.fn(({ where }: { where: { code: string } }) =>
        Promise.resolve((options.templates ?? []).find((item) => item.code === where.code) ?? null),
      ),
    },
  };
  const memory = memoryTickets();
  Object.assign(db, {
    // The sweep's SQL for idle tickets, over the in-memory tickets.
    $queryRaw: vi.fn(() => {
      const cutoff = Date.now() - Number(settings['support.autoclose_hours']) * 3_600_000;
      return Promise.resolve(
        memory.tickets
          .filter(
            (ticket) =>
              ticket.status !== 'closed' &&
              ticket.lastOperatorAt !== null &&
              (ticket.lastCustomerAt === null || ticket.lastCustomerAt < ticket.lastOperatorAt) &&
              ticket.lastOperatorAt.getTime() < cutoff,
          )
          .map((ticket) => ({ id: ticket.id })),
      );
    }),
  });
  db.supportTicket = Object.assign(db.supportTicket, {
    findMany: vi.fn(({ where }: { where: { createdAt: { lt: Date } } }) =>
      Promise.resolve(
        memory.tickets.filter(
          (ticket) =>
            ticket.status === 'open' &&
            ticket.takenAt === null &&
            ticket.remindedAt === null &&
            ticket.createdAt < where.createdAt.lt,
        ),
      ),
    ),
    updateMany: vi.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Partial<Ticket> }) => {
        const matching = memory.tickets.filter(
          (ticket) =>
            ticket.id === where['id'] &&
            Object.entries(where).every(
              ([key, value]) => key === 'id' || ticket[key as keyof Ticket] === value,
            ),
        );
        for (const ticket of matching) Object.assign(ticket, data);
        return Promise.resolve({ count: matching.length });
      },
    ),
  });
  const service = new SupportService(
    { db, redis } as never,
    { get: (key: string) => Promise.resolve(settings[key]) } as never,
    memory.repo as never,
    { messages: () => Promise.resolve(catalog) } as never,
    actions as never,
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
  return { service, calls, store, notify, memory, operator, press, actions };
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
            { callback_data: `st:ext7:${memory.tickets[0]?.id ?? ''}` },
            { callback_data: `st:ext30:${memory.tickets[0]?.id ?? ''}` },
          ],
          [
            { callback_data: `st:reset:${memory.tickets[0]?.id ?? ''}` },
            { callback_data: `st:link:${memory.tickets[0]?.id ?? ''}` },
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
      ['sendMessage', 42, 'Request #1 closed\n\nRate us'],
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
    await expect(service.customerClose('42', 'shop')).resolves.toEqual({
      id: memory.tickets[0]?.id,
      number: 1,
    });
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

describe('the minute sweep (F36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it('reminds the operators of a ticket nobody took, once, with a link to its topic', async () => {
    const { service, calls, memory } = harness({ forum: true });
    await service.forward('42', 5);
    await memory.repo.update(memory.tickets[0]?.id ?? '', { createdAt: minutesAgo(20) });
    calls.length = 0;

    await expect(service.sweep()).resolves.toEqual({ reminded: 1, closed: 0 });
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        token: '123:token',
        body: expect.objectContaining({
          chat_id: -100500,
          text: 'Waiting #1 20 min Anna',
          reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://t.me/c/500/71' }]] },
        }) as object,
      },
    ]);
    expect(calls[0]?.body).not.toHaveProperty('message_thread_id');
    await expect(service.sweep()).resolves.toEqual({ reminded: 0, closed: 0 });
  });

  it('does not remind of a fresh or taken ticket, nor when reminders are off', async () => {
    const fresh = harness({ forum: true });
    await fresh.service.forward('42', 5);
    await expect(fresh.service.sweep()).resolves.toEqual({ reminded: 0, closed: 0 });

    const off = harness({ forum: true, remindAfter: 0 });
    await off.service.forward('42', 5);
    await off.memory.repo.update(off.memory.tickets[0]?.id ?? '', { createdAt: minutesAgo(600) });
    await expect(off.service.sweep()).resolves.toEqual({ reminded: 0, closed: 0 });
  });

  it('closes a ticket the customer left after the operators’ answer, and asks for a rating', async () => {
    const { service, calls, memory, operator } = harness({ forum: true });
    await service.forward('42', 5);
    await operator({ threadId: 71 });
    const id = memory.tickets[0]?.id ?? '';

    // The customer spoke last: nothing to close.
    await memory.repo.update(id, {
      lastOperatorAt: minutesAgo(60 * 50),
      lastCustomerAt: minutesAgo(10),
    });
    await expect(service.sweep()).resolves.toEqual({ reminded: 0, closed: 0 });

    await memory.repo.update(id, {
      lastOperatorAt: minutesAgo(60 * 50),
      lastCustomerAt: minutesAgo(60 * 51),
    });
    calls.length = 0;
    await expect(service.sweep()).resolves.toEqual({ reminded: 0, closed: 1 });
    expect(memory.tickets[0]).toMatchObject({ status: 'closed', closedBy: 'auto' });
    expect(calls[0]?.body).toMatchObject({
      chat_id: 42,
      text: 'Request #1 auto-closed\n\nRate us',
    });
    expect(calls[1]?.body).toMatchObject({ chat_id: -100500, text: 'Auto-closed #1' });
  });

  it('does nothing while support has no operators’ chat', async () => {
    const { service } = harness({ chatId: null });
    await expect(service.sweep()).resolves.toEqual({ reminded: 0, closed: 0 });
  });
});

describe('ratings (F36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks the customer to rate a closed ticket and takes the first rating only', async () => {
    const { service, calls, memory, press } = harness({ forum: true });
    await service.forward('42', 5);
    const id = memory.tickets[0]?.id ?? '';

    // An open ticket cannot be rated.
    await expect(service.rate('42', id, 5)).resolves.toEqual({ accepted: false, number: 1 });

    calls.length = 0;
    await press('close', id);
    expect(calls[0]?.body['reply_markup']).toEqual({
      inline_keyboard: [
        [1, 2, 3, 4, 5].map((n) => ({
          text: `${String(n)}★`,
          callback_data: `rate:${id}:${String(n)}`,
        })),
      ],
    });

    calls.length = 0;
    await expect(service.rate('42', id, 4)).resolves.toEqual({ accepted: true, number: 1 });
    expect(memory.tickets[0]).toMatchObject({ rating: 4 });
    expect(calls[0]?.body).toMatchObject({ chat_id: -100500, text: '★★★★☆ #1: 4' });
    expect(methods(calls)).toContain('editMessageText');

    await expect(service.rate('42', id, 1)).resolves.toEqual({ accepted: false, number: 1 });
    expect(memory.tickets[0]).toMatchObject({ rating: 4 });
  });

  it('never lets someone rate another customer’s ticket', async () => {
    const { service, memory, press } = harness();
    await service.forward('42', 5);
    const id = memory.tickets[0]?.id ?? '';
    await press('close', id);
    await expect(service.rate('43', id, 1)).resolves.toEqual({ accepted: false, number: null });
    expect(memory.tickets[0]?.rating).toBeNull();
  });
});

describe('notes and templates (F36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const templates = [
    { code: 'link', title: 'How to connect', body: { ru: 'Откройте ссылку', en: 'Open the link' } },
    { code: 'ru-only', title: 'Russian', body: { ru: 'Только по-русски', en: '' } },
  ];

  it('keeps a //note with the ticket and sends the customer nothing', async () => {
    const { service, operator, calls, memory } = harness({ forum: true });
    await service.forward('42', 5);
    calls.length = 0;
    await expect(
      operator({ threadId: 71, message: { kind: 'text', text: '// paid twice, check' } }),
    ).resolves.toEqual({ handled: true });
    expect(calls).toEqual([]);
    expect(memory.messages.at(-1)).toMatchObject({
      direction: 'note',
      text: 'paid twice, check',
      authorName: 'Olga',
    });
    // Nor does a note take the ticket.
    expect(memory.tickets[0]?.takenAt).toBeNull();
  });

  it('lists the templates and answers with one in the customer’s language', async () => {
    const { service, operator, calls, memory } = harness({ forum: true, templates });
    await service.forward('42', 5);
    calls.length = 0;

    await operator({ threadId: 71, message: { kind: 'text', text: '/t' } });
    expect(calls[0]?.body).toMatchObject({
      chat_id: -100500,
      message_thread_id: 71,
      text: 'Templates:\nlink — How to connect\nru-only — Russian',
    });

    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/t LINK' } });
    expect(calls[0]).toMatchObject({
      method: 'sendMessage',
      body: { chat_id: 42, text: 'Support: Open the link' },
    });
    expect(memory.messages.at(-1)).toMatchObject({
      direction: 'operator',
      kind: 'text',
      text: 'Open the link',
    });
    expect(memory.tickets[0]).toMatchObject({ status: 'in_progress', assigneeName: 'Olga' });

    // A language the template lacks falls back to the other one.
    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/t ru-only' } });
    expect(calls[0]?.body).toMatchObject({ chat_id: 42, text: 'Support: Только по-русски' });

    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/t nope' } });
    expect(calls[0]?.body).toMatchObject({ chat_id: -100500, text: 'No template nope' });
  });

  it('sends a template as plain text from the support bot', async () => {
    const { service, operator, calls } = harness({
      forum: true,
      templates,
      supportToken: '777:support',
    });
    await service.forward('42', 5, { via: 'support' });
    calls.length = 0;
    await operator({ threadId: 71, message: { kind: 'text', text: '/t link' } });
    expect(calls[0]).toEqual({
      method: 'sendMessage',
      token: '777:support',
      body: { chat_id: 42, text: 'Open the link' },
    });
  });

  it('says there is nothing to note on when the customer never wrote', async () => {
    const { operator, calls, memory } = harness({ forum: true });
    await memory.repo.setTopic(-100500, 'u1', 71);
    await operator({ threadId: 71, message: { kind: 'text', text: '//x' } });
    expect(calls[0]?.body).toMatchObject({ text: 'No ticket yet' });
  });
});

describe('card actions from the operators’ chat (F36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('runs a card button once per double tap and leaves a line in the ticket', async () => {
    const { service, memory, press, actions, calls } = harness({ forum: true });
    await service.forward('42', 5);
    const id = memory.tickets[0]?.id ?? '';
    calls.length = 0;

    await expect(press('ext7', id)).resolves.toEqual({
      text: 'Olga extended until 10/08/2026, 12:00 AM',
    });
    expect(actions.run).toHaveBeenCalledWith({ kind: 'extend', days: 7 }, 'u1', 7, 1);
    expect(calls[0]?.body).toMatchObject({
      chat_id: -100500,
      message_thread_id: 71,
      text: 'Olga extended until 10/08/2026, 12:00 AM',
    });
    await expect(press('ext7', id)).resolves.toEqual({ text: 'Already running' });
    expect(actions.run).toHaveBeenCalledTimes(1);
  });

  it('sends the subscription link to the customer', async () => {
    const { service, memory, press, calls } = harness({ forum: true });
    await service.forward('42', 5);
    calls.length = 0;
    await press('link', memory.tickets[0]?.id ?? '');
    expect(calls[0]?.body).toMatchObject({
      chat_id: 42,
      text: 'Your link: https://sub.example.test/x',
    });
  });

  it('shows a refusal as an alert', async () => {
    const { service, memory, press, actions } = harness();
    await service.forward('42', 5);
    actions.run.mockResolvedValueOnce({ ok: false, reason: 'not_admin' } as never);
    await expect(press('reset', memory.tickets[0]?.id ?? '')).resolves.toEqual({
      text: 'Admins only',
      alert: true,
    });
  });

  it('credits with /credit once, even when Telegram delivers the command twice', async () => {
    const { service, operator, actions, calls } = harness({ forum: true });
    await service.forward('42', 5);
    await operator({ threadId: 71, message: { kind: 'text', text: '/credit 150,5 compensation' } });
    await operator({ threadId: 71, message: { kind: 'text', text: '/credit 150,5 compensation' } });
    expect(actions.run).toHaveBeenCalledTimes(1);
    expect(actions.run).toHaveBeenCalledWith(
      { kind: 'credit', amountMinor: 15_050n, reason: 'compensation' },
      'u1',
      7,
      1,
    );
    calls.length = 0;
    await operator({ threadId: 71, messageId: 901, message: { kind: 'text', text: '/credit -5' } });
    expect(calls[0]?.body).toMatchObject({ text: 'Usage: /credit' });
  });
});

describe('parseAction', () => {
  it('reads days and amounts, and refuses anything else', () => {
    expect(parseAction('extend', '30 server down')).toEqual({
      kind: 'extend',
      days: 30,
      reason: 'server down',
    });
    expect(parseAction('extend', '0')).toBeNull();
    expect(parseAction('extend', '')).toBeNull();
    expect(parseAction('credit', '150')).toEqual({
      kind: 'credit',
      amountMinor: 15_000n,
      reason: undefined,
    });
    expect(parseAction('credit', '0.99')).toMatchObject({ amountMinor: 99n });
    expect(parseAction('credit', '1.999')).toBeNull();
    expect(parseAction('credit', '-5')).toBeNull();
    expect(parseAction('credit', '0')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('reads a command with or without the bot’s name and its arguments', () => {
    expect(parseCommand('/close')).toEqual({ name: 'close', args: '' });
    expect(parseCommand('/t@manta_bot  link ')).toEqual({ name: 't', args: 'link' });
    expect(parseCommand('hello /close')).toBeNull();
  });
});
