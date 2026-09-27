import { randomBytes } from 'node:crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import * as QRCode from 'qrcode';
import { createRemnawaveClient } from '@remnaray/remnawave-sdk';

import { Infrastructure } from '../../infra/infra.module';
import { equalSecret } from '../auth/auth.guards';
import {
  createTotp,
  encryptTotpSecret,
  decryptTotpSecret,
  hashAdminPassword,
  totpFromBase32,
} from '../admin/admin.crypto';
import { SupportBotRefused, configureSupportBot } from '../bot/support-bot';
import { NotifyService } from '../notify/notify.service';
import { PaymentProviderRegistry } from '../payments/payments.registry';
import { PlansService } from '../plans/plans.service';
import { ThemeService } from '../public/theme.service';
import { withStarsRuntime } from '../payments/payments.service';
import { encryptSetting } from '../settings/settings.crypto';
import { SettingsService } from '../settings/settings.service';
import {
  SETUP_STEPS,
  setupAdminSchema,
  setupBotCheckSchema,
  setupBotSchema,
  setupBrandSchema,
  setupDomainSchema,
  setupPanelSchema,
  setupPaymentsSchema,
  setupPlanSchema,
  setupProviderCheckSchema,
  setupStepBodies,
  setupTokenSchema,
  type SetupStep,
} from './setup.schemas';
import { providerFields } from '../payments/provider-fields';

/** FR-171: the wizard session lives one hour after the token is accepted. */
const SESSION_TTL = 60 * 60;
/** Section 17.4 step 0: five wrong tokens block the address for fifteen minutes. */
const TOKEN_ATTEMPTS = 5;
const TOKEN_BLOCK_SECONDS = 15 * 60;
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };

export class SetupFailure extends HttpException {
  constructor(code: string, status: number) {
    super({ error: { code, message: code } }, status);
  }
}

type PendingAdmin = { email: string; passwordHash: string; secretEnc: string };
type SetupSession = { pendingAdmin?: PendingAdmin };
type Draft = Record<string, unknown>;

