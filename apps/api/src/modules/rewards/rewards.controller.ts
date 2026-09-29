import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AdminRole } from '@remnaray/domain/rbac';

import { Permissions, Roles } from '../admin/admin.rbac';
import { Audit, Audited } from '../admin/audit.interceptor';
import { AuthGuard, InternalTokenGuard, type AuthenticatedRequest } from '../auth/auth.guards';
import { Infrastructure } from '../../infra/infra.module';
import { SettingsService } from '../settings/settings.service';
import { PromocodesService } from './promocodes.service';
import { RewardsService } from './rewards.service';

const rewardQuerySchema = z.object({
  status: z.enum(['held', 'released', 'reversed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const programSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['percent_first', 'percent_all', 'fixed_first']).optional(),
  percent: z.number().int().min(1).max(100).optional(),
  fixed_minor: z.string().regex(/^\d+$/).optional(),
  all_months: z.number().int().min(0).max(120).optional(),
  invitee_bonus: z
    .object({ type: z.enum(['none', 'days', 'balance']), value: z.number().int().min(0) })
    .optional(),
  invitee_bonus_trigger: z.enum(['signup', 'first_paid']).optional(),
  hold_hours: z.number().int().min(0).max(720).optional(),
  max_rewards_per_day: z.number().int().min(0).optional(),
  min_source_amount_minor: z.string().regex(/^\d+$/).optional(),
  reason: z.string().min(3).max(500).optional(),
});

function acting(request: AuthenticatedRequest): { id: string; role: AdminRole } {
  return { id: request.admin?.id ?? '', role: (request.admin?.role ?? 'operator') as AdminRole };
}

@Controller('api/admin/v1/promocodes')
@UseGuards(AuthGuard)
@Permissions('promocodes.read')
export class AdminPromocodesController {
  constructor(private readonly promocodes: PromocodesService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.promocodes.list(query);
  }

  @Get('export')
  async exportCsv(@Res() reply: FastifyReply) {
    const csv = await this.promocodes.exportCsv();
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="promocodes.csv"')
      .send(csv);
  }

  @Post()
  @HttpCode(201)
  @Permissions('promocodes.write')
  @Audit('promocodes.create', 'promocode')
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.promocodes.create(body, acting(request));
  }

  @Post('generate')
  @HttpCode(201)
  @Permissions('promocodes.write')
  @Audit('promocodes.generate', 'promocode')
  generate(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.promocodes.generate(body, acting(request));
  }

  @Get(':id/redemptions')
  redemptions(@Param('id') id: string) {
    return this.promocodes.redemptions(id);
  }

  @Patch(':id')
  @Permissions('promocodes.write')
  @Audit('promocodes.update', 'promocode', 'id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.promocodes.update(id, body, acting(request));
  }

  @Delete(':id')
  @Permissions('promocodes.write')
  @Audit('promocodes.delete', 'promocode', 'id')
  remove(@Param('id') id: string) {
    return this.promocodes.remove(id);
  }
}

@Controller('api/admin/v1/referral')
@UseGuards(AuthGuard)
@Permissions('referrals.read')
export class AdminReferralController {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly rewards: RewardsService,
  ) {}

  @Get('program')
  program() {
    return this.settings.getGroup('referral');
  }

  @Put('program')
  @Roles('admin')
  @Permissions('referrals.write')
  @Audit('referral.program', 'settings')
  async setProgram(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = programSchema.parse(body);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'reason'));
    const before = await this.settings.getGroup('referral');
    await this.settings.set({ referral: patch }, { id: request.admin?.id ?? '' });
    return new Audited(before, await this.settings.getGroup('referral'));
  }

  @Get('rewards')
  async rewardsList(@Query() query: unknown) {
    const input = rewardQuerySchema.parse(query ?? {});
    const rows = await this.infra.db.referralReward.findMany({
      where: { ...(input.status ? { status: input.status } : {}) },
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    const attributions = await this.infra.db.referralAttribution.findMany({
      where: { id: { in: page.map((row) => row.attributionId) } },
    });
    const referrers = new Map(attributions.map((row) => [row.id, row.referrerId]));
    return {
      items: page.map((row) => ({
        id: row.id,
        referrerId: referrers.get(row.attributionId) ?? null,
        amountMinor: Number(row.amountMinor),
        status: row.status,
        holdUntil: row.holdUntil?.toISOString() ?? null,
        sourceTransactionId: row.sourceTransactionId,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  @Post('rewards/:id/reverse')
  @HttpCode(200)
  @Roles('admin')
  @Permissions('referrals.write')
  @Audit('referral.reverse', 'referral_reward', 'id')
  async reverse(@Param('id') id: string, @Body() body: unknown) {
    z.object({ reason: z.string().min(3).max(500) }).parse(body);
    const before = await this.infra.db.referralReward.findUnique({ where: { id } });
    const result = await this.rewards.reverseReward(id);
    const after = await this.infra.db.referralReward.findUnique({ where: { id } });
    return new Audited(
      { status: before?.status ?? null },
      { status: after?.status ?? null },
      result,
    );
  }
}

@Controller('api/internal/v1/rewards')
@UseGuards(InternalTokenGuard)
export class InternalRewardsController {
  constructor(private readonly rewards: RewardsService) {}

  /** Cron `maintenance.referral-release` (section 15.2). */
  @Post('release-held')
  @HttpCode(200)
  release() {
    return this.rewards.releaseHeld();
  }
}
