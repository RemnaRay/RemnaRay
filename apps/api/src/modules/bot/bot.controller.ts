import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SUPPORTED_LOCALES, type Locale } from '@remnaray/i18n-core';
import { z } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { InternalTokenGuard, equalToken } from '../auth/auth.guards';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from '../public/i18n.service';
import { emitWebhook, subscriptionData } from '../webhooks/outgoing';
import { queuePanelSync } from '../remnawave/panel-jobs';
import { SupportService } from './support.service';

const appendUpdate = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('XADD', KEYS[1], 'MAXLEN', '~', 10000, '*', 'payload', ARGV[1])
redis.call('SET', KEYS[2], '1', 'EX', 604800)
return 1`;
const publicCommandNames = [
  'start',
  'menu',
  'sub',
  'buy',
  'balance',
  'ref',
  'promo',
  'lang',
  'notifications',
  'help',
  'support',
] as const;
const adminCommandNames = [
  'admin_stats',
  'admin_user',
  'admin_extend',
  'admin_broadcast_status',
] as const;

@Controller('tg/webhook')
export class TelegramWebhookController {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
  ) {}

  @Post(':secretPath')
  @HttpCode(200)
  async receive(
    @Param('secretPath') secretPath: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
  ) {
    const configuredPath = String(await this.settings.get('bot.webhook_secret_path'));
    const configuredToken = String(await this.settings.get('bot.webhook_secret_token'));
    const header = headers['x-telegram-bot-api-secret-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!equalToken(secretPath, configuredPath) || !equalToken(token, configuredToken))
      throw new ForbiddenException('FORBIDDEN');
    if (
      !isRecord(body) ||
      typeof body.update_id !== 'number' ||
      !Number.isSafeInteger(body.update_id)
    )
      throw new BadRequestException('INVALID_UPDATE');
    await this.infra.redis.eval(
      appendUpdate,
      2,
      'tg:updates',
      `tg:received:${String(body.update_id)}`,
      JSON.stringify(body),
    );
    return { ok: true };
  }
}

@Controller('api/internal/v1')
@UseGuards(InternalTokenGuard)
export class BotInternalController {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly i18n: I18nService,
    private readonly support: SupportService,
  ) {}

  @Get('i18n/:lang')
  async messages(@Param('lang') lang: string) {
    const locale = SUPPORTED_LOCALES.includes(lang as Locale) ? (lang as Locale) : 'ru';
    return { lang: locale, messages: await this.i18n.messages(locale) };
  }

  @Post('users/:telegramId/bot-blocked')
  @HttpCode(204)
  async blocked(@Param('telegramId') telegramId: string) {
    await this.infra.db.user.updateMany({
      where: { telegramId: BigInt(telegramId) },
      data: { botBlockedAt: new Date() },
    });
  }

  @Post('users/:telegramId/bot-unblocked')
  @HttpCode(204)
  async unblocked(@Param('telegramId') telegramId: string) {
    await this.infra.db.user.updateMany({
      where: { telegramId: BigInt(telegramId) },
      data: { botBlockedAt: null },
    });
  }

  @Get('bot/config')
  async config() {
    const mode = (await this.settings.get('bot.mode')) as 'webhook' | 'polling';
    const domain = String(await this.settings.get('domain.main'));
    const secretPath = String(await this.settings.get('bot.webhook_secret_path'));
    const supportForwardChatId = (await this.settings.get('brand.support_forward_chat_id')) as
      number | null;
    const supportContact = String(await this.settings.get('brand.support_contact'));
    const admins = await this.infra.db.admin.findMany({
      where: { isActive: true, deletedAt: null, telegramId: { not: null } },
      select: { telegramId: true },
    });
    const catalogs = Object.fromEntries(
      await Promise.all(
        SUPPORTED_LOCALES.map(
          async (locale) => [locale, await this.i18n.messages(locale)] as const,
        ),
      ),
    );
    const describe = (locale: Locale, command: string) =>
      catalogs[locale]?.[`bot.commands.${command}`] ?? command;
    const commands = Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => [
        locale,
        publicCommandNames.map((command) => ({ command, description: describe(locale, command) })),
      ]),
    );
    const adminCommands = Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => [
        locale,
        adminCommandNames.map((command) => ({ command, description: describe(locale, command) })),
      ]),
    );
    return {
      mode,
      token: String(await this.settings.get('bot.token')),
      defaultLocale: await this.settings.get('locale.default'),
      webUrl: `https://${domain}`,
      webhookUrl: `https://${domain}/tg/webhook/${secretPath}`,
      secretPath,
      secretToken: String(await this.settings.get('bot.webhook_secret_token')),
      locales: await this.settings.get('locale.enabled'),
      commands,
      adminCommands,
      supportForwardChatId,
      supportContact,
      brandName: String(await this.settings.get('brand.name')),
      timezone: String(await this.settings.get('locale.timezone')),
      clients: (
        (await this.settings.get('clients.items')) as Array<{ name: string; platforms: string[] }>
      ).map((client) => ({ name: client.name, platforms: client.platforms })),
      trial: {
        days: Number(await this.settings.get('trial.days')),
        trafficGb: Number(await this.settings.get('trial.traffic_gb')),
      },
      admins: admins.flatMap((admin) =>
        admin.telegramId === null ? [] : [admin.telegramId.toString()],
      ),
    };
  }

  /**
   * Section 9.5 `POST /api/internal/v1/support/forward` (FR-124): the
   * customer's message `messageId` in their chat with the bot is copied to
   * the operators. `requireOpen` refuses one outside an open conversation.
   */
  @Post('support/forward')
  @HttpCode(200)
  async supportForward(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Body() body: unknown,
  ) {
    const input = supportForwardSchema.parse(body);
    return this.support.forward(telegramIdOf(actingUser), input.messageId, {
      requireOpen: input.requireOpen,
    });
  }

  /** «Поддержка»: the customer's messages go to the operators until closed. */
  @Post('support/open')
  @HttpCode(204)
  async supportOpen(@Headers('x-acting-user') actingUser: string | undefined) {
    await this.support.open(telegramIdOf(actingUser));
  }

  /** «Завершить»: the customer's messages stay with the bot again. */
  @Post('support/close')
  @HttpCode(204)
  async supportClose(@Headers('x-acting-user') actingUser: string | undefined) {
    await this.support.close(telegramIdOf(actingUser));
  }

  /** FR-124: the customer an operator's message in the operators' chat answers. */
  @Post('support/route')
  @HttpCode(200)
  async supportRoute(@Body() body: unknown) {
    const input = supportRouteSchema.parse(body);
    return { target: await this.support.route(input) };
  }
}

