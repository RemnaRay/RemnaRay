import { escapeHtml } from '@remnaray/i18n-core';
import { InlineKeyboard } from 'grammy';

import type { ApiClient } from './api-client.js';

export const FAQ_DATA = /^faq:([0-9a-f-]{36})$/u;

/** One button per self-help question (owner decision F36), in the customer's language. */
export async function faqKeyboard(
  api: Pick<ApiClient, 'supportFaq'>,
  locale: string,
): Promise<{ keyboard: InlineKeyboard; count: number }> {
  const { items } = await api.supportFaq(locale);
  const keyboard = new InlineKeyboard();
  for (const item of items) keyboard.text(item.question.slice(0, 64), `faq:${item.id}`).row();
  return { keyboard, count: items.length };
}

/**
 * A self-help answer for an HTML message: the owner writes it in the console
 * as plain text, so it is escaped and shown exactly as written.
 */
export async function faqAnswer(
  api: Pick<ApiClient, 'supportFaqAnswer'>,
  id: string,
  locale: string,
): Promise<string | null> {
  const found = await api.supportFaqAnswer(id, locale);
  return found ? `❓ <b>${escapeHtml(found.question)}</b>\n\n${escapeHtml(found.answer)}` : null;
}
