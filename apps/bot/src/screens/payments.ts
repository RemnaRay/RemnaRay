import { randomUUID } from 'node:crypto';
import { InlineKeyboard } from 'grammy';

import { ApiClientError, type ApiClient, type InvoiceView } from '../api-client.js';
import type { RrContext } from '../types.js';
import { backButton, formatDate, formatMinor, formatTime, show } from './common.js';

export async function createPayment(
  ctx: RrContext,
  api: ApiClient,
  slug: string,
  provider: string,
): Promise<void> {
  if (!ctx.from) return;
  const plan = (await api.getPlans()).items.find((item) => item.slug === slug);
  if (!plan) {
    await show(ctx, ctx.t('bot.error.invoice_expired'), backButton(ctx, 'plans'));
    return;
  }
  const invoice = await api.createInvoice(
    ctx.from.id,
    { kind: 'purchase', planId: plan.id, provider },
    randomUUID(),
  );
  ctx.session.lastInvoiceId = invoice.id;
  await showInvoice(ctx, invoice);
}

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
    await showInvoice(ctx, await api.getInvoice(ctx.from.id, invoiceId), note);
  }
}

export async function showInvoice(
  ctx: RrContext,
  invoice: InvoiceView,
  note?: string,
): Promise<void> {
  if (invoice.status === 'paid') {
    await show(ctx, ctx.t('bot.screen.pay.ok'), backButton(ctx));
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
    price: formatMinor(invoice.amount.amountMinor, invoice.amount.currency),
    until: formatDate(invoice.expiresAt, ctx.locale),
  });
  await show(ctx, note ? `${wait}\n\n${note}` : wait, keyboard);
}
