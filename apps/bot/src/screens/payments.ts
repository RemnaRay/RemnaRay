import { InlineKeyboard } from 'grammy';

import { ApiClientError, type ApiClient, type InvoiceView } from '../api-client.js';
import type { RrContext } from '../types.js';
import { backButton, formatDate, formatMinor, formatTime, show } from './common.js';

/**
 * FR-064 «Проверить оплату». The answer always changes the screen: a paid
 * invoice shows its success, and one still unpaid says when it was checked
 * — or that checks are one per 10 seconds, or that the payment system did
 * not answer — so a press is never left without a visible answer (F30).
 */
export async function checkPayment(
  ctx: RrContext,
  api: ApiClient,
  invoiceId: string,
): Promise<void> {
  if (!ctx.from) return;
  const checkedAt = formatTime(new Date(), ctx.locale);
  try {
    const invoice = await api.checkInvoice(ctx.from.id, invoiceId);
    await showInvoice(
      ctx,
      api,
      invoice,
      invoice.status === 'pending'
        ? ctx.t('bot.screen.pay.notYet', { time: checkedAt })
        : undefined,
    );
  } catch (error) {
    const note =
      error instanceof ApiClientError && error.status === 429
        ? ctx.t('bot.screen.pay.checkLimit', { time: checkedAt })
        : error instanceof ApiClientError && error.code === 'PROVIDER_UNAVAILABLE'
          ? ctx.t('bot.screen.pay.checkFailed', { time: checkedAt })
          : undefined;
    if (!note) throw error;
    await showInvoice(ctx, api, await api.getInvoice(ctx.from.id, invoiceId), note);
  }
}

export async function showInvoice(
  ctx: RrContext,
  api: ApiClient,
  invoice: InvoiceView,
  note?: string,
): Promise<void> {
  if (invoice.status === 'paid' || invoice.status === 'underpaid') {
    if (invoice.kind !== 'topup') {
      await show(ctx, ctx.t('bot.screen.pay.ok'), backButton(ctx));
      return;
    }
    // F37: the money is on the balance; the purchase is the customer's next step.
    const keyboard = new InlineKeyboard();
    if (invoice.target) {
      const plan = (await api.getPlans()).items.find((item) => item.id === invoice.target?.planId);
      if (plan)
        keyboard
          .text(
            ctx.tPlain('bot.btn.buyPlan', {
              plan: plan.name[ctx.locale] ?? plan.name['ru'] ?? plan.slug,
            }),
            `tb:${invoice.id}`,
          )
          .row();
    }
    keyboard.text(ctx.t('bot.btn.balance'), 'balance').row().text(ctx.t('bot.btn.back'), 'home');
    await show(
      ctx,
      ctx.t('bot.screen.pay.credited', {
        amount: formatMinor(invoice.amount.amountMinor, invoice.amount.currency),
        hasNumber: invoice.number ? 'yes' : 'no',
        number: invoice.number ?? '',
      }),
      keyboard,
    );
    return;
  }
  const keyboard = new InlineKeyboard();
  // Section 11.3.6: a Stars invoice's link is its `pay` button.
  const payUrl = invoice.paymentUrl ?? invoice.starsInvoiceLink;
  if (payUrl) keyboard.url(ctx.t('bot.btn.pay'), payUrl).row();
  keyboard
    .text(ctx.t('bot.btn.check'), `inv:check:${invoice.id}`)
    .row()
    .text(ctx.t('bot.btn.back'), 'home');
  const wait = ctx.t('bot.screen.pay.wait', {
    hasNumber: invoice.number ? 'yes' : 'no',
    number: invoice.number ?? '',
    price: formatMinor(invoice.amount.amountMinor, invoice.amount.currency),
    until: formatDate(invoice.expiresAt, ctx.locale),
  });
  await show(ctx, note ? `${wait}\n\n${note}` : wait, keyboard);
}
