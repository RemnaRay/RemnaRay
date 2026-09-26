import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { MockRoute } from '../test-utils/render-page';

const navigationRouter = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

/**
 * A real anchor, unlike the pass-through mock the page tests use: these
 * assertions are about the markup a link renders (NFR-010).
 */
vi.mock('../i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => '/account',
  useRouter: () => navigationRouter,
  redirect: () => undefined,
  getPathname: () => '/account',
}));

vi.mock('next/script', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const { renderPage } = await import('../test-utils/render-page');
const SubscriptionClient = (await import('../app/[locale]/account/subscription-client')).default;
const LoginWidget = (await import('../app/[locale]/login-widget')).default;

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

const routes: Record<string, MockRoute> = {
  '/api/v1/me': { body: userMe },
  '/api/v1/me/subscription': { body: { subscription: null, panel: null, clients: [] } },
};

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('accessibility invariants', () => {
  it('styles links as buttons instead of nesting one inside the other', async () => {
    const document_ = parse(await renderPage(SubscriptionClient, routes));

    expect(document_.querySelectorAll('a button, button a')).toHaveLength(0);
    const link = document_.querySelector('a[href="/account/plans"]');
    expect(link?.className).toContain('inline-flex');
  });

  it("names the login group and loads Telegram's OIDC login library once", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ clientId: '8521897198', nonce: 'n.1.m' }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <LoginWidget errorLabel="Ошибка входа" label="Войти" locale="ru" unavailableLabel="—" />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const host = container.querySelector('#login');
      expect(host?.getAttribute('role')).toBe('group');
      expect(host?.getAttribute('aria-label')).toBe('Войти');
      expect(
        document.head.querySelectorAll(
          'script[src="https://oauth.telegram.org/js/telegram-login.js?6"]',
        ),
      ).toHaveLength(1);
      // The nonce is asked for before the button is pressed: the popup must
      // open inside the click, which an awaited request would break.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v1/auth/telegram/nonce',
        expect.objectContaining({ credentials: 'include' }),
      );
      expect(host?.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      globalThis.fetch = previousFetch;
    }
  });

  it('only navigates after the Telegram auth endpoint accepts the callback', async () => {
    const previousFetch = globalThis.fetch;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      navigationRouter.replace.mockClear();
      globalThis.fetch = vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/v1/auth/telegram/nonce'
            ? Response.json({ clientId: '8521897198', nonce: 'n.1.m' })
            : new Response(null, { status: 401 }),
        ),
      ) as unknown as typeof fetch;
      await act(async () => {
        root.render(
          <LoginWidget errorLabel="Ошибка входа" label="Войти" locale="ru" unavailableLabel="—" />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        window.onRemnaRayTelegramOidc?.({ id_token: 'a.b.c' });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(navigationRouter.replace).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Ошибка входа');
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      globalThis.fetch = previousFetch;
    }
  });
});
