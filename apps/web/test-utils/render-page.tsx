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

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};

/**
 * Renders an account page against a mocked API, the way AC-133 requires: no
 * Storybook, the real component tree, and the three states driven by what the
 * API answers.
 */
export async function renderPage(
  Component: ComponentType<{ locale: 'ru' }>,
  routes: Record<string, MockRoute>,
): Promise<string> {
  const page = await mountPage(Component, routes);
  try {
    return page.container.innerHTML;
  } finally {
    await page.unmount();
  }
}

/**
 * `renderPage` that stays mounted: a test clicks and types through `act`,
 * reads what the page sent from `requests`, and unmounts it itself.
 */
export async function mountPage(
  Component: ComponentType<{ locale: 'ru' }>,
  routes: Record<string, MockRoute>,
): Promise<{
  container: HTMLElement;
  requests: RecordedRequest[];
  click: (element: Element | null | undefined) => Promise<void>;
  type: (element: Element | null | undefined, value: string) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invalidate();
  const container = document.createElement('div');
  document.body.append(container);

  const requests: RecordedRequest[] = [];
  const previousFetch = globalThis.fetch;
  const mockFetch: typeof fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
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

  const settle = async () => {
    for (let round = 0; round < 3; round += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };

  await act(async () => {
    root.render(tree);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    requests,
    async click(element) {
      if (!(element instanceof HTMLElement)) throw new Error('nothing to click');
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
      await settle();
    },
    async type(element, value) {
      if (!(element instanceof HTMLInputElement)) throw new Error('no input to type into');
      // React tracks the value it set; the prototype setter makes the change visible to it.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        element,
        value,
      );
      await act(async () => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      globalThis.fetch = previousFetch;
    },
  };
}
