import { createHash, randomInt } from 'node:crypto';
import { InlineKeyboard } from 'grammy';

import {
  ApiClientError,
  type ApiClient,
  type CheckoutQuote,
  type PublicPlan,
} from '../api-client.js';
import type { RrContext } from '../types.js';
import { backButton, formatMinor, show } from './common.js';
import { showInvoice } from './payments.js';
import { showPlans } from './plans.js';

type Kind = 'purchase' | 'plan_change';
/** Where the card came from: the showcase / plan change, or a paid top-up's purpose. */
type Origin = { slug: string; kind: Kind; invoiceId?: string; promocode?: string };

/**
 * F37: the Idempotency-Key of a press — the same card pressed twice buys once;
 * a card drawn again (a new balance, a new price) has other callback data.
 */
export function stableKey(ctx: RrContext): string {
  const hex = createHash('sha256')
    .update(
      `${String(ctx.chat?.id)}:${String(ctx.callbackQuery?.message?.message_id)}:${ctx.callbackQuery?.data ?? ''}`,
    )
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A plan change's remainder melts ~0.4 ₽ an hour: up to 1 ₽ more than shown is the same offer. */
export function sameOffer(kind: Kind, shownMinor: number, quotedMinor: number): boolean {
  return kind === 'plan_change'
    ? quotedMinor >= shownMinor && quotedMinor - shownMinor <= 100
    : quotedMinor === shownMinor;
}

function planName(ctx: RrContext, plan: Pick<PublicPlan, 'name' | 'slug'>): string {
  return plan.name[ctx.locale] ?? plan.name['ru'] ?? plan.slug;
}

/**
 * F37: one card drawing = one nonce in its buttons' callback data. The bot edits a single menu
 * message, so without it a card redrawn on the same message would repeat an old press's
 * Idempotency-Key and the API would replay the old invoice.
 */
function renderNonce(): string {
  return randomInt(36 ** 6)
    .toString(36)
    .padStart(6, '0');
}

const SLUG = '([a-z0-9_-]{1,32})';
const UUID = '([0-9a-f-]{36})';
const NONCE = '([a-z0-9]{6})';

/** The registered callbacks of the card; `index.ts` registers exactly these. */
export const CARD_CALLBACKS = {
  buy: new RegExp(`^b([bc]):${SLUG}:(\\d+):${NONCE}$`, 'u'),
  topup: new RegExp(`^t([pc]):${SLUG}:([a-z-]+):${NONCE}$`, 'u'),
  confirm: new RegExp(`^tb:${UUID}$`, 'u'),
  buyFromConfirm: new RegExp(`^tbb:${UUID}:(\\d+):${NONCE}$`, 'u'),
  topupFromConfirm: new RegExp(`^tbt:${UUID}:([a-z-]+):${NONCE}$`, 'u'),
};

export function buyData(origin: Origin, toPayMinor: number, nonce: string): string {
  if (origin.invoiceId) return `tbb:${origin.invoiceId}:${String(toPayMinor)}:${nonce}`;
  return `${origin.kind === 'plan_change' ? 'bc' : 'bb'}:${origin.slug}:${String(toPayMinor)}:${nonce}`;
}

export function topupData(origin: Origin, provider: string, nonce: string): string {
  if (origin.invoiceId) return `tbt:${origin.invoiceId}:${provider}:${nonce}`;
  return `${origin.kind === 'plan_change' ? 'tc' : 'tp'}:${origin.slug}:${provider}:${nonce}`;
}

/** The card: the price, the balance, and either «Купить с баланса» or a top-up per provider. */
export async function showCheckout(
  ctx: RrContext,
  api: ApiClient,
  origin: Origin,
  note?: string,
): Promise<void> {
  if (!ctx.from) return;
  const back = origin.kind === 'plan_change' ? 'plan:change' : 'plans';
  const plan = (await api.getPlans()).items.find((item) => item.slug === origin.slug);
  if (!plan) {
    await show(ctx, ctx.t('bot.error.plan_unavailable'), backButton(ctx, back));
    return;
  }
  let quote: CheckoutQuote;
  try {
    quote = await api.getCheckoutQuote(ctx.from.id, plan.id, origin.kind, origin.promocode);
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      (error.code === 'PLAN_UNAVAILABLE' || error.code === 'PLAN_CHANGE_NOT_ALLOWED')
    ) {
      await show(
        ctx,
        ctx.t(
          origin.kind === 'plan_change'
            ? 'bot.screen.planChange.unavailable'
            : 'bot.error.plan_unavailable',
        ),
        backButton(ctx, back),
      );
      return;
    }
    throw error;
  }
  const methods = quote.missingMinor > 0 ? await api.getPaymentMethods(ctx.from.id) : { items: [] };
  const keyboard = new InlineKeyboard();
  const nonce = renderNonce();
  if (quote.missingMinor === 0)
    keyboard
      .text(
        ctx.tPlain(
          origin.kind === 'plan_change' ? 'bot.btn.changeFromBalance' : 'bot.btn.buyFromBalance',
          { price: formatMinor(quote.toPayMinor) },
        ),
        buyData(origin, quote.toPayMinor, nonce),
      )
      .row();
  for (const topup of quote.topups) {
    const method = methods.items.find((item) => item.code === topup.provider);
    keyboard
      .text(
        ctx.tPlain('bot.btn.topupFor', {
          amount: formatMinor(topup.amountMinor),
          provider: method?.displayName[ctx.locale] ?? method?.displayName['ru'] ?? topup.provider,
        }),
        topupData(origin, topup.provider, nonce),
      )
      .row();
  }
  keyboard.text(ctx.t('bot.btn.back'), back);
  const lines = [
    origin.kind === 'plan_change'
      ? ctx.t('bot.screen.checkout.change', {
          plan: planName(ctx, plan),
          price: formatMinor(quote.priceMinor),
          credit: formatMinor(quote.creditMinor),
          toPay: formatMinor(quote.toPayMinor),
        })
      : ctx.t('bot.screen.plan.details', {
          plan: planName(ctx, plan),
          price: formatMinor(quote.toPayMinor),
          days: plan.durationDays,
        }),
    ctx.t('bot.screen.checkout.balance', { balance: formatMinor(quote.availableMinor) }),
  ];
  if (quote.promocode && !quote.promocode.applied)
    lines.push(ctx.t('bot.screen.checkout.promoRefused', { code: quote.promocode.code }));
  if (quote.missingMinor > 0)
    lines.push(ctx.t('bot.screen.checkout.short', { missing: formatMinor(quote.missingMinor) }));
  if (note) lines.push(note);
  await show(ctx, lines.join('\n'), keyboard);
}

