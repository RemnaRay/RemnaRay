import { describe, expect, it } from 'vitest';

import { showPlanChange } from './plan-change.js';
import type { RrContext } from '../types.js';

function context() {
  const params: Record<string, unknown>[] = [];
  const markups: unknown[] = [];
  const ctx = {
    from: { id: 123 },
    locale: 'ru',
    session: {},
    t: (key: string, values: Record<string, unknown> = {}) => {
      params.push({ key, ...values });
      return key;
    },
    tPlain: (key: string, values: Record<string, unknown> = {}) => {
      params.push({ key, ...values });
      return key;
    },
    reply: (_text: string, options: { reply_markup?: unknown }) => {
      markups.push(options.reply_markup);
      return { message_id: 1 };
    },
  } as unknown as RrContext;
  const data = () =>
    (
      markups.at(-1) as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
    ).inline_keyboard
      .flat()
      .map((button) => button.callback_data);
  return { ctx, params, data };
}

const plans = {
  items: [
    {
      id: 'p1',
      slug: 'month',
      name: { ru: 'Месяц' },
      price: { amountMinor: 29900, currency: 'RUB' },
    },
    {
      id: 'p2',
      slug: 'year',
      name: { ru: 'Год' },
      price: { amountMinor: 299000, currency: 'RUB' },
    },
  ],
};
describe('bot plan change (section 12 `plan:change`, FR-023)', () => {
  it('lists the other plans with what is left to pay', async () => {
    const { ctx, params, data } = context();
    const api = {
      getSubscription: () => ({ subscription: { canChangePlan: true, plan: { id: 'p1' } } }),
      getPlans: () => plans,
      getCheckoutQuote: () => ({ kind: 'plan_change', toPayMinor: 289000 }),
    } as never;

    await showPlanChange(ctx, api);

    expect(data()).toEqual(['plan:change:year', 'sub']);
    expect(params).toContainEqual(
      expect.objectContaining({ key: 'bot.btn.planChangeTo', plan: 'Год' }),
    );
  });
});
