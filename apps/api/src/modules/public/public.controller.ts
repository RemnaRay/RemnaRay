import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { localeDirectory, SUPPORTED_LOCALES } from '@remnaray/i18n-core';

import { Infrastructure } from '../../infra/infra.module';
import { Permissions } from '../admin/admin.rbac';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from './i18n.service';
import { ThemeService } from './theme.service';

const LEGAL_DOCUMENTS = ['terms', 'privacy', 'offer'] as const;
type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];
const REFERRAL_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function isLegalDocument(value: string): value is LegalDocument {
  return LEGAL_DOCUMENTS.includes(value as LegalDocument);
}

@Controller('api/v1/public')
export class PublicController {
  constructor(
    private readonly themes: ThemeService,
    private readonly i18n: I18nService,
    private readonly settings: SettingsService,
  ) {}

  @Get('theme')
  async theme(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const tokens = await this.themes.active();
    reply.header('ETag', tokens.etag);
    reply.header('Cache-Control', 'public, max-age=60');
    if (ifNoneMatch === tokens.etag) {
      reply.status(304);
      return null;
    }
    return tokens;
  }

  @Get('config')
  async config() {
    const [
      name,
      slogan,
      supportContact,
      botUsername,
      defaultLocale,
      enabled,
      adminLanguage,
      trialEnabled,
      trialDays,
      topupEnabled,
      referralEnabled,
      hidePoweredBy,
      termsUpdatedAt,
      privacyUpdatedAt,
      clients,
    ] = await Promise.all([
      this.settings.get('brand.name'),
      this.settings.get('brand.slogan'),
      this.settings.get('brand.support_contact'),
      this.settings.get('bot.username'),
      this.settings.get('locale.default'),
      this.settings.get('locale.enabled'),
      this.settings.get('admin.language'),
      this.settings.get('trial.enabled'),
      this.settings.get('trial.days'),
      this.settings.get('balance.topup_enabled'),
      this.settings.get('referral.enabled'),
      this.settings.get('brand.hide_powered_by'),
      this.settings.get('legal.terms_updated_at'),
      this.settings.get('legal.privacy_updated_at'),
      this.settings.get('clients.items'),
    ]);

    return {
      brand: {
        name: String(name),
        slogan,
        supportContact: String(supportContact),
        botUsername: String(botUsername),
        hidePoweredBy: Boolean(hidePoweredBy),
      },
      // `admin` is the console language: its sign-in page renders before any
      // session exists, so it is read here and not behind the admin API.
      locales: { default: defaultLocale, enabled, admin: adminLanguage },
      currency: 'RUB',
      features: {
        trial: { enabled: Boolean(trialEnabled), days: Number(trialDays) },
        topup: Boolean(topupEnabled),
        referral: Boolean(referralEnabled),
        promo: true,
      },
      clients,
      legal: {
        termsUpdatedAt: termsUpdatedAt ?? this.legalModifiedAt('terms'),
        privacyUpdatedAt: privacyUpdatedAt ?? this.legalModifiedAt('privacy'),
      },
    };
  }

  @Get('i18n/:lang/:namespace')
  async messages(
    @Param('lang') lang: string,
    @Param('namespace') namespace: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const catalog = await this.i18n.namespace(lang, namespace);
    reply.header('ETag', catalog.etag);
    reply.header('Cache-Control', 'public, max-age=60');
    if (ifNoneMatch === catalog.etag) {
      reply.status(304);
      return null;
    }
    return { lang: catalog.lang, namespace: catalog.namespace, messages: catalog.messages };
  }

  @Get('legal/:doc')
  async legal(@Param('doc') doc: string, @Query('lang') lang: string | undefined) {
    if (!isLegalDocument(doc)) throw new NotFoundException('NOT_FOUND');
    const locale =
      lang && SUPPORTED_LOCALES.includes(lang as (typeof SUPPORTED_LOCALES)[number])
        ? lang
        : String(await this.settings.get('locale.default'));
    const override = await this.legalOverride(doc, locale);
    const markdown = override ?? this.legalFile(doc, locale) ?? this.legalFile(doc, 'en') ?? '';
    const [brand, domain, support] = await Promise.all([
      this.settings.get('brand.name'),
      this.settings.get('domain.main'),
      this.settings.get('brand.support_contact'),
    ]);
    return {
      doc,
      lang: locale,
      markdown: markdown
        .replaceAll('{brand}', String(brand))
        .replaceAll('{domain}', String(domain))
        .replaceAll('{support}', String(support)),
      updatedAt: this.legalModifiedAt(doc),
    };
  }

  private legalFile(doc: LegalDocument, lang: string): string | null {
    const file = join(localeDirectory(), lang, 'legal', `${doc}.md`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  private legalModifiedAt(doc: LegalDocument): string | null {
    const file = join(localeDirectory(), 'en', 'legal', `${doc}.md`);
    return existsSync(file) ? statSync(file).mtime.toISOString() : null;
  }

  private async legalOverride(doc: LegalDocument, lang: string): Promise<string | null> {
    const catalog = await this.i18n.namespace(lang, 'legal');
    return catalog.messages[`legal.${doc}.markdown`] ?? null;
  }
}

@Controller('api/v1/r')
export class PublicReferralController {
  constructor(private readonly infra: Infrastructure) {}

  /** Section 9.4: stores the referral code for 30 days and returns to the site. */
  @Get(':code')
  async referral(@Param('code') code: string, @Res() reply: FastifyReply) {
    if (/^[A-Za-z0-9]{4,16}$/.test(code)) {
      const user = await this.infra.db.user.findUnique({
        where: { referralCode: code },
        select: { id: true },
      });
      if (user)
        reply.header(
          'set-cookie',
          `rr_ref=${encodeURIComponent(code)}; Max-Age=${String(REFERRAL_COOKIE_MAX_AGE)}; Path=/; Secure; SameSite=Lax`,
        );
    }
    return reply.redirect('/', 302);
  }
}

@Controller('api/admin/v1/themes')
@Permissions('themes.read')
export class AdminThemesController {
  constructor(private readonly themes: ThemeService) {}

  @Get()
  async list() {
    return { items: this.themes.list(), active: await this.themes.activeSlug() };
  }

  @Post('upload')
  @Permissions('themes.write')
  @HttpCode(200)
  async upload(@Req() request: FastifyRequest) {
    if (process.env.RR_THEME_UPLOAD !== 'true') throw new NotFoundException('NOT_FOUND');
    const file = await request.file();
    if (!file) throw new Error('A theme archive is required');
    return this.themes.uploadArchive(await file.toBuffer());
  }
}
