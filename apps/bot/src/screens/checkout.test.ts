import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../api-client.js';
import type { RrContext } from '../types.js';
import {
  CARD_CALLBACKS,
  buyData,
  buyFromCard,
  confirmCard,
  originOfInvoice,
  sameOffer,
  showCheckout,
  stableKey,
  topupData,
  topupForPlan,
} from './checkout.js';

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
  const raw = () =>
    (
      markups.at(-1) as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
    ).inline_keyboard
      .flat()
      .map((button) => button.callback_data);
  /** The callback data without the render nonce of the card's buy and top-up buttons. */
  const data = () => raw().map((value) => value?.replace(/:[a-z0-9]{6}$/u, ''));
  const texts = () =>
    (markups.at(-1) as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard
      .flat()
      .map((button) => button.text);
  return { ctx, data, raw, texts, params, labels };
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

  it('draws every card with its own nonce, so a redrawn card is a new press', async () => {
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi.fn().mockResolvedValue(quote()),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
    };
    const first = context();
    const second = context();
    await showCheckout(first.ctx, api as never, { slug: 'month', kind: 'purchase' });
    await showCheckout(second.ctx, api as never, { slug: 'month', kind: 'purchase' });
    const [a, b] = [first.raw()[0] ?? '', second.raw()[0] ?? ''];
    expect(a).not.toBe(b);
    const keyOf = (data: string) => stableKey(context({ data }).ctx);
    expect(keyOf(a)).not.toBe(keyOf(b));
    expect(keyOf(a)).toBe(keyOf(a));
  });

  it('keeps every callback within 64 bytes and matches its registered pattern', () => {
    const slug = 'a'.repeat(32);
    const id = '01a0ded7-ef45-767a-bbf5-fbd98a0d8762';
    const nonce = 'zz09az';
    const cases: Array<[RegExp, string]> = [
      [CARD_CALLBACKS.buy, buyData({ slug, kind: 'purchase' }, 9999999999, nonce)],
      [CARD_CALLBACKS.buy, buyData({ slug, kind: 'plan_change' }, 9999999999, nonce)],
      [CARD_CALLBACKS.topup, topupData({ slug, kind: 'purchase' }, 'cryptobot', nonce)],
      [CARD_CALLBACKS.topup, topupData({ slug, kind: 'plan_change' }, 'cryptobot', nonce)],
      [CARD_CALLBACKS.confirm, `tb:${id}`],
      [
        CARD_CALLBACKS.buyFromConfirm,
        buyData({ slug, kind: 'purchase', invoiceId: id }, 9999999999, nonce),
      ],
      [
        CARD_CALLBACKS.topupFromConfirm,
        topupData({ slug, kind: 'purchase', invoiceId: id }, 'cryptobot', nonce),
      ],
    ];
    for (const [pattern, value] of cases) {
      expect(value).toMatch(pattern);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    }
  });
});

