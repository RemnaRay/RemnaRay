import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MockRoute } from '../test-utils/render-page';

vi.mock('../i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
  usePathname: () => '/account',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  redirect: () => undefined,
  getPathname: () => '/account',
}));

const { mountPage, renderPage } = await import('../test-utils/render-page');
const SubscriptionClient = (await import('../app/[locale]/account/subscription-client')).default;
const PlansClient = (await import('../app/[locale]/account/plans/plans-client')).default;
const BalanceClient = (await import('../app/[locale]/account/balance/balance-client')).default;
const ReferralsClient = (await import('../app/[locale]/account/referrals/referrals-client'))
  .default;
const DevicesClient = (await import('../app/[locale]/account/devices/devices-client')).default;
const SettingsClient = (await import('../app/[locale]/account/settings/settings-client')).default;

const userMe = {
  id: 'user-1',
  telegramId: 123,
  username: 'manta',
  firstName: 'Manta',
  language: 'ru',
  email: null,
  balance: { amountMinor: 0, currency: 'RUB' },
  balanceHeld: { amountMinor: 0, currency: 'RUB' },
  referralCode: 'AB12CD34',
  referralLink: 'https://shop.test/r/AB12CD34',
  botReferralLink: 'https://t.me/bot?start=ref_AB12CD34',
  marketingOptOut: false,
  trialAvailable: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const failure = { status: 503, body: { error: { code: 'PANEL_UNAVAILABLE', requestId: 'req-7' } } };

type PageCase = {
  name: string;
  component: ComponentType<{ locale: 'ru' }>;
  emptyState: 'empty' | 'ready';
  hasEmptyBlock?: boolean;
  empty: Record<string, MockRoute>;
  error: Record<string, MockRoute>;
};

const pages: PageCase[] = [
  {
    name: 'subscription',
    component: SubscriptionClient,
    emptyState: 'empty',
    empty: {
      '/api/v1/me': { body: userMe },
      '/api/v1/me/subscription': { body: { subscription: null, panel: null, clients: [] } },
    },
    error: { '/api/v1/me': { body: userMe }, '/api/v1/me/subscription': failure },
  },
  {
    name: 'plans',
    component: PlansClient,
    emptyState: 'empty',
    empty: {
      '/api/v1/public/plans': { body: { items: [] } },
      '/api/v1/me/payment-methods': { body: { items: [] } },
    },
    error: {
      '/api/v1/public/plans': failure,
      '/api/v1/me/payment-methods': { body: { items: [] } },
    },
  },
  {
    name: 'balance',
    component: BalanceClient,
    emptyState: 'ready',
    empty: {
      '/api/v1/me': { body: userMe },
      '/api/v1/me/topup-config': { body: { presetsMinor: [], minMinor: 100, maxMinor: 1000 } },
      '/api/v1/me/payment-methods': { body: { items: [] } },
      '/api/v1/me/transactions': { body: { items: [], nextCursor: null } },
    },
    error: {
      '/api/v1/me': { body: userMe },
      '/api/v1/me/topup-config': failure,
      '/api/v1/me/payment-methods': { body: { items: [] } },
      '/api/v1/me/transactions': { body: { items: [], nextCursor: null } },
    },
  },
  {
    name: 'referrals',
    component: ReferralsClient,
    emptyState: 'ready',
    empty: {
      '/api/v1/me/referrals': {
        body: {
          code: 'AB12CD34',
          link: 'https://shop.test/r/AB12CD34',
          botLink: 'https://t.me/bot?start=ref_AB12CD34',
          invited: 0,
          converted: 0,
          earned: { amountMinor: 0, currency: 'RUB' },
          program: {
            mode: 'percent_first',
            percent: 20,
            fixedMinor: 0,
            inviteeBonus: { type: 'days', value: 3 },
          },
        },
      },
      '/api/v1/me/referrals/list': { body: { items: [], nextCursor: null } },
    },
    error: {
      '/api/v1/me/referrals': failure,
      '/api/v1/me/referrals/list': { body: { items: [], nextCursor: null } },
    },
  },
  {
    name: 'devices',
    component: DevicesClient,
    emptyState: 'ready',
    empty: { '/api/v1/me/subscription/devices': { body: { items: [], canRemove: true } } },
    error: { '/api/v1/me/subscription/devices': failure },
  },
  {
    name: 'settings',
    component: SettingsClient,
    emptyState: 'ready',
    hasEmptyBlock: false,
    empty: { '/api/v1/me': { body: userMe } },
    error: { '/api/v1/me': failure },
  },
];

describe('AC-133: every account page renders loading, empty and error', () => {
  for (const page of pages) {
    it(`renders the three states for /account ${page.name}`, async () => {
      const pendingRoutes = Object.fromEntries(
        Object.keys(page.empty).map((path) => [path, { pending: true }]),
      );
      const loading = await renderPage(page.component, pendingRoutes);
      expect(loading, 'loading state').toContain('data-state="loading"');
      expect(loading).toContain('animate-pulse');

      const empty = await renderPage(page.component, page.empty);
      expect(empty, 'ready or empty state').toContain(`data-state="${page.emptyState}"`);
      if (page.hasEmptyBlock !== false)
        expect(empty, 'empty block').toContain('data-state="empty"');

      const error = await renderPage(page.component, page.error);
      expect(error, 'error state').toContain('data-state="error"');
      expect(error).toContain('role="alert"');
      expect(error).toContain('req-7');
      expect(error, 'localized error code').toContain('Панель временно недоступна');
    });
  }
});

describe('the balance page (section 15.2)', () => {
  const routes = (held: number) => ({
    '/api/v1/me': {
      body: {
        ...userMe,
        balance: { amountMinor: 20000, currency: 'RUB' },
        balanceHeld: { amountMinor: held, currency: 'RUB' },
      },
    },
    '/api/v1/me/topup-config': { body: { presetsMinor: [], minMinor: 100, maxMinor: 1000 } },
    '/api/v1/me/payment-methods': { body: { items: [] } },
    '/api/v1/me/transactions': { body: { items: [], nextCursor: null } },
  });

  it('shows held referral rewards as pending next to the available balance', async () => {
    const markup = await renderPage(BalanceClient, routes(9900));
    expect(markup).toMatch(/200(?:&nbsp;|\s)?₽/u);
    expect(markup).toContain('В обработке:');
    expect(markup).toMatch(/99(?:&nbsp;|\s)?₽/u);
  });

  it('shows no pending line when nothing is held', async () => {
    const markup = await renderPage(BalanceClient, routes(0));
    expect(markup).not.toContain('В обработке:');
  });

  it('heads the history amount «Сумма», not a second «Текущий баланс»', async () => {
    const markup = await renderPage(BalanceClient, {
      ...routes(0),
      '/api/v1/me/transactions': {
        body: {
          items: [
            {
              id: 'tx-1',
              type: 'adjustment',
              amount: { amountMinor: 50000, currency: 'RUB' },
              provider: null,
              status: 'completed',
              createdAt: '2026-09-28T00:00:00.000Z',
              description: 'seed balance',
              invoiceNumber: null,
            },
          ],
          nextCursor: null,
        },
      },
    });
    expect(markup).toMatch(/<th[^>]*>Сумма<\/th>/u);
    expect(markup.match(/Текущий баланс/gu)).toHaveLength(1);
  });

  it('lets the customer choose the provider of a top-up, never the balance (FR-071)', async () => {
    const markup = await renderPage(BalanceClient, {
      ...routes(0),
      '/api/v1/me/payment-methods': {
        body: {
          items: [
            {
              code: 'balance',
              displayName: { ru: 'Баланс', en: 'Balance' },
              kind: 'balance',
              available: true,
              balance: { amountMinor: 20000, currency: 'RUB' },
            },
            {
              code: 'yookassa',
              displayName: { ru: 'ЮKassa', en: 'YooKassa' },
              kind: 'redirect',
              available: true,
            },
            {
              code: 'stars',
              displayName: { ru: 'Звёзды', en: 'Stars' },
              kind: 'stars',
              available: true,
            },
          ],
        },
      },
    });
    expect(markup).toContain('value="yookassa"');
    expect(markup).toContain('value="stars"');
    expect(markup).not.toContain('value="balance"');
  });
});

describe('the referral terms (FR-152, section 15)', () => {
  const summary = (program: Record<string, unknown>) => ({
    '/api/v1/me/referrals': {
      body: {
        code: 'AB12CD34',
        link: 'https://shop.test/r/AB12CD34',
        botLink: 'https://t.me/bot?start=ref_AB12CD34',
        invited: 0,
        converted: 0,
        earned: { amountMinor: 0, currency: 'RUB' },
        program: {
          mode: 'percent_first',
          percent: 20,
          fixedMinor: 15000,
          inviteeBonus: { type: 'none', value: 0 },
          ...program,
        },
      },
    },
    '/api/v1/me/referrals/list': { body: { items: [], nextCursor: null } },
  });

  it('states the fixed reward of fixed_first and the invitee bonus', async () => {
    const markup = await renderPage(
      ReferralsClient,
      summary({ mode: 'fixed_first', inviteeBonus: { type: 'days', value: 3 } }),
    );
    expect(markup).toMatch(/Вы получаете 150(?:&nbsp;|\s)?₽ за каждого приглашённого/u);
    expect(markup).toContain('Приглашённый получает 3 дня доступа.');
  });

  it('states a reward on every top-up for percent_all', async () => {
    const markup = await renderPage(ReferralsClient, summary({ mode: 'percent_all' }));
    expect(markup).toContain('Вы получаете 20% от каждого пополнения приглашённого.');
    expect(markup).not.toContain('Приглашённый получает');
  });
});

describe('an answer that does not match the contract (F24)', () => {
  it('names the failure instead of an empty incident code', async () => {
    const markup = await renderPage(PlansClient, {
      '/api/v1/public/plans': {
        body: {
          items: [
            {
              id: 'p1',
              slug: 'month',
              name: { ru: 'Месяц', en: 'Month' },
              description: {},
              durationDays: 30,
              trafficLimitBytes: 0,
              deviceLimit: 3,
              price: { amountMinor: 29900, currency: 'RUB' },
              sortOrder: 10,
            },
          ],
        },
      },
      '/api/v1/me/payment-methods': { body: { items: [] } },
    });
    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('Сервер ответил не в том формате');
    expect(markup).not.toMatch(/Код инцидента: ?</u);
  });
});

describe('buying from the balance (F37)', () => {
  const plans = {
    items: [
      {
        id: 'p1',
        slug: 'month',
        name: { ru: 'Месяц', en: 'Month' },
        description: { ru: '', en: '' },
        durationDays: 30,
        trafficLimitBytes: 0,
        trafficResetStrategy: 'NO_RESET',
        deviceLimit: 3,
        price: { amountMinor: 29900, currency: 'RUB' },
        sortOrder: 10,
      },
    ],
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
  const PlansClientSelected = ({ locale }: { locale: 'ru' }) => (
    <PlansClient initialPlanId="p1" locale={locale} />
  );

  it('offers the purchase from the balance when it covers the price', async () => {
    const markup = await renderPage(PlansClientSelected, {
      '/api/v1/public/plans': { body: plans },
      '/api/v1/me/checkout/quote': { body: quote() },
      '/api/v1/me/payment-methods': { body: { items: [] } },
    });
    expect(markup).toContain('Купить с баланса за 299');
    expect(markup).not.toContain('name="provider"');
  });

  it('offers a top-up of the shortage per provider', async () => {
    const markup = await renderPage(PlansClientSelected, {
      '/api/v1/public/plans': { body: plans },
      '/api/v1/me/checkout/quote': {
        body: quote({
          availableMinor: 29600,
          missingMinor: 300,
          topups: [{ provider: 'yookassa', amountMinor: 5000 }],
        }),
      },
      '/api/v1/me/payment-methods': {
        body: {
          items: [
            {
              code: 'yookassa',
              displayName: { ru: 'ЮKassa', en: 'YooKassa' },
              kind: 'redirect',
              available: true,
            },
          ],
        },
      },
    });
    expect(markup).toContain('Не хватает 3');
    expect(markup).toContain('value="yookassa"');
    expect(markup).toContain('Пополнить на 50');
  });

  it('changes the plan: hides the current one and shows the credit (13.4)', async () => {
    const two = {
      items: [
        plans.items[0],
        { ...plans.items[0], id: 'p2', slug: 'year', name: { ru: 'Год', en: 'Year' } },
      ],
    };
    const PlansChange = ({ locale }: { locale: 'ru' }) => (
      <PlansClient change initialPlanId="p2" locale={locale} />
    );
    const markup = await renderPage(PlansChange, {
      '/api/v1/public/plans': { body: two },
      '/api/v1/me/subscription': {
        body: {
          subscription: {
            id: 's1',
            status: 'active',
            source: 'purchase',
            plan: plans.items[0],
            startsAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
            daysLeft: 10,
            canChangePlan: true,
            canRevoke: false,
          },
          panel: null,
          clients: [],
        },
      },
      '/api/v1/me/checkout/quote': {
        body: quote({ kind: 'plan_change', creditMinor: 10000, toPayMinor: 19900 }),
      },
      '/api/v1/me/payment-methods': { body: { items: [] } },
    });
    expect(markup).toContain('Смена тарифа');
    expect(markup).not.toContain('Месяц');
    expect(markup).toContain('Зачёт за остаток текущего тарифа: 100');
    expect(markup).toContain('Сменить за 199');
  });

  const buttonNamed = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text));

  it('does not send a promocode the quote refused with the purchase', async () => {
    const page = await mountPage(PlansClientSelected, {
      '/api/v1/public/plans': { body: plans },
      '/api/v1/me/promocodes/preview': {
        status: 404,
        body: { error: { code: 'PROMO_NOT_FOUND', requestId: 'req-1' } },
      },
      '/api/v1/me/checkout/quote': {
        body: quote({ promocode: { code: 'NOPE', applied: false, error: 'PROMO_NOT_FOUND' } }),
      },
      '/api/v1/me/payment-methods': { body: { items: [] } },
      '/api/v1/me/invoices': { status: 409, body: { error: { code: 'INSUFFICIENT_FUNDS' } } },
    });
    try {
      await page.type(page.container.querySelector('#promocode'), 'nope');
      await page.click(buttonNamed(page.container, 'Применить'));
      const quoted = page.requests.filter((item) => item.path === '/api/v1/me/checkout/quote');
      expect(quoted.at(-1)?.query.get('promocode')).toBe('NOPE');
      await page.click(buttonNamed(page.container, 'Купить с баланса'));
      const bought = page.requests.find((item) => item.path === '/api/v1/me/invoices');
      expect(bought?.body).toEqual({ kind: 'purchase', planId: 'p1' });
    } finally {
      await page.unmount();
    }
  });

  it('sends a promocode the quote applied with the purchase', async () => {
    const page = await mountPage(PlansClientSelected, {
      '/api/v1/public/plans': { body: plans },
      '/api/v1/me/promocodes/preview': { body: { discountMinor: 5980, finalMinor: 23920 } },
      '/api/v1/me/checkout/quote': {
        body: quote({
          discountMinor: 5980,
          toPayMinor: 23920,
          promocode: { code: 'SALE20', applied: true },
        }),
      },
      '/api/v1/me/payment-methods': { body: { items: [] } },
      '/api/v1/me/invoices': { status: 409, body: { error: { code: 'INSUFFICIENT_FUNDS' } } },
    });
    try {
      await page.type(page.container.querySelector('#promocode'), 'sale20');
      await page.click(buttonNamed(page.container, 'Применить'));
      await page.click(buttonNamed(page.container, 'Купить с баланса'));
      const bought = page.requests.find((item) => item.path === '/api/v1/me/invoices');
      expect(bought?.body).toEqual({ kind: 'purchase', planId: 'p1', promocode: 'SALE20' });
    } finally {
      await page.unmount();
    }
  });

  it('applies a trimmed promocode, and none shorter than three characters', async () => {
    const page = await mountPage(PlansClientSelected, {
      '/api/v1/public/plans': { body: plans },
      '/api/v1/me/promocodes/preview': { body: { discountMinor: 5980, finalMinor: 23920 } },
      '/api/v1/me/checkout/quote': { body: quote() },
      '/api/v1/me/payment-methods': { body: { items: [] } },
    });
    try {
      const input = page.container.querySelector('#promocode');
      await page.type(input, ' ab ');
      expect(buttonNamed(page.container, 'Применить')?.hasAttribute('disabled')).toBe(true);
      await page.type(input, '  sale20 ');
      await page.click(buttonNamed(page.container, 'Применить'));
      const previewed = page.requests.find((item) => item.path === '/api/v1/me/promocodes/preview');
      expect(previewed?.body).toEqual({ code: 'SALE20', planId: 'p1' });
      const quoted = page.requests.filter((item) => item.path === '/api/v1/me/checkout/quote');
      expect(quoted.at(-1)?.query.get('promocode')).toBe('SALE20');
      expect(page.container.querySelector('[data-testid="checkout"]')).not.toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
