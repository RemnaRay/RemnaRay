import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { InternalTokenGuard } from '../auth/auth.guards';
import { PaymentsModule } from '../payments/payments.module';
import { PlansModule } from '../plans/plans.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { PublicModule } from '../public/public.module';
import { NotifyModule } from '../notify/notify.module';
import {
  BotInternalController,
  BotAdminController,
  TelegramWebhookController,
} from './bot.controller';
import { SupportModule } from '../support/support.module';

@Module({
  imports: [
    SettingsModule,
    PaymentsModule,
    PlansModule,
    SubscriptionsModule,
    RemnawaveModule,
    PublicModule,
    NotifyModule,
    SupportModule,
  ],
  controllers: [TelegramWebhookController, BotInternalController, BotAdminController],
  providers: [InternalTokenGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class BotModule {}
