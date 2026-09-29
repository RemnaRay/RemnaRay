import { InlineKeyboard } from 'grammy';

import type { ApiClient, PublicPlan } from '../api-client.js';
import type { RrContext } from '../types.js';
import { formatMinor, show } from './common.js';
import { showCheckout } from './checkout.js';

export async function showPlans(ctx: RrContext, api: ApiClient): Promise<void> {
  const result = await api.getPlans();
  const keyboard = new InlineKeyboard();
  for (const plan of result.items) keyboard.text(planLabel(ctx, plan), `plan:${plan.slug}`).row();
  keyboard.text(ctx.t('bot.btn.back'), 'home');
  await show(ctx, ctx.t('bot.screen.plans.title'), keyboard);
}

export async function showPlan(ctx: RrContext, api: ApiClient, slug: string): Promise<void> {
  return showCheckout(ctx, api, { slug, kind: 'purchase' });
}

function planLabel(ctx: RrContext, plan: PublicPlan): string {
  const name = plan.name[ctx.locale] ?? plan.name.ru ?? plan.slug;
  return `${name} · ${formatMinor(plan.price.amountMinor, plan.price.currency)}`;
}