const supportForwardSchema = z.object({
  messageId: z.number().int().positive(),
  requireOpen: z.boolean().default(false),
});

function telegramIdOf(actingUser: string | undefined): string {
  if (!actingUser || !/^\d+$/.test(actingUser)) throw new ForbiddenException('FORBIDDEN');
  return actingUser;
}

const supportRouteSchema = z.object({
  chatId: z.number().int(),
  threadId: z.number().int().optional(),
  replyToMessageId: z.number().int().optional(),
});

@Controller('api/internal/v1/admins')
@UseGuards(InternalTokenGuard)
export class BotAdminController {
  constructor(private readonly infra: Infrastructure) {}

  @Get('by-telegram/:id')
  async byTelegram(@Param('id') id: string) {
    const admin = await this.infra.db.admin.findFirst({
      where: { telegramId: BigInt(id), isActive: true, deletedAt: null },
      select: { role: true },
    });
    if (!admin) throw new BadRequestException('ADMIN_NOT_FOUND');
    return { role: admin.role };
  }

  @Get('stats')
  async stats(@Headers('x-acting-user') actingUser: string | undefined) {
    await this.authorize(actingUser);
    const [users, active, today] = await Promise.all([
      this.infra.db.user.count(),
      this.infra.db.subscription.count({ where: { status: 'active' } }),
      this.infra.db.transaction.count({ where: { createdAt: { gte: startOfDay() } } }),
    ]);
    return { users, activeSubscriptions: active, transactionsToday: today };
  }

