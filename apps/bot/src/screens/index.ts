import { randomUUID } from 'node:crypto';
import { InlineKeyboard, type Bot } from 'grammy';

import { ApiClientError, type ApiClient } from '../api-client.js';
import type { RrContext } from '../types.js';
import { showAccount, showHome, showTrialConfirm } from './home.js';
import { createPayment, checkPayment, showInvoice } from './payments.js';
import { STARS_START_PAYLOAD, sendStarsInvoice } from './stars.js';
import { showHelp } from './help.js';
import { showProfile } from './profile.js';
import { showPlan, showPlans } from './plans.js';
import { showReferralList, showReferrals } from './referrals.js';
import {
  confirmRevoke,
  removeDevice,
  showClients,
  showDevices,
  showGuide,
  showQr,
  showSubscription,
} from './subscription.js';
import { confirmPlanChange, payPlanChange, showPlanChange } from './plan-change.js';
import { backButton, formatDate, formatMinor, show } from './common.js';

export function registerScreens(bot: Bot<RrContext>, api: ApiClient): void {
  bot.command('start', (ctx) => {
    // FR-134: the site's Stars button opens `t.me/<bot>?start=inv_<id>`.
    const invoiceId = STARS_START_PAYLOAD.exec(ctx.match.trim())?.[1];
    return invoiceId ? sendStarsInvoice(ctx, api, invoiceId) : showHome(ctx, api);
  });
  bot.command('menu', (ctx) => showHome(ctx, api));
  bot.command('buy', (ctx) => showPlans(ctx, api));
  bot.command('sub', (ctx) => showSubscription(ctx, api));
  bot.command('promo', (ctx) => ctx.conversation.enter('promoEnter'));
  bot.callbackQuery('promo:enter', (ctx) => ctx.conversation.enter('promoEnter'));
  bot.callbackQuery('topup:custom', (ctx) => ctx.conversation.enter('topupCustom'));
  bot.command('balance', (ctx) => showBalance(ctx, api));
  bot.command('ref', (ctx) => showReferrals(ctx, api));
  bot.command('lang', (ctx) => showLanguage(ctx));
  bot.command('notifications', (ctx) => showNotifications(ctx, api));
  bot.command('help', (ctx) => showHelp(ctx, api));
  bot.command('support', (ctx) => showSupport(ctx, api));
  bot.command('admin_stats', (ctx) => adminStats(ctx, api));
  bot.command('admin_user', (ctx) => adminUser(ctx, api));
  bot.command('admin_extend', (ctx) => adminExtend(ctx, api));
  bot.command('admin_broadcast_status', (ctx) => adminBroadcastStatus(ctx, api));
  bot.callbackQuery('home', (ctx) => showHome(ctx, api));
  bot.callbackQuery('account', (ctx) => showAccount(ctx, api));
  bot.callbackQuery('profile', (ctx) => showProfile(ctx, api));
  bot.callbackQuery('profile:email', (ctx) => ctx.conversation.enter('emailAsk'));
  bot.callbackQuery('plans', (ctx) => showPlans(ctx, api));
  bot.callbackQuery('sub', (ctx) => showSubscription(ctx, api));
  bot.callbackQuery('sub:clients', (ctx) => showClients(ctx, api));
  bot.callbackQuery('sub:qr', (ctx) => showQr(ctx, api));
  bot.callbackQuery('sub:devices', (ctx) => showDevices(ctx, api));
  bot.callbackQuery(/^dev:rm:([\w-]{1,8})$/u, (ctx) =>
    removeDevice(ctx, api, capture(ctx.match, 1)),
  );
  bot.callbackQuery(/^sub:guide:(ios|android|windows|macos|linux)$/u, (ctx) =>
    showGuide(ctx, capture(ctx.match, 1)),
  );
  bot.callbackQuery('plan:change', (ctx) => showPlanChange(ctx, api));
  bot.callbackQuery(/^plan:change:go:([a-z0-9_-]+):([a-z-]+)$/u, (ctx) =>
    payPlanChange(ctx, api, capture(ctx.match, 1), capture(ctx.match, 2)),
  );
  bot.callbackQuery(/^plan:change:([a-z0-9_-]+)$/u, (ctx) =>
    confirmPlanChange(ctx, api, capture(ctx.match, 1)),
  );
  bot.callbackQuery('sub:revoke', (ctx) => confirmRevoke(ctx));
  bot.callbackQuery('sub:revoke:go', async (ctx) => {
    try {
      await api.revokeSubscription(ctx.from.id);
      await showSubscription(ctx, api);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'REVOKE_RATE_LIMITED')
        await show(ctx, ctx.t('bot.error.revoke_rate_limited'), backButton(ctx, 'sub'));
      else throw error;
    }
  });
  bot.callbackQuery(/^plan:([a-z0-9_-]+)$/u, (ctx) => showPlan(ctx, api, capture(ctx.match, 1)));
  bot.callbackQuery(/^pay:([a-z0-9_-]+):([a-z-]+)$/u, (ctx) =>
    createPayment(ctx, api, capture(ctx.match, 1), capture(ctx.match, 2)),
  );
  bot.callbackQuery(/^inv:check:([0-9a-f-]+)$/u, (ctx) =>
    checkPayment(ctx, api, capture(ctx.match, 1)),
  );
  bot.callbackQuery('trial:confirm', (ctx) => showTrialConfirm(ctx, api));
  bot.callbackQuery('trial:go', async (ctx) => {
    await api.startTrial(ctx.from.id);
    await showSubscription(ctx, api);
  });
  bot.callbackQuery('balance', (ctx) => showBalance(ctx, api));
  bot.callbackQuery('topup:open', (ctx) => showTopup(ctx, api));
  bot.callbackQuery(/^topup:(\d+)$/u, (ctx) =>
    showTopupProviders(ctx, api, Number(capture(ctx.match, 1))),
  );
  bot.callbackQuery(/^topup:(\d+):([a-z-]+)$/u, (ctx) =>
    createTopup(ctx, api, Number(capture(ctx.match, 1)), capture(ctx.match, 2)),
  );
  bot.callbackQuery('ref', (ctx) => showReferrals(ctx, api));
  bot.callbackQuery('ref:list', (ctx) => showReferralList(ctx, api));
  bot.callbackQuery('lang', (ctx) => showLanguage(ctx));
  bot.callbackQuery(/^lang:(ru|en)$/u, (ctx) =>
    setLanguage(ctx, api, capture(ctx.match, 1) as 'ru' | 'en'),
  );
  bot.callbackQuery('support', (ctx) => showSupport(ctx, api));
  bot.callbackQuery('support:end', (ctx) => endSupport(ctx, api));
  bot.callbackQuery('notif:toggle', (ctx) => toggleNotifications(ctx, api));
  bot.callbackQuery('email:ask', (ctx) =>
    show(ctx, ctx.t('bot.screen.email.ask'), backButton(ctx)),
  );
}

