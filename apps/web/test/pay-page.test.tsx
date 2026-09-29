import { describe, expect, it, vi } from 'vitest';

vi.mock('../i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
  usePathname: () => '/pay/inv-1',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  redirect: () => undefined,
  getPathname: () => '/pay/inv-1',
}));

const { renderPage } = await import('../test-utils/render-page');
const PayStatus = (await import('../app/[locale]/pay/[invoiceId]/pay-status')).default;

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    kind: 'purchase',
    status: 'pending',
    terminal: false,
    plan: null,
    provider: 'mock',
    amount: { amountMinor: 29900, currency: 'RUB' },
    discount: { amountMinor: 0, currency: 'RUB' },
    paymentUrl: 'https://pay.example.test/inv-1',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function page(body: unknown, status?: number) {
  const Component = ({ locale }: { locale: 'ru' }) => (
    <PayStatus botUsername="manta_bot" invoiceId="inv-1" locale={locale} />
  );
  return renderPage(Component, {
    '/api/v1/me/invoices/inv-1': status === undefined ? { body } : { body, status },
  });
}

describe('FR-134 / AC-134: payment page', () => {
  it('shows the status, amount, deadline and both actions while pending', async () => {
    const markup = await page(invoice());

    expect(markup).toContain('Ожидание оплаты');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toMatch(/\d{2}:\d{2}/u);
    expect(markup).toContain('Перейти к оплате');
    expect(markup).toContain('Проверить');
    expect(markup).toContain('Отменить');
  });

  it('sends Telegram Stars invoices to the bot instead of a payment page', async () => {
    const markup = await page(
      invoice({ provider: 'stars', paymentUrl: undefined, starsInvoiceLink: undefined }),
    );

    expect(markup).toContain('Оплатить в боте');
    expect(markup).toContain('https://t.me/manta_bot?start=inv_inv-1');
  });

  it('opens the bot even when the Stars invoice already carries its own link', async () => {
    const markup = await page(
      invoice({
        provider: 'stars',
        paymentUrl: undefined,
        starsInvoiceLink: 'https://t.me/$direct-invoice',
      }),
    );

    expect(markup).toContain('https://t.me/manta_bot?start=inv_inv-1');
    expect(markup).not.toContain('$direct-invoice');
  });

  it('stops offering the check action and links to the subscription once paid', async () => {
    const markup = await page(invoice({ status: 'paid', terminal: true }));

    expect(markup).toContain('Оплачено');
    expect(markup).not.toContain('Проверить');
    expect(markup).toContain('Перейти к подписке');
  });

  it('explains the balance credit for an expired invoice', async () => {
    const markup = await page(invoice({ status: 'expired', terminal: true }));

    expect(markup).toContain('Счёт истёк');
    expect(markup).toContain('деньги придут на баланс');
  });

  it('explains the balance credit for an underpaid invoice', async () => {
    const markup = await page(invoice({ status: 'underpaid', terminal: false }));

    expect(markup).toContain('Недоплата');
    expect(markup).toContain('зачислена на баланс');
  });

  it('shows the localized error state with the request id', async () => {
    const markup = await page({ error: { code: 'NOT_FOUND', requestId: 'req-9' } }, 404);

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('req-9');
    expect(markup).toContain('Запись не найдена');
  });

  it('shows the invoice number and offers the plan after a top-up for it (F37)', async () => {
    const markup = await renderPage(
      ({ locale }: { locale: 'ru' }) => (
        <PayStatus botUsername="manta_bot" invoiceId="inv-1" locale={locale} />
      ),
      {
        '/api/v1/me/invoices/inv-1': {
          body: invoice({
            kind: 'topup',
            status: 'paid',
            terminal: true,
            number: '01-00001',
            target: { planId: 'p1', planSlug: 'month', kind: 'purchase', promocode: null },
          }),
        },
        '/api/v1/me/checkout/quote': {
          body: {
            planId: 'p1',
            kind: 'purchase',
            priceMinor: 29900,
            discountMinor: 0,
            creditMinor: 0,
            toPayMinor: 29900,
            availableMinor: 29900,
            missingMinor: 0,
            topups: [],
            promocode: null,
          },
        },
        '/api/v1/me/payment-methods': { body: { items: [] } },
      },
    );
    expect(markup).toContain('Счёт #01-00001');
    expect(markup).toContain('Баланс пополнен');
    expect(markup).toContain('Купить с баланса за 299');
  });
});
