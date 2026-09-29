import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MockRoute } from '../test-utils/render-page';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: vi.fn(), replace }),
}));

const { renderPage } = await import('../test-utils/render-page');
const DashboardClient = (await import('../app/admin/dashboard-client')).default;
const UsersClient = (await import('../app/admin/users/users-client')).default;
const PlansClient = (await import('../app/admin/plans/plans-client')).default;
const SettingsClient = (await import('../app/admin/settings/settings-client')).default;
const PaymentsClient = (await import('../app/admin/payments/payments-client')).default;
const { SupportTab } = await import('../app/admin/settings/support-tab');
const SupportTabForTest = () => <SupportTab fail={() => undefined} notify={() => undefined} />;
const AdminShell = (await import('../app/admin/admin-shell')).AdminShell;
const AdminShellForTest = ({ locale }: { locale: 'ru' }) => (
  <AdminShell>{() => <span data-locale={locale}>admin shell</span>}</AdminShell>
);

function session(role: 'admin' | 'operator'): MockRoute {
  const admin = {
    id: 'admin-1',
    email: 'owner@example.test',
    role,
    telegramId: null,
    permissions:
      role === 'admin'
        ? [
            'dashboard.read',
            'users.read',
            'users.mutate',
            'plans.read',
            'plans.write',
            'payments.read',
            'subscriptions.read',
            'subscriptions.bulk',
          ]
        : [
            'dashboard.read',
            'users.read',
            'users.mutate',
            'plans.read',
            'payments.read',
            'subscriptions.read',
          ],
  };
  return { body: { admin, csrfToken: 'csrf-1' } };
}

const overview = {
  range: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
  receipts: { amountMinor: 99800, currency: 'RUB' },
  sales: { amountMinor: 79700, currency: 'RUB' },
  payments: 3,
  averagePayment: { amountMinor: 33266, currency: 'RUB' },
  newUsers: 5,
  trialsIssued: 2,
  trialConversionPercent: 50,
  activeSubscriptions: 2,
  expiringInThreeDays: 1,
  userBalanceLiability: { amountMinor: 10000, currency: 'RUB' },
  referralRewards: { amountMinor: 5980, currency: 'RUB' },
  topProviders: [{ provider: 'mock', total: { amountMinor: 59800, currency: 'RUB' }, payments: 2 }],
};

const series = {
  receipts: [{ day: '2026-08-31', amountMinor: 99800 }],
  registrations: [{ day: '2026-08-31', count: 5 }],
};

const attention = {
  provisioningFailed: 1,
  stuckJobs: 0,
  panelLastSyncedAt: null,
};

function dashboardRoutes(role: 'admin' | 'operator' = 'admin'): Record<string, MockRoute> {
  return {
    '/api/admin/v1/auth/me': session(role),
    '/api/admin/v1/dashboard': { body: overview },
    '/api/admin/v1/dashboard/series': { body: series },
    '/api/admin/v1/dashboard/attention': { body: attention },
  };
}

const render = (component: ComponentType<{ locale: 'ru' }>, routes: Record<string, MockRoute>) =>
  renderPage(component, routes);

