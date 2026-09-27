import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import { telegramSecretToken, telegramWebhookTarget } from '../bot/telegram-webhook-target';
import { SettingsService } from '../settings/settings.service';

const TELEGRAM_WEBHOOK = /^\/tg\/webhook\/([^/?]+)/u;

/**
 * The section 9.1 throttler, which first refuses a Telegram webhook request
 * whose secret path and token match no bot (P-2, owner decision О-16): a
 * forged update never counts against the bucket Telegram's own deliveries
 * use. Payment providers' signatures need the body and the provider's
 * configuration, so they stay in the controller; the per-address webhook
 * bucket (`sessionTracker`) keeps a flood to its sender.
 */
@Injectable()
export class WebhookThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly settings: SettingsService,
  ) {
    super(options, storage, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const encoded = TELEGRAM_WEBHOOK.exec(request.url)?.[1];
    if (encoded !== undefined) {
      const secretPath = decoded(encoded);
      const target =
        secretPath !== undefined &&
        (await telegramWebhookTarget(
          this.settings,
          secretPath,
          telegramSecretToken(request.headers),
        ));
      if (!target) throw new ForbiddenException('FORBIDDEN');
    }
    return super.canActivate(context);
  }
}

/** The route parameter as the controller receives it; a malformed one matches no bot. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
