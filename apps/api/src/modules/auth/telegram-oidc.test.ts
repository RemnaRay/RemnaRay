import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  TELEGRAM_OIDC_ISSUER,
  TelegramOidcVerifier,
  checkNonce,
  issueNonce,
} from './telegram-oidc';

const APP_KEY = randomBytes(32).toString('base64');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = {
  keys: [
    { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'oidc-1', alg: 'RS256' },
    { ...ec.publicKey.export({ format: 'jwk' }), kid: 'oidc-es256-1', alg: 'ES256' },
  ],
};

function token(
  claims: Record<string, unknown>,
  options: { alg?: 'RS256' | 'ES256'; kid?: string; key?: KeyObject } = {},
): string {
  const alg = options.alg ?? 'RS256';
  const header = Buffer.from(
    JSON.stringify({ alg, kid: options.kid ?? (alg === 'RS256' ? 'oidc-1' : 'oidc-es256-1') }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = options.key ?? (alg === 'RS256' ? rsa.privateKey : ec.privateKey);
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const now = 1_800_000_000;
const good = (overrides: Record<string, unknown> = {}) => ({
  iss: TELEGRAM_OIDC_ISSUER,
  aud: '8521897198',
  sub: '1234123412341234123',
  iat: now - 10,
  exp: now + 3600,
  nonce: 'n-1',
  // As a live token carries it (2026-09-26): a string of digits.
  id: '987654321',
  name: 'John Doe',
  given_name: 'John',
  preferred_username: 'johndoe',
  ...overrides,
});

function verifier() {
  const fetchImpl = vi.fn(() => Promise.resolve(Response.json(jwks)));
  return { fetchImpl, instance: new TelegramOidcVerifier('http://oauth.test', fetchImpl) };
}
const expected = { clientId: '8521897198', nonce: 'n-1' };

describe('Telegram OIDC id_token (core.telegram.org/widgets/login)', () => {
  it('accepts a token Telegram signed, with RS256 or ES256, and returns the user', async () => {
    const { instance, fetchImpl } = verifier();
    await expect(instance.verify(token(good()), expected, now)).resolves.toEqual({
      id: 987654321,
      name: 'John Doe',
      given_name: 'John',
      preferred_username: 'johndoe',
    });
    await expect(
      instance.verify(token(good({ id: 987654321 }), { alg: 'ES256' }), expected, now),
    ).resolves.toMatchObject({ id: 987654321 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([
      'http://oauth.test/.well-known/jwks.json',
      expect.anything(),
    ]);
  });

  it.each([
    [
      'signed by another key',
      () => token(good(), { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
      'signature',
    ],
    ['issued by someone else', () => token(good({ iss: 'https://evil.example' })), 'iss'],
    ['for another bot', () => token(good({ aud: '1111' })), 'aud 1111 is not the bot 8521897198'],
    ['for another browser', () => token(good({ nonce: 'n-2' })), 'nonce'],
    ['without the Telegram id', () => token(good({ id: undefined })), 'id'],
    ['with an id that is not digits', () => token(good({ id: '12a' })), 'id'],
    ['with an id past a safe integer', () => token(good({ id: '90071992547409930' })), 'id'],
    ['with an unknown key id', () => token(good(), { kid: 'nope' }), 'unknown key id nope'],
    [
      'tampered with',
      () =>
        token(good()).replace(
          /\.[^.]+\./u,
          `.${Buffer.from(JSON.stringify(good({ id: 1 }))).toString('base64url')}.`,
        ),
      'signature',
    ],
  ])('refuses a token %s, saying which check', async (_name, build, reason) => {
    await expect(verifier().instance.verify(build(), expected, now)).rejects.toMatchObject({
      code: 'AUTH_INVALID_SIGNATURE',
      reason,
    });
  });

  // L-6: the key id is read before the signature is checked, so every
  // made-up `kid` used to fetch Telegram's JWKS again — a request anybody
  // could multiply at the sign-in rate.
  it('reloads the keys for an unknown key id at most once a minute, once for concurrent requests', async () => {
    vi.useFakeTimers({ now: now * 1000 });
    try {
      const { instance, fetchImpl } = verifier();
      await Promise.all(
        Array.from({ length: 5 }, () => instance.verify(token(good()), expected, now)),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 20; attempt += 1)
        await expect(
          instance.verify(token(good(), { kid: `made-up-${String(attempt)}` }), expected, now),
        ).rejects.toMatchObject({ reason: `unknown key id made-up-${String(attempt)}` });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // A key Telegram rotated in is found once the minute has passed.
      vi.setSystemTime((now + 61) * 1000);
      await expect(
        instance.verify(token(good(), { kid: 'made-up-0' }), expected, now + 61),
      ).rejects.toMatchObject({ reason: 'unknown key id made-up-0' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an expired token as AUTH_EXPIRED', async () => {
    await expect(
      verifier().instance.verify(token(good({ exp: now - 120 })), expected, now),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('answers AUTH_UNAVAILABLE when the keys cannot be read', async () => {
    const instance = new TelegramOidcVerifier('http://oauth.test', () =>
      Promise.resolve(new Response('down', { status: 503 })),
    );
    await expect(instance.verify(token(good()), expected, now)).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });
});

describe('the login nonce', () => {
  it('is ours, unexpired and unforgeable', () => {
    const issued = issueNonce(APP_KEY, now * 1000);
    expect(checkNonce(APP_KEY, issued, now * 1000)).toBe(issued.split('.')[0]);
    expect(checkNonce(APP_KEY, issued, (now + 601) * 1000)).toBeNull();
    expect(checkNonce(randomBytes(32).toString('base64'), issued, now * 1000)).toBeNull();
    const [random, , mac] = issued.split('.');
    expect(
      checkNonce(APP_KEY, `${String(random)}.${String(now + 99_999)}.${String(mac)}`, now * 1000),
    ).toBeNull();
  });
});
