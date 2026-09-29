import type { Locale } from '@remnaray/i18n-core';

import { setDisplayTimeZone } from './screens/common.js';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ApiClientError';
  }
}

/** The bot a customer writes to support in (F35). */
export type SupportVia = 'shop' | 'support';

/** What a support message is and says, kept with the ticket (F36). */
export type SupportMessageInfo = {
  kind: string;
  text?: string;
  fileId?: string;
  fileUniqueId?: string;
};

export type UserSummary = {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  language: Locale;
  referralCode: string;
  isBanned: boolean;
};

export type UpsertUserResult = {
  user: UserSummary;
  created: boolean;
  attributed: boolean;
  promoReserved: boolean;
  planSlug?: string;
};

/** `UserMe` from section 9.4. */
export type HomeState = {
  id: string;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  language: Locale;
  email: string | null;
  balance: { amountMinor: number; currency: string };
  balanceHeld: { amountMinor: number; currency: string };
  referralCode: string;
  referralLink: string;
  botReferralLink: string;
  marketingOptOut: boolean;
  trialAvailable: boolean;
  createdAt: string;
};

export type PublicPlan = {
  id: string;
  slug: string;
  name: Record<string, string>;
  durationDays: number;
  trafficLimitBytes: number;
  deviceLimit: number;
  price: { amountMinor: number; currency: string };
};

export type SubscriptionState = {
  subscription: {
    status: string;
    plan?: PublicPlan | null;
    expiresAt: string;
    daysLeft: number;
    canChangePlan: boolean;
    canRevoke: boolean;
  } | null;
  panel: {
    status?: string;
    subscriptionUrl: string;
    usedTrafficBytes: number;
    trafficLimitBytes: number;
    deviceLimit?: number | null;
  } | null;
  clients: { id: string; name: string; platforms: string[]; deepLink: string | null }[];
};

export type InvoiceView = {
  id: string;
  kind: string;
  status: string;
  provider: string;
  amount: { amountMinor: number; currency: string };
  number: string | null;
  target: {
    planId: string;
    planSlug: string;
    kind: 'purchase' | 'plan_change';
    promocode: string | null;
  } | null;
  paymentUrl?: string;
  starsInvoiceLink?: string;
  expiresAt: string;
  createdAt: string;
};

export type CheckoutQuote = {
  planId: string;
  kind: 'purchase' | 'plan_change';
  priceMinor: number;
  discountMinor: number;
  creditMinor: number;
  toPayMinor: number;
  availableMinor: number;
  missingMinor: number;
  topups: Array<{ provider: string; amountMinor: number }>;
  promocode: { code: string; applied: boolean; error?: string } | null;
};

export type InvoiceRequest =
  | { kind: 'purchase' | 'plan_change'; planId: string; promocode?: string }
  | { kind: 'topup'; provider: string; amountMinor: number }
  | {
      kind: 'topup';
      provider: string;
      forPlan: { planId: string; kind: 'purchase' | 'plan_change'; promocode?: string };
    };

export type StarsInvoice = {
  invoiceId: string;
  link: string | null;
  title: string;
  description: string;
  payload: string;
  currency: 'XTR';
  amount: number;
};

export type ReferralState = {
  code: string;
  link: string;
  botLink: string;
  invited: number;
  converted: number;
  earned: { amountMinor: number; currency: string };
  program: {
    mode: string;
    percent: number;
    fixedMinor: number;
    inviteeBonus: { type: 'none' | 'days' | 'balance'; value: number };
  };
};

export type ReferralListPage = {
  items: { maskedName: string; joinedAt: string; status: string; rewardMinor: number }[];
  nextCursor: string | null;
};

export type ApiClientOptions = {
  baseUrl?: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
};

const CONFIG_TTL_MS = 30_000;

