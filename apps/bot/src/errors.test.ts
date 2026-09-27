import { BotError, GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api-client.js';
import { botErrorHandler, incidentId, outgoingThrottle } from './bot.js';
import type { RrContext } from './types.js';

function failed(cause: unknown) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    update: { update_id: 7, callback_query: { id: 'q', data: 'plans' } },
    chat: { id: 42 },
    from: { id: 42 },
    callbackQuery: { data: 'plans' },
    reply,
    t: (key: string, params: { incidentId: string }) => `${key}:${params.incidentId}`,
  } as unknown as RrContext;
  return { error: new BotError<RrContext>(cause, ctx), reply };
}

describe('bot error handler for Stars payments (R1)', () => {
  function paymentFailed(t: unknown) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      update: {
        update_id: 8,
        message: { successful_payment: { telegram_payment_charge_id: 'charge-1' } },
      },
      chat: { id: 42 },
      from: { id: 42 },
      reply,
      t,
    } as unknown as RrContext;
    return { error: new BotError<RrContext>(new ApiClientError(503, 'UNAVAILABLE'), ctx), reply };
  }

  it('tells the customer the payment is received and being credited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { error, reply } = paymentFailed(
      (key: string, params: { incidentId: string }) => `${key}:${params.incidentId}`,
    );

    await botErrorHandler({ markBlocked: vi.fn() })(error);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/^bot\.payment\.received:/u));
    vi.restoreAllMocks();
  });

  it('logs and does not fail when the catalog never loaded', async () => {
    // The i18n middleware failed before `ctx.t` was bound.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { error, reply } = paymentFailed(undefined);

    await expect(botErrorHandler({ markBlocked: vi.fn() })(error)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(
      'Telegram update failed',
      expect.objectContaining({ updateId: 8, updateType: 'message' }),
    );
    expect(reply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('bot error and delivery boundaries', () => {
  it('creates an eight-character incident id without punctuation', () => {
    expect(incidentId()).toMatch(/^[A-Za-z0-9_-]{8}$/u);
  });

  it('serializes message delivery through the global transformer', async () => {
    const calls: number[] = [];
    const transformer = outgoingThrottle();
    const prev = () => {
      calls.push(Date.now());
      return Promise.resolve(true as never);
    };
    await Promise.all([
      transformer(prev, 'sendMessage', { chat_id: 1, text: 'one' }),
      transformer(prev, 'sendMessage', { chat_id: 2, text: 'two' }),
    ]);
    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second && first ? second - first : 0).toBeGreaterThanOrEqual(30);
  });

  it('logs a handler error with the incident id the customer is shown (FR-127)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { error, reply } = failed(new ApiClientError(403, 'FORBIDDEN'));

    await botErrorHandler({ markBlocked: vi.fn() })(error);

    const [message, context] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Telegram update failed');
    expect(context).toMatchObject({
      updateId: 7,
      chatId: 42,
      updateType: 'callback_query',
      callbackData: 'plans',
      description: 'api_error',
      status: 403,
      apiCode: 'FORBIDDEN',
    });
    expect(reply).toHaveBeenCalledWith(`bot.error.generic:${String(context.incidentId)}`);
    log.mockRestore();
  });

  it('names an unknown handler error in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { error } = failed(new TypeError('x is undefined'));

    await botErrorHandler({ markBlocked: vi.fn() })(error);

    expect(log.mock.calls[0]?.[1]).toMatchObject({
      description: 'handler_error',
      error: 'TypeError',
      message: 'x is undefined',
    });
    log.mockRestore();
  });

  it('marks a user who blocked the bot instead of answering (EX-04)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const markBlocked = vi.fn().mockResolvedValue(undefined);
    const { error, reply } = failed(
      new GrammyError(
        'blocked',
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        'sendMessage',
        {},
      ),
    );

    await botErrorHandler({ markBlocked })(error);

    expect(markBlocked).toHaveBeenCalledWith(42);
    expect(reply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
