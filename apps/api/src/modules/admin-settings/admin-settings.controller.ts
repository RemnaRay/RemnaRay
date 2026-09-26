import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { can, type AdminRole } from '@remnaray/domain/rbac';

import { Infrastructure } from '../../infra/infra.module';
import { Permissions, Roles } from '../admin/admin.rbac';
import { Audit, Audited } from '../admin/audit.interceptor';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guards';
import { SupportBotRefused, configureSupportBot } from '../bot/support-bot';
import { ApiError } from '../me/me.errors';
import { ThemeService } from '../public/theme.service';
import { RemnawaveService } from '../remnawave/remnawave.service';
import { SettingsService } from '../settings/settings.service';
import { I18nAdminService } from './i18n-admin.service';
import { ProvidersService } from './providers.service';
import { SystemService } from './system.service';
import { panelUrlSchema } from '../setup/setup.schemas';

const auditQuerySchema = z.object({
  actorId: z.uuid().optional(),
  action: z.string().min(1).max(64).optional(),
  entity: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const themeActiveSchema = z.object({
  slug: z.string().min(1).max(64),
  reason: z.string().min(3).max(500).optional(),
});
const panelSchema = z.object({
  base_url: panelUrlSchema.optional(),
  api_token: z.string().min(1).optional(),
  webhook_secret: z.string().min(1).optional(),
  reason: z.string().min(3).max(500).optional(),
});
const botSchema = z.object({
  token: z.string().min(1).optional(),
  mode: z.enum(['webhook', 'polling']).optional(),
  username: z.string().min(1).optional(),
  reason: z.string().min(3).max(500).optional(),
});

const supportSchema = z.object({
  contact: z.string().max(200).optional(),
  chatId: z.number().int().nullable().optional(),
  token: z.string().max(200).optional(),
  reason: z.string().min(3).max(500).optional(),
});

/** What the console shows of support; the token itself never leaves the API. */
async function supportView(settings: SettingsService) {
  const username = String(await settings.get('bot.support_username'));
  return {
    contact: String(await settings.get('brand.support_contact')),
    chatId: (await settings.get('brand.support_forward_chat_id')) as number | null,
    supportBot: username ? { username } : null,
  };
}

function withoutReason(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'reason'));
}

@Controller('api/admin/v1/providers')
@UseGuards(AuthGuard)
@Roles('admin')
@Permissions('providers.write')
export class AdminProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list() {
    return this.providers.list();
  }

  @Put(':code')
  @Audit('providers.update', 'payment_provider', 'code')
  update(@Param('code') code: string, @Body() body: unknown) {
    return this.providers.update(code, body);
  }

  @Post(':code/healthcheck')
  @HttpCode(200)
  healthcheck(@Param('code') code: string) {
    return this.providers.healthcheck(code);
  }

  @Post('reorder')
  @HttpCode(200)
  @Audit('providers.reorder', 'payment_provider')
  reorder(@Body() body: unknown) {
    return this.providers.reorder(body);
  }
}

@Controller('api/admin/v1/panel')
@UseGuards(AuthGuard)
@Roles('admin')
@Permissions('panel.write')
export class AdminPanelController {
  constructor(
    private readonly settings: SettingsService,
    private readonly panel: RemnawaveService,
  ) {}

  @Get()
  async get() {
    const group = await this.settings.getGroup('panel');
    const health = await this.panel.health().catch(() => null);
    return { settings: group, health };
  }

  @Put()
  @Audit('panel.update', 'settings')
  async update(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = panelSchema.parse(body);
    const before = await this.settings.getGroup('panel');
    await this.settings.set({ panel: withoutReason(input) }, { id: request.admin?.id ?? '' });
    return new Audited(before, await this.settings.getGroup('panel'));
  }

  /** FR-145: the squads the plan form offers ("мультиселект из панели"). */
  @Get('squads')
  async squads() {
    return { items: await this.panel.squads() };
  }

  @Post('test')
  @HttpCode(200)
  async test() {
    try {
      return { ok: true, health: await this.panel.health() };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 300) };
    }
  }

  @Post('reconcile')
  @HttpCode(200)
  @Audit('panel.reconcile', 'panel')
  async reconcile() {
    const result = await this.panel.reconcile();
    return new Audited(null, result, result);
  }
}

@Controller('api/admin/v1/bot')
@UseGuards(AuthGuard)
@Roles('admin')
@Permissions('bot.write')
export class AdminBotController {
  constructor(
    private readonly settings: SettingsService,
    private readonly infra: Infrastructure,
  ) {}

  @Get()
  async get() {
    const group = await this.settings.getGroup('bot');
    return { settings: group };
  }

  @Put()
  @Audit('bot.update', 'settings')
  async update(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = botSchema.parse(body);
    const before = await this.settings.getGroup('bot');
    await this.settings.set({ bot: withoutReason(input) }, { id: request.admin?.id ?? '' });
    // Section 17.6: `bot.*` changes ask the bot to rebuild its transport.
    await this.infra.redis.publish('rr:bot.reconfigure', JSON.stringify({ at: Date.now() }));
    return new Audited(before, await this.settings.getGroup('bot'));
  }

  /** The console's «Поддержка» (FR-124, owner decision F35). */
  @Get('support')
  async support() {
    return supportView(this.settings);
  }

