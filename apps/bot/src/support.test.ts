import { describe, expect, it, vi } from 'vitest';

import { supportRelay } from './support.js';
import type { RrContext } from './types.js';

function relay(options: { supportBot?: boolean; bot?: 'shop' | 'support' } = {}) {
  const api = {
    getConfig: () =>
      Promise.resolve({
        supportForwardChatId: -100500,
        defaultLocale: 'ru',
        supportBot: options.supportBot ? { username: 'manta_help_bot' } : null,
      }),
    operatorSupport: vi.fn().mockResolvedValue({ handled: true }),
    supportCallback: vi.fn().mockResolvedValue({ text: 'Yours #1' }),
  };
  return {
    middleware: supportRelay(api as never, { bot: options.bot ?? 'shop' }),
    api,
  };
}

function update(
  fields: { message?: Record<string, unknown>; callbackQuery?: Record<string, unknown> },
  chat = { id: -100500, type: 'supergroup' },
) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(true);
  const ctx = {
    chat,
    from: { id: 7, is_bot: false, first_name: 'Olga', last_name: 'K' },
    ...(fields.message ? { message: { message_id: 5, ...fields.message } } : {}),
    ...(fields.callbackQuery ? { callbackQuery: fields.callbackQuery } : {}),
    answerCallbackQuery,
  } as unknown as RrContext;
  return { ctx, answerCallbackQuery };
}

describe('support relay (FR-124, F36)', () => {
  it('hands an operator’s message in a customer’s topic to the API with what it is', async () => {
    const { middleware, api } = relay();
    const { ctx } = update({
      message: {
        caption: 'Look here',
        photo: [
          { file_id: 'small', file_unique_id: 's' },
          { file_id: 'big', file_unique_id: 'b' },
        ],
        is_topic_message: true,
        message_thread_id: 71,
        reply_to_message: { message_id: 71 },
      },
    });
    const next = vi.fn();
    await middleware(ctx, next);
    expect(api.operatorSupport).toHaveBeenCalledWith({
      chatId: -100500,
      messageId: 5,
      threadId: 71,
      replyToMessageId: 71,
      from: { id: 7, name: 'Olga K' },
      via: 'shop',
      message: { kind: 'photo', text: 'Look here', fileId: 'big', fileUniqueId: 'b' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a ticket card’s button with what the API says, as an alert when refused', async () => {
    const { middleware, api } = relay({ bot: 'support' });
    const { ctx, answerCallbackQuery } = update({ callbackQuery: { data: 'st:take:abc' } });
    await middleware(ctx, vi.fn());
    expect(api.supportCallback).toHaveBeenCalledWith({
      chatId: -100500,
      from: { id: 7, name: 'Olga K' },
      data: 'st:take:abc',
      via: 'support',
    });
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Yours #1' });

    api.supportCallback.mockResolvedValueOnce({ text: 'Denied', alert: true });
    const second = update({ callbackQuery: { data: 'st:close:abc' } });
    await middleware(second.ctx, vi.fn());
    expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Denied', show_alert: true });
  });

  it('hands on an answer an administrator wrote anonymously, as the group', async () => {
    const { middleware, api } = relay();
    const { ctx } = update(
      { message: { text: 'We are on it', sender_chat: { id: -100500, type: 'supergroup' } } },
      { id: -100500, type: 'supergroup', title: 'Operators' } as never,
    );
    (ctx as unknown as { from: Record<string, unknown> }).from = {
      id: 1087968824,
      is_bot: true,
      first_name: 'Group',
    };
    await middleware(ctx, vi.fn());
    expect(api.operatorSupport).toHaveBeenCalledWith(
      expect.objectContaining({ from: { id: 1087968824, name: 'Operators' } }),
    );
  });

  it('passes on everything outside the operators’ chat', async () => {
    const { middleware, api } = relay();
    for (const chat of [
      { id: 42, type: 'private' },
      { id: -1, type: 'supergroup' },
    ]) {
      const { ctx } = update({ message: { text: 'hello' } }, chat);
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalled();
    }
    expect(api.operatorSupport).not.toHaveBeenCalled();
  });

  it('ignores bots, blank text, and leaves the chat to the support bot when there is one', async () => {
    const { middleware, api } = relay();
    const blank = update({ message: { text: '   ' } });
    await middleware(blank.ctx, vi.fn());
    const fromBot = update({ message: { text: 'hi' } });
    (fromBot.ctx as unknown as { from: { is_bot: boolean } }).from.is_bot = true;
    await middleware(fromBot.ctx, vi.fn());
    expect(api.operatorSupport).not.toHaveBeenCalled();

    const moved = relay({ supportBot: true });
    const { ctx } = update({ message: { text: 'hi' } });
    const next = vi.fn();
    await moved.middleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(moved.api.operatorSupport).not.toHaveBeenCalled();
  });
});
