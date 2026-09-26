import type { Context, SessionFlavor } from 'grammy';
import type { ConversationFlavor } from '@grammyjs/conversations';

import type { Locale } from '@remnaray/i18n-core';

export type BotSession = {
  lang: Locale;
  menuMessageId?: number;
  pendingPromo?: string;
  lastInvoiceId?: string;
  awaitingEmailForInvoice?: string;
  userInitialized?: boolean;
};

export type I18nFlavor = {
  locale: Locale;
  t: (key: string, values?: Record<string, unknown>) => string;
  /** The raw catalog: array values (`landing.faq`) are JSON, not ICU messages. */
  messages: Record<string, string>;
};

export type BaseContext = Context & SessionFlavor<BotSession> & I18nFlavor;
export type RrContext = ConversationFlavor<BaseContext>;

export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'pre_checkout_query',
  'my_chat_member',
] as const;

export type BotConfig = {
  token: string;
  /** `settings.brand.name`: the shop's own name in customer-facing texts. */
  brandName: string;
  /** `settings.trial.days` and `settings.trial.traffic_gb` (0 = unlimited). */
  trial: { days: number; trafficGb: number };
  /** `settings.locale.timezone`: dates the bot shows are in this zone. */
  timezone: string;
  /** `settings.clients.items`, for `/help`. */
  clients: { name: string; platforms: string[] }[];
  defaultLocale: Locale;
  mode: 'webhook' | 'polling';
  webUrl: string;
  webhookUrl: string;
  secretPath: string;
  secretToken: string;
  locales: Locale[];
  commands: Record<Locale, Array<{ command: string; description: string }>>;
  adminCommands: Record<Locale, Array<{ command: string; description: string }>>;
  supportForwardChatId: number | null;
  supportContact: string;
  /**
   * The optional support bot (owner decision F35): customers write to it,
   * and it answers for the operators, in the shop bot's delivery mode.
   */
  supportBot: { token: string; username: string; webhookUrl: string; secretToken: string } | null;
  admins: string[];
};

export type TelegramUpdate = {
  update_id: number;
  [key: string]: unknown;
};
