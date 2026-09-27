import { randomBytes } from 'node:crypto';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signJwt } from './auth.crypto';
import { AuthGuard } from './auth.guards';
import { AuthService } from './auth.service';

const APP_KEY = randomBytes(32).toString('base64');

function harness() {
  const claimed = new Set<string>();
  const sessions = {
    create: vi.fn().mockResolvedValue('session-1'),
    get: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
    claimOnce: (key: string) => {
      if (claimed.has(key)) return Promise.resolve(false);
      claimed.add(key);
      return Promise.resolve(true);
    },
    isClaimed: (key: string) => Promise.resolve(claimed.has(key)),
  };
  const users = {
    upsert: vi.fn().mockResolvedValue({ user: { id: 'user-1', telegramId: '42' } }),
    summary: vi.fn().mockResolvedValue({
      id: 'user-1',
      telegramId: '42',
      firstName: 'Ann',
      username: 'ann',
      language: 'ru',
      referralCode: 'ABCD2345',
      isBanned: false,
    }),
  };
  const service = new AuthService({ get: vi.fn() } as never, users as never, sessions, APP_KEY);
  return { service, sessions, users };
}

describe('the bot`s account link (R79, L-3; owner decision О-9)', () => {
  it('signs in once: the same link cannot open a second session', async () => {
    const { service, sessions } = harness();
    const { token } = await service.issueBotToken({ telegramId: 42 });

    await expect(service.exchangeJwt({ token })).resolves.toBe('session-1');
    await expect(service.exchangeJwt({ token })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('names the account it opens without spending the link', async () => {
    const { service } = harness();
    const { token } = await service.issueBotToken({ telegramId: 42 });

    await expect(service.previewJwt({ token })).resolves.toEqual({
      user: { firstName: 'Ann', username: 'ann' },
    });
    await expect(service.previewJwt({ token })).resolves.toBeDefined();
    await service.exchangeJwt({ token });
    await expect(service.previewJwt({ token })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('the customer API takes no Bearer token (R79, О-9)', () => {
  const previous = process.env.RR_APP_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.RR_APP_KEY;
    else process.env.RR_APP_KEY = previous;
  });

  it('refuses /api/v1/me with a valid link token and no session', async () => {
    process.env.RR_APP_KEY = APP_KEY;
    const guard = new AuthGuard({
      redis: { getex: () => Promise.resolve(null) },
      db: { user: { findUnique: () => Promise.resolve({ id: 'user-1', isBanned: false }) } },
    } as never);
    const request = {
      url: '/api/v1/me',
      routeOptions: { url: '/api/v1/me' },
      headers: { authorization: `Bearer ${signJwt('user-1', APP_KEY)}` },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
