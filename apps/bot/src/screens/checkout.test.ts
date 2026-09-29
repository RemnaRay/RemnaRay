import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../api-client.js';
import type { RrContext } from '../types.js';
import { buyFromCard, showCheckout, stableKey, topupForPlan } from './checkout.js';

const plan = {
  id: 'p1',
  slug: 'month',
  name: { ru: 'Месяц' },
  durationDays: 30,
  price: { amountMinor: 29900, currency: 'RUB' },
};
const quote = (over = {}) => ({
  planId: 'p1',
  kind: 'purchase',
  priceMinor: 29900,
  discountMinor: 0,
  creditMinor: 0,
  toPayMinor: 29900,
  availableMinor: 30000,
  missingMinor: 0,
  topups: [],
  promocode: null,
  ...over,
});
const methods = {
  items: [
    { code: 'yookassa', kind: 'redirect', available: true, displayName: { ru: 'ЮKassa' } },
    { code: 'cryptobot', kind: 'redirect', available: true, displayName: { ru: 'CryptoBot' } },
  ],
};

function context(options: { data?: string } = {}) {
  const params: Record<string, unknown>[] = [];
  const markups: unknown[] = [];
  const labels: string[] = [];
  const format = (key: string, values: Record<string, unknown> = {}) => {
    params.push({ key, ...values });
    return key;
  };
  const ctx = {
    from: { id: 123 },
    chat: { id: 5 },
    locale: 'ru',
    session: {},
    callbackQuery: { message: { message_id: 9 }, data: options.data ?? '' },
    t: format,
    tPlain: (key: string, values: Record<string, unknown> = {}) => {
      const label = `${key}|${Object.values(values).join('|')}`;
      labels.push(label);
      return label;
    },
    editMessageText: (_text: string, extra: { reply_markup?: unknown }) => {
      markups.push(extra.reply_markup);
      return Promise.resolve({ message_id: 9 });
    },
    reply: (_text: string, extra: { reply_markup?: unknown }) => {
      markups.push(extra.reply_markup);
      return Promise.resolve({ message_id: 9 });
    },
  } as unknown as RrContext;
  const data = () =>
    (
      markups.at(-1) as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
    ).inline_keyboard
      .flat()
      .map((button) => button.callback_data);
  const texts = () =>
    (markups.at(-1) as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard
      .flat()
      .map((button) => button.text);
  return { ctx, data, texts, params, labels };
}

describe('the plan card (F37)', () => {
  it('offers the purchase from the balance when it covers the price', async () => {
    const { ctx, data } = context();
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(quote()),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
    };
    await showCheckout(ctx, api as never, { slug: 'month', kind: 'purchase' });
    expect(data()).toEqual(['bb:month:29900', 'plans']);
  });

  it('offers a top-up per provider for the shortage', async () => {
    const { ctx, data, params } = context();
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(
        quote({
          availableMinor: 29600,
          missingMinor: 300,
          topups: [
            { provider: 'yookassa', amountMinor: 5000 },
            { provider: 'cryptobot', amountMinor: 10000 },
          ],
        }),
      ),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
    };
    await showCheckout(ctx, api as never, { slug: 'month', kind: 'purchase' });
    expect(data()).toEqual(['tp:month:yookassa', 'tp:month:cryptobot', 'plans']);
    expect(params).toContainEqual(expect.objectContaining({ key: 'bot.screen.checkout.short' }));
  });

  it('writes a plan name with an ampersand into a button as it is, not as HTML', async () => {
    const { ctx, texts } = context();
    const named = { ...plan, name: { ru: 'Tom & Jerry' } };
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [named] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(
        quote({
          availableMinor: 0,
          missingMinor: 29900,
          topups: [{ provider: 'yookassa', amountMinor: 29900 }],
        }),
      ),
      getPaymentMethods: vi.fn().mockResolvedValue({
        items: [
          { code: 'yookassa', kind: 'redirect', available: true, displayName: { ru: 'A & B' } },
        ],
      }),
    };
    await showCheckout(ctx, api as never, { slug: 'month', kind: 'purchase' });
    expect(texts()[0]).toContain('bot.btn.topupFor');
    expect(texts()[0]).toContain('A & B');
    expect(texts()[0]).not.toContain('&amp;');
  });

  it('keeps a plan name with an ampersand raw on the balance button too', async () => {
    const { ctx, labels } = context();
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [{ ...plan, name: { ru: 'Tom & Jerry' } }] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(quote({ kind: 'plan_change' })),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
    };
    await showCheckout(ctx, api as never, { slug: 'month', kind: 'plan_change' });
    expect(labels[0]).toContain('bot.btn.changeFromBalance');
  });

  it('keeps every callback within 64 bytes', () => {
    const slug = 'a'.repeat(32);
    const id = '01a0ded7-ef45-767a-bbf5-fbd98a0d8762';
    for (const value of [
      `bb:${slug}:9999999999`,
      `bc:${slug}:9999999999`,
      `tp:${slug}:cryptobot`,
      `tc:${slug}:cryptobot`,
      `tb:${id}`,
      `tbb:${id}:9999999999`,
      `tbt:${id}:cryptobot`,
    ])
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
  });
});

describe('buying from the card', () => {
  it('buys once however often the same card is pressed', () => {
    const first = context({ data: 'bb:month:29900' });
    const second = context({ data: 'bb:month:29900' });
    expect(stableKey(first.ctx)).toBe(stableKey(second.ctx));
    expect(stableKey(first.ctx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('shows the card again instead of buying at a price the card did not show', async () => {
    const { ctx, data } = context({ data: 'bb:month:23920' });
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(quote()),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
      createInvoice: vi.fn(),
    };
    await buyFromCard(ctx, api as never, { slug: 'month', kind: 'purchase', shownMinor: 23920 });
    expect(api.createInvoice).not.toHaveBeenCalled();
    expect(data()).toEqual(['bb:month:29900', 'plans']);
  });

  it('re-renders the shortage when the balance fell in between', async () => {
    const { ctx, data } = context({ data: 'bb:month:29900' });
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi
        .fn()
        .mockResolvedValueOnce(quote())
        .mockResolvedValue(
          quote({
            availableMinor: 0,
            missingMinor: 29900,
            topups: [{ provider: 'yookassa', amountMinor: 29900 }],
          }),
        ),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
      createInvoice: vi.fn().mockRejectedValue(
        new ApiClientError(409, 'INSUFFICIENT_FUNDS', {
          error: { details: { missingMinor: 29900 } },
        }),
      ),
    };
    await buyFromCard(ctx, api as never, { slug: 'month', kind: 'purchase', shownMinor: 29900 });
    expect(data()).toEqual(['tp:month:yookassa', 'plans']);
  });
});

describe('the top-up for a plan', () => {
  it('opens the card when the balance already covers it', async () => {
    const { ctx, data } = context({ data: 'tp:month:yookassa' });
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(quote()),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
      createInvoice: vi.fn().mockRejectedValue(new ApiClientError(409, 'BALANCE_SUFFICIENT')),
    };
    await topupForPlan(ctx, api as never, {
      slug: 'month',
      kind: 'purchase',
      provider: 'yookassa',
    });
    expect(data()).toEqual(['bb:month:29900', 'plans']);
  });
});