  /**
   * Saves the support contact, the operators' chat and the optional support
   * bot. A token is checked with `getMe` and must not be the shop bot's; an
   * empty token turns the support bot off, and an absent one keeps it.
   */
  @Put('support')
  @Audit('bot.support', 'settings')
  async updateSupport(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = supportSchema.parse(body);
    const actor = { id: request.admin?.id ?? '' };
    const before = await supportView(this.settings);
    await this.settings.set(
      {
        brand: {
          ...(input.contact === undefined ? {} : { support_contact: input.contact }),
          ...(input.chatId === undefined ? {} : { support_forward_chat_id: input.chatId }),
        },
      },
      actor,
    );
    if (input.token !== undefined) {
      try {
        await configureSupportBot(this.settings, input.token, actor);
      } catch (error) {
        if (!(error instanceof SupportBotRefused)) throw error;
        throw new ApiError(
          error.reason === 'invalid_token' ? 'SUPPORT_BOT_INVALID' : 'SUPPORT_BOT_SAME',
          HttpStatus.BAD_REQUEST,
          undefined,
          { fields: [{ path: ['token'], code: error.reason }] },
        );
      }
    }
    // Section 17.6: `bot.*` changes ask the bot to rebuild its transport.
    await this.infra.redis.publish('rr:bot.reconfigure', JSON.stringify({ at: Date.now() }));
    return new Audited(before, await supportView(this.settings));
  }

  @Post('test')
  @HttpCode(200)
  async test() {
    const token = String(await this.settings.get('bot.token'));
    if (!token) return { ok: false, error: 'BOT_TOKEN_MISSING' };
    const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
    try {
      const response = await fetch(`${base}/bot${encodeURIComponent(token)}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 300) };
    }
  }

  @Post('sync-commands')
  @HttpCode(200)
  @Audit('bot.sync-commands', 'bot')
  async syncCommands() {
    await this.infra.redis.publish('rr:bot.reconfigure', JSON.stringify({ at: Date.now() }));
    return new Audited(null, { requested: true }, { requested: true });
  }
}

@Controller('api/admin/v1/i18n')
@UseGuards(AuthGuard)
export class AdminI18nController {
  constructor(private readonly i18n: I18nAdminService) {}

  @Get('legal/:doc/:lang')
  @Permissions('legal.read')
  legal(@Param('doc') doc: string, @Param('lang') lang: string) {
    return this.i18n.legal(doc, lang);
  }

  @Put('legal/:doc/:lang')
  @Roles('admin')
  @Permissions('i18n.write')
  @Audit('i18n.legal', 'locale_override')
  setLegal(
    @Param('doc') doc: string,
    @Param('lang') lang: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.i18n.setLegal(doc, lang, body, request.admin?.id ?? '');
  }

  @Get(':lang/:namespace')
  @Roles('admin')
  @Permissions('i18n.read')
  entries(@Param('lang') lang: string, @Param('namespace') namespace: string) {
    return this.i18n.entries(lang, namespace);
  }

  @Put(':lang/:namespace')
  @Roles('admin')
  @Permissions('i18n.write')
  @Audit('i18n.patch', 'locale_override')
  patch(
    @Param('lang') lang: string,
    @Param('namespace') namespace: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.i18n.patch(lang, namespace, body, request.admin?.id ?? '');
  }
}

@Controller('api/admin/v1/themes')
@UseGuards(AuthGuard)
export class AdminThemeSettingsController {
  constructor(
    private readonly themes: ThemeService,
    private readonly settings: SettingsService,
    private readonly infra: Infrastructure,
  ) {}

  @Put('active')
  @Roles('admin')
  @Permissions('themes.write')
  @Audit('themes.active', 'settings')
  async setActive(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = themeActiveSchema.parse(body);
    const before = await this.themes.activeSlug();
    this.themes.load(input.slug);
    await this.settings.set({ theme: { slug: input.slug } }, { id: request.admin?.id ?? '' });
    // Section 17.6: `web` drops its cached theme when this lands.
    await this.infra.redis.publish('rr:theme.changed', JSON.stringify({ slug: input.slug }));
    return new Audited({ slug: before }, { slug: input.slug });
  }

  @Get(':slug')
  @Permissions('themes.read')
  tokens(@Param('slug') slug: string) {
    return this.themes.load(slug);
  }
}

@Controller('api/admin/v1/audit')
@UseGuards(AuthGuard)
export class AdminAuditController {
  constructor(private readonly infra: Infrastructure) {}

  /** Section 14.2: an operator only sees their own actions. */
  @Get()
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    const input = auditQuerySchema.parse(query ?? {});
    const role = (request.admin?.role ?? 'operator') as AdminRole;
    const own = !can(role, 'audit.read');
    const rows = await this.infra.db.auditLog.findMany({
      where: {
        ...(own ? { actorAdminId: request.admin?.id ?? '' } : {}),
        ...(input.actorId && !own ? { actorAdminId: input.actorId } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.entity ? { entity: input.entity } : {}),
        ...(input.entityId ? { entityId: input.entityId } : {}),
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        actorAdminId: row.actorAdminId,
        actorType: row.actorType,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        reason: row.reason,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      scope: own ? 'own' : 'all',
    };
  }
}

@Controller('api/admin/v1/system')
@UseGuards(AuthGuard)
@Permissions('system.read')
export class AdminSystemController {
  constructor(private readonly system: SystemService) {}

  @Get()
  overview() {
    return this.system.overview();
  }

  @Get('queues')
  queues() {
    return this.system.queues();
  }

  @Post('queues/:name/retry-failed')
  @HttpCode(200)
  @Roles('admin')
  @Permissions('system.write')
  @Audit('system.retry-failed', 'queue', 'name')
  retryFailed(@Param('name') name: string) {
    return this.system.retryFailed(name);
  }

  @Post('reconcile')
  @HttpCode(200)
  @Roles('admin')
  @Permissions('system.write')
  @Audit('system.reconcile', 'panel')
  reconcile() {
    return this.system.reconcile();
  }
}