export async function showBalance(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from) return;
  const [state, transactions] = await Promise.all([
    api.getMe(ctx.from.id),
    api.getTransactions(ctx.from.id, 5),
  ]);
  // Section 12 `balance`: the last five operations, dated in the shop's zone.
  const recent =
    transactions.items.length > 0
      ? `\n${ctx.t('bot.screen.balance.transactions')}\n${transactions.items
          .map(
            (item) =>
              `${formatDate(item.createdAt, ctx.locale)} · ${ctx.t(`bot.screen.balance.type.${item.type}`)} · ${formatMinor(item.amount.amountMinor, item.amount.currency)}`,
          )
          .join('\n')}`
      : '';
  const keyboard = new InlineKeyboard()
    .text(ctx.t('bot.btn.topup'), 'topup:open')
    .row()
    .text(ctx.t('bot.btn.back'), 'home');
  // Section 15.2: held referral rewards are shown as pending.
  const held =
    state.balanceHeld.amountMinor > 0
      ? `\n${ctx.t('bot.screen.balance.held', { held: formatMinor(state.balanceHeld.amountMinor, state.balanceHeld.currency) })}`
      : '';
  await show(
    ctx,
    `${ctx.t('bot.screen.balance.details', { balance: formatMinor(state.balance.amountMinor, state.balance.currency) })}${held}\n${recent}`,
    keyboard,
  );
}

