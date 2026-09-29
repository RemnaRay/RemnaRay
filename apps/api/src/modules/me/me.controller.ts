import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { IdempotencyInterceptor, IdempotencyRequired } from '../../common/idempotency.interceptor';
import { AuthGuard, InternalTokenGuard, type AuthenticatedRequest } from '../auth/auth.guards';
import { PlansService } from '../plans/plans.service';
import { MeService } from './me.service';

/** Section 9.4: the same operations the bot reaches over `/api/internal/v1/me`. */
@Controller('api/v1/me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly me: MeService) {}

  private userId(request: AuthenticatedRequest): string {
    return request.user?.id ?? '';
  }

  @Get()
  profile(@Req() request: AuthenticatedRequest) {
    return this.me.profile(this.userId(request));
  }

  @Patch()
  patch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.me.patchProfile(this.userId(request), body);
  }

  @Get('subscription')
  subscription(@Req() request: AuthenticatedRequest) {
    return this.me.subscription(this.userId(request));
  }

  @Get('subscription/qr')
  async qr(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const png = await this.me.subscriptionQr(this.userId(request));
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, no-store')
      .send(png);
  }

  @Post('subscription/revoke')
  @HttpCode(200)
  revoke(@Req() request: AuthenticatedRequest) {
    return this.me.revoke(this.userId(request));
  }

  @Get('subscription/devices')
  devices(@Req() request: AuthenticatedRequest) {
    return this.me.devices(this.userId(request));
  }

  @Delete('subscription/devices/:hwid')
  @HttpCode(204)
  async removeDevice(@Req() request: AuthenticatedRequest, @Param('hwid') hwid: string) {
    await this.me.removeDevice(this.userId(request), hwid);
  }

  @Post('trial')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  trial(@Req() request: AuthenticatedRequest) {
    return this.me.trial(this.userId(request));
  }

  @Get('payment-methods')
  paymentMethods(@Req() request: AuthenticatedRequest) {
    return this.me.paymentMethods(this.userId(request));
  }

  @Get('topup-config')
  topupConfig() {
    return this.me.topupConfig();
  }

  @Post('invoices')
  @UseInterceptors(IdempotencyInterceptor)
  @IdempotencyRequired()
  @HttpCode(201)
  createInvoice(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.me.createInvoice(this.userId(request), body, key);
  }

  @Get('invoices/:id')
  invoice(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.me.invoice(this.userId(request), id);
  }

  @Post('invoices/:id/check')
  @HttpCode(200)
  check(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.me.checkInvoice(this.userId(request), id);
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.me.cancelInvoice(this.userId(request), id);
  }

  @Get('checkout/quote')
  quote(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.me.checkoutQuote(this.userId(request), query);
  }

  @Get('transactions')
  transactions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.me.transactions(this.userId(request), query);
  }

  @Get('referrals')
  referrals(@Req() request: AuthenticatedRequest) {
    return this.me.referrals(this.userId(request));
  }

  @Get('referrals/list')
  referralList(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.me.referralList(this.userId(request), query);
  }

  @Post('anonymize-request')
  @HttpCode(200)
  anonymize(@Req() request: AuthenticatedRequest) {
    return this.me.requestAnonymization(this.userId(request));
  }

  @Post('promocodes/redeem')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  redeem(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.me.redeemPromocode(this.userId(request), body);
  }

  @Post('promocodes/preview')
  @HttpCode(200)
  preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.me.previewPromocode(this.userId(request), body);
  }
}

/** Section 9.5: the same set, addressed by `X-Acting-User` instead of a session. */
@Controller('api/internal/v1/me')
@UseGuards(InternalTokenGuard)
export class InternalMeController {
  constructor(
    private readonly me: MeService,
    private readonly plans: PlansService,
  ) {}

  @Get('plans')
  async plansList() {
    return { items: await this.plans.publicList() };
  }

  @Get()
  async profile(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.profile(await this.me.userIdForTelegram(actingUser));
  }

  @Patch()
  async patch(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    return this.me.patchProfile(await this.me.userIdForTelegram(actingUser), body);
  }

  @Get('subscription')
  async subscription(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.subscription(await this.me.userIdForTelegram(actingUser));
  }

  @Post('subscription/revoke')
  @HttpCode(200)
  async revoke(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.revoke(await this.me.userIdForTelegram(actingUser));
  }

  @Get('subscription/devices')
  async devices(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.devices(await this.me.userIdForTelegram(actingUser));
  }

  @Delete('subscription/devices/:hwid')
  @HttpCode(204)
  async removeDevice(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Param('hwid') hwid: string,
  ) {
    await this.me.removeDevice(await this.me.userIdForTelegram(actingUser), hwid);
  }

  @Post('trial')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  async trial(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.trial(await this.me.userIdForTelegram(actingUser));
  }

  @Get('payment-methods')
  async paymentMethods(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.paymentMethods(await this.me.userIdForTelegram(actingUser));
  }

  @Get('topup-config')
  topupConfig() {
    return this.me.topupConfig();
  }

  @Post('invoices')
  @UseInterceptors(IdempotencyInterceptor)
  @IdempotencyRequired()
  @HttpCode(201)
  async createInvoice(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.me.createInvoice(await this.me.userIdForTelegram(actingUser), body, key);
  }

  @Get('invoices/:id')
  async invoice(@Headers('x-acting-user') actingUser: string | undefined, @Param('id') id: string) {
    return this.me.invoice(await this.me.userIdForTelegram(actingUser), id);
  }

  @Post('invoices/:id/check')
  @HttpCode(200)
  async check(@Headers('x-acting-user') actingUser: string | undefined, @Param('id') id: string) {
    return this.me.checkInvoice(await this.me.userIdForTelegram(actingUser), id);
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  async cancel(@Headers('x-acting-user') actingUser: string | undefined, @Param('id') id: string) {
    return this.me.cancelInvoice(await this.me.userIdForTelegram(actingUser), id);
  }

  @Get('checkout/quote')
  async quote(@Headers('x-acting-user') actingUser: string | undefined, @Query() query: unknown) {
    return this.me.checkoutQuote(await this.me.userIdForTelegram(actingUser), query);
  }

  @Get('transactions')
  async transactions(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Query() query: unknown,
  ) {
    return this.me.transactions(await this.me.userIdForTelegram(actingUser), query);
  }

  @Get('referrals')
  async referrals(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.referrals(await this.me.userIdForTelegram(actingUser));
  }

  @Get('referrals/list')
  async referralList(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Query() query: unknown,
  ) {
    return this.me.referralList(await this.me.userIdForTelegram(actingUser), query);
  }

  @Post('anonymize-request')
  @HttpCode(200)
  async anonymize(@Headers('x-acting-user') actingUser: string | undefined) {
    return this.me.requestAnonymization(await this.me.userIdForTelegram(actingUser));
  }

  @Post('promocodes/redeem')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  async redeem(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    return this.me.redeemPromocode(await this.me.userIdForTelegram(actingUser), body);
  }

  @Post('promocodes/preview')
  @HttpCode(200)
  async preview(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    return this.me.previewPromocode(await this.me.userIdForTelegram(actingUser), body);
  }
}
