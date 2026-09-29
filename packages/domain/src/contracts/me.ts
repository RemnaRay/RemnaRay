import { z } from 'zod';

import { cursorPage, localeTextSchema, moneySchema } from './common.js';
import { planPublicSchema } from './plans.js';

export const userMeSchema = z.object({
  id: z.string(),
  telegramId: z.number(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  language: z.string(),
  email: z.string().nullable(),
  /** Section 15.2: what can be spent, `balance_minor − SUM(held rewards)`. */
  balance: moneySchema,
  /** Referral rewards still held for a possible reversal, shown as pending. */
  balanceHeld: moneySchema,
  referralCode: z.string(),
  referralLink: z.string(),
  botReferralLink: z.string(),
  marketingOptOut: z.boolean(),
  trialAvailable: z.boolean(),
  createdAt: z.string(),
});
export type UserMeView = z.infer<typeof userMeSchema>;

export const subscriptionViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  source: z.string(),
  plan: planPublicSchema.nullable(),
  startsAt: z.string(),
  expiresAt: z.string(),
  daysLeft: z.number(),
  canChangePlan: z.boolean(),
  canRevoke: z.boolean(),
});

export const clientLinkSchema = z.object({
  id: z.string(),
  name: z.string(),
  platforms: z.array(z.string()),
  deepLink: z.string().nullable(),
  storeUrls: z.record(z.string(), z.string()).default({}),
});

export const subscriptionStateSchema = z.object({
  subscription: subscriptionViewSchema.nullable(),
  panel: z
    .object({
      status: z.string(),
      usedTrafficBytes: z.number(),
      trafficLimitBytes: z.number(),
      expireAt: z.string().nullable(),
      deviceLimit: z.number().nullable(),
      subscriptionUrl: z.string(),
    })
    .nullable(),
  clients: z.array(clientLinkSchema),
});
export type SubscriptionStateView = z.infer<typeof subscriptionStateSchema>;

export const deviceListSchema = z.object({
  items: z.array(
    z.object({
      hwid: z.string(),
      platform: z.string().nullable(),
      osVersion: z.string().nullable(),
      deviceModel: z.string().nullable(),
      createdAt: z.string().nullable(),
    }),
  ),
  canRemove: z.boolean(),
});
export type DeviceListView = z.infer<typeof deviceListSchema>;

export const paymentMethodsSchema = z.object({
  items: z.array(
    z.object({
      code: z.string(),
      displayName: z.union([localeTextSchema, z.record(z.string(), z.string())]),
      kind: z.enum(['redirect', 'stars', 'balance']),
      available: z.boolean(),
      unavailableReason: z.string().optional(),
      balance: moneySchema.optional(),
    }),
  ),
});
export type PaymentMethodsView = z.infer<typeof paymentMethodsSchema>;

export const invoiceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  plan: planPublicSchema.nullable(),
  provider: z.string(),
  amount: moneySchema,
  discount: moneySchema,
  providerAmount: z.object({ amount: z.string(), currency: z.string() }).optional(),
  paymentUrl: z.string().optional(),
  starsInvoiceLink: z.string().optional(),
  // F37 (ADR-021): a provider invoice's `NN-00001`, and what a top-up for a plan is meant to buy.
  number: z.string().nullable().default(null),
  target: z
    .object({
      planId: z.string(),
      planSlug: z.string(),
      kind: z.enum(['purchase', 'plan_change']),
      promocode: z.string().nullable(),
    })
    .nullable()
    .default(null),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type InvoiceView = z.infer<typeof invoiceSchema>;

export const transactionsSchema = cursorPage(
  z.object({
    id: z.string(),
    type: z.string(),
    amount: moneySchema,
    provider: z.string().nullable(),
    status: z.string(),
    createdAt: z.string(),
    description: z.string().nullable(),
    invoiceNumber: z.string().nullable().default(null),
  }),
);
export type TransactionsView = z.infer<typeof transactionsSchema>;

export const referralsSchema = z.object({
  code: z.string(),
  link: z.string(),
  botLink: z.string(),
  invited: z.number(),
  converted: z.number(),
  earned: moneySchema,
  program: z.object({
    mode: z.string(),
    percent: z.number(),
    fixedMinor: z.number(),
    // Section 15 `referral.invitee_bonus`: what the invited customer receives.
    inviteeBonus: z.object({
      type: z.enum(['none', 'days', 'balance']),
      value: z.number(),
    }),
  }),
});
export type ReferralsView = z.infer<typeof referralsSchema>;

export const referralListSchema = cursorPage(
  z.object({
    maskedName: z.string(),
    joinedAt: z.string(),
    status: z.string(),
    rewardMinor: z.number(),
  }),
);

export const trialResultSchema = z.object({
  subscription: z.unknown(),
  status: z.string(),
});

export const revokeResultSchema = z.object({ subscriptionUrl: z.string() });

export const anonymizationRequestSchema = z.object({
  requested: z.boolean(),
  requestedAt: z.string(),
});

export const topupConfigSchema = z.object({
  presetsMinor: z.array(z.number()),
  minMinor: z.number(),
  maxMinor: z.number(),
});

/** F37 (ADR-021): what a plan costs from the balance now, and the top-up each provider needs. */
export const checkoutQuoteSchema = z.object({
  planId: z.string(),
  kind: z.enum(['purchase', 'plan_change']),
  priceMinor: z.number(),
  discountMinor: z.number(),
  creditMinor: z.number(),
  toPayMinor: z.number(),
  availableMinor: z.number(),
  missingMinor: z.number(),
  topups: z.array(z.object({ provider: z.string(), amountMinor: z.number() })),
  promocode: z
    .object({ code: z.string(), applied: z.boolean(), error: z.string().optional() })
    .nullable(),
});
export type CheckoutQuoteView = z.infer<typeof checkoutQuoteSchema>;

export const promocodePreviewSchema = z.object({
  discountMinor: z.number(),
  finalMinor: z.number(),
});
