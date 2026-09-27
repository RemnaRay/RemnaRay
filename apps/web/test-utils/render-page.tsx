import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import { namespaces, readNamespace } from '@remnaray/i18n-core';
import { ToastProvider } from '@remnaray/ui';

import { localeRoot } from '../i18n/messages';
import { invalidate } from '../lib/resource';

export type MockRoute = { status?: number; body?: unknown; pending?: boolean };

export function messagesFor(locale: 'ru'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    for (const [key, value] of Object.entries(readNamespace(localeRoot, locale, namespace))) {
      const parts = key.split('.');
      let cursor = result;
      for (const part of parts.slice(0, -1)) {
        const next = cursor[part];
        if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      const last = parts.at(-1);
      if (last) cursor[last] = parse(value);
    }
  }
  return result;
}

function parse(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Renders an account page against a mocked API, the way AC-133 requires: no
 * Storybook, the real component tree, and the three states driven by what the
 * API answers.
 */
export async function renderPage(
  Component: ComponentType<{ locale: 'ru' }>,
  routes: Record<string, MockRoute>,
): Promise<string> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invalidate();
  const container = document.createElement('div');
  document.body.append(container);

  const previousFetch = globalThis.fetch;
  const mockFetch: typeof fetch = (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const route = routes[url.pathname];
    if (!route) return Promise.reject(new Error(`unexpected request ${url.pathname}`));
    if (route.pending) return new Promise<Response>(() => undefined);
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  globalThis.fetch = mockFetch;

  const root = createRoot(container);
  const tree: ReactNode = (
    <NextIntlClientProvider locale="ru" messages={messagesFor('ru')}>
      <ToastProvider>
        <Component locale="ru" />
      </ToastProvider>
    </NextIntlClientProvider>
  );

  try {
    await act(async () => {
      root.render(tree);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container.innerHTML;
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    globalThis.fetch = previousFetch;
  }
}