/**
 * Section 17.4. Every step validates on the server, writes straight into the
 * settings and target tables, and keeps a secret-free draft in `setup_state`
 * so an interrupted wizard can be resumed.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);
  private readonly appKey = process.env.RR_APP_KEY ?? '';

  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly plans: PlansService,
    private readonly themes: ThemeService,
    private readonly providers: PaymentProviderRegistry,
    private readonly notify: NotifyService,
  ) {}

  /** Step 0. Answers with the session id the controller puts in `rr_setup`. */
  async token(body: unknown, ip: string): Promise<{ sessionId: string }> {
    const input = setupTokenSchema.parse(body);
    const attemptKey = `rr:setup:attempts:${ip}`;
    const attempts = await this.infra.redis.incr(attemptKey);
    if (attempts === 1) await this.infra.redis.expire(attemptKey, TOKEN_BLOCK_SECONDS);
    if (attempts > TOKEN_ATTEMPTS) throw new SetupFailure('RATE_LIMITED', 429);

    if (!(await this.verifyToken(input.token))) throw new SetupFailure('UNAUTHENTICATED', 401);

    await this.infra.redis.del(attemptKey);
    const sessionId = randomBytes(32).toString('base64url');
    await this.infra.redis.set(this.sessionKey(sessionId), JSON.stringify({}), 'EX', SESSION_TTL);
    return { sessionId };
  }

  /**
   * `GET /api/setup/v1/state`: the current step and the secret-free draft.
   * The draft still names the domain, the panel and the brand, so it is only
   * served to a wizard session; without one the answer says which step to show.
   */
  async state(sessionId: string) {
    const row = await this.row();
    const authenticated = sessionId
      ? (await this.infra.redis.exists(this.sessionKey(sessionId))) === 1
      : false;
    if (!authenticated)
      return { authenticated: false as const, completed: row.completed, step: '0' };
    const draft = this.draft(row.data);
    return {
      authenticated: true as const,
      completed: row.completed,
      step: row.currentStep ?? '1',
      draft,
      defaults: {
        domain: process.env.RR_DOMAIN ?? '',
        acmeEmail: process.env.RR_ACME_EMAIL ?? '',
        tlsMode: process.env.RR_TLS_MODE ?? 'acme',
        proxyProfile: process.env.RR_PROXY_PROFILE ?? 'nginx',
        themeUpload: process.env.RR_THEME_UPLOAD === 'true',
      },
      themes: this.themes.list().filter((theme) => !theme.builtin),
      providers: this.providers
        .list()
        .filter((provider) => provider.capabilities.kind !== 'balance')
        .map((provider) => ({
          code: provider.code,
          kind: provider.capabilities.kind,
          receipts: provider.capabilities.receipts,
          fields: providerFields(provider.configSchema),
        })),
      steps: SETUP_STEPS,
    };
  }

  async submit(step: string, body: unknown, sessionId: string): Promise<unknown> {
    if (!SETUP_STEPS.includes(step as SetupStep)) throw new SetupFailure('NOT_FOUND', 404);
    const session = await this.session(sessionId);
    const parsed = setupStepBodies[step as SetupStep].parse(body);
    switch (step as SetupStep) {
      case '1':
        return await this.stepAdmin(
          parsed as ReturnType<typeof setupAdminSchema.parse>,
          sessionId,
          session,
        );
      case '2':
        return await this.stepDomain(parsed as ReturnType<typeof setupDomainSchema.parse>);
      case '3':
        return await this.stepPanel(parsed as ReturnType<typeof setupPanelSchema.parse>);
      case '4':
        return await this.stepBot(parsed as ReturnType<typeof setupBotSchema.parse>);
      case '5':
        return await this.stepBrand(parsed as ReturnType<typeof setupBrandSchema.parse>);
      case '6':
        return await this.stepPlan(parsed as ReturnType<typeof setupPlanSchema.parse>, body);
      default:
        return await this.stepPayments(parsed as ReturnType<typeof setupPaymentsSchema.parse>);
    }
  }

  /** Step 3's «Проверить»: `system.stats` plus `squads.list` (section 17.4). */
  async checkPanel(body: unknown, sessionId: string) {
    await this.session(sessionId);
    const input = setupPanelSchema.parse(body);
    const client = createRemnawaveClient({
      baseUrl: input.baseUrl,
      apiToken: input.apiToken,
      extraHeaders: input.extraHeaders,
    });
    try {
      const health = await client.system.health();
      if (!health.ok) return { ok: false as const, error: 'PANEL_UNAVAILABLE' };
      const squads = await client.squads.list();
      return {
        ok: true as const,
        version: health.version ?? null,
        squads: squads.map((squad) => ({ uuid: squad.uuid, name: squad.name })),
        webhook: await this.panelWebhookHints(input.webhookSecret),
      };
    } catch (error) {
      return { ok: false as const, error: this.reason(error) };
    } finally {
      await client.close();
    }
  }

  /** Step 4's «Проверить»: `getMe` only; the webhook is set when step 8 runs. */
  async checkBot(body: unknown, sessionId: string) {
    await this.session(sessionId);
    const input = setupBotCheckSchema.parse(body);
    try {
      const me = await this.getMe(input.token);
      return me
        ? { ok: true as const, username: me.username, id: me.id }
        : { ok: false as const, error: 'BOT_TOKEN_INVALID' };
    } catch (error) {
      return { ok: false as const, error: this.reason(error) };
    }
  }

  /**
   * A payment provider the owner configures. The built-in balance (FR-070,
   * section 11.3.7) has no configuration and no row: one would be offered as
   * a second payment method, and a top-up through it pays from the balance.
   */
  private configurable(code: string): boolean {
    return this.providers.has(code) && this.providers.get(code).capabilities.kind !== 'balance';
  }

  /** Step 7's per-provider «Проверить». */
  async checkProvider(body: unknown, sessionId: string) {
    await this.session(sessionId);
    const input = setupProviderCheckSchema.parse(body);
    if (!this.configurable(input.code)) throw new SetupFailure('NOT_FOUND', 404);
    // FR-061: a configuration the provider's schema refuses is a
    // VALIDATION_ERROR naming the field, not a failed healthcheck.
    const config = this.providers.get(input.code).configSchema.parse(input.config) as Record<
      string,
      unknown
    >;
    const started = Date.now();
    try {
      return await this.providers
        .get(input.code)
        .healthcheck(await this.providerRuntime(input.code, config));
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: this.reason(error) };
    }
  }

  async uploadLogo(
    sessionId: string,
    themeSlug: string,
    filename: string,
    mimetype: string,
    contents: Buffer,
  ) {
    await this.session(sessionId);
    if (process.env.RR_THEME_UPLOAD !== 'true') throw new SetupFailure('NOT_FOUND', 404);
    return this.themes.uploadLogo(themeSlug, filename, mimetype, contents);
  }

  /**
   * Step 8. One transaction flips `setup.completed`, then the bot is asked to
   * rebuild its transport (`setWebhook`, `setMyCommands` — section 17.6), the
   * panel reconciliation is queued and the administrators are alerted.
   */
  async finish(sessionId: string) {
    await this.session(sessionId);
    const row = await this.row();
    const draft = this.draft(row.data);
    const missing = ['admin', 'domain', 'panel', 'bot', 'brand', 'plan'].filter(
      (key) => !(key in draft),
    );
    if (missing.length > 0) throw new SetupFailure('VALIDATION_ERROR', 400);

    await this.settings.set({ setup: { completed: true, step: 'done' } });
    await this.infra.db.$transaction(async (tx) => {
      await tx.setupState.update({
        where: { id: 1 },
        data: { completed: true, currentStep: 'done', updatedAt: new Date() },
      });
      await tx.outboxJob.create({
        data: {
          queue: 'panel',
          name: 'panel.reconcile-all',
          payload: { reason: 'setup' },
          jobId: 'panel:setup-reconcile',
        },
      });
    });
    await this.infra.redis.publish('rr:bot.reconfigure', JSON.stringify({ at: Date.now() }));
    await this.infra.redis.publish('rr:theme.changed', JSON.stringify({ at: Date.now() }));
    await this.infra.redis.publish('rr:i18n.changed', JSON.stringify({ at: Date.now() }));
    await this.infra.redis.del(this.sessionKey(sessionId));
    await this.notify.alert({ type: 'setup.completed' }).catch((error: unknown) => {
      this.logger.warn(`Launch alert failed: ${String(error)}`);
    });

    const username = String(await this.settings.get('bot.username'));
    const domain = String(await this.settings.get('domain.main'));
    return {
      completed: true,
      botLink: username ? `https://t.me/${username}` : null,
      adminUrl: `https://${domain}/admin`,
    };
  }

  // --- steps -------------------------------------------------------------

  private async stepAdmin(
    input: ReturnType<typeof setupAdminSchema.parse>,
    sessionId: string,
    session: SetupSession,
  ) {
    if (!input.code) {
      const totp = createTotp(input.email);
      const pendingAdmin: PendingAdmin = {
        email: input.email,
        passwordHash: await hashAdminPassword(input.password),
        secretEnc: encryptTotpSecret(totp.secret.base32, this.appKey),
      };
      await this.saveSession(sessionId, { ...session, pendingAdmin });
      const otpauthUrl = totp.toString();
      const dataUrl = await QRCode.toDataURL(otpauthUrl, { width: 256, margin: 2 });
      const comma = dataUrl.indexOf(',');
      return {
        confirmed: false,
        otpauthUrl,
        qrPng: comma < 0 ? dataUrl : dataUrl.slice(comma + 1),
      };
    }

    const pending = session.pendingAdmin;
    if (!pending || pending.email !== input.email) throw new SetupFailure('VALIDATION_ERROR', 400);
    const secret = decryptTotpSecret(pending.secretEnc, this.appKey);
    if (totpFromBase32(secret, pending.email).validate({ token: input.code, window: 1 }) === null)
      throw new SetupFailure('ADMIN_TOTP_INVALID', 401);

    const admin = await this.infra.db.admin.upsert({
      where: { email: pending.email },
      create: {
        email: pending.email,
        passwordHash: pending.passwordHash,
        role: 'admin',
        totpEnabled: true,
        totpSecretEnc: encryptTotpSecret(secret, this.appKey),
      },
      update: {
        passwordHash: pending.passwordHash,
        role: 'admin',
        isActive: true,
        deletedAt: null,
        totpEnabled: true,
        totpSecretEnc: encryptTotpSecret(secret, this.appKey),
      },
    });
    await this.saveSession(sessionId, {});
    await this.advance('1', { admin: { email: admin.email, created: true } });
    await this.audit('setup.admin', 'admin', admin.id, { email: this.maskEmail(admin.email) });
    return { confirmed: true, adminId: admin.id };
  }

  private async stepDomain(input: ReturnType<typeof setupDomainSchema.parse>) {
    await this.settings.set({
      domain: { main: input.main, acme_email: input.acmeEmail, extra_domains: input.extraDomains },
    });
    await this.advance('2', { domain: input });
    return { saved: true };
  }

  private async stepPanel(input: ReturnType<typeof setupPanelSchema.parse>) {
    const check = await this.checkPanelDirect(input);
    if (!check.ok) throw new SetupFailure('PANEL_UNAVAILABLE', 503);
    const webhookSecret =
      input.webhookSecret ||
      String(await this.settings.get('panel.webhook_secret')) ||
      randomBytes(24).toString('hex');
    await this.settings.set({
      panel: {
        base_url: input.baseUrl,
        api_token: input.apiToken,
        webhook_secret: webhookSecret,
        extra_headers: input.extraHeaders,
      },
    });
    await this.advance('3', {
      panel: {
        baseUrl: input.baseUrl,
        tokenSet: true,
        version: check.version,
        squads: check.squads,
      },
    });
    return { saved: true, version: check.version, squads: check.squads, webhook: check.webhook };
  }

  private async stepBot(input: ReturnType<typeof setupBotSchema.parse>) {
    const me = await this.getMe(input.token);
    if (!me) throw new SetupFailure('VALIDATION_ERROR', 400);
    const secretPath =
      String(await this.settings.get('bot.webhook_secret_path')) ||
      randomBytes(24).toString('base64url');
    const secretToken =
      String(await this.settings.get('bot.webhook_secret_token')) ||
      randomBytes(24).toString('base64url');
    await this.settings.set({
      bot: {
        token: input.token,
        username: me.username,
        mode: input.mode,
        webhook_secret_path: secretPath,
        webhook_secret_token: secretToken,
        admin_language: input.adminLanguage,
      },
      brand: {
        support_contact: input.supportContact,
        ...(input.supportChatId === null ? {} : { support_forward_chat_id: input.supportChatId }),
      },
    });
    let supportBot: string | null = null;
    if (input.supportBotToken !== '') {
      try {
        supportBot = (await configureSupportBot(this.settings, input.supportBotToken)).username;
      } catch (error) {
        if (!(error instanceof SupportBotRefused)) throw error;
        throw new SetupFailure(
          error.reason === 'invalid_token' ? 'SUPPORT_BOT_INVALID' : 'SUPPORT_BOT_SAME',
          400,
        );
      }
    }
    await this.advance('4', {
      bot: {
        username: me.username,
        mode: input.mode,
        tokenSet: true,
        supportContact: input.supportContact,
        supportBot,
        supportChatId: input.supportChatId,
      },
    });
    return { saved: true, username: me.username, supportBot };
  }

  private async stepBrand(input: ReturnType<typeof setupBrandSchema.parse>) {
    this.themes.load(input.themeSlug);
    await this.settings.set({
      brand: { name: input.name, slogan: input.slogan },
      locale: {
        default: input.defaultLocale,
        enabled: input.enabledLocales,
        timezone: input.timezone,
      },
      theme: { slug: input.themeSlug },
      admin: { language: input.defaultLocale },
    });
    await this.advance('5', { brand: input });
    return { saved: true };
  }

  /**
   * `PlansService.create` validates its own input, and `planInputSchema`
   * transforms the money fields into `bigint`, so the already parsed plan
   * cannot be handed back to it — the untouched body is.
   */
  private async stepPlan(input: ReturnType<typeof setupPlanSchema.parse>, body: unknown) {
    // Re-submitting the step must not fail on the unique slug: the wizard is
    // resumable, so an already created plan is reused.
    const existing = await this.infra.db.plan.findUnique({
      where: { slug: input.plan.slug },
      select: { id: true, slug: true },
    });
    const plan = existing ?? (await this.plans.create((body as { plan: unknown }).plan));
    await this.settings.set({ trial: input.trial });
    await this.advance('6', {
      plan: { id: plan.id, slug: plan.slug, priceMinor: input.plan.priceMinor.toString() },
      trial: input.trial,
    });
    return { saved: true, planId: plan.id };
  }

  private async stepPayments(input: ReturnType<typeof setupPaymentsSchema.parse>) {
    const results: { code: string; ok: boolean; error?: string }[] = [];
    for (const provider of input.providers)
      if (!this.configurable(provider.code)) throw new SetupFailure('NOT_FOUND', 404);
    // Every configuration is checked against its schema before any is saved,
    // and saved as parsed, with the schema's defaults.
    const configs = input.providers.map(
      (provider) =>
        this.providers.get(provider.code).configSchema.parse(provider.config) as Record<
          string,
          unknown
        >,
    );
    for (const [index, provider] of input.providers.entries()) {
      const definition = this.providers.get(provider.code);
      const config = configs[index] ?? {};
      const health = await definition
        .healthcheck(await this.providerRuntime(provider.code, config))
        .catch((error: unknown) => ({ ok: false, latencyMs: 0, error: this.reason(error) }));
      await this.infra.db.paymentProvider.upsert({
        where: { code: provider.code },
        create: {
          code: provider.code,
          enabled: provider.enabled,
          displayName: provider.displayName ?? { ru: provider.code, en: provider.code },
          supportsReceipts: definition.capabilities.receipts,
          sortOrder: (results.length + 1) * 10,
          configEnc: encryptSetting(config, this.appKey).enc,
          lastHealthcheckAt: new Date(),
          lastHealthcheckOk: health.ok,
          lastHealthcheckError: health.error ?? null,
        },
        update: {
          enabled: provider.enabled,
          ...(provider.displayName ? { displayName: provider.displayName } : {}),
          configEnc: encryptSetting(config, this.appKey).enc,
          lastHealthcheckAt: new Date(),
          lastHealthcheckOk: health.ok,
          lastHealthcheckError: health.error ?? null,
        },
      });
      results.push({
        code: provider.code,
        ok: health.ok,
        ...(health.error ? { error: health.error } : {}),
      });
    }
    await this.settings.set({ fiscal: input.fiscal });
    await this.advance('7', {
      payments: { skipped: input.skipped, providers: results, fiscal: input.fiscal },
    });
    return { saved: true, providers: results };
  }

  // --- helpers -----------------------------------------------------------

  private async checkPanelDirect(input: ReturnType<typeof setupPanelSchema.parse>) {
    const client = createRemnawaveClient({
      baseUrl: input.baseUrl,
      apiToken: input.apiToken,
      extraHeaders: input.extraHeaders,
    });
    try {
      const health = await client.system.health();
      if (!health.ok) return { ok: false as const };
      const squads = await client.squads.list();
      return {
        ok: true as const,
        version: health.version ?? null,
        squads: squads.map((squad) => ({ uuid: squad.uuid, name: squad.name })),
        webhook: await this.panelWebhookHints(input.webhookSecret),
      };
    } catch {
      return { ok: false as const };
    } finally {
      await client.close();
    }
  }

  /** The three `.env` lines section 10.5 asks the owner to paste into the panel. */
  private async panelWebhookHints(webhookSecret?: string) {
    const domain = String(await this.settings.get('domain.main'));
    const secret =
      webhookSecret ||
      String(await this.settings.get('panel.webhook_secret')) ||
      randomBytes(24).toString('hex');
    return {
      WEBHOOK_ENABLED: 'true',
      WEBHOOK_URL: `https://${domain}/webhooks/remnawave`,
      WEBHOOK_SECRET_HEADER: secret,
    };
  }

  private async getMe(token: string): Promise<{ id: number; username: string } | null> {
    const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
    const response = await fetch(`${base}/bot${encodeURIComponent(token)}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string };
    };
    if (payload.ok !== true || typeof payload.result?.username !== 'string') return null;
    return { id: payload.result.id ?? 0, username: payload.result.username };
  }

  private async verifyToken(token: string): Promise<boolean> {
    const row = await this.row();
    if (row.tokenHash) return verify(row.tokenHash, token).catch(() => false);
    const expected = process.env.RR_SETUP_TOKEN ?? '';
    // R81: compared in constant time, like the stored hash is.
    if (!expected || !equalSecret(token, expected)) return false;
    await this.infra.db.setupState.update({
      where: { id: 1 },
      data: { tokenHash: await hash(expected, ARGON2_OPTIONS) },
    });
    return true;
  }

  private async row() {
    return this.infra.db.setupState.upsert({
      where: { id: 1 },
      create: { id: 1, data: {} },
      update: {},
    });
  }

  private draft(value: unknown): Draft {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Draft) : {};
  }

  private async advance(step: SetupStep, patch: Draft): Promise<void> {
    const row = await this.row();
    const data = { ...this.draft(row.data), ...patch };
    const next = String(Number(step) + 1);
    await this.infra.db.setupState.update({
      where: { id: 1 },
      data: { currentStep: next, data: data as never, updatedAt: new Date() },
    });
    await this.settings.set({ setup: { step: next } });
  }

  /** ADR-012: Stars are checked with the bot token step 4 saved, not a token of their own. */
  private providerRuntime(code: string, config: Record<string, unknown>) {
    return code === 'stars' ? withStarsRuntime(config, this.settings) : Promise.resolve(config);
  }

  private async session(sessionId: string): Promise<SetupSession> {
    const raw = sessionId ? await this.infra.redis.get(this.sessionKey(sessionId)) : null;
    if (!raw) throw new SetupFailure('UNAUTHENTICATED', 401);
    // The session slides so a long wizard is not cut off mid-step.
    await this.infra.redis.expire(this.sessionKey(sessionId), SESSION_TTL);
    return JSON.parse(raw) as SetupSession;
  }

  private async saveSession(sessionId: string, session: SetupSession): Promise<void> {
    await this.infra.redis.set(
      this.sessionKey(sessionId),
      JSON.stringify(session),
      'EX',
      SESSION_TTL,
    );
  }

  private sessionKey(id: string) {
    return `rr:setup:${id}`;
  }

  private reason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }

  private maskEmail(email: string): string {
    const [name, domain] = email.split('@');
    return `${name?.slice(0, 1) ?? '*'}***@${domain ?? 'unknown'}`;
  }

  private async audit(action: string, entity: string, entityId: string, after: unknown) {
    await this.infra.db.auditLog.create({
      data: { actorType: 'system', action, entity, entityId, after: after as never },
    });
  }
}