/** «Купить с баланса»: only at the price the card showed; otherwise the card is drawn again. */
export async function buyFromCard(
  ctx: RrContext,
  api: ApiClient,
  origin: Origin & { shownMinor: number },
): Promise<void> {
  if (!ctx.from) return;
  const plan = (await api.getPlans()).items.find((item) => item.slug === origin.slug);
  if (!plan) return showCheckout(ctx, api, origin);
  const quote = await api
    .getCheckoutQuote(ctx.from.id, plan.id, origin.kind, origin.promocode)
    .catch(() => null);
  if (
    !quote ||
    quote.missingMinor > 0 ||
    !sameOffer(origin.kind, origin.shownMinor, quote.toPayMinor)
  )
    return showCheckout(ctx, api, origin);
  try {
    const invoice = await api.createInvoice(
      ctx.from.id,
      {
        kind: origin.kind,
        planId: plan.id,
        // A code the card said is not applied is not sent: the server would refuse the purchase.
        ...(origin.promocode && quote.promocode?.applied ? { promocode: origin.promocode } : {}),
      },
      stableKey(ctx),
    );
    await showInvoice(ctx, api, invoice);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409)
      return showCheckout(ctx, api, origin);
    throw error;
  }
}

/** «Пополнить на X ₽»: a top-up for the plan; the server computes X again. */
export async function topupForPlan(
  ctx: RrContext,
  api: ApiClient,
  origin: Origin & { provider: string },
): Promise<void> {
  if (!ctx.from) return;
  const plan = (await api.getPlans()).items.find((item) => item.slug === origin.slug);
  if (!plan) return showCheckout(ctx, api, origin);
  try {
    const invoice = await api.createInvoice(
      ctx.from.id,
      {
        kind: 'topup',
        provider: origin.provider,
        forPlan: {
          planId: plan.id,
          kind: origin.kind,
          ...(origin.promocode ? { promocode: origin.promocode } : {}),
        },
      },
      stableKey(ctx),
    );
    ctx.session.lastInvoiceId = invoice.id;
    await showInvoice(ctx, api, invoice);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'BALANCE_SUFFICIENT')
      return showCheckout(ctx, api, origin);
    throw error;
  }
}

/** `tb:<invoiceId>`: the purpose of a paid top-up, as a card with a fresh quote. */
export async function originOfInvoice(
  ctx: RrContext,
  api: ApiClient,
  invoiceId: string,
): Promise<Origin | null> {
  if (!ctx.from) return null;
  const invoice = await api.getInvoice(ctx.from.id, invoiceId);
  if (!invoice.target) return null;
  return {
    slug: invoice.target.planSlug,
    kind: invoice.target.kind,
    invoiceId,
    ...(invoice.target.promocode ? { promocode: invoice.target.promocode } : {}),
  };
}

/**
 * `tb` / `tbb` / `tbt`: the card of a paid top-up's purpose. Without a purpose (an invoice that
 * was not for a plan) the customer is taken to the plans instead of a dead button.
 */
export async function confirmCard(
  ctx: RrContext,
  api: ApiClient,
  invoiceId: string,
  action: { shownMinor?: number; provider?: string } = {},
): Promise<void> {
  const origin = await originOfInvoice(ctx, api, invoiceId);
  if (!origin) return showPlans(ctx, api);
  if (action.shownMinor !== undefined)
    return buyFromCard(ctx, api, { ...origin, shownMinor: action.shownMinor });
  if (action.provider !== undefined)
    return topupForPlan(ctx, api, { ...origin, provider: action.provider });
  return showCheckout(ctx, api, origin);
}
