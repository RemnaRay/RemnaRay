import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '../settings/settings.service';
import { sessionRequestLimit, sessionTracker } from './auth.module';
import { WebhookThrottlerGuard } from './webhook-throttler.guard';

/** A counting store, like the Valkey one: blocked past the limit. */
function memoryStorage() {
  const hits = new Map<string, number>();
  // A standalone spy, so the assertions do not read it off the storage.
  const increment = vi.fn((key: string, ttl: number, limit: number) => {
    const totalHits = (hits.get(key) ?? 0) + 1;
    hits.set(key, totalHits);
    return Promise.resolve({
      totalHits,
      timeToExpire: ttl / 1000,
      isBlocked: totalHits > limit,
      timeToBlockExpire: totalHits > limit ? 60 : -1,
    });
  });
  return { storage: { increment } as ThrottlerStorage, increment };
}

const settings = {
  get: (key: string) =>
    Promise.resolve(
      {
        'bot.webhook_secret_path': 'real-path',
        'bot.webhook_secret_token': 'real-token',
        'bot.support_token': '',
      }[key] ?? '',
    ),
} as unknown as SettingsService;

function guard(storage: ThrottlerStorage) {
  const instance = new WebhookThrottlerGuard(
    {
      throttlers: [{ name: 'default', ttl: 60_000, limit: sessionRequestLimit }],
      getTracker: sessionTracker,
    },
    storage,
    new Reflector(),
    settings,
  );
  return instance;
}

function request(url: string, ip: string, token?: string): ExecutionContext {
  const req = {
    url,
    ip,
    routeOptions: { url: undefined },
    headers: token === undefined ? {} : { 'x-telegram-bot-api-secret-token': token },
  };
  const res = { header: vi.fn() };
  return {
    getHandler: () => request,
    getClass: () => WebhookThrottlerGuard,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('webhook throttling (P-2)', () => {
  it('refuses a forged Telegram webhook before it counts against any bucket', async () => {
    const { storage, increment } = memoryStorage();
    const throttler = guard(storage);
    await throttler.onModuleInit();

    await expect(
      throttler.canActivate(request('/tg/webhook/real-path', '203.0.113.9', 'wrong')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      throttler.canActivate(request('/tg/webhook/guess', '203.0.113.9', 'real-token')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      throttler.canActivate(request('/tg/webhook/%E0%A4%A', '203.0.113.9', 'real-token')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(increment).not.toHaveBeenCalled();

    await expect(
      throttler.canActivate(request('/tg/webhook/real-path', '149.154.167.1', 'real-token')),
    ).resolves.toBe(true);
    expect(increment).toHaveBeenCalledTimes(1);
  });

  it('keeps a provider`s own address open while another floods its webhook', async () => {
    const { storage } = memoryStorage();
    const throttler = guard(storage);
    await throttler.onModuleInit();

    for (let attempt = 0; attempt < 601; attempt += 1)
      await throttler.canActivate(request('/webhooks/yookassa', '203.0.113.9')).catch(() => false);
    await expect(
      throttler.canActivate(request('/webhooks/yookassa', '203.0.113.9')),
    ).rejects.toMatchObject({ status: 429 });

    await expect(throttler.canActivate(request('/webhooks/yookassa', '185.71.76.1'))).resolves.toBe(
      true,
    );
  });
});
