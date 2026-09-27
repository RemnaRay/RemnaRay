import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
vi.mock('../i18n/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  Link: ({ children }: { children: unknown }) => children,
}));

const { messagesFor } = await import('../test-utils/render-page');
const BotSignIn = (await import('../app/[locale]/auth/tg/bot-sign-in')).default;

type Call = { url: string; init: RequestInit | undefined };

async function mount(fragment: string, answers: Record<string, Response>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', `/ru/auth/tg${fragment}`);
  const calls: Call[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(answers[url]?.clone() ?? new Response(null, { status: 500 }));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ru" messages={messagesFor('ru')}>
        <BotSignIn locale="ru" />
      </NextIntlClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    calls,
    async click(name: string) {
      const button = [...container.querySelectorAll('button')].find(
        (item) => item.textContent === name,
      );
      if (!button) throw new Error(`no button ${name}: ${container.textContent}`);
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

const preview = () =>
  Response.json({ user: { firstName: 'Анна', username: 'anna' } }, { status: 200 });

describe('the bot`s account link asks before it signs in (L-3, R79)', () => {
  const previousFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = previousFetch;
    replace.mockReset();
  });

  it('names the account and signs in only on the button', async () => {
    const page = await mount('#jwt.token', {
      '/api/v1/auth/tg/preview': preview(),
      '/api/v1/auth/tg': new Response(null, { status: 204 }),
    });
    try {
      expect(page.container.textContent).toContain('Войти как Анна (@anna)?');
      expect(page.calls.map((call) => call.url)).toEqual(['/api/v1/auth/tg/preview']);
      // The token leaves the address bar and the history.
      expect(window.location.hash).toBe('');
      expect(replace).not.toHaveBeenCalled();

      await page.click('Войти');

      const exchange = page.calls.find((call) => call.url === '/api/v1/auth/tg');
      expect(exchange?.init?.method).toBe('POST');
      expect(exchange?.init?.body).toBe(JSON.stringify({ token: 'jwt.token' }));
      expect(exchange?.init?.headers).toMatchObject({ 'X-Requested-With': 'RemnaRay' });
      expect(replace).toHaveBeenCalledWith('/account', { locale: 'ru' });
    } finally {
      await page.unmount();
    }
  });

  it('says a spent or broken link is no good, and offers nothing to press', async () => {
    const page = await mount('#jwt.used', {
      '/api/v1/auth/tg/preview': Response.json(
        { error: { code: 'UNAUTHENTICATED' } },
        { status: 401 },
      ),
    });
    try {
      expect(page.container.textContent).toContain('Ссылка недействительна или уже использована');
      expect([...page.container.querySelectorAll('button')]).toHaveLength(0);
    } finally {
      await page.unmount();
    }
  });

  it('asks nothing without a token', async () => {
    const page = await mount('', {});
    try {
      expect(page.calls).toHaveLength(0);
      expect(page.container.textContent).toContain('Ссылка недействительна или уже использована');
    } finally {
      await page.unmount();
    }
  });
});
