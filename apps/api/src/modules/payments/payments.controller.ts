import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PaymentsService } from './payments.service';
import { StarsService } from './stars.service';
import { InternalTokenGuard } from '../auth/auth.guards';

@Controller('webhooks')
export class PaymentsWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  /** Section 9.7 names Robokassa's ResultURL `/webhooks/robokassa/result`. */
  @Post('robokassa/result')
  robokassaResult(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string>,
    @Res() response: FastifyReply,
  ) {
    return this.webhook('robokassa', request, headers, response);
  }

  @Post(':provider')
  async webhook(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string>,
    @Res() response: FastifyReply,
  ) {
    try {
      const result = await this.payments.receiveWebhook(
        provider,
        request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})),
        headers,
        request.ip,
      );
      return await response.status(result.status).type(result.contentType).send(result.body);
    } catch (error) {
      if (error instanceof Error && error.name === 'PaymentError')
        return response.status(400).send({ code: error.message });
      throw error;
    }
  }
}

@Controller('api/internal/v1/payments')
@UseGuards(InternalTokenGuard)
export class PaymentsInternalController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('events/:id/apply')
  apply(@Param('id') id: string) {
    return this.payments.applyEvent(id);
  }

  @Post('expire')
  expire() {
    return this.payments.expire();
  }

  @Post('poll-pending')
  poll() {
    return this.payments.pollPending();
  }

  @Post('reapply-events')
  reapply() {
    return this.payments.reapplyUnapplied();
  }
}

/** Section 9.5: the bot hands Telegram Stars payment updates to the shop here. */
@Controller('api/internal/v1/stars')
@UseGuards(InternalTokenGuard)
export class StarsInternalController {
  constructor(private readonly stars: StarsService) {}

  @Post('create-link')
  @HttpCode(200)
  createLink(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    return this.stars.invoiceForBot(actingUser, body);
  }

  @Post('precheckout')
  @HttpCode(200)
  precheckout(@Body() body: unknown) {
    return this.stars.precheckout(body);
  }

  @Post('successful-payment')
  @HttpCode(200)
  successfulPayment(@Body() body: unknown) {
    return this.stars.successfulPayment(body);
  }
}
