import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

import { limitKeyFor, type AdminRole } from '@remnaray/domain/rbac';

import { Infrastructure } from '../../infra/infra.module';
import { Audited } from '../admin/audit.interceptor';
import { ApiError } from '../me/me.errors';
import { PaymentError } from '../payments/payments.errors';
import { PaymentsService } from '../payments/payments.service';
import { SettingsService } from '../settings/settings.service';
import { emitWebhook, subscriptionData } from '../webhooks/outgoing';
import { queuePanelSync } from '../remnawave/panel-jobs';
import { bulkExtendSchema, refundSchema } from './admin-users.schemas';

export type ActingAdmin = { id: string; role: AdminRole };

const invoiceQuerySchema = z.object({
  status: z.enum(['pending', 'paid', 'expired', 'canceled', 'underpaid']).optional(),
  provider: z.string().min(1).max(32).optional(),
  userId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const transactionQuerySchema = z.object({
  type: z
    .enum([
      'purchase',
      'topup',
      'refund',
      'referral_reward',
      'referral_reversal',
      'promo_bonus',
      'adjustment',
      'plan_change_credit',
    ])
    .optional(),
  provider: z.string().min(1).max(32).optional(),
  userId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const subscriptionQuerySchema = z.object({
  status: z
    .enum(['provisioning', 'active', 'grace', 'expired', 'revoked', 'provisioning_failed'])
    .optional(),
  planId: z.uuid().optional(),
  expiresBefore: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

function money(amountMinor: bigint, currency = 'RUB') {
  return { amountMinor: Number(amountMinor), currency };
}

/** Masks anything that looks like a secret inside a stored provider payload. */
function maskRaw(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskRaw(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /token|secret|password|signature|api[-_]?key|card|pan/i.test(key)
      ? '***'
      : maskRaw(item, depth + 1);
  }
  return output;
}

@Injectable()
export class AdminPaymentsService {
  constructor(
    private readonly infra: Infrastructure,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
  ) {}

  async invoices(query: unknown) {
    const input = invoiceQuerySchema.parse(query ?? {});
    const rows = await this.infra.db.invoice.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        status: row.status,
        provider: row.provider,
        amount: money(row.amountMinor, row.currency),
        createdAt: row.createdAt.toISOString(),
        paidAt: row.paidAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async invoice(id: string) {
    const invoice = await this.infra.db.invoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('NOT_FOUND');
    const events = await this.infra.db.paymentEvent.findMany({
      where: { invoiceId: id },
      orderBy: { id: 'asc' },
      take: 100,
    });
    return {
      invoice: {
        id: invoice.id,
        userId: invoice.userId,
        kind: invoice.kind,
        status: invoice.status,
        provider: invoice.provider,
        planId: invoice.planId,
        amount: money(invoice.amountMinor, invoice.currency),
        discount: money(invoice.discountMinor, invoice.currency),
        providerInvoiceId: invoice.providerInvoiceId,
        expiresAt: invoice.expiresAt.toISOString(),
        paidAt: invoice.paidAt?.toISOString() ?? null,
        createdAt: invoice.createdAt.toISOString(),
      },
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        externalId: event.externalId,
        signatureOk: event.signatureOk,
        processedAt: event.processedAt?.toISOString() ?? null,
        processError: event.processError,
        raw: maskRaw(event.raw),
        receivedAt: event.receivedAt.toISOString(),
      })),
    };
  }

  async recheck(id: string) {
    const before = await this.infra.db.invoice.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    const after = await this.payments.recheck(id).catch((error: unknown) => {
      // FR-064's 10-second limit and a provider that did not answer are
      // answers, not failures of ours.
      if (error instanceof PaymentError && error.code === 'RATE_LIMITED')
        throw new ApiError('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
      if (error instanceof PaymentError && error.code === 'PROVIDER_UNAVAILABLE')
        throw new ApiError('PROVIDER_UNAVAILABLE', HttpStatus.CONFLICT);
      throw error;
    });
    return new Audited({ status: before.status }, { status: after?.status ?? before.status });
  }

  async transactions(query: unknown) {
    const input = transactionQuerySchema.parse(query ?? {});
    const rows = await this.infra.db.transaction.findMany({
      where: {
        ...(input.type ? { type: input.type } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        type: row.type,
        status: row.status,
        amount: money(row.amountMinor, row.currency),
        refunded: money(row.refundedMinor, row.currency),
        provider: row.provider,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** AC-066: a refund never exceeds the remaining refundable amount. */
  async refund(id: string, body: unknown, admin: ActingAdmin) {
    const input = refundSchema.parse(body);
    const before = await this.infra.db.transaction.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    if (admin.role === 'operator') {
      const key = limitKeyFor(admin.role, 'payments.refund');
      if (key) {
        const limit = BigInt(String(await this.settings.get(key)));
        if (input.amountMinor > limit)
          throw new ApiError('FORBIDDEN', HttpStatus.FORBIDDEN, 'Operator refund limit exceeded.', {
            limitMinor: Number(limit),
          });
      }
    }
    try {
      await this.payments.refund(id, input.amountMinor, input.reason);
    } catch (error) {
      // Section 9.3 has no refund-specific code; AC-066 asks for 409.
      if (error instanceof PaymentError && error.code === 'TRANSACTION_NOT_FOUND')
        throw new NotFoundException('NOT_FOUND');
      if (
        error instanceof PaymentError &&
        (error.code === 'REFUND_EXCEEDS_REMAINING' || error.code === 'REFUND_NOT_PURCHASE')
      )
        throw new ApiError(
          'CONFLICT',
          HttpStatus.CONFLICT,
          error.code === 'REFUND_NOT_PURCHASE'
            ? 'Only a purchase can be refunded to the balance.'
            : 'The refund exceeds the amount left to refund.',
          { reason: error.code },
        );
      throw error;
    }
    const after = await this.infra.db.transaction.findUniqueOrThrow({ where: { id } });
    return new Audited(
      { refunded: money(before.refundedMinor, before.currency) },
      { refunded: money(after.refundedMinor, after.currency) },
    );
  }

  async subscriptions(query: unknown) {
    const input = subscriptionQuerySchema.parse(query ?? {});
    const rows = await this.infra.db.subscription.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.expiresBefore ? { expiresAt: { lte: new Date(input.expiresBefore) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        planId: row.planId,
        status: row.status,
        source: row.source,
        startsAt: row.startsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Section 14.1: bulk extension, admin only, at most 500 rows, reason required. */
  async bulkExtend(body: unknown, admin: ActingAdmin) {
    const input = bulkExtendSchema.parse(body);
    return this.infra.db.$transaction(async (tx) => {
      const rows = await tx.subscription.findMany({ where: { id: { in: input.subscriptionIds } } });
      const before = rows.map((row) => ({ id: row.id, expiresAt: row.expiresAt.toISOString() }));
      const after: { id: string; expiresAt: string }[] = [];
      for (const row of rows) {
        const base = row.expiresAt > new Date() ? row.expiresAt : new Date();
        const expiresAt = new Date(base.getTime() + input.days * 86_400_000);
        const updated = await tx.subscription.update({
          where: { id: row.id },
          data: { expiresAt, status: 'active' },
        });
        await emitWebhook(tx, 'subscription.activated', row.userId, subscriptionData(updated));
        await queuePanelSync(tx, row.userId, 'admin:bulk-extend');
        await tx.transaction.create({
          data: {
            userId: row.userId,
            type: 'adjustment',
            status: 'completed',
            amountMinor: 0n,
            currency: 'RUB',
            subscriptionId: row.id,
            reason: input.reason,
            actorAdminId: admin.id,
          },
        });
        after.push({ id: row.id, expiresAt: expiresAt.toISOString() });
      }
      return new Audited(before, after, { updated: after.length });
    });
  }
}
