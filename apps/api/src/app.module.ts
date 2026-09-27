import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';
import { MetricsInterceptor } from './health/metrics.interceptor';
import { InfraModule } from './infra/infra.module';
import { AuthModule } from './modules/auth/auth.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PlansModule } from './modules/plans/plans.module';
import { RemnawaveModule } from './modules/remnawave/remnawave.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { BotModule } from './modules/bot/bot.module';
import { AdminModule } from './modules/admin/admin.module';
import { PublicModule } from './modules/public/public.module';
import { MeModule } from './modules/me/me.module';
import { AdminApiModule } from './modules/admin-api/admin-api.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { NotifyModule } from './modules/notify/notify.module';
import { BroadcastsModule } from './modules/broadcasts/broadcasts.module';
import { AdminSettingsModule } from './modules/admin-settings/admin-settings.module';
import { SetupModule } from './modules/setup/setup.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { loggerParams } from './logging';

@Module({
  imports: [
    InfraModule,
    SettingsModule,
    // Before `AuthModule`: its guard runs first, so a request made before the
    // wizard finishes answers `SETUP_NOT_COMPLETED` rather than `UNAUTHENTICATED`.
    SetupModule,
    UsersModule,
    AuthModule,
    LedgerModule,
    PlansModule,
    RemnawaveModule,
    SubscriptionsModule,
    PaymentsModule,
    BotModule,
    AdminModule,
    PublicModule,
    MeModule,
    AdminApiModule,
    RewardsModule,
    NotifyModule,
    BroadcastsModule,
    AdminSettingsModule,
    WebhooksModule,
    LoggerModule.forRoot(loggerParams()),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    // Section 9.3: one error envelope for every route.
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
// Nest module metadata is intentionally the complete shell for this milestone.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
