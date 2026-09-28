import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { InternalTokenGuard } from '../auth/auth.guards';
import { LedgerService } from './ledger.service';

@Controller('api/internal/v1/ledger')
@UseGuards(InternalTokenGuard)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('users/:userId/available')
  async available(@Param('userId') userId: string) {
    return { amountMinor: (await this.ledger.available(userId)).toString() };
  }

  /** Cron `maintenance.ledger-audit`, nightly (section 8.3, repair queue R19). */
  @Post('audit')
  @HttpCode(200)
  async audit() {
    const result = await this.ledger.audit();
    return { checked: result.checked, mismatches: result.mismatches.length };
  }
}
