import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import { AuthFailure } from './auth.crypto';

/**
 * Telegram Login over OpenID Connect (core.telegram.org/widgets/login, read
 * 2026-09-26; the library `telegram-login.js?6`). The page's popup returns an
 * `id_token`, a JWT Telegram signs with a key from its JWKS; the API verifies
 * the signature, `iss`, `aud` (the bot's id, which is the Client ID), `exp`
 * and the `nonce` it handed this browser, then trusts the claims.
 */
export const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org';
const JWKS_TTL_MS = 60 * 60_000;
/** L-6: an unknown `kid` reads the keys again at most this often. */
const JWKS_REFRESH_MS = 60_000;
const CLOCK_SKEW_SECONDS = 60;
export const NONCE_TTL_SECONDS = 600;

/** Only what a `profile` scope carries; `id` is the Telegram user id. */
export type TelegramOidcClaims = {
  id: number;
  name?: string;
  given_name?: string;
  preferred_username?: string;
};

type Jwk = JsonWebKey & { kid?: string; alg?: string };

/** RS256 and ES256 carry the `profile` scope; EdDSA and ES256K do not. */
const ALGORITHMS: Record<string, { hash: string; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
};

export class TelegramOidcVerifier {
  private keys: { at: number; byKid: Map<string, KeyObject> } | undefined;
  /** The load in flight, which concurrent requests share. */
  private loading: Promise<void> | undefined;

  constructor(
    private readonly baseUrl = process.env.RR_TELEGRAM_OAUTH_URL ?? TELEGRAM_OIDC_ISSUER,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(
    token: string,
    expected: { clientId: string; nonce: string },
    now = Math.floor(Date.now() / 1000),
  ): Promise<TelegramOidcClaims> {
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    if (!headerPart || !payloadPart || !signaturePart) throw invalid('not a JWT');
    const header = decode(headerPart) as { alg?: unknown; kid?: unknown };
    const algorithm = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm || typeof header.kid !== 'string')
      throw invalid(`algorithm ${String(header.alg)} or key id not accepted`);
    const key = await this.key(header.kid);
    const signed = verify(
      algorithm.hash,
      Buffer.from(`${headerPart}.${payloadPart}`),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!signed) throw invalid('signature');

    const claims = decode(payloadPart) as Record<string, unknown>;
    const audience = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
    if (claims.iss !== TELEGRAM_OIDC_ISSUER) throw invalid('iss');
    if (!audience.includes(expected.clientId))
      throw invalid(`aud ${audience.join(',')} is not the bot ${expected.clientId}`);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now)
      throw new AuthFailure('AUTH_EXPIRED', undefined, 'exp');
    if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, expected.nonce))
      throw invalid('nonce');
    // The Telegram id arrives as `id` with the `profile` scope; `sub` is an
    // opaque identifier. The documentation's example shows a number, but a
    // live token (2026-09-26) carries a string of digits: both are accepted.
    const id = telegramId(claims.id);
    if (id === null) throw invalid('id');
    return {
      id,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.given_name === 'string' ? { given_name: claims.given_name } : {}),
      ...(typeof claims.preferred_username === 'string'
        ? { preferred_username: claims.preferred_username }
        : {}),
    };
  }

  /**
   * The JWKS is cached for an hour. An unknown `kid` — Telegram may have
   * rotated its keys — reads it again, but at most once a minute (L-6): the
   * `kid` comes before the signature is checked, so anybody can make one up.
   * Concurrent requests share one load.
   */
  private async key(kid: string): Promise<KeyObject> {
    const age = this.keys ? Date.now() - this.keys.at : Infinity;
    if (age > JWKS_TTL_MS || (!this.keys?.byKid.has(kid) && age > JWKS_REFRESH_MS))
      await this.reload();
    const key = this.keys?.byKid.get(kid);
    if (!key) throw invalid(`unknown key id ${kid}`);
    return key;
  }

  private reload(): Promise<void> {
    this.loading ??= this.loadKeys().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadKeys(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) throw new AuthFailure('AUTH_UNAVAILABLE');
    const body = (await response.json()) as { keys?: Jwk[] };
    const byKid = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || !jwk.alg || !ALGORITHMS[jwk.alg]) continue;
      try {
        byKid.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // A key this runtime cannot read is simply not offered.
      }
    }
    this.keys = { at: Date.now(), byKid };
  }
}

/**
 * The nonce handed to one browser: random, with its expiry, signed with
 * `RR_APP_KEY`. The same value goes to the page (for Telegram) and into an
 * HttpOnly cookie, so a token is only accepted in the browser it was asked for.
 */
export function issueNonce(appKey: string, now = Date.now()): string {
  const random = randomBytes(16).toString('base64url');
  const expires = String(Math.floor(now / 1000) + NONCE_TTL_SECONDS);
  return `${random}.${expires}.${nonceMac(appKey, random, expires)}`;
}

/** The nonce's random part when it is ours and unexpired; null otherwise. */
export function checkNonce(appKey: string, nonce: string, now = Date.now()): string | null {
  const [random, expires, mac] = nonce.split('.');
  if (!random || !expires || !mac || !/^\d+$/u.test(expires)) return null;
  if (!sameText(mac, nonceMac(appKey, random, expires))) return null;
  if (Number(expires) < Math.floor(now / 1000)) return null;
  return random;
}

function nonceMac(appKey: string, random: string, expires: string): string {
  return createHmac('sha256', Buffer.from(appKey, 'base64'))
    .update(`telegram-oidc-nonce:${random}.${expires}`)
    .digest('base64url');
}

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalid('not a JWT');
  }
}

/** A Telegram user id: a safe positive integer, as a number or its digits. */
function telegramId(value: unknown): number | null {
  const id =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,16}$/u.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function invalid(reason: string): AuthFailure {
  return new AuthFailure('AUTH_INVALID_SIGNATURE', undefined, reason);
}