describe('admin pages', () => {
  it('does not redirect to login when the existing admin session is rate limited', async () => {
    const markup = await renderPage(AdminShellForTest, {
      '/api/admin/v1/auth/me': {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', requestId: 'req-429' } },
      },
    });

    expect(markup).toContain('Не удалось загрузить данные');
    expect(replace).not.toHaveBeenCalledWith('/admin/login');
  });

  it('shows the support bot by its username, never a token field filled in (F35)', async () => {
    const set = await render(SupportTabForTest, {
      '/api/admin/v1/bot/support': {
        body: {
          contact: '@manta_help',
          chatId: -100500,
          supportBot: { username: 'manta_help_bot' },
        },
      },
    });
    expect(set).toContain('Задан: @manta_help_bot');
    expect(set).toContain('value="-100500"');
    expect(set).toContain('Отключить бот поддержки');
    expect(set).not.toMatch(/id="support-bot-token"[^>]*value="[^"]+"/u);

    const unset = await render(SupportTabForTest, {
      '/api/admin/v1/bot/support': {
        body: { contact: '', chatId: null, supportBot: null },
      },
    });
    expect(unset).toContain('Не задан — поддержка в основном боте');
    expect(unset).not.toContain('Отключить бот поддержки');
  });

  it('names a balance payment and invoice statuses in words (F32)', async () => {
    const markup = await render(PaymentsClient, {
      '/api/admin/v1/auth/me': session('admin'),
      '/api/admin/v1/invoices': {
        body: {
          items: [
            {
              id: 'inv-1',
              number: '01-00150',
              kind: 'topup',
              status: 'paid',
              provider: 'balance',
              amount: { amountMinor: 29900, currency: 'RUB' },
              createdAt: '2026-09-26T17:53:22.000Z',
            },
          ],
          nextCursor: null,
        },
      },
      '/api/admin/v1/transactions': { body: { items: [], nextCursor: null } },
    });

    expect(markup).toContain('01-00150');
    expect(markup).toContain('Пополнение');
    expect(markup).toContain('С баланса');
    expect(markup).toContain('Оплачен');
    expect(markup).not.toContain('>balance<');
  });

  it('renders the FR-142 dashboard widgets and both charts', async () => {
    const markup = await render(DashboardClient, dashboardRoutes());

    expect(markup).toContain('data-state="ready"');
    expect(markup).toContain('Поступления');
    expect(markup).toContain('Продажи');
    expect(markup).not.toContain('Оплаты просроченных счетов');
    expect(markup).toContain('Конверсия триал → оплата');
    expect(markup).toContain('50%');
    expect(markup).toContain('Поступления по дням');
    expect(markup).toContain('Регистрации по дням');
    expect(markup).toContain('Требует внимания');
  });

  it('shows the dashboard error state with the request id', async () => {
    const markup = await render(DashboardClient, {
      ...dashboardRoutes(),
      '/api/admin/v1/dashboard': {
        status: 503,
        body: { error: { code: 'PANEL_UNAVAILABLE', requestId: 'req-11' } },
      },
    });

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('req-11');
  });

  it('hides sections an operator may not reach (section 14.2)', async () => {
    const adminMarkup = await render(DashboardClient, dashboardRoutes('admin'));
    const operatorMarkup = await render(DashboardClient, dashboardRoutes('operator'));

    expect(adminMarkup).toContain('href="/admin/plans"');
    expect(operatorMarkup).toContain('href="/admin/users"');
    expect(operatorMarkup).toContain('href="/admin/plans"');
    expect(operatorMarkup).toContain('operator');
  });

  it('renders the AC-140 user list with search filters', async () => {
    const markup = await render(UsersClient, {
      '/api/admin/v1/auth/me': session('admin'),
      '/api/admin/v1/users': {
        body: {
          items: [
            {
              id: 'user-1',
              telegramId: 123,
              username: 'mantafan',
              firstName: 'Manta',
              isBanned: false,
              anonymizedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              subscriptionStatus: 'active',
              expiresAt: '2026-03-01T00:00:00.000Z',
              balance: { amountMinor: 29900, currency: 'RUB' },
            },
          ],
          nextCursor: null,
        },
      },
    });

    expect(markup).toContain('mantafan');
    expect(markup).toContain('Telegram ID');
    expect(markup).toContain('href="/admin/users/user-1"');
  });

  it('offers plan editing to an admin and read-only to an operator', async () => {
    const plans = {
      body: [
        {
          id: 'plan-1',
          slug: 'month',
          name: { ru: 'Месяц', en: 'Month' },
          durationDays: 30,
          trafficLimitBytes: 0,
          deviceLimit: 3,
          price: { amountMinor: 29900, currency: 'RUB' },
          isPublic: true,
          isActive: true,
          sortOrder: 10,
        },
      ],
    };
    const adminMarkup = await render(PlansClient, {
      '/api/admin/v1/auth/me': session('admin'),
      '/api/admin/v1/plans': plans,
    });
    const operatorMarkup = await render(PlansClient, {
      '/api/admin/v1/auth/me': session('operator'),
      '/api/admin/v1/plans': plans,
    });

    expect(adminMarkup).toContain('Создать тариф');
    expect(adminMarkup).toContain('Удалить');
    expect(operatorMarkup).not.toContain('Создать тариф');
    expect(operatorMarkup).not.toContain('Удалить');
  });

  it('offers the section 9.8 webhook recipients among the settings, secret unshown', async () => {
    const property = (description: string, secret: boolean) => ({
      title: description,
      description,
      default: null,
      'x-secret': secret,
    });
    const markup = await render(SettingsClient, {
      '/api/admin/v1/auth/me': session('admin'),
      '/api/admin/v1/settings/schema': {
        body: {
          version: 1,
          type: 'object',
          properties: {
            'brand.name': property('Store name.', false),
            'webhooks.outgoing': property('Outgoing webhook destinations.', true),
          },
        },
      },
      '/api/admin/v1/settings': {
        body: { 'brand.name': 'Manta', 'webhooks.outgoing': { set: true } },
      },
      '/api/admin/v1/providers': { body: { items: [] } },
      '/api/admin/v1/themes': { body: { items: [], active: 'default' } },
    });

    expect(markup).toContain('id="webhooks.outgoing"');
    expect(markup).not.toContain('[object Object]');
    expect(markup).toContain('Outgoing webhook destinations.');
  });
});
