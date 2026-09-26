import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { verifyJwt, verifyTelegramWidget, signJwt, AuthFailure } from './auth.crypto';
import {
  issueTokenSchema,
  telegramOidcSchema,
  telegramWidgetSchema,
  type TelegramWidgetInput,
} from './auth.schemas';
import { NONCE_TTL_SECONDS, TelegramOidcVerifier, checkNonce, issueNonce } from './telegram-oidc';
import type { SessionStorePort } from './auth.session';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly sessions: SessionStorePort,
    private readonly appKey: string,
    private readonly oidc = new TelegramOidcVerifier(),
  ) {}

  /**
   * Section 15.3: the `rr_ref` cookie set by `/r/<code>` attributes a user who
   * signs in on the site, using the same start payload the bot would send.
   */
  async authenticateTelegram(
    value: unknown,
    requestMeta?: { userAgent?: string; ip?: string; referralCode?: string },
  ) {
    const input = telegramWidgetSchema.parse(value);
    const botToken = await this.settings.get('bot.token');
    if (typeof botToken !== 'string' || !botToken) throw new AuthFailure('AUTH_UNAVAILABLE');
    verifyTelegramWidget(input, botToken);
    const user = await this.users.upsert({
      telegramId: String(input.id),
      firstName: input.first_name,
      ...(input.username ? { username: input.username } : {}),
      ...(input.language_code ? { languageCode: input.language_code } : {}),
      ...(requestMeta?.referralCode ? { startPayload: `ref_${requestMeta.referralCode}` } : {}),
    });
    const sessionId = await this.sessions.create({
      userId: user.user.id,
      user: user.user,
      ...(requestMeta?.userAgent ? { userAgent: requestMeta.userAgent } : {}),
      ...(requestMeta?.ip ? { ip: requestMeta.ip } : {}),
    });
    return { user: user.user, sessionId };
  }

  /** The Client ID of Telegram's OIDC login: the bot's id, its token's prefix. */
  async telegramClientId(): Promise<string | null> {
    const botToken = await this.settings.get('bot.token');
    const id = typeof botToken === 'string' ? botToken.split(':')[0] : undefined;
    return id && /^\d+$/u.test(id) ? id : null;
  }

  /** A login nonce for one browser (see `issueNonce`). */
  telegramNonce(): string {
    return issueNonce(this.appKey);
  }

  private async verifyOidc(idToken: string, nonce: string | undefined) {
    const clientId = await this.telegramClientId();
    if (!clientId) throw new AuthFailure('AUTH_UNAVAILABLE', undefined, 'no bot token');
    const random = nonce ? checkNonce(this.appKey, nonce) : null;
    if (!nonce || !random)
      throw new AuthFailure('AUTH_EXPIRED', undefined, nonce ? 'nonce cookie' : 'no nonce cookie');
    const claims = await this.oidc.verify(idToken, { clientId, nonce });
    if (!(await this.sessions.claimOnce(`oidc-nonce:${random}`, NONCE_TTL_SECONDS)))
      throw new AuthFailure('AUTH_EXPIRED', undefined, 'nonce already used');
    return claims;
  }

  /**
   * Telegram Login over OIDC: the `id_token` the page's popup received, and
   * the nonce cookie of the browser that asked for it. The token must carry
   * that nonce, and a nonce signs in once.
   */
  async authenticateTelegramOidc(
    value: unknown,
    nonce: string | undefined,
    requestMeta?: { userAgent?: string; ip?: string; referralCode?: string },
  ) {
    const input = telegramOidcSchema.parse(value);
    const claims = await this.verifyOidc(input.idToken, nonce).catch((error: unknown) => {
      // Every refusal answers one of three codes; the log says which check.
      if (error instanceof AuthFailure)
        this.logger.warn(`Telegram OIDC sign-in refused: ${error.code} (${error.reason ?? '-'})`);
      throw error;
    });
    const firstName = claims.given_name ?? claims.name;
    const user = await this.users.upsert({
      telegramId: String(claims.id),
      ...(firstName ? { firstName } : {}),
      ...(claims.preferred_username ? { username: claims.preferred_username } : {}),
      ...(requestMeta?.referralCode ? { startPayload: `ref_${requestMeta.referralCode}` } : {}),
    });
    const sessionId = await this.sessions.create({
      userId: user.user.id,
      user: user.user,
      ...(requestMeta?.userAgent ? { userAgent: requestMeta.userAgent } : {}),
      ...(requestMeta?.ip ? { ip: requestMeta.ip } : {}),
    });
    return { user: user.user, sessionId };
  }

  async issueBotToken(value: unknown) {
    const input = issueTokenSchema.parse(value);
    const user = await this.users.upsert({ telegramId: String(input.telegramId) });
    return { token: signJwt(user.user.id, this.appKey), user: user.user };
  }

  async exchangeJwt(token: string): Promise<string> {
    const claims = verifyJwt(token, this.appKey);
    return this.sessions.create({ userId: claims.sub });
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.delete(sessionId);
  }
}

export function asTelegramWidgetInput(value: unknown): TelegramWidgetInput {
  return telegramWidgetSchema.parse(value);
}
