import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpException } from '@nestjs/common';

import type { TelegramWidgetInput } from './auth.schemas';

const JWT_ALGORITHM = 'HS256';

export class AuthFailure extends HttpException {
  constructor(
    readonly code:
      'AUTH_INVALID_SIGNATURE' | 'AUTH_EXPIRED' | 'AUTH_UNAVAILABLE' | 'UNAUTHENTICATED',
    status = code === 'AUTH_UNAVAILABLE' ? 503 : 401,
    /** Which check refused, for the log only; never sent to the client. */
    readonly reason?: string,
  ) {
    super({ error: { code, message: code } }, status);
  }
}

function keyFromAppKey(appKey: string): Buffer {
  const key = Buffer.from(appKey, 'base64');
  if (key.length !== 32) throw new Error('RR_APP_KEY must decode to 32 bytes');
  return key;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function telegramDataCheckString(input: TelegramWidgetInput): string {
  return Object.entries(input)
    .filter(([key]) => key !== 'hash' && input[key as keyof TelegramWidgetInput] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
}

export function verifyTelegramWidget(
  input: TelegramWidgetInput,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  const authDate = Number(input.auth_date);
  if (!Number.isSafeInteger(authDate) || nowSeconds - authDate > 300 || authDate > nowSeconds) {
    throw new AuthFailure('AUTH_EXPIRED');
  }

  const secretKey = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secretKey)
    .update(telegramDataCheckString(input))
    .digest('hex');
  const received = Buffer.from(input.hash, 'hex');
  const calculated = Buffer.from(expected, 'hex');
  if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) {
    throw new AuthFailure('AUTH_INVALID_SIGNATURE');
  }
}

/**
 * The bot's account link (section 9.2, 13.3). `jti` names this link, so the
 * exchange can spend it once (R79, owner decision О-9).
 */
export type JwtClaims = { sub: string; iat: number; exp: number; jti: string };

export function signJwt(
  subject: string,
  appKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: JWT_ALGORITHM, typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: subject,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      jti: randomBytes(16).toString('base64url'),
    }),
  );
  const content = `${header}.${payload}`;
  const signature = createHmac('sha256', keyFromAppKey(appKey)).update(content).digest();
  return `${content}.${base64Url(signature)}`;
}

export function verifyJwt(
  token: string,
  appKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): JwtClaims {
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new AuthFailure('UNAUTHENTICATED');
  const [headerValue, payloadValue, signatureValue] = token.split('.');
  if (!headerValue || !payloadValue || !signatureValue) throw new AuthFailure('UNAUTHENTICATED');
  const content = `${headerValue}.${payloadValue}`;
  const expected = createHmac('sha256', keyFromAppKey(appKey)).update(content).digest();
  const received = Buffer.from(signatureValue, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AuthFailure('UNAUTHENTICATED');
  }

  try {
    const header = JSON.parse(decodeBase64Url(headerValue)) as { alg?: string; typ?: string };
    const payload = JSON.parse(decodeBase64Url(payloadValue)) as Partial<JwtClaims>;
    if (
      header.alg !== JWT_ALGORITHM ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/u.test(payload.jti) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat > nowSeconds ||
      payload.exp - payload.iat !== 3600 ||
      payload.exp <= nowSeconds
    ) {
      throw new Error('invalid claims');
    }
    return payload as JwtClaims;
  } catch {
    throw new AuthFailure('UNAUTHENTICATED');
  }
}