export class ApiClient {
  private config: { value: import('./types.js').BotConfig; at: number } | undefined;
  private readonly baseUrl: string;
  private readonly internalToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.RR_API_URL ?? 'http://api:3000').replace(
      /\/$/u,
      '',
    );
    this.internalToken = options.internalToken ?? process.env.RR_INTERNAL_TOKEN ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(
    path: string,
    options: {
      method?: string;
      userId?: string | number | bigint;
      body?: unknown;
      idempotencyKey?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': this.internalToken,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.userId !== undefined) headers['x-acting-user'] = String(options.userId);
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const request: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'error',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, request);
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }
    if (!response.ok)
      throw new ApiClientError(response.status, errorCode(payload, response.status), payload);
    return payload as T;
  }

  upsertUser(user: {
    telegramId: number;
    username?: string;
    firstName?: string;
    languageCode?: string;
    startPayload?: string;
  }): Promise<UpsertUserResult> {
    return this.request('/api/internal/v1/users/upsert', {
      method: 'POST',
      body: user,
    });
  }

  /**
   * The bot's configuration. Screens read it for the brand and the trial, and
   * the answer assembles every locale's commands, so it is kept for 30 s;
   * `main.ts` asks for it afresh on every `rr:bot.reconfigure`.
   */
  async getConfig(options: { fresh?: boolean } = {}) {
    if (!options.fresh && this.config && Date.now() - this.config.at < CONFIG_TTL_MS)
      return this.config.value;
    const value = await this.request<import('./types.js').BotConfig>('/api/internal/v1/bot/config');
    this.config = { value, at: Date.now() };
    setDisplayTimeZone(value.timezone);
    return value;
  }

  getMessages(lang: Locale) {
    return this.request<{ lang: Locale; messages: Record<string, string> }>(
      `/api/internal/v1/i18n/${lang}`,
    );
  }

  getMe(telegramId: number) {
    return this.request<HomeState>('/api/internal/v1/me', { userId: telegramId });
  }

  patchMe(
    telegramId: number,
    body: { language?: Locale; marketingOptOut?: boolean; email?: string | null },
  ) {
    return this.request<{ language: Locale; email: string | null; marketingOptOut: boolean }>(
      '/api/internal/v1/me',
      { method: 'PATCH', userId: telegramId, body },
    );
  }

  redeemPromo(telegramId: number, code: string) {
    return this.request<{ reservedForNextPurchase: boolean }>(
      '/api/internal/v1/me/promocodes/redeem',
      {
        method: 'POST',
        userId: telegramId,
        body: { code },
      },
    );
  }

  /**
   * FR-124, owner decision F36: the customer's message `messageId` goes into
   * their ticket; `created` tells the bot to confirm a new ticket.
   */
  forwardSupport(
    telegramId: number,
    messageId: number,
    options: { requireOpen?: boolean; via?: SupportVia; message?: SupportMessageInfo } = {},
  ) {
    return this.request<{ ticket: { id: string; number: number; created: boolean } }>(
      '/api/internal/v1/support/forward',
      {
        method: 'POST',
        userId: telegramId,
        body: {
          messageId,
          requireOpen: options.requireOpen ?? false,
          ...(options.via ? { via: options.via } : {}),
          ...(options.message ? { message: options.message } : {}),
        },
      },
    );
  }

  /** «Написать оператору»: the customer's messages go to the operators. */
  openSupport(telegramId: number) {
    return this.request<unknown>('/api/internal/v1/support/open', {
      method: 'POST',
      userId: telegramId,
    });
  }

  /** «Завершить» / «Закрыть обращение»: the customer closes their ticket. */
  closeSupport(telegramId: number, via: SupportVia = 'shop') {
    return this.request<{ ticket: { id: string; number: number } | null }>(
      '/api/internal/v1/support/close',
      {
        method: 'POST',
        userId: telegramId,
        body: { via },
      },
    );
  }

  /** The self-help questions (F36) in `locale`. */
  supportFaq(locale: string) {
    return this.request<{ items: Array<{ id: string; question: string }> }>(
      `/api/internal/v1/support/faq?locale=${encodeURIComponent(locale)}`,
    );
  }

  /** One self-help answer; null when it was removed or turned off. */
  async supportFaqAnswer(id: string, locale: string) {
    try {
      return await this.request<{ question: string; answer: string }>(
        `/api/internal/v1/support/faq/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`,
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) return null;
      throw error;
    }
  }

  /** «Моя ссылка подписки»: the customer's subscription link, or null. */
  supportLink(telegramId: number) {
    return this.request<{ url: string | null }>('/api/internal/v1/support/subscription-link', {
      userId: telegramId,
    });
  }

  /** The customer rates their closed ticket (1–5); only the first rating counts. */
  rateSupport(telegramId: number, ticketId: string, rating: number) {
    return this.request<{ accepted: boolean; number: number | null }>(
      '/api/internal/v1/support/rate',
      { method: 'POST', userId: telegramId, body: { ticketId, rating } },
    );
  }

  /** A message in the operators' chat; the API answers, notes or runs the command. */
  operatorSupport(input: {
    chatId: number;
    messageId: number;
    threadId?: number;
    replyToMessageId?: number;
    from: { id: number; name: string };
    via: SupportVia;
    message: SupportMessageInfo;
  }) {
    return this.request<{ handled: boolean }>('/api/internal/v1/support/operator', {
      method: 'POST',
      body: input,
    });
  }

  /** A ticket card's button in the operators' chat; the answer goes to the presser. */
  supportCallback(input: {
    chatId: number;
    from: { id: number; name: string };
    data: string;
    via: SupportVia;
  }) {
    return this.request<{ text: string; alert?: boolean }>('/api/internal/v1/support/callback', {
      method: 'POST',
      body: input,
    });
  }

  getAdminRole(telegramId: number) {
    return this.request<{ role: string }>(
      `/api/internal/v1/admins/by-telegram/${String(telegramId)}`,
    );
  }

  adminStats(telegramId: number) {
    return this.request<{ users: number; activeSubscriptions: number; transactionsToday: number }>(
      '/api/internal/v1/admins/stats',
      { userId: telegramId },
    );
  }

  adminUser(telegramId: number, query: string) {
    return this.request<{ telegramId: string; username: string | null; firstName: string | null }>(
      `/api/internal/v1/admins/users/${encodeURIComponent(query)}`,
      { userId: telegramId },
    );
  }

  adminExtend(telegramId: number, targetTelegramId: string, days: number) {
    return this.request<{ expiresAt: string; days: number }>('/api/internal/v1/admins/extend', {
      method: 'POST',
      userId: telegramId,
      body: { telegramId: targetTelegramId, days },
    });
  }

  adminBroadcastStatus(telegramId: number) {
    return this.request<{ id: string; status: string; sent: number; total: number } | null>(
      '/api/internal/v1/admins/broadcast-status',
      { userId: telegramId },
    );
  }

  getPlans() {
    return this.request<{ items: PublicPlan[] }>('/api/internal/v1/me/plans');
  }

  getSubscription(telegramId: number) {
    return this.request<SubscriptionState>('/api/internal/v1/me/subscription', {
      userId: telegramId,
    });
  }

  getTransactions(telegramId: number, limit = 20) {
    return this.request<{
      items: Array<{
        type: string;
        amount: { amountMinor: number; currency: string };
        description: string | null;
        createdAt: string;
      }>;
      nextCursor: string | null;
    }>(`/api/internal/v1/me/transactions?limit=${String(limit)}`, { userId: telegramId });
  }

  getReferralList(telegramId: number) {
    return this.request<ReferralListPage>('/api/internal/v1/me/referrals/list?limit=10', {
      userId: telegramId,
    });
  }

  getReferrals(telegramId: number) {
    return this.request<ReferralState>('/api/internal/v1/me/referrals', { userId: telegramId });
  }

  startTrial(telegramId: number) {
    return this.request<{ subscription: unknown }>('/api/internal/v1/me/trial', {
      method: 'POST',
      userId: telegramId,
    });
  }

  revokeSubscription(telegramId: number) {
    return this.request<{ subscriptionUrl: string }>('/api/internal/v1/me/subscription/revoke', {
      method: 'POST',
      userId: telegramId,
    });
  }

  getPaymentMethods(telegramId: number) {
    return this.request<{
      items: Array<{
        code: string;
        displayName: Record<string, string>;
        kind: string;
        available: boolean;
        /** The available balance, on the built-in balance method only. */
        balance?: { amountMinor: number; currency: string };
      }>;
    }>('/api/internal/v1/me/payment-methods', { userId: telegramId });
  }

  getTopupConfig() {
    return this.request<{ presetsMinor: number[]; minMinor: number; maxMinor: number }>(
      '/api/internal/v1/me/topup-config',
    );
  }

  createInvoice(telegramId: number, body: InvoiceRequest, idempotencyKey: string) {
    return this.request<InvoiceView>('/api/internal/v1/me/invoices', {
      method: 'POST',
      userId: telegramId,
      body,
      idempotencyKey,
    });
  }

  /** FR-026: the HWID devices of the customer's panel account. */
  getDevices(telegramId: number) {
    return this.request<{
      items: {
        hwid: string;
        platform: string | null;
        osVersion: string | null;
        deviceModel: string | null;
        createdAt: string | null;
      }[];
      canRemove: boolean;
    }>('/api/internal/v1/me/subscription/devices', { userId: telegramId });
  }

  removeDevice(telegramId: number, hwid: string) {
    return this.request<unknown>(
      `/api/internal/v1/me/subscription/devices/${encodeURIComponent(hwid)}`,
      { method: 'DELETE', userId: telegramId },
    );
  }

  /** F37: what `planId` costs from the balance and the top-up each provider needs. */
  getCheckoutQuote(
    telegramId: number,
    planId: string,
    kind: 'purchase' | 'plan_change',
    promocode?: string,
  ) {
    const query = new URLSearchParams({ planId, kind, ...(promocode ? { promocode } : {}) });
    return this.request<CheckoutQuote>(`/api/internal/v1/me/checkout/quote?${query.toString()}`, {
      userId: telegramId,
    });
  }

  getInvoice(telegramId: number, invoiceId: string) {
    return this.request<InvoiceView>(`/api/internal/v1/me/invoices/${invoiceId}`, {
      userId: telegramId,
    });
  }

  checkInvoice(telegramId: number, invoiceId: string) {
    return this.request<InvoiceView>(`/api/internal/v1/me/invoices/${invoiceId}/check`, {
      method: 'POST',
      userId: telegramId,
    });
  }

  issueToken(telegramId: number) {
    return this.request<{ token: string; user: UserSummary }>('/api/internal/v1/auth/issue-token', {
      method: 'POST',
      body: { telegramId },
    });
  }

  /** Section 11.3.6 `stars/create-link`: the pending invoice to `sendInvoice` for `/start inv_<id>`. */
  starsCreateLink(telegramId: number, invoiceId: string) {
    return this.request<StarsInvoice>('/api/internal/v1/stars/create-link', {
      method: 'POST',
      userId: telegramId,
      body: { invoiceId },
    });
  }

  /** Section 9.5 `stars/precheckout`; Telegram waits ten seconds for the answer. */
  starsPrecheckout(body: {
    telegramId: number;
    invoicePayload: string;
    totalAmount: number;
    currency: string;
  }) {
    return this.request<{ ok: true }>('/api/internal/v1/stars/precheckout', {
      method: 'POST',
      body,
      timeoutMs: 7_000,
    });
  }

  /** Section 9.5 `stars/successful-payment`, idempotent by `telegramPaymentChargeId`. */
  starsSuccessfulPayment(body: {
    telegramId: number;
    telegramPaymentChargeId: string;
    providerPaymentChargeId: string;
    invoicePayload: string;
    totalAmount: number;
    currency: string;
  }) {
    return this.request<{ ok: true; invoiceId?: string; status?: string }>(
      '/api/internal/v1/stars/successful-payment',
      { method: 'POST', body },
    );
  }

  /** FR-163: an alert to the administrators; the API sends one per type per hour. */
  alert(body: { type: string; details?: string }): Promise<unknown> {
    return this.request<unknown>('/api/internal/v1/notify/alert', { method: 'POST', body });
  }

  markBlocked(telegramId: number): Promise<unknown> {
    return this.request<unknown>(`/api/internal/v1/users/${String(telegramId)}/bot-blocked`, {
      method: 'POST',
    });
  }

  markUnblocked(telegramId: number): Promise<unknown> {
    return this.request<unknown>(`/api/internal/v1/users/${String(telegramId)}/bot-unblocked`, {
      method: 'POST',
    });
  }
}

/** Section 9.3 answers `{ error: { code } }`; a few internal routes answer `{ code }`. */
function errorCode(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('code' in payload && typeof payload.code === 'string') return payload.code;
    if (
      'error' in payload &&
      typeof payload.error === 'object' &&
      payload.error !== null &&
      'code' in payload.error &&
      typeof payload.error.code === 'string'
    )
      return payload.error.code;
  }
  return `HTTP_${String(status)}`;
}
