import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { InternalTokenGuard } from '../auth/auth.guards';
import { SupportService } from './support.service';

const via = z.enum(['shop', 'support']).default('shop');
const message = z.object({
  kind: z.string().min(1).max(32),
  text: z.string().max(4096).optional(),
  fileId: z.string().max(256).optional(),
  fileUniqueId: z.string().max(128).optional(),
});
const forwardSchema = z.object({
  messageId: z.number().int().positive(),
  requireOpen: z.boolean().default(false),
  via,
  message: message.optional(),
});
const person = z.object({ id: z.number().int().positive(), name: z.string().min(1).max(256) });
const operatorSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  threadId: z.number().int().optional(),
  replyToMessageId: z.number().int().optional(),
  from: person,
  via,
  message,
});
const callbackSchema = z.object({
  chatId: z.number().int(),
  from: person,
  data: z.string().max(64),
  via,
});
const closeSchema = z.object({ via });
const rateSchema = z.object({ ticketId: z.uuid(), rating: z.number().int().min(1).max(5) });

/**
 * Section 9.5 support routes with the owner's F35/F36 decisions: the bot
 * hands over customers' messages, operators' messages and card buttons; the
 * API keeps the tickets and makes the Telegram calls.
 */
@Controller('api/internal/v1/support')
@UseGuards(InternalTokenGuard)
export class SupportInternalController {
  constructor(private readonly support: SupportService) {}

  /** FR-124: the customer's message `messageId` in their chat with the bot goes into their ticket. */
  @Post('forward')
  @HttpCode(200)
  async forward(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    const input = forwardSchema.parse(body);
    return this.support.forward(telegramIdOf(actingUser), input.messageId, {
      requireOpen: input.requireOpen,
      via: input.via,
      ...(input.message ? { message: input.message } : {}),
    });
  }

  /** «Написать оператору»: the customer's messages go to the operators. */
  @Post('open')
  @HttpCode(204)
  async open(@Headers('x-acting-user') actingUser: string | undefined) {
    await this.support.open(telegramIdOf(actingUser));
  }

  /** «Завершить» / «Закрыть обращение»: the customer closes their ticket. */
  @Post('close')
  @HttpCode(200)
  async close(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    const input = closeSchema.parse(body ?? {});
    return { ticket: await this.support.customerClose(telegramIdOf(actingUser), input.via) };
  }

  /** The customer rates their closed ticket, once. */
  @Post('rate')
  @HttpCode(200)
  async rate(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    const input = rateSchema.parse(body);
    return this.support.rate(telegramIdOf(actingUser), input.ticketId, input.rating);
  }

  /** The worker's minute sweep: reminders of untaken tickets and the auto-close (F36). */
  @Post('sweep')
  @HttpCode(200)
  async sweep() {
    return this.support.sweep();
  }

  /** A message in the operators' chat: an answer, a note or a command. */
  @Post('operator')
  @HttpCode(200)
  async operator(@Body() body: unknown) {
    return this.support.operatorMessage(operatorSchema.parse(body));
  }

  /** A ticket card's button; the answer is shown to the operator who pressed it. */
  @Post('callback')
  @HttpCode(200)
  async callback(@Body() body: unknown) {
    return this.support.callback(callbackSchema.parse(body));
  }
}

function telegramIdOf(actingUser: string | undefined): string {
  if (!actingUser || !/^\d+$/.test(actingUser)) throw new ForbiddenException('FORBIDDEN');
  return actingUser;
}
