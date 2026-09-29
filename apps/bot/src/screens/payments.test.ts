import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, type InvoiceView } from '../api-client.js';
import type { RrContext } from '../types.js';
import { show } from './common.js';
import { checkPayment } from './payments.js';

const pending = {
  id: '01a0ded7-ef45-767a-bbf5-fbd98a0d8762',
  status: 'pending',
  amount: { amountMinor: 30000, currency: 'RUB' },
  paymentUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1',
  expiresAt: '2026-09-26T18:21:00.000Z',
} as unknown as InvoiceView;

/** A callback press on the invoice message; `edits` keeps what the screen became. */
function press() {
  const edits: string[] = [];
  const markups: unknown[] = [];
  const ctx = {
    from: { id: 7556126867 },
    locale: 'ru',
    session: {},
    callbackQuery: { message: { message_id: 5 } },
    t: (key: string, values: Record<string, unknown> = {}) =>
      [key, ...Object.keys(values)].join(' '),
    tPlain: (key: string, values: Record<string, unknown> = {}) =>
      [key, ...Object.values(values)].join('|'),
    editMessageText: (text: string, extra?: { reply_markup?: unknown }) => {
      edits.push(text);
      markups.push(extra?.reply_markup);
      return Promise.resolve(true);
    },
  } as unknown as RrContext;
  const labels = () =>
    (
      markups.at(-1) as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }
    ).inline_keyboard.flat();
  return { ctx, edits, labels };
}

describe('«Проверить оплату» (FR-064, F30)', () => {
  it('says when an unpaid invoice was checked, so every press changes the screen', async () => {
    const { ctx, edits } = press();
    const api = { checkInvoice: vi.fn().mockResolvedValue(pending) };

    await checkPayment(ctx, api as never, pending.id);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('bot.screen.pay.wait');
    expect(edits[0]).toContain('bot.screen.pay.notYet time');
  });

  it('shows the success of a paid one', async () => {
    const { ctx, edits } = press();
    const api = {
      checkInvoice: vi
        .fn()
        .mockResolvedValue({ ...pending, kind: 'purchase', provider: 'balance', status: 'paid' }),
    };

    await checkPayment(ctx, api as never, pending.id);

    expect(edits).toEqual(['bot.screen.pay.ok']);
  });

  const topupFor = (over: Record<string, unknown>) => ({
    ...pending,
    kind: 'topup',
    provider: 'yookassa',
    status: 'paid',
    number: '01-00001',
    target: { planId: 'p1', planSlug: 'month', kind: 'purchase', promocode: null },
    ...over,
  });
  const plans = { items: [{ id: 'p1', slug: 'month', name: { ru: 'Tom & Jerry' } }] };

  it('turns a paid top-up for a plan into the «Купить» offer', async () => {
    const { ctx, edits, labels } = press();
    const api = {
      checkInvoice: vi.fn().mockResolvedValue(topupFor({})),
      getPlans: vi.fn().mockResolvedValue(plans),
    };

    await checkPayment(ctx, api as never, pending.id);

    expect(edits[0]).toContain('bot.screen.pay.credited');
    expect(labels()[0]).toEqual(
      expect.objectContaining({
        callback_data: `tb:${pending.id}`,
        text: 'bot.btn.buyPlan|Tom & Jerry',
      }),
    );
  });

  it('credits an old provider invoice of a purchase to the balance, not to a subscription', async () => {
    const { ctx, edits } = press();
    const api = {
      checkInvoice: vi.fn().mockResolvedValue(topupFor({ kind: 'purchase', target: null })),
      getPlans: vi.fn(),
    };

    await checkPayment(ctx, api as never, pending.id);

    expect(edits[0]).toContain('bot.screen.pay.credited');
  });

  it('says an underpaid top-up arrived incomplete, without an amount', async () => {
    const { ctx, edits } = press();
    const api = {
      checkInvoice: vi.fn().mockResolvedValue(topupFor({ status: 'underpaid' })),
      getPlans: vi.fn().mockResolvedValue(plans),
    };

    await checkPayment(ctx, api as never, pending.id);

    expect(edits[0]).toContain('bot.screen.pay.creditedPartial');
    expect(edits[0]).not.toContain('amount');
  });

  it.each([
    [new ApiClientError(429, 'RATE_LIMITED'), 'bot.screen.pay.checkLimit time'],
    [new ApiClientError(409, 'PROVIDER_UNAVAILABLE'), 'bot.screen.pay.checkFailed time'],
  ])('answers %s on the invoice instead of an error', async (refusal, note) => {
    const { ctx, edits } = press();
    const api = {
      checkInvoice: vi.fn().mockRejectedValue(refusal),
      getInvoice: vi.fn().mockResolvedValue(pending),
    };

    await checkPayment(ctx, api as never, pending.id);

    expect(api.getInvoice).toHaveBeenCalledWith(7556126867, pending.id);
    expect(edits[0]).toContain(note);
  });

  it('still reports any other failure as one (FR-127)', async () => {
    const { ctx } = press();
    const failure = new ApiClientError(500, 'INTERNAL_ERROR');
    const api = { checkInvoice: vi.fn().mockRejectedValue(failure) };

    await expect(checkPayment(ctx, api as never, pending.id)).rejects.toBe(failure);
  });
});

describe('show', () => {
  it('treats Telegram’s «message is not modified» as done, not as a failure', async () => {
    const reply = vi.fn();
    const ctx = {
      session: {},
      callbackQuery: { message: { message_id: 5 } },
      editMessageText: () =>
        Promise.reject(
          new GrammyError(
            "Call to 'editMessageText' failed!",
            {
              ok: false,
              error_code: 400,
              description:
                'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
            },
            'editMessageText',
            {},
          ),
        ),
      reply,
    } as unknown as RrContext;

    await expect(show(ctx, 'same')).resolves.toBeUndefined();
    expect(reply).not.toHaveBeenCalled();
  });
});