describe('the price a card may be bought at', () => {
  it('needs the exact price for a purchase', () => {
    expect(sameOffer('purchase', 29900, 29900)).toBe(true);
    expect(sameOffer('purchase', 29900, 29901)).toBe(false);
  });

  it('lets a plan change rise by up to 1 ₽ and never fall', () => {
    expect(sameOffer('plan_change', 1000, 1100)).toBe(true);
    expect(sameOffer('plan_change', 1000, 1101)).toBe(false);
    expect(sameOffer('plan_change', 1000, 999)).toBe(false);
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

describe('the promocode of a purchase', () => {
  it('is not sent when the fresh quote did not apply it', async () => {
    const { ctx } = context({ data: 'bb:month:29900:abcdef' });
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi
        .fn()
        .mockResolvedValue(
          quote({ promocode: { code: 'GONE', applied: false, error: 'PROMO_EXPIRED' } }),
        ),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
      createInvoice: vi
        .fn()
        .mockResolvedValue({ id: 'i1', status: 'paid', kind: 'purchase', provider: 'balance' }),
    };
    await buyFromCard(ctx, api as never, {
      slug: 'month',
      kind: 'purchase',
      shownMinor: 29900,
      promocode: 'GONE',
    });
    expect(api.createInvoice).toHaveBeenCalledWith(
      123,
      { kind: 'purchase', planId: 'p1' },
      expect.any(String),
    );
  });

  it('is sent when the fresh quote applied it', async () => {
    const { ctx } = context({ data: 'bb:month:29900:abcdef' });
    const api = {
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi
        .fn()
        .mockResolvedValue(quote({ promocode: { code: 'OK', applied: true } })),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
      createInvoice: vi
        .fn()
        .mockResolvedValue({ id: 'i1', status: 'paid', kind: 'purchase', provider: 'balance' }),
    };
    await buyFromCard(ctx, api as never, {
      slug: 'month',
      kind: 'purchase',
      shownMinor: 29900,
      promocode: 'OK',
    });
    expect(api.createInvoice).toHaveBeenCalledWith(
      123,
      { kind: 'purchase', planId: 'p1', promocode: 'OK' },
      expect.any(String),
    );
  });
});

describe('the card of a paid top-up', () => {
  const invoiceId = '01a0ded7-ef45-767a-bbf5-fbd98a0d8762';
  const withTarget = (promocode: string | null) => ({
    id: invoiceId,
    target: { planId: 'p1', planSlug: 'month', kind: 'purchase', promocode },
  });

  it('takes the plan, the kind and the promocode from the invoice target', async () => {
    const { ctx } = context();
    const api = { getInvoice: vi.fn().mockResolvedValue(withTarget('OK')) };
    expect(await originOfInvoice(ctx, api as never, invoiceId)).toEqual({
      slug: 'month',
      kind: 'purchase',
      invoiceId,
      promocode: 'OK',
    });
    api.getInvoice.mockResolvedValue({ id: invoiceId, target: null });
    expect(await originOfInvoice(ctx, api as never, invoiceId)).toBeNull();
  });

  it('draws the card with the promocode and the tbb/tbt buttons', async () => {
    const { ctx, data } = context();
    const api = {
      getInvoice: vi.fn().mockResolvedValue(withTarget('OK')),
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      getCheckoutQuote: vi
        .fn()
        .mockResolvedValue(quote({ promocode: { code: 'OK', applied: true } })),
      getPaymentMethods: vi.fn().mockResolvedValue(methods),
    };
    await confirmCard(ctx, api as never, invoiceId);
    expect(api.getCheckoutQuote).toHaveBeenCalledWith(123, 'p1', 'purchase', 'OK');
    expect(data()).toEqual([`tbb:${invoiceId}:29900`, 'plans']);
  });

  it.each([[{}], [{ shownMinor: 29900 }], [{ provider: 'yookassa' }]])(
    'shows the plans when the invoice has no target (%j)',
    async (action) => {
      const { ctx, data } = context();
      const api = {
        getInvoice: vi.fn().mockResolvedValue({ id: invoiceId, target: null }),
        getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      };
      await confirmCard(ctx, api as never, invoiceId, action);
      expect(data()).toEqual(['plan:month', 'home']);
    },
  );

  it('tops up again from the card for the same purpose', async () => {
    const { ctx } = context({ data: `tbt:${invoiceId}:yookassa:abcdef` });
    const api = {
      getInvoice: vi.fn().mockResolvedValue(withTarget(null)),
      getPlans: vi.fn().mockResolvedValue({ items: [plan] }),
      createInvoice: vi.fn().mockResolvedValue({
        id: 'i2',
        status: 'pending',
        kind: 'topup',
        provider: 'yookassa',
        number: null,
        amount: { amountMinor: 100, currency: 'RUB' },
        expiresAt: '2026-09-26T18:21:00.000Z',
      }),
    };
    await confirmCard(ctx, api as never, invoiceId, { provider: 'yookassa' });
    expect(api.createInvoice).toHaveBeenCalledWith(
      123,
      { kind: 'topup', provider: 'yookassa', forPlan: { planId: 'p1', kind: 'purchase' } },
      expect.any(String),
    );
  });
});