  @Get('users/:query')
  async user(
    @Headers('x-acting-user') actingUser: string | undefined,
    @Param('query') query: string,
  ) {
    await this.authorize(actingUser);
    const user = await this.infra.db.user.findFirst({
      where: /^\d+$/.test(query)
        ? { telegramId: BigInt(query) }
        : { username: { equals: query.replace(/^@/u, ''), mode: 'insensitive' } },
      select: { id: true, telegramId: true, username: true, firstName: true, language: true },
    });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');
    return { ...user, telegramId: user.telegramId.toString() };
  }

  @Post('extend')
  @HttpCode(200)
  async extend(@Headers('x-acting-user') actingUser: string | undefined, @Body() body: unknown) {
    const admin = await this.authorize(actingUser);
    if (
      !isRecord(body) ||
      typeof body.telegramId !== 'string' ||
      !/^\d+$/.test(body.telegramId) ||
      typeof body.days !== 'number' ||
      !Number.isInteger(body.days) ||
      body.days < 1 ||
      body.days > 3650
    )
      throw new BadRequestException('INVALID_BODY');
    const user = await this.infra.db.user.findUnique({
      where: { telegramId: BigInt(body.telegramId) },
    });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');
    const subscription = await this.infra.db.subscription.findFirst({
      where: { userId: user.id, status: { in: ['provisioning', 'active', 'grace'] } },
      orderBy: { expiresAt: 'desc' },
    });
    if (!subscription) throw new BadRequestException('SUBSCRIPTION_NOT_FOUND');
    const before = { expiresAt: subscription.expiresAt.toISOString() };
    const afterDate = new Date(subscription.expiresAt.getTime() + body.days * 86_400_000);
    await this.infra.db.$transaction(async (transaction) => {
      const extended = await transaction.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt: afterDate },
      });
      await emitWebhook(transaction, 'subscription.activated', user.id, subscriptionData(extended));
      await queuePanelSync(transaction, user.id, 'bot-admin');
      await transaction.transaction.create({
        data: {
          userId: user.id,
          type: 'adjustment',
          status: 'completed',
          amountMinor: 0n,
          currency: 'RUB',
          reason: 'bot-admin',
          actorAdminId: admin.id,
          subscriptionId: subscription.id,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorAdminId: admin.id,
          actorType: 'admin',
          action: 'subscription.extend',
          entity: 'subscription',
          entityId: subscription.id,
          before,
          after: { expiresAt: afterDate.toISOString(), days: Number(body.days) },
          reason: 'bot-admin',
        },
      });
    });
    return { expiresAt: afterDate.toISOString(), days: body.days };
  }

  @Get('broadcast-status')
  async broadcastStatus(@Headers('x-acting-user') actingUser: string | undefined) {
    await this.authorize(actingUser);
    const broadcast = await this.infra.db.broadcast.findFirst({ orderBy: { createdAt: 'desc' } });
    return broadcast
      ? {
          id: broadcast.id,
          status: broadcast.status,
          sent: broadcast.sentCount,
          total: broadcast.totalCount,
        }
      : null;
  }

  private async authorize(actingUser: string | undefined) {
    if (!actingUser || !/^\d+$/.test(actingUser)) throw new ForbiddenException('FORBIDDEN');
    const admin = await this.infra.db.admin.findFirst({
      where: {
        telegramId: BigInt(actingUser),
        isActive: true,
        deletedAt: null,
        role: { in: ['admin', 'operator'] },
      },
    });
    if (!admin) throw new ForbiddenException('FORBIDDEN');
    return admin;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function startOfDay(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
