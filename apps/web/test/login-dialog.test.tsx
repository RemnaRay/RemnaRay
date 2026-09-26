import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const LoginDialog = (await import('../app/[locale]/login-dialog')).default;

const labels = {
  trigger: 'Войти',
  title: 'Вход в личный кабинет',
  description: 'Подтвердите вход в окне Telegram.',
  button: 'Войти через Telegram',
  error: 'Ошибка входа',
  unavailable: 'Вход не настроен',
};

async function mount(path: string, openOnLoginQuery: boolean) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', path);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<LoginDialog labels={labels} locale="ru" openOnLoginQuery={openOnLoginQuery} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    dialog: () => document.querySelector('[role="dialog"]'),
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

describe('the landing sign-in dialog (F33)', () => {
  it('opens from «Войти» with the Telegram button, and closes', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ clientId: '8521897198', nonce: 'n.1.m' }));
    const page = await mount('/ru', false);
    try {
      expect(page.dialog()).toBeNull();
      // The nonce is asked for only once the dialog opens.
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await act(async () => {
        page.container.querySelector('button')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(page.dialog()?.textContent).toContain('Вход в личный кабинет');
      expect(page.dialog()?.querySelector('#login button')?.textContent).toBe(
        'Войти через Telegram',
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v1/auth/telegram/nonce',
        expect.objectContaining({ credentials: 'include' }),
      );
    } finally {
      await page.unmount();
      globalThis.fetch = previousFetch;
    }
  });

  it('opens by itself on /?login=1, where the account sends a visitor, and forgets it on close', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ clientId: '8521897198', nonce: 'n.1.m' }));
    const page = await mount('/ru?login=1', true);
    try {
      expect(page.dialog()).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(page.dialog()).toBeNull();
      expect(window.location.search).toBe('');
    } finally {
      await page.unmount();
      globalThis.fetch = previousFetch;
    }
  });

  it('stays closed on /?login=1 where it is not the page’s own', async () => {
    const page = await mount('/ru?login=1', false);
    try {
      expect(page.dialog()).toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