async function showTopup(ctx: RrContext, api: ApiClient): Promise<void> {
  const config = await api.getTopupConfig();
  const keyboard = new InlineKeyboard();
  for (const amount of config.presetsMinor)
    keyboard.text(formatMinor(amount), `topup:${String(amount)}`).row();
  keyboard.text(ctx.t('bot.btn.back'), 'balance');
  await show(ctx, ctx.t('bot.screen.topup.title'), keyboard);
}

/** FR-071: the providers a top-up can be paid through — never the balance. */
export function topupProviders(methods: Awaited<ReturnType<ApiClient['getPaymentMethods']>>) {
  return methods.items.filter((item) => item.available && item.kind !== 'balance');
}

/** The customer's provider choice for a top-up, as `pay:<slug>:<provider>` is for a plan. */
export function topupProviderKeyboard(
  ctx: { t: (key: string) => string; locale: RrContext['locale'] },
  providers: ReturnType<typeof topupProviders>,
  amountMinor: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const provider of providers)
    keyboard
      .text(
        provider.displayName[ctx.locale] ?? provider.code,
        `topup:${String(amountMinor)}:${provider.code}`,
      )
      .row();
  return keyboard.text(ctx.t('bot.btn.back'), 'topup:open');
}

export async function showTopupProviders(
  ctx: RrContext,
  api: ApiClient,
  amountMinor: number,
): Promise<void> {
  if (!ctx.from) return;
  const providers = topupProviders(await api.getPaymentMethods(ctx.from.id));
  const [only] = providers;
  if (!only) {
    await show(ctx, ctx.t('bot.error.provider_unavailable'), backButton(ctx, 'balance'));
    return;
  }
  if (providers.length === 1) {
    await createTopup(ctx, api, amountMinor, only.code);
    return;
  }
  await show(
    ctx,
    ctx.t('bot.screen.topup.provider', { amount: formatMinor(amountMinor) }),
    topupProviderKeyboard(ctx, providers, amountMinor),
  );
}

async function createTopup(
  ctx: RrContext,
  api: ApiClient,
  amountMinor: number,
  provider: string,
): Promise<void> {
  if (!ctx.from) return;
  const invoice = await api.createInvoice(
    ctx.from.id,
    { kind: 'topup', provider, amountMinor },
    randomUUID(),
  );
  ctx.session.lastInvoiceId = invoice.id;
  await showInvoice(ctx, invoice);
}

async function showLanguage(ctx: RrContext): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(ctx.t('bot.lang.ru'), 'lang:ru')
    .text(ctx.t('bot.lang.en'), 'lang:en')
    .row()
    .text(ctx.t('bot.btn.back'), 'home');
  await show(ctx, ctx.t('bot.screen.lang.title'), keyboard);
}

async function setLanguage(ctx: RrContext, api: ApiClient, language: 'ru' | 'en'): Promise<void> {
  if (!ctx.from) return;
  await api.patchMe(ctx.from.id, { language });
  ctx.session.lang = language;
  ctx.locale = language;
  await showHome(ctx, api);
}

async function showNotifications(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from) return;
  const state = await api.getMe(ctx.from.id);
  const keyboard = new InlineKeyboard()
    .text(ctx.t('bot.screen.notifications.enabled'), 'notif:toggle')
    .row()
    .text(ctx.t('bot.btn.back'), 'home');
  await show(
    ctx,
    ctx.t(
      state.marketingOptOut
        ? 'bot.screen.notifications.disabled'
        : 'bot.screen.notifications.enabled',
    ),
    keyboard,
  );
}

