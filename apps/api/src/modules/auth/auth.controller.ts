import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { AuthService } from './auth.service';
import { type AuthenticatedRequest, InternalTokenGuard } from './auth.guards';
import { NONCE_TTL_SECONDS } from './telegram-oidc';

const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

@Controller('api/v1')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/telegram')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async telegram(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const referralCode = readReferralCookie(request.headers.cookie);
    const result = await this.auth.authenticateTelegram(body, {
      ip: request.ip,
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      ...(referralCode ? { referralCode } : {}),
    });
    setSessionCookie(reply, result.sessionId);
    return { user: result.user };
  }

  /**
   * Telegram Login over OIDC: the nonce the page passes to Telegram, also set
   * as an HttpOnly cookie so the resulting token only signs this browser in.
   */
  @Get('auth/telegram/nonce')
  async telegramNonce(@Res({ passthrough: true }) reply: FastifyReply) {
    const clientId = await this.auth.telegramClientId();
    const nonce = this.auth.telegramNonce();
    reply.header('cache-control', 'no-store');
    reply.header(
      'set-cookie',
      `rr_oidc_nonce=${nonce}; Max-Age=${String(NONCE_TTL_SECONDS)}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax`,
    );
    return { clientId, nonce };
  }

  @Post('auth/telegram/oidc')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async telegramOidc(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const referralCode = readReferralCookie(request.headers.cookie);
    const result = await this.auth.authenticateTelegramOidc(
      body,
      readCookie(request.headers.cookie, 'rr_oidc_nonce'),
      {
        ip: request.ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(referralCode ? { referralCode } : {}),
      },
    );
    reply.header('set-cookie', [
      sessionCookie(result.sessionId),
      'rr_oidc_nonce=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax',
    ]);
    return { user: result.user };
  }

  /**
   * The bot's account link (section 13.3) opens a confirmation page, which
   * shows whose account it is (L-3, owner decision 2026-09-28) …
   */
  @Post('auth/tg/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  telegramLinkPreview(@Body() body: unknown) {
    return this.auth.previewJwt(body);
  }

  /**
   * … and signs in only when the visitor confirms, with a same-origin POST:
   * a link someone else hands over names their account and cannot sign a
   * visitor in unasked. The link is spent (R79, owner decision О-9).
   */
  @Post('auth/tg')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async telegramLink(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const sessionId = await this.auth.exchangeJwt(body, {
      ip: request.ip,
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
    });
    setSessionCookie(reply, sessionId);
  }

  @Post('auth/logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(request.user?.sessionId);
    clearSessionCookie(reply);
    reply.code(204);
  }
}

@Controller('api/internal/v1/auth')
export class InternalAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('issue-token')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  issueToken(@Body() body: unknown) {
    return this.auth.issueBotToken(body);
  }
}

/** Reads `rr_ref` from `/r/<code>` (section 15.3). */
export function readReferralCookie(header: string | undefined): string | undefined {
  const value = header
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('rr_ref='))
    ?.slice('rr_ref='.length);
  return value && /^[A-Za-z0-9]{4,16}$/.test(value) ? value : undefined;
}

function sessionCookie(value: string): string {
  return `rr_sid=${encodeURIComponent(value)}; Max-Age=${String(SESSION_COOKIE_MAX_AGE)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function setSessionCookie(reply: FastifyReply, value: string): void {
  reply.header('set-cookie', sessionCookie(value));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  const value = header
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[\w.-]{1,200}$/u.test(value) ? value : undefined;
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', 'rr_sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
}
