import type { Bot } from 'grammy';

import { ApiClientError, type ApiClient } from '../api-client.js';
import type { RrContext } from '../types.js';
import { backButton, show } from './common.js';

/** `/start inv_<invoiceId>`, the deep link the site's Stars button opens (FR-134). */
export const STARS_START_PAYLOAD =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/**
 * A Stars payment update must never be dropped by the per-user rate limit:
 * Telegram expects the pre-checkout answer within ten seconds, and a
 * `successful_payment` means the stars have already been taken.
 */
export function isPaymentUpdate(ctx: RrContext): boolean {
  return Boolean(ctx.update.pre_checkout_query ?? ctx.update.message?.successful_payment);
}

function refusalKey(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 409)
    return error.code === 'INVOICE_EXPIRED'
      ? 'bot.error.invoice_expired'
      : 'bot.error.invoice_unavailable';
  return 'bot.error.payment_unavailable';
}

/** Section 11.3.6: the bot sends the shop's pending Stars invoice with `sendInvoice`. */
export async function sendStarsInvoice(
  ctx: RrContext,
  api: ApiClient,
  invoiceId: string,
): Promise<void> {
  if (!ctx.from) return;
  let invoice;
  try {
    invoice = await api.starsCreateLink(ctx.from.id, invoiceId);
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 409) throw error;
    await show(ctx, ctx.t(refusalKey(error)), backButton(ctx, 'plans'));
    return;
  }
  await ctx.replyWithInvoice(
    invoice.title,
    invoice.description,
    invoice.payload,
    'XTR',
    [{ label: invoice.title, amount: invoice.amount }],
    // A start parameter turns the Pay button of a forwarded copy into a deep
    // link, so only the invoice's owner is offered to pay it.
    { provider_token: '', start_parameter: invoice.payload },
  );
}

export function registerStars(bot: Bot<RrContext>, api: ApiClient): void {
  // Section 11.3.6: approve only a pending, unexpired invoice of this payer at
  // the amount it was issued for; anything else is declined with a reason.
  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    try {
      await api.starsPrecheckout({
        telegramId: query.from.id,
        invoicePayload: query.invoice_payload,
        totalAmount: query.total_amount,
        currency: query.currency,
      });
    } catch (error) {
      await ctx.answerPreCheckoutQuery(false, { error_message: ctx.t(refusalKey(error)) });
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  // The stars are already taken. A failure is thrown, not answered here: the
  // ingress keeps a failed `successful_payment` pending in the stream (it is
  // never acknowledged, whichever middleware failed) and it is redelivered
  // until the shop has recorded it; the endpoint is idempotent by the charge
  // id. The error handler tells the customer once that the payment is being
  // credited, and the shop's `payment.succeeded` follows on applying it.
  bot.on('message:successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    if (payment.currency !== 'XTR') return;
    await api.starsSuccessfulPayment({
      telegramId: ctx.from.id,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      providerPaymentChargeId: payment.provider_payment_charge_id,
      invoicePayload: payment.invoice_payload,
      totalAmount: payment.total_amount,
      currency: payment.currency,
    });
  });
}
