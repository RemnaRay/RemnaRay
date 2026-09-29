import { InlineKeyboard } from 'grammy';

import type { ApiClient } from '../api-client.js';
import type { RrContext } from '../types.js';
import { backButton, formatMinor, show } from './common.js';
import { showCheckout } from './checkout.js';

/**
 * Section 12 `plan:change` (FR-023, EX-06): every other public plan with its
 * quote — the credit for the unused time and what is left to pay.
 */
export async function showPlanChange(ctx: RrContext, api: ApiClient): Promise<void> {
  if (!ctx.from) return;
  const telegramId = ctx.from.id;
  const [state, plans] = await Promise.all([api.getSubscription(telegramId), api.getPlans()]);
  if (!state.subscription?.canChangePlan) {
    await show(ctx, ctx.t('bot.screen.planChange.unavailable'), backButton(ctx, 'sub'));
    return;
  }
  const currentId = state.subscription.plan?.id;
  const keyboard = new InlineKeyboard();
  for (const plan of plans.items.filter((item) => item.id !== currentId)) {
    let quote;
    try {
      quote = await api.getCheckoutQuote(telegramId, plan.id, 'plan_change');
    } catch {
      continue;
    }
    keyboard
      .text(
        ctx.tPlain('bot.btn.planChangeTo', {
          plan: plan.name[ctx.locale] ?? plan.name['ru'] ?? plan.slug,
          toPay: formatMinor(quote.toPayMinor),
        }),
        `plan:change:${plan.slug}`,
      )
      .row();
  }
  keyboard.text(ctx.t('bot.btn.back'), 'sub');
  await show(ctx, ctx.t('bot.screen.planChange.title'), keyboard);
}

/** `plan:change:<slug>`: the card of the change — the calculation and how to pay it. */
export async function confirmPlanChange(
  ctx: RrContext,
  api: ApiClient,
  slug: string,
): Promise<void> {
  return showCheckout(ctx, api, { slug, kind: 'plan_change' });
}
