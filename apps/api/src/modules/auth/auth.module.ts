import { Module, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';
import { AuthController, InternalAuthController } from './auth.controller';
import {
  AuthGuard,
  CsrfGuard,
  InternalTokenGuard,
  trustedInternal,
  type AuthenticatedRequest,
} from './auth.guards';
import { AuthService } from './auth.service';
import { RedisSessionStore, type SessionStorePort } from './auth.session';
import { ValkeyThrottlerStorage } from './auth.throttler';
import { WebhookThrottlerGuard } from './webhook-throttler.guard';

const sessionStore = new RedisSessionStore();
const throttlerStorage = new ValkeyThrottlerStorage();

/**
 * Internal workers authenticate with a token and have their own job cadence.
 * The web container's own server-side requests — page data, the setup state,
 * the bot's sign-in link — are not an anonymous visitor either (P-9, R26,
 * owner decision 2026-09-28): they come straight from inside the compose
 * network without `X-Forwarded-For`, which both bundled proxies and the
 * external edge always set, so a visitor never looks like one. The visitor
 * is limited at the proxy; the client IP is not forwarded on page data,
 * since Next.js keys its data cache on the request headers.
 */
export function skipThrottleForInternal(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
  if (path.startsWith('/api/internal/')) return true;
  const socket = (request.raw as FastifyRequest['raw'] | undefined)?.socket.remoteAddress;
  return (
    socket !== undefined &&
    request.headers['x-forwarded-for'] === undefined &&
    trustedInternal(socket)
  );
}

/**
 * Section 9.1: webhooks are limited to 600 a minute per provider, apart from
 * the anonymous visitors' 60 a minute per IP. The Telegram webhook is the
 * `telegram` provider. P-2 (owner decision О-16): the bucket is the
 * provider's per sending address, so forged requests fill only the sender's
 * own bucket.
 */
export function webhookProvider(url: string): string | null {
  const path = url.split('?')[0] ?? '';
  if (/^\/tg\/webhook\//u.test(path)) return 'telegram';
  return /^\/webhooks\/([^/]+)/u.exec(path)?.[1] ?? null;
}

/** Section 9.1 grants authenticated sessions 300 requests per minute. */
export function sessionRequestLimit(context: ExecutionContext): number {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (webhookProvider(request.url)) return 600;
  return request.admin || request.user ? 300 : 60;
}

export function sessionTracker(request: Record<string, unknown>): string {
  const typed = request as unknown as AuthenticatedRequest;
  const provider = webhookProvider(typed.url);
  if (provider) return `webhook:${provider}:ip:${typed.ip}`;
  if (typed.admin) return `admin:${typed.admin.id}`;
  if (typed.user) return `user:${typed.user.id}`;
  return `ip:${typed.ip}`;
}

@Module({
  imports: [
    SettingsModule,
    UsersModule,
    ThrottlerModule.forRoot({
      storage: throttlerStorage,
      throttlers: [{ name: 'default', ttl: 60_000, limit: sessionRequestLimit }],
      skipIf: skipThrottleForInternal,
      getTracker: sessionTracker,
    }),
  ],
  controllers: [AuthController, InternalAuthController],
  providers: [
    { provide: 'SESSION_STORE', useValue: sessionStore },
    {
      provide: AuthService,
      inject: [SettingsService, UsersService, 'SESSION_STORE'],
      useFactory: (settings: SettingsService, users: UsersService, sessions: SessionStorePort) =>
        new AuthService(settings, users, sessions, process.env.RR_APP_KEY ?? ''),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WebhookThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    InternalTokenGuard,
  ],
  exports: [AuthService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthModule {}
