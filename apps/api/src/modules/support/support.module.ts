import { Module } from '@nestjs/common';

import { InternalTokenGuard } from '../auth/auth.guards';
import { NotifyModule } from '../notify/notify.module';
import { PublicModule } from '../public/public.module';
import { SettingsModule } from '../settings/settings.module';
import { SupportInternalController } from './support.internal.controller';
import { SupportService } from './support.service';
import { TicketsRepository } from './tickets.repository';

/** Support tickets in the operators' Telegram chat (FR-124, owner decisions F35, F36). */
@Module({
  imports: [SettingsModule, PublicModule, NotifyModule],
  controllers: [SupportInternalController],
  providers: [InternalTokenGuard, SupportService, TicketsRepository],
  exports: [SupportService, TicketsRepository],
})
// Nest module metadata is the complete implementation of this module.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SupportModule {}
