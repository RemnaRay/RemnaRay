import { z } from 'zod';

export const profilePatchSchema = z
  .object({
    language: z.enum(['ru', 'en']).optional(),
    email: z.email().max(254).nullable().optional(),
    marketingOptOut: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

const promocodeCode = z.string().min(3).max(64);
const purposeSchema = z.object({
  planId: z.uuid(),
  kind: z.enum(['purchase', 'plan_change']),
  promocode: promocodeCode.optional(),
});

/**
 * F37 (ADR-021): a plan is bought or changed only from the balance; a
 * provider takes a top-up — of an amount, or «for a plan», whose amount the
 * server computes.
 */
export const invoiceCreateSchema = z
  .object({
    kind: z.enum(['purchase', 'topup', 'plan_change']),
    planId: z.uuid().optional(),
    provider: z.string().min(1).max(32).default('balance'),
    amountMinor: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
    promocode: promocodeCode.optional(),
    forPlan: purposeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'topup') {
      if (value.provider !== 'balance')
        ctx.addIssue({
          code: 'custom',
          path: ['provider'],
          message: 'Plans are bought from the balance.',
        });
      if (!value.planId) ctx.addIssue({ code: 'custom', path: ['planId'], message: 'Required.' });
      if (value.forPlan || value.amountMinor !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'Only a top-up has an amount or a purpose.',
        });
      return;
    }
    if (value.provider === 'balance')
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'The balance does not top itself up.',
      });
    if ((value.forPlan === undefined) === (value.amountMinor === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['amountMinor'],
        message: 'Either an amount or a plan.',
      });
    if (value.planId || value.promocode)
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'A top-up names its plan in forPlan.',
      });
  });

export const checkoutQuoteQuerySchema = purposeSchema;

export const promocodeSchema = z.object({ code: z.string().min(3).max(64) });
export const promocodePreviewSchema = promocodeSchema.extend({ planId: z.uuid() });
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export type ProfilePatch = z.infer<typeof profilePatchSchema>;
export type InvoiceCreate = z.infer<typeof invoiceCreateSchema>;
