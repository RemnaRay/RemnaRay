import { z } from 'zod';

export const adminMoneySchema = z.object({ amountMinor: z.number(), currency: z.string() });

export const adminUserRowSchema = z.object({
  id: z.string(),
  telegramId: z.number(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  isBanned: z.boolean(),
  anonymizedAt: z.string().nullable(),
  createdAt: z.string(),
  subscriptionStatus: z.string().nullable(),
  expiresAt: z.string().nullable(),
  balance: adminMoneySchema,
});

export const adminUserListSchema = z.object({
  items: z.array(adminUserRowSchema),
  nextCursor: z.string().nullable(),
});

export const adminUserDetailSchema = z.object({
  user: z.object({
    id: z.string(),
    telegramId: z.number(),
    username: z.string().nullable(),
    firstName: z.string().nullable(),
    language: z.string(),
    email: z.string().nullable(),
    referralCode: z.string(),
    referrerId: z.string().nullable(),
    isBanned: z.boolean(),
    botBlockedAt: z.string().nullable(),
    anonymizedAt: z.string().nullable(),
    marketingOptOut: z.boolean(),
    notes: z.string().nullable(),
    createdAt: z.string(),
  }),
  subscription: z
    .object({
      id: z.string(),
      status: z.string(),
      source: z.string(),
      planId: z.string().nullable(),
      startsAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
  panel: z
    .object({
      panelUuid: z.string(),
      panelUsername: z.string(),
      status: z.string(),
      usedTrafficBytes: z.number(),
      trafficLimitBytes: z.number(),
      subscriptionUrl: z.string(),
      syncedAt: z.string().nullable(),
      syncError: z.string().nullable(),
    })
    .nullable(),
  balance: adminMoneySchema,
  counts: z.object({ transactions: z.number(), invoices: z.number(), referrals: z.number() }),
});

export const adminTransactionListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userId: z.string().optional(),
      type: z.string(),
      status: z.string(),
      amount: adminMoneySchema,
      refunded: adminMoneySchema.optional(),
      provider: z.string().nullable(),
      reason: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable().default(null),
});

export const adminInvoiceListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable().default(null),
      userId: z.string().optional(),
      kind: z.string(),
      status: z.string(),
      provider: z.string(),
      amount: adminMoneySchema,
      createdAt: z.string(),
      paidAt: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable().default(null),
});

export const adminInvoiceDetailSchema = z.object({
  invoice: z.object({
    id: z.string(),
    userId: z.string(),
    kind: z.string(),
    status: z.string(),
    provider: z.string(),
    planId: z.string().nullable(),
    amount: adminMoneySchema,
    discount: adminMoneySchema,
    providerInvoiceId: z.string().nullable(),
    expiresAt: z.string(),
    paidAt: z.string().nullable(),
    createdAt: z.string(),
  }),
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      externalId: z.string(),
      signatureOk: z.boolean(),
      processedAt: z.string().nullable(),
      processError: z.string().nullable(),
      raw: z.unknown(),
      receivedAt: z.string(),
    }),
  ),
});

export const adminSubscriptionListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      planId: z.string().nullable(),
      status: z.string(),
      source: z.string(),
      startsAt: z.string(),
      expiresAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const adminAuditListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      actorAdminId: z.string().nullable(),
      reason: z.string().nullable(),
      before: z.unknown(),
      after: z.unknown(),
      createdAt: z.string(),
    }),
  ),
});

export const adminPlanSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).nullable().optional(),
  durationDays: z.number(),
  trafficLimitBytes: z.number(),
  trafficResetStrategy: z.string().default('NO_RESET'),
  deviceLimit: z.number(),
  squads: z.array(z.string()).default([]),
  price: adminMoneySchema,
  isPublic: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number(),
});
export type AdminPlan = z.infer<typeof adminPlanSchema>;
export const adminPlanListSchema = z.array(adminPlanSchema);