async function toggleNotifications(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from) return;
  const state = await api.getMe(ctx.from.id);
  await api.patchMe(ctx.from.id, { marketingOptOut: !state.marketingOptOut });
  await showNotifications(ctx, api);
}

function capture(match: string | RegExpMatchArray, index: number): string {
  return typeof match === 'string' ? match : (match[index] ?? '');
}

async function isAdmin(ctx: RrContext, api: ApiClient): Promise<boolean> {
  if (!ctx.from) return false;
  try {
    await api.getAdminRole(ctx.from.id);
    return true;
  } catch {
    return false;
  }
}

async function adminStats(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from || !(await isAdmin(ctx, api))) return;
  const stats = await api.adminStats(ctx.from.id);
  await ctx.reply(
    ctx.t('bot.admin.stats') + `\n${String(stats.users)} / ${String(stats.activeSubscriptions)}`,
  );
}

async function adminUser(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from || !(await isAdmin(ctx, api))) return;
  const query = ctx.message?.text?.split(/\s+/u)[1];
  if (!query) return;
  const user = await api.adminUser(ctx.from.id, query);
  await ctx.reply(ctx.t('bot.admin.user', { id: user.telegramId }));
}

async function adminExtend(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from || !(await isAdmin(ctx, api))) return;
  const [, target, rawDays] = ctx.message?.text?.split(/\s+/u) ?? [];
  const days = Number(rawDays);
  if (!target || !Number.isInteger(days)) return;
  const result = await api.adminExtend(ctx.from.id, target, days);
  await ctx.reply(ctx.t('bot.admin.extended', { days: result.days }));
}

async function adminBroadcastStatus(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from || !(await isAdmin(ctx, api))) return;
  const status = await api.adminBroadcastStatus(ctx.from.id);
  await ctx.reply(
    status
      ? `${status.status}: ${String(status.sent)}/${String(status.total)}`
      : ctx.t('bot.admin.broadcast'),
  );
}

/**
 * FR-124: the support contact, and, when the operators' chat is configured,
 * a conversation with the operators: everything the customer writes goes to
 * them until «Завершить» (owner decision F35; section 12's one-message
 * `supportMessage` dialog made a customer press «Поддержка» for every reply).
 */
export async function showSupport(ctx: RrContext, api: ApiClient): Promise<void> {
  const config = await api.getConfig();
  const contact = config.supportContact
    ? `\n\n${ctx.t('bot.screen.support.details', { contact: config.supportContact })}`
    : '';
  // F35: support runs in a bot of its own; the customer writes there.
  if (config.supportBot) {
    await show(
      ctx,
      `${ctx.t('bot.screen.support.bot', { username: config.supportBot.username })}${contact}`,
      new InlineKeyboard()
        .url(ctx.t('bot.btn.supportBot'), `https://t.me/${config.supportBot.username}`)
        .row()
        .text(ctx.t('bot.btn.back'), 'home'),
    );
    return;
  }
  if (config.supportForwardChatId !== null && ctx.from) {
    try {
      await api.openSupport(ctx.from.id);
      await show(
        ctx,
        `${ctx.t('bot.screen.support.open')}${contact}`,
        new InlineKeyboard()
          .text(ctx.t('bot.btn.supportEnd'), 'support:end')
          .row()
          .text(ctx.t('bot.btn.back'), 'home'),
      );
      return;
    } catch (error) {
      if (!(error instanceof ApiClientError)) throw error;
    }
  }
  await show(
    ctx,
    config.supportContact
      ? ctx.t('bot.screen.support.details', { contact: config.supportContact })
      : ctx.t('bot.screen.support.none'),
    backButton(ctx),
  );
}

/** «Завершить»: the customer's messages stay with the bot again. */
export async function endSupport(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from) return;
  await api.closeSupport(ctx.from.id);
  await show(ctx, ctx.t('bot.screen.support.ended'), backButton(ctx));
}
