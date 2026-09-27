import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { issueNonce, type TelegramOidcVerifier } from './telegram-oidc';

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
    upsert: vi.fn().mockResolvedValue({ user: { id: 'user-1', telegramId: '987654321' } }),
  };
  const verify = vi.fn().mockResolvedValue({
    id: 987654321,
    given_name: 'John',
    preferred_username: 'johndoe',
  });
  const service = new AuthService(
    { get: () => Promise.resolve('8521897198:secret') } as never,
    users as never,
    sessions,
    APP_KEY,
    { verify } as unknown as TelegramOidcVerifier,
  );
  return { service, users, sessions, verify };
}

describe('AuthService Telegram OIDC sign-in', () => {
  it('signs in the user the token names, for the bot it was issued to', async () => {
    const { service, users, verify } = harness();
    const nonce = issueNonce(APP_KEY);

    await expect(
      service.authenticateTelegramOidc({ idToken: 'x'.repeat(40) }, nonce, {
        referralCode: 'AB12CD34',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-1' });

    expect(await service.telegramClientId()).toBe('8521897198');
    expect(verify).toHaveBeenCalledWith('x'.repeat(40), { clientId: '8521897198', nonce });
    expect(users.upsert).toHaveBeenCalledWith({
      telegramId: '987654321',
      firstName: 'John',
      username: 'johndoe',
      startPayload: 'ref_AB12CD34',
    });
  });

  it('refuses without this browser’s nonce, with a forged one, and a nonce used before', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = harness();
    const body = { idToken: 'x'.repeat(40) };
    await expect(service.authenticateTelegramOidc(body, undefined)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      reason: 'no nonce cookie',
    });
    await expect(service.authenticateTelegramOidc(body, 'a.1.b')).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      reason: 'nonce cookie',
    });
    const nonce = issueNonce(APP_KEY);
    await service.authenticateTelegramOidc(body, nonce);
    await expect(service.authenticateTelegramOidc(body, nonce)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      reason: 'nonce already used',
    });
    // F34: the log names the check, which the answer does not.
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      'Telegram OIDC sign-in refused: AUTH_EXPIRED (no nonce cookie)',
      'Telegram OIDC sign-in refused: AUTH_EXPIRED (nonce cookie)',
      'Telegram OIDC sign-in refused: AUTH_EXPIRED (nonce already used)',
    ]);
    warn.mockRestore();
  });
});
