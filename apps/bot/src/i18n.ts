import {
  formatMessage,
  formatPlainMessage,
  SUPPORTED_LOCALES,
  type Locale,
} from '@remnaray/i18n-core';
import type { Middleware } from 'grammy';

import type { ApiClient } from './api-client.js';
import type { RrContext } from './types.js';

type CachedCatalog = { expiresAt: number; messages: Record<string, string> };

export class BotI18n {
  private readonly cache = new Map<Locale, CachedCatalog>();

  constructor(
    private readonly api: ApiClient,
    private readonly ttlMs = 60_000,
  ) {}

  /** Section 18.5: `rr:i18n.changed` drops the cache before the 60 s TTL. */
  invalidate(): void {
    this.cache.clear();
  }

  async catalog(locale: Locale): Promise<Record<string, string>> {
    const cached = this.cache.get(locale);
    if (cached && cached.expiresAt > Date.now()) return cached.messages;
    const response = await this.api.getMessages(locale);
    this.cache.set(locale, { expiresAt: Date.now() + this.ttlMs, messages: response.messages });
    return response.messages;
  }

  async bind(ctx: RrContext, locale: Locale): Promise<void> {
    const messages = await this.catalog(locale);
    ctx.locale = locale;
    ctx.messages = messages;
    ctx.t = (key, values = {}) => formatMessage(locale, messages, key, values);
    // Button labels are plain text: a plan named `A & B` must not show `A &amp; B`.
    ctx.tPlain = (key, values = {}) => formatPlainMessage(locale, messages, key, values);
  }

  middleware(): Middleware<RrContext> {
    return async (ctx, next) => {
      const locale = ctx.session.lang;
      await this.bind(ctx, locale);
      await next();
    };
  }
}

export function normalizeLocale(value: string | undefined): Locale | undefined {
  const normalized = value?.slice(0, 2).toLowerCase();
  return SUPPORTED_LOCALES.includes(normalized as Locale) ? (normalized as Locale) : undefined;
}
